import type {
  ConversationMessageData,
} from '@/features/conversations/types';
import type {
  NativeSessionSummary,
  SessionPromptAnnotation,
  SessionPromptImage,
} from '@/lib/tauri-ipc';

export interface WorkspaceLiveSessionEntry {
  session: NativeSessionSummary;
  initialPrompt: string | null;
  initialImages: SessionPromptImage[] | null;
  initialAnnotations: SessionPromptAnnotation[] | null;
  generatedTitle?: string | null;
  seedMessages: ConversationMessageData[];
}

export type WorkspaceLiveSessionsByRuntimeId = Record<string, WorkspaceLiveSessionEntry>;

type MutableSnapshotRef<T> = {
  current: T;
};

export function areNativeSessionSummariesEqual(
  previous: NativeSessionSummary,
  next: NativeSessionSummary,
) {
  return previous.runtime_id === next.runtime_id
    && previous.provider === next.provider
    && previous.transport === next.transport
    && previous.provider_session_id === next.provider_session_id
    && previous.display_title === next.display_title
    && previous.display_title_revision === next.display_title_revision
    && previous.initial_user_prompt === next.initial_user_prompt
    && previous.project_dir === next.project_dir
    && previous.env_name === next.env_name
    && previous.perm_mode === next.perm_mode
    && previous.runtime_perm_mode === next.runtime_perm_mode
    && previous.effort === next.effort
    && previous.status === next.status
    && previous.created_at === next.created_at
    && previous.updated_at === next.updated_at
    && previous.is_active === next.is_active
    && previous.last_event_seq === next.last_event_seq
    && previous.can_handoff_to_terminal === next.can_handoff_to_terminal
    && previous.last_error === next.last_error;
}

function mergeInitialUserPrompt(
  previous: NativeSessionSummary,
  target: NativeSessionSummary,
  candidate: NativeSessionSummary,
): NativeSessionSummary {
  const previousPrompt = previous.initial_user_prompt?.trim()
    ? previous.initial_user_prompt
    : null;
  const candidatePrompt = candidate.initial_user_prompt?.trim()
    ? candidate.initial_user_prompt
    : null;
  const nextPrompt = previousPrompt || candidatePrompt;

  if (target.initial_user_prompt === nextPrompt) {
    return target;
  }
  return {
    ...target,
    initial_user_prompt: nextPrompt,
  };
}

function preserveNewerDisplayTitle(
  previous: NativeSessionSummary,
  incoming: NativeSessionSummary,
  promptCandidate: NativeSessionSummary = incoming,
): NativeSessionSummary {
  const incomingWithInitialPrompt = mergeInitialUserPrompt(previous, incoming, promptCandidate);
  const previousProviderSessionId = previous.provider_session_id?.trim() || null;
  const incomingProviderSessionId = incomingWithInitialPrompt.provider_session_id?.trim() || null;
  if (previousProviderSessionId !== incomingProviderSessionId) {
    if (previousProviderSessionId && !incomingProviderSessionId) {
      // Provider binding is monotonic for a runtime. A slower response that
      // started before binding must not roll the entry back to a runtime-only
      // title identity.
      return {
        ...incomingWithInitialPrompt,
        provider_session_id: previous.provider_session_id,
        display_title: previous.display_title,
        display_title_revision: previous.display_title_revision,
      };
    }
    // A newly-bound provider id changes the authoritative title key. An older
    // runtime-key title must not mask an intentionally empty provider title.
    return incomingWithInitialPrompt;
  }
  const previousRevision = previous.display_title_revision ?? 0;
  const incomingRevision = incomingWithInitialPrompt.display_title_revision ?? 0;
  if (previousRevision <= incomingRevision) {
    return incomingWithInitialPrompt;
  }
  return {
    ...incomingWithInitialPrompt,
    display_title: previous.display_title,
    display_title_revision: previousRevision,
  };
}

