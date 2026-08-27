import { useEffect, useState } from 'react';
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileText,
  LoaderCircle,
  Square,
  Terminal,
  Workflow,
  X,
} from '@/lib/lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useLocale } from '@/locales';
import type { NativeBackgroundTask, NativeBackgroundTaskStatus } from '@/lib/tauri-ipc';
import { cn } from '@/lib/utils';
import {
  backgroundTaskDurationMs,
  canStopBackgroundTask,
} from './workspaceBackgroundTasks';

interface WorkspaceBackgroundTasksPopoverProps {
  activeTasks: NativeBackgroundTask[];
  recentTasks: NativeBackgroundTask[];
  onStopTask: (taskId: string) => Promise<void>;
  onDismiss?: () => void;
}

const STATUS_CLASS: Record<NativeBackgroundTaskStatus, string> = {
  pending: 'bg-muted-foreground/55',
  running: 'bg-info',
  paused: 'bg-warning',
  stopping: 'bg-warning',
  settling: 'bg-primary/75',
  completed: 'bg-success',
  failed: 'bg-destructive',
  stopped: 'bg-muted-foreground/55',
  interrupted: 'bg-destructive',
};

function formatDuration(durationMs: number) {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function taskTypeLabel(task: NativeBackgroundTask) {
  if (task.subagent_type) return `Agent · ${task.subagent_type}`;
  if (task.workflow_name) return `Workflow · ${task.workflow_name}`;
  return task.task_type || 'Bash';
}

function TaskTypeIcon({ task }: { task: NativeBackgroundTask }) {
  if (task.subagent_type) return <Bot className="h-3 w-3" />;
  if (task.workflow_name) return <Workflow className="h-3 w-3" />;
  return <Terminal className="h-3 w-3" />;
}

function BackgroundTaskRow({
  task,
  now,
  onRequestStop,
}: {
  task: NativeBackgroundTask;
  now: number;
  onRequestStop?: (task: NativeBackgroundTask) => void;
}) {
  const { t } = useLocale();
  const durationMs = backgroundTaskDurationMs(task, now);
  const progress = task.terminal_summary
    || task.error
    || task.progress_summary
    || (task.last_tool_name
      ? t('workspace.backgroundTaskLastTool').replace('{tool}', task.last_tool_name)
      : null);
  const isStopping = task.status === 'stopping';
  const isRunning = task.status === 'running';

  return (
    <div
      data-ccem-background-task={task.task_id}
      data-task-status={task.status}
      className={cn(
        'group/row flex items-start gap-2.5 px-2.5 py-2 transition-colors hover:bg-surface-raised/55',
        isRunning && 'bg-info/[0.045]',
      )}
    >
      <span className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', STATUS_CLASS[task.status])} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="min-w-0 truncate text-[12px] font-medium leading-[1.45] text-foreground">
            {task.description}
          </p>
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
            {t(`workspace.backgroundTaskStatus.${task.status}`)}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <TaskTypeIcon task={task} />
            {taskTypeLabel(task)}
          </span>
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Clock className="h-3 w-3" />
            {formatDuration(durationMs)}
          </span>
          {task.usage?.total_tokens ? (
            <span className="tabular-nums">{task.usage.total_tokens.toLocaleString()} tokens</span>
          ) : null}
          {task.usage?.tool_uses ? (
            <span>
              {t('workspace.backgroundTaskToolUses')
                .replace('{count}', String(task.usage.tool_uses))}
            </span>
          ) : null}
        </div>
        {progress ? (
          <p className={cn(
            'mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground',
            task.error && 'text-destructive',
          )}>
            {progress}
          </p>
        ) : null}
        {task.output_file ? (
          <div className="mt-1 flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground/70">
            <FileText className="h-3 w-3 shrink-0" />
            <span className="truncate font-mono" title={task.output_file}>{task.output_file}</span>
          </div>
        ) : null}
      </div>
      {onRequestStop && canStopBackgroundTask(task) ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="mt-0.5 h-6 w-6 shrink-0 rounded-full text-muted-foreground opacity-55 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100"
          aria-label={t('workspace.backgroundTaskStop')}
          onClick={() => onRequestStop(task)}
        >
          <Square className="h-2.5 w-2.5 fill-current" />
        </Button>
      ) : isStopping ? (
        <LoaderCircle className="mt-1.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : null}
    </div>
  );
}

function TaskSection({
  title,
  tone,
  count,
  children,
}: {
  title: string;
  tone: 'running' | 'recent';
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5" aria-label={title}>
      <div className="flex items-center gap-2 px-0.5">
        <span className={cn(
          'h-2 w-2 rounded-full border',
          tone === 'running' && 'border-info bg-info/15',
          tone === 'recent' && 'border-muted-foreground/50',
        )} />
        <h4 className="text-[11px] font-semibold text-foreground/85">{title}</h4>
        <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground">{count}</span>
      </div>
      <div className="divide-y divide-border-subtle/45 overflow-hidden rounded-lg border border-border-subtle/55 bg-surface-raised/25">
        {children}
      </div>
    </section>
  );
}

export function WorkspaceBackgroundTasksPopover({
  activeTasks,
  recentTasks,
  onStopTask,
  onDismiss,
}: WorkspaceBackgroundTasksPopoverProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [stopTarget, setStopTarget] = useState<NativeBackgroundTask | null>(null);
  const [isStopping, setIsStopping] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open || activeTasks.length === 0) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activeTasks.length, open]);

  const stopTargetId = stopTarget?.task_id ?? null;
  useEffect(() => {
    if (!stopTargetId || isStopping) return;
    const current = activeTasks.find((task) => task.task_id === stopTargetId);
    if (!current || !canStopBackgroundTask(current)) {
      setStopTarget(null);
      return;
    }
    setStopTarget(current);
  }, [activeTasks, isStopping, stopTargetId]);

  const hasActive = activeTasks.length > 0;
  const summary = hasActive
    ? t('workspace.backgroundTasksActiveCount').replace('{count}', String(activeTasks.length))
    : `${t('workspace.backgroundTasksRecent')} · ${recentTasks.length}`;

  const confirmStop = async () => {
    if (!stopTarget || !canStopBackgroundTask(stopTarget) || isStopping) return;
    setIsStopping(true);
    try {
      await onStopTask(stopTarget.task_id);
      setStopTarget(null);
    } catch (error) {
      toast.error(
        t('workspace.backgroundTaskStopFailed').replace('{error}', String(error)),
      );
    } finally {
      setIsStopping(false);
    }
  };

  const showDismiss = !hasActive && Boolean(onDismiss);

  return (
    <>
      <Popover modal={false} open={open} onOpenChange={setOpen}>
        <div className="relative w-full">
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              data-native-attention-card
              data-ccem-background-tasks-trigger
              data-ccem-background-tasks-attention
              className={cn(
                'h-7 w-full justify-between gap-2 rounded-lg bg-surface-raised/60 px-2 text-left backdrop-blur-sm transition-colors hover:bg-surface-raised/85',
                open && 'bg-surface-overlay',
                showDismiss && 'pr-8',
              )}
              aria-label={`${t('workspace.backgroundTasks')} · ${summary}`}
              aria-expanded={open}
            >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded',
                hasActive ? 'bg-info/15 text-info' : 'bg-muted/60 text-muted-foreground',
              )}>
                <Activity className="h-3 w-3" />
              </span>
              <span className="shrink-0 text-[12px] font-semibold text-foreground">
                {t('workspace.backgroundTasks')}
              </span>
              <span className="min-w-0 truncate text-[11px] font-normal text-muted-foreground">
                {summary}
              </span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <span className={cn('h-1.5 w-1.5 rounded-full', hasActive ? 'bg-info' : 'bg-success')} />
              <ChevronDown
                className={cn('h-3 w-3 text-muted-foreground/60 transition-transform duration-200', open && 'rotate-180')}
              />
            </span>
            </Button>
          </PopoverTrigger>
          {showDismiss ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              data-ccem-background-tasks-dismiss
              className="absolute right-1 top-1 h-5 w-5 rounded-full text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground"
              aria-label={t('workspace.backgroundTasksDismiss')}
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
                onDismiss?.();
              }}
            >
              <X className="h-3 w-3" />
            </Button>
          ) : null}
        </div>
        <PopoverContent
          data-ccem-background-tasks-popover
          role="dialog"
          align="end"
          side="top"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(event) => event.preventDefault()}
          style={{
            width: 'min(420px, calc(100vw - 24px))',
            maxHeight: 'min(70vh, 560px)',
          }}
          className="frosted-panel glass-noise z-[80] flex flex-col overflow-hidden rounded-2xl border border-[hsl(var(--glass-border-light))]/55 bg-popover/95 p-0 shadow-2xl backdrop-blur-xl"
        >
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle/55 px-3">
            <span className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-raised/70',
              hasActive ? 'text-info' : 'text-success',
            )}>
              {hasActive ? (
                <Activity className="h-4 w-4" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[13px] font-semibold text-foreground">
                {t('workspace.backgroundTasks')}
              </h3>
              <p className="truncate text-[10px] text-muted-foreground">{summary}</p>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0 rounded-full text-muted-foreground"
              aria-label={t('workspace.reviewClose')}
              onClick={() => setOpen(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </header>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-3 px-3.5 py-3">
              <TaskSection
                title={t('workspace.backgroundTasksRunning')}
                tone="running"
                count={activeTasks.length}
              >
                {activeTasks.length > 0 ? activeTasks.map((task) => (
                  <BackgroundTaskRow
                    key={task.task_id}
                    task={task}
                    now={now}
                    onRequestStop={setStopTarget}
                  />
                )) : (
                  <p className="px-2.5 py-4 text-center text-[11px] text-muted-foreground">
                    {t('workspace.backgroundTasksNone')}
                  </p>
                )}
              </TaskSection>
              {recentTasks.length > 0 ? (
                <TaskSection
                  title={t('workspace.backgroundTasksRecent')}
                  tone="recent"
                  count={recentTasks.length}
                >
                  {recentTasks.map((task) => (
                    <BackgroundTaskRow key={task.task_id} task={task} now={now} />
                  ))}
                </TaskSection>
              ) : null}
            </div>
          </ScrollArea>

          <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-border-subtle/50 px-3 text-[9px] text-muted-foreground">
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', hasActive ? 'bg-info' : 'bg-success')} />
            <span className="min-w-0 truncate">{t('workspace.backgroundTasksHint')}</span>
          </footer>
        </PopoverContent>
      </Popover>

      <Dialog
        open={Boolean(stopTarget)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !isStopping) setStopTarget(null);
        }}
      >
        <DialogContent
          data-ccem-background-task-stop-dialog
          className="frosted-panel glass-noise max-w-[420px] rounded-2xl border-none p-5"
        >
          <DialogHeader>
            <DialogTitle>{t('workspace.backgroundTaskStopConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('workspace.backgroundTaskStopConfirmBody')}
            </DialogDescription>
          </DialogHeader>
          {stopTarget ? (
            <div className="rounded-lg bg-surface-raised/50 px-3 py-2 text-xs text-foreground">
              {stopTarget.description}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="glass-btn-outline"
              disabled={isStopping}
              onClick={() => setStopTarget(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="gap-2"
              disabled={!stopTarget || !canStopBackgroundTask(stopTarget) || isStopping}
              onClick={() => void confirmStop()}
            >
              {isStopping ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5 fill-current" />}
              {t('workspace.backgroundTaskStop')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
