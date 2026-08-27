import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { DeleteEnvConfirmDialog } from '@/components/DeleteEnvConfirmDialog';
import { createDeleteGuard } from '@/lib/asyncGuard';
import { ENV_PRESETS } from '@ccem/core/browser';
import type { PermissionModeName } from '@ccem/core/browser';
import { AppLayout } from '@/components/layout';
import { Workspace } from '@/pages/Workspace';
import { useAppStore, type Environment, type LaunchClient } from '@/store';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useZoom } from '@/hooks/useZoom';
import { Toaster, toast } from 'sonner';
import { LocaleProvider, useLocale } from '@/locales';
import type { UsageStats } from '@/types/analytics';
import { shallow } from 'zustand/shallow';
import { TooltipProvider } from '@/components/ui/tooltip';
import { scheduleAfterFirstPaint } from '@/lib/idle';
import { ccemMotion, clearMotionProps, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';
import { EnvironmentsSkeleton } from '@/components/ui/skeleton-states';
import { StartupSplash } from '@/components/layout/StartupSplash';
import type { PetOpenSessionRequest } from '@/types/pet';
import { AppUpdateProvider } from '@/components/app-update/AppUpdateProvider';
import { runExclusiveLaunch } from '@/components/sessions/sessionLaunchAction';
import {
  NativeBackgroundTaskAppGuardProvider,
  useNativeBackgroundTaskAppGuard,
} from '@/components/NativeBackgroundTaskAppGuard';
import {
  formatInteractiveSessionLaunchError,
  isInteractiveSessionTerminalOpenError,
} from '@/lib/interactiveSessionLaunch';

interface CcemControlRequest {
  kind?: string;
  link?: string;
}

interface TrayOpenTabRequest {
  tab?: string;
}

const AnalyticsPage = lazy(async () =>
  import('@/pages/Analytics').then((m) => ({ default: m.Analytics }))
);
const EnvironmentDialogComponent = lazy(async () =>
  import('@/components/EnvironmentDialog').then((m) => ({ default: m.EnvironmentDialog }))
);
const EnvironmentsPage = lazy(async () =>
  import('@/pages/Environments').then((m) => ({ default: m.Environments }))
);
const SkillsPage = lazy(async () =>
  import('@/pages/Skills').then((m) => ({ default: m.Skills }))
);
const HistoryPage = lazy(async () =>
  import('@/pages/History').then((m) => ({ default: m.History }))
);
const SessionsPage = lazy(async () =>
  import('@/pages/Sessions').then((m) => ({ default: m.Sessions }))
);
const CronTasksPage = lazy(async () =>
  import('@/pages/CronTasks').then((m) => ({ default: m.CronTasks }))
);
const ProxyDebugPage = lazy(async () =>
  import('@/pages/ProxyDebug').then((m) => ({ default: m.ProxyDebug }))
);
const ChatAppPage = lazy(async () =>
  import('@/pages/ChatApp').then((m) => ({ default: m.ChatApp }))
);
const SettingsPage = lazy(async () =>
  import('@/pages/Settings').then((m) => ({ default: m.Settings }))
);

const PERMISSION_MODE_NAMES: PermissionModeName[] = ['yolo', 'dev', 'readonly', 'safe', 'ci', 'audit'];

function normalizeAppPermissionMode(value: unknown): PermissionModeName | null {
  return typeof value === 'string' && (PERMISSION_MODE_NAMES as string[]).includes(value)
    ? value as PermissionModeName
    : null;
}

function calculateContinuousUsageDays(dailyHistory: UsageStats['dailyHistory']): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);

  let streak = 0;
  while (true) {
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    if (!dailyHistory[dateKey]) {
      return streak;
    }
    streak += 1;
    date.setDate(date.getDate() - 1);
  }
}

