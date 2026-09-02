import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DshProjectionError, type DshProviderSpec } from './provider.js';
import { DSH_API_KEY_ENV } from './provider.js';
import { renderCordisPatch } from './patch.js';
import {
  DSH_PROFILE,
  type DshInvocation,
  type VersionProbeDeps,
  resolveBinOnPath,
  resolveDshInvocation,
  resolveDshRoot,
  probeBinVersion,
  probeSimpleBinVersion,
} from './environment.js';
import {
  DSH_NODE_MIN_VERSION,
  DSH_REQUIRED_VERSION,
  isDshVersionCompatible,
  isNodeVersionCompatible,
} from './version.js';

/**
 * Launches the external `dsh` binary for one headless task.
 *
 * Safety contract:
 * - argv arrays with `shell: false` — task text is a single literal argv
 *   element and can never be shell-interpreted;
 * - launcher flags (`--profile`, `--patch`) come before the task argument;
 * - the token reaches the child only as `CCEM_DSH_API_KEY`; every
 *   credential-shaped variable is stripped from the child environment, and
 *   the token never appears in argv, patch content, errors, or logs;
 * - stdout/stderr are inherited and the exit code (or 128+signal) is
 *   preserved;
 * - the temporary patch directory is removed on every exit path.
 * - `close` is the sole settle point; `error` only records diagnostics.
 */

/**
 * Ambient environment variable patterns stripped from the child.
 * Uses both prefix-based and generic credential-shaped name matching.
 * A key is stripped if it matches ANY of these criteria:
 * - Starts with a known sensitive prefix (ANTHROPIC_, OPENAI_, etc.)
 * - Contains TOKEN, SECRET, PASSWORD, CREDENTIAL(S), PRIVATE_KEY,
 *   or ACCESS_KEY (case-insensitive) anywhere in the name
 * - Starts with DSH_ (except DSH_HOME which is explicitly restored)
 */
const STRIP_PREFIX_PATTERNS: readonly RegExp[] = [
  /^ANTHROPIC_/i,
  /^CLAUDE_CODE_/i,
  /^OPENAI_/i,
  /^DEEPSEEK_/i,
  /^AWS_/i,
  /^AZURE_/i,
  /^GOOGLE_/i,
  /^HF_/i,
  /^HUGGING_FACE_/i,
  /^DSH_/i,
];

/** Generic credential-shaped substrings (case-insensitive). */
const STRIP_CREDENTIAL_SUBSTRINGS: readonly RegExp[] = [
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /CREDENTIALS?/i,
  /PRIVATE[_-]?KEY/i,
  /ACCESS[_-]?KEY/i,
];

/** Keys explicitly preserved even if they match a strip pattern. */
const PRESERVE_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_RUNTIME_DIR',
  'COLORTERM',
  'TERM_PROGRAM',
]);

function isCredentialShaped(key: string): boolean {
  if (PRESERVE_KEYS.has(key)) return false;
  if (STRIP_PREFIX_PATTERNS.some((re) => re.test(key))) return true;
  if (STRIP_CREDENTIAL_SUBSTRINGS.some((re) => re.test(key))) return true;
  return false;
}

const FORWARD_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export type DshPermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export const DSH_PERMISSION_MODES: readonly DshPermissionMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
];

export const DSH_PERMISSION_ENV = 'DSH_PERMISSION_MODE';

export type SpawnFn = (bin: string, args: string[], opts: SpawnOptions) => ChildProcess;

/**
 * Removes the temporary patch directory. Exported to allow deterministic
 * spy-counting in lifecycle tests.
 */
export function cleanupTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export interface DshRunOptions {
  /** The one-shot task text; a single argv element, never shell-evaluated. */
  task: string;
  spec: DshProviderSpec;
  /** Decrypted auth token; passed only as `CCEM_DSH_API_KEY`. */
  token: string;
  /** Working directory for the dsh process. */
  cwd?: string;
  /** Resolved dsh invocation; defaults to PATH resolution. */
  invocation?: DshInvocation;
  /** dsh profile to boot; defaults to the built-in `headless` template. */
  profile?: string;
  /** Permission mode for the dsh child. Defaults to 'workspace-write'. */
  permission?: DshPermissionMode;
  /** Parent environment to inherit (tests inject); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Platform override for testing. */
  platform?: NodeJS.Platform;
  stdio?: SpawnOptions['stdio'];
  /** Test hook observing the spawned child before exit. */
  onSpawned?: (child: ChildProcess) => void;
  /** Injectable spawn implementation for testing; defaults to child_process.spawn (shell:false). */
  spawnImpl?: SpawnFn;
  /** Injectable cleanup for testing; defaults to cleanupTempDir. */
  cleanupImpl?: (dir: string) => void;
}

