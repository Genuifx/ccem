import type { PermissionModeName } from '@ccem/core/browser';
import type { HistorySessionItem, HistorySource } from '@/features/conversations/types';
import type { EffortLevel } from '@/components/workspace/ComposerControls';

export interface WorkspaceHistorySessionPreference {
  envName?: string;
  permMode?: PermissionModeName;
  effort?: EffortLevel;
  model?: string;
}

export type WorkspaceHistorySessionPreferences = Record<string, WorkspaceHistorySessionPreference>;

const DEFAULT_EFFORT: EffortLevel = 'max';
const PERMISSION_MODES = new Set(['yolo', 'auto', 'dev', 'readonly', 'safe']);
const EFFORT_ORDER: EffortLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_EFFORT_LEVELS = new Set<EffortLevel>(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_EFFORT_LEVELS = new Set<EffortLevel>(['minimal', 'low', 'medium', 'high', 'xhigh']);
const AGY_EFFORT_LEVELS = new Set<EffortLevel>(['low', 'medium', 'high', 'xhigh']);

function resolvePermissionMode(value: string | undefined): PermissionModeName | null {
  // Retired modes: "ci" became "safe", "audit" became "readonly".
  if (value === 'ci') return 'safe';
  if (value === 'audit') return 'readonly';
  return value && PERMISSION_MODES.has(value) ? value as PermissionModeName : null;
}

export function isEffortLevel(value: string | null | undefined): value is EffortLevel {
  return Boolean(
    value
      && (
        CLAUDE_EFFORT_LEVELS.has(value as EffortLevel)
        || CODEX_EFFORT_LEVELS.has(value as EffortLevel)
        || AGY_EFFORT_LEVELS.has(value as EffortLevel)
      ),
  );
}

export function clampEffortToSupportedLevels(
  effort: string | null | undefined,
  supportedLevels: readonly EffortLevel[],
  fallback?: EffortLevel,
): EffortLevel {
  if (supportedLevels.length === 0) {
    return isEffortLevel(effort) ? effort : (fallback ?? 'high');
  }
  if (isEffortLevel(effort) && supportedLevels.includes(effort)) {
    return effort;
  }
  if (isEffortLevel(effort)) {
    const requestedIndex = EFFORT_ORDER.indexOf(effort);
    for (let i = requestedIndex - 1; i >= 0; i -= 1) {
      const candidate = EFFORT_ORDER[i]!;
      if (supportedLevels.includes(candidate)) {
        return candidate;
      }
    }
    for (let i = requestedIndex + 1; i < EFFORT_ORDER.length; i += 1) {
      const candidate = EFFORT_ORDER[i]!;
      if (supportedLevels.includes(candidate)) {
        return candidate;
      }
    }
  }
  if (fallback && supportedLevels.includes(fallback)) {
    return fallback;
  }
  if (supportedLevels.includes('high')) {
    return 'high';
  }
  return supportedLevels[0]!;
}

function sessionPreferenceKey(session: Pick<HistorySessionItem, 'id' | 'source' | 'codexIsolated'>): string {
  return `${session.source}:${session.source === 'codex' && session.codexIsolated ? 'isolated:' : ''}${session.id}`;
}

export function normalizeEffortForProvider(
  effort: string | null | undefined,
  provider: HistorySource | string | null | undefined,
): EffortLevel {
  if (!isEffortLevel(effort)) {
    if (provider === 'codex' || provider === 'agy') return 'high';
    return DEFAULT_EFFORT;
  }

  if (provider === 'codex' && !CODEX_EFFORT_LEVELS.has(effort)) {
    return 'high';
  }

  if (provider === 'agy' && !AGY_EFFORT_LEVELS.has(effort)) {
    return effort === 'max' ? 'xhigh' : 'high';
  }

  if (provider !== 'codex' && provider !== 'agy' && !CLAUDE_EFFORT_LEVELS.has(effort)) {
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
  defaultModel?: string | null;
}) {
  const saved = options.preferences[sessionPreferenceKey(options.session)] ?? {};
  const savedPermMode = resolvePermissionMode(saved.permMode);
  const resolvedModel = saved.model || options.defaultModel || undefined;

  return {
    envName: saved.envName || options.session.envName || options.currentEnv || '',
    permMode: savedPermMode || options.defaultPermMode,
    effort: normalizeEffortForProvider(saved.effort, options.session.source),
    ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
  };
}
