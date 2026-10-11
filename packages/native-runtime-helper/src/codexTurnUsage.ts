import fs from 'node:fs';
import path from 'node:path';
import { findCodexSessionFile, resolveCodexSessionsRoot } from './codexContextUsage';

/** Mutually exclusive categories: inputTokens excludes both cache categories. */
export interface CodexTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface RawUsage {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

export interface CodexUsageBaseline {
  sessionId: string | null;
  sessionsRoot: string;
  filePath: string | null;
  offset: number;
  device: number;
  inode: number;
  anchor: string;
  total: RawUsage | null;
  valid: boolean;
}

const TAIL_BYTES = 1024 * 1024;
const MAX_TURN_BYTES = 32 * 1024 * 1024;
const RETRY_COUNT = 8;
const RETRY_DELAY_MS = 50;
const ZERO: RawUsage = { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0, total: 0 };
const KEYS = Object.keys(ZERO) as Array<keyof RawUsage>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usage(value: unknown): RawUsage | null {
  const obj = record(value);
  if (!obj) return null;
  const input = count(obj.input_tokens);
  const output = count(obj.output_tokens);
  const cached = count(obj.cached_input_tokens);
  const cacheWrite = count(obj.cache_write_input_tokens ?? 0);
  const reasoning = count(obj.reasoning_output_tokens ?? 0);
  const total = count(obj.total_tokens);
  if (input === null || output === null || cached === null || cacheWrite === null
    || reasoning === null || total === null || cached + cacheWrite > input || reasoning > output) {
    return null;
  }
  return { input, output, cached, cacheWrite, reasoning, total };
}

function equal(a: RawUsage, b: RawUsage) {
  return KEYS.every((key) => a[key] === b[key]);
}

function normalize(raw: RawUsage): CodexTurnUsage {
  return {
    inputTokens: raw.input - raw.cached - raw.cacheWrite,
    outputTokens: raw.output,
    cacheReadTokens: raw.cached,
    cacheCreationTokens: raw.cacheWrite,
  };
}

function sessionsRoot(codexHome?: string) {
  return codexHome?.trim()
    ? path.join(codexHome.trim(), 'sessions')
    : resolveCodexSessionsRoot();
}

function readRange(fd: number, start: number, length: number) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const next = fs.readSync(fd, buffer, read, length - read, start + read);
    if (next === 0) throw new Error('Codex rollout changed while reading');
    read += next;
  }
  return buffer;
}

function readAnchor(fd: number, offset: number) {
  const length = Math.min(64, offset);
  return readRange(fd, offset - length, length).toString('base64');
}

