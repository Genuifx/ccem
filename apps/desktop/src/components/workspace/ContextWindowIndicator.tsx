import { useState } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import type { SessionUsageState } from './workspaceUsage';
import { formatTokenCount } from './workspaceUsage';
import { SessionUsagePopoverContent } from './SessionUsagePopover';

interface ContextWindowIndicatorProps {
  usage: SessionUsageState;
  provider?: string;
  onRefreshUsage?: () => void;
}

function getProgressColor(percentage: number): string {
  if (percentage >= 90) return 'bg-destructive';
  if (percentage >= 70) return 'bg-warning';
  return 'bg-primary/80';
}

function getRingColor(percentage: number): string {
  if (percentage >= 90) return 'hsl(var(--destructive))';
  if (percentage >= 70) return 'hsl(var(--warning))';
  return 'hsl(var(--muted-foreground) / 0.72)';
}

function formatPercent(value: number) {
  return `${Math.round(Math.max(0, value))}%`;
}

function formatTokenLabel(tokens: number) {
  return formatTokenCount(tokens).toLowerCase();
}

export function ContextWindowIndicator({
  usage,
  provider,
  onRefreshUsage,
}: ContextWindowIndicatorProps) {
  const { t } = useLocale();
  const [popoverOpen, setPopoverOpen] = useState(false);

  if (usage.turnCount === 0 && !usage.context && !usage.sessionUsage) return null;

  const hasContext = usage.context !== null;
  const percentage = Math.max(0, Math.min(100, usage.context?.percentage ?? 0));
  const totalTokens = usage.totalInputTokens + usage.totalOutputTokens;
  const ringColor = getRingColor(percentage);
  const ringStyle = hasContext
    ? {
        background: `conic-gradient(${ringColor} ${percentage * 3.6}deg, hsl(var(--muted) / 0.72) 0deg)`,
      }
    : undefined;

  const handleOpenChange = (next: boolean) => {
    setPopoverOpen(next);
    if (next) {
      onRefreshUsage?.();
    }
  };

  return (
    <Popover open={popoverOpen} onOpenChange={handleOpenChange}>
      <Tooltip open={popoverOpen ? false : undefined}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t('workspace.contextWindowTitle')}
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
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="center"
          sideOffset={10}
          className="min-w-[170px] max-w-[220px] px-3 py-2 text-center text-[12px] leading-5"
        >
          {hasContext && (
            <div className="space-y-0.5">
              <div className="text-muted-foreground">{t('workspace.contextWindowTitle')}</div>
              <div className="text-muted-foreground">
                {t('workspace.contextPercentUsed').replace('{percent}', formatPercent(percentage))}
              </div>
              <div className="font-medium text-foreground">
                {t('workspace.contextUsageLine')
                  .replace('{used}', formatTokenLabel(usage.context!.usedTokens))
                  .replace('{total}', formatTokenLabel(usage.context!.maxTokens))}
              </div>
              <div className="font-semibold text-foreground">
                {usage.context!.isAutoCompactEnabled
                  ? t('workspace.contextAutoCompactEnabled')
                  : t('workspace.contextAutoCompactDisabled')
                }
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted/60">
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-500',
                    getProgressColor(percentage),
                  )}
                  style={{ width: `${percentage}%` }}
                />
              </div>
            </div>
          )}

          {!hasContext && (
            <div className="space-y-0.5">
              <div className="text-muted-foreground">{t('workspace.contextWindowTitle')}</div>
              <div className="font-medium text-foreground">
                {t('workspace.contextTokenFallback')
                  .replace('{tokens}', formatTokenLabel(totalTokens))}
              </div>
              <div className="text-muted-foreground">{t('workspace.contextWindowUnavailable')}</div>
            </div>
          )}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={10}
        className="p-3"
      >
        <SessionUsagePopoverContent
          usage={usage}
          provider={provider}
          onRefresh={onRefreshUsage}
        />
      </PopoverContent>
    </Popover>
  );
}
