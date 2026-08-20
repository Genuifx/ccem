import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useTauriEvent } from '@/hooks/useTauriEvents';
import { scheduleAfterFirstPaint } from '@/lib/idle';
import { useLocale } from '@/locales';
import type { AppUpdateMetadata } from '@/lib/tauri-ipc';
import {
  initialAppUpdateState,
  reduceUpdateState,
  type AppUpdateProgressEvent,
} from './appUpdateState';
import {
  AppUpdateContext,
  type AppUpdateContextValue,
  type CheckForUpdateOptions,
} from './appUpdateContext';
import { useNativeBackgroundTaskAppGuard } from '@/components/NativeBackgroundTaskAppGuard';

function formatMessage(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce(
    (message, [key, value]) => message.split(`{${key}}`).join(value),
    template
  );
}

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const { requestRestart } = useNativeBackgroundTaskAppGuard();
  const [state, dispatch] = useReducer(reduceUpdateState, initialAppUpdateState);
  const stateRef = useRef(state);
  const autoCheckStartedRef = useRef(false);
  const downloadInFlightRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useTauriEvent<AppUpdateProgressEvent>('app-update-progress', (event) => {
    dispatch({ type: 'progress', event });
  });

  const restartForUpdate = useCallback(async () => {
    await requestRestart();
  }, [requestRestart]);

  const checkForUpdate = useCallback(async (options: CheckForUpdateOptions = {}) => {
    dispatch({ type: 'check-start' });

    try {
      const updateInfo = await invoke<AppUpdateMetadata | null>('check_app_update');
      dispatch({ type: 'check-result', updateInfo });

      if (!options.silent) {
        if (updateInfo) {
          toast.success(formatMessage(t('settings.updateAvailableToast'), {
            version: updateInfo.version,
          }));
        } else {
          toast.info(t('settings.upToDate'));
        }
      }

      return updateInfo;
    } catch (error) {
      const message = String(error);
      dispatch({ type: 'check-error', error: message, expose: !options.silent });
      if (!options.silent) {
        toast.error(formatMessage(t('settings.updateCheckFailed'), { error: message }));
      }
      return null;
    }
  }, [t]);

  const downloadUpdate = useCallback(async () => {
    if (downloadInFlightRef.current) {
      return;
    }

    downloadInFlightRef.current = true;
    if (stateRef.current.status === 'error' || !stateRef.current.updateInfo) {
      const refreshed = await checkForUpdate({ silent: true });
      if (!refreshed) {
        downloadInFlightRef.current = false;
        return;
      }
    }

    dispatch({ type: 'download-start' });
    toast.info(t('settings.updateDownloadStarted'));

    try {
      await invoke('install_app_update');
      dispatch({ type: 'download-ready' });
      toast.success(t('settings.updateReadyToast'), {
        action: {
          label: t('settings.restartToUpdate'),
          onClick: () => { void restartForUpdate(); },
        },
      });
    } catch (error) {
      const message = String(error);
      dispatch({ type: 'download-error', error: message });
      toast.error(formatMessage(t('settings.updateInstallFailed'), { error: message }));
    } finally {
      downloadInFlightRef.current = false;
    }
  }, [checkForUpdate, restartForUpdate, t]);

  useEffect(() => {
    if (autoCheckStartedRef.current) {
      return;
    }

    autoCheckStartedRef.current = true;
    const cancel = scheduleAfterFirstPaint(() => {
      void checkForUpdate({ silent: true });
    }, { delayMs: 1800, timeoutMs: 5000 });

    return cancel;
  }, [checkForUpdate]);

  const value = useMemo<AppUpdateContextValue>(() => ({
    state,
    checkForUpdate,
    downloadUpdate,
    restartForUpdate,
  }), [state, checkForUpdate, downloadUpdate, restartForUpdate]);

  return (
    <AppUpdateContext.Provider value={value}>
      {children}
    </AppUpdateContext.Provider>
  );
}
