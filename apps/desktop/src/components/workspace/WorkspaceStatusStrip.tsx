import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Radio, Flame, Clock, Check, Settings2, ClipboardCheck, Search, Command, PanelRightClose, PanelRightOpen } from '@/lib/lucide-react';
import { useAppStore } from '@/store';
import { useLocale } from '@/locales';
import { getEnvColorVar, cn } from '@/lib/utils';
import { shallow } from 'zustand/shallow';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { ModelIcon } from '@/components/history/ModelIcon';
import { resolveEnvironmentIconHint } from '@/components/workspace/sessionTreeIcons';
import { StreakUsagePopoverContent } from './StreakUsagePopover';
import type { UsageStats } from '@/types/analytics';
import type { Environment } from '@/store';
import { filterRuntimeEnvironments } from '@/lib/enabledEnvironments';
import {
  WORKSPACE_REVIEW_POPOVER_ID,
  workspaceReviewTriggerRef,
} from './workspaceReviewAnchor';

function EnvironmentLobeIcon({
  environment,
  size = 14,
}: {
  environment?: Environment;
  size?: number;
}) {
  return (
    <ModelIcon
      model={resolveEnvironmentIconHint(environment)}
      size={size}
      className="shrink-0"
      disableContrastBg
    />
  );
}

// Walks dailyHistory backwards from today counting consecutive days.
// Matches the boot-time calculation in App.tsx.
function calculateContinuousUsageDays(dailyHistory: UsageStats['dailyHistory']): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  let streak = 0;
  while (true) {
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    if (!dailyHistory[dateKey]) return streak;
    streak += 1;
    date.setDate(date.getDate() - 1);
  }
}

interface WorkspaceStatusStripProps {
  onNavigate: (tab: string) => void;
  onOpenSearch: () => void;
  browserOpen?: boolean;
  onToggleBrowser?: () => void;
  /** Optional env context (e.g. the active history/live session env) to keep visible alongside the global current env. */
  envContext?: string;
}

function StatusChip({
  icon: Icon,
  label,
  color,
  pulse,
  onClick,
  compact = false,
  className,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  label: string;
  color?: string;
  pulse?: boolean;
  onClick?: () => void;
  compact?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative inline-flex shrink-0 items-center whitespace-nowrap rounded-full',
        compact ? 'h-8 gap-1 px-2' : 'gap-1.5 px-2.5 py-1 sm:gap-2 sm:px-3.5 sm:py-1.5',
        'status-chip-glass',
        'hover:scale-[1.02] active:scale-[0.98]',
        onClick && 'cursor-pointer',
        className
      )}
    >
      <span className="relative flex items-center justify-center w-3.5 h-3.5">
        <Icon
          className="w-3.5 h-3.5 transition-transform duration-200 group-hover:scale-110"
          style={color ? { color } : undefined}
        />
        {pulse && (
          <>
            <span
              className="absolute inset-0 rounded-full animate-ping opacity-40"
              style={{ backgroundColor: color || 'hsl(142 71% 45%)' }}
            />
            <span
              className="absolute inset-[-2px] rounded-full opacity-20 animate-pulse"
              style={{ backgroundColor: color || 'hsl(142 71% 45%)' }}
            />
          </>
        )}
      </span>
      <span className={cn(
        'whitespace-nowrap text-[12px] font-medium text-foreground transition-colors group-hover:text-foreground',
        !compact && 'sm:text-[13px]',
      )}>
        {label}
      </span>
    </button>
  );
}

