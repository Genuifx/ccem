import { useCallback } from 'react';
import { toast } from 'sonner';
import type { ArrangeLayout, Session } from '@/store';
import type { TmuxAttachTerminalType } from '@/lib/tauri-ipc';
import {
  launchMultipleInteractiveSessions,
  retryInteractiveSessionTerminals,
} from '@/lib/interactiveSessionLaunch';

interface UseMultiSessionTerminalLaunchOptions {
  isLaunching: boolean;
  setIsLaunching: (isLaunching: boolean) => void;
  launchSession: (workingDir: string) => Promise<Session>;
  openSessionInTerminal: (
    sessionId: string,
    terminalType?: TmuxAttachTerminalType,
    options?: { notifyOnError?: boolean },
  ) => Promise<void>;
  arrangeSessions: (
    sessionIds: string[],
    layout: ArrangeLayout,
  ) => Promise<unknown>;
  t: (key: string) => string;
}

export function useMultiSessionTerminalLaunch({
  isLaunching,
  setIsLaunching,
  launchSession,
  openSessionInTerminal,
  arrangeSessions,
  t,
}: UseMultiSessionTerminalLaunchOptions) {
  return useCallback(async (workingDirs: string[], layout: ArrangeLayout) => {
    if (workingDirs.length === 0 || isLaunching) {
      return;
    }

    setIsLaunching(true);
    try {
      const result = await launchMultipleInteractiveSessions({
        workingDirs,
        layout,
        launchSession,
        arrangeSessions,
      });

      result.launchFailures.forEach(({ workingDir, error }) => {
        console.error(`Failed to launch session for ${workingDir}:`, error);
      });
      if (result.arrangementError) {
        console.error(
          'Failed to arrange launched terminal sessions:',
          result.arrangementError,
        );
      }

      if (result.terminalOpenFailures.length > 0) {
        const retrySessionIds = result.terminalOpenFailures.map(
          ({ sessionId }) => sessionId,
        );
        toast.error(
          t('sessions.multiLaunchTerminalPartial')
            .replace('{created}', String(result.createdCount))
            .replace('{opened}', String(result.openedCount))
            .replace('{total}', String(result.requestedCount)),
          {
            action: {
              label: t('common.retry'),
              onClick: () => {
                void retryInteractiveSessionTerminals(
                  retrySessionIds,
                  (sessionId) => openSessionInTerminal(
                    sessionId,
                    undefined,
                    { notifyOnError: false },
                  ),
                ).then((retry) => {
                  if (retry.openedCount === retry.requestedCount) {
                    toast.success(
                      t('sessions.multiLaunchTerminalRetrySuccess').replace(
                        '{count}',
                        String(retry.openedCount),
                      ),
                    );
                  } else if (retry.openedCount > 0) {
                    toast.error(
                      t('sessions.multiLaunchTerminalRetryPartial')
                        .replace('{opened}', String(retry.openedCount))
                        .replace('{total}', String(retry.requestedCount)),
                    );
                  } else {
                    toast.error(t('sessions.multiLaunchTerminalRetryFailed'));
                  }
                });
              },
            },
          },
        );
      } else if (result.arrangementError) {
        toast.error(
          t('sessions.multiLaunchArrangeFailed').replace(
            '{count}',
            String(result.openedCount),
          ),
        );
      } else if (
        result.openedCount === result.requestedCount
        && result.openedCount >= 2
        && result.arranged
      ) {
        toast.success(
          t('sessions.multiLaunchSuccess').replace(
            '{count}',
            String(result.openedCount),
          ),
        );
      } else if (result.openedCount > 0) {
        toast.success(
          t('sessions.multiLaunchPartial')
            .replace('{success}', String(result.openedCount))
            .replace('{total}', String(result.requestedCount)),
        );
      }
    } finally {
      setIsLaunching(false);
    }
  }, [
    arrangeSessions,
    isLaunching,
    launchSession,
    openSessionInTerminal,
    setIsLaunching,
    t,
  ]);
}
