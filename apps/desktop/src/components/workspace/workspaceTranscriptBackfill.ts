import type { ReplayBatch, SessionEventRecord } from '@/lib/tauri-ipc';

export type TranscriptBackfillResult<T> =
  | { status: 'success'; attempts: number; value: T }
  | { status: 'partial'; attempts: number; value: T }
  | { status: 'error'; attempts: number; error: unknown }
  | { status: 'cancelled'; attempts: number };

interface TranscriptBackfillOptions<T> {
  load: () => Promise<T>;
  isComplete: (value: T) => boolean;
  physicalRequestKey?: string;
  retryDelaysMs?: readonly number[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_RETRY_DELAYS_MS = [350, 1_000] as const;
const DEFAULT_TIMEOUT_MS = 8_000;
const physicalBackfillReads = new Map<string, Promise<unknown>>();

class TranscriptBackfillTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Transcript backfill timed out after ${timeoutMs}ms`);
    this.name = 'TranscriptBackfillTimeoutError';
  }
}

function cancelledError() {
  return new DOMException('Transcript backfill was cancelled', 'AbortError');
}

function isCancelled(error: unknown, signal?: AbortSignal) {
  return signal?.aborted === true
    || (error instanceof DOMException && error.name === 'AbortError');
}

function runWithTimeout<T>(
  load: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }

    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener('abort', handleAbort);
      callback();
    };
    const handleAbort = () => finish(() => reject(cancelledError()));
    const timeoutId = globalThis.setTimeout(() => {
      finish(() => reject(new TranscriptBackfillTimeoutError(timeoutMs)));
    }, timeoutMs);

    signal?.addEventListener('abort', handleAbort, { once: true });
    Promise.resolve()
      .then(load)
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
  });
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }

    const handleAbort = () => {
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener('abort', handleAbort);
      reject(cancelledError());
    };
    const timeoutId = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, Math.max(0, delayMs));
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

function acquirePhysicalBackfillRead<T>(
  requestKey: string | undefined,
  load: () => Promise<T>,
): Promise<T> {
  if (!requestKey) {
    return Promise.resolve().then(load);
  }

  const activeRead = physicalBackfillReads.get(requestKey);
  if (activeRead) {
    return activeRead as Promise<T>;
  }

  const nextRead = Promise.resolve().then(load);
  physicalBackfillReads.set(requestKey, nextRead);
  nextRead.then(
    () => {
      if (physicalBackfillReads.get(requestKey) === nextRead) {
        physicalBackfillReads.delete(requestKey);
      }
    },
    () => {
      if (physicalBackfillReads.get(requestKey) === nextRead) {
        physicalBackfillReads.delete(requestKey);
      }
    },
  );
  return nextRead;
}

export async function runTranscriptBackfillWithRetry<T>({
  load,
  isComplete,
  physicalRequestKey,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
}: TranscriptBackfillOptions<T>): Promise<TranscriptBackfillResult<T>> {
  let attempts = 0;
  let lastError: unknown = new Error('Transcript backfill failed');

  for (let attemptIndex = 0; attemptIndex <= retryDelaysMs.length; attemptIndex += 1) {
    if (signal?.aborted) {
      return { status: 'cancelled', attempts };
    }

    attempts += 1;
    try {
      const value = await runWithTimeout(
        () => acquirePhysicalBackfillRead(physicalRequestKey, load),
        timeoutMs,
        signal,
      );
      if (!isComplete(value)) {
        return { status: 'partial', attempts, value };
      }
      return { status: 'success', attempts, value };
    } catch (error) {
      if (isCancelled(error, signal)) {
        return { status: 'cancelled', attempts };
      }
      lastError = error;
      // Tauri invoke has no cancellation channel. A timed-out read may still
      // be running in Rust, so an automatic retry would stack physical full
      // replays. End this round; an explicit Retry reuses the per-runtime
      // physical lease until that read actually settles.
      if (error instanceof TranscriptBackfillTimeoutError) {
        break;
      }
    }

    const retryDelay = retryDelaysMs[attemptIndex];
    if (retryDelay == null) {
      break;
    }
    try {
      await waitForRetry(retryDelay, signal);
    } catch (error) {
      if (isCancelled(error, signal)) {
        return { status: 'cancelled', attempts };
      }
      lastError = error;
    }
  }

  return { status: 'error', attempts, error: lastError };
}

export function reconcileCompleteReplayEvents(
  completeReplay: SessionEventRecord[],
  currentEvents: SessionEventRecord[],
  replaySnapshotNewestSeq?: number | null,
): SessionEventRecord[] {
  const lastReplayEvent = completeReplay[completeReplay.length - 1];
  if (!lastReplayEvent) {
    return [];
  }

  const seenSeqs = new Set(completeReplay.map((event) => event.seq));
  const snapshotNewestSeq = replaySnapshotNewestSeq ?? lastReplayEvent.seq;
  const newerLiveEvents = currentEvents
    .filter((event) => (
      event.runtime_id === lastReplayEvent.runtime_id
      && event.seq > snapshotNewestSeq
      && !seenSeqs.has(event.seq)
    ))
    .sort((left, right) => left.seq - right.seq);

  return [...completeReplay, ...newerLiveEvents];
}

function mergeReadableFallbackEvents(
  currentEvents: SessionEventRecord[],
  fallbackEvents: SessionEventRecord[],
): SessionEventRecord[] {
  const merged = new Map<string, SessionEventRecord>();
  for (const event of currentEvents) {
    merged.set(`${event.runtime_id}:${event.seq}`, event);
  }
  for (const event of fallbackEvents) {
    merged.set(`${event.runtime_id}:${event.seq}`, event);
  }
  return Array.from(merged.values()).sort((left, right) => (
    left.runtime_id === right.runtime_id
      ? left.seq - right.seq
      : left.runtime_id.localeCompare(right.runtime_id)
  ));
}

export function resolveTranscriptBackfillReplay(
  status: 'success' | 'partial',
  replayBatch: ReplayBatch,
  currentEvents: SessionEventRecord[],
  requestStartNewestSeq?: number | null,
) {
  const persistedSourceUnavailable = replayBatch.source_available === false;
  const decodedNoEvents = status === 'partial' && replayBatch.events.length === 0;
  const events = persistedSourceUnavailable
    ? mergeReadableFallbackEvents(currentEvents, replayBatch.events)
    : decodedNoEvents
    ? currentEvents
    : status === 'success'
      && replayBatch.events.length === 0
      && requestStartNewestSeq !== undefined
      ? currentEvents.filter((event) => (
        requestStartNewestSeq == null || event.seq > requestStartNewestSeq
      ))
    : reconcileCompleteReplayEvents(
      replayBatch.events,
      currentEvents,
      replayBatch.newest_available_seq,
    );

  return {
    events,
    state: status === 'partial' || persistedSourceUnavailable
      ? 'partial' as const
      : 'idle' as const,
    // Once a full read decodes rows, any remaining gap is real and the
    // persistent partial status covers missing head/tail rows. If it decodes
    // nothing, keep cached seam suppression with the readable cached tail.
    clearProvisionalGaps: !decodedNoEvents && !persistedSourceUnavailable,
    // Keep the expanded cache intact while persisted history is unavailable.
    // A later authoritative full replay may safely settle and prune the tail.
    rawTailSettled: !persistedSourceUnavailable,
  };
}

export function createTranscriptBackfillEventUpdate(
  status: 'success' | 'partial',
  replayBatch: ReplayBatch,
  requestStartNewestSeq?: number | null,
) {
  return (currentEvents: SessionEventRecord[]) => (
    resolveTranscriptBackfillReplay(
      status,
      replayBatch,
      currentEvents,
      requestStartNewestSeq,
    ).events
  );
}

export function inspectIncrementalTranscriptReplay(replayBatch: ReplayBatch) {
  const partial = replayBatch.source_available === false
    || replayBatch.truncated
    || replayBatch.gap_detected;
  const newestDecodedSeq = replayBatch.events.reduce<number | null>(
    (newest, event) => newest == null ? event.seq : Math.max(newest, event.seq),
    null,
  );
  const acknowledgedSeq = partial && replayBatch.newest_available_seq != null
    ? Math.max(newestDecodedSeq ?? replayBatch.newest_available_seq, replayBatch.newest_available_seq)
    : newestDecodedSeq;

  return {
    state: partial ? 'partial' as const : 'idle' as const,
    acknowledgedSeq,
  };
}

export interface TranscriptPartialObservation {
  version: number;
  throughSeq: number | null;
  unknownRange: boolean;
}

export function markTranscriptPartialObservation(
  current: TranscriptPartialObservation,
  throughSeq: number | null,
): TranscriptPartialObservation {
  return {
    version: current.version + 1,
    throughSeq: throughSeq == null
      ? current.throughSeq
      : Math.max(current.throughSeq ?? throughSeq, throughSeq),
    unknownRange: current.unknownRange || throughSeq == null,
  };
}

export function resolveTranscriptBackfillPresentation(
  status: 'success' | 'partial',
  replayCursor: number | null,
  partialVersionAtRequestStart: number,
  currentPartial: TranscriptPartialObservation,
) {
  if (status === 'partial') {
    return {
      state: 'partial' as const,
      partialObservation: markTranscriptPartialObservation(currentPartial, replayCursor),
    };
  }

  const partialArrivedDuringRequest = currentPartial.version !== partialVersionAtRequestStart;
  const partialExtendsPastReplay = currentPartial.unknownRange
    || (
      currentPartial.throughSeq != null
      && (replayCursor == null || currentPartial.throughSeq > replayCursor)
    );
  if (partialArrivedDuringRequest && partialExtendsPastReplay) {
    return {
      state: 'partial' as const,
      partialObservation: currentPartial,
    };
  }

  return {
    state: 'idle' as const,
    partialObservation: {
      version: currentPartial.version,
      throughSeq: null,
      unknownRange: false,
    },
  };
}
