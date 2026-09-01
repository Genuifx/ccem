import type { NativeQueuedInputSnapshotItem } from '@/lib/tauri-ipc';
import type {
  LocalUserPrompt,
  NativeQueuedPromptDeliveryState,
} from './workspaceEventTranscript';

export interface NativeQueuedComposerMessage {
  id: string;
  text: string;
  displayText: string;
  deliveryState: NativeQueuedPromptDeliveryState;
  removable: boolean;
  flushable: false;
}

export interface NativeQueuedPromptPresentation {
  transcriptPrompts: LocalUserPrompt[];
  composerQueuedMessages: NativeQueuedComposerMessage[];
}

export interface NativeQueueReconcileOptions {
  activeCommandId?: string | null;
  afterEventSeq?: number;
  expectedQueueCount?: number;
  isTerminal: boolean;
  now?: number;
  observedClientMessageIds?: ReadonlySet<string>;
}

function normalizeDeliveryState(value: string): NativeQueuedPromptDeliveryState {
  if (value === 'dispatching' || value === 'delivery_uncertain') {
    return value;
  }
  return 'pending';
}

/**
 * Keeps backend-owned queued prompts in the established dock above the
 * composer. They enter the transcript only after a persisted `user_prompt`
 * event confirms helper admission and removes the matching optimistic row.
 */
export function partitionNativeQueuedPromptPresentation(
  prompts: LocalUserPrompt[],
): NativeQueuedPromptPresentation {
  const transcriptPrompts: LocalUserPrompt[] = [];
  const composerQueuedMessages: NativeQueuedComposerMessage[] = [];

  for (const prompt of prompts) {
    if (prompt.queuedBehindTurn === true && prompt.deferUntilPersisted === true) {
      composerQueuedMessages.push({
        id: prompt.id,
        text: prompt.text,
        displayText: prompt.text,
        deliveryState: prompt.queuedDeliveryState ?? 'pending',
        removable: (prompt.queuedDeliveryState ?? 'pending') === 'pending',
        flushable: false,
      });
      continue;
    }
    transcriptPrompts.push(prompt);
  }

  return { transcriptPrompts, composerQueuedMessages };
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
  const snapshotIsComplete = options.expectedQueueCount == null
    || options.expectedQueueCount === items.length;

  if (snapshotIsComplete) {
    const snapshotIds = new Set(items.map((item) => item.client_message_id));
    const previousById = new Map(previous.map((prompt) => [prompt.id, prompt]));
    const next: LocalUserPrompt[] = [];

    for (const prompt of previous) {
      if (snapshotIds.has(prompt.id)) {
        continue;
      }
      if (prompt.queuedBehindTurn !== true) {
        next.push(prompt);
        continue;
      }
      // Backend persistence precedes dequeue, but renderer observation can
      // trail the snapshot. Keep that transition row until the matching event
      // reaches React state; absence without an observed event is cancellation
      // or queue loss and is removed immediately.
      if (options.observedClientMessageIds?.has(prompt.id)) {
        next.push(prompt);
      }
    }

    for (const item of items) {
      const prompt = previousById.get(item.client_message_id);
      const queuedDeliveryState = normalizeDeliveryState(item.delivery_state);
      if (
        prompt
        && prompt.queuedBehindTurn === true
        && prompt.queuedDeliveryState === queuedDeliveryState
      ) {
        next.push(prompt);
        continue;
      }
      if (prompt) {
        next.push({
          ...prompt,
          queuedBehindTurn: true,
          queuedDeliveryState,
        });
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
        queuedDeliveryState,
      });
    }

    const unchanged = next.length === previous.length
      && next.every((prompt, index) => prompt === previous[index]);
    return unchanged ? previous : next;
  }

  const snapshotById = new Map(items.map((item) => [item.client_message_id, item]));
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

    next.push(prompt);
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
