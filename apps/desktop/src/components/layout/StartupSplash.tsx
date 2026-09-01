import { useEffect, useRef } from 'react';
import { MacFullscreenWindowControls } from './MacFullscreenWindowControls';
import { ccemMotion, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';

interface StartupSplashProps {
  exiting?: boolean;
  onExitComplete?: () => void;
}

const EXIT_FALLBACK_MS = 800;

export function StartupSplash({ exiting = false, onExitComplete }: StartupSplashProps) {
  const splashRef = useRef<HTMLDivElement | null>(null);
  const centerRef = useRef<HTMLDivElement | null>(null);

  // WebKit suspends requestAnimationFrame for hidden windows. GSAP's ticker
  // then cannot finish the exit timeline, which used to leave the loaded app
  // permanently covered by the splash. Timers still advance in that state, so
  // keep animation as progressive enhancement and make removal deterministic.
  useEffect(() => {
    if (!exiting) {
      return;
    }
    const fallbackId = window.setTimeout(() => {
      onExitComplete?.();
    }, EXIT_FALLBACK_MS);
    return () => window.clearTimeout(fallbackId);
  }, [exiting, onExitComplete]);

  useGSAP(() => {
    const splash = splashRef.current;
    const center = centerRef.current;
    if (!splash || !center) {
      return;
    }

    if (shouldReduceMotion()) {
      if (exiting) {
        onExitComplete?.();
      }
      return;
    }

    gsap.killTweensOf([splash, center]);

    if (exiting) {
      gsap.timeline({ onComplete: onExitComplete })
        .to(center, {
          autoAlpha: 0,
          y: -14,
          scale: 0.98,
          duration: ccemMotion.duration.base,
          ease: ccemMotion.ease.soft,
        })
        .to(splash, {
          autoAlpha: 0,
          duration: ccemMotion.duration.handoff,
          ease: ccemMotion.ease.standard,
        }, '<0.04');
      return;
    }

    gsap.fromTo(
      center,
      { autoAlpha: 0, y: 12, scale: 0.98 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: ccemMotion.duration.handoff,
        ease: ccemMotion.ease.standard,
        clearProps: 'opacity,visibility,transform',
      },
    );
  }, { dependencies: [exiting, onExitComplete], scope: splashRef });

  return (
    <div
      ref={splashRef}
      className="startup-splash"
      data-tauri-drag-region
      data-exiting={exiting ? 'true' : undefined}
      aria-label="CCEM loading"
    >
      <MacFullscreenWindowControls />
      <div className="startup-splash-grain" aria-hidden="true" />
      <div className="startup-splash-sheen" aria-hidden="true" />

      <div ref={centerRef} className="startup-splash-center">
        <div className="startup-logo-aura" aria-hidden="true" />
        <img src="/logo.png" alt="CCEM" className="startup-logo" />
        <div className="startup-brand" aria-hidden="true">CCEM</div>
      </div>
    </div>
  );
}
