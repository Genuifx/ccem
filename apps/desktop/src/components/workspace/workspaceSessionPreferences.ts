import type { PermissionModeName } from '@ccem/core/browser';
import type { HistorySessionItem, HistorySource } from '@/features/conversations/types';
import type { EffortLevel } from '@/components/workspace/ComposerControls';

export interface WorkspaceHistorySessionPreference {
  envName?: string;
  permMode?: PermissionModeName;
  effort?: EffortLevel;
}

export type WorkspaceHistorySessionPreferences = Record<string, WorkspaceHistorySessionPreference>;

const DEFAULT_EFFORT: EffortLevel = 'max';
const PERMISSION_MODES = new Set(['yolo', 'auto', 'dev', 'readonly', 'safe']);
const CLAUDE_EFFORT_LEVELS = new Set<EffortLevel>(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_EFFORT_LEVELS = new Set<EffortLevel>(['minimal', 'low', 'medium', 'high', 'xhigh']);

function resolvePermissionMode(value: string | undefined): PermissionModeName | null {
  // Retired modes: "ci" became "safe", "audit" became "readonly".
  if (value === 'ci') return 'safe';
  if (value === 'audit') return 'readonly';
  return value && PERMISSION_MODES.has(value) ? value as PermissionModeName : null;
}

function isEffortLevel(value: string | null | undefined): value is EffortLevel {
  return Boolean(
    value
      && (
        CLAUDE_EFFORT_LEVELS.has(value as EffortLevel)
        || CODEX_EFFORT_LEVELS.has(value as EffortLevel)
      ),
  );
}

function sessionPreferenceKey(session: Pick<HistorySessionItem, 'id' | 'source' | 'codexIsolated'>): string {
  return `${session.source}:${session.source === 'codex' && session.codexIsolated ? 'isolated:' : ''}${session.id}`;
}

export function normalizeEffortForProvider(
  effort: string | null | undefined,
  provider: HistorySource | string | null | undefined,
): EffortLevel {
  if (!isEffortLevel(effort)) {
    if (provider === 'codex') return 'high';
    return DEFAULT_EFFORT;
  }

  if (provider === 'codex' && !CODEX_EFFORT_LEVELS.has(effort)) {
    return 'high';
  }

  if (provider !== 'codex' && !CLAUDE_EFFORT_LEVELS.has(effort)) {
    return DEFAULT_EFFORT;
  }

  return effort;
}

export function updateHistorySessionPreference(
  preferences: WorkspaceHistorySessionPreferences,
  sessionKey: string,
  patch: WorkspaceHistorySessionPreference,
): WorkspaceHistorySessionPreferences {
  return {
    ...preferences,
    [sessionKey]: {
      ...preferences[sessionKey],
      ...patch,
    },
  };
}

export function resolveHistorySessionControls(options: {
  session: Pick<HistorySessionItem, 'id' | 'source' | 'envName'>;
  preferences: WorkspaceHistorySessionPreferences;
  currentEnv?: string | null;
  defaultPermMode: PermissionModeName;
}) {
  const saved = options.preferences[sessionPreferenceKey(options.session)] ?? {};
  const savedPermMode = resolvePermissionMode(saved.permMode);

  return {
    envName: saved.envName || options.session.envName || options.currentEnv || '',
    permMode: savedPermMode || options.defaultPermMode,
    effort: normalizeEffortForProvider(saved.effort, options.session.source),
  };
}
