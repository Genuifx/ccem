import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { ChevronDown, MessageSquare } from '@/lib/lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { HistoryList } from '@/components/history/HistoryList';
import { getHistorySessionDisplay } from '@/components/history/historySession';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import {
  formatInteractiveSessionLaunchError,
  isInteractiveSessionTerminalOpenError,
} from '@/lib/interactiveSessionLaunch';
import {
  fetchConversationDetail,
  fetchHistorySessions,
  fetchHistorySessionsWithDiagnostics,
  getCachedHistorySessions,
  getCachedDiagnostics,
  invalidateHistoryCache,
  isHistoryCacheFresh,
  normalizeHistoryError,
  primeHistoryPage,
} from '@/features/conversations/historyData';
import type { HistoryCommandError, SourceDiagnostic } from '@/features/conversations/historyData';
import type {
  ConversationMessageData,
  HistorySegment,
  HistorySessionItem,
  HistorySourceFilter,
} from '@/features/conversations/types';
import { toSessionKey, isResumableHistorySource } from '@/features/conversations/types';

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
  const {
    launchClaudeCode,
    openInteractiveSessionInTerminal,
    setSessionTitle,
  } = useTauriCommands();
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
  const [diagnostics, setDiagnostics] = useState<SourceDiagnostic[]>(() => getCachedDiagnostics('all'));
  const [listError, setListError] = useState<HistoryCommandError | null>(null);
  const [detailError, setDetailError] = useState<HistoryCommandError | null>(null);
  const [detailWarnings, setDetailWarnings] = useState<string[]>([]);
  const [, startTransition] = useTransition();

  // Generation refs for race protection: event-handler promises (Retry clicks)
  // check these to avoid overwriting state after source/query/selection changes.
  const listGenRef = useRef(0);
  const detailGenRef = useRef(0);

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
    // Clear error immediately on source transition — prevents stale error from
    // one source (e.g. DSH) persisting under another source's cached data.
    setListError(null);
    // Bump generation so any in-flight Retry promise from the old source is ignored.
    listGenRef.current += 1;

    const cached = getCachedHistorySessions(sourceFilter);
    if (cached) {
      syncSessionState(cached);
      setDiagnostics(getCachedDiagnostics(sourceFilter));
      setIsLoadingSessions(false);
    } else {
      setSessions([]);
      setDiagnostics([]);
      setIsLoadingSessions(true);
    }

    if (cached && isHistoryCacheFresh(sourceFilter)) {
      return;
    }

    let cancelled = false;
    fetchHistorySessionsWithDiagnostics(sourceFilter)
      .then((result) => {
        if (cancelled) return;
        syncSessionState(result.sessions);
        setDiagnostics(result.diagnostics);
        setListError(null);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Failed to load conversation history:', err);
          setListError(normalizeHistoryError(err));
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
    // DSH sessions are read-only — never allow resume.
    if (!isResumableHistorySource(selectedSession.source)) return;
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
      if (isInteractiveSessionTerminalOpenError(err)) {
        toast.error(
          t('workspace.terminalSessionCreatedOpenFailed').replace(
            '{error}',
            formatInteractiveSessionLaunchError(err.terminalError),
          ),
          {
            action: {
              label: t('common.retry'),
              onClick: () => {
                void openInteractiveSessionInTerminal(
                  err.sessionId,
                  undefined,
                  { notifyOnError: false },
                )
                  .then(() => {
                    setLaunched(true);
                    setTimeout(() => setLaunched(false), 1200);
                    toast.success(t('workspace.nativeHandoffDone'));
                  })
                  .catch(() => {
                    toast.error(t('workspace.nativeHandoffFailed'));
                  });
              },
            },
          },
        );
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`${t('history.resumeFailed')}: ${message}`);
    }
  }, [launchClaudeCode, openInteractiveSessionInTerminal, selectedSession, t]);

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
    setDetailError(null);
    setDetailWarnings([]);
    // Bump detail generation so prior in-flight detail requests are ignored
    detailGenRef.current += 1;
    const gen = detailGenRef.current;
    try {
      const { messages: msgs, segments: segs, warnings } = await fetchConversationDetail(session);
      if (detailGenRef.current !== gen) return; // stale — selection changed
      setMessages(msgs);
      setSegments(segs);
      setDetailWarnings(warnings ?? []);
    } catch (err) {
      if (detailGenRef.current !== gen) return; // stale
      console.error('Failed to load conversation:', err);
      setDetailError(normalizeHistoryError(err));
    } finally {
      if (detailGenRef.current === gen) {
        setIsLoadingMessages(false);
      }
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
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT') return;
    if (target.closest('[data-history-source-control], [role="menu"], [role^="menuitem"]')) return;
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
            {(['all', 'claude', 'codex'] as HistorySourceFilter[]).map((source) => (
              <button
                key={source}
                data-testid={`history-filter-${source}`}
                data-history-source-control
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
              </button>
            ))}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  data-testid="history-filter-other"
                  data-history-source-control
                  type="button"
                  className={cn(
                    'flex items-center gap-1 border-b-2 pb-1 text-xs transition-colors duration-150',
                    sourceFilter === 'opencode' || sourceFilter === 'dsh'
                      ? 'border-primary font-medium text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  )}
                >
                  <span>
                    {t('history.sourceOther')}
                    {sourceFilter === 'opencode' && ` · ${t('history.sourceOpencode')}`}
                    {sourceFilter === 'dsh' && ` · ${t('history.sourceDsh')}`}
                  </span>
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[132px]">
                <DropdownMenuRadioGroup
                  value={sourceFilter === 'opencode' || sourceFilter === 'dsh' ? sourceFilter : ''}
                  onValueChange={(value) => {
                    if (value === 'opencode' || value === 'dsh') {
                      startTransition(() => setSourceFilter(value));
                    }
                  }}
                >
                  <DropdownMenuRadioItem
                    data-testid="history-filter-opencode-option"
                    value="opencode"
                  >
                    {t('history.sourceOpencode')}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem
                    data-testid="history-filter-dsh-option"
                    value="dsh"
                  >
                    {t('history.sourceDsh')}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {diagnostics.length > 0 && (
          <div className="px-3 py-1.5">
            {diagnostics.map((d, i) => (
              <div key={i} className="text-xs text-amber-400/80 flex items-center gap-1.5">
                <span className="shrink-0">⚠</span>
                <span className="truncate">{d.message}</span>
                <button
                  className="ml-auto shrink-0 text-[10px] underline opacity-70 hover:opacity-100"
                  onClick={() => {
                    fetchHistorySessionsWithDiagnostics(sourceFilter, true)
                      .then((result) => { syncSessionState(result.sessions); setDiagnostics(result.diagnostics); setListError(null); })
                      .catch((retryErr) => { setListError(normalizeHistoryError(retryErr)); });
                  }}
                >
                  {t('history.retry')}
                </button>
              </div>
            ))}
          </div>
        )}
        {listError && (
          <div className="px-3 py-2 border-b border-destructive/20 bg-destructive/5">
            <div className="text-xs text-destructive flex items-center gap-1.5">
              <span className="truncate">{listError.message}</span>
              <button
                className="ml-auto shrink-0 text-[10px] underline opacity-70 hover:opacity-100"
                data-testid="history-list-retry"
                onClick={() => {
                  const gen = listGenRef.current;
                  setListError(null);
                  setIsLoadingSessions(true);
                  fetchHistorySessionsWithDiagnostics(sourceFilter, true)
                    .then((result) => {
                      if (listGenRef.current !== gen) return; // stale
                      syncSessionState(result.sessions);
                      setDiagnostics(result.diagnostics);
                      setListError(null);
                    })
                    .catch((retryErr) => {
                      if (listGenRef.current !== gen) return; // stale
                      setListError(normalizeHistoryError(retryErr));
                    })
                    .finally(() => {
                      if (listGenRef.current !== gen) return; // stale
                      setIsLoadingSessions(false);
                    });
                }}
              >
                {t('history.retry')}
              </button>
            </div>
          </div>
        )}
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
              detailError={detailError}
              detailWarnings={detailWarnings}
              onRetryDetail={() => selectedSession && handleSelect(selectedSession)}
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
