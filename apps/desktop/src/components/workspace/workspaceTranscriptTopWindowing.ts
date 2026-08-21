/**
 * Pure math for the transcript top windowing (plan 022, step 4 + anchor fix).
 *
 * Heights are cached per item key, so one dynamically expanded digest only
 * affects its own entry and never re-estimates other rows. Unmeasured rows
 * fall back to the MEDIAN of measured heights — an outlier-resistant typical
 * height, because a single expanded ~3000px row among a handful of measured
 * rows must not stretch the spacer for hundreds of hidden rows by tens of
 * thousands of pixels (the regression a plain mean reintroduced).
 *
 * The cache is only valid for the content width it was measured at; callers
 * reset it whenever the container width changes so heights re-measure safely.
 */

/** Items more than this many viewports above the scroll top can collapse. */
export const TOP_WINDOWING_VIEWPORTS_ABOVE = 8;
/** Never window below this many rendered items (tail safety floor). */
export const TOP_WINDOWING_MIN_RENDERED_ITEMS = 24;
/** Fallback item height before any measurement (typical message row). */
export const TOP_WINDOWING_DEFAULT_ITEM_HEIGHT = 72;

export interface TranscriptItemHeightCache {
  /** Content width the heights were measured at; null before first measure. */
  width: number | null;
  /**
   * Outer heights (element height + vertical margins) per item key. The
   * spacer replaces the item's full flow box, and `mt-*` spacing classes
   * live outside `offsetHeight`, so margins must be part of the height.
   */
  heights: Map<string, number>;
  /** Vertical margin per item key (measured once; stable for a given key). */
  margins: Map<string, number>;
}

export function createTranscriptItemHeightCache(): TranscriptItemHeightCache {
  return { width: null, heights: new Map(), margins: new Map() };
}

/**
 * Typical item height for unmeasured rows. Median, not mean: one giant
 * expanded row is a legitimate outlier and must not move the estimate.
 */
export function medianMeasuredItemHeight(heights: Map<string, number>): number {
  if (heights.size === 0) {
    return TOP_WINDOWING_DEFAULT_ITEM_HEIGHT;
  }
  const values = Array.from(heights.values())
    .filter((height) => height > 0)
    .sort((a, b) => a - b);
  if (values.length === 0) {
    return TOP_WINDOWING_DEFAULT_ITEM_HEIGHT;
  }
  const middle = values.length >> 1;
  const median = values.length % 2 === 1
    ? values[middle]!
    : (values[middle - 1]! + values[middle]!) / 2;
  return median > 0 ? median : TOP_WINDOWING_DEFAULT_ITEM_HEIGHT;
}

/** Height used for one item: its own measurement when known, else the median. */
export function estimateTranscriptItemHeight(
  cache: TranscriptItemHeightCache,
  key: string,
): number {
  const cached = cache.heights.get(key);
  if (cached != null && cached > 0) {
    return cached;
  }
  return medianMeasuredItemHeight(cache.heights);
}

/** Spacer height covering the windowed-away items (rounded to whole px). */
export function computeTopSpacerHeight(
  windowedKeys: readonly string[],
  cache: TranscriptItemHeightCache,
): number {
  // Compute the fallback once. Calling estimateTranscriptItemHeight for every
  // unknown key would sort the full measurement set once per key, turning a
  // render of a long transcript into avoidable quadratic-ish work.
  let fallbackHeight: number | null = null;
  let total = 0;
  for (const key of windowedKeys) {
    const cached = cache.heights.get(key);
    if (cached != null && cached > 0) {
      total += cached;
      continue;
    }
    fallbackHeight ??= medianMeasuredItemHeight(cache.heights);
    total += fallbackHeight;
  }
  return Math.round(total);
}

/** True only when an item actually intersects the viewport. */
export function transcriptItemIntersectsViewport(
  itemTop: number,
  itemBottom: number,
  viewportTop: number,
  viewportBottom: number,
): boolean {
  return itemBottom > viewportTop + 1 && itemTop < viewportBottom - 1;
}

export interface TopWindowCountParams {
  scrollTop: number;
  /** Content-space top of the list (spacer included). */
  listTopInContent: number;
  viewportHeight: number;
  itemKeys: readonly string[];
  heightCache: TranscriptItemHeightCache;
  viewportsAbove?: number;
  minRenderedItems?: number;
}

export function computeNextTopWindowCount(params: TopWindowCountParams): number {
  const {
    scrollTop,
    listTopInContent,
    viewportHeight,
    itemKeys,
    heightCache,
  } = params;
  const viewportsAbove = params.viewportsAbove ?? TOP_WINDOWING_VIEWPORTS_ABOVE;
  const minRenderedItems = params.minRenderedItems ?? TOP_WINDOWING_MIN_RENDERED_ITEMS;
  const bufferPx = viewportsAbove * viewportHeight;
  const hideablePx = scrollTop - bufferPx - listTopInContent;
  if (!(hideablePx > 0)) {
    return 0;
  }

  const maxHidden = Math.max(0, itemKeys.length - minRenderedItems);
  let fallbackHeight: number | null = null;
  let accumulatedHeight = 0;
  for (let index = 0; index < maxHidden; index += 1) {
    const cached = heightCache.heights.get(itemKeys[index]!);
    let itemHeight = cached;
    if (itemHeight == null || itemHeight <= 0) {
      fallbackHeight ??= medianMeasuredItemHeight(heightCache.heights);
      itemHeight = fallbackHeight;
    }
    if (accumulatedHeight + itemHeight > hideablePx) {
      return index;
    }
    accumulatedHeight += itemHeight;
  }
  return maxHidden;
}

/**
 * A hidden (display:none) scroll container reports zero-width/height and zero
 * item measurements; every windowing decision and cache write must be skipped
 * for it, otherwise zero heights pollute the estimates and the window count
 * collapses while the session is backgrounded.
 */
export function isWindowingViewportMeasurable(
  element: { clientWidth: number; clientHeight: number } | null | undefined,
): boolean {
  if (!element) {
    return false;
  }
  return element.clientWidth > 0 && element.clientHeight > 0;
}

/**
 * On switch-back, a restored non-bottom reading position wins over automatic
 * tail following. Keep this transition-only so normal streaming growth does
 * not look like a user scroll-away.
 */
export function shouldPreserveRestoredReadingPosition(params: {
  becameVisible: boolean;
  previousEventCount: number;
  isNearBottom: boolean;
}): boolean {
  return params.becameVisible && params.previousEventCount > 0 && !params.isNearBottom;
}
