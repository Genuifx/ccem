import { memo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ExternalLink, Lightbulb } from '@/lib/lucide-react';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import { nextStepSuggestionId, type NextStepSuggestion, type WorkspaceNextSteps } from './workspaceNextSteps';

export interface NextStepActions {
  /** suggestion id -> keys recorded for the started child session */
  startedChildKeys: Map<string, string[]>;
  onStartSession: (id: string, suggestion: NextStepSuggestion) => Promise<void>;
  onDoHere: (suggestion: NextStepSuggestion) => Promise<void>;
  onOpen: (childKeys: string[]) => void;
}

// Monochrome only: a black primary and a ghost secondary, no accent color.
const ACTION = 'h-6 gap-1 rounded-md bg-foreground px-2.5 text-[12px] font-normal text-background hover:bg-foreground/85';
const GHOST_ACTION = 'h-6 rounded-md px-2.5 text-[12px] font-normal text-foreground/80 hover:text-foreground';

export const WorkspaceNextStepsCard = memo(function WorkspaceNextStepsCard({
  nextSteps,
  actions,
}: {
  nextSteps: WorkspaceNextSteps;
  actions: NextStepActions;
}) {
  const { t } = useLocale();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const run = async (id: string, task: () => Promise<void>) => {
    if (pendingId) return;
    setPendingId(id);
    try {
      await task();
    } finally {
      setPendingId(null);
    }
  };

  return (
    <section
      data-workspace-next-steps="true"
      aria-label={t('workspace.nextStepsTitle')}
      className="mt-3 max-w-[560px] rounded-xl bg-muted/35 px-3.5 py-3"
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
        <Lightbulb className="h-3 w-3" />
        <span>{t('workspace.nextStepsTitle')}</span>
      </div>
      <ul className="mt-1.5">
        {nextSteps.suggestions.map((suggestion, index) => {
          const id = nextStepSuggestionId(nextSteps.anchorKey, index);
          const childKeys = actions.startedChildKeys.get(id) ?? null;
          return (
            <li
              key={id}
              data-next-step-id={id}
              data-next-step-state={childKeys ? 'started' : 'suggested'}
              className={cn('py-1.5', index > 0 && 'border-t border-border-subtle/40')}
            >
              <p className="text-[13px] font-medium leading-5 text-foreground">{suggestion.title}</p>
              <p className="line-clamp-2 whitespace-pre-line text-[12px] leading-[18px] text-muted-foreground">
                {suggestion.prompt}
              </p>
              <div className="mt-1.5 flex items-center gap-1.5">
                {childKeys ? (
                  <>
                    <span className="pr-1 text-[12px] text-muted-foreground/70">{t('workspace.nextStepStarted')}</span>
                    <Button
                      size="sm"
                      className={ACTION}
                      onClick={() => actions.onOpen(childKeys)}
                    >
                      <ExternalLink className="h-3 w-3" />
                      {t('workspace.nextStepOpen')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      className={ACTION}
                      disabled={pendingId !== null}
                      onClick={() => void run(id, () => actions.onStartSession(id, suggestion))}
                    >
                      {pendingId === id ? t('workspace.nextStepStarting') : t('workspace.nextStepStartSession')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className={GHOST_ACTION}
                      disabled={pendingId !== null}
                      onClick={() => void run(`${id}:here`, () => actions.onDoHere(suggestion))}
                    >
                      {t('workspace.nextStepDoHere')}
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
});
