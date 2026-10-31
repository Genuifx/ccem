import type { SessionEventRecord } from '@/lib/tauri-ipc';

export type NativeFileCheckpointStatus = 'available' | 'rewound' | 'failed';

export interface NativeFileCheckpoint {
  checkpointId: string;
  providerSessionId: string | null;
  runtimeId: string;
  createdAt: string;
  turnIndex: number;
  promptSummary: string | null;
  status: NativeFileCheckpointStatus;
  source: 'claude-file-checkpoint';
  error?: string | null;
}

/** Events that can change `deriveNativeFileCheckpoints`. */
export function isFileCheckpointEvent(event: SessionEventRecord): boolean {
  const type = event.payload.type;
  return type === 'checkpoint_created' || type === 'files_rewound' || type === 'file_rewind_failed';
}

export function deriveNativeFileCheckpoints(
  events: SessionEventRecord[],
): NativeFileCheckpoint[] {
  const checkpoints = new Map<string, NativeFileCheckpoint>();
  let turnIndex = 0;

  for (const event of events) {
    const payload = event.payload;
    if (
      payload.type === 'checkpoint_created'
      && payload.provider === 'claude'
      && payload.source === 'claude-file-checkpoint'
    ) {
      const existing = checkpoints.get(payload.checkpoint_id);
      if (existing) {
        checkpoints.set(payload.checkpoint_id, {
          ...existing,
          providerSessionId: payload.provider_session_id ?? existing.providerSessionId,
          promptSummary: payload.prompt_summary ?? existing.promptSummary,
        });
        continue;
      }

      turnIndex += 1;
      checkpoints.set(payload.checkpoint_id, {
        checkpointId: payload.checkpoint_id,
        providerSessionId: payload.provider_session_id ?? null,
        runtimeId: event.runtime_id,
        createdAt: event.occurred_at,
        turnIndex,
        promptSummary: payload.prompt_summary ?? null,
        status: 'available',
        source: 'claude-file-checkpoint',
        error: null,
      });
      continue;
    }

    if (payload.type === 'files_rewound') {
      const checkpoint = checkpoints.get(payload.checkpoint_id);
      if (checkpoint) {
        checkpoints.set(payload.checkpoint_id, {
          ...checkpoint,
          status: 'rewound',
          error: null,
        });
      }
      continue;
    }

    if (payload.type === 'file_rewind_failed') {
      const checkpoint = checkpoints.get(payload.checkpoint_id);
      if (checkpoint) {
        checkpoints.set(payload.checkpoint_id, {
          ...checkpoint,
          status: 'failed',
          error: payload.error,
        });
      }
    }
  }

  // turnIndex grows with Map insertion order, so reversing yields newest first.
  return Array.from(checkpoints.values()).reverse();
}

/** Events that can change `mapCheckpointsToUserPromptMessages`. */
export function isUserPromptCheckpointEvent(event: SessionEventRecord): boolean {
  return event.payload.type === 'user_prompt' || isFileCheckpointEvent(event);
}

/**
 * Keys each Claude file checkpoint by the transcript user message it belongs
 * to (`user-prompt-<seq>`, the id the event transcript gives a `user_prompt`).
 * The SDK echoes a user message — and the helper emits its checkpoint — after
 * the matching `user_prompt` event, so a checkpoint attaches to the nearest
 * preceding prompt that has none yet. SDK-only user messages (no preceding
 * unclaimed prompt) get no transcript anchor.
 */
export function mapCheckpointsToUserPromptMessages(
  events: SessionEventRecord[],
): Map<string, NativeFileCheckpoint> {
  const checkpointById = new Map(
    deriveNativeFileCheckpoints(events).map((checkpoint) => [checkpoint.checkpointId, checkpoint]),
  );
  const byMessageId = new Map<string, NativeFileCheckpoint>();
  const claimed = new Set<string>();
  let unclaimedPromptSeq: number | null = null;

  for (const event of events) {
    const payload = event.payload;
    if (payload.type === 'user_prompt') {
      unclaimedPromptSeq = event.seq;
      continue;
    }
    if (payload.type !== 'checkpoint_created' || unclaimedPromptSeq === null) {
      continue;
    }
    const checkpoint = checkpointById.get(payload.checkpoint_id);
    if (!checkpoint || claimed.has(checkpoint.checkpointId)) {
      continue;
    }
    claimed.add(checkpoint.checkpointId);
    byMessageId.set(`user-prompt-${unclaimedPromptSeq}`, checkpoint);
    unclaimedPromptSeq = null;
  }

  return byMessageId;
}
