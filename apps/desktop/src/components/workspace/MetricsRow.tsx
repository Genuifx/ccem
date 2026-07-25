import { Zap, DollarSign, Flame, Timer, Activity } from '@/lib/lucide-react';
import { MetricCard } from './MetricCard';
import { HeroMetricCard } from './HeroMetricCard';
import { useAppStore } from '@/store';
import { useLocale } from '@/locales';
import { shallow } from 'zustand/shallow';

interface MetricsRowProps {
  onNavigate: (tab: string) => void;
}

export function MetricsRow({ onNavigate }: MetricsRowProps) {
  const { t } = useLocale();
  const { sessions, usageStats, continuousUsageDays, cronTasks } = useAppStore(
    (state) => ({
      sessions: state.sessions,
      usageStats: state.usageStats,
      continuousUsageDays: state.continuousUsageDays,
      cronTasks: state.cronTasks,
    }),
    shallow
  );

  const activeSessions = sessions.filter(s => s.status === 'running').length;
  const todayTokens = (usageStats?.today.inputTokens ?? 0) + (usageStats?.today.outputTokens ?? 0) + (usageStats?.today.cacheReadTokens ?? 0) + (usageStats?.today.cacheCreationTokens ?? 0);
  const todayCost = usageStats?.today.cost ?? 0;
  const weekTokens = (usageStats?.week.inputTokens ?? 0) + (usageStats?.week.outputTokens ?? 0) + (usageStats?.week.cacheReadTokens ?? 0) + (usageStats?.week.cacheCreationTokens ?? 0);
  const weekCost = usageStats?.week.cost ?? 0;

  const enabledTasks = cronTasks.filter(t => t.enabled);
  const hasCron = enabledTasks.length > 0;

  return (
    <div className="flex flex-col gap-2.5">
      {/* Hero card — Today's usage */}
      <HeroMetricCard
        icon={Activity}
        label={t('workspace.todayTokens')}
        value={todayTokens}
        formatValue={(v) => v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v)}
        sublabel={`${t('workspace.todayCost')}: $${todayCost.toFixed(2)}`}
        trend={weekTokens > 0 ? `${(todayTokens / (weekTokens / 7) * 100 - 100).toFixed(0)}% vs avg` : undefined}
        onClick={() => onNavigate('analytics')}
      />

      {/* 2x2 compact grid */}
      <div className="grid grid-cols-2 gap-2">
        <MetricCard
          icon={Zap}
          iconColor="text-primary"
          label={t('workspace.runningSessions')}
          value={activeSessions}
          formatValue={(v) => String(v)}
          sublabel={`${sessions.length} ${t('workspace.totalSessions')}`}
          onClick={() => onNavigate('sessions')}
        />
        <MetricCard
          icon={Flame}
          iconColor="text-chart-6"
          label={t('workspace.streak')}
          value={continuousUsageDays}
          formatValue={(v) => `${v}`}
          sublabel={t('workspace.streakDays')}
          sublabelColor={continuousUsageDays >= 7 ? 'text-success' : undefined}
          onClick={() => onNavigate('analytics')}
        />
        <MetricCard
          icon={Timer}
          iconColor="text-info"
          label={t('workspace.cronStatus')}
          value={hasCron ? enabledTasks.length : 0}
          formatValue={(v) => hasCron ? `${v}` : '—'}
          sublabel={hasCron ? t('workspace.cronAllGood') : t('workspace.cronNotConfigured')}
          onClick={() => onNavigate('cron')}
        />
        <MetricCard
          icon={DollarSign}
          iconColor="text-warning"
          label={t('workspace.weekTotal')}
          value={Math.round(weekCost * 100)}
          formatValue={(v) => `$${(v / 100).toFixed(2)}`}
          sublabel={weekTokens > 0 ? `${weekTokens >= 1000000 ? `${(weekTokens / 1000000).toFixed(1)}M` : `${(weekTokens / 1000).toFixed(0)}K`} tokens` : undefined}
          onClick={() => onNavigate('analytics')}
        />
      </div>
    </div>
  );
}
