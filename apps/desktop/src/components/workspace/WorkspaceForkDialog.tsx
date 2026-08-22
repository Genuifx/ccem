import { useEffect, useRef, useState } from 'react';
import { GitFork } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLocale } from '@/locales';
import type { ConversationMessageData } from '@/features/conversations/types';

export interface WorkspaceForkTarget {
  /** Turn preview shown as the fork point (assistant text excerpt). */
  turnPreview: string;
  /** Human label of the session being forked from. */
  sessionLabel: string | null;
}

const FORK_TURN_PREVIEW_LIMIT = 200;

/** Short text excerpt of the chosen turn, shown as the fork point. */
export function getWorkspaceForkTurnPreview(message: ConversationMessageData): string {
  const parts: string[] = [];
  const pushText = (value: string | null | undefined) => {
    if (value && value.trim()) {
      parts.push(value.trim());
    }
  };
  if (typeof message.content === 'string') {
    pushText(message.content);
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block && typeof block === 'object' && 'text' in block) {
        pushText(String((block as { text?: unknown }).text ?? ''));
      }
    }
  }
  const joined = parts.join(' ').replace(/\s+/g, ' ');
  return joined.length > FORK_TURN_PREVIEW_LIMIT
    ? `${joined.slice(0, FORK_TURN_PREVIEW_LIMIT - 1)}…`
    : joined;
}

interface WorkspaceForkDialogProps {
  open: boolean;
  target: WorkspaceForkTarget | null;
  submitting: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (firstPrompt: string) => void;
}

export function WorkspaceForkDialog({
  open,
  target,
  submitting,
  onOpenChange,
  onSubmit,
}: WorkspaceForkDialogProps) {
  const { t } = useLocale();
  const [prompt, setPrompt] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) {
      setPrompt('');
    }
  }, [open]);

  const trimmedPrompt = prompt.trim();
  const canSubmit = trimmedPrompt.length > 0 && !submitting;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(trimmedPrompt);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (submitting) return;
      onOpenChange(next);
    }}>
      <DialogContent className="frosted-panel glass-noise sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitFork className="h-4 w-4 text-primary" />
            {t('workspace.forkTurnDialogTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('workspace.forkTurnDialogBody')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <p className="line-clamp-3 rounded-xl bg-surface-raised px-3 py-2 text-[11px] leading-4.5 text-muted-foreground">
            {target?.turnPreview ?? ''}
          </p>
          <textarea
            ref={textareaRef}
            autoFocus
            maxLength={8_000}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSubmit) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={t('workspace.forkTurnPromptPlaceholder')}
            className="min-h-[88px] w-full resize-none rounded-xl border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button size="sm" disabled={!canSubmit} onClick={submit}>
              {submitting
                ? t('workspace.forkTurnSubmitting')
                : t('workspace.forkTurnSubmit')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
