import type { AppUpdateMetadata } from '@/lib/tauri-ipc';

const RELEASE_URL_PREFIX = 'https://github.com/Genuifx/ccem/releases/tag/v';

export type AppUpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
export type AppUpdateIndicatorTone = 'hidden' | 'available' | 'downloading' | 'ready' | 'error';
export type AppUpdateIndicatorAction = 'none' | 'download' | 'restart' | 'retry';

export interface AppUpdateProgress {
  downloaded: number;
  total: number | null;
  percent: number | null;
}

export interface AppUpdateProgressEvent {
  phase: 'download-started' | 'download-progress' | 'download-finished' | 'installed';
  version: string;
  downloaded: number;
  total: number | null;
}

export interface AppUpdateState {
  status: AppUpdateStatus;
  updateInfo: AppUpdateMetadata | null;
  progress: AppUpdateProgress | null;
  error: string | null;
}

export type AppUpdateAction =
  | { type: 'check-start' }
  | { type: 'check-result'; updateInfo: AppUpdateMetadata | null }
  | { type: 'check-error'; error: string; expose?: boolean }
  | { type: 'download-start' }
  | { type: 'download-error'; error: string }
  | { type: 'download-ready' }
  | { type: 'progress'; event: AppUpdateProgressEvent };

export interface UpdateIndicatorModel {
  visible: boolean;
  tone: AppUpdateIndicatorTone;
  action: AppUpdateIndicatorAction;
  titleKey: string;
  descriptionKey: string | null;
  percent: number | null;
}

export const initialAppUpdateState: AppUpdateState = {
  status: 'idle',
  updateInfo: null,
  progress: null,
  error: null,
};

export function reduceUpdateState(state: AppUpdateState, action: AppUpdateAction): AppUpdateState {
  switch (action.type) {
    case 'check-start':
      return {
        ...state,
        status: 'checking',
        error: null,
      };
    case 'check-result':
      return action.updateInfo
        ? {
          status: 'available',
          updateInfo: action.updateInfo,
          progress: null,
          error: null,
        }
        : initialAppUpdateState;
    case 'check-error':
      return {
        ...state,
        status: action.expose ? 'error' : 'idle',
        error: action.expose ? action.error : null,
      };
    case 'download-start':
      return {
        ...state,
        status: 'downloading',
        progress: normalizeProgress({ downloaded: 0, total: null }),
        error: null,
      };
    case 'download-error':
      return {
        ...state,
        status: 'error',
        error: action.error,
      };
    case 'download-ready':
      return {
        ...state,
        status: 'ready',
        progress: normalizeProgress({
          downloaded: state.progress?.downloaded ?? 0,
          total: state.progress?.total ?? state.progress?.downloaded ?? null,
        }),
        error: null,
      };
    case 'progress':
      return applyProgressEvent(state, action.event);
    default:
      return state;
  }
}

export function deriveUpdateIndicatorModel(state: AppUpdateState): UpdateIndicatorModel {
  if (state.status === 'available' && state.updateInfo) {
    return {
      visible: true,
      tone: 'available',
      action: 'download',
      titleKey: 'settings.updateAvailable',
      descriptionKey: 'settings.updateGlobalDownloadHint',
      percent: null,
    };
  }

  if (state.status === 'downloading' && state.updateInfo) {
    return {
      visible: true,
      tone: 'downloading',
      action: 'none',
      titleKey: 'settings.updateDownloading',
      descriptionKey: 'settings.updateGlobalDownloadingHint',
      percent: state.progress?.percent ?? null,
    };
  }

  if (state.status === 'ready' && state.updateInfo) {
    return {
      visible: true,
      tone: 'ready',
      action: 'restart',
      titleKey: 'settings.restartToUpdate',
      descriptionKey: 'settings.updateGlobalRestartHint',
      percent: state.progress?.percent ?? null,
    };
  }

  if (state.status === 'error' && state.updateInfo) {
    return {
      visible: true,
      tone: 'error',
      action: 'retry',
      titleKey: 'settings.updateInstallFailedShort',
      descriptionKey: 'settings.updateGlobalRetryHint',
      percent: state.progress?.percent ?? null,
    };
  }

  return {
    visible: false,
    tone: 'hidden',
    action: 'none',
    titleKey: 'settings.checkUpdate',
    descriptionKey: null,
    percent: null,
  };
}

function applyProgressEvent(state: AppUpdateState, event: AppUpdateProgressEvent): AppUpdateState {
  const progress = normalizeProgress({
    downloaded: event.downloaded,
    total: event.total,
  });
  const updateInfo = state.updateInfo ?? updateInfoFromProgressEvent(event);

  if (event.phase === 'installed') {
    return {
      ...state,
      status: 'ready',
      updateInfo,
      progress,
      error: null,
    };
  }

  return {
    ...state,
    status: 'downloading',
    updateInfo,
    progress,
    error: null,
  };
}

function updateInfoFromProgressEvent(event: AppUpdateProgressEvent): AppUpdateMetadata {
  const version = event.version || 'unknown';
  const releaseVersion = version.trim().replace(/^v/i, '');

  return {
    version,
    currentVersion: '',
    channel: releaseVersion.includes('-') ? 'beta' : 'stable',
    releaseTag: `v${releaseVersion}`,
    releaseUrl: `${RELEASE_URL_PREFIX}${releaseVersion}`,
    date: null,
    body: null,
  };
}

function normalizeProgress(input: { downloaded: number; total: number | null }): AppUpdateProgress {
  const downloaded = Math.max(0, Math.round(Number.isFinite(input.downloaded) ? input.downloaded : 0));
  const total = input.total !== null && Number.isFinite(input.total) && input.total > 0
    ? Math.round(input.total)
    : null;
  const percent = total ? Math.min(100, Math.max(0, Math.round((downloaded / total) * 100))) : null;

  return { downloaded, total, percent };
}
