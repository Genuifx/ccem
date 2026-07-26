import {
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openExternalUrl } from '@tauri-apps/plugin-shell';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useLocale } from '@/locales';
import type {
  BrowserInfo,
  BrowserRecentActivity,
  BrowserSessionStateEvent,
} from '@/lib/tauri-ipc';
import {
  applyBrowserSurfaceMutationResponseForLease,
  BROWSER_SURFACE_HOST_SHORTCUT_EVENT,
  browserSurfaceEventMatchesLease,
  browserSurfaceHostShortcutMatchesLease,
  createBrowserSurfaceClient,
  createBrowserSurfaceOrdering,
  highestSequencedSurfaceEventForLease,
  type BrowserSurfaceHostShortcutAction,
  type BrowserSurfaceHostShortcutEvent,
  type BrowserSurfaceOrdering,
  type BrowserSurfaceProfileSelection,
  type BrowserSurfaceRecoveryState,
  type BrowserSurfaceSnapshot,
  type BrowserSurfaceStateChangedEvent,
} from '@/lib/browserSurfaceIpc';
import { createBrowserPanelNativeSurfaceParticipant } from '@/lib/browserPanelNativeSurfaceParticipant';
import { useNativeSurfaceOcclusionParticipant } from '@/lib/nativeSurfaceOcclusion';
import { nativeSurfaceOcclusionStore } from '@/lib/nativeSurfaceOcclusionStore';
import { useNativeBrowserSurfaceGeometrySync } from '@/hooks/useNativeBrowserSurfaceGeometrySync';
import { CCEM_ZOOM_STORAGE_KEY } from '@/hooks/useZoom';
import { usePreviewSurfaceMutation } from '@/hooks/usePreviewSurfaceMutation';
import { buildNativeBrowserBounds, normalizeBrowserBoundsZoom } from './browserPanelGeometry';
import { BrowserPanelNavigation, BrowserPanelTabStrip } from './BrowserPanelChrome';

interface BrowserPanelSharedProps {
  sessionId: string;
  defaultUrl?: string | null;
  className?: string;
  style?: CSSProperties;
  surfaceOccluded?: boolean;
  onResizeStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onHostShortcut?: (action: BrowserSurfaceHostShortcutAction) => void;
  onClose: () => void;
}

type BrowserPanelProps = BrowserPanelSharedProps & (
  | { backend: 'preview'; workingDir?: never; profileMode?: never; profileId?: never }
  | ({ backend: 'login'; workingDir: string } & BrowserSurfaceProfileSelection)
);

type BrowserPanelLifecycle = NonNullable<BrowserInfo['lifecycle']>
  | NonNullable<BrowserSurfaceSnapshot['lifecycle']>;

const browserSurfaceClient = createBrowserSurfaceClient({
  invoke: (command, args) => invoke(command, args),
});

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

