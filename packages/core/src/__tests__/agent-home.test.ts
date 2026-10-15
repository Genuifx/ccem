import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_MIGRATION_MARKER,
  buildIsolatedAgentEnv,
  ensureCcemAgentHome,
  getCcemAgentEnv,
  getCcemAgentHome,
  getCcemIsolatedAgentHome,
  isCodexIsolated,
} from '../agent-home';

describe('CCEM agent homes', () => {
  let home: string;
  beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-agent-home-'))); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  function write(relative: string, value = relative) {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
    return file;
  }

  it('forces independent storage and removes inherited account overrides while preserving selected tokens', () => {
    const env = buildIsolatedAgentEnv({
      HOME: home, PATH: '/usr/bin', CCEM_CODEX_ISOLATED: '1',
      CLAUDE_CONFIG_DIR: '/official/claude', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/official/keychain',
      CODEX_HOME: '/official/codex', CODEX_SQLITE_HOME: '/official/sqlite',
      CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '4',
      CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'host-session', ANTHROPIC_PROFILE: 'host-profile',
      ANTHROPIC_API_KEY: 'host-key', OPENAI_API_KEY: 'host-openai', CODEX_API_KEY: 'host-codex',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_ANTHROPIC_AWS: '1', CLAUDE_CODE_USE_MANTLE: '1', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: inherited',
      CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '1', CLAUDE_CODE_USE_GATEWAY: '1',
      ANTHROPIC_AWS_API_KEY: 'inherited', ANTHROPIC_FOUNDRY_AUTH_TOKEN: 'inherited',
    }, {
      ANTHROPIC_AUTH_TOKEN: 'selected-token', CODEX_API_KEY: 'selected-codex',
      CLAUDE_CONFIG_DIR: '/override/claude', CODEX_HOME: '/override/codex',
      CCEM_AGENT_HOME: '/model-cannot-redirect',
      CLAUDE_CODE_OAUTH_TOKEN: 'caller-oauth', CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'caller-session',
      ANTHROPIC_PROFILE: 'caller-profile',
      CLAUDE_CODE_HOST_CREDS_FILE: '/official/host-creds', CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'host-refresh',
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '7', CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: '/official/memory',
      CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR: '8', CLAUDE_CODE_ORGANIZATION_UUID: 'official-org',
      CLAUDE_CODE_USER_EMAIL: 'official@example.invalid',
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(home, '.ccem/agents/claude'));
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(env.CLAUDE_CONFIG_DIR);
    expect(env.CODEX_HOME).toBe(path.join(home, '.ccem/agents/codex'));
    expect(env.CODEX_SQLITE_HOME).toBe(env.CODEX_HOME);
    expect(env).toMatchObject({ PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'selected-token', CODEX_API_KEY: 'selected-codex' });
    for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
      'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'ANTHROPIC_PROFILE', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'CLAUDE_CODE_USE_MANTLE', 'ANTHROPIC_CUSTOM_HEADERS', 'CCEM_AGENT_HOME', 'CLAUDE_CODE_HOST_CREDS_FILE',
      'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_GATEWAY',
      'ANTHROPIC_AWS_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
      'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR', 'CLAUDE_CODE_ORGANIZATION_UUID', 'CLAUDE_CODE_USER_EMAIL',
      'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE']) {
      expect(env[key], key).toBeUndefined();
    }
    expect(buildIsolatedAgentEnv({ HOME: home, ANTHROPIC_CUSTOM_HEADERS: 'inherited' }, {
      ANTHROPIC_CUSTOM_HEADERS: 'X-CCEM-Selected: configured',
    }).ANTHROPIC_CUSTOM_HEADERS).toBe('X-CCEM-Selected: configured');
  });

  it('accepts only an absolute launcher-owned base override', () => {
    expect(getCcemAgentHome('codex', { HOME: home, CCEM_AGENT_HOME: path.join(home, 'test-agents'), CCEM_CODEX_ISOLATED: '1' }))
      .toBe(path.join(home, 'test-agents/codex'));
    expect(() => getCcemAgentHome('claude', { CCEM_AGENT_HOME: 'relative' })).toThrow(/absolute/);
  });

  it('shares official Codex by default without creating or changing its state', () => {
    const auth = write('.codex/auth.json', 'official-login');
    write('.codex/config.toml', 'sqlite_home = "/official/config-sqlite"');
    const official = path.join(home, '.codex');
    fs.chmodSync(official, 0o751);
    expect(isCodexIsolated({ HOME: home })).toBe(false);
    expect(ensureCcemAgentHome('codex', { HOME: home })).toBe(official);
    expect(fs.readFileSync(auth, 'utf8')).toBe('official-login');
    expect(fs.statSync(official).mode & 0o777).toBe(0o751);
    expect(fs.existsSync(path.join(home, '.ccem'))).toBe(false);
    expect(fs.existsSync(path.join(official, AGENT_MIGRATION_MARKER))).toBe(false);
    expect(getCcemAgentEnv({ HOME: home })).not.toHaveProperty('CODEX_SQLITE_HOME');
    const absent = path.join(home, 'missing-official');
    expect(ensureCcemAgentHome('codex', { HOME: home, CODEX_HOME: absent })).toBe(absent);
    expect(fs.existsSync(absent)).toBe(false);
  });

  it('keeps shared Codex credentials and SQLite settings while Claude remains isolated', () => {
    const env = buildIsolatedAgentEnv({
      HOME: home, CODEX_HOME: '~/official-codex', CODEX_SQLITE_HOME: '~/official-sqlite',
      OPENAI_API_KEY: 'official-openai', OPENAI_BASE_URL: 'https://official.example',
      CODEX_API_KEY: 'official-codex', CODEX_ACCESS_TOKEN: 'official-access',
      CLAUDE_CODE_OAUTH_TOKEN: 'official-claude', CLAUDE_CONFIG_DIR: '/official/claude',
    }, { CCEM_CODEX_ISOLATED: '1', CODEX_HOME: '/model/codex', CODEX_SQLITE_HOME: '/model/sqlite' });
    expect(env).toMatchObject({
      CCEM_CODEX_ISOLATED: '0', CODEX_HOME: path.join(home, 'official-codex'),
      CODEX_SQLITE_HOME: '~/official-sqlite', OPENAI_API_KEY: 'official-openai',
      OPENAI_BASE_URL: 'https://official.example', CODEX_API_KEY: 'official-codex', CODEX_ACCESS_TOKEN: 'official-access',
      CLAUDE_CONFIG_DIR: path.join(home, '.ccem/agents/claude'),
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(buildIsolatedAgentEnv({ HOME: home }, { CODEX_SQLITE_HOME: '/model/sqlite' }))
      .not.toHaveProperty('CODEX_SQLITE_HOME');
    expect(getCcemAgentHome('codex', { HOME: home, CODEX_HOME: 'relative-codex' })).toBe(path.resolve('relative-codex'));
  });

  it('applies the preference to new launches while keeping existing process pins stable', () => {
    const source = write('.codex/sessions/old.jsonl', 'old session');
    const shared = buildIsolatedAgentEnv({ HOME: home });
    write('.ccem/agents/profiles.json', JSON.stringify({ codexIsolation: true, future: 'retained' }));
    expect(isCodexIsolated({ HOME: home })).toBe(true);
    expect(getCcemAgentHome('codex', shared)).toBe(path.join(home, '.codex'));
    const isolated = buildIsolatedAgentEnv({ HOME: home });
    const root = ensureCcemAgentHome('codex', { HOME: home });
    expect(root).toBe(getCcemIsolatedAgentHome('codex', { HOME: home }));
    expect(fs.readFileSync(path.join(root, 'sessions/old.jsonl'), 'utf8')).toBe('old session');
    write('.ccem/agents/profiles.json', JSON.stringify({ codexIsolation: false }));
    expect(getCcemAgentHome('codex', { HOME: home })).toBe(path.join(home, '.codex'));
    expect(getCcemAgentHome('codex', isolated)).toBe(root);
    expect(ensureCcemAgentHome('codex', isolated)).toBe(root);
    expect(fs.readFileSync(source, 'utf8')).toBe('old session');
  });

  it('snapshots a custom shared Codex home and rejects overlap before an unfinished migration', () => {
    write('custom-codex/sessions/custom.jsonl', 'custom session');
    write('.codex/sessions/default.jsonl', 'different session');
    const env = { HOME: home, CODEX_HOME: '~/custom-codex', CCEM_CODEX_ISOLATED: '1' };
    const root = ensureCcemAgentHome('codex', env);
    expect(fs.readFileSync(path.join(root, 'sessions/custom.jsonl'), 'utf8')).toBe('custom session');
    expect(fs.existsSync(path.join(root, 'sessions/default.jsonl'))).toBe(false);
    expect(ensureCcemAgentHome('codex', { ...env, CODEX_HOME: root })).toBe(root);
    const base = path.join(home, 'overlap-agents');
    expect(() => ensureCcemAgentHome('codex', { ...env, CCEM_AGENT_HOME: base, CODEX_HOME: path.join(base, 'codex') }))
      .toThrow(/overlap/);
    expect(fs.existsSync(path.join(base, 'codex', AGENT_MIGRATION_MARKER))).toBe(false);
  });

  it('does not silently fall back to sharing when preferences are invalid', () => {
    write('.ccem/agents/profiles.json', '{broken');
    expect(isCodexIsolated({ HOME: home })).toBe(true);
    expect(getCcemAgentHome('codex', { HOME: home })).toBe(path.join(home, '.ccem/agents/codex'));
    expect(() => buildIsolatedAgentEnv({ HOME: home })).toThrow(/invalid/);
    expect(() => ensureCcemAgentHome('codex', { HOME: home })).toThrow(/invalid/);
    expect(isCodexIsolated({ HOME: home, CCEM_CODEX_ISOLATED: '0' })).toBe(false);
    expect(isCodexIsolated({ HOME: home, CCEM_CODEX_ISOLATED: '1' })).toBe(true);
    write('.ccem/agents/profiles.json', JSON.stringify({ codexIsolation: 'yes' }));
    expect(() => getCcemAgentEnv({ HOME: home })).toThrow(/boolean/);
  });

  it('copies only legacy Claude sessions and memory once without overwriting either app', () => {
    const source = write('.claude/projects/project/session.jsonl', 'old-session\n');
    write('.claude/projects/project/memory/MEMORY.md', 'old memory');
    write('.claude/history.jsonl', 'history');
    write('.claude/plans/old.md', 'plan');
    write('.claude/file-history/checkpoint', 'snapshot');
    write('.claude/CLAUDE.md', 'global memory');
    for (const file of ['settings.json', '.credentials.json', '.claude.json', 'plugins/plugin.json']) write(`.claude/${file}`, 'secret');
    write('.claude.json', 'official-onboarding-secret');
    const root = ensureCcemAgentHome('claude', { HOME: home, CLAUDE_CONFIG_DIR: '/not-the-source' });
    const copied = path.join(root, 'projects/project/session.jsonl');
    expect(fs.readFileSync(copied, 'utf8')).toBe('old-session\n');
    expect(fs.statSync(source).ino).not.toBe(fs.statSync(copied).ino);
    expect(fs.readFileSync(path.join(root, 'projects/project/memory/MEMORY.md'), 'utf8')).toBe('old memory');
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toBe('global memory');
    for (const file of ['settings.json', '.credentials.json', 'plugins/plugin.json']) expect(fs.existsSync(path.join(root, file))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root, '.claude.json'), 'utf8'))).toEqual({ hasCompletedOnboarding: true });
    expect(JSON.parse(fs.readFileSync(path.join(root, AGENT_MIGRATION_MARKER), 'utf8'))).toEqual({ version: 1 });
    fs.appendFileSync(copied, 'ccem-only\n');
    fs.appendFileSync(source, 'official-only\n');
    write('.claude/projects/project/new-official.jsonl');
    ensureCcemAgentHome('claude', { HOME: home });
    expect(fs.readFileSync(copied, 'utf8')).toBe('old-session\nccem-only\n');
    expect(fs.readFileSync(source, 'utf8')).toBe('old-session\nofficial-only\n');
    expect(fs.existsSync(path.join(root, 'projects/project/new-official.jsonl'))).toBe(false);
  });

  it('keeps Codex rollouts and memories but excludes official credentials, configuration and SQLite', () => {
    for (const file of ['sessions/2026/old.jsonl', 'archived_sessions/old.jsonl', 'history.jsonl', 'session_index.jsonl', 'memories/summary.md', 'memories_v2/rollout_summaries/old.md', 'AGENTS.md', 'AGENTS.override.md']) write(`.codex/${file}`);
    for (const file of ['auth.json', 'config.toml', 'state_5.sqlite', 'skills/private/SKILL.md',
      'memories_v2/private.sqlite', 'memories_v2/private.sqlite-shm', 'memories_v2/state.db-wal']) write(`.codex/${file}`, 'secret');
    const root = ensureCcemAgentHome('codex', { HOME: home, CCEM_CODEX_ISOLATED: '1' });
    expect(fs.readFileSync(path.join(root, 'sessions/2026/old.jsonl'), 'utf8')).toBe('.codex/sessions/2026/old.jsonl');
    expect(fs.existsSync(path.join(root, 'memories/summary.md'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe('.codex/AGENTS.md');
    expect(fs.readFileSync(path.join(root, 'AGENTS.override.md'), 'utf8')).toBe('.codex/AGENTS.override.md');
    expect(fs.readFileSync(path.join(root, 'memories_v2/rollout_summaries/old.md'), 'utf8')).toBe('.codex/memories_v2/rollout_summaries/old.md');
    for (const file of ['auth.json', 'config.toml', 'state_5.sqlite', 'skills',
      'memories_v2/private.sqlite', 'memories_v2/private.sqlite-shm', 'memories_v2/state.db-wal']) expect(fs.existsSync(path.join(root, file))).toBe(false);
  });

  it('resumes incomplete copies without replacing CCEM data and skips symlinks', () => {
    write('.claude/projects/p/session.jsonl', 'official');
    write('.ccem/agents/claude/projects/p/session.jsonl', 'existing ccem');
    const external = write('external.jsonl', 'external');
    fs.symlinkSync(external, path.join(home, '.claude/projects/p/link.jsonl'));
    fs.symlinkSync(path.dirname(external), path.join(home, '.claude/projects/p/directory-link'));
    write('.claude/history.jsonl', 'official-history');
    const root = ensureCcemAgentHome('claude', { HOME: home });
    expect(fs.readFileSync(path.join(root, 'projects/p/session.jsonl'), 'utf8')).toBe('existing ccem');
    expect(fs.existsSync(path.join(root, 'projects/p/link.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'projects/p/directory-link'))).toBe(false);
    expect(fs.readFileSync(external, 'utf8')).toBe('external');
  });

  it('refuses a live or malformed migration lock without modifying official files', () => {
    const source = write('.claude/history.jsonl', 'original');
    write('.ccem/agents/.ccem-migration.lock', JSON.stringify({ pid: process.pid }));
    expect(() => ensureCcemAgentHome('claude', { HOME: home })).toThrow(/in progress/);
    expect(fs.readFileSync(source, 'utf8')).toBe('original');
    write('.ccem/agents/.ccem-migration.lock', 'not-json');
    expect(() => ensureCcemAgentHome('claude', { HOME: home })).toThrow(/invalid/);
  });

  it('rejects official-home overlap, symlink destinations and invalid completion markers', () => {
    write('.claude/history.jsonl', 'official');
    expect(() => ensureCcemAgentHome('claude', { HOME: home, CCEM_AGENT_HOME: path.join(home, '.claude/agents') }))
      .toThrow(/overlap/);
    expect(() => ensureCcemAgentHome('claude', { HOME: home, CCEM_AGENT_HOME: home }))
      .toThrow(/overlap/);
    write('.ccem/agents/claude/projects/fixture', 'existing');
    fs.symlinkSync(path.join(home, '.claude/history.jsonl'), path.join(home, '.ccem/agents/claude/history.jsonl'));
    expect(() => ensureCcemAgentHome('claude', { HOME: home })).toThrow(/symlink/);
    expect(fs.readFileSync(path.join(home, '.claude/history.jsonl'), 'utf8')).toBe('official');
    fs.unlinkSync(path.join(home, '.ccem/agents/claude/history.jsonl'));
    write(`.ccem/agents/claude/${AGENT_MIGRATION_MARKER}`, 'not complete');
    expect(() => ensureCcemAgentHome('claude', { HOME: home })).toThrow(/marker/);
  });

  it('keeps a migration retryable when a destination has the wrong file type', () => {
    write('.claude/projects/p/session.jsonl', 'history');
    const destination = path.join(home, '.ccem/agents/claude/projects/p/session.jsonl');
    fs.mkdirSync(destination, { recursive: true });
    expect(() => ensureCcemAgentHome('claude', { HOME: home })).toThrow(/conflicts/);
    expect(fs.existsSync(path.join(home, '.ccem/agents/claude', AGENT_MIGRATION_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(home, '.ccem/agents/.ccem-migration.lock'))).toBe(false);
    fs.rmdirSync(destination);
    ensureCcemAgentHome('claude', { HOME: home });
    expect(fs.readFileSync(destination, 'utf8')).toBe('history');
  });
});