function displayTitleAuthorityAdvanced(
  previous: NativeSessionSummary,
  next: NativeSessionSummary,
): boolean {
  const previousProviderSessionId = previous.provider_session_id?.trim() || null;
  const nextProviderSessionId = next.provider_session_id?.trim() || null;
  const previousRevision = previous.display_title_revision ?? 0;
  const nextRevision = next.display_title_revision ?? 0;
  if (nextRevision > previousRevision) {
    return true;
  }
  if (previousProviderSessionId === nextProviderSessionId) {
    return false;
  }

  // Provider binding changes which persisted title key is authoritative, but
  // an empty revision-zero summary does not yet carry title state. Keep an
  // ephemeral generated title long enough for Workspace to bind that title to
  // the new provider id. A persisted title or clear tombstone may replace it.
  return nextRevision > 0 || Boolean(next.display_title?.trim());
}

export function beginWorkspaceSessionTitleGeneration(
  revisions: Record<string, number>,
  runtimeId: string,
): number {
  const nextRevision = (revisions[runtimeId] ?? 0) + 1;
  revisions[runtimeId] = nextRevision;
  return nextRevision;
}

export function cancelWorkspaceSessionTitleGeneration(
  revisions: Record<string, number>,
  runtimeId: string,
): void {
  revisions[runtimeId] = (revisions[runtimeId] ?? 0) + 1;
}

export function isWorkspaceSessionTitleGenerationCurrent(
  revisions: Record<string, number>,
  runtimeId: string,
  revision: number,
): boolean {
  return revisions[runtimeId] === revision;
}

export function updateWorkspaceLiveSessionDisplayTitle(
  previous: WorkspaceLiveSessionsByRuntimeId,
  source: string,
  sessionId: string,
  title: string,
  displayTitleRevision: number,
): WorkspaceLiveSessionsByRuntimeId {
  const normalizedTitle = title.trim() || null;
  let next = previous;

  for (const [runtimeId, entry] of Object.entries(previous)) {
    const matches = entry.session.provider === source
      && (
        entry.session.runtime_id === sessionId
        || entry.session.provider_session_id === sessionId
      );
    if (
      !matches
      || (entry.session.display_title_revision ?? 0) > displayTitleRevision
      || (
        entry.session.display_title === normalizedTitle
        && entry.session.display_title_revision === displayTitleRevision
        && entry.generatedTitle == null
      )
    ) {
      continue;
    }

    if (next === previous) {
      next = { ...previous };
    }
    next[runtimeId] = {
      ...entry,
      generatedTitle: null,
      session: {
        ...entry.session,
        display_title: normalizedTitle,
        display_title_revision: displayTitleRevision,
      },
    };
  }

  return next;
}

export function upsertWorkspaceLiveSessionEntry(
  previous: WorkspaceLiveSessionsByRuntimeId,
  session: NativeSessionSummary,
  options: {
    initialPrompt?: string | null;
    initialImages?: SessionPromptImage[] | null;
    initialAnnotations?: SessionPromptAnnotation[] | null;
    generatedTitle?: string | null;
    seedMessages?: ConversationMessageData[];
  } = {},
): WorkspaceLiveSessionsByRuntimeId {
  const existing = previous[session.runtime_id];
  const nextSession = existing
    ? preserveNewerDisplayTitle(existing.session, session)
    : session;
  const nextInitialPrompt = options.initialPrompt ?? existing?.initialPrompt ?? null;
  const nextInitialImages = options.initialImages ?? existing?.initialImages ?? null;
  const nextInitialAnnotations = options.initialAnnotations ?? existing?.initialAnnotations ?? null;
  const nextGeneratedTitle = options.generatedTitle !== undefined
    ? options.generatedTitle
    : existing && displayTitleAuthorityAdvanced(existing.session, nextSession)
      ? null
      : existing?.generatedTitle ?? null;
  const nextSeedMessages = options.seedMessages ?? existing?.seedMessages ?? [];

  if (
    existing
    && existing.initialPrompt === nextInitialPrompt
    && existing.initialImages === nextInitialImages
    && existing.initialAnnotations === nextInitialAnnotations
    && existing.generatedTitle === nextGeneratedTitle
    && existing.seedMessages === nextSeedMessages
    && areNativeSessionSummariesEqual(existing.session, nextSession)
  ) {
    return previous;
  }

  return {
    ...previous,
    [session.runtime_id]: {
      session: nextSession,
      initialPrompt: nextInitialPrompt,
      initialImages: nextInitialImages,
      initialAnnotations: nextInitialAnnotations,
      generatedTitle: nextGeneratedTitle,
      seedMessages: nextSeedMessages,
    },
  };
}

