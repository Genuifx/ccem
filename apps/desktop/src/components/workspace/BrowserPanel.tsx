import {
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openExternalUrl } from '@tauri-apps/plugin-shell';
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  ExternalLink,
  FileImage,
  FileJson,
  Files,
  Globe,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  X,
} from '@/lib/lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import type {
  BrowserInfo,
  BrowserRecentActivity,
  BrowserSessionStateEvent,
} from '@/lib/tauri-ipc';
import { CCEM_ZOOM_CHANGE_EVENT, CCEM_ZOOM_STORAGE_KEY } from '@/hooks/useZoom';
import { buildNativeBrowserBounds, normalizeBrowserBoundsZoom } from './browserPanelGeometry';

interface BrowserPanelProps {
  sessionId: string;
  defaultUrl?: string | null;
  className?: string;
  style?: CSSProperties;
  onResizeStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onClose: () => void;
}

function readCurrentAppZoom(): number {
  try {
    const raw = window.localStorage.getItem(CCEM_ZOOM_STORAGE_KEY);
    return normalizeBrowserBoundsZoom(raw ?? 1);
  } catch {
    return 1;
  }
}

function normalizeBrowserInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  if (/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(:\d+)?(\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }

  if (/^[a-z][a-z\d+\-.]*:/i.test(trimmed)) {
    return trimmed;
  }

  if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(trimmed) || trimmed.includes('.')) {
    return `https://${trimmed}`;
  }

  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

