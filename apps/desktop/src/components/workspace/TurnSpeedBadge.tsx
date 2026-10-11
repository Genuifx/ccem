import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ConversationMessageData } from '@/features/conversations/types';
import { useLocale } from '@/locales';

/** Persisted execution metrics only. Rendering/replaying never starts a clock. */
export function TurnSpeedBadge({ metrics }: { metrics: ConversationMessageData['turnMetrics'] }) {
  const { t } = useLocale();
  if (!metrics || !Number.isSafeInteger(metrics.outputTokens) || metrics.outputTokens < 0
    || !Number.isSafeInteger(metrics.elapsedMs) || metrics.elapsedMs <= 0) return null;
  const rate = metrics.outputTokens * 1000 / metrics.elapsedMs;
  const speed = rate > 0 && rate < 0.1 ? '<0.1' : rate.toFixed(1);
  const label = t('workspace.turnAverageSpeed', { speed });
  return (
    <div className="text-xs text-muted-foreground/70" data-turn-speed={speed}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="cursor-default tabular-nums" aria-label={label}>{label}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72">
          <div>{t('workspace.turnSpeedCalculation', {
            tokens: metrics.outputTokens.toLocaleString(), seconds: (metrics.elapsedMs / 1000).toFixed(1),
          })}</div>
          <div>{t('workspace.turnSpeedScope')}</div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
