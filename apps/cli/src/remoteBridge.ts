import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';
import type { Command } from 'commander';
import { printJson, requestDesktopControl } from './desktopControl.js';

export function parseRemoteCursor(raw: string): number {
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error('Expected a non-negative safe integer event cursor.');
  }
  return Number(raw);
}

export interface RemoteEvent {
  version: 1;
  event_id: string;
  runtime_id: string;
  seq: number;
  occurred_at: string;
  kind: string;
  title: string;
  text: string;
}

export interface RemoteEventBatch {
  version: 1;
  sourceAvailable: boolean;
  gapDetected: boolean;
  hasMore: boolean;
  decodeFailureCount: number;
  oversizedEventCount: number;
  nextCursor: number | null;
  events: RemoteEvent[];
}

/** Hermes owns platform discovery and authentication; CCEM never guesses a home chat. */
export function validateHermesTarget(target: string): string {
  if (!/^[a-z][a-z0-9_-]*:[^\s:]+(?::[^\s:]+)?$/.test(target)) {
    throw new Error('Expected an explicit Hermes platform:chat_id[:thread_id] target.');
  }
  return target;
}

export function renderRemoteEvent(event: RemoteEvent): string {
  // Do not rely on Markdown/code-fence masking of Hermes MEDIA directives. Session
  // output is untrusted text, never authorization to upload a local file.
  const text = `[CCEM ${event.event_id}] ${event.title}\n${event.text}`;
  return text.replace(/media:/gi, 'MEDIA\u200b:').replace(/\[\[/g, '[\u200b[');
}

/** Fail closed, including Hermes' exit-0 skipped result. Never retry an uncertain send. */
export async function sendHermesMessage(
  target: string,
  message: string,
  executable = 'hermes',
  limits: { timeoutMs?: number; killGraceMs?: number } = {},
): Promise<void> {
  validateHermesTarget(target);
  const timeoutMs = limits.timeoutMs ?? 30_000;
  const killGraceMs = limits.killGraceMs ?? 250;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
    || !Number.isSafeInteger(killGraceMs) || killGraceMs < 1 || killGraceMs > 1000) {
    throw new Error('Invalid Hermes process limits.');
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['send', '--to', target, '--file', '-', '--json'], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let failure: string | undefined;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(reapTimer);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (failure) {
        reject(new Error(failure));
        return;
      }
      let result: { success?: unknown; skipped?: unknown; error?: unknown } | null = null;
      try {
        const stdout = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        result = JSON.parse(stdout);
      } catch { /* malformed receipts, including invalid UTF-8, are unknown delivery */ }
      if (code !== 0 || result?.success !== true || result.skipped || result.error) {
        reject(new Error('Hermes did not confirm delivery; no fallback channel was used. Inspect the destination before retrying.'));
        return;
      }
      resolve();
    };
    const fail = (reason: string) => {
      if (failure || settled) return;
      failure = reason;
      clearTimeout(timer);
      child.stdin.destroy();
      // Only this ChildProcess is owned by this call. Never kill by name or port.
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        // A descendant could retain a pipe after the direct child has exited.
        // Bound that wait too; this path never confirms delivery or retries.
        reapTimer = setTimeout(() => {
          child.unref();
          finish(null);
        }, 1000);
      }, killGraceMs);
    };
    const timer = setTimeout(() => fail('Hermes delivery timed out; delivery is unknown. Inspect the destination before retrying.'), timeoutMs);
    child.on('error', () => fail('Hermes could not be started; no fallback channel was used.'));
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure || settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > 64 * 1024) fail('Hermes returned an oversized response; delivery is unknown.');
      else chunks.push(chunk);
    });
    // Drain without echoing potentially sensitive platform diagnostics.
    child.stderr.resume();
    child.stdin.on('error', () => fail('Hermes did not accept the message; delivery is unknown.'));
    child.on('close', finish);
    child.stdin.end(message);
  });
}

