/**
 * Lightweight in-memory performance logger.
 *
 * Captures coarse-grained signals useful to diagnose user-reported jank:
 *   - PerformanceObserver: longtask / paint / largest-contentful-paint / navigation
 *   - Window error & unhandledrejection
 *   - Tauri IPC durations (by patching window.__TAURI_INTERNALS__.invoke)
 *   - Manual marks via recordPerfMark()
 *
 * The buffer is bounded (BUFFER_CAPACITY) so it is safe to leave enabled. Data
 * stays in-process — nothing is sent anywhere unless the user explicitly
 * exports it from the Settings page.
 */

export type PerfEventType =
  | 'longtask'
  | 'paint'
  | 'lcp'
  | 'navigation'
  | 'ipc'
  | 'ipc-error'
  | 'frame-drop'
  | 'mark'
  | 'error';

export interface PerfEvent {
  /** Monotonic timestamp relative to navigation start, in ms. */
  t: number;
  /** Wall-clock timestamp (ISO 8601) for human reading after export. */
  iso: string;
  type: PerfEventType;
  name: string;
  /** Duration in ms when applicable (longtask, ipc, navigation). */
  durationMs?: number;
  meta?: Record<string, unknown>;
}

const BUFFER_CAPACITY = 500;
// A janky session drops frames continuously; in the shared buffer they would
// evict every IPC, mark and error. Keep them apart: the summary covers the
// whole frame window, the event list only its most recent tail.
const FRAME_DROP_CAPACITY = 600;
const FRAME_DROP_EXPORT_LIMIT = 60;
const LONG_FRAME_THRESHOLD_MS = 80; // 12.5fps — anything noticeably janky
const LONG_IPC_THRESHOLD_MS = 250;

interface Ring {
  items: PerfEvent[];
  cursor: number;
  capacity: number;
}

const createRing = (capacity: number): Ring => ({ items: [], cursor: 0, capacity });
const buffer = createRing(BUFFER_CAPACITY);
const frameDrops = createRing(FRAME_DROP_CAPACITY);
let installed = false;
let ipcPatched = false;
let frameSamplerStop: (() => void) | null = null;
const observers: PerformanceObserver[] = [];

function pushRing(ring: Ring, event: PerfEvent) {
  if (ring.items.length < ring.capacity) {
    ring.items.push(event);
  } else {
    ring.items[ring.cursor] = event;
    ring.cursor = (ring.cursor + 1) % ring.capacity;
  }
}

function readRing(ring: Ring): PerfEvent[] {
  if (ring.items.length < ring.capacity) {
    return ring.items.slice();
  }
  return ring.items.slice(ring.cursor).concat(ring.items.slice(0, ring.cursor));
}

