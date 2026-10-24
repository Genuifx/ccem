import { memo } from 'react';
import { Check, Circle, CircleAlert, ListChecks } from '@/lib/lucide-react';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import type { WorkspaceTodoItem, WorkspaceTodos } from './workspaceTodos';

/**
 * Hide a finished list once the turn is idle: it is history, not progress.
 * While a turn runs, or while anything is left, it stays at the tail.
 */
export function shouldShowWorkspaceTodoList(
  todos: WorkspaceTodos | null | undefined,
  isRunning: boolean,
): todos is WorkspaceTodos {
  if (!todos || todos.items.length === 0) return false;
  return isRunning || todos.completed < todos.total;
}

function TodoIcon({ status }: { status: WorkspaceTodoItem['status'] }) {
  if (status === 'completed') {
    return (
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-muted-foreground/25">
        <Check className="h-2.5 w-2.5 text-muted-foreground" />
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span className="relative flex h-3.5 w-3.5 items-center justify-center rounded-full border-[1.5px] border-primary">
        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
      </span>
    );
  }
  if (status === 'failed') {
    return <CircleAlert className="h-3.5 w-3.5 text-destructive" />;
  }
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/45" />;
}

export const WorkspaceTodoList = memo(function WorkspaceTodoList({
  todos,
}: {
  todos: WorkspaceTodos;
}) {
  const { t } = useLocale();
  return (
    <section
      data-workspace-todo-list="true"
      aria-label={t('workspace.todoListTitle')}
      className="mt-4 max-w-[560px] rounded-xl bg-muted/35 px-3.5 py-3"
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
        <ListChecks className="h-3 w-3" />
        <span>{t('workspace.todoListTitle')}</span>
        <span className="tabular-nums">
          {t('workspace.todoListProgress')
            .replace('{done}', String(todos.completed))
            .replace('{total}', String(todos.total))}
        </span>
      </div>
      <ol className="mt-1.5 space-y-1">
        {todos.items.map((item) => (
          <li
            key={item.id}
            data-todo-status={item.status}
            aria-current={item.status === 'in_progress' ? 'step' : undefined}
            className="flex items-start gap-2"
          >
            <span className="mt-[3px] shrink-0">
              <TodoIcon status={item.status} />
            </span>
            <div className="min-w-0">
              <p className={cn(
                'text-[13px] leading-5',
                item.status === 'completed' && 'text-muted-foreground/60 line-through decoration-muted-foreground/30',
                item.status === 'in_progress' && 'font-medium text-foreground',
                item.status === 'pending' && 'text-foreground/75',
                item.status === 'failed' && 'text-destructive',
              )}>
                {item.text}
              </p>
              {item.status === 'in_progress' && item.activeText && item.activeText !== item.text ? (
                <p className="text-[11px] leading-4 text-muted-foreground/70">{item.activeText}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
});
