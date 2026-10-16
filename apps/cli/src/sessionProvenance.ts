import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { getCcemAgentHome } from '@ccem/core';

const DEFAULT_CONFIG_SOURCE = 'ccem';
const STATE_DB_FILE_NAME = 'state.sqlite';
const BIND_POLL_INTERVAL_MS = 500;
const BIND_POLL_TIMEOUT_MS = 20_000;
const SQLITE_EXPERIMENTAL_WARNING = 'SQLite is an experimental feature';

const require = createRequire(import.meta.url);

interface StatementSyncLike {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncLike;
  close(): void;
}

type DatabaseSyncConstructor = new (dbPath: string) => DatabaseSyncLike;

let databaseSyncCtor: DatabaseSyncConstructor | null = null;
let databaseSyncResolved = false;
let sqlite3CliAvailable: boolean | null = null;

export interface CliProvenanceTrackingHandle {
  ccemSessionId: string;
  stop: () => void;
}

interface StartCliClaudeTrackingOptions {
  ccemSessionId?: string;
  envName: string;
  workingDir: string;
  permMode?: string;
  resumeSessionId?: string;
}

interface RegisterLaunchOptions {
  ccemSessionId: string;
  client: string;
  envName: string;
  configSource?: string;
  workingDir: string;
  permMode?: string;
  launchMode: string;
  startedVia: string;
  sourceSessionId?: string;
}

