import { RotateCw } from '@/lib/lucide-react';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import type { SessionUsageModelEntry, SessionUsageState } from './workspaceUsage';
import { formatTokenCount } from './workspaceUsage';

interface SessionUsagePopoverContentProps {
  usage: SessionUsageState;
  provider?: string;
  onRefresh?: () => void;
}

function barColor(percentage: number): string {
  if (percentage >= 90) return 'bg-destructive';
  if (percentage >= 70) return 'bg-warning';
  return 'bg-primary/80';
}

function UsageRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="text-[12px] font-medium text-foreground tabular-nums">
        {value}
        {hint && (
          <span className="ml-1 font-normal text-muted-foreground/70">{hint}</span>
        )}
      </span>
    </div>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
      {children}
    </div>
  );
}

const MODEL_ROWS_LIMIT = 4;

function buildModelRows(modelUsage: SessionUsageModelEntry[]) {
  const sorted = [...modelUsage].sort((a, b) => b.inputTokens - a.inputTokens);
  if (sorted.length <= MODEL_ROWS_LIMIT) {
    return sorted;
  }

  const shown = sorted.slice(0, MODEL_ROWS_LIMIT - 1);
  const rest = sorted.slice(MODEL_ROWS_LIMIT - 1);
  const other: SessionUsageModelEntry = {
    model: '',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: null,
  };
  for (const entry of rest) {
    other.inputTokens += entry.inputTokens;
    other.outputTokens += entry.outputTokens;
    other.cacheReadTokens += entry.cacheReadTokens;
    other.cacheCreationTokens += entry.cacheCreationTokens;
    if (other.costUsd !== null || entry.costUsd !== null) {
      other.costUsd = (other.costUsd ?? 0) + (entry.costUsd ?? 0);
    }
  }
  return [...shown, other];
}

export function SessionUsagePopoverContent({
  usage,
  provider,
  onRefresh,
}: SessionUsagePopoverContentProps) {
  const { t } = useLocale();

  const snapshot = usage.sessionUsage;
  const inputTokens = snapshot?.inputTokens ?? usage.totalInputTokens;
  const outputTokens = snapshot?.outputTokens ?? usage.totalOutputTokens;
  const cacheReadTokens = snapshot?.cacheReadTokens ?? usage.totalCacheReadTokens;
  const cacheCreationTokens = snapshot?.cacheCreationTokens ?? usage.totalCacheCreationTokens;
  const costUsd = snapshot?.costUsd ?? usage.estimatedCostUsd;

  const cacheBase = cacheReadTokens + inputTokens;
  const cacheHitPercent = cacheBase > 0
    ? Math.round((cacheReadTokens / cacheBase) * 100)
    : null;

  const hasTotals = inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0;
  const hasContext = usage.context !== null;
  const hasModelUsage = (snapshot?.modelUsage.length ?? 0) > 0;
  const hasRateLimits = snapshot?.rateLimitsAvailable === true
    && snapshot?.rateLimits !== null
    && (snapshot!.rateLimits!.fiveHour?.utilization != null
      || snapshot!.rateLimits!.sevenDay?.utilization != null);
  const isEmpty = !hasTotals && !hasContext && !hasModelUsage && !hasRateLimits;

  const modelRows = hasModelUsage ? buildModelRows(snapshot!.modelUsage) : [];

  const rateLimitRows = hasRateLimits
    ? ([
        { key: 'fiveHour', label: t('workspace.usagePanelFiveHour'), window: snapshot!.rateLimits!.fiveHour },
        { key: 'sevenDay', label: t('workspace.usagePanelSevenDay'), window: snapshot!.rateLimits!.sevenDay },
      ] as const).filter((entry) => entry.window?.utilization != null)
    : [];

  return (
    <div className="w-[268px] space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
          {t('workspace.usagePanelTitle')}
        </span>
        {provider === 'claude' && onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            aria-label={t('workspace.usagePanelRefresh')}
            className={cn(
              'inline-flex h-6 w-6 items-center justify-center rounded-full',
              'text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground',
              'active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
            )}
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {isEmpty && (
        <div className="text-[12px] leading-5 text-muted-foreground">
          {t('workspace.usagePanelEmpty')}
        </div>
      )}

      {hasContext && (
        <div className="space-y-1.5">
          <SectionTitle>{t('workspace.contextUsed')}</SectionTitle>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[12px] text-muted-foreground">
              {t('workspace.contextUsageLine')
                .replace('{used}', formatTokenCount(usage.context!.usedTokens).toLowerCase())
                .replace('{total}', formatTokenCount(usage.context!.maxTokens).toLowerCase())}
            </span>
            <span className="text-[12px] font-semibold text-foreground tabular-nums">
              {Math.round(Math.max(0, Math.min(100, usage.context!.percentage)))}%
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted/60">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500',
                barColor(usage.context!.percentage),
              )}
              style={{ width: `${Math.max(0, Math.min(100, usage.context!.percentage))}%` }}
            />
          </div>
          <div className="text-[11px] text-muted-foreground/80">
            {usage.context!.isAutoCompactEnabled
              ? t('workspace.contextAutoCompactEnabled')
              : t('workspace.contextAutoCompactDisabled')}
          </div>
        </div>
      )}

      {hasTotals && (
        <div className="space-y-1">
          <SectionTitle>{t('workspace.usagePanelTitle')}</SectionTitle>
          <UsageRow
            label={t('workspace.contextInputTokens')}
            value={formatTokenCount(inputTokens)}
          />
          <UsageRow
            label={t('workspace.contextOutputTokens')}
            value={formatTokenCount(outputTokens)}
          />
          <UsageRow
            label={t('workspace.contextCacheRead')}
            value={formatTokenCount(cacheReadTokens)}
            hint={cacheHitPercent !== null
              ? t('workspace.usagePanelCacheHitRate').replace('{percent}', String(cacheHitPercent))
              : undefined}
          />
          <UsageRow
            label={t('workspace.usagePanelCacheWrite')}
            value={formatTokenCount(cacheCreationTokens)}
          />
          {costUsd !== null && (
            <UsageRow
              label={t('workspace.contextCost')}
              value={`$${costUsd.toFixed(2)}`}
            />
          )}
        </div>
      )}

      {hasModelUsage && (
        <div className="space-y-1">
          <SectionTitle>{t('workspace.usagePanelModels')}</SectionTitle>
          {modelRows.map((entry, index) => (
            <UsageRow
              key={entry.model || `other-${index}`}
              label={entry.model || t('workspace.usagePanelOther')}
              value={formatTokenCount(entry.inputTokens + entry.outputTokens)}
            />
          ))}
        </div>
      )}

      {hasRateLimits && (
        <div className="space-y-1.5">
          <SectionTitle>{t('workspace.usagePanelRateLimit')}</SectionTitle>
          {rateLimitRows.map((entry) => {
            const utilization = Math.max(0, Math.min(100, entry.window!.utilization!));
            return (
              <div key={entry.key} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] text-muted-foreground">{entry.label}</span>
                  <span className="text-[12px] font-medium text-foreground tabular-nums">
                    {Math.round(utilization)}%
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-muted/60">
                  <div
                    className={cn('h-full rounded-full transition-all duration-500', barColor(utilization))}
                    style={{ width: `${utilization}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
