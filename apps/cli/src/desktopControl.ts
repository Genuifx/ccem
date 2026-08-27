import fs from 'fs';
import path from 'path';
import { getCcemConfigDir } from '@ccem/core';

export interface DesktopControlDescriptor {
  endpoint: string;
  token: string;
  pid?: number | null;
}

export interface DesktopCreateSessionInput {
  provider: 'claude' | 'codex';
  cwd: string;
  prompt: string;
  envName?: string | null;
  permissionMode?: string | null;
  runtimePermissionMode?: string | null;
  providerSessionId?: string | null;
  effort?: string | null;
  open?: boolean;
  routes?: Record<string, string>;
}

export interface DesktopSessionRouterState {
  revision: number;
  bindings: Record<string, string>;
  allowedEnvs: string[];
  [key: string]: unknown;
}

export interface DesktopRouterUpdateParams {
  runtimeId: string;
  expectedRevision: number;
  patch: {
    bindings: Record<string, string>;
    allowedEnvs: string[];
  };
}

export interface DesktopEnvironmentRenameResult {
  ok: true;
  operation: 'rename';
  oldName: string;
  newName: string;
  updatedSessions: number;
  current: string | null;
}

export interface DesktopEnvironmentDeleteResult {
  ok: true;
  operation: 'delete';
  name: string;
  current: string | null;
}

export type DesktopControlRequester = (
  method: string,
  params?: unknown,
) => Promise<unknown>;

export interface RequestDesktopControlOptions {
  /** AbortSignal provided by the caller. */
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds. Defaults to 5000ms. */
  timeoutMs?: number;
  /** Backward-compatible alias for timeoutMs. */
  fetchTimeoutMs?: number;
}

export type DesktopControlRequestOptions = RequestDesktopControlOptions;

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const ENDPOINT_UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTCONN',
  'EHOSTUNREACH',
  'ECONNABORTED',
]);
const ROUTER_BINDING_KEY = /^(?:background|subagent:\*|subagent:[A-Za-z0-9._:-]{1,128})$/;

type StaleDescriptorReason = 'dead-pid' | 'endpoint-unreachable' | 'request-timeout';

export interface StaleDesktopControlDescriptorDetails {
  reason: StaleDescriptorReason;
  descriptorPath: string;
  pid: number | null;
  cleanedUp: boolean;
  timeoutMs?: number;
  cause?: unknown;
}

/**
 * Raised when the desktop control descriptor points at a dead process or an
 * unreachable endpoint. The message intentionally omits the bearer token and
 * the descriptor body; only the descriptor path, pid, and a remediation hint
 * are exposed.
 */
export class StaleDesktopControlDescriptorError extends Error {
  override readonly name = 'StaleDesktopControlDescriptorError';
  readonly reason: StaleDescriptorReason;
  readonly descriptorPath: string;
  readonly pid: number | null;
  readonly cleanedUp: boolean;
  readonly cause?: unknown;

  constructor(details: StaleDesktopControlDescriptorDetails) {
    const subject = details.pid !== null
      ? `process ${details.pid}`
      : 'the publishing process';
    const symptom = details.reason === 'dead-pid'
      ? `${subject} is no longer running`
      : details.reason === 'endpoint-unreachable'
        ? 'the control endpoint refused the connection'
        : `the control request timed out after ${details.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS}ms`;
    const remedy = details.cleanedUp
      ? 'The stale descriptor was removed automatically; start CCEM Desktop and rerun the command.'
      : details.pid !== null
        ? 'Restart CCEM Desktop so it republishes a fresh control endpoint.'
        : 'Restart CCEM Desktop to refresh the descriptor, or remove the stale file manually if it is no longer managed.';
    super(
      `CCEM Desktop control descriptor at ${details.descriptorPath} is stale: ${symptom}. ${remedy}`,
    );
    this.reason = details.reason;
    this.descriptorPath = details.descriptorPath;
    this.pid = details.pid;
    this.cleanedUp = details.cleanedUp;
    if (details.cause !== undefined) {
      this.cause = details.cause;
    }
  }
}

export class DesktopControlRpcError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = 'DesktopControlRpcError';
    this.code = code;
    this.data = data;
  }
}

export function getDesktopControlDescriptorPath(): string {
  return process.env.CCEM_CONTROL_FILE?.trim()
    || getDefaultControlDescriptorPath();
}

