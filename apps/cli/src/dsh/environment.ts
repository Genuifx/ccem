import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { parseVersion } from './version.js';

const execFileAsync = promisify(execFile);

export const DSH_PROFILE = 'headless';

/**
 * The active dsh root: the inherited `$DSH_HOME` when set, otherwise dsh's
 * own `~/.dsh` default. ccem never overrides `DSH_HOME` — session logs keep
 * flowing to the user's active root.
 */
export function resolveDshRoot(env: NodeJS.ProcessEnv = process.env): string {
  const inherited = env.DSH_HOME?.trim();
  if (inherited) return inherited;
  const home = env.HOME?.trim() || os.homedir();
  return path.join(home, '.dsh');
}

/**
 * DshInvocation represents the resolved command to launch dsh.
 * - POSIX: the resolved dsh binary path (direct executable).
 * - Windows: node.exe + the dsh entry point script (since npm .cmd shims
 *   cannot be executed with shell:false).
 *
 * Both paths always use shell:false — no task text can ever be
 * shell-interpreted.
 */
export interface DshInvocation {
  /** The binary to spawn (dsh on POSIX, node.exe on Windows). */
  bin: string;
  /** Prefix args before dsh's own argv (empty on POSIX, [entryScript] on Windows). */
  prefix: readonly string[];
}

export interface InvocationDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Resolve an executable by scanning PATH (POSIX-style). */
export function resolveBinOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (name.includes('/') || (platform === 'win32' && name.includes('\\'))) {
    return fileIsExecutable(name, platform) ? name : null;
  }
  const searchDirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean)
    : [''];
  for (const dir of searchDirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      if (fileIsExecutable(candidate, platform)) return candidate;
    }
  }
  return null;
}

function fileIsExecutable(file: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (platform === 'win32') {
      // On Windows, X_OK check is unreliable; just verify it's a readable file.
      return fs.statSync(file).isFile();
    }
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the dsh invocation for the current platform.
 *
 * - POSIX: look up `dsh` on PATH, verify it's executable, use it directly.
 * - Windows: find the dsh shim on PATH. If it's a .exe or .com, use it
 *   directly (shell:false works). If it's a .cmd, resolve node.exe and the
 *   verified @deepseek-ai/dsh entry point (package.json name must match,
 *   bin.dsh must point to a real file). .bat and .ps1 are rejected.
 *
 * Returns null if the binary cannot be resolved (fail-closed).
 */
export function resolveDshInvocation(deps: InvocationDeps = {}): DshInvocation | null {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;

  if (platform === 'win32') {
    return resolveWindowsDshInvocation(env);
  }
  // POSIX: direct executable
  const bin = resolveBinOnPath('dsh', env, platform);
  if (!bin) return null;
  return { bin, prefix: [] };
}

function resolveWindowsDshInvocation(env: NodeJS.ProcessEnv): DshInvocation | null {
  const dshFile = resolveBinOnPath('dsh', env, 'win32');
  if (!dshFile) return null;

  const ext = path.extname(dshFile).toLowerCase();

  // .exe and .com can be spawned directly with shell:false.
  if (ext === '.exe' || ext === '.com') {
    return { bin: dshFile, prefix: [] };
  }

  // Only .cmd shims are supported via node+entry; reject .bat/.ps1.
  if (ext !== '.cmd') return null;

  // Resolve the @deepseek-ai/dsh package in the shim's directory tree.
  const shimDir = path.dirname(dshFile);
  const candidates = [
    path.join(shimDir, 'node_modules', '@deepseek-ai', 'dsh'),
    path.join(shimDir, '..', 'node_modules', '@deepseek-ai', 'dsh'),
  ];

  for (const pkgDir of candidates) {
    const entryScript = verifyDshPackage(pkgDir);
    if (entryScript) {
      const nodeExe = resolveBinOnPath('node', env, 'win32');
      if (!nodeExe) return null;
      return { bin: nodeExe, prefix: [entryScript] };
    }
  }

  return null;
}

/**
 * Verify a candidate @deepseek-ai/dsh package directory:
 * - package.json must exist and have name === '@deepseek-ai/dsh'
 * - package.json bin.dsh must point to a real file within the package
 * - After realpath resolution, the entry must still reside under the package root
 *   (prevents symlink/traversal escape)
 * - The resolved entry must be a regular file (not a directory)
 * Returns the resolved absolute entry path, or null on failure.
 */
function verifyDshPackage(pkgDir: string): string | null {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  try {
    const raw = fs.readFileSync(pkgJsonPath, 'utf-8');
    const pkg = JSON.parse(raw);
    if (pkg.name !== '@deepseek-ai/dsh') return null;
    // Resolve the bin entry.
    const binEntry = typeof pkg.bin === 'string'
      ? pkg.bin
      : (pkg.bin?.dsh ?? null);
    if (!binEntry || typeof binEntry !== 'string') return null;
    const entryPath = path.resolve(pkgDir, binEntry);
    // Verify the entry script actually exists as a real file.
    const realEntry = fs.realpathSync(entryPath);
    const realPkgDir = fs.realpathSync(pkgDir);
    // Containment check: resolved entry must be under the real package root.
    if (!realEntry.startsWith(realPkgDir + path.sep) && realEntry !== realPkgDir) return null;
    // Must be a regular file, not a directory.
    if (!fs.statSync(realEntry).isFile()) return null;
    return realEntry;
  } catch {
    return null;
  }
}

const VERSION_TOKEN = /v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

/** Extract a version from the first meaningful `--version` output line. */
export function extractVersionOutput(stdout: string): string | null {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = VERSION_TOKEN.exec(line);
    if (match) return match[1];
  }
  return null;
}

