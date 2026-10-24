import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowRight, Clock, Flame, Radio } from '@/lib/lucide-react';
import { shallow } from 'zustand/shallow';
import { useAppStore } from '@/store';
import { useLocale } from '@/locales';
import { cn } from '@/lib/utils';
import { calculateContinuousUsageDays } from '@/lib/streak';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { UsageStats } from '@/types/analytics';
import { StreakUsagePopoverContent } from './StreakUsagePopover';

const RUNNING_COLOR = 'hsl(142 71% 45%)';
const STREAK_COLOR = 'hsl(25 95% 53%)';

/**
 * Global status (running sessions, cron, usage streak) as ONE capsule.
 * Clicking opens a summary instead of jumping away from the workspace;
 * the rows inside are the explicit "go to page" actions.
 */
export function WorkspaceStatusCapsule({
  onNavigate,
  compact = false,
}: {
  onNavigate: (tab: string) => void;
  compact?: boolean;
}) {
  const { t } = useLocale();
  const { sessions, cronTasks, continuousUsageDays, usageStats, setUsageStats, setContinuousUsageDays } = useAppStore(
    (state) => ({
      sessions: state.sessions,
      cronTasks: state.cronTasks,
      continuousUsageDays: state.continuousUsageDays,
      usageStats: state.usageStats,
      setUsageStats: state.setUsageStats,
      setContinuousUsageDays: state.setContinuousUsageDays,
    }),
    shallow,
  );
  const [open, setOpen] = useState(false);

  // Refresh usage on open so the streak summary reflects the latest data.
  const refreshUsage = useCallback(async () => {
    try {
      const stats = await invoke<UsageStats>('get_usage_stats');
      if (stats) {
        setUsageStats(stats);
        setContinuousUsageDays(calculateContinuousUsageDays(stats.dailyHistory));
      }
    } catch (err) {
      console.debug('Failed to refresh streak usage:', err);
    }
  }, [setUsageStats, setContinuousUsageDays]);

  const runningCount = sessions.filter((s) => s.status === 'running').length;
  const cronCount = cronTasks.filter((task) => task.enabled !== false).length;
  const showStreak = continuousUsageDays > 0 && Boolean(usageStats);
  const runningLabel = runningCount > 0
    ? `${runningCount} ${t('workspace.statusRunning')}`
    : t('workspace.statusIdle');

  const go = (tab: string) => {
    setOpen(false);
    onNavigate(tab);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void refreshUsage();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-ccem-workspace-status-capsule="true"
          className={cn(
            'group relative inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded-full status-chip-glass',
            'hover:scale-[1.02] active:scale-[0.98]',
            compact ? 'h-8 gap-1 px-2' : 'gap-1.5 px-2.5 py-1 sm:gap-2 sm:px-3.5 sm:py-1.5',
            open && 'ring-1 ring-inset ring-primary/40',
          )}
        >
          <span className="relative flex h-3.5 w-3.5 items-center justify-center">
            <Radio
              className="h-3.5 w-3.5"
              style={runningCount > 0 ? { color: RUNNING_COLOR } : undefined}
            />
            {runningCount > 0 && (
              <span
                className="absolute inset-0 animate-ping rounded-full opacity-40"
                style={{ backgroundColor: RUNNING_COLOR }}
              />
            )}
          </span>
          <span className={cn('text-[12px] font-medium text-foreground', !compact && 'sm:text-[13px]')}>
            {runningLabel}
          </span>
          {showStreak && !compact && (
            <>
              <span className="h-3 w-px bg-foreground/15" aria-hidden="true" />
              <Flame className="h-3.5 w-3.5" style={{ color: STREAK_COLOR }} />
              <span className="text-[12px] font-medium tabular-nums text-foreground sm:text-[13px]">
                {continuousUsageDays}
              </span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[360px] overflow-hidden rounded-xl border border-[hsl(var(--glass-border-light))] bg-popover p-0 shadow-lg"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-0.5 p-1.5">
          <StatusRow
            icon={<Radio className="h-3.5 w-3.5" style={runningCount > 0 ? { color: RUNNING_COLOR } : undefined} />}
            label={runningLabel}
            onClick={() => go('sessions')}
          />
          {cronCount > 0 && (
            <StatusRow
              icon={<Clock className="h-3.5 w-3.5 text-muted-foreground" />}
              label={`${cronCount} ${t('workspace.statusCronActive')}`}
              onClick={() => go('cron')}
            />
          )}
        </div>
        {showStreak && usageStats && (
          <div className="border-t border-[hsl(var(--glass-border-light))]">
            <StreakUsagePopoverContent
              usageStats={usageStats}
              continuousUsageDays={continuousUsageDays}
              onNavigateAnalytics={() => go('analytics')}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function StatusRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-foreground glass-dropdown-item hover:bg-foreground/[0.05]"
    >
      {icon}
      <span className="flex-1">{label}</span>
      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