function getDefaultControlDescriptorPath(): string {
  return path.join(getCcemConfigDir(), 'control.json');
}

/**
 * Returns true when the descriptor path is the global default that CCEM Desktop
 * owns. Only the default path is safe to auto-clean; paths overridden via
 * `CCEM_CONTROL_FILE` are caller-managed and must not be touched.
 */
function isDefaultDescriptorPath(descriptorPath: string): boolean {
  try {
    return path.resolve(descriptorPath) === path.resolve(getDefaultControlDescriptorPath());
  } catch {
    return false;
  }
}

function safeRemoveStaleDescriptor(descriptorPath: string): boolean {
  if (!isDefaultDescriptorPath(descriptorPath)) {
    return false;
  }
  try {
    fs.rmSync(descriptorPath);
    return true;
  } catch {
    return false;
  }
}

function readErrnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.code ?? candidate.cause?.code;
}

function readPid(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * Returns true when `host` is a loopback host. Accepts bare host,
 * IPv6 bracketed form `[::1]`, and the common loopback names.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(normalized)) {
    return true;
  }
  // 127.0.0.0/8 loopback range
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) {
    return true;
  }
  // [::1] / ::1 variants
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  return false;
}

/**
 * Extract the host portion from an endpoint URL without relying on the
 * URL parser (which may throw). Falls back to string splitting so we
 * can still reject obviously bad endpoints.
 */
export function extractHost(endpoint: string): string | null {
  // Strip scheme
  const withoutScheme = endpoint.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  // Take up to the first / ? or #
  const hostPort = withoutScheme.split(/[\/?#]/)[0] || '';
  // IPv6 bracketed form: [::1]:port
  if (hostPort.startsWith('[')) {
    const end = hostPort.indexOf(']');
    if (end === -1) return null;
    return hostPort.slice(1, end);
  }
  // host:port — split on the last colon that isn't part of an IPv6 literal
  const colonIndex = hostPort.lastIndexOf(':');
  if (colonIndex === -1) return hostPort;
  return hostPort.slice(0, colonIndex);
}

function validateLoopbackEndpoint(endpoint: string): void {
  const host = extractHost(endpoint);
  if (!host) {
    throw new Error(
      `CCEM Desktop control endpoint '${redactEndpoint(endpoint)}' is missing a host. Refusing to continue.`,
    );
  }
  if (!isLoopbackHost(host)) {
    throw new Error(
      `CCEM Desktop control endpoint '${redactEndpoint(endpoint)}' is not bound to loopback. ` +
      `Only 127.0.0.1, localhost, or ::1 are allowed.`,
    );
  }
}

/**
 * Best-effort check that a pid is still alive using signal 0.
 * Returns true if the pid is alive, false otherwise. Errors that are
 * not ESRCH (no such process) are treated as "alive" to avoid false
 * negatives from permission issues.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false; // No such process
    // EPERM means process exists but we can't signal it — treat as alive
    if (code === 'EPERM') return true;
    return false;
  }
}

function redactEndpoint(endpoint: string): string {
  // Never leak any token that might be embedded; just show scheme+host+path
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '<invalid endpoint>';
  }
}

function isDescriptor(value: unknown): value is DesktopControlDescriptor {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as DesktopControlDescriptor).endpoint === 'string'
    && typeof (value as DesktopControlDescriptor).token === 'string',
  );
}

export function resolveDesktopControlDescriptor(
  descriptorPath = getDesktopControlDescriptorPath(),
): DesktopControlDescriptor {
  if (!fs.existsSync(descriptorPath)) {
    throw new Error(`CCEM Desktop control endpoint not found at ${descriptorPath}. Start CCEM Desktop first.`);
  }

  const parsed = JSON.parse(fs.readFileSync(descriptorPath, 'utf-8')) as Partial<DesktopControlDescriptor>;
  const endpoint = parsed.endpoint?.trim();
  const token = parsed.token?.trim();
  if (!endpoint || !token) {
    throw new Error(`Invalid CCEM Desktop control descriptor at ${descriptorPath}`);
  }

  // Reject non-loopback endpoints before touching the network
  validateLoopbackEndpoint(endpoint);

  // Verify desktop process is still alive (prevents stale descriptors).
  const pid = readPid(parsed.pid);
  if (pid !== null && !isPidAlive(pid)) {
    const cleanedUp = safeRemoveStaleDescriptor(descriptorPath);
    throw new StaleDesktopControlDescriptorError({
      reason: 'dead-pid',
      descriptorPath,
      pid,
      cleanedUp,
    });
  }

  return { endpoint, token, pid };
}

export async function requestDesktopControl<T = unknown>(
  method: string,
  params?: unknown,
  descriptorOrOptions?: DesktopControlDescriptor | RequestDesktopControlOptions,
  maybeOptions: RequestDesktopControlOptions = {},
): Promise<T> {
  const descriptorPath = getDesktopControlDescriptorPath();
  const hasInjectedDescriptor = isDescriptor(descriptorOrOptions);
  const descriptor = hasInjectedDescriptor
    ? descriptorOrOptions
    : resolveDesktopControlDescriptor(descriptorPath);
  const options = hasInjectedDescriptor
    ? maybeOptions
    : ((descriptorOrOptions as RequestDesktopControlOptions | undefined) ?? maybeOptions ?? {});
  const timeoutMs = options.timeoutMs ?? options.fetchTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pid = readPid(descriptor.pid);

  validateLoopbackEndpoint(descriptor.endpoint);

  if (pid !== null && !isPidAlive(pid)) {
    const cleanedUp = hasInjectedDescriptor ? false : safeRemoveStaleDescriptor(descriptorPath);
    throw new StaleDesktopControlDescriptorError({
      reason: 'dead-pid',
      descriptorPath,
      pid,
      cleanedUp,
    });
  }

  const id = `ccem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // If the caller provided their own signal, propagate its abort.
  const externalSignal = options.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  let response: Response;
  try {
    response = await fetch(descriptor.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: params ?? {},
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new StaleDesktopControlDescriptorError({
        reason: 'request-timeout',
        descriptorPath,
        pid,
        cleanedUp: false,
        timeoutMs,
        cause: error,
      });
    }

    const code = readErrnoCode(error);
    if (code && ENDPOINT_UNREACHABLE_CODES.has(code)) {
      throw new StaleDesktopControlDescriptorError({
        reason: 'endpoint-unreachable',
        descriptorPath,
        pid,
        cleanedUp: false,
        cause: error,
      });
    }

    throw error;
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }

  if (!response.ok) {
    throw new Error(`CCEM Desktop control request failed: HTTP ${response.status}`);
  }

  const payload = await response.json() as {
    result?: T;
    error?: { code?: number; message?: string; data?: unknown };
  };
  if (payload.error) {
    throw new DesktopControlRpcError(
      payload.error.message || `CCEM Desktop control error ${payload.error.code ?? ''}`.trim(),
      payload.error.code,
      payload.error.data,
    );
  }
  return payload.result as T;
}

/**
 * Parse and validate the `--since` option for `desktop events`.
 * Accepts a non-negative integer sequence number.
 * Returns null when the value is empty/undefined.
 */
export function parseSinceOption(raw: string | undefined): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(
      `Invalid --since value '${raw}'. Expected a non-negative integer sequence number (e.g. 0, 42).`,
    );
  }
  return value;
}

