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
  type BrowserSurfaceNavigationAction,
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

class BrowserControlSupersededError extends Error {}
class BrowserNavigationSupersededError extends Error {}

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
  const manualNavigationBusyRef = useRef(false);
  const autoHandoffAttemptedLeaseRef = useRef<string | null>(null);
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
  const loginAgentSessionIdRef = useRef(loginAgentSessionId);
  loginAgentSessionIdRef.current = loginAgentSessionId;
  const loginProfileId = profileMode === 'saved' ? profileId : undefined;
  const [currentUrl, setCurrentUrl] = useState<string | null>(defaultUrl ?? null);
  const authoritativeUrlRef = useRef<string | null>(null);
  const [urlInput, setUrlInput] = useState(defaultUrl ?? '');
  const [isUrlEditing, setIsUrlEditing] = useState(false);
  const [title, setTitle] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<BrowserPanelLifecycle>('creating');
  const [control, setControl] = useState<BrowserPanelControl>('user');
  const [autoHandoff, setAutoHandoff] = useState(true);
  const [paused, setPaused] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<'running' | 'closing' | 'cleanup_required'>('running');
  const [recoveryStates, setRecoveryStates] = useState<BrowserSurfaceRecoveryState[]>([]);
  const [popupActive, setPopupActive] = useState(false);
  const [popupUrl, setPopupUrl] = useState<string | null>(null);
  const [popupTitle, setPopupTitle] = useState<string | null>(null);
  const [popupLoading, setPopupLoading] = useState(false);
  const [popupError, setPopupError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isLoginControlBusy, setIsLoginControlBusy] = useState(false);
  const [isPopupCloseBusy, setIsPopupCloseBusy] = useState(false);
  const [isClosingSurface, setIsClosingSurface] = useState(false);
  const [isSurfaceReady, setIsSurfaceReady] = useState(false);
  const controlRef = useRef(control);
  controlRef.current = control;
  const autoHandoffRef = useRef(autoHandoff);
  autoHandoffRef.current = autoHandoff;
  const lifecycleRef = useRef(lifecycle);
  lifecycleRef.current = lifecycle;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const isLoginControlBusyRef = useRef(isLoginControlBusy);
  isLoginControlBusyRef.current = isLoginControlBusy;
  const sessionStatusRef = useRef(sessionStatus);
  sessionStatusRef.current = sessionStatus;
  const popupActiveRef = useRef(popupActive);
  popupActiveRef.current = popupActive;
  const rendererRecoveryErrorRef = useRef(false);
  const occludedAgentResumeRef = useRef<({
    leaseId: string;
    generation: number;
    agentSessionId: string;
  }) | null>(null);
  const resumeAgentAfterOcclusionRef = useRef<() => Promise<void>>(async () => {});

  const applySurfaceSnapshot = useCallback((snapshot?: BrowserSurfaceSnapshot | null) => {
    if (!snapshot) return;
    if (snapshot.url !== undefined) {
      authoritativeUrlRef.current = snapshot.url ?? null;
      setCurrentUrl(snapshot.url ?? null);
      if (!isUrlEditingRef.current) setUrlInput(snapshot.url ?? '');
    }
    if (snapshot.title !== undefined) setTitle(snapshot.title ?? null);
    if (snapshot.lifecycle !== undefined) {
      lifecycleRef.current = snapshot.lifecycle;
      setLifecycle(snapshot.lifecycle);
    }
    if (snapshot.control !== undefined) {
      controlRef.current = snapshot.control;
      setControl(snapshot.control);
      if (snapshot.control === 'user') {
        occludedAgentResumeRef.current = null;
      }
    }
    if (snapshot.auto_handoff !== undefined) {
      autoHandoffRef.current = snapshot.auto_handoff;
      setAutoHandoff(snapshot.auto_handoff);
      if (!snapshot.auto_handoff) {
        occludedAgentResumeRef.current = null;
      }
    }
    if (snapshot.paused !== undefined) setPaused(snapshot.paused);
    if (snapshot.loading !== undefined) {
      isLoadingRef.current = snapshot.loading;
      setIsLoading(snapshot.loading);
    }
    if (snapshot.can_go_back !== undefined) setCanGoBack(snapshot.can_go_back);
    if (snapshot.can_go_forward !== undefined) setCanGoForward(snapshot.can_go_forward);
    const nextRecoveryStates = snapshot.recovery_states ?? [];
    setRecoveryStates([...nextRecoveryStates]);
    if (nextRecoveryStates.includes('renderer_process_terminated')) {
      rendererRecoveryErrorRef.current = true;
      setError(t('workspace.browserRecoveryRendererStopped'));
    } else if (snapshot.error !== undefined) {
      rendererRecoveryErrorRef.current = false;
      setError(snapshot.error ?? null);
    } else if (rendererRecoveryErrorRef.current) {
      rendererRecoveryErrorRef.current = false;
      setError(null);
    }
    if (snapshot.session_status !== undefined) {
      sessionStatusRef.current = snapshot.session_status;
      setSessionStatus(snapshot.session_status);
    }
    if (snapshot.popup_active !== undefined) {
      popupActiveRef.current = snapshot.popup_active;
      setPopupActive(snapshot.popup_active);
    }
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
    const agentSessionId = loginAgentSessionIdRef.current;
    const existingResume = occludedAgentResumeRef.current;
    if (controlRef.current === 'agent' && agentSessionId) {
      occludedAgentResumeRef.current = { ...lease, agentSessionId };
    } else if (!(
      controlRef.current === 'paused'
      && existingResume?.leaseId === lease.leaseId
      && existingResume.generation === lease.generation
      && existingResume.agentSessionId === agentSessionId
    )) {
      occludedAgentResumeRef.current = null;
    }
    try {
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
    } catch (occlusionError) {
      const pendingResume = occludedAgentResumeRef.current;
      if (
        pendingResume?.leaseId === lease.leaseId
        && pendingResume.generation === lease.generation
      ) {
        occludedAgentResumeRef.current = null;
      }
      throw occlusionError;
    }
  }, [applySurfaceSnapshot, surfaceOrdering]);

  useNativeSurfaceOcclusionParticipant(createBrowserPanelNativeSurfaceParticipant({
    isActive: () => isActiveSurfaceRef.current,
    occlude: occludeSurface,
    restore: async () => {
      await setNativeSurfaceVisible(!surfaceOccludedRef.current);
      await resumeAgentAfterOcclusionRef.current();
    },
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

  const showLifecycleError = useCallback((message: string) => {
    setIsLoading(false);
    rendererRecoveryErrorRef.current = false;
    setError(message);
  }, []);

  const showActionError = useCallback((message: string) => {
    toast.error(message);
  }, []);

  const lifecycleActionsRef = useRef({
    applySurfaceSnapshot,
    readViewport,
    showLifecycleError,
    syncSurface,
  });
  lifecycleActionsRef.current = {
    applySurfaceSnapshot,
    readViewport,
    showLifecycleError,
    syncSurface,
  };

  useEffect(() => {
    let disposed = false;
    let unlistenState: (() => void) | null = null;
    let unlistenHostShortcut: (() => void) | null = null;
    const pendingStates: BrowserSurfaceStateChangedEvent[] = [];
    setLifecycle('creating');
    authoritativeUrlRef.current = null;
    setIsSurfaceReady(false);
    setIsBusy(true);
    setError(null);
    surfaceLeaseRef.current = null;
    surfaceOrdering.resetServerSequence();
    surfaceClosingRef.current = false;
    surfaceCloseSucceededRef.current = false;
    autoHandoffAttemptedLeaseRef.current = null;
    autoHandoffRef.current = true;
    setAutoHandoff(true);
    occludedAgentResumeRef.current = null;
    rendererRecoveryErrorRef.current = false;
    setIsClosingSurface(false);
    setSessionStatus('running');
    setRecoveryStates([]);
    setPopupActive(false);
    setPopupUrl(null);
    setPopupTitle(null);
    setPopupLoading(false);
    setPopupError(null);
    setCanGoBack(false);
    setCanGoForward(false);

    if (!workingDir.trim() || (profileMode === 'saved' && !loginProfileId?.trim())) {
      lifecycleActionsRef.current.showLifecycleError(
        tRef.current('workspace.browserSurfaceUnavailable'),
      );
      setLifecycle('failed');
      setIsBusy(false);
      return;
    }

    const viewport = lifecycleActionsRef.current.readViewport();
    if (!viewport) {
      lifecycleActionsRef.current.showLifecycleError(
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
          showLifecycleError(String(acquireError));
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
  }, [loginProfileId, profileMode, sessionId, showLifecycleError, surfaceOrdering, workingDir]);

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
    if (manualNavigationBusyRef.current) return;
    if (popupActive) {
      showActionError(t('workspace.browserPopupCloseBeforeNavigate'));
      return;
    }
    if (controlRef.current !== 'user') return;
    const nextUrl = normalizeBrowserInput(rawValue);
    if (!nextUrl) {
      setUrlInput(currentUrl ?? '');
      return;
    }
    const lease = surfaceLeaseRef.current;
    if (!lease) {
      showActionError(t('workspace.browserSurfaceUnavailable'));
      return;
    }
    const previousUrl = currentUrl;
    manualNavigationBusyRef.current = true;
    setIsBusy(true);
    setUrlInput(nextUrl);
    try {
      await surfaceOrdering.enqueue((clientRevision) => {
        const currentLease = surfaceLeaseRef.current;
        const leaseChanged = !currentLease
          || currentLease.leaseId !== lease.leaseId
          || currentLease.generation !== lease.generation;
        const navigationContextChanged = controlRef.current !== 'user'
          || lifecycleRef.current !== 'ready'
          || isLoadingRef.current
          || isLoginControlBusyRef.current
          || !isActiveSurfaceRef.current
          || surfaceOccludedRef.current
          || nativeSurfaceOcclusionStore.isOccluded()
          || popupActiveRef.current
          || sessionStatusRef.current !== 'running';
        if (leaseChanged || surfaceClosingRef.current || navigationContextChanged) {
          throw new BrowserNavigationSupersededError();
        }
        return browserSurfaceClient.navigate({
          leaseId: lease.leaseId,
          generation: lease.generation,
          clientRevision,
          url: nextUrl,
        });
      });
      setIsUrlEditing(false);
    } catch (navigateError) {
      const currentLease = surfaceLeaseRef.current;
      const leaseStillCurrent = currentLease?.leaseId === lease.leaseId
        && currentLease.generation === lease.generation
        && !surfaceClosingRef.current;
      if (leaseStillCurrent) {
        setUrlInput(authoritativeUrlRef.current ?? previousUrl ?? '');
        if (navigateError instanceof BrowserNavigationSupersededError) {
          setIsUrlEditing(false);
        }
      }
      if (!(navigateError instanceof BrowserNavigationSupersededError)) {
        showActionError(String(navigateError));
      }
    } finally {
      manualNavigationBusyRef.current = false;
      const currentLease = surfaceLeaseRef.current;
      if (
        currentLease?.leaseId === lease.leaseId
        && currentLease.generation === lease.generation
        && !surfaceClosingRef.current
      ) {
        setIsBusy(false);
      }
    }
  }, [currentUrl, popupActive, showActionError, surfaceOrdering, t]);

  const handleNavigationAction = useCallback(async (
    action: BrowserSurfaceNavigationAction,
  ) => {
    if (manualNavigationBusyRef.current) return;
    const lease = surfaceLeaseRef.current;
    if (!lease) {
      showActionError(t('workspace.browserSurfaceUnavailable'));
      return;
    }
    manualNavigationBusyRef.current = true;
    setIsBusy(true);
    try {
      const response = await surfaceOrdering.enqueue((clientRevision) => {
        const currentLease = surfaceLeaseRef.current;
        const leaseChanged = !currentLease
          || currentLease.leaseId !== lease.leaseId
          || currentLease.generation !== lease.generation;
        const navigationStateChanged = action === 'stop'
          ? lifecycleRef.current !== 'loading' || !isLoadingRef.current
          : lifecycleRef.current !== 'ready' || isLoadingRef.current;
        const navigationContextChanged = controlRef.current !== 'user'
          || navigationStateChanged
          || isLoginControlBusyRef.current
          || !isActiveSurfaceRef.current
          || surfaceOccludedRef.current
          || nativeSurfaceOcclusionStore.isOccluded()
          || popupActiveRef.current
          || sessionStatusRef.current !== 'running';
        if (leaseChanged || surfaceClosingRef.current || navigationContextChanged) {
          throw new BrowserNavigationSupersededError();
        }
        return browserSurfaceClient.navigationAction({
          leaseId: lease.leaseId,
          generation: lease.generation,
          clientRevision,
          action,
        });
      });
      applyBrowserSurfaceMutationResponseForLease(
        surfaceOrdering,
        surfaceLeaseRef.current,
        lease,
        response,
        applySurfaceSnapshot,
      );
    } catch (navigationError) {
      if (!(navigationError instanceof BrowserNavigationSupersededError)) {
        showActionError(String(navigationError));
      }
    } finally {
      manualNavigationBusyRef.current = false;
      const currentLease = surfaceLeaseRef.current;
      if (
        currentLease?.leaseId === lease.leaseId
        && currentLease.generation === lease.generation
        && !surfaceClosingRef.current
      ) {
        setIsBusy(false);
      }
    }
  }, [applySurfaceSnapshot, showActionError, surfaceOrdering, t]);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void navigate(urlInput);
  }, [navigate, urlInput]);

  const handleClose = useCallback(async () => {
    if (surfaceClosingRef.current) return;
    const lease = surfaceLeaseRef.current;
    if (!lease) {
      if (lifecycle === 'failed' || lifecycle === 'closed') onClose();
      else showActionError(t('workspace.browserSurfaceUnavailable'));
      return;
    }

    surfaceClosingRef.current = true;
    if (syncFrameRef.current !== null) {
      cancelAnimationFrame(syncFrameRef.current);
      syncFrameRef.current = null;
    }
    setIsClosingSurface(true);
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
      showActionError(String(closeError));
      setIsClosingSurface(false);
    }
  }, [lifecycle, onClose, showActionError, surfaceOrdering, t]);

  const cancelUrlEditing = useCallback(() => {
    setUrlInput(currentUrl ?? '');
    setIsUrlEditing(false);
  }, [currentUrl]);

  const handleStartUrlEditing = useCallback(() => {
    if (popupActive || control !== 'user') return;
    setUrlInput(currentUrl ?? '');
    setIsUrlEditing(true);
  }, [control, currentUrl, popupActive]);

  const handleOpenExternal = useCallback(() => {
    const targetUrl = popupActive ? popupUrl : currentUrl;
    if (!targetUrl) return;
    void openExternalUrl(targetUrl).catch((openError) => {
      showActionError(String(openError));
    });
  }, [currentUrl, popupActive, popupUrl, showActionError]);

  const handleLoginControl = useCallback(async (
    action: 'handoff' | 'takeover',
  ) => {
    if (action === 'takeover') occludedAgentResumeRef.current = null;
    if (isLoginControlBusyRef.current) return;
    const controlIntent = action === 'handoff'
      ? (loginAgentSessionId ? { action, agentSessionId: loginAgentSessionId } as const : null)
      : { action };
    if (!controlIntent) {
      showActionError(t('loginBrowserControl.unavailable'));
      return;
    }
    const lease = surfaceLeaseRef.current;
    if (!lease) {
      showActionError(t('workspace.browserSurfaceUnavailable'));
      return;
    }
    const handoffAttemptKey = action === 'handoff'
      ? `${lease.leaseId}:${lease.generation}:${controlRef.current}:${loginAgentSessionId}`
      : null;
    if (handoffAttemptKey) autoHandoffAttemptedLeaseRef.current = handoffAttemptKey;
    isLoginControlBusyRef.current = true;
    setIsLoginControlBusy(true);
    try {
      const response = await surfaceOrdering.enqueue((clientRevision) => {
        const currentLease = surfaceLeaseRef.current;
        const leaseChanged = !currentLease
          || currentLease.leaseId !== lease.leaseId
          || currentLease.generation !== lease.generation;
        const controlContextChanged = !isActiveSurfaceRef.current
          || surfaceOccludedRef.current
          || nativeSurfaceOcclusionStore.isOccluded()
          || sessionStatusRef.current !== 'running';
        const handoffContextChanged = action === 'handoff' && (
          loginAgentSessionIdRef.current !== loginAgentSessionId
          || lifecycleRef.current !== 'ready'
          || isLoadingRef.current
          || popupActiveRef.current
        );
        if (
          leaseChanged
          || surfaceClosingRef.current
          || controlContextChanged
          || handoffContextChanged
        ) {
          throw new BrowserControlSupersededError();
        }
        return browserSurfaceClient.control({
          leaseId: lease.leaseId,
          generation: lease.generation,
          clientRevision,
          ...controlIntent,
        });
      });
      applyBrowserSurfaceMutationResponseForLease(
        surfaceOrdering,
        surfaceLeaseRef.current,
        lease,
        response,
        applySurfaceSnapshot,
      );
    } catch (controlError) {
      if (controlError instanceof BrowserControlSupersededError) {
        if (autoHandoffAttemptedLeaseRef.current === handoffAttemptKey) {
          autoHandoffAttemptedLeaseRef.current = null;
        }
      } else {
        showActionError(String(controlError));
      }
    } finally {
      isLoginControlBusyRef.current = false;
      setIsLoginControlBusy(false);
    }
  }, [applySurfaceSnapshot, loginAgentSessionId, showActionError, surfaceOrdering, t]);

  resumeAgentAfterOcclusionRef.current = async () => {
    const resumeIntent = occludedAgentResumeRef.current;
    if (!resumeIntent) return;
    if (controlRef.current === 'agent') {
      occludedAgentResumeRef.current = null;
      return;
    }
    const currentLease = surfaceLeaseRef.current;
    if (
      !currentLease
      || currentLease.leaseId !== resumeIntent.leaseId
      || currentLease.generation !== resumeIntent.generation
      || loginAgentSessionIdRef.current !== resumeIntent.agentSessionId
      || !isActiveSurfaceRef.current
      || popupActiveRef.current
      || sessionStatusRef.current !== 'running'
      || surfaceClosingRef.current
    ) {
      occludedAgentResumeRef.current = null;
      return;
    }
    if (surfaceOccludedRef.current || nativeSurfaceOcclusionStore.isOccluded()) return;
    if (
      controlRef.current !== 'paused'
      || !autoHandoffRef.current
      || lifecycleRef.current !== 'ready'
      || isLoadingRef.current
    ) {
      // The normal auto-handoff effect retries a still-desired Paused lease after
      // its authoritative native lifecycle converges back to Ready.
      occludedAgentResumeRef.current = null;
      return;
    }
    occludedAgentResumeRef.current = null;
    await handleLoginControl('handoff');
  };

  useEffect(() => {
    if (
      !isSurfaceReady
      || lifecycle !== 'ready'
      || sessionStatus !== 'running'
      || !isActiveSurface
      || surfaceOccluded
      || nativeSurfaceOcclusionStore.isOccluded()
      || isLoading
      || popupActive
    ) return;
    const lease = surfaceLeaseRef.current;
    if (!lease) return;
    if (control === 'agent') {
      autoHandoffAttemptedLeaseRef.current = `${lease.leaseId}:${lease.generation}:agent:${loginAgentSessionId ?? ''}`;
      return;
    }
    const desiredControl = control === 'paused' || paused ? 'paused' : 'user';
    const attemptKey = `${lease.leaseId}:${lease.generation}:${desiredControl}:${loginAgentSessionId ?? ''}`;
    if (
      autoHandoffAttemptedLeaseRef.current === attemptKey
      || !autoHandoff
      || !loginAgentSessionId
      || isLoginControlBusy
    ) return;
    autoHandoffAttemptedLeaseRef.current = attemptKey;
    void handleLoginControl('handoff');
  }, [
    autoHandoff,
    control,
    handleLoginControl,
    isActiveSurface,
    isLoginControlBusy,
    isLoading,
    isSurfaceReady,
    lifecycle,
    loginAgentSessionId,
    paused,
    popupActive,
    sessionStatus,
    surfaceOccluded,
  ]);

  const handleClosePopup = useCallback(async () => {
    if (isPopupCloseBusy) return;
    const lease = surfaceLeaseRef.current;
    if (!lease) {
      showActionError(t('workspace.browserSurfaceUnavailable'));
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
      showActionError(String(popupCloseError));
    } finally {
      setIsPopupCloseBusy(false);
    }
  }, [applySurfaceSnapshot, isPopupCloseBusy, showActionError, surfaceOrdering, t]);

  const panelTitle = t('workspace.browserTitle');
  const effectiveUrl = popupActive ? popupUrl : currentUrl;
  const displayUrl = effectiveUrl || (popupActive ? popupTitle : title) || panelTitle;
  const navigationCommonDisabled = !isSurfaceReady
    || sessionStatus !== 'running'
    || control !== 'user'
    || !isActiveSurface
    || surfaceOccluded
    || nativeSurfaceOcclusionStore.isOccluded()
    || popupActive
    || isBusy
    || isLoginControlBusy
    || isClosingSurface;
  const navigationDisabled = navigationCommonDisabled
    || lifecycle !== 'ready'
    || isLoading;
  const stopLoadingDisabled = navigationCommonDisabled
    || lifecycle !== 'loading'
    || !isLoading;
  const controlToggleUnavailable = !isSurfaceReady
    || sessionStatus !== 'running'
    || !isActiveSurface
    || surfaceOccluded
    || nativeSurfaceOcclusionStore.isOccluded()
    || isClosingSurface;
  const canHandoffAgent = Boolean(loginAgentSessionId)
    && !controlToggleUnavailable
    && lifecycle === 'ready'
    && !isLoading
    && !isBusy;

  return (
    <aside
      data-ccem-browser-panel="true"
      data-ccem-browser-backend="login"
      data-ccem-browser-lifecycle={lifecycle}
      data-ccem-browser-control={control}
      data-ccem-browser-auto-handoff={autoHandoff ? 'true' : 'false'}
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
          spinnerActive={isBusy || isLoading || popupLoading || isClosingSurface
            || isLoginControlBusy || isPopupCloseBusy}
          isPopupCloseBusy={isPopupCloseBusy}
          isClosingSurface={isClosingSurface}
          t={t}
          onClosePopup={() => void handleClosePopup()}
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
        sessionStatus={sessionStatus}
        control={control}
        paused={paused}
        isLoginControlBusy={isLoginControlBusy || controlToggleUnavailable}
        canHandoffAgent={canHandoffAgent}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        isLoading={isLoading}
        navigationDisabled={navigationDisabled}
        stopLoadingDisabled={stopLoadingDisabled}
        t={t}
        onNavigationAction={(action) => void handleNavigationAction(action)}
        onOpenExternal={handleOpenExternal}
        onLoginControl={(action) => void handleLoginControl(action)}
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
