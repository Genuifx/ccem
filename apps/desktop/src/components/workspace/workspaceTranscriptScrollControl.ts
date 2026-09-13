/**
 * Unified transcript scroll control (REQ-0023, diagnosis candidate 1).
 *
 * The live transcript disables browser scroll anchoring (it fights the
 * top-windowing spacer), so asynchronous content height changes — tool digest
 * auto expand/collapse, markdown image load, the lazy code highlighter swap —
 * used to land AFTER the parent's event-count-driven bottom-pin ladder had
 * finished its fixed scroll passes. In follow mode that leaves the viewport off
 * the bottom; in reading mode content above the viewport shifts the reading
 * position with nothing to correct it.
 *
 * This module restores both invariants from one entry point:
 *
 * - Follow mode: a content resize scrolls back to the bottom.
 * - Reading mode: the FIRST VISIBLE transcript item, captured continuously at
 *   the last scroll event (i.e. BEFORE the resize), is re-applied exactly.
 *   Re-application is idempotent — when another mechanism (windowing anchor
 *   compensation) already restored the position, the computed delta is <1px
 *   and nothing happens, so the two systems compose instead of fighting.
 *
 * Compensations only assign scrollTop and never mutate content size, so they
 * cannot re-trigger the ResizeObserver (no observer/scroll loop).
 */

/** Distance from the anchor's target position below which we do nothing. */
export const TRANSCRIPT_ANCHOR_EPSILON_PX = 1;
/**
 * A scroll event during a programmatic sequence reports a position this far
 * from the value we assigned → the user intervened (scrollbar drag, touch,
 * keyboard). Matches the `ignoreScrollToTop` technique from use-stick-to-bottom.
 */
export const TRANSCRIPT_USER_SCROLL_INTERVENTION_PX = 4;

export interface TranscriptReadingAnchor {
  key: string;
  /** Anchor item's top relative to the container's viewport top when captured. */
  viewportTopOffset: number;
}

interface AnchoredContainer {
  getBoundingClientRect: () => { top: number };
  scrollTop: number;
}

/**
 * First transcript item intersecting the container viewport, with its offset
 * from the viewport top. Items are queried by the same
 * `data-transcript-item-key` marker the windowing code uses.
 */
export function findTranscriptReadingAnchor(
  container: AnchoredContainer,
  root: ParentNode,
): TranscriptReadingAnchor | null {
  const containerTop = container.getBoundingClientRect().top;
  const children = root.querySelectorAll<HTMLElement>('[data-transcript-item-key]');
  for (const child of Array.from(children)) {
    const rect = child.getBoundingClientRect();
    if (rect.bottom > containerTop + 1) {
      return {
        key: child.dataset.transcriptItemKey ?? '',
        viewportTopOffset: rect.top - containerTop,
      };
    }
  }
  return null;
}

/**
 * Re-apply a reading anchor: shift scrollTop by the anchor item's real rect
 * delta so the item returns to the offset it had when the anchor was captured.
 * Returns the applied delta (0 when already in place or anchor not found).
 */
export function applyTranscriptReadingAnchor(
  container: AnchoredContainer & { scrollTop: number },
  root: ParentNode,
  anchor: TranscriptReadingAnchor,
): number {
  if (!anchor.key) {
    return 0;
  }
  const anchorElement = root.querySelector<HTMLElement>(
    `[data-transcript-item-key="${cssEscape(anchor.key)}"]`,
  );
  if (!anchorElement) {
    // The anchor row itself got windowed away or unmounted: rather than guess,
    // leave the position alone — growth below the viewport needs no fix and the
    // windowing path owns its own compensation.
    return 0;
  }
  const delta = anchorElement.getBoundingClientRect().top
    - container.getBoundingClientRect().top
    - anchor.viewportTopOffset;
  if (Math.abs(delta) < TRANSCRIPT_ANCHOR_EPSILON_PX) {
    return 0;
  }
  container.scrollTop += delta;
  return delta;
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}

/**
 * True when a scroll event during a programmatic sequence must be treated as a
 * user intervention: the reported position is materially below (or above) the
 * exact value we assigned, which only user input (scrollbar drag, touch pan,
 * keyboard) can produce while the flag is up.
 */
export function isTranscriptUserScrollIntervention(params: {
  programmaticTarget: number;
  currentScrollTop: number;
}): boolean {
  return Math.abs(params.currentScrollTop - params.programmaticTarget)
    >= TRANSCRIPT_USER_SCROLL_INTERVENTION_PX;
}