/**
 * Parse and validate the `--limit` option for `desktop events`.
 * Accepts a positive integer. Returns null when the value is empty/undefined.
 */
export function parseLimitOption(raw: string | undefined): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(
      `Invalid --limit value '${raw}'. Expected a positive integer (e.g. 1, 100).`,
    );
  }
  return value;
}

function parseRouteBinding(raw: string, optionName: '--route' | '--set') {
  const separator = raw.indexOf('=');
  const key = separator > 0 ? raw.slice(0, separator).trim() : '';
  const env = separator > 0 ? raw.slice(separator + 1).trim() : '';
  if (!key || !env) {
    throw new Error(`Invalid ${optionName} value '${raw}'. Expected key=env.`);
  }
  if (!ROUTER_BINDING_KEY.test(key)) {
    throw new Error(
      `Invalid route key '${key}' in ${optionName}. Expected background, subagent:*, or subagent:<safe-agent-name>.`,
    );
  }
  return { key, env };
}

function parseRoutesJson(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid --routes-json. Expected a JSON object of key-to-environment bindings.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid --routes-json. Expected a JSON object of key-to-environment bindings.');
  }

  const routes: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error('Invalid --routes-json. Expected a JSON object of key-to-environment bindings.');
    }
    const binding = parseRouteBinding(`${key}=${value}`, '--route');
    routes[binding.key] = binding.env;
  }
  return routes;
}