function AppContent() {
  const { t } = useLocale();
  const { requestQuit } = useNativeBackgroundTaskAppGuard();
  const FOCUS_SYNC_INTERVAL_MS = 5000;
  const FOCUS_SYNC_DELAY_MS = 180;
  const perfAutopilotEnabled = import.meta.env.DEV && import.meta.env.VITE_PERF_AUTOPILOT === '1';
  const [activeTab, setActiveTab] = useState('workspace');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<'add' | 'edit'>('add');
  const [editingEnvName, setEditingEnvName] = useState<string | undefined>();
  const [pendingDeleteEnv, setPendingDeleteEnv] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Synchronous re-entry guard: React state can't block a second confirm within
  // the same tick, so a fast double-submit would hit the backend twice.
  const deleteEnvGuardRef = useRef(createDeleteGuard());
  const [startupReady, setStartupReady] = useState(false);
  const [startupSplashVisible, setStartupSplashVisible] = useState(true);
  const [petOpenRequest, setPetOpenRequest] = useState<PetOpenSessionRequest | null>(null);
  const [workspaceSessionLinkRequest, setWorkspaceSessionLinkRequest] = useState<{ id: number; link: string } | null>(null);
  const [workspaceComposeSeed, setWorkspaceComposeSeed] = useState<{ id: number; value: string } | null>(null);
  const appPageMotionRef = useRef<HTMLDivElement | null>(null);
  const hasAnimatedAppPageRef = useRef(false);
  const lastFocusSyncAtRef = useRef(0);
  const launchInFlightRef = useRef<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  const { setEnvironments, setCurrentEnv, setPermissionMode, setDefaultMode, setUsageStats, setContinuousUsageDays, setCompanion, environments, launchClient, error, setError } = useAppStore(
    (state) => ({
      setEnvironments: state.setEnvironments,
      setCurrentEnv: state.setCurrentEnv,
      setPermissionMode: state.setPermissionMode,
      setDefaultMode: state.setDefaultMode,
      setUsageStats: state.setUsageStats,
      setContinuousUsageDays: state.setContinuousUsageDays,
      setCompanion: state.setCompanion,
      environments: state.environments,
      launchClient: state.launchClient,
      error: state.error,
      setError: state.setError,
    }),
    shallow
  );

  const {
    loadEnvironments,
    loadCurrentEnv,
    loadSessions,
    loadAppConfig,
    launchClaudeCode,
    openInteractiveSessionInTerminal,
    addEnvironment,
    updateEnvironment,
    deleteEnvironment,
    loadEnabledEnvironments,
    loadFromRemote,
  } = useTauriCommands();

  const surfaceBackgroundTerminalPartial = useCallback((error: unknown) => {
    if (!isInteractiveSessionTerminalOpenError(error)) {
      return;
    }

    toast.error(
      t('workspace.terminalSessionCreatedOpenFailed').replace(
        '{error}',
        formatInteractiveSessionLaunchError(error.terminalError),
      ),
      {
        action: {
          label: t('common.retry'),
          onClick: () => {
            void openInteractiveSessionInTerminal(
              error.sessionId,
              undefined,
              { notifyOnError: false },
            )
              .then(() => toast.success(t('workspace.nativeHandoffDone')))
              .catch(() => {
                toast.error(t('workspace.nativeHandoffFailed'));
              });
          },
        },
      },
    );
  }, [openInteractiveSessionInTerminal, t]);

  const preloadAnalyticsPage = useCallback(() => {
    void import('@/pages/Analytics').then((module) => {
      module.primeAnalyticsPage?.();
    });
  }, []);

  const preloadEnvironmentsPage = useCallback(() => {
    void import('@/pages/Environments');
  }, []);

  const preloadHistoryPage = useCallback(() => {
    void import('@/pages/History').then((module) => {
      module.primeHistoryPage?.();
    });
  }, []);

  const preloadSessionsPage = useCallback(() => {
    void import('@/pages/Sessions');
  }, []);

  const preloadSettingsPage = useCallback(() => {
    void import('@/pages/Settings');
  }, []);

  const prefetchTab = useCallback((tab: string) => {
    switch (tab) {
      case 'analytics':
        preloadAnalyticsPage();
        return;
      case 'environments':
        preloadEnvironmentsPage();
        return;
      case 'history':
        preloadHistoryPage();
        return;
      case 'sessions':
        preloadSessionsPage();
        return;
      case 'settings':
        preloadSettingsPage();
        return;
      default:
        return;
    }
  }, [
    preloadAnalyticsPage,
    preloadEnvironmentsPage,
    preloadHistoryPage,
    preloadSessionsPage,
    preloadSettingsPage,
  ]);

  const navigateToTab = useCallback((tab: string) => {
    prefetchTab(tab);
    startTransition(() => {
      setActiveTab(tab);
    });
  }, [prefetchTab, startTransition]);

  const handleStartupSplashExitComplete = useCallback(() => {
    setStartupSplashVisible(false);
  }, []);

  useEffect(() => {
    if (!startupReady) {
      setStartupSplashVisible(true);
    }
  }, [startupReady]);

  useGSAP(() => {
    const page = appPageMotionRef.current;
    if (!startupReady || !page) {
      return;
    }

    if (shouldReduceMotion()) {
      clearMotionProps(page);
      hasAnimatedAppPageRef.current = true;
      return;
    }

    const firstRun = !hasAnimatedAppPageRef.current;
    hasAnimatedAppPageRef.current = true;
    gsap.killTweensOf(page);
    gsap.fromTo(
      page,
      {
        autoAlpha: firstRun ? 0 : 0.72,
        y: firstRun ? 14 : 8,
        scale: firstRun ? 0.992 : 0.998,
      },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: firstRun ? ccemMotion.duration.handoff : ccemMotion.duration.base,
        ease: ccemMotion.ease.standard,
        clearProps: 'opacity,visibility,transform',
      },
    );
  }, { dependencies: [activeTab, startupReady], scope: appPageMotionRef });

  const openWorkspaceCronCreate = useCallback(() => {
    setWorkspaceComposeSeed({ id: Date.now(), value: '/ccem-cron ' });
    navigateToTab('workspace');
  }, [navigateToTab]);

  const openCronRunSessionLink = useCallback((link: string) => {
    setWorkspaceSessionLinkRequest({ id: Date.now(), link });
    navigateToTab('workspace');
  }, [navigateToTab]);

  useEffect(() => {
    if (!perfAutopilotEnabled) {
      return;
    }

    const sequence = [
      { delayMs: 1200, tab: 'workspace' },
      { delayMs: 4200, tab: 'sessions' },
      { delayMs: 7600, tab: 'history' },
      { delayMs: 11000, tab: 'analytics' },
      { delayMs: 14500, tab: 'workspace' },
    ] as const;

    const timers = sequence.map(({ delayMs, tab }) => (
      window.setTimeout(() => {
        navigateToTab(tab);
      }, delayMs)
    ));

    return () => {
      timers.forEach((timerId) => window.clearTimeout(timerId));
    };
  }, [navigateToTab, perfAutopilotEnabled]);

  // Show global errors as toast notifications
  useEffect(() => {
    if (error) {
      toast.error(error);
      // Clear error after showing toast to prevent re-triggering
      setError(null);
    }
  }, [error, setError]);

  // Listen for tray menu events
  useEffect(() => {
    const unlisteners: (() => void)[] = [];
    let cancelled = false;

    const setupListeners = async () => {
      try {
        const listener1 = await listen('tray-launch-claude', () => {
          void handleLaunch().catch((error) => {
            surfaceBackgroundTerminalPartial(error);
          });
        });
        if (cancelled) {
          listener1();
          return;
        }
        unlisteners.push(listener1);

        const listener2 = await listen('navigate-to-settings', () => {
          navigateToTab('settings');
        });
        if (cancelled) {
          listener2();
          return;
        }
        unlisteners.push(listener2);

        const listener3 = await listen<{ env: string }>('env-changed', (event) => {
          setCurrentEnv(event.payload.env);
        });
        if (cancelled) {
          listener3();
          return;
        }
        unlisteners.push(listener3);

        const listener4 = await listen<{ perm: string }>('perm-changed', (event) => {
          setPermissionMode(event.payload.perm as PermissionModeName);
        });
        if (cancelled) {
          listener4();
          return;
        }
        unlisteners.push(listener4);

        const listener5 = await listen<PetOpenSessionRequest>('pet-open-session', (event) => {
          setPetOpenRequest(event.payload);
          navigateToTab('workspace');
        });
        if (cancelled) {
          listener5();
          return;
        }
        unlisteners.push(listener5);

        const listener6 = await listen<CcemControlRequest>('ccem-control-request', (event) => {
          if (event.payload?.kind !== 'openSession' || typeof event.payload.link !== 'string') {
            return;
          }
          setWorkspaceSessionLinkRequest({ id: Date.now(), link: event.payload.link });
          navigateToTab('workspace');
        });
        if (cancelled) {
          listener6();
          return;
        }
        unlisteners.push(listener6);

        const listener7 = await listen<TrayOpenTabRequest>('tray-open-tab', (event) => {
          if (typeof event.payload?.tab === 'string') {
            navigateToTab(event.payload.tab);
          }
        });
        if (cancelled) {
          listener7();
          return;
        }
        unlisteners.push(listener7);
      } catch (err) {
        console.error('Failed to setup tray event listeners:', err);
      }
    };

    setupListeners();

    return () => {
      cancelled = true;
      unlisteners.forEach(fn => fn());
    };
  }, [
    navigateToTab,
    setCurrentEnv,
    setPermissionMode,
    surfaceBackgroundTerminalPartial,
  ]);

  const refreshCriticalData = useCallback(async () => {
    const settingsPromise = invoke<{
      defaultMode: string | null;
      enabledEnvironments?: string[] | null;
    }>('get_settings')
      .then((settings) => {
        const defaultMode = normalizeAppPermissionMode(settings.defaultMode);
        if (defaultMode) {
          setDefaultMode(defaultMode);
          setPermissionMode(defaultMode);
        }
        // Prefer full settings payload; keep explicit null as legacy all-enabled.
        useAppStore.getState().setEnabledEnvironments(settings.enabledEnvironments ?? null);
      })
      .catch(() => {
        const saved = localStorage.getItem('ccem-settings');
        if (!saved) {
          return;
        }
        try {
          const settings = JSON.parse(saved) as {
            defaultMode?: unknown;
            enabledEnvironments?: string[] | null;
          };
          const defaultMode = normalizeAppPermissionMode(settings.defaultMode);
          if (defaultMode) {
            setDefaultMode(defaultMode);
            setPermissionMode(defaultMode);
          }
          if ('enabledEnvironments' in settings) {
            useAppStore.getState().setEnabledEnvironments(settings.enabledEnvironments ?? null);
          }
        } catch {
          // Ignore corrupt local fallback settings.
        }
      });
    // Best-effort dedicated load so enablement still hydrates if settings payload is partial.
    void loadEnabledEnvironments();
    const envPromise = loadEnvironments().catch(() => {
      // Fallback to presets if Tauri is not available (dev mode)
      const envList: Environment[] = Object.entries(ENV_PRESETS).map(([name, config]) => ({
        name,
        baseUrl: config.ANTHROPIC_BASE_URL || '',
        defaultOpusModel: config.ANTHROPIC_DEFAULT_OPUS_MODEL || '',
        defaultSonnetModel: config.ANTHROPIC_DEFAULT_SONNET_MODEL,
        defaultHaikuModel: config.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        runtimeModel: config.ANTHROPIC_MODEL || 'opus',
        limitWriteTools: Boolean(config.CCEM_LIMIT_WRITE_TOOLS),
      }));
      envList.unshift({
        name: 'official',
        baseUrl: 'https://api.anthropic.com',
        defaultOpusModel: '',
        defaultHaikuModel: 'claude-3-5-haiku-20241022',
        runtimeModel: 'opus',
        limitWriteTools: false,
      });
      setEnvironments(envList);
    });
    const currentEnvPromise = loadCurrentEnv().catch(() => {
      setCurrentEnv('official');
    });

    await Promise.allSettled([
      settingsPromise,
      envPromise,
      currentEnvPromise,
    ]);
  }, [
    loadEnvironments,
    loadEnabledEnvironments,
    loadCurrentEnv,
    setEnvironments,
    setCurrentEnv,
    setDefaultMode,
    setPermissionMode,
  ]);

  const refreshDeferredData = useCallback(async () => {
    const appConfigPromise = loadAppConfig().catch((err) => {
      console.error('Failed to load app config:', err);
    });
    const sessionsPromise = loadSessions().catch((err) => {
      console.error('Failed to load sessions:', err);
    });
    const statsPromise = invoke<UsageStats>('get_usage_stats')
      .then((stats) => {
        if (stats) {
          setUsageStats(stats);
          setContinuousUsageDays(calculateContinuousUsageDays(stats.dailyHistory));
        }
      })
      .catch(() => {
        console.debug('Usage stats not available during deferred dashboard refresh');
      });
    const companionPromise = invoke<import('@/store').Companion | null>('get_companion')
      .then((c) => setCompanion(c))
      .catch(() => {});

    await Promise.allSettled([
      appConfigPromise,
      sessionsPromise,
      statsPromise,
      companionPromise,
    ]);
  }, [
    loadAppConfig,
    loadSessions,
    setUsageStats,
    setContinuousUsageDays,
    setCompanion,
  ]);

  // Keep cold-start intentional: show the branded glass splash until critical
  // config is ready, then fill in sessions and analytics after the first app paint.
  useEffect(() => {
    let cancelled = false;
    let minimumTimerId: number | null = null;
    let maxTimerId: number | null = null;
    const startedAt = performance.now();
    const minSplashMs = 760;
    const maxSplashMs = 4800;

    const finishStartup = () => {
      if (cancelled) {
        return;
      }
      if (maxTimerId !== null) {
        window.clearTimeout(maxTimerId);
        maxTimerId = null;
      }

      const elapsedMs = performance.now() - startedAt;
      const remainingMs = Math.max(0, minSplashMs - elapsedMs);
      minimumTimerId = window.setTimeout(() => {
        if (!cancelled) {
          setStartupReady(true);
        }
      }, remainingMs);
    };

    maxTimerId = window.setTimeout(() => {
      if (!cancelled) {
        setStartupReady(true);
      }
    }, maxSplashMs);

    void refreshCriticalData().finally(finishStartup);

    return () => {
      cancelled = true;
      if (minimumTimerId !== null) {
        window.clearTimeout(minimumTimerId);
      }
      if (maxTimerId !== null) {
        window.clearTimeout(maxTimerId);
      }
    };
  }, [refreshCriticalData]);

  useEffect(() => {
    if (!startupReady) {
      return;
    }

    let cancelled = false;

    const cancelDeferredRefresh = scheduleAfterFirstPaint(() => {
      if (!cancelled) {
        void refreshDeferredData();
      }
    }, { delayMs: 220, timeoutMs: 1200 });

    return () => {
      cancelled = true;
      cancelDeferredRefresh();
    };
  }, [startupReady, refreshDeferredData]);

  // Re-sync with CLI config when window regains focus
  // This ensures desktop stays in sync when user modifies env via `ccem add/del/use` in terminal
  // Skip environment reload when a dialog is open to avoid resetting in-progress edits
  useEffect(() => {
    let timeoutId: number | null = null;
    let idleId: number | null = null;
    const requestIdle = window.requestIdleCallback?.bind(window);
    const cancelIdle = window.cancelIdleCallback?.bind(window);
    lastFocusSyncAtRef.current = Date.now();

    const runFocusSync = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      loadCurrentEnv().catch(() => {});

      if (!dialogOpen) {
        loadEnvironments({ silent: true }).catch(() => {});
      }

      if (activeTab === 'workspace' || activeTab === 'sessions') {
        loadSessions().catch(() => {});
      }
    };

    const scheduleFocusSync = () => {
      if (idleId !== null && cancelIdle) {
        cancelIdle(idleId);
        idleId = null;
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        if (requestIdle) {
          idleId = requestIdle(() => {
            idleId = null;
            runFocusSync();
          }, { timeout: 800 });
          return;
        }

        runFocusSync();
      }, FOCUS_SYNC_DELAY_MS);
    };

    const handleFocus = () => {
      const now = Date.now();
      if (now - lastFocusSyncAtRef.current < FOCUS_SYNC_INTERVAL_MS) {
        return;
      }
      lastFocusSyncAtRef.current = now;
      scheduleFocusSync();
    };

    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
      if (idleId !== null && cancelIdle) {
        cancelIdle(idleId);
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, [activeTab, loadEnvironments, loadCurrentEnv, loadSessions, dialogOpen]);

  const runLaunchOnce = useCallback(async (key: string, launch: () => Promise<void>) => {
    try {
      await runExclusiveLaunch(launchInFlightRef.current, key, launch);
    } catch (err) {
      console.error('Launch failed:', err);
      throw err;
    }
  }, []);

  // Handle launch
  const handleLaunch = useCallback(async (client?: LaunchClient) => {
    const effectiveClient = client ?? launchClient;
    await runLaunchOnce(`default:${effectiveClient}`, async () => {
      await launchClaudeCode(undefined, undefined, effectiveClient);
    });
  }, [launchClaudeCode, launchClient, runLaunchOnce]);

  // Global keyboard shortcuts (Cmd+1..9 for tabs, Cmd+Enter/N for launch, Cmd+, for settings)
  const globalShortcuts = useMemo(() => ({
    'meta+1': () => navigateToTab('workspace'),
    'meta+2': () => navigateToTab('sessions'),
    'meta+3': () => navigateToTab('environments'),
    'meta+4': () => navigateToTab('skills'),
    'meta+5': () => navigateToTab('history'),
    'meta+6': () => navigateToTab('cron'),
    'meta+7': () => navigateToTab('chat-app'),
    'meta+8': () => navigateToTab('analytics'),
    'meta+9': () => navigateToTab('proxy-debug'),
    'meta+enter': () => handleLaunch().catch(surfaceBackgroundTerminalPartial),
    'meta+n': () => handleLaunch().catch(surfaceBackgroundTerminalPartial),
    'meta+,': () => navigateToTab('settings'),
    'meta+q': () => { void requestQuit(); },
  }), [handleLaunch, navigateToTab, requestQuit, surfaceBackgroundTerminalPartial]);

  useKeyboardShortcuts(globalShortcuts);

  // Mac-native zoom shortcuts: Cmd+= / Cmd+- / Cmd+0.
  useZoom();

  // Handle launch with specific directory
  const handleLaunchWithDir = useCallback(async (workingDir: string, client?: LaunchClient) => {
    const effectiveClient = client ?? launchClient;
    await runLaunchOnce(`dir:${effectiveClient}:${workingDir}`, async () => {
      await launchClaudeCode(workingDir, undefined, effectiveClient);
    });
  }, [launchClaudeCode, launchClient, runLaunchOnce]);

  // Environment CRUD handlers
  const handleAddEnv = () => {
    setDialogMode('add');
    setEditingEnvName(undefined);
    setDialogOpen(true);
  };

  const handleEditEnv = (name: string) => {
    setDialogMode('edit');
    setEditingEnvName(name);
    setDialogOpen(true);
  };

  const handleCopyEnv = (name: string) => {
    setDialogMode('add');
    setEditingEnvName(name);
    setDialogOpen(true);
  };

  const handleDeleteEnv = (name: string) => {
    setPendingDeleteEnv(name);
  };

  const confirmDeleteEnv = async () => {
    if (!pendingDeleteEnv) return;
    // Atomic re-entry guard: a second confirm in the same tick (fast double
    // submit) is dropped synchronously before any backend call.
    if (!deleteEnvGuardRef.current.begin()) return;
    setConfirmingDelete(true);
    try {
      await deleteEnvironment(pendingDeleteEnv);
      // Success → close the confirm dialog.
      setPendingDeleteEnv(null);
    } catch (err) {
      // deleteEnvironment already routed the failure through the global error
      // state (surfaced as a toast by the global error effect) and rethrew. Do
      // NOT toast again here (would double-notify). Keep the dialog open so the
      // user can resolve references (or a TOCTOU new reference) and retry.
      console.error('Delete failed:', err);
    } finally {
      deleteEnvGuardRef.current.end();
      setConfirmingDelete(false);
    }
  };

  const handleSaveEnv = async (env: Environment) => {
    try {
      if (dialogMode === 'add') {
        await addEnvironment(env);
      } else {
        await updateEnvironment(env, editingEnvName);
      }
      setDialogOpen(false);
    } catch (err) {
      console.error('Save failed:', err);
    }
  };

  // Get seed environment for edit / copy dialogs
  const getEditingEnv = (): Environment | undefined => {
    if (!editingEnvName) return undefined;
    const env = environments.find(e => e.name === editingEnvName);
    return env;
  };

  const existingEnvNames = environments.map((env) => env.name);

  // Render current non-workspace page. Workspace stays mounted so its local UI state
  // survives tab switches instead of remounting on every return.
  const renderActivePage = () => {
    switch (activeTab) {
      case 'workspace':
        return null;
      case 'sessions':
        return <SessionsPage onLaunch={handleLaunch} onLaunchWithDir={handleLaunchWithDir} />;
      case 'environments':
        return (
          <EnvironmentsPage
            onAddEnv={handleAddEnv}
            onEditEnv={handleEditEnv}
            onCopyEnv={handleCopyEnv}
            onDeleteEnv={handleDeleteEnv}
          />
        );
      case 'analytics':
        return <AnalyticsPage />;
      case 'skills':
        return <SkillsPage />;
      case 'history':
        return <HistoryPage />;
      case 'cron':
        return <CronTasksPage onAiCreate={openWorkspaceCronCreate} onOpenSessionLink={openCronRunSessionLink} />;
      case 'chat-app':
        return <ChatAppPage />;
      case 'proxy-debug':
        return <ProxyDebugPage />;
      case 'settings':
        return <SettingsPage />;
      default:
        return null;
    }
  };

  const isFullBleedTab = activeTab === 'history' || activeTab === 'workspace' || activeTab === 'settings';

  return (
    <AppUpdateProvider>
        <TooltipProvider>
          {startupReady ? (
            <AppLayout
              activeTab={activeTab}
              onTabChange={navigateToTab}
              onTabPrefetch={prefetchTab}
              fullBleed={isFullBleedTab}
            >
              <div
                ref={appPageMotionRef}
                data-motion-page={activeTab}
                className={isFullBleedTab ? 'h-full w-full' : 'w-full min-w-0'}
              >
                <div
                  className={activeTab === 'workspace' ? 'h-full w-full' : 'hidden'}
                  hidden={activeTab !== 'workspace'}
                  aria-hidden={activeTab !== 'workspace'}
                >
                  <Workspace
                    isActive={activeTab === 'workspace'}
                    onNavigate={navigateToTab}
                    onLaunchWithDir={handleLaunchWithDir}
                    composeSeed={workspaceComposeSeed}
                    petOpenRequest={petOpenRequest}
                    onPetOpenHandled={() => setPetOpenRequest(null)}
                    sessionLinkRequest={workspaceSessionLinkRequest}
                    onSessionLinkHandled={() => setWorkspaceSessionLinkRequest(null)}
                  />
                </div>

                {activeTab !== 'workspace' ? (
                  <Suspense fallback={<PageFallback activeTab={activeTab} />}>
                    {renderActivePage()}
                  </Suspense>
                ) : null}
              </div>
            </AppLayout>
          ) : null}

          {startupSplashVisible ? (
            <StartupSplash
              exiting={startupReady}
              onExitComplete={handleStartupSplashExitComplete}
            />
          ) : null}

          {/* Environment Dialog */}
          {dialogOpen ? (
            <Suspense fallback={null}>
              <EnvironmentDialogComponent
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                mode={dialogMode}
                environment={getEditingEnv()}
                existingNames={existingEnvNames}
                onSave={handleSaveEnv}
                onServerSync={loadFromRemote}
              />
            </Suspense>
          ) : null}

          {/* Delete Environment Confirmation Dialog */}
          {pendingDeleteEnv && (
            <DeleteEnvConfirmDialog
              envName={pendingDeleteEnv}
              confirming={confirmingDelete}
              onConfirm={confirmDeleteEnv}
              onCancel={() => setPendingDeleteEnv(null)}
            />
          )}

          {/* Toast notifications */}
          <Toaster position="top-center" richColors />
        </TooltipProvider>
    </AppUpdateProvider>
  );
}

function App() {
  return (
    <LocaleProvider>
      <NativeBackgroundTaskAppGuardProvider>
        <AppContent />
      </NativeBackgroundTaskAppGuardProvider>
    </LocaleProvider>
  );
}

function PageFallback({ activeTab }: { activeTab: string }) {
  if (activeTab === 'environments') {
    return <EnvironmentsSkeleton />;
  }

  return (
    <div className="min-h-[320px] w-full flex items-center justify-center text-sm text-muted-foreground">
      Loading...
    </div>
  );
}

export default App;
