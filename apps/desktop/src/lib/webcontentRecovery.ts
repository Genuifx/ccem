import { invoke } from '@tauri-apps/api/core';
import { recoveryDraftDiagnostics } from './recoveryDrafts';
import type { BrowserPanelSessionKeys, BrowserPanelTarget } from '@/components/workspace/browserPanelTarget';

interface WebcontentDocument {
  documentId: string;
  generation: number;
  recovered: boolean;
  browserWorkspace?: BrowserWorkspaceRecoveryState | null;
}

export interface WebcontentDocumentIdentity {
  documentId: string;
  generation: number;
}

/** Host-memory metadata only; page state and Agent ownership stay in the retained CEF runtime. */
export interface BrowserWorkspaceRecoveryState {
  version: 1;
  instanceSequence: number;
  targets: Record<string, BrowserPanelTarget | undefined>;
  sessionKeys: BrowserPanelSessionKeys;
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
let identityPromise: Promise<WebcontentDocumentIdentity | null> | null = null;
let resolveIdentity: ((identity: WebcontentDocumentIdentity | null) => void) | null = null;
let browserWorkspace: BrowserWorkspaceRecoveryState | null = null;
let workspaceRevision = 0;
let workspaceSave: Promise<void> = Promise.resolve();
let queuedWorkspace = '';
let workspaceSaveFailed = false;

async function invokeRecoveryWithRetry<T>(command: string, args: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await invoke<T>(command, args);
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 100 : 400));
    }
  }
}

/** Resolve the native recovery fence before mounting any session effects. */
export function initializeWebcontentRecovery(): Promise<void> {
  if (bootPromise) return bootPromise;
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return Promise.resolve();
  }
  recoveryUncertain = true;
  identityPromise = new Promise((resolve) => { resolveIdentity = resolve; });
  try {
    documentId = crypto.randomUUID();
  } catch {
    console.warn('Main WebContent document identity unavailable');
    resolveIdentity?.(null);
    resolveIdentity = null;
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
    void invokeRecoveryWithRetry<WebcontentDocument>('webcontent_frontend_boot', { documentId: id })
      .then((state) => {
        if (!state || state.documentId !== id
          || !Number.isSafeInteger(state.generation) || state.generation < 0
          || typeof state.recovered !== 'boolean') return;
        activeDocument = state;
        browserWorkspace = state.browserWorkspace ?? null;
        // A late identity can still ACK readiness, but cannot retroactively
        // authorize replay after the UI mounted with an uncertain handshake.
        if (!finished) recoveryUncertain = false;
        resolveIdentity?.({ documentId: id, generation: state.generation });
        resolveIdentity = null;
      })
      .catch(() => {
        console.warn('Main WebContent recovery handshake unavailable');
      })
      .finally(() => {
        resolveIdentity?.(null);
        resolveIdentity = null;
        finish();
      });
  });
  return bootPromise;
}

export function awaitWebcontentDocumentIdentity(): Promise<WebcontentDocumentIdentity | null> {
  if (activeDocument) return Promise.resolve({ documentId: activeDocument.documentId, generation: activeDocument.generation });
  return identityPromise ?? Promise.resolve(null);
}

/** Undefined means the native handshake is still pending; do not create replacement panels yet. */
export function currentBrowserWorkspace(): BrowserWorkspaceRecoveryState | null | undefined {
  if (activeDocument) return browserWorkspace;
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  return undefined;
}

export async function awaitBrowserWorkspace(): Promise<BrowserWorkspaceRecoveryState | null> {
  if (!await awaitWebcontentDocumentIdentity()) throw new Error('Browser workspace recovery is unavailable.');
  return browserWorkspace;
}

/** Queue a complete snapshot before native acquisition, retaining order across quick UI actions. */
export function saveBrowserWorkspace(workspace: BrowserWorkspaceRecoveryState): Promise<void> {
  const serialized = JSON.stringify(workspace);
  if (serialized === queuedWorkspace && !workspaceSaveFailed) return workspaceSave;
  const snapshot = JSON.parse(serialized) as BrowserWorkspaceRecoveryState;
  browserWorkspace = snapshot;
  queuedWorkspace = serialized;
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return Promise.resolve();
  const revision = ++workspaceRevision;
  workspaceSave = workspaceSave.catch(() => {}).then(async () => {
    const identity = await awaitWebcontentDocumentIdentity();
    if (!identity) throw new Error('Browser workspace recovery is unavailable.');
    await invokeRecoveryWithRetry('webcontent_browser_workspace_save', { ...identity, revision, workspace: snapshot });
    workspaceSaveFailed = false;
  }).catch((error) => {
    workspaceSaveFailed = true;
    throw error;
  });
  // Callers may enqueue synchronously from UI state changes. Acquisition still observes failures.
  void workspaceSave.catch(() => {});
  return workspaceSave;
}

export async function flushBrowserWorkspace(): Promise<void> {
  let pending: Promise<void>;
  do {
    pending = workspaceSave;
    await pending;
  } while (pending !== workspaceSave);
}

/** Every UI mutation carries its originating document; stale windows cannot borrow the new fence. */
export async function invokeBrowserCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const identity = await awaitWebcontentDocumentIdentity();
  if (!identity) throw new Error('Browser document identity is unavailable.');
  if (command === 'browser_surface_acquire'
    || (command === 'browser_surface_release' && args?.disposition === 'close')) {
    // A user's retry must be able to repair a failed metadata ACK before acquiring.
    if (workspaceSaveFailed && browserWorkspace) void saveBrowserWorkspace(browserWorkspace);
    await flushBrowserWorkspace();
  }
  return invoke<T>(command, {
    ...args,
    frontendDocumentId: identity.documentId,
    frontendGeneration: identity.generation,
  });
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
