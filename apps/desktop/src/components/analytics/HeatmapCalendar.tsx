// apps/desktop/src/components/analytics/HeatmapCalendar.tsx
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DailyActivity } from '@/types/analytics';
import { useLocale } from '@/locales';
import { cn, formatTokens } from '@/lib/utils';

interface HeatmapCalendarProps {
  activities: DailyActivity[];
  compact?: boolean;
}

const LEVEL_STYLES: Record<number, React.CSSProperties> = {
  0: { backgroundColor: 'hsl(var(--heatmap-0))' },
  1: { backgroundColor: 'hsl(var(--heatmap-1))' },
  2: { backgroundColor: 'hsl(var(--heatmap-2))' },
  3: { backgroundColor: 'hsl(var(--heatmap-3))' },
  4: { backgroundColor: 'hsl(var(--heatmap-4))' },
};

const COMPACT_WEEK_COUNT = 12;
const DEFAULT_WEEK_COUNT = 26;
const MIN_WEEK_COUNT = 8;
const MAX_WEEK_COUNT = 53;
const LABEL_COLUMN_PX = 28;
const MIN_CELL_PX = 14;
const CELL_GAP_PX = 4;

type ActivityWeek = (DailyActivity | null)[];

function getMonthLabelsForWeeks(weeks: ActivityWeek[], dateLocale: string) {
  const labels: { label: string; weekIndex: number }[] = [];
  let lastMonth = '';

  weeks.forEach((week, weekIndex) => {
    const firstActivity = week.find((a) => a !== null);
    if (!firstActivity) return;

    const month = new Date(firstActivity.date).toLocaleDateString(dateLocale, { month: 'short' });
    if (month !== lastMonth) {
      labels.push({ label: month, weekIndex });
      lastMonth = month;
    }
  });

  return labels.map((month, index) => ({
    ...month,
    span: Math.max(1, (labels[index + 1]?.weekIndex ?? weeks.length) - month.weekIndex),
  }));
}

