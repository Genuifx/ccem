import { useCallback, useEffect, useRef, useState } from 'react';
import {
  agyRuntimeErrorText,
  listAgyModels,
  type AgyModelCatalogItem,
} from '@/lib/agy-runtime';
import { AGY_RUNTIME_CHANGED_EVENT } from '@/hooks/useAgyRuntime';

type CachedAgyModelsState = {
  models: AgyModelCatalogItem[];
  defaultModel: string | null;
  fetchedAt: number;
};

const FRONTEND_CACHE_TTL_MS = 5 * 60 * 1000;
let sharedCache: CachedAgyModelsState | null = null;
let inflightRequest: Promise<CachedAgyModelsState> | null = null;
let cacheGeneration = 0;

async function fetchAgyModelsCached(forceRefresh: boolean): Promise<CachedAgyModelsState> {
  if (
    !forceRefresh
    && sharedCache
    && sharedCache.models.length > 0
    && Date.now() - sharedCache.fetchedAt < FRONTEND_CACHE_TTL_MS
  ) {
    return sharedCache;
  }
  if (!forceRefresh && inflightRequest) {
    return inflightRequest;
  }

  if (forceRefresh) {
    cacheGeneration += 1;
  }
  const requestGeneration = cacheGeneration;

  const request = listAgyModels(forceRefresh)
    .then((response) => {
      const next: CachedAgyModelsState = {
        models: Array.isArray(response.models) ? response.models : [],
        defaultModel: response.defaultModel ?? response.models?.[0]?.id ?? null,
        fetchedAt: Date.now(),
      };
      if (next.models.length > 0 && requestGeneration === cacheGeneration) {
        sharedCache = next;
      }
      return next;
    })
    .finally(() => {
      if (inflightRequest === request) {
        inflightRequest = null;
      }
    });

  inflightRequest = request;
  return request;
}

export function clearAgyModelsFrontendCache() {
  cacheGeneration += 1;
  sharedCache = null;
}

export function useAgyModels(enabled: boolean) {
  const [models, setModels] = useState<AgyModelCatalogItem[]>(() => sharedCache?.models ?? []);
  const [defaultModel, setDefaultModel] = useState<string | null>(() => sharedCache?.defaultModel ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const requestSeqRef = useRef(0);

  const refresh = useCallback(async (forceRefresh = false) => {
    if (!enabled) {
      return null;
    }
    const seq = ++requestSeqRef.current;
    setLoading(true);
    try {
      const next = await fetchAgyModelsCached(forceRefresh);
      if (mountedRef.current && seq === requestSeqRef.current) {
        setModels(next.models);
        setDefaultModel(next.defaultModel);
        setError(null);
      }
      return next;
    } catch (failure) {
      if (mountedRef.current && seq === requestSeqRef.current) {
        setError(agyRuntimeErrorText(failure) || String(failure));
      }
      return null;
    } finally {
      if (mountedRef.current && seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [enabled]);

  useEffect(() => {
    mountedRef.current = true;
    if (enabled) {
      void refresh(false);
    }
    const handleRuntimeChanged = () => {
      clearAgyModelsFrontendCache();
      if (enabled) {
        void refresh(true);
      }
    };
    window.addEventListener(AGY_RUNTIME_CHANGED_EVENT, handleRuntimeChanged);
    return () => {
      mountedRef.current = false;
      requestSeqRef.current += 1;
      window.removeEventListener(AGY_RUNTIME_CHANGED_EVENT, handleRuntimeChanged);
    };
  }, [enabled, refresh]);

  return { models, defaultModel, loading, error, refresh };
}
