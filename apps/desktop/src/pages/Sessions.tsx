import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Minimize2, Plus, Terminal, X } from '@/lib/lucide-react';
import { ProjectPickerModal } from '@/components/workspace/ProjectPickerModal';
import {
  SessionCard,
  SessionList,
  ArrangeBanner,
  SessionsPageActions,
} from '@/components/sessions';
import { resolveSessionCloseAction } from '@/components/sessions/sessionCloseActions';
import {
  formatSessionLaunchError,
  isLaunchAlreadyInProgressError,
  launchSingleSession,
} from '@/components/sessions/sessionLaunchAction';
import { useAppStore, type ArrangeLayout, type LaunchClient, type Session, type UnifiedSession } from '@/store';
import type { PermissionModeName } from '@ccem/core/browser';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import { useLocale } from '../locales';
import { filterRuntimeEnvironments } from '@/lib/enabledEnvironments';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { SessionsSkeleton } from '@/components/ui/skeleton-states';
import { toast } from 'sonner';
import { shallow } from 'zustand/shallow';
import { getRemotePlatformFromSource } from '@/lib/remote-platforms';
import { scheduleAfterFirstPaint } from '@/lib/idle';
import { ccemMotion, clearMotionProps, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';
import type {
  UnifiedSessionInfo,
  ManagedSessionSource,
  AttachedChannelInfo,
  TmuxAttachTerminalInfo,
  TmuxAttachTerminalType,
} from '@/lib/tauri-ipc';

const LazyRecoveryCandidatesPanel = lazy(async () =>
  import('@/components/sessions/RecoveryCandidatesPanel').then((module) => ({
    default: module.RecoveryCandidatesPanel,
  }))
);

// --- Helper: map snake_case UnifiedSessionInfo → camelCase UnifiedSession ---
function mapSourceToString(source: ManagedSessionSource): UnifiedSession['source'] {
  const remotePlatform = getRemotePlatformFromSource(source);
  if (remotePlatform) {
    return remotePlatform;
  }

  switch (source.type) {
    case 'desktop': return 'desktop';
    case 'cron': return 'cron';
    default: return 'cli';
  }
}

function mapChannelInfo(ch: AttachedChannelInfo): { kind: string; connectedAt: string; label?: string; rawKind?: import('@/lib/tauri-ipc').ChannelKind } {
  const kindStr = typeof ch.kind === 'string' ? ch.kind : ch.kind.kind;
  return {
    kind: kindStr,
    connectedAt: ch.connected_at,
    label: ch.label ?? undefined,
    rawKind: ch.kind as import('@/lib/tauri-ipc').ChannelKind,
  };
}

function toUnifiedSession(info: UnifiedSessionInfo): UnifiedSession {
  return {
    id: info.id,
    runtimeKind: info.runtime_kind,
    source: mapSourceToString(info.source),
    status: info.status,
    projectDir: info.project_dir,
    envName: info.env_name,
    permMode: info.perm_mode,
    createdAt: info.created_at,
    isActive: info.is_active,
    pid: info.pid ?? undefined,
    claudeSessionId: info.claude_session_id ?? undefined,
    tmuxTarget: info.tmux_target ?? undefined,
    client: info.client ?? undefined,
    channels: (info.channels ?? []).map(mapChannelInfo),
  };
}

function areChannelListsEqual(
  left: UnifiedSession['channels'],
  right: UnifiedSession['channels'],
) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((channel, index) => {
    const candidate = right[index];
    return candidate
      && candidate.kind === channel.kind
      && candidate.connectedAt === channel.connectedAt
      && candidate.label === channel.label;
  });
}

