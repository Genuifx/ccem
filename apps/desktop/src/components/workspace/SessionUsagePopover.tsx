import { useState } from 'react';
import { RotateCw } from '@/lib/lucide-react';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import type { SessionContextSnapshot, SessionUsageModelEntry, SessionUsageState } from './workspaceUsage';
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

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
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
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium font-mono tabular-nums text-foreground">
        {value}
        {hint && (
          <span className="ml-1 font-sans font-normal text-muted-foreground/70">{hint}</span>
        )}
      </span>
    </div>
  );
}

/** App-wide section label idiom (ComposerControls / MetricCard): 2xs tracked caps on /70 muted. */
function SectionTitle({ children }: { children: string }) {
  return (
    <div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground/70">
      {children}
    </div>
  );
}

const MODEL_ROWS_LIMIT = 4;

/** Human label for a sub-route logical key: `subagent:Explore` → `Explore`,
 * `background` → the localized background label, '' → explicit/unclassified
 * route override (main-thread entries never reach these rows). */
function routedRowLabel(t: (k: string) => string, logicalKey: string): string {
  if (logicalKey.startsWith('subagent:')) return logicalKey.slice('subagent:'.length);
  if (logicalKey === 'background') return t('router.background');
  if (logicalKey === 'subagent:*') return t('router.subagentAny');
  return t('workspace.usagePanelSubRouteOther');
}

/** Upstream context-composition category that reports the unused window
 * remainder — rendered muted, like upstream /context. */
const FREE_SPACE_CATEGORY = 'Free space';

/** Category names are open strings from upstream (new names ship ahead of
 * locale updates); known ones map to localized labels, anything else renders
 * verbatim. */
const CATEGORY_LABEL_KEYS: Record<string, string> = {
  'System prompt': 'workspace.contextCategorySystemPrompt',
  'System tools': 'workspace.contextCategorySystemTools',
  'MCP tools': 'workspace.contextCategoryMcpTools',
  'Custom agents': 'workspace.contextCategoryCustomAgents',
  'Memory files': 'workspace.contextCategoryMemoryFiles',
  Skills: 'workspace.contextCategorySkills',
  Messages: 'workspace.contextCategoryMessages',
  Attachments: 'workspace.contextCategoryAttachments',
  'Output style': 'workspace.contextCategoryOutputStyle',
  'Compact summary': 'workspace.contextCategoryCompactSummary',
  'Autocompact buffer': 'workspace.contextCategoryAutocompactBuffer',
  'Free space': 'workspace.contextCategoryFreeSpace',
  input: 'workspace.contextCategoryInput',
  output: 'workspace.contextCategoryOutput',
};

const CHART_SEGMENT_CLASSES = [
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
  'bg-chart-6',
];

interface CompositionRow {
  name: string;
  label: string;
  tokens: number;
  /** Share of the full context window (0–100, unrounded). */
  percent: number;
  colorClass: string;
  isFreeSpace: boolean;
}

/** Build the composition rows: used categories in upstream order (stable
 * chart colors) plus the muted free-space remainder when the provider reports
 * it. Percentages are relative to the context window — the same base as the
 * usage view's context bar and upstream /context, so the two views stay
 * comparable. */
function buildCompositionRows(
  t: (k: string) => string,
  context: SessionContextSnapshot,
): { rows: CompositionRow[]; hasData: boolean } {
  const categories = context.categories ?? [];
  const denominator = context.maxTokens > 0 ? context.maxTokens : 0;
  const percentOfWindow = (tokens: number) =>
    denominator > 0 ? (tokens / denominator) * 100 : 0;

  const rows: CompositionRow[] = [];
  let colorIndex = 0;
  for (const category of categories) {
    if (category.tokens <= 0) continue;
    const isFreeSpace = category.name === FREE_SPACE_CATEGORY;
    rows.push({
      name: category.name,
      label: CATEGORY_LABEL_KEYS[category.name]
        ? t(CATEGORY_LABEL_KEYS[category.name])
        : category.name,
      tokens: category.tokens,
      percent: percentOfWindow(category.tokens),
      colorClass: isFreeSpace
        ? 'bg-muted'
        : CHART_SEGMENT_CLASSES[colorIndex++ % CHART_SEGMENT_CLASSES.length],
      isFreeSpace,
    });
  }
  return { rows, hasData: rows.length > 0 };
}

/** Secondary panel view: current context composition breakdown (REQ-0028).
 * Shares the usage view's overall used/total line idiom so the drill-down
 * reads as another aperture of the same snapshot, never a second total. */
