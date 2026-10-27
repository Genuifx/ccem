import type { HistorySessionItem } from '@/features/conversations/types';

/** Sessions idle at least this long are offered for bulk archive. */
export const STALE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export interface BulkArchiveCandidates {
  stale: HistorySessionItem[];
  done: HistorySessionItem[];
}

/**
 * Project-level bulk archive candidates. Pinned and running sessions are
 * protected: pinning is an explicit "keep this visible" signal, and a running
 * session would resurface on its next turn anyway.
 */
export function selectBulkArchiveCandidates(
  sessions: readonly HistorySessionItem[],
  isProtected: (session: HistorySessionItem) => boolean,
  now = Date.now(),
): BulkArchiveCandidates {
  const stale: HistorySessionItem[] = [];
  const done: HistorySessionItem[] = [];
  for (const session of sessions) {
    if (isProtected(session)) continue;
    if (now - session.timestamp >= STALE_SESSION_MS) stale.push(session);
    if (session.taskStage === 'done') done.push(session);
  }
  return { stale, done };
}

export function filterArchivedSessions(
  sessions: readonly HistorySessionItem[],
  query: string,
): HistorySessionItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...sessions];
  return sessions.filter((session) => {
    const haystack = `${session.display} ${session.projectName} ${session.taskLabel ?? ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
