import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchAgentAuth } from '../launcher';

describe('isolated agent authentication executable boundary', () => {
  let home: string;
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-agent-auth-')));
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    for (const provider of ['claude', 'codex']) {
      const official = path.join(home, `.${provider}`);
      fs.mkdirSync(official);
      fs.writeFileSync(path.join(official, 'auth-fixture.json'), 'official-account');
      const script = `#!${process.execPath}\n` + `
        const fs = require('node:fs');
        const path = require('node:path');
        const root = process.env.${provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'};
        fs.writeFileSync(path.join(root, 'login-fixture.json'), 'ccem-account');
        fs.writeFileSync(process.env.CCEM_AUTH_CAPTURE, JSON.stringify({
          args: process.argv.slice(2), root,
          secure: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
          sqlite: process.env.CODEX_SQLITE_HOME,
          oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
          anthropic: process.env.ANTHROPIC_AUTH_TOKEN,
          openai: process.env.OPENAI_API_KEY,
          codex: process.env.CODEX_API_KEY,
        }));
      `;
      fs.writeFileSync(path.join(bin, provider), script, { mode: 0o700 });
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
