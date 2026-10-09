import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { SpawnOptions } from 'node:child_process';
import { Command } from 'commander';
import {
  parseRemoteCursor, registerRemoteBridge, relayRemoteBatch, renderRemoteEvent,
  sendHermesMessage, type RemoteEventBatch,
} from '../remoteBridge.js';

const fixtureScripts = vi.hoisted(() => new Set<string>());
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn(command: string, args: readonly string[], options: SpawnOptions) {
      if (!fixtureScripts.has(command)) return actual.spawn(command, args, options);
      // Windows cannot execute a POSIX shebang. Adapt only our fixture's launch;
      // keep real child processes, literal argv, pipes, and production kill logic.
      expect(options.shell).toBe(false);
      return actual.spawn(process.execPath, [command, ...args], options);
    },
  };
});

const event = (seq: number) => ({ version: 1 as const, event_id: `run:${seq}`, runtime_id: 'run', seq,
  occurred_at: '2026-09-09T00:00:00Z', kind: 'session_completed', title: 'Session completed', text: 'completed' });
const batch = (): RemoteEventBatch => ({ version: 1, sourceAvailable: true, gapDetected: false,
  hasMore: false, decodeFailureCount: 0, oversizedEventCount: 0, nextCursor: 3, events: [event(1), event(2)] });
const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fixtureScripts.clear();
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ccem-hermes-test-'));
  temporary.push(dir);
  const file = join(dir, 'hermes fixture.cjs');
  await writeFile(file, script);
  fixtureScripts.add(file);
  return file;
}

describe('remote bridge delivery', () => {
  it('delivers in order and advances past filtered records', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await relayRemoteBatch(batch(), 'run', 0, 'feishu:chat', send))
      .toEqual({ nextCursor: 3, delivered: 2, hasMore: false });
    expect(send.mock.calls.map(call => call[1])).toEqual([
      '[CCEM run:1] Session completed\ncompleted', '[CCEM run:2] Session completed\ncompleted',
    ]);
  });
  it('validates all records before any send and rejects gaps/unavailable history', async () => {
    for (const value of [
      { ...batch(), sourceAvailable: false }, { ...batch(), gapDetected: true },
      { ...batch(), decodeFailureCount: 1 }, { ...batch(), oversizedEventCount: 1 }, { ...batch(), nextCursor: 1 },
      { ...batch(), events: [event(1), { ...event(2), runtime_id: 'other' }] },
      { ...batch(), events: [event(2), event(1)] },
    ]) {
      const send = vi.fn();
      await expect(relayRemoteBatch(value, 'run', 0, 'feishu:chat', send)).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
    }
  });
  it('stops on the first uncertain send, reports confirmed cursor and does not fallback/retry', async () => {
    const send = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline'));
    const value = { ...batch(), events: [event(1), event(2), event(3)] };
    await expect(relayRemoteBatch(value, 'run', 0, 'wecom:chat', send))
      .rejects.toThrow('confirmed cursor=1, delivered=1');
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('does not turn untrusted output into Hermes attachment directives', () => {
    const text = renderRemoteEvent({ ...event(1), text: 'MEDIA:/secret\nmedia:/private [[as_document]] $(touch /tmp/no)' });
    expect(text).not.toMatch(/MEDIA:/i);
    expect(text).not.toContain('[[as_document]]');
    expect(text).toContain('$(touch /tmp/no)');
  });
  it('pipes body to a real child process with literal argv', async () => {
    const executable = await fixture(`
let body = ''; process.stdin.on('data', c => body += c);
process.stdin.on('end', () => {
  const ok = JSON.stringify(process.argv.slice(2)) === JSON.stringify(['send','--to','feishu:chat','--file','-','--json'])
    && body === 'literal $(do-not-execute)';
  console.log(JSON.stringify({success: ok}));
});`);
    await expect(sendHermesMessage('feishu:chat', 'literal $(do-not-execute)', executable)).resolves.toBeUndefined();
  });
  it('rejects skipped, malformed, false success, and nonzero child exits', async () => {
    for (const script of [
      "process.stdin.resume(); console.log(JSON.stringify({skipped:true}));",
      "process.stdin.resume(); console.log('bad JSON');",
      "process.stdin.resume(); console.log(JSON.stringify({success:'true'}));",
      "process.stdin.resume(); console.log(JSON.stringify({success:true})); process.exitCode=1;",
    ]) {
      await expect(sendHermesMessage('wecom:chat', 'text', await fixture(script))).rejects.toThrow('did not confirm delivery');
    }
  });
  it('rejects implicit destinations and invalid cursors', async () => {
    await expect(sendHermesMessage('telegram', 'text', '/does-not-exist')).rejects.toThrow('explicit Hermes');
    for (const raw of ['', '-1', '1.5', '9007199254740992']) expect(() => parseRemoteCursor(raw)).toThrow();
    expect(parseRemoteCursor('0')).toBe(0);
  });
  it('bounds receipt bytes, rejects invalid UTF-8, and preserves split code points', async () => {
    await expect(sendHermesMessage('feishu:chat', 'text', await fixture(`
process.stdin.resume(); console.log(JSON.stringify({success:true, note:'中'.repeat(30000)}));
`))).rejects.toThrow('oversized');
    await expect(sendHermesMessage('feishu:chat', 'text', await fixture(`
process.stdin.resume(); process.stdout.write(Buffer.concat([
  Buffer.from('{"success":true,"note":"'), Buffer.from([255]), Buffer.from('"}')
]));
`))).rejects.toThrow('did not confirm');
    await expect(sendHermesMessage('feishu:chat', 'text', await fixture(`
process.stdin.resume(); const value = Buffer.from(JSON.stringify({success:true,note:'中'}));
const split = value.indexOf(0xe4) + 1;
process.stdout.write(value.subarray(0, split));
setTimeout(() => process.stdout.write(value.subarray(split)), 30);
`))).resolves.toBeUndefined();
  });
  it('reaps its own child even when it ignores SIGTERM after an oversized receipt', async () => {
    const executable = await fixture(`
const fs = require('node:fs');
fs.writeFileSync(__filename + '.pid', String(process.pid));
process.on('SIGTERM', () => {});
process.stdin.resume(); setInterval(() => {}, 1000);
process.stdout.write('x'.repeat(65537));
`);
    try {
      await expect(sendHermesMessage('feishu:chat', 'text', executable, { killGraceMs: 30 }))
        .rejects.toThrow('oversized');
      const pid = Number(await readFile(executable + '.pid', 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      // Exact fixture ownership only, including cleanup if the assertion regresses.
      const pid = Number(await readFile(executable + '.pid', 'utf8').catch(() => '0'));
      if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ } }
    }
  });
  it('reports timeouts as unknown and handles an executable that cannot start', async () => {
    const executable = await fixture('process.stdin.resume(); setInterval(() => {}, 1000);');
    await expect(sendHermesMessage('feishu:chat', 'text', executable, { timeoutMs: 600 }))
      .rejects.toThrow('delivery is unknown');
    await expect(sendHermesMessage('feishu:chat', 'text', '/ccem-missing-hermes'))
      .rejects.toThrow('could not be started');
  });
});