export function HeatmapCalendar({ activities, compact = false }: HeatmapCalendarProps) {
  const { lang, t } = useLocale();
  const dateLocale = lang === 'zh' ? 'zh-CN' : 'en-US';

  const dayLabels = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(dateLocale, { weekday: 'short' });
    // Generate Mon-Sun labels using known dates (2024-01-01 is Monday)
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(2024, 0, 1 + i);
      return formatter.format(date);
    });
  }, [dateLocale]);

  const formatTooltip = (activity: DailyActivity): string => {
    const date = new Date(activity.date).toLocaleDateString(dateLocale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    const tokens = formatTokens(activity.tokens);
    const cost = `$${activity.cost.toFixed(2)}`;
    return `${date}, ${tokens} tokens, ${cost}`;
  };

  // Memoize the expensive week/month computation
  const weeks = useMemo(() => {
    const computedWeeks: (DailyActivity | null)[][] = [];
    let currentWeek: (DailyActivity | null)[] = [];

    // Pad the first week with nulls for days before the first activity
    if (activities.length > 0) {
      const firstDay = new Date(activities[0].date).getDay();
      const mondayBasedDay = firstDay === 0 ? 6 : firstDay - 1;
      for (let i = 0; i < mondayBasedDay; i++) {
        currentWeek.push(null);
      }
    }

    activities.forEach((activity) => {
      currentWeek.push(activity);
      if (currentWeek.length === 7) {
        computedWeeks.push([...currentWeek]);
        currentWeek = [];
      }
    });

    // Pad the last week
    if (currentWeek.length > 0) {
      while (currentWeek.length < 7) {
        currentWeek.push(null);
      }
      computedWeeks.push(currentWeek);
    }

    return computedWeeks;
  }, [activities]);

  const cellSize = 'w-3 h-3';
  const gapClass = 'gap-[3px]';

  if (compact) {
    const displayWeeks = weeks.slice(-COMPACT_WEEK_COUNT);
    return (
      <div className="heatmap-enter">
        <div className={`flex ${gapClass}`}>
          <div className={`flex ${gapClass} flex-1 overflow-x-auto`}>
            {displayWeeks.map((week, weekIndex) => (
              <div key={weekIndex} className={`flex flex-col ${gapClass}`}>
                {week.map((activity, dayIndex) =>
                  activity ? (
                    <div
                      key={activity.date}
                      role="button"
                      tabIndex={0}
                      aria-label={formatTooltip(activity)}
                      className={`${cellSize} rounded-sm hover:brightness-110 hover:ring-2 hover:ring-primary/40 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none cursor-pointer transition-[filter,box-shadow] duration-150 relative`}
                      style={LEVEL_STYLES[activity.level]}
                      title={formatTooltip(activity)}
                    >
                      <span className="absolute -inset-1.5" aria-hidden="true" />
                    </div>
                  ) : (
                    <div key={`empty-${weekIndex}-${dayIndex}`} className={cellSize} />
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <ExpandedHeatmap
      weeks={weeks}
      dayLabels={dayLabels}
      dateLocale={dateLocale}
      formatTooltip={formatTooltip}
      t={t}
    />
  );
}

/** Fits as many whole weeks as the container width allows, so the grid always fills its row. */
function ExpandedHeatmap({
  weeks,
  dayLabels,
  dateLocale,
  formatTooltip,
  t,
}: {
  weeks: ActivityWeek[];
  dayLabels: string[];
  dateLocale: string;
  formatTooltip: (activity: DailyActivity) => string;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    setWidth(node.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const fittedWeekCount = width > 0
    ? Math.floor((width - LABEL_COLUMN_PX + CELL_GAP_PX) / (MIN_CELL_PX + CELL_GAP_PX))
    : DEFAULT_WEEK_COUNT;
  const weekCount = Math.max(MIN_WEEK_COUNT, Math.min(MAX_WEEK_COUNT, fittedWeekCount, weeks.length || MIN_WEEK_COUNT));
  const displayWeeks = weeks.slice(-weekCount);
  const monthLabels = getMonthLabelsForWeeks(displayWeeks, dateLocale);

  return (
    <div ref={containerRef} className="heatmap-enter w-full min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-foreground">{t('analytics.activityHeatmap')}</span>
          <span className="text-xs text-muted-foreground">{t('analytics.recentWeeks', { count: displayWeeks.length })}</span>
        </div>
        <HeatmapLegend t={t} />
      </div>
      <HeatmapGrid
        weeks={displayWeeks}
        monthLabels={monthLabels}
        dayLabels={dayLabels}
        formatTooltip={formatTooltip}
      />
    </div>
  );
}

interface HeatmapGridProps {
  weeks: ActivityWeek[];
  monthLabels: { label: string; weekIndex: number; span: number }[];
  dayLabels: string[];
  formatTooltip: (activity: DailyActivity) => string;
}

function HeatmapGrid({ weeks, monthLabels, dayLabels, formatTooltip }: HeatmapGridProps) {
  const gridStyle: React.CSSProperties = {
    gridTemplateColumns: `${LABEL_COLUMN_PX}px repeat(${Math.max(weeks.length, 1)}, minmax(0, 1fr))`,
    gap: CELL_GAP_PX,
  };

  return (
    <>
      <div className="mb-1.5 grid text-[11px] text-muted-foreground" style={gridStyle}>
        <span aria-hidden="true" />
        {monthLabels.map(({ label, weekIndex, span }, i) => (
          <div
            key={i}
            className="min-w-0 overflow-visible whitespace-nowrap leading-none"
            style={{ gridColumn: `${weekIndex + 2} / span ${span}` }}
          >
            {/* A month that only touches one column has no room for its label */}
            {span >= 2 ? label : null}
          </div>
        ))}
      </div>

      <div className="grid" style={gridStyle}>
        {dayLabels.map((label, index) => (
          <div
            key={label}
            className="flex items-center text-[11px] leading-none text-muted-foreground"
            style={{ gridColumn: 1, gridRow: index + 1 }}
          >
            {index % 2 === 0 ? label : null}
          </div>
        ))}

        {weeks.map((week, weekIndex) => (
          week.map((activity, dayIndex) =>
            activity ? (
              <div
                key={activity.date}
                role="button"
                tabIndex={0}
                aria-label={formatTooltip(activity)}
                className="relative aspect-square w-full cursor-pointer rounded-[3px] transition-[filter,box-shadow] duration-150 hover:brightness-110 hover:ring-2 hover:ring-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                style={{
                  ...LEVEL_STYLES[activity.level],
                  gridColumn: weekIndex + 2,
                  gridRow: dayIndex + 1,
                }}
                title={formatTooltip(activity)}
              />
            ) : (
              <div
                key={`empty-${weekIndex}-${dayIndex}`}
                className="aspect-square w-full"
                style={{ gridColumn: weekIndex + 2, gridRow: dayIndex + 1 }}
              />
            ),
          )
        ))}
      </div>
    </>
  );
}

function HeatmapLegend({ t, className }: { t: (key: string) => string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 text-xs text-muted-foreground', className)}>
      <span>{t('analytics.legendLow')}</span>
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((level) => (
          <div
            key={level}
            className="h-3 w-3 rounded-[3px]"
            style={LEVEL_STYLES[level]}
          />
        ))}
      </div>
      <span>{t('analytics.legendHigh')}</span>
    </div>
  );
}
