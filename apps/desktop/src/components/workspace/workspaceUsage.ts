import type { SessionEventRecord } from '@/lib/tauri-ipc';

export interface SessionContextSnapshot {
  provider: string;
  usedTokens: number;
  maxTokens: number;
  rawMaxTokens: number | null;
  percentage: number;
  autoCompactThreshold: number | null;
  isAutoCompactEnabled: boolean;
  model: string;
  categories: Array<{ name: string; tokens: number }>;
}

export interface SessionUsageModelEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
}

export interface SessionRateLimitWindow {
  utilization: number | null;
  resetsAt: string | null;
}

/** Authoritative cumulative session usage snapshot from the SDK `/usage` query */
export interface SessionUsageSnapshot {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  modelUsage: SessionUsageModelEntry[];
  subscriptionType: string | null;
  rateLimitsAvailable: boolean;
  rateLimits: {
    fiveHour: SessionRateLimitWindow | null;
    sevenDay: SessionRateLimitWindow | null;
  } | null;
}

/** Aggregated OBSERVED routed usage per (logical key, env, model) — from
 *  router request-ledger events. Observational (upstream self-reported SSE),
 *  not a billing statement. */
export interface RoutedEnvUsage {
  /** Logical routing key (background / subagent:Explore / ...); '' when unknown */
  logicalKey: string;
  env: string;
  model: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Router request ledger rollup: observed rows + explicit unknown remainder. */
export interface RoutedUsageLedger {
  /** Rows aggregated over requests that CARRIED usage. */
  rows: RoutedEnvUsage[];
  /** Forwarded requests whose stream had no parseable usage — counted, not
   *  zero-filled, so they never silently vanish from the distribution. */
  unattributedCount: number;
  /** Incomplete streams (client cancel / upstream error mid-stream). */
  incompleteCount: number;
}

export interface SessionUsageState {
  /** Cumulative token consumption across all turns (event-derived) */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  /** Client-side cost estimate (Claude only) */
  estimatedCostUsd: number | null;
  /** Number of token_usage events seen */
  turnCount: number;
  /** Latest context window snapshot (Claude only, from context_usage events) */
  context: SessionContextSnapshot | null;
  /** Latest SDK session usage snapshot (from session_usage events, latest wins) */
  sessionUsage: SessionUsageSnapshot | null;
  /** Router request-ledger rollup for dynamically routed sessions (null when not routed) */
  routedLedger: RoutedUsageLedger | null;
}

const EMPTY_USAGE: SessionUsageState = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
  estimatedCostUsd: null,
  turnCount: 0,
  context: null,
  sessionUsage: null,
  routedLedger: null,
};

/**
 * Compute cumulative token usage and latest context window snapshot from session events.
 *
 * - Accumulates all `token_usage` events for total consumption.
 * - Takes the latest `context_usage` event as the current context window state.
 * - Does NOT derive context occupancy from cumulative tokens (they are different metrics).
 */
