import { useEffect, useRef, useState } from 'react';
import { Bot, HeartPulse, LifeBuoy, TerminalSquare, Workflow } from '@/lib/lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { useAppStore } from '@/store';
import { useLocale } from '@/locales';
import { cn } from '@/lib/utils';
import { shallow } from 'zustand/shallow';
import type { PlatformCapabilities } from '@/lib/tauri-ipc';

interface RuntimeOverviewCardProps {
  onNavigate: (tab: string) => void;
}

interface RuntimeSnapshot {
  headlessCount: number;
  recoveryCount: number;
  tmuxSupported: boolean;
  tmuxInstalled: boolean;
  tmuxInstallCommand?: string | null;
  telegramRunning: boolean;
  telegramConfigured: boolean;
  telegramRestricted: boolean;
}

const INITIAL_SNAPSHOT: RuntimeSnapshot = {
  headlessCount: 0,
  recoveryCount: 0,
  tmuxSupported: true,
  tmuxInstalled: true,
  tmuxInstallCommand: null,
  telegramRunning: false,
  telegramConfigured: false,
  telegramRestricted: false,
};

function snapshotsEqual(left: RuntimeSnapshot, right: RuntimeSnapshot) {
  return left.headlessCount === right.headlessCount
    && left.recoveryCount === right.recoveryCount
    && left.tmuxSupported === right.tmuxSupported
    && left.tmuxInstalled === right.tmuxInstalled
    && left.tmuxInstallCommand === right.tmuxInstallCommand
    && left.telegramRunning === right.telegramRunning
    && left.telegramConfigured === right.telegramConfigured
    && left.telegramRestricted === right.telegramRestricted;
}

