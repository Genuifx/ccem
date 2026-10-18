import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertNoLegacyAgentWriters } from './agent-migration-processes';
import { claudePluginImportPending, importClaudePlugins } from './agent-plugins';
import { claudePluginLinksPending, linkClaudePlugins } from './agent-plugin-links';

export type IsolatedAgentProvider = 'claude' | 'codex';
type AgentEnvironment = Record<string, string | undefined>;

export const AGENT_MIGRATION_MARKER = '.ccem-migration-v1.json';
const MIGRATION_LOCK = '.ccem-migration.lock';
const PROFILES_FILE = 'profiles.json';
const LEGACY_ENTRIES: Record<IsolatedAgentProvider, readonly string[]> = {
  claude: ['projects', 'history.jsonl', 'plans', 'file-history', 'CLAUDE.md'],
  codex: ['sessions', 'archived_sessions', 'history.jsonl', 'session_index.jsonl', 'memories', 'memories_v2', 'AGENTS.md', 'AGENTS.override.md'],
};

const IDENTITY_ENV_KEYS = [
  'ANTHROPIC_PROFILE', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR', 'CLAUDE_CODE_ORGANIZATION_UUID', 'CLAUDE_CODE_USER_EMAIL',
  'CLAUDE_CODE_HFI_BEARER_TOKEN', 'CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL', 'CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID',
  'CLAUDE_CODE_REMOTE_SETTINGS_PATH', 'CLAUDE_CODE_MOCK_REMOTE_SETTINGS',
  'CLAUDE_CODE_PLUGIN_SEED_DIR', 'CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE',
  'USE_LOCAL_OAUTH', 'USE_STAGING_OAUTH', 'CLAUDE_LOCAL_OAUTH_API_BASE',
  'CODEX_ACCESS_TOKEN',
] as const;

export function isAgentIdentityEnvKey(key: string): boolean {
  return (IDENTITY_ENV_KEYS as readonly string[]).includes(key)
    || ['CLAUDE_CODE_OAUTH_', 'CLAUDE_CODE_HOST_', 'CLAUDE_CODE_ACCOUNT_', 'CLAUDE_COWORK_MEMORY_']
      .some((prefix) => key.startsWith(prefix));
}

/** Values from a launching shell must not select an official app's account or provider. */
export const INHERITED_AGENT_ENV_KEYS = [
  ...IDENTITY_ENV_KEYS,
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_PROFILE',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_CLIENT_ID', 'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_ACCOUNT_TAGGED_ID',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_HOME', 'CODEX_SQLITE_HOME',
  'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_AWS_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION',
] as const;

/** Official Codex credentials and SQLite settings remain available in shared mode. */
export const SHARED_CODEX_ENV_KEYS = [
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_SQLITE_HOME',
] as const;

function userHome(env: AgentEnvironment): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function getCcemAgentBase(env: AgentEnvironment = process.env): string {
  const override = env.CCEM_AGENT_HOME?.trim();
  if (override && (!path.isAbsolute(override) || override.split(/[\\/]/).includes('..'))) {
    throw new Error("CCEM_AGENT_HOME must be an absolute path without '..'");
  }
  return path.resolve(override || path.join(userHome(env), '.ccem', 'agents'));
}

function readCodexIsolation(env: AgentEnvironment): boolean {
  if (env.CCEM_CODEX_ISOLATED === '1') return true;
  if (env.CCEM_CODEX_ISOLATED === '0') return false;
  const file = path.join(getCcemAgentBase(env), PROFILES_FILE);
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error('Cannot read CCEM agent profile preferences');
  }
  let profiles: unknown;
  try { profiles = JSON.parse(raw); } catch { throw new Error('CCEM agent profile preferences are invalid'); }
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new Error('CCEM agent profile preferences are invalid');
  }
  const value = (profiles as Record<string, unknown>).codexIsolation;
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error('CCEM codexIsolation preference must be a boolean');
  return value;
}