export function WorkspaceStatusStrip({
  onNavigate,
  onOpenSearch,
  browserOpen = false,
  onToggleBrowser,
  envContext,
}: WorkspaceStatusStripProps) {
  const { t } = useLocale();
  const { sessions, currentEnv, environments, enabledEnvironments, continuousUsageDays, cronTasks, usageStats } = useAppStore(
    (state) => ({
      sessions: state.sessions,
      currentEnv: state.currentEnv,
      environments: state.environments,
      enabledEnvironments: state.enabledEnvironments,
      continuousUsageDays: state.continuousUsageDays,
      cronTasks: state.cronTasks,
      usageStats: state.usageStats,
    }),
    shallow
  );
  const statusStripCurrentEnvs = envContext
    ? [currentEnv, envContext].filter((name): name is string => Boolean(name))
    : currentEnv;
  const runtimeEnvironments = filterRuntimeEnvironments(environments, enabledEnvironments, {
    currentEnv: statusStripCurrentEnvs.length > 0 ? statusStripCurrentEnvs : null,
  });
  const [streakPopoverOpen, setStreakPopoverOpen] = useState(false);
  const [isRefreshingStreak, setIsRefreshingStreak] = useState(false);
  const { reviewEntry, reviewPanelOpen, setReviewPanelOpen } = useAppStore(
    (state) => ({
      reviewEntry: state.reviewEntry,
      reviewPanelOpen: state.reviewPanelOpen,
      setReviewPanelOpen: state.setReviewPanelOpen,
    }),
    shallow
  );
  const { setUsageStats, setContinuousUsageDays } = useAppStore(
    (state) => ({
      setUsageStats: state.setUsageStats,
      setContinuousUsageDays: state.setContinuousUsageDays,
    }),
    shallow
  );
  const { switchEnvironment } = useTauriCommands();

  // Actively refresh usage stats from the backend so the streak popover
  // reflects the latest data each time it's opened.
  const refreshStreakUsage = useCallback(async () => {
    setIsRefreshingStreak(true);
    try {
      const stats = await invoke<UsageStats>('get_usage_stats');
      if (stats) {
        setUsageStats(stats);
        setContinuousUsageDays(calculateContinuousUsageDays(stats.dailyHistory));
      }
    } catch (err) {
      console.debug('Failed to refresh streak usage:', err);
    } finally {
      setIsRefreshingStreak(false);
    }
  }, [setUsageStats, setContinuousUsageDays]);

  const runningSessions = sessions.filter((s) => s.status === 'running');
  const activeCronTasks = cronTasks.filter((t) => t.enabled !== false);
  const currentEnvironment = environments.find((env) => env.name === currentEnv);

  return (
    <div
      data-tauri-drag-region
      data-ccem-workspace-status-compact={browserOpen ? 'browser' : 'default'}
      className={cn(
        'workspace-status-strip flex shrink-0 items-center min-w-0 overflow-x-auto scroll-glass-root [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        browserOpen ? 'h-10 gap-1 pr-1' : 'h-11 gap-1.5 sm:h-12 sm:gap-2.5',
      )}
    >
      <StatusChip
        icon={Radio}
        label={
          runningSessions.length > 0
            ? `${runningSessions.length} ${t('workspace.statusRunning')}`
            : t('workspace.statusIdle')
        }
        color={runningSessions.length > 0 ? 'hsl(142 71% 45%)' : undefined}
        pulse={runningSessions.length > 0}
        onClick={() => onNavigate('sessions')}
        compact={browserOpen}
      />

      {/* Environment quick-switch capsule — icon language matches composer env picker */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={currentEnv || '—'}
            className={cn(
              'group relative inline-flex shrink-0 items-center whitespace-nowrap rounded-full',
              browserOpen ? 'h-8 gap-1 px-2' : 'gap-1.5 px-2.5 py-1 sm:gap-2 sm:px-3.5 sm:py-1.5',
              'status-chip-glass',
              'hover:scale-[1.02] active:scale-[0.98]',
              'cursor-pointer'
            )}
          >
            <span className="relative flex items-center justify-center">
              <EnvironmentLobeIcon environment={currentEnvironment} size={14} />
            </span>
            <span className={cn(
              'max-w-[8.5rem] truncate whitespace-nowrap text-[12px] font-medium text-foreground transition-colors',
              !browserOpen && 'sm:max-w-[10rem] sm:text-[13px]',
            )}>
              {currentEnv || '—'}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[220px] p-0">
          <div className="px-3 pt-2.5 pb-1 text-2xs uppercase tracking-wider font-medium text-muted-foreground/70">
            {t('workspace.environmentLabel')}
          </div>
          <div className={cn('p-1.5 pt-0', runtimeEnvironments.length > 6 && 'max-h-[200px] overflow-y-auto')}>
            {runtimeEnvironments.map((env) => {
              const isActive = env.name === currentEnv;
              return (
                <DropdownMenuItem
                  key={env.name}
                  className={cn(
                    'gap-2 rounded-lg px-3 py-2 glass-dropdown-item',
                    isActive && 'text-primary',
                  )}
                  onSelect={() => {
                    if (!isActive) void switchEnvironment(env.name);
                  }}
                >
                  <EnvironmentLobeIcon environment={env} size={13} />
                  <span className="flex-1 text-left text-sm">{env.name}</span>
                  {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                </DropdownMenuItem>
              );
            })}
          </div>
          {environments.length > 0 && <DropdownMenuSeparator className="mx-1.5" />}
          <DropdownMenuItem
            className="mx-1.5 mb-1.5 gap-2 rounded-lg px-3 py-2 text-muted-foreground glass-dropdown-item"
            onSelect={() => onNavigate('environments')}
          >
            <Settings2 className="h-3.5 w-3.5 shrink-0" />
            <span className="text-sm">{t('workspace.manageEnvs')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {continuousUsageDays > 0 && usageStats && (
        <Popover
          open={streakPopoverOpen}
          onOpenChange={(open) => {
            setStreakPopoverOpen(open);
            if (open) void refreshStreakUsage();
          }}
        >
          <PopoverTrigger asChild>
            <div className={cn(browserOpen ? 'inline-flex' : 'hidden md:inline-flex')}>
              <StatusChip
                icon={Flame}
                label={`${continuousUsageDays} ${t('workspace.statusStreak')}`}
                color="hsl(25 95% 53%)"
                compact={browserOpen}
                className={isRefreshingStreak ? 'opacity-70' : undefined}
              />
            </div>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={6}
            className="w-[360px] p-0 overflow-hidden rounded-xl border border-[hsl(var(--glass-border-light))] bg-popover shadow-lg"
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <StreakUsagePopoverContent
              usageStats={usageStats}
              continuousUsageDays={continuousUsageDays}
              onNavigateAnalytics={() => {
                setStreakPopoverOpen(false);
                onNavigate('analytics');
              }}
            />
          </PopoverContent>
        </Popover>
      )}

      {!browserOpen && activeCronTasks.length > 0 && (
        <StatusChip
          icon={Clock}
          label={`${activeCronTasks.length} ${t('workspace.statusCronActive')}`}
          onClick={() => onNavigate('cron')}
          className="hidden lg:inline-flex"
        />
      )}

      {/* Global search trigger — spotlight-style field, distinct from status chips */}
      <button
        type="button"
        data-ccem-workspace-search-trigger="true"
        title={t('workspace.globalSearchPlaceholder')}
        onClick={onOpenSearch}
        className={cn(
          'group ml-auto inline-flex shrink-0 items-center rounded-full',
          browserOpen
            ? 'h-8 w-8 min-h-[2rem] min-w-[2rem] flex-none justify-center px-0'
            : 'h-7 min-w-[120px] gap-1.5 px-2.5 sm:h-8 sm:min-w-[160px] sm:gap-2 sm:px-3 lg:min-w-[220px]',
          'border border-[hsl(var(--glass-border-light))]/40 bg-muted/25',
          'transition-colors duration-150',
          'hover:border-[hsl(var(--glass-border-light))]/70 hover:bg-muted/40'
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {!browserOpen ? (
          <>
            <span className="hidden flex-1 truncate text-left text-[12px] text-muted-foreground/70 sm:inline">
              {t('workspace.globalSearchPlaceholder')}
            </span>
            <kbd className="hidden shrink-0 items-center gap-0.5 rounded border border-border/30 bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/60 md:inline-flex">
              <Command className="h-2.5 w-2.5" />
              K
            </kbd>
          </>
        ) : null}
      </button>

      {/* Review audit entry — always visible, far-right, context-aware */}
      <button
        ref={workspaceReviewTriggerRef}
        type="button"
        data-ccem-workspace-review-trigger
        aria-haspopup="dialog"
        aria-expanded={reviewPanelOpen}
        aria-controls={reviewPanelOpen ? WORKSPACE_REVIEW_POPOVER_ID : undefined}
        title={t('workspace.reviewEntry')}
        onClick={() => setReviewPanelOpen(!reviewPanelOpen)}
        className={cn(
          'group relative inline-flex shrink-0 items-center whitespace-nowrap rounded-full cursor-pointer',
          browserOpen ? 'h-8 w-8 min-h-[2rem] min-w-[2rem] flex-none justify-center gap-0 px-0' : 'gap-1.5 px-2.5 py-1 sm:gap-2 sm:px-3.5 sm:py-1.5',
          'status-chip-glass',
          'hover:scale-[1.02] active:scale-[0.98]',
          reviewPanelOpen && 'ring-1 ring-inset ring-primary/40'
        )}
      >
        <span className="relative flex items-center justify-center w-3.5 h-3.5">
          <ClipboardCheck
            className={cn(
              'w-3.5 h-3.5 transition-transform duration-200 group-hover:scale-110',
              !reviewEntry && 'text-muted-foreground'
            )}
            style={reviewEntry ? { color: `hsl(${getEnvColorVar(reviewEntry.envName)})` } : undefined}
          />
          {reviewEntry ? (
            <span
              className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-background"
              style={{ backgroundColor: `hsl(${getEnvColorVar(reviewEntry.envName)})` }}
            />
          ) : null}
        </span>
        <span className={cn(
          'whitespace-nowrap text-[12px] font-medium text-foreground transition-colors',
          browserOpen ? 'sr-only' : 'sm:text-[13px]',
        )}>
          {t('workspace.reviewEntry')}
        </span>
        {reviewEntry && reviewEntry.failedTools > 0 ? (
          <span className={cn(
            'inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground',
            browserOpen ? 'absolute -right-1 -top-1' : 'ml-0.5',
          )}>
            {reviewEntry.failedTools}
          </span>
        ) : null}
      </button>

      {onToggleBrowser ? (
        <button
          type="button"
          data-ccem-workspace-browser-toggle="true"
          aria-pressed={browserOpen}
          aria-label={browserOpen ? t('workspace.browserClose') : t('workspace.browserOpen')}
          title={browserOpen ? t('workspace.browserClose') : t('workspace.browserOpen')}
          onClick={onToggleBrowser}
          className={cn(
            'group relative inline-flex h-8 w-8 min-h-[2rem] min-w-[2rem] flex-none items-center justify-center rounded-full p-0 cursor-pointer',
            'status-chip-glass',
            'hover:scale-[1.02] active:scale-[0.98]',
            browserOpen && 'ring-1 ring-inset ring-primary/40'
          )}
        >
          {browserOpen ? (
            <PanelRightClose
              className="h-3.5 w-3.5 shrink-0 text-primary transition-transform duration-200 group-hover:scale-110"
            />
          ) : (
            <PanelRightOpen
              className={cn(
                'h-3.5 w-3.5 shrink-0 transition-transform duration-200 group-hover:scale-110',
                'text-muted-foreground'
              )}
            />
          )}
        </button>
      ) : null}
    </div>
  );
}