export function computeSessionUsage(events: SessionEventRecord[]): SessionUsageState {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let estimatedCostUsd: number | null = null;
  let turnCount = 0;
  let context: SessionContextSnapshot | null = null;
  let sessionUsage: SessionUsageSnapshot | null = null;
  // Router request ledger: request_id is the stable identity — replayed or
  // duplicated events collapse via last-write-wins, never double-count.
  const routedRequests = new Map<string, {
    logicalKey: string;
    env: string;
    model: string;
    complete: boolean;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    } | null;
  }>();

  for (const event of events) {
    const { payload } = event;

    if (payload.type === 'token_usage') {
      // Only count turn_total scope to avoid double-counting per-step + turn_total
      if (payload.scope === 'turn_total') {
        totalInputTokens += payload.input_tokens;
        totalOutputTokens += payload.output_tokens;
        totalCacheReadTokens += payload.cache_read_tokens;
        totalCacheCreationTokens += payload.cache_creation_tokens;
        turnCount++;
        if (typeof payload.total_cost_usd === 'number') {
          // turn_total cost is session-cumulative — latest event wins, never sum.
          // Crash/error results may carry a zeroed total; keep the last non-zero value.
          if (payload.total_cost_usd > 0 || estimatedCostUsd == null) {
            estimatedCostUsd = payload.total_cost_usd;
          }
        }
      } else if (!payload.scope && payload.provider !== 'claude') {
        // Codex events have no scope — always count them
        totalInputTokens += payload.input_tokens;
        totalOutputTokens += payload.output_tokens;
        totalCacheReadTokens += payload.cache_read_tokens;
        totalCacheCreationTokens += payload.cache_creation_tokens;
        turnCount++;
      }
      // Claude per-step events (no scope) are skipped to avoid double-counting with turn_total
    }

    if (payload.type === 'context_usage') {
      context = {
        provider: payload.provider,
        usedTokens: payload.used_tokens,
        maxTokens: payload.max_tokens,
        rawMaxTokens: payload.raw_max_tokens ?? null,
        percentage: Number.isFinite(payload.percentage)
          ? payload.percentage
          : payload.max_tokens > 0
            ? (payload.used_tokens / payload.max_tokens) * 100
            : 0,
        autoCompactThreshold: payload.auto_compact_threshold ?? null,
        isAutoCompactEnabled: payload.is_auto_compact_enabled,
        model: payload.model,
        categories: payload.categories,
      };
    }

    if (payload.type === 'routed_request') {
      // One ledger entry per forwarded request; request_id dedups replay.
      const usage = payload.usage
        ? {
            inputTokens: payload.usage.input_tokens,
            outputTokens: payload.usage.output_tokens,
            cacheReadTokens: payload.usage.cache_read_tokens,
            cacheCreationTokens: payload.usage.cache_creation_tokens,
          }
        : null;
      routedRequests.set(payload.request_id, {
        logicalKey: payload.logical_key ?? '',
        env: payload.target_env,
        model: payload.model ?? '',
        complete: payload.complete,
        usage,
      });
    }

    if (payload.type === 'session_usage') {
      // SDK snapshots are cumulative and authoritative — latest wins.
      sessionUsage = {
        provider: payload.provider,
        inputTokens: payload.input_tokens,
        outputTokens: payload.output_tokens,
        cacheReadTokens: payload.cache_read_tokens,
        cacheCreationTokens: payload.cache_creation_tokens,
        costUsd: payload.cost_usd ?? null,
        modelUsage: (payload.model_usage ?? []).map((entry) => ({
          model: entry.model,
          inputTokens: entry.input_tokens,
          outputTokens: entry.output_tokens,
          cacheReadTokens: entry.cache_read_tokens,
          cacheCreationTokens: entry.cache_creation_tokens,
          costUsd: entry.cost_usd ?? null,
        })),
        subscriptionType: payload.subscription_type ?? null,
        rateLimitsAvailable: payload.rate_limits_available === true,
        rateLimits: payload.rate_limits
          ? {
              fiveHour: payload.rate_limits.five_hour
                ? {
                    utilization: payload.rate_limits.five_hour.utilization,
                    resetsAt: payload.rate_limits.five_hour.resets_at,
                  }
                : null,
              sevenDay: payload.rate_limits.seven_day
                ? {
                    utilization: payload.rate_limits.seven_day.utilization,
                    resetsAt: payload.rate_limits.seven_day.resets_at,
                  }
                : null,
            }
          : null,
      };
    }
  }

  if (turnCount === 0 && !context && !sessionUsage && routedRequests.size === 0) {
    return EMPTY_USAGE;
  }

  // Roll up the ledger: rows only over usage-bearing requests; usage-less and
  // incomplete requests are counted explicitly, never zero-filled.
  let routedLedger: RoutedUsageLedger | null = null;
  if (routedRequests.size > 0) {
    const rows = new Map<string, RoutedEnvUsage>();
    let unattributedCount = 0;
    let incompleteCount = 0;
    for (const request of routedRequests.values()) {
      if (!request.complete) incompleteCount += 1;
      if (!request.usage) {
        unattributedCount += 1;
        continue;
      }
      const key = `${request.logicalKey} ${request.env} ${request.model}`;
      const row = rows.get(key) ?? {
        logicalKey: request.logicalKey,
        env: request.env,
        model: request.model,
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      row.requestCount += 1;
      row.inputTokens += request.usage.inputTokens;
      row.outputTokens += request.usage.outputTokens;
      row.cacheReadTokens += request.usage.cacheReadTokens;
      row.cacheCreationTokens += request.usage.cacheCreationTokens;
      rows.set(key, row);
    }
    routedLedger = {
      rows: [...rows.values()].sort(
        (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
      ),
      unattributedCount,
      incompleteCount,
    };
  }

  return {
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    estimatedCostUsd,
    turnCount,
    context,
    sessionUsage,
    routedLedger,
  };
}

/** Format token count for compact display (e.g. 84000 → "84K") */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(0)}K`;
  }
  return String(tokens);
}
