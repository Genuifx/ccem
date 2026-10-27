import { invoke } from '@tauri-apps/api/core';
import type { HistorySessionItem } from './types';

export interface SessionArchiveOverlayEntry {
  source: string;
  sessionId: string;
  archivedAt: number;
}

/** `archived: null` clears the override (undo) and defers to the native state. */
export function setSessionsArchived(
  sessions: Array<Pick<HistorySessionItem, 'source' | 'id'>>,
  archived: boolean | null,
): Promise<void> {
  return invoke('set_sessions_archived', {
    targets: sessions.map((session) => ({ source: session.source, sessionId: session.id })),
    archived,
  });
}

export function getArchivedSessions(): Promise<HistorySessionItem[]> {
  return invoke('get_archived_sessions');
}

export function getSessionArchiveOverlay(): Promise<SessionArchiveOverlayEntry[]> {
  return invoke('get_session_archive_overlay');
}
