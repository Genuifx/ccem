import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, SquareArrowOutUpRight } from '@/lib/lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import type { TmuxAttachTerminalInfo, TmuxAttachTerminalType } from '@/lib/tauri-ipc';

const TERMINAL_ORDER: Record<TmuxAttachTerminalType, number> = {
  iterm2: 0,
  terminalapp: 1,
  ghostty: 2,
};

const FALLBACK_TERMINALS: TmuxAttachTerminalInfo[] = [
  { terminal_type: 'terminalapp', name: 'Terminal.app', installed: true, preferred: false },
  { terminal_type: 'iterm2', name: 'iTerm2', installed: false, preferred: false },
  { terminal_type: 'ghostty', name: 'Ghostty', installed: false, preferred: false },
];

interface OpenInTerminalPopoverButtonProps {
  sessionId: string | null;
  terminals?: TmuxAttachTerminalInfo[];
  disabled?: boolean;
  className?: string;
  align?: 'start' | 'center' | 'end';
  label?: string;
  onMenuIntent?: () => void;
  onOpenInTerminal: (sessionId: string, terminalType?: TmuxAttachTerminalType) => Promise<void> | void;
}

export function OpenInTerminalPopoverButton({
  sessionId,
  terminals,
  disabled,
  className,
  align = 'end',
  label,
  onMenuIntent,
  onOpenInTerminal,
}: OpenInTerminalPopoverButtonProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const options = useMemo(() => {
    const source = terminals && terminals.length > 0 ? terminals : FALLBACK_TERMINALS;
    return [...source].sort((a, b) => {
      if (a.preferred !== b.preferred) {
        return a.preferred ? -1 : 1;
      }
      return TERMINAL_ORDER[a.terminal_type] - TERMINAL_ORDER[b.terminal_type];
    });
  }, [terminals]);

  const clearCloseTimer = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const handlePointerEnter = () => {
    clearCloseTimer();
    onMenuIntent?.();
    setOpen(true);
  };

  const handlePointerLeave = () => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 120);
  };

  useEffect(() => {
    return () => {
      clearCloseTimer();
    };
  }, []);

  const triggerDisabled = disabled || !sessionId;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          onMenuIntent?.();
        }
        setOpen(nextOpen);
      }}
    >
      <Popover.Trigger asChild>
        <Button
          size="sm"
          variant="ghost"
          disabled={triggerDisabled}
          className={cn('h-9 gap-1.5 px-3', className)}
          onPointerDown={onMenuIntent}
          onMouseEnter={handlePointerEnter}
          onMouseLeave={handlePointerLeave}
          onFocus={handlePointerEnter}
        >
          <SquareArrowOutUpRight className="h-4 w-4" />
          {label ?? t('sessions.openInTerminal')}
          <ChevronDown className="h-3.5 w-3.5 opacity-70" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align={align}
          sideOffset={6}
          className="frosted-panel glass-noise z-50 w-[240px] rounded-xl p-2 shadow-dialog animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          onMouseEnter={handlePointerEnter}
          onMouseLeave={handlePointerLeave}
        >
          <div className="mb-1 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
            {t('sessions.chooseTerminal')}
          </div>
          <div className="space-y-1">
            {options.map((option) => (
              <button
                key={option.terminal_type}
                type="button"
                disabled={triggerDisabled || !option.installed}
                onClick={async () => {
                  if (!sessionId || !option.installed) {
                    return;
                  }
                  setOpen(false);
                  await onOpenInTerminal(sessionId, option.terminal_type);
                }}
                className={cn(
                  'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors',
                  triggerDisabled || !option.installed
                    ? 'cursor-not-allowed text-muted-foreground/40'
                    : 'text-foreground hover:bg-primary/10 hover:text-foreground'
                )}
              >
                <span>{option.name}</span>
                <span className="text-[11px] text-muted-foreground/70">
                  {option.preferred
                    ? t('common.default')
                    : option.installed
                      ? ''
                      : t('sessions.notInstalled')}
                </span>
              </button>
            ))}
          </div>
          <Popover.Arrow className="fill-[hsl(var(--glass-bg)/0.66)]" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
