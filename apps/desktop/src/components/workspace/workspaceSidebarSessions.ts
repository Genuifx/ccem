import type { HistorySessionItem, HistorySource } from '@/features/conversations/types';
import type { NativeProvider, NativeSessionSummary } from '@/lib/tauri-ipc';

export interface WorkspaceSidebarLiveSessionEntry {
  session: Pick<
    NativeSessionSummary,
    | 'runtime_id'
    | 'provider'
    | 'codex_isolated'
    | 'provider_session_id'
    | 'display_title'
    | 'display_title_revision'
    | 'initial_user_prompt'
    | 'project_dir'
    | 'env_name'
    | 'status'
    | 'is_active'
    | 'created_at'
    | 'updated_at'
  >;
  initialPrompt?: string | null;
  generatedTitle?: string | null;
}

const TERMINAL_NATIVE_STATUSES = new Set(['stopped', 'error', 'handoff']);

function toHistorySource(provider: NativeProvider): HistorySource {
  return provider === 'codex' ? 'codex' : 'claude';
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() || 'unknown';
}

function parseTimestamp(value: string | undefined): number {
  if (!value) {
    return Date.now();
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function liveSessionSidebarId(entry: WorkspaceSidebarLiveSessionEntry): string {
  const providerSessionId = entry.session.provider_session_id?.trim();
  return providerSessionId || entry.session.runtime_id;
}

export function liveSessionSidebarKey(entry: WorkspaceSidebarLiveSessionEntry): string {
  return historySessionKey({ source: toHistorySource(entry.session.provider), id: liveSessionSidebarId(entry), codexIsolated: entry.session.codex_isolated ?? false });
}

function liveSessionRuntimeSidebarKey(entry: WorkspaceSidebarLiveSessionEntry): string {
  return historySessionKey({ source: toHistorySource(entry.session.provider), id: entry.session.runtime_id, codexIsolated: entry.session.codex_isolated ?? false });
}

function historySessionKey(session: Pick<HistorySessionItem, 'id' | 'source' | 'codexIsolated'>): string {
  return `${session.source}:${session.source === 'codex' && session.codexIsolated ? 'isolated:' : ''}${session.id}`;
}

export function areHistorySessionItemsEqual(
  previous: HistorySessionItem,
  next: HistorySessionItem,
) {
  return previous.id === next.id
    && previous.source === next.source
    && previous.codexIsolated === next.codexIsolated
    && previous.display === next.display
    && previous.timestamp === next.timestamp
    && previous.project === next.project
    && previous.projectName === next.projectName
    && previous.cwd === next.cwd
    && previous.envName === next.envName
    && previous.configSource === next.configSource
    && previous.taskStage === next.taskStage
    && previous.taskSticker === next.taskSticker
    && previous.taskLabel === next.taskLabel
    && previous.launchMode === next.launchMode;
}

export function retainStableHistorySessions(
  previousSessions: HistorySessionItem[],
  nextSessions: HistorySessionItem[],
): HistorySessionItem[] {
  if (previousSessions.length === 0 && nextSessions.length === 0) {
    return previousSessions;
  }

  if (previousSessions.length === 0 || nextSessions.length === 0) {
    return nextSessions;
  }

  const previousByKey = new Map(
    previousSessions.map((session) => [historySessionKey(session), session])
  );
  let hasChanged = previousSessions.length !== nextSessions.length;
  const retainedSessions = nextSessions.map((session, index) => {
    const previous = previousByKey.get(historySessionKey(session));
    if (!previous || !areHistorySessionItemsEqual(previous, session)) {
      hasChanged = true;
      return session;
    }

    if (previousSessions[index] !== previous) {
      hasChanged = true;
    }
    return previous;
  });

  return hasChanged ? retainedSessions : previousSessions;
}

export interface LoadedHistorySessionVersion {
  key: string;
  timestamp: number;
}

export function toLoadedHistorySessionVersion(
  session: Pick<HistorySessionItem, 'id' | 'source' | 'codexIsolated' | 'timestamp'>,
): LoadedHistorySessionVersion {
  return { key: historySessionKey(session), timestamp: session.timestamp };
}

/**
 * Background refreshes reload the selected transcript only when the snapshot
 * version differs from the last transcript that loaded successfully.
 */
export function shouldReloadSelectedHistorySession(
  loaded: LoadedHistorySessionVersion | null,
  next: Pick<HistorySessionItem, 'id' | 'source' | 'codexIsolated' | 'timestamp'>,
): boolean {
  return !loaded
    || loaded.key !== historySessionKey(next)
    || loaded.timestamp !== next.timestamp;
}

function isTerminalNativeStatus(status: string): boolean {
  return TERMINAL_NATIVE_STATUSES.has(status);
}

function isTerminalNativeSession(entry: WorkspaceSidebarLiveSessionEntry): boolean {
  return isTerminalNativeStatus(entry.session.status);
}

export function isActiveWorkspaceNativeSession(
  session: Pick<NativeSessionSummary, 'status' | 'is_active'>,
): boolean {
  return session.is_active && !isTerminalNativeStatus(session.status);
}

export function canRestoreWorkspaceLiveSession(
  session: Pick<NativeSessionSummary, 'status' | 'is_active'>,
): boolean {
  if (session.status === 'interrupted' || session.status === 'closed_idle') {
    return true;
  }
  return isActiveWorkspaceNativeSession(session);
}

/**
 * Always discover authoritative active runtimes. Persistence is only needed to
 * keep explicitly recoverable inactive sessions (for example interrupted
 * conversations) across a desktop restart.
 */
export function selectWorkspaceLiveSessionsForRestore(
  nativeSessions: NativeSessionSummary[],
  persistedRuntimeIds: string[],
): NativeSessionSummary[] {
  const persistedRuntimeIdSet = new Set(persistedRuntimeIds);
  return nativeSessions.filter((session) => (
    isActiveWorkspaceNativeSession(session)
    || (
      persistedRuntimeIdSet.has(session.runtime_id)
      && canRestoreWorkspaceLiveSession(session)
    )
  ));
}

export interface LiveSessionTreeState {
  canonicalKeyBySessionKey: Record<string, string>;
  activeSessionKeys: Set<string>;
}

export function hasWorkspaceLiveActivityConflict(
  activeSessionKeys: ReadonlySet<string>,
  decorationsBySessionKey: Readonly<Record<string, { isActive?: boolean } | undefined>>,
): boolean {
  for (const sessionKey of activeSessionKeys) {
    if (decorationsBySessionKey[sessionKey]?.isActive === false) {
      return true;
    }
  }
  return false;
}

/**
 * Keep runtime wrappers and their eventual provider history rows as one UI
 * identity. Provider ids remain the canonical business id when available;
 * runtime ids are only aliases used while the provider is still starting.
 */
export function buildLiveSessionTreeState(
  liveEntries: WorkspaceSidebarLiveSessionEntry[],
): LiveSessionTreeState {
  const canonicalKeyBySessionKey: Record<string, string> = {};
  const activeSessionKeys = new Set<string>();

  for (const entry of liveEntries) {
    const runtimeKey = liveSessionRuntimeSidebarKey(entry);
    const canonicalKey = liveSessionSidebarKey(entry);
    canonicalKeyBySessionKey[runtimeKey] = canonicalKey;
    canonicalKeyBySessionKey[canonicalKey] = canonicalKey;

    if (isActiveWorkspaceNativeSession(entry.session)) {
      activeSessionKeys.add(canonicalKey);
    }
  }

  return {
    canonicalKeyBySessionKey,
    activeSessionKeys,
  };
}

export function toLiveHistorySessionItem(
  entry: WorkspaceSidebarLiveSessionEntry,
): HistorySessionItem | null {
  if (isTerminalNativeSession(entry)) {
    return null;
  }

  const project = entry.session.project_dir.trim();
  const hasAuthoritativeTitleState = (entry.session.display_title_revision ?? 0) > 0;
  const display = entry.session.display_title?.trim()
    || (!hasAuthoritativeTitleState ? entry.generatedTitle?.trim() : '')
    || entry.session.initial_user_prompt?.trim()
    || entry.initialPrompt?.trim()
    || `${entry.session.provider === 'codex' ? 'Codex' : 'Claude'} workspace session`;

  return {
    id: liveSessionSidebarId(entry),
    source: toHistorySource(entry.session.provider),
    codexIsolated: entry.session.provider === 'codex' ? entry.session.codex_isolated ?? false : undefined,
    display,
    timestamp: parseTimestamp(entry.session.updated_at || entry.session.created_at),
    project,
    projectName: basename(project),
    envName: entry.session.env_name,
    configSource: entry.session.provider_session_id?.trim() ? 'ccem' : 'native',
  };
}

export function buildWorkspaceSidebarSessions(
  historySessions: HistorySessionItem[],
  liveEntries: WorkspaceSidebarLiveSessionEntry[],
): HistorySessionItem[] {
  if (liveEntries.length === 0) {
    for (let index = 1; index < historySessions.length; index += 1) {
      if (historySessions[index - 1].timestamp < historySessions[index].timestamp) {
        return [...historySessions].sort((left, right) => right.timestamp - left.timestamp);
      }
    }
    return historySessions;
  }

  const nextSessions = [...historySessions];
  const indexByKey = new Map(historySessions.map((session, index) => [historySessionKey(session), index]));

  for (const entry of liveEntries) {
    const liveItem = toLiveHistorySessionItem(entry);
    if (!liveItem) {
      continue;
    }

    const key = historySessionKey(liveItem);
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      const historyItem = nextSessions[existingIndex];
      // Persisted native revisions include manual clears. Their latest title
      // must render immediately, even while the history snapshot is stale.
      if (((entry.session.display_title_revision ?? 0) > 0 || !historyItem.display.trim())
        && historyItem.display !== liveItem.display) {
        nextSessions[existingIndex] = { ...historyItem, display: liveItem.display };
      }
      continue;
    }

    indexByKey.set(key, nextSessions.length);
    nextSessions.push(liveItem);
  }

  return nextSessions.sort((left, right) => right.timestamp - left.timestamp);
}

export function findLiveEntryForSidebarSession<T extends WorkspaceSidebarLiveSessionEntry>(
  liveEntries: T[],
  session: Pick<HistorySessionItem, 'id' | 'source' | 'codexIsolated'>,
): T | undefined {
  return liveEntries.find((entry) => {
    const source = toHistorySource(entry.session.provider);
    if (source !== session.source) {
      return false;
    }
    if (source === 'codex' && Boolean(entry.session.codex_isolated) !== Boolean(session.codexIsolated)) {
      return false;
    }

    return entry.session.runtime_id === session.id
      || entry.session.provider_session_id === session.id;
  });
}

export function resolveWorkspaceReviewProviderSessionId(
  session: Pick<HistorySessionItem, 'id' | 'configSource'> | null | undefined,
  liveEntry?: WorkspaceSidebarLiveSessionEntry | null,
): string | null {
  if (!session) {
    return null;
  }

  if (session.configSource === 'native') {
    return liveEntry?.session.provider_session_id?.trim() || null;
  }

  return session.id;
}
