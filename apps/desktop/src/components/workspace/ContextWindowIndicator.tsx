import { useRef, useState } from 'react';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import type { SessionUsageState } from './workspaceUsage';
import { SessionUsagePopoverContent } from './SessionUsagePopover';

interface ContextWindowIndicatorProps {
  usage: SessionUsageState;
  provider?: string;
  onRefreshUsage?: () => void;
}

function getRingColor(percentage: number): string {
  if (percentage >= 90) return 'hsl(var(--destructive))';
  if (percentage >= 70) return 'hsl(var(--warning))';
  return 'hsl(var(--muted-foreground) / 0.72)';
}

/**
 * Context ring in the composer secondary actions.
 *
 * The ring is ALWAYS rendered — every session shows the usage entry point.
 * Before any usage/context event arrives (fresh session, events still
 * replaying, providers without context events) it renders the neutral
 * placeholder ring instead of vanishing; the hover panel explains the empty
 * state. Hiding the entry point entirely made the composer usage area look
 * intermittently missing.
 *
 * Hovering the ring opens the full session usage panel; the pointer can move
 * onto the panel (refresh button) without closing it. There is deliberately no
 * separate hover tooltip — the panel itself is the hover surface, so the old
 * hover-tooltip/click-popover double layer is gone.
 *
 * Clicking the ring PINS the panel open (REQ-0035): the panel view switch
 * (用量/组成) resizes the content, which can drop a resting pointer outside
 * the hover surface and auto-close the panel mid-read. While pinned, hover/
 * focus leave can no longer close the panel; only an explicit dismissal
 * (click the ring again, click outside, or Escape) closes it.
 */
export function ContextWindowIndicator({
  usage,
  provider,
  onRefreshUsage,
}: ContextWindowIndicatorProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  // Read inside Radix event callbacks that run before a re-render lands
  // (pointerdown → click), so guards and dismissal agree within one gesture.
  const pinnedRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const hasContext = usage.context !== null;
  const percentage = Math.max(0, Math.min(100, usage.context?.percentage ?? 0));
  const ringColor = getRingColor(percentage);
  const ringStyle = hasContext
    ? {
        background: `conic-gradient(${ringColor} ${percentage * 3.6}deg, hsl(var(--muted) / 0.72) 0deg)`,
      }
    : undefined;

  const dismiss = () => {
    pinnedRef.current = false;
    setPinned(false);
    setOpen(false);
  };

  // Every Radix close intent (hover/focus leave after closeDelay, DismissableLayer
  // dismiss on Escape / pointerdown outside) funnels through this handler while
  // `open` is controlled. Explicit dismissals clear `pinnedRef` first, so the
  // guard below only vetoes the hover-leave intents while pinned.
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setOpen(true);
      onRefreshUsage?.();
    } else if (!pinnedRef.current) {
      setOpen(false);
    }
  };

  const handleTriggerClick = () => {
    if (pinnedRef.current) {
      dismiss();
      return;
    }
    pinnedRef.current = true;
    setPinned(true);
    setOpen(true);
    // Hover-open already refreshed; only a click that opened the panel needs one.
    if (!open) {
      onRefreshUsage?.();
    }
  };

  const handlePointerDownOutside = (
    event: { preventDefault: () => void; detail?: { originalEvent: { target: EventTarget | null } } },
  ) => {
    const target = event.detail?.originalEvent.target;
    if (target instanceof Node && triggerRef.current?.contains(target)) {
      // The ring click toggles the pin in onClick; without this the layer
      // dismisses the panel on the pointerdown half of that same click.
      event.preventDefault();
      return;
    }
    dismiss();
  };

  return (
    <HoverCard open={open} openDelay={200} closeDelay={200} onOpenChange={handleOpenChange}>
      <HoverCardTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={t('workspace.usagePanelTitle')}
          aria-expanded={open}
          onClick={handleTriggerClick}
          className={cn(
            'inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground',
            'transition-colors hover:bg-background/70 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
            pinned && 'bg-background/70 text-foreground',
          )}
        >
          {hasContext ? (
            <span className="relative h-4 w-4 rounded-full" style={ringStyle}>
              <span className="absolute inset-[3px] rounded-full bg-background" />
            </span>
          ) : (
            <span className="h-4 w-4 rounded-full border border-muted-foreground/55" />
          )}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="end"
        sideOffset={10}
        onEscapeKeyDown={dismiss}
        onPointerDownOutside={handlePointerDownOutside}
        className="w-[300px] overflow-hidden rounded-2xl border-border/45 bg-popover p-0 shadow-lg"
      >
        <SessionUsagePopoverContent
          usage={usage}
          provider={provider}
          onRefresh={onRefreshUsage}
        />
      </HoverCardContent>
    </HoverCard>
  );
}
