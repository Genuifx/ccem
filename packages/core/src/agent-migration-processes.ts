import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Provider = 'claude' | 'codex';
type PersistedProcess = { pid: number; client?: string; jsonlPath?: string };

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    try { value = fs.realpathSync(value); } catch { value = path.resolve(value); }
    return process.platform === 'win32' ? value.toLowerCase() : value;
  };
  return normalize(left) === normalize(right);
}

function providerCommand(provider: Provider, executable: string, command: string): boolean {
  const name = path.basename(executable).toLowerCase().replace(/\.exe$/, '');
  if (name === provider) return true;
  if (!['node', 'bun', 'ccem-node'].includes(name) && !name.startsWith('ccem-node-')) return false;
  if (/(?:^|[\\/\s])native-runtime-helper\.mjs(?:[\s"']|$)/.test(command)) return true;
  return provider === 'claude'
    ? /@anthropic-ai[\\/]claude-code[\\/]cli\.js(?:[\s"']|$)/.test(command)
    : /@openai[\\/]codex[\\/]bin[\\/]codex\.js(?:[\s"']|$)/.test(command);
}

function candidateExecutable(executable: string): boolean {
  const name = path.basename(executable).toLowerCase().replace(/\.exe$/, '');
  return ['claude', 'codex', 'node', 'bun', 'ccem-node'].includes(name) || name.startsWith('ccem-node-');
}

function ps(args: string[]): string {
  return execFileSync('ps', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 16 * 1024 * 1024,
  }).trimEnd();
}

/** ps appends environment after argv; retain spaces in values such as HOME. */
function parseEnvironment(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  const boundaries = [...value.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)];
  for (let i = 0; i < boundaries.length; i += 1) {
    const entry = boundaries[i];
    if (!['HOME', 'USERPROFILE', 'CCEM_RUNTIME_ID', 'CCEM_SESSION_ID', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].includes(entry[1])) continue;
    const start = entry.index! + entry[0].length;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].index! : value.length;
    result[entry[1]] = value.slice(start, end).trim();
  }
  return result;
}

function migrationBlocked(provider: Provider, pid: number, unknownHome = false): never {
  const reason = unknownHome
    ? `Cannot verify the agent home of a live CCEM ${provider} session (PID ${pid}).`
    : `A live CCEM ${provider} session (PID ${pid}) is still writing legacy history.`;
  throw new Error(`${reason} Finish that session and retry to preserve its latest messages before isolation.`);
}

function persistedProcesses(home: string): PersistedProcess[] {
  const result: PersistedProcess[] = [];
  for (const name of ['sessions.json', 'runtime-state.json']) {
    const file = path.join(home, '.ccem', name);
    let value: unknown;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      value = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error('Cannot inspect saved CCEM sessions before migration; retry when their state is available');
    }
    const rows = Array.isArray(value) ? value : (value as { sessions?: unknown[] } | null)?.sessions;
    for (const raw of Array.isArray(rows) ? rows : []) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      if (!Number.isSafeInteger(row.pid) || (row.pid as number) <= 0 || row.pid === process.pid) continue;
      if (typeof row.status === 'string' && row.status !== 'running') continue;
      if (row.summary) continue;
      result.push({
        pid: row.pid as number,
        client: typeof row.client === 'string' ? row.client : undefined,
        jsonlPath: typeof row.jsonl_path === 'string' ? row.jsonl_path : undefined,
      });
    }
  }
  return result;
}

function persistedPathIsLegacy(record: PersistedProcess, provider: Provider, source: string): boolean {
  if (record.client && record.client !== provider) return false;
  if (!record.jsonlPath) return true;
  const roots = provider === 'claude' ? ['projects'] : ['sessions', 'archived_sessions'];
  const candidate = path.resolve(record.jsonlPath);
  return roots.some((name) => {
    const directory = path.resolve(source, name);
    const relative = path.relative(directory, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
}

function assertWindowsProcesses(provider: Provider, home: string, source: string): void {
  for (const record of persistedProcesses(home)) {
    if (!persistedPathIsLegacy(record, provider, source) || !processAlive(record.pid)) continue;
    let command: { Name?: string; CommandLine?: string };
    try {
      const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter 'ProcessId = ${record.pid}' | Select-Object Name,CommandLine | ConvertTo-Json -Compress`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      command = JSON.parse(output);
    } catch {
      if (processAlive(record.pid)) migrationBlocked(provider, record.pid, true);
      continue;
    }
    if (!command || !providerCommand(provider, command.Name || '', command.CommandLine || '')) continue;
    migrationBlocked(provider, record.pid, !record.jsonlPath);
  }
}

/** Snapshot only after old CCEM writers finish; unrelated official processes keep running. */
export function assertNoLegacyAgentWriters(provider: Provider, home: string, source: string, destination: string): void {
  if (process.platform === 'win32') {
    assertWindowsProcesses(provider, home, source);
    return;
  }
  let listing: string;
  try { listing = ps(['-ax', '-o', 'pid=,comm=']); } catch {
    throw new Error('Cannot inspect running CCEM sessions before migration; finish legacy sessions and retry');
  }
  const candidates = new Map<number, string>();
  for (const row of listing.split('\n')) {
    const match = row.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const executable = match[2];
    if (pid === process.pid || !candidateExecutable(executable)) continue;
    candidates.set(pid, executable);
  }
  if (candidates.size === 0) return;
  const commands = new Map<number, string>();
  try {
    const rows = ps(['ww', '-p', [...candidates.keys()].join(','), '-o', 'pid=,command=']);
    for (const row of rows.split('\n')) {
      const match = row.match(/^\s*(\d+)\s+(.+)$/);
      if (match) commands.set(Number(match[1]), match[2]);
    }
  } catch { /* Processes may have exited between the two inventories. */ }
  for (const [pid, executable] of candidates) {
    const command = commands.get(pid);
    if (!command) {
      if (processAlive(pid) && persistedProcesses(home).some((record) => record.pid === pid && persistedPathIsLegacy(record, provider, source))) {
        migrationBlocked(provider, pid, true);
      }
      continue;
    }
    if (!providerCommand(provider, executable, command)) continue;
    let withEnvironment: string;
    try { withEnvironment = ps(['eww', '-p', String(pid), '-o', 'command=']); } catch {
      if (processAlive(pid) && persistedProcesses(home).some((record) => record.pid === pid && persistedPathIsLegacy(record, provider, source))) {
        migrationBlocked(provider, pid, true);
      }
      continue;
    }
    const env = withEnvironment.startsWith(command)
      ? parseEnvironment(withEnvironment.slice(command.length).trimStart()) : {};
    if (Object.keys(env).length === 0 && processAlive(pid)
      && persistedProcesses(home).some((record) => record.pid === pid && persistedPathIsLegacy(record, provider, source))) {
      migrationBlocked(provider, pid, true);
    }
    if (!env.CCEM_RUNTIME_ID?.trim() && !env.CCEM_SESSION_ID?.trim()) continue;
    const sourceHome = env.HOME || env.USERPROFILE || home;
    let effectiveHome = provider === 'claude'
      ? env.CLAUDE_CONFIG_DIR || path.join(sourceHome, '.claude')
      : env.CODEX_HOME || path.join(sourceHome, '.codex');
    if (/^~[\\/]/.test(effectiveHome)) effectiveHome = path.join(sourceHome, effectiveHome.slice(2));
    if (samePath(effectiveHome, source) && !samePath(effectiveHome, destination) && processAlive(pid)) {
      migrationBlocked(provider, pid);
    }
  }
}