describe('remote command behavior over loopback RPC', () => {
  it('keeps local queries working but blocks every remote side effect before RPC', async () => {
    const calls: any[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        expect(req.headers.authorization).toBe('Bearer test-local-token');
        const call = JSON.parse(body);
        calls.push(call);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { ok: true, runtimeId: 'run' } }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const dir = await mkdtemp(join(tmpdir(), 'ccem-remote-rpc-')); temporary.push(dir);
      const file = join(dir, 'control.json');
      await writeFile(file, JSON.stringify({ endpoint: `http://127.0.0.1:${(server.address() as any).port}/rpc`, token: 'test-local-token', pid: process.pid }));
      vi.stubEnv('CCEM_CONTROL_FILE', file);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const run = async (args: string[]) => {
        const program = new Command(); registerRemoteBridge(program);
        await program.parseAsync(['node', 'ccem', 'remote', ...args]);
      };
      await run(['status', 'run']);
      await run(['events', 'run', '--since', '12']);
      for (const platform of ['feishu', 'wecom', 'wechat', 'weixin', 'personal-wechat', 'future-platform']) {
        const args = ['send', 'run', '--platform', platform, '--chat-id', 'chat', '--message-id', 'msg1', '--text', 'continue'];
        for (const confirmation of ['run', 'different']) {
          await expect(run([...args, '--confirm', confirmation])).rejects.toThrow('CAPABILITY_UNAVAILABLE');
        }
        await expect(run(['relay', 'run', '--to', `${platform}:chat`, '--since', '0']))
          .rejects.toThrow('CAPABILITY_UNAVAILABLE');
      }
      expect(calls.map(call => call.method)).toEqual(['ccem.workspace.getSession', 'ccem.remote.getEvents']);
      expect(calls[1].params).toEqual({ runtimeId: 'run', sinceSeq: 12, limit: 100 });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });
});
