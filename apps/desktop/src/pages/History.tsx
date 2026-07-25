import { Suspense, lazy, useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { MessageSquare } from '@/lib/lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { HistoryList } from '@/components/history/HistoryList';
import { getHistorySessionDisplay } from '@/components/history/historySession';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import {
  fetchConversationDetail,
  fetchHistorySessions,
  getCachedHistorySessions,
  invalidateHistoryCache,
  isHistoryCacheFresh,
  primeHistoryPage,
} from '@/features/conversations/historyData';
import type {
  ConversationMessageData,
  HistorySegment,
  HistorySessionItem,
  HistorySourceFilter,
} from '@/features/conversations/types';
import { toSessionKey } from '@/features/conversations/types';

const LazyHistoryDetail = lazy(async () =>
  import('@/components/history/HistoryDetail').then((m) => ({ default: m.HistoryDetail }))
);

export { primeHistoryPage };

function HistoryDetailFallback() {
  return (
    <div className="flex-1 overflow-hidden">
      <div className="glass-header glass-noise shrink-0 border-b border-white/[0.06] px-5 py-2.5">
        <div className="h-4 w-48 animate-pulse rounded bg-white/[0.06]" />
        <div className="mt-2 h-3 w-28 animate-pulse rounded bg-white/[0.04]" />
      </div>
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={`flex ${i % 2 === 0 ? 'justify-end' : 'justify-start'}`}>
              <div className={`h-16 animate-pulse rounded-xl ${i % 2 === 0 ? 'bg-primary/10 w-48' : 'bg-white/[0.04] w-64'}`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function History() {
  const { t } = useLocale();
  const { launchClaudeCode, setSessionTitle } = useTauriCommands();
  const [sessions, setSessions] = useState<HistorySessionItem[]>(() => getCachedHistorySessions('all') ?? []);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessageData[]>([]);
  const [segments, setSegments] = useState<HistorySegment[]>([]);
  const [activeSegment, setActiveSegment] = useState<number | null>(null);
  const [isLoadingSessions, setIsLoadingSessions] = useState(() => getCachedHistorySessions('all') == null);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [focusedSessionKey, setFocusedSessionKey] = useState<string | null>(null);
  const [visibleSessionKeys, setVisibleSessionKeys] = useState<string[] | null>(null);
  const [launched, setLaunched] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<HistorySourceFilter>('all');
  const [, startTransition] = useTransition();

  const syncSessionState = useCallback((nextSessions: HistorySessionItem[]) => {
    setSessions(nextSessions);
    setSelectedKey((prev) => (
      prev && nextSessions.some((session) => toSessionKey(session) === prev) ? prev : null
    ));
    setFocusedSessionKey((prev) => (
      prev && nextSessions.some((session) => toSessionKey(session) === prev) ? prev : null
    ));
  }, []);

  useEffect(() => {
    setVisibleSessionKeys(null);

    const cached = getCachedHistorySessions(sourceFilter);
    if (cached) {
      syncSessionState(cached);
      setIsLoadingSessions(false);
    } else {
      setSessions([]);
      setIsLoadingSessions(true);
    }

    if (cached && isHistoryCacheFresh(sourceFilter)) {
      return;
    }

    let cancelled = false;
    fetchHistorySessions(sourceFilter)
      .then((normalized) => {
        if (cancelled) return;
        syncSessionState(normalized);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Failed to load conversation history:', err);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingSessions(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sourceFilter, syncSessionState]);

  const selectedSession = sessions.find((session) => toSessionKey(session) === selectedKey);

  const handleResume = useCallback(async () => {
    if (!selectedSession) return;
    try {
      await launchClaudeCode(
        selectedSession.project || undefined,
        selectedSession.id,
        selectedSession.source,
        selectedSession.envName,
      );
      setLaunched(true);
      setTimeout(() => setLaunched(false), 1200);
    } catch (err) {
      console.error('Failed to resume session:', err);
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`${t('history.resumeFailed')}: ${message}`);
    }
  }, [selectedSession, launchClaudeCode, t]);

  const handleExport = useCallback(async () => {
    if (!selectedSession) return;

    try {
      const sessionTitle = getHistorySessionDisplay(selectedSession, t('history.untitledSession'));
      const payload = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        session: {
          ...selectedSession,
          display: sessionTitle,
        },
        segments,
        messages,
      };

      const safeTitle = sessionTitle
        .replace(/[^\w\-.]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || selectedSession.id;
      const date = new Date(selectedSession.timestamp).toISOString().slice(0, 10);
      const defaultName = `${date}-${safeTitle}.json`;

      const saved = await invoke<boolean>('save_file_dialog', {
        content: JSON.stringify(payload, null, 2),
        defaultName,
      });

      if (saved) {
        toast.success(t('history.exported'));
      }
    } catch (err) {
      console.error('Failed to export conversation:', err);
      toast.error(t('history.exportFailed'));
    }
  }, [selectedSession, segments, messages, t]);

  const handleSelect = useCallback(async (session: HistorySessionItem) => {
    const key = toSessionKey(session);
    setSessions((prev) => (
      prev.some((currentSession) => toSessionKey(currentSession) === key)
        ? prev
        : [session, ...prev]
    ));
    setSelectedKey(key);
    setFocusedSessionKey(key);
    setActiveSegment(null);
    setIsLoadingMessages(true);
    setMessages([]);
    setSegments([]);
    try {
      const { messages: msgs, segments: segs } = await fetchConversationDetail(session);
      setMessages(msgs);
      setSegments(segs);
    } catch (err) {
      console.error('Failed to load conversation:', err);
    } finally {
      setIsLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    if (visibleSessionKeys === null) return;
    if (visibleSessionKeys.length === 0) {
      setFocusedSessionKey(null);
      return;
    }
    if (focusedSessionKey && !visibleSessionKeys.includes(focusedSessionKey)) {
      setFocusedSessionKey(
        selectedKey && visibleSessionKeys.includes(selectedKey) ? selectedKey : null
      );
    }
  }, [visibleSessionKeys, focusedSessionKey, selectedKey]);

  const sessionKeys = useMemo(() => sessions.map((session) => toSessionKey(session)), [sessions]);
  const navigableSessionKeys = visibleSessionKeys ?? sessionKeys;

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (navigableSessionKeys.length === 0 && e.key !== '/') return;

    switch (e.key) {
      case 'j':
      case 'ArrowDown': {
        e.preventDefault();
        const currentIdx = focusedSessionKey ? navigableSessionKeys.indexOf(focusedSessionKey) : -1;
        const nextIdx = Math.min(currentIdx + 1, navigableSessionKeys.length - 1);
        setFocusedSessionKey(navigableSessionKeys[nextIdx] || null);
        break;
      }
      case 'k':
      case 'ArrowUp': {
        e.preventDefault();
        const currentIdx = focusedSessionKey ? navigableSessionKeys.indexOf(focusedSessionKey) : navigableSessionKeys.length;
        const prevIdx = Math.max(currentIdx - 1, 0);
        setFocusedSessionKey(navigableSessionKeys[prevIdx] || null);
        break;
      }
      case 'Enter': {
        if (focusedSessionKey) {
          e.preventDefault();
          const target = sessions.find((session) => toSessionKey(session) === focusedSessionKey);
          if (target) {
            handleSelect(target);
          }
        }
        break;
      }
      case '/': {
        e.preventDefault();
        const searchInput = document.querySelector('[data-history-search]') as HTMLInputElement;
        searchInput?.focus();
        break;
      }
    }
  }, [focusedSessionKey, navigableSessionKeys, handleSelect, sessions]);

  return (
    <div
      className="page-transition-enter flex h-full gap-0"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className="w-[300px] shrink-0 flex flex-col glass-subtle glass-noise border-r border-white/[0.06]">
        <div className="border-b border-white/[0.06] px-4 pt-3 pb-1">
          <div className="flex items-center gap-4">
            {(['all', 'claude', 'codex', 'opencode'] as HistorySourceFilter[]).map((source) => (
              <button
                key={source}
                data-testid={`history-filter-${source}`}
                type="button"
                onClick={() => startTransition(() => setSourceFilter(source))}
                className={cn(
                  'border-b-2 pb-1 text-xs transition-colors duration-150',
                  sourceFilter === source
                    ? 'border-primary font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                {source === 'all' && t('history.sourceAll')}
                {source === 'claude' && t('history.sourceClaude')}
                {source === 'codex' && t('history.sourceCodex')}
                {source === 'opencode' && t('history.sourceOpencode')}
              </button>
            ))}
          </div>
        </div>
        {isLoadingSessions && sessions.length === 0 ? (
          <div className="flex-1 flex flex-col gap-2 p-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="animate-pulse">
                <div className="mb-1.5 h-4 w-3/4 rounded bg-white/[0.06]" />
                <div className="h-3 w-1/2 rounded bg-white/[0.04]" />
              </div>
            ))}
          </div>
        ) : (
          <HistoryList
            sessions={sessions}
            selectedKey={selectedKey}
            onSelect={handleSelect}
            focusedKey={focusedSessionKey}
            sourceFilter={sourceFilter}
            onVisibleSessionKeysChange={setVisibleSessionKeys}
          />
        )}
      </div>

      <div className="flex-1 flex flex-col min-w-0 bg-[hsl(var(--background)/0.5)]">
        {!selectedKey ? (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              icon={MessageSquare}
              message={t('history.selectConversation')}
            />
          </div>
        ) : selectedSession ? (
          <Suspense fallback={<HistoryDetailFallback />}>
            <LazyHistoryDetail
              key={selectedSession ? toSessionKey(selectedSession) : undefined}
              selectedSession={selectedSession}
              messages={messages}
              segments={segments}
              activeSegment={activeSegment}
              onActiveSegmentChange={setActiveSegment}
              isLoadingMessages={isLoadingMessages}
              onExport={handleExport}
              onResume={handleResume}
              launched={launched}
              onSessionTitleChange={async (source, sessionId, newTitle) => {
                await setSessionTitle(source, sessionId, newTitle);
                invalidateHistoryCache();
                const refreshed = await fetchHistorySessions(sourceFilter, true);
                syncSessionState(refreshed);
              }}
            />
          </Suspense>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs text-muted-foreground">{t('history.noResults')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
