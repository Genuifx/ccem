import { useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Check, Download, Play } from '@/lib/lucide-react';
import { MessageBubble } from './MessageBubble';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import { getPerformanceMode } from '@/lib/performance';
import { getSessionTokenUsage, mergeToolResults } from '@/features/conversations/messageState';
import type {
  ConversationMessageData,
  HistorySegment,
  HistorySessionItem,
} from '@/features/conversations/types';
import { getHistorySessionDisplay } from './historySession';

interface HistoryDetailProps {
  selectedSession: HistorySessionItem;
  messages: ConversationMessageData[];
  segments: HistorySegment[];
  activeSegment: number | null;
  onActiveSegmentChange: (segment: number | null) => void;
  isLoadingMessages: boolean;
  onExport: () => void;
  onResume: () => void;
  launched: boolean;
  /** When true, auto-scrolls to the bottom on session load (dashboard mode).
   *  When false (default), scrolls to the top (history mode). */
  scrollToBottomOnLoad?: boolean;
  onSessionTitleChange?: (source: string, sessionId: string, newTitle: string) => Promise<void>;
}

function formatHeaderDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function isNearBottom(container: HTMLDivElement): boolean {
  return container.scrollHeight - container.clientHeight - container.scrollTop <= 48;
}

export function HistoryDetail({
  selectedSession,
  messages,
  segments,
  activeSegment,
  onActiveSegmentChange,
  isLoadingMessages,
  onExport,
  onResume,
  launched,
  scrollToBottomOnLoad = false,
  onSessionTitleChange,
}: HistoryDetailProps) {
  const { t } = useLocale();
  const [, startTransition] = useTransition();
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const initialScrollKeyRef = useRef<string | null>(null);
  const lastVisibleMessageCountRef = useRef(0);
  const programmaticScrollRef = useRef(false);
  const autoScrollDetachedRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const messageBatchSize = getPerformanceMode() === 'reduced' ? 24 : 48;
  const formatTokens = (v: number) => v.toLocaleString();
  const sessionTitle = getHistorySessionDisplay(selectedSession, t('history.untitledSession'));

  const mergedMessages = useMemo(() => mergeToolResults(messages), [messages]);
  const sessionUsage = useMemo(() => getSessionTokenUsage(mergedMessages), [mergedMessages]);

  const visibleMessages = useMemo(() => {
    if (activeSegment === null) return mergedMessages;
    return mergedMessages.filter((message) => message.segmentIndex === activeSegment);
  }, [mergedMessages, activeSegment]);
  // When scrollToBottomOnLoad, render all messages at once to enable correct scroll
  const [renderedMessageCount, setRenderedMessageCount] = useState(() => (
    scrollToBottomOnLoad ? visibleMessages.length : Math.min(visibleMessages.length, messageBatchSize)
  ));
  const displayedMessages = useMemo(() => (
    visibleMessages.slice(0, renderedMessageCount)
  ), [renderedMessageCount, visibleMessages]);
  const hasMoreMessages = renderedMessageCount < visibleMessages.length;

  const formatSegmentLabel = useMemo(() => (
    (segmentIndex: number) => (
      segmentIndex === 0
        ? t('history.segmentShortInitial')
        : t('history.segmentShortLabel').replace('{n}', String(segmentIndex))
    )
  ), [t]);
  const scrollContextKey = `${selectedSession.id}:${activeSegment ?? 'all'}`;

  // Batch reset: load all for scroll-to-bottom, progressive for scroll-to-top
  useLayoutEffect(() => {
    if (scrollToBottomOnLoad) {
      setRenderedMessageCount(visibleMessages.length);
    } else {
      setRenderedMessageCount(Math.min(visibleMessages.length, messageBatchSize));
    }
  }, [scrollToBottomOnLoad, messageBatchSize, visibleMessages]);

  useEffect(() => {
    initialScrollKeyRef.current = null;
    lastVisibleMessageCountRef.current = 0;
    autoScrollDetachedRef.current = false;
  }, [scrollContextKey, scrollToBottomOnLoad]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
    }
  }, []);

  useEffect(() => {
    if (!scrollToBottomOnLoad || !messagesContainerRef.current) {
      return;
    }

    const container = messagesContainerRef.current;
    const handleScroll = () => {
      if (programmaticScrollRef.current) {
        return;
      }
      autoScrollDetachedRef.current = !isNearBottom(container);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [scrollContextKey, scrollToBottomOnLoad]);

  // Initial scroll only once per session/segment context.
  useEffect(() => {
    if (displayedMessages.length === 0 || !messagesContainerRef.current) {
      return;
    }

    if (initialScrollKeyRef.current === scrollContextKey) {
      return;
    }

    initialScrollKeyRef.current = scrollContextKey;
    const container = messagesContainerRef.current;

    if (scrollToBottomOnLoad) {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }

      programmaticScrollRef.current = true;
      scrollFrameRef.current = requestAnimationFrame(() => {
        container.scrollTo({ top: container.scrollHeight });
        scrollFrameRef.current = requestAnimationFrame(() => {
          programmaticScrollRef.current = false;
          autoScrollDetachedRef.current = !isNearBottom(container);
          scrollFrameRef.current = null;
        });
      });
    } else {
      container.scrollTo({ top: 0 });
    }
  }, [displayedMessages.length, scrollContextKey, scrollToBottomOnLoad]);

  useEffect(() => {
    const previousCount = lastVisibleMessageCountRef.current;
    lastVisibleMessageCountRef.current = visibleMessages.length;

    if (
      !scrollToBottomOnLoad
      || previousCount === 0
      || visibleMessages.length <= previousCount
      || autoScrollDetachedRef.current
      || !messagesContainerRef.current
    ) {
      return;
    }

    const container = messagesContainerRef.current;
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
    }

    programmaticScrollRef.current = true;
    scrollFrameRef.current = requestAnimationFrame(() => {
      container.scrollTo({ top: container.scrollHeight });
      scrollFrameRef.current = requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
        autoScrollDetachedRef.current = !isNearBottom(container);
        scrollFrameRef.current = null;
      });
    });
  }, [scrollToBottomOnLoad, visibleMessages.length]);

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

  useEffect(() => {
    if (!hasMoreMessages || !messagesContainerRef.current) {
      return;
    }

    const container = messagesContainerRef.current;
    if (container.scrollHeight <= container.clientHeight + 32) {
      startTransition(() => {
        setRenderedMessageCount((current) => Math.min(current + messageBatchSize, visibleMessages.length));
      });
    }
  }, [displayedMessages.length, hasMoreMessages, messageBatchSize, startTransition, visibleMessages.length]);

  return (
    <>
      <div className="glass-header glass-noise shrink-0 border-b border-border/30 px-5 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-medium text-foreground" title={sessionTitle}>
              {isEditingTitle ? (
                <input
                  autoFocus
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setIsEditingTitle(false);
                      onSessionTitleChange?.(selectedSession.source, selectedSession.id, editTitle)
                        .catch((err) => console.error('Failed to save title:', err));
                    }
                    if (e.key === 'Escape') setIsEditingTitle(false);
                  }}
                  onBlur={() => setIsEditingTitle(false)}
                  className="w-full text-[15px] font-semibold bg-surface-raised rounded px-2 py-0.5 outline-none border border-primary/40"
                />
              ) : (
                <span
                  className="cursor-text"
                  onDoubleClick={() => {
                    setIsEditingTitle(true);
                    setEditTitle(sessionTitle);
                  }}
                >
                  {sessionTitle}
                </span>
              )}
            </h3>
            <p className="mt-1 min-w-0 truncate text-[11px] text-muted-foreground">
              {selectedSession.projectName} · {formatHeaderDate(selectedSession.timestamp)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 px-3 text-xs"
              onClick={onExport}
              disabled={isLoadingMessages}
            >
              <Download className="h-3.5 w-3.5" />
              {t('history.export')}
            </Button>
            <Button
              size="sm"
              variant={launched ? 'ghost' : 'outline'}
              className="h-8 gap-1.5 px-3 text-xs"
              onClick={onResume}
              disabled={launched}
            >
              {launched ? <Check className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {launched ? t('history.resumed') : t('history.resume')}
            </Button>
          </div>
        </div>
        <div className="mt-1 flex items-center gap-3">
          {segments.length > 1 && (
            <div
              className="ml-auto max-w-[55%] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              style={{
                maskImage: 'linear-gradient(to right, transparent, black 12px, black calc(100% - 12px), transparent)',
                WebkitMaskImage: 'linear-gradient(to right, transparent, black 12px, black calc(100% - 12px), transparent)',
              }}
            >
              <div className="flex items-center gap-1 pl-3">
                <button
                  onClick={() => startTransition(() => onActiveSegmentChange(null))}
                  className={cn(
                    'shrink-0 rounded-full border px-2 py-0.5 text-[10px] transition-colors',
                    activeSegment === null
                      ? 'border-primary/40 bg-primary/12 text-foreground'
                      : 'border-border/50 text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t('history.allSegments')}
                </button>
                {segments.map((seg) => (
                  <button
                    key={seg.segmentIndex}
                    onClick={() => startTransition(() => onActiveSegmentChange(seg.segmentIndex))}
                    className={cn(
                      'shrink-0 rounded-full border px-2 py-0.5 text-[10px] transition-colors',
                      activeSegment === seg.segmentIndex
                        ? 'border-primary/40 bg-primary/12 text-foreground'
                        : 'border-border/50 text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {formatSegmentLabel(seg.segmentIndex)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6">
          {isLoadingMessages ? (
            <div className="space-y-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className={`flex ${i % 2 === 0 ? 'justify-end' : 'justify-start'}`}>
                  <div className="animate-pulse">
                    <div className={`h-16 rounded-xl ${i % 2 === 0 ? 'bg-primary/10 w-48' : 'bg-muted/40 w-64'}`} />
                  </div>
                </div>
              ))}
            </div>
          ) : visibleMessages.length === 0 ? (
            <div className="flex min-h-[240px] items-center justify-center">
              <p className="text-xs text-muted-foreground">{t('history.noMessages')}</p>
            </div>
          ) : (
            <div key={activeSegment ?? 'all'}>
              {displayedMessages.map((msg, i) => {
                const prevMsg = i > 0 ? displayedMessages[i - 1] : null;
                const prevRole = prevMsg
                  ? (prevMsg.msgType === 'user' || prevMsg.msgType === 'human' ? 'user' : 'assistant')
                  : null;
                const animDelay = i < 8 ? `${i * 30}ms` : '0ms';

                return (
                  <div
                    key={msg.uuid || i}
                    className={cn(
                      !scrollToBottomOnLoad && 'msg-enter history-msg-virtualized'
                    )}
                    style={!scrollToBottomOnLoad ? { animationDelay: animDelay } : undefined}
                  >
                    <MessageBubble message={msg} prevRole={prevRole} />
                  </div>
                );
              })}
              {hasMoreMessages ? (
                <div className="flex justify-center pt-4">
                  <div className="glass-subtle rounded-full px-3 py-1 text-[11px] text-muted-foreground">
                    {t('history.loadingMessages')}
                  </div>
                </div>
              ) : null}
              {hasMoreMessages ? <div ref={loadMoreSentinelRef} className="h-px" /> : null}
            </div>
          )}

          {!isLoadingMessages && (
            <div className="mt-8 flex justify-center">
              <div className="glass-subtle glass-noise w-full max-w-sm rounded-xl border border-border/40 px-4 py-4 text-center shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
                <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/40">
                  {t('history.sessionInfo')}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  <span className="font-mono text-foreground/90">{formatTokens(sessionUsage.input)}</span> {t('history.tokensInput')}
                  <span className="mx-2 text-muted-foreground/50">·</span>
                  <span className="font-mono text-foreground/90">{formatTokens(sessionUsage.output)}</span> {t('history.tokensOutput')}
                </p>
                <p
                  className="mt-2 break-all font-mono text-[11px] text-muted-foreground/65"
                  title={selectedSession.id}
                >
                  {selectedSession.id}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
