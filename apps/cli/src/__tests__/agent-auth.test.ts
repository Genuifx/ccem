import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchAgentAuth } from '../launcher';

describe('isolated agent authentication executable boundary', () => {
  let home: string;
  let fixtureDir: string;
  let executable: string;
  const extension = process.platform === 'win32' ? '.exe' : '';
  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-auth-executable-'));
    executable = path.join(fixtureDir, `agent-auth${extension}`);
    // shell:false must launch a native executable on Windows. Rust is already part
    // of the repository's CI toolchain; use the same real fixture on every OS.
    execFileSync('rustc', [
      '--edition=2021', fileURLToPath(new URL('./fixtures/agent-auth.rs', import.meta.url)), '-o', executable,
    ], { stdio: 'pipe', timeout: 30_000 });
  }, 35_000);
  afterAll(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccem agent auth ')));
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    for (const provider of ['claude', 'codex']) {
      const official = path.join(home, `.${provider}`);
      fs.mkdirSync(official);
      fs.writeFileSync(path.join(official, 'auth-fixture.json'), 'official-account');
      fs.copyFileSync(executable, path.join(bin, `${provider}${extension}`));
    }
    vi.stubEnv('HOME', home);
    vi.stubEnv('CCEM_CODEX_ISOLATED', '1');
    vi.stubEnv('CCEM_AGENT_HOME', path.join(home, 'agents'));
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
    vi.stubEnv('CCEM_AUTH_CAPTURE', path.join(home, 'capture.json'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'));
    vi.stubEnv('CODEX_HOME', path.join(home, '.codex'));
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'official-oauth');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'selected-shell-token');
    vi.stubEnv('OPENAI_API_KEY', 'official-api-key');
    vi.stubEnv('CODEX_API_KEY', 'official-codex-key');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  for (const provider of ['claude', 'codex'] as const) {
    it(`logs ${provider} into the CCEM home without inherited login overrides`, async () => {
      await launchAgentAuth(provider);
      const captured = JSON.parse(fs.readFileSync(path.join(home, 'capture.json'), 'utf8'));
      const root = path.join(home, 'agents', provider);
      expect(captured.root).toBe(root);
      expect(captured.secure).toBe(path.join(home, 'agents', 'claude'));
      expect(captured.sqlite).toBe(path.join(home, 'agents', 'codex'));
      for (const key of ['oauth', 'anthropic', 'openai', 'codex']) expect(captured[key]).toBeUndefined();
      expect(captured.args).toEqual(provider === 'claude'
        ? ['auth', 'login']
        : ['--config', `sqlite_home=${JSON.stringify(root)}`, 'login']);
      expect(fs.readFileSync(path.join(root, 'login-fixture.json'), 'utf8')).toBe('ccem-account');
      expect(fs.readFileSync(path.join(home, `.${provider}`, 'auth-fixture.json'), 'utf8')).toBe('official-account');
      expect(fs.existsSync(path.join(home, `.${provider}`, 'login-fixture.json'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'auth-fixture.json'))).toBe(false);
    });
  }

  it('uses the official Codex login and inherited environment by default', async () => {
    vi.stubEnv('CCEM_CODEX_ISOLATED', undefined);
    vi.stubEnv('CODEX_SQLITE_HOME', path.join(home, 'official-sqlite'));
    await launchAgentAuth('codex');
    const captured = JSON.parse(fs.readFileSync(path.join(home, 'capture.json'), 'utf8'));
    expect(captured.args).toEqual(['login']);
    expect(captured.root).toBe(path.join(home, '.codex'));
    expect(captured.sqlite).toBe(path.join(home, 'official-sqlite'));
    expect(captured.openai).toBe('official-api-key');
    expect(captured.codex).toBe('official-codex-key');
    expect(captured.oauth).toBeUndefined();
    expect(fs.existsSync(path.join(home, 'agents'))).toBe(false);
    expect(fs.readFileSync(path.join(home, '.codex/login-fixture.json'), 'utf8')).toBe('ccem-account');
  });
});