export function reconcileWorkspaceLiveSessionsSnapshot(
  previous: WorkspaceLiveSessionsByRuntimeId,
  sessions: NativeSessionSummary[],
  requestBaseline: WorkspaceLiveSessionsByRuntimeId = previous,
): WorkspaceLiveSessionsByRuntimeId {
  const next: WorkspaceLiveSessionsByRuntimeId = {};
  const snapshotRuntimeIds = new Set(sessions.map((session) => session.runtime_id));

  for (const session of sessions) {
    const existing = previous[session.runtime_id];
    const baselineEntry = requestBaseline[session.runtime_id];
    const changedDuringRequest = Boolean(existing && existing !== baselineEntry);
    const currentUpdatedAt = existing ? Date.parse(existing.session.updated_at) : Number.NaN;
    const incomingUpdatedAt = Date.parse(session.updated_at);
    const incomingIsOlder = changedDuringRequest
      && existing
      && (
        (Number.isFinite(currentUpdatedAt) && Number.isFinite(incomingUpdatedAt)
          && incomingUpdatedAt < currentUpdatedAt)
        || (
          incomingUpdatedAt === currentUpdatedAt
          && (session.last_event_seq ?? -1) < (existing.session.last_event_seq ?? -1)
        )
      );
    const runtimeSession = incomingIsOlder && existing ? existing.session : session;
    const nextSession = existing
      ? preserveNewerDisplayTitle(existing.session, runtimeSession, session)
      : runtimeSession;

    if (existing && areNativeSessionSummariesEqual(existing.session, nextSession)) {
      next[session.runtime_id] = existing;
      continue;
    }

    next[session.runtime_id] = existing
      ? {
          ...existing,
          generatedTitle: displayTitleAuthorityAdvanced(existing.session, nextSession)
            ? null
            : existing.generatedTitle,
          session: nextSession,
        }
      : {
          session: nextSession,
          initialPrompt: null,
          initialImages: null,
          initialAnnotations: null,
          generatedTitle: null,
          seedMessages: [],
        };
  }

  for (const [runtimeId, entry] of Object.entries(previous)) {
    if (snapshotRuntimeIds.has(runtimeId)) {
      continue;
    }
    if (requestBaseline[runtimeId] !== entry) {
      next[runtimeId] = entry;
    }
  }

  const previousRuntimeIds = Object.keys(previous);
  const unchanged = previousRuntimeIds.length === Object.keys(next).length
    && previousRuntimeIds.every((runtimeId) => next[runtimeId] === previous[runtimeId]);
  return unchanged ? previous : next;
}

export function replaceWorkspaceLiveSessionsSnapshot(
  liveSessionsRef: MutableSnapshotRef<WorkspaceLiveSessionsByRuntimeId>,
  setLiveSessions: (next: WorkspaceLiveSessionsByRuntimeId) => void,
  next: WorkspaceLiveSessionsByRuntimeId,
) {
  liveSessionsRef.current = next;
  setLiveSessions(next);
  return next;
}

export function updateWorkspaceLiveSessionsSnapshot(
  liveSessionsRef: MutableSnapshotRef<WorkspaceLiveSessionsByRuntimeId>,
  setLiveSessions: (next: WorkspaceLiveSessionsByRuntimeId) => void,
  updater: (previous: WorkspaceLiveSessionsByRuntimeId) => WorkspaceLiveSessionsByRuntimeId,
) {
  return replaceWorkspaceLiveSessionsSnapshot(
    liveSessionsRef,
    setLiveSessions,
    updater(liveSessionsRef.current),
  );
}
