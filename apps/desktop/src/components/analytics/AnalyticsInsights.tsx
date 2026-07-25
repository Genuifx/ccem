import { invoke } from '@tauri-apps/api/core';
import { Suspense, lazy, memo, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { BarChart3, DollarSign, Flame, RefreshCw } from '@/lib/lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/utils';
import { buildWeekBucketKey } from '@/lib/analyticsTimeBuckets';
import { useLocale } from '@/locales';
import { getPerformanceMode } from '@/lib/performance';
import type {
  ChartDataPoint,
  Milestone,
  ModelBreakdownHistory,
  TokenUsageWithCost,
  UsageStats,
} from '@/types/analytics';

type TimeGranularity = 'hour' | 'day' | 'week' | 'month';
type AnalyticsUsageSource = 'all' | 'claude' | 'codex' | 'opencode';
const MODEL_BREAKDOWN_CACHE_TTL_MS = 60_000;

interface ModelBreakdownCacheEntry {
  data?: ModelBreakdownHistory;
  statsLastUpdated?: string;
  fetchedAt: number;
  promise?: Promise<ModelBreakdownHistory>;
}

interface LoadedModelBreakdown {
  data: ModelBreakdownHistory;
  granularity: TimeGranularity;
  source: AnalyticsUsageSource;
  statsLastUpdated: string;
}

const modelBreakdownCache = new Map<string, ModelBreakdownCacheEntry>();

interface AnalyticsInsightsProps {
  usageStats: UsageStats;
  usageSource: AnalyticsUsageSource;
  enableModelBreakdown: boolean;
  milestones: Milestone[];
  isRefreshing: boolean;
  onRefresh: () => void | Promise<void>;
}

const LazyTokenChart = lazy(async () =>
  import('./TokenChart').then((module) => ({ default: module.TokenChart }))
);

const LazyModelDistribution = lazy(async () =>
  import('./ModelDistribution').then((module) => ({ default: module.ModelDistribution }))
);

const LazyDailyTokenBar = lazy(async () =>
  import('./DailyTokenBar').then((module) => ({ default: module.DailyTokenBar }))
);

function sumTokens(usage: TokenUsageWithCost): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

function createEmptyUsage(): TokenUsageWithCost {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cost: 0,
  };
}

function addUsage(target: TokenUsageWithCost, usage: TokenUsageWithCost) {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheReadTokens += usage.cacheReadTokens;
  target.cacheCreationTokens += usage.cacheCreationTokens;
  target.cost += usage.cost;
}

function toBreakdown(modelUsage: Record<string, TokenUsageWithCost> | undefined): Record<string, number> {
  if (!modelUsage) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(modelUsage)
      .map(([model, usage]) => [model, sumTokens(usage)] as const)
      .filter((entry): entry is readonly [string, number] => entry[1] > 0)
      .sort(([, left], [, right]) => right - left),
  );
}

function getModelBreakdownCacheKey(
  source: AnalyticsUsageSource,
  granularity: TimeGranularity,
): string {
  return `${source}:${granularity}`;
}

async function fetchModelBreakdown(
  source: AnalyticsUsageSource,
  granularity: TimeGranularity,
  statsLastUpdated: string,
): Promise<ModelBreakdownHistory> {
  const cacheKey = getModelBreakdownCacheKey(source, granularity);
  const cached = modelBreakdownCache.get(cacheKey);
  const isFresh = cached?.statsLastUpdated === statsLastUpdated
    && Date.now() - cached.fetchedAt < MODEL_BREAKDOWN_CACHE_TTL_MS;

  if (cached?.data && isFresh) {
    return cached.data;
  }

  if (cached?.promise && cached.statsLastUpdated === statsLastUpdated) {
    return cached.promise;
  }

  const request = invoke<ModelBreakdownHistory>('get_usage_model_breakdown', {
    granularity,
    source: source === 'all' ? null : source,
  })
    .then((data) => {
      modelBreakdownCache.set(cacheKey, {
        data,
        statsLastUpdated,
        fetchedAt: Date.now(),
      });
      return data;
    })
    .catch((error) => {
      if (cached) {
        modelBreakdownCache.set(cacheKey, cached);
      } else {
        modelBreakdownCache.delete(cacheKey);
      }
      throw error;
    });

  modelBreakdownCache.set(cacheKey, {
    data: cached?.statsLastUpdated === statsLastUpdated ? cached.data : undefined,
    statsLastUpdated,
    fetchedAt: cached?.fetchedAt ?? 0,
    promise: request,
  });

  return request;
}

