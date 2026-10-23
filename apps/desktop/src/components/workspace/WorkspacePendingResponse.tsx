import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import type { TurnLiveProgress } from './workspaceEventTranscript';
import { ccemMotion, clearMotionProps, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';
import { useLocale } from '@/locales';

/** Progress below this much streaming time gives a noisy rate; hide it. */
const MIN_RATE_GENERATION_MS = 500;

const formatCount = (value: number) => Math.round(value).toLocaleString();
const formatRate = (value: number) => Math.round(value).toString();

/**
 * Counts toward each new value over roughly one progress interval, so the
 * throttled helper updates read as a continuous tick instead of jumps. Text is
 * written imperatively: React never owns the node's content.
 */
function RollingNumber({ value, format }: { value: number; format: (value: number) => string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const shown = useRef(value);

  useLayoutEffect(() => {
    if (ref.current) ref.current.textContent = format(shown.current);
  }, [format]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (shouldReduceMotion()) {
      shown.current = value;
      node.textContent = format(value);
      return;
    }
    const state = { value: shown.current };
    const tween = gsap.to(state, {
      value,
      duration: 0.5,
      ease: 'none',
      onUpdate: () => {
        shown.current = state.value;
        node.textContent = format(state.value);
      },
    });
    return () => { tween.kill(); };
  }, [value, format]);

  return <span ref={ref} className="tabular-nums" />;
}

export const WorkspacePendingResponse = memo(function WorkspacePendingResponse({
  progress,
}: { progress?: TurnLiveProgress }) {
  const { t } = useLocale();
  const pendingRef = useRef<HTMLDivElement | null>(null);

  useGSAP(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (shouldReduceMotion()) {
      clearMotionProps(pending);
      return;
    }
    gsap.fromTo(
      pending,
      { autoAlpha: 0, y: 6 },
      {
        autoAlpha: 1,
        y: 0,
        duration: ccemMotion.duration.base,
        ease: ccemMotion.ease.standard,
        clearProps: 'opacity,visibility,transform',
      },
    );
  }, { scope: pendingRef });

  const tokens = progress && progress.outputTokens > 0 ? progress.outputTokens : undefined;
  const rate = tokens !== undefined && progress?.generationMs !== undefined
    && progress.generationMs >= MIN_RATE_GENERATION_MS
    ? tokens * 1000 / progress.generationMs : undefined;

  return (
    <div ref={pendingRef} className="flex items-center gap-1.5 py-1 text-[12px]" data-turn-progress={tokens ?? ''}>
      <span className="workspace-thinking-shimmer">{t('workspace.nativeThinking')}</span>
      {tokens !== undefined ? (
        <span className="flex items-center gap-1.5 text-muted-foreground/50">
          <span aria-hidden="true">·</span>
          <span><RollingNumber value={tokens} format={formatCount} /> tokens</span>
          {rate !== undefined ? (
            <>
              <span aria-hidden="true">·</span>
              <span><RollingNumber value={rate} format={formatRate} /> tok/s</span>
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
});
