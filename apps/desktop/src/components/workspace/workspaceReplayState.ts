import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { filterConfirmedLocalUserPrompts, type LocalUserPrompt } from './workspaceEventTranscript';
import type { SessionEventRecord } from '@/lib/tauri-ipc';

/**
 * Cache an updater's result per input reference.
 *
 * While an older transition update is still pending, React keeps every later
 * update in the hook's base queue and re-runs it from the same frozen base
 * state on each render. Poll and backfill updaters merge the whole event
 * list, so without this each render re-merged every queued batch and the
 * cost grew with uptime. A replay sees the same `previous` reference, so it
 * can reuse the first result.
 */
export function memoizeReplayUpdater<T>(update: (previous: T) => T): (previous: T) => T {
  let cached: { input: T; output: T } | null = null;
  return (previous) => {
    if (cached && Object.is(cached.input, previous)) return cached.output;
    const output = update(previous);
    cached = { input: previous, output };
    return output;
  };
}

/**
 * Drop locally echoed prompts once the event stream confirms them.
 *
 * Only schedule a state update when something was actually confirmed. A
 * same-value updater is not free: with transition updates pending, React
 * cannot bail out eagerly, so every events change used to force an extra
 * synchronous render that interrupted the pending poll replay.
 */
export function usePruneConfirmedLocalUserPrompts(
  events: SessionEventRecord[],
  localUserPrompts: LocalUserPrompt[],
  unconfirmedLocalUserPrompts: LocalUserPrompt[],
  setLocalUserPrompts: Dispatch<SetStateAction<LocalUserPrompt[]>>,
) {
  useEffect(() => {
    if (unconfirmedLocalUserPrompts === localUserPrompts) return;
    setLocalUserPrompts((previous) => filterConfirmedLocalUserPrompts(previous, events));
  }, [events, localUserPrompts, setLocalUserPrompts, unconfirmedLocalUserPrompts]);
}