function NextMilestone({ milestones }: { milestones: Milestone[] }) {
  const { t } = useLocale();

  let next = milestones.find((milestone) => !milestone.achieved);

  if (!next) {
    const totalTokens = milestones.find((milestone) => milestone.type === 'tokens')?.current ?? 0;
    const higherTargets: Milestone[] = [
      {
        id: 'tokens-10m',
        type: 'tokens',
        title: t('analytics.milestone10mTitle'),
        description: t('analytics.milestone10mDesc'),
        target: 10_000_000,
        current: totalTokens,
        achieved: totalTokens >= 10_000_000,
      },
      {
        id: 'tokens-50m',
        type: 'tokens',
        title: t('analytics.milestone50mTitle'),
        description: t('analytics.milestone50mDesc'),
        target: 50_000_000,
        current: totalTokens,
        achieved: totalTokens >= 50_000_000,
      },
      {
        id: 'tokens-100m',
        type: 'tokens',
        title: t('analytics.milestone100mTitle'),
        description: t('analytics.milestone100mDesc'),
        target: 100_000_000,
        current: totalTokens,
        achieved: totalTokens >= 100_000_000,
      },
    ];

    next = higherTargets.find((milestone) => !milestone.achieved);
    if (!next) {
      return (
        <div className="flex items-center gap-2 px-6 py-4 text-sm text-muted-foreground">
          <Flame className="h-4 w-4 text-[hsl(25_90%_50%)]" />
          <span>{t('analytics.allMilestonesAchieved')}</span>
        </div>
      );
    }
  }

  const progress = Math.min((next.current / next.target) * 100, 100);
  const Icon = next.type === 'cost' ? DollarSign : next.type === 'streak' ? Flame : BarChart3;

  return (
    <div className="flex items-center gap-4 rounded-2xl border border-border-subtle bg-[hsl(var(--surface-sunken))] px-6 py-4">
      <Icon className="h-4 w-4 flex-shrink-0" style={{ color: 'hsl(var(--chart-4))' }} />
      <span
        className="flex-shrink-0 text-sm text-muted-foreground"
        style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
      >
        {t('analytics.nextMilestone')}
      </span>
      <span
        className="flex-shrink-0 text-sm font-semibold text-foreground"
        style={{ fontFamily: 'system-ui, -apple-system, sans-serif', letterSpacing: '-0.01em' }}
      >
        {next.title}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[hsl(var(--border-subtle))]">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${progress}%`, backgroundColor: 'hsl(var(--chart-4))' }}
        />
      </div>
      <span className="flex-shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
        {progress.toFixed(0)}%
      </span>
    </div>
  );
}

function ChartSkeleton({ heightClass }: { heightClass: string }) {
  return <div className={cn('animate-pulse rounded-2xl bg-[hsl(var(--surface-sunken))]', heightClass)} />;
}