/** Read-only path lookups fail toward isolation; launch preparation reports invalid preferences. */
export function isCodexIsolated(env: AgentEnvironment = process.env): boolean {
  try { return readCodexIsolation(env); } catch { return true; }
}

export function getCcemIsolatedAgentHome(provider: IsolatedAgentProvider, env: AgentEnvironment = process.env): string {
  return path.join(getCcemAgentBase(env), provider);
}

function getOfficialCodexHome(env: AgentEnvironment): string {
  const override = env.CODEX_HOME?.trim();
  if (!override) return path.resolve(userHome(env), '.codex');
  if (override === '~') return path.resolve(userHome(env));
  if (/^~[\\/]/.test(override)) return path.resolve(userHome(env), override.slice(2));
  return path.resolve(override);
}

export function getCcemAgentHome(provider: IsolatedAgentProvider, env: AgentEnvironment = process.env): string {
  return provider === 'codex' && !isCodexIsolated(env)
    ? getOfficialCodexHome(env) : getCcemIsolatedAgentHome(provider, env);
}

export function getCcemAgentEnv(env: AgentEnvironment = process.env): Record<string, string> {
  const isolated = readCodexIsolation(env);
  const claude = getCcemIsolatedAgentHome('claude', env);
  const codex = isolated ? getCcemIsolatedAgentHome('codex', env) : getOfficialCodexHome(env);
  return {
    CLAUDE_CONFIG_DIR: claude,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: claude,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(claude, 'plugins'),
    CODEX_HOME: codex,
    CCEM_CODEX_ISOLATED: isolated ? '1' : '0',
    ...(isolated ? { CODEX_SQLITE_HOME: codex } : {}),
  };
}

export function clearInheritedAgentEnv(env: AgentEnvironment, codexIsolated = isCodexIsolated(env)): void {
  for (const key of Object.keys(env)) {
    if (!codexIsolated && (SHARED_CODEX_ENV_KEYS as readonly string[]).includes(key)) continue;
    if ((INHERITED_AGENT_ENV_KEYS as readonly string[]).includes(key)
      || isAgentIdentityEnvKey(key)) {
      delete env[key];
    }
  }
}

