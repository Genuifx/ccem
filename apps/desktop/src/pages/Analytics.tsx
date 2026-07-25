// apps/desktop/src/pages/Analytics.tsx
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Flame, RefreshCw, Share2, TrendingDown, TrendingUp } from '@/lib/lucide-react';
import { ErrorBanner } from '@/components/ui/EmptyState';
import { cn } from '@/lib/utils';
import { HeatmapCalendar } from '@/components/analytics/HeatmapCalendar';
import { useAppStore } from '@/store';
import { generateMockMilestones, generateMockUsageStats } from '@/lib/mockAnalytics';
import { useLocale } from '@/locales';
import { AnalyticsSkeleton } from '@/components/ui/skeleton-states';
import { useCountUp } from '@/hooks/useCountUp';
import { ccemMotion, clearMotionProps, getMotionTargets, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';
import type { DailyActivity, UsageStats } from '@/types/analytics';
import { shallow } from 'zustand/shallow';

type UsageSourceFilter = 'all' | 'claude' | 'codex' | 'opencode';
const ANALYTICS_CACHE_TTL_MS = 60_000;

interface AnalyticsCacheResult {
  stats: UsageStats;
  streakDays: number;
}

interface AnalyticsSourceCacheEntry {
  stats?: UsageStats;
  streakDays?: number;
  fetchedAt: number;
  promise?: Promise<AnalyticsCacheResult>;
}

const analyticsSourceCache = new Map<UsageSourceFilter, AnalyticsSourceCacheEntry>();

function isMockUsageStats(stats: UsageStats | null | undefined): boolean {
  return typeof stats?.lastUpdated === 'string' && stats.lastUpdated.startsWith('mock:');
}

function calculateStreakDays(dailyHistory: UsageStats['dailyHistory']): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);

  let streak = 0;
  while (true) {
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    if (!dailyHistory[dateKey]) {
      return streak;
    }
    streak += 1;
    date.setDate(date.getDate() - 1);
  }
}

function primeAnalyticsSourceCache(source: UsageSourceFilter, stats: UsageStats, fetchedAt = Date.now()) {
  analyticsSourceCache.set(source, {
    stats,
    streakDays: calculateStreakDays(stats.dailyHistory),
    fetchedAt,
  });
}

async function fetchAnalyticsSource(source: UsageSourceFilter, force = false): Promise<AnalyticsCacheResult> {
  const cached = analyticsSourceCache.get(source);

  if (!force && cached?.stats && Date.now() - cached.fetchedAt < ANALYTICS_CACHE_TTL_MS) {
    return {
      stats: cached.stats,
      streakDays: cached.streakDays ?? calculateStreakDays(cached.stats.dailyHistory),
    };
  }

  if (!force && cached?.promise) {
    return cached.promise;
  }

  const request = invoke<UsageStats>('get_usage_stats', {
    source: source === 'all' ? null : source,
  })
    .then((stats) => {
      const result = {
        stats,
        streakDays: calculateStreakDays(stats.dailyHistory),
      };
      analyticsSourceCache.set(source, {
        ...result,
        fetchedAt: Date.now(),
      });
      return result;
    })
    .catch((error) => {
      if (cached) {
        analyticsSourceCache.set(source, cached);
      } else {
        analyticsSourceCache.delete(source);
      }
      throw error;
    });

  analyticsSourceCache.set(source, {
    stats: cached?.stats,
    streakDays: cached?.streakDays,
    fetchedAt: cached?.fetchedAt ?? 0,
    promise: request,
  });

  return request;
}

const LazyAnalyticsInsights = lazy(async () =>
  import('@/components/analytics/AnalyticsInsights').then((module) => ({ default: module.AnalyticsInsights }))
);

const LazySharePosterDialog = lazy(async () =>
  import('@/components/analytics/SharePosterDialog').then((module) => ({ default: module.SharePosterDialog }))
);

