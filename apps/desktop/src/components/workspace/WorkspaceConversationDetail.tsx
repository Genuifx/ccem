import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Layers3 } from '@/lib/lucide-react';
import { WorkspaceTranscriptList } from './WorkspaceTranscriptList';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useLocale } from '@/locales';
import { getPerformanceMode } from '@/lib/performance';
import { WorkspaceTranscriptSelection } from './WorkspaceAnnotations';
import { mergeToolResults } from '@/features/conversations/messageState';
import type {
  ConversationMessageData,
  HistorySegment,
  HistorySessionItem,
} from '@/features/conversations/types';
import {
  getInitialTranscriptRenderCount,
  getLatestTranscriptWindow,
} from './workspaceTranscriptWindow';
import type {
  WorkspaceAnnotation,
  WorkspaceAnnotationAnchor,
} from './workspaceAnnotationModel';

interface WorkspaceConversationDetailProps {
  selectedSession: HistorySessionItem;
  messages: ConversationMessageData[];
  segments: HistorySegment[];
  activeSegment: number | null;
  onActiveSegmentChange: (segment: number | null) => void;
  isLoadingMessages: boolean;
  canAddAnnotation?: boolean;
  annotations?: WorkspaceAnnotation[];
  onAddAnnotation?: (quote: string, note: string, anchor?: WorkspaceAnnotationAnchor) => boolean;
  onUpdateAnnotation?: (id: string, note: string) => void;
  onRemoveAnnotation?: (id: string) => void;
}

function isNearBottom(container: HTMLDivElement): boolean {
  return container.scrollHeight - container.clientHeight - container.scrollTop <= 48;
}

function scrollToLatest(container: HTMLDivElement) {
  container.scrollTo({ top: container.scrollHeight });
}

