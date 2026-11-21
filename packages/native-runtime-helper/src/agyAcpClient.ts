import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import process from 'node:process';

export const AGY_AUTH_REQUIRED_PREFIX =
  'AGY_AUTH_REQUIRED: Antigravity is not signed in. Sign in with Google to continue.';

const MIN_RECOMMENDED_AGY_VERSION: readonly [number, number, number] = [1, 5, 5];
const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
const SESSION_CLOSE_TIMEOUT_MS = 800;
const EOF_EXIT_GRACE_MS = 1_500;
const SIGTERM_EXIT_GRACE_MS = 1_500;

export class AcpJsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'AcpJsonRpcError';
    this.code = code;
    this.data = data;
  }
}

export function isAgyAuthRequiredError(error: unknown): boolean {
  if (error instanceof AcpJsonRpcError && error.code === -32000) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /authentication required/i.test(message);
}

export function formatAgyAuthRequiredError(error: unknown): string {
  const detail = error instanceof Error ? error.message.trim() : String(error ?? '').trim();
  if (!detail || /^authentication required$/i.test(detail)) {
    return AGY_AUTH_REQUIRED_PREFIX;
  }
  if (detail.startsWith(AGY_AUTH_REQUIRED_PREFIX)) {
    return detail;
  }
  return `${AGY_AUTH_REQUIRED_PREFIX} (${detail})`;
}

export function parseSemverTuple(version: string | undefined | null): [number, number, number] | null {
  if (!version || typeof version !== 'string') {
    return null;
  }
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isAgyVersionBelowRecommended(version: string | undefined | null): boolean {
  const parsed = parseSemverTuple(version);
  if (!parsed) {
    return false;
  }
  for (let i = 0; i < 3; i += 1) {
    if (parsed[i]! < MIN_RECOMMENDED_AGY_VERSION[i]!) {
      return true;
    }
    if (parsed[i]! > MIN_RECOMMENDED_AGY_VERSION[i]!) {
      return false;
    }
  }
  return false;
}

const AGY_STRIPPED_ENV_KEYS = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR',
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'CCEM_CODEX_ISOLATED',
]);

function isDisallowedAgyEnvKey(key: string): boolean {
  return key.startsWith('ANTHROPIC_') || AGY_STRIPPED_ENV_KEYS.has(key);
}

/**
 * Build the subprocess environment for `agy acp`.
 *
 * CRITICAL: Never calls `buildIsolatedAgentEnv`, never overrides `HOME` (nor
 * `--app-data-dir` / `--gemini-dir`), and strips `ANTHROPIC_*` plus Claude/Codex
 * isolation env vars from both `baseEnv` and `extraEnvVars` so `agy` reuses the
 * user's native `~/.gemini/antigravity-cli` Google login cleanly.
 */
export function buildAgyProcessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  extraEnvVars?: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined || isDisallowedAgyEnvKey(key)) {
      continue;
    }
    env[key] = value;
  }
  if (extraEnvVars) {
    for (const [key, value] of Object.entries(extraEnvVars)) {
      if (typeof value !== 'string') {
        continue;
      }
      if (key === 'HOME' && baseEnv.HOME) {
        continue;
      }
      if (isDisallowedAgyEnvKey(key)) {
        continue;
      }
      env[key] = value;
    }
  }
  return env;
}

export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export type AcpConfigOptionValue = {
  value: string;
  name?: string;
  description?: string;
};

export type AcpConfigOption = {
  configId?: string;
  id?: string;
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: AcpConfigOptionValue[];
};

export type AcpAvailableMode = {
  id: string;
  name?: string;
  description?: string;
};

export type AcpAgentCapabilities = {
  loadSession?: boolean;
  load_session?: boolean;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  sessionCapabilities?: {
    resume?: Record<string, unknown>;
    close?: Record<string, unknown>;
    load?: Record<string, unknown>;
    list?: Record<string, unknown>;
    additionalDirectories?: Record<string, unknown>;
  };
  session_capabilities?: {
    resume?: Record<string, unknown>;
    close?: Record<string, unknown>;
    load?: Record<string, unknown>;
    list?: Record<string, unknown>;
    additionalDirectories?: Record<string, unknown>;
  };
  [key: string]: unknown;
};

