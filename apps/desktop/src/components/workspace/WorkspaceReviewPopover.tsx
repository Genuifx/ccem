import { useCallback, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleAlert,
  FileDiff,
  LoaderCircle,
  PackageCheck,
  RefreshCw,
  X,
} from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useLocale } from '@/locales';
import type {
  NativeSessionSummary,
  WorkspaceFileDiff,
  WorkspaceGitSnapshot,
  WorkspaceMediaPreview,
} from '@/lib/tauri-ipc';
import { cn, getEnvColorVar } from '@/lib/utils';
import type { SessionSubagentsPayload } from '@/features/conversations/types';
import type { ReviewTodoItem, WorkspaceReviewModel } from './workspaceReview';
import {
  WorkspaceReviewDetails,
  type WorkspaceReviewDetailPage,
} from './WorkspaceReviewDetails';
import {
  WORKSPACE_REVIEW_POPOVER_ID,
  workspaceReviewTriggerRef,
} from './workspaceReviewAnchor';

interface WorkspaceReviewPopoverProps {
  session: NativeSessionSummary;
  model: WorkspaceReviewModel;
  gitSnapshot?: WorkspaceGitSnapshot | null;
  isOpen: boolean;
  isRefreshingGit: boolean;
  onOpenChange: (open: boolean) => void;
  onRefreshGit: () => void;
  onLoadDiff: (filePath: string) => Promise<WorkspaceFileDiff>;
  onLoadMediaPreview?: (filePath: string) => Promise<WorkspaceMediaPreview>;
  onLoadSubagents?: (detailAgentId: string | null) => Promise<SessionSubagentsPayload>;
  isLive?: boolean;
}

type ReviewPage = 'main' | WorkspaceReviewDetailPage;
type TaskTone = 'completed' | 'current' | 'failed' | 'next';

