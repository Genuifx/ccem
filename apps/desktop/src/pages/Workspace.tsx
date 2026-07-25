import {
  type PointerEvent as ReactPointerEvent,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  ChevronDown,
  FolderOpen,
  LoaderCircle,
  Terminal,
} from '@/lib/lucide-react';
import { toast } from 'sonner';
import { shallow } from 'zustand/shallow';
import { WorkspaceStatusStrip } from '@/components/workspace/WorkspaceStatusStrip';
import { ProjectTree } from '@/components/workspace/ProjectTree';
import { WorkspaceGlobalSearch } from '@/components/workspace/WorkspaceGlobalSearch';
import { WorkspaceNativeSessionView } from '@/components/workspace/WorkspaceNativeSessionView';
import { WorkspaceHistoryErrorBoundary } from '@/components/workspace/WorkspaceHistoryErrorBoundary';
import { WorkspaceSessionComposer } from '@/components/workspace/WorkspaceSessionComposer';
import { BrowserPanel } from '@/components/workspace/BrowserPanel';
import { ComposerControls } from '@/components/workspace/ComposerControls';
import type { EffortLevel } from '@/components/workspace/ComposerControls';
import type { PermissionModeName } from '@ccem/core/browser';
import {
  buildComposerPromptPreview,
  buildComposerPromptText,
  extractComposerImagePayloads,
  type ComposerSubmitPayload,
} from '@/components/workspace/composerAttachments';
import { WorkspaceSkeleton } from '@/components/ui/skeleton-states';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAppStore } from '@/store';
import type { InstalledSkill, LaunchClient } from '@/store';
import { useTauriCommands } from '@/hooks/useTauriCommands';
import {
  useSessionInterruptedEvent,
  useSessionUpdatedEvent,
  useTaskCompletedEvent,
  useTaskErrorEvent,
} from '@/hooks/useTauriEvents';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useLocale } from '@/locales';
import { scheduleAfterFirstPaint } from '@/lib/idle';
import { cn, getProjectName } from '@/lib/utils';
import {
  fetchConversationDetail,
  fetchWorkspaceOverviewSnapshot,
  invalidateHistoryCache,
} from '@/features/conversations/historyData';
import type {
  ConversationContentBlock,
  ConversationMessageData,
  HistorySegment,
  HistorySessionItem,
  SessionStickerId,
  SessionTaskStage,
  WorkspaceProjectNode,
} from '@/features/conversations/types';
import { toSessionKey } from '@/features/conversations/types';
import { useWorkspaceSessionDecorations } from '@/components/workspace/useWorkspaceSessionDecorations';
import { useWorkspaceAnnotations } from '@/components/workspace/useWorkspaceAnnotations';
import type {
  NativeSessionSummary,
  SessionEventRecord,
  SessionPromptImage,
  WorkspaceCommand,
  WorkspaceGitSnapshot,
} from '@/lib/tauri-ipc';
import {
  buildLiveSessionTreeState,
  buildWorkspaceSidebarSessions,
  canRestoreWorkspaceLiveSession,
  findLiveEntryForSidebarSession,
  hasWorkspaceLiveActivityConflict,
  retainStableHistorySessions,
  resolveWorkspaceReviewProviderSessionId,
  selectWorkspaceLiveSessionsForRestore,
  toLiveHistorySessionItem,
} from '@/components/workspace/workspaceSidebarSessions';
import { launchWorkspaceTerminalSession } from '@/components/workspace/workspaceTerminalLaunch';
import {
  reconcileWorkspaceLiveSessionsSnapshot,
  updateWorkspaceLiveSessionsSnapshot,
  upsertWorkspaceLiveSessionEntry,
  type WorkspaceLiveSessionEntry,
  type WorkspaceLiveSessionsByRuntimeId,
} from '@/components/workspace/workspaceLiveSessions';
import {
  BROWSER_PANEL_DEFAULT_WIDTH_PERCENT,
  BROWSER_PANEL_MAX_WIDTH_PERCENT,
  BROWSER_PANEL_MIN_WIDTH_PX,
  BROWSER_PANEL_WIDTH_STORAGE_KEY,
  calculateBrowserPanelWidthPercent,
  clampBrowserPanelWidthPercent,
} from '@/components/workspace/browserPanelLayout';
import {
  WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX,
  WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY,
  calculateWorkspaceSidebarWidth,
  clampWorkspaceSidebarWidth,
} from '@/components/workspace/workspaceSidebarLayout';
import { LazyWorkspaceReviewPopover } from '@/components/workspace/LazyWorkspaceReviewPopover';
import {
  buildWorkspaceReviewModel,
  buildWorkspaceReviewSummary,
} from '@/components/workspace/workspaceReview';
import {
  normalizeEffortForProvider,
  resolveHistorySessionControls,
  updateHistorySessionPreference,
  type WorkspaceHistorySessionPreference,
  type WorkspaceHistorySessionPreferences,
} from '@/components/workspace/workspaceSessionPreferences';
import { resolveComposerDispatch } from '@/components/workspace/workspaceComposerDispatch';
import {
  buildWorkspaceCronAgentPrompt,
  isWorkspaceCronCommand,
} from '@/components/workspace/workspaceCronCommand';
import {
  buildMessagesFromEvents,
  selectSeedMessagesForNativeReplay,
  shouldSkipProviderSeedHydration,
} from '@/components/workspace/workspaceEventTranscript';
import {
  nativeSessionMatchesCcemSessionLink,
  parseCcemSessionLink,
  shouldPreferLiveSessionForCcemLink,
} from '@/components/workspace/sessionLinks';
import { buildPetNotificationId } from '@/lib/petNotifications';
import type { PetOpenSessionRequest } from '@/types/pet';

const LazyHistoryDetail = lazy(async () =>
  import('@/components/workspace/WorkspaceConversationDetail').then((m) => ({
    default: m.WorkspaceConversationDetail,
  }))
);

type WorkspaceViewMode = 'compose' | 'live' | 'history';

const ACTIVE_LIVE_RUNTIME_STORAGE_KEY = 'ccem-workspace-live-runtime';
const LIVE_RUNTIME_SET_STORAGE_KEY = 'ccem-workspace-live-runtimes';
const WORKSPACE_BROWSER_COMPOSE_SESSION_ID = 'workspace';
const WORKSPACE_HISTORY_SESSION_LIMIT = 240;
const NATIVE_ACTIVITY_CONFLICT_RETRY_MS = 3000;
const NATIVE_ACTIVITY_CONFLICT_MAX_RETRIES = 10;
const NATIVE_ACTIVITY_CONFLICT_MAX_RETRY_MS = 60_000;

function readStoredBrowserPanelWidthPercent(): number {
  try {
    return clampBrowserPanelWidthPercent(
      window.localStorage.getItem(BROWSER_PANEL_WIDTH_STORAGE_KEY)
        ?? BROWSER_PANEL_DEFAULT_WIDTH_PERCENT,
    );
  } catch {
    return BROWSER_PANEL_DEFAULT_WIDTH_PERCENT;
  }
}

function readStoredWorkspaceSidebarWidth(): number {
  try {
    return clampWorkspaceSidebarWidth(
      window.localStorage.getItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY)
        ?? WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX,
    );
  } catch {
    return WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX;
  }
}

function readPersistedLiveRuntimeIds(): string[] {
  const raw = localStorage.getItem(LIVE_RUNTIME_SET_STORAGE_KEY);
  const legacyActiveRuntimeId = localStorage.getItem(ACTIVE_LIVE_RUNTIME_STORAGE_KEY);

  if (!raw) {
    return legacyActiveRuntimeId ? [legacyActiveRuntimeId] : [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return legacyActiveRuntimeId ? [legacyActiveRuntimeId] : [];
    }

    const runtimeIds = parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (legacyActiveRuntimeId && !runtimeIds.includes(legacyActiveRuntimeId)) {
      runtimeIds.push(legacyActiveRuntimeId);
    }
    return runtimeIds;
  } catch {
    return legacyActiveRuntimeId ? [legacyActiveRuntimeId] : [];
  }
}

function writePersistedLiveRuntimeIds(runtimeIds: string[]) {
  if (runtimeIds.length === 0) {
    localStorage.removeItem(LIVE_RUNTIME_SET_STORAGE_KEY);
    return;
  }

  localStorage.setItem(LIVE_RUNTIME_SET_STORAGE_KEY, JSON.stringify(runtimeIds));
}

function DetailFallback() {
  return <div className="flex-1 overflow-hidden" />;
}

function contentBlockHasRenderableContent(
  block: ConversationContentBlock,
): boolean {
  if (typeof block.text === 'string' && block.text.trim()) {
    return true;
  }
  if (block.type === 'image') {
    return true;
  }
  if (typeof block.thinking === 'string' && block.thinking.trim()) {
    return true;
  }
  if (typeof block.content === 'string' && block.content.trim()) {
    return true;
  }
  return block.type === 'tool_use' || block.type === 'tool_result';
}

function messageHasRenderableContent(content: ConversationMessageData['content']): boolean {
  if (typeof content === 'string') {
    return content.trim().length > 0;
  }
  if (Array.isArray(content)) {
    return content.some(contentBlockHasRenderableContent);
  }
  if (content && typeof content === 'object') {
    return contentBlockHasRenderableContent(content as ConversationContentBlock);
  }
  return false;
}

function hasNativeHistoryTranscriptMessages(messages: ConversationMessageData[]): boolean {
  return messages.some((message) =>
    ['user', 'human', 'assistant', 'ai'].includes(message.msgType)
    && messageHasRenderableContent(message.content)
  );
}

function nativeSessionMatchesHistorySession(
  nativeSession: NativeSessionSummary,
  session: HistorySessionItem,
  runtimeId?: string | null,
): boolean {
  if (nativeSession.provider !== session.source) {
    return false;
  }
  if (runtimeId) {
    return nativeSession.runtime_id === runtimeId;
  }
  return nativeSession.runtime_id === session.id
    || nativeSession.provider_session_id === session.id;
}

function sortNativeSessionsByUpdatedAt(
  sessions: NativeSessionSummary[],
): NativeSessionSummary[] {
  return [...sessions].sort((left, right) =>
    Date.parse(right.updated_at) - Date.parse(left.updated_at)
  );
}

interface WorkspaceProps {
  isActive?: boolean;
  onNavigate: (tab: string) => void;
  onLaunchWithDir: (dir: string, client?: LaunchClient) => void;
  composeSeed?: { id: number; value: string } | null;
  petOpenRequest?: PetOpenSessionRequest | null;
  onPetOpenHandled?: () => void;
  sessionLinkRequest?: { id: number; link: string } | null;
  onSessionLinkHandled?: () => void;
}