function AnalyticsInsightsFallback() {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border-subtle bg-[hsl(var(--surface))] p-6">
        <div className="mb-5 h-5 w-40 animate-pulse rounded-full bg-[hsl(var(--surface-sunken))]" />
        <div className="h-[300px] w-full animate-pulse rounded-2xl bg-[hsl(var(--surface-sunken))]" />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-border-subtle bg-[hsl(var(--surface))] p-6">
          <div className="mb-5 h-5 w-32 animate-pulse rounded-full bg-[hsl(var(--surface-sunken))]" />
          <div className="h-[160px] w-full animate-pulse rounded-2xl bg-[hsl(var(--surface-sunken))]" />
        </div>
        <div className="rounded-2xl border border-border-subtle bg-[hsl(var(--surface))] p-6">
          <div className="mb-5 h-5 w-28 animate-pulse rounded-full bg-[hsl(var(--surface-sunken))]" />
          <div className="h-[160px] w-full animate-pulse rounded-2xl bg-[hsl(var(--surface-sunken))]" />
        </div>
      </div>
    </div>
  );
}

export function primeAnalyticsPage() {
  void import('@/components/analytics/AnalyticsInsights');
}

export function Analytics() {
  const { t } = useLocale();
  const {
    usageStats,
    milestones,
    continuousUsageDays,
    isLoadingStats,
    setUsageStats,
    setMilestones,
    setContinuousUsageDays,
  } = useAppStore(
    (state) => ({
      usageStats: state.usageStats,
      milestones: state.milestones,
      continuousUsageDays: state.continuousUsageDays,
      isLoadingStats: state.isLoadingStats,
      setUsageStats: state.setUsageStats,
      setMilestones: state.setMilestones,
      setContinuousUsageDays: state.setContinuousUsageDays,
    }),
    shallow
  );

  const [isUsingMockData, setIsUsingMockData] = useState(() => isMockUsageStats(useAppStore.getState().usageStats));
  const [loadError, setLoadError] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [usageSource, setUsageSource] = useState<UsageSourceFilter>('all');
  const [showSharePoster, setShowSharePoster] = useState(false);
  const requestSeqRef = useRef(0);
  const analyticsMotionRef = useRef<HTMLDivElement>(null);
  const hasHydratedAnalyticsMotionRef = useRef(false);
  const [, startTransition] = useTransition();

  const buildMilestones = useCallback((stats: UsageStats, streakDays: number) => {
    const totalTokens = stats.total.inputTokens + stats.total.outputTokens + stats.total.cacheReadTokens + stats.total.cacheCreationTokens;
    const totalCost = stats.total.cost;

    return [
      {
        id: 'tokens-100k',
        type: 'tokens' as const,
        title: t('analytics.milestone100kTitle'),
        description: t('analytics.milestone100kDesc'),
        target: 100000,
        current: totalTokens,
        achieved: totalTokens >= 100000,
      },
      {
        id: 'tokens-1m',
        type: 'tokens' as const,
        title: t('analytics.milestone1mTitle'),
        description: t('analytics.milestone1mDesc'),
        target: 1000000,
        current: totalTokens,
        achieved: totalTokens >= 1000000,
      },
      {
        id: 'tokens-5m',
        type: 'tokens' as const,
        title: t('analytics.milestone5mTitle'),
        description: t('analytics.milestone5mDesc'),
        target: 5000000,
        current: totalTokens,
        achieved: totalTokens >= 5000000,
      },
      {
        id: 'cost-10',
        type: 'cost' as const,
        title: t('analytics.firstTenTitle'),
        description: t('analytics.firstTenDesc'),
        target: 10,
        current: totalCost,
        achieved: totalCost >= 10,
      },
      {
        id: 'cost-100',
        type: 'cost' as const,
        title: t('analytics.hundredTitle'),
        description: t('analytics.hundredDesc'),
        target: 100,
        current: totalCost,
        achieved: totalCost >= 100,
      },
      {
        id: 'streak-7',
        type: 'streak' as const,
        title: t('analytics.sevenDayTitle'),
        description: t('analytics.sevenDayDesc'),
        target: 7,
        current: streakDays,
        achieved: streakDays >= 7,
      },
    ];
  }, [t]);

  const applyAnalyticsData = useCallback((result: AnalyticsCacheResult) => {
    setUsageStats(result.stats);
    setIsUsingMockData(false);
    setContinuousUsageDays(result.streakDays);
    setMilestones(buildMilestones(result.stats, result.streakDays));
  }, [buildMilestones, setContinuousUsageDays, setMilestones, setUsageStats]);

  const loadRealData = useCallback(async (force = false) => {
    const requestSeq = ++requestSeqRef.current;

    try {
      setLoadError(false);
      const result = await fetchAnalyticsSource(usageSource, force);

      if (requestSeq !== requestSeqRef.current) {
        return;
      }

      applyAnalyticsData(result);
    } catch (err) {
      if (requestSeq !== requestSeqRef.current) {
        return;
      }

      console.error('Failed to load analytics data:', err);
      const hasExistingStats = useAppStore.getState().usageStats !== null;

      if (import.meta.env.DEV && !hasExistingStats) {
        const mockStats = generateMockUsageStats();
        setUsageStats(mockStats);
        setMilestones(generateMockMilestones());
        setContinuousUsageDays(calculateStreakDays(mockStats.dailyHistory));
        setIsUsingMockData(true);
      } else {
        setLoadError(true);
      }
    }
  }, [applyAnalyticsData, setContinuousUsageDays, setMilestones, setUsageStats, usageSource]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await loadRealData(true);
    setIsRefreshing(false);
  }, [loadRealData]);

  useEffect(() => {
    loadRealData();
  }, [loadRealData]);

  useEffect(() => {
    setIsUsingMockData(usageSource === 'all' && isMockUsageStats(usageStats));
  }, [usageSource, usageStats]);

  useEffect(() => {
    if (usageSource === 'all' && usageStats && !isMockUsageStats(usageStats) && !analyticsSourceCache.has('all')) {
      primeAnalyticsSourceCache('all', usageStats);
    }
  }, [usageSource, usageStats]);

  useEffect(() => {
    localStorage.setItem('ccem-ftue-analytics-seen', 'true');
  }, []);

  const analyticsMotionKey = `${usageSource}:${usageStats?.lastUpdated ?? 'empty'}:${isRefreshing ? 'refreshing' : 'settled'}`;

  useGSAP(() => {
    const root = analyticsMotionRef.current;
    if (!root) {
      return;
    }

    const targets = [
      ...getMotionTargets(root, '[data-analytics-motion-panel]', 3),
      ...getMotionTargets(root, '[data-analytics-motion-cell]', 6),
      ...getMotionTargets(root, '[data-analytics-motion-action]', 2),
    ];

    if (!hasHydratedAnalyticsMotionRef.current) {
      hasHydratedAnalyticsMotionRef.current = true;
      clearMotionProps(targets);
      return;
    }

    if (targets.length === 0) {
      return;
    }

    if (shouldReduceMotion()) {
      clearMotionProps(targets);
      return;
    }

    gsap.killTweensOf(targets);
    gsap.fromTo(
      targets,
      { autoAlpha: 0, y: 8 },
      {
        autoAlpha: 1,
        y: 0,
        duration: ccemMotion.duration.quick,
        ease: ccemMotion.ease.standard,
        stagger: 0.025,
        overwrite: 'auto',
        onComplete: () => clearMotionProps(targets),
      },
    );
  }, { scope: analyticsMotionRef, dependencies: [analyticsMotionKey] });

  const totalTokensRaw = usageStats
    ? usageStats.total.inputTokens + usageStats.total.outputTokens + usageStats.total.cacheReadTokens + usageStats.total.cacheCreationTokens
    : 0;
  const weeklyTokensRaw = usageStats
    ? usageStats.week.inputTokens + usageStats.week.outputTokens + usageStats.week.cacheReadTokens + usageStats.week.cacheCreationTokens
    : 0;
  const totalCostRaw = usageStats?.total.cost ?? 0;
  const weeklyCostRaw = usageStats?.week.cost ?? 0;
  const streakDays = continuousUsageDays ?? 0;

  const animatedTotalTokens = useCountUp(totalTokensRaw);
  const animatedWeeklyTokens = useCountUp(weeklyTokensRaw);
  const animatedTotalCostCents = useCountUp(Math.round(totalCostRaw * 100));
  const animatedWeeklyCostCents = useCountUp(Math.round(weeklyCostRaw * 100));
  const animatedStreakDays = useCountUp(streakDays);

  const tokenChange = useMemo(() => {
    if (!usageStats) {
      return null;
    }

    const sorted = Object.entries(usageStats.dailyHistory)
      .sort(([a], [b]) => a.localeCompare(b));
    const thisWeekEntries = sorted.slice(-7);
    const prevWeekEntries = sorted.slice(-14, -7);
    const sumTokens = (entries: typeof thisWeekEntries) =>
      entries.reduce((acc, [, usage]) => (
        acc + usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
      ), 0);

    const thisWeekTokens = sumTokens(thisWeekEntries);
    const prevWeekTokens = sumTokens(prevWeekEntries);

    return prevWeekEntries.length > 0 && prevWeekTokens > 0
      ? ((thisWeekTokens - prevWeekTokens) / prevWeekTokens) * 100
      : null;
  }, [usageStats]);

  const dailyActivities: DailyActivity[] = useMemo(() => {
    if (!usageStats?.dailyHistory) {
      return [];
    }

    const entries = Object.entries(usageStats.dailyHistory);
    const tokenCounts = entries.map(([, usage]) => (
      usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
    ));
    const maxTokens = Math.max(...tokenCounts, 1);
    const dataMap = new Map<string, { tokens: number; cost: number }>();

    entries.forEach(([date, usage]) => {
      const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
      dataMap.set(date, { tokens, cost: usage.cost });
    });

    const result: DailyActivity[] = [];
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - 364);

    for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const data = dataMap.get(dateStr);
      const tokens = data?.tokens ?? 0;
      const cost = data?.cost ?? 0;
      const ratio = tokens / maxTokens;
      let level: 0 | 1 | 2 | 3 | 4 = 0;

      if (ratio > 0.75) level = 4;
      else if (ratio > 0.5) level = 3;
      else if (ratio > 0.25) level = 2;
      else if (tokens > 0) level = 1;

      result.push({ date: dateStr, tokens, cost, level });
    }

    return result;
  }, [usageStats]);

  if (isLoadingStats || !usageStats) {
    return <AnalyticsSkeleton />;
  }

  return (
    <div ref={analyticsMotionRef} className="page-transition-enter mx-auto w-full max-w-[1480px] pb-8">
      {loadError && !isUsingMockData && (
        <ErrorBanner
          message={t('analytics.failedToLoad')}
          retryLabel={t('common.retry')}
          onRetry={() => {
            setLoadError(false);
            void loadRealData();
          }}
        />
      )}

      {import.meta.env.DEV && isUsingMockData && (
        <div className="mb-6 rounded-2xl border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.06)] px-5 py-3 text-sm text-[hsl(var(--warning-foreground))]">
          <span>
            <strong>{t('analytics.demoData')}</strong> — {t('analytics.demoDataHint')}
          </span>
        </div>
      )}

      {/* Summary Section */}
      <section data-analytics-motion-panel className="rounded-2xl border border-border-subtle bg-[hsl(var(--surface-sunken))] px-5 py-5 sm:px-8 sm:py-6">
        {/* Source filter + actions row */}
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-nowrap sm:overflow-x-auto sm:[scrollbar-width:none] sm:[&::-webkit-scrollbar]:hidden" role="radiogroup" aria-label="Source filter">
            {(['all', 'claude', 'codex', 'opencode'] as UsageSourceFilter[]).map((source) => (
              <button
                key={source}
                data-testid={`analytics-filter-${source}`}
                type="button"
                role="radio"
                aria-checked={usageSource === source}
                onClick={() => startTransition(() => setUsageSource(source))}
                className={cn(
                  'shrink-0 rounded-full px-4 py-1.5 text-sm transition-all duration-200',
                  'tracking-[-0.01em]',
                  usageSource === source
                    ? 'border-2 border-primary bg-[hsl(var(--surface))] font-medium text-foreground shadow-sm'
                    : 'border border-border-subtle bg-[hsl(var(--surface))] text-muted-foreground hover:text-foreground'
                )}
                style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
              >
                {source === 'all' && t('analytics.sourceAll')}
                {source === 'claude' && t('analytics.sourceClaude')}
                {source === 'codex' && t('analytics.sourceCodex')}
                {source === 'opencode' && t('analytics.sourceOpencode')}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              data-analytics-motion-action
              type="button"
              disabled={isRefreshing}
              onClick={() => void handleRefresh()}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-[hsl(var(--surface))] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              aria-label="Refresh"
            >
              <RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
            </button>
            <button
              data-analytics-motion-action
              type="button"
              onClick={() => setShowSharePoster(true)}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-[hsl(var(--surface))] text-muted-foreground transition-colors hover:text-foreground"
              aria-label={t('analytics.sharePoster')}
            >
              <Share2 className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="grid gap-5 border-t border-[hsl(var(--border-subtle)/0.5)] pt-5 xl:grid-cols-[minmax(320px,0.4fr)_minmax(620px,1fr)] xl:gap-7">
          <div className="grid min-w-0 grid-cols-2 gap-x-5 gap-y-4 xl:border-r xl:border-[hsl(var(--border-subtle)/0.5)] xl:pr-7">
            <MetricCell
              value={animatedTotalTokens.toLocaleString()}
              label={t('analytics.totalTokens')}
              trend={tokenChange}
              featured
              className="col-span-2"
            />
            <MetricCell
              value={`$${(animatedTotalCostCents / 100).toFixed(2)}`}
              label={t('analytics.costTotal')}
            />
            <MetricCell
              value={`$${(animatedWeeklyCostCents / 100).toFixed(2)}`}
              label={t('analytics.costThisWeek')}
            />
            <MetricCell
              value={animatedWeeklyTokens.toLocaleString()}
              label={t('analytics.tokenThisWeek')}
            />
            <MetricCell
              value={String(animatedStreakDays)}
              label={t('analytics.streak')}
              suffix={
                <Flame
                  className={cn(
                    'h-4 w-4 transition-colors duration-300',
                    streakDays >= 7 ? 'text-[hsl(25_90%_50%)] drop-shadow-[0_0_4px_hsl(25_90%_50%/0.4)]' : 'text-muted-foreground'
                  )}
                />
              }
            />
          </div>

          <div className="min-w-0">
            <HeatmapCalendar activities={dailyActivities} compact={false} />
          </div>
        </div>
      </section>

      {/* Charts Section — white surface */}
      <section data-analytics-motion-panel className="mt-8">
        <Suspense fallback={<AnalyticsInsightsFallback />}>
          <LazyAnalyticsInsights
            usageStats={usageStats}
            usageSource={usageSource}
            enableModelBreakdown={!isUsingMockData}
            milestones={milestones}
            isRefreshing={isRefreshing}
            onRefresh={handleRefresh}
          />
        </Suspense>
      </section>

      {showSharePoster && (
        <Suspense fallback={null}>
          <LazySharePosterDialog
            open={showSharePoster}
            onOpenChange={setShowSharePoster}
            usageStats={usageStats}
            dailyActivities={dailyActivities}
            streakDays={streakDays}
          />
        </Suspense>
      )}
    </div>
  );
}

/** A single metric in the horizontal row */
function MetricCell({
  value,
  label,
  trend,
  suffix,
  featured = false,
  className,
}: {
  value: string;
  label: string;
  trend?: number | null;
  suffix?: React.ReactNode;
  featured?: boolean;
  className?: string;
}) {
  return (
    <div data-analytics-motion-cell className={cn('min-w-0 border-t border-[hsl(var(--border-subtle)/0.42)] pt-2.5 first:border-t-0 first:pt-0', className)}>
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            'min-w-0 truncate font-semibold tabular-nums text-foreground',
            featured ? 'text-[1.65rem] leading-none sm:text-[2rem]' : 'text-[1.22rem] leading-tight sm:text-[1.45rem]'
          )}
          style={{
            fontFamily: 'system-ui, -apple-system, sans-serif',
            letterSpacing: '-0.02em',
          }}
        >
          {value}
        </span>
        {suffix}
        {trend != null && (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums',
              trend >= 0
                ? 'bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]'
                : 'bg-[hsl(var(--destructive)/0.1)] text-[hsl(var(--destructive))]'
            )}
          >
            {trend >= 0 ? (
              <TrendingUp className="h-3 w-3" />
            ) : (
              <TrendingDown className="h-3 w-3" />
            )}
            {Math.abs(trend).toFixed(1)}%
          </span>
        )}
      </div>
      <span
        className="mt-1.5 block text-sm text-muted-foreground"
        style={{
          fontFamily: 'system-ui, -apple-system, sans-serif',
          letterSpacing: '-0.01em',
        }}
      >
        {label}
      </span>
    </div>
  );
}