export type AcpInitializeResult = {
  protocolVersion?: number;
  agentInfo?: {
    name?: string;
    version?: string;
  };
  agentCapabilities?: AcpAgentCapabilities;
  authMethods?: Array<{
    id: string;
    name?: string;
    description?: string;
    type?: string;
    args?: string[];
  }>;
  [key: string]: unknown;
};

export type AcpSessionNewResult = {
  sessionId: string;
  configOptions?: AcpConfigOption[];
  modes?: {
    currentModeId?: string;
    availableModes?: AcpAvailableMode[];
  };
  availableModes?: AcpAvailableMode[];
  [key: string]: unknown;
};

export type AcpPromptResult = {
  stopReason?: string;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
};

export type AcpPermissionOption = {
  optionId: string;
  name?: string;
  kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
};

export type AcpPermissionRequestParams = {
  sessionId?: string;
  toolCall?: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: unknown;
    locations?: unknown[];
    [key: string]: unknown;
  };
  options?: AcpPermissionOption[];
  [key: string]: unknown;
};

export type AcpPermissionResponse = {
  outcome:
    | { outcome: 'selected'; optionId: string }
    | { outcome: 'cancelled' };
};

export type AcpSessionUpdateParams = {
  sessionId?: string;
  update?: Record<string, unknown>;
  [key: string]: unknown;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export type AgyAcpClientOptions = {
  agyPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  dangerouslySkipPermissions?: boolean;
  requestTimeoutMs?: number;
  onSessionUpdate?: (params: AcpSessionUpdateParams) => void;
  onRequestPermission?: (params: AcpPermissionRequestParams) => Promise<AcpPermissionResponse>;
  onStderrLine?: (line: string) => void;
  onWarning?: (message: string) => void;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
};

function readObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export class AgyAcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number | string, PendingRequest>();
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  private initializedResult: AcpInitializeResult | null = null;
  private activeSessionId: string | null = null;

  constructor(private readonly options: AgyAcpClientOptions) {}

  get isAlive(): boolean {
    return Boolean(this.child && !this.closed && this.child.exitCode === null && this.child.signalCode === null);
  }

  get initializeResult(): AcpInitializeResult | null {
    return this.initializedResult;
  }

  get currentSessionId(): string | null {
    return this.activeSessionId;
  }

  start(): void {
    if (this.child) {
      return;
    }
    this.closed = false;

    const args = [
      'acp',
      ...(this.options.dangerouslySkipPermissions ? ['--dangerously-skip-permissions'] : []),
    ];

    const child = spawn(this.options.agyPath, args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.handleStderrChunk(chunk);
    });

    child.stdin.on('error', () => {
      // Broken pipe errors during teardown or unexpected child exit are surfaced via exit/error.
    });

    child.on('error', (error) => {
      this.failAllPendingRequests(
        new Error(`Antigravity ACP process error: ${error.message}`),
      );
      this.resolveExit?.();
      this.resolveExit = null;
    });

    child.on('exit', (code, signal) => {
      this.flushStderrBuffer();
      const reason = signal
        ? `Antigravity ACP process exited with signal ${signal}.`
        : `Antigravity ACP process exited with code ${code ?? 'unknown'}.`;
      this.failAllPendingRequests(new Error(reason));
      this.child = null;
      this.resolveExit?.();
      this.resolveExit = null;
      this.options.onExit?.({ code, signal });
    });
  }

  async initialize(): Promise<AcpInitializeResult> {
    this.start();
    const result = await this.sendRequest<AcpInitializeResult>('initialize', {
      protocolVersion: 1,
      clientInfo: {
        name: 'ccem-desktop',
        version: '1.0.0',
      },
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
        auth: {
          terminal: true,
        },
      },
    });
    this.initializedResult = result;

    const version = result.agentInfo?.version;
    if (isAgyVersionBelowRecommended(version)) {
      this.options.onWarning?.(
        `Antigravity CLI version ${version} is below recommended 1.5.5; permission handling may be unstable. Consider running "agy update".`,
      );
    }

    return result;
  }

  async sessionNew(cwd: string, mcpServers: unknown[] = []): Promise<AcpSessionNewResult> {
    const result = await this.sendRequest<AcpSessionNewResult>('session/new', {
      cwd,
      mcpServers,
    });
    if (typeof result?.sessionId === 'string' && result.sessionId.trim()) {
      this.activeSessionId = result.sessionId.trim();
    }
    return result;
  }

  async sessionResumeOrLoad(
    sessionId: string,
    cwd: string,
    mcpServers: unknown[] = [],
  ): Promise<AcpSessionNewResult> {
    const caps = this.initializedResult?.agentCapabilities;
    const sessionCaps = caps?.sessionCapabilities ?? caps?.session_capabilities;
    const canResume = sessionCaps ? sessionCaps.resume !== undefined : true;
    const canLoad = Boolean(
      caps?.loadSession
      || caps?.load_session
      || sessionCaps?.load !== undefined,
    );

    const normalizeResult = (raw: unknown): AcpSessionNewResult => {
      const record = readObject(raw) ?? {};
      const resolvedId = typeof record.sessionId === 'string' && record.sessionId.trim()
        ? record.sessionId.trim()
        : sessionId;
      this.activeSessionId = resolvedId;
      return {
        ...(record as Record<string, unknown>),
        sessionId: resolvedId,
      } as AcpSessionNewResult;
    };

    if (canResume) {
      try {
        const resumed = await this.sendRequest<unknown>('session/resume', {
          sessionId,
          cwd,
          mcpServers,
        });
        return normalizeResult(resumed);
      } catch (error) {
        if (isAgyAuthRequiredError(error) || !canLoad) {
          throw error;
        }
        // Fall back to session/load when session/resume is unsupported or rejected.
      }
    }

    const loaded = await this.sendRequest<unknown>('session/load', {
      sessionId,
      cwd,
      mcpServers,
    });
    return normalizeResult(loaded);
  }

  async sessionSetMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.sendRequest('session/set_mode', {
      sessionId,
      modeId,
    });
  }

  async sessionSetConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<{ configOptions?: AcpConfigOption[] } | unknown> {
    return this.sendRequest('session/set_config_option', {
      sessionId,
      configId,
      value,
    });
  }

  async sessionPrompt(sessionId: string, prompt: AcpContentBlock[]): Promise<AcpPromptResult> {
    return this.sendRequest<AcpPromptResult>(
      'session/prompt',
      {
        sessionId,
        prompt,
      },
      { timeoutMs: 0 },
    );
  }

  sessionCancel(sessionId: string): void {
    this.sendNotification('session/cancel', { sessionId });
  }

  async sessionClose(sessionId: string): Promise<void> {
    if (!this.isAlive) {
      return;
    }
    try {
      await this.sendRequest('session/close', { sessionId }, { timeoutMs: SESSION_CLOSE_TIMEOUT_MS });
    } catch {
      // Best-effort close during teardown.
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.closePromise = (async () => {
      const child = this.child;
      if (!child) {
        this.closed = true;
        return;
      }

      const sessionId = this.activeSessionId;
      this.activeSessionId = null;

      if (sessionId && this.isAlive) {
        await this.sessionClose(sessionId);
      }

      this.closed = true;
      this.failAllPendingRequests(new Error('Antigravity ACP client closed.'));

      try {
        if (!child.stdin.destroyed && !child.stdin.writableEnded) {
          child.stdin.end();
        }
      } catch {
        // Ignore write-after-end errors.
      }

      const exitedAfterEof = await this.waitForExit(EOF_EXIT_GRACE_MS);
      if (exitedAfterEof || child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      try {
        child.kill('SIGTERM');
      } catch {
        return;
      }

      const exitedAfterTerm = await this.waitForExit(SIGTERM_EXIT_GRACE_MS);
      if (exitedAfterTerm || child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      try {
        child.kill('SIGKILL');
      } catch {
        // Process already gone.
      }
      await this.waitForExit(500);
    })();

    return this.closePromise;
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.child || !this.exitPromise) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }, timeoutMs);
      timer.unref?.();

      void this.exitPromise!.then(() => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(true);
        }
      });
    });
  }

  private sendRequest<T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    if (!this.child || !this.isAlive) {
      return Promise.reject(new Error(`Cannot send "${method}": Antigravity ACP server is not running.`));
    }

    const id = this.nextRequestId++;
    const timeoutMs = options?.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;

    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`ACP request "${method}" timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.pendingRequests.set(id, pending);

      try {
        this.writeJsonLine({
          jsonrpc: '2.0',
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        });
      } catch (error) {
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    if (!this.child || !this.isAlive) {
      return;
    }
    try {
      this.writeJsonLine({
        jsonrpc: '2.0',
        method,
        ...(params !== undefined ? { params } : {}),
      });
    } catch {
      // Ignore write errors during shutdown.
    }
  }

  private sendResponse(id: number | string, result: unknown): void {
    if (!this.child || !this.isAlive) {
      return;
    }
    try {
      this.writeJsonLine({
        jsonrpc: '2.0',
        id,
        result,
      });
    } catch {
      // Ignore write errors during shutdown.
    }
  }

  private sendErrorResponse(id: number | string, code: number, message: string): void {
    if (!this.child || !this.isAlive) {
      return;
    }
    try {
      this.writeJsonLine({
        jsonrpc: '2.0',
        id,
        error: { code, message },
      });
    } catch {
      // Ignore write errors during shutdown.
    }
  }

  private writeJsonLine(payload: Record<string, unknown>): void {
    if (!this.child || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      throw new Error('Antigravity ACP stdin is not writable.');
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex < 0) {
        break;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      this.handleStdoutLine(trimmed);
    }
  }

  private handleStdoutLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Defensive stdout resilience: tolerate non-JSON banner/log lines safely.
      this.options.onStderrLine?.(`[agy acp stdout] ${line}`);
      return;
    }

    const message = readObject(parsed);
    if (!message) {
      return;
    }

    const hasId = message.id !== undefined && message.id !== null;
    const method = typeof message.method === 'string' ? message.method : null;

    // 1. Response to an outbound request from us.
    if (hasId && !method && ('result' in message || 'error' in message)) {
      const pending = this.pendingRequests.get(message.id as number | string);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(message.id as number | string);
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      const errorRecord = readObject(message.error);
      if (errorRecord) {
        const code = typeof errorRecord.code === 'number' ? errorRecord.code : -32000;
        const errMessage = typeof errorRecord.message === 'string'
          ? errorRecord.message
          : `ACP request "${pending.method}" failed with code ${code}`;
        pending.reject(new AcpJsonRpcError(code, errMessage, errorRecord.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // 2. Server-to-client request (expects a response).
    if (hasId && method) {
      void this.handleServerRequest(message.id as number | string, method, message.params);
      return;
    }

    // 3. Server-to-client notification.
    if (method) {
      if (method === 'session/update') {
        const params = readObject(message.params) as AcpSessionUpdateParams | null;
        if (params) {
          this.options.onSessionUpdate?.(params);
        }
      }
    }
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (method === 'session/request_permission') {
      if (!this.options.onRequestPermission) {
        this.sendResponse(id, { outcome: { outcome: 'cancelled' } });
        return;
      }
      try {
        const response = await this.options.onRequestPermission(
          (readObject(params) ?? {}) as AcpPermissionRequestParams,
        );
        this.sendResponse(id, response);
      } catch (error) {
        this.sendErrorResponse(
          id,
          -32603,
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }

    this.sendErrorResponse(id, -32601, `Unsupported client method: ${method}`);
  }

  private handleStderrChunk(chunk: string): void {
    this.stderrBuffer += chunk;
    for (;;) {
      const newlineIndex = this.stderrBuffer.indexOf('\n');
      if (newlineIndex < 0) {
        break;
      }
      const line = this.stderrBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
      if (line.trim()) {
        this.options.onStderrLine?.(line);
      }
    }
  }

  private flushStderrBuffer(): void {
    const remaining = this.stderrBuffer.trim();
    this.stderrBuffer = '';
    if (remaining) {
      this.options.onStderrLine?.(remaining);
    }
  }

  private failAllPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}