/** The base environment owns the storage boundary; selected model settings cannot redirect it. */
export function buildIsolatedAgentEnv(
  baseEnv: AgentEnvironment = process.env,
  selectedEnv: AgentEnvironment = {},
): Record<string, string> {
  const profile = getCcemAgentEnv(baseEnv);
  const codexIsolated = profile.CCEM_CODEX_ISOLATED === '1';
  const env = { ...baseEnv };
  clearInheritedAgentEnv(env, codexIsolated);
  Object.assign(env, selectedEnv);
  for (const key of Object.keys(env)) {
    if (isAgentIdentityEnvKey(key) && (codexIsolated || key !== 'CODEX_ACCESS_TOKEN')) delete env[key];
  }
  delete env.CLAUDECODE;
  // This is a launcher setting, never a per-model setting.
  if (baseEnv.CCEM_AGENT_HOME === undefined) delete env.CCEM_AGENT_HOME;
  else env.CCEM_AGENT_HOME = baseEnv.CCEM_AGENT_HOME;
  if (!codexIsolated) {
    if (baseEnv.CODEX_SQLITE_HOME === undefined) delete env.CODEX_SQLITE_HOME;
    else env.CODEX_SQLITE_HOME = baseEnv.CODEX_SQLITE_HOME;
  }
  Object.assign(env, profile);
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function statIfPresent(file: string): fs.Stats | undefined {
  try { return fs.lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function ensureRealDirectory(directory: string): void {
  validateNoSymlinks(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`CCEM agent directory must be a real directory: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
}

function validateNoSymlinks(file: string): void {
  let current = path.parse(file).root;
  for (const component of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = statIfPresent(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`CCEM agent state cannot use a symlink: ${current}`);
  }
}

function resolveExistingParent(file: string): string {
  const suffix: string[] = [];
  let parent = file;
  while (!statIfPresent(parent)) {
    suffix.unshift(path.basename(parent));
    parent = path.dirname(parent);
  }
  return path.join(fs.realpathSync(parent), ...suffix);
}

function validateAgentBase(base: string, env: AgentEnvironment): void {
  validateNoSymlinks(base);
  const resolved = resolveExistingParent(base);
  for (const name of ['.claude', '.codex']) {
    const official = resolveExistingParent(path.join(userHome(env), name));
    if (resolved === official || resolved.startsWith(`${official}${path.sep}`)
      || official.startsWith(`${resolved}${path.sep}`)) {
      throw new Error('CCEM agent state must not overlap an official Claude or Codex home');
    }
  }
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function migrationComplete(marker: string): boolean {
  const stat = statIfPresent(marker);
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('CCEM agent migration marker is invalid');
  let version: unknown;
  try { version = JSON.parse(fs.readFileSync(marker, 'utf8')).version; } catch { /* Fail below. */ }
  if (version !== 1) throw new Error('CCEM agent migration marker is invalid or unsupported');
  return true;
}

function writeNewFile(file: string, contents: string): void {
  validateNoSymlinks(file);
  const existing = statIfPresent(file);
  if (existing) {
    if (!existing.isFile()) throw new Error(`CCEM agent file conflicts with a directory: ${file}`);
    return;
  }
  const temporary = path.join(path.dirname(file), `.ccem-copy-${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(temporary, file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Publish a complete independent copy; never follow or overwrite a destination symlink. */
function copyLegacyEntry(source: string, destination: string): void {
  const sourceStat = statIfPresent(source);
  if (!sourceStat || sourceStat.isSymbolicLink()) return;
  if (sourceStat.isFile() && /\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm))?$/i.test(path.basename(source))) return;
  validateNoSymlinks(destination);
  const destinationStat = statIfPresent(destination);
  if (sourceStat.isDirectory()) {
    if (destinationStat && !destinationStat.isDirectory()) throw new Error(`CCEM agent directory conflicts with a file: ${destination}`);
    ensureRealDirectory(destination);
    for (const name of fs.readdirSync(source)) {
      copyLegacyEntry(path.join(source, name), path.join(destination, name));
    }
    syncDirectory(destination);
    return;
  }
  if (!sourceStat.isFile()) return;
  if (destinationStat) {
    if (!destinationStat.isFile()) throw new Error(`CCEM agent file conflicts with a directory: ${destination}`);
    return;
  }
  const temporary = path.join(path.dirname(destination), `.ccem-copy-${randomUUID()}.tmp`);
  let sourceFd: number | undefined;
  let destinationFd: number | undefined;
  try {
    sourceFd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const openedStat = fs.fstatSync(sourceFd);
    if (!openedStat.isFile()) throw new Error('Legacy agent history changed during migration');
    destinationFd = fs.openSync(temporary, 'wx', 0o600);
    const buffer = Buffer.alloc(1024 * 1024);
    let remaining = openedStat.size;
    while (remaining > 0) {
      const bytesRead = fs.readSync(sourceFd, buffer, 0, Math.min(remaining, buffer.length), null);
      if (!bytesRead) throw new Error('Legacy agent history changed during migration');
      let offset = 0;
      while (offset < bytesRead) offset += fs.writeSync(destinationFd, buffer, offset, bytesRead - offset);
      remaining -= bytesRead;
    }
    fs.futimesSync(destinationFd, openedStat.atime, openedStat.mtime);
    fs.fsyncSync(destinationFd);
    fs.closeSync(destinationFd);
    destinationFd = undefined;
    try { fs.linkSync(temporary, destination); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    if (sourceFd !== undefined) fs.closeSync(sourceFd);
    if (destinationFd !== undefined) fs.closeSync(destinationFd);
    fs.rmSync(temporary, { force: true });
  }
}

function acquireMigrationLock(base: string): () => void {
  const lockPath = path.join(base, MIGRATION_LOCK);
  const contents = JSON.stringify({ pid: process.pid });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, contents);
        fs.fsyncSync(fd);
      } catch (error) {
        const owned = fs.fstatSync(fd);
        const current = statIfPresent(lockPath);
        if (current?.ino === owned.ino && current.dev === owned.dev) fs.unlinkSync(lockPath);
        throw error;
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        if (statIfPresent(lockPath)?.isFile() && fs.readFileSync(lockPath, 'utf8') === contents) fs.unlinkSync(lockPath);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = fs.lstatSync(lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('CCEM agent migration lock is invalid');
      const old = fs.readFileSync(lockPath, 'utf8');
      let pid: unknown;
      try { pid = JSON.parse(old).pid; } catch { /* Fail closed below. */ }
      if (!Number.isSafeInteger(pid) || (pid as number) <= 0) throw new Error('CCEM agent migration lock is invalid');
      try { process.kill(pid as number, 0); } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === 'ESRCH' && attempt === 0) {
          if (fs.readFileSync(lockPath, 'utf8') !== old) throw new Error('CCEM agent migration lock changed; retry preparation');
          fs.unlinkSync(lockPath);
          continue;
        }
      }
      throw new Error(`CCEM agent migration is in progress (PID ${pid}); retry when it finishes`);
    }
  }
  throw new Error('Could not acquire CCEM agent migration lock');
}

/** Snapshot history once; import plugin choices and share only their code. */
export function ensureCcemAgentHome(
  provider: IsolatedAgentProvider,
  env: AgentEnvironment = process.env,
): string {
  if (provider === 'codex' && !readCodexIsolation(env)) return getOfficialCodexHome(env);
  const base = getCcemAgentBase(env);
  const root = getCcemIsolatedAgentHome(provider, env);
  validateAgentBase(base, env);
  for (const entry of LEGACY_ENTRIES[provider]) validateNoSymlinks(path.join(root, entry));
  validateNoSymlinks(path.join(root, provider === 'claude' ? '.claude.json' : 'config.toml'));
  const marker = path.join(root, AGENT_MIGRATION_MARKER);
  const source = provider === 'codex' ? getOfficialCodexHome(env) : path.join(userHome(env), '.claude');
  const historyReady = migrationComplete(marker);
  if (historyReady) {
    if (provider !== 'claude') return root;
    try { if (!claudePluginImportPending(source, root) && !claudePluginLinksPending(source, root)) return root; } catch (error) {
      console.warn(`CCEM plugin import deferred: ${(error as Error).message}`);
      return root;
    }
  }

  ensureRealDirectory(base);
  ensureRealDirectory(root);
  let unlock: () => void;
  try { unlock = acquireMigrationLock(base); } catch (error) {
    if (!historyReady) throw error;
    console.warn(`CCEM plugin import deferred: ${(error as Error).message}`);
    return root;
  }
  try {
    if (!migrationComplete(marker)) {
      if (provider === 'codex') {
        const resolvedBase = resolveExistingParent(base);
        const resolvedSource = resolveExistingParent(source);
        if (resolvedBase === resolvedSource || resolvedBase.startsWith(`${resolvedSource}${path.sep}`)
          || resolvedSource.startsWith(`${resolvedBase}${path.sep}`)) {
          throw new Error('CCEM Codex migration source must not overlap its isolated agent directory');
        }
      }
      assertNoLegacyAgentWriters(provider, userHome(env), source, root);
      const sourceStat = statIfPresent(source);
      if (sourceStat?.isDirectory() && !sourceStat.isSymbolicLink()) {
        for (const entry of LEGACY_ENTRIES[provider]) copyLegacyEntry(path.join(source, entry), path.join(root, entry));
      }
      if (provider === 'claude') writeNewFile(path.join(root, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
      writeNewFile(marker, JSON.stringify({ version: 1 }));
      syncDirectory(root);
    }
    if (provider === 'claude') {
      try { importClaudePlugins(source, root); linkClaudePlugins(source, root); } catch (error) {
        // A broken plugin must not prevent an existing conversation from resuming.
        console.warn(`CCEM plugin import deferred: ${(error as Error).message}`);
      }
    }
    return root;
  } finally {
    unlock();
  }
}