export interface DshRunResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  /** Non-fatal spawn diagnostics (e.g. ENOENT); never contains the token. */
  spawnError: string | null;
  /** Absolute path of the (already removed) temporary patch directory. */
  tempDir: string;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const known = (os.constants.signals as Record<string, number | { number: number } | undefined>)[signal];
  const number = typeof known === 'number' ? known : known?.number;
  return number === undefined ? 1 : 128 + number;
}

export function buildDshArgv(options: {
  invocation: DshInvocation;
  profile?: string;
  patchPath: string;
  task: string;
}): string[] {
  return [
    ...options.invocation.prefix,
    '--profile', options.profile ?? DSH_PROFILE,
    '--patch', options.patchPath,
    options.task,
  ];
}

export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  token: string,
  options: { inheritedDshHome?: string; permission?: DshPermissionMode } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (isCredentialShaped(key)) continue;
    env[key] = value;
  }
  // Only restore DSH_HOME if the parent explicitly had it set (non-empty).
  // When unset, let dsh resolve its own ~/.dsh default internally.
  if (options.inheritedDshHome) {
    env.DSH_HOME = options.inheritedDshHome;
  }
  // The single credential channel into the dsh child.
  env[DSH_API_KEY_ENV] = token;
  // Permission mode for dsh headless.
  env[DSH_PERMISSION_ENV] = options.permission ?? 'workspace-write';
  return env;
}

export interface DshGateResult {
  invocation: DshInvocation;
  dshVersion: string;
  nodeVersion: string;
}

export interface DshPreflightOptions extends VersionProbeDeps {
  platform?: NodeJS.Platform;
}

/**
 * Pre-flight runtime gate. Must pass before token decrypt or spawn.
 * Checks: binary resolution, dsh == 0.1.1-rc.2, node >= 22.19.0.
 * Returns the resolved invocation on success; throws DshProjectionError on failure.
 */
export async function runPreflightGate(
  options: DshPreflightOptions = {},
): Promise<DshGateResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const invocation = resolveDshInvocation({ env, platform });
  if (!invocation) {
    throw new DshProjectionError(
      'DSH_BINARY_MISSING',
      'dsh binary not found on PATH. Install it with: npm install -g @deepseek-ai/dsh@0.1.1-rc.2',
    );
  }

  const probeDeps = { env, exec: options.exec };
  const dshVersion = await probeBinVersion(invocation, probeDeps);
  if (dshVersion === null) {
    throw new DshProjectionError(
      'DSH_VERSION_UNREADABLE',
      `Could not determine dsh version from '${invocation.bin}'. Ensure dsh --version works.`,
    );
  }
  if (!isDshVersionCompatible(dshVersion)) {
    throw new DshProjectionError(
      'DSH_VERSION_UNSUPPORTED',
      `dsh ${dshVersion} is not the verified contract version. ccem dsh requires exactly dsh ${DSH_REQUIRED_VERSION}. Install: npm install -g @deepseek-ai/dsh@${DSH_REQUIRED_VERSION}`,
    );
  }

  // Resolve the node that will run dsh:
  // - On Windows with prefix (cmd shim → node+entry): invocation.bin IS node.
  // - On Windows with direct .exe/.com: invocation.bin is dsh itself; resolve node from PATH.
  // - On POSIX: resolve node from PATH.
  const nodeBin = (platform === 'win32' && invocation.prefix.length > 0)
    ? invocation.bin
    : resolveBinOnPath('node', env, platform) ?? 'node';
  const nodeVersion = await probeSimpleBinVersion(nodeBin, probeDeps);
  if (nodeVersion === null) {
    throw new DshProjectionError(
      'NODE_VERSION_UNREADABLE',
      `Could not determine node version. dsh requires Node >= ${DSH_NODE_MIN_VERSION}.`,
    );
  }
  if (!isNodeVersionCompatible(nodeVersion)) {
    throw new DshProjectionError(
      'NODE_VERSION_UNSUPPORTED',
      `Node ${nodeVersion} < ${DSH_NODE_MIN_VERSION}. dsh's LLM stack requires Node >= ${DSH_NODE_MIN_VERSION}; switch the PATH-visible node (e.g. via nvm).`,
    );
  }

  return { invocation, dshVersion, nodeVersion };
}