function areUnifiedSessionsEqual(left: UnifiedSession[], right: UnifiedSession[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((session, index) => {
    const candidate = right[index];
    return candidate
      && candidate.id === session.id
      && candidate.runtimeKind === session.runtimeKind
      && candidate.source === session.source
      && candidate.status === session.status
      && candidate.projectDir === session.projectDir
      && candidate.envName === session.envName
      && candidate.permMode === session.permMode
      && candidate.createdAt === session.createdAt
      && candidate.isActive === session.isActive
      && candidate.pid === session.pid
      && candidate.claudeSessionId === session.claudeSessionId
      && candidate.tmuxTarget === session.tmuxTarget
      && candidate.client === session.client
      && areChannelListsEqual(session.channels, candidate.channels);
  });
}

// --- Helper: create a placeholder legacy Session from a UnifiedSession ---
function unifiedToLegacySession(u: UnifiedSession): Session {
  const statusMap: Record<string, Session['status']> = {
    running: 'running',
    ready: 'running',
    processing: 'running',
    waiting_permission: 'running',
    initializing: 'running',
    completed: 'stopped',
    stopped: 'stopped',
    error: 'error',
  };
  return {
    id: u.id,
    client: (
      u.client?.toLowerCase() === 'codex'
        ? 'codex'
        : u.client?.toLowerCase() === 'opencode'
          ? 'opencode'
          : 'claude'
    ) as Session['client'],
    envName: u.envName,
    workingDir: u.projectDir,
    pid: u.pid,
    startedAt: new Date(u.createdAt),
    status: statusMap[u.status] ?? 'stopped',
    permMode: u.permMode,
    tmuxTarget: u.tmuxTarget ?? undefined,
  };
}

interface SessionsProps {
  onLaunch: (client?: LaunchClient) => Promise<void>;
  onLaunchWithDir: (dir: string, client?: LaunchClient) => Promise<void>;
}

export function Sessions({ onLaunch, onLaunchWithDir }: SessionsProps) {
  const { t } = useLocale();
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [showCloseAllDialog, setShowCloseAllDialog] = useState(false);
  const [isArranging, setIsArranging] = useState(false);
  const [arrangeStatus, setArrangeStatus] = useState<'normal' | 'loading' | 'success'>('normal');
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [isMultiLaunching, setIsMultiLaunching] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [tmuxAttachTerminals, setTmuxAttachTerminals] = useState<TmuxAttachTerminalInfo[]>([]);
  const [showRecoveryCandidates, setShowRecoveryCandidates] = useState(false);
  const launchedTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const tmuxAttachTerminalsRequestedRef = useRef(false);
  const tmuxAttachTerminalsPromiseRef = useRef<Promise<void> | null>(null);
  const sessionsMotionRef = useRef<HTMLDivElement>(null);
  const [, startTransition] = useTransition();
  const {
    sessions,
    isLoadingSessions,
    arrangeLayout,
    setArrangeLayout,
    selectedWorkingDir,
    setSelectedWorkingDir,
    unifiedSessions,
    setUnifiedSessions,
    currentEnv,
    environments,
    enabledEnvironments,
    permissionMode,
    setPermissionMode,
  } = useAppStore(
    (state) => ({
      sessions: state.sessions,
      isLoadingSessions: state.isLoadingSessions,
      arrangeLayout: state.arrangeLayout,
      setArrangeLayout: state.setArrangeLayout,
      selectedWorkingDir: state.selectedWorkingDir,
      setSelectedWorkingDir: state.setSelectedWorkingDir,
      unifiedSessions: state.unifiedSessions,
      setUnifiedSessions: state.setUnifiedSessions,
      currentEnv: state.currentEnv,
      environments: state.environments,
      enabledEnvironments: state.enabledEnvironments,
      permissionMode: state.permissionMode,
      setPermissionMode: state.setPermissionMode,
    }),
    shallow
  );
  const {
    focusSession,
    listTmuxAttachTerminals,
    openInteractiveSessionInTerminal,
    minimizeSession,
    closeSession,
    arrangeSessions,
    launchClaudeCode,
    openDirectoryPicker,
    listUnifiedSessions,
    stopUnifiedSession,
    closeUnifiedInteractiveSession,
    removeHeadlessSession,
    detachChannel,
    switchEnvironment,
  } = useTauriCommands();

  const legacySessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session] as const)),
    [sessions],
  );

  // --- Load unified sessions ---
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }

      try {
        const infos = await listUnifiedSessions();
        if (!cancelled) {
          const nextSessions = infos.map(toUnifiedSession);
          const currentSessions = useAppStore.getState().unifiedSessions;
          if (!areUnifiedSessionsEqual(currentSessions, nextSessions)) {
            startTransition(() => {
              setUnifiedSessions(nextSessions);
            });
          }
        }
      } catch (err) {
        console.error('Failed to load unified sessions:', err);
      }
    };

    const cancelInitialLoad = scheduleAfterFirstPaint(() => {
      void load();
    }, { delayMs: 180, timeoutMs: 1200 });

    const interval = setInterval(load, 5000);

    return () => {
      cancelled = true;
      cancelInitialLoad();
      clearInterval(interval);
    };
  }, [listUnifiedSessions, setUnifiedSessions, startTransition]);

  useEffect(() => {
    const cancelDeferredRecoveryPanel = scheduleAfterFirstPaint(() => {
      setShowRecoveryCandidates(true);
    }, { delayMs: 260, timeoutMs: 1400 });

    return () => {
      cancelDeferredRecoveryPanel();
    };
  }, []);

  const ensureTmuxAttachTerminalsLoaded = useCallback(() => {
    if (tmuxAttachTerminalsRequestedRef.current) {
      return tmuxAttachTerminalsPromiseRef.current;
    }

    tmuxAttachTerminalsRequestedRef.current = true;
    const request = listTmuxAttachTerminals()
      .then((terminals) => {
        setTmuxAttachTerminals(terminals);
      })
      .catch((err) => {
        console.error('Failed to load tmux attach terminals:', err);
        tmuxAttachTerminalsRequestedRef.current = false;
      })
      .finally(() => {
        tmuxAttachTerminalsPromiseRef.current = null;
      });

    tmuxAttachTerminalsPromiseRef.current = request;
    return request;
  }, [listTmuxAttachTerminals]);

  // --- Merge sessions: legacy (external terminal) + unified, dedup by id ---
  type DisplayItem = { session: Session; unifiedSession?: UnifiedSession };
  const mergedSessions: DisplayItem[] = useMemo(() => {
    const items: DisplayItem[] = [];
    const seen = new Set<string>();

    // Add unified sessions
    for (const u of unifiedSessions) {
      // Find matching legacy session for external terminal features
      const legacyMatch = legacySessionById.get(u.id);
      items.push({
        session: legacyMatch ?? unifiedToLegacySession(u),
        unifiedSession: u,
      });
      seen.add(u.id);
    }

    // Add legacy-only sessions (external terminal sessions not in unified)
    for (const s of sessions) {
      if (seen.has(s.id)) {
        continue;
      }
      items.push({ session: s });
    }

    return items;
  }, [legacySessionById, sessions, unifiedSessions]);

  // --- Apply filter + counts (memoized) ---
  const { filteredSessions, totalCount } = useMemo(() => {
    // 显示全部会话（已移除 tab 过滤）
    return {
      filteredSessions: mergedSessions,
      totalCount: mergedSessions.length,
    };
  }, [mergedSessions]);

  // Force card view when any unified-only sessions are visible (list view lacks unified data)
  const hasUnifiedOnlyInView = filteredSessions.some(
    (item) => item.unifiedSession && !legacySessionById.has(item.unifiedSession.id)
  );
  const effectiveViewMode = hasUnifiedOnlyInView ? 'card' : viewMode;

  const runningSessions = useMemo(
    () => sessions.filter((session) => session.status === 'running'),
    [sessions],
  );
  const externalRunningSessions = useMemo(
    () => runningSessions.filter((session) => session.terminalType !== 'embedded'),
    [runningSessions],
  );
  const externalRunningCount = externalRunningSessions.length;

  // Truncate directory path for display (same logic as Dashboard)
  const launchDirDisplay = selectedWorkingDir
    ? selectedWorkingDir.replace(/^\/Users\/[^/]+/, '~').split('/').slice(-2).join('/')
    : '~';

  // Smart layout: pick best layout based on session count, or use remembered layout
  const getSmartLayout = useCallback((): ArrangeLayout => {
    if (arrangeLayout) return arrangeLayout;
    if (externalRunningCount <= 2) return 'horizontal2';
    if (externalRunningCount === 3) return 'left_main3';
    return 'grid4';
  }, [arrangeLayout, externalRunningCount]);

  const selectedLayout = arrangeLayout || getSmartLayout();

  const handleArrange = useCallback(async (layout?: ArrangeLayout) => {
    if (externalRunningCount < 2 || isArranging) return;

    const targetLayout = layout || getSmartLayout();
    setIsArranging(true);
    setArrangeStatus('loading');

    try {
      const sessionIds = externalRunningSessions.map(s => s.id);
      await arrangeSessions(sessionIds, targetLayout);

      setArrangeStatus('success');
      const layoutNames: Record<ArrangeLayout, string> = {
        horizontal2: t('sessions.layoutHorizontal2'),
        vertical2: t('sessions.layoutVertical2'),
        grid4: t('sessions.layoutGrid4'),
        left_main3: t('sessions.layoutLeftMain3'),
      };
      toast.success(
        t('sessions.arrangeSuccess')
          .replace('{count}', String(externalRunningCount))
          .replace('{layout}', layoutNames[targetLayout])
      );

      // Reset success state after 1.5s
      setTimeout(() => setArrangeStatus('normal'), 1500);
    } catch (err) {
      setArrangeStatus('normal');
      toast.error(`${t('sessions.arrangeFailed')}: ${err}`);
    } finally {
      setIsArranging(false);
    }
  }, [externalRunningCount, isArranging, getSmartLayout, externalRunningSessions, arrangeSessions, t]);

  // Multi-session launch: serially launch N sessions, then auto-arrange
  const handleMultiLaunch = useCallback(async (dirs: string[], layout: ArrangeLayout) => {
    if (dirs.length === 0 || isMultiLaunching) return;

    setIsMultiLaunching(true);
    let successCount = 0;

    for (const dir of dirs) {
      try {
        await launchClaudeCode(dir);
        successCount++;
      } catch (err) {
        console.error(`Failed to launch session for ${dir}:`, err);
      }
    }

    // Wait for terminal windows to be ready before arranging
    if (successCount >= 2) {
      await new Promise(resolve => setTimeout(resolve, 800));

      try {
        const allRunning = useAppStore
          .getState()
          .sessions
          .filter((session) => session.status === 'running' && session.terminalType !== 'embedded');
        if (allRunning.length >= 2) {
          await arrangeSessions(allRunning.map(s => s.id), layout);
        }
        toast.success(
          t('sessions.multiLaunchSuccess').replace('{count}', String(successCount))
        );
      } catch (err) {
        // Sessions launched but arrange failed — still a partial success
        toast.success(
          t('sessions.multiLaunchPartial')
            .replace('{success}', String(successCount))
            .replace('{total}', String(dirs.length))
        );
      }
    } else if (successCount > 0) {
      toast.success(
        t('sessions.multiLaunchPartial')
          .replace('{success}', String(successCount))
          .replace('{total}', String(dirs.length))
      );
    }

    setIsMultiLaunching(false);
  }, [isMultiLaunching, launchClaudeCode, arrangeSessions, t]);

  const markLaunchSuccess = useCallback(() => {
    setLaunched(true);
    clearTimeout(launchedTimerRef.current);
    launchedTimerRef.current = setTimeout(() => setLaunched(false), 1200);
  }, []);

  const showLaunchError = useCallback((err: unknown) => {
    if (isLaunchAlreadyInProgressError(err)) {
      toast.error(t('sessions.launchAlreadyInProgress'));
      return;
    }

    toast.error(
      t('sessions.launchFailed').replace('{error}', formatSessionLaunchError(err))
    );
  }, [t]);

  // Browse directory and launch single session
  const handleBrowseAndLaunch = useCallback(async () => {
    if (isLaunching) return;
    setIsLaunching(true);
    try {
      const path = await openDirectoryPicker();
      if (!path) {
        return;
      }
      await launchSingleSession({
        selectedWorkingDir: path,
        onLaunch,
        onLaunchWithDir,
      });
      markLaunchSuccess();
    } catch (err) {
      console.error('Launch failed:', err);
      showLaunchError(err);
    } finally {
      setIsLaunching(false);
    }
  }, [isLaunching, openDirectoryPicker, onLaunch, onLaunchWithDir, markLaunchSuccess, showLaunchError]);

  // Single launch with pending/success/failure state
  const handleLaunchClick = useCallback(async () => {
    if (isLaunching) return;
    setIsLaunching(true);
    try {
      await launchSingleSession({
        selectedWorkingDir,
        onLaunch,
        onLaunchWithDir,
      });
      markLaunchSuccess();
    } catch (err) {
      console.error('Launch failed:', err);
      showLaunchError(err);
    } finally {
      setIsLaunching(false);
    }
  }, [isLaunching, selectedWorkingDir, onLaunch, onLaunchWithDir, markLaunchSuccess, showLaunchError]);

  // Select directory for launch
  const handleSelectDirectory = useCallback(async () => {
    const dir = await openDirectoryPicker();
    if (dir) {
      setSelectedWorkingDir(dir);
      setShowProjectPicker(false);
    }
  }, [openDirectoryPicker, setSelectedWorkingDir]);

  const handleSelectProject = useCallback((path: string) => {
    setSelectedWorkingDir(path);
    setShowProjectPicker(false);
  }, [setSelectedWorkingDir]);

  // Register keyboard shortcuts
  useKeyboardShortcuts({
    'meta+shift+l': () => {
      if (externalRunningCount >= 2) handleArrange();
    },
    'meta+shift+n': () => {
      setLauncherOpen(true);
    },
  });

  // --- Helper: find the merged display item for a session id ---
  const findDisplayItem = useCallback((id: string): DisplayItem | undefined => {
    return mergedSessions.find(item => item.session.id === id || item.unifiedSession?.id === id);
  }, [mergedSessions]);

  // --- Helper: check if a session has a real legacy match (not a placeholder) ---
  const hasLegacySession = useCallback((id: string): boolean => {
    return legacySessionById.has(id);
  }, [legacySessionById]);

  const handleFocus = async (id: string) => {
    const item = findDisplayItem(id);
    // Only call focus for interactive sessions with a real legacy entry
    if (item?.unifiedSession?.runtimeKind === 'headless') return;
    if (!hasLegacySession(id) && item?.unifiedSession?.runtimeKind === 'interactive') {
      // Unified-only interactive: still try — the interactive runtime manager may know it
      // even though SessionManager doesn't
    }
    try {
      await focusSession(id);
    } catch (err) {
      console.error('Failed to focus session:', err);
    }
  };

  const handleMinimize = async (id: string) => {
    const item = findDisplayItem(id);
    if (item?.unifiedSession?.runtimeKind === 'headless') return;
    const target = sessions.find((session) => session.id === id);
    if (target?.terminalType === 'embedded') {
      return;
    }
    try {
      await minimizeSession(id);
    } catch (err) {
      console.error('Failed to minimize session:', err);
    }
  };

  const handleOpenInTerminal = async (id: string, terminalType?: TmuxAttachTerminalType) => {
    try {
      await openInteractiveSessionInTerminal(id, terminalType);
    } catch (err) {
      console.error('Failed to open interactive session in terminal:', err);
    }
  };

  const handleRequestClose = (id: string) => {
    setConfirmingId(id);
  };

  const handleCancelClose = () => {
    setConfirmingId(null);
  };

  const handleConfirmClose = async (id: string) => {
    try {
      const item = findDisplayItem(id);
      const action = resolveSessionCloseAction({
        unifiedSession: item?.unifiedSession
          ? {
              runtimeKind: item.unifiedSession.runtimeKind,
              status: item.unifiedSession.status,
              id: item.unifiedSession.id,
            }
          : undefined,
        hasLegacySession: hasLegacySession(id),
      });
      switch (action) {
        case 'stopThenRemoveHeadless':
          await stopUnifiedSession(id);
          await removeHeadlessSession(id);
          break;
        case 'removeHeadless':
          await removeHeadlessSession(id);
          break;
        case 'closeUnifiedInteractive':
          await closeUnifiedInteractiveSession(id);
          break;
        case 'closeLegacyInteractive':
          await closeSession(id);
          break;
      }
    } catch (err) {
      console.error('Failed to close session:', err);
    } finally {
      setConfirmingId(null);
    }
  };

  const handleStopUnified = async (id: string) => {
    try {
      await stopUnifiedSession(id);
      toast.success(t('sessions.sessionStopped'));
    } catch (err) {
      toast.error(t('sessions.stopFailed').replace('{error}', String(err)));
    }
  };

  const handleRemoveHeadless = async (id: string) => {
    try {
      const item = findDisplayItem(id);
      // Stop if still running
      if (item?.unifiedSession && ['ready', 'processing', 'waiting_permission', 'initializing'].includes(item.unifiedSession.status)) {
        await stopUnifiedSession(id);
      }
      await removeHeadlessSession(id);
      toast.success(t('sessions.sessionStopped'));
    } catch (err) {
      toast.error(t('sessions.stopFailed').replace('{error}', String(err)));
    }
  };

  const handleDisconnectChannel = async (sessionId: string, channelKind: string) => {
    try {
      // Find the real ChannelKind from the unified session's channel data
      const item = findDisplayItem(sessionId);
      const channel = item?.unifiedSession?.channels.find(ch => ch.kind === channelKind);
      if (channel?.rawKind) {
        await detachChannel(sessionId, channel.rawKind);
      } else {
        console.error('Cannot disconnect: no rawKind for channel', channelKind);
      }
    } catch (err) {
      console.error('Failed to disconnect channel:', err);
    }
  };

  const handleMinimizeAll = async () => {
    for (const session of externalRunningSessions) {
      await minimizeSession(session.id);
    }
  };

  const handleCloseAll = async () => {
    setShowCloseAllDialog(false);
    // Close all merged sessions (both legacy and unified)
    for (const item of mergedSessions) {
      try {
        const id = item.session.id;
        const action = resolveSessionCloseAction({
          unifiedSession: item.unifiedSession
            ? {
                runtimeKind: item.unifiedSession.runtimeKind,
                status: item.unifiedSession.status,
                id: item.unifiedSession.id,
              }
            : undefined,
          hasLegacySession: hasLegacySession(id),
        });
        switch (action) {
          case 'stopThenRemoveHeadless':
            await stopUnifiedSession(id);
            await removeHeadlessSession(id);
            break;
          case 'removeHeadless':
            await removeHeadlessSession(id);
            break;
          case 'closeUnifiedInteractive':
            await closeUnifiedInteractiveSession(id);
            break;
          case 'closeLegacyInteractive':
            await closeSession(id);
            break;
        }
      } catch (err) {
        console.error('Failed to close session:', item.session.id, err);
      }
    }
  };

  // Total count for display (merged)
  const totalDisplayCount = totalCount;
  const sessionMotionKey = filteredSessions
    .map((item) => item.session.id)
    .join('\u0000');

  useGSAP(() => {
    const root = sessionsMotionRef.current;
    if (!root) {
      return;
    }

    const cards = gsap.utils.toArray<HTMLElement>('[data-session-motion-card]', root);
    if (cards.length === 0) {
      return;
    }
    if (shouldReduceMotion()) {
      clearMotionProps(cards);
      return;
    }

    gsap.fromTo(
      cards,
      { autoAlpha: 0, y: 8, scale: 0.985 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: ccemMotion.duration.base,
        ease: ccemMotion.ease.standard,
        stagger: 0.025,
        overwrite: 'auto',
        onComplete: () => clearMotionProps(cards),
      }
    );
  }, { scope: sessionsMotionRef, dependencies: [effectiveViewMode, sessionMotionKey] });

  const runtimeEnvironments = useMemo(
    () => filterRuntimeEnvironments(environments, enabledEnvironments, { currentEnv }),
    [currentEnv, enabledEnvironments, environments],
  );

  // Show skeleton when sessions are loading
  if (isLoadingSessions && !sessions.length && !unifiedSessions.length) {
    return <SessionsSkeleton />;
  }

  return (
    <div className="flex flex-col h-full">
      <SessionsPageActions
        effectiveViewMode={effectiveViewMode}
        hasUnifiedOnlyInView={hasUnifiedOnlyInView}
        currentEnv={currentEnv}
        environments={runtimeEnvironments}
        permissionMode={permissionMode as PermissionModeName}
        launchDirDisplay={launchDirDisplay}
        isLaunching={isLaunching}
        launched={launched}
        launcherOpen={launcherOpen}
        isMultiLaunching={isMultiLaunching}
        onViewModeChange={setViewMode}
        onEnvironmentChange={switchEnvironment}
        onPermissionModeChange={setPermissionMode}
        onOpenProjectPicker={() => setShowProjectPicker(true)}
        onLaunchClick={handleLaunchClick}
        onLauncherOpenChange={setLauncherOpen}
        onLaunchMulti={handleMultiLaunch}
        onBrowseAndLaunch={handleBrowseAndLaunch}
      />

      {/* Scrollable content */}
      <div ref={sessionsMotionRef} className="flex-1 overflow-y-auto px-5 py-5">
        {/* Arrange Banner */}
        {externalRunningCount >= 2 && (
          <div className="mb-5">
            <ArrangeBanner
              runningCount={externalRunningCount}
              onArrange={handleArrange}
              isArranging={isArranging}
              arrangeStatus={arrangeStatus}
              selectedLayout={selectedLayout}
              onSelectLayout={(layout) => setArrangeLayout(layout)}
              onMinimizeAll={handleMinimizeAll}
              onCloseAll={() => setShowCloseAllDialog(true)}
            />
          </div>
        )}

        {/* Recovery candidates */}
        {showRecoveryCandidates ? (
          <div className="mb-5">
            <Suspense fallback={null}>
              <LazyRecoveryCandidatesPanel />
            </Suspense>
          </div>
        ) : null}

        {/* Empty state OR session grid */}
        {totalDisplayCount === 0 ? (
          <div className="flex flex-col items-center justify-center py-14 sm:py-20 max-w-md mx-auto text-center">
            {/* Icon with tinted surface + soft glow halo */}
            <div className="relative mb-5">
              <div
                className="absolute inset-0 -m-3 rounded-[28px] bg-primary/[0.06] blur-2xl"
                aria-hidden
              />
              <div className="relative w-16 h-16 rounded-[18px] bg-[hsl(var(--surface-raised))] border border-[hsl(var(--border-subtle))] flex items-center justify-center">
                <Terminal className="w-7 h-7 text-primary/70" />
              </div>
            </div>

            <h2 className="text-[19px] font-semibold text-foreground tracking-[-0.01em] mb-1.5">
              {t('sessions.noActiveSessions')}
            </h2>
            <p className="text-[13px] text-muted-foreground leading-relaxed mb-5 max-w-[340px]">
              {t('sessions.detectionNote')}
            </p>

            <button
              type="button"
              onClick={handleLaunchClick}
              className="bg-primary text-white rounded-full px-5 py-2.5 text-[14px] font-medium hover:bg-primary/90 active:scale-95 transition-all flex items-center gap-1.5 shadow-sm"
            >
              <Plus className="w-4 h-4" />
              {t('sessions.newSession')}
            </button>
          </div>
        ) : (
          <div>
            <h3 className="text-[13px] font-medium text-muted-foreground tracking-[-0.01em] uppercase mb-4">
              {t('sessions.activeSessions')}
            </h3>

            {effectiveViewMode === 'card' ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                {filteredSessions.map((item) => (
                  <SessionCard
                    key={item.session.id}
                    session={item.session}
                    unifiedSession={item.unifiedSession}
                    terminalOptions={tmuxAttachTerminals}
                    onMenuIntent={ensureTmuxAttachTerminalsLoaded}
                    onFocus={handleFocus}
                    onOpenInTerminal={handleOpenInTerminal}
                    onMinimize={handleMinimize}
                    onClose={handleRequestClose}
                    onStop={handleStopUnified}
                    onRemove={handleRemoveHeadless}
                    onDisconnectChannel={handleDisconnectChannel}
                    confirmingClose={confirmingId === item.session.id}
                    onCancelClose={handleCancelClose}
                    onConfirmClose={handleConfirmClose}
                  />
                ))}
              </div>
            ) : (
              <SessionList
                sessions={filteredSessions.map(item => item.session)}
                terminalOptions={tmuxAttachTerminals}
                onMenuIntent={ensureTmuxAttachTerminalsLoaded}
                onFocus={handleFocus}
                onOpenInTerminal={handleOpenInTerminal}
                onMinimize={handleMinimize}
                onClose={handleRequestClose}
                confirmingId={confirmingId}
                onCancelClose={handleCancelClose}
                onConfirmClose={handleConfirmClose}
              />
            )}

            {/* Footer actions when no arrange banner */}
            {(() => {
              const arrangeBannerVisible = externalRunningCount >= 2;
              const hasAnySessions = mergedSessions.length > 0;
              if (arrangeBannerVisible || !hasAnySessions) return null;

              return (
                <div className="mt-5 pt-4 flex items-center gap-2 border-t border-[hsl(var(--border-subtle))]">
                  {externalRunningCount > 0 && (
                    <button
                      type="button"
                      onClick={handleMinimizeAll}
                      className="rounded-full border border-[hsl(var(--border-subtle))] px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-[hsl(var(--surface-raised))] active:scale-95 transition-all flex items-center gap-1.5"
                    >
                      <Minimize2 className="h-3.5 w-3.5" />
                      {t('sessions.minimizeAll')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowCloseAllDialog(true)}
                    className="rounded-full border border-[hsl(var(--border-subtle))] px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-[hsl(var(--surface-raised))] active:scale-95 transition-all flex items-center gap-1.5"
                  >
                    <X className="h-3.5 w-3.5" />
                    {t('sessions.closeAll')}
                  </button>
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Close All Dialog */}
      {showCloseAllDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-md"
            onClick={() => setShowCloseAllDialog(false)}
          />
          <div className="relative bg-card rounded-[18px] border border-[hsl(var(--border-subtle))] p-6 max-w-md w-full mx-4 shadow-lg">
            <h3 className="text-lg font-semibold text-foreground mb-2">
              {t('sessions.closeAllTitle')}
            </h3>
            <p className="text-sm text-muted-foreground mb-6">
              {t('sessions.closeAllDescription').replace('{count}', String(mergedSessions.length))}
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowCloseAllDialog(false)}
                className="rounded-full border border-[hsl(var(--border-subtle))] px-4 py-2 text-[14px] font-medium hover:bg-[hsl(var(--surface-raised))] transition-all"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleCloseAll}
                className="bg-destructive text-destructive-foreground rounded-full px-4 py-2 text-[14px] font-medium hover:bg-destructive/90 active:scale-95 transition-all"
              >
                {t('sessions.closeAll')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Project Picker Modal */}
      <ProjectPickerModal
        open={showProjectPicker}
        onOpenChange={setShowProjectPicker}
        onSelectProject={handleSelectProject}
        onBrowseFolder={handleSelectDirectory}
      />
    </div>
  );
}
