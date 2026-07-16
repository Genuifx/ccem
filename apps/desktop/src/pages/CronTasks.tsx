import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { useLocale } from '@/locales';
import { useAppStore, type CronTask, type CronTaskRun, type CronTemplate, type CronWecomNotification } from '@/store';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { CronEditor } from '@/components/cron';
import {
  buildCronRunSessionLink,
  getCronRunSessionAvailability,
} from '@/components/cron/cronSessionLink';
import { PageActionsSlot } from '@/components/layout';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import {
  Clock, Plus, Play, Trash2, CheckCircle2, XCircle,
  Timer, AlertTriangle, FolderOpen, ChevronDown, GitPullRequest,
  FlaskConical, FileText, Shield, Newspaper, Sparkles, X,
  Zap, Terminal, Copy, Check, Bell, ExternalLink, History,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ccemMotion, clearMotionProps, getMotionTargets, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';
import { shallow } from 'zustand/shallow';
import type { PlatformCapabilities, WecomTaskBindingOption } from '@/lib/tauri-ipc';

// --- Utility functions ---

function formatDuration(ms?: number | null) {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatTime(iso?: string | null) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatTimeShort(iso?: string | null) {
  if (!iso) return '-';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function formatRelativeTime(iso?: string | null, t?: (key: string) => string) {
  if (!iso) return '';
  try {
    const now = Date.now();
    const target = new Date(iso).getTime();
    const diff = target - now;
    if (diff < 0) return '';
    if (diff < 60000) return t ? t('cron.relativeUnder1Min') : '';
    if (diff < 3600000) {
      const n = Math.round(diff / 60000);
      return t ? t('cron.relativeMinutes').replace('{n}', String(n)) : `${n}m`;
    }
    if (diff < 86400000) {
      const n = (diff / 3600000).toFixed(1);
      return t ? t('cron.relativeHours').replace('{n}', n) : `${n}h`;
    }
    const n = Math.round(diff / 86400000);
    return t ? t('cron.relativeDays').replace('{n}', String(n)) : `${n}d`;
  } catch {
    return '';
  }
}

function parseToolListInput(input: string) {
  return Array.from(new Set(
    input.split(/[\n,]+/).map((v) => v.trim()).filter(Boolean),
  ));
}

function formatToolListInput(values?: string[] | null) {
  return (values ?? []).join(', ');
}

function normalizeWecomPeerComparable(peerId: string) {
  return peerId.trim().replace(/^(single|group):/, '');
}

const TEMPLATE_ICONS: Record<string, typeof Clock> = {
  'git-pr-review': GitPullRequest,
  'test-runner': FlaskConical,
  'doc-gen': FileText,
  'security-audit': Shield,
  'changelog': Newspaper,
};

function getTemplateIcon(id: string) {
  return TEMPLATE_ICONS[id] || Clock;
}

// --- Status components ---

function StatusBadge({ status }: { status: string }) {
  const { t } = useLocale();
  const map: Record<string, { icon: typeof CheckCircle2; cls: string; key: string }> = {
    running: { icon: Timer, cls: 'text-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.1)]', key: 'cron.statusRunning' },
    success: { icon: CheckCircle2, cls: 'text-[hsl(var(--success))] bg-[hsl(var(--success)/0.1)]', key: 'cron.statusSuccess' },
    failed: { icon: XCircle, cls: 'text-[hsl(var(--destructive))] bg-[hsl(var(--destructive)/0.1)]', key: 'cron.statusFailed' },
    timeout: { icon: AlertTriangle, cls: 'text-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.1)]', key: 'cron.statusTimeout' },
  };
  const c = map[status] || map.failed;
  const Icon = c.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium', c.cls)}>
      <Icon className="w-3 h-3" />
      {t(c.key)}
    </span>
  );
}

function StatusDot({ task, runs }: { task: CronTask; runs?: CronTaskRun[] }) {
  if (!task.enabled) return <span className="w-2 h-2 rounded-full bg-[hsl(var(--muted-foreground)/0.3)]" />;
  const last = runs?.[runs.length - 1];
  if (!last) return <span className="w-2 h-2 rounded-full bg-[hsl(var(--success))] animate-pulse" />;
  if (last.status === 'running') return <span className="w-2 h-2 rounded-full bg-[hsl(var(--warning))] animate-pulse" />;
  if (last.status === 'success') return <span className="w-2 h-2 rounded-full bg-[hsl(var(--success))]" />;
  return <span className="w-2 h-2 rounded-full bg-[hsl(var(--destructive))]" />;
}

// --- Timeline Bar ---

function TimelineBar({
  tasks,
  runs,
  onSelectRun,
}: {
  tasks: CronTask[];
  runs: Record<string, CronTaskRun[]>;
  onSelectRun: (taskId: string, runId: string) => void;
}) {
  const { t } = useLocale();
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const progressPercent = (currentMinutes / (24 * 60)) * 100;

  // Collect today's run events for dots
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const dots: { percent: number; status: string; taskId: string; runId: string; taskName: string }[] = [];
  for (const task of tasks) {
    const taskRuns = runs[task.id] ?? [];
    for (const run of taskRuns) {
      const startTime = new Date(run.startedAt);
      if (startTime >= todayStart) {
        const runMinutes = startTime.getHours() * 60 + startTime.getMinutes();
        // Keep dots inside the rounded bar ends
        const pct = Math.min(98, Math.max(2, (runMinutes / (24 * 60)) * 100));
        dots.push({
          percent: pct,
          status: run.status,
          taskId: task.id,
          runId: run.id,
          taskName: task.name,
        });
      }
    }
  }

  const statusColor = (status: string) => {
    switch (status) {
      case 'success': return 'hsl(var(--success))';
      case 'running': return 'hsl(var(--warning))';
      case 'failed': return 'hsl(var(--destructive))';
      case 'timeout': return 'hsl(var(--warning))';
      default: return 'hsl(var(--primary))';
    }
  };

  const labelSets = [
    { hours: [0, 6, 12, 18], cls: 'text-[11px] text-muted-foreground/70 block' },
    { hours: [3, 9, 15, 21], cls: 'text-[10px] text-muted-foreground/50 hidden xl:block' },
  ];

  return (
    <div data-cron-motion-timeline className="relative h-12 md:h-14 lg:h-16 glass-card glass-noise rounded-xl overflow-hidden">
      {/* Elapsed region */}
      <div
        className="absolute inset-y-0 left-0 bg-[hsl(var(--primary)/0.08)]"
        style={{ width: `${progressPercent}%` }}
      />
      {/* Current time indicator */}
      <div
        className="absolute top-1.5 md:top-2 bottom-1.5 md:bottom-2 w-0.5 rounded-full bg-[hsl(var(--primary))] shadow-[0_0_4px_hsl(var(--primary)/0.4)]"
        style={{ left: `${Math.min(99, Math.max(1, progressPercent))}%` }}
      />
      {/* Time labels */}
      {labelSets.map((set, setIdx) =>
        set.hours.map((h) => (
          <span
            key={`${setIdx}-${h}`}
            className={cn('absolute top-1/2 -translate-y-1/2 font-mono select-none', set.cls)}
            style={{ left: `max(16px, min(calc(100% - 16px), ${(h / 24) * 100}%))` }}
          >
            {String(h).padStart(2, '0')}:00
          </span>
        ))
      )}
      {/* Run dots */}
      {dots.map((dot) => (
        <button
          key={dot.runId}
          type="button"
          data-cron-motion-dot
          title={t('cron.timelineDotLabel')
            .replace('{name}', dot.taskName)
            .replace('{status}', dot.status)}
          onClick={() => onSelectRun(dot.taskId, dot.runId)}
          className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full ring-2 ring-[hsl(var(--surface-raised))] hover:scale-125 transition-transform"
          style={{ left: `${dot.percent}%`, backgroundColor: statusColor(dot.status) }}
          aria-label={t('cron.timelineDotLabel')
            .replace('{name}', dot.taskName)
            .replace('{status}', dot.status)}
        />
      ))}
    </div>
  );
}

// --- Empty State ---

function CronEmptyState({ onAdd, onAi }: { onAdd: () => void; onAi: () => void }) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col items-center justify-center py-20">
      {/* Abstract clock + calendar SVG */}
      <div className="relative w-20 h-20 mb-6">
        <svg viewBox="0 0 80 80" fill="none" className="w-full h-full text-muted-foreground/20">
          {/* Clock circle */}
          <circle cx="40" cy="40" r="32" stroke="currentColor" strokeWidth="2" />
          {/* Clock hands */}
          <line x1="40" y1="40" x2="40" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <line x1="40" y1="40" x2="54" y2="40" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          {/* Center dot */}
          <circle cx="40" cy="40" r="3" fill="hsl(var(--primary))" />
          {/* Hour markers */}
          {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg) => (
            <line
              key={deg}
              x1="40"
              y1="12"
              x2="40"
              y2="14"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              transform={`rotate(${deg} 40 40)`}
            />
          ))}
        </svg>
        {/* Pulse ring */}
        <div className="absolute inset-0 rounded-full border border-[hsl(var(--primary)/0.2)] animate-ping motion-reduce:animate-none" style={{ animationDuration: '3s' }} />
      </div>
      <h3 className="text-base font-semibold text-foreground mb-1.5">
        {t('cron.noTasks')}
      </h3>
      <p className="text-sm text-muted-foreground mb-6 max-w-[280px] text-center">
        {t('cron.noTasksHint')}
      </p>
      <div className="flex items-center gap-3">
        <button
          onClick={onAdd}
          className="inline-flex items-center gap-1.5 px-4 py-[7px] rounded-full text-[13px] font-medium bg-primary text-white shadow-sm hover:bg-primary/90 transition-all active:scale-[0.97]"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('cron.addTask')}
        </button>
        <button
          onClick={onAi}
          className="inline-flex items-center gap-1.5 px-4 py-[7px] rounded-full text-[13px] font-medium bg-transparent text-primary border border-primary/40 hover:border-primary/70 transition-all active:scale-[0.97]"
        >
          <Sparkles className="w-3.5 h-3.5" />
          {t('cron.aiCreate')}
        </button>
      </div>
    </div>
  );
}

