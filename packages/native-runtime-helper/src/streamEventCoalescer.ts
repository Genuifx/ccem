export const STREAM_EVENT_FLUSH_DELAY_MS = 40;
export const STREAM_EVENT_MAX_BUFFERED_BYTES = 4096;

type StreamEventKind = 'assistant_chunk' | 'system_message';

type PendingStreamEvent = {
  kind: StreamEventKind;
  content: string;
  byteLength: number;
};

type TimerHandle = ReturnType<typeof setTimeout>;

type StreamEventCoalescerOptions = {
  flushDelayMs?: number;
  maxBufferedBytes?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
};

type StreamFragment = {
  kind: StreamEventKind;
  content: string;
};

function exactStreamFragment(payload: Record<string, unknown>): StreamFragment | null {
  if (Object.keys(payload).length !== 2) {
    return null;
  }

  if (payload.type === 'assistant_chunk' && typeof payload.text === 'string' && payload.text) {
    return { kind: 'assistant_chunk', content: payload.text };
  }

  if (payload.type === 'system_message'
    && typeof payload.message === 'string'
    && payload.message) {
    return { kind: 'system_message', content: payload.message };
  }

  return null;
}

function payloadFromPending(pending: PendingStreamEvent): Record<string, unknown> {
  return pending.kind === 'assistant_chunk'
    ? { type: pending.kind, text: pending.content }
    : { type: pending.kind, message: pending.content };
}

export function createStreamEventCoalescer(
  writePayload: (payload: Record<string, unknown>) => void,
  options: StreamEventCoalescerOptions = {},
) {
  const flushDelayMs = options.flushDelayMs ?? STREAM_EVENT_FLUSH_DELAY_MS;
  const maxBufferedBytes = options.maxBufferedBytes ?? STREAM_EVENT_MAX_BUFFERED_BYTES;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let pending: PendingStreamEvent | null = null;
  let flushTimer: TimerHandle | null = null;

  const clearFlushTimer = () => {
    if (flushTimer === null) {
      return;
    }
    clearTimer(flushTimer);
    flushTimer = null;
  };

  const flush = () => {
    clearFlushTimer();
    if (!pending) {
      return;
    }
    const next = pending;
    pending = null;
    writePayload(payloadFromPending(next));
  };

  const startPending = (fragment: StreamFragment, byteLength: number) => {
    pending = {
      kind: fragment.kind,
      content: fragment.content,
      byteLength,
    };
    flushTimer = setTimer(() => {
      flushTimer = null;
      flush();
    }, flushDelayMs);
  };

  const emit = (payload: Record<string, unknown>) => {
    const fragment = exactStreamFragment(payload);
    if (!fragment) {
      flush();
      writePayload(payload);
      return;
    }

    const fragmentBytes = Buffer.byteLength(fragment.content, 'utf8');
    if (pending?.kind !== fragment.kind) {
      flush();
    }

    if (fragmentBytes >= maxBufferedBytes) {
      flush();
      writePayload(payload);
      return;
    }

    if (!pending) {
      startPending(fragment, fragmentBytes);
      return;
    }

    const combinedBytes = pending.byteLength + fragmentBytes;
    if (combinedBytes > maxBufferedBytes) {
      flush();
      startPending(fragment, fragmentBytes);
      return;
    }

    pending.content += fragment.content;
    pending.byteLength = combinedBytes;
    if (combinedBytes === maxBufferedBytes) {
      flush();
    }
  };

  return { emit, flush };
}
