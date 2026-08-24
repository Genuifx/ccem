import { invoke } from '@tauri-apps/api/core';
import type {
  ConversationDetailPayload,
  ConversationMessageList,
  HistorySessionItem,
  HistorySource,
  HistorySourceFilter,
  WorkspaceOverviewSnapshot,
  WorkspaceOverviewSnapshotPayload,
} from './types';
import { isResumableHistorySource } from './types';

const HISTORY_CACHE_TTL_MS = 60_000;

/** Diagnostic from a partial source failure (e.g. DSH in source=all). */
export interface SourceDiagnostic {
  source: string;
  code: string;
  message: string;
}

/** Structured error from backend history commands. */
export interface HistoryCommandError {
  code: string;
  message: string;
}

/** Backend envelope for list/search results. */
interface HistoryListResult {
  sessions: HistorySessionItem[];
  diagnostics: SourceDiagnostic[];
}

/** Result including diagnostics for the caller to surface. */
export interface HistoryFetchResult {
  sessions: HistorySessionItem[];
  diagnostics: SourceDiagnostic[];
}

/**
 * Normalize a backend error into a HistoryCommandError.
 * Tauri serializes structured errors as objects; legacy strings become generic errors.
 */
export function normalizeHistoryError(err: unknown): HistoryCommandError {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    return { code: String((err as any).code), message: String((err as any).message) };
  }
  if (typeof err === 'string') {
    return { code: 'unknown', message: err };
  }
  if (err instanceof Error) {
    return { code: 'unknown', message: err.message };
  }
  return { code: 'unknown', message: String(err) };
}

interface HistorySessionCacheEntry {
  data: HistorySessionItem[];
  diagnostics: SourceDiagnostic[];
  fetchedAt: number;
  promise?: Promise<HistoryFetchResult>;
}

interface WorkspaceOverviewCacheEntry {
  data: WorkspaceOverviewSnapshot;
  fetchedAt: number;
  promise?: Promise<WorkspaceOverviewSnapshot>;
}

interface FetchHistorySessionsOptions {
  limit?: number;
}

const historySessionCache = new Map<string, HistorySessionCacheEntry>();
const workspaceOverviewCache = new Map<string, WorkspaceOverviewCacheEntry>();

function historySessionCacheKey(
  sourceFilter: HistorySourceFilter,
  options: FetchHistorySessionsOptions = {},
): string {
  return options.limit && options.limit > 0
    ? `${sourceFilter}:limit:${options.limit}`
    : `${sourceFilter}:full`;
}

export function normalizeHistorySource(value: unknown): HistorySource | null {
  if (typeof value !== 'string') return null;
  switch (value.toLowerCase()) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'opencode':
      return 'opencode';
    case 'dsh':
      return 'dsh';
    default:
      // Unknown source — never fallback to claude.
      return null;
  }
}

export function normalizeHistorySessions(data: HistorySessionItem[]): HistorySessionItem[] {
  return data
    .map((session) => {
      const source = normalizeHistorySource(session.source);
      if (source === null) return null; // Drop sessions with unknown source
      return { ...session, source };
    })
    .filter((session): session is HistorySessionItem => session !== null);
}

export function normalizeWorkspaceOverviewSnapshot(
  data: WorkspaceOverviewSnapshotPayload,
): WorkspaceOverviewSnapshot {
  // Workspace never shows DSH — filter at normalization as a second defense line.
  const sessions = normalizeHistorySessions(data.sessions).filter(
    (session) => isResumableHistorySource(session.source),
  );
  const sessionByKey = new Map(sessions.map((session) => [`${session.source}:${session.id}`, session]));
  const projectNodes = data.projectNodes.map((node) => ({
    project: node.project,
    projectName: node.projectName,
    latestTimestamp: node.latestTimestamp,
    sessions: node.sessionKeys
      ? node.sessionKeys
          .map((sessionKey) => sessionByKey.get(sessionKey))
          .filter((session): session is HistorySessionItem => Boolean(session))
      : normalizeHistorySessions(node.sessions ?? [])
          .filter((session) => isResumableHistorySource(session.source))
          .map((session) =>
            sessionByKey.get(`${session.source}:${session.id}`) ?? session
          ),
  }));

  return {
    ...data,
    sessions,
    projectNodes,
  };
}

export function getCachedHistorySessions(
  sourceFilter: HistorySourceFilter,
  options: FetchHistorySessionsOptions = {},
): HistorySessionItem[] | null {
  return historySessionCache.get(historySessionCacheKey(sourceFilter, options))?.data ?? null;
}

export function getCachedDiagnostics(
  sourceFilter: HistorySourceFilter,
  options: FetchHistorySessionsOptions = {},
): SourceDiagnostic[] {
  return historySessionCache.get(historySessionCacheKey(sourceFilter, options))?.diagnostics ?? [];
}

export function isHistoryCacheFresh(
  sourceFilter: HistorySourceFilter,
  options: FetchHistorySessionsOptions = {},
): boolean {
  const entry = historySessionCache.get(historySessionCacheKey(sourceFilter, options));
  return !!entry && Date.now() - entry.fetchedAt < HISTORY_CACHE_TTL_MS;
}

