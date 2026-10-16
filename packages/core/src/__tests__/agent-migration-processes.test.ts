import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_MIGRATION_MARKER, ensureCcemAgentHome, getCcemAgentHome } from '../agent-home';

// A real Windows CIM query has its own 5 s deadline. The enclosing integration test
// also starts/stops a writer and copies the final snapshot; it must not expire first.
const writerTestTimeout = 15_000;

describe('migration with live legacy CCEM processes', () => {
  let home: string;
  let children: ChildProcess[];

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccem writer home ')));
    children = [];
  });
  afterEach(async () => {
    await Promise.all(children.map(stop));
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = once(child, 'exit', { signal: AbortSignal.timeout(2000) });
    child.kill();
    try { await stopped; } catch (error) {
      child.kill('SIGKILL');
      throw new Error(`Writer fixture ${child.pid} did not exit after termination`, { cause: error });
    }
  }

  function write(relative: string, contents: string) {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  }

  async function start(provider: 'claude' | 'codex', env: Record<string, string>, persistedPath?: string) {
    const relative = provider === 'claude' ? '@anthropic-ai/claude-code/cli.js' : '@openai/codex/bin/codex.js';
    const script = write(relative, "setInterval(() => {}, 1000); process.stdout.write('ready\\n');");
    const child = spawn(process.execPath, [script], {
      env: { PATH: process.env.PATH, HOME: home, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      let output = '';
      let diagnostics = '';
      const onData = (data: Buffer) => {
        output += data.toString();
        if (output.includes('ready\n')) finish();
      };
      const onStderr = (data: Buffer) => { diagnostics += data.toString(); };
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null) => finish(new Error(`Writer exited before ready (${code}): ${diagnostics}`));
      const timer = setTimeout(() => finish(new Error(`Writer did not become ready: ${diagnostics}`)), 3000);
      function finish(error?: Error) {
        clearTimeout(timer);
        child.stdout!.off('data', onData);
        child.stderr!.off('data', onStderr);
        child.off('error', onError);
        child.off('exit', onExit);
        if (error) reject(error); else resolve();
      }
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onStderr);
      child.on('error', onError);
      child.on('exit', onExit);
    });
    if (persistedPath) write('.ccem/sessions.json', JSON.stringify([
      { id: 'fixture', client: provider, pid: child.pid, status: 'running', jsonl_path: persistedPath },
    ]));
    return child;
  }

  it.each(['claude', 'codex'] as const)('defers %s migration until its legacy writer exits, including the final messages', async (provider) => {
    const relative = provider === 'claude' ? '.claude/projects/project/session.jsonl' : '.codex/sessions/old.jsonl';
    const source = write(relative, 'initial\n');
    const child = await start(provider, { CCEM_SESSION_ID: 'legacy-ccem' }, source);
    expect(() => ensureCcemAgentHome(provider, { HOME: home, CCEM_CODEX_ISOLATED: '1' })).toThrow(/live CCEM|still writing/);
    const root = getCcemAgentHome(provider, { HOME: home, CCEM_CODEX_ISOLATED: '1' });
    expect(fs.existsSync(path.join(root, AGENT_MIGRATION_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(home, '.ccem/agents/.ccem-migration.lock'))).toBe(false);
    fs.appendFileSync(source, 'last-message\n');
    await stop(child);
    ensureCcemAgentHome(provider, { HOME: home, CCEM_CODEX_ISOLATED: '1' });
    const copied = path.join(root, relative.split('/').slice(1).join('/'));
    expect(fs.readFileSync(copied, 'utf8')).toBe('initial\nlast-message\n');
    expect(fs.readFileSync(source, 'utf8')).toBe('initial\nlast-message\n');
  }, writerTestTimeout);

  it('allows official and already isolated writers and writers using another source home', async () => {
    write('.claude/projects/project/session.jsonl', 'legacy\n');
    await start('claude', {});
    const root = getCcemAgentHome('claude', { HOME: home, CCEM_CODEX_ISOLATED: '1' });
    await start('claude', { CCEM_SESSION_ID: 'isolated', CLAUDE_CONFIG_DIR: root }, path.join(root, 'projects/current.jsonl'));
    await start('claude', { CCEM_SESSION_ID: 'other-home', HOME: path.join(home, 'other user') });
    expect(ensureCcemAgentHome('claude', { HOME: home, CCEM_CODEX_ISOLATED: '1' })).toBe(root);
    expect(fs.readFileSync(path.join(root, 'projects/project/session.jsonl'), 'utf8')).toBe('legacy\n');
  });

  it('does not reopen a completed snapshot when a later official-directory writer starts', async () => {
    const source = write('.codex/sessions/old.jsonl', 'snapshot\n');
    const root = ensureCcemAgentHome('codex', { HOME: home, CCEM_CODEX_ISOLATED: '1' });
    await start('codex', { CCEM_RUNTIME_ID: 'after-snapshot' }, source);
    fs.appendFileSync(source, 'later-official-message\n');
    expect(ensureCcemAgentHome('codex', { HOME: home, CCEM_CODEX_ISOLATED: '1' })).toBe(root);
    expect(fs.readFileSync(path.join(root, 'sessions/old.jsonl'), 'utf8')).toBe('snapshot\n');
  });

  it('defers a custom shared Codex source until its CCEM writer finishes', async () => {
    const source = write('custom-codex/sessions/old.jsonl', 'initial\n');
    const sharedRoot = path.join(home, 'custom-codex');
    const child = await start('codex', { CCEM_RUNTIME_ID: 'custom-shared', CODEX_HOME: sharedRoot }, source);
    const env = { HOME: home, CODEX_HOME: sharedRoot, CCEM_CODEX_ISOLATED: '1' };
    expect(() => ensureCcemAgentHome('codex', env)).toThrow(/live CCEM|still writing/);
    fs.appendFileSync(source, 'last-message\n');
    await stop(child);
    const root = ensureCcemAgentHome('codex', env);
    expect(fs.readFileSync(path.join(root, 'sessions/old.jsonl'), 'utf8')).toBe('initial\nlast-message\n');
  }, writerTestTimeout);
});