export const AnalyticsInsights = memo(function AnalyticsInsights({
  usageStats,
  usageSource,
  enableModelBreakdown,
  milestones,
  isRefreshing,
  onRefresh,
}: AnalyticsInsightsProps) {
  const { t, lang } = useLocale();
  const [granularity, setGranularity] = useState<TimeGranularity>('day');
  const isReducedPerformanceMode = getPerformanceMode() === 'reduced';
  const [animateTokenChart, setAnimateTokenChart] = useState(true);
  const [loadedBreakdown, setLoadedBreakdown] = useState<LoadedModelBreakdown | null>(null);
  const breakdownRequestSeqRef = useRef(0);
  const [, startTransition] = useTransition();
  const dateLocale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const modelBreakdownEnabled = enableModelBreakdown;
  const [showPrimaryChart, setShowPrimaryChart] = useState(() => !isReducedPerformanceMode);
  const [showSecondaryCharts, setShowSecondaryCharts] = useState(false);

  useEffect(() => {
    if (!modelBreakdownEnabled || !showPrimaryChart) {
      setLoadedBreakdown(null);
      return;
    }

    const requestSeq = ++breakdownRequestSeqRef.current;

    void fetchModelBreakdown(usageSource, granularity, usageStats.lastUpdated)
      .then((data) => {
        if (requestSeq !== breakdownRequestSeqRef.current) {
          return;
        }

        setLoadedBreakdown({
          data,
          granularity,
          source: usageSource,
          statsLastUpdated: usageStats.lastUpdated,
        });
      })
      .catch((error) => {
        if (requestSeq !== breakdownRequestSeqRef.current) {
          return;
        }

        console.debug('Model breakdown not available for analytics tooltip:', error);
        setLoadedBreakdown(null);
      });
  }, [granularity, modelBreakdownEnabled, showPrimaryChart, usageSource, usageStats.lastUpdated]);

  useEffect(() => {
    if (!isReducedPerformanceMode) {
      setShowPrimaryChart(true);
      return;
    }

    setShowPrimaryChart(false);
    const revealPrimaryChart = () => {
      startTransition(() => setShowPrimaryChart(true));
    };
    const scheduleIdle = window.requestIdleCallback?.bind(window);
    const cancelIdle = window.cancelIdleCallback?.bind(window);

    if (scheduleIdle && cancelIdle) {
      const idleId = scheduleIdle(revealPrimaryChart, { timeout: 300 });
      return () => {
        cancelIdle(idleId);
      };
    }

    const timeoutId = globalThis.setTimeout(revealPrimaryChart, 180);
    return () => {
      globalThis.clearTimeout(timeoutId);
    };
  }, [granularity, isReducedPerformanceMode, startTransition, usageSource, usageStats.lastUpdated]);

  useEffect(() => {
    setShowSecondaryCharts(false);
    const timeoutId = window.setTimeout(() => {
      setShowSecondaryCharts(true);
    }, isReducedPerformanceMode ? 650 : 200);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isReducedPerformanceMode, usageSource, usageStats.lastUpdated]);

  const activeBreakdown = loadedBreakdown?.granularity === granularity
    && loadedBreakdown.source === usageSource
    && loadedBreakdown.statsLastUpdated === usageStats.lastUpdated
    ? loadedBreakdown.data
    : null;

  const chartData: ChartDataPoint[] = useMemo(() => {
    const allSortedEntries = Object.entries(usageStats.dailyHistory)
      .sort(([a], [b]) => a.localeCompare(b));

    const toChartPoints = (
      entries: [string, TokenUsageWithCost][],
      dateFormat: Intl.DateTimeFormatOptions,
    ): ChartDataPoint[] =>
      entries.map(([bucketKey, usage]) => ({
        bucketKey,
        date: new Date(bucketKey).toLocaleDateString(dateLocale, dateFormat),
        Tokens: sumTokens(usage),
        breakdown: toBreakdown(activeBreakdown?.[bucketKey]),
      }));

    const aggregate = (
      entries: [string, TokenUsageWithCost][],
      keyFn: (dateStr: string) => string,
    ): [string, TokenUsageWithCost][] => {
      const grouped: Record<string, TokenUsageWithCost> = {};

      entries.forEach(([date, usage]) => {
        const key = keyFn(date);
        if (!grouped[key]) {
          grouped[key] = createEmptyUsage();
        }

        addUsage(grouped[key], usage);
      });

      return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b));
    };

    const toAggregatedPoints = (
      entries: [string, TokenUsageWithCost][],
      labelFn: (key: string) => string,
    ): ChartDataPoint[] =>
      entries.map(([bucketKey, usage]) => ({
        bucketKey,
        date: labelFn(bucketKey),
        Tokens: sumTokens(usage),
        breakdown: toBreakdown(activeBreakdown?.[bucketKey]),
      }));

    switch (granularity) {
      case 'hour': {
        const hourlyMap = usageStats.hourlyHistory ?? {};
        const now = new Date();
        const points: ChartDataPoint[] = [];
        let previousDate = '';

        for (let i = 23; i >= 0; i--) {
          const date = new Date(now);
          date.setMinutes(0, 0, 0);
          date.setHours(date.getHours() - i);
          const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}`;
          const datePart = key.slice(5, 10);
          const hourPart = key.slice(11);
          const label = previousDate !== datePart ? `${datePart} ${hourPart}:00` : `${hourPart}:00`;
          previousDate = datePart;
          const usage = hourlyMap[key];
          points.push({
            bucketKey: key,
            date: label,
            Tokens: usage ? sumTokens(usage) : 0,
            breakdown: toBreakdown(activeBreakdown?.[key]),
          });
        }

        return points;
      }
      case 'day':
        return toChartPoints(
          allSortedEntries.slice(-7) as [string, TokenUsageWithCost][],
          { month: 'short', day: 'numeric' },
        );
      case 'week': {
        const weekEntries = aggregate(
          allSortedEntries as [string, TokenUsageWithCost][],
          buildWeekBucketKey,
        );
        return toAggregatedPoints(weekEntries.slice(-4), (key) => key);
      }
      case 'month': {
        const monthEntries = aggregate(
          allSortedEntries as [string, TokenUsageWithCost][],
          (dateStr) => dateStr.slice(0, 7),
        );
        return toAggregatedPoints(
          monthEntries,
          (key) => new Date(`${key}-01`).toLocaleDateString(dateLocale, { year: 'numeric', month: 'short' }),
        );
      }
      default:
        return [];
    }
  }, [activeBreakdown, dateLocale, granularity, usageStats.dailyHistory, usageStats.hourlyHistory]);

  const granularityOptions = useMemo<{ key: TimeGranularity; label: string }[]>(() => [
    { key: 'hour', label: t('analytics.hour') },
    { key: 'day', label: t('analytics.day') },
    { key: 'week', label: t('analytics.week') },
    { key: 'month', label: t('analytics.month') },
  ], [t]);
  const deferredChartData = useDeferredValue(chartData);
  const deferredByModel = useDeferredValue(usageStats.byModel);
  const deferredDailyHistory = useDeferredValue(usageStats.dailyHistory);

  return (
    <div className="space-y-6">
      {/* Token Distribution Chart */}
      <div className="rounded-2xl border border-border-subtle bg-[hsl(var(--surface))] p-6 transition-shadow duration-200 hover:shadow-md">
        <div className="mb-5 flex items-center justify-between">
          <h3
            className="text-lg font-semibold text-foreground"
            style={{ fontFamily: 'system-ui, -apple-system, sans-serif', letterSpacing: '-0.01em' }}
          >
            {t('analytics.tokenDistribution')}
          </h3>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1" role="radiogroup" aria-label="Time granularity">
              {granularityOptions.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={granularity === key}
                  onClick={() => {
                    if (granularity === key) {
                      return;
                    }
                    setAnimateTokenChart(true);
                    startTransition(() => setGranularity(key));
                  }}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs transition-all duration-200',
                    granularity === key
                      ? 'border-2 border-primary bg-[hsl(var(--surface))] font-medium text-foreground shadow-sm'
                      : 'border border-border-subtle text-muted-foreground hover:text-foreground'
                  )}
                  style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={isRefreshing}
              onClick={() => void onRefresh()}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[hsl(var(--surface-sunken))] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              aria-label="Refresh"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
            </button>
          </div>
        </div>
        {chartData.length === 0 ? (
          <EmptyState icon={BarChart3} message={t('analytics.noDataYet')} />
        ) : !showPrimaryChart ? (
          <ChartSkeleton heightClass="h-[300px]" />
        ) : (
          <Suspense fallback={<ChartSkeleton heightClass="h-[300px]" />}>
            <LazyTokenChart
              data={deferredChartData}
              seriesKeys={['Tokens']}
              animate={animateTokenChart}
            />
          </Suspense>
        )}
      </div>

      {/* Secondary Charts Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-border-subtle bg-[hsl(var(--surface))] p-6 transition-shadow duration-200 hover:shadow-md">
          <h3
            className="mb-5 text-lg font-semibold text-foreground"
            style={{ fontFamily: 'system-ui, -apple-system, sans-serif', letterSpacing: '-0.01em' }}
          >
            {t('analytics.modelDistribution')}
          </h3>
          {showSecondaryCharts ? (
            <Suspense fallback={<ChartSkeleton heightClass="h-[160px]" />}>
              <LazyModelDistribution breakdown={activeBreakdown ?? undefined} byModel={deferredByModel} />
            </Suspense>
          ) : (
            <ChartSkeleton heightClass="h-[160px]" />
          )}
        </div>
        <div className="rounded-2xl border border-border-subtle bg-[hsl(var(--surface))] p-6 transition-shadow duration-200 hover:shadow-md">
          <h3
            className="mb-5 text-lg font-semibold text-foreground"
            style={{ fontFamily: 'system-ui, -apple-system, sans-serif', letterSpacing: '-0.01em' }}
          >
            {t('analytics.dailyTokens')}
          </h3>
          {showSecondaryCharts ? (
            <Suspense fallback={<ChartSkeleton heightClass="h-[200px]" />}>
              <LazyDailyTokenBar dailyHistory={deferredDailyHistory} />
            </Suspense>
          ) : (
            <ChartSkeleton heightClass="h-[200px]" />
          )}
        </div>
      </div>

      {/* Milestone */}
      <NextMilestone milestones={milestones} />
    </div>
  );
});
