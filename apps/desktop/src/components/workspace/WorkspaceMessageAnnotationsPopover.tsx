import { useRef } from 'react';
import { ChevronDown, MessageSquareQuote } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useLocale } from '@/locales';

interface WorkspaceMessageAnnotationsPopoverProps {
  annotations: Array<{ quote: string; note: string }>;
}

export function WorkspaceMessageAnnotationsPopover({
  annotations,
}: WorkspaceMessageAnnotationsPopoverProps) {
  const { t } = useLocale();
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (annotations.length === 0) {
    return null;
  }

  const dialogLabel = t('workspace.messageAnnotationsTitle')
    .replace('{count}', String(annotations.length));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="sm"
          data-workspace-message-annotations-trigger
          className="-ml-2 h-7 rounded-full px-2 text-[11px] font-medium text-muted-foreground hover:bg-muted/55 hover:text-foreground"
          aria-label={t('workspace.messageAnnotationsView')}
        >
          <MessageSquareQuote className="h-3.5 w-3.5" />
          <span>{t('workspace.messageAnnotationsView')}</span>
          <ChevronDown className="h-3 w-3 opacity-65" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        data-workspace-message-annotations-popover
        aria-label={dialogLabel}
        onEscapeKeyDown={() => {
          window.setTimeout(() => triggerRef.current?.focus(), 0);
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus();
        }}
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        className="w-[360px] max-w-[calc(100vw-24px)] rounded-2xl border-border/45 bg-popover p-0 shadow-lg"
      >
        <ScrollArea className="max-h-[360px]">
          <div className="divide-y divide-border/35">
            {annotations.map((annotation, index) => (
              <div
                key={`${annotation.quote}:${annotation.note}:${index}`}
                className="px-4 py-3.5"
              >
                {annotations.length > 1 ? (
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {t('workspace.messageAnnotationIndex').replace('{index}', String(index + 1))}
                  </p>
                ) : null}
                <blockquote className="whitespace-pre-wrap border-l-2 border-primary/30 pl-2.5 text-[11px] leading-5 text-muted-foreground">
                  {annotation.quote}
                </blockquote>
                <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-foreground">
                  {annotation.note}
                </p>
              </div>
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
