import type {
  NativeEventReplayPage,
  ReplayBatch,
  SessionEventRecord,
} from '@/lib/tauri-ipc';

export type TranscriptBackfillResult<T> =
  | { status: 'success'; attempts: number; value: T }
  | { status: 'partial'; attempts: number; value: T }
  | { status: 'error'; attempts: number; error: unknown }
  | { status: 'cancelled'; attempts: number };

export interface TranscriptBackfillCommitIdentity {
  runtimeId: string;
  generation: number;
  commitId: number;
}

export function transcriptBackfillCommitMatches(
  pending: TranscriptBackfillCommitIdentity | null,
  committed: TranscriptBackfillCommitIdentity | null,
): boolean {
  return Boolean(
    pending
    && committed
    && pending.runtimeId === committed.runtimeId
    && pending.generation === committed.generation
    && pending.commitId === committed.commitId
  );
}

export function resolveCommittedReplayCursor(
  current: number | null,
  acknowledgedSeq: number | null,
  reset: boolean,
): number | null {
  const base = reset ? null : current;
  return acknowledgedSeq == null
    ? base
    : Math.max(base ?? acknowledgedSeq, acknowledgedSeq);
}

export function deriveTranscriptBackfillHideDisposition({
  runtimeId,
  activeRequestRuntimeId,
  pendingCommit,
  committedMarker,
  rawTailSettled,
}: {
  runtimeId: string;
  activeRequestRuntimeId: string | null;
  pendingCommit: TranscriptBackfillCommitIdentity | null;
  committedMarker: TranscriptBackfillCommitIdentity | null;
  rawTailSettled: boolean;
}): {
  pendingCommitLanded: boolean;
  mustRestartInitialReplay: boolean;
} {
  const pendingCommitLanded = transcriptBackfillCommitMatches(
    pendingCommit,
    committedMarker,
  );
  return {
    pendingCommitLanded,
    mustRestartInitialReplay: activeRequestRuntimeId === runtimeId
      || Boolean(pendingCommit && !pendingCommitLanded)
      || !rawTailSettled,
  };
}

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
const DEFAULT_MAX_BACKFILL_PAGES = 100_000;
export const NATIVE_TRANSCRIPT_REPLAY_PAGE_LIMIT = 2_000;

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

interface TranscriptPagedBackfillOptions {
  loadPage: (
    afterSeq: number | null,
    snapshotNewestSeq: number | null,
  ) => Promise<NativeEventReplayPage>;
  isComplete: (value: ReplayBatch) => boolean;
  initialAfterSeq?: number | null;
  physicalRequestKey?: string;
  retryDelaysMs?: readonly number[];
  timeoutMs?: number;
  maxPages?: number;
  signal?: AbortSignal;
  yieldBetweenPages?: () => Promise<void>;
}

