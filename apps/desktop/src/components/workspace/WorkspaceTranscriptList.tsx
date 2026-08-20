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

/**
 * Top-windowing bounds (plan 022, step 4). Items more than this many
 * viewports above the scroll position are replaced by an estimated-height
 * spacer; the streaming tail always stays mounted. Expect revision.
 */
export const TOP_WINDOWING_VIEWPORTS_ABOVE = 8;
/** Never window below this many rendered items (tail safety floor). */
export const TOP_WINDOWING_MIN_RENDERED_ITEMS = 24;
/** Fallback item height before any measurement (typical message row). */
const TOP_WINDOWING_DEFAULT_ITEM_HEIGHT = 72;
/** Running-average sample cap; halving keeps the mean recent but stable. */
const TOP_WINDOWING_MAX_SAMPLES = 800;
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
}

export function WorkspaceTranscriptList({
  messages,
  isAwaitingResponse = false,
  enableTopWindowing = false,
  viewportRef,
}: WorkspaceTranscriptListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const seenItemKeysRef = useRef<Set<string>>(new Set());
  const hasHydratedMotionRef = useRef(false);
  const itemHeightStatsRef = useRef({ sum: 0, count: 0 });
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
  // Items more than N viewports above the scroll top collapse into a spacer
  // of estimated height. All spacer height changes land strictly ABOVE the
  // viewport (the buffer guarantees it), which matters because this scroll
  // container disables browser scroll anchoring (overflow-anchor: none).
  const averageItemHeight = useCallback(() => {
    const stats = itemHeightStatsRef.current;
    return stats.count > 0 ? stats.sum / stats.count : TOP_WINDOWING_DEFAULT_ITEM_HEIGHT;
  }, []);

  const recomputeTopWindow = useCallback(() => {
    const container = viewportRef?.current;
    const list = listRef.current;
    if (!container || !list || displayItems.length === 0) {
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    // Content-space top of the list (spacer included; the spacer is the list's
    // first child, so the list element's top is a stable anchor).
    const listTopInContent = container.scrollTop + (listRect.top - containerRect.top);
    const bufferPx = TOP_WINDOWING_VIEWPORTS_ABOVE * container.clientHeight;
    const hideablePx = container.scrollTop - bufferPx - listTopInContent;
    let next = Math.floor(hideablePx / averageItemHeight());
    if (!(next > 0)) {
      next = 0;
    }
    const maxHidden = Math.max(0, displayItems.length - TOP_WINDOWING_MIN_RENDERED_ITEMS);
    if (next > maxHidden) {
      next = maxHidden;
    }
    setTopWindowCount((previous) => (previous === next ? previous : next));
  }, [averageItemHeight, displayItems.length, viewportRef]);

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
      if (frame != null) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        recomputeTopWindow();
      });
    };
    recomputeTopWindow();
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

  // Running average of measured item heights feeds the spacer estimate.
  useLayoutEffect(() => {
    if (!enableTopWindowing) {
      return;
    }
    const list = listRef.current;
    if (!list) {
      return;
    }
    let sum = 0;
    let count = 0;
    for (const child of Array.from(list.children)) {
      if (!(child instanceof HTMLElement)) {
        continue;
      }
      if (child.dataset[TOP_SPACER_DATASET] !== undefined) {
        continue;
      }
      sum += child.offsetHeight;
      count += 1;
    }
    if (count > 0) {
      const stats = itemHeightStatsRef.current;
      stats.sum += sum;
      stats.count += count;
      if (stats.count > TOP_WINDOWING_MAX_SAMPLES) {
        stats.sum /= 2;
        stats.count /= 2;
      }
    }
  });

  const windowedItems = enableTopWindowing && topWindowCount > 0
    ? displayItems.slice(topWindowCount)
    : displayItems;
  const topSpacerHeight = enableTopWindowing && topWindowCount > 0
    ? Math.round(topWindowCount * averageItemHeight())
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
            />
          </div>
        );
      })}
    </div>
  );
}