export function ContextCompositionView({ context }: { context: SessionContextSnapshot }) {
  const { t } = useLocale();
  const { rows, hasData } = buildCompositionRows(t, context);
  const contextPercent = clampPercent(context.percentage);

  return (
    <div className="space-y-2 px-4 py-2.5">
      <SectionTitle>{t('workspace.contextCompositionTitle')}</SectionTitle>
      {!hasData ? (
        <div className="pb-1 text-xs leading-5 text-muted-foreground">
          {t('workspace.contextCompositionEmpty')}
        </div>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {t('workspace.contextUsageLine')
                .replace('{used}', formatTokenCount(context.usedTokens).toLowerCase())
                .replace('{total}', formatTokenCount(context.maxTokens).toLowerCase())}
            </span>
            <span className="text-xs font-semibold font-mono tabular-nums text-foreground">
              {Math.round(contextPercent)}%
            </span>
          </div>
          <div
            className="flex h-2 items-stretch gap-[2px] overflow-hidden rounded-full bg-muted/60"
            aria-label={t('workspace.contextCompositionTitle')}
          >
            {rows.map((row) => (
              <div
                key={`segment-${row.name}`}
                className={cn('h-full rounded-[2px]', row.colorClass)}
                style={{ width: `${row.percent}%` }}
                title={`${row.label} · ${formatTokenCount(row.tokens)}`}
              />
            ))}
          </div>
          <div className="space-y-1">
            {rows.map((row) => (
              <div
                key={`row-${row.name}`}
                className={cn(
                  'flex items-center gap-2',
                  row.isFreeSpace && 'mt-1.5 border-t border-border/35 pt-1.5',
                )}
              >
                <span
                  className={cn('h-2 w-2 shrink-0 rounded-full', row.colorClass)}
                  aria-hidden="true"
                />
                <span
                  className={cn(
                    'min-w-0 truncate text-xs',
                    row.isFreeSpace ? 'text-muted-foreground/80' : 'text-muted-foreground',
                  )}
                >
                  {row.label}
                </span>
                <span className="ml-auto flex shrink-0 items-baseline font-mono tabular-nums">
                  <span
                    className={cn(
                      'min-w-[2.75rem] text-right text-xs font-medium',
                      row.isFreeSpace ? 'text-muted-foreground/80' : 'text-foreground',
                    )}
                  >
                    {formatTokenCount(row.tokens)}
                  </span>
                  <span className="min-w-[2.5rem] text-right text-xs text-muted-foreground/75">
                    {row.percent.toFixed(1)}%
                  </span>
                </span>
              </div>
            ))}
          </div>
          <div className="pt-0.5 text-2xs leading-4 text-muted-foreground/70">
            {t('workspace.contextCompositionFootnote')}
          </div>
        </>
      )}
    </div>
  );
}

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
  // Secondary view state (REQ-0028). The popover content unmounts when the
  // hover closes, so every open starts on the usage view — no stale drill-down.
  const [view, setView] = useState<'usage' | 'composition'>('usage');

  const snapshot = usage.sessionUsage;
  // The SDK snapshot can lag one turn behind (transcript flush timing), while
  // event-derived totals are per-turn complete. Both converge to the same
  // session totals, so per-field max keeps the panel fresh without inflating.
  const inputTokens = Math.max(snapshot?.inputTokens ?? 0, usage.totalInputTokens);
  const outputTokens = Math.max(snapshot?.outputTokens ?? 0, usage.totalOutputTokens);
  const cacheReadTokens = Math.max(snapshot?.cacheReadTokens ?? 0, usage.totalCacheReadTokens);
  const cacheCreationTokens = Math.max(snapshot?.cacheCreationTokens ?? 0, usage.totalCacheCreationTokens);
  const costUsd = snapshot?.costUsd != null || usage.estimatedCostUsd != null
    ? Math.max(snapshot?.costUsd ?? 0, usage.estimatedCostUsd ?? 0)
    : null;

  const cacheBase = cacheReadTokens + inputTokens;
  const cacheHitPercent = cacheBase > 0
    ? Math.round((cacheReadTokens / cacheBase) * 100)
    : null;

  const hasTotals = inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0;
  const hasContext = usage.context !== null;
  const ledger = usage.routedLedger;
  // Two INDEPENDENT sections per the usage data contract: the session total
  // comes from the SDK snapshot (product-chosen primary aperture); the router
  // ledger below is a separate sub-route observation. They are never summed,
  // reconciled, or substituted for one another.
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

  const contextPercent = hasContext ? clampPercent(usage.context!.percentage) : 0;

  return (
    <div className="[&>*+*]:border-t [&>*+*]:border-border/35 [&>*:nth-child(2)]:border-t-0">
      <div className="flex items-center justify-between gap-2 px-4 pb-2.5 pt-3">
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

      {hasContext && (
        <div className="px-4 pb-2.5">
          <div className="grid grid-cols-2 gap-0.5 rounded-lg bg-muted/60 p-0.5">
            {([
              ['usage', t('workspace.usagePanelViewUsage')],
              ['composition', t('workspace.usagePanelViewComposition')],
            ] as const).map(([nextView, label]) => (
              <button
                key={nextView}
                type="button"
                aria-pressed={view === nextView}
                onClick={() => setView(nextView)}
                className={cn(
                  'rounded-md px-2 py-1 text-xs font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
                  view === nextView
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {isEmpty && (
        <div className="px-4 py-3 text-xs leading-5 text-muted-foreground">
          {t('workspace.usagePanelEmpty')}
        </div>
      )}

      {view === 'composition' && hasContext ? (
        <ContextCompositionView context={usage.context!} />
      ) : (
        <>

      {hasContext && (
        <div className="space-y-1.5 px-4 py-2.5">
          <SectionTitle>{t('workspace.contextUsed')}</SectionTitle>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {t('workspace.contextUsageLine')
                .replace('{used}', formatTokenCount(usage.context!.usedTokens).toLowerCase())
                .replace('{total}', formatTokenCount(usage.context!.maxTokens).toLowerCase())}
            </span>
            <span className="text-xs font-semibold font-mono tabular-nums text-foreground">
              {Math.round(contextPercent)}%
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted/60">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500',
                barColor(contextPercent),
              )}
              style={{ width: `${contextPercent}%` }}
            />
          </div>
          <div className="text-2xs text-muted-foreground/70">
            {usage.context!.isAutoCompactEnabled
              ? t('workspace.contextAutoCompactEnabled')
              : t('workspace.contextAutoCompactDisabled')}
          </div>
        </div>
      )}

      {hasTotals && (
        <div className="space-y-1 px-4 py-2.5">
          <SectionTitle>{t('workspace.usagePanelSdkTotals')}</SectionTitle>
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
        <div className="space-y-1 px-4 py-2.5">
          <SectionTitle>{t('workspace.usagePanelSdkModels')}</SectionTitle>
          {modelRows.map((entry, index) => (
            <UsageRow
              key={entry.model || `other-${index}`}
              label={entry.model || t('workspace.usagePanelOther')}
              value={formatTokenCount(entry.inputTokens + entry.outputTokens)}
            />
          ))}
        </div>
      )}

      {ledger && (
        <div className="space-y-1 px-4 py-2.5">
          <SectionTitle>{t('workspace.usagePanelSubRoute')}</SectionTitle>
          {ledger.rows.map((entry) => (
            <UsageRow
              key={`${entry.logicalKey}-${entry.env}-${entry.model}`}
              label={`${routedRowLabel(t, entry.logicalKey)} · ${entry.env}`}
              value={formatTokenCount(entry.inputTokens + entry.outputTokens)}
              hint={t('workspace.usagePanelRequestCount').replace('{count}', String(entry.requestCount))}
            />
          ))}
          {ledger.unattributedCount > 0 && (
            <UsageRow
              key="routed-unattributed"
              label={t('workspace.usagePanelSubRouteUnreported')}
              value={`${ledger.unattributedCount}`}
            />
          )}
          {ledger.incompleteCount > 0 && (
            <UsageRow
              key="routed-incomplete"
              label={t('workspace.usagePanelSubRouteIncomplete')}
              value={`${ledger.incompleteCount}`}
            />
          )}
          <div className="pt-0.5 text-2xs leading-4 text-muted-foreground/70">
            {t('workspace.usagePanelSubRouteFootnote')}
          </div>
        </div>
      )}

      {hasRateLimits && (
        <div className="space-y-2 px-4 py-2.5">
          <SectionTitle>{t('workspace.usagePanelRateLimit')}</SectionTitle>
          {rateLimitRows.map((entry) => {
            const utilization = clampPercent(entry.window!.utilization!);
            return (
              <div key={entry.key} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{entry.label}</span>
                  <span className="text-xs font-medium font-mono tabular-nums text-foreground">
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
        </>
      )}
    </div>
  );
}
