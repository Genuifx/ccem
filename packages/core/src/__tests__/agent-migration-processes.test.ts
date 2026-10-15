import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_MIGRATION_MARKER, ensureCcemAgentHome, getCcemAgentHome } from '../agent-home';

describe('migration with live legacy CCEM processes', () => {
  let home: string;
  let children: ChildProcess[];

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccem writer home ')));
    children = [];
  });
  afterEach(async () => {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'exit');
        child.kill();
        await stopped;
      }
    }));
    fs.rmSync(home, { recursive: true, force: true });
  });

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
    await Promise.race([once(child.stdout!, 'data'), once(child, 'error').then(([error]) => { throw error; })]);
    if (persistedPath) write('.ccem/sessions.json', JSON.stringify([
      { id: 'fixture', client: provider, pid: child.pid, status: 'running', jsonl_path: persistedPath },
    ]));
    return child;
  }

  it.each(['claude', 'codex'] as const)('defers %s migration until its legacy writer exits, including the final messages', async (provider) => {
    const relative = provider === 'claude' ? '.claude/projects/project/session.jsonl' : '.codex/sessions/old.jsonl';
    const source = write(relative, 'initial\n');
    const child = await start(provider, { CCEM_SESSION_ID: 'legacy-ccem' }, source);
    expect(() => ensureCcemAgentHome(provider, { HOME: home })).toThrow(/live CCEM|still writing/);
    const root = getCcemAgentHome(provider, { HOME: home });
    expect(fs.existsSync(path.join(root, AGENT_MIGRATION_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(home, '.ccem/agents/.ccem-migration.lock'))).toBe(false);
    fs.appendFileSync(source, 'last-message\n');
    const stopped = once(child, 'exit');
    child.kill();
    await stopped;
    ensureCcemAgentHome(provider, { HOME: home });
    const copied = path.join(root, relative.split('/').slice(1).join('/'));
    expect(fs.readFileSync(copied, 'utf8')).toBe('initial\nlast-message\n');
    expect(fs.readFileSync(source, 'utf8')).toBe('initial\nlast-message\n');
  });

  it('allows official and already isolated writers and writers using another source home', async () => {
    write('.claude/projects/project/session.jsonl', 'legacy\n');
    await start('claude', {});
    const root = getCcemAgentHome('claude', { HOME: home });
    await start('claude', { CCEM_SESSION_ID: 'isolated', CLAUDE_CONFIG_DIR: root }, path.join(root, 'projects/current.jsonl'));
    await start('claude', { CCEM_SESSION_ID: 'other-home', HOME: path.join(home, 'other user') });
    expect(ensureCcemAgentHome('claude', { HOME: home })).toBe(root);
    expect(fs.readFileSync(path.join(root, 'projects/project/session.jsonl'), 'utf8')).toBe('legacy\n');
  });

  it('does not reopen a completed snapshot when a later official-directory writer starts', async () => {
    const source = write('.codex/sessions/old.jsonl', 'snapshot\n');
    const root = ensureCcemAgentHome('codex', { HOME: home });
    await start('codex', { CCEM_RUNTIME_ID: 'after-snapshot' }, source);
    fs.appendFileSync(source, 'later-official-message\n');
    expect(ensureCcemAgentHome('codex', { HOME: home })).toBe(root);
    expect(fs.readFileSync(path.join(root, 'sessions/old.jsonl'), 'utf8')).toBe('snapshot\n');
  });
});
