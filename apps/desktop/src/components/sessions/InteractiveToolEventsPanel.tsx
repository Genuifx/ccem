import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { Bot, CheckCircle2, ClipboardList, FilePenLine, Search, ShieldCheck, TerminalSquare, Wrench } from '@/lib/lucide-react';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/EmptyState';
import { useLocale } from '@/locales';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import type {
  InteractiveToolPrompt,
  SessionEventPayload,
  SessionEventRecord,
  ToolCategory,
  ToolQuestionPrompt,
} from '@/lib/tauri-ipc';

interface InteractiveToolEventsPanelProps {
  sessionId: string | null;
}

function formatTimestamp(value: string) {
  try {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return value;
  }
}

function lastEventSeq(events?: SessionEventRecord[]) {
  if (!events || events.length === 0) {
    return null;
  }
  return events[events.length - 1]?.seq ?? null;
}

function isStructuredInteractiveEvent(payload: SessionEventPayload) {
  return payload.type === 'tool_use_started'
    || payload.type === 'tool_use_completed'
    || payload.type === 'terminal_prompt_required'
    || payload.type === 'terminal_prompt_resolved';
}

function categoryIcon(category: ToolCategory) {
  switch (category.category) {
    case 'execution':
      return TerminalSquare;
    case 'file_op':
      return FilePenLine;
    case 'search':
      return Search;
    case 'task_mgmt':
      return ClipboardList;
    case 'user_input':
      return Bot;
    case 'unknown':
    default:
      return Wrench;
  }
}

function categoryTone(category: ToolCategory) {
  switch (category.category) {
    case 'execution':
      return 'border-cyan-400/30 bg-cyan-500/10 text-cyan-100';
    case 'file_op':
      return 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100';
    case 'search':
      return 'border-slate-400/30 bg-slate-500/10 text-slate-100';
    case 'task_mgmt':
      return 'border-violet-400/30 bg-violet-500/10 text-violet-100';
    case 'user_input':
      return 'border-amber-400/30 bg-amber-500/10 text-amber-100';
    case 'unknown':
    default:
      return 'border-white/15 bg-white/10 text-slate-100';
  }
}

function categoryLabel(category: ToolCategory) {
  switch (category.category) {
    case 'execution':
      return 'Execution';
    case 'file_op':
      return 'File';
    case 'search':
      return 'Search';
    case 'task_mgmt':
      return 'Task';
    case 'user_input':
      switch (category.kind) {
        case 'question':
          return 'Question';
        case 'plan_entry':
          return 'Plan Mode';
        case 'plan_exit':
          return 'Plan Review';
        default:
          return 'User Input';
      }
    case 'unknown':
    default:
      return 'Tool';
  }
}

function formatQuestion(question: ToolQuestionPrompt) {
  const lines = [];
  if (question.header) {
    lines.push(question.header);
  }
  lines.push(question.question);
  if (question.options.length > 0) {
    lines.push(question.options.map((option, index) => `${index + 1}. ${option.label}`).join('\n'));
  }
  return lines.filter(Boolean).join('\n\n');
}

function describePrompt(prompt?: InteractiveToolPrompt | null) {
  if (!prompt) {
    return null;
  }

  switch (prompt.prompt_type) {
    case 'ask_user_question':
      return prompt.questions[0] ? formatQuestion(prompt.questions[0]) : null;
    case 'plan_entry':
      return 'Claude entered plan mode and is preparing an execution plan.';
    case 'plan_exit':
      if (prompt.plan_summary?.trim()) {
        return `Claude is ready to execute this plan:\n\n${prompt.plan_summary.trim()}`;
      }
      return 'Claude wrote up a plan and is waiting for approval or feedback.';
    default:
      return null;
  }
}

function renderEventSummary(payload: SessionEventPayload) {
  switch (payload.type) {
    case 'tool_use_started': {
      const promptBody = describePrompt(payload.prompt);
      return promptBody || payload.input_summary || payload.raw_name;
    }
    case 'tool_use_completed':
      return payload.result_summary || `${payload.raw_name} completed`;
    case 'terminal_prompt_required':
      return payload.prompt_text;
    case 'terminal_prompt_resolved':
      return payload.approved ? 'Resolved with approval' : 'Resolved with denial';
    default:
      return null;
  }
}

