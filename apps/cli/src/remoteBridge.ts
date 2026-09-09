import { spawn } from 'node:child_process';
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
): Promise<void> {
  validateHermesTarget(target);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['send', '--to', target, '--file', '-', '--json'], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let failed = false;
    const fail = (reason: string) => {
      if (failed) return;
      failed = true;
      child.kill();
      reject(new Error(reason));
    };
    const timer = setTimeout(() => fail('Hermes delivery timed out; delivery is unknown. Inspect the destination before retrying.'), 30_000);
    child.on('error', () => fail('Hermes could not be started; no fallback channel was used.'));
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 64 * 1024) fail('Hermes returned an oversized response; delivery is unknown.');
    });
    // Drain without echoing potentially sensitive platform diagnostics.
    child.stderr.resume();
    child.stdin.on('error', () => fail('Hermes did not accept the message; delivery is unknown.'));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed) return;
      let result: { success?: unknown; skipped?: unknown; error?: unknown } | null = null;
      try { result = JSON.parse(stdout); } catch { /* rejected below */ }
      if (code !== 0 || result?.success !== true || result.skipped || result.error) {
        reject(new Error('Hermes did not confirm delivery; no fallback channel was used. Inspect the destination before retrying.'));
        return;
      }
      resolve();
    });
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

export function validateRemoteInput(platform: string, chatId: string, runtimeId: string, confirm: string, messageId: string): void {
  validateHermesTarget(`${platform}:${chatId}`);
  if (platform === 'weixin' || platform === 'wechat') throw new Error('Personal Weixin is notification-only.');
  if (confirm !== runtimeId) throw new Error('Write input requires explicit user confirmation: --confirm must equal the runtime ID.');
  if (!messageId.trim()) throw new Error('A stable platform message ID is required.');
}

export function registerRemoteBridge(program: Command): void {
  const remote = program.command('remote').description('Local event bridge for Hermes (platform identity is verified by Hermes)');
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
    .action(async (runtimeId: string, opts: { to: string; since: string }) => {
      const since = parseRemoteCursor(opts.since)!;
      validateHermesTarget(opts.to);
      const batch = await requestDesktopControl<RemoteEventBatch>('ccem.remote.getEvents', { runtimeId, sinceSeq: since, limit: 100 });
      printJson(await relayRemoteBatch(batch, runtimeId, since, opts.to));
    });
  remote.command('send <runtimeId>')
    .requiredOption('--platform <platform>', 'Authenticated Hermes source platform')
    .requiredOption('--chat-id <id>', 'Authenticated Hermes source chat')
    .requiredOption('--message-id <id>', 'Stable platform message ID for idempotency')
    .requiredOption('--text <text>', 'Confirmed input')
    .requiredOption('--confirm <runtimeId>', 'Repeat the runtime ID after obtaining user confirmation')
    .action(async (runtimeId: string, opts: { platform: string; chatId: string; messageId: string; text: string; confirm: string }) => {
      validateRemoteInput(opts.platform, opts.chatId, runtimeId, opts.confirm, opts.messageId);
      if (!opts.text.trim()) throw new Error('Input text must not be empty.');
      printJson(await requestDesktopControl('ccem.workspace.sendInput', {
        runtimeId,
        clientMessageId: JSON.stringify(['hermes', opts.platform, opts.chatId, opts.messageId]),
        text: opts.text,
        displayText: null,
      }));
    });
}
