import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { LoaderCircle, ShieldAlert } from '@/lib/lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useTauriEvent } from '@/hooks/useTauriEvents';
import { useLocale } from '@/locales';
import type { NativeSessionSummary } from '@/lib/tauri-ipc';

type DestructiveAppAction = 'quit' | 'restart';

interface NativeBackgroundTaskAppGuardValue {
  requestQuit: () => Promise<void>;
  requestRestart: () => Promise<void>;
}

const NativeBackgroundTaskAppGuardContext =
  createContext<NativeBackgroundTaskAppGuardValue | null>(null);

async function activeClaudeBackgroundTaskCount() {
  const sessions = await invoke<NativeSessionSummary[]>('list_native_sessions');
  return sessions.reduce((count, session) => (
    session.provider === 'claude'
      ? count + (session.background_tasks?.length ?? 0)
      : count
  ), 0);
}

export function NativeBackgroundTaskAppGuardProvider({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const [pendingAction, setPendingAction] = useState<DestructiveAppAction | null>(null);
  const [taskCount, setTaskCount] = useState(0);
  const [isApplying, setIsApplying] = useState(false);

  const execute = useCallback(async (action: DestructiveAppAction, force: boolean) => {
    await invoke(action === 'quit' ? 'quit_app' : 'restart_app', { force });
  }, []);

  const request = useCallback(async (action: DestructiveAppAction) => {
    try {
      const count = await activeClaudeBackgroundTaskCount();
      if (count > 0) {
        setTaskCount(count);
        setPendingAction(action);
        return;
      }
      await execute(action, false);
    } catch {
      const count = await activeClaudeBackgroundTaskCount().catch(() => 0);
      setTaskCount(count);
      setPendingAction(action);
    }
  }, [execute]);

  useTauriEvent<string>('native-background-task-app-action', (action) => {
    if (action === 'quit' || action === 'restart') {
      void request(action);
    }
  });

  const confirm = useCallback(async () => {
    if (!pendingAction || isApplying) return;
    setIsApplying(true);
    try {
      await execute(pendingAction, true);
      setPendingAction(null);
    } catch (error) {
      toast.error(t('workspace.backgroundTasksAppActionFailed').replace('{error}', String(error)));
    } finally {
      setIsApplying(false);
    }
  }, [execute, isApplying, pendingAction, t]);

  const value = useMemo<NativeBackgroundTaskAppGuardValue>(() => ({
    requestQuit: () => request('quit'),
    requestRestart: () => request('restart'),
  }), [request]);

  return (
    <NativeBackgroundTaskAppGuardContext.Provider value={value}>
      {children}
      <Dialog
        open={Boolean(pendingAction)}
        onOpenChange={(open) => {
          if (!open && !isApplying) setPendingAction(null);
        }}
      >
        <DialogContent
          data-ccem-background-task-app-guard
          className="frosted-panel glass-noise max-w-[440px] border-none p-5"
        >
          <DialogHeader>
            <DialogTitle>
              {t(taskCount > 0
                ? 'workspace.backgroundTasksRestartWarningTitle'
                : 'workspace.nativeRuntimeUnsafeActionWarningTitle')}
            </DialogTitle>
            <DialogDescription>
              {t(
                taskCount > 0
                  ? pendingAction === 'restart'
                    ? 'workspace.backgroundTasksAppRestartWarningBody'
                    : 'workspace.backgroundTasksAppQuitWarningBody'
                  : pendingAction === 'restart'
                    ? 'workspace.nativeRuntimeAppRestartWarningBody'
                    : 'workspace.nativeRuntimeAppQuitWarningBody',
                { count: taskCount },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="glass-btn-outline"
              disabled={isApplying}
              onClick={() => setPendingAction(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="gap-2"
              disabled={isApplying}
              onClick={() => void confirm()}
            >
              {isApplying ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldAlert className="h-4 w-4" />
              )}
              {t(pendingAction === 'restart'
                ? 'workspace.backgroundTasksRestartAnyway'
                : 'workspace.backgroundTasksQuitAnyway')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </NativeBackgroundTaskAppGuardContext.Provider>
  );
}

export function useNativeBackgroundTaskAppGuard() {
  const value = useContext(NativeBackgroundTaskAppGuardContext);
  if (!value) {
    throw new Error('useNativeBackgroundTaskAppGuard must be used inside its provider');
  }
  return value;
}
