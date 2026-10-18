import type { SessionEventRecord } from '@/lib/tauri-ipc';
import { selectEventAppendRange } from './workspaceEventTranscript';

/**
 * Incrementally maintained subset of the events a derivation cares about.
 * Follows the same append/reset/idle contract as the usage and review folds:
 * appended events are filtered on arrival, a non-suffix change refilters the
 * whole list, and `relevant` keeps its identity when nothing relevant arrived
 * so downstream memos can skip recomputation during fast polling.
 */
export interface EventSubsetFold {
  runtimeId: string | null;
  consumedSeq: number | null;
  consumedCount: number;
  relevant: SessionEventRecord[];
}

export function foldEventSubset(
  previous: EventSubsetFold | null,
  events: SessionEventRecord[],
  isRelevant: (event: SessionEventRecord) => boolean,
): EventSubsetFold {
  const consumedSeq = events[events.length - 1]?.seq ?? null;
  if (previous) {
    const selection = selectEventAppendRange(
      events,
      previous.consumedSeq,
      previous.consumedCount,
      previous.runtimeId,
    );
    if (selection.mode === 'idle') {
      return previous;
    }
    if (selection.mode === 'append') {
      const added = selection.appended.filter(isRelevant);
      return {
        runtimeId: previous.runtimeId ?? selection.appended[0]?.runtime_id ?? null,
        consumedSeq,
        consumedCount: previous.consumedCount + selection.appended.length,
        relevant: added.length ? [...previous.relevant, ...added] : previous.relevant,
      };
    }
  }
  return {
    runtimeId: events[0]?.runtime_id ?? null,
    consumedSeq,
    consumedCount: events.length,
    relevant: events.filter(isRelevant),
  };
}