export async function relayRemoteBatch(
  batch: RemoteEventBatch,
  runtimeId: string,
  since: number,
  target: string,
  send = sendHermesMessage,
): Promise<{ nextCursor: number; delivered: number; hasMore: boolean }> {
  validateHermesTarget(target);
  if (!Number.isSafeInteger(since) || since < 0) throw new Error('Invalid starting cursor.');
  if (batch.version !== 1 || !batch.sourceAvailable || batch.gapDetected
    || batch.decodeFailureCount !== 0 || batch.oversizedEventCount !== 0) {
    throw new Error('Remote event source is unavailable or incomplete; nothing was sent.');
  }
  if (!Array.isArray(batch.events) || !Number.isSafeInteger(batch.nextCursor)
    || batch.nextCursor! < since) {
    throw new Error('Invalid remote event cursor; nothing was sent.');
  }
  let previous = since;
  // Validate the whole batch before the first external side effect.
  for (const event of batch.events) {
    if (event.version !== 1 || event.runtime_id !== runtimeId
      || !Number.isSafeInteger(event.seq) || event.seq <= previous
      || event.seq > batch.nextCursor! || event.event_id !== `${runtimeId}:${event.seq}`
      || typeof event.title !== 'string' || typeof event.text !== 'string') {
      throw new Error('Invalid remote event batch; nothing was sent.');
    }
    previous = event.seq;
  }
  let delivered = 0;
  let acknowledgedCursor = since;
  for (const event of batch.events) {
    try {
      await send(target, renderRemoteEvent(event));
    } catch (error) {
      throw new Error(`Delivery stopped at ${event.event_id}; confirmed cursor=${acknowledgedCursor}, delivered=${delivered}. ${error instanceof Error ? error.message : 'Unknown delivery failure'}`);
    }
    delivered++;
    acknowledgedCursor = event.seq;
  }
  return { nextCursor: batch.nextCursor!, delivered, hasMore: batch.hasMore };
}

const REMOTE_WRITE_UNAVAILABLE = 'CAPABILITY_UNAVAILABLE: Remote input requires a scoped bridge token, trusted chat confirmation and durable input deduplication. CLI source/confirmation arguments cannot authorize it.';
const REMOTE_RELAY_UNAVAILABLE = 'CAPABILITY_UNAVAILABLE: Remote relay requires a verified managed Hermes transport. Standalone CLI sends can replace a live gateway connection or change a thread target.';

export function registerRemoteBridge(program: Command): void {
  const remote = program.command('remote').description('Local administrative event inspection; managed Hermes integration is not enabled');
  remote.command('status <runtimeId>').action(async (runtimeId: string) => {
    printJson(await requestDesktopControl('ccem.workspace.getSession', { runtimeId }));
  });
  remote.command('events <runtimeId>')
    .option('--since <seq>', 'Last acknowledged event sequence', '0')
    .action(async (runtimeId: string, opts: { since: string }) => {
      printJson(await requestDesktopControl('ccem.remote.getEvents', { runtimeId, sinceSeq: parseRemoteCursor(opts.since), limit: 100 }));
    });
  remote.command('relay <runtimeId>')
    .requiredOption('--to <target>', 'Explicit Hermes platform:chat_id[:thread_id]')
    .requiredOption('--since <seq>', 'Last acknowledged cursor; explicit 0 replays available history')
    .description('Unavailable until managed transport capability checks pass')
    .action(() => {
      throw new Error(REMOTE_RELAY_UNAVAILABLE);
    });
  remote.command('send <runtimeId>')
    .requiredOption('--platform <platform>', 'Authenticated Hermes source platform')
    .requiredOption('--chat-id <id>', 'Authenticated Hermes source chat')
    .requiredOption('--message-id <id>', 'Stable platform message ID for idempotency')
    .requiredOption('--text <text>', 'Confirmed input')
    .requiredOption('--confirm <runtimeId>', 'Repeat the runtime ID after obtaining user confirmation')
    .description('Unavailable until trusted inbound bridge capability checks pass')
    .action(() => {
      throw new Error(REMOTE_WRITE_UNAVAILABLE);
    });
}
