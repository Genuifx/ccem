import { invoke } from '@tauri-apps/api/core';
import { nativeCreateFailure } from '@/components/workspace/composerSubmissionResult';
import type { RuntimeConfigOptionsState } from '@/lib/tauri-ipc';

export interface AgyRuntimeStatus {
  installed: boolean;
  resolvedPath: string | null;
  customPath: string | null;
  defaultHomeDir: string;
}

export interface AgyModelCatalogItem {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort?: string | null;
}

export interface AgyModelCatalogResponse {
  models: AgyModelCatalogItem[];
  defaultModel?: string | null;
  source: string;
}

const AGY_EFFORT_VALUES = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const DEFAULT_AGY_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;

export function parseAgyTranscriptModel(
  rawModel: string | null | undefined,
  catalog?: readonly AgyModelCatalogItem[],
): { model: string; effort?: string } | null {
  const trimmed = rawModel?.trim();
  if (!trimmed) return null;

  if (catalog?.some((item) => item.id === trimmed)) {
    return { model: trimmed };
  }

  for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const suffix = `-${effort}`;
    if (trimmed.endsWith(suffix) && trimmed.length > suffix.length) {
      const base = trimmed.slice(0, -suffix.length);
      if (!catalog || catalog.length === 0 || catalog.some((item) => item.id === base)) {
        return { model: base, effort };
      }
    }
  }

  return { model: trimmed };
}

export function resolveAgyModelsForControl(options: {
  catalog?: readonly AgyModelCatalogItem[];
  liveConfigOptions?: RuntimeConfigOptionsState | null;
}): AgyModelCatalogItem[] {
  const catalog = options.catalog ?? [];
  const catalogById = new Map(catalog.map((item) => [item.id, item]));
  const live = options.liveConfigOptions;

  if (live && Array.isArray(live.models) && live.models.length > 0) {
    const liveEfforts = live.supports_effort
      ? live.efforts.map((choice) => choice.value).filter((value) => AGY_EFFORT_VALUES.has(value))
      : [];
    return live.models.map((choice) => {
      const catalogItem = catalogById.get(choice.value);
      const isCurrent = live.current_model === choice.value;
      const efforts = isCurrent
        ? liveEfforts
        : (catalogItem?.efforts ?? []);
      return {
        id: choice.value,
        name: choice.name?.trim() || catalogItem?.name || choice.value,
        efforts,
        defaultEffort: isCurrent
          ? (live.current_effort ?? catalogItem?.defaultEffort ?? efforts[0] ?? null)
          : (catalogItem?.defaultEffort ?? null),
      };
    });
  }

  return [...catalog];
}

export function resolveAgyEffortLevels(
  modelId: string | null | undefined,
  models: readonly AgyModelCatalogItem[],
  liveConfigOptions?: RuntimeConfigOptionsState | null,
): string[] {
  if (
    liveConfigOptions
    && (!modelId || !liveConfigOptions.current_model || liveConfigOptions.current_model === modelId)
  ) {
    if (!liveConfigOptions.supports_effort) {
      return [];
    }
    return liveConfigOptions.efforts
      .map((choice) => choice.value)
      .filter((value) => AGY_EFFORT_VALUES.has(value));
  }

  if (modelId) {
    const matched = models.find((item) => item.id === modelId);
    if (matched) {
      return matched.efforts.filter((value) => AGY_EFFORT_VALUES.has(value));
    }
  }

  if (models.length > 0) {
    return models[0]!.efforts.filter((value) => AGY_EFFORT_VALUES.has(value));
  }

  return [...DEFAULT_AGY_EFFORT_LEVELS];
}

export const AGY_AUTH_REQUIRED_PREFIX = 'AGY_AUTH_REQUIRED';

export function agyRuntimeErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return '';
}

export function isAgyAuthRequiredError(error?: unknown): boolean {
  if (error == null) return false;
  const raw = agyRuntimeErrorText(error);
  if (raw.includes(AGY_AUTH_REQUIRED_PREFIX)) return true;
  const failure = nativeCreateFailure(error);
  return failure.detail.includes(AGY_AUTH_REQUIRED_PREFIX);
}

export async function checkAgyInstalled(): Promise<boolean> {
  try {
    return await invoke<boolean>('check_agy_installed');
  } catch {
    return false;
  }
}

export const getAgyRuntimeStatus = () =>
  invoke<AgyRuntimeStatus>('get_agy_runtime_status');

export const setAgyCustomPath = (path: string | null) =>
  invoke<AgyRuntimeStatus>('set_agy_custom_path', { path });

export const loginAgyAccount = () =>
  invoke<void>('login_agent_profile', { provider: 'agy' });

export const listAgyModels = (forceRefresh = false) =>
  invoke<AgyModelCatalogResponse>('list_agy_models', { forceRefresh });