// --- Task Card (Timeline item) ---

function TimelineTaskCard({
  task,
  runs,
  nextRun,
  expanded,
  onToggleExpand,
  onEdit,
  onDelete,
  onToggleEnabled,
  onRetry,
  onViewRun,
  onOpenSession,
}: {
  task: CronTask;
  runs: CronTaskRun[];
  nextRun?: string;
  expanded: boolean;
  onToggleExpand: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onRetry: () => void;
  onViewRun: (runId: string) => void;
  onOpenSession: (run: CronTaskRun) => void;
}) {
  const { t } = useLocale();
  const lastRun = runs[runs.length - 1];
  const [showAllRuns, setShowAllRuns] = useState(false);
  const orderedRuns = useMemo(() => [...runs].reverse(), [runs]);
  const visibleRuns = showAllRuns ? orderedRuns : orderedRuns.slice(0, 8);

  return (
    <div
      data-cron-motion-card
      data-cron-task-id={task.id}
      data-cron-motion-expanded={expanded ? 'true' : 'false'}
      className={cn(
        'glass-card glass-noise rounded-xl transition-all',
        expanded && 'ring-1 ring-[hsl(var(--primary)/0.4)]',
      )}
    >
      {/* Main row */}
      <button
        onClick={onToggleExpand}
        aria-expanded={expanded}
        className="w-full flex items-center gap-4 px-4 py-3 text-left"
      >
        {/* Time column */}
        <div className="w-14 shrink-0 text-center">
          {nextRun ? (
            <div className="text-base font-semibold text-foreground tabular-nums tracking-tight">
              {formatTimeShort(nextRun)}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground/50">—</div>
          )}
        </div>
        {/* Task info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot task={task} runs={runs} />
            <span className="text-sm font-semibold text-foreground truncate">{task.name}</span>
            {!task.enabled && (
              <span className="text-[10px] text-muted-foreground/60 px-1.5 py-0.5 rounded-md bg-[hsl(var(--muted-foreground)/0.08)]">
                {t('cron.disabled')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs font-mono text-muted-foreground">{task.cronExpression}</span>
            {nextRun && (
              <span className="text-[11px] text-muted-foreground/60">{formatRelativeTime(nextRun, t)}</span>
            )}
          </div>
        </div>
        {/* Status */}
        {lastRun && <StatusBadge status={lastRun.status} />}
        {/* Chevron */}
        <ChevronDown className={cn('w-4 h-4 text-muted-foreground/40 transition-transform', expanded && 'rotate-180')} />
      </button>

      {/* Expanded detail */}
      <div className={cn('grid transition-[grid-template-rows] duration-200 ease-out', expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div data-cron-motion-detail className="overflow-hidden">
          <div className="px-4 pb-3.5 space-y-2.5 border-t border-[hsl(var(--glass-border-light)/var(--glass-border-opacity))]">
            {/* Actions */}
            <div className="flex items-center gap-2 pt-3.5">
              <button
                onClick={(e) => { e.stopPropagation(); onRetry(); }}
                className="glass-btn-outline flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs"
              >
                <Play className="w-3 h-3" />
                {t('cron.retry')}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onToggleEnabled(); }}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs transition-colors',
                  task.enabled
                    ? 'bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]'
                    : 'glass-btn-outline'
                )}
              >
                {task.enabled ? t('cron.enabled') : t('cron.disabled')}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onEdit(); }}
                className="glass-btn-outline px-2.5 py-1 rounded-lg text-xs"
              >
                {t('common.edit')}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                aria-label={t('common.delete')}
                className="ml-auto p-1.5 rounded-lg text-muted-foreground hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/0.1)] transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Prompt */}
            <div>
              <p className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider mb-1.5">{t('cron.prompt')}</p>
              <p className="text-[13px] leading-relaxed text-foreground/80 whitespace-pre-wrap line-clamp-3">{task.prompt}</p>
            </div>

            {/* Config grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="glass-subtle glass-noise rounded-lg px-3 py-2">
                <div className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">{t('cron.workingDir')}</div>
                <div className="text-[11px] font-mono text-foreground/80 mt-1 truncate">{task.workingDir}</div>
              </div>
              <div className="glass-subtle glass-noise rounded-lg px-3 py-2">
                <div className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">{t('cron.timeout')}</div>
                <div className="text-[11px] font-medium text-foreground/80 mt-1 tabular-nums">{task.timeoutSecs}s</div>
              </div>
              <div className="glass-subtle glass-noise rounded-lg px-3 py-2">
                <div className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">{t('cron.executionProfile')}</div>
                <div className="text-[11px] font-medium text-foreground/80 mt-1">
                  {task.executionProfile === 'conservative' ? t('cron.profileConservative')
                    : task.executionProfile === 'standard' ? t('cron.profileStandard')
                    : t('cron.profileAutonomous')}
                </div>
              </div>
              <div className="glass-subtle glass-noise rounded-lg px-3 py-2">
                <div className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">{t('cron.profileBudget')}</div>
                <div className="text-[11px] font-medium text-foreground/80 mt-1 tabular-nums">
                  {task.maxBudgetUsd != null ? `$${task.maxBudgetUsd.toFixed(2)}` : '$0.50'}
                </div>
              </div>
            </div>

            {/* Run history */}
            {runs.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">{t('cron.runHistory')}</p>
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {t('cron.runCount').replace('{n}', String(runs.length))}
                  </span>
                </div>
                <div className="space-y-1">
                  {visibleRuns.map((run) => {
                    const session = getCronRunSessionAvailability({
                      id: run.id,
                      runtimeId: run.runtimeId,
                      providerSessionId: run.providerSessionId,
                      workingDir: run.workingDir ?? task.workingDir,
                      status: run.status,
                    });
                    return (
                      <div key={run.id} className="group/run flex items-center gap-2 px-2.5 py-1 rounded-lg glass-subtle">
                        <StatusBadge status={run.status} />
                        <span className="text-[11px] text-muted-foreground flex-1 min-w-0 truncate">{formatTime(run.startedAt)}</span>
                        <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">{formatDuration(run.durationMs)}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (session.canOpen) onOpenSession(run);
                          }}
                          disabled={!session.canOpen}
                          className={cn(
                            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] transition-colors',
                            session.canOpen
                              ? 'text-primary hover:bg-primary/10'
                              : 'text-muted-foreground/50 cursor-not-allowed',
                          )}
                          aria-label={session.canOpen ? t('cron.openSession') : t('cron.openSessionUnavailable')}
                          title={session.canOpen ? t('cron.openSession') : t('cron.sessionUnavailable')}
                        >
                          <ExternalLink className="w-3 h-3" />
                          {session.canOpen ? t('cron.openSession') : t('cron.openSessionUnavailable')}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); onViewRun(run.id); }}
                          className="p-1 rounded-md hover:bg-foreground/[0.06]"
                          aria-label={t('cron.viewOutput')}
                        >
                          <Terminal className="w-3.5 h-3.5 text-muted-foreground" />
                        </button>
                      </div>
                    );
                  })}
                </div>
                {orderedRuns.length > 8 && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setShowAllRuns((v) => !v); }}
                    className="mt-1.5 text-[11px] text-primary hover:text-primary/80"
                  >
                    {showAllRuns
                      ? t('cron.showLessRuns')
                      : t('cron.viewAllRuns')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Task Dialog ---

const INPUT_CLS = 'w-full px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.06] border border-black/[0.08] dark:border-white/[0.08] text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/30 transition-all';
const MODAL_SELECT_CONTENT_CLS = '!z-[160]';

function TaskDialog({ open, onClose, onSave, editTask, environments }: {
  open: boolean;
  onClose: () => void;
  onSave: (d: {
    name: string;
    cronExpression: string;
    prompt: string;
    workingDir: string;
    envName?: string;
    executionProfile: CronTask['executionProfile'];
    maxBudgetUsd?: number | null;
    allowedTools?: string[];
    disallowedTools?: string[];
    timeoutSecs?: number;
    wecomNotification?: CronWecomNotification | null;
  }) => Promise<void>;
  editTask?: CronTask;
  environments: { name: string }[];
}) {
  const { t } = useLocale();
  const { openDirectoryPicker, getWecomTaskBindingOptions } = useTauriCommands();
  const [name, setName] = useState('');
  const [cronExpr, setCronExpr] = useState('0 9 * * 1-5');
  const [prompt, setPrompt] = useState('');
  const [workDir, setWorkDir] = useState('');
  const [envName, setEnvName] = useState('');
  const [executionProfile, setExecutionProfile] = useState<CronTask['executionProfile']>('conservative');
  const [maxBudgetUsdInput, setMaxBudgetUsdInput] = useState('');
  const [allowedToolsInput, setAllowedToolsInput] = useState('');
  const [disallowedToolsInput, setDisallowedToolsInput] = useState('');
  const [timeoutSecs, setTimeoutSecs] = useState(300);
  const [notifyWecom, setNotifyWecom] = useState(false);
  const [wecomBotId, setWecomBotId] = useState('');
  const [wecomPeerId, setWecomPeerId] = useState('');
  const [useManualWecomTarget, setUseManualWecomTarget] = useState(false);
  const [wecomOptions, setWecomOptions] = useState<WecomTaskBindingOption[]>([]);
  const [saving, setSaving] = useState(false);

  const wecomTargetOptions = useMemo(() => wecomOptions.flatMap((bot) => (
    bot.targets.map((target, index) => ({
      id: `${bot.botId}::${index}`,
      botId: bot.botId,
      peerId: target.peerId,
      label: `${bot.name} · ${target.label}${target.isDefault ? ` · ${t('cron.wecomDefaultTarget')}` : ''}`,
    }))
  )), [t, wecomOptions]);

  const selectedWecomTargetValue = useMemo(() => {
    if (useManualWecomTarget) {
      return '__manual__';
    }
    if (!wecomBotId.trim() && !wecomPeerId.trim()) {
      return '__default__';
    }
    const match = wecomTargetOptions.find((target) => (
      target.botId === wecomBotId.trim()
      && normalizeWecomPeerComparable(target.peerId) === normalizeWecomPeerComparable(wecomPeerId)
    ));
    return match?.id ?? '__manual__';
  }, [useManualWecomTarget, wecomBotId, wecomPeerId, wecomTargetOptions]);

  useEffect(() => {
    if (editTask) {
      setName(editTask.name);
      setCronExpr(editTask.cronExpression);
      setPrompt(editTask.prompt);
      setWorkDir(editTask.workingDir);
      setEnvName(editTask.envName || '');
      setExecutionProfile(editTask.executionProfile || 'conservative');
      setMaxBudgetUsdInput(editTask.maxBudgetUsd != null ? String(editTask.maxBudgetUsd) : '');
      setAllowedToolsInput(formatToolListInput(editTask.allowedTools));
      setDisallowedToolsInput(formatToolListInput(editTask.disallowedTools));
      setTimeoutSecs(editTask.timeoutSecs);
      setNotifyWecom(Boolean(editTask.wecomNotification?.enabled));
      setWecomBotId(editTask.wecomNotification?.botId || '');
      setWecomPeerId(editTask.wecomNotification?.peerId || '');
      setUseManualWecomTarget(false);
    } else {
      setName('');
      setCronExpr('0 9 * * 1-5');
      setPrompt('');
      setWorkDir('');
      setEnvName('');
      setExecutionProfile('conservative');
      setMaxBudgetUsdInput('');
      setAllowedToolsInput('');
      setDisallowedToolsInput('');
      setTimeoutSecs(300);
      setNotifyWecom(false);
      setWecomBotId('');
      setWecomPeerId('');
      setUseManualWecomTarget(false);
    }
  }, [editTask, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    getWecomTaskBindingOptions()
      .then(setWecomOptions)
      .catch(() => setWecomOptions([]));
  }, [getWecomTaskBindingOptions, open]);

  if (!open) return null;

  const doSave = async () => {
    if (!name.trim() || !cronExpr.trim() || !prompt.trim() || !workDir.trim()) return;
    const parsedBudget = maxBudgetUsdInput.trim() ? Number(maxBudgetUsdInput.trim()) : null;
    if (maxBudgetUsdInput.trim() && (!Number.isFinite(parsedBudget) || Number(parsedBudget) <= 0)) {
      toast.error(t('cron.invalidBudget'));
      return;
    }
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        cronExpression: cronExpr.trim(),
        prompt: prompt.trim(),
        workingDir: workDir.trim(),
        envName: envName || undefined,
        executionProfile,
        maxBudgetUsd: parsedBudget,
        allowedTools: parseToolListInput(allowedToolsInput),
        disallowedTools: parseToolListInput(disallowedToolsInput),
        timeoutSecs,
        wecomNotification: notifyWecom ? {
          enabled: true,
          botId: wecomBotId.trim() || null,
          peerId: wecomPeerId.trim() || null,
        } : null,
      });
      onClose();
    } catch (err) {
      toast.error(typeof err === 'string' ? err : t('cron.taskSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-dialog-title"
        className="relative rounded-2xl w-[calc(100%-1.5rem)] sm:w-[calc(100%-2rem)] md:w-[calc(100%-2.5rem)] lg:w-[calc(100%-3rem)] xl:w-[calc(100%-4rem)] 2xl:w-[calc(100%-5rem)] mx-auto max-w-md sm:max-w-lg md:max-w-xl lg:max-w-2xl xl:max-w-3xl 2xl:max-w-4xl max-h-[min(90vh,900px)] overflow-hidden shadow-elevation-4 border border-[hsl(var(--glass-border-light)/0.25)]"
        style={{ background: 'hsl(var(--surface-overlay))' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="relative px-5 pt-5 pb-4">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-purple-500/5" />
          <div className="relative flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-primary/15 flex items-center justify-center">
                <Clock className="w-4 h-4 text-primary" />
              </div>
              <h2 id="task-dialog-title" className="text-sm font-semibold text-foreground">{editTask ? t('cron.editTask') : t('cron.addTask')}</h2>
            </div>
            <button onClick={onClose} aria-label={t('common.cancel')} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Form */}
        <div className="px-5 pb-5 space-y-4 overflow-y-auto max-h-[calc(min(85vh,900px)-80px)]">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('cron.taskName')}</label>
            <input className={INPUT_CLS} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('cron.taskNamePlaceholder')} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('cron.schedule')}</label>
            <CronEditor value={cronExpr} onChange={setCronExpr} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('cron.prompt')}</label>
            <textarea className={cn(INPUT_CLS, 'min-h-[80px] resize-y')} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('cron.promptPlaceholder')} rows={3} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('cron.workingDir')}</label>
            <div className="flex gap-2">
              <input className={cn(INPUT_CLS, 'flex-1 font-mono')} value={workDir} onChange={(e) => setWorkDir(e.target.value)} placeholder="/path/to/project" />
              <button type="button" onClick={async () => { const d = await openDirectoryPicker(); if (d) setWorkDir(d); }} className="px-3 py-2 rounded-xl border border-black/[0.08] dark:border-white/[0.08] bg-black/[0.03] dark:bg-white/[0.06] text-foreground hover:bg-black/[0.06] dark:hover:bg-white/[0.1] transition-colors shrink-0">
                <FolderOpen className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t('cron.environment')}</label>
              <Select value={envName || '__default__'} onValueChange={(v) => setEnvName(v === '__default__' ? '' : v)}>
                <SelectTrigger className="w-full h-auto px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.06] border border-black/[0.08] dark:border-white/[0.08] text-sm">
                  <SelectValue placeholder={t('cron.envDefault')} />
                </SelectTrigger>
                <SelectContent className={MODAL_SELECT_CONTENT_CLS}>
                  <SelectItem value="__default__">{t('cron.envDefault')}</SelectItem>
                  {environments.map((env) => <SelectItem key={env.name} value={env.name}>{env.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t('cron.timeout')}</label>
              <div className="flex items-center gap-2">
                <input type="number" className={INPUT_CLS} value={timeoutSecs} onChange={(e) => setTimeoutSecs(Number(e.target.value) || 300)} min={30} max={3600} />
                <span className="text-2xs text-muted-foreground shrink-0">{t('cron.timeoutUnit')}</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t('cron.executionProfile')}</label>
              <Select value={executionProfile} onValueChange={(value) => setExecutionProfile(value as CronTask['executionProfile'])}>
                <SelectTrigger className="w-full h-auto px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.06] border border-black/[0.08] dark:border-white/[0.08] text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={MODAL_SELECT_CONTENT_CLS}>
                  <SelectItem value="conservative">{t('cron.profileConservative')}</SelectItem>
                  <SelectItem value="standard">{t('cron.profileStandard')}</SelectItem>
                  <SelectItem value="autonomous">{t('cron.profileAutonomous')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-2xs text-muted-foreground">
                {executionProfile === 'conservative'
                  ? t('cron.profileConservativeDesc')
                  : executionProfile === 'standard'
                    ? t('cron.profileStandardDesc')
                    : t('cron.profileAutonomousDesc')}
              </p>
            </div>
          </div>
          <div className="rounded-xl border border-black/[0.08] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03] p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Bell className="h-3.5 w-3.5 text-primary" />
                  <p className="text-xs font-medium text-foreground">{t('cron.resultNotification')}</p>
                </div>
                <p className="mt-1 text-2xs text-muted-foreground">{t('cron.wecomNotificationDesc')}</p>
              </div>
              <button
                type="button"
                onClick={() => setNotifyWecom((value) => !value)}
                className={cn(
                  'shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-all active:scale-[0.97]',
                  notifyWecom
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'border border-black/[0.08] dark:border-white/[0.12] text-muted-foreground hover:text-foreground',
                )}
              >
                {notifyWecom ? t('cron.wecomNotifyOn') : t('cron.wecomNotifyOff')}
              </button>
            </div>
            {notifyWecom && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">{t('cron.wecomTarget')}</label>
                  <Select
                    value={selectedWecomTargetValue}
                    onValueChange={(value) => {
                      if (value === '__default__') {
                        setWecomBotId('');
                        setWecomPeerId('');
                        setUseManualWecomTarget(false);
                        return;
                      }
                      if (value === '__manual__') {
                        setUseManualWecomTarget(true);
                        return;
                      }
                      const target = wecomTargetOptions.find((item) => item.id === value);
                      if (target) {
                        setWecomBotId(target.botId);
                        setWecomPeerId(target.peerId);
                        setUseManualWecomTarget(false);
                      }
                    }}
                  >
                    <SelectTrigger className="w-full h-auto px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.06] border border-black/[0.08] dark:border-white/[0.08] text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className={MODAL_SELECT_CONTENT_CLS}>
                      <SelectItem value="__default__">{t('cron.wecomDefaultTarget')}</SelectItem>
                      {wecomTargetOptions.map((target) => (
                        <SelectItem key={target.id} value={target.id}>{target.label}</SelectItem>
                      ))}
                      <SelectItem value="__manual__">{t('cron.wecomManualTarget')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {selectedWecomTargetValue === '__manual__' && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">{t('cron.wecomBotId')}</label>
                      <input
                        className={cn(INPUT_CLS, 'font-mono')}
                        value={wecomBotId}
                        onChange={(e) => { setUseManualWecomTarget(true); setWecomBotId(e.target.value); }}
                        placeholder="aibot..."
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">{t('cron.wecomPeerId')}</label>
                      <input
                        className={cn(INPUT_CLS, 'font-mono')}
                        value={wecomPeerId}
                        onChange={(e) => { setUseManualWecomTarget(true); setWecomPeerId(e.target.value); }}
                        placeholder="iveswen or group:chatid"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="rounded-xl border border-black/[0.08] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03] p-3 space-y-3">
            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground">{t('cron.customToolPolicy')}</p>
              <p className="text-2xs text-muted-foreground">{t('cron.customToolPolicyDesc')}</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t('cron.profileBudget')}</label>
                <input
                  type="number"
                  min={0.01}
                  step={0.01}
                  className={INPUT_CLS}
                  value={maxBudgetUsdInput}
                  onChange={(e) => setMaxBudgetUsdInput(e.target.value)}
                  placeholder={t('cron.profileBudgetPlaceholder')}
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <label className="text-xs font-medium text-muted-foreground">{t('cron.allowedTools')}</label>
                <textarea
                  className={cn(INPUT_CLS, 'min-h-[72px] resize-y')}
                  value={allowedToolsInput}
                  onChange={(e) => setAllowedToolsInput(e.target.value)}
                  placeholder={t('cron.toolListPlaceholder')}
                  rows={3}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t('cron.disallowedTools')}</label>
              <textarea
                className={cn(INPUT_CLS, 'min-h-[72px] resize-y')}
                value={disallowedToolsInput}
                onChange={(e) => setDisallowedToolsInput(e.target.value)}
                placeholder={t('cron.toolListPlaceholder')}
                rows={3}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2.5 pt-3 border-t border-black/[0.06] dark:border-white/[0.06]">
            <button className="px-4 py-[7px] text-[13px] font-medium rounded-full border border-black/[0.08] dark:border-white/[0.12] text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-all active:scale-[0.97]" onClick={onClose}>{t('common.cancel')}</button>
            <button
              onClick={doSave}
              disabled={saving || !name.trim() || !prompt.trim() || !workDir.trim()}
              className="px-4 py-[7px] text-[13px] font-medium rounded-full bg-primary text-white shadow-sm hover:bg-primary/90 transition-all active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
            >
              {saving ? t('common.loading') : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// --- Main Export Component ---

export function CronTasks({
  onAiCreate,
  onOpenSessionLink,
}: {
  onAiCreate?: () => void;
  onOpenSessionLink?: (link: string) => void;
}) {
  const { t } = useLocale();
  const { cronTasks, cronRuns, environments, isLoadingCron } = useAppStore(
    (state) => ({
      cronTasks: state.cronTasks,
      cronRuns: state.cronRuns,
      environments: state.environments,
      isLoadingCron: state.isLoadingCron,
    }),
    shallow
  );
  const {
    loadCronTasks, addCronTask, updateCronTask,
    deleteCronTask, toggleCronTask, listCronTemplates,
    getPlatformCapabilities, getCronNextRuns, retryCronTask,
    getCronRunDetail, loadCronTaskRuns,
  } = useTauriCommands();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<CronTask | undefined>();
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CronTask | null>(null);
  const [templates, setTemplates] = useState<CronTemplate[]>([]);
  const [platformCapabilities, setPlatformCapabilities] = useState<PlatformCapabilities | null>(null);
  const [nextRunTimes, setNextRunTimes] = useState<Record<string, string>>({});
  const [drawerRun, setDrawerRun] = useState<CronTaskRun | null>(null);
  const [drawerTask, setDrawerTask] = useState<CronTask | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [recentRange, setRecentRange] = useState<'today' | '7d' | 'all'>('today');
  const cronMotionRef = useRef<HTMLDivElement>(null);
  const hasHydratedCronMotionRef = useRef(false);
  const seenCronMotionTargetsRef = useRef<Set<string>>(new Set());
  const showTmuxNotice = platformCapabilities?.tmuxSupported === true && !platformCapabilities.tmuxInstalled;
  const tmuxInstallCommand = platformCapabilities?.tmuxInstallCommand ?? null;

  const openRunDrawer = useCallback(async (taskId: string, runId: string) => {
    setDrawerLoading(true);
    setDrawerRun(null);
    setDrawerTask(cronTasks.find((task) => task.id === taskId) ?? null);
    try {
      const detail = await getCronRunDetail(taskId, runId);
      setDrawerRun(detail);
    } catch (err) {
      console.error('Failed to load run detail:', err);
      setDrawerRun(null);
    } finally {
      setDrawerLoading(false);
    }
  }, [cronTasks, getCronRunDetail]);

  const openRunSession = useCallback((task: CronTask | null | undefined, run: CronTaskRun) => {
    const link = buildCronRunSessionLink({
      id: run.id,
      runtimeId: run.runtimeId,
      providerSessionId: run.providerSessionId,
      workingDir: run.workingDir ?? task?.workingDir ?? null,
      status: run.status,
    }, { focus: 'live' });
    if (!link) {
      toast.error(t('cron.sessionUnavailable'));
      return;
    }
    if (onOpenSessionLink) {
      onOpenSessionLink(link);
      return;
    }
    toast.error(t('cron.sessionUnavailable'));
  }, [onOpenSessionLink, t]);

  // Load tasks and templates on mount
  useEffect(() => {
    loadCronTasks();
    listCronTemplates().then(setTemplates).catch(() => {});
  }, [loadCronTasks, listCronTemplates]);

  // Load runs for all tasks
  useEffect(() => {
    for (const task of cronTasks) {
      loadCronTaskRuns(task.id);
    }
  }, [cronTasks, loadCronTaskRuns]);

  // Load platform capabilities for optional tmux enhancement messaging.
  useEffect(() => {
    getPlatformCapabilities()
      .then(setPlatformCapabilities)
      .catch(() => setPlatformCapabilities(null));
  }, [getPlatformCapabilities]);

  // Event listeners for cron task lifecycle
  useEffect(() => {
    let mounted = true;
    const unsubs: (() => void)[] = [];
    const setup = async () => {
      try {
        for (const evt of ['cron-task-started', 'cron-task-completed', 'cron-task-failed']) {
          const fn = await listen(evt, () => {
            if (!mounted) return;
            void loadCronTasks();
            for (const task of useAppStore.getState().cronTasks) {
              void loadCronTaskRuns(task.id);
            }
          });
          // If unmounted while listen() was resolving, immediately clean up
          if (!mounted) { fn(); return; }
          unsubs.push(fn);
        }
      } catch (err) {
        console.error('Failed to setup cron event listeners:', err);
      }
    };
    setup();
    return () => {
      mounted = false;
      unsubs.forEach((fn) => fn());
    };
  }, [loadCronTaskRuns, loadCronTasks]);

  // Fetch next run times for each task
  useEffect(() => {
    const fetchNextRuns = async () => {
      const times: Record<string, string> = {};
      for (const task of cronTasks) {
        if (task.enabled) {
          try {
            const runs = await getCronNextRuns(task.cronExpression, 1);
            if (runs.length > 0) times[task.id] = runs[0];
          } catch { /* ignore */ }
        }
      }
      setNextRunTimes(times);
    };
    if (cronTasks.length > 0) fetchNextRuns();
  }, [cronTasks, getCronNextRuns]);

  // Sort tasks by next run time (upcoming)
  const upcomingTasks = useMemo(() => {
    return [...cronTasks]
      .filter((task) => task.enabled)
      .sort((a, b) => {
        const aTime = nextRunTimes[a.id] ? new Date(nextRunTimes[a.id]).getTime() : Infinity;
        const bTime = nextRunTimes[b.id] ? new Date(nextRunTimes[b.id]).getTime() : Infinity;
        return aTime - bTime;
      });
  }, [cronTasks, nextRunTimes]);

  const disabledTasks = useMemo(() => cronTasks.filter((task) => !task.enabled), [cronTasks]);

  // Recent completed runs (filterable)
  const recentCompletedRuns = useMemo(() => {
    const now = Date.now();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const results: { task: CronTask; run: CronTaskRun }[] = [];
    for (const task of cronTasks) {
      const runs = cronRuns[task.id] || [];
      for (const run of runs) {
        if (run.status === 'running') continue;
        const stamp = run.finishedAt || run.startedAt;
        if (!stamp) continue;
        const ts = new Date(stamp).getTime();
        if (Number.isNaN(ts)) continue;
        if (recentRange === 'today' && ts < today.getTime()) continue;
        if (recentRange === '7d' && ts < sevenDaysAgo) continue;
        results.push({ task, run });
      }
    }
    return results.sort((a, b) => {
      const aTs = new Date(a.run.finishedAt || a.run.startedAt).getTime();
      const bTs = new Date(b.run.finishedAt || b.run.startedAt).getTime();
      return bTs - aTs;
    });
  }, [cronTasks, cronRuns, recentRange]);

  // Only structural list identity should re-trigger entrance motion.
  // nextRunTimes / run status updates are local data refreshes and must not
  // replay whole-page fromTo (that caused multi-fade jitter on open).
  const cronMotionStructureKey = useMemo(() => {
    const taskIds = [...upcomingTasks, ...disabledTasks]
      .slice(0, 12)
      .map((task) => `${task.id}:${task.enabled ? 'on' : 'off'}`)
      .join('|');
    const completedIds = recentCompletedRuns
      .slice(0, 6)
      .map(({ run }) => run.id)
      .join('|');
    return `${isLoadingCron ? 'loading' : 'ready'}:${taskIds}:${completedIds}`;
  }, [disabledTasks, isLoadingCron, recentCompletedRuns, upcomingTasks]);

  useGSAP(() => {
    const root = cronMotionRef.current;
    if (!root || isLoadingCron) {
      return;
    }

    const targets = [
      ...getMotionTargets(root, '[data-cron-motion-timeline]', 1),
      ...getMotionTargets(root, '[data-cron-motion-section]', 4),
      ...getMotionTargets(root, '[data-cron-motion-card]', 12),
      ...getMotionTargets(root, '[data-cron-motion-run]', 8),
    ];

    if (targets.length === 0) {
      return;
    }

    const targetIdentity = (el: HTMLElement) => {
      if (el.hasAttribute('data-cron-motion-timeline')) return 'timeline';
      if (el.hasAttribute('data-cron-motion-section')) {
        return `section:${el.querySelector('h3')?.textContent?.trim() || targets.indexOf(el)}`;
      }
      if (el.hasAttribute('data-cron-motion-card')) {
        return `card:${el.getAttribute('data-cron-task-id') || targets.indexOf(el)}`;
      }
      if (el.hasAttribute('data-cron-motion-run')) {
        return `run:${el.getAttribute('data-cron-run-id') || targets.indexOf(el)}`;
      }
      return `node:${targets.indexOf(el)}`;
    };

    const seen = seenCronMotionTargetsRef.current;
    const freshTargets = targets.filter((el) => !seen.has(targetIdentity(el)));

    // First paint after mount: mark existing nodes as seen without animating.
    // Subsequent structural inserts animate only the new nodes (local update).
    if (!hasHydratedCronMotionRef.current) {
      hasHydratedCronMotionRef.current = true;
      for (const el of targets) {
        seen.add(targetIdentity(el));
      }
      clearMotionProps(targets);
      return;
    }

    // Drop identities that left the DOM so re-added tasks can animate once.
    const liveIds = new Set(targets.map(targetIdentity));
    for (const id of [...seen]) {
      if (!liveIds.has(id)) {
        seen.delete(id);
      }
    }

    if (freshTargets.length === 0) {
      clearMotionProps(targets);
      return;
    }

    for (const el of freshTargets) {
      seen.add(targetIdentity(el));
    }

    if (shouldReduceMotion()) {
      clearMotionProps(freshTargets);
      return;
    }

    gsap.killTweensOf(freshTargets);
    gsap.fromTo(
      freshTargets,
      { autoAlpha: 0, y: 8, scale: 0.99 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: ccemMotion.duration.quick,
        ease: ccemMotion.ease.standard,
        stagger: 0.02,
        overwrite: 'auto',
        onComplete: () => clearMotionProps(freshTargets),
      },
    );
  }, { scope: cronMotionRef, dependencies: [cronMotionStructureKey, isLoadingCron] });

  useGSAP(() => {
    const root = cronMotionRef.current;
    if (!root || !expandedTaskId) {
      return;
    }

    const detail = root.querySelector<HTMLElement>(
      '[data-cron-motion-card][data-cron-motion-expanded="true"] [data-cron-motion-detail]',
    );
    if (!detail) {
      return;
    }

    if (shouldReduceMotion()) {
      clearMotionProps(detail);
      return;
    }

    gsap.killTweensOf(detail);
    gsap.fromTo(
      detail,
      { autoAlpha: 0, y: -4 },
      {
        autoAlpha: 1,
        y: 0,
        duration: ccemMotion.duration.quick,
        ease: ccemMotion.ease.standard,
        overwrite: 'auto',
        onComplete: () => clearMotionProps(detail),
      },
    );
  }, { scope: cronMotionRef, dependencies: [expandedTaskId] });

  const handleAdd = () => { setEditingTask(undefined); setDialogOpen(true); };
  const handleEdit = (task: CronTask) => { setEditingTask(task); setDialogOpen(true); };
  const handleAiCreate = () => {
    onAiCreate?.();
  };

  const handleTemplateCreate = async (tpl: CronTemplate) => {
    try {
      const task = await addCronTask({
        name: tpl.name, cronExpression: tpl.cronExpression,
        prompt: tpl.prompt, workingDir: '~', templateId: tpl.id,
        executionProfile: 'conservative', maxBudgetUsd: null,
        allowedTools: [], disallowedTools: [],
      });
      toast.success(t('cron.taskCreated'));
      setEditingTask(task);
      setDialogOpen(true);
    } catch {
      toast.error(t('cron.fillRequired'));
    }
  };

  const handleSave = useCallback(async (data: {
    name: string; cronExpression: string; prompt: string;
    workingDir: string; envName?: string;
    executionProfile: CronTask['executionProfile'];
    maxBudgetUsd?: number | null;
    allowedTools?: string[];
    disallowedTools?: string[];
    timeoutSecs?: number;
    wecomNotification?: CronWecomNotification | null;
  }) => {
    if (editingTask) {
      await updateCronTask({ id: editingTask.id, ...data });
      toast.success(t('cron.taskUpdated'));
    } else {
      await addCronTask(data);
      toast.success(t('cron.taskAdded'));
    }
  }, [editingTask, addCronTask, updateCronTask, t]);

  const handleDelete = async () => {
    if (!pendingDelete) return;
    await deleteCronTask(pendingDelete.id);
    toast.success(t('cron.taskDeleted'));
    if (expandedTaskId === pendingDelete.id) setExpandedTaskId(null);
    setPendingDelete(null);
  };

  const handleRetry = async (taskId: string) => {
    try {
      await retryCronTask(taskId);
      toast.success(t('cron.taskRetried'));
    } catch {
      toast.error(t('cron.retryFailed'));
    }
  };

  const hasTaskColumn = upcomingTasks.length > 0 || disabledTasks.length > 0;

  return (
    <div ref={cronMotionRef} className="space-y-4">
      {/* Tmux warning */}
      {showTmuxNotice && (
        <div className="rounded-xl border border-warning/25 bg-warning/8 px-4 py-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div>
              <p className="text-sm font-medium text-foreground">{t('cron.tmuxOptionalTitle')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('cron.tmuxOptionalNotice')}</p>
              {tmuxInstallCommand && (
                <p className="mt-2 font-mono text-2xs text-muted-foreground">{tmuxInstallCommand}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Page action buttons — portaled to titlebar */}
      <PageActionsSlot>
        <button
          onClick={handleAiCreate}
          className="inline-flex items-center gap-1.5 px-4 py-[7px] rounded-full text-[13px] font-medium bg-transparent text-primary border border-primary/40 hover:border-primary/70 transition-all active:scale-[0.97]"
        >
          <Sparkles className="w-3.5 h-3.5" />
          {t('cron.aiCreate')}
        </button>
        <button
          onClick={handleAdd}
          className="inline-flex items-center gap-1.5 px-4 py-[7px] rounded-full text-[13px] font-medium bg-primary text-white shadow-sm hover:bg-primary/90 transition-all active:scale-[0.97]"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('cron.addTask')}
        </button>
      </PageActionsSlot>

      {/* Templates (shown when no tasks) */}
      {templates.length > 0 && cronTasks.length === 0 && (
        <div data-cron-motion-section className="shrink-0">
          <p className="text-xs text-muted-foreground mb-2">{t('cron.templates')}</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {templates.map((tpl) => {
              const TplIcon = getTemplateIcon(tpl.id);
              return (
                <button key={tpl.id} onClick={() => handleTemplateCreate(tpl)} className="glass-card glass-noise rounded-xl px-4 py-3 flex items-center gap-2.5 shrink-0 text-left hover:ring-1 hover:ring-primary/30 transition-all">
                  <TplIcon className="w-4 h-4 text-primary shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">{tpl.name}</p>
                    <p className="text-2xs text-muted-foreground truncate">{tpl.description}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Main timeline content */}
      {isLoadingCron ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="glass-card glass-noise rounded-xl p-5 animate-pulse">
              <div className="h-4 bg-foreground/[0.06] rounded w-2/3 mb-3" />
              <div className="h-3 bg-foreground/[0.06] rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : cronTasks.length === 0 ? (
        <CronEmptyState onAdd={handleAdd} onAi={handleAiCreate} />
      ) : (
        <div className="space-y-4">
          {/* Timeline bar — always full width */}
          <TimelineBar tasks={cronTasks} runs={cronRuns} onSelectRun={openRunDrawer} />

          {/* Responsive: stack below lg, tasks + recent side-by-side at lg+ */}
          <div
            className={cn(
              'grid gap-4 items-start',
              hasTaskColumn
                ? 'grid-cols-1 lg:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.95fr)] xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,0.9fr)] 2xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.85fr)]'
                : 'grid-cols-1',
            )}
          >
            {hasTaskColumn && (
              <div className="min-w-0 space-y-4">
                {upcomingTasks.length > 0 && (
                  <div data-cron-motion-section className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Zap className="w-3.5 h-3.5 text-primary" />
                      <h3 className="text-xs font-semibold text-foreground uppercase tracking-wide">{t('cron.upcoming')}</h3>
                      <span className="text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded-full tabular-nums">{upcomingTasks.length}</span>
                    </div>
                    <div className="space-y-1.5">
                      {upcomingTasks.map((task) => (
                        <TimelineTaskCard
                          key={task.id}
                          task={task}
                          runs={cronRuns[task.id] || []}
                          nextRun={nextRunTimes[task.id]}
                          expanded={expandedTaskId === task.id}
                          onToggleExpand={() => setExpandedTaskId(expandedTaskId === task.id ? null : task.id)}
                          onEdit={() => handleEdit(task)}
                          onDelete={() => setPendingDelete(task)}
                          onToggleEnabled={() => toggleCronTask(task.id)}
                          onRetry={() => handleRetry(task.id)}
                          onViewRun={(runId) => openRunDrawer(task.id, runId)}
                          onOpenSession={(run) => openRunSession(task, run)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {disabledTasks.length > 0 && (
                  <div data-cron-motion-section className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Timer className="w-3.5 h-3.5 text-muted-foreground" />
                      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t('cron.disabled')}</h3>
                      <span className="text-[10px] font-medium text-muted-foreground bg-muted-foreground/10 px-1.5 py-0.5 rounded-full tabular-nums">{disabledTasks.length}</span>
                    </div>
                    <div className="space-y-1.5">
                      {disabledTasks.map((task) => (
                        <TimelineTaskCard
                          key={task.id}
                          task={task}
                          runs={cronRuns[task.id] || []}
                          expanded={expandedTaskId === task.id}
                          onToggleExpand={() => setExpandedTaskId(expandedTaskId === task.id ? null : task.id)}
                          onEdit={() => handleEdit(task)}
                          onDelete={() => setPendingDelete(task)}
                          onToggleEnabled={() => toggleCronTask(task.id)}
                          onRetry={() => handleRetry(task.id)}
                          onViewRun={(runId) => openRunDrawer(task.id, runId)}
                          onOpenSession={(run) => openRunSession(task, run)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div
              data-cron-motion-section
              className={cn(
                'min-w-0 space-y-2',
                hasTaskColumn && 'lg:sticky lg:top-0 lg:max-h-[calc(100vh-7.5rem)] lg:overflow-y-auto lg:pr-0.5',
              )}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <History className="w-3.5 h-3.5 text-muted-foreground" />
                <h3 className="text-xs font-semibold text-foreground uppercase tracking-wide">{t('cron.recentRuns')}</h3>
                <span className="text-[10px] font-medium text-muted-foreground bg-muted-foreground/10 px-1.5 py-0.5 rounded-full tabular-nums">{recentCompletedRuns.length}</span>
                <div className="ml-auto flex items-center gap-1">
                  {([
                    ['today', 'cron.runsToday'],
                    ['7d', 'cron.runs7d'],
                    ['all', 'cron.runsAll'],
                  ] as const).map(([key, labelKey]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setRecentRange(key)}
                      className={cn(
                        'px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors',
                        recentRange === key
                          ? 'bg-primary/15 text-primary'
                          : 'text-muted-foreground hover:bg-foreground/[0.05]',
                      )}
                    >
                      {t(labelKey)}
                    </button>
                  ))}
                </div>
              </div>
              {recentCompletedRuns.length === 0 ? (
                <div className="glass-subtle glass-noise rounded-lg px-3 py-2.5 text-xs text-muted-foreground">
                  {t('cron.noRuns')}
                </div>
              ) : (
                <div className="space-y-1">
                  {recentCompletedRuns.map(({ task, run }) => {
                    const session = getCronRunSessionAvailability({
                      id: run.id,
                      runtimeId: run.runtimeId,
                      providerSessionId: run.providerSessionId,
                      workingDir: run.workingDir ?? task.workingDir,
                      status: run.status,
                    });
                    return (
                      <div
                        key={run.id}
                        data-cron-motion-run
                        data-cron-run-id={run.id}
                        className="group/run glass-subtle glass-noise rounded-lg px-2.5 py-1.5 flex items-center gap-1.5"
                      >
                        <StatusBadge status={run.status} />
                        <span className="text-xs font-medium text-foreground flex-1 min-w-0 truncate">{task.name}</span>
                        <span className="text-2xs text-muted-foreground tabular-nums shrink-0 hidden sm:inline">{formatTime(run.finishedAt || run.startedAt)}</span>
                        <span className="text-2xs text-muted-foreground tabular-nums shrink-0">{formatDuration(run.durationMs)}</span>
                        <button
                          type="button"
                          onClick={() => openRunSession(task, run)}
                          disabled={!session.canOpen}
                          className={cn(
                            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] shrink-0 transition-colors',
                            session.canOpen
                              ? 'text-primary hover:bg-primary/10'
                              : 'text-muted-foreground/50 cursor-not-allowed',
                          )}
                          aria-label={session.canOpen ? t('cron.openSession') : t('cron.openSessionUnavailable')}
                          title={session.canOpen ? t('cron.openSession') : t('cron.sessionUnavailable')}
                        >
                          <ExternalLink className="w-3 h-3" />
                          <span className="hidden xl:inline">
                            {session.canOpen ? t('cron.openSession') : t('cron.openSessionUnavailable')}
                          </span>
                        </button>
                        <button
                          onClick={() => openRunDrawer(task.id, run.id)}
                          className="p-1 rounded-md hover:bg-foreground/[0.06] shrink-0"
                          aria-label={t('cron.viewOutput')}
                        >
                          <Terminal className="w-3.5 h-3.5 text-muted-foreground" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Task Dialog */}
      <TaskDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onSave={handleSave} editTask={editingTask} environments={environments} />

      {/* Delete confirmation */}
      {pendingDelete && createPortal(
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setPendingDelete(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-dialog-title"
            className="relative rounded-2xl w-[calc(100%-2rem)] mx-auto max-w-sm overflow-hidden shadow-elevation-4 border border-[hsl(var(--glass-border-light)/0.25)]"
            style={{ background: 'hsl(var(--surface-overlay))' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative px-5 pt-5 pb-4">
              <div className="absolute inset-0 bg-gradient-to-br from-destructive/10 via-transparent to-transparent" />
              <div className="relative flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-destructive/15 flex items-center justify-center">
                  <Trash2 className="w-4 h-4 text-destructive" />
                </div>
                <h2 id="delete-dialog-title" className="text-sm font-semibold text-foreground">{t('common.delete')}</h2>
              </div>
            </div>
            <div className="px-5 pb-5 space-y-4">
              <p className="text-foreground text-sm">{t('cron.confirmDelete').replace('{name}', pendingDelete.name)}</p>
              <div className="flex justify-end gap-2.5 pt-1">
                <button className="px-4 py-[7px] text-[13px] font-medium rounded-full border border-black/[0.08] dark:border-white/[0.12] text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-all active:scale-[0.97]" onClick={() => setPendingDelete(null)}>{t('common.cancel')}</button>
                <button className="px-4 py-[7px] text-[13px] font-medium rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm transition-all active:scale-[0.97]" onClick={handleDelete}>{t('common.delete')}</button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Run Detail Drawer */}
      {(drawerRun || drawerLoading) && (
        <RunDetailDrawer
          run={drawerRun}
          task={drawerTask}
          loading={drawerLoading}
          onClose={() => { setDrawerRun(null); setDrawerTask(null); setDrawerLoading(false); }}
          onOpenSession={(run) => openRunSession(drawerTask, run)}
          t={t}
        />
      )}
    </div>
  );
}

// --- Run Detail Drawer ---

function RunDetailDrawer({ run, task, loading, onClose, onOpenSession, t }: {
  run: CronTaskRun | null;
  task: CronTask | null;
  loading: boolean;
  onClose: () => void;
  onOpenSession: (run: CronTaskRun) => void;
  t: (key: string) => string;
}) {
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleCopy = useCallback((text: string, field: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    });
  }, []);

  const session = run
    ? getCronRunSessionAvailability({
      id: run.id,
      runtimeId: run.runtimeId,
      providerSessionId: run.providerSessionId,
      workingDir: run.workingDir ?? task?.workingDir,
      status: run.status,
    })
    : null;

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[130] bg-black/30 backdrop-blur-[2px] transition-opacity"
        onClick={onClose}
      />
      {/* Drawer panel */}
      <div className="fixed inset-y-0 right-0 z-[130] w-full max-w-full sm:max-w-md md:max-w-lg lg:max-w-xl xl:max-w-2xl 2xl:max-w-3xl 3xl:max-w-4xl flex flex-col shadow-elevation-4 border-l border-[hsl(var(--glass-border-light)/0.2)] animate-in slide-in-from-right duration-200"
        style={{ background: 'hsl(var(--surface-overlay))' }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[hsl(var(--glass-border-light)/0.15)]">
          <Terminal className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground flex-1">{t('cron.runDetail')}</h2>
          {run && <StatusBadge status={run.status} />}
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-foreground/[0.06] transition-colors"
            aria-label={t('common.cancel')}
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading && (
            <div className="space-y-3">
              <div className="h-4 w-32 rounded bg-foreground/[0.06] animate-pulse" />
              <div className="h-32 rounded-lg bg-foreground/[0.06] animate-pulse" />
            </div>
          )}

          {run && !loading && (
            <>
              {/* Meta info */}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {task?.name && <span className="font-medium text-foreground/80">{task.name}</span>}
                <span>{formatTime(run.startedAt)}</span>
                <span>{formatDuration(run.durationMs)}</span>
                {run.exitCode !== null && run.exitCode !== undefined && (
                  <span>{t('cron.exitCode')}: {run.exitCode}</span>
                )}
              </div>

              {/* Session CTA */}
              <div className="rounded-xl border border-[hsl(var(--glass-border-light)/0.18)] bg-foreground/[0.03] px-3 py-3 space-y-2">
                <p className="text-[11px] text-muted-foreground">
                  {session?.reason === 'live'
                    ? t('cron.sessionAvailableLive')
                    : session?.reason === 'history'
                      ? t('cron.sessionAvailableHistory')
                      : t('cron.sessionUnavailable')}
                </p>
                <button
                  type="button"
                  onClick={() => onOpenSession(run)}
                  disabled={!session?.canOpen}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-3 py-[7px] rounded-full text-[12px] font-medium transition-all active:scale-[0.97]',
                    session?.canOpen
                      ? 'bg-primary text-white hover:bg-primary/90'
                      : 'bg-foreground/[0.06] text-muted-foreground cursor-not-allowed',
                  )}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  {session?.canOpen ? t('cron.openSession') : t('cron.openSessionUnavailable')}
                </button>
              </div>

              {/* Stdout */}
              <OutputBlock
                label={t('cron.stdout')}
                content={run.stdout || ''}
                emptyText={t('cron.noOutput')}
                copied={copiedField === 'stdout'}
                onCopy={() => handleCopy(run.stdout || '', 'stdout')}
                t={t}
              />

              {/* Stderr */}
              {run.stderr && (
                <OutputBlock
                  label={t('cron.stderr')}
                  content={run.stderr}
                  emptyText={t('cron.noOutput')}
                  copied={copiedField === 'stderr'}
                  onCopy={() => handleCopy(run.stderr || '', 'stderr')}
                  t={t}
                  isError
                />
              )}
            </>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

function OutputBlock({ label, content, emptyText, copied, onCopy, t, isError }: {
  label: string;
  content: string;
  emptyText: string;
  copied: boolean;
  onCopy: () => void;
  t: (key: string) => string;
  isError?: boolean;
}) {
  if (!content) {
    return (
      <div className="space-y-1.5">
        <span className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">{label}</span>
        <p className="text-xs text-muted-foreground/50 italic">{emptyText}</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">{label}</span>
        <button
          onClick={onCopy}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded"
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? t('cron.copied') : t('cron.copyOutput')}
        </button>
      </div>
      <pre className={cn(
        'text-xs leading-relaxed p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-words font-mono max-h-[50vh]',
        isError
          ? 'bg-destructive/[0.06] text-destructive border border-destructive/10'
          : 'bg-foreground/[0.04] text-foreground border border-[hsl(var(--glass-border-light)/0.1)]'
      )}>
        {content}
      </pre>
    </div>
  );
}
