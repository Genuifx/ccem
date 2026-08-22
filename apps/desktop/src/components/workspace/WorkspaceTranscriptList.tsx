import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { mergeToolResults } from '@/features/conversations/messageState';
import type {
  ConversationMessageData,
} from '@/features/conversations/types';
import { cn } from '@/lib/utils';
import { ccemMotion, clearMotionProps, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';
import {
  processMessageBlocks,
  WorkspaceMessageBubble,
  WorkspacePendingResponse,
  WorkspaceToolDigest,
  type MessageSegment,
  type ToolDigestEntry,
} from './WorkspaceMessageBubble';
import {
  computeNextTopWindowCount,
  computeTopSpacerHeight,
  createTranscriptItemHeightCache,
  isWindowingViewportMeasurable,
  transcriptItemIntersectsViewport,
  type TranscriptItemHeightCache,
} from './workspaceTranscriptTopWindowing';

const TOP_SPACER_DATASET = 'workspaceTranscriptTopSpacer';

export type WorkspaceTranscriptItem =
  | {
    type: 'message';
    key: string;
    role: 'user' | 'assistant';
    message: ConversationMessageData;
  }
  | {
    type: 'tool-digest';
    key: string;
    role: 'assistant';
    entries: ToolDigestEntry[];
  }
  | {
    type: 'pending-response';
    key: string;
    role: 'assistant';
  };

export function getWorkspaceMessageRole(
  message: ConversationMessageData,
): 'user' | 'assistant' {
  return message.msgType === 'user' || message.msgType === 'human'
    ? 'user'
    : 'assistant';
}

export function getWorkspaceTranscriptSpacing(
  prevRole: WorkspaceTranscriptItem['role'] | null,
  role: WorkspaceTranscriptItem['role'],
  kind: WorkspaceTranscriptItem['type'],
): string {
  if (prevRole == null) {
    return 'mt-0';
  }

  // Tighter spacing within the same role — conversational flow
  if (prevRole === role) {
    return kind === 'tool-digest' ? 'mt-2' : 'mt-3';
  }

  // Generous breathing room between different roles — turn boundaries
  // Tool digests get slightly tighter spacing than full messages
  return kind === 'tool-digest' ? 'mt-5' : 'mt-6';
}

const processedMessageSegmentsCache = new WeakMap<
  ConversationMessageData,
  {
    messageKey: string;
    content: ConversationMessageData['content'];
    isCompactBoundary: ConversationMessageData['isCompactBoundary'];
    planContent: ConversationMessageData['planContent'];
    msgType: ConversationMessageData['msgType'];
    segments: MessageSegment[];
  }
>();

const fallbackMessageKeys = new WeakMap<ConversationMessageData, string>();
let nextFallbackMessageKey = 0;

/**
 * Outer flow height of one transcript item: element height plus its vertical
 * margins. The spacer replaces the item's full flow box, and the `mt-*`
 * spacing classes live outside offsetHeight, so margins must be counted.
 * Returns 0-equivalent (just the margin) for unmeasurable rows.
 */
function measureTranscriptItemOuterHeight(
  element: HTMLElement,
  key: string,
  cache: TranscriptItemHeightCache,
): number {
  let margin = cache.margins.get(key);
  if (margin == null) {
    const style = window.getComputedStyle(element);
    margin = Math.max(0, Number.parseFloat(style.marginTop) || 0)
      + Math.max(0, Number.parseFloat(style.marginBottom) || 0);
    cache.margins.set(key, margin);
  }
  // offsetHeight is the flow-box height. getBoundingClientRect includes GSAP
  // transforms, so measuring during an entrance animation can cache a scaled
  // (and therefore stale) value that ResizeObserver will not correct because
  // transforms do not change layout size.
  return element.offsetHeight + margin;
}

function getStableMessageKey(message: ConversationMessageData): string {
  if (message.uuid) {
    return `message-${message.uuid}`;
  }

  const cached = fallbackMessageKeys.get(message);
  if (cached) {
    return cached;
  }

  nextFallbackMessageKey += 1;
  const key = `message-${message.segmentIndex}-${message.timestamp ?? 'untimed'}-${nextFallbackMessageKey}`;
  fallbackMessageKeys.set(message, key);
  return key;
}

function getProcessedMessageSegments(
  message: ConversationMessageData,
  messageKey: string,
): MessageSegment[] {
  const cached = processedMessageSegmentsCache.get(message);
  if (
    cached
    && cached.messageKey === messageKey
    && cached.content === message.content
    && cached.isCompactBoundary === message.isCompactBoundary
    && cached.planContent === message.planContent
    && cached.msgType === message.msgType
  ) {
    return cached.segments;
  }

  const segments = processMessageBlocks(message, messageKey);
  processedMessageSegmentsCache.set(message, {
    messageKey,
    content: message.content,
    isCompactBoundary: message.isCompactBoundary,
    planContent: message.planContent,
    msgType: message.msgType,
    segments,
  });
  return segments;
}

export function buildWorkspaceTranscriptItems(
  messages: ConversationMessageData[],
): WorkspaceTranscriptItem[] {
  const items: WorkspaceTranscriptItem[] = [];
  const pendingSegments: Array<MessageSegment & { key: string }> = [];
  const seenItemKeys = new Map<string, number>();

  const uniqueItemKey = (baseKey: string) => {
    const seenCount = seenItemKeys.get(baseKey) ?? 0;
    seenItemKeys.set(baseKey, seenCount + 1);
    return seenCount === 0 ? baseKey : `${baseKey}-${seenCount}`;
  };

  const pushToolDigest = (entries: ToolDigestEntry[], segmentKey: string) => {
    if (entries.length > 0) {
      items.push({
        type: 'tool-digest',
        role: 'assistant',
        key: uniqueItemKey(`${segmentKey}-digest`),
        entries,
      });
    }
  };

  const pushMessage = (message: ConversationMessageData, segmentKey: string) => {
    items.push({
      type: 'message',
      role: 'assistant',
      key: uniqueItemKey(`${segmentKey}-message`),
      message,
    });
  };

  const flushSegments = () => {
    // Merge consecutive tool-group segments across messages
    const merged: Array<MessageSegment & { key: string }> = [];
    for (const seg of pendingSegments) {
      if (
        seg.type === 'tool-group'
        && merged.length > 0
        && merged[merged.length - 1].type === 'tool-group'
      ) {
        const prev = merged[merged.length - 1];
        prev.entries.push(...seg.entries);
      } else {
        merged.push({
          key: seg.key,
          type: seg.type,
          message: seg.message,
          entries: [...seg.entries],
        });
      }
    }

    for (const seg of merged) {
      if (seg.type === 'text' && seg.message) {
        pushMessage(seg.message, seg.key);
      } else {
        pushToolDigest(seg.entries, seg.key);
      }
    }

    pendingSegments.length = 0;
  };

  messages.forEach((message) => {
    const role = getWorkspaceMessageRole(message);
    const messageKey = getStableMessageKey(message);

    if (role === 'user') {
      flushSegments();
      items.push({
        type: 'message',
        role,
        key: uniqueItemKey(`${messageKey}-message`),
        message,
      });
      return;
    }

    const segments = getProcessedMessageSegments(message, messageKey);
    pendingSegments.push(...segments.map((segment, segmentIndex) => ({
      ...segment,
      key: `${messageKey}-segment-${segmentIndex}`,
    })));
  });

  flushSegments();

  return items;
}

interface WorkspaceTranscriptListProps {
  messages: ConversationMessageData[];
  isAwaitingResponse?: boolean;
  /**
   * Opt-in top-windowing (plan 022): items far above the viewport render as an
   * estimated-height spacer. Only the live session view enables it; history
   * and review-detail lists keep the full render.
   */
  enableTopWindowing?: boolean;
  /** Scroll container (ScrollArea viewport) — required for top-windowing. */
  viewportRef?: RefObject<HTMLElement | null>;
  /**
   * Fork-session-from-turn action for model-output bubbles. Must be a stable
   * callback: bubbles are memoized on message identity only.
   */
  onForkTurn?: (message: ConversationMessageData) => void;
}

export function WorkspaceTranscriptList({
  messages,
  isAwaitingResponse = false,
  enableTopWindowing = false,
  viewportRef,
  onForkTurn,
}: WorkspaceTranscriptListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const seenItemKeysRef = useRef<Set<string>>(new Set());
  const hasHydratedMotionRef = useRef(false);
  /** Per-item-key measured heights; stable estimates immune to one giant row. */
  const heightCacheRef = useRef<TranscriptItemHeightCache>(createTranscriptItemHeightCache());
  /** Pending reading anchor to re-apply after the window/spacer shifts. */
  const windowAnchorRef = useRef<{
    key: string;
    viewportTopOffset: number;
    fromWindowCount: number;
  } | null>(null);
  const topWindowCountRef = useRef(0);
  const wasViewportMeasurableRef = useRef(false);
  const lastVisibleScrollTopRef = useRef(0);
  const itemResizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedItemKeysRef = useRef<Set<string>>(new Set());
  const [topWindowCount, setTopWindowCount] = useState(0);
  const mergedMessages = useMemo(() => mergeToolResults(messages), [messages]);
  const transcriptItems = useMemo(
    () => buildWorkspaceTranscriptItems(mergedMessages),
    [mergedMessages],
  );
  const activeDigestKey = useMemo(() => {
    if (!isAwaitingResponse) {
      return null;
    }

    let lastUserIndex = -1;
    for (let index = transcriptItems.length - 1; index >= 0; index -= 1) {
      const item = transcriptItems[index];
      if (item.type === 'message' && item.role === 'user') {
        lastUserIndex = index;
        break;
      }
    }

    if (lastUserIndex === -1) {
      return null;
    }

    let activeKey: string | null = null;
    for (let index = lastUserIndex + 1; index < transcriptItems.length; index += 1) {
      const item = transcriptItems[index];
      if (item.type === 'tool-digest') {
        activeKey = item.key;
      }
    }

    return activeKey;
  }, [isAwaitingResponse, transcriptItems]);
  const displayItems = useMemo(() => {
    if (!isAwaitingResponse) {
      return transcriptItems;
    }

    const lastRole = transcriptItems[transcriptItems.length - 1]?.role;
    if (lastRole === 'assistant') {
      return transcriptItems;
    }

    return [
      ...transcriptItems,
      {
        type: 'pending-response',
        key: 'workspace-pending-response',
        role: 'assistant',
      } as const,
    ];
  }, [isAwaitingResponse, transcriptItems]);
  const displayItemKeys = useMemo(
    () => displayItems.map((item) => item.key),
    [displayItems],
  );
  // The entrance effect only needs to know when NEW items appear at the tail
  // (streaming appends, segment growth, pending-response toggle); a
  // {length, lastKey} signal is O(1) where the joined key string was O(N).
  const displayItemTailSignal = useMemo(
    () => `${displayItems.length}:${displayItems[displayItems.length - 1]?.key ?? ''}`,
    [displayItems],
  );

  useGSAP(() => {
    const list = listRef.current;
    const currentKeys = displayItems.map((item) => item.key);
    if (!list) {
      seenItemKeysRef.current = new Set(currentKeys);
      hasHydratedMotionRef.current = true;
      return;
    }

    const previousKeys = seenItemKeysRef.current;
    const newKeys = currentKeys.filter((key) => !previousKeys.has(key));
    seenItemKeysRef.current = new Set(currentKeys);

    if (!hasHydratedMotionRef.current) {
      hasHydratedMotionRef.current = true;
      return;
    }

    if (newKeys.length === 0) {
      return;
    }

    const targets = gsap.utils.toArray<HTMLElement>('[data-transcript-item-key]', list)
      .filter((element) => {
        const key = element.dataset.transcriptItemKey;
        return key ? newKeys.includes(key) : false;
      });

    if (targets.length === 0) {
      return;
    }

    if (shouldReduceMotion()) {
      clearMotionProps(targets);
      return;
    }

    gsap.fromTo(
      targets,
      { autoAlpha: 0, y: 12, scale: 0.992 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: ccemMotion.duration.base,
        ease: ccemMotion.ease.standard,
        stagger: 0.025,
        clearProps: 'opacity,visibility,transform',
      },
    );
  }, { dependencies: [displayItemTailSignal], scope: listRef });

  // --- Top windowing (opt-in) ---------------------------------------------
  // Items more than N viewports above the scroll top collapse into a spacer.
  // Heights are cached per item key (stable across sessions switches); the
  // spacer sums cached heights and falls back to the MEDIAN measured height
  // for rows never measured — one dynamically expanded digest only affects
  // its own key and can no longer re-estimate every other row.
  // All spacer height changes land strictly ABOVE the viewport (the buffer
  // guarantees it), which matters because this scroll container disables
  // browser scroll anchoring (overflow-anchor: none).

  /** Remember the first visible item so a window change can hold it in place. */
  const captureFirstVisibleAnchor = useCallback((fromWindowCount: number) => {
    const container = viewportRef?.current;
    const list = listRef.current;
    windowAnchorRef.current = null;
    if (!container || !list) {
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const children = list.querySelectorAll<HTMLElement>('[data-transcript-item-key]');
    for (const child of Array.from(children)) {
      const rect = child.getBoundingClientRect();
      if (transcriptItemIntersectsViewport(
        rect.top,
        rect.bottom,
        containerRect.top,
        containerRect.bottom,
      )) {
        windowAnchorRef.current = {
          key: child.dataset.transcriptItemKey ?? '',
          viewportTopOffset: rect.top - containerRect.top,
          fromWindowCount,
        };
        return;
      }
    }
  }, [viewportRef]);

  /** Width change invalidates every cached height: re-anchor, drop, un-window. */
  const resetHeightCacheForWidth = useCallback((width: number) => {
    captureFirstVisibleAnchor(topWindowCountRef.current);
    const fresh = createTranscriptItemHeightCache();
    fresh.width = width;
    heightCacheRef.current = fresh;
    if (topWindowCountRef.current !== 0) {
      topWindowCountRef.current = 0;
      setTopWindowCount(0);
    }
  }, [captureFirstVisibleAnchor]);

  /**
   * Keep the ResizeObserver pointed at exactly the rendered items. A dep-less
   * layout effect only sees heights that change alongside a parent commit;
   * a tool digest expanding its own internal state re-renders nothing here,
   * so the observer is what keeps that item's cached height honest (and the
   * spacer accurate once the row is windowed away later).
   */
  const syncItemResizeObserver = useCallback((
    children: Array<{ key: string; element: HTMLElement }>,
  ) => {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observed = observedItemKeysRef.current;
    const currentKeys = new Set(children.map((child) => child.key));
    let staleObservations = observed.size !== currentKeys.size;
    if (!staleObservations) {
      for (const key of currentKeys) {
        if (!observed.has(key)) {
          staleObservations = true;
          break;
        }
      }
    }
    if (staleObservations) {
      itemResizeObserverRef.current?.disconnect();
      observed.clear();
    }
    if (!itemResizeObserverRef.current) {
      itemResizeObserverRef.current = new ResizeObserver((entries) => {
        const cache = heightCacheRef.current;
        for (const entry of entries) {
          const target = entry.target;
          if (!(target instanceof HTMLElement)) {
            continue;
          }
          const key = target.dataset.transcriptItemKey;
          if (!key) {
            continue;
          }
          const outerHeight = measureTranscriptItemOuterHeight(target, key, cache);
          const margin = cache.margins.get(key) ?? 0;
          if (outerHeight > margin) {
            cache.heights.set(key, outerHeight);
          }
        }
      });
    }
    for (const { key, element } of children) {
      if (observed.has(key)) {
        continue;
      }
      itemResizeObserverRef.current.observe(element);
      observed.add(key);
    }
  }, []);

  useEffect(() => () => {
    itemResizeObserverRef.current?.disconnect();
    itemResizeObserverRef.current = null;
    observedItemKeysRef.current.clear();
  }, []);

  const recomputeTopWindow = useCallback(() => {
    const container = viewportRef?.current;
    const list = listRef.current;
    if (!container || !list || displayItems.length === 0) {
      return;
    }
    if (!isWindowingViewportMeasurable(container)) {
      return;
    }
    if (heightCacheRef.current.width !== container.clientWidth) {
      // Width moved since the last measurement: heights are stale. Reset and
      // un-window now (the resize path may run before any re-render commits).
      resetHeightCacheForWidth(container.clientWidth);
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    // Content-space top of the list (spacer included; the spacer is the list's
    // first child, so the list element's top is a stable anchor).
    const listTopInContent = container.scrollTop + (listRect.top - containerRect.top);
    const next = computeNextTopWindowCount({
      scrollTop: container.scrollTop,
      listTopInContent,
      viewportHeight: container.clientHeight,
      itemKeys: displayItemKeys,
      heightCache: heightCacheRef.current,
    });
    const previous = topWindowCountRef.current;
    if (next === previous) {
      return;
    }
    // Capture the reading anchor BEFORE the state update; the layout effect
    // below re-applies it from the real post-render rect, so compensation is
    // exact even when cached heights already match the spacer change.
    captureFirstVisibleAnchor(previous);
    topWindowCountRef.current = next;
    setTopWindowCount(next);
  }, [captureFirstVisibleAnchor, displayItemKeys, resetHeightCacheForWidth, viewportRef]);

  useEffect(() => {
    if (!enableTopWindowing) {
      return;
    }
    const container = viewportRef?.current;
    if (!container) {
      return;
    }
    let frame: number | null = null;
    const onScroll = () => {
      // A hidden (display:none) container reports scrollTop 0 — never save
      // that, it would clobber the reading position restored on switch-back.
      if (!isWindowingViewportMeasurable(container)) {
        return;
      }
      lastVisibleScrollTopRef.current = container.scrollTop;
      if (frame != null) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        recomputeTopWindow();
      });
    };
    onScroll();
    container.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      container.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame != null) {
        cancelAnimationFrame(frame);
      }
    };
  }, [enableTopWindowing, recomputeTopWindow, viewportRef]);

  // Visibility + width + per-item height maintenance. Runs on every commit:
  // hidden (display:none) sessions report zero geometry, so while hidden
  // nothing is measured (zero heights must never pollute the cache) and on
  // the hidden->visible transition the saved scroll position is restored and
  // the window re-derived — a stale spacer must not blank the switched-back
  // view. A container width change invalidates every cached height: re-anchor,
  // drop the cache and un-window so rows re-measure at the new width.
  // Heights are OUTER heights (offsetHeight + vertical margins): the spacer
  // replaces each item's full flow box and the `mt-*` spacing classes live
  // outside offsetHeight (offsetHeight itself ignores GSAP transforms).
  // A dep-less effect cannot see heights that change without a parent
  // re-render (a tool digest expanding its own internal state), so rendered
  // items are also observed with a ResizeObserver while visible; the observer
  // only refreshes the cache — a rendered item's height never moves the
  // spacer, so no re-render or compensation is needed for those changes.
  useLayoutEffect(() => {
    if (!enableTopWindowing) {
      return;
    }
    const container = viewportRef?.current;
    const list = listRef.current;
    if (!container || !list) {
      return;
    }
    if (!isWindowingViewportMeasurable(container)) {
      wasViewportMeasurableRef.current = false;
      if (itemResizeObserverRef.current) {
        itemResizeObserverRef.current.disconnect();
        observedItemKeysRef.current.clear();
      }
      return;
    }

    if (!wasViewportMeasurableRef.current) {
      wasViewportMeasurableRef.current = true;
      const savedScrollTop = lastVisibleScrollTopRef.current;
      if (savedScrollTop > 0 && container.scrollTop === 0) {
        container.scrollTop = savedScrollTop;
      }
      recomputeTopWindow();
    }

    const width = container.clientWidth;
    if (heightCacheRef.current.width == null) {
      // First measurement at this width: adopt it and measure below in the
      // same commit (nothing to invalidate — the cache is still empty).
      const fresh = createTranscriptItemHeightCache();
      fresh.width = width;
      heightCacheRef.current = fresh;
    } else if (heightCacheRef.current.width !== width) {
      // Real width change: re-anchor, drop the cache, un-window. Children are
      // already laid out at the new width, so keep measuring this commit; the
      // un-window re-render then re-measures the full list before paint.
      resetHeightCacheForWidth(width);
    }

    const cache = heightCacheRef.current;
    const measuredChildren: Array<{ key: string; element: HTMLElement }> = [];
    for (const child of Array.from(list.children)) {
      if (!(child instanceof HTMLElement)) {
        continue;
      }
      if (child.dataset[TOP_SPACER_DATASET] !== undefined) {
        continue;
      }
      const key = child.dataset.transcriptItemKey;
      if (!key) {
        continue;
      }
      const outerHeight = measureTranscriptItemOuterHeight(child, key, cache);
      if (outerHeight > (cache.margins.get(key) ?? 0)) {
        cache.heights.set(key, outerHeight);
      }
      measuredChildren.push({ key, element: child });
    }

    syncItemResizeObserver(measuredChildren);

    lastVisibleScrollTopRef.current = container.scrollTop;
  });

  // Anchor compensation: after a window/spacer change lands in the DOM, shift
  // scrollTop by the FIRST VISIBLE ITEM's real rect delta (not by the spacer
  // delta — when cached heights already match the spacer the content did not
  // move, and adding the spacer delta would over-scroll).
  useLayoutEffect(() => {
    const anchor = windowAnchorRef.current;
    if (!anchor || topWindowCount === anchor.fromWindowCount) {
      return;
    }
    windowAnchorRef.current = null;
    const container = viewportRef?.current;
    const list = listRef.current;
    if (!container || !list || !anchor.key) {
      return;
    }
    const children = list.querySelectorAll<HTMLElement>('[data-transcript-item-key]');
    for (const child of Array.from(children)) {
      if (child.dataset.transcriptItemKey !== anchor.key) {
        continue;
      }
      const delta = child.getBoundingClientRect().top - container.getBoundingClientRect().top
        - anchor.viewportTopOffset;
      if (Math.abs(delta) >= 1) {
        container.scrollTop += delta;
        lastVisibleScrollTopRef.current = container.scrollTop;
      }
      break;
    }
  });

  const windowedItems = enableTopWindowing && topWindowCount > 0
    ? displayItems.slice(topWindowCount)
    : displayItems;
  const topSpacerHeight = enableTopWindowing && topWindowCount > 0
    ? computeTopSpacerHeight(
      displayItemKeys.slice(0, topWindowCount),
      heightCacheRef.current,
    )
    : 0;
  const windowStartIndex = displayItems.length - windowedItems.length;

  return (
    <div ref={listRef}>
      {topSpacerHeight > 0 ? (
        <div
          key="workspace-transcript-top-spacer"
          data-workspace-transcript-top-spacer="true"
          style={{ height: topSpacerHeight }}
          aria-hidden="true"
        />
      ) : null}
      {windowedItems.map((item, index) => {
        const absoluteIndex = windowStartIndex + index;
        const prevRole = absoluteIndex > 0 ? displayItems[absoluteIndex - 1].role : null;

        if (item.type === 'tool-digest') {
          return (
            <div
              key={item.key}
              data-transcript-item-key={item.key}
              className={cn(
                'max-w-[760px] workspace-tool-digest-virtualized',
                getWorkspaceTranscriptSpacing(prevRole, item.role, item.type),
              )}
            >
              <WorkspaceToolDigest
                entries={item.entries}
                autoExpanded={item.key === activeDigestKey}
                isActive={item.key === activeDigestKey}
              />
            </div>
          );
        }

        if (item.type === 'pending-response') {
          return (
            <div
              key={item.key}
              data-transcript-item-key={item.key}
              className={cn(
                'max-w-[760px]',
                getWorkspaceTranscriptSpacing(prevRole, item.role, item.type),
              )}
            >
              <WorkspacePendingResponse />
            </div>
          );
        }

        return (
          <div key={item.key} data-transcript-item-key={item.key}>
            <WorkspaceMessageBubble
              message={item.message}
              prevRole={prevRole}
              onForkTurn={onForkTurn}
            />
          </div>
        );
      })}
    </div>
  );
}
