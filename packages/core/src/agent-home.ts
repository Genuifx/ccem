import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertNoLegacyAgentWriters } from './agent-migration-processes';

export type IsolatedAgentProvider = 'claude' | 'codex';
type AgentEnvironment = Record<string, string | undefined>;

export const AGENT_MIGRATION_MARKER = '.ccem-migration-v1.json';
const MIGRATION_LOCK = '.ccem-migration.lock';
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
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_HOME', 'CODEX_SQLITE_HOME',
  'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_AWS_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION',
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

export function getCcemAgentHome(provider: IsolatedAgentProvider, env: AgentEnvironment = process.env): string {
  return path.join(getCcemAgentBase(env), provider);
}

export function getCcemAgentEnv(env: AgentEnvironment = process.env): Record<string, string> {
  const claude = getCcemAgentHome('claude', env);
  const codex = getCcemAgentHome('codex', env);
  return {
    CLAUDE_CONFIG_DIR: claude,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: claude,
    CODEX_HOME: codex,
    CODEX_SQLITE_HOME: codex,
  };
}

export function clearInheritedAgentEnv(env: AgentEnvironment): void {
  for (const key of Object.keys(env)) {
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
  const env = { ...baseEnv };
  clearInheritedAgentEnv(env);
  Object.assign(env, selectedEnv);
  for (const key of Object.keys(env)) {
    if (isAgentIdentityEnvKey(key)) delete env[key];
  }
  delete env.CLAUDECODE;
  // This is a launcher setting, never a per-model setting.
  if (baseEnv.CCEM_AGENT_HOME === undefined) delete env.CCEM_AGENT_HOME;
  else env.CCEM_AGENT_HOME = baseEnv.CCEM_AGENT_HOME;
  Object.assign(env, getCcemAgentEnv(baseEnv));
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

/** Import session data once. Official settings, credentials, plugins and databases stay untouched. */
export function ensureCcemAgentHome(
  provider: IsolatedAgentProvider,
  env: AgentEnvironment = process.env,
): string {
  const base = getCcemAgentBase(env);
  const root = getCcemAgentHome(provider, env);
  validateAgentBase(base, env);
  ensureRealDirectory(base);
  ensureRealDirectory(root);
  for (const entry of LEGACY_ENTRIES[provider]) validateNoSymlinks(path.join(root, entry));
  validateNoSymlinks(path.join(root, provider === 'claude' ? '.claude.json' : 'config.toml'));
  const marker = path.join(root, AGENT_MIGRATION_MARKER);
  if (migrationComplete(marker)) return root;

  const unlock = acquireMigrationLock(base);
  try {
    if (migrationComplete(marker)) return root;
    const source = path.join(userHome(env), provider === 'claude' ? '.claude' : '.codex');
    assertNoLegacyAgentWriters(provider, userHome(env), source, root);
    const sourceStat = statIfPresent(source);
    if (sourceStat?.isDirectory() && !sourceStat.isSymbolicLink()) {
      for (const entry of LEGACY_ENTRIES[provider]) copyLegacyEntry(path.join(source, entry), path.join(root, entry));
    }
    if (provider === 'claude') writeNewFile(path.join(root, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
    writeNewFile(marker, JSON.stringify({ version: 1 }));
    syncDirectory(root);
    return root;
  } finally {
    unlock();
  }
}