export function RuntimeOverviewCard({ onNavigate }: RuntimeOverviewCardProps) {
  const { t } = useLocale();
  const { sessions } = useAppStore(
    (state) => ({ sessions: state.sessions }),
    shallow
  );
  const {
    listHeadlessSessions,
    listRuntimeRecoveryCandidates,
    getTelegramBridgeStatus,
    getTelegramSettings,
    getPlatformCapabilities,
  } = useTauriCommands();
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(INITIAL_SNAPSHOT);
  const platformCapabilitiesRef = useRef<PlatformCapabilities | null>(null);
  const telegramRestrictedRef = useRef(INITIAL_SNAPSHOT.telegramRestricted);

  useEffect(() => {
    let cancelled = false;

    const loadSnapshot = async (mode: 'full' | 'runtime' = 'full') => {
      try {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
          return;
        }

        const [headlessSessions, recoveryCandidates, telegramStatus] = await Promise.all([
          listHeadlessSessions(),
          listRuntimeRecoveryCandidates(),
          getTelegramBridgeStatus(),
        ]);

        if (cancelled) {
          return;
        }

        const nextSnapshot: RuntimeSnapshot = {
          headlessCount: headlessSessions.length,
          recoveryCount: recoveryCandidates.length,
          telegramRunning: telegramStatus.running,
          telegramConfigured: telegramStatus.configured,
          tmuxSupported: platformCapabilitiesRef.current?.tmuxSupported ?? INITIAL_SNAPSHOT.tmuxSupported,
          tmuxInstalled: platformCapabilitiesRef.current?.tmuxInstalled ?? INITIAL_SNAPSHOT.tmuxInstalled,
          tmuxInstallCommand: platformCapabilitiesRef.current?.tmuxInstallCommand ?? null,
          telegramRestricted: telegramRestrictedRef.current,
        };

        if (mode === 'full') {
          const [telegramSettings, platformCapabilities] = await Promise.all([
            getTelegramSettings(),
            getPlatformCapabilities(),
          ]);
          if (cancelled) {
            return;
          }

          platformCapabilitiesRef.current = platformCapabilities;
          telegramRestrictedRef.current = (telegramSettings.allowedUserIds?.length ?? 0) > 0;
          nextSnapshot.tmuxSupported = platformCapabilities.tmuxSupported;
          nextSnapshot.tmuxInstalled = platformCapabilities.tmuxInstalled;
          nextSnapshot.tmuxInstallCommand = platformCapabilities.tmuxInstallCommand ?? null;
          nextSnapshot.telegramRestricted = telegramRestrictedRef.current;
        }

        setSnapshot((current) => (snapshotsEqual(current, nextSnapshot) ? current : nextSnapshot));
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load runtime overview:', error);
        }
      }
    };

    void loadSnapshot('full');
    const intervalId = window.setInterval(() => {
      void loadSnapshot('runtime');
    }, 7000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [getPlatformCapabilities, getTelegramBridgeStatus, getTelegramSettings, listHeadlessSessions, listRuntimeRecoveryCandidates]);

  const interactiveCount = sessions.filter((session) => session.status === 'running').length;
  const showTmuxNotice = snapshot.tmuxSupported && !snapshot.tmuxInstalled;
  const needsAttention = showTmuxNotice
    || snapshot.recoveryCount > 0
    || (snapshot.telegramConfigured && !snapshot.telegramRunning)
    || (snapshot.telegramConfigured && !snapshot.telegramRestricted);

  return (
    <Card className={cn(
      'p-5',
      needsAttention && 'border-warning/30'
    )}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Workflow className="h-4 w-4 text-primary" />
            {t('workspace.runtimeOverview')}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('workspace.runtimeOverviewDesc')}
          </p>
        </div>
        <div className={cn(
          'rounded-full px-2.5 py-1 text-[11px] font-medium',
          needsAttention
            ? 'bg-warning/10 text-warning'
            : 'bg-success/10 text-success'
        )}>
          {needsAttention ? t('workspace.runtimeNeedsAttention') : t('workspace.runtimeHealthy')}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <RuntimeStat
          icon={TerminalSquare}
          label={t('workspace.runtimeInteractive')}
          value={interactiveCount}
          highlight={showTmuxNotice}
        />
        <RuntimeStat
          icon={Bot}
          label={t('workspace.runtimeHeadless')}
          value={snapshot.headlessCount}
        />
        <RuntimeStat
          icon={LifeBuoy}
          label={t('workspace.runtimeRecovery')}
          value={snapshot.recoveryCount}
          highlight={snapshot.recoveryCount > 0}
        />
        <RuntimeStat
          icon={HeartPulse}
          label={t('workspace.runtimeTelegram')}
          value={
            snapshot.telegramConfigured
              ? snapshot.telegramRunning
                ? snapshot.telegramRestricted
                  ? t('workspace.telegramOnline')
                  : t('workspace.telegramOpenAccess')
                : t('workspace.telegramOffline')
              : t('workspace.telegramNotReady')
          }
          highlight={
            (snapshot.telegramConfigured && !snapshot.telegramRunning)
            || (snapshot.telegramConfigured && !snapshot.telegramRestricted)
          }
          isText
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" className="glass-btn-outline" size="sm" onClick={() => onNavigate('sessions')}>
          {t('workspace.runtimeOpenSessions')}
        </Button>
        <Button variant="outline" className="glass-btn-outline" size="sm" onClick={() => onNavigate('cron')}>
          {t('workspace.runtimeOpenCron')}
        </Button>
        <Button variant="outline" className="glass-btn-outline" size="sm" onClick={() => onNavigate('chat-app')}>
          {t('workspace.runtimeOpenTelegram')}
        </Button>
      </div>

      {showTmuxNotice && (
        <div className="mt-4 rounded-xl border border-warning/25 bg-warning/8 px-3.5 py-3">
          <p className="text-xs font-medium text-foreground">{t('workspace.tmuxOptionalTitle')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('workspace.tmuxOptionalNotice')}</p>
          {snapshot.tmuxInstallCommand && (
            <p className="mt-2 font-mono text-2xs text-muted-foreground">{snapshot.tmuxInstallCommand}</p>
          )}
        </div>
      )}
    </Card>
  );
}

interface RuntimeStatProps {
  icon: typeof Workflow;
  label: string;
  value: number | string;
  highlight?: boolean;
  isText?: boolean;
}

function RuntimeStat({ icon: Icon, label, value, highlight = false, isText = false }: RuntimeStatProps) {
  return (
    <div className={cn(
      'rounded-xl border border-black/[0.08] bg-black/[0.03] p-3 dark:border-white/[0.08] dark:bg-white/[0.03]',
      highlight && 'border-warning/30'
    )}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className={cn('h-3.5 w-3.5', highlight ? 'text-warning' : 'text-primary')} />
        <span>{label}</span>
      </div>
      <div className={cn(
        'mt-2 font-semibold text-foreground',
        isText ? 'text-sm' : 'text-2xl tabular-nums'
      )}>
        {value}
      </div>
    </div>
  );
}
