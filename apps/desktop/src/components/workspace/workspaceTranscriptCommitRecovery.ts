import { startTransition } from 'react';
import { flushSync } from 'react-dom';
import {
  transcriptBackfillCommitMatches,
  type TranscriptBackfillCommitIdentity,
} from './workspaceTranscriptBackfill';

export const TRANSCRIPT_COMMIT_DEADLINE_MS = 2_000;
type CommitKind = 'poll' | 'backfill';
type Commit = (isOwned: () => boolean, canReplayEvents: () => boolean) => void;

/** A read is not acknowledged until its events and marker commit together.
 * Keep one owner per drain, so repeated polls cannot renew a stalled deadline.
 * The normal path stays concurrent; one timer task can promote an overdue
 * batch. Cancellation also makes its already queued React updaters inert.
 */
export function createTranscriptCommitRecovery({
  isCurrent,
  isSameRuntime,
  onRecover,
}: {
  isCurrent: (identity: TranscriptBackfillCommitIdentity) => boolean;
  isSameRuntime: (identity: TranscriptBackfillCommitIdentity) => boolean;
  onRecover: (identity: TranscriptBackfillCommitIdentity, kind: CommitKind) => void;
}) {
  const pending = new Map<CommitKind, {
    identity: TranscriptBackfillCommitIdentity;
    timer: ReturnType<typeof setTimeout>;
    landed: boolean;
  }>();
  return {
    hasPending: (kind: CommitKind) => pending.has(kind),
    enqueue(kind: CommitKind, identity: TranscriptBackfillCommitIdentity, commit: Commit, immediate = false) {
      if (pending.has(kind) || !isCurrent(identity)) return;
      const owner = {
        identity,
        landed: false,
        timer: globalThis.setTimeout(() => {
          if (pending.get(kind) !== owner || !isCurrent(identity)) return;
          onRecover(identity, kind);
          // Last resort, once per owned batch, outside React's lifecycle.
          // Do not retry this synchronously on every poll or stream fragment.
          flushSync(() => commit(isOwned, canReplayEvents));
        }, TRANSCRIPT_COMMIT_DEADLINE_MS),
      };
      // React may replay a committed synchronous updater while rebasing the
      // older transition lane. It must remain idempotently applicable after
      // acknowledgement; otherwise rebasing would roll the DOM back.
      const isOwned = () => (pending.get(kind) === owner || owner.landed) && isCurrent(identity);
      // A retained view changes generation when hidden. Its already committed
      // event updaters still participate in React's later lane rebase; skipping
      // them would roll events back while the acknowledged cursor stays ahead.
      // Only events may replay across generations, never markers/UI side effects.
      const canReplayEvents = () => isOwned() || (owner.landed && isSameRuntime(identity));
      pending.set(kind, owner);
      if (immediate) commit(isOwned, canReplayEvents);
      else startTransition(() => commit(isOwned, canReplayEvents));
    },
    acknowledge(kind: CommitKind, marker: TranscriptBackfillCommitIdentity) {
      const owner = pending.get(kind);
      if (!owner || !transcriptBackfillCommitMatches(owner.identity, marker)) return;
      owner.landed = true;
      globalThis.clearTimeout(owner.timer);
      pending.delete(kind);
    },
    cancel() {
      for (const owner of pending.values()) globalThis.clearTimeout(owner.timer);
      pending.clear();
    },
  };
}
