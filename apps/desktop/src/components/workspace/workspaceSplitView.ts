// Workspace split view: several live sessions shown side by side. The panes
// are identified by native runtime id; only one pane is focused at a time and
// that focus is the workspace's ordinary active live runtime.

export const MAX_SPLIT_PANES = 4;

const HISTORY_PANE_PREFIX = 'history:';

/** Pane id for a session shown from provider history (no native runtime). */
export function toSplitHistoryPaneId(sessionKey: string): string {
  return `${HISTORY_PANE_PREFIX}${sessionKey}`;
}

export function isSplitHistoryPaneId(paneId: string): boolean {
  return paneId.startsWith(HISTORY_PANE_PREFIX);
}

export type SplitToggleResult =
  | { kind: 'added'; paneIds: string[] }
  | { kind: 'removed'; paneIds: string[] }
  | { kind: 'full'; paneIds: string[] };

/**
 * Add or remove `runtimeId`. When no split exists yet, the session currently
 * on screen (`seedId`) becomes the first pane so Cmd+click "adds a second".
 */
export function toggleSplitPane(
  paneIds: readonly string[],
  seedId: string | null,
  runtimeId: string,
): SplitToggleResult {
  // A group below two panes is not a split: start over from what is on screen.
  const start = paneIds.length >= 2 ? [...paneIds] : seedId ? [seedId] : [...paneIds];
  if (start.includes(runtimeId)) {
    const remaining = start.filter((id) => id !== runtimeId);
    return { kind: 'removed', paneIds: remaining.length >= 2 ? remaining : [] };
  }
  if (start.length >= MAX_SPLIT_PANES) {
    return { kind: 'full', paneIds: [...paneIds] };
  }
  return { kind: 'added', paneIds: [...start, runtimeId] };
}

/** Drop panes whose live entry is gone. Returns the input when unchanged. */
export function pruneSplitPanes(
  paneIds: string[],
  liveRuntimeIds: ReadonlySet<string>,
): string[] {
  const next = paneIds.filter((id) => liveRuntimeIds.has(id));
  if (next.length === paneIds.length) return paneIds;
  return next.length >= 2 ? next : [];
}

/** The split is on screen only while the focused session is one of its panes. */
export function isSplitViewShown(
  paneIds: readonly string[],
  activeRuntimeId: string | null,
): boolean {
  return paneIds.length >= 2 && activeRuntimeId !== null && paneIds.includes(activeRuntimeId);
}

/** Focus target after closing a pane: keep focus unless the closed pane had it. */
export function focusAfterClosingPane(
  paneIds: readonly string[],
  closedId: string,
  activeRuntimeId: string | null,
): string | null {
  if (activeRuntimeId !== closedId) return activeRuntimeId;
  const index = paneIds.indexOf(closedId);
  const remaining = paneIds.filter((id) => id !== closedId);
  return remaining[Math.min(Math.max(index, 0), remaining.length - 1)] ?? null;
}

const SPLIT_PANE_MIN_WIDTH = 320;
const SPLIT_PANE_MIN_HEIGHT = 360;

/**
 * Grid for `count` panes in a `width` x `height` area. Each candidate column
 * count is scored by its tighter dimension relative to the readable minimum
 * (a pane needs room for the transcript AND the composer), and rows stay
 * balanced so 4 panes become 2x2 rather than 3+1. Ties keep more columns:
 * chat reads best tall.
 */
export function splitGridLayout(
  count: number,
  width: number,
  height: number,
): { columns: number; rows: number } {
  const panes = Math.max(1, count);
  let best = { columns: panes, rows: 1 };
  let bestScore = -1;
  for (let columns = panes; columns >= 1; columns -= 1) {
    const rows = Math.ceil(panes / columns);
    // Balanced: 4 panes in 3 columns would need 2 rows anyway, so use 2x2.
    if (Math.ceil(panes / rows) !== columns) continue;
    const score = Math.min(
      width / columns / SPLIT_PANE_MIN_WIDTH,
      height / rows / SPLIT_PANE_MIN_HEIGHT,
    );
    if (score > bestScore + 1e-9) {
      best = { columns, rows };
      bestScore = score;
    }
  }
  return best;
}
