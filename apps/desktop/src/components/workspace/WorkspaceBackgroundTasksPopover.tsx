import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Bot,
  Clock,
  FileText,
  LoaderCircle,
  Square,
  Terminal,
  Workflow,
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
}

const STATUS_CLASS: Record<NativeBackgroundTaskStatus, string> = {
  pending: 'bg-muted-foreground',
  running: 'bg-sky-500',
  paused: 'bg-amber-500',
  stopping: 'bg-amber-500',
  settling: 'bg-violet-500',
  completed: 'bg-emerald-500',
  failed: 'bg-destructive',
  stopped: 'bg-muted-foreground',
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
  if (task.subagent_type) return <Bot className="h-3.5 w-3.5" />;
  if (task.workflow_name) return <Workflow className="h-3.5 w-3.5" />;
  return <Terminal className="h-3.5 w-3.5" />;
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

  return (
    <div
      data-ccem-background-task={task.task_id}
      data-task-status={task.status}
      className="rounded-xl border border-[hsl(var(--glass-border-light)/0.14)] bg-surface-raised/45 px-3 py-2.5"
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 rounded-lg bg-muted/55 p-1.5 text-muted-foreground">
          <TaskTypeIcon task={task} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[12px] font-semibold text-foreground">
              {task.description}
            </span>
            <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_CLASS[task.status])} />
              {t(`workspace.backgroundTaskStatus.${task.status}`)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-muted-foreground">
            <span>{taskTypeLabel(task)}</span>
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDuration(durationMs)}
            </span>
            {task.usage?.total_tokens ? (
              <span>{task.usage.total_tokens.toLocaleString()} tokens</span>
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
              'mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground',
              task.error && 'text-destructive',
            )}>
              {progress}
            </p>
          ) : null}
          {task.output_file ? (
            <div className="mt-1.5 flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
              <FileText className="h-3 w-3 shrink-0" />
              <span className="truncate" title={task.output_file}>{task.output_file}</span>
            </div>
          ) : null}
        </div>
        {onRequestStop && canStopBackgroundTask(task) ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0 rounded-full text-muted-foreground hover:text-destructive"
            aria-label={t('workspace.backgroundTaskStop')}
            onClick={() => onRequestStop(task)}
          >
            <Square className="h-3 w-3 fill-current" />
          </Button>
        ) : isStopping ? (
          <LoaderCircle className="mt-1 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
      </div>
    </div>
  );
}

export function WorkspaceBackgroundTasksPopover({
  activeTasks,
  recentTasks,
  onStopTask,
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

  const title = useMemo(
    () => activeTasks.length > 0
      ? t('workspace.backgroundTasksActiveCount').replace('{count}', String(activeTasks.length))
      : t('workspace.backgroundTasks'),
    [activeTasks.length, t],
  );

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

  return (
    <>
      <Popover modal={false} open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            data-native-attention-card
            data-ccem-background-tasks-trigger
            data-ccem-background-tasks-attention
            className={cn(
              'h-auto w-full justify-start gap-2.5 rounded-xl bg-muted/35 px-3 py-2.5 text-left transition-colors hover:bg-muted/50',
              open && 'bg-primary/10',
            )}
            aria-label={title}
            aria-expanded={open}
          >
            <span className="rounded-md bg-muted/60 p-1.5 text-muted-foreground">
              <Activity className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold leading-snug text-foreground">
                {t('workspace.backgroundTasks')}
              </span>
              <span className="mt-0.5 block truncate text-[11px] font-normal text-muted-foreground">
                {activeTasks.length > 0
                  ? title
                  : `${t('workspace.backgroundTasksRecent')} · ${recentTasks.length}`}
              </span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-normal text-muted-foreground">
              <span className={cn(
                'h-1.5 w-1.5 rounded-full',
                activeTasks.length > 0 ? 'bg-sky-500' : 'bg-emerald-500',
              )} />
              {activeTasks.length > 0
                ? t('workspace.backgroundTasksRunning')
                : t('workspace.backgroundTasksRecent')}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          data-ccem-background-tasks-popover
          align="end"
          side="top"
          sideOffset={8}
          className="frosted-panel glass-noise w-[min(420px,calc(100vw-24px))] border-none p-0"
        >
          <div className="border-b border-[hsl(var(--glass-border-light)/0.14)] px-4 py-3">
            <h3 className="text-sm font-semibold text-foreground">{t('workspace.backgroundTasks')}</h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {t('workspace.backgroundTasksHint')}
            </p>
          </div>
          <div className="max-h-[min(520px,70vh)] space-y-4 overflow-y-auto p-3">
            <section>
              <div className="mb-2 flex items-center justify-between px-1">
                <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('workspace.backgroundTasksRunning')}
                </h4>
                <span className="text-[10px] text-muted-foreground">{activeTasks.length}</span>
              </div>
              <div className="space-y-2">
                {activeTasks.length > 0 ? activeTasks.map((task) => (
                  <BackgroundTaskRow
                    key={task.task_id}
                    task={task}
                    now={now}
                    onRequestStop={setStopTarget}
                  />
                )) : (
                  <p className="rounded-xl bg-surface-raised/35 px-3 py-4 text-center text-[11px] text-muted-foreground">
                    {t('workspace.backgroundTasksNone')}
                  </p>
                )}
              </div>
            </section>
            {recentTasks.length > 0 ? (
              <section>
                <div className="mb-2 flex items-center justify-between px-1">
                  <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('workspace.backgroundTasksRecent')}
                  </h4>
                  <span className="text-[10px] text-muted-foreground">{recentTasks.length}</span>
                </div>
                <div className="space-y-2">
                  {recentTasks.map((task) => (
                    <BackgroundTaskRow key={task.task_id} task={task} now={now} />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
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
          className="frosted-panel glass-noise max-w-[420px] border-none p-5"
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
