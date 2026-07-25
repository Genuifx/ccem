/**
 * @deprecated This component is superseded by the unified session view in Sessions.tsx.
 * Headless sessions now render in the main session card grid via UnifiedSession.
 * This file will be removed in the backend cleanup phase (Task 1 Phase 4).
 */
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Bot, CheckCircle2, LoaderCircle, RefreshCw, Send, Sparkles, Square, TerminalSquare, Trash2, XCircle } from '@/lib/lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { useAppStore } from '@/store';
import type { HeadlessSessionSummary, SessionEventPayload, SessionEventRecord } from '@/lib/tauri-ipc';

const INPUT_CLS = 'w-full px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.06] border border-black/[0.08] dark:border-white/[0.08] text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/30 transition-all';

function formatTimestamp(value: string) {
  try {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return value;
  }
}

function summarizeProject(path: string) {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || path;
}

function lastEventSeq(events?: SessionEventRecord[]) {
  if (!events || events.length === 0) {
    return null;
  }
  return events[events.length - 1]?.seq ?? null;
}

function pendingPermissionRequests(events: SessionEventRecord[]) {
  const pending = new Map<string, { requestId: string; toolName: string }>();

  for (const event of events) {
    if (event.payload.type === 'permission_required') {
      pending.set(event.payload.request_id, {
        requestId: event.payload.request_id,
        toolName: event.payload.tool_name,
      });
      continue;
    }

    if (event.payload.type === 'permission_responded') {
      pending.delete(event.payload.request_id);
    }
  }

  return Array.from(pending.values());
}

function statusTone(status: string) {
  switch (status) {
    case 'ready':
    case 'processing':
      return 'text-primary bg-primary/10';
    case 'completed':
      return 'text-success bg-success/10';
    case 'waiting_permission':
      return 'text-warning bg-warning/10';
    case 'stopped':
      return 'text-muted-foreground bg-muted/30';
    default:
      return 'text-destructive bg-destructive/10';
  }
}

function formatEventLabel(payload: SessionEventPayload) {
  switch (payload.type) {
    case 'assistant_chunk':
      return 'Claude';
    case 'lifecycle':
      return payload.stage;
    case 'system_message':
      return 'system';
    case 'stderr_line':
      return 'stderr';
    case 'session_completed':
      return 'completed';
    case 'permission_required':
      return 'permission';
    case 'permission_responded':
      return 'permission';
    case 'gap_notification':
      return 'gap';
    case 'claude_json':
      return payload.message_type ?? 'json';
  }
  return 'event';
}

function renderEventBody(payload: SessionEventPayload, showRawJson: boolean) {
  switch (payload.type) {
    case 'assistant_chunk':
      return payload.text;
    case 'lifecycle':
      return payload.detail;
    case 'system_message':
      return payload.message;
    case 'stderr_line':
      return payload.line;
    case 'session_completed':
      return payload.reason;
    case 'permission_required':
      return `${payload.tool_name} · ${payload.request_id}`;
    case 'permission_responded':
      return `${payload.approved ? 'approved' : 'denied'} · ${payload.responder}`;
    case 'gap_notification':
      return `last_seen=${payload.last_seen_seq}, oldest=${payload.oldest_available_seq}`;
    case 'claude_json':
      return showRawJson ? payload.raw_json : null;
    default:
      return null;
  }
}

