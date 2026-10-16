import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('conf', () => ({
  default: class {
    store: Record<string, unknown>;
    constructor(options: { defaults?: Record<string, unknown> } = {}) { this.store = structuredClone(options.defaults ?? {}); }
    get(key: string) { return this.store[key]; }
    set(key: string, value: unknown) { this.store[key] = value; }
  },
}));

describe('CLI shell environment profile selection', () => {
  let home: string;
  const argv = process.argv;
  beforeEach(() => {
    vi.resetModules();
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-shell-profile-')));
    vi.stubEnv('HOME', home);
    vi.stubEnv('CCEM_AGENT_HOME', path.join(home, 'agents'));
    vi.stubEnv('CCEM_CODEX_ISOLATED', undefined);
    vi.stubEnv('CODEX_HOME', path.join(home, '.codex'));
    vi.stubEnv('CODEX_SQLITE_HOME', path.join(home, 'official-sqlite'));
    vi.stubEnv('CODEX_API_KEY', 'fixture-codex-key');
    vi.stubEnv('CODEX_ACCESS_TOKEN', 'fixture-access-token');
    vi.stubEnv('OPENAI_API_KEY', 'fixture-openai-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://fixture.invalid');
  });
  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  for (const isolated of [false, true]) {
    it(`shell exports preserve the ${isolated ? 'isolated' : 'shared'} Codex profile`, async () => {
      fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(home, 'agents/profiles.json'), JSON.stringify({ codexIsolation: isolated }));
      const output: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...values) => { output.push(values.map(String).join(' ')); });
      process.argv = [process.execPath, 'index.ts', 'env'];
      await import('../index.js');
      const capture = path.join(home, 'capture.cjs');
      fs.writeFileSync(capture, `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify([
        'CODEX_HOME', 'CODEX_SQLITE_HOME', 'CCEM_CODEX_ISOLATED', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN',
        'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLAUDE_CONFIG_DIR',
      ])}.map(key => [key, process.env[key]]))));`);
      const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
      const evaluated = spawnSync('/bin/sh', ['-c', `${output.join('\n')}\n${quote(process.execPath)} ${quote(capture)}`], {
        env: process.env, encoding: 'utf8',
      });
      expect(evaluated.status, evaluated.stderr).toBe(0);
      const env = JSON.parse(evaluated.stdout);
      expect(env.CCEM_CODEX_ISOLATED).toBe(isolated ? '1' : '0');
      expect(env.CODEX_HOME).toBe(path.join(home, isolated ? 'agents/codex' : '.codex'));
      expect(env.CODEX_SQLITE_HOME).toBe(path.join(home, isolated ? 'agents/codex' : 'official-sqlite'));
      expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(home, 'agents/claude'));
      expect(env.CODEX_API_KEY).toBe(isolated ? undefined : 'fixture-codex-key');
      expect(env.CODEX_ACCESS_TOKEN).toBe(isolated ? undefined : 'fixture-access-token');
      expect(env.OPENAI_API_KEY).toBe(isolated ? undefined : 'fixture-openai-key');
      expect(env.OPENAI_BASE_URL).toBe(isolated ? undefined : 'https://fixture.invalid');
    });
  }
});
