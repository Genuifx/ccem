import { invoke } from '@tauri-apps/api/core';
import type { ModelBreakdownHistory } from '@/types/analytics';

export type TimeGranularity = 'hour' | 'day' | 'week' | 'month';
export type AnalyticsUsageSource = 'all' | 'claude' | 'codex' | 'opencode' | 'dsh';

const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

interface CacheEntry {
  data?: ModelBreakdownHistory;
  revision: string;
  fetchedAt: number;
  promise?: Promise<ModelBreakdownHistory>;
}

const cache = new Map<string, CacheEntry>();

export function fetchModelBreakdown(
  source: AnalyticsUsageSource,
  granularity: TimeGranularity,
  revision: string,
): Promise<ModelBreakdownHistory> {
  const key = `${source}:${granularity}`;
  const cached = cache.get(key);
  if (cached?.revision === revision) {
    if (cached.data && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return Promise.resolve(cached.data);
    }
    if (cached.promise) return cached.promise;
  }

  let timeoutId: ReturnType<typeof setTimeout>;
  // A missing IPC reply must not poison this cache key with a pending promise
  // forever. The native scan may finish later, but only this bounded request
  // is allowed to publish its result.
  const response = new Promise<ModelBreakdownHistory>((resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Model breakdown request timed out')), REQUEST_TIMEOUT_MS);
    invoke<ModelBreakdownHistory>('get_usage_model_breakdown', {
      granularity,
      source: source === 'all' ? null : source,
    }).then(resolve, reject);
  });
  const request = response.then((data) => {
    if (cache.get(key)?.promise === request) {
      cache.set(key, { data, revision, fetchedAt: Date.now() });
    }
    return data;
  }).catch((error) => {
    if (cache.get(key)?.promise === request) {
      cache.delete(key);
    }
    throw error;
  }).finally(() => clearTimeout(timeoutId));

  cache.set(key, { revision, fetchedAt: 0, promise: request });
  return request;
}