export function WorkspaceConversationDetail({
  selectedSession,
  messages,
  activeSegment,
  isLoadingMessages,
  canAddAnnotation = false,
  annotations = [],
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
}: WorkspaceConversationDetailProps) {
  const { t } = useLocale();
  const [, startTransition] = useTransition();
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const initialScrollKeyRef = useRef<string | null>(null);
  const lastVisibleMessageCountRef = useRef(0);
  const programmaticScrollRef = useRef(false);
  const autoScrollDetachedRef = useRef(false);
  const pendingPrependScrollHeightRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollSettleTimeoutRef = useRef<number | null>(null);
  const messageBatchSize = getPerformanceMode() === 'reduced' ? 24 : 48;
  const mergedMessages = useMemo(() => mergeToolResults(messages), [messages]);

  const visibleMessages = useMemo(() => {
    if (activeSegment === null) return mergedMessages;
    return mergedMessages.filter((message) => message.segmentIndex === activeSegment);
  }, [activeSegment, mergedMessages]);

  const [renderedMessageCount, setRenderedMessageCount] = useState(() =>
    getInitialTranscriptRenderCount(visibleMessages.length, messageBatchSize)
  );
  const displayedMessages = useMemo(
    () => getLatestTranscriptWindow(visibleMessages, renderedMessageCount),
    [renderedMessageCount, visibleMessages]
  );
  const hasMoreMessages = renderedMessageCount < visibleMessages.length;
  const scrollContextKey = `${selectedSession.id}:${activeSegment ?? 'all'}`;

  useLayoutEffect(() => {
    pendingPrependScrollHeightRef.current = null;
    setRenderedMessageCount((current) => {
      const next = getInitialTranscriptRenderCount(visibleMessages.length, messageBatchSize);
      return current === next ? current : next;
    });
  }, [messageBatchSize, scrollContextKey, visibleMessages.length]);

  useEffect(() => {
    initialScrollKeyRef.current = null;
    lastVisibleMessageCountRef.current = 0;
    autoScrollDetachedRef.current = false;
  }, [scrollContextKey]);

  const cancelPendingAutoScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    if (scrollSettleTimeoutRef.current !== null) {
      window.clearTimeout(scrollSettleTimeoutRef.current);
      scrollSettleTimeoutRef.current = null;
    }
    programmaticScrollRef.current = false;
  }, []);

  useEffect(() => () => {
    cancelPendingAutoScroll();
  }, [cancelPendingAutoScroll]);

  useEffect(() => {
    if (!messagesContainerRef.current) {
      return;
    }

    const container = messagesContainerRef.current;
    const handleScroll = () => {
      if (programmaticScrollRef.current) {
        return;
      }
      autoScrollDetachedRef.current = !isNearBottom(container);
    };
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        cancelPendingAutoScroll();
        autoScrollDetachedRef.current = true;
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('wheel', handleWheel, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('wheel', handleWheel);
    };
  }, [cancelPendingAutoScroll, scrollContextKey]);

  useLayoutEffect(() => {
    if (displayedMessages.length === 0 || !messagesContainerRef.current) {
      return;
    }

    if (initialScrollKeyRef.current === scrollContextKey) {
      return;
    }

    initialScrollKeyRef.current = scrollContextKey;
    const container = messagesContainerRef.current;
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    if (scrollSettleTimeoutRef.current !== null) {
      window.clearTimeout(scrollSettleTimeoutRef.current);
      scrollSettleTimeoutRef.current = null;
    }

    programmaticScrollRef.current = true;
    scrollToLatest(container);
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollToLatest(container);
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        scrollSettleTimeoutRef.current = window.setTimeout(() => {
          scrollToLatest(container);
          programmaticScrollRef.current = false;
          autoScrollDetachedRef.current = !isNearBottom(container);
          scrollSettleTimeoutRef.current = null;
        }, 120);
      });
    });
  }, [displayedMessages.length, scrollContextKey]);

  useLayoutEffect(() => {
    const previousScrollHeight = pendingPrependScrollHeightRef.current;
    pendingPrependScrollHeightRef.current = null;

    if (previousScrollHeight === null || !messagesContainerRef.current) {
      return;
    }

    const container = messagesContainerRef.current;
    container.scrollTop += container.scrollHeight - previousScrollHeight;
  }, [displayedMessages.length]);

  useEffect(() => {
    const previousCount = lastVisibleMessageCountRef.current;
    lastVisibleMessageCountRef.current = visibleMessages.length;

    if (
      previousCount === 0
      || visibleMessages.length <= previousCount
      || autoScrollDetachedRef.current
      || !messagesContainerRef.current
    ) {
      return;
    }

    const container = messagesContainerRef.current;
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    if (scrollSettleTimeoutRef.current !== null) {
      window.clearTimeout(scrollSettleTimeoutRef.current);
      scrollSettleTimeoutRef.current = null;
    }

    programmaticScrollRef.current = true;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollToLatest(container);
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        scrollSettleTimeoutRef.current = window.setTimeout(() => {
          scrollToLatest(container);
          programmaticScrollRef.current = false;
          autoScrollDetachedRef.current = !isNearBottom(container);
          scrollSettleTimeoutRef.current = null;
        }, 120);
      });
    });
  }, [visibleMessages.length]);

  useEffect(() => {
    if (!hasMoreMessages) {
      return;
    }

    const root = messagesContainerRef.current;
    const sentinel = loadMoreSentinelRef.current;
    if (!root || !sentinel) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          return;
        }

        observer.disconnect();
        pendingPrependScrollHeightRef.current = root.scrollHeight;
        startTransition(() => {
          setRenderedMessageCount((current) => Math.min(current + messageBatchSize, visibleMessages.length));
        });
      },
      {
        root,
        rootMargin: '200px 0px',
        threshold: 0.01,
      }
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [hasMoreMessages, messageBatchSize, renderedMessageCount, startTransition, visibleMessages.length]);

  return (
    <>
      {onAddAnnotation && onUpdateAnnotation && onRemoveAnnotation ? (
        <WorkspaceTranscriptSelection
          rootRef={messagesContainerRef}
          scopeKey={`history:${selectedSession.source}:${selectedSession.id}:${activeSegment ?? 'all'}`}
          canAdd={canAddAnnotation}
          annotations={annotations}
          onAdd={onAddAnnotation}
          onUpdate={onUpdateAnnotation}
          onRemove={onRemoveAnnotation}
        />
      ) : null}
      <ScrollArea viewportRef={messagesContainerRef} className="workspace-transcript-scroll flex-1 bg-background/30">
        <div className="mx-auto max-w-[860px] px-8 py-8">
          {isLoadingMessages ? (
            <div className="space-y-5">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className={cn('animate-pulse rounded-2xl', index === 0 ? 'h-16 w-[68%] bg-muted/50' : 'h-24 w-full bg-muted/35')} />
              ))}
            </div>
          ) : visibleMessages.length === 0 ? (
            <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 text-center">
              <div className="rounded-2xl border border-border/40 bg-surface/70 p-4">
                <Layers3 className="h-6 w-6 text-muted-foreground/60" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{t('history.noMessages')}</p>
                <p className="mt-1 text-xs text-muted-foreground/75">{t('workspace.selectConversationHint')}</p>
              </div>
            </div>
          ) : (
            <div>
              {hasMoreMessages ? <div ref={loadMoreSentinelRef} className="h-px" /> : null}
              <WorkspaceTranscriptList messages={displayedMessages} />
            </div>
          )}
        </div>
      </ScrollArea>
    </>
  );
}