export function HeadlessSessionsPanel() {
  const { t } = useLocale();
  const [sessions, setSessions] = useState<HeadlessSessionSummary[]>([]);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<string | null>(null);
  const [eventsByRuntime, setEventsByRuntime] = useState<Record<string, SessionEventRecord[]>>({});
  const [nextPrompt, setNextPrompt] = useState('');
  const [composerText, setComposerText] = useState('');
  const [showRawJson, setShowRawJson] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null);
  const [isRefreshing, startRefreshTransition] = useTransition();
  const {
    currentEnv,
    permissionMode,
    selectedWorkingDir,
    defaultWorkingDir,
  } = useAppStore((state) => ({
    currentEnv: state.currentEnv,
    permissionMode: state.permissionMode,
    selectedWorkingDir: state.selectedWorkingDir,
    defaultWorkingDir: state.defaultWorkingDir,
  }));
  const {
    createHeadlessSession,
    listHeadlessSessions,
    getHeadlessSessionEvents,
    sendToHeadlessSession,
    stopHeadlessSession,
    respondHeadlessPermission,
    removeHeadlessSession,
  } = useTauriCommands();

  const refreshSessions = useCallback(async () => {
    const nextSessions = await listHeadlessSessions();
    setSessions(nextSessions);
    setSelectedRuntimeId((current) => {
      if (current && nextSessions.some((session) => session.runtime_id === current)) {
        return current;
      }
      return nextSessions[0]?.runtime_id ?? null;
    });
    return nextSessions;
  }, [listHeadlessSessions]);

  const refreshEvents = useCallback(async (runtimeId: string, sinceSeq?: number | null) => {
    const batch = await getHeadlessSessionEvents(runtimeId, sinceSeq ?? null);
    setEventsByRuntime((current) => {
      const previous = sinceSeq && !batch.gap_detected ? current[runtimeId] ?? [] : [];
      const next = [...previous, ...batch.events];
      const deduped = next.filter((event, index, all) =>
        index === all.findIndex((candidate) => candidate.seq === event.seq && candidate.runtime_id === event.runtime_id)
      );
      return { ...current, [runtimeId]: deduped };
    });
    return batch;
  }, [getHeadlessSessionEvents]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    if (!selectedRuntimeId) {
      return;
    }
    if (!eventsByRuntime[selectedRuntimeId]) {
      void refreshEvents(selectedRuntimeId, null);
    }
  }, [eventsByRuntime, refreshEvents, selectedRuntimeId]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      startRefreshTransition(() => {
        void refreshSessions();
        if (selectedRuntimeId) {
          const lastSeen = lastEventSeq(eventsByRuntime[selectedRuntimeId]);
          void refreshEvents(selectedRuntimeId, lastSeen);
        }
      });
    }, 3000);

    return () => window.clearInterval(intervalId);
  }, [eventsByRuntime, refreshEvents, refreshSessions, selectedRuntimeId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      unlisten = await listen<SessionEventRecord>('headless-session-event', (event) => {
        const record = event.payload;
        setEventsByRuntime((current) => {
          const previous = current[record.runtime_id] ?? [];
          if (previous.some((item) => item.seq === record.seq)) {
            return current;
          }
          return {
            ...current,
            [record.runtime_id]: [...previous, record],
          };
        });
      });
    };

    void setup();
    return () => {
      unlisten?.();
    };
  }, []);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.runtime_id === selectedRuntimeId) ?? null,
    [selectedRuntimeId, sessions],
  );
  const canInteractWithSelected = !!selectedSession && !['stopped', 'completed', 'error'].includes(selectedSession.status);
  const canRemoveSelected = !!selectedSession && ['stopped', 'completed', 'error'].includes(selectedSession.status);

  const visibleEvents = useMemo(() => {
    const events = selectedRuntimeId ? eventsByRuntime[selectedRuntimeId] ?? [] : [];
    return events.filter((event) => showRawJson || event.payload.type !== 'claude_json');
  }, [eventsByRuntime, selectedRuntimeId, showRawJson]);
  const pendingPermissions = useMemo(() => {
    if (!selectedRuntimeId) {
      return [];
    }
    return pendingPermissionRequests(eventsByRuntime[selectedRuntimeId] ?? []);
  }, [eventsByRuntime, selectedRuntimeId]);

  const effectiveWorkingDir = selectedWorkingDir || defaultWorkingDir || null;

  const handleCreate = useCallback(async () => {
    if (!nextPrompt.trim()) {
      return;
    }

    setIsCreating(true);
    try {
      const session = await createHeadlessSession({
        initialPrompt: nextPrompt.trim(),
        workingDir: effectiveWorkingDir,
      });
      setNextPrompt('');
      await refreshSessions();
      setSelectedRuntimeId(session.runtime_id);
      await refreshEvents(session.runtime_id, null);
    } finally {
      setIsCreating(false);
    }
  }, [createHeadlessSession, effectiveWorkingDir, nextPrompt, refreshEvents, refreshSessions]);

  const handleSend = useCallback(async () => {
    if (!selectedRuntimeId || !composerText.trim()) {
      return;
    }

    setIsSending(true);
    try {
      await sendToHeadlessSession(selectedRuntimeId, composerText.trim());
      setComposerText('');
      await refreshEvents(selectedRuntimeId, lastEventSeq(eventsByRuntime[selectedRuntimeId]));
    } finally {
      setIsSending(false);
    }
  }, [composerText, eventsByRuntime, refreshEvents, selectedRuntimeId, sendToHeadlessSession]);

  const handleStop = useCallback(async () => {
    if (!selectedRuntimeId) {
      return;
    }

    await stopHeadlessSession(selectedRuntimeId);
    await refreshSessions();
  }, [refreshSessions, selectedRuntimeId, stopHeadlessSession]);

  const handleRemove = useCallback(async () => {
    if (!selectedRuntimeId) {
      return;
    }

    setIsRemoving(true);
    try {
      await removeHeadlessSession(selectedRuntimeId);
      setEventsByRuntime((current) => {
        const next = { ...current };
        delete next[selectedRuntimeId];
        return next;
      });
      const nextSessions = await refreshSessions();
      if (nextSessions.length === 0) {
        setSelectedRuntimeId(null);
      }
    } finally {
      setIsRemoving(false);
    }
  }, [refreshSessions, removeHeadlessSession, selectedRuntimeId]);

  const handlePermissionResponse = useCallback(async (requestId: string, approved: boolean) => {
    setRespondingRequestId(requestId);
    try {
      await respondHeadlessPermission(requestId, approved, 'desktop');
      if (selectedRuntimeId) {
        await refreshEvents(selectedRuntimeId, lastEventSeq(eventsByRuntime[selectedRuntimeId]));
        await refreshSessions();
      }
    } finally {
      setRespondingRequestId(null);
    }
  }, [eventsByRuntime, refreshEvents, refreshSessions, respondHeadlessPermission, selectedRuntimeId]);

  return (
    <Card className="p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">{t('sessions.headlessTitle')}</h3>
          <p className="text-xs text-muted-foreground mt-1">{t('sessions.headlessSubtitle')}</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{currentEnv}</span>
          <span>·</span>
          <span>{permissionMode}</span>
          <span>·</span>
          <span className="font-mono">{effectiveWorkingDir ? summarizeProject(effectiveWorkingDir) : '~'}</span>
          <Button
            variant="ghost"
            size="sm"
            className="glass-btn-outline h-8 px-2"
            onClick={() => {
              startRefreshTransition(() => {
                void refreshSessions();
                if (selectedRuntimeId) {
                  void refreshEvents(selectedRuntimeId, lastEventSeq(eventsByRuntime[selectedRuntimeId]));
                }
              });
            }}
          >
            <RefreshCw className={cn('w-3.5 h-3.5', isRefreshing && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <div className="rounded-2xl border border-black/[0.06] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03] p-3 space-y-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Sparkles className="w-3.5 h-3.5" />
          <span>{t('sessions.headlessCreateLabel')}</span>
        </div>
        <textarea
          className={cn(INPUT_CLS, 'min-h-[90px] resize-y')}
          rows={4}
          value={nextPrompt}
          onChange={(event) => setNextPrompt(event.target.value)}
          placeholder={t('sessions.headlessPromptPlaceholder')}
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground font-mono truncate">
            {effectiveWorkingDir ?? t('sessions.headlessWorkingDirFallback')}
          </p>
          <Button size="sm" onClick={handleCreate} disabled={isCreating || !nextPrompt.trim()}>
            {isCreating ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />}
            {t('sessions.headlessCreate')}
          </Button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="py-6">
          <EmptyState
            icon={TerminalSquare}
            message={t('sessions.headlessEmpty')}
            action={t('sessions.headlessCreate')}
            onAction={handleCreate}
          />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div className="space-y-2">
            {sessions.map((session) => (
              <button
                key={session.runtime_id}
                type="button"
                onClick={() => setSelectedRuntimeId(session.runtime_id)}
                className={cn(
                  'w-full rounded-2xl border p-3 text-left transition-all',
                  selectedRuntimeId === session.runtime_id
                    ? 'border-primary/40 bg-primary/5 shadow-primary-glow'
                    : 'border-black/[0.06] dark:border-white/[0.08] hover:border-primary/20 hover:bg-black/[0.02] dark:hover:bg-white/[0.03]'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground truncate">
                    {summarizeProject(session.project_dir)}
                  </span>
                  <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium', statusTone(session.status))}>
                    {session.status}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{session.env_name}</span>
                  <span>·</span>
                  <span>{session.perm_mode}</span>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground font-mono truncate">
                  {session.runtime_id}
                </p>
              </button>
            ))}
          </div>

          <div className="rounded-2xl border border-black/[0.06] dark:border-white/[0.08] p-4 bg-black/[0.02] dark:bg-white/[0.03] min-h-[420px]">
            {!selectedSession ? (
              <div className="h-full flex items-center justify-center">
                <EmptyState
                  icon={Bot}
                  message={t('sessions.headlessSelect')}
                />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{summarizeProject(selectedSession.project_dir)}</span>
                      <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium', statusTone(selectedSession.status))}>
                        {selectedSession.status}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground font-mono break-all">
                      {selectedSession.project_dir}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="glass-btn-outline"
                    onClick={handleStop}
                    disabled={!canInteractWithSelected}
                  >
                    <Square className="w-4 h-4" />
                    {t('sessions.headlessStop')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="glass-btn-outline"
                    onClick={handleRemove}
                    disabled={!canRemoveSelected || isRemoving}
                  >
                    {isRemoving ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    {t('sessions.headlessRemove')}
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span>{selectedSession.env_name}</span>
                  <span>·</span>
                  <span>{selectedSession.perm_mode}</span>
                  <span>·</span>
                  <span>{formatTimestamp(selectedSession.created_at)}</span>
                  <span>·</span>
                  <button
                    type="button"
                    className="underline-offset-4 hover:underline"
                    onClick={() => setShowRawJson((current) => !current)}
                  >
                    {showRawJson ? t('sessions.headlessHideRaw') : t('sessions.headlessShowRaw')}
                  </button>
                </div>

                {pendingPermissions.length > 0 ? (
                  <div className="rounded-2xl border border-warning/30 bg-warning/5 p-3 space-y-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">{t('sessions.headlessPermissionTitle')}</p>
                      <p className="text-xs text-muted-foreground mt-1">{t('sessions.headlessPermissionSubtitle')}</p>
                    </div>
                    <div className="space-y-2">
                      {pendingPermissions.map((request) => (
                        <div
                          key={request.requestId}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/[0.06] bg-background/70 px-3 py-2 dark:border-white/[0.08]"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">{request.toolName}</p>
                            <p className="text-[11px] font-mono text-muted-foreground break-all">{request.requestId}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="glass-btn-outline"
                              disabled={respondingRequestId === request.requestId}
                              onClick={() => handlePermissionResponse(request.requestId, false)}
                            >
                              {respondingRequestId === request.requestId ? (
                                <LoaderCircle className="w-4 h-4 animate-spin" />
                              ) : (
                                <XCircle className="w-4 h-4" />
                              )}
                              {t('sessions.headlessDeny')}
                            </Button>
                            <Button
                              size="sm"
                              disabled={respondingRequestId === request.requestId}
                              onClick={() => handlePermissionResponse(request.requestId, true)}
                            >
                              {respondingRequestId === request.requestId ? (
                                <LoaderCircle className="w-4 h-4 animate-spin" />
                              ) : (
                                <CheckCircle2 className="w-4 h-4" />
                              )}
                              {t('sessions.headlessApprove')}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="rounded-2xl border border-black/[0.06] dark:border-white/[0.08] bg-background/70 min-h-[250px] max-h-[420px] overflow-y-auto">
                  {visibleEvents.length === 0 ? (
                    <div className="h-full min-h-[250px] flex items-center justify-center text-sm text-muted-foreground">
                      {t('sessions.headlessNoEvents')}
                    </div>
                  ) : (
                    <div className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
                      {visibleEvents.map((event) => {
                        const body = renderEventBody(event.payload, showRawJson);
                        if (!body) {
                          return null;
                        }
                        return (
                          <div key={`${event.runtime_id}-${event.seq}`} className="px-4 py-3 space-y-1.5">
                            <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                              <span>{formatEventLabel(event.payload)}</span>
                              <span>{formatTimestamp(event.occurred_at)}</span>
                            </div>
                            <pre className={cn(
                              'whitespace-pre-wrap break-words text-sm font-mono',
                              event.payload.type === 'stderr_line' && 'text-destructive',
                              event.payload.type === 'assistant_chunk' && 'text-foreground',
                              event.payload.type !== 'assistant_chunk' && event.payload.type !== 'stderr_line' && 'text-muted-foreground'
                            )}>
                              {body}
                            </pre>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <textarea
                    className={cn(INPUT_CLS, 'min-h-[88px] resize-y')}
                    rows={4}
                    value={composerText}
                    onChange={(event) => setComposerText(event.target.value)}
                    placeholder={t('sessions.headlessFollowupPlaceholder')}
                    disabled={!canInteractWithSelected}
                  />
                  <div className="flex items-center justify-end">
                    <Button
                      size="sm"
                      onClick={handleSend}
                      disabled={!canInteractWithSelected || isSending || !composerText.trim()}
                    >
                      {isSending ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                      {t('sessions.headlessSend')}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
