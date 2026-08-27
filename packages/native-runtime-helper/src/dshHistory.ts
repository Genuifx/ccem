/**
 * DSH History Helper — one-shot stdin→stdout JSON protocol entry.
 *
 * Executed by `ccem-node dsh-history-helper.mjs` as a short-lived child process.
 * Reads one JSON request from stdin, writes one JSON response envelope to stdout.
 * All diagnostics go to stderr. Source files are never written.
 *
 * Uses the official SessionPersistence.readFrom(id, 0) API for event access.
 * Never calls loadStored, inspect, prepare, or any write/repair method.
 *
 * detail: isAppendSurfaceEvent + deriveEventMessage → append-origin surface.
 * list: foldSessionTitle || collectSessionTitleMessages+fallbackSessionTitle.
 * usage: usage-chunk priority → assistant/message.data.usage fallback.
 *
 * @module @ccem/native-runtime-helper/dshHistory
 */

import { Context } from '@deepseek-ai/cordis';
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SessionStore, isAppendSurfaceEvent, deriveEventMessage } from '@deepseek-ai/dsh-session';
import { foldSessionTitle, collectSessionTitleMessages, fallbackSessionTitle } from '@deepseek-ai/dsh-session-title';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

// --- Node.js version gate (zstd requires >=22.15) ---

const NODE_VERSION_FLOOR = [22, 15, 0];
{
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const current = [major, minor, patch];
  for (let i = 0; i < 3; i++) {
    if (current[i] > NODE_VERSION_FLOOR[i]) break;
    if (current[i] < NODE_VERSION_FLOOR[i]) {
      process.stderr.write(
        `dsh-history-helper requires Node.js >= ${NODE_VERSION_FLOOR.join('.')} ` +
        `(zstd support). Current: ${process.versions.node}\n`
      );
      process.exit(78); // EX_CONFIG
    }
  }
}

// --- Types ---

interface DshListRequest { op: 'list'; roots: string[]; limit?: number }
interface DshDetailRequest { op: 'detail'; sourceInstanceId: string; sessionId: string }
interface DshUsageRequest { op: 'usage'; roots: string[] }
type DshHistoryRequest = DshListRequest | DshDetailRequest | DshUsageRequest;

interface DshSuccessResponse<T> { ok: true; schemaVersion: 1; dshVersion: string; data: T; warnings: string[] }
interface DshErrorResponse { ok: false; schemaVersion: 1; code: string; message: string }
type DshHistoryResponse<T> = DshSuccessResponse<T> | DshErrorResponse;

interface DshSessionListItem {
  sourceInstanceId: string;
  sessionId: string;
  cwd: string | undefined;
  projectName: string | undefined;
  title: string | undefined;
  createdAt: number;
  lastEventAt: number | undefined;
  model: string | undefined;
  provider: string | undefined;
  parentSession: string | undefined;
  seedLength: number;
  delegationDepth: number;
  eventCount: number;
  revision: string | undefined;
}

interface DshSessionDetail {
  sourceInstanceId: string;
  sessionId: string;
  header: {
    version: number;
    id: string;
    createdAt: number;
    cwd: string | undefined;
    parentSession: string | undefined;
    seedLength: number;
    delegationDepth: number;
  };
  events: DshSurfaceEvent[];
  warnings: string[];
}

/** Projected append-origin surface event. */
interface DshSurfaceEvent {
  seq: number;
  type: string;
  time: number | undefined;
  role: 'user' | 'assistant';
  content: unknown[] | undefined;
  model: string | undefined;
  provider: string | undefined;
}

interface DshUsageEntry {
  sourceInstanceId: string;
  sessionId: string;
  seedLength: number;
  revision: string | undefined;
  steps: DshUsageStep[];
}