export function startCliClaudeProvenanceTracking(
  options: StartCliClaudeTrackingOptions,
): CliProvenanceTrackingHandle | null {
  const envName = normalizeText(options.envName) ?? 'unknown';
  const workingDir = normalizeText(options.workingDir);
  if (!workingDir) {
    return null;
  }

  const ccemSessionId = normalizeText(options.ccemSessionId)
    ?? `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    registerLaunch({
      ccemSessionId,
      client: 'claude',
      envName,
      configSource: DEFAULT_CONFIG_SOURCE,
      workingDir,
      permMode: normalizeText(options.permMode),
      launchMode: 'cli_external',
      startedVia: 'cli',
      sourceSessionId: normalizeText(options.resumeSessionId),
    });
  } catch (error) {
    reportTrackingError('register launch', error);
    return null;
  }

  let timer: NodeJS.Timeout | null = null;
  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const resumeSessionId = normalizeText(options.resumeSessionId);
  if (resumeSessionId) {
    return { ccemSessionId, stop };
  }

  const startedAtMs = Date.now();
  timer = setInterval(() => {
    if (Date.now() - startedAtMs > BIND_POLL_TIMEOUT_MS) {
      stop();
      return;
    }

    try {
      const jsonlPath = discoverClaudeJsonlPath(workingDir, startedAtMs);
      if (!jsonlPath) {
        return;
      }

      const sourceSessionId =
        readClaudeSessionId(jsonlPath) ?? normalizeText(path.parse(jsonlPath).name);
      if (!sourceSessionId) {
        return;
      }

      bindSourceSessionId('claude', ccemSessionId, sourceSessionId);
      stop();
    } catch (error) {
      reportTrackingError('bind source session id', error);
      stop();
    }
  }, BIND_POLL_INTERVAL_MS);

  return { ccemSessionId, stop };
}

function registerLaunch(options: RegisterLaunchOptions): void {
  const now = new Date().toISOString();
  const DatabaseSync = getDatabaseSyncCtor();
  if (DatabaseSync) {
    const db = openNodeSqliteDb(DatabaseSync);
    try {
      const statement = db.prepare(`
        INSERT INTO session_provenance (
          ccem_session_id,
          client,
          env_name,
          config_source,
          working_dir,
          perm_mode,
          launch_mode,
          started_via,
          source_session_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ccem_session_id) DO UPDATE SET
          client = excluded.client,
          env_name = excluded.env_name,
          config_source = COALESCE(excluded.config_source, session_provenance.config_source),
          working_dir = excluded.working_dir,
          perm_mode = COALESCE(excluded.perm_mode, session_provenance.perm_mode),
          launch_mode = excluded.launch_mode,
          started_via = excluded.started_via,
          source_session_id = COALESCE(excluded.source_session_id, session_provenance.source_session_id),
          updated_at = excluded.updated_at
      `);

      statement.run(
        options.ccemSessionId,
        options.client,
        options.envName,
        normalizeText(options.configSource),
        options.workingDir,
        normalizeText(options.permMode),
        options.launchMode,
        options.startedVia,
        normalizeText(options.sourceSessionId),
        now,
        now,
      );
      return;
    } finally {
      db.close();
    }
  }

  execSqlite3Cli(`
    INSERT INTO session_provenance (
      ccem_session_id,
      client,
      env_name,
      config_source,
      working_dir,
      perm_mode,
      launch_mode,
      started_via,
      source_session_id,
      created_at,
      updated_at
    ) VALUES (
      ${sqliteLiteral(options.ccemSessionId)},
      ${sqliteLiteral(options.client)},
      ${sqliteLiteral(options.envName)},
      ${sqliteLiteral(normalizeText(options.configSource))},
      ${sqliteLiteral(options.workingDir)},
      ${sqliteLiteral(normalizeText(options.permMode))},
      ${sqliteLiteral(options.launchMode)},
      ${sqliteLiteral(options.startedVia)},
      ${sqliteLiteral(normalizeText(options.sourceSessionId))},
      ${sqliteLiteral(now)},
      ${sqliteLiteral(now)}
    )
    ON CONFLICT(ccem_session_id) DO UPDATE SET
      client = excluded.client,
      env_name = excluded.env_name,
      config_source = COALESCE(excluded.config_source, session_provenance.config_source),
      working_dir = excluded.working_dir,
      perm_mode = COALESCE(excluded.perm_mode, session_provenance.perm_mode),
      launch_mode = excluded.launch_mode,
      started_via = excluded.started_via,
      source_session_id = COALESCE(excluded.source_session_id, session_provenance.source_session_id),
      updated_at = excluded.updated_at;
  `);
}

function bindSourceSessionId(client: string, ccemSessionId: string, sourceSessionId: string): void {
  const updatedAt = new Date().toISOString();
  const DatabaseSync = getDatabaseSyncCtor();
  if (DatabaseSync) {
    const db = openNodeSqliteDb(DatabaseSync);
    try {
      const statement = db.prepare(`
        UPDATE session_provenance
        SET source_session_id = ?, updated_at = ?
        WHERE ccem_session_id = ? AND client = ?
      `);
      statement.run(sourceSessionId, updatedAt, ccemSessionId, client);
      return;
    } finally {
      db.close();
    }
  }

  execSqlite3Cli(`
    UPDATE session_provenance
    SET source_session_id = ${sqliteLiteral(sourceSessionId)},
        updated_at = ${sqliteLiteral(updatedAt)}
    WHERE ccem_session_id = ${sqliteLiteral(ccemSessionId)}
      AND client = ${sqliteLiteral(client)};
  `);
}

function openNodeSqliteDb(DatabaseSync: DatabaseSyncConstructor): DatabaseSyncLike {
  const dbPath = getStateDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec(schemaSql());
  return db;
}

function getDatabaseSyncCtor(): DatabaseSyncConstructor | null {
  if (databaseSyncResolved) {
    return databaseSyncCtor;
  }

  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const message =
      typeof warning === 'string'
        ? warning
        : warning instanceof Error
          ? warning.message
          : String(warning);
    if (message.includes(SQLITE_EXPERIMENTAL_WARNING)) {
      return;
    }
    return (originalEmitWarning as (...input: unknown[]) => void)(warning, ...args);
  }) as typeof process.emitWarning;

  try {
    const loaded = require('node:sqlite') as { DatabaseSync: DatabaseSyncConstructor };
    databaseSyncCtor = loaded.DatabaseSync;
  } catch {
    databaseSyncCtor = null;
  } finally {
    process.emitWarning = originalEmitWarning;
    databaseSyncResolved = true;
  }

  return databaseSyncCtor;
}

function execSqlite3Cli(statementSql: string): void {
  if (sqlite3CliAvailable == null) {
    try {
      execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
      sqlite3CliAvailable = true;
    } catch {
      sqlite3CliAvailable = false;
    }
  }

  if (!sqlite3CliAvailable) {
    throw new Error('sqlite3 CLI is unavailable and node:sqlite is not supported by this Node runtime');
  }

  const dbPath = getStateDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  execFileSync('sqlite3', [dbPath], {
    input: `${schemaSql()}\n${statementSql}\n`,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
}

function getStateDbPath(): string {
  const override = normalizeText(process.env.CCEM_STATE_DB_PATH);
  if (override) {
    return override;
  }
  return path.join(os.homedir(), '.ccem', STATE_DB_FILE_NAME);
}

function schemaSql(): string {
  return `
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS session_provenance (
      ccem_session_id TEXT PRIMARY KEY,
      client TEXT NOT NULL,
      env_name TEXT NOT NULL,
      config_source TEXT,
      working_dir TEXT NOT NULL,
      perm_mode TEXT,
      launch_mode TEXT NOT NULL,
      started_via TEXT NOT NULL,
      source_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_provenance_client_source
      ON session_provenance (client, source_session_id);
    CREATE INDEX IF NOT EXISTS idx_session_provenance_client_updated
      ON session_provenance (client, updated_at DESC);
  `;
}

function discoverClaudeJsonlPath(projectDir: string, startedAtMs: number): string | null {
  const projectsDir = path.join(getCcemAgentHome('claude'), 'projects');
  const earliestModifiedAt = startedAtMs - 15_000;

  for (const key of projectDirKeys(projectDir)) {
    const baseDir = path.join(projectsDir, key);
    if (!fs.existsSync(baseDir)) {
      continue;
    }

    const candidates = fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => {
        const fullPath = path.join(baseDir, entry.name);
        return { path: fullPath, modifiedAt: fs.statSync(fullPath).mtimeMs };
      })
      .filter((candidate) => candidate.modifiedAt >= earliestModifiedAt)
      .sort((left, right) => right.modifiedAt - left.modifiedAt);

    if (candidates.length > 0) {
      return candidates[0]!.path;
    }
  }

  return null;
}

function projectDirKeys(projectDir: string): string[] {
  const candidates = [projectDir];

  try {
    candidates.push(fs.realpathSync(projectDir));
  } catch {
    // Ignore canonicalization failures.
  }

  if (process.platform === 'darwin') {
    if (projectDir.startsWith('/private/')) {
      candidates.push(projectDir.slice('/private'.length));
    } else if (projectDir.startsWith('/tmp')) {
      candidates.push(path.posix.join('/private', projectDir));
    } else if (projectDir.startsWith('/var/')) {
      candidates.push(path.posix.join('/private', projectDir));
    }
  }

  return [...new Set(candidates.map(projectDirKey))];
}

function projectDirKey(projectDir: string): string {
  return projectDir.replace(/[\/\\: ]/g, '-');
}

function readClaudeSessionId(jsonlPath: string): string | null {
  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const value = JSON.parse(line) as { sessionId?: string };
      const sessionId = normalizeText(value.sessionId);
      if (sessionId) {
        return sessionId;
      }
    } catch {
      // Ignore malformed lines.
    }
  }
  return null;
}

function normalizeText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sqliteLiteral(value: string | undefined): string {
  if (!value) {
    return 'NULL';
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function reportTrackingError(stage: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ccem] Failed to ${stage}: ${message}`);
}