export function parseDesktopRoutes(
  routeValues: string[] = [],
  routesJson?: string,
): Record<string, string> | undefined {
  if (routesJson === undefined && routeValues.length === 0) {
    return undefined;
  }

  const routes = routesJson === undefined ? {} : parseRoutesJson(routesJson);
  for (const raw of routeValues) {
    const binding = parseRouteBinding(raw, '--route');
    routes[binding.key] = binding.env;
  }
  return routes;
}

function isDesktopSessionRouterState(value: unknown): value is DesktopSessionRouterState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<DesktopSessionRouterState>;
  if (!Number.isSafeInteger(state.revision) || (state.revision as number) < 0) return false;
  if (!state.bindings || typeof state.bindings !== 'object' || Array.isArray(state.bindings)) return false;
  if (!Object.entries(state.bindings).every(([key, env]) => key.trim() && typeof env === 'string')) {
    return false;
  }
  return Array.isArray(state.allowedEnvs)
    && state.allowedEnvs.every((env) => typeof env === 'string');
}

export function buildDesktopRouterUpdateParams(
  runtimeId: string,
  current: unknown,
  setValue: string,
): DesktopRouterUpdateParams {
  if (!isDesktopSessionRouterState(current)) {
    throw new Error('Invalid router state returned by CCEM Desktop.');
  }
  const binding = parseRouteBinding(setValue, '--set');
  const bindings = { ...current.bindings, [binding.key]: binding.env };
  const allowedEnvs = current.allowedEnvs.includes(binding.env)
    ? [...current.allowedEnvs]
    : [...current.allowedEnvs, binding.env];
  return {
    runtimeId,
    expectedRevision: current.revision,
    patch: { bindings, allowedEnvs },
  };
}

export async function getOrUpdateDesktopRoutes(
  runtimeId: string,
  setValue: string | undefined,
  requester: DesktopControlRequester = requestDesktopControl,
): Promise<unknown> {
  const current = await requester('ccem.workspace.getRouter', { runtimeId });
  if (setValue === undefined) {
    return current;
  }
  const update = buildDesktopRouterUpdateParams(runtimeId, current, setValue);
  return requester('ccem.workspace.updateRouter', update);
}

export async function getDesktopEnvironmentReferences(
  name: string,
  requester: DesktopControlRequester = requestDesktopControl,
): Promise<string[]> {
  const result = await requester('ccem.environment.references', { name });
  if (
    !result
    || typeof result !== 'object'
    || Array.isArray(result)
    || !Array.isArray((result as { references?: unknown }).references)
    || !(result as { references: unknown[] }).references.every(
      (reference) => typeof reference === 'string' && reference.trim().length > 0,
    )
  ) {
    throw new Error('Invalid environment reference response from CCEM Desktop.');
  }
  return [...(result as { references: string[] }).references];
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isDesktopEnvironmentRenameResult(
  value: unknown,
): value is DesktopEnvironmentRenameResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Partial<DesktopEnvironmentRenameResult>;
  return result.ok === true
    && result.operation === 'rename'
    && typeof result.oldName === 'string'
    && typeof result.newName === 'string'
    && Number.isSafeInteger(result.updatedSessions)
    && (result.updatedSessions as number) >= 0
    && isNullableString(result.current);
}

function isDesktopEnvironmentDeleteResult(
  value: unknown,
): value is DesktopEnvironmentDeleteResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Partial<DesktopEnvironmentDeleteResult>;
  return result.ok === true
    && result.operation === 'delete'
    && typeof result.name === 'string'
    && isNullableString(result.current);
}

export async function renameDesktopEnvironment(
  oldName: string,
  newName: string,
  requester: DesktopControlRequester = requestDesktopControl,
): Promise<DesktopEnvironmentRenameResult> {
  const result = await requester('ccem.environment.rename', { oldName, newName });
  if (!isDesktopEnvironmentRenameResult(result)) {
    throw new Error('Invalid environment mutation response from CCEM Desktop.');
  }
  return result;
}

export async function deleteDesktopEnvironment(
  name: string,
  requester: DesktopControlRequester = requestDesktopControl,
): Promise<DesktopEnvironmentDeleteResult> {
  const result = await requester('ccem.environment.delete', { name });
  if (!isDesktopEnvironmentDeleteResult(result)) {
    throw new Error('Invalid environment mutation response from CCEM Desktop.');
  }
  return result;
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
