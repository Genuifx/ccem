import { invoke } from '@tauri-apps/api/core';
import { recoveryDraftDiagnostics } from './recoveryDrafts';

interface WebcontentDocument {
  generation: number;
  recovered: boolean;
}

export interface WebcontentSessionSample {
  rawEventCount: number;
  projectedMessageCount: number;
  toolResultChars: number;
}

const readers = new Map<() => WebcontentSessionSample, boolean>();
let documentId: string | null = null;
let activeDocument: WebcontentDocument | null = null;
let bootPromise: Promise<void> | null = null;
let recoveryUncertain = false;

/** Resolve the native recovery fence before mounting any session effects. */
export function initializeWebcontentRecovery(): Promise<void> {
  if (bootPromise) return bootPromise;
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return Promise.resolve();
  }
  recoveryUncertain = true;
  try {
    documentId = crypto.randomUUID();
  } catch {
    console.warn('Main WebContent document identity unavailable');
    bootPromise = Promise.resolve();
    return bootPromise;
  }
  const id = documentId;
  bootPromise = new Promise<void>((resolve) => {
    // A missing command/bridge must not strand the UI or authorize queue replay.
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, 3000);
    void invoke<WebcontentDocument>('webcontent_frontend_boot', { documentId: id })
      .then((state) => {
        if (!Number.isSafeInteger(state.generation) || state.generation < 0
          || typeof state.recovered !== 'boolean') return;
        activeDocument = state;
        // A late identity can still ACK readiness, but cannot retroactively
        // authorize replay after the UI mounted with an uncertain handshake.
        if (!finished) recoveryUncertain = false;
      })
      .catch(() => {
        console.warn('Main WebContent recovery handshake unavailable');
      })
      .finally(finish);
  });
  return bootPromise;
}

/** A restored/unknown document must not replay persisted frontend input. */
export function isRecoveringWebcontent(): boolean {
  return recoveryUncertain || activeDocument?.recovered === true;
}

export function hasRecoveredWebcontent(): boolean {
  return activeDocument?.recovered === true;
}

export function registerWebcontentSessionSample(
  reader: () => WebcontentSessionSample,
  isLiveSession = true,
): () => void {
  readers.set(reader, isLiveSession);
  return () => { readers.delete(reader); };
}

function nonnegativeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Numeric summaries only: never serialize event payloads, prompts or URLs. */
export function collectWebcontentSample() {
  let rawEventCount = 0;
  let projectedMessageCount = 0;
  let toolResultChars = 0;
  let mountedSessionCount = 0;
  for (const [reader, isLiveSession] of readers) {
    const sample = reader();
    if (isLiveSession) mountedSessionCount += 1;
    rawEventCount += nonnegativeCount(sample.rawEventCount);
    projectedMessageCount += nonnegativeCount(sample.projectedMessageCount);
    toolResultChars += nonnegativeCount(sample.toolResultChars);
  }
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  const heap = memory?.usedJSHeapSize;
  const drafts = recoveryDraftDiagnostics();
  return {
    domNodeCount: document.querySelectorAll('*').length,
    transcriptRowCount: document.querySelectorAll('[data-transcript-item-key]').length,
    visible: document.visibilityState === 'visible',
    // JavaScriptCore normally has no performance.memory. Unavailable is null, not zero.
    heapUsedBytes: typeof heap === 'number' && Number.isSafeInteger(heap) && heap >= 0 ? heap : null,
    mountedSessionCount,
    rawEventCount,
    projectedMessageCount,
    toolResultChars,
    recoveryDraftCount: nonnegativeCount(drafts.drafts),
    recoveryUncertainSubmissionCount: nonnegativeCount(drafts.uncertain),
    recoveryDraftWriteFailures: nonnegativeCount(drafts.failedWrites),
  };
}

export async function acknowledgeWebcontentReady(): Promise<boolean> {
  if (!activeDocument || !documentId) return false;
  await invoke('webcontent_frontend_ready', { documentId, generation: activeDocument.generation });
  return true;
}

let sampleInFlight = false;
export async function sampleWebcontent(): Promise<void> {
  if (!activeDocument || !documentId || sampleInFlight) return;
  sampleInFlight = true;
  try {
    await invoke('webcontent_frontend_sample', {
      documentId,
      generation: activeDocument.generation,
      sample: collectWebcontentSample(),
    });
  } finally {
    sampleInFlight = false;
  }
}