function interpolate(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{${key}}`, String(value)),
    template,
  );
}

function TaskStatusIcon({ todo, tone }: { todo: ReviewTodoItem; tone: TaskTone }) {
  if (todo.status === 'failed') {
    return <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />;
  }
  if (tone === 'completed') {
    return (
      <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-success text-success-foreground">
        <Check className="h-2.5 w-2.5" />
      </span>
    );
  }
  if (tone === 'current') {
    return <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 fill-primary/10 text-primary" />;
  }
  return <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/55" />;
}

function TaskGroup({
  title,
  tone,
  todos,
  currentId,
  ordinalById,
}: {
  title: string;
  tone: TaskTone;
  todos: ReviewTodoItem[];
  currentId: string | null;
  ordinalById: Map<string, number>;
}) {
  if (todos.length === 0) return null;
  return (
    <section className="space-y-1.5" aria-label={title}>
      <div className="flex items-center gap-2 px-0.5">
        <span className={cn(
          'h-2 w-2 rounded-full border',
          tone === 'completed' && 'border-success bg-success/15',
          tone === 'current' && 'border-primary bg-primary/10',
          tone === 'failed' && 'border-destructive bg-destructive/10',
          tone === 'next' && 'border-muted-foreground/50',
        )} />
        <h3 className="text-[11px] font-semibold text-foreground/85">{title}</h3>
      </div>
      <ol className="overflow-hidden rounded-lg border border-border-subtle/55 bg-surface-raised/25">
        {todos.map((todo, index) => {
          const isCurrent = todo.id === currentId;
          return (
            <li
              key={todo.id}
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                'flex items-start gap-2.5 px-2.5 py-2',
                index > 0 && 'border-t border-border-subtle/45',
                tone === 'current' && 'bg-primary/[0.055]',
                tone === 'failed' && 'bg-destructive/[0.045]',
              )}
            >
              <TaskStatusIcon todo={todo} tone={tone} />
              <div className="min-w-0 flex-1">
                <p className={cn(
                  'text-[12px] leading-[1.45] text-foreground',
                  tone === 'completed' && 'text-muted-foreground',
                  todo.status === 'failed' && 'text-destructive',
                )}>
                  {todo.text}
                </p>
                {isCurrent && (todo.activeText || todo.sourceLabel) ? (
                  <div className="mt-1.5 space-y-1 rounded-md border border-primary/15 bg-background/45 px-2 py-1.5">
                    {todo.activeText ? (
                      <p className="text-[11px] leading-snug text-muted-foreground">{todo.activeText}</p>
                    ) : null}
                    {todo.sourceLabel ? (
                      <p className="truncate font-mono text-[9px] text-muted-foreground/65">{todo.sourceLabel}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <span className="shrink-0 pt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground/50">
                {ordinalById.get(todo.id) ?? index + 1}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function EvidenceRow({
  icon: Icon,
  label,
  count,
  tone,
  onClick,
}: {
  icon: typeof FileDiff;
  label: string;
  count?: number;
  tone?: 'danger';
  onClick?: () => void;
}) {
  const content = (
    <>
      <Icon className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', tone === 'danger' && 'text-destructive')} />
      <span className={cn('min-w-0 flex-1 truncate text-xs', tone === 'danger' && count && count > 0 && 'text-destructive')}>
        {label}
      </span>
      {typeof count === 'number' ? (
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{count}</span>
      ) : null}
      {onClick ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/45" /> : null}
    </>
  );
  if (!onClick) {
    return <div className="flex h-8 items-center gap-2 px-2.5">{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex h-8 w-full items-center gap-2 px-2.5 text-left transition-colors hover:bg-surface-raised/55"
    >
      {content}
    </button>
  );
}

export function WorkspaceReviewPopover({
  session,
  model,
  gitSnapshot,
  isOpen,
  isRefreshingGit,
  onOpenChange,
  onRefreshGit,
  onLoadDiff,
  onLoadMediaPreview,
  onLoadSubagents,
  isLive,
}: WorkspaceReviewPopoverProps) {
  const { t } = useLocale();
  const [page, setPage] = useState<ReviewPage>('main');
  const envColor = getEnvColorVar(session.env_name);

  const completedTodos = useMemo(
    () => model.todos.filter((todo) => todo.status === 'completed'),
    [model.todos],
  );
  const inProgressTodos = useMemo(
    () => model.todos.filter((todo) => todo.status === 'in_progress'),
    [model.todos],
  );
  const failedTodos = useMemo(
    () => model.todos.filter((todo) => todo.status === 'failed'),
    [model.todos],
  );
  const pendingTodos = useMemo(
    () => model.todos.filter((todo) => todo.status === 'pending'),
    [model.todos],
  );
  const ordinalById = useMemo(
    () => new Map(model.todos.map((todo, index) => [todo.id, index + 1])),
    [model.todos],
  );
  const currentId = inProgressTodos[0]?.id ?? null;
  const progressPercent = model.todoTotal > 0
    ? Math.round((model.todoCompleted / model.todoTotal) * 100)
    : 0;

  const focusTrigger = useCallback(() => {
    window.requestAnimationFrame(() => workspaceReviewTriggerRef.current?.focus());
  }, []);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setPage('main');
    }
  }, [onOpenChange]);

  const handleInteractOutside = useCallback((event: { preventDefault: () => void }) => {
    event.preventDefault();
  }, []);

  const branchLabel = gitSnapshot?.is_repo
    ? `${gitSnapshot.branch || '—'}${gitSnapshot.sha ? ` · ${gitSnapshot.sha.slice(0, 7)}` : ''}`
    : '—';
  const detailPage = page === 'files' || page === 'agents' ? page : null;
  const width = detailPage ? 'min(820px, calc(100vw - 24px))' : 'min(400px, calc(100vw - 24px))';
  const sessionIsActive = ['initializing', 'processing', 'running'].includes(session.status);
  const sessionHasFailed = ['error', 'failed', 'interrupted'].includes(session.status);
  const hasTodoProgress = model.todoSource !== 'unavailable' && model.todoTotal > 0;
  const progressTemplate = sessionIsActive
    ? t('workspace.reviewProgressActive')
    : sessionHasFailed
      ? t('workspace.reviewProgressFailed')
      : t('workspace.reviewProgress');

  return (
    <Popover modal={false} open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverAnchor virtualRef={workspaceReviewTriggerRef} />
      <PopoverContent
        id={WORKSPACE_REVIEW_POPOVER_ID}
        role="dialog"
        aria-labelledby={`${WORKSPACE_REVIEW_POPOVER_ID}-title`}
        side="bottom"
        align="end"
        sideOffset={10}
        collisionPadding={12}
        data-ccem-workspace-review-popover
        onInteractOutside={handleInteractOutside}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusTrigger();
        }}
        style={{
          width,
          maxHeight: 'min(70vh, 560px)',
          ...(detailPage ? { height: 'min(70vh, 560px)' } : {}),
        }}
        className={cn(
          'frosted-panel glass-noise z-[80] flex overflow-hidden rounded-2xl border border-[hsl(var(--glass-border-light))]/55 bg-popover/95 p-0 shadow-2xl backdrop-blur-xl',
          'transition-[width] duration-200 ease-out',
        )}
      >
        <div className="flex min-h-0 w-full flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle/55 px-3">
            {detailPage ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0 rounded-full"
                aria-label={t('workspace.reviewBack')}
                onClick={() => setPage('main')}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            ) : (
              <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-raised/70">
                {sessionIsActive ? (
                  <LoaderCircle className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : sessionHasFailed ? (
                  <CircleAlert className="h-4 w-4 text-destructive" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-success" />
                )}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <h2 id={`${WORKSPACE_REVIEW_POPOVER_ID}-title`} className="truncate text-[13px] font-semibold text-foreground">
                {detailPage === 'files'
                  ? t('workspace.reviewChangedFiles')
                  : detailPage === 'agents'
                    ? t('workspace.reviewSubagents')
                    : t('workspace.reviewTitle')}
              </h2>
              <p className="truncate text-[10px] text-muted-foreground">
                {detailPage === 'files'
                  ? interpolate(t('workspace.reviewFilesCount'), { count: model.changedFiles.length })
                  : detailPage === 'agents'
                    ? session.env_name
                    : `${session.env_name} · ${session.provider}`}
              </p>
            </div>
            {!detailPage ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0 rounded-full text-muted-foreground"
                aria-label={t('workspace.reviewRefresh')}
                disabled={isRefreshingGit}
                onClick={onRefreshGit}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', isRefreshingGit && 'animate-spin')} />
              </Button>
            ) : null}
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0 rounded-full text-muted-foreground"
              aria-label={t('workspace.reviewClose')}
              onClick={() => handleOpenChange(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </header>

          {detailPage ? (
            <WorkspaceReviewDetails
              page={detailPage}
              session={session}
              model={model}
              onLoadDiff={onLoadDiff}
              onLoadMediaPreview={onLoadMediaPreview}
              onLoadSubagents={onLoadSubagents}
              isLive={isLive}
            />
          ) : (
            <>
              <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-3 px-3.5 py-3">
                  <section className="space-y-1.5 border-b border-border-subtle/45 pb-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[11px] font-medium text-foreground">
                        {model.todoSource === 'unavailable'
                          ? t('workspace.reviewTodoUnavailableTitle')
                          : model.todoTotal === 0
                            ? t('workspace.reviewTodoStructuredEmptyTitle')
                            : interpolate(progressTemplate, {
                              completed: model.todoCompleted,
                              total: model.todoTotal,
                            })}
                      </p>
                      {hasTodoProgress ? (
                        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{progressPercent}%</span>
                      ) : null}
                    </div>
                    {hasTodoProgress ? (
                      <div
                        role="progressbar"
                        aria-label={t('workspace.reviewProgressLabel')}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progressPercent}
                        className="h-1 overflow-hidden rounded-full bg-muted"
                      >
                        <div
                          className="h-full rounded-full bg-primary transition-[width] duration-300"
                          style={{ width: `${progressPercent}%` }}
                        />
                      </div>
                    ) : null}
                    <p className="text-[10px] text-muted-foreground">
                      {model.todoSource === 'unavailable'
                        ? t('workspace.reviewTodoUnavailableBody')
                        : model.todoSource === 'structured' && model.todoTotal === 0
                          ? t('workspace.reviewTodoStructuredEmpty')
                          : t('workspace.reviewTodoHint')}
                    </p>
                  </section>

                  {model.todoSource === 'legacy' ? (
                    <div className="flex items-start gap-2 rounded-lg border border-warning/35 bg-warning/5 px-2.5 py-2 text-[10px] leading-snug text-warning">
                      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{t('workspace.reviewTodoLegacyWarning')}</span>
                    </div>
                  ) : null}

                  {model.todoSource !== 'unavailable' && model.todos.length > 0 ? (
                    <div className="space-y-3">
                      <TaskGroup title={t('workspace.reviewCompleted')} tone="completed" todos={completedTodos} currentId={currentId} ordinalById={ordinalById} />
                      <TaskGroup title={t('workspace.reviewInProgress')} tone="current" todos={inProgressTodos} currentId={currentId} ordinalById={ordinalById} />
                      <TaskGroup title={t('workspace.reviewNeedsAttention')} tone="failed" todos={failedTodos} currentId={currentId} ordinalById={ordinalById} />
                      <TaskGroup title={t('workspace.reviewNext')} tone="next" todos={pendingTodos} currentId={currentId} ordinalById={ordinalById} />
                    </div>
                  ) : null}

                  <details className="group space-y-1.5 pt-0.5" open>
                    <summary className="flex cursor-pointer list-none items-center gap-1 px-0.5 text-[11px] font-semibold text-foreground/85 [&::-webkit-details-marker]:hidden">
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/55 transition-transform group-open:rotate-90" />
                      {t('workspace.reviewEvidence')}
                    </summary>
                    <div className="overflow-hidden rounded-lg border border-border-subtle/55 bg-surface-raised/25 divide-y divide-border-subtle/45">
                      <EvidenceRow
                        icon={FileDiff}
                        label={t('workspace.reviewChangedFiles')}
                        count={model.changedFiles.length}
                        onClick={() => setPage('files')}
                      />
                      <EvidenceRow icon={PackageCheck} label={t('workspace.reviewArtifacts')} count={model.artifacts.length} />
                      <EvidenceRow
                        icon={CircleAlert}
                        label={t('workspace.reviewFailedTools')}
                        count={model.failedTools.length}
                        tone="danger"
                      />
                      {onLoadSubagents ? (
                        <EvidenceRow icon={Bot} label={t('workspace.reviewSubagents')} onClick={() => setPage('agents')} />
                      ) : null}
                    </div>
                  </details>
                </div>
              </ScrollArea>

              <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-border-subtle/50 px-3 text-[9px] text-muted-foreground">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: `hsl(${envColor})` }} />
                <span className="min-w-0 truncate">{t('workspace.reviewEnvironment')} · {session.env_name}</span>
                <span className="ml-auto shrink-0 font-mono">{t('workspace.reviewBranch')} · {branchLabel}</span>
              </footer>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
