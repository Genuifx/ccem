import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ConversationMessageData } from '@/features/conversations/types';
import { useLocale } from '@/locales';

function formatTtft(ttftMs: number): string {
  if (ttftMs < 1000) return `${Math.round(ttftMs)}ms`;
  return `${(ttftMs / 1000).toFixed(1)}s`;
}

/** Persisted execution metrics only. Rendering/replaying never starts a clock. */
export function TurnSpeedBadge({ metrics }: { metrics: ConversationMessageData['turnMetrics'] }) {
  const { t } = useLocale();
  if (!metrics || !Number.isSafeInteger(metrics.outputTokens) || metrics.outputTokens < 0
    || !Number.isSafeInteger(metrics.elapsedMs) || metrics.elapsedMs <= 0) return null;
  // Prefer streamed generation time (no first-token latency, tools or waiting);
  // fall back to wall-clock turn time when the provider does not stream deltas.
  const generationMs = Number.isSafeInteger(metrics.generationMs) && metrics.generationMs! > 0
    ? metrics.generationMs! : undefined;
  const ttftMs = Number.isSafeInteger(metrics.ttftMs) && metrics.ttftMs! >= 0
    ? metrics.ttftMs! : undefined;
  const ttft = ttftMs !== undefined ? formatTtft(ttftMs) : undefined;
  const durationMs = generationMs ?? metrics.elapsedMs;
  const rate = metrics.outputTokens * 1000 / durationMs;
  const speed = rate > 0 && rate < 0.1 ? '<0.1' : rate.toFixed(1);
  const speedLabel = t('workspace.turnAverageSpeed', { speed });
  const label = ttft ? `${t('workspace.turnTtft', { ttft })} · ${speedLabel}` : speedLabel;
  const tokens = metrics.outputTokens.toLocaleString();
  const seconds = (durationMs / 1000).toFixed(1);
  return (
    <div
      className="mx-1 whitespace-nowrap text-[10px] text-muted-foreground/50"
      data-turn-speed={speed}
      {...(ttftMs !== undefined ? { 'data-turn-ttft': ttftMs } : {})}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="cursor-default tabular-nums" aria-label={label}>{label}</span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72">
          {ttft ? <div>{t('workspace.turnSpeedTtft', { ttft })}</div> : null}
          {generationMs ? (
            <>
              <div>{t('workspace.turnSpeedGenerationCalculation', { tokens, seconds })}</div>
              <div>{t('workspace.turnSpeedGenerationScope')}</div>
              <div>{t('workspace.turnSpeedElapsed', { seconds: (metrics.elapsedMs / 1000).toFixed(1) })}</div>
            </>
          ) : (
            <>
              <div>{t('workspace.turnSpeedCalculation', { tokens, seconds })}</div>
              <div>{t('workspace.turnSpeedScope')}</div>
            </>
          )}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
