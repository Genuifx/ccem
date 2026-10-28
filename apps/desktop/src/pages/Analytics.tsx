// apps/desktop/src/pages/Analytics.tsx
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Flame, RefreshCw, Share2, TrendingDown, TrendingUp } from '@/lib/lucide-react';
import { ErrorBanner } from '@/components/ui/EmptyState';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { HeatmapCalendar } from '@/components/analytics/HeatmapCalendar';
import { useAppStore } from '@/store';
import { generateMockMilestones, generateMockUsageStats } from '@/lib/mockAnalytics';
import { calculateContinuousUsageDays } from '@/lib/streak';
import { useLocale } from '@/locales';
import { AnalyticsSkeleton } from '@/components/ui/skeleton-states';
import { useCountUp } from '@/hooks/useCountUp';
import { ccemMotion, clearMotionProps, getMotionTargets, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';
import type { DailyActivity, UsageStats } from '@/types/analytics';
import { shallow } from 'zustand/shallow';

type UsageSourceFilter = 'all' | 'claude' | 'codex' | 'opencode' | 'dsh';
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

function primeAnalyticsSourceCache(source: UsageSourceFilter, stats: UsageStats, fetchedAt = Date.now()) {
  analyticsSourceCache.set(source, {
    stats,
    streakDays: calculateContinuousUsageDays(stats.dailyHistory),
    fetchedAt,
  });
}

async function fetchAnalyticsSource(source: UsageSourceFilter, force = false): Promise<AnalyticsCacheResult> {
  const cached = analyticsSourceCache.get(source);

  if (!force && cached?.stats && Date.now() - cached.fetchedAt < ANALYTICS_CACHE_TTL_MS) {
    return {
      stats: cached.stats,
      streakDays: cached.streakDays ?? calculateContinuousUsageDays(cached.stats.dailyHistory),
    };
  }

  if (!force && cached?.promise) {
    return cached.promise;
  }

  const request = invoke<UsageStats>('get_usage_stats', {
    source: source === 'all' ? null : source,
    force,
  })
    .then((stats) => {
      const result = {
        stats,
        streakDays: calculateContinuousUsageDays(stats.dailyHistory),
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
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [usageSource, setUsageSource] = useState<UsageSourceFilter>('all');
  const [localViewStats, setLocalViewStats] = useState<UsageStats | null>(null);
  const [showSharePoster, setShowSharePoster] = useState(false);
  const requestSeqRef = useRef(0);
  const analyticsMotionRef = useRef<HTMLDivElement>(null);
  const hasHydratedAnalyticsMotionRef = useRef(false);

  const buildMilestones = useCallback((stats: UsageStats, streakDays: number) => {
    const totalTokens = stats.total.inputTokens + stats.total.outputTokens + stats.total.cacheReadTokens + stats.total.cacheCreationTokens;
    const totalCost = stats.total.cost;
    // Cost milestones only trigger when cost is fully priced (not incomplete)
    const costFullyPriced = !stats.total.costIncomplete;

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
        achieved: costFullyPriced && totalCost >= 10,
      },
      {
        id: 'cost-100',
        type: 'cost' as const,
        title: t('analytics.hundredTitle'),
        description: t('analytics.hundredDesc'),
        target: 100,
        current: totalCost,
        achieved: costFullyPriced && totalCost >= 100,
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

  const applyAnalyticsData = useCallback((result: AnalyticsCacheResult, source: UsageSourceFilter) => {
    if (source === 'all') {
      setUsageStats(result.stats);
      setContinuousUsageDays(result.streakDays);
      setMilestones(buildMilestones(result.stats, result.streakDays));
      setLocalViewStats(null);
    } else {
      setLocalViewStats(result.stats);
    }
    setIsUsingMockData(false);
  }, [buildMilestones, setContinuousUsageDays, setMilestones, setUsageStats]);

  const loadRealData = useCallback(async (force = false) => {
    const requestSeq = ++requestSeqRef.current;
    const currentSource = usageSource;

    try {
      setLoadError(false);
      const result = await fetchAnalyticsSource(currentSource, force);

      if (requestSeq !== requestSeqRef.current) {
        return;
      }

      applyAnalyticsData(result, currentSource);
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
        setContinuousUsageDays(calculateContinuousUsageDays(mockStats.dailyHistory));
        setIsUsingMockData(true);
      } else {
        setLoadError(true);
      }
    }
  }, [applyAnalyticsData, setContinuousUsageDays, setMilestones, setUsageStats, usageSource]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await loadRealData(true);
    // A refresh must also retry model details when the summary is unchanged
    // (or failed), rather than relying solely on its lastUpdated timestamp.
    setRefreshRevision((value) => value + 1);
    setIsRefreshing(false);
  }, [loadRealData]);

  useEffect(() => {
    if (usageSource !== 'all' || useAppStore.getState().usageStats !== null) {
      return;
    }

    let cancelled = false;
    void invoke<UsageStats | null>('get_tray_usage_stats')
      .then((summary) => {
        if (cancelled || !summary || useAppStore.getState().usageStats !== null) {
          return;
        }
        const result = {
          stats: summary,
          streakDays: calculateContinuousUsageDays(summary.dailyHistory),
        };
        primeAnalyticsSourceCache('all', summary);
        applyAnalyticsData(result, 'all');
      })
      .catch((error) => {
        console.debug('Cached analytics summary is not available:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [applyAnalyticsData, usageSource]);

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

  // For filtered sources, use local view stats; for 'all', use global store
  const viewStats = usageSource === 'all' ? usageStats : (localViewStats ?? usageStats);

  const totalTokensRaw = viewStats
    ? viewStats.total.inputTokens + viewStats.total.outputTokens + viewStats.total.cacheReadTokens + viewStats.total.cacheCreationTokens
    : 0;
  const weeklyTokensRaw = viewStats
    ? viewStats.week.inputTokens + viewStats.week.outputTokens + viewStats.week.cacheReadTokens + viewStats.week.cacheCreationTokens
    : 0;
  const totalCostRaw = viewStats?.total.cost ?? 0;
  const weeklyCostRaw = viewStats?.week.cost ?? 0;
  const totalCostIncomplete = viewStats?.total.costIncomplete ?? false;
  const totalUnpricedTokens = viewStats?.total.unpricedTokens ?? 0;
  const weeklyCostIncomplete = viewStats?.week.costIncomplete ?? false;
  const streakDays = continuousUsageDays ?? 0;

  const animatedTotalTokens = useCountUp(totalTokensRaw);
  const animatedWeeklyTokens = useCountUp(weeklyTokensRaw);
  const animatedTotalCostCents = useCountUp(Math.round(totalCostRaw * 100));
  const animatedWeeklyCostCents = useCountUp(Math.round(weeklyCostRaw * 100));
  const animatedStreakDays = useCountUp(streakDays);

  const tokenChange = useMemo(() => {
    if (!viewStats) {
      return null;
    }

    const sorted = Object.entries(viewStats.dailyHistory)
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
  }, [viewStats]);

  const dailyActivities: DailyActivity[] = useMemo(() => {
    if (!viewStats?.dailyHistory) {
      return [];
    }

    const entries = Object.entries(viewStats.dailyHistory);
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
  }, [viewStats]);

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
      <section data-analytics-motion-panel className="rounded-2xl border border-border-subtle bg-[hsl(var(--surface-sunken))] p-3 sm:p-4">
        {/* Source filter + actions row */}
        <div className="mb-3 flex items-center justify-between gap-3">
          <div
            className="inline-flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-full border border-border-subtle bg-[hsl(var(--surface))] p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            role="radiogroup"
            aria-label="Source filter"
          >
            {(['all', 'claude', 'codex', 'opencode', 'dsh'] as UsageSourceFilter[]).map((source) => (
              <button
                key={source}
                data-testid={`analytics-filter-${source}`}
                type="button"
                role="radio"
                aria-checked={usageSource === source}
                onClick={() => setUsageSource(source)}
                className={cn(
                  'shrink-0 rounded-full px-3 py-1 text-[13px] transition-colors duration-150',
                  usageSource === source
                    ? 'bg-foreground font-medium text-background'
                    : 'text-muted-foreground hover:bg-[hsl(var(--surface-sunken))] hover:text-foreground'
                )}
              >
                {source === 'all' && t('analytics.sourceAll')}
                {source === 'claude' && t('analytics.sourceClaude')}
                {source === 'codex' && t('analytics.sourceCodex')}
                {source === 'opencode' && t('analytics.sourceOpencode')}
                {source === 'dsh' && 'DSH'}
              </button>
            ))}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-analytics-motion-action
                  type="button"
                  disabled={isRefreshing}
                  onClick={() => void handleRefresh()}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[hsl(var(--surface))] hover:text-foreground disabled:opacity-50"
                  aria-label={t('analytics.refresh')}
                >
                  <RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
                </button>
              </TooltipTrigger>
              <TooltipContent>{t('analytics.refresh')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-analytics-motion-action
                  type="button"
                  onClick={() => setShowSharePoster(true)}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[hsl(var(--surface))] hover:text-foreground"
                  aria-label={t('analytics.sharePoster')}
                >
                  <Share2 className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{t('analytics.sharePoster')}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          <MetricTile
            label={t('analytics.totalTokens')}
            value={formatKpiTokens(animatedTotalTokens)}
            title={totalTokensRaw.toLocaleString()}
            meta={<span className="tabular-nums">{totalTokensRaw.toLocaleString()}</span>}
          />
          <MetricTile
            label={t('analytics.tokenThisWeek')}
            value={formatKpiTokens(animatedWeeklyTokens)}
            title={weeklyTokensRaw.toLocaleString()}
            meta={tokenChange != null ? <TrendBadge value={tokenChange} label={t('analytics.vsLastWeek')} /> : null}
          />
          <MetricTile
            label={t('analytics.costTotal')}
            value={formatUsd(animatedTotalCostCents / 100)}
            badge={totalCostIncomplete ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    data-testid="cost-incomplete-annotation"
                    tabIndex={0}
                    className="cursor-help rounded-full bg-[hsl(var(--warning)/0.12)] px-1.5 py-0.5 text-[11px] font-medium leading-none text-[hsl(var(--warning-foreground))]"
                  >
                    {t('analytics.costPartial')}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {t('analytics.unpricedTokens', { count: formatKpiTokens(totalUnpricedTokens) })}
                </TooltipContent>
              </Tooltip>
            ) : null}
            meta={(
              <span className="tabular-nums">
                {t('analytics.thisWeekValue', { value: formatUsd(animatedWeeklyCostCents / 100) })}
                {weeklyCostIncomplete && ` · ${t('analytics.costPartial')}`}
              </span>
            )}
          />
          <MetricTile
            label={t('analytics.streak')}
            value={String(animatedStreakDays)}
            unit={t('analytics.days')}
            badge={(
              <Flame
                className={cn(
                  'h-4 w-4 transition-colors duration-300',
                  streakDays >= 7 ? 'text-[hsl(25_90%_50%)]' : 'text-muted-foreground/60'
                )}
              />
            )}
          />
        </div>

        <div data-analytics-motion-cell className="mt-2 rounded-xl bg-[hsl(var(--surface))] px-4 py-4 sm:mt-3 sm:px-5">
          <HeatmapCalendar activities={dailyActivities} compact={false} />
        </div>
      </section>

      {/* Charts Section — white surface */}
      <section data-analytics-motion-panel className="mt-8">
        <Suspense fallback={<AnalyticsInsightsFallback />}>
          <LazyAnalyticsInsights
            usageStats={viewStats!}
            usageSource={usageSource}
            enableModelBreakdown={!isUsingMockData}
            milestones={milestones}
            isRefreshing={isRefreshing}
            refreshRevision={refreshRevision}
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

function formatKpiTokens(n: number): string {
  const value = Math.abs(n);
  if (value >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

const usdFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function formatUsd(n: number): string {
  return usdFormatter.format(n);
}

function TrendBadge({ value, label }: { value: number; label: string }) {
  const up = value >= 0;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-none tabular-nums',
          up
            ? 'bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))]'
            : 'bg-[hsl(var(--destructive)/0.1)] text-[hsl(var(--destructive))]'
        )}
      >
        {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
        {Math.abs(value).toFixed(1)}%
      </span>
      <span>{label}</span>
    </span>
  );
}

/** One KPI tile: label on top, headline value, optional one-line context below. */
function MetricTile({
  label,
  value,
  unit,
  title,
  badge,
  meta,
}: {
  label: string;
  value: string;
  unit?: string;
  title?: string;
  badge?: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <div data-analytics-motion-cell className="flex min-w-0 flex-col rounded-xl bg-[hsl(var(--surface))] px-4 py-3.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{label}</span>
        {badge}
      </div>
      <div className="mt-2 flex min-w-0 items-baseline gap-1" title={title}>
        <span className="truncate text-[1.6rem] font-semibold leading-none tracking-[-0.02em] tabular-nums text-foreground">
          {value}
        </span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>
      <div className="mt-2 min-h-[18px] truncate text-xs text-muted-foreground">{meta}</div>
    </div>
  );
}
