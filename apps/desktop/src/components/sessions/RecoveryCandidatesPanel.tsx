import { useCallback, useEffect, useState, useTransition, type ReactNode } from 'react';
import { History, RefreshCw, RotateCcw, X } from '@/lib/lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { LaunchButton } from '@/components/ui/LaunchButton';
import { Card } from '@/components/ui/card';
import { formatRemoteSourceHint, getRemotePlatformFromSource, getRemotePlatformMeta } from '@/lib/remote-platforms';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import type { RuntimeRecoveryCandidate } from '@/lib/tauri-ipc';

function formatTimestamp(value: string) {
  try {
    return new Date(value).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

function summarizeProject(path: string) {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || path;
}

function sourceLabel(candidate: RuntimeRecoveryCandidate) {
  const remotePlatform = getRemotePlatformFromSource(candidate.source);
  if (remotePlatform) {
    const remoteHint = formatRemoteSourceHint(candidate.source);
    return `${getRemotePlatformMeta(remotePlatform).displayName}${remoteHint ? ` · ${remoteHint}` : ''}`;
  }

  switch (candidate.source.type) {
    case 'cron':
      return `Cron · ${candidate.source.task_id}`;
    default:
      return 'Desktop';
  }
}

function candidatesEqual(left: RuntimeRecoveryCandidate[], right: RuntimeRecoveryCandidate[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((candidate, index) => {
    const other = right[index];
    return other
      && other.runtime_id === candidate.runtime_id
      && other.runtime_kind === candidate.runtime_kind
      && other.claude_session_id === candidate.claude_session_id
      && other.project_dir === candidate.project_dir
      && other.env_name === candidate.env_name
      && other.perm_mode === candidate.perm_mode
      && other.saved_at === candidate.saved_at
      && JSON.stringify(other.source) === JSON.stringify(candidate.source);
  });
}

function MetaPill({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-full border border-black/[0.06] bg-black/[0.03] px-2 py-0.5 text-[11px] text-muted-foreground dark:border-white/[0.08] dark:bg-white/[0.04]',
        className,
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

export function RecoveryCandidatesPanel() {
  const { t } = useLocale();
  const [candidates, setCandidates] = useState<RuntimeRecoveryCandidate[]>([]);
  const [busyRuntimeId, setBusyRuntimeId] = useState<string | null>(null);
  const [isRefreshing, startRefreshTransition] = useTransition();
  const {
    listRuntimeRecoveryCandidates,
    dismissRuntimeRecoveryCandidate,
    createInteractiveSession,
    createHeadlessSession,
  } = useTauriCommands();

  const refreshCandidates = useCallback(async () => {
    const next = await listRuntimeRecoveryCandidates();
    setCandidates((current) => (candidatesEqual(current, next) ? current : next));
    return next;
  }, [listRuntimeRecoveryCandidates]);

  useEffect(() => {
    void refreshCandidates();
  }, [refreshCandidates]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      startRefreshTransition(() => {
        void refreshCandidates();
      });
    }, 9000);

    return () => window.clearInterval(intervalId);
  }, [refreshCandidates]);

  const handleDismiss = useCallback(async (runtimeId: string) => {
    setBusyRuntimeId(runtimeId);
    try {
      await dismissRuntimeRecoveryCandidate(runtimeId);
      await refreshCandidates();
      toast.success(t('sessions.recoveryDismissed'));
    } catch (error) {
      toast.error(t('sessions.recoveryDismissFailed').replace('{error}', String(error)));
    } finally {
      setBusyRuntimeId(null);
    }
  }, [dismissRuntimeRecoveryCandidate, refreshCandidates, t]);

  const handleResume = useCallback(async (candidate: RuntimeRecoveryCandidate) => {
    setBusyRuntimeId(candidate.runtime_id);
    try {
      if (candidate.runtime_kind === 'interactive') {
        await createInteractiveSession({
          envName: candidate.env_name,
          permMode: candidate.perm_mode,
          workingDir: candidate.project_dir,
          resumeSessionId: candidate.claude_session_id,
          client: 'claude',
        });
      } else {
        await createHeadlessSession({
          envName: candidate.env_name,
          permMode: candidate.perm_mode,
          workingDir: candidate.project_dir,
          resumeSessionId: candidate.claude_session_id,
        });
      }
      await refreshCandidates();
      toast.success(t('sessions.recoveryResumed'));
    } catch (error) {
      toast.error(t('sessions.recoveryResumeFailed').replace('{error}', String(error)));
    } finally {
      setBusyRuntimeId(null);
    }
  }, [createHeadlessSession, createInteractiveSession, refreshCandidates, t]);

  if (candidates.length === 0) {
    return null;
  }

  return (
    <Card className="p-3 sm:p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">{t('sessions.recoveryTitle')}</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t('sessions.recoverySubtitle').replace('{count}', String(candidates.length))}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="glass-btn-outline h-7 w-7 px-0"
          onClick={() => {
            startRefreshTransition(() => {
              void refreshCandidates();
            });
          }}
        >
          <RefreshCw className={cn('w-3.5 h-3.5', isRefreshing && 'animate-spin')} />
        </Button>
      </div>

      <div className="space-y-2">
        {candidates.map((candidate) => {
          const isBusy = busyRuntimeId === candidate.runtime_id;
          const isInteractive = candidate.runtime_kind === 'interactive';
          return (
            <div
              key={candidate.runtime_id}
              className="rounded-xl border border-black/[0.06] bg-black/[0.02] p-3 text-left dark:border-white/[0.08] dark:bg-white/[0.03]"
            >
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span
                          className="truncate text-sm font-semibold text-foreground"
                          title={candidate.project_dir}
                        >
                          {summarizeProject(candidate.project_dir)}
                        </span>
                        <span className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
                          isInteractive ? 'bg-primary/10 text-primary' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
                        )}>
                          {isInteractive ? t('sessions.recoveryKindInteractive') : t('sessions.recoveryKindHeadless')}
                        </span>
                      </div>
                      <p
                        className="truncate font-mono text-[11px] text-muted-foreground"
                        title={candidate.project_dir}
                      >
                        {candidate.project_dir}
                      </p>
                    </div>
                    <History className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    <MetaPill>{candidate.env_name}</MetaPill>
                    <MetaPill>{candidate.perm_mode}</MetaPill>
                    <MetaPill className="max-w-full sm:max-w-[240px]">{sourceLabel(candidate)}</MetaPill>
                    <MetaPill>{formatTimestamp(candidate.saved_at)}</MetaPill>
                  </div>

                  <div className="rounded-lg border border-black/[0.05] bg-background/70 px-2.5 py-1.5 dark:border-white/[0.08]">
                    <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                      {t('sessions.recoverySessionId')}
                    </p>
                    <p
                      className="mt-0.5 truncate font-mono text-[11px] text-foreground"
                      title={candidate.claude_session_id}
                    >
                      {candidate.claude_session_id}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap justify-end gap-2 lg:shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="glass-btn-outline h-8 px-2.5 text-[11px]"
                    disabled={isBusy}
                    onClick={() => void handleDismiss(candidate.runtime_id)}
                  >
                    <X className="w-3.5 h-3.5" />
                    {t('sessions.recoveryDismiss')}
                  </Button>
                  <LaunchButton
                    onClick={() => void handleResume(candidate)}
                    disabled={isBusy}
                    size="sm"
                    className="h-8 px-2.5 text-[11px]"
                    icon={<RotateCcw className="w-3.5 h-3.5" />}
                  >
                    {isInteractive ? t("sessions.recoveryResumeInteractive") : t("sessions.recoveryResumeHeadless")}
                  </LaunchButton>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