export interface TranscriptResizeCompensatorOptions {
  container: HTMLElement;
  /** Live content element getter (ref-based; may not be mounted yet). */
  getContentElement: () => HTMLElement | null;
  /** True while the transcript should follow the tail (not detached/hidden). */
  isFollowMode: () => boolean;
  /** Follow-mode bottom pin; the caller owns the programmatic flag protocol. */
  scrollToBottom: (container: HTMLElement) => void;
}

export interface TranscriptResizeCompensator {
  /** React to a content size change (wired to a ResizeObserver when present). */
  handleContentResize: () => void;
  dispose: () => void;
}

interface TrackedReadingAnchor {
  anchor: TranscriptReadingAnchor;
  /** Live element for the anchor key; survives className churn, dies on remount. */
  element: HTMLElement | null;
  /** Content height when the anchor was captured/refreshed (delta fallback). */
  contentHeight: number;
}

/**
 * Attach the unified content-resize compensation. A hidden (display:none)
 * container reports zero geometry and is always ignored; anchors are captured
 * on real scroll events only while reading, so follow mode pays nothing.
 */
export function attachTranscriptResizeCompensator(
  options: TranscriptResizeCompensatorOptions,
): TranscriptResizeCompensator {
  const { container, getContentElement, isFollowMode, scrollToBottom } = options;
  let tracked: TrackedReadingAnchor | null = null;

  const isMeasurable = () => container.clientWidth > 0 && container.clientHeight > 0;

  const handleScroll = () => {
    if (!isMeasurable() || isFollowMode()) {
      // Follow mode needs no anchor (it pins to the bottom instead), and a
      // zero-geometry container must not capture garbage anchors.
      if (isFollowMode()) {
        tracked = null;
      }
      return;
    }
    const content = getContentElement();
    if (!content) {
      return;
    }
    const anchor = findTranscriptReadingAnchor(container, content);
    if (!anchor) {
      tracked = null;
      return;
    }
    const element = content.querySelector<HTMLElement>(
      `[data-transcript-item-key="${cssEscape(anchor.key)}"]`,
    );
    tracked = {
      anchor,
      element,
      contentHeight: container.scrollHeight,
    };
  };

  const handleContentResize = () => {
    if (!isMeasurable()) {
      return;
    }
    if (isFollowMode()) {
      scrollToBottom(container);
      return;
    }
    if (!tracked) {
      return;
    }
    const content = getContentElement();
    if (!content) {
      return;
    }
    // Anchor resolution order: the live element (survives className churn),
    // then the key (React may re-render the same key onto a new element),
    // then the content-height delta. The key changes when a pending turn
    // finalizes its provider uuid — that remount replaces the element AND the
    // key, and only the delta can still hold the reading position (the same
    // fallback the backfill anchor restore uses).
    const element = tracked.element && tracked.element.isConnected
      ? tracked.element
      : content.querySelector<HTMLElement>(
        `[data-transcript-item-key="${cssEscape(tracked.anchor.key)}"]`,
      );
    if (element) {
      const delta = element.getBoundingClientRect().top
        - container.getBoundingClientRect().top
        - tracked.anchor.viewportTopOffset;
      tracked.element = element;
      tracked.contentHeight = container.scrollHeight;
      if (Math.abs(delta) >= TRANSCRIPT_ANCHOR_EPSILON_PX) {
        container.scrollTop += delta;
      }
      return;
    }
    const heightDelta = container.scrollHeight - tracked.contentHeight;
    tracked.contentHeight = container.scrollHeight;
    if (Math.abs(heightDelta) >= TRANSCRIPT_ANCHOR_EPSILON_PX && container.scrollTop > 0) {
      container.scrollTop += heightDelta;
    }
  };

  container.addEventListener('scroll', handleScroll, { passive: true });

  // The content element is stable for a mounted session view (it renders even
  // for an empty transcript); callers re-attach across session switches. In
  // environments without ResizeObserver the exported handler can still be
  // driven directly (that is also how the jsdom regression tests exercise it).
  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    const content = getContentElement();
    if (content) {
      resizeObserver = new ResizeObserver(() => {
        handleContentResize();
      });
      resizeObserver.observe(content);
    }
  }

  return {
    handleContentResize,
    dispose() {
      container.removeEventListener('scroll', handleScroll);
      resizeObserver?.disconnect();
    },
  };
}