export function Workspace({
  isActive = true,
  onNavigate,
  composeSeed = null,
  petOpenRequest = null,
  onPetOpenHandled,
  sessionLinkRequest = null,
  onSessionLinkHandled,
}: WorkspaceProps) {
  const { t } = useLocale();
  const {
    isLoadingEnvs,
    isLoadingStats,
    environments,
    currentEnv,
    enabledEnvironments,
    permissionMode,
    selectedWorkingDir,
    defaultWorkingDir,
    launchClient,
    installedSkills,
    setSelectedWorkingDir,
    setLaunchClient,
    setPermissionMode,
  } = useAppStore(
    (state) => ({
      isLoadingEnvs: state.isLoadingEnvs,
      isLoadingStats: state.isLoadingStats,
      environments: state.environments,
      currentEnv: state.currentEnv,
      enabledEnvironments: state.enabledEnvironments,
      permissionMode: state.permissionMode,
      selectedWorkingDir: state.selectedWorkingDir,
      defaultWorkingDir: state.defaultWorkingDir,
      launchClient: state.launchClient,
      installedSkills: state.installedSkills,
      setSelectedWorkingDir: state.setSelectedWorkingDir,
      setLaunchClient: state.setLaunchClient,
      setPermissionMode: state.setPermissionMode,
    }),
    shallow
  );
  const workspaceReviewOpen = useAppStore((state) => state.reviewPanelOpen);
  const setWorkspaceReviewOpen = useAppStore((state) => state.setReviewPanelOpen);
  const setReviewEntry = useAppStore((state) => state.setReviewEntry);

  const {
    switchEnvironment,
    openDirectoryPicker,
    loadCronTasks,
    loadInstalledSkills,
    loadWorkspaceSkills,
    loadWorkspaceCommands,
    checkCodexInstalled,
    checkOpenCodeInstalled,
    setSessionTitle,
    setSessionAnnotation,
    createNativeSession,
    getNativeSessionEvents,
    listNativeSessions,
    launchOpenCodeWeb,
    launchClaudeCode,
    searchWorkspaceFiles,
    stopNativeSession,
    generateWorkspaceSessionTitle,
    getWorkspaceGitSnapshot,
    getWorkspaceFileDiff,
    getWorkspaceMediaPreview,
    getSessionSubagents,
  } = useTauriCommands();

  const [sessions, setSessions] = useState<HistorySessionItem[]>([]);
  const sessionsRef = useRef<HistorySessionItem[]>([]);
  const [precomputedProjectNodes, setPrecomputedProjectNodes] = useState<WorkspaceProjectNode[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessageData[]>([]);
  const [segments, setSegments] = useState<HistorySegment[]>([]);
  const [historyEvents, setHistoryEvents] = useState<SessionEventRecord[]>([]);
  const [activeSegment, setActiveSegment] = useState<number | null>(null);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [codexInstalled, setCodexInstalled] = useState(false);
  const [opencodeInstalled, setOpenCodeInstalled] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceViewMode>('compose');
  const [composeProvider, setComposeProvider] = useState<'claude' | 'codex'>(
    launchClient === 'codex' ? 'codex' : 'claude'
  );
  const [composePrompt, setComposePrompt] = useState('');
  const composePromptRef = useRef('');
  const composeHasDraftRef = useRef(false);
  const [composePromptRevision, setComposePromptRevision] = useState(0);
  const [composeHasDraft, setComposeHasDraft] = useState(false);
  const [composePlanModeEnabled, setComposePlanModeEnabled] = useState(false);
  const [historyComposerText, setHistoryComposerText] = useState('');
  const historyComposerTextRef = useRef('');
  const historyHasDraftRef = useRef(false);
  const [historyComposerRevision, setHistoryComposerRevision] = useState(0);
  const [historyHasDraft, setHistoryHasDraft] = useState(false);
  const [historyPlanModeEnabled, setHistoryPlanModeEnabled] = useState(false);
  const [historyEnv, setHistoryEnv] = useState('');
  const [historyPermMode, setHistoryPermMode] = useState<PermissionModeName>(permissionMode);
  const [composeEffort, setComposeEffort] = useState<EffortLevel>('max');
  const [historyEffort, setHistoryEffort] = useState<EffortLevel>('max');
  const [historySessionPreferences, setHistorySessionPreferences] = useState<WorkspaceHistorySessionPreferences>({});
  const [composeDir, setComposeDir] = useState<string | null>(selectedWorkingDir || defaultWorkingDir || null);
  const [workspaceInstalledSkills, setWorkspaceInstalledSkills] = useState<InstalledSkill[]>([]);
  const [workspaceCommands, setWorkspaceCommands] = useState<WorkspaceCommand[]>([]);
  const [liveSessionsByRuntimeId, setLiveSessionsByRuntimeId] = useState<WorkspaceLiveSessionsByRuntimeId>({});
  const liveSessionsByRuntimeIdRef = useRef<WorkspaceLiveSessionsByRuntimeId>(liveSessionsByRuntimeId);
  const nativeSessionRestoreRequestSeqRef = useRef(0);
  const [activeLiveRuntimeId, setActiveLiveRuntimeId] = useState<string | null>(null);
  const [hasAttemptedNativeSessionRestore, setHasAttemptedNativeSessionRestore] = useState(false);
  const [workspaceGitSnapshot, setWorkspaceGitSnapshot] = useState<WorkspaceGitSnapshot | null>(null);
  const [isRefreshingWorkspaceGitSnapshot, setIsRefreshingWorkspaceGitSnapshot] = useState(false);
  const workspaceGitSnapshotRequestSeqRef = useRef(0);
  const lastComposeSeedIdRef = useRef<number | null>(null);
  const [isCreatingNativeSession, setIsCreatingNativeSession] = useState(false);
  const [isLaunchingComposeTerminal, setIsLaunchingComposeTerminal] = useState(false);
  const [isResumingHistorySession, setIsResumingHistorySession] = useState(false);
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false);
  const [browserOpenBySessionId, setBrowserOpenBySessionId] = useState<Record<string, boolean>>({});
  const [browserPanelWidthPercent, setBrowserPanelWidthPercent] = useState(
    readStoredBrowserPanelWidthPercent,
  );
  const [workspaceSidebarWidth, setWorkspaceSidebarWidth] = useState(readStoredWorkspaceSidebarWidth);
  const browserLayoutRef = useRef<HTMLDivElement>(null);
  const workspaceColumnRef = useRef<HTMLDivElement>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshRequestSeqRef = useRef(0);
  const skillsBootstrapAttemptedRef = useRef(false);
  const conversationRequestSeqRef = useRef(0);
  const hydratingLiveRuntimeIdsRef = useRef(new Set<string>());
  const hydratedLiveRuntimeIdsRef = useRef(new Set<string>());
  const pendingRefreshRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const prevIsActiveRef = useRef(isActive);
  const selectedKeyRef = useRef<string | null>(null);
  const persistedGeneratedTitleKeysRef = useRef(new Set<string>());
  const reviewOwnerKey = `${workspaceMode}:${selectedKey ?? ''}:${activeLiveRuntimeId ?? ''}:${composeDir ?? ''}`;
  const reviewOwnerKeyRef = useRef(reviewOwnerKey);

  useLayoutEffect(() => {
    const ownerChanged = reviewOwnerKeyRef.current !== reviewOwnerKey;
    reviewOwnerKeyRef.current = reviewOwnerKey;
    if ((!isActive || ownerChanged) && workspaceReviewOpen) {
      setWorkspaceReviewOpen(false);
    }
  }, [isActive, reviewOwnerKey, setWorkspaceReviewOpen, workspaceReviewOpen]);

  const handleComposePromptChange = useCallback((value: string) => {
    composePromptRef.current = value;
    const hasDraft = value.trim().length > 0;
    if (composeHasDraftRef.current !== hasDraft) {
      composeHasDraftRef.current = hasDraft;
      setComposeHasDraft(hasDraft);
    }
  }, []);

  const resetComposePrompt = useCallback((value = '') => {
    handleComposePromptChange(value);
    setComposePrompt(value);
    setComposePromptRevision((revision) => revision + 1);
  }, [handleComposePromptChange]);

  const handleHistoryComposerTextChange = useCallback((value: string) => {
    historyComposerTextRef.current = value;
    const hasDraft = value.trim().length > 0;
    if (historyHasDraftRef.current !== hasDraft) {
      historyHasDraftRef.current = hasDraft;
      setHistoryHasDraft(hasDraft);
    }
  }, []);

  const resetHistoryComposerText = useCallback((value = '') => {
    handleHistoryComposerTextChange(value);
    setHistoryComposerText(value);
    setHistoryComposerRevision((revision) => revision + 1);
  }, [handleHistoryComposerTextChange]);

  useEffect(() => {
    selectedKeyRef.current = selectedKey;
  }, [selectedKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        BROWSER_PANEL_WIDTH_STORAGE_KEY,
        String(browserPanelWidthPercent),
      );
    } catch {
      // Ignore private-mode storage failures; the current session width still works.
    }
  }, [browserPanelWidthPercent]);

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY, String(workspaceSidebarWidth));
    } catch {
      // Ignore private-mode storage failures; the current session width still works.
    }
  }, [workspaceSidebarWidth]);

  const handleBrowserPanelResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    const layout = browserLayoutRef.current;
    if (!layout) {
      return;
    }

    event.preventDefault();

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const updateWidth = (clientX: number) => {
      const rect = layout.getBoundingClientRect();
      setBrowserPanelWidthPercent(
        calculateBrowserPanelWidthPercent({
          layoutWidth: rect.width,
          layoutRight: rect.right,
          pointerClientX: clientX,
        }),
      );
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateWidth(moveEvent.clientX);
    };
    const stopResize = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };

    updateWidth(event.clientX);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }, []);

  const handleWorkspaceSidebarResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    const layout = workspaceColumnRef.current;
    if (!layout) {
      return;
    }

    event.preventDefault();

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const updateWidth = (clientX: number) => {
      const rect = layout.getBoundingClientRect();
      setWorkspaceSidebarWidth(calculateWorkspaceSidebarWidth({
        layoutLeft: rect.left,
        pointerClientX: clientX,
      }));
    };

    const handlePointerMove = (moveEvent: PointerEvent) => updateWidth(moveEvent.clientX);
    const stopResize = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };

    updateWidth(event.clientX);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listen<{ sessionId?: string; session_id?: string; cause?: string }>('browser_panel_requested', (event) => {
      if (event.payload?.cause && event.payload.cause !== 'agent_reveal') {
        return;
      }
      const requestedSessionId = event.payload?.sessionId
        ?? event.payload?.session_id
        ?? WORKSPACE_BROWSER_COMPOSE_SESSION_ID;
      setBrowserOpenBySessionId((previous) => {
        if (previous[requestedSessionId]) {
          return previous;
        }
        return {
          ...previous,
          [requestedSessionId]: true,
        };
      });
    }).then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    }).catch((error) => {
      console.error('Failed to listen for browser panel requests:', error);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (selectedWorkingDir && selectedWorkingDir !== composeDir) {
      setComposeDir(selectedWorkingDir);
    }
  }, [composeDir, selectedWorkingDir]);

  useEffect(() => {
    if (!composeSeed || composeSeed.id === lastComposeSeedIdRef.current) {
      return;
    }
    lastComposeSeedIdRef.current = composeSeed.id;
    setWorkspaceMode('compose');
    resetComposePrompt(composeSeed.value);
    setComposePlanModeEnabled(false);
    if (!composeDir && (selectedWorkingDir || defaultWorkingDir)) {
      setComposeDir(selectedWorkingDir || defaultWorkingDir || null);
    }
  }, [composeDir, composeSeed, defaultWorkingDir, resetComposePrompt, selectedWorkingDir]);

  const updateLiveSessionsByRuntimeId = useCallback((
    updater: (previous: WorkspaceLiveSessionsByRuntimeId) => WorkspaceLiveSessionsByRuntimeId,
  ) => {
    return updateWorkspaceLiveSessionsSnapshot(
      liveSessionsByRuntimeIdRef,
      setLiveSessionsByRuntimeId,
      updater,
    );
  }, []);

  const upsertLiveSessionEntry = useCallback((
    session: NativeSessionSummary,
    options: {
      initialPrompt?: string | null;
      initialImages?: SessionPromptImage[] | null;
      generatedTitle?: string | null;
      seedMessages?: ConversationMessageData[];
    } = {},
  ) => {
    updateLiveSessionsByRuntimeId((previous) =>
      upsertWorkspaceLiveSessionEntry(previous, session, options)
    );
  }, [updateLiveSessionsByRuntimeId]);

  const setLiveSessionGeneratedTitle = useCallback((runtimeId: string, title: string) => {
    updateLiveSessionsByRuntimeId((previous) => {
      const existing = previous[runtimeId];
      if (!existing) {
        return previous;
      }

      return upsertWorkspaceLiveSessionEntry(previous, existing.session, {
        generatedTitle: title,
      });
    });
  }, [updateLiveSessionsByRuntimeId]);

  const restoreNativeSessions = useCallback(async ({
    restorePersistedSelection = true,
  }: {
    restorePersistedSelection?: boolean;
  } = {}) => {
    const requestSeq = ++nativeSessionRestoreRequestSeqRef.current;
    const persistedRuntimeId = localStorage.getItem(ACTIVE_LIVE_RUNTIME_STORAGE_KEY);
    const persistedRuntimeIds = readPersistedLiveRuntimeIds();
    const requestBaseline = liveSessionsByRuntimeIdRef.current;

    try {
      const nativeSessions = await listNativeSessions();
      if (requestSeq !== nativeSessionRestoreRequestSeqRef.current) {
        return;
      }
      const restoredSessions = selectWorkspaceLiveSessionsForRestore(
        nativeSessions,
        persistedRuntimeIds,
      );
      const reconciledSessions = updateLiveSessionsByRuntimeId((previous) =>
        reconcileWorkspaceLiveSessionsSnapshot(previous, restoredSessions, requestBaseline)
      );

      if (Object.keys(reconciledSessions).length === 0) {
        localStorage.removeItem(ACTIVE_LIVE_RUNTIME_STORAGE_KEY);
        localStorage.removeItem(LIVE_RUNTIME_SET_STORAGE_KEY);
        if (restorePersistedSelection) {
          setActiveLiveRuntimeId(null);
        }
        return;
      }

      if (!restorePersistedSelection || !persistedRuntimeId) {
        return;
      }

      const target = reconciledSessions[persistedRuntimeId]?.session;
      if (!target) {
        localStorage.removeItem(ACTIVE_LIVE_RUNTIME_STORAGE_KEY);
        setActiveLiveRuntimeId(null);
        return;
      }

      setActiveLiveRuntimeId(target.runtime_id);
      setComposeDir(target.project_dir);
      setSelectedWorkingDir(target.project_dir);
      setWorkspaceMode('live');
    } catch (error) {
      if (requestSeq === nativeSessionRestoreRequestSeqRef.current) {
        console.error('Failed to restore native workspace sessions:', error);
      }
    } finally {
      if (requestSeq === nativeSessionRestoreRequestSeqRef.current) {
        setHasAttemptedNativeSessionRestore(true);
      }
    }
  }, [listNativeSessions, setSelectedWorkingDir, updateLiveSessionsByRuntimeId]);

  useEffect(() => {
    if (installedSkills.length === 0 || workspaceInstalledSkills.length > 0) {
      return;
    }
    setWorkspaceInstalledSkills(installedSkills);
  }, [installedSkills, workspaceInstalledSkills.length]);

  useEffect(() => {
    const cancelDeferred = scheduleAfterFirstPaint(() => {
      void loadCronTasks().catch(() => {});
      void loadInstalledSkills()
        .then((skills) => {
          if (skills.length > 0) {
            setWorkspaceInstalledSkills(skills);
          }
        })
        .catch(() => {});
      checkCodexInstalled().then(setCodexInstalled).catch(() => {});
      checkOpenCodeInstalled().then(setOpenCodeInstalled).catch(() => {});
      void restoreNativeSessions();
    }, { delayMs: 220, timeoutMs: 1400 });

    return () => {
      cancelDeferred();
    };
  }, [checkCodexInstalled, checkOpenCodeInstalled, loadCronTasks, loadInstalledSkills, restoreNativeSessions]);

  useEffect(() => {
    if (installedSkills.length > 0 || skillsBootstrapAttemptedRef.current) {
      return;
    }

    skillsBootstrapAttemptedRef.current = true;
    void loadInstalledSkills()
      .then((skills) => {
        if (skills.length > 0) {
          setWorkspaceInstalledSkills(skills);
        }
      })
      .catch(() => {
        skillsBootstrapAttemptedRef.current = false;
      });
  }, [installedSkills.length, loadInstalledSkills]);

  const replaceSessions = useCallback((nextSessions: HistorySessionItem[]) => {
    const retainedSessions = retainStableHistorySessions(sessionsRef.current, nextSessions);
    sessionsRef.current = retainedSessions;
    setSessions(retainedSessions);
    return retainedSessions;
  }, []);

  const syncSessionState = useCallback((nextSessions: HistorySessionItem[]) => {
    const retainedSessions = replaceSessions(nextSessions);

    const currentSelectedKey = selectedKeyRef.current;
    if (!currentSelectedKey) {
      return retainedSessions;
    }

    const liveSessionsSnapshot = liveSessionsByRuntimeIdRef.current;
    const stillExists = retainedSessions.some((session) => toSessionKey(session) === currentSelectedKey)
      || Object.values(liveSessionsSnapshot).some((entry) => {
        const liveItem = toLiveHistorySessionItem(entry);
        return liveItem ? toSessionKey(liveItem) === currentSelectedKey : false;
      });
    if (!stillExists) {
      selectedKeyRef.current = null;
      setSelectedKey(null);
      setMessages([]);
      setSegments([]);
      setHistoryEvents([]);
      setActiveSegment(null);
      setIsLoadingMessages(false);
      if (Object.keys(liveSessionsSnapshot).length === 0) {
        setWorkspaceMode('compose');
      }
    }
    return retainedSessions;
  }, [replaceSessions]);

  useEffect(() => {
    if (!hasAttemptedNativeSessionRestore) {
      return;
    }

    if (activeLiveRuntimeId) {
      localStorage.setItem(ACTIVE_LIVE_RUNTIME_STORAGE_KEY, activeLiveRuntimeId);
      return;
    }
    localStorage.removeItem(ACTIVE_LIVE_RUNTIME_STORAGE_KEY);
  }, [activeLiveRuntimeId, hasAttemptedNativeSessionRestore]);

  useEffect(() => {
    if (!hasAttemptedNativeSessionRestore) {
      return;
    }

    const restorableRuntimeIds = Object.values(liveSessionsByRuntimeId)
      .filter((entry) => canRestoreWorkspaceLiveSession(entry.session))
      .map((entry) => entry.session.runtime_id);
    writePersistedLiveRuntimeIds(restorableRuntimeIds);
  }, [hasAttemptedNativeSessionRestore, liveSessionsByRuntimeId]);

  const activeLiveEntry = activeLiveRuntimeId
    ? liveSessionsByRuntimeId[activeLiveRuntimeId] ?? null
    : null;

  const statusStripEnvContext = useMemo(() => {
    if (workspaceMode === 'history') {
      return historyEnv || undefined;
    }
    if (workspaceMode === 'live') {
      return activeLiveEntry?.session.env_name || undefined;
    }
    return undefined;
  }, [workspaceMode, historyEnv, activeLiveEntry]);

  useEffect(() => {
    if (workspaceMode !== 'live') {
      return;
    }

    const providerSessionId = activeLiveEntry?.session.provider_session_id;
    if (!providerSessionId) {
      return;
    }

    const matchingSession = sessions.find((session) =>
      session.id === providerSessionId
      && session.source === activeLiveEntry.session.provider,
    );
    if (!matchingSession) {
      return;
    }

    const nextKey = toSessionKey(matchingSession);
    if (selectedKeyRef.current === nextKey) {
      return;
    }

    selectedKeyRef.current = nextKey;
    setSelectedKey(nextKey);
  }, [activeLiveEntry, sessions, workspaceMode]);

  const loadNativeHistoryConversation = useCallback(async (
    nativeSession: NativeSessionSummary,
  ): Promise<{
    messages: ConversationMessageData[];
    segments: HistorySegment[];
    events: SessionEventRecord[];
  } | null> => {
    const replayBatch = await getNativeSessionEvents(nativeSession.runtime_id, null, null);
    if (replayBatch.events.length === 0) {
      return null;
    }

    const nativeMessages = buildMessagesFromEvents(
      [],
      [],
      replayBatch.events,
      nativeSession.status === 'error' ? nativeSession.last_error : null,
    );
    return {
      messages: nativeMessages,
      segments: [],
      events: replayBatch.events,
    };
  }, [getNativeSessionEvents]);

  const loadConversation = useCallback(
    async (
      session: HistorySessionItem,
      options: {
        resetBeforeLoad?: boolean;
        showLoading?: boolean;
        nativeHistorySession?: NativeSessionSummary | null;
      } = {}
    ) => {
      const { resetBeforeLoad = true, showLoading = true } = options;
      const hasNativeHistorySessionOption = Object.prototype.hasOwnProperty.call(
        options,
        'nativeHistorySession',
      );
      const requestSeq = ++conversationRequestSeqRef.current;

      if (resetBeforeLoad) {
        setMessages([]);
        setSegments([]);
        if (hasNativeHistorySessionOption) {
          setHistoryEvents([]);
        }
        setActiveSegment(null);
      }

      if (showLoading) {
        setIsLoadingMessages(true);
      }

      try {
        const nativeHistory = options.nativeHistorySession
          ? await loadNativeHistoryConversation(options.nativeHistorySession).catch((error) => {
            console.error('Failed to load native history transcript:', error);
            return null;
          })
          : null;
        if (requestSeq !== conversationRequestSeqRef.current) {
          return;
        }
        if (nativeHistory && hasNativeHistoryTranscriptMessages(nativeHistory.messages)) {
          setMessages(nativeHistory.messages);
          setSegments(nativeHistory.segments);
          setHistoryEvents(nativeHistory.events);
          return;
        }

        if (hasNativeHistorySessionOption) {
          setHistoryEvents(nativeHistory?.events ?? []);
        }
        const { messages: msgs, segments: segs } = await fetchConversationDetail(session);

        if (requestSeq !== conversationRequestSeqRef.current) {
          return;
        }

        setMessages(msgs);
        setSegments(segs);
      } catch (error) {
        if (requestSeq !== conversationRequestSeqRef.current) {
          return;
        }
        console.error('Failed to load conversation:', error);
      } finally {
        if (showLoading && requestSeq === conversationRequestSeqRef.current) {
          setIsLoadingMessages(false);
        }
      }
    },
    [loadNativeHistoryConversation]
  );

  const refreshWorkspaceData = useCallback(
    async (
      options: { force?: boolean; silent?: boolean; includeSelectedConversation?: boolean } = {}
    ) => {
      const {
        force = true,
        silent = true,
        includeSelectedConversation = true,
      } = options;
      const requestSeq = ++refreshRequestSeqRef.current;

      setIsRefreshing(true);
      if (!hasLoadedRef.current) {
        setIsLoadingSessions(true);
      }

      try {
        const snapshot = await fetchWorkspaceOverviewSnapshot(
          WORKSPACE_HISTORY_SESSION_LIMIT,
          force,
        );

        if (requestSeq !== refreshRequestSeqRef.current) {
          return null;
        }

        const retainedSessions = syncSessionState(snapshot.sessions);
        setPrecomputedProjectNodes(snapshot.projectNodes);
        hasLoadedRef.current = true;

        if (includeSelectedConversation) {
          const currentSelectedKey = selectedKeyRef.current;
          if (currentSelectedKey) {
            const selectedSession = retainedSessions.find(
              (session) => toSessionKey(session) === currentSelectedKey
            );
            if (selectedSession) {
              await loadConversation(selectedSession, {
                resetBeforeLoad: false,
                showLoading: false,
              });
            }
          }
        }

        return retainedSessions;
      } catch (error) {
        if (requestSeq !== refreshRequestSeqRef.current) {
          return null;
        }

        console.error('Failed to refresh workspace history:', error);
        if (!silent) {
          toast.error(t('workspace.refreshFailed'));
        }
        return null;
      } finally {
        if (requestSeq === refreshRequestSeqRef.current) {
          setIsRefreshing(false);
          setIsLoadingSessions(false);
          pendingRefreshRef.current = false;
        }
      }
    },
    [loadConversation, syncSessionState, t]
  );

  const scheduleWorkspaceRefresh = useCallback((delayMs = 700) => {
    pendingRefreshRef.current = true;

    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }

    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      if (!isActive) {
        return;
      }

      void refreshWorkspaceData({
        force: true,
        silent: true,
        includeSelectedConversation: true,
      });
    }, delayMs);
  }, [isActive, refreshWorkspaceData]);

  useEffect(() => {
    for (const entry of Object.values(liveSessionsByRuntimeId)) {
      const generatedTitle = entry.generatedTitle?.trim();
      const providerSessionId = entry.session.provider_session_id?.trim();
      if (!generatedTitle || !providerSessionId) {
        continue;
      }

      const key = `${entry.session.provider}:${providerSessionId}:${generatedTitle}`;
      if (persistedGeneratedTitleKeysRef.current.has(key)) {
        continue;
      }

      persistedGeneratedTitleKeysRef.current.add(key);
      void setSessionTitle(entry.session.provider, providerSessionId, generatedTitle)
        .then(() => {
          invalidateHistoryCache();
          scheduleWorkspaceRefresh(650);
        })
        .catch((error) => {
          persistedGeneratedTitleKeysRef.current.delete(key);
          console.error('Failed to persist generated provider session title:', error);
        });
    }
  }, [liveSessionsByRuntimeId, scheduleWorkspaceRefresh, setSessionTitle]);

  useEffect(() => {
    void refreshWorkspaceData({
      force: false,
      silent: true,
      includeSelectedConversation: false,
    });
  }, [refreshWorkspaceData]);

  useEffect(() => {
    if (!hasLoadedRef.current) {
      prevIsActiveRef.current = isActive;
      return;
    }

    const becameActive = isActive && !prevIsActiveRef.current;
    prevIsActiveRef.current = isActive;

    if (!becameActive) {
      return;
    }

    void refreshWorkspaceData({
      force: true,
      silent: true,
      includeSelectedConversation: true,
    });
  }, [isActive, refreshWorkspaceData]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const handleWindowFocus = () => {
      scheduleWorkspaceRefresh(220);
    };

    window.addEventListener('focus', handleWindowFocus);
    return () => {
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [isActive, scheduleWorkspaceRefresh]);

  useSessionUpdatedEvent(() => {
    scheduleWorkspaceRefresh();
  });

  useTaskCompletedEvent(() => {
    scheduleWorkspaceRefresh();
  });

  useTaskErrorEvent(() => {
    scheduleWorkspaceRefresh();
  });

  useSessionInterruptedEvent(() => {
    scheduleWorkspaceRefresh();
  });

  const selectedSession = useMemo(() => {
    if (!selectedKey) return null;
    return sessions.find((session) => toSessionKey(session) === selectedKey) ?? null;
  }, [selectedKey, sessions]);
  const historyAnnotationSessionKey = selectedSession
    ? `history:${selectedSession.source}:${selectedSession.id}`
    : null;
  const historyAnnotations = useWorkspaceAnnotations(historyAnnotationSessionKey);

  const activeBrowserSessionId = useMemo(() => {
    if (workspaceMode === 'live' && activeLiveEntry) {
      return activeLiveEntry.session.runtime_id;
    }
    if (workspaceMode === 'history' && selectedSession) {
      return `history:${selectedSession.source}:${selectedSession.id}`;
    }
    return WORKSPACE_BROWSER_COMPOSE_SESSION_ID;
  }, [activeLiveEntry, selectedSession, workspaceMode]);

  const browserPanelOpen = browserOpenBySessionId[activeBrowserSessionId] ?? false;

  const setActiveBrowserPanelOpen = useCallback((next: boolean | ((previous: boolean) => boolean)) => {
    setBrowserOpenBySessionId((previous) => {
      const previousOpen = previous[activeBrowserSessionId] ?? false;
      const nextOpen = typeof next === 'function' ? next(previousOpen) : next;
      if (previousOpen === nextOpen) {
        return previous;
      }
      return {
        ...previous,
        [activeBrowserSessionId]: nextOpen,
      };
    });
  }, [activeBrowserSessionId]);

  useEffect(() => {
    void invoke('browser_set_active_session', {
      sessionId: activeBrowserSessionId,
      visible: browserPanelOpen,
    }).catch((error) => {
      console.error('Failed to sync active browser session:', error);
    });
  }, [activeBrowserSessionId, browserPanelOpen]);

  useEffect(() => {
    setComposeEffort((previous) => normalizeEffortForProvider(previous, composeProvider));
  }, [composeProvider]);

  useEffect(() => {
    if (!selectedSession) {
      return;
    }

    const controls = resolveHistorySessionControls({
      session: selectedSession,
      preferences: historySessionPreferences,
      currentEnv,
      defaultPermMode: permissionMode,
    });

    resetHistoryComposerText('');
    setHistoryPlanModeEnabled(false);
    setHistoryEnv(controls.envName);
    setHistoryPermMode(controls.permMode);
    setHistoryEffort(controls.effort);
  }, [resetHistoryComposerText, selectedKey]);

  const environmentByName = useMemo(
    () => Object.fromEntries(environments.map((environment) => [environment.name, environment])),
    [environments]
  );

  const liveSessionEntries = useMemo(
    () => Object.values(liveSessionsByRuntimeId),
    [liveSessionsByRuntimeId],
  );

  const sidebarSessions = useMemo(
    () => buildWorkspaceSidebarSessions(sessions, liveSessionEntries),
    [liveSessionEntries, sessions],
  );

  const liveSessionTreeState = useMemo(
    () => buildLiveSessionTreeState(liveSessionEntries),
    [liveSessionEntries],
  );

  useEffect(() => {
    const currentKey = selectedKeyRef.current;
    if (!currentKey) {
      return;
    }
    const canonicalKey = liveSessionTreeState.canonicalKeyBySessionKey[currentKey] ?? currentKey;
    if (canonicalKey === currentKey) {
      return;
    }
    selectedKeyRef.current = canonicalKey;
    setSelectedKey(canonicalKey);
  }, [liveSessionTreeState.canonicalKeyBySessionKey]);

  const { decorationsBySessionKey } = useWorkspaceSessionDecorations({
    sessions: sidebarSessions,
    isActive,
  });

  const hasNativeActivityTruthConflict = useMemo(
    () => hasWorkspaceLiveActivityConflict(
      liveSessionTreeState.activeSessionKeys,
      decorationsBySessionKey,
    ),
    [decorationsBySessionKey, liveSessionTreeState.activeSessionKeys],
  );

  useEffect(() => {
    if (!isActive || !hasAttemptedNativeSessionRestore || !hasNativeActivityTruthConflict) {
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    let retryCount = 0;
    const reconcileNativeActivity = async () => {
      await restoreNativeSessions({ restorePersistedSelection: false });
      if (cancelled) {
        return;
      }
      if (retryCount >= NATIVE_ACTIVITY_CONFLICT_MAX_RETRIES) {
        console.warn(
          `Native activity conflict persisted after ${NATIVE_ACTIVITY_CONFLICT_MAX_RETRIES} retries; stopping background reconciliation.`,
        );
        return;
      }
      const delay = Math.min(
        NATIVE_ACTIVITY_CONFLICT_RETRY_MS * 2 ** retryCount,
        NATIVE_ACTIVITY_CONFLICT_MAX_RETRY_MS,
      );
      retryCount++;
      retryTimer = window.setTimeout(
        () => void reconcileNativeActivity(),
        delay,
      );
    };

    void reconcileNativeActivity();
    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [
    hasAttemptedNativeSessionRestore,
    hasNativeActivityTruthConflict,
    isActive,
    restoreNativeSessions,
  ]);

  const findLiveEntryForSession = useCallback((session: HistorySessionItem) => {
    const sessionKey = toSessionKey(session);
    const runtimeId = decorationsBySessionKey[sessionKey]?.runtimeId;

    if (runtimeId && liveSessionsByRuntimeId[runtimeId]) {
      return liveSessionsByRuntimeId[runtimeId];
    }

    return findLiveEntryForSidebarSession(liveSessionEntries, session);
  }, [decorationsBySessionKey, liveSessionEntries, liveSessionsByRuntimeId]);

  const shouldHydrateLiveEntryFromHistory = useCallback((entry: WorkspaceLiveSessionEntry | null | undefined) => {
    if (!entry?.session.provider_session_id) {
      return false;
    }

    if (hydratedLiveRuntimeIdsRef.current.has(entry.session.runtime_id)) {
      return false;
    }

    if (entry.seedMessages.length > 0) {
      return false;
    }

    return true;
  }, []);

  const hydrateLiveEntryFromHistory = useCallback(async (
    session: NativeSessionSummary,
  ): Promise<ConversationMessageData[] | null> => {
    if (!session.provider_session_id) {
      return null;
    }

    if (hydratingLiveRuntimeIdsRef.current.has(session.runtime_id)) {
      return null;
    }

    hydratingLiveRuntimeIdsRef.current.add(session.runtime_id);

    try {
      const replayBatch = session.last_event_seq == null
        ? null
        : await getNativeSessionEvents(session.runtime_id, null, 1).catch((error) => {
          console.error('Failed to read native session prompt anchors:', error);
          return null;
        });
      const hasPersistedUserPrompt = replayBatch?.events.some((event) =>
        event.payload.type === 'user_prompt',
      ) ?? false;
      const seedBoundaryMessageCount = session.seed_boundary_message_count ?? null;

      if (session.last_event_seq != null && !hasPersistedUserPrompt) {
        hydratedLiveRuntimeIdsRef.current.add(session.runtime_id);
        return [];
      }

      if (
        shouldSkipProviderSeedHydration(replayBatch, seedBoundaryMessageCount)
      ) {
        upsertLiveSessionEntry(session, {
          seedMessages: [],
        });
        hydratedLiveRuntimeIdsRef.current.add(session.runtime_id);
        return [];
      }

      const { messages: historyMessages } = await fetchConversationDetail({
        id: session.provider_session_id,
        source: session.provider,
      });
      const seedMessages = replayBatch
        ? selectSeedMessagesForNativeReplay(historyMessages, replayBatch, seedBoundaryMessageCount)
        : historyMessages;

      upsertLiveSessionEntry(session, {
        seedMessages,
      });
      hydratedLiveRuntimeIdsRef.current.add(session.runtime_id);

      return seedMessages;
    } catch (error) {
      console.error('Failed to hydrate live workspace session from history:', error);
      return null;
    } finally {
      hydratingLiveRuntimeIdsRef.current.delete(session.runtime_id);
    }
  }, [getNativeSessionEvents, upsertLiveSessionEntry]);

  const findNativeHistorySessionForSession = useCallback(async (
    session: HistorySessionItem,
  ): Promise<NativeSessionSummary | null> => {
    const runtimeId = decorationsBySessionKey[toSessionKey(session)]?.runtimeId;
    const nativeSessions = await listNativeSessions();
    return sortNativeSessionsByUpdatedAt(
      nativeSessions.filter((nativeSession) =>
        nativeSessionMatchesHistorySession(nativeSession, session, runtimeId)
      ),
    )[0] ?? null;
  }, [decorationsBySessionKey, listNativeSessions]);

  const ensureLiveEntryForSession = useCallback(async (
    session: HistorySessionItem,
  ): Promise<WorkspaceLiveSessionEntry | null> => {
    const existing = findLiveEntryForSession(session);
    if (existing) {
      const hydratedMessages = shouldHydrateLiveEntryFromHistory(existing)
        ? await hydrateLiveEntryFromHistory(existing.session)
        : null;
      return {
        ...existing,
        seedMessages: hydratedMessages ?? existing.seedMessages,
      };
    }

    const runtimeId = decorationsBySessionKey[toSessionKey(session)]?.runtimeId;
    const nativeSessions = await listNativeSessions();
    const matchingSession = nativeSessions
      .filter((nativeSession) => {
        if (!canRestoreWorkspaceLiveSession(nativeSession)) {
          return false;
        }

        if (runtimeId) {
          return nativeSession.runtime_id === runtimeId;
        }

        return nativeSession.provider === session.source
          && (
            nativeSession.runtime_id === session.id
            || nativeSession.provider_session_id === session.id
          );
      })
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))[0];

    if (!matchingSession) {
      return null;
    }

    upsertLiveSessionEntry(matchingSession);
    const hydratedMessages = await hydrateLiveEntryFromHistory(matchingSession);
    return {
      session: matchingSession,
      initialPrompt: null,
      initialImages: null,
      seedMessages: hydratedMessages ?? [],
    };
  }, [
    decorationsBySessionKey,
    findLiveEntryForSession,
    hydrateLiveEntryFromHistory,
    listNativeSessions,
    shouldHydrateLiveEntryFromHistory,
    upsertLiveSessionEntry,
  ]);

  const markPetNotificationReadForSession = useCallback(async (
    session: HistorySessionItem,
    liveEntry?: WorkspaceLiveSessionEntry | null,
  ) => {
    const liveSession = liveEntry?.session;
    let runtimeId = liveSession?.runtime_id;
    let provider: 'claude' | 'codex' | undefined = liveSession?.provider;
    let status = liveSession?.status;

    if (!runtimeId || !provider || !status) {
      const decoration = decorationsBySessionKey[toSessionKey(session)];
      if (!decoration?.runtimeId || !decoration.client || !decoration.status) {
        return;
      }
      if (decoration.client === 'opencode') {
        return;
      }

      runtimeId = decoration.runtimeId;
      provider = decoration.client;
      status = decoration.status;
    }

    try {
      await invoke('mark_pet_notification_read', {
        notificationId: buildPetNotificationId(provider, runtimeId, status),
      });
    } catch (error) {
      console.error('Failed to mark pet notification as read from workspace selection:', error);
    }
  }, [decorationsBySessionKey]);

  useEffect(() => {
    if (!activeLiveEntry || !shouldHydrateLiveEntryFromHistory(activeLiveEntry)) {
      return;
    }

    void hydrateLiveEntryFromHistory(activeLiveEntry.session);
  }, [activeLiveEntry, hydrateLiveEntryFromHistory, shouldHydrateLiveEntryFromHistory]);

  const effectiveComposeDir = composeDir || selectedWorkingDir || defaultWorkingDir || null;
  const effectiveComposeDirLabel = effectiveComposeDir ? getProjectName(effectiveComposeDir) : null;
  const shouldRenderWorkspaceReview = workspaceMode !== 'live' || !activeLiveEntry;
  const workspaceReviewEvents = useMemo(
    () => workspaceMode === 'history' && selectedSession ? historyEvents : [],
    [historyEvents, selectedSession, workspaceMode],
  );
  const workspaceReviewWorkingDir = workspaceMode === 'history' && selectedSession
    ? selectedSession.project || null
    : effectiveComposeDir;
  const workspaceReviewProviderSessionId = workspaceMode === 'history' && selectedSession
    ? resolveWorkspaceReviewProviderSessionId(selectedSession, findLiveEntryForSession(selectedSession))
    : null;
  const workspaceReviewSession = useMemo<NativeSessionSummary>(() => {
    const provider = workspaceMode === 'history' && selectedSession
      ? selectedSession.source === 'codex' ? 'codex' : 'claude'
      : composeProvider;
    const envName = workspaceMode === 'history' && selectedSession
      ? historyEnv
      : currentEnv;
    const permMode = workspaceMode === 'history' && selectedSession
      ? historyPermMode
      : permissionMode;
    const effort = workspaceMode === 'history' && selectedSession
      ? historyEffort
      : composeEffort;

    return {
      runtime_id: workspaceMode === 'history' && selectedSession
        ? `history:${selectedSession.source}:${selectedSession.id}`
        : 'compose',
      provider,
      transport: 'native_sdk',
      provider_session_id: workspaceMode === 'history' && selectedSession
        ? workspaceReviewProviderSessionId
        : null,
      project_dir: workspaceReviewWorkingDir || '',
      env_name: envName || '—',
      perm_mode: permMode,
      runtime_perm_mode: null,
      effort,
      status: workspaceMode === 'history' && selectedSession ? 'history' : 'ready',
      created_at: '',
      updated_at: '',
      is_active: false,
      last_event_seq: null,
      seed_boundary_message_count: null,
      can_handoff_to_terminal: false,
      last_error: null,
    };
  }, [
    composeEffort,
    composeProvider,
    currentEnv,
    historyEffort,
    historyEnv,
    historyPermMode,
    permissionMode,
    selectedSession,
    workspaceMode,
    workspaceReviewWorkingDir,
    workspaceReviewProviderSessionId,
  ]);
  const workspaceReviewSummary = useMemo(
    () => buildWorkspaceReviewSummary({
      events: workspaceReviewEvents,
      gitSnapshot: workspaceGitSnapshot,
    }),
    [workspaceGitSnapshot, workspaceReviewEvents],
  );
  const workspaceReviewModel = useMemo(
    () => {
      if (!workspaceReviewOpen || !shouldRenderWorkspaceReview) {
        return null;
      }

      return buildWorkspaceReviewModel({
        session: workspaceReviewSession,
        events: workspaceReviewEvents,
        messages: workspaceMode === 'history' ? messages : [],
        gitSnapshot: workspaceGitSnapshot,
      });
    },
    [
      messages,
      shouldRenderWorkspaceReview,
      workspaceGitSnapshot,
      workspaceMode,
      workspaceReviewEvents,
      workspaceReviewOpen,
      workspaceReviewSession,
    ],
  );

  // Publish review summary to the status-strip entry pill while compose/history owns the view.
  useEffect(() => {
    if (!shouldRenderWorkspaceReview) {
      return;
    }
    setReviewEntry({
      envName: workspaceReviewSession.env_name,
      failedTools: workspaceReviewSummary.failedTools,
      changedFiles: workspaceReviewSummary.changedFiles,
      artifacts: workspaceReviewSummary.artifacts,
    });
  }, [
    shouldRenderWorkspaceReview,
    workspaceReviewSession.env_name,
    workspaceReviewSummary.failedTools,
    workspaceReviewSummary.changedFiles,
    workspaceReviewSummary.artifacts,
    setReviewEntry,
  ]);

  const refreshWorkspaceGitSnapshot = useCallback(async () => {
    const requestSeq = workspaceGitSnapshotRequestSeqRef.current + 1;
    workspaceGitSnapshotRequestSeqRef.current = requestSeq;
    const workingDir = workspaceReviewWorkingDir;

    if (!workingDir) {
      setWorkspaceGitSnapshot(null);
      return;
    }

    setIsRefreshingWorkspaceGitSnapshot(true);
    try {
      const snapshot = await getWorkspaceGitSnapshot(workingDir);
      if (workspaceGitSnapshotRequestSeqRef.current === requestSeq) {
        setWorkspaceGitSnapshot(snapshot);
      }
    } catch (error) {
      if (workspaceGitSnapshotRequestSeqRef.current === requestSeq) {
        setWorkspaceGitSnapshot({
          is_repo: false,
          root: null,
          branch: null,
          sha: null,
          upstream: null,
          dirty_count: 0,
          files: [],
          error: String(error),
        });
      }
    } finally {
      if (workspaceGitSnapshotRequestSeqRef.current === requestSeq) {
        setIsRefreshingWorkspaceGitSnapshot(false);
      }
    }
  }, [getWorkspaceGitSnapshot, workspaceReviewWorkingDir]);

  useEffect(() => {
    workspaceGitSnapshotRequestSeqRef.current += 1;
    setWorkspaceGitSnapshot(null);
    setIsRefreshingWorkspaceGitSnapshot(false);
  }, [workspaceReviewWorkingDir]);

  useEffect(() => {
    if (!isActive || !shouldRenderWorkspaceReview) {
      return;
    }
    const delay = workspaceReviewOpen ? 250 : 1200;
    const timeoutId = window.setTimeout(() => {
      void refreshWorkspaceGitSnapshot();
    }, delay);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    isActive,
    refreshWorkspaceGitSnapshot,
    shouldRenderWorkspaceReview,
    workspaceReviewOpen,
    workspaceReviewWorkingDir,
    workspaceMode,
  ]);

  const skillsContext = useMemo(() => {
    if (workspaceMode === 'history' && selectedSession) {
      return {
        workingDir: selectedSession.project || null,
        provider: selectedSession.source === 'codex' ? 'codex' : 'claude',
      };
    }
    if (workspaceMode === 'live' && activeLiveEntry) {
      return {
        workingDir: activeLiveEntry.session.project_dir || null,
        provider: activeLiveEntry.session.provider,
      };
    }
    return {
      workingDir: effectiveComposeDir,
      provider: composeProvider,
    };
  }, [
    activeLiveEntry,
    composeProvider,
    effectiveComposeDir,
    selectedSession,
    workspaceMode,
  ]);

  useEffect(() => {
    let cancelled = false;
    void loadWorkspaceSkills({
      workingDir: skillsContext.workingDir,
      provider: skillsContext.provider,
    })
      .then((skills) => {
        if (cancelled) {
          return;
        }
        if (skills.length > 0) {
          setWorkspaceInstalledSkills(skills);
          return;
        }
        setWorkspaceInstalledSkills(installedSkills);
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspaceInstalledSkills(installedSkills);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [installedSkills, loadWorkspaceSkills, skillsContext]);

  useEffect(() => {
    let cancelled = false;
    void loadWorkspaceCommands({
      workingDir: skillsContext.workingDir,
      provider: skillsContext.provider,
    })
      .then((commands) => {
        if (!cancelled) {
          setWorkspaceCommands(commands);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspaceCommands([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [loadWorkspaceCommands, skillsContext]);

  const refreshWorkspaceInstalledSkills = useCallback(async () => {
    const skills = await loadWorkspaceSkills({
      workingDir: skillsContext.workingDir,
      provider: skillsContext.provider,
    });
    const nextSkills = skills.length > 0 ? skills : installedSkills;
    setWorkspaceInstalledSkills(nextSkills);
    return nextSkills;
  }, [installedSkills, loadWorkspaceSkills, skillsContext]);

  const handleSelect = useCallback(
    async (
      session: HistorySessionItem,
      options?: {
        forceHistory?: boolean;
        nativeHistorySession?: NativeSessionSummary | null;
      },
    ) => {
      const key = toSessionKey(session);
      setSelectedKey(key);
      selectedKeyRef.current = key;

      const liveEntry = options?.forceHistory ? null : await ensureLiveEntryForSession(session);
      await markPetNotificationReadForSession(session, liveEntry);
      if (liveEntry && canRestoreWorkspaceLiveSession(liveEntry.session)) {
        setActiveLiveRuntimeId(liveEntry.session.runtime_id);
        setComposeDir(liveEntry.session.project_dir);
        setSelectedWorkingDir(liveEntry.session.project_dir);
        setWorkspaceMode('live');
        return;
      }

      const shouldLookupNativeHistory = options?.nativeHistorySession === undefined;
      const nativeHistorySession = shouldLookupNativeHistory
        ? await findNativeHistorySessionForSession(session)
        : options.nativeHistorySession ?? null;

      setWorkspaceMode('history');
      await loadConversation(session, {
        resetBeforeLoad: true,
        showLoading: true,
        nativeHistorySession,
      });
    },
    [
      ensureLiveEntryForSession,
      findNativeHistorySessionForSession,
      loadConversation,
      markPetNotificationReadForSession,
      setSelectedWorkingDir,
    ]
  );

  const selectNativeSessionSummary = useCallback((session: NativeSessionSummary) => {
    const existingEntry = liveSessionsByRuntimeIdRef.current[session.runtime_id];
    upsertLiveSessionEntry(session, {
      initialPrompt: existingEntry?.initialPrompt ?? null,
      initialImages: existingEntry?.initialImages ?? null,
      seedMessages: existingEntry?.seedMessages ?? [],
    });

    const liveItem = toLiveHistorySessionItem({
      session,
      initialPrompt: existingEntry?.initialPrompt ?? null,
      generatedTitle: existingEntry?.generatedTitle ?? null,
    });
    if (liveItem) {
      const nextKey = toSessionKey(liveItem);
      selectedKeyRef.current = nextKey;
      setSelectedKey(nextKey);
    }

    setActiveLiveRuntimeId(session.runtime_id);
    setComposeDir(session.project_dir);
    setSelectedWorkingDir(session.project_dir);
    setWorkspaceMode('live');
  }, [setSelectedWorkingDir, upsertLiveSessionEntry]);

  const openCcemSessionLink = useCallback(async (link: string) => {
    const parsed = parseCcemSessionLink(link);
    if (!parsed) {
      toast.error(t('workspace.sessionLinkInvalid'));
      return;
    }

    const targetRuntimeId = parsed.runtimeId || (parsed.idKind === 'runtime' ? parsed.id : null);
    const targetProviderSessionId = parsed.providerSessionId || (parsed.idKind === 'provider' ? parsed.id : null);
    const preferLiveSession = shouldPreferLiveSessionForCcemLink(parsed);
    let matchingNativeSession: NativeSessionSummary | null = null;

    if (preferLiveSession && targetRuntimeId) {
      const liveEntry = liveSessionsByRuntimeIdRef.current[targetRuntimeId];
      if (liveEntry && canRestoreWorkspaceLiveSession(liveEntry.session)) {
        selectNativeSessionSummary(liveEntry.session);
        return;
      }
    }

    if (targetRuntimeId || targetProviderSessionId) {
      const nativeSessions = await listNativeSessions().catch((error) => {
        console.error('Failed to list native sessions for ccem link:', error);
        return [] as NativeSessionSummary[];
      });
      matchingNativeSession = sortNativeSessionsByUpdatedAt(
        nativeSessions.filter((session) => nativeSessionMatchesCcemSessionLink(parsed, session)),
      )[0] ?? null;

      if (
        preferLiveSession
        && matchingNativeSession
        && canRestoreWorkspaceLiveSession(matchingNativeSession)
      ) {
        selectNativeSessionSummary(matchingNativeSession);
        return;
      }
    }

    const matchesParsedSession = (session: HistorySessionItem) => {
      if (session.source !== parsed.source) {
        return false;
      }
      if (session.id === parsed.id) {
        return true;
      }
      if (targetProviderSessionId && session.id === targetProviderSessionId) {
        return true;
      }
      if (targetRuntimeId && session.id === targetRuntimeId) {
        return true;
      }
      return false;
    };

    const matchingSession = sidebarSessions.find(matchesParsedSession);
    if (matchingSession) {
      await handleSelect(matchingSession, {
        forceHistory: !preferLiveSession,
        nativeHistorySession: matchingNativeSession,
      });
      return;
    }

    const refreshedSessions = await refreshWorkspaceData({
      force: true,
      silent: true,
      includeSelectedConversation: false,
    });
    const refreshedMatchingSession = refreshedSessions?.find(matchesParsedSession);
    if (refreshedMatchingSession) {
      await handleSelect(refreshedMatchingSession, {
        forceHistory: !preferLiveSession,
        nativeHistorySession: matchingNativeSession,
      });
      return;
    }

    toast.error(t('workspace.sessionLinkNotFound'));
  }, [
    handleSelect,
    listNativeSessions,
    refreshWorkspaceData,
    selectNativeSessionSummary,
    sidebarSessions,
    t,
  ]);

  useEffect(() => {
    if (!isActive || !sessionLinkRequest) {
      return;
    }

    void openCcemSessionLink(sessionLinkRequest.link)
      .finally(() => {
        onSessionLinkHandled?.();
      });
  }, [
    isActive,
    onSessionLinkHandled,
    openCcemSessionLink,
    sessionLinkRequest,
  ]);

  useEffect(() => {
    if (!isActive || !petOpenRequest) {
      return;
    }

    const openFromRequest = async () => {
      const liveEntry = liveSessionsByRuntimeId[petOpenRequest.runtimeId];
      if (liveEntry && canRestoreWorkspaceLiveSession(liveEntry.session)) {
        setActiveLiveRuntimeId(liveEntry.session.runtime_id);
        setComposeDir(liveEntry.session.project_dir);
        setSelectedWorkingDir(liveEntry.session.project_dir);
        setWorkspaceMode('live');
        onPetOpenHandled?.();
        return;
      }

      const matchingSession = sidebarSessions.find((session) => {
        if (session.id === petOpenRequest.runtimeId) {
          return true;
        }
        if (petOpenRequest.providerSessionId && session.id === petOpenRequest.providerSessionId) {
          return true;
        }
        return false;
      });

      if (matchingSession) {
        await handleSelect(matchingSession);
        onPetOpenHandled?.();
        return;
      }

      const refreshedSessions = await refreshWorkspaceData({
        force: true,
        silent: true,
        includeSelectedConversation: false,
      });
      const refreshedMatchingSession = refreshedSessions?.find((session) => {
        if (session.id === petOpenRequest.runtimeId) {
          return true;
        }
        if (petOpenRequest.providerSessionId && session.id === petOpenRequest.providerSessionId) {
          return true;
        }
        return false;
      });
      if (refreshedMatchingSession) {
        await handleSelect(refreshedMatchingSession);
      }
      onPetOpenHandled?.();
    };

    void openFromRequest();
  }, [
    handleSelect,
    isActive,
    liveSessionsByRuntimeId,
    onPetOpenHandled,
    petOpenRequest,
    refreshWorkspaceData,
    setSelectedWorkingDir,
    sidebarSessions,
  ]);

  const openComposer = useCallback((client: 'claude' | 'codex', dir?: string | null) => {
    setComposeProvider(client);
    setLaunchClient(client);
    setWorkspaceMode('compose');
    setSelectedKey(null);
    selectedKeyRef.current = null;
    if (dir) {
      setComposeDir(dir);
      setSelectedWorkingDir(dir);
    }
  }, [setLaunchClient, setSelectedWorkingDir]);

  const handleNewSession = useCallback(async (client: LaunchClient = 'claude') => {
    if (client === 'opencode') {
      try {
        let targetDir = effectiveComposeDir;
        if (!targetDir) {
          targetDir = await openDirectoryPicker();
        }
        await launchOpenCodeWeb(targetDir ?? null, currentEnv || null);
      } catch (error) {
        console.error('Failed to launch OpenCode Web UI:', error);
        toast.error(t('workspace.openCodeLaunchFailed'));
      }
      return;
    }

    openComposer(client, effectiveComposeDir);
  }, [
    currentEnv,
    effectiveComposeDir,
    launchOpenCodeWeb,
    openComposer,
    openDirectoryPicker,
    t,
  ]);

  const handlePickComposeDir = useCallback(async () => {
    try {
      const dir = await openDirectoryPicker();
      if (dir) {
        setComposeDir(dir);
        setSelectedWorkingDir(dir);
      }
    } catch (error) {
      console.error('Failed to open directory dialog:', error);
    }
  }, [openDirectoryPicker, setSelectedWorkingDir]);

  const handleLaunchComposeTerminal = useCallback(async () => {
    if (isLaunchingComposeTerminal) {
      return;
    }

    setIsLaunchingComposeTerminal(true);
    try {
      const result = await launchWorkspaceTerminalSession({
        prompt: composePromptRef.current,
        provider: composeProvider,
        currentEnv,
        workingDir: effectiveComposeDir,
        pickWorkingDir: openDirectoryPicker,
        launchTerminal: launchClaudeCode,
        onWorkingDirResolved: (targetDir) => {
          setComposeDir(targetDir);
          setSelectedWorkingDir(targetDir);
        },
        scheduleRefresh: scheduleWorkspaceRefresh,
      });
      if (!result.launched) {
        return;
      }

      toast.success(t('workspace.nativeHandoffDone'));
    } catch (error) {
      console.error('Failed to launch workspace terminal session:', error);
      toast.error(t('workspace.nativeHandoffFailed'));
    } finally {
      setIsLaunchingComposeTerminal(false);
    }
  }, [
    composeProvider,
    currentEnv,
    effectiveComposeDir,
    isLaunchingComposeTerminal,
    launchClaudeCode,
    openDirectoryPicker,
    scheduleWorkspaceRefresh,
    setSelectedWorkingDir,
    t,
  ]);

  const saveSelectedHistoryPreference = useCallback((patch: WorkspaceHistorySessionPreference) => {
    const key = selectedKeyRef.current;
    if (!key) {
      return;
    }

    setHistorySessionPreferences((previous) =>
      updateHistorySessionPreference(previous, key, patch),
    );
  }, []);

  const handleHistoryEnvChange = useCallback((envName: string) => {
    setHistoryEnv(envName);
    saveSelectedHistoryPreference({ envName });
  }, [saveSelectedHistoryPreference]);

  const handleHistoryPermModeChange = useCallback((mode: PermissionModeName) => {
    setHistoryPermMode(mode);
    saveSelectedHistoryPreference({ permMode: mode });
  }, [saveSelectedHistoryPreference]);

  const handleHistoryEffortChange = useCallback((effort: EffortLevel) => {
    const nextEffort = normalizeEffortForProvider(effort, selectedSession?.source);
    setHistoryEffort(nextEffort);
    saveSelectedHistoryPreference({ effort: nextEffort });
  }, [saveSelectedHistoryPreference, selectedSession?.source]);

  const handleCreateForProject = useCallback((projectPath: string) => {
    openComposer(composeProvider, projectPath);
  }, [composeProvider, openComposer]);

  const requestWorkspaceSessionTitle = useCallback((session: NativeSessionSummary, titleInput: string) => {
    const normalizedInput = titleInput.trim();
    if (!normalizedInput) {
      return;
    }

    void generateWorkspaceSessionTitle(normalizedInput)
      .then(async (generatedTitle) => {
        const title = generatedTitle?.trim();
        if (!title) {
          return;
        }

        setLiveSessionGeneratedTitle(session.runtime_id, title);
        await setSessionTitle(session.provider, session.runtime_id, title).catch((error) => {
          console.error('Failed to persist generated runtime session title:', error);
        });

        const latestSession = liveSessionsByRuntimeIdRef.current[session.runtime_id]?.session ?? session;
        const providerSessionId = latestSession.provider_session_id?.trim();
        if (providerSessionId) {
          await setSessionTitle(session.provider, providerSessionId, title).catch((error) => {
            console.error('Failed to persist generated provider session title:', error);
          });
        }

        invalidateHistoryCache();
        scheduleWorkspaceRefresh(650);
      })
      .catch((error) => {
        console.error('Failed to generate workspace session title:', error);
      });
  }, [
    generateWorkspaceSessionTitle,
    scheduleWorkspaceRefresh,
    setLiveSessionGeneratedTitle,
    setSessionTitle,
  ]);

  const handleCreateNativeConversation = useCallback(async (payload?: ComposerSubmitPayload) => {
    if (isCreatingNativeSession) {
      return false;
    }

    const rawPrompt = payload?.text ?? composePromptRef.current;
    const displayPrompt = payload?.displayText ?? rawPrompt;
    const attachments = payload?.attachments ?? [];
    const workingDir = effectiveComposeDir;
    const isCronCommand = isWorkspaceCronCommand(rawPrompt);
    const cronAgentPrompt = isCronCommand
      ? buildWorkspaceCronAgentPrompt(rawPrompt, workingDir)
      : null;
    if (isCronCommand) {
      if (attachments.length > 0) {
        toast.error(t('workspace.cronCommandInvalid'));
        return false;
      }
      if (!cronAgentPrompt) {
        toast.error(t('workspace.cronCommandInvalid'));
        return false;
      }
    }
    const prompt = cronAgentPrompt?.prompt ?? buildComposerPromptText(rawPrompt, attachments);
    const images = extractComposerImagePayloads(attachments);
    if ((!prompt && images.length === 0) || !workingDir) {
      return false;
    }
    const previewPrompt = buildComposerPromptPreview(displayPrompt, attachments);

    const dispatch = resolveComposerDispatch({
      provider: composeProvider,
      prompt,
      permissionMode,
      planModeEnabled: isCronCommand ? false : composePlanModeEnabled,
    });

    setIsCreatingNativeSession(true);
    try {
      const summary = await createNativeSession({
        provider: composeProvider,
        envName: currentEnv,
        permMode: dispatch.permMode,
        runtimePermMode: dispatch.runtimePermMode,
        workingDir,
        initialPrompt: dispatch.prompt,
        initialDisplayPrompt: previewPrompt,
        initialImages: images.length > 0 ? images : undefined,
        effort: normalizeEffortForProvider(composeEffort, composeProvider),
        seedBoundaryMessageCount: 0,
      });

      upsertLiveSessionEntry(summary, {
        initialPrompt: previewPrompt,
        initialImages: images.length > 0 ? images : null,
        seedMessages: [],
      });
      const liveItem = toLiveHistorySessionItem({
        session: summary,
        initialPrompt: previewPrompt,
      });
      if (liveItem) {
        const nextKey = toSessionKey(liveItem);
        selectedKeyRef.current = nextKey;
        setSelectedKey(nextKey);
      }
      requestWorkspaceSessionTitle(summary, previewPrompt);
      setActiveLiveRuntimeId(summary.runtime_id);
      setWorkspaceMode('live');
      resetComposePrompt('');
      setComposePlanModeEnabled(false);
      setSelectedWorkingDir(workingDir);
      scheduleWorkspaceRefresh(1200);
      return true;
    } catch (error) {
      console.error('Failed to create native workspace session:', error);
      toast.error(t('workspace.nativeCreateFailed'));
      return false;
    } finally {
      setIsCreatingNativeSession(false);
    }
  }, [
    buildComposerPromptPreview,
    buildComposerPromptText,
    extractComposerImagePayloads,
    composeEffort,
    composeProvider,
    composePlanModeEnabled,
    createNativeSession,
    currentEnv,
    effectiveComposeDir,
    isCreatingNativeSession,
    permissionMode,
    requestWorkspaceSessionTitle,
    resetComposePrompt,
    scheduleWorkspaceRefresh,
    setSelectedWorkingDir,
    upsertLiveSessionEntry,
    t,
  ]);

  const handleContinueHistorySession = useCallback(async (payload?: ComposerSubmitPayload) => {
    if (isResumingHistorySession) {
      return false;
    }

    if (!selectedSession) {
      return false;
    }

    if (selectedSession.source === 'opencode') {
      try {
        await launchOpenCodeWeb(selectedSession.project, selectedSession.envName ?? currentEnv ?? null);
      } catch (error) {
        console.error('Failed to launch OpenCode Web UI from history:', error);
        toast.error(t('workspace.openCodeLaunchFailed'));
      }
      return false;
    }

    const rawPrompt = payload?.text ?? historyComposerTextRef.current;
    const displayPrompt = payload?.displayText ?? rawPrompt;
    const attachments = payload?.attachments ?? [];
    const isCronCommand = isWorkspaceCronCommand(rawPrompt);
    const cronAgentPrompt = isCronCommand
      ? buildWorkspaceCronAgentPrompt(rawPrompt, selectedSession.project)
      : null;
    if (isCronCommand) {
      if (attachments.length > 0) {
        toast.error(t('workspace.cronCommandInvalid'));
        return false;
      }
      if (!cronAgentPrompt) {
        toast.error(t('workspace.cronCommandInvalid'));
        return false;
      }
    }
    const prompt = cronAgentPrompt?.prompt ?? buildComposerPromptText(rawPrompt, attachments);
    const images = extractComposerImagePayloads(attachments);
    if ((!prompt && images.length === 0) || !selectedSession.project) {
      return false;
    }

    const provider = selectedSession.source;
    const previewPrompt = buildComposerPromptPreview(displayPrompt, attachments);
    const dispatch = resolveComposerDispatch({
      provider,
      prompt,
      permissionMode: historyPermMode,
      planModeEnabled: isCronCommand ? false : historyPlanModeEnabled,
    });
    setIsResumingHistorySession(true);

    try {
      const summary = await createNativeSession({
        provider,
        envName: historyEnv,
        permMode: dispatch.permMode,
        runtimePermMode: dispatch.runtimePermMode,
        workingDir: selectedSession.project,
        initialPrompt: dispatch.prompt,
        initialDisplayPrompt: previewPrompt,
        initialImages: images.length > 0 ? images : undefined,
        providerSessionId: selectedSession.id,
        effort: normalizeEffortForProvider(historyEffort, provider),
        seedBoundaryMessageCount: messages.length,
      });

      setLaunchClient(provider);
      upsertLiveSessionEntry(summary, {
        initialPrompt: previewPrompt,
        initialImages: images.length > 0 ? images : null,
        seedMessages: messages,
      });
      setActiveLiveRuntimeId(summary.runtime_id);
      setWorkspaceMode('live');
      resetHistoryComposerText('');
      setHistoryPlanModeEnabled(false);
      setSelectedWorkingDir(selectedSession.project);
      scheduleWorkspaceRefresh(1200);
      return true;
    } catch (error) {
      console.error('Failed to continue workspace history session:', error);
      toast.error(t('workspace.nativeCreateFailed'));
      return false;
    } finally {
      setIsResumingHistorySession(false);
    }
  }, [
    buildComposerPromptPreview,
    buildComposerPromptText,
    extractComposerImagePayloads,
    createNativeSession,
    historyEnv,
    historyPermMode,
    historyPlanModeEnabled,
    historyEffort,
    isResumingHistorySession,
    launchOpenCodeWeb,
    messages,
    scheduleWorkspaceRefresh,
    selectedSession,
    setLaunchClient,
    setSelectedWorkingDir,
    resetHistoryComposerText,
    upsertLiveSessionEntry,
    t,
  ]);

  const handleLiveSessionUpdate = useCallback((session: NativeSessionSummary) => {
    upsertLiveSessionEntry(session);
  }, [upsertLiveSessionEntry]);

  const selectedHistorySupportsInline = selectedSession?.source !== 'opencode';

  useEffect(() => {
    if (workspaceMode !== 'live' || !activeLiveEntry) {
      return;
    }

    const liveItem = toLiveHistorySessionItem(activeLiveEntry);
    if (!liveItem) {
      return;
    }

    const nextKey = toSessionKey(liveItem);
    if (selectedKeyRef.current === nextKey) {
      return;
    }

    selectedKeyRef.current = nextKey;
    setSelectedKey(nextKey);
  }, [activeLiveEntry, workspaceMode]);

  const shortcuts = useMemo(
    () => ({
      'meta+k': () => setIsGlobalSearchOpen(true),
      'meta+o': () => void handlePickComposeDir(),
      'meta+enter': () => {
        if (workspaceMode === 'history') {
          void handleContinueHistorySession();
          return;
        }
        void handleCreateNativeConversation();
      },
    }),
    [
      handleContinueHistorySession,
      handleCreateNativeConversation,
      handlePickComposeDir,
      workspaceMode,
    ]
  );
  useKeyboardShortcuts(isActive ? shortcuts : {});

  // Escape key: abort running session, prevent fullscreen exit
  const activeLiveStatus = activeLiveEntry?.session.status;
  const activeLiveStoppingId = activeLiveEntry?.session.runtime_id;

  useEffect(() => {
    if (!isActive) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;

      e.preventDefault();

      if (
        activeLiveStatus === 'initializing' ||
        activeLiveStatus === 'processing'
      ) {
        void stopNativeSession(activeLiveStoppingId!, 'workspace_escape');
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isActive, activeLiveStatus, activeLiveStoppingId, stopNativeSession]);

  const renderComposeView = () => (
    <div className="flex h-full min-h-0 flex-col items-center px-4 sm:px-6 lg:px-8">
      <div className="flex flex-1 flex-col items-center justify-end">
        <div className="mb-6 flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-2 text-center">
          <h2 className="shrink-0 whitespace-nowrap text-2xl font-semibold tracking-tight text-foreground">
            {t('workspace.composeTitle')}
          </h2>
          <button
            type="button"
            onClick={() => void handlePickComposeDir()}
            className="inline-flex min-w-0 max-w-full items-center justify-center gap-1.5 text-2xl font-semibold tracking-tight text-muted-foreground transition-colors hover:text-foreground"
          >
            <FolderOpen className="h-4 w-4 shrink-0" />
            <span className="min-w-0 max-w-[300px] truncate">
              {effectiveComposeDirLabel || t('workspace.composeSelectFolder')}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          </button>
        </div>
      </div>

      <div className="w-full max-w-3xl">
        <WorkspaceSessionComposer
          value={composePrompt}
          valueRevision={composePromptRevision}
          onValueChange={handleComposePromptChange}
          onSubmit={handleCreateNativeConversation}
          placeholder={t('workspace.composePlaceholder')}
          canSubmit={composeHasDraft && !!effectiveComposeDir && !isCreatingNativeSession}
          isSubmitting={isCreatingNativeSession}
          submitLabel={t('workspace.composeSend')}
          loadingLabel={t('common.loading')}
          provider={composeProvider}
          installedSkills={workspaceInstalledSkills}
          onRefreshSkills={refreshWorkspaceInstalledSkills}
          workspaceCommands={workspaceCommands}
          workingDir={effectiveComposeDir}
          searchWorkspaceFiles={searchWorkspaceFiles}
          planModeEnabled={composePlanModeEnabled}
          onPlanModeEnabledChange={setComposePlanModeEnabled}
          codexInstalled={codexInstalled}
          opencodeInstalled={opencodeInstalled}
          onLaunchNewSession={handleNewSession}
          secondaryActions={(
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-9 w-9 rounded-full"
                    aria-label={t('workspace.nativeOpenTerminal')}
                    disabled={isLaunchingComposeTerminal}
                    onClick={() => void handleLaunchComposeTerminal()}
                  >
                    {isLaunchingComposeTerminal ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : (
                      <Terminal className="h-4 w-4" />
                    )}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">{t('workspace.nativeOpenTerminal')}</TooltipContent>
            </Tooltip>
          )}
          controls={(
            <ComposerControls
              provider={composeProvider}
              envName={currentEnv}
              permMode={permissionMode}
              effort={composeEffort}
              environments={environments}
              enabledEnvironments={enabledEnvironments}
              onEnvChange={(value) => void switchEnvironment(value)}
              onPermModeChange={setPermissionMode}
              onEffortChange={setComposeEffort}
            />
          )}
        />
      </div>
      <div className="flex-1" />
    </div>
  );

  const renderHistoryView = () => {
    if (!selectedSession) {
      return null;
    }

    const historyProvider = selectedSession.source === 'codex' ? 'codex' : 'claude';

    return (
      <div className="flex h-full min-h-0 flex-col">
        <Suspense fallback={<DetailFallback />}>
          <WorkspaceHistoryErrorBoundary
            key={toSessionKey(selectedSession)}
            message={t('workspace.historyRenderFailed')}
            retryLabel={t('common.retry')}
          >
            <LazyHistoryDetail
              selectedSession={selectedSession}
              messages={messages}
              segments={segments}
              activeSegment={activeSegment}
              onActiveSegmentChange={setActiveSegment}
              isLoadingMessages={isLoadingMessages}
              canAddAnnotation={selectedHistorySupportsInline && historyAnnotations.canAddAnnotation}
              annotations={historyAnnotations.annotations}
              onAddAnnotation={selectedHistorySupportsInline ? historyAnnotations.addAnnotation : undefined}
              onUpdateAnnotation={selectedHistorySupportsInline ? historyAnnotations.updateAnnotation : undefined}
              onRemoveAnnotation={selectedHistorySupportsInline ? historyAnnotations.removeAnnotation : undefined}
            />
          </WorkspaceHistoryErrorBoundary>
        </Suspense>

        <WorkspaceSessionComposer
          value={historyComposerText}
          valueRevision={historyComposerRevision}
          onValueChange={handleHistoryComposerTextChange}
          onSubmit={handleContinueHistorySession}
          placeholder={
            selectedHistorySupportsInline
              ? t('workspace.composePlaceholder')
              : t('workspace.historyContinueUnsupported')
          }
          disabled={!selectedHistorySupportsInline}
          canSubmit={selectedHistorySupportsInline && historyHasDraft && !isResumingHistorySession}
          isSubmitting={isResumingHistorySession}
          submitLabel={selectedHistorySupportsInline ? t('workspace.composeSend') : t('workspace.openCodeWeb')}
          loadingLabel={t('common.loading')}
          provider={historyProvider}
          installedSkills={workspaceInstalledSkills}
          onRefreshSkills={refreshWorkspaceInstalledSkills}
          workspaceCommands={workspaceCommands}
          workingDir={selectedSession.project || null}
          searchWorkspaceFiles={searchWorkspaceFiles}
          planModeEnabled={historyPlanModeEnabled}
          onPlanModeEnabledChange={selectedHistorySupportsInline ? setHistoryPlanModeEnabled : undefined}
          planModeAvailable={selectedHistorySupportsInline}
          codexInstalled={codexInstalled}
          opencodeInstalled={opencodeInstalled}
          onLaunchNewSession={handleNewSession}
          annotations={historyAnnotations.annotations}
          onUpdateAnnotation={historyAnnotations.updateAnnotation}
          onRemoveAnnotation={historyAnnotations.removeAnnotation}
          onClearAnnotations={historyAnnotations.clearAnnotations}
          onAnnotationsSent={historyAnnotations.clearAnnotations}
          controls={(
            <ComposerControls
              provider={historyProvider}
              envName={historyEnv}
              permMode={historyPermMode}
              effort={historyEffort}
              environments={environments}
              enabledEnvironments={enabledEnvironments}
              onEnvChange={handleHistoryEnvChange}
              onPermModeChange={handleHistoryPermModeChange}
              onEffortChange={handleHistoryEffortChange}
            />
          )}
          secondaryActions={(
            <>
              {selectedHistorySupportsInline ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-9 w-9 rounded-full"
                        aria-label={t('workspace.nativeOpenTerminal')}
                        onClick={() => {
                          void launchClaudeCode(
                            selectedSession.project || undefined,
                            selectedSession.id,
                            historyProvider as LaunchClient,
                            historyEnv,
                          )
                            .then(() => toast.success(t('workspace.nativeHandoffDone')))
                            .catch(() => toast.error(t('workspace.nativeHandoffFailed')));
                        }}
                      >
                        <Terminal className="h-4 w-4" />
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">{t('workspace.nativeOpenTerminal')}</TooltipContent>
                </Tooltip>
              ) : null}
            </>
          )}
        />
      </div>
    );
  };

  const handleProjectTreeRefresh = useCallback(() => {
    void Promise.all([
      refreshWorkspaceData({
        force: true,
        silent: false,
        includeSelectedConversation: true,
      }),
      restoreNativeSessions({ restorePersistedSelection: false }),
    ]);
  }, [refreshWorkspaceData, restoreNativeSessions]);

  const handleProjectTreeSaveTitle = useCallback(async (
    session: HistorySessionItem,
    title: string,
  ) => {
    await setSessionTitle(session.source, session.id, title);
  }, [setSessionTitle]);

  const handleProjectTreeSaveAnnotation = useCallback(async (
    session: HistorySessionItem,
    annotation: {
      stage?: SessionTaskStage;
      sticker?: SessionStickerId;
      label?: string;
    },
  ) => {
    await setSessionAnnotation(session.source, session.id, annotation);
    invalidateHistoryCache();
    const updateSession = (currentSession: HistorySessionItem): HistorySessionItem =>
        currentSession.source === session.source && currentSession.id === session.id
          ? {
              ...currentSession,
              taskStage: annotation.stage,
              taskSticker: annotation.sticker,
              taskLabel: annotation.label?.trim() || undefined,
            }
          : currentSession;
    replaceSessions(
      sessionsRef.current.map(updateSession)
    );
    setPrecomputedProjectNodes((nodes) =>
      nodes.map((node) => ({
        ...node,
        sessions: node.sessions.map(updateSession),
      }))
    );
  }, [replaceSessions, setSessionAnnotation]);

  const handleProjectTreeSessionsChanged = useCallback(async () => {
    invalidateHistoryCache();
    const snapshot = await fetchWorkspaceOverviewSnapshot(
      WORKSPACE_HISTORY_SESSION_LIMIT,
      true,
    );
    syncSessionState(snapshot.sessions);
    setPrecomputedProjectNodes(snapshot.projectNodes);
  }, [syncSessionState]);

  const handleProjectTreeNewSession = useCallback(() => {
    void handleNewSession(launchClient);
  }, [handleNewSession, launchClient]);

  if (isLoadingEnvs || isLoadingStats) {
    return <WorkspaceSkeleton />;
  }

  return (
    <div className="page-transition-enter flex h-full flex-col">
      <div
        ref={browserLayoutRef}
        data-ccem-workspace-browser-layout={browserPanelOpen ? 'shell-browser-split' : 'workspace'}
        className="flex min-h-0 flex-1 overflow-hidden"
      >
        <div
          ref={workspaceColumnRef}
          data-ccem-workspace-column="true"
          className={cn(
            'flex min-h-0 min-w-0 flex-col overflow-hidden',
            browserPanelOpen
              ? 'ml-3 mb-3 flex-1'
              : 'mx-3 mb-3 flex-1',
          )}
        >
          <WorkspaceStatusStrip
            onNavigate={onNavigate}
            onOpenSearch={() => setIsGlobalSearchOpen(true)}
            browserOpen={browserPanelOpen}
            onToggleBrowser={() => setActiveBrowserPanelOpen((open) => !open)}
            envContext={statusStripEnvContext}
          />

          <div
            data-ccem-workspace-shell="true"
            className="workspace-main-container flex min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            <ProjectTree
              sessions={sidebarSessions}
              precomputedProjectNodes={precomputedProjectNodes}
              environmentByName={environmentByName}
              decorationsBySessionKey={decorationsBySessionKey}
              canonicalKeyBySessionKey={liveSessionTreeState.canonicalKeyBySessionKey}
              activeSessionKeys={liveSessionTreeState.activeSessionKeys}
              isLoading={isLoadingSessions}
              isRefreshing={isRefreshing}
              selectedKey={selectedKey}
              onSelect={handleSelect}
              onRefresh={handleProjectTreeRefresh}
              onSaveTitle={handleProjectTreeSaveTitle}
              onSaveAnnotation={handleProjectTreeSaveAnnotation}
              onSessionsChanged={handleProjectTreeSessionsChanged}
              onCreateForProject={handleCreateForProject}
              onNewSession={handleProjectTreeNewSession}
              width={workspaceSidebarWidth}
              onResizeStart={handleWorkspaceSidebarResizeStart}
            />

            <div className="workspace-reading-surface relative flex min-w-0 flex-1 flex-col overflow-hidden">
              {shouldRenderWorkspaceReview && workspaceReviewOpen && workspaceReviewModel ? (
                <Suspense fallback={null}>
                  <LazyWorkspaceReviewPopover
                    key={`${workspaceReviewSession.runtime_id}:${workspaceReviewSession.project_dir}`}
                    session={workspaceReviewSession}
                    model={workspaceReviewModel}
                    gitSnapshot={workspaceGitSnapshot}
                    isOpen={workspaceReviewOpen}
                    isRefreshingGit={isRefreshingWorkspaceGitSnapshot}
                    onOpenChange={setWorkspaceReviewOpen}
                    onRefreshGit={() => void refreshWorkspaceGitSnapshot()}
                    onLoadDiff={(filePath) => getWorkspaceFileDiff(workspaceReviewWorkingDir || '', filePath)}
                    onLoadMediaPreview={(filePath) => getWorkspaceMediaPreview(workspaceReviewWorkingDir || '', filePath)}
                    isLive={workspaceMode !== 'history'}
                    onLoadSubagents={
                      workspaceReviewSession.provider === 'claude' && workspaceReviewSession.provider_session_id
                        ? (detailAgentId) =>
                            getSessionSubagents(
                              workspaceReviewSession.provider_session_id!,
                              workspaceReviewSession.provider,
                              detailAgentId,
                            )
                        : undefined
                    }
                  />
                </Suspense>
              ) : null}

              {workspaceMode === 'history' && selectedSession
                ? renderHistoryView()
                : workspaceMode === 'compose' || (workspaceMode === 'live' && !activeLiveEntry)
                  ? renderComposeView()
                  : null}

              {liveSessionEntries.length > 0 ? (
                <div
                  className={cn(
                    'relative min-h-0 flex-1 overflow-hidden',
                    workspaceMode === 'live' && activeLiveEntry ? 'block' : 'hidden',
                  )}
                >
                  {liveSessionEntries.map((entry) => {
                    const isActiveLiveEntry = workspaceMode === 'live'
                      && activeLiveEntry?.session.runtime_id === entry.session.runtime_id;
                    return (
                      <div
                        key={entry.session.runtime_id}
                        className={cn(
                          'absolute inset-0 min-h-0',
                          isActiveLiveEntry ? 'block' : 'hidden',
                        )}
                      >
                        <WorkspaceNativeSessionView
                          session={entry.session}
                          initialPrompt={entry.initialPrompt}
                          initialImages={entry.initialImages}
                          seedMessages={entry.seedMessages}
                          installedSkills={workspaceInstalledSkills}
                          onRefreshSkills={refreshWorkspaceInstalledSkills}
                          workspaceCommands={workspaceCommands}
                          isVisible={isActiveLiveEntry}
                          onSessionUpdate={handleLiveSessionUpdate}
                          codexInstalled={codexInstalled}
                          opencodeInstalled={opencodeInstalled}
                          onLaunchNewSession={handleNewSession}
                          onStartNew={() => {
                            setWorkspaceMode('compose');
                            setActiveLiveRuntimeId(null);
                          }}
                      />
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {browserPanelOpen ? (
          <BrowserPanel
            key={activeBrowserSessionId}
            sessionId={activeBrowserSessionId}
            className="shrink-0"
            style={{
              flex: `0 0 ${browserPanelWidthPercent}%`,
              maxWidth: `${BROWSER_PANEL_MAX_WIDTH_PERCENT}%`,
              minWidth: BROWSER_PANEL_MIN_WIDTH_PX,
            }}
            onResizeStart={handleBrowserPanelResizeStart}
            onClose={() => setActiveBrowserPanelOpen(false)}
          />
        ) : null}
      </div>

      <WorkspaceGlobalSearch
        sessions={sessions}
        isOpen={isGlobalSearchOpen}
        onOpenChange={setIsGlobalSearchOpen}
        onSelectSession={handleSelect}
        onSelectProject={handleCreateForProject}
      />
    </div>
  );
}
