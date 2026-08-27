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
  type BrowserSurfaceLeaseIdentity,
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
import { buildNativeBrowserBounds, normalizeBrowserBoundsZoom } from './browserPanelGeometry';
import { BrowserPanelNavigation, BrowserPanelTabStrip } from './BrowserPanelChrome';

interface BrowserPanelSharedProps {
  backend: 'login';
  sessionId: string;
  workingDir: string;
  defaultUrl?: string | null;
  /** Workspace-wide visibility epoch captured by each render/effect. */
  presentationRevision?: number;
  className?: string;
  style?: CSSProperties;
  /** The one conversation whose native child surface may currently be visible. */
  isActiveSurface?: boolean;
  surfaceOccluded?: boolean;
  /** Active native runtime whose opaque actor lineage owns Agent control. */
  agentSessionId?: string;
  onResizeStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onHostShortcut?: (action: BrowserSurfaceHostShortcutAction) => void;
  onClose: () => void;
}

type BrowserPanelProps = BrowserPanelSharedProps & BrowserSurfaceProfileSelection;
type BrowserPanelLifecycle = NonNullable<BrowserSurfaceSnapshot['lifecycle']>;
type BrowserPanelControl = NonNullable<BrowserSurfaceSnapshot['control']>;

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
  if (!trimmed) return '';

  if (/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(:\d+)?(\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (/^[a-z][a-z\d+\-.]*:/i.test(trimmed)) return trimmed;
  if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(trimmed) || trimmed.includes('.')) {
    return `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

export function BrowserPanel({
  sessionId,
  workingDir,
  profileMode,
  profileId,
  defaultUrl = null,
  presentationRevision = 0,
  className,
  style,
  isActiveSurface = true,
  surfaceOccluded = false,
  agentSessionId,
  onResizeStart,
  onHostShortcut,
  onClose,
}: BrowserPanelProps) {
  const { t } = useLocale();
  const tRef = useRef(t);
  tRef.current = t;

  const frameRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const syncFrameRef = useRef<number | null>(null);
  const isUrlEditingRef = useRef(false);
  const surfaceLeaseRef = useRef<BrowserSurfaceLeaseIdentity | null>(null);
  const surfaceOrderingRef = useRef<BrowserSurfaceOrdering | null>(null);
  if (!surfaceOrderingRef.current) surfaceOrderingRef.current = createBrowserSurfaceOrdering();
  const surfaceOrdering = surfaceOrderingRef.current;
  const surfaceClosingRef = useRef(false);
  const surfaceCloseSucceededRef = useRef(false);
  const onHostShortcutRef = useRef(onHostShortcut);
  onHostShortcutRef.current = onHostShortcut;
  const presentationRevisionRef = useRef(presentationRevision);
  presentationRevisionRef.current = presentationRevision;
  const initialUrlRef = useRef(defaultUrl);
  const isActiveSurfaceRef = useRef(isActiveSurface);
  isActiveSurfaceRef.current = isActiveSurface;
  const surfaceOccludedRef = useRef(surfaceOccluded);
  surfaceOccludedRef.current = surfaceOccluded;

  const loginAgentSessionId = agentSessionId?.trim() || undefined;
  const loginProfileId = profileMode === 'saved' ? profileId : undefined;
  const [currentUrl, setCurrentUrl] = useState<string | null>(defaultUrl ?? null);
  const [urlInput, setUrlInput] = useState(defaultUrl ?? '');
  const [isUrlEditing, setIsUrlEditing] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<BrowserPanelLifecycle>('creating');
  const [control, setControl] = useState<BrowserPanelControl>('user');
  const [paused, setPaused] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<'running' | 'closing' | 'cleanup_required'>('running');
  const [recoveryStates, setRecoveryStates] = useState<BrowserSurfaceRecoveryState[]>([]);
  const [popupActive, setPopupActive] = useState(false);
  const [popupUrl, setPopupUrl] = useState<string | null>(null);
  const [popupTitle, setPopupTitle] = useState<string | null>(null);
  const [popupLoading, setPopupLoading] = useState(false);
  const [popupError, setPopupError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoginControlBusy, setIsLoginControlBusy] = useState(false);
  const [isPopupCloseBusy, setIsPopupCloseBusy] = useState(false);
  const [isClosingSurface, setIsClosingSurface] = useState(false);
  const [isSurfaceReady, setIsSurfaceReady] = useState(false);

  const applySurfaceSnapshot = useCallback((snapshot?: BrowserSurfaceSnapshot | null) => {
    if (!snapshot) return;
    if (snapshot.url !== undefined) {
      setCurrentUrl(snapshot.url ?? null);
      if (!isUrlEditingRef.current) setUrlInput(snapshot.url ?? '');
    }
    if (snapshot.title !== undefined) setTitle(snapshot.title ?? null);
    if (snapshot.lifecycle !== undefined) setLifecycle(snapshot.lifecycle);
    if (snapshot.control !== undefined) setControl(snapshot.control);
    if (snapshot.paused !== undefined) setPaused(snapshot.paused);
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

  const syncSurface = useCallback((
    requestedVisible: boolean,
    requestedPresentationRevision: number,
  ) => surfaceOrdering.enqueue(async (clientRevision) => {
    if (surfaceClosingRef.current) return;
    const lease = surfaceLeaseRef.current;
    const visible = requestedVisible
      && isActiveSurfaceRef.current
      && !surfaceOccludedRef.current
      && !nativeSurfaceOcclusionStore.isOccluded();
    const viewport = visible ? readViewport() : undefined;
    if (!lease || (visible && !viewport)) return;
    await browserSurfaceClient.sync({
      leaseId: lease.leaseId,
      generation: lease.generation,
      clientRevision,
      ...(viewport ? { viewport } : {}),
      visible,
      presentationRevision: requestedPresentationRevision,
    });
  }), [readViewport, surfaceOrdering]);

  const setNativeSurfaceVisible = useCallback((requestedVisible: boolean) => (
    syncSurface(requestedVisible, presentationRevision)
  ), [presentationRevision, syncSurface]);

  const occludeSurface = useCallback(async () => {
    if (!isActiveSurfaceRef.current || surfaceClosingRef.current) return;
    const lease = surfaceLeaseRef.current;
    if (!lease) return;
    const response = await surfaceOrdering.enqueue((clientRevision) => (
      browserSurfaceClient.control({
        leaseId: lease.leaseId,
        generation: lease.generation,
        clientRevision,
        action: 'occlude',
      })
    ));
    applyBrowserSurfaceMutationResponseForLease(
      surfaceOrdering,
      surfaceLeaseRef.current,
      lease,
      response,
      applySurfaceSnapshot,
    );
  }, [applySurfaceSnapshot, surfaceOrdering]);

  useNativeSurfaceOcclusionParticipant(createBrowserPanelNativeSurfaceParticipant({
    isActive: () => isActiveSurfaceRef.current,
    occlude: occludeSurface,
    restore: () => setNativeSurfaceVisible(!surfaceOccludedRef.current),
  }), isActiveSurface);

  const syncBounds = useCallback(() => {
    if (!isActiveSurfaceRef.current) return;
    if (syncFrameRef.current !== null) cancelAnimationFrame(syncFrameRef.current);
    syncFrameRef.current = requestAnimationFrame(() => {
      syncFrameRef.current = null;
      if (!readViewport()) return;
      void syncSurface(true, presentationRevision).catch((boundsError) => {
        console.error('Failed to sync browser bounds:', boundsError);
      });
    });
  }, [presentationRevision, readViewport, syncSurface]);

  const showBrowserError = useCallback((message: string) => {
    setIsLoading(false);
    setError(message);
    toast.error(message);
  }, []);

  const lifecycleActionsRef = useRef({
    applySurfaceSnapshot,
    readViewport,
    showBrowserError,
    syncSurface,
  });
  lifecycleActionsRef.current = {
    applySurfaceSnapshot,
    readViewport,
    showBrowserError,
    syncSurface,
  };

  useEffect(() => {
    let disposed = false;
    let unlistenState: (() => void) | null = null;
    let unlistenHostShortcut: (() => void) | null = null;
    const pendingStates: BrowserSurfaceStateChangedEvent[] = [];
    setLifecycle('creating');
    setIsSurfaceReady(false);
    setIsBusy(true);
    setError(null);
    surfaceLeaseRef.current = null;
    surfaceOrdering.resetServerSequence();
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

    if (!workingDir.trim() || (profileMode === 'saved' && !loginProfileId?.trim())) {
      lifecycleActionsRef.current.showBrowserError(
        tRef.current('workspace.browserSurfaceUnavailable'),
      );
      setLifecycle('failed');
      setIsBusy(false);
      return;
    }

    const viewport = lifecycleActionsRef.current.readViewport();
    if (!viewport) {
      lifecycleActionsRef.current.showBrowserError(
        tRef.current('workspace.browserSurfaceUnavailable'),
      );
      setLifecycle('failed');
      setIsBusy(false);
      return;
    }

    const profileSelection: BrowserSurfaceProfileSelection = profileMode === 'saved'
      ? { profileMode: 'saved', profileId: loginProfileId!.trim() }
      : { profileMode };
    const acquireRequest = {
      panelSessionId: sessionId,
      backend: 'login' as const,
      workingDir: workingDir.trim(),
      ...profileSelection,
      initialUrl: initialUrlRef.current,
      viewport,
    };

    const applySurfaceState = (state: BrowserSurfaceStateChangedEvent) => {
      const lease = surfaceLeaseRef.current;
      if (!browserSurfaceEventMatchesLease(lease, state)) return false;
      return surfaceOrdering.applySequencedSnapshot(
        state.server_sequence,
        state.snapshot,
        lifecycleActionsRef.current.applySurfaceSnapshot,
      );
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
              || !isActiveSurfaceRef.current
              || !browserSurfaceHostShortcutMatchesLease(surfaceLeaseRef.current, event.payload)
            ) return;
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

        const lease = await surfaceOrdering.enqueue((clientRevision) => (
          browserSurfaceClient.acquire({ ...acquireRequest, clientRevision })
        ));
        if (disposed) {
          await surfaceOrdering.enqueue((clientRevision) => (
            browserSurfaceClient.release({
              leaseId: lease.lease_id,
              generation: lease.generation,
              clientRevision,
              disposition: 'close',
            })
          ));
          return;
        }
        const leaseIdentity: BrowserSurfaceLeaseIdentity = {
          leaseId: lease.lease_id,
          generation: lease.generation,
          surfaceId: lease.surface_id,
        };
        surfaceLeaseRef.current = leaseIdentity;
        setIsSurfaceReady(true);
        surfaceOrdering.applySequencedSnapshot(
          lease.server_sequence,
          lease.snapshot,
          lifecycleActionsRef.current.applySurfaceSnapshot,
        );
        const highestPendingState = highestSequencedSurfaceEventForLease(
          leaseIdentity,
          pendingStates,
        );
        if (highestPendingState) applySurfaceState(highestPendingState);
        pendingStates.length = 0;
        void lifecycleActionsRef.current.syncSurface(
          true,
          presentationRevisionRef.current,
        ).catch((syncError) => {
          console.error('Failed to sync browser surface:', syncError);
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
          console.error('Failed to close a disposed browser surface:', acquireError);
        }
      } finally {
        if (!disposed) setIsBusy(false);
      }
    })();

    return () => {
      disposed = true;
      unlistenState?.();
      unlistenHostShortcut?.();
      if (syncFrameRef.current !== null) cancelAnimationFrame(syncFrameRef.current);
      const lease = surfaceLeaseRef.current;
      surfaceLeaseRef.current = null;
      setIsSurfaceReady(false);
      surfaceClosingRef.current = true;
      if (lease && !surfaceCloseSucceededRef.current) {
        void surfaceOrdering.enqueue((clientRevision) => (
          browserSurfaceClient.release({
            leaseId: lease.leaseId,
            generation: lease.generation,
            clientRevision,
            disposition: 'close',
          })
        )).catch((closeError) => {
          console.error('Failed to close browser surface during unmount:', closeError);
        });
      }
    };
  }, [loginProfileId, profileMode, sessionId, showBrowserError, surfaceOrdering, workingDir]);

  useEffect(() => {
    if (!isSurfaceReady) return;
    void setNativeSurfaceVisible(isActiveSurface && !surfaceOccluded).catch(() => {});
  }, [isActiveSurface, isSurfaceReady, setNativeSurfaceVisible, surfaceOccluded]);

  useEffect(() => {
    isUrlEditingRef.current = isUrlEditing;
    if (!isUrlEditing) return;
    const timeoutId = window.setTimeout(() => {
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [isUrlEditing]);

  useEffect(() => {
    if (popupActive) setIsUrlEditing(false);
  }, [popupActive]);

  useNativeBrowserSurfaceGeometrySync(frameRef, syncBounds, isActiveSurface);

  const navigate = useCallback(async (rawValue: string) => {
    if (popupActive) {
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
      const lease = surfaceLeaseRef.current;
      if (!lease) throw new Error(t('workspace.browserSurfaceUnavailable'));
      await surfaceOrdering.enqueue((clientRevision) => (
        browserSurfaceClient.navigate({
          leaseId: lease.leaseId,
          generation: lease.generation,
          clientRevision,
          url: nextUrl,
        })
      ));
      setIsUrlEditing(false);
    } catch (navigateError) {
      setCurrentUrl(previousUrl);
      setUrlInput(previousUrl ?? '');
      showBrowserError(String(navigateError));
    } finally {
      setIsBusy(false);
    }
  }, [currentUrl, popupActive, showBrowserError, surfaceOrdering, t]);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void navigate(urlInput);
  }, [navigate, urlInput]);

  const handleClose = useCallback(async () => {
    if (surfaceClosingRef.current) return;
    const lease = surfaceLeaseRef.current;
    if (!lease) {
      if (lifecycle === 'failed' || lifecycle === 'closed') onClose();
      else showBrowserError(t('workspace.browserSurfaceUnavailable'));
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
      await surfaceOrdering.enqueue((clientRevision) => (
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
  }, [lifecycle, onClose, showBrowserError, surfaceOrdering, t]);

  const cancelUrlEditing = useCallback(() => {
    setUrlInput(currentUrl ?? '');
    setIsUrlEditing(false);
  }, [currentUrl]);

  const handleStartUrlEditing = useCallback(() => {
    if (popupActive) return;
    setUrlInput(currentUrl ?? '');
    setIsUrlEditing(true);
  }, [currentUrl, popupActive]);

  const handleOpenExternal = useCallback(() => {
    const targetUrl = popupActive ? popupUrl : currentUrl;
    if (!targetUrl) return;
    void openExternalUrl(targetUrl).catch((openError) => {
      showBrowserError(String(openError));
    });
  }, [currentUrl, popupActive, popupUrl, showBrowserError]);

  const handleLoginControl = useCallback(async (
    action: 'handoff' | 'pause' | 'takeover',
  ) => {
    if (isLoginControlBusy) return;
    const controlIntent = action === 'handoff'
      ? (loginAgentSessionId ? { action, agentSessionId: loginAgentSessionId } as const : null)
      : { action };
    if (!controlIntent) {
      showBrowserError(t('loginBrowserControl.unavailable'));
      return;
    }
    const lease = surfaceLeaseRef.current;
    if (!lease) {
      showBrowserError(t('workspace.browserSurfaceUnavailable'));
      return;
    }
    setIsLoginControlBusy(true);
    setError(null);
    try {
      const response = await surfaceOrdering.enqueue((clientRevision) => (
        browserSurfaceClient.control({
          leaseId: lease.leaseId,
          generation: lease.generation,
          clientRevision,
          ...controlIntent,
        })
      ));
      applyBrowserSurfaceMutationResponseForLease(
        surfaceOrdering,
        surfaceLeaseRef.current,
        lease,
        response,
        applySurfaceSnapshot,
      );
    } catch (controlError) {
      showBrowserError(String(controlError));
    } finally {
      setIsLoginControlBusy(false);
    }
  }, [applySurfaceSnapshot, isLoginControlBusy, loginAgentSessionId, showBrowserError, surfaceOrdering, t]);

  const handleClosePopup = useCallback(async () => {
    if (isPopupCloseBusy) return;
    const lease = surfaceLeaseRef.current;
    if (!lease) {
      showBrowserError(t('workspace.browserSurfaceUnavailable'));
      return;
    }
    setIsPopupCloseBusy(true);
    setPopupError(null);
    try {
      const response = await surfaceOrdering.enqueue((clientRevision) => (
        browserSurfaceClient.closePopup({
          leaseId: lease.leaseId,
          generation: lease.generation,
          clientRevision,
        })
      ));
      applyBrowserSurfaceMutationResponseForLease(
        surfaceOrdering,
        surfaceLeaseRef.current,
        lease,
        response,
        applySurfaceSnapshot,
      );
    } catch (popupCloseError) {
      showBrowserError(String(popupCloseError));
    } finally {
      setIsPopupCloseBusy(false);
    }
  }, [applySurfaceSnapshot, isPopupCloseBusy, showBrowserError, surfaceOrdering, t]);

  const panelTitle = t('workspace.browserTitle');
  const effectiveUrl = popupActive ? popupUrl : currentUrl;
  const displayUrl = effectiveUrl || (popupActive ? popupTitle : title) || panelTitle;

  return (
    <aside
      data-ccem-browser-panel="true"
      data-ccem-browser-backend="login"
      data-ccem-browser-lifecycle={lifecycle}
      data-ccem-browser-control={control}
      data-ccem-browser-paused={paused ? 'true' : 'false'}
      data-ccem-browser-session-status={sessionStatus}
      data-ccem-browser-recovery={recoveryStates.join(',') || 'none'}
      data-ccem-browser-popup={popupActive ? 'active' : 'none'}
      data-ccem-browser-active={isActiveSurface ? 'true' : 'false'}
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
          panelTitle={panelTitle}
          sessionStatus={sessionStatus}
          recoveryStates={recoveryStates}
          popupActive={popupActive}
          lifecycle={lifecycle}
          control={control}
          paused={paused}
          browserAgentControllingLabel={t('workspace.browserAgentControlling')}
          spinnerActive={isBusy || isLoading || popupLoading || isClosingSurface
            || isLoginControlBusy || isPopupCloseBusy}
          isLoginControlBusy={isLoginControlBusy}
          canHandoffAgent={Boolean(loginAgentSessionId)}
          isPopupCloseBusy={isPopupCloseBusy}
          isClosingSurface={isClosingSurface}
          t={t}
          onClosePopup={() => void handleClosePopup()}
          onLoginControl={(action) => void handleLoginControl(action)}
          onClose={() => void handleClose()}
        />
      </div>

      <BrowserPanelNavigation
        effectiveUrl={effectiveUrl}
        popupActive={popupActive}
        isUrlEditing={isUrlEditing}
        urlInputRef={urlInputRef}
        urlInput={urlInput}
        displayUrl={displayUrl}
        t={t}
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