/** Capture before iterating runStreamed(). Its async generator starts the CLI. */
export function captureCodexUsageBaseline(
  sessionId: string | null,
  codexHome?: string,
): CodexUsageBaseline {
  const baseline: CodexUsageBaseline = {
    sessionId: sessionId?.trim() || null,
    sessionsRoot: sessionsRoot(codexHome),
    filePath: null,
    offset: 0,
    device: 0,
    inode: 0,
    anchor: '',
    total: null,
    valid: !sessionId?.trim(),
  };
  if (!baseline.sessionId) return baseline;
  const filePath = findCodexSessionFile(baseline.sessionId, baseline.sessionsRoot);
  if (!filePath) return baseline;

  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return baseline;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const tail = readRange(fd, start, stat.size - start);
    // Do not let an old partial line become part of the next operation.
    if (tail[tail.length - 1] !== 10) return baseline;
    const lines = tail.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    for (let index = lines.length - 1; index >= 0; index--) {
      try {
        const row = record(JSON.parse(lines[index]));
        const payload = record(row?.payload);
        if (row?.type === 'event_msg' && payload?.type === 'token_count') {
          baseline.total = usage(record(payload.info)?.total_token_usage);
          break;
        }
      } catch { /* Old unrelated lines do not supply a usage baseline. */ }
    }
    const anchor = readAnchor(fd, stat.size);
    if (fs.fstatSync(fd).size !== stat.size) return baseline;
    return { ...baseline, filePath, offset: stat.size, device: stat.dev, inode: stat.ino, anchor, valid: true };
  } catch {
    return baseline;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

type Resolution = { state: 'ready'; value: CodexTurnUsage } | { state: 'pending' | 'invalid' };
const INVALID: Resolution = { state: 'invalid' };
const PENDING: Resolution = { state: 'pending' };

function parseTurn(text: string, sessionId: string, baseline: CodexUsageBaseline): Resolution {
  let turnId: string | null = null;
  let completed = false;
  let sawSessionMeta = baseline.sessionId !== null;
  let lastTotal = baseline.sessionId ? baseline.total : { ...ZERO };
  let cumulativeValid = lastTotal !== null;
  let sawTotal = false;
  let turnUsage: RawUsage | null = null;
  let summedUsage = { ...ZERO };
  const responses = new Map<string, { request: RawUsage; turn: RawUsage }>();

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown> | null;
    try { row = record(JSON.parse(line)); } catch { return INVALID; }
    const payload = record(row?.payload);
    if (!row || !payload) return INVALID;

    if (row.type === 'session_meta') {
      if ((payload.id ?? payload.session_id) !== sessionId) return INVALID;
      // A supposedly fresh thread must not silently inherit another thread's usage.
      if (!baseline.sessionId && (payload.forked_from_id || payload.history_base)) return INVALID;
      sawSessionMeta = true;
    } else if (row.type === 'turn_context') {
      if (!turnId || payload.turn_id !== turnId) return INVALID;
    } else if (row.type === 'token_usage_record') {
      if (!turnId || completed || payload.thread_id !== sessionId || payload.turn_id !== turnId
        || typeof payload.response_id !== 'string' || !payload.response_id) return INVALID;
      const request = usage(payload.usage);
      const turn = usage(payload.turn_token_usage);
      if (!request || !turn) return INVALID;
      const previous = responses.get(payload.response_id);
      if (previous) {
        if (!equal(previous.request, request) || !equal(previous.turn, turn)) return INVALID;
        continue;
      }
      summedUsage = Object.fromEntries(KEYS.map((key) => [key, summedUsage[key] + request[key]])) as unknown as RawUsage;
      if (!KEYS.every((key) => Number.isSafeInteger(summedUsage[key])) || !equal(summedUsage, turn)) return INVALID;
      responses.set(payload.response_id, { request, turn });
      turnUsage = turn;
    } else if (row.type === 'event_msg') {
      if (payload.type === 'task_started' || payload.type === 'turn_started') {
        if (turnId || typeof payload.turn_id !== 'string' || !payload.turn_id) return INVALID;
        turnId = payload.turn_id;
      } else if (payload.type === 'task_complete' || payload.type === 'turn_complete') {
        if (!turnId || payload.turn_id !== turnId) return INVALID;
        completed = true;
      } else if (payload.type === 'turn_aborted' || payload.type === 'turn_failed'
        || payload.type === 'thread_rolled_back') {
        return INVALID;
      } else if (payload.type === 'token_count') {
        const next = usage(record(payload.info)?.total_token_usage);
        if (!turnId || completed) {
          if (!next || !lastTotal || !equal(next, lastTotal)) return INVALID;
          continue;
        }
        sawTotal = true;
        // This validates a documented cumulative counter; it does not infer
        // whether an exec completion happens to be cumulative from its values.
        const previousTotal = lastTotal;
        if (!next || !previousTotal || KEYS.some((key) => next[key] < previousTotal[key])) {
          cumulativeValid = false;
        }
        lastTotal = next;
      }
    }
  }

  if (!sawSessionMeta || !turnId || !completed) return PENDING;
  // The response ledger is explicitly scoped to this turn and survives context
  // counter resets. reasoning_output_tokens is already included in output_tokens.
  if (turnUsage) return { state: 'ready', value: normalize(turnUsage) };
  const initial = baseline.sessionId ? baseline.total : ZERO;
  if (!cumulativeValid || !sawTotal || !lastTotal || !initial) return INVALID;
  const delta = Object.fromEntries(KEYS.map((key) => [key, lastTotal[key] - initial[key]])) as unknown as RawUsage;
  if (delta.cached + delta.cacheWrite > delta.input || delta.reasoning > delta.output) return INVALID;
  return { state: 'ready', value: normalize(delta) };
}

function tryResolve(sessionId: string, baseline: CodexUsageBaseline): Resolution {
  const filePath = baseline.filePath ?? findCodexSessionFile(sessionId, baseline.sessionsRoot);
  if (!filePath) return PENDING;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < baseline.offset || stat.size - baseline.offset > MAX_TURN_BYTES) return INVALID;
    if (baseline.filePath && (stat.dev !== baseline.device || stat.ino !== baseline.inode
      || readAnchor(fd, baseline.offset) !== baseline.anchor)) return INVALID;
    const bytes = readRange(fd, baseline.offset, stat.size - baseline.offset);
    if (!bytes.length || bytes[bytes.length - 1] !== 10) return PENDING;
    return parseTurn(bytes.toString('utf8'), sessionId, baseline);
  } catch {
    return PENDING;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Caller must freeze its completion clock before awaiting rollout flushes here. */
export async function resolveCodexTurnUsage(
  sessionId: string,
  baseline: CodexUsageBaseline,
  codexHome?: string,
): Promise<CodexTurnUsage | null> {
  const id = sessionId.trim();
  if (!baseline.valid || !id || (baseline.sessionId && baseline.sessionId !== id)
    || (codexHome !== undefined && sessionsRoot(codexHome) !== baseline.sessionsRoot)) return null;
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    const result = tryResolve(id, baseline);
    if (result.state === 'ready') return result.value;
    if (result.state === 'invalid') return null;
    if (attempt < RETRY_COUNT) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  return null;
}
