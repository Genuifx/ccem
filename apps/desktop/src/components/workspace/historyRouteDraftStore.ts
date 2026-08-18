import type { ComposerRouteDraft } from './composerRouteDraft';

export const HISTORY_ROUTE_DRAFT_STORAGE_KEY = 'ccem-workspace-history-route-drafts-v1';

const HISTORY_ROUTE_DRAFT_STORAGE_VERSION = 1;
const MAX_HISTORY_ROUTE_DRAFTS = 100;

export interface HistoryRouteDraftIdentity {
  source: string;
  id: string;
  project: string;
}

interface HistoryRouteDraftStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

interface StoredHistoryRouteDraft {
  key: string;
  optIn: boolean;
  profileId: string | null;
  updatedAt: number;
}

interface StoredHistoryRouteDraftEnvelope {
  version: 1;
  entries: StoredHistoryRouteDraft[];
}

export function normalizeHistoryRouteProject(project: string): string {
  return project.replace(/\\/g, '/').replace(/\/+$/, '').trim();
}

/**
 * A provider session id is not globally unique: the same id can appear in
 * different providers or working directories. Keep the complete identity in
 * the key so an unfinished opt-in can never leak into another workspace.
 */
export function historyRouteDraftKey(identity: HistoryRouteDraftIdentity): string {
  return JSON.stringify([
    identity.source.trim().toLowerCase(),
    identity.id.trim(),
    normalizeHistoryRouteProject(identity.project),
  ]);
}

function isStoredDraft(value: unknown): value is StoredHistoryRouteDraft {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredHistoryRouteDraft>;
  return typeof candidate.key === 'string'
    && typeof candidate.optIn === 'boolean'
    && (candidate.profileId === null || typeof candidate.profileId === 'string')
    && typeof candidate.updatedAt === 'number'
    && Number.isFinite(candidate.updatedAt);
}

function readEnvelope(storage: HistoryRouteDraftStorage): StoredHistoryRouteDraftEnvelope {
  try {
    const raw = storage.getItem(HISTORY_ROUTE_DRAFT_STORAGE_KEY);
    if (!raw) return { version: HISTORY_ROUTE_DRAFT_STORAGE_VERSION, entries: [] };
    const parsed = JSON.parse(raw) as Partial<StoredHistoryRouteDraftEnvelope>;
    if (parsed.version !== HISTORY_ROUTE_DRAFT_STORAGE_VERSION || !Array.isArray(parsed.entries)) {
      return { version: HISTORY_ROUTE_DRAFT_STORAGE_VERSION, entries: [] };
    }
    return {
      version: HISTORY_ROUTE_DRAFT_STORAGE_VERSION,
      entries: parsed.entries.filter(isStoredDraft),
    };
  } catch {
    return { version: HISTORY_ROUTE_DRAFT_STORAGE_VERSION, entries: [] };
  }
}

function writeEnvelope(
  storage: HistoryRouteDraftStorage,
  entries: StoredHistoryRouteDraft[],
): void {
  try {
    storage.setItem(HISTORY_ROUTE_DRAFT_STORAGE_KEY, JSON.stringify({
      version: HISTORY_ROUTE_DRAFT_STORAGE_VERSION,
      entries: [...entries]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_HISTORY_ROUTE_DRAFTS),
    } satisfies StoredHistoryRouteDraftEnvelope));
  } catch {
    // localStorage can be unavailable or full. The current React state still
    // works; persistence is best-effort and must never block the Composer.
  }
}

/** Returns null when the user has never made an explicit choice for this history session. */
export function readHistoryRouteDraft(
  storage: HistoryRouteDraftStorage,
  key: string,
): ComposerRouteDraft | null {
  const entry = readEnvelope(storage).entries.find((candidate) => candidate.key === key);
  return entry ? { optIn: entry.optIn, profileId: entry.profileId } : null;
}

/** Persists both explicit on and explicit off; absence means "derive from authoritative history". */
export function writeHistoryRouteDraft(
  storage: HistoryRouteDraftStorage,
  key: string,
  draft: ComposerRouteDraft,
  updatedAt = Date.now(),
): void {
  const envelope = readEnvelope(storage);
  writeEnvelope(storage, [
    { key, optIn: draft.optIn, profileId: draft.profileId, updatedAt },
    ...envelope.entries.filter((candidate) => candidate.key !== key),
  ]);
}

export function clearHistoryRouteDraft(
  storage: HistoryRouteDraftStorage,
  key: string,
): void {
  const envelope = readEnvelope(storage);
  const next = envelope.entries.filter((candidate) => candidate.key !== key);
  if (next.length === envelope.entries.length) return;
  writeEnvelope(storage, next);
}

// ============================================================================
// Facade: memory (incl. restored snapshots) + bounded localStorage
// ============================================================================

export type HistoryRouteDraftMap = Map<string, ComposerRouteDraft>;

export interface HistoryRouteDraftStore {
  /** Memory value → persisted explicit choice → fresh opted-out draft. */
  take(key: string): ComposerRouteDraft;
  /**
   * Memory always. Persisted ONLY for plain user drafts — restored history
   * runtime references stay memory-only so they can never mask the
   * authoritative routed summary on a later reopen.
   */
  save(key: string, draft: ComposerRouteDraft): void;
  /** Clears this session's draft from memory and storage. */
  clear(key: string): void;
}

export function createHistoryRouteDraftStore(
  storage: HistoryRouteDraftStorage,
): HistoryRouteDraftStore {
  const memory: HistoryRouteDraftMap = new Map();
  return {
    take(key) {
      const inMemory = memory.get(key);
      if (inMemory) return inMemory;
      const persisted = readHistoryRouteDraft(storage, key);
      if (persisted) return persisted;
      return { optIn: false, profileId: null };
    },
    save(key, draft) {
      memory.set(key, draft);
      if (!draft.restoredSource) {
        writeHistoryRouteDraft(storage, key, draft);
      }
    },
    clear(key) {
      memory.delete(key);
      clearHistoryRouteDraft(storage, key);
    },
  };
}

/** window.localStorage accessor that degrades to a no-op storage. */
export function browserHistoryRouteDraftStorage(): HistoryRouteDraftStorage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** In-memory storage fallback (persistence unavailable). */
export function createInMemoryHistoryRouteDraftStorage(): HistoryRouteDraftStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}