function defaultPageYield(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

/**
 * Recover a fixed native-event snapshot through bounded keyset pages.
 *
 * Pages stay outside React state until the snapshot is complete. Publishing a
 * prepended page at a time would force every transcript/usage/review fold to
 * reset repeatedly (quadratic work) and could split one streaming message at
 * an arbitrary page boundary. The final ReplayBatch therefore preserves the
 * exact semantics of the previous authoritative full replay without its
 * unbounded IPC response.
 */
export async function runTranscriptPagedBackfill({
  loadPage,
  isComplete,
  initialAfterSeq = null,
  physicalRequestKey,
  retryDelaysMs,
  timeoutMs,
  maxPages = DEFAULT_MAX_BACKFILL_PAGES,
  signal,
  yieldBetweenPages = defaultPageYield,
}: TranscriptPagedBackfillOptions): Promise<TranscriptBackfillResult<ReplayBatch>> {
  const events: SessionEventRecord[] = [];
  let attempts = 0;
  let afterSeq: number | null = initialAfterSeq;
  let snapshotNewestSeq: number | null = null;
  let oldestAvailableSeq: number | null = null;
  let sourceAvailable = true;
  let gapDetected = false;
  let decodeFailureCount = 0;
  let oversizedEventCount = 0;

  for (let pageIndex = 0; pageIndex < Math.max(1, maxPages); pageIndex += 1) {
    const pageRequestCursor: number | null = afterSeq;
    const pageRequestSnapshot: number | null = snapshotNewestSeq;
    const pageResult: TranscriptBackfillResult<NativeEventReplayPage> =
      await runTranscriptBackfillWithRetry({
        load: () => loadPage(pageRequestCursor, pageRequestSnapshot),
        isComplete: () => true,
        physicalRequestKey: physicalRequestKey
          ? [
              physicalRequestKey,
              pageRequestSnapshot ?? 'snapshot',
              pageRequestCursor ?? 'start',
            ].join(':')
          : undefined,
        ...(retryDelaysMs ? { retryDelaysMs } : {}),
        ...(timeoutMs != null ? { timeoutMs } : {}),
        signal,
      });
    attempts += pageResult.attempts;

    if (pageResult.status === 'cancelled') {
      return { status: 'cancelled', attempts };
    }
    if (pageResult.status === 'error') {
      return { status: 'error', attempts, error: pageResult.error };
    }

    const page: NativeEventReplayPage = pageResult.value;
    const pageSnapshot: number | null = page.snapshot_newest_seq ?? null;
    if (pageIndex === 0) {
      snapshotNewestSeq = pageSnapshot;
      oldestAvailableSeq = page.oldest_available_seq ?? null;
    } else if (pageSnapshot !== snapshotNewestSeq) {
      return {
        status: 'error',
        attempts,
        error: new Error('Transcript backfill snapshot changed between pages'),
      };
    }

    sourceAvailable = sourceAvailable && page.source_available !== false;
    gapDetected = gapDetected || page.gap_detected;
    decodeFailureCount += Math.max(0, page.decode_failure_count || 0);
    oversizedEventCount += Math.max(0, page.oversized_event_count || 0);

    for (const event of page.events) {
      const previous = events[events.length - 1];
      if (previous && (
        event.runtime_id !== previous.runtime_id
        || event.seq <= previous.seq
      )) {
        return {
          status: 'error',
          attempts,
          error: new Error('Transcript backfill page order is not strictly increasing'),
        };
      }
      if (snapshotNewestSeq != null && event.seq > snapshotNewestSeq) {
        return {
          status: 'error',
          attempts,
          error: new Error('Transcript backfill page crossed its snapshot boundary'),
        };
      }
      events.push(event);
    }

    if (!page.has_more) {
      const replayBatch: ReplayBatch = {
        source_available: sourceAvailable,
        gap_detected: gapDetected,
        truncated: !sourceAvailable
          || gapDetected
          || decodeFailureCount > 0
          || oversizedEventCount > 0,
        unloaded_gap_starts: [],
        oldest_available_seq: oldestAvailableSeq,
        newest_available_seq: snapshotNewestSeq,
        events,
      };
      return {
        status: isComplete(replayBatch) ? 'success' : 'partial',
        attempts,
        value: replayBatch,
      };
    }

    const nextCursor: number | null = page.next_cursor ?? null;
    if (nextCursor == null || nextCursor <= (afterSeq ?? 0)) {
      return {
        status: 'error',
        attempts,
        error: new Error('Transcript backfill cursor did not advance'),
      };
    }
    afterSeq = nextCursor;

    try {
      await yieldBetweenPages();
    } catch (error) {
      if (isCancelled(error, signal)) {
        return { status: 'cancelled', attempts };
      }
      return { status: 'error', attempts, error };
    }
  }

  return {
    status: 'error',
    attempts,
    error: new Error(`Transcript backfill exceeded ${maxPages} pages`),
  };
}

/**
 * Verify the requested suffix of a fixed snapshot, rather than the database's
 * entire global range. This is the completeness contract used by live polling
 * after it has already committed every event through `afterSeq`.
 */
export function replayBatchCoversSequenceAfter(
  replayBatch: ReplayBatch,
  afterSeq: number | null,
): boolean {
  if (
    replayBatch.source_available === false
    || replayBatch.truncated
    || replayBatch.gap_detected
  ) {
    return false;
  }

  const newestSeq = replayBatch.newest_available_seq ?? null;
  if (newestSeq == null) {
    return replayBatch.events.length === 0;
  }
  if (afterSeq != null && newestSeq <= afterSeq) {
    return replayBatch.events.length === 0;
  }

  const expectedFirstSeq = afterSeq == null
    ? replayBatch.oldest_available_seq ?? 1
    : afterSeq + 1;
  const expectedCount = newestSeq - expectedFirstSeq + 1;
  if (
    expectedCount < 0
    || replayBatch.events.length !== expectedCount
    || replayBatch.events[0]?.seq !== expectedFirstSeq
    || replayBatch.events[replayBatch.events.length - 1]?.seq !== newestSeq
  ) {
    return false;
  }

  return replayBatch.events.every((event, index) => (
    event.seq === expectedFirstSeq + index
  ));
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

export interface PendingTranscriptPartialObservation
  extends TranscriptBackfillCommitIdentity {
  observation: TranscriptPartialObservation;
}

export function includePendingTranscriptPartialObservation(
  committed: TranscriptPartialObservation,
  pending: PendingTranscriptPartialObservation | null,
  scope: Pick<TranscriptBackfillCommitIdentity, 'runtimeId' | 'generation'>,
): TranscriptPartialObservation {
  if (
    !pending
    || pending.runtimeId !== scope.runtimeId
    || pending.generation !== scope.generation
  ) {
    return committed;
  }

  return {
    version: Math.max(committed.version, pending.observation.version),
    throughSeq: pending.observation.throughSeq == null
      ? committed.throughSeq
      : Math.max(committed.throughSeq ?? pending.observation.throughSeq, pending.observation.throughSeq),
    unknownRange: committed.unknownRange || pending.observation.unknownRange,
  };
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
