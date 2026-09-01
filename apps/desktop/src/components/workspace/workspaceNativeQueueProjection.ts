import type { NativeQueuedInputSnapshotItem } from '@/lib/tauri-ipc';
import type {
  LocalUserPrompt,
  NativeQueuedPromptDeliveryState,
} from './workspaceEventTranscript';

export interface NativeQueueReconcileOptions {
  activeCommandId?: string | null;
  afterEventSeq?: number;
  expectedQueueCount?: number;
  isTerminal: boolean;
  now?: number;
}

function normalizeDeliveryState(value: string): NativeQueuedPromptDeliveryState {
  if (value === 'dispatching' || value === 'delivery_uncertain') {
    return value;
  }
  return 'pending';
}

/**
 * Reconciles optimistic prompt rows with the backend-owned queue projection.
 * A lifecycle count, when present, fences an incomplete snapshot. When the
 * coordinator projection is temporarily unavailable (for example after a
 * backend dev restart), the backend snapshot itself remains authoritative;
 * request sequencing in the caller prevents pre-submit responses from winning.
 */
export function reconcileNativeQueuedPrompts(
  previous: LocalUserPrompt[],
  items: NativeQueuedInputSnapshotItem[],
  options: NativeQueueReconcileOptions,
): LocalUserPrompt[] {
  const snapshotById = new Map(items.map((item) => [item.client_message_id, item]));
  const snapshotIsComplete = options.expectedQueueCount == null
    || options.expectedQueueCount === items.length;
  const next: LocalUserPrompt[] = [];
  let changed = false;

  for (const prompt of previous) {
    const item = snapshotById.get(prompt.id);
    if (item) {
      snapshotById.delete(prompt.id);
      const queuedDeliveryState = normalizeDeliveryState(item.delivery_state);
      if (
        prompt.queuedBehindTurn !== true
        || prompt.queuedDeliveryState !== queuedDeliveryState
      ) {
        next.push({
          ...prompt,
          queuedBehindTurn: true,
          queuedDeliveryState,
        });
        changed = true;
      } else {
        next.push(prompt);
      }
      continue;
    }

    if (prompt.queuedBehindTurn !== true || !snapshotIsComplete) {
      next.push(prompt);
      continue;
    }

    // The backend appends the persisted user_prompt before removing an
    // admitted queue head. Therefore an absent queued row is either already
    // represented by transcript events or was cancelled; retaining or
    // reclassifying the optimistic row would create a duplicate/ghost.
    changed = true;
  }

  for (const item of items) {
    if (!snapshotById.has(item.client_message_id)) {
      continue;
    }
    next.push({
      id: item.client_message_id,
      text: item.display_text,
      images: item.images,
      annotations: item.annotations,
      timestamp: options.now ?? Date.now(),
      afterEventSeq: options.afterEventSeq,
      deferUntilPersisted: true,
      queuedBehindTurn: true,
      queuedDeliveryState: normalizeDeliveryState(item.delivery_state),
    });
    changed = true;
  }

  return changed ? next : previous;
}