function pushEvent(event: PerfEvent) {
  pushRing(event.type === 'frame-drop' ? frameDrops : buffer, event);
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function record(event: Omit<PerfEvent, 't' | 'iso'>) {
  pushEvent({
    t: Math.round(nowMs()),
    iso: new Date().toISOString(),
    ...event,
  });
}

/**
 * Buffered events in chronological order. Frame drops are limited to the most
 * recent FRAME_DROP_EXPORT_LIMIT; getPerfSummary() covers all retained ones.
 */
export function getPerfEvents(): PerfEvent[] {
  return readRing(buffer)
    .concat(readRing(frameDrops).slice(-FRAME_DROP_EXPORT_LIMIT))
    .sort((a, b) => a.t - b.t);
}

/** Clear all buffered events. */
export function clearPerfLog() {
  for (const ring of [buffer, frameDrops]) {
    ring.items.length = 0;
    ring.cursor = 0;
  }
}

/** Safari/WebKit cannot observe long tasks; a zero count there means "unknown". */
export function isLongTaskObservationSupported(): boolean {
  const types = typeof PerformanceObserver !== 'undefined'
    ? (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes
    : undefined;
  return Array.isArray(types) && types.includes('longtask');
}

/** Manual instrumentation hook for callers (e.g. page transitions). */
export function recordPerfMark(name: string, meta?: Record<string, unknown>) {
  record({ type: 'mark', name, meta });
}

/** Manual duration record (e.g. wrap a heavy computation). */
export function recordPerfDuration(
  name: string,
  durationMs: number,
  meta?: Record<string, unknown>
) {
  record({ type: 'mark', name, durationMs, meta });
}

interface PerfSummaryEntry {
  count: number;
  avgMs?: number;
  p95Ms?: number;
  maxMs?: number;
}

export type PerfSummary = Partial<Record<PerfEventType, PerfSummaryEntry>>;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** Aggregate summary suitable for showing in the Settings page. */
export function getPerfSummary(): PerfSummary {
  const events = readRing(buffer).concat(readRing(frameDrops));
  const grouped = new Map<PerfEventType, number[]>();
  const counts = new Map<PerfEventType, number>();

  for (const e of events) {
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    if (typeof e.durationMs === 'number' && Number.isFinite(e.durationMs)) {
      const arr = grouped.get(e.type) ?? [];
      arr.push(e.durationMs);
      grouped.set(e.type, arr);
    }
  }

  const summary: PerfSummary = {};
  for (const [type, count] of counts) {
    const durations = grouped.get(type);
    if (durations && durations.length > 0) {
      const sorted = [...durations].sort((a, b) => a - b);
      const avg = durations.reduce((s, n) => s + n, 0) / durations.length;
      summary[type] = {
        count,
        avgMs: Math.round(avg * 10) / 10,
        p95Ms: Math.round(percentile(sorted, 95) * 10) / 10,
        maxMs: Math.round(sorted[sorted.length - 1] * 10) / 10,
      };
    } else {
      summary[type] = { count };
    }
  }
  return summary;
}

export interface DiagnosticsEnvelope {
  generatedAt: string;
  appUserAgent: string;
  language: string;
  url: string;
  performanceMode?: string;
  hardwareConcurrency?: number;
  /** False on WebKit: long-task counts are then unknown, not zero. */
  longTaskSupported?: boolean;
  deviceMemory?: number;
  /** Throttled frames look identical to slow ones; these tell them apart. */
  display?: {
    visibilityState: string;
    hasFocus: boolean;
    devicePixelRatio: number;
    viewport: string;
    screen: string;
    prefersReducedMotion: boolean;
  };
  summary: PerfSummary;
  events: PerfEvent[];
}

export interface DoctorEnvelope {
  schemaVersion: 1;
  kind: 'ccem-doctor-report';
  generatedAt: string;
  frontend: DiagnosticsEnvelope;
  perfSmoke?: unknown;
  backend?: unknown;
  backendError?: string;
}

/** Build the JSON envelope that the export button writes to disk. */
export function buildDiagnosticsEnvelope(): DiagnosticsEnvelope {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const doc = typeof document !== 'undefined' ? document : undefined;
  return {
    generatedAt: new Date().toISOString(),
    appUserAgent: nav?.userAgent ?? '',
    language: nav?.language ?? '',
    url: typeof location !== 'undefined' ? location.href : '',
    performanceMode: doc?.documentElement.dataset.performanceMode,
    hardwareConcurrency: nav?.hardwareConcurrency,
    longTaskSupported: isLongTaskObservationSupported(),
    deviceMemory: (nav as { deviceMemory?: number } | undefined)?.deviceMemory,
    display: typeof window !== 'undefined' && doc ? {
      visibilityState: doc.visibilityState,
      hasFocus: doc.hasFocus(),
      devicePixelRatio: window.devicePixelRatio,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      screen: `${window.screen.width}x${window.screen.height}`,
      prefersReducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    } : undefined,
    summary: getPerfSummary(),
    events: getPerfEvents(),
  };
}

/** Serialize the diagnostics envelope as a pretty-printed JSON string. */
export function exportPerfLogAsJson(): string {
  return JSON.stringify(buildDiagnosticsEnvelope(), null, 2);
}

/** Build a support bundle that combines frontend perf data with backend diagnostics. */
export function buildDoctorEnvelope(options: {
  backend?: unknown;
  backendError?: string;
  perfSmoke?: unknown;
} = {}): DoctorEnvelope {
  const envelope: DoctorEnvelope = {
    schemaVersion: 1,
    kind: 'ccem-doctor-report',
    generatedAt: new Date().toISOString(),
    frontend: buildDiagnosticsEnvelope(),
  };

  if (options.backend !== undefined) {
    envelope.backend = options.backend;
  }
  if (options.perfSmoke !== undefined) {
    envelope.perfSmoke = options.perfSmoke;
  }
  if (options.backendError) {
    envelope.backendError = options.backendError;
  }

  return envelope;
}

/** Serialize the combined Doctor report as pretty-printed JSON. */
export function exportDoctorReportAsJson(options: {
  backend?: unknown;
  backendError?: string;
  perfSmoke?: unknown;
} = {}): string {
  return JSON.stringify(buildDoctorEnvelope(options), null, 2);
}

function safeObserve(type: string, callback: (entries: PerformanceEntryList) => void) {
  try {
    const supported =
      typeof PerformanceObserver !== 'undefined' &&
      Array.isArray((PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes) &&
      (PerformanceObserver as unknown as { supportedEntryTypes: string[] }).supportedEntryTypes.includes(type);
    if (!supported) return;
    const observer = new PerformanceObserver((list) => callback(list.getEntries()));
    observer.observe({ type, buffered: true });
    observers.push(observer);
  } catch {
    // PerformanceObserver may throw on unsupported types; ignore.
  }
}

function installFrameSampler(targetWindow: Window): () => void {
  if (typeof targetWindow.requestAnimationFrame !== 'function') {
    return () => {};
  }
  let last = nowMs();
  let rafId = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const current = nowMs();
    const delta = current - last;
    last = current;
    if (delta >= LONG_FRAME_THRESHOLD_MS) {
      record({
        type: 'frame-drop',
        name: 'rAF gap',
        durationMs: Math.round(delta),
      });
    }
    rafId = targetWindow.requestAnimationFrame(tick);
  };
  rafId = targetWindow.requestAnimationFrame(tick);
  return () => {
    stopped = true;
    if (targetWindow.cancelAnimationFrame) {
      targetWindow.cancelAnimationFrame(rafId);
    }
  };
}

interface TauriInternals {
  invoke?: (...args: unknown[]) => Promise<unknown>;
}

function patchTauriInvoke(targetWindow: Window): boolean {
  const internals = (targetWindow as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') {
    return false;
  }
  if ((internals.invoke as { __ccemInstrumented?: boolean }).__ccemInstrumented) {
    return true;
  }
  const original = internals.invoke.bind(internals);
  const wrapped = async (...args: unknown[]) => {
    const command = typeof args[0] === 'string' ? args[0] : 'unknown';
    const start = nowMs();
    try {
      const result = await original(...args);
      const duration = nowMs() - start;
      if (duration >= LONG_IPC_THRESHOLD_MS) {
        record({
          type: 'ipc',
          name: command,
          durationMs: Math.round(duration),
        });
      }
      return result;
    } catch (err) {
      const duration = nowMs() - start;
      record({
        type: 'ipc-error',
        name: command,
        durationMs: Math.round(duration),
        meta: { message: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  };
  (wrapped as { __ccemInstrumented?: boolean }).__ccemInstrumented = true;

  try {
    Object.defineProperty(internals, 'invoke', {
      value: wrapped,
      configurable: true,
      writable: true,
    });
  } catch (defineError) {
    try {
      internals.invoke = wrapped as TauriInternals['invoke'];
    } catch (assignError) {
      record({
        type: 'mark',
        name: 'perf-log:ipc-patch-skipped',
        meta: {
          defineError: defineError instanceof Error ? defineError.message : String(defineError),
          assignError: assignError instanceof Error ? assignError.message : String(assignError),
        },
      });
      return false;
    }
  }
  return true;
}

interface InstallOptions {
  /** Try to instrument Tauri IPC. Retries a few times if internals aren't ready yet. */
  patchTauri?: boolean;
}

/**
 * Install observers and IPC instrumentation. Safe to call multiple times.
 */
export function initPerfLog(
  targetWindow: Window = window,
  options: InstallOptions = {}
): void {
  if (installed) return;
  installed = true;
  const { patchTauri = true } = options;

  safeObserve('longtask', (entries) => {
    for (const entry of entries) {
      record({
        type: 'longtask',
        name: entry.name || 'longtask',
        durationMs: Math.round(entry.duration),
      });
    }
  });

  safeObserve('paint', (entries) => {
    for (const entry of entries) {
      record({
        type: 'paint',
        name: entry.name,
        durationMs: Math.round(entry.startTime),
      });
    }
  });

  safeObserve('largest-contentful-paint', (entries) => {
    for (const entry of entries) {
      record({
        type: 'lcp',
        name: 'largest-contentful-paint',
        durationMs: Math.round(entry.startTime),
      });
    }
  });

  safeObserve('navigation', (entries) => {
    for (const entry of entries as PerformanceNavigationTiming[]) {
      record({
        type: 'navigation',
        name: entry.name || 'navigation',
        durationMs: Math.round(entry.duration),
        meta: {
          domContentLoaded: Math.round(entry.domContentLoadedEventEnd),
          loadEvent: Math.round(entry.loadEventEnd),
        },
      });
    }
  });

  if (typeof targetWindow.addEventListener === 'function') {
    targetWindow.addEventListener('error', (event) => {
      record({
        type: 'error',
        name: event.message || 'window.error',
        meta: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        },
      });
    });
    targetWindow.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      record({
        type: 'error',
        name: 'unhandledrejection',
        meta: {
          message: reason instanceof Error ? reason.message : String(reason),
        },
      });
    });
  }

  frameSamplerStop = installFrameSampler(targetWindow);

  if (patchTauri) {
    ipcPatched = patchTauriInvoke(targetWindow);
    if (!ipcPatched) {
      // Tauri may inject __TAURI_INTERNALS__ slightly after page load. Retry briefly.
      let attempts = 0;
      const retry = () => {
        if (ipcPatched || attempts >= 20) return;
        attempts += 1;
        ipcPatched = patchTauriInvoke(targetWindow);
        if (!ipcPatched) {
          targetWindow.setTimeout(retry, 100);
        }
      };
      targetWindow.setTimeout(retry, 50);
    }
  }

  record({ type: 'mark', name: 'perf-log:installed' });
}

/** For tests: tear everything down. */
export function _resetPerfLogForTests() {
  clearPerfLog();
  observers.forEach((o) => {
    try {
      o.disconnect();
    } catch {
      /* noop */
    }
  });
  observers.length = 0;
  if (frameSamplerStop) {
    frameSamplerStop();
    frameSamplerStop = null;
  }
  installed = false;
  ipcPatched = false;
}
