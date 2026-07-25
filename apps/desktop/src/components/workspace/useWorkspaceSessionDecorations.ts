import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { scheduleAfterFirstPaint } from '@/lib/idle';
import type { HistorySessionItem } from '@/features/conversations/types';

export type WorkspaceSessionVisualState = 'identity' | 'processing' | 'attention';
export type WorkspaceAttentionKind = 'input_required' | 'plan_review' | 'permission_required';

export interface WorkspaceSessionDecoration {
  sessionKey: string;
  runtimeId?: string;
  client?: 'claude' | 'codex' | 'opencode';
  status?: string;
  isActive?: boolean;
  envName?: string;
  visualState: WorkspaceSessionVisualState;
  attentionKind?: WorkspaceAttentionKind;
}

interface WorkspaceDecorationSessionInput {
  id: string;
  source: HistorySessionItem['source'];
  timestamp: number;
  project: string;
  projectName: string;
  envName?: string | null;
}

interface UseWorkspaceSessionDecorationsOptions {
  sessions: HistorySessionItem[];
  isActive?: boolean;
}

const POLL_INTERVAL_MS = 3000;

function toDecorationSessionInput(session: HistorySessionItem): WorkspaceDecorationSessionInput {
  return {
    id: session.id,
    source: session.source,
    timestamp: session.timestamp,
    project: session.project,
    projectName: session.projectName,
    envName: session.envName ?? null,
  };
}

function normalizeClient(value: unknown): WorkspaceSessionDecoration['client'] {
  if (value === 'codex' || value === 'opencode') {
    return value;
  }
  return 'claude';
}

function normalizeVisualState(value: unknown): WorkspaceSessionVisualState {
  if (value === 'processing' || value === 'attention') {
    return value;
  }
  return 'identity';
}

function normalizeAttentionKind(value: unknown): WorkspaceAttentionKind | undefined {
  if (value === 'input_required' || value === 'plan_review' || value === 'permission_required') {
    return value;
  }
  return undefined;
}

function normalizeDecoration(value: WorkspaceSessionDecoration): WorkspaceSessionDecoration {
  return {
    ...value,
    client: normalizeClient(value.client),
    isActive: typeof value.isActive === 'boolean' ? value.isActive : undefined,
    visualState: normalizeVisualState(value.visualState),
    attentionKind: normalizeAttentionKind(value.attentionKind),
  };
}

function decorationsEqual(
  previous: Record<string, WorkspaceSessionDecoration>,
  next: Record<string, WorkspaceSessionDecoration>,
): boolean {
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  if (previousKeys.length !== nextKeys.length) {
    return false;
  }

  return nextKeys.every((key) => {
    const left = previous[key];
    const right = next[key];
    return !!left
      && left.runtimeId === right.runtimeId
      && left.client === right.client
      && left.status === right.status
      && left.isActive === right.isActive
      && left.envName === right.envName
      && left.visualState === right.visualState
      && left.attentionKind === right.attentionKind;
  });
}

function toDecorationRecord(
  decorations: WorkspaceSessionDecoration[],
): Record<string, WorkspaceSessionDecoration> {
  return Object.fromEntries(
    decorations
      .map(normalizeDecoration)
      .filter((decoration) => decoration.sessionKey)
      .map((decoration) => [decoration.sessionKey, decoration])
  );
}

export function useWorkspaceSessionDecorations({
  sessions,
  isActive = true,
}: UseWorkspaceSessionDecorationsOptions) {
  const [decorationsBySessionKey, setDecorationsBySessionKey] = useState<
    Record<string, WorkspaceSessionDecoration>
  >({});

  const decorationSessions = useMemo(
    () => sessions.map(toDecorationSessionInput),
    [sessions],
  );

  const refreshDecorations = useCallback(async () => {
    if (decorationSessions.length === 0) {
      setDecorationsBySessionKey((current) => (
        Object.keys(current).length === 0 ? current : {}
      ));
      return;
    }

    const decorations = await invoke<WorkspaceSessionDecoration[]>(
      'get_workspace_session_decorations',
      { sessions: decorationSessions },
    );
    const nextDecorations = toDecorationRecord(decorations);
    setDecorationsBySessionKey((current) => (
      decorationsEqual(current, nextDecorations) ? current : nextDecorations
    ));
  }, [decorationSessions]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    let cancelled = false;
    const tick = async () => {
      try {
        await refreshDecorations();
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to refresh workspace session decorations:', error);
        }
      }
    };

    const cancelDeferred = scheduleAfterFirstPaint(() => {
      void tick();
    }, { delayMs: 180, timeoutMs: 1200 });

    const intervalId = window.setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      cancelDeferred();
      window.clearInterval(intervalId);
    };
  }, [isActive, refreshDecorations]);

  return {
    decorationsBySessionKey,
  };
}
