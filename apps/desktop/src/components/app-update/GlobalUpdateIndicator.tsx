import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AlertCircle, Download, Loader2, RefreshCw, RotateCw } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import { useAppUpdate } from './appUpdateContext';
import { ccemMotion, clearMotionProps, getMotionTargets, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';
import {
  deriveUpdateIndicatorModel,
  type AppUpdateIndicatorAction,
} from './appUpdateState';

function formatMessage(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce(
    (message, [key, value]) => message.split(`{${key}}`).join(value),
    template
  );
}

export function GlobalUpdateIndicator() {
  const { t } = useLocale();
  const { state, downloadUpdate, restartForUpdate } = useAppUpdate();
  const model = deriveUpdateIndicatorModel(state);
  const [statusOpen, setStatusOpen] = useState(false);
  const readyVersionRef = useRef<string | null>(null);
  const indicatorButtonRef = useRef<HTMLButtonElement>(null);
  const popoverMotionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.updateIndicatorVisible = model.visible ? 'true' : 'false';

    return () => {
      root.removeAttribute('data-update-indicator-visible');
    };
  }, [model.visible]);

  useEffect(() => {
    if (state.status !== 'ready' || !state.updateInfo) {
      return;
    }

    if (readyVersionRef.current === state.updateInfo.version) {
      return;
    }

    readyVersionRef.current = state.updateInfo.version;
    setStatusOpen(true);
  }, [state.status, state.updateInfo]);

  useEffect(() => {
    if (!model.visible) {
      setStatusOpen(false);
    }
  }, [model.visible]);

  useGSAP(() => {
    const button = indicatorButtonRef.current;
    if (!model.visible || !button) {
      return;
    }

    if (shouldReduceMotion()) {
      clearMotionProps(button);
      return;
    }

    gsap.killTweensOf(button);
    gsap.fromTo(
      button,
      { autoAlpha: 0, y: -4, scale: 0.92 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: ccemMotion.duration.quick,
        ease: ccemMotion.ease.standard,
        overwrite: 'auto',
        onComplete: () => clearMotionProps(button),
      },
    );
  }, { dependencies: [model.visible, model.tone] });

  useGSAP(() => {
    const popover = popoverMotionRef.current;
    if (!statusOpen || !popover) {
      return;
    }

    const targets = [popover, ...getMotionTargets(popover, '[data-update-popover-motion]', 4)];
    if (shouldReduceMotion()) {
      clearMotionProps(targets);
      return;
    }

    gsap.killTweensOf(targets);
    gsap.fromTo(
      targets,
      { autoAlpha: 0, y: -4 },
      {
        autoAlpha: 1,
        y: 0,
        duration: ccemMotion.duration.quick,
        ease: ccemMotion.ease.standard,
        stagger: 0.025,
        overwrite: 'auto',
        onComplete: () => clearMotionProps(targets),
      },
    );
  }, { scope: popoverMotionRef, dependencies: [statusOpen, model.tone] });

  if (!model.visible || !state.updateInfo) {
    return null;
  }

  const title = model.titleKey === 'settings.updateAvailable'
    ? formatMessage(t(model.titleKey), { version: state.updateInfo.version })
    : t(model.titleKey);
  const description = model.descriptionKey ? t(model.descriptionKey) : '';
  const percentLabel = model.percent !== null
    ? formatMessage(t('settings.updateDownloadProgress'), { percent: String(model.percent) })
    : description;
  const Icon = model.tone === 'ready'
    ? RotateCw
    : model.tone === 'downloading'
      ? Loader2
      : model.tone === 'error'
        ? AlertCircle
        : Download;
  const popoverTitle = model.tone === 'downloading' && model.percent !== null
    ? percentLabel
    : model.tone === 'ready'
      ? t('settings.updateReadyTitle')
      : model.tone === 'error'
        ? t('settings.updateInstallFailedShort')
        : title;
  const actionLabel = getActionLabel(model.action, t);
  const ActionIcon = getActionIcon(model.action);
  const showVersion = model.tone !== 'available';
  const showProgressTrack = model.tone === 'downloading';
  const progressPercent = model.percent ?? (showProgressTrack ? 22 : 0);
  const progressRingStyle = showProgressTrack && model.percent !== null
    ? ({
      background: `conic-gradient(hsl(var(--primary)) ${Math.max(0, Math.min(100, model.percent)) * 3.6}deg, hsl(var(--border) / 0.45) 0deg)`,
    } satisfies CSSProperties)
    : undefined;
  const titleHint = model.percent !== null ? percentLabel : description || title;

  const handleButtonClick = () => {
    setStatusOpen(true);

    if (model.action === 'download' || model.action === 'retry') {
      void downloadUpdate();
    }
  };

  const handlePopoverAction = () => {
    if (model.action === 'download' || model.action === 'retry') {
      void downloadUpdate();
      return;
    }

    if (model.action === 'restart') {
      void restartForUpdate();
    }
  };

  return (
    <div className="app-update-indicator-anchor absolute z-[121]">
      <Popover open={statusOpen} onOpenChange={setStatusOpen}>
        <PopoverTrigger asChild>
          <button
            ref={indicatorButtonRef}
            type="button"
            data-update-tone={model.tone}
            className={cn(
              'global-update-button relative inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-md border border-transparent',
              'bg-background/25 text-muted-foreground/80 shadow-[0_1px_0_hsl(var(--foreground)/0.04)] backdrop-blur-sm',
              'transition-[background-color,border-color,color,transform,box-shadow] duration-150',
              'hover:border-border/70 hover:bg-background/70 hover:text-foreground active:scale-[0.96]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              model.tone === 'available' && 'text-rose-500 hover:bg-rose-500/10 hover:text-rose-500',
              model.tone === 'ready' && 'text-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-500',
              model.tone === 'error' && 'text-destructive hover:bg-destructive/10 hover:text-destructive',
              model.tone === 'downloading' && 'text-primary hover:bg-primary/10 hover:text-primary'
            )}
            aria-label={model.tone === 'ready' ? t('settings.updateGlobalReadyLabel') : title}
            title={titleHint}
            onClick={handleButtonClick}
          >
            {progressRingStyle ? (
              <>
                <span
                  className="pointer-events-none absolute inset-[3px] rounded-full opacity-80 transition-opacity"
                  style={progressRingStyle}
                />
                <span className="pointer-events-none absolute inset-[5px] rounded-full bg-background/90" />
              </>
            ) : null}
            <Icon className={cn('relative h-[15px] w-[15px]', model.tone === 'downloading' && 'animate-spin')} />
            {model.tone === 'available' || model.tone === 'error' ? (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-rose-500 shadow-[0_0_0_2px_hsl(var(--background))]" />
            ) : null}
            {model.tone === 'ready' ? (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_2px_hsl(var(--background))]" />
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent
          ref={popoverMotionRef}
          side="bottom"
          align="start"
          sideOffset={8}
          className="w-auto max-w-[calc(100vw-24px)] rounded-md border-border/70 bg-popover/95 px-2 py-1.5 shadow-sm backdrop-blur-xl"
        >
          <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
            <span data-update-popover-motion className="min-w-0 truncate text-sm font-medium text-foreground">
              {popoverTitle}
            </span>
            {showVersion ? (
              <span data-update-popover-motion className="shrink-0 text-xs tabular-nums text-muted-foreground">
                v{state.updateInfo.version}
              </span>
            ) : null}
            {showProgressTrack ? (
              <span data-update-popover-motion className="relative h-1 w-14 shrink-0 overflow-hidden rounded-full bg-foreground/10" aria-hidden="true">
                <span
                  className={cn(
                    'block h-full rounded-full bg-primary transition-[width] duration-300 ease-out',
                    model.percent === null && 'animate-pulse'
                  )}
                  style={{ width: `${Math.max(10, Math.min(100, progressPercent))}%` }}
                />
              </span>
            ) : null}
            {actionLabel && model.action !== 'none' ? (
              <Button
                data-update-popover-motion
                variant="ghost"
                size="sm"
                className={cn(
                  'h-7 shrink-0 px-2 text-xs active:scale-[0.97] transition-transform',
                  model.tone === 'ready' && 'text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-600',
                  model.tone === 'error' && 'text-destructive hover:bg-destructive/10 hover:text-destructive'
                )}
                onClick={handlePopoverAction}
              >
                {ActionIcon ? <ActionIcon className="mr-1 h-3 w-3" /> : null}
                {actionLabel}
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function getActionLabel(action: AppUpdateIndicatorAction, t: (key: string) => string) {
  if (action === 'download') {
    return t('settings.downloadUpdate');
  }

  if (action === 'restart') {
    return t('settings.restartToUpdate');
  }

  if (action === 'retry') {
    return t('settings.retryUpdateDownload');
  }

  return null;
}

function getActionIcon(action: AppUpdateIndicatorAction) {
  if (action === 'download') {
    return Download;
  }

  if (action === 'restart') {
    return RotateCw;
  }

  if (action === 'retry') {
    return RefreshCw;
  }

  return null;
}