export function BrowserPanel(props: BrowserPanelProps) {
  const {
    backend,
    sessionId,
    defaultUrl = null,
    className,
    style,
    surfaceOccluded = false,
    onResizeStart,
    onHostShortcut,
    onClose,
  } = props;
  const loginWorkingDir = props.backend === 'login' ? props.workingDir : null;
  const loginProfileMode = props.backend === 'login' ? props.profileMode : null;
  const loginProfileId = props.backend === 'login' && props.profileMode === 'saved'
    ? props.profileId
    : undefined;
  const { t } = useLocale();
  const frameRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const syncFrameRef = useRef<number | null>(null);
  const isUrlEditingRef = useRef(false);
  const surfaceLeaseRef = useRef<{ leaseId: string; generation: number } | null>(null);
  const loginSurfaceOrderingRef = useRef<BrowserSurfaceOrdering | null>(null);
  if (!loginSurfaceOrderingRef.current) loginSurfaceOrderingRef.current = createBrowserSurfaceOrdering();
  const loginSurfaceOrdering = loginSurfaceOrderingRef.current;
  const runPreviewSurfaceMutation = usePreviewSurfaceMutation(backend === 'preview' ? sessionId : null);
  const surfaceClosingRef = useRef(false);
  const surfaceCloseSucceededRef = useRef(false);
  const onHostShortcutRef = useRef(onHostShortcut);
  onHostShortcutRef.current = onHostShortcut;
  const previewSurfaceReadyRef = useRef(false);
  const previewDesiredVisibilityRef = useRef(!surfaceOccluded);
  const surfaceOccludedRef = useRef(surfaceOccluded);
  const pausedRef = useRef(false);
  surfaceOccludedRef.current = surfaceOccluded;
  if (surfaceOccluded) previewDesiredVisibilityRef.current = false;
  const [currentUrl, setCurrentUrl] = useState<string | null>(defaultUrl ?? null);
  const [urlInput, setUrlInput] = useState(defaultUrl ?? '');
  const [isUrlEditing, setIsUrlEditing] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<BrowserPanelLifecycle>('creating');
  const [control, setControl] = useState<BrowserInfo['control']>('user');
  const [paused, setPaused] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<'running' | 'closing' | 'cleanup_required'>('running');
  const [recoveryStates, setRecoveryStates] = useState<BrowserSurfaceRecoveryState[]>([]);
  const [popupActive, setPopupActive] = useState(false);
  const [popupUrl, setPopupUrl] = useState<string | null>(null);
  const [popupTitle, setPopupTitle] = useState<string | null>(null);
  const [popupLoading, setPopupLoading] = useState(false);
  const [popupError, setPopupError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPauseBusy, setIsPauseBusy] = useState(false);
  const [isLoginControlBusy, setIsLoginControlBusy] = useState(false);
  const [isPopupCloseBusy, setIsPopupCloseBusy] = useState(false);
  const [isClosingSurface, setIsClosingSurface] = useState(false);
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
    pausedRef.current = Boolean(info.paused);
    setPaused(pausedRef.current);
    setIsLoading(Boolean(info.loading));
    if (info.error !== undefined) {
      setError(info.error ?? null);
    }
    return nextUrl;
  }, []);

  const applySurfaceSnapshot = useCallback((snapshot?: BrowserSurfaceSnapshot | null) => {
    if (!snapshot) return;
    if (snapshot.url !== undefined) {
      setCurrentUrl(snapshot.url ?? null);
      if (!isUrlEditingRef.current) {
        setUrlInput(snapshot.url ?? '');
      }
    }
    if (snapshot.title !== undefined) setTitle(snapshot.title ?? null);
    if (snapshot.lifecycle !== undefined) setLifecycle(snapshot.lifecycle);
    if (snapshot.control !== undefined) setControl(snapshot.control);
    if (snapshot.paused !== undefined) {
      pausedRef.current = snapshot.paused;
      setPaused(snapshot.paused);
    }
    if (snapshot.loading !== undefined) setIsLoading(snapshot.loading);
    if (snapshot.recovery_states?.includes('renderer_process_terminated')) {
      setError(t('workspace.browserRecoveryRendererStopped'));
    } else if (snapshot.error !== undefined) {
      setError(snapshot.error ?? null);
    }
    if (snapshot.session_status !== undefined) setSessionStatus(snapshot.session_status);
    if (snapshot.recovery_states !== undefined) setRecoveryStates([...snapshot.recovery_states]);
    if (snapshot.popup_active !== undefined) setPopupActive(snapshot.popup_active);
    if (snapshot.popup_url !== undefined) setPopupUrl(snapshot.popup_url ?? null);
    if (snapshot.popup_title !== undefined) setPopupTitle(snapshot.popup_title ?? null);
    if (snapshot.popup_loading !== undefined) setPopupLoading(snapshot.popup_loading);
    if (snapshot.popup_error !== undefined) setPopupError(snapshot.popup_error ?? null);
  }, [t]);

  const readViewport = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return null;
    return buildNativeBrowserBounds(frame.getBoundingClientRect(), readCurrentAppZoom());
  }, []);

  const syncLoginSurface = useCallback((requestedVisible = true) => {
    return loginSurfaceOrdering.enqueue(async (clientRevision) => {
      if (surfaceClosingRef.current) return;
      const lease = surfaceLeaseRef.current;
      const viewport = readViewport();
      if (!lease || !viewport) return;
      const visible = requestedVisible
        && !surfaceOccludedRef.current
        && !nativeSurfaceOcclusionStore.isOccluded();
      await browserSurfaceClient.sync({
        leaseId: lease.leaseId,
        generation: lease.generation,
        clientRevision,
        viewport,
        visible,
      });
    });
  }, [loginSurfaceOrdering, readViewport]);

  const setNativeSurfaceVisible = useCallback(async (requestedVisible: boolean) => {
    const visible = requestedVisible
      && !surfaceOccludedRef.current
      && !nativeSurfaceOcclusionStore.isOccluded();
    if (backend === 'login') {
      await syncLoginSurface(visible);
      return;
    }
    previewDesiredVisibilityRef.current = visible;
    await runPreviewSurfaceMutation(async () => {
      if (!previewSurfaceReadyRef.current) return;
      await invoke('browser_set_visible', { sessionId, visible });
    });
  }, [backend, runPreviewSurfaceMutation, sessionId, syncLoginSurface]);

  const pausePreviewForOcclusion = useCallback(async () => {
    if (backend !== 'preview' || pausedRef.current) return;
    const info = await invoke<BrowserInfo>('browser_set_paused', {
      sessionId,
      paused: true,
    });
    applyBrowserInfo(info);
  }, [applyBrowserInfo, backend, sessionId]);

  const occludeLoginSurface = useCallback(async () => {
    if (backend !== 'login' || surfaceClosingRef.current) return;
    const lease = surfaceLeaseRef.current;
    if (!lease) return;
    const response = await loginSurfaceOrdering.enqueue((clientRevision) => (
      browserSurfaceClient.control({
        leaseId: lease.leaseId,
        generation: lease.generation,
        clientRevision,
        action: 'occlude',
      })
    ));
    applyBrowserSurfaceMutationResponseForLease(
      loginSurfaceOrdering,
      surfaceLeaseRef.current,
      lease,
      response,
      applySurfaceSnapshot,
    );
  }, [applySurfaceSnapshot, backend, loginSurfaceOrdering]);

  useNativeSurfaceOcclusionParticipant(createBrowserPanelNativeSurfaceParticipant({
    backend,
    preparePreviewHide: () => {
      previewDesiredVisibilityRef.current = false;
    },
    pausePreview: pausePreviewForOcclusion,
    hidePreview: () => setNativeSurfaceVisible(false),
    occludeLogin: occludeLoginSurface,
    restore: () => setNativeSurfaceVisible(!surfaceOccludedRef.current),
  }));

  const syncBounds = useCallback(() => {
    if (syncFrameRef.current !== null) {
      cancelAnimationFrame(syncFrameRef.current);
    }

    syncFrameRef.current = requestAnimationFrame(() => {
      syncFrameRef.current = null;
      const bounds = readViewport();
      if (!bounds) return;
      const sync = backend === 'login'
        ? syncLoginSurface()
        : runPreviewSurfaceMutation(() => invoke('browser_set_bounds', { sessionId, ...bounds }));
      void sync.catch((boundsError) => {
        console.error('Failed to sync browser bounds:', boundsError);
      });
    });
  }, [backend, readViewport, runPreviewSurfaceMutation, sessionId, syncLoginSurface]);

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
    if (backend !== 'preview') return;
    setIsBusy(true);
    setError(null);
    try {
      const result = await runPreviewSurfaceMutation(() => invoke<BrowserInfo>('browser_open', {
        sessionId,
        url: url || null,
        visible: false,
      }));
      if (!result.applied) return;
      const info = result.value;
      previewSurfaceReadyRef.current = true;
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
  }, [applyBrowserInfo, backend, refreshInfo, runPreviewSurfaceMutation, sessionId, showBrowserError, syncBounds]);

  useEffect(() => {
    if (backend !== 'preview') return;
    previewSurfaceReadyRef.current = false;
    previewDesiredVisibilityRef.current = !surfaceOccludedRef.current
      && !nativeSurfaceOcclusionStore.isOccluded();
    void openBrowser(defaultUrl)
      .then(() => setNativeSurfaceVisible(previewDesiredVisibilityRef.current))
      .catch(() => {});
    void refreshRecentActivity().catch(() => {});

    return () => {
      previewSurfaceReadyRef.current = false;
      previewDesiredVisibilityRef.current = false;
      if (syncFrameRef.current !== null) {
        cancelAnimationFrame(syncFrameRef.current);
      }
    };
  }, [backend, defaultUrl, openBrowser, refreshRecentActivity, setNativeSurfaceVisible]);

  useEffect(() => {
    if (backend !== 'login') return;

    let disposed = false;
    let unlistenState: (() => void) | null = null;
    let unlistenHostShortcut: (() => void) | null = null;
    const pendingStates: BrowserSurfaceStateChangedEvent[] = [];
    setLifecycle('creating');
    setIsBusy(true);
    setError(null);
    surfaceLeaseRef.current = null;
    loginSurfaceOrdering.resetServerSequence();
    surfaceClosingRef.current = false;
    surfaceCloseSucceededRef.current = false;
    setIsClosingSurface(false);
    setSessionStatus('running');
    setRecoveryStates([]);
    setPopupActive(false);
    setPopupUrl(null);
    setPopupTitle(null);
    setPopupLoading(false);
    setPopupError(null);

    if (
      !loginWorkingDir?.trim()
      || !loginProfileMode
      || (loginProfileMode === 'saved' && !loginProfileId?.trim())
    ) {
      showBrowserError(t('workspace.browserSurfaceUnavailable'));
      setLifecycle('failed');
      setIsBusy(false);
      return;
    }

    const viewport = readViewport();
    if (!viewport) {
      showBrowserError(t('workspace.browserSurfaceUnavailable'));
      setLifecycle('failed');
      setIsBusy(false);
      return;
    }

    const profileSelection: BrowserSurfaceProfileSelection = loginProfileMode === 'saved'
      ? { profileMode: 'saved', profileId: loginProfileId!.trim() }
      : { profileMode: loginProfileMode };
    const acquireRequest = {
      panelSessionId: sessionId,
      backend: 'login' as const,
      workingDir: loginWorkingDir,
      ...profileSelection,
      initialUrl: defaultUrl,
      viewport,
    };

    const applySurfaceState = (state: BrowserSurfaceStateChangedEvent) => {
      const lease = surfaceLeaseRef.current;
      if (!browserSurfaceEventMatchesLease(lease, state)) return false;
      return loginSurfaceOrdering.applySequencedSnapshot(state.server_sequence, state.snapshot, applySurfaceSnapshot);
    };

    void (async () => {
      try {
        const nextStateUnlisten = await listen<BrowserSurfaceStateChangedEvent>(
          'browser_surface_state_changed',
          (event) => {
            if (disposed) return;
            if (!surfaceLeaseRef.current) {
              pendingStates.push(event.payload);
              if (pendingStates.length > 16) {
                pendingStates.sort((left, right) => right.server_sequence - left.server_sequence);
                pendingStates.length = 16;
              }
              return;
            }
            applySurfaceState(event.payload);
          },
        );
        if (disposed) {
          nextStateUnlisten();
          return;
        }
        unlistenState = nextStateUnlisten;

        const nextHostShortcutUnlisten = await listen<BrowserSurfaceHostShortcutEvent>(
          BROWSER_SURFACE_HOST_SHORTCUT_EVENT,
          (event) => {
            if (
              disposed
              || !browserSurfaceHostShortcutMatchesLease(
                surfaceLeaseRef.current,
                event.payload,
              )
            ) {
              return;
            }
            onHostShortcutRef.current?.(event.payload.action);
          },
        );
        if (disposed) {
          nextHostShortcutUnlisten();
          unlistenState?.();
          unlistenState = null;
          return;
        }
        unlistenHostShortcut = nextHostShortcutUnlisten;

        const lease = await loginSurfaceOrdering.enqueue((clientRevision) => (
          browserSurfaceClient.acquire({ ...acquireRequest, clientRevision })
        ));
        if (disposed) {
          await loginSurfaceOrdering.enqueue((clientRevision) => (
            browserSurfaceClient.release({
              leaseId: lease.lease_id,
              generation: lease.generation,
              clientRevision,
              disposition: 'close',
            })
          ));
          return;
        }
        const leaseIdentity = {
          leaseId: lease.lease_id,
          generation: lease.generation,
        };
        surfaceLeaseRef.current = leaseIdentity;
        loginSurfaceOrdering.applySequencedSnapshot(lease.server_sequence, lease.snapshot, applySurfaceSnapshot);
        const highestPendingState = highestSequencedSurfaceEventForLease(
          leaseIdentity,
          pendingStates,
        );
        if (highestPendingState) applySurfaceState(highestPendingState);
        pendingStates.length = 0;
        void syncLoginSurface().catch((syncError) => {
          console.error('Failed to sync login browser surface:', syncError);
        });
      } catch (acquireError) {
        if (!disposed) {
          unlistenState?.();
          unlistenState = null;
          unlistenHostShortcut?.();
          unlistenHostShortcut = null;
          setLifecycle('failed');
          showBrowserError(String(acquireError));
        } else {
          console.error('Failed to close a disposed login browser surface:', acquireError);
        }
      } finally {
        if (!disposed) setIsBusy(false);
      }
    })();

    return () => {
      disposed = true;
      unlistenState?.();
      unlistenHostShortcut?.();
      if (syncFrameRef.current !== null) {
        cancelAnimationFrame(syncFrameRef.current);
      }
      const lease = surfaceLeaseRef.current;
      surfaceLeaseRef.current = null;
      surfaceClosingRef.current = true;
      if (lease && !surfaceCloseSucceededRef.current) {
        void loginSurfaceOrdering.enqueue((clientRevision) => (
          browserSurfaceClient.release({
            leaseId: lease.leaseId,
            generation: lease.generation,
            clientRevision,
            disposition: 'close',
          })
        )).catch((closeError) => {
          console.error('Failed to close login browser surface during unmount:', closeError);
        });
      }
    };
  }, [
    applySurfaceSnapshot,
    backend,
    defaultUrl,
    loginSurfaceOrdering,
    loginProfileId,
    loginProfileMode,
    loginWorkingDir,
    readViewport,
    sessionId,
    showBrowserError,
    syncLoginSurface,
    t,
  ]);

  useEffect(() => {
    if (backend !== 'preview') return;
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
  }, [applyBrowserInfo, backend, refreshRecentActivity, sessionId]);

  useEffect(() => {
    void setNativeSurfaceVisible(!surfaceOccluded).catch(() => {});
  }, [setNativeSurfaceVisible, surfaceOccluded]);

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
    if (popupActive) {
      setIsUrlEditing(false);
    }
  }, [popupActive]);

  useNativeBrowserSurfaceGeometrySync(frameRef, syncBounds);

  const runBrowserCommand = useCallback(async (
    command: 'browser_back' | 'browser_forward' | 'browser_reload',
  ) => {
    if (backend !== 'preview') return;
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
  }, [applyBrowserInfo, backend, currentUrl, refreshInfo, sessionId, showBrowserError]);

  const navigate = useCallback(async (rawValue: string) => {
    if (backend === 'login' && popupActive) {
      showBrowserError(t('workspace.browserPopupCloseBeforeNavigate'));
      return;
    }
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
      if (backend === 'login') {
        const lease = surfaceLeaseRef.current;
        if (!lease) {
          throw new Error(t('workspace.browserSurfaceUnavailable'));
        }
        await loginSurfaceOrdering.enqueue((clientRevision) => (
          browserSurfaceClient.navigate({
            leaseId: lease.leaseId,
            generation: lease.generation,
            clientRevision,
            url: nextUrl,
          })
        ));
      } else {
        const info = await invoke<BrowserInfo>('browser_navigate', { sessionId, url: nextUrl });
        applyBrowserInfo(info, nextUrl);
      }
      setIsUrlEditing(false);
      if (backend === 'preview') {
        syncBounds();
        window.setTimeout(() => {
          void refreshInfo().catch(() => {});
        }, 700);
      }
    } catch (navigateError) {
      setCurrentUrl(previousUrl);
      setUrlInput(previousUrl ?? '');
      showBrowserError(String(navigateError));
    } finally {
      setIsBusy(false);
    }
  }, [
    applyBrowserInfo,
    backend,
    currentUrl,
    loginSurfaceOrdering,
    refreshInfo,
    sessionId,
    showBrowserError,
    syncBounds,
    t,
    popupActive,
  ]);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void navigate(urlInput);
  }, [navigate, urlInput]);

  const handleClose = useCallback(async () => {
    if (backend === 'preview') {
      onClose();
      return;
    }
    if (surfaceClosingRef.current) return;

    const lease = surfaceLeaseRef.current;
    if (!lease) {
      if (lifecycle === 'failed' || lifecycle === 'closed') {
        onClose();
      } else {
        showBrowserError(t('workspace.browserSurfaceUnavailable'));
      }
      return;
    }

    surfaceClosingRef.current = true;
    if (syncFrameRef.current !== null) {
      cancelAnimationFrame(syncFrameRef.current);
      syncFrameRef.current = null;
    }
    setIsClosingSurface(true);
    setError(null);
    try {
      await loginSurfaceOrdering.enqueue((clientRevision) => (
        browserSurfaceClient.release({
          leaseId: lease.leaseId,
          generation: lease.generation,
          clientRevision,
          disposition: 'close',
        })
      ));
      surfaceCloseSucceededRef.current = true;
      surfaceLeaseRef.current = null;
      onClose();
    } catch (closeError) {
      surfaceClosingRef.current = false;
      showBrowserError(String(closeError));
      setIsClosingSurface(false);
    }
  }, [backend, lifecycle, loginSurfaceOrdering, onClose, showBrowserError, t]);

  const cancelUrlEditing = useCallback(() => {
    setUrlInput(currentUrl ?? '');
    setIsUrlEditing(false);
  }, [currentUrl]);

  const handleStartUrlEditing = useCallback(() => {
    if (backend === 'login' && popupActive) return;
    setUrlInput(currentUrl ?? '');
    setIsUrlEditing(true);
  }, [backend, currentUrl, popupActive]);

  const handleOpenExternal = useCallback(() => {
    const targetUrl = popupActive ? popupUrl : currentUrl;
    if (!targetUrl) {
      return;
    }
    void openExternalUrl(targetUrl).catch((openError) => {
      showBrowserError(String(openError));
    });
  }, [currentUrl, popupActive, popupUrl, showBrowserError]);

  const handleToggleAgentControl = useCallback(async () => {
    if (backend !== 'preview') return;
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
  }, [applyBrowserInfo, backend, paused, sessionId, showBrowserError]);

  const handleLoginControl = useCallback(async (
    action: 'handoff' | 'pause' | 'takeover',
  ) => {
    if (backend !== 'login' || isLoginControlBusy) return;
    const lease = surfaceLeaseRef.current;
    if (!lease) {
      showBrowserError(t('workspace.browserSurfaceUnavailable'));
      return;
    }
    setIsLoginControlBusy(true);
    setError(null);
    try {
      const response = await loginSurfaceOrdering.enqueue((clientRevision) => (
        browserSurfaceClient.control({
          leaseId: lease.leaseId,
          generation: lease.generation,
          clientRevision,
          action,
        })
      ));
      applyBrowserSurfaceMutationResponseForLease(loginSurfaceOrdering, surfaceLeaseRef.current, lease, response, applySurfaceSnapshot);
    } catch (controlError) {
      showBrowserError(String(controlError));
    } finally {
      setIsLoginControlBusy(false);
    }
  }, [
    applySurfaceSnapshot,
    backend,
    isLoginControlBusy,
    loginSurfaceOrdering,
    showBrowserError,
    t,
  ]);

  const handleClosePopup = useCallback(async () => {
    if (backend !== 'login' || isPopupCloseBusy) return;
    const lease = surfaceLeaseRef.current;
    if (!lease) {
      showBrowserError(t('workspace.browserSurfaceUnavailable'));
      return;
    }
    setIsPopupCloseBusy(true);
    setPopupError(null);
    try {
      const response = await loginSurfaceOrdering.enqueue((clientRevision) => (
        browserSurfaceClient.closePopup({
          leaseId: lease.leaseId,
          generation: lease.generation,
          clientRevision,
        })
      ));
      applyBrowserSurfaceMutationResponseForLease(loginSurfaceOrdering, surfaceLeaseRef.current, lease, response, applySurfaceSnapshot);
    } catch (popupCloseError) {
      showBrowserError(String(popupCloseError));
    } finally {
      setIsPopupCloseBusy(false);
    }
  }, [
    applySurfaceSnapshot,
    backend,
    isPopupCloseBusy,
    loginSurfaceOrdering,
    showBrowserError,
    t,
  ]);

  const panelTitle = backend === 'login'
    ? t('workspace.loginBrowser')
    : t('workspace.previewBrowser');
  const effectiveUrl = popupActive ? popupUrl : currentUrl;
  const displayUrl = effectiveUrl || (popupActive ? popupTitle : title) || panelTitle;
  const recentActivityCount = recentActivity.artifacts.length
    + (recentActivity.console_log_path ? 1 : 0)
    + (recentActivity.audit_log_path ? 1 : 0);

  return (
    <aside
      data-ccem-browser-panel="true"
      data-ccem-browser-backend={backend}
      data-ccem-browser-lifecycle={lifecycle}
      data-ccem-browser-control={control}
      data-ccem-browser-paused={paused ? 'true' : 'false'}
      data-ccem-browser-session-status={sessionStatus}
      data-ccem-browser-recovery={recoveryStates.join(',') || 'none'}
      data-ccem-browser-popup={popupActive ? 'active' : 'none'}
      data-ccem-browser-occluded={surfaceOccluded ? 'true' : 'false'}
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
        <BrowserPanelTabStrip
          backend={backend}
          panelTitle={panelTitle}
          sessionStatus={sessionStatus}
          recoveryStates={recoveryStates}
          popupActive={popupActive}
          lifecycle={lifecycle}
          control={control}
          paused={paused}
          recentActivity={recentActivity}
          recentActivityCount={recentActivityCount}
          browserAgentControllingLabel={t('workspace.browserAgentControlling')}
          browserRecentArtifactsLabel={t('workspace.browserRecentArtifacts')}
          spinnerActive={isBusy || isLoading || popupLoading || isClosingSurface
            || isLoginControlBusy || isPopupCloseBusy}
          isPauseBusy={isPauseBusy}
          isLoginControlBusy={isLoginControlBusy}
          isPopupCloseBusy={isPopupCloseBusy}
          isClosingSurface={isClosingSurface}
          t={t}
          onRefreshRecentActivity={() => void refreshRecentActivity().catch(() => {})}
          onCopyActivityPath={(path) => void copyActivityPath(path)}
          onToggleAgentControl={() => void handleToggleAgentControl()}
          onClosePopup={() => void handleClosePopup()}
          onLoginControl={(action) => void handleLoginControl(action)}
          onClose={() => void handleClose()}
        />
      </div>

      <BrowserPanelNavigation
        backend={backend}
        isBusy={isBusy}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        effectiveUrl={effectiveUrl}
        popupActive={popupActive}
        isUrlEditing={isUrlEditing}
        urlInputRef={urlInputRef}
        urlInput={urlInput}
        displayUrl={displayUrl}
        t={t}
        onBrowserCommand={(command) => void runBrowserCommand(command)}
        onOpenExternal={handleOpenExternal}
        onSubmit={handleSubmit}
        onUrlInputChange={setUrlInput}
        onCancelUrlEditing={cancelUrlEditing}
        onStartUrlEditing={handleStartUrlEditing}
      />

      {error || popupError ? (
        <div className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {popupError || error}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 bg-white">
        <div ref={frameRef} data-ccem-browser-frame="true" className="absolute inset-y-0 right-0 left-1.5" />
      </div>
    </aside>
  );
}
