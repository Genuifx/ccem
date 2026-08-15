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
 * Hovering the ring opens the full session usage panel; the pointer can move
 * onto the panel (refresh button) without closing it. There is deliberately no
 * separate hover tooltip — the panel itself is the hover surface, so the old
 * hover-tooltip/click-popover double layer is gone.
 */
export function ContextWindowIndicator({
  usage,
  provider,
  onRefreshUsage,
}: ContextWindowIndicatorProps) {
  const { t } = useLocale();

  if (usage.turnCount === 0 && !usage.context && !usage.sessionUsage) return null;

  const hasContext = usage.context !== null;
  const percentage = Math.max(0, Math.min(100, usage.context?.percentage ?? 0));
  const ringColor = getRingColor(percentage);
  const ringStyle = hasContext
    ? {
        background: `conic-gradient(${ringColor} ${percentage * 3.6}deg, hsl(var(--muted) / 0.72) 0deg)`,
      }
    : undefined;

  const handleOpenChange = (next: boolean) => {
    if (next) {
      onRefreshUsage?.();
    }
  };

  return (
    <HoverCard openDelay={200} closeDelay={200} onOpenChange={handleOpenChange}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={t('workspace.usagePanelTitle')}
          className={cn(
            'inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground',
            'transition-colors hover:bg-background/70 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
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