function formatArtifactBytes(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`;
  if (byteSize < 1024 * 1024) return `${Math.round(byteSize / 1024)} KB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

function BrowserToolButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 rounded-full"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function BrowserPanel({
  sessionId,
  defaultUrl = null,
  className,
  style,
  onResizeStart,
  onClose,
}: BrowserPanelProps) {
  const { t } = useLocale();
  const frameRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const syncFrameRef = useRef<number | null>(null);
  const isUrlEditingRef = useRef(false);
  const [currentUrl, setCurrentUrl] = useState<string | null>(defaultUrl ?? null);
  const [urlInput, setUrlInput] = useState(defaultUrl ?? '');
  const [isUrlEditing, setIsUrlEditing] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<BrowserInfo['lifecycle']>('creating');
  const [control, setControl] = useState<BrowserInfo['control']>('user');
  const [paused, setPaused] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isPauseBusy, setIsPauseBusy] = useState(false);
  const [recentActivity, setRecentActivity] = useState<BrowserRecentActivity>({ artifacts: [] });

  const applyBrowserInfo = useCallback((info: BrowserInfo, fallbackUrl?: string | null) => {
    const nextUrl = info.url ?? fallbackUrl ?? null;
    setCurrentUrl(nextUrl);
    if (!isUrlEditingRef.current) {
      setUrlInput(nextUrl ?? '');
    }
    setTitle(info.title ?? null);
    setCanGoBack(Boolean(info.can_go_back));
    setCanGoForward(Boolean(info.can_go_forward));
    setLifecycle(info.lifecycle ?? 'ready');
    setControl(info.control ?? 'user');
    setPaused(Boolean(info.paused));
    setIsLoading(Boolean(info.loading));
    if (info.error !== undefined) {
      setError(info.error ?? null);
    }
    return nextUrl;
  }, []);

  const syncBounds = useCallback(() => {
    if (syncFrameRef.current !== null) {
      cancelAnimationFrame(syncFrameRef.current);
    }

    syncFrameRef.current = requestAnimationFrame(() => {
      syncFrameRef.current = null;
      const frame = frameRef.current;
      if (!frame) {
        return;
      }
      const rect = frame.getBoundingClientRect();
      const bounds = buildNativeBrowserBounds(rect, readCurrentAppZoom());
      void invoke('browser_set_bounds', { sessionId, ...bounds }).catch((boundsError) => {
        console.error('Failed to sync browser bounds:', boundsError);
      });
    });
  }, [sessionId]);

  const refreshInfo = useCallback(async () => {
    const info = await invoke<BrowserInfo>('browser_info', { sessionId });
    applyBrowserInfo(info);
    return info;
  }, [applyBrowserInfo, sessionId]);

  const refreshRecentActivity = useCallback(async () => {
    const activity = await invoke<BrowserRecentActivity>('browser_recent_activity', { sessionId });
    setRecentActivity(activity);
    return activity;
  }, [sessionId]);

  const copyActivityPath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast.success(t('workspace.browserPathCopied'));
    } catch (copyError) {
      toast.error(String(copyError));
    }
  }, [t]);

  const showBrowserError = useCallback((message: string) => {
    setIsLoading(false);
    setError(message);
    toast.error(message);
  }, []);

  const openBrowser = useCallback(async (url?: string | null) => {
    setIsBusy(true);
    setError(null);
    try {
      const info = await invoke<BrowserInfo>('browser_open', {
        sessionId,
        url: url || null,
      });
      applyBrowserInfo(info, url ?? null);
      syncBounds();
      window.setTimeout(() => {
        void refreshInfo().catch(() => {});
      }, 700);
    } catch (openError) {
      showBrowserError(String(openError));
    } finally {
      setIsBusy(false);
    }
  }, [applyBrowserInfo, refreshInfo, sessionId, showBrowserError, syncBounds]);

  useEffect(() => {
    void openBrowser(defaultUrl);
    void refreshRecentActivity().catch(() => {});

    return () => {
      if (syncFrameRef.current !== null) {
        cancelAnimationFrame(syncFrameRef.current);
      }
      void invoke('browser_set_visible', { sessionId, visible: false }).catch(() => {});
    };
  }, [defaultUrl, openBrowser, refreshRecentActivity, sessionId]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listen<BrowserSessionStateEvent>('browser_session_state_changed', (event) => {
      const state = event.payload;
      if (state.sessionId !== sessionId) {
        return;
      }
      applyBrowserInfo({
        label: state.label,
        session_id: state.sessionId,
        url: state.url,
        title: state.title,
        visible: state.visible,
        can_go_back: state.canGoBack,
        can_go_forward: state.canGoForward,
        lifecycle: state.lifecycle,
        loading: state.loading,
        error: state.error,
        control: state.control,
        paused: state.paused,
        generation: state.generation,
        last_agent_action: state.lastAgentAction,
        created_at: state.createdAt,
        updated_at: state.updatedAt,
      });
      if (state.cause === 'agent_action_finished' || state.cause === 'agent_action_failed') {
        void refreshRecentActivity().catch(() => {});
      }
    }).then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten();
      } else {
        unlisten = nextUnlisten;
      }
    }).catch((listenError) => {
      console.error('Failed to listen for browser session state:', listenError);
    });

    const healthTimer = window.setInterval(() => {
      void invoke<BrowserInfo>('browser_health_check', { sessionId })
        .then((info) => {
          applyBrowserInfo(info);
          void refreshRecentActivity().catch(() => {});
        })
        .catch(() => {});
    }, 4_000);

    return () => {
      disposed = true;
      unlisten?.();
      window.clearInterval(healthTimer);
    };
  }, [applyBrowserInfo, refreshRecentActivity, sessionId]);

  useEffect(() => {
    isUrlEditingRef.current = isUrlEditing;
    if (!isUrlEditing) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isUrlEditing]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) {
      return;
    }

    const observer = new ResizeObserver(syncBounds);
    observer.observe(frame);
    window.addEventListener('resize', syncBounds);
    window.addEventListener(CCEM_ZOOM_CHANGE_EVENT, syncBounds);
    const timeoutId = window.setTimeout(syncBounds, 80);

    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener('resize', syncBounds);
      window.removeEventListener(CCEM_ZOOM_CHANGE_EVENT, syncBounds);
      observer.disconnect();
    };
  }, [syncBounds]);

  const runBrowserCommand = useCallback(async (
    command: 'browser_back' | 'browser_forward' | 'browser_reload',
  ) => {
    setIsBusy(true);
    setError(null);
    try {
      const info = await invoke<BrowserInfo>(command, { sessionId });
      applyBrowserInfo(info, currentUrl);
      window.setTimeout(() => {
        void refreshInfo().catch(() => {});
      }, 260);
    } catch (commandError) {
      showBrowserError(String(commandError));
    } finally {
      setIsBusy(false);
    }
  }, [applyBrowserInfo, currentUrl, refreshInfo, sessionId, showBrowserError]);

  const navigate = useCallback(async (rawValue: string) => {
    const nextUrl = normalizeBrowserInput(rawValue);
    if (!nextUrl) {
      setUrlInput(currentUrl ?? '');
      return;
    }
    const previousUrl = currentUrl;

    setIsBusy(true);
    setError(null);
    setUrlInput(nextUrl);
    setCurrentUrl(nextUrl);
    try {
      const info = await invoke<BrowserInfo>('browser_navigate', { sessionId, url: nextUrl });
      applyBrowserInfo(info, nextUrl);
      setIsUrlEditing(false);
      syncBounds();
      window.setTimeout(() => {
        void refreshInfo().catch(() => {});
      }, 700);
    } catch (navigateError) {
      setCurrentUrl(previousUrl);
      setUrlInput(previousUrl ?? '');
      showBrowserError(String(navigateError));
    } finally {
      setIsBusy(false);
    }
  }, [applyBrowserInfo, currentUrl, refreshInfo, sessionId, showBrowserError, syncBounds]);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void navigate(urlInput);
  }, [navigate, urlInput]);

  const cancelUrlEditing = useCallback(() => {
    setUrlInput(currentUrl ?? '');
    setIsUrlEditing(false);
  }, [currentUrl]);

  const handleStartUrlEditing = useCallback(() => {
    setUrlInput(currentUrl ?? '');
    setIsUrlEditing(true);
  }, [currentUrl]);

  const handleOpenExternal = useCallback(() => {
    if (!currentUrl) {
      return;
    }
    void openExternalUrl(currentUrl).catch((openError) => {
      showBrowserError(String(openError));
    });
  }, [currentUrl, showBrowserError]);

  const handleToggleAgentControl = useCallback(async () => {
    setIsPauseBusy(true);
    try {
      const info = await invoke<BrowserInfo>('browser_set_paused', {
        sessionId,
        paused: !paused,
      });
      applyBrowserInfo(info);
    } catch (pauseError) {
      showBrowserError(String(pauseError));
    } finally {
      setIsPauseBusy(false);
    }
  }, [applyBrowserInfo, paused, sessionId, showBrowserError]);

  const displayUrl = currentUrl || title || t('workspace.browserTitle');
  const recentActivityCount = recentActivity.artifacts.length
    + (recentActivity.console_log_path ? 1 : 0)
    + (recentActivity.audit_log_path ? 1 : 0);

  return (
    <aside
      data-ccem-browser-panel="true"
      data-ccem-browser-lifecycle={lifecycle}
      data-ccem-browser-control={control}
      data-ccem-browser-paused={paused ? 'true' : 'false'}
      style={style}
      className={cn(
        'workspace-browser-panel relative flex h-full min-w-0 flex-col overflow-hidden',
        className,
      )}
    >
      <div
        data-ccem-browser-resize-handle="true"
        className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize touch-none"
        onPointerDown={onResizeStart}
      />

      <div data-ccem-browser-tab-strip="true" className="flex h-10 shrink-0 items-center gap-2 border-b border-border/45 pl-3 pr-2">
        <div className="flex h-7 min-w-0 max-w-[220px] items-center gap-2 rounded-md bg-muted/45 px-2.5 text-xs font-medium text-foreground">
          <Globe className="h-4 w-4" />
          <span className="truncate">{t('workspace.browserTitle')}</span>
        </div>
        <div className="min-w-0 flex-1" />
        {lifecycle === 'crashed' ? (
          <span className="text-[11px] font-medium text-destructive">
            {t('workspace.browserCrashed')}
          </span>
        ) : control === 'agent' ? (
          <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
            {t('workspace.browserAgentControlling')}
          </span>
        ) : paused ? (
          <span className="text-[11px] font-medium text-muted-foreground">
            {t('workspace.browserAgentPaused')}
          </span>
        ) : null}
        <Popover onOpenChange={(open) => {
          if (open) void refreshRecentActivity().catch(() => {});
        }}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="relative h-7 w-7 shrink-0"
              aria-label={t('workspace.browserRecentArtifacts')}
              title={t('workspace.browserRecentArtifacts')}
            >
              <Files className="h-4 w-4" />
              {recentActivityCount > 0 ? (
                <span className="absolute -right-1 -top-1 min-w-3.5 rounded-full bg-primary px-1 text-[9px] font-semibold leading-3.5 text-primary-foreground">
                  {Math.min(recentActivityCount, 9)}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" side="bottom" className="w-80 p-2">
            <div className="px-2 py-1.5 text-xs font-semibold text-foreground">
              {t('workspace.browserRecentArtifacts')}
            </div>
            {recentActivityCount === 0 ? (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                {t('workspace.browserNoArtifacts')}
              </div>
            ) : (
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {recentActivity.artifacts.map((artifact) => {
                  const ArtifactIcon = artifact.kind === 'screenshot' ? FileImage : FileJson;
                  return (
                    <button
                      key={artifact.path}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/60"
                      title={artifact.path}
                      onClick={() => void copyActivityPath(artifact.path)}
                    >
                      <ArtifactIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-foreground">
                          {artifact.file_name}
                        </span>
                        <span className="block text-[10px] text-muted-foreground">
                          {formatArtifactBytes(artifact.byte_size)}
                        </span>
                      </span>
                      <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    </button>
                  );
                })}
                {recentActivity.console_log_path ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/60"
                    title={recentActivity.console_log_path}
                    onClick={() => void copyActivityPath(recentActivity.console_log_path!)}
                  >
                    <ScrollText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                      {t('workspace.browserConsoleLog')}
                    </span>
                    <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ) : null}
                {recentActivity.audit_log_path ? (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/60"
                    title={recentActivity.audit_log_path}
                    onClick={() => void copyActivityPath(recentActivity.audit_log_path!)}
                  >
                    <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                      {t('workspace.browserAuditLog')}
                    </span>
                    <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ) : null}
              </div>
            )}
          </PopoverContent>
        </Popover>
        {isBusy || isLoading ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : null}
        <BrowserToolButton
          label={paused ? t('workspace.browserResumeAgent') : t('workspace.browserPauseAgent')}
          onClick={() => void handleToggleAgentControl()}
          disabled={isPauseBusy || lifecycle === 'crashed'}
        >
          {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
        </BrowserToolButton>
        <BrowserToolButton
          label={t('workspace.browserClose')}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </BrowserToolButton>
      </div>

      <div data-ccem-browser-navigation="true" className="flex h-11 shrink-0 items-center gap-1 border-b border-border/45 px-3">
        <BrowserToolButton
          label={t('workspace.browserBack')}
          onClick={() => void runBrowserCommand('browser_back')}
          disabled={isBusy || !canGoBack}
        >
          <ArrowLeft className="h-4 w-4" />
        </BrowserToolButton>
        <BrowserToolButton
          label={t('workspace.browserForward')}
          onClick={() => void runBrowserCommand('browser_forward')}
          disabled={isBusy || !canGoForward}
        >
          <ArrowRight className="h-4 w-4" />
        </BrowserToolButton>
        <BrowserToolButton
          label={t('workspace.browserReload')}
          onClick={() => void runBrowserCommand('browser_reload')}
          disabled={isBusy}
        >
          <RefreshCw className={cn('h-4 w-4', isBusy && 'animate-spin')} />
        </BrowserToolButton>
        <BrowserToolButton
          label={t('workspace.browserOpenExternal')}
          onClick={handleOpenExternal}
          disabled={!currentUrl}
        >
          <ExternalLink className="h-4 w-4" />
        </BrowserToolButton>
        <form className="ml-2 min-w-0 flex-1" onSubmit={handleSubmit}>
          {isUrlEditing ? (
            <Input
              ref={urlInputRef}
              data-ccem-browser-url-input="true"
              aria-label={t('workspace.browserUrl')}
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              onBlur={cancelUrlEditing}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelUrlEditing();
                }
              }}
              className="h-8 min-w-0 rounded-md border-border/60 bg-muted/20 px-2 text-xs shadow-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          ) : (
            <button
              type="button"
              data-ccem-browser-url-display="true"
              aria-label={t('workspace.browserUrl')}
              title={displayUrl}
              className="flex h-8 w-full min-w-0 items-center rounded-md px-2 text-left text-xs text-muted-foreground transition hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={handleStartUrlEditing}
            >
              <span className="truncate">{displayUrl}</span>
            </button>
          )}
        </form>
      </div>

      {error ? (
        <div className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 bg-white">
        <div ref={frameRef} data-ccem-browser-frame="true" className="absolute inset-y-0 right-0 left-1.5" />
      </div>
    </aside>
  );
}