export function InteractiveToolEventsPanel({ sessionId }: InteractiveToolEventsPanelProps) {
  const { t } = useLocale();
  const { getInteractiveSessionEvents } = useTauriCommands();
  const [eventsBySession, setEventsBySession] = useState<Record<string, SessionEventRecord[]>>({});
  const [isRefreshing, startRefreshTransition] = useTransition();

  const refreshEvents = useCallback(async (targetSessionId: string, sinceSeq?: number | null) => {
    const batch = await getInteractiveSessionEvents(targetSessionId, sinceSeq ?? null);
    setEventsBySession((current) => {
      const previous = sinceSeq && !batch.gap_detected ? current[targetSessionId] ?? [] : [];
      const merged = [...previous, ...batch.events];
      const seen = new Set<string>();
      const deduped = merged.filter((event) => {
        const key = `${event.runtime_id}:${event.seq}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
      return {
        ...current,
        [targetSessionId]: deduped,
      };
    });
  }, [getInteractiveSessionEvents]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    if (!eventsBySession[sessionId]) {
      void refreshEvents(sessionId, null);
    }
  }, [eventsBySession, refreshEvents, sessionId]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      startRefreshTransition(() => {
        const lastSeen = lastEventSeq(eventsBySession[sessionId]);
        void refreshEvents(sessionId, lastSeen);
      });
    }, 2500);

    return () => window.clearInterval(intervalId);
  }, [eventsBySession, refreshEvents, sessionId]);

  const visibleEvents = useMemo(() => {
    if (!sessionId) {
      return [];
    }
    const events = eventsBySession[sessionId] ?? [];
    return events.filter((event) => isStructuredInteractiveEvent(event.payload)).slice(-16).reverse();
  }, [eventsBySession, sessionId]);

  return (
    <Card className="rounded-2xl border border-black/[0.08] bg-white/70 p-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{t('sessions.interactiveEventsTitle')}</p>
          <p className="text-sm text-muted-foreground">{t('sessions.interactiveEventsSubtitle')}</p>
        </div>
        {isRefreshing ? (
          <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground/70">syncing</span>
        ) : null}
      </div>

      {!sessionId ? (
        <EmptyState
          icon={Bot}
          message={t('sessions.interactiveEventsSelect')}
        />
      ) : visibleEvents.length === 0 ? (
        <EmptyState
          icon={Bot}
          message={t('sessions.interactiveEventsEmpty')}
        />
      ) : (
        <div className="space-y-3">
          {visibleEvents.map((event) => {
            if (event.payload.type === 'tool_use_started') {
              const Icon = categoryIcon(event.payload.category);
              return (
                <div
                  key={`${event.runtime_id}:${event.seq}`}
                  className="rounded-2xl border border-black/[0.06] bg-black/[0.02] p-4"
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <div className={`rounded-full border px-2 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${categoryTone(event.payload.category)}`}>
                        <span className="inline-flex items-center gap-1.5">
                          <Icon className="h-3.5 w-3.5" />
                          {categoryLabel(event.payload.category)}
                        </span>
                      </div>
                      <span className="text-sm font-medium text-foreground">{event.payload.raw_name}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{formatTimestamp(event.occurred_at)}</span>
                  </div>
                  <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/90">
                    {renderEventSummary(event.payload)}
                  </pre>
                </div>
              );
            }

            if (event.payload.type === 'tool_use_completed') {
              return (
                <div
                  key={`${event.runtime_id}:${event.seq}`}
                  className="rounded-2xl border border-emerald-400/20 bg-emerald-500/5 p-4"
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="inline-flex items-center gap-2 text-sm font-medium text-emerald-700">
                      <CheckCircle2 className="h-4 w-4" />
                      {event.payload.raw_name}
                    </div>
                    <span className="text-xs text-muted-foreground">{formatTimestamp(event.occurred_at)}</span>
                  </div>
                  <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/90">
                    {event.payload.result_summary || (event.payload.success ? 'Completed successfully' : 'Completed with errors')}
                  </pre>
                </div>
              );
            }

            if (event.payload.type === 'terminal_prompt_required' || event.payload.type === 'terminal_prompt_resolved') {
              return (
                <div
                  key={`${event.runtime_id}:${event.seq}`}
                  className="rounded-2xl border border-amber-400/20 bg-amber-500/5 p-4"
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="inline-flex items-center gap-2 text-sm font-medium text-amber-700">
                      <ShieldCheck className="h-4 w-4" />
                      {event.payload.type === 'terminal_prompt_required'
                        ? 'Terminal approval'
                        : 'Terminal approval resolved'}
                    </div>
                    <span className="text-xs text-muted-foreground">{formatTimestamp(event.occurred_at)}</span>
                  </div>
                  <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/90">
                    {renderEventSummary(event.payload)}
                  </pre>
                </div>
              );
            }

            return null;
          })}
        </div>
      )}
    </Card>
  );
}
