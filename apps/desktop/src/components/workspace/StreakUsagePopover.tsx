import { useMemo } from 'react';
import { Flame, ArrowRight } from '@/lib/lucide-react';
import type { ChartDataPoint, UsageStats } from '@/types/analytics';
import { sumTokens } from '@/components/analytics/poster-types';
import { useLocale } from '@/locales';
import { formatTokens } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { StreakChart } from './StreakChart';

interface StreakUsagePopoverContentProps {
  usageStats: UsageStats;
  continuousUsageDays: number;
  onNavigateAnalytics: () => void;
}

function buildDailyChartData(
  dailyHistory: UsageStats['dailyHistory'],
): ChartDataPoint[] {
  const sorted = Object.entries(dailyHistory).sort(([a], [b]) => a.localeCompare(b));
  return sorted.slice(-7).map(([bucketKey, usage]) => ({
    bucketKey,
    date: bucketKey,
    Tokens: sumTokens(usage),
  }));
}

export function StreakUsagePopoverContent({
  usageStats,
  continuousUsageDays,
  onNavigateAnalytics,
}: StreakUsagePopoverContentProps) {
  const { t } = useLocale();
  const chartData = useMemo(
    () => buildDailyChartData(usageStats.dailyHistory),
    [usageStats.dailyHistory],
  );
  const todayTokens = sumTokens(usageStats.today);
  const todayCost = usageStats.today.cost ?? 0;

  return (
    <div className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Flame className="w-4 h-4" style={{ color: 'hsl(25 95% 53%)' }} />
          <span className="text-[14px] font-semibold tracking-[-0.01em] text-foreground">
            {continuousUsageDays} {t('workspace.streakPopoverTitle')}
          </span>
        </div>
      </div>

      <div className="mt-1 flex items-baseline gap-2 text-[12px] text-muted-foreground tabular-nums">
        <span>
          {t('workspace.streakPopoverToday')}{' '}
          <span className="font-semibold text-foreground">{formatTokens(todayTokens)}</span>
          <span className="ml-0.5 text-muted-foreground/70">·</span>
          <span className="ml-1 font-semibold text-foreground">
            ${todayCost.toFixed(2)}
          </span>
        </span>
      </div>

      <div className="mt-3">
        <StreakChart data={chartData} height={160} />
      </div>

      <button
        type="button"
        onClick={onNavigateAnalytics}
        className={cn(
          'mt-3 w-full inline-flex items-center justify-center gap-1.5 rounded-lg',
          'px-3 py-2 text-[12px] font-medium text-foreground/85',
          'border border-[hsl(var(--glass-border-light))] bg-transparent',
          'hover:bg-foreground/[0.04] hover:text-foreground',
          'active:scale-[0.99] transition-all',
        )}
      >
        <span>{t('workspace.streakPopoverViewAnalytics')}</span>
        <ArrowRight className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