export async function runDshTask(options: DshRunOptions): Promise<DshRunResult> {
  const task = options.task.trim();
  if (!task) {
    throw new DshProjectionError('EMPTY_TASK', 'A non-empty task is required');
  }
  if (task.startsWith('-')) {
    throw new DshProjectionError(
      'LEADING_DASH_TASK',
      'The task must not start with "-" — dsh would parse it as a launcher flag; rephrase the task',
    );
  }
  if (options.permission !== undefined && !DSH_PERMISSION_MODES.includes(options.permission)) {
    throw new DshProjectionError(
      'INVALID_PERMISSION',
      `Invalid permission mode '${options.permission}'; expected one of: ${DSH_PERMISSION_MODES.join(', ')}`,
    );
  }
  const token = options.token;
  if (!token) {
    throw new DshProjectionError('MISSING_TOKEN', 'No auth token available for the dsh child');
  }

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const invocation = options.invocation ?? resolveDshInvocation({ env, platform });
  if (!invocation) {
    return {
      exitCode: 1,
      signal: null,
      spawnError: 'dsh binary not found on PATH. Install: npm install -g @deepseek-ai/dsh@0.1.1-rc.2',
      tempDir: '',
    };
  }

  // Only inherit DSH_HOME if the parent explicitly set it (non-empty).
  const inheritedDshHome = env.DSH_HOME?.trim() || undefined;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-dsh-'));
  const patchPath = path.join(tempDir, 'cordis.ccem.patch.yml');
  const patchContent = renderCordisPatch(options.spec);
  fs.writeFileSync(patchPath, patchContent, { mode: 0o600 });

  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let spawnError: string | null = null;

  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finishOnce = () => {
        if (settled) return;
        settled = true;
        for (const [sig, handler] of handlers) {
          process.removeListener(sig, handler);
        }
        resolve();
      };

      const argv = buildDshArgv({
        invocation,
        profile: options.profile,
        patchPath,
        task,
      });

      const doSpawn = options.spawnImpl ?? defaultSpawn;
      let child: ChildProcess;
      try {
        child = doSpawn(invocation.bin, argv, {
          shell: false,
          stdio: options.stdio ?? 'inherit',
          env: buildChildEnv(env, token, {
            inheritedDshHome,
            permission: options.permission,
          }),
          cwd: options.cwd,
        });
      } catch (err: unknown) {
        // Synchronous spawn throw (rare but possible on some platforms).
        const msg = err instanceof Error ? err.message : String(err);
        spawnError = `Failed to launch dsh: ${msg.replaceAll(token, '<redacted>')}`;
        resolve();
        return;
      }

      // Register signal forwarding handlers.
      const forward = (received: NodeJS.Signals): void => {
        if (child.exitCode === null && child.signalCode === null && !child.killed) {
          child.kill(received);
        }
      };
      const handlers = new Map<NodeJS.Signals, NodeJS.SignalsListener>();
      for (const sig of FORWARD_SIGNALS) {
        const handler: NodeJS.SignalsListener = () => forward(sig);
        handlers.set(sig, handler);
        process.on(sig, handler);
      }

      // Error handler records the diagnostic but NEVER settles the promise.
      // Node always emits `close` after an error for a spawned ChildProcess
      // (including ENOENT, EACCES, EPERM). `close` is the sole settle point.
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          spawnError = `dsh binary not found at '${invocation.bin.replaceAll(token, '<redacted>')}'. Install: npm install -g @deepseek-ai/dsh@0.1.1-rc.2`;
        } else {
          const msg = err.message.replaceAll(token, '<redacted>');
          spawnError = `Failed to launch dsh: ${msg}`;
        }
      });

      // `close` is the sole async settle point. It fires after all stdio
      // streams close and after any error event. Patch cleanup happens in
      // the `finally` block after this promise resolves.
      child.once('close', (code, sig) => {
        exitCode = code;
        signal = sig;
        finishOnce();
      });

      // Call onSpawned AFTER all listeners are registered.
      options.onSpawned?.(child);
    });
  } finally {
    try {
      (options.cleanupImpl ?? cleanupTempDir)(tempDir);
    } catch {
      // Cleanup is best-effort; never mask the child's result.
    }
  }

  return {
    exitCode: exitCode !== null && exitCode >= 0 ? exitCode : signalExitCode(signal),
    signal,
    spawnError: spawnError ?? (exitCode !== null && exitCode < 0 ? 'dsh exited abnormally' : null),
    tempDir,
  };
}