export async function fetchHistorySessions(
  sourceFilter: HistorySourceFilter,
  force = false,
  options: FetchHistorySessionsOptions = {},
): Promise<HistorySessionItem[]> {
  const result = await fetchHistorySessionsWithDiagnostics(sourceFilter, force, options);
  return result.sessions;
}

export async function fetchHistorySessionsWithDiagnostics(
  sourceFilter: HistorySourceFilter,
  force = false,
  options: FetchHistorySessionsOptions = {},
): Promise<HistoryFetchResult> {
  const cacheKey = historySessionCacheKey(sourceFilter, options);
  const cached = historySessionCache.get(cacheKey);

  if (!force && cached?.data && isHistoryCacheFresh(sourceFilter, options)) {
    return { sessions: cached.data, diagnostics: cached.diagnostics };
  }

  if (!force && cached?.promise) {
    return cached.promise;
  }

  const request = invoke<HistoryListResult>('get_conversation_history', {
    source: sourceFilter === 'all' ? null : sourceFilter,
    limit: options.limit ?? null,
  })
    .then((result) => {
      const normalized = normalizeHistorySessions(result.sessions);
      const diagnostics = result.diagnostics ?? [];
      historySessionCache.set(cacheKey, {
        data: normalized,
        diagnostics,
        fetchedAt: Date.now(),
      });
      return { sessions: normalized, diagnostics };
    })
    .catch((err) => {
      if (cached?.data) {
        historySessionCache.set(cacheKey, cached);
      } else {
        historySessionCache.delete(cacheKey);
      }
      throw err;
    });

  historySessionCache.set(cacheKey, {
    data: cached?.data ?? [],
    diagnostics: cached?.diagnostics ?? [],
    fetchedAt: cached?.fetchedAt ?? 0,
    promise: request,
  });

  return request;
}

export async function fetchWorkspaceOverviewSnapshot(
  limit: number,
  force = false,
): Promise<WorkspaceOverviewSnapshot> {
  const options = { limit };
  const cacheKey = historySessionCacheKey('all', options);
  const cached = workspaceOverviewCache.get(cacheKey);

  if (!force && cached?.data && Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL_MS) {
    return cached.data;
  }

  if (!force && cached?.promise) {
    return cached.promise;
  }

  const request = invoke<WorkspaceOverviewSnapshotPayload>('get_workspace_overview_snapshot', {
    limit,
  })
    .then(normalizeWorkspaceOverviewSnapshot)
    .then((snapshot) => {
      workspaceOverviewCache.set(cacheKey, {
        data: snapshot,
        fetchedAt: Date.now(),
      });
      historySessionCache.set(cacheKey, {
        data: snapshot.sessions,
        diagnostics: [],
        fetchedAt: Date.now(),
      });
      return snapshot;
    })
    .catch((err) => {
      if (cached?.data) {
        workspaceOverviewCache.set(cacheKey, cached);
      } else {
        workspaceOverviewCache.delete(cacheKey);
      }
      throw err;
    });

  workspaceOverviewCache.set(cacheKey, {
    data: cached?.data ?? {
      sessions: [],
      projectNodes: [],
      totalSessions: 0,
      totalProjects: 0,
    },
    fetchedAt: cached?.fetchedAt ?? 0,
    promise: request,
  });

  return request;
}

export async function searchHistorySessions(
  query: string,
  sourceFilter: HistorySourceFilter = 'all',
  limit = 120,
): Promise<HistorySessionItem[]> {
  const result = await searchHistorySessionsWithDiagnostics(query, sourceFilter, limit);
  return result.sessions;
}

export async function searchHistorySessionsWithDiagnostics(
  query: string,
  sourceFilter: HistorySourceFilter = 'all',
  limit = 120,
): Promise<HistoryFetchResult> {
  const result = await invoke<HistoryListResult>('search_conversation_history', {
    query,
    source: sourceFilter === 'all' ? null : sourceFilter,
    limit,
  });
  return {
    sessions: normalizeHistorySessions(result.sessions),
    diagnostics: result.diagnostics ?? [],
  };
}

export async function fetchConversationDetail(session: Pick<HistorySessionItem, 'id' | 'source'>) {
  const detail = await invoke<ConversationDetailPayload>('get_conversation_detail', {
    sessionId: session.id,
    source: session.source,
  });
  const messages = detail.messages as ConversationMessageList;
  if (detail.toolResultsMerged) {
    messages.toolResultsMerged = true;
  }

  return {
    messages,
    segments: detail.segments,
    toolResultsMerged: detail.toolResultsMerged === true,
    warnings: (detail as any).warnings ?? [],
  };
}

export function primeHistoryPage() {
  void fetchHistorySessions('all').catch(() => {});
}

export function invalidateHistoryCache() {
  historySessionCache.clear();
  workspaceOverviewCache.clear();
}