export interface VersionProbeDeps {
  env?: NodeJS.ProcessEnv;
  exec?: (bin: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string | null>;
}

/**
 * Strict allowlist of environment keys passed to version-probe subprocesses.
 * Only the minimum keys needed for a child process to locate and run binaries.
 * Everything else is dropped — no denylist, no exceptions.
 */
const PROBE_ALLOWED_KEYS = new Set([
  // Binary/library resolution
  'PATH',
  'PATHEXT',
  // Windows system roots
  'SystemRoot',
  'SYSTEMROOT',
  'COMSPEC',
  'windir',
  // Home/user identity (needed by some runtimes for config discovery)
  'HOME',
  'USERPROFILE',
  'USER',
  'LOGNAME',
  // Temp dirs (some runtimes need a writable tmp)
  'TMPDIR',
  'TMP',
  'TEMP',
  // Locale (affects output encoding/parsing)
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // Terminal (some binaries change behavior if missing)
  'TERM',
  'COLORTERM',
  'TERM_PROGRAM',
]);

/**
 * Build a sanitized environment for version probes. Uses a strict allowlist:
 * only copies keys that are necessary for a subprocess to locate binaries and
 * run. All other keys are discarded — this prevents leaking credentials,
 * code-injection vectors (NODE_OPTIONS, LD_PRELOAD, DYLD_INSERT_LIBRARIES),
 * or any other ambient state into the probe child.
 */
export function buildProbeEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PROBE_ALLOWED_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Probe a binary's version via `--version`. Uses the DshInvocation model
 * so version probes and actual launches use the same resolution.
 * The subprocess runs in a sanitized environment (no ambient credentials).
 */
export async function probeBinVersion(
  invocation: DshInvocation | string,
  deps: VersionProbeDeps = {},
): Promise<string | null> {
  const bin = typeof invocation === 'string' ? invocation : invocation.bin;
  const prefix = typeof invocation === 'string' ? [] : invocation.prefix;
  const args = [...prefix, '--version'];
  const probeEnv = buildProbeEnv(deps.env ?? process.env);

  if (deps.exec) return deps.exec(bin, args, probeEnv);
  try {
    const { stdout } = await execFileAsync(bin, args, {
      env: probeEnv,
      timeout: 15_000,
      windowsHide: true,
    });
    const version = extractVersionOutput(stdout);
    return version ?? (parseVersion(stdout.trim()) ? stdout.trim() : null);
  } catch {
    return null;
  }
}

/**
 * Probe a simple binary's version with `<bin> --version`.
 * For cases where the binary is a plain path (e.g., node).
 * The subprocess runs in a sanitized environment (no ambient credentials).
 */
export async function probeSimpleBinVersion(
  bin: string,
  deps: VersionProbeDeps = {},
): Promise<string | null> {
  const probeEnv = buildProbeEnv(deps.env ?? process.env);
  if (deps.exec) return deps.exec(bin, ['--version'], probeEnv);
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], {
      env: probeEnv,
      timeout: 15_000,
      windowsHide: true,
    });
    const version = extractVersionOutput(stdout);
    return version ?? (parseVersion(stdout.trim()) ? stdout.trim() : null);
  } catch {
    return null;
  }
}
