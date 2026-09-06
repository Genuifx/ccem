import type { ComposerAttachment } from '@/components/workspace/composerAttachments';
import type { WorkspaceAnnotation } from '@/components/workspace/workspaceAnnotationModel';

const PREFIX = 'ccem:renderer-recovery-draft:v1:';
const ASSET_PREFIX = 'ccem:renderer-recovery-attachment:v1:';
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface RecoveryDraft {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
  annotations?: WorkspaceAnnotation[];
}
interface StoredDraft {
  id: string;
  text: string;
  attachmentIds: string[];
  rejected?: boolean;
  annotations?: WorkspaceAnnotation[];
}
interface RecoveryDraftRecord {
  version: 1;
  draft: StoredDraft | null;
  // IPC acceptance may precede renderer ACK. Never restore these as sendable.
  submitting: StoredDraft[];
}
let nextDraftId = 0;
let failedWrites = 0;

export function recoveryDraftKey(kind: 'live' | 'compose' | 'history', ...identity: string[]): string {
  return `${kind}:${JSON.stringify(identity)}`;
}
function defaultStorage(): DraftStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; }
  catch { recordFailure(); return undefined; }
}
function assetKey(key: string, id: string): string {
  return `${ASSET_PREFIX}${JSON.stringify([key, id])}`;
}
function attachmentStorageId(attachment: ComposerAttachment): string {
  // Rejected draft recovery can renumber an image placeholder while retaining
  // the image id. Keep both snapshots' placeholder metadata correct.
  return JSON.stringify([attachment.id, attachment.kind === 'image' ? attachment.placeholder : '']);
}
function isStoredDraft(value: unknown): value is StoredDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as StoredDraft;
  return typeof draft.id === 'string' && typeof draft.text === 'string'
    && Array.isArray(draft.attachmentIds) && draft.attachmentIds.every(id => typeof id === 'string');
}
function readRecord(key: string, storage: DraftStorage | undefined): RecoveryDraftRecord {
  try {
    const raw = storage?.getItem(`${PREFIX}${key}`);
    if (raw) {
      const parsed = JSON.parse(raw) as RecoveryDraftRecord;
      if (parsed.version === 1 && (parsed.draft === null || isStoredDraft(parsed.draft))
        && Array.isArray(parsed.submitting) && parsed.submitting.every(isStoredDraft)) return parsed;
    }
  } catch { /* Local cache corruption must never block the editor. */ }
  return { version: 1, draft: null, submitting: [] };
}
function recordAssetIds(record: RecoveryDraftRecord): Set<string> {
  return new Set([...(record.draft?.attachmentIds ?? []), ...record.submitting.flatMap(d => d.attachmentIds)]);
}
function recordFailure(): void {
  failedWrites += 1;
  // No draft text, paths, scope keys, attachments, or error objects.
  console.warn('Renderer draft persistence failed', { failedWrites });
}
function writeRecord(key: string, record: RecoveryDraftRecord, storage: DraftStorage | undefined): boolean {
  if (!storage) return false;
  const previousIds = recordAssetIds(readRecord(key, storage));
  let committed = false;
  try {
    if (!record.draft && record.submitting.length === 0) storage.removeItem(`${PREFIX}${key}`);
    else storage.setItem(`${PREFIX}${key}`, JSON.stringify(record));
    committed = true;
    const retainedIds = recordAssetIds(record);
    for (const id of previousIds) {
      if (!retainedIds.has(id)) storage.removeItem(assetKey(key, id));
    }
    return true;
  } catch {
    if (!committed) {
      for (const id of recordAssetIds(record)) {
        if (!previousIds.has(id)) {
          try { storage.removeItem(assetKey(key, id)); } catch { /* Best effort. */ }
        }
      }
    }
    recordFailure();
    return false;
  }
}
function storeDraft(
  key: string, text: string, attachments: ComposerAttachment[], record: RecoveryDraftRecord,
  storage: DraftStorage | undefined,
): StoredDraft | null {
  if (!storage) return null;
  const knownIds = recordAssetIds(record);
  const writtenKeys: string[] = [];
  try {
    // Attachment ids identify immutable payloads. Keystrokes only rewrite the
    // small metadata record, never parse/stringify image data or large pastes.
    for (const attachment of attachments) {
      const storageId = attachmentStorageId(attachment);
      if (knownIds.has(storageId)) continue;
      const keyForAsset = assetKey(key, storageId);
      storage.setItem(keyForAsset, JSON.stringify(attachment.kind === 'image'
        ? { ...attachment, objectUrl: null } : attachment));
      writtenKeys.push(keyForAsset);
    }
    return { id: `${Date.now()}-${++nextDraftId}`, text, attachmentIds: attachments.map(attachmentStorageId) };
  } catch {
    for (const writtenKey of writtenKeys) {
      try { storage.removeItem(writtenKey); } catch { /* Best effort orphan cleanup. */ }
    }
    recordFailure();
    return null;
  }
}
function hydrateDraft(key: string, draft: StoredDraft, storage: DraftStorage | undefined): RecoveryDraft | null {
  try {
    const attachments: ComposerAttachment[] = [];
    for (const id of draft.attachmentIds) {
      const raw = storage?.getItem(assetKey(key, id));
      if (!raw) return null; // Never restore image placeholders without their payload.
      const attachment = JSON.parse(raw) as ComposerAttachment;
      if (attachment.id !== JSON.parse(id)[0] || typeof attachment.name !== 'string'
        || !['image', 'file', 'text'].includes(attachment.kind)) return null;
      if (attachment.kind === 'image') {
        if (typeof attachment.base64Data !== 'string' || typeof attachment.mediaType !== 'string'
          || typeof attachment.placeholder !== 'string') return null;
        attachment.objectUrl = null;
      }
      if (attachment.kind === 'file' && typeof attachment.absolutePath !== 'string') return null;
      if (attachment.kind === 'text' && typeof attachment.content !== 'string') return null;
      attachments.push(attachment);
    }
    return { id: draft.id, text: draft.text, attachments, ...(draft.annotations ? { annotations: draft.annotations } : {}) };
  } catch { return null; }
}
export function readRecoveryDraft(
  key: string | undefined, recovering: boolean, storage = defaultStorage(),
): RecoveryDraft | null {
  if (!key || !recovering) return null;
  const draft = readRecord(key, storage).draft;
  return draft ? hydrateDraft(key, draft, storage) : null;
}
/** Synchronous on edit: unexpected WebContent death cannot run unload handlers. */
export function writeRecoveryDraft(
  key: string | undefined, text: string, attachments: ComposerAttachment[], storage = defaultStorage(),
): string | null {
  if (!key) return null;
  const record = readRecord(key, storage);
  const draft = text.length > 0 || attachments.length > 0
    ? storeDraft(key, text, attachments, record, storage) : null;
  if ((text.length > 0 || attachments.length > 0) && !draft) return null;
  record.draft = draft;
  return writeRecord(key, record, storage) ? draft?.id ?? null : null;
}
export function beginRecoveryDraftSubmission(
  key: string | undefined, text: string, attachments: ComposerAttachment[], capturedDraftId: string | null,
  storage = defaultStorage(),
  annotations?: WorkspaceAnnotation[],
): string | null {
  if (!key) return null;
  const record = readRecord(key, storage);
  const submission = storeDraft(key, text, attachments, record, storage);
  if (submission) {
    if (annotations?.length) submission.annotations = annotations;
    if (record.draft?.id === capturedDraftId) record.draft = null;
    record.submitting.push(submission);
    if (writeRecord(key, record, storage)) return submission.id;
  }
  // Quota failure cannot leave an old sendable copy once IPC admission starts.
  // This only invalidates a recovery cache; it does not clear the live editor.
  try {
    storage?.removeItem(`${PREFIX}${key}`);
    for (const id of recordAssetIds(record)) storage?.removeItem(assetKey(key, id));
  } catch { /* Best effort. */ }
  return null;
}
export function readRejectedRecoveryDrafts(
  key: string | undefined, recovering: boolean, storage = defaultStorage(),
): RecoveryDraft[] {
  if (!key || !recovering) return [];
  return readRecord(key, storage).submitting.filter(draft => draft.rejected === true)
    .map(draft => hydrateDraft(key, draft, storage)).filter((draft): draft is RecoveryDraft => draft !== null);
}
export function discardRejectedRecoveryDraft(
  key: string | undefined, id: string, storage = defaultStorage(),
): void {
  if (!key) return;
  const record = readRecord(key, storage);
  record.submitting = record.submitting.filter(draft => draft.id !== id || draft.rejected !== true);
  writeRecord(key, record, storage);
}
export function finishRecoveryDraftSubmission(
  key: string | undefined, submissionId: string | null, admitted: boolean, storage = defaultStorage(),
): void {
  if (!key || !submissionId) return;
  const record = readRecord(key, storage);
  const submitted = record.submitting.find(draft => draft.id === submissionId);
  if (!submitted) return;
  if (!admitted && record.draft) {
    // A newer edit occupies the editor. Keep the captured rejected payload
    // separate, matching the existing rejected-draft UI, without replacing it.
    submitted.rejected = true;
  } else {
    record.submitting = record.submitting.filter(draft => draft.id !== submissionId);
    if (!admitted) record.draft = submitted;
  }
  writeRecord(key, record, storage);
}
export function recoveryDraftDiagnostics(storage?: Storage): {
  drafts: number; uncertain: number; rejected: number; failedWrites: number;
} {
  const counters = { drafts: 0, uncertain: 0, rejected: 0, failedWrites };
  try {
    const target = storage ?? (typeof window === 'undefined' ? undefined : window.sessionStorage);
    if (!target) return counters;
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (!key?.startsWith(PREFIX)) continue;
      const record = readRecord(key.slice(PREFIX.length), target);
      if (record.draft) counters.drafts += 1;
      for (const submitted of record.submitting) {
        if (submitted.rejected) counters.rejected += 1;
        else counters.uncertain += 1;
      }
    }
  } catch { /* Aggregate metadata only; attachment bodies are not read. */ }
  return counters;
}