interface DshUsageStep {
  seq: number;
  turn: number;
  step: number;
  time: number | undefined;
  provider: string | undefined;
  model: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// --- Constants & Utilities ---

const DSH_VERSION = '0.1.1-rc.2';
const DEFAULT_LIST_LIMIT = 1000;

/**
 * Classify persistence/read errors into structured error codes.
 * Strict discriminators ONLY — no message substring heuristics.
 * - UNSUPPORTED_FORMAT: official SessionFormatUnsupportedError (.name) or
 *   exact .code of UNSUPPORTED_FORMAT / ERR_UNSUPPORTED.
 * - BUSY_CORRUPT: everything else (lock, corrupt, truncation, decode, I/O, unknown).
 */
function classifyReadError(err: any): { code: 'UNSUPPORTED_FORMAT' | 'BUSY_CORRUPT'; message: string } {
  const msg = err?.message ?? String(err ?? 'unknown error');
  const code = err?.code;
  const name = err?.name;
  if (code === 'UNSUPPORTED_FORMAT' || code === 'ERR_UNSUPPORTED' || name === 'SessionFormatUnsupportedError') {
    return { code: 'UNSUPPORTED_FORMAT', message: msg };
  }
  return { code: 'BUSY_CORRUPT', message: msg };
}

async function computeSourceInstanceId(root: string): Promise<string> {
  const canonical = await realpath(root);
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

function projectNameFromCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  return path.basename(cwd) || undefined;
}

async function detectCompression(root: string): Promise<'zstd' | 'none'> {
  const { readdir } = await import('node:fs/promises');
  try {
    const projects = await readdir(root, { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectPath = path.join(root, project.name);
      const sessions = await readdir(projectPath, { withFileTypes: true });
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const sessionPath = path.join(projectPath, session.name);
        const files = await readdir(sessionPath);
        if (files.includes('session.jsonl.zstd')) return 'zstd';
        if (files.includes('session.jsonl')) return 'none';
      }
    }
  } catch { /* skip */ }
  return 'none';
}

async function createReadOnlyPersistence(root: string) {
  const compression = await detectCompression(root);
  const ctx = new Context();
  ctx.plugin(SessionStore);
  const fiber = ctx.plugin(JsonlSessionPersistence, { root, compression });
  await fiber;
  return { ctx, persistence: ctx.sessionPersistence as InstanceType<typeof JsonlSessionPersistence> };
}

// --- Operations ---

async function handleList(request: DshListRequest): Promise<DshHistoryResponse<DshSessionListItem[]>> {
  const warnings: string[] = [];
  const items: DshSessionListItem[] = [];
  const limit = request.limit ?? DEFAULT_LIST_LIMIT;

  for (const root of request.roots) {
    let sourceInstanceId: string;
    try { sourceInstanceId = await computeSourceInstanceId(root); }
    catch (err: any) {
      // Only ENOENT (root genuinely absent) may be treated as absent (warn + skip).
      // EACCES/I/O/corrupt realpath failures must fail closed as BUSY_CORRUPT.
      if (err?.code === 'ENOENT') {
        warnings.push(`Root "${root}" cannot be resolved`);
        continue;
      }
      return { ok: false, schemaVersion: 1, code: 'BUSY_CORRUPT', message: `Root "${root}": realpath failed: ${err?.message ?? err}` };
    }

    let ctx: Context | undefined;
    try {
      const result = await createReadOnlyPersistence(root);
      ctx = result.ctx;
      const persistence = result.persistence;
      const snapshots = await persistence.listSnapshots();

      for (const snap of snapshots) {
        if (items.length >= limit) break;
        const h = snap.header;
        let title: string | undefined;
        let lastEventAt: number | undefined;
        let model: string | undefined;
        let provider: string | undefined;
        let eventCount = 0;

        const readResult = await persistence.readFrom(h.id, 0);
        if (readResult) {
          const events = readResult.events;
          eventCount = events.length;

          // Title: official foldSessionTitle first
          try {
            const titleSnap = foldSessionTitle(events as any);
            title = titleSnap?.title;
          } catch { /* ignore */ }

          // Fallback: collectSessionTitleMessages + fallbackSessionTitle
          if (!title) {
            try {
              const msgs = collectSessionTitleMessages(events as any, undefined);
              if (msgs.length > 0) {
                title = fallbackSessionTitle(msgs[0].text, 8, 80);
              }
            } catch { /* ignore */ }
          }

          // lastEventAt, model, provider from append-origin events only
          for (const ev of events) {
            if (isAppendSurfaceEvent(ev as any)) {
              const t = (ev as any).time;
              if (t && (!lastEventAt || t > lastEventAt)) lastEventAt = t;
              if ((ev as any).type === 'assistant/message') {
                const src = (ev as any).data?.message?.source;
                if (src?.provider) { provider = src.provider; model = src.model; }
              }
            }
          }
        }

        items.push({
          sourceInstanceId, sessionId: h.id, cwd: h.cwd,
          projectName: projectNameFromCwd(h.cwd), title, createdAt: h.createdAt,
          lastEventAt, model, provider,
          parentSession: h.parentSession ?? undefined,
          seedLength: h.seedLength ?? 0, delegationDepth: h.delegationDepth ?? 0,
          eventCount, revision: snap.revision ?? undefined,
        });
      }
    } catch (err: any) {
      // Root-level failure: cannot authoritatively read the source.
      // Return a structured error — do not present partial results.
      ctx?.scope?.dispose?.();
      const classified = classifyReadError(err);
      return { ok: false, schemaVersion: 1, code: classified.code, message: `Root "${root}": ${classified.message}` };
    } finally { ctx?.scope?.dispose?.(); }
    if (items.length >= limit) break;
  }

  items.sort((a, b) => b.createdAt - a.createdAt);
  return { ok: true, schemaVersion: 1, dshVersion: DSH_VERSION, data: items.slice(0, limit), warnings };
}

async function handleDetail(request: DshDetailRequest): Promise<DshHistoryResponse<DshSessionDetail>> {
  const rootsEnv = process.env.__DSH_HISTORY_ROOTS;
  if (!rootsEnv) return { ok: false, schemaVersion: 1, code: 'NO_ROOTS', message: 'No DSH roots configured' };

  const roots: string[] = JSON.parse(rootsEnv);
  let matchedRoot: string | undefined;
  for (const root of roots) {
    try {
      if (await computeSourceInstanceId(root) === request.sourceInstanceId) { matchedRoot = root; break; }
    } catch (err: any) {
      // Only ENOENT may be skipped (root absent). Other errors fail closed.
      if (err?.code === 'ENOENT') continue;
      return { ok: false, schemaVersion: 1, code: 'BUSY_CORRUPT', message: `Root "${root}": realpath failed: ${err?.message ?? err}` };
    }
  }
  if (!matchedRoot) return { ok: false, schemaVersion: 1, code: 'SOURCE_NOT_FOUND', message: `Source instance "${request.sourceInstanceId}" not found` };

  let ctx: Context | undefined;
  try {
    const result = await createReadOnlyPersistence(matchedRoot);
    ctx = result.ctx;
    const persistence = result.persistence;
    const readResult = await persistence.readFrom(request.sessionId, 0);
    if (!readResult) return { ok: false, schemaVersion: 1, code: 'SESSION_NOT_FOUND', message: `Session "${request.sessionId}" not found` };

    const warnings: string[] = [];
    const meta = readResult.meta;
    const seedLength = meta.seedLength ?? 0;
    const projected: DshSurfaceEvent[] = [];

    for (const ev of readResult.events) {
      const raw = ev as any;
      // Skip seed events
      if (raw.seq < seedLength) continue;
      // Only append-origin surface events
      if (!isAppendSurfaceEvent(raw)) continue;
      // Derive LLM message
      const msg = deriveEventMessage(raw);
      if (!msg) continue;

      const surfaceEv: DshSurfaceEvent = {
        seq: raw.seq, type: raw.type, time: raw.time ?? undefined,
        role: (msg as any).role, content: (msg as any).content ?? undefined,
        model: undefined, provider: undefined,
      };

      // model/provider from message source
      const src = (msg as any).source;
      if (src && 'provider' in src) { surfaceEv.model = src.model; surfaceEv.provider = src.provider; }

      projected.push(surfaceEv);
    }

    return {
      ok: true, schemaVersion: 1, dshVersion: DSH_VERSION, warnings,
      data: {
        sourceInstanceId: request.sourceInstanceId, sessionId: request.sessionId,
        header: {
          version: meta.version, id: meta.id, createdAt: meta.createdAt,
          cwd: meta.cwd, parentSession: meta.parentSession ?? undefined,
          seedLength, delegationDepth: meta.delegationDepth ?? 0,
        },
        events: projected, warnings,
      },
    };
  } catch (err: any) {
    const classified = classifyReadError(err);
    return { ok: false, schemaVersion: 1, code: classified.code, message: classified.message };
  } finally { ctx?.scope?.dispose?.(); }
}

async function handleUsage(request: DshUsageRequest): Promise<DshHistoryResponse<DshUsageEntry[]>> {
  const warnings: string[] = [];
  const entries: DshUsageEntry[] = [];

  for (const root of request.roots) {
    let sourceInstanceId: string;
    try { sourceInstanceId = await computeSourceInstanceId(root); }
    catch (err: any) {
      // Only ENOENT (root genuinely absent) may be treated as absent (warn + skip).
      // EACCES/I/O/corrupt realpath failures must fail closed as BUSY_CORRUPT.
      if (err?.code === 'ENOENT') {
        warnings.push(`Root "${root}" cannot be resolved`);
        continue;
      }
      return { ok: false, schemaVersion: 1, code: 'BUSY_CORRUPT', message: `Root "${root}": realpath failed: ${err?.message ?? err}` };
    }

    let ctx: Context | undefined;
    try {
      const result = await createReadOnlyPersistence(root);
      ctx = result.ctx;
      const persistence = result.persistence;
      const snapshots = await persistence.listSnapshots();

      for (const snap of snapshots) {
        const readResult = await persistence.readFrom(snap.header.id, 0);

        const seedLength = readResult.meta.seedLength ?? 0;

        // Collect per turn+step: usage chunk priority, then assistant/message fallback
        // Also track provider/model from assistant/message in same step
        const chunkUsage = new Map<string, DshUsageStep>(); // turn:step → from usage chunk
        const msgUsage = new Map<string, DshUsageStep>();   // turn:step → from assistant/message
        const stepMeta = new Map<string, { provider?: string; model?: string }>();

        for (const ev of readResult.events) {
          const raw = ev as any;
          if (raw.seq < seedLength) continue;

          if (raw.type === 'assistant/chunk' && raw.data?.chunk?.type === 'usage') {
            const turn = raw.data.turn ?? 0;
            const step = raw.data.step ?? 0;
            const key = `${turn}:${step}`;
            const usage = raw.data.chunk.usage;
            if (usage) {
              // Presence-based last-wins: any usage chunk (even all-zero) is authoritative
              chunkUsage.set(key, {
                seq: raw.seq, turn, step, time: raw.time ?? undefined,
                provider: undefined, model: undefined,
                inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
                cacheReadTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens: usage.cacheWriteTokens ?? 0,
              });
            }
          }

          if (raw.type === 'assistant/message') {
            const data = raw.data;
            const turn = data?.turn ?? 0;
            const step = data?.step ?? 0;
            const key = `${turn}:${step}`;
            const src = data?.message?.source;
            if (src?.provider) stepMeta.set(key, { provider: src.provider, model: src.model });

            const usage = data?.usage;
            if (usage) {
              // Presence-based last-wins: any usage object (even all-zero) is authoritative
              msgUsage.set(key, {
                seq: raw.seq, turn, step, time: raw.time ?? undefined,
                provider: src?.provider ?? undefined, model: src?.model ?? undefined,
                inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
                cacheReadTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens: usage.cacheWriteTokens ?? 0,
              });
            }
          }
        }

        // Merge: chunk takes priority, fallback to message. Fill provider/model from stepMeta.
        const allKeys = new Set([...chunkUsage.keys(), ...msgUsage.keys()]);
        const steps: DshUsageStep[] = [];
        for (const key of allKeys) {
          const entry = chunkUsage.get(key) ?? msgUsage.get(key)!;
          const meta = stepMeta.get(key);
          if (meta) { entry.provider = entry.provider ?? meta.provider; entry.model = entry.model ?? meta.model; }
          steps.push(entry);
        }
        steps.sort((a, b) => a.seq - b.seq);

        entries.push({ sourceInstanceId, sessionId: snap.header.id, seedLength, revision: snap.revision ?? undefined, steps });
      }
    } catch (err: any) {
      // Root-level failure: return structured error, not partial results
      ctx?.scope?.dispose?.();
      const classified = classifyReadError(err);
      return { ok: false, schemaVersion: 1, code: classified.code, message: `Root "${root}": ${classified.message}` };
    } finally { ctx?.scope?.dispose?.(); }
  }

  return { ok: true, schemaVersion: 1, dshVersion: DSH_VERSION, data: entries, warnings };
}

// --- Main entry ---

async function main() {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; }

  let request: DshHistoryRequest;
  try { request = JSON.parse(input); }
  catch {
    process.stdout.write(JSON.stringify({ ok: false, schemaVersion: 1, code: 'INVALID_REQUEST', message: 'Failed to parse JSON request from stdin' }) + '\n');
    process.exit(1);
  }

  let response: DshHistoryResponse<any>;
  try {
    switch (request.op) {
      case 'list': response = await handleList(request); break;
      case 'detail': response = await handleDetail(request); break;
      case 'usage': response = await handleUsage(request); break;
      default: response = { ok: false, schemaVersion: 1, code: 'UNKNOWN_OP', message: `Unknown operation: ${(request as any).op}` };
    }
  } catch (err: any) {
    response = { ok: false, schemaVersion: 1, code: 'INTERNAL_ERROR', message: err?.message ?? 'Unknown error' };
  }

  process.stdout.write(JSON.stringify(response) + '\n');
}

main().catch(err => { process.stderr.write(`dsh-history-helper fatal: ${err?.message ?? err}\n`); process.exit(2); });
