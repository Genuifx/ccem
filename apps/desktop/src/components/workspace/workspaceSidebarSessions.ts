import type { HistorySessionItem, HistorySource } from '@/features/conversations/types';
import type { NativeProvider, NativeSessionSummary } from '@/lib/tauri-ipc';

export interface WorkspaceSidebarLiveSessionEntry {
  session: Pick<
    NativeSessionSummary,
    | 'runtime_id'
    | 'provider'
    | 'provider_session_id'
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
  return `${toHistorySource(entry.session.provider)}:${liveSessionSidebarId(entry)}`;
}

function liveSessionRuntimeSidebarKey(entry: WorkspaceSidebarLiveSessionEntry): string {
  return `${toHistorySource(entry.session.provider)}:${entry.session.runtime_id}`;
}

function historySessionKey(session: Pick<HistorySessionItem, 'id' | 'source'>): string {
  return `${session.source}:${session.id}`;
}

export function areHistorySessionItemsEqual(
  previous: HistorySessionItem,
  next: HistorySessionItem,
) {
  return previous.id === next.id
    && previous.source === next.source
    && previous.display === next.display
    && previous.timestamp === next.timestamp
    && previous.project === next.project
    && previous.projectName === next.projectName
    && previous.envName === next.envName
    && previous.configSource === next.configSource
    && previous.taskStage === next.taskStage
    && previous.taskSticker === next.taskSticker
    && previous.taskLabel === next.taskLabel;
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
  const display = entry.generatedTitle?.trim()
    || entry.initialPrompt?.trim()
    || entry.session.provider_session_id?.trim()
    || `${entry.session.provider === 'codex' ? 'Codex' : 'Claude'} workspace session`;

  return {
    id: liveSessionSidebarId(entry),
    source: toHistorySource(entry.session.provider),
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
  const existingKeys = new Set(historySessions.map(historySessionKey));

  for (const entry of liveEntries) {
    const liveItem = toLiveHistorySessionItem(entry);
    if (!liveItem) {
      continue;
    }

    const key = historySessionKey(liveItem);
    if (existingKeys.has(key)) {
      continue;
    }

    existingKeys.add(key);
    nextSessions.push(liveItem);
  }

  return nextSessions.sort((left, right) => right.timestamp - left.timestamp);
}

export function findLiveEntryForSidebarSession<T extends WorkspaceSidebarLiveSessionEntry>(
  liveEntries: T[],
  session: Pick<HistorySessionItem, 'id' | 'source'>,
): T | undefined {
  return liveEntries.find((entry) => {
    const source = toHistorySource(entry.session.provider);
    if (source !== session.source) {
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
