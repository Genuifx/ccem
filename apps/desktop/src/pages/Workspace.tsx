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
import {
  Check,
  ChevronDown,
  FolderOpen,
  FolderSearch,
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
import { WorkspaceCodexModelMigrationDialog } from '@/components/workspace/WorkspaceCodexModelMigrationDialog';
import { WorkspaceSessionComposer } from '@/components/workspace/WorkspaceSessionComposer';
import {
  WorkspaceForkDialog,
  getWorkspaceForkTurnPreview,
  type WorkspaceForkTarget,
} from '@/components/workspace/WorkspaceForkDialog';
import {
  createComposerRouteDraft,
  isHistoryRouteContinuationBlocked,
  isRouteDraftRowVisible,
  resolveRouterLaunchDraft,
  resolveHistoryRouteRestore,
  type ComposerRouteDraft,
  type HistoryRouteResolutionStatus,
} from '@/components/workspace/composerRouteDraft';
import {
  clearHistoryRouteDraft,
  historyRouteDraftKey,
  normalizeHistoryRouteProject,
  readHistoryRouteDraft,
  writeHistoryRouteDraft,
} from '@/components/workspace/historyRouteDraftStore';
import {
  decideWorkspaceEscape,
  hasOpenWorkspaceEscapeLayer,
  type WorkspaceEscapeCommandIdentity,
} from '@/pages/workspaceEscape';
import type { RouterLaunchDraft } from '@ccem/core/browser';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAppStore } from '@/store';
import type { InstalledSkill, LaunchClient } from '@/store';
import {
  SESSION_TITLE_UPDATED_EVENT,
  useTauriCommands,
  type SessionTitleUpdatedEventDetail,
} from '@/hooks/useTauriCommands';
import {
  useSessionInterruptedEvent,
  useSessionUpdatedEvent,
  useTaskCompletedEvent,
  useTaskErrorEvent,
  useRouterStatusEvent,
  useSessionRouterUpdatedEvent,
} from '@/hooks/useTauriEvents';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { dispatchAppZoomCommand } from '@/hooks/useZoom';
import { useLocale } from '@/locales';
import { scheduleAfterFirstPaint } from '@/lib/idle';
import { useNativeSurfaceOccluded } from '@/lib/nativeSurfaceOcclusion';
import { createReentryGuard, type ReentryGuard } from '@/lib/asyncGuard';
import { cn, getProjectName, truncatePath } from '@/lib/utils';
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
  SessionPromptAnnotation,
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
  formatInteractiveSessionLaunchError,
  isInteractiveSessionTerminalOpenError,
} from '@/lib/interactiveSessionLaunch';
import {
  beginWorkspaceSessionTitleGeneration,
  cancelWorkspaceSessionTitleGeneration,
  isWorkspaceSessionTitleGenerationCurrent,
  reconcileWorkspaceLiveSessionsSnapshot,
  updateWorkspaceLiveSessionsSnapshot,
  updateWorkspaceLiveSessionDisplayTitle,
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
import type { BrowserPanelTarget } from '@/components/workspace/browserPanelTarget';
import {
  createBrowserPanelSessionKeyRegistry,
  isBrowserPanelTargetVisible,
  matchesBrowserPanelHistorySession,
  rebindBrowserPanelTarget,
  retireBrowserPanelTargetForWorkingDirChange,
  resolveActiveBrowserAgentSessionId,
  resolveHistoryBrowserAgentSessionId,
  toggleDefaultBrowserPanelTarget,
  WORKSPACE_BROWSER_COMPOSE_SESSION_ID,
} from '@/components/workspace/browserPanelTarget';
import { createBrowserPresentationRevisionAllocator } from '@/components/workspace/browserPresentationRevision';
import type { BrowserSurfaceHostShortcutAction } from '@/lib/browserSurfaceIpc';
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
  startAfterCodexModelMigrationGate,
  type CodexModelMigrationWarning,
} from '@/components/workspace/workspaceCodexModelMigration';
import {
  buildWorkspaceCronAgentPrompt,
  isWorkspaceCronCommand,
} from '@/components/workspace/workspaceCronCommand';
import {
  buildMessagesFromEvents,
  replayBatchCoversAvailableSequenceRange,
  selectSeedMessagesForNativeReplay,
  shouldSkipProviderSeedHydration,
} from '@/components/workspace/workspaceEventTranscript';
import {
  NATIVE_TRANSCRIPT_REPLAY_PAGE_LIMIT,
  runTranscriptPagedBackfill,
} from '@/components/workspace/workspaceTranscriptBackfill';
import type { WorkspaceTranscriptBackfillState } from '@/components/workspace/WorkspaceTranscriptBackfillStatus';
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

/** Everything needed to launch a forked Claude session from a model-output turn. */
interface WorkspaceForkTurnRequest {
  /** Parent provider session (transcript to slice). */
  providerSessionId: string;
  /** Cut point: last assistant message uuid kept in the fork (inclusive). */
  forkFromMessageId: string;
  /** Transcript prefix to hydrate the forked session view. */
  seedMessages: ConversationMessageData[];
  envName?: string;
  permMode?: string;
  workingDir?: string | null;
  effort?: string | null;
}

const ACTIVE_LIVE_RUNTIME_STORAGE_KEY = 'ccem-workspace-live-runtime';
const LIVE_RUNTIME_SET_STORAGE_KEY = 'ccem-workspace-live-runtimes';
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
  if (
    normalizeHistoryRouteProject(nativeSession.project_dir)
    !== normalizeHistoryRouteProject(session.project)
  ) {
    return false;
  }
  if (runtimeId && nativeSession.runtime_id !== runtimeId) {
    return false;
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
    recent,
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
      recent: state.recent,
      setSelectedWorkingDir: state.setSelectedWorkingDir,
      setLaunchClient: state.setLaunchClient,
      setPermissionMode: state.setPermissionMode,
    }),
    shallow
  );
  const workspaceReviewOpen = useAppStore((state) => state.reviewPanelOpen);
  const setWorkspaceReviewOpen = useAppStore((state) => state.setReviewPanelOpen);
  const setReviewEntry = useAppStore((state) => state.setReviewEntry);
  const setSessionRouter = useAppStore((state) => state.setSessionRouter);
  const setRouterStatus = useAppStore((state) => state.setRouterStatus);

  const {
    switchEnvironment,
    openDirectoryPicker,
    recordRecentProject,
    loadCronTasks,
    loadInstalledSkills,
    loadWorkspaceSkills,
    loadWorkspaceCommands,
    checkCodexInstalled,
    checkOpenCodeInstalled,
    setSessionTitle,
    setSessionAnnotation,
    preflightCodexModelMigration,
    createNativeSession,
    getNativeSessionEventPage,
    getNativeSessionEvents,
    listNativeSessions,
    loadRouterStatus,
    loadRouterSettings,
    launchOpenCodeWeb,
    launchClaudeCode,
    openInteractiveSessionInTerminal,
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
  const [historyTranscriptBackfillState, setHistoryTranscriptBackfillState] =
    useState<WorkspaceTranscriptBackfillState>('idle');
  const [activeSegment, setActiveSegment] = useState<number | null>(null);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const isLoadingMessagesRef = useRef(false);
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
  const [composeRouteDraft, setComposeRouteDraft] = useState<ComposerRouteDraft>(createComposerRouteDraft);
  const composeRouteDraftRef = useRef<ComposerRouteDraft>(composeRouteDraft);
  const [historyComposerText, setHistoryComposerText] = useState('');
  const historyComposerTextRef = useRef('');
  const historyHasDraftRef = useRef(false);
  const [historyComposerRevision, setHistoryComposerRevision] = useState(0);
  const [historyHasDraft, setHistoryHasDraft] = useState(false);
  const [historyPlanModeEnabled, setHistoryPlanModeEnabled] = useState(false);
  const [historyRouteDraft, setHistoryRouteDraft] = useState<ComposerRouteDraft>(createComposerRouteDraft);
  const historyRouteDraftRef = useRef<ComposerRouteDraft>(historyRouteDraft);
  const [historyRouteResolutionStatus, setHistoryRouteResolutionStatus] =
    useState<HistoryRouteResolutionStatus>('idle');
  const historyRouteResolutionStatusRef = useRef<HistoryRouteResolutionStatus>('idle');
  const historySelectionRequestSeqRef = useRef(0);
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
  const [selectedHistoryNativeRuntimeId, setSelectedHistoryNativeRuntimeId] = useState<string | null>(null);
  const [hasAttemptedNativeSessionRestore, setHasAttemptedNativeSessionRestore] = useState(false);
  const [workspaceGitSnapshot, setWorkspaceGitSnapshot] = useState<WorkspaceGitSnapshot | null>(null);
  const [isRefreshingWorkspaceGitSnapshot, setIsRefreshingWorkspaceGitSnapshot] = useState(false);
  const workspaceGitSnapshotRequestSeqRef = useRef(0);
  const lastComposeSeedIdRef = useRef<number | null>(null);
  const [isCreatingNativeSession, setIsCreatingNativeSession] = useState(false);
  const [isLaunchingComposeTerminal, setIsLaunchingComposeTerminal] = useState(false);
  const [isResumingHistorySession, setIsResumingHistorySession] = useState(false);
  const [codexModelMigrationWarning, setCodexModelMigrationWarning] = useState<CodexModelMigrationWarning | null>(null);
  const codexModelMigrationDecisionRef = useRef<((shouldContinue: boolean) => void) | null>(null);
  const acknowledgedCodexModelWarningsRef = useRef(new Set<string>());
  const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false);
  const [browserTargetBySessionId, setBrowserTargetBySessionId] = useState<
    Record<string, BrowserPanelTarget | undefined>
  >({});
  const browserTargetBySessionIdRef = useRef(browserTargetBySessionId);
  browserTargetBySessionIdRef.current = browserTargetBySessionId;
  const browserPanelInstanceSeqRef = useRef(0);
  const browserPanelSessionKeyRegistryRef = useRef(createBrowserPanelSessionKeyRegistry());
  const browserPresentationRevisionAllocatorRef = useRef(
    createBrowserPresentationRevisionAllocator(),
  );
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
  const conversationLoadAbortRef = useRef<AbortController | null>(null);
  const hydratingLiveRuntimeIdsRef = useRef(new Set<string>());
  const hydratedLiveRuntimeIdsRef = useRef(new Set<string>());
  const pendingRefreshRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const prevIsActiveRef = useRef(isActive);
  const selectedKeyRef = useRef<string | null>(null);
  const persistedGeneratedTitleKeysRef = useRef(new Set<string>());
  const titleGenerationRevisionsRef = useRef<Record<string, number>>({});
  const reviewOwnerKey = `${workspaceMode}:${selectedKey ?? ''}:${activeLiveRuntimeId ?? ''}:${composeDir ?? ''}`;
  const reviewOwnerKeyRef = useRef(reviewOwnerKey);

  const updateComposeRouteDraftState = useCallback((next: ComposerRouteDraft) => {
    composeRouteDraftRef.current = next;
    setComposeRouteDraft(next);
  }, []);

  const updateHistoryRouteDraftState = useCallback((next: ComposerRouteDraft) => {
    historyRouteDraftRef.current = next;
    setHistoryRouteDraft(next);
  }, []);

  const updateHistoryRouteResolutionStatus = useCallback((next: HistoryRouteResolutionStatus) => {
    historyRouteResolutionStatusRef.current = next;
    setHistoryRouteResolutionStatus(next);
  }, []);

  const updateIsLoadingMessages = useCallback((next: boolean) => {
    isLoadingMessagesRef.current = next;
    setIsLoadingMessages(next);
  }, []);

  const requestCodexModelMigrationDecision = useCallback((
    warning: CodexModelMigrationWarning,
  ): Promise<boolean> => new Promise((resolve) => {
    codexModelMigrationDecisionRef.current?.(false);
    codexModelMigrationDecisionRef.current = resolve;
    setCodexModelMigrationWarning(warning);
  }), []);

  const settleCodexModelMigrationDecision = useCallback((shouldContinue: boolean) => {
    const resolve = codexModelMigrationDecisionRef.current;
    codexModelMigrationDecisionRef.current = null;
    setCodexModelMigrationWarning(null);
    resolve?.(shouldContinue);
  }, []);

  useEffect(() => () => {
    codexModelMigrationDecisionRef.current?.(false);
    codexModelMigrationDecisionRef.current = null;
    conversationLoadAbortRef.current?.abort();
  }, []);

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
    // A seeded composer (/ccem-cron etc.) is a fresh Composer: routing opt-in
    // must not leak from a previous unsent draft.
    updateComposeRouteDraftState(createComposerRouteDraft());
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

  useEffect(() => {
    const handleSessionTitleUpdated = (event: Event) => {
      const detail = (event as CustomEvent<SessionTitleUpdatedEventDetail>).detail;
      const sessionIds = Array.from(new Set([
        detail.sessionId,
        ...detail.aliasSessionIds,
      ].filter((id) => id.trim())));
      const matchingRuntimeIds = Object.values(liveSessionsByRuntimeIdRef.current)
        .filter((entry) => (
          entry.session.provider === detail.source
          && sessionIds.some((id) => (
            entry.session.runtime_id === id
            || entry.session.provider_session_id === id
          ))
        ))
        .map((entry) => entry.session.runtime_id);

      if (detail.overwriteExisting) {
        for (const runtimeId of new Set([
          ...detail.nativeRuntimeIds,
          ...matchingRuntimeIds,
        ])) {
          cancelWorkspaceSessionTitleGeneration(
            titleGenerationRevisionsRef.current,
            runtimeId,
          );
        }
      }

      updateLiveSessionsByRuntimeId((previous) => sessionIds.reduce(
        (next, sessionId) => updateWorkspaceLiveSessionDisplayTitle(
          next,
          detail.source,
          sessionId,
          detail.title,
          detail.revision,
        ),
        previous,
      ));
    };
    window.addEventListener(SESSION_TITLE_UPDATED_EVENT, handleSessionTitleUpdated);
    return () => window.removeEventListener(SESSION_TITLE_UPDATED_EVENT, handleSessionTitleUpdated);
  }, [updateLiveSessionsByRuntimeId]);

  const upsertLiveSessionEntry = useCallback((
    session: NativeSessionSummary,
    options: {
      initialPrompt?: string | null;
      initialImages?: SessionPromptImage[] | null;
      initialAnnotations?: SessionPromptAnnotation[] | null;
      generatedTitle?: string | null;
      seedMessages?: ConversationMessageData[];
    } = {},
  ) => {
    // Seed per-session router state from the summary so the chip/pill reflect
    // reality immediately (covers create + restore + ccem/cron link paths).
    if (session.router) {
      setSessionRouter(session.runtime_id, session.router);
    }
    updateLiveSessionsByRuntimeId((previous) =>
      upsertWorkspaceLiveSessionEntry(previous, session, options)
    );
  }, [setSessionRouter, updateLiveSessionsByRuntimeId]);

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
      // Seed per-session router state from the summaries so the chip/pill render
      // correct state immediately (before any event fires or popover is opened).
      for (const ns of nativeSessions) {
        if (ns.router) setSessionRouter(ns.runtime_id, ns.router);
      }
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
      updateIsLoadingMessages(false);
      if (Object.keys(liveSessionsSnapshot).length === 0) {
        setWorkspaceMode('compose');
      }
    }
    return retainedSessions;
  }, [replaceSessions, updateIsLoadingMessages]);

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
    signal?: AbortSignal,
  ): Promise<{
    messages: ConversationMessageData[];
    segments: HistorySegment[];
    events: SessionEventRecord[];
    integrity: 'complete' | 'partial';
  } | null> => {
    const result = await runTranscriptPagedBackfill({
      loadPage: (afterSeq, snapshotNewestSeq) => getNativeSessionEventPage(
        nativeSession.runtime_id,
        afterSeq,
        snapshotNewestSeq,
        NATIVE_TRANSCRIPT_REPLAY_PAGE_LIMIT,
      ),
      isComplete: replayBatchCoversAvailableSequenceRange,
      physicalRequestKey: nativeSession.runtime_id,
      signal,
    });
    if (result.status === 'cancelled') {
      throw new DOMException('Native history replay was cancelled', 'AbortError');
    }
    if (result.status === 'error') {
      throw result.error;
    }
    const replayBatch = result.value;
    if (result.status === 'success' && replayBatch.events.length === 0) {
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
      integrity: result.status === 'partial' ? 'partial' : 'complete',
    };
  }, [getNativeSessionEventPage]);

  const loadConversation = useCallback(
    async (
      session: HistorySessionItem,
      options: {
        resetBeforeLoad?: boolean;
        showLoading?: boolean;
        nativeHistorySession?: NativeSessionSummary | null;
        preserveActiveRequest?: boolean;
      } = {}
    ) => {
      const {
        resetBeforeLoad = true,
        showLoading = true,
        preserveActiveRequest = false,
      } = options;
      if (
        preserveActiveRequest
        && (conversationLoadAbortRef.current || isLoadingMessagesRef.current)
      ) {
        return;
      }
      const hasNativeHistorySessionOption = Object.prototype.hasOwnProperty.call(
        options,
        'nativeHistorySession',
      );
      const requestSeq = ++conversationRequestSeqRef.current;
      conversationLoadAbortRef.current?.abort();
      const requestController = new AbortController();
      conversationLoadAbortRef.current = requestController;

      if (resetBeforeLoad) {
        setMessages([]);
        setSegments([]);
        setHistoryTranscriptBackfillState('idle');
        if (hasNativeHistorySessionOption) {
          setHistoryEvents([]);
        }
        setActiveSegment(null);
      }

      if (showLoading) {
        updateIsLoadingMessages(true);
      }

      try {
        const nativeHistoryPromise = options.nativeHistorySession
          ? loadNativeHistoryConversation(
            options.nativeHistorySession,
            requestController.signal,
          ).then(
            (value) => ({ value, error: null as unknown }),
            (error: unknown) => ({ value: null, error }),
          )
          : null;

        // Provider history is already a semantic transcript and is normally
        // much smaller than the raw native event log. Paint it first while a
        // routed native session is paged in parallel for review/usage data.
        // This keeps time-to-first-content independent of raw event count.
        if (nativeHistoryPromise) {
          let providerHistory: Awaited<ReturnType<typeof fetchConversationDetail>> | null = null;
          let providerHistoryError: unknown = null;
          try {
            providerHistory = await fetchConversationDetail(session);
          } catch (error) {
            providerHistoryError = error;
          }
          if (requestSeq !== conversationRequestSeqRef.current) {
            return;
          }

          const providerHasTranscript = providerHistory
            ? hasNativeHistoryTranscriptMessages(providerHistory.messages)
            : false;
          if (providerHistory) {
            setMessages(providerHistory.messages);
            setSegments(providerHistory.segments);
            if (providerHasTranscript && showLoading) {
              updateIsLoadingMessages(false);
            }
          }

          const nativeHistoryResult = await nativeHistoryPromise;
          if (requestSeq !== conversationRequestSeqRef.current) {
            return;
          }
          if (nativeHistoryResult.error && requestController.signal.aborted) {
            throw nativeHistoryResult.error;
          }
          if (nativeHistoryResult.error) {
            console.error('Failed to load native history transcript:', nativeHistoryResult.error);
            if (!providerHasTranscript) {
              setHistoryTranscriptBackfillState('error');
            }
          }
          const nativeHistory = nativeHistoryResult.value;
          setHistoryEvents(nativeHistory?.events ?? []);
          if (providerHasTranscript) {
            setHistoryTranscriptBackfillState('idle');
            return;
          }
          if (nativeHistory) {
            setHistoryTranscriptBackfillState(
              nativeHistory.integrity === 'partial' ? 'partial' : 'idle',
            );
          }
          if (
            nativeHistory
            && hasNativeHistoryTranscriptMessages(nativeHistory.messages)
          ) {
            setMessages(nativeHistory.messages);
            setSegments(nativeHistory.segments);
            return;
          }
          if (providerHistory) {
            return;
          }
          if (providerHistoryError) {
            throw providerHistoryError;
          }
          return;
        }

        if (hasNativeHistorySessionOption) {
          setHistoryEvents([]);
        }
        const { messages: msgs, segments: segs } = await fetchConversationDetail(session);

        if (requestSeq !== conversationRequestSeqRef.current) {
          return;
        }

        setMessages(msgs);
        setSegments(segs);
        if (hasNativeHistoryTranscriptMessages(msgs)) {
          setHistoryTranscriptBackfillState('idle');
        }
      } catch (error) {
        if (requestSeq !== conversationRequestSeqRef.current) {
          return;
        }
        console.error('Failed to load conversation:', error);
      } finally {
        if (conversationLoadAbortRef.current === requestController) {
          conversationLoadAbortRef.current = null;
        }
        if (showLoading && requestSeq === conversationRequestSeqRef.current) {
          updateIsLoadingMessages(false);
        }
      }
    },
    [loadNativeHistoryConversation, updateIsLoadingMessages]
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
                preserveActiveRequest: true,
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
      void setSessionTitle(
        entry.session.provider,
        entry.session.runtime_id,
        generatedTitle,
        [providerSessionId],
        false,
        [entry.session.runtime_id],
      )
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

  // Router events are the source of truth — the backend emits after every
  // successful write (IPC / external control / main-env switch). Apply directly;
  // the store dedups by revision.
  useSessionRouterUpdatedEvent((payload) => {
    setSessionRouter(payload.runtimeId, payload.router);
  });
  useRouterStatusEvent((status) => {
    setRouterStatus(status);
  });

  // Seed global router status + config once so the status-strip chip and
  // Settings reflect reality before any event fires.
  useEffect(() => {
    void loadRouterStatus().catch(() => {
      // Router may be disabled or unavailable; the chip handles the disabled state.
    });
    void loadRouterSettings().catch(() => {
      // Best-effort; Settings will re-read on open.
    });
  }, [loadRouterStatus, loadRouterSettings]);

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
      return browserPanelSessionKeyRegistryRef.current.resolveLive({
        provider: activeLiveEntry.session.provider,
        providerSessionId: activeLiveEntry.session.provider_session_id,
        runtimeId: activeLiveEntry.session.runtime_id,
      });
    }
    if (workspaceMode === 'history' && selectedSession) {
      const matchingLiveEntry = Object.values(liveSessionsByRuntimeId).find((entry) => (
        matchesBrowserPanelHistorySession(selectedSession, entry.session)
      ));
      return browserPanelSessionKeyRegistryRef.current.resolveHistory({
        provider: selectedSession.source,
        providerSessionId: selectedSession.id,
        matchingLiveSession: matchingLiveEntry
          ? {
            provider: matchingLiveEntry.session.provider,
            providerSessionId: matchingLiveEntry.session.provider_session_id,
            runtimeId: matchingLiveEntry.session.runtime_id,
          }
          : null,
      });
    }
    return WORKSPACE_BROWSER_COMPOSE_SESSION_ID;
  }, [activeLiveEntry, liveSessionsByRuntimeId, selectedSession, workspaceMode]);
  const activeBrowserAgentSessionId = useMemo(() => {
    if (workspaceMode === 'live') {
      return resolveActiveBrowserAgentSessionId(activeLiveEntry?.session);
    }
    if (workspaceMode === 'history' && selectedSession) {
      const selectedHistoryNativeSession = selectedHistoryNativeRuntimeId
        ? liveSessionsByRuntimeId[selectedHistoryNativeRuntimeId]?.session
        : null;
      return resolveHistoryBrowserAgentSessionId(
        selectedSession,
        selectedHistoryNativeSession,
      );
    }
    return null;
  }, [
    activeLiveEntry,
    liveSessionsByRuntimeId,
    selectedHistoryNativeRuntimeId,
    selectedSession,
    workspaceMode,
  ]);

  const activeBrowserTarget = browserTargetBySessionId[activeBrowserSessionId] ?? null;
  const activeVisibleBrowserTarget = isBrowserPanelTargetVisible(activeBrowserTarget)
    ? activeBrowserTarget
    : null;
  const browserPanelOpen = activeVisibleBrowserTarget !== null;
  const nativeSurfaceModalOccluded = useNativeSurfaceOccluded();
  const browserSurfaceOccluded = !isActive
    || isGlobalSearchOpen
    || nativeSurfaceModalOccluded;
  const presentationSurfaceSessionId = activeBrowserTarget?.surfaceSessionId
    ?? activeBrowserSessionId;
  const browserPresentationRevision = browserPresentationRevisionAllocatorRef.current.observe({
    ownerSessionId: activeBrowserSessionId,
    surfaceSessionId: presentationSurfaceSessionId,
    occluded: activeVisibleBrowserTarget ? browserSurfaceOccluded : false,
  });

  const closeBrowserPanel = useCallback((sessionId: string) => {
    setBrowserTargetBySessionId((previous) => {
      if (!previous[sessionId]) return previous;
      const next = { ...previous };
      delete next[sessionId];
      browserTargetBySessionIdRef.current = next;
      return next;
    });
  }, []);

  const toggleActiveBrowser = useCallback((workingDir: string | null | undefined) => {
    if (!workingDir?.trim()) {
      toast.error(t('workspace.loginBrowserNeedsWorkspace'));
      return;
    }
    setBrowserTargetBySessionId((previous) => {
      return toggleDefaultBrowserPanelTarget(
        previous,
        activeBrowserSessionId,
        workingDir,
        () => browserPanelInstanceSeqRef.current += 1,
      );
    });
  }, [activeBrowserSessionId, t]);

  useEffect(() => {
    setComposeEffort((previous) => normalizeEffortForProvider(previous, composeProvider));
    // Providers without env routing show no draft UI and must not carry a
    // stale opt-in into the next create call.
    if (composeProvider !== 'claude') {
      updateComposeRouteDraftState(createComposerRouteDraft());
    }
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

    if (
      runtimeId
      && liveSessionsByRuntimeId[runtimeId]
      && nativeSessionMatchesHistorySession(
        liveSessionsByRuntimeId[runtimeId].session,
        session,
        runtimeId,
      )
    ) {
      return liveSessionsByRuntimeId[runtimeId];
    }

    const candidate = findLiveEntryForSidebarSession(liveSessionEntries, session);
    return candidate && nativeSessionMatchesHistorySession(candidate.session, session)
      ? candidate
      : null;
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
      // The persisted seed boundary remains authoritative even when a freshly
      // restarted backend has not repopulated `last_event_seq` yet. Bypassing
      // it in that window hydrates the provider's live turns as seed messages,
      // then native replay renders the same turns a second time.
      const seedMessages = selectSeedMessagesForNativeReplay(
        historyMessages,
        replayBatch,
        seedBoundaryMessageCount,
      );

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

    // Pick one deterministic authoritative record first, then decide whether
    // it is recoverable. Never hunt for an older routed/recoverable sibling.
    const matchingSession = await findNativeHistorySessionForSession(session);
    if (!matchingSession || !canRestoreWorkspaceLiveSession(matchingSession)) {
      return null;
    }

    upsertLiveSessionEntry(matchingSession);
    const hydratedMessages = await hydrateLiveEntryFromHistory(matchingSession);
    return {
      session: matchingSession,
      initialPrompt: null,
      initialImages: null,
      initialAnnotations: null,
      seedMessages: hydratedMessages ?? [],
    };
  }, [
    findNativeHistorySessionForSession,
    findLiveEntryForSession,
    hydrateLiveEntryFromHistory,
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
  const recentComposeFolders = useMemo(() => recent.slice(0, 5), [recent]);
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
    if (workspaceMode !== 'compose') return;
    setBrowserTargetBySessionId((previous) => (
      retireBrowserPanelTargetForWorkingDirChange(
        previous,
        WORKSPACE_BROWSER_COMPOSE_SESSION_ID,
        skillsContext.workingDir,
      )
    ));
  }, [skillsContext.workingDir, workspaceMode]);

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
      const selectionRequestSeq = ++historySelectionRequestSeqRef.current;
      const requiresRouteResolution = session.source === 'claude';
      updateHistoryRouteResolutionStatus(requiresRouteResolution ? 'resolving' : 'ready');
      // Invalidate any transcript request started by the previously selected
      // session before awaiting native/history lookups for this one. Without
      // this, a slow A request can still overwrite B after B becomes live.
      conversationRequestSeqRef.current += 1;
      conversationLoadAbortRef.current?.abort();
      // Clear A synchronously as soon as B is selected. Merely invalidating
      // A's request is not enough: its already-rendered transcript would sit
      // under B's title while B's native lookup is pending (or if it fails).
      setMessages([]);
      setSegments([]);
      setHistoryEvents([]);
      setHistoryTranscriptBackfillState('idle');
      setActiveSegment(null);
      updateIsLoadingMessages(true);
      const selectionIsCurrent = () =>
        historySelectionRequestSeqRef.current === selectionRequestSeq
        && selectedKeyRef.current === key;
      setSelectedKey(key);
      selectedKeyRef.current = key;
      setSelectedHistoryNativeRuntimeId(null);

      // Apply the user's unsubmitted per-history choice synchronously with
      // selection. If none exists, start off until the authoritative native
      // record lookup below proves this exact history session was routed.
      const draftKey = historyRouteDraftKey(session);
      const explicitChoice = readHistoryRouteDraft(window.localStorage, draftKey);
      updateHistoryRouteDraftState(explicitChoice ?? createComposerRouteDraft());

      const liveEntry = options?.forceHistory
        ? null
        : await ensureLiveEntryForSession(session).catch((error) => {
          console.error('Failed to resolve native session for history selection:', error);
          return null;
        });
      if (!selectionIsCurrent()) return;
      await markPetNotificationReadForSession(session, liveEntry).catch((error) => {
        console.error('Failed to mark selected history session read:', error);
      });
      if (!selectionIsCurrent()) return;
      if (liveEntry && canRestoreWorkspaceLiveSession(liveEntry.session)) {
        updateHistoryRouteResolutionStatus('ready');
        updateIsLoadingMessages(false);
        setActiveLiveRuntimeId(liveEntry.session.runtime_id);
        setComposeDir(liveEntry.session.project_dir);
        setSelectedWorkingDir(liveEntry.session.project_dir);
        setWorkspaceMode('live');
        return;
      }

      const shouldLookupNativeHistory = options?.nativeHistorySession === undefined;
      let nativeHistoryLookupFailed = false;
      const nativeHistorySession = shouldLookupNativeHistory
        ? await findNativeHistorySessionForSession(session).catch((error) => {
          nativeHistoryLookupFailed = true;
          console.error('Failed to resolve routed history state:', error);
          return null;
        })
        : options.nativeHistorySession ?? null;
      if (!selectionIsCurrent()) return;

      const historyBrowserAgentSessionId = resolveHistoryBrowserAgentSessionId(
        session,
        nativeHistorySession,
      );
      if (historyBrowserAgentSessionId && nativeHistorySession) {
        upsertLiveSessionEntry(nativeHistorySession);
        setSelectedHistoryNativeRuntimeId(historyBrowserAgentSessionId);
      }

      if (requiresRouteResolution && nativeHistoryLookupFailed) {
        updateHistoryRouteResolutionStatus('failed');
        setWorkspaceMode('history');
        toast.error(t('workspace.historyRouterResolveFailed'));
        await loadConversation(session, {
          resetBeforeLoad: true,
          showLoading: true,
        });
        return;
      }

      const restored = session.source === 'claude'
        ? resolveHistoryRouteRestore(nativeHistorySession)
        : { kind: 'off' as const };
      updateHistoryRouteDraftState(
        explicitChoice
        ?? (restored.kind === 'restored' ? restored.draft : createComposerRouteDraft()),
      );

      if (
        explicitChoice === null
        && restored.kind === 'restored'
        && nativeHistorySession?.router?.defaultEnv
      ) {
        setHistoryEnv(nativeHistorySession.router.defaultEnv);
      }

      updateHistoryRouteResolutionStatus('ready');
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
      t,
      upsertLiveSessionEntry,
      updateHistoryRouteDraftState,
      updateHistoryRouteResolutionStatus,
      updateIsLoadingMessages,
    ]
  );

  const selectNativeSessionSummary = useCallback((session: NativeSessionSummary) => {
    const existingEntry = liveSessionsByRuntimeIdRef.current[session.runtime_id];
    upsertLiveSessionEntry(session, {
      initialPrompt: existingEntry?.initialPrompt ?? null,
      initialImages: existingEntry?.initialImages ?? null,
      initialAnnotations: existingEntry?.initialAnnotations ?? null,
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
      if (
        parsed.cwd
        && normalizeHistoryRouteProject(session.project)
          !== normalizeHistoryRouteProject(parsed.cwd)
      ) {
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
    // A fresh Composer always starts with Dynamic Routing opted out.
    updateComposeRouteDraftState(createComposerRouteDraft());
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

  const applyComposeDir = useCallback((dir: string) => {
    setComposeDir(dir);
    setSelectedWorkingDir(dir);
    void recordRecentProject(dir);
  }, [recordRecentProject, setSelectedWorkingDir]);

  const handlePickComposeDir = useCallback(async () => {
    try {
      const dir = await openDirectoryPicker();
      if (dir) {
        applyComposeDir(dir);
      }
    } catch (error) {
      console.error('Failed to open directory dialog:', error);
    }
  }, [applyComposeDir, openDirectoryPicker]);

  const showWorkspaceTerminalLaunchError = useCallback((error: unknown) => {
    if (!isInteractiveSessionTerminalOpenError(error)) {
      toast.error(t('workspace.nativeHandoffFailed'));
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
      showWorkspaceTerminalLaunchError(error);
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
    showWorkspaceTerminalLaunchError,
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
    const generationRevision = beginWorkspaceSessionTitleGeneration(
      titleGenerationRevisionsRef.current,
      session.runtime_id,
    );

    void generateWorkspaceSessionTitle(normalizedInput)
      .then(async (generatedTitle) => {
        const title = generatedTitle?.trim();
        if (
          !title
          || !isWorkspaceSessionTitleGenerationCurrent(
            titleGenerationRevisionsRef.current,
            session.runtime_id,
            generationRevision,
          )
        ) {
          return;
        }

        const latestSession = liveSessionsByRuntimeIdRef.current[session.runtime_id]?.session ?? session;
        const providerSessionId = latestSession.provider_session_id?.trim();
        const result = await setSessionTitle(
          session.provider,
          session.runtime_id,
          title,
          providerSessionId ? [providerSessionId] : [],
          false,
          [session.runtime_id],
        ).catch((error) => {
          console.error('Failed to persist generated native session title:', error);
          return null;
        });
        if (
          !result?.applied
          || !isWorkspaceSessionTitleGenerationCurrent(
            titleGenerationRevisionsRef.current,
            session.runtime_id,
            generationRevision,
          )
        ) {
          return;
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
    setSessionTitle,
  ]);

  const runCreateNativeConversation = useCallback(async (payload?: ComposerSubmitPayload) => {
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
    // Per-Composer Dynamic Routing opt-in: resolve the launch seed from the
    // CURRENT store config at submit time. Blocking codes keep the draft so the
    // user can fix the selection and retry; opted-out drafts omit the param.
    let routerLaunchDraft: RouterLaunchDraft | null = null;
    const routeDraft = composeRouteDraftRef.current;
    if (composeProvider === 'claude' && routeDraft.optIn) {
      const resolution = resolveRouterLaunchDraft(
        routeDraft,
        useAppStore.getState().routerConfig,
      );
      if (!resolution.ok) {
        if (resolution.code === 'PROFILE_MISSING') {
          toast.error(t('router.routeDraftProfileMissing'));
        } else {
          toast.error(t('router.routeDraftConfigUnavailable'));
        }
        return false;
      }
      routerLaunchDraft = resolution.value;
    }

    const dispatch = resolveComposerDispatch({
      provider: composeProvider,
      prompt,
      permissionMode,
      planModeEnabled: isCronCommand ? false : composePlanModeEnabled,
    });

    setIsCreatingNativeSession(true);
    try {
      const launch = await startAfterCodexModelMigrationGate({
        provider: composeProvider,
        envName: currentEnv,
        workingDir,
        preflight: preflightCodexModelMigration,
        confirm: requestCodexModelMigrationDecision,
        acknowledgedWarnings: acknowledgedCodexModelWarningsRef.current,
        start: (codexMigrationProofToken) => createNativeSession({
          provider: composeProvider,
          envName: currentEnv,
          permMode: dispatch.permMode,
          runtimePermMode: dispatch.runtimePermMode,
          workingDir,
          initialPrompt: dispatch.prompt,
          initialDisplayPrompt: previewPrompt,
          initialImages: images.length > 0 ? images : undefined,
          initialAnnotations: payload?.annotations,
          effort: normalizeEffortForProvider(composeEffort, composeProvider),
          seedBoundaryMessageCount: 0,
          routerLaunchDraft,
          codexMigrationProofToken,
        }),
      });
      if (!launch.started) {
        if (launch.reason === 'preflight_changed') {
          toast.error(t('workspace.codexModelMigrationChanged'));
        }
        return false;
      }
      const summary = launch.value;

      const liveBrowserSessionId = browserPanelSessionKeyRegistryRef.current.resolveLive({
        provider: summary.provider,
        providerSessionId: summary.provider_session_id,
        runtimeId: summary.runtime_id,
      });
      setBrowserTargetBySessionId((previous) => {
        const next = rebindBrowserPanelTarget(
          previous,
          WORKSPACE_BROWSER_COMPOSE_SESSION_ID,
          liveBrowserSessionId,
        );
        browserTargetBySessionIdRef.current = next;
        return next;
      });
      upsertLiveSessionEntry(summary, {
        initialPrompt: previewPrompt,
        initialImages: images.length > 0 ? images : null,
        initialAnnotations: payload?.annotations ?? null,
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
      // The next Composer starts opted out again; the launch just created
      // carries this draft's routing snapshot in its authoritative state.
      updateComposeRouteDraftState(createComposerRouteDraft());
      setSelectedWorkingDir(workingDir);
      scheduleWorkspaceRefresh(1200);
      return true;
    } catch (error) {
      console.error('Failed to create native workspace session:', error);
      // An opted-in launch failure must surface the backend's specific error
      // (e.g. ROUTER_* validation), not just the generic banner — the draft is
      // intentionally KEPT so the user can adjust and retry.
      if (routerLaunchDraft) {
        const detail = error instanceof Error ? error.message : String(error);
        toast.error(detail || t('workspace.nativeCreateFailed'));
      } else {
        toast.error(t('workspace.nativeCreateFailed'));
      }
      return false;
    } finally {
      setIsCreatingNativeSession(false);
    }
  }, [
    buildComposerPromptPreview,
    buildComposerPromptText,
    browserPanelSessionKeyRegistryRef,
    extractComposerImagePayloads,
    composeEffort,
    composeProvider,
    composePlanModeEnabled,
    createNativeSession,
    currentEnv,
    effectiveComposeDir,
    isCreatingNativeSession,
    permissionMode,
    preflightCodexModelMigration,
    requestWorkspaceSessionTitle,
    requestCodexModelMigrationDecision,
    resetComposePrompt,
    scheduleWorkspaceRefresh,
    setSelectedWorkingDir,
    upsertLiveSessionEntry,
    t,
  ]);

  // Synchronous in-flight guard: React state cannot stop a second submit in
  // the SAME tick (Enter + click / double click both read `false` before the
  // setState flushes). `begin()` flips a closure flag synchronously; released
  // only in `finally` so every return path (validation, failure, success)
  // re-arms it.
  const createConversationGuardRef = useRef<ReentryGuard | null>(null);
  if (!createConversationGuardRef.current) {
    createConversationGuardRef.current = createReentryGuard();
  }
  const handleCreateNativeConversation = useCallback(async (payload?: ComposerSubmitPayload) => {
    const guard = createConversationGuardRef.current;
    if (!guard || !guard.begin()) {
      return false;
    }
    try {
      return await runCreateNativeConversation(payload);
    } finally {
      guard.end();
    }
  }, [runCreateNativeConversation]);

  const runContinueHistorySession = useCallback(async (payload?: ComposerSubmitPayload) => {
    if (isResumingHistorySession) {
      return false;
    }

    if (!selectedSession) {
      return false;
    }

    // DSH sessions are read-only — never allow continuation in Workspace.
    if (selectedSession.source === 'dsh') {
      return false;
    }

    if (isHistoryRouteContinuationBlocked(
      selectedSession.source,
      historyRouteResolutionStatusRef.current,
    )) {
      const key = historyRouteResolutionStatusRef.current === 'failed'
        ? 'workspace.historyRouterResolveFailed'
        : 'workspace.historyRouterResolving';
      toast.error(t(key));
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
    // History sessions without an authoritative routed record default to off;
    // an explicit opt-in resolves against the CURRENT config.
    // A RESTORED draft instead references the authoritative routed runtime:
    // the backend clones its private route/auth record and mints fresh
    // secrets — the public summary is never replayed as a launch draft.
    let routerLaunchDraft: RouterLaunchDraft | null = null;
    let resumeRouterFromRuntimeId: string | null = null;
    const routeDraft = historyRouteDraftRef.current;
    if (provider === 'claude' && routeDraft.optIn) {
      const restored = routeDraft.restoredSource;
      if (restored) {
        resumeRouterFromRuntimeId = restored.runtimeId;
      } else {
        const resolution = resolveRouterLaunchDraft(
          routeDraft,
          useAppStore.getState().routerConfig,
        );
        if (!resolution.ok) {
          if (resolution.code === 'PROFILE_MISSING') {
            toast.error(t('router.routeDraftProfileMissing'));
          } else {
            toast.error(t('router.routeDraftConfigUnavailable'));
          }
          return false;
        }
        routerLaunchDraft = resolution.value;
      }
    }
    const dispatch = resolveComposerDispatch({
      provider,
      prompt,
      permissionMode: historyPermMode,
      planModeEnabled: isCronCommand ? false : historyPlanModeEnabled,
    });
    setIsResumingHistorySession(true);

    try {
      const launch = await startAfterCodexModelMigrationGate({
        provider,
        envName: historyEnv,
        workingDir: selectedSession.project,
        preflight: preflightCodexModelMigration,
        confirm: requestCodexModelMigrationDecision,
        acknowledgedWarnings: acknowledgedCodexModelWarningsRef.current,
        start: (codexMigrationProofToken) => createNativeSession({
          provider,
          envName: historyEnv,
          permMode: dispatch.permMode,
          runtimePermMode: dispatch.runtimePermMode,
          workingDir: selectedSession.project,
          initialPrompt: dispatch.prompt,
          initialDisplayPrompt: previewPrompt,
          initialImages: images.length > 0 ? images : undefined,
          initialAnnotations: payload?.annotations,
          providerSessionId: selectedSession.id,
          effort: normalizeEffortForProvider(historyEffort, provider),
          seedBoundaryMessageCount: messages.length,
          routerLaunchDraft,
          resumeRouterFromRuntimeId,
          codexMigrationProofToken,
        }),
      });
      if (!launch.started) {
        if (launch.reason === 'preflight_changed') {
          toast.error(t('workspace.codexModelMigrationChanged'));
        }
        return false;
      }
      const summary = launch.value;

      setLaunchClient(provider);
      upsertLiveSessionEntry(summary, {
        initialPrompt: previewPrompt,
        initialImages: images.length > 0 ? images : null,
        initialAnnotations: payload?.annotations ?? null,
        seedMessages: messages,
      });
      setActiveLiveRuntimeId(summary.runtime_id);
      setWorkspaceMode('live');
      resetHistoryComposerText('');
      setHistoryPlanModeEnabled(false);
      clearHistoryRouteDraft(
        window.localStorage,
        historyRouteDraftKey(selectedSession),
      );
      updateHistoryRouteDraftState(createComposerRouteDraft());
      setSelectedWorkingDir(selectedSession.project);
      scheduleWorkspaceRefresh(1200);
      return true;
    } catch (error) {
      console.error('Failed to continue workspace history session:', error);
      if (routerLaunchDraft || resumeRouterFromRuntimeId) {
        const detail = error instanceof Error ? error.message : String(error);
        toast.error(detail || t('workspace.nativeCreateFailed'));
      } else {
        toast.error(t('workspace.nativeCreateFailed'));
      }
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
    preflightCodexModelMigration,
    requestCodexModelMigrationDecision,
    scheduleWorkspaceRefresh,
    selectedSession,
    setLaunchClient,
    setSelectedWorkingDir,
    resetHistoryComposerText,
    updateHistoryRouteDraftState,
    upsertLiveSessionEntry,
    t,
  ]);

  // ---- Fork session from a model-output turn (Claude only) ----
  const [forkDialog, setForkDialog] = useState<{
    request: WorkspaceForkTurnRequest;
    target: WorkspaceForkTarget;
  } | null>(null);
  const [isForkingTurn, setIsForkingTurn] = useState(false);

  const openForkTurn = useCallback((
    request: WorkspaceForkTurnRequest,
    target: WorkspaceForkTarget,
  ) => {
    setForkDialog({ request, target });
  }, []);

  const closeForkTurnDialog = useCallback(() => {
    setForkDialog((current) => (isForkingTurn ? current : null));
  }, [isForkingTurn]);

  const runForkFromTurn = useCallback(async (firstPrompt: string) => {
    if (!forkDialog || isForkingTurn) {
      return;
    }
    setIsForkingTurn(true);
    const { request } = forkDialog;
    try {
      const summary = await createNativeSession({
        provider: 'claude',
        envName: request.envName,
        permMode: request.permMode,
        workingDir: request.workingDir ?? null,
        initialPrompt: firstPrompt,
        providerSessionId: request.providerSessionId,
        forkFromMessageId: request.forkFromMessageId,
        effort: request.effort ?? null,
        seedBoundaryMessageCount: request.seedMessages.length,
      });
      setLaunchClient('claude');
      upsertLiveSessionEntry(summary, {
        initialPrompt: firstPrompt,
        initialImages: null,
        initialAnnotations: null,
        seedMessages: request.seedMessages,
      });
      setActiveLiveRuntimeId(summary.runtime_id);
      setWorkspaceMode('live');
      scheduleWorkspaceRefresh(1200);
      setForkDialog(null);
    } catch (error) {
      console.error('Failed to fork session from turn:', error);
      const detail = error instanceof Error ? error.message : String(error);
      toast.error(detail || t('workspace.forkTurnCreateFailed'));
    } finally {
      setIsForkingTurn(false);
    }
  }, [
    createNativeSession,
    forkDialog,
    isForkingTurn,
    scheduleWorkspaceRefresh,
    setLaunchClient,
    upsertLiveSessionEntry,
    t,
  ]);

  // History-mode fork anchor: built from current selection each render, but the
  // callback handed to memoized bubbles must stay identity-stable.
  const handleForkHistoryTurnImpl = useRef<(message: ConversationMessageData) => void>(() => {});
  handleForkHistoryTurnImpl.current = (message: ConversationMessageData) => {
    if (!selectedSession || selectedSession.source !== 'claude' || !selectedSession.project) {
      return;
    }
    if (!message.uuid || message.uuid.startsWith('assistant-turn-')) {
      return;
    }
    // Bubbles render merged/windowed messages; match by uuid against the raw
    // transcript array that seeds the forked session view.
    const index = messages.findIndex((candidate) => candidate.uuid === message.uuid);
    if (index < 0) {
      return;
    }
    openForkTurn({
      providerSessionId: selectedSession.id,
      forkFromMessageId: message.uuid,
      seedMessages: messages.slice(0, index + 1),
      envName: historyEnv,
      permMode: historyPermMode,
      workingDir: selectedSession.project,
      effort: normalizeEffortForProvider(historyEffort, 'claude'),
    }, {
      turnPreview: getWorkspaceForkTurnPreview(message),
    });
  };
  const handleForkHistoryTurn = useCallback((message: ConversationMessageData) => {
    handleForkHistoryTurnImpl.current(message);
  }, []);

  // All user route-draft edits for the history composer flow through here so
  // the keyed store stays in sync (A/B/A retention). UI edits never carry a
  // restored snapshot by construction; the restore path saves its own entry.
  const updateHistoryRouteDraft = useCallback((next: ComposerRouteDraft) => {
    if (selectedSession) {
      writeHistoryRouteDraft(
        window.localStorage,
        historyRouteDraftKey(selectedSession),
        next,
      );
    }
    updateHistoryRouteDraftState(next);
  }, [selectedSession, updateHistoryRouteDraftState]);

  // Same synchronous in-flight guard as the compose submit (see above).
  const resumeHistoryGuardRef = useRef<ReentryGuard | null>(null);
  if (!resumeHistoryGuardRef.current) {
    resumeHistoryGuardRef.current = createReentryGuard();
  }
  const handleContinueHistorySession = useCallback(async (payload?: ComposerSubmitPayload) => {
    const guard = resumeHistoryGuardRef.current;
    if (!guard || !guard.begin()) {
      return false;
    }
    try {
      return await runContinueHistorySession(payload);
    } finally {
      guard.end();
    }
  }, [runContinueHistorySession]);

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

  const handleOpenSearchShortcut = useCallback(() => {
    setIsGlobalSearchOpen(true);
  }, []);

  const handleOpenProjectShortcut = useCallback(() => {
    void handlePickComposeDir();
  }, [handlePickComposeDir]);

  const handleWorkspaceSubmitShortcut = useCallback(() => {
    if (workspaceMode === 'history') {
      void handleContinueHistorySession();
      return;
    }
    void handleCreateNativeConversation();
  }, [handleContinueHistorySession, handleCreateNativeConversation, workspaceMode]);

  const shortcuts = useMemo(
    () => ({
      'meta+k': handleOpenSearchShortcut,
      'meta+o': handleOpenProjectShortcut,
      'meta+enter': handleWorkspaceSubmitShortcut,
    }),
    [handleOpenProjectShortcut, handleOpenSearchShortcut, handleWorkspaceSubmitShortcut],
  );
  useKeyboardShortcuts(isActive ? shortcuts : {});

  // Escape is owned by the currently visible coordinator command only. Keep
  // the last identity outside the effect so key repeat and rerenders cannot
  // send duplicate interrupt requests for the same command.
  const lastWorkspaceEscapeCommandRef = useRef<WorkspaceEscapeCommandIdentity | null>(null);
  const activeLiveStoppingId = activeLiveEntry?.session.runtime_id ?? null;
  const activeLiveProvider = activeLiveEntry?.session.provider;
  const activeLiveProviderProcessing = activeLiveEntry?.session.status === 'initializing'
    || activeLiveEntry?.session.status === 'processing';
  const activeLiveCommandId = activeLiveEntry?.session.lifecycle?.active_command_id ?? null;
  const activeLiveSessionIsActive = (activeLiveEntry?.session.is_active ?? false)
    || activeLiveCommandId != null;
  const isActiveLiveSessionVisible = workspaceMode === 'live' && activeLiveEntry != null;

  const handleWorkspaceEscapeShortcut = useCallback((event?: KeyboardEvent) => {
    const decision = decideWorkspaceEscape({
      key: event?.key ?? 'Escape',
      isComposing: event?.isComposing,
      keyCode: event?.keyCode,
      repeat: event?.repeat,
      defaultPrevented: event?.defaultPrevented,
      target: event?.target ?? null,
      isWorkspaceActive: isActive,
      isLiveSessionVisible: isActiveLiveSessionVisible,
      isSessionActive: activeLiveSessionIsActive,
      runtimeId: activeLiveStoppingId,
      activeCommandId: activeLiveCommandId,
      provider: activeLiveProvider,
      isProviderProcessing: activeLiveProviderProcessing,
      lastRequestedCommand: lastWorkspaceEscapeCommandRef.current,
      hasOpenInteractionLayer: hasOpenWorkspaceEscapeLayer(document),
    });
    if (decision.kind !== 'stop') return;

    lastWorkspaceEscapeCommandRef.current = decision;
    event?.preventDefault();
    void stopNativeSession(
      decision.runtimeId,
      'workspace_escape',
      decision.commandId,
    );
  }, [
    activeLiveCommandId,
    activeLiveProvider,
    activeLiveProviderProcessing,
    activeLiveSessionIsActive,
    activeLiveStoppingId,
    isActive,
    isActiveLiveSessionVisible,
    stopNativeSession,
  ]);

  const handleBrowserSurfaceHostShortcut = useCallback((
    action: BrowserSurfaceHostShortcutAction,
  ) => {
    if (!isActive) return;
    switch (action) {
      case 'open_search':
        handleOpenSearchShortcut();
        break;
      case 'open_project':
        handleOpenProjectShortcut();
        break;
      case 'submit':
        handleWorkspaceSubmitShortcut();
        break;
      case 'escape':
        handleWorkspaceEscapeShortcut();
        break;
      case 'zoom_in':
      case 'zoom_out':
      case 'zoom_reset':
        dispatchAppZoomCommand(action);
        break;
    }
  }, [
    handleOpenProjectShortcut,
    handleOpenSearchShortcut,
    handleWorkspaceEscapeShortcut,
    handleWorkspaceSubmitShortcut,
    isActive,
  ]);

  useEffect(() => {
    if (!isActive || !isActiveLiveSessionVisible) return;

    const handler = (e: KeyboardEvent) => {
      handleWorkspaceEscapeShortcut(e);
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleWorkspaceEscapeShortcut, isActive, isActiveLiveSessionVisible]);

  const renderComposeView = () => (
    <div className="flex h-full min-h-0 flex-col items-center px-4 sm:px-6 lg:px-8">
      <div className="flex flex-1 flex-col items-center justify-end">
        <div className="mb-6 flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-2 text-center">
          <h2 className="shrink-0 whitespace-nowrap text-2xl font-semibold tracking-tight text-foreground">
            {t('workspace.composeTitle')}
          </h2>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex min-w-0 max-w-full items-center justify-center gap-1.5 text-2xl font-semibold tracking-tight text-muted-foreground transition-colors hover:text-foreground"
              >
                <FolderOpen className="h-4 w-4 shrink-0" />
                <span className="min-w-0 max-w-[300px] truncate">
                  {effectiveComposeDirLabel || t('workspace.composeSelectFolder')}
                </span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" side="bottom" className="min-w-[260px]">
              {recentComposeFolders.length > 0 && (
                <>
                  <DropdownMenuLabel className="px-2.5 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t('workspace.composeRecentFolders')}
                  </DropdownMenuLabel>
                  {recentComposeFolders.map((project) => (
                    <DropdownMenuItem
                      key={project.path}
                      onSelect={() => applyComposeDir(project.path)}
                    >
                      <FolderOpen className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm">{getProjectName(project.path)}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {truncatePath(project.path)}
                        </span>
                      </span>
                      {effectiveComposeDir === project.path && (
                        <Check className="ml-2 h-4 w-4 shrink-0 text-foreground" />
                      )}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onSelect={() => void handlePickComposeDir()}>
                <FolderSearch className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <span>{t('workspace.composeBrowseFolders')}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
          routeDraft={composeRouteDraft}
          onRouteDraftChange={updateComposeRouteDraftState}
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

    // DSH sessions should never appear in Workspace (backend legacy-only loader + frontend filter).
    // Guard defensively for type narrowing.
    if (selectedSession.source === 'dsh') {
      return null;
    }

    const historyProvider = selectedSession.source === 'codex' ? 'codex' : 'claude';
    const historyRouteDraftAvailable = selectedHistorySupportsInline
      && isRouteDraftRowVisible(selectedSession.source);
    const historyRouteResolutionBlocked = isHistoryRouteContinuationBlocked(
      selectedSession.source,
      historyRouteResolutionStatus,
    );

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
              transcriptBackfillState={historyTranscriptBackfillState}
              onTranscriptRetry={() => {
                void handleSelect(selectedSession, { forceHistory: true });
              }}
              canAddAnnotation={selectedHistorySupportsInline && historyAnnotations.canAddAnnotation}
              annotations={historyAnnotations.annotations}
              onAddAnnotation={selectedHistorySupportsInline ? historyAnnotations.addAnnotation : undefined}
              onUpdateAnnotation={selectedHistorySupportsInline ? historyAnnotations.updateAnnotation : undefined}
              onRemoveAnnotation={selectedHistorySupportsInline ? historyAnnotations.removeAnnotation : undefined}
              onForkTurn={selectedSession.source === 'claude' ? handleForkHistoryTurn : undefined}
            />
          </WorkspaceHistoryErrorBoundary>
        </Suspense>

        <WorkspaceSessionComposer
          value={historyComposerText}
          valueRevision={historyComposerRevision}
          onValueChange={handleHistoryComposerTextChange}
          onSubmit={handleContinueHistorySession}
          placeholder={
            historyRouteResolutionStatus === 'resolving'
              ? t('workspace.historyRouterResolving')
              : historyRouteResolutionStatus === 'failed'
                ? t('workspace.historyRouterResolveFailed')
                : selectedHistorySupportsInline
              ? t('workspace.composePlaceholder')
              : t('workspace.historyContinueUnsupported')
          }
          disabled={!selectedHistorySupportsInline || historyRouteResolutionBlocked}
          canSubmit={
            selectedHistorySupportsInline
            && !historyRouteResolutionBlocked
            && historyHasDraft
            && !isResumingHistorySession
          }
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
          routeDraft={historyRouteDraftAvailable ? historyRouteDraft : null}
          onRouteDraftChange={historyRouteDraftAvailable ? updateHistoryRouteDraft : undefined}
          codexInstalled={codexInstalled}
          opencodeInstalled={opencodeInstalled}
          onLaunchNewSession={handleNewSession}
          annotations={historyAnnotations.pendingAnnotations}
          onUpdateAnnotation={historyAnnotations.updateAnnotation}
          onRemoveAnnotation={historyAnnotations.removeAnnotation}
          onClearAnnotations={historyAnnotations.clearPendingAnnotations}
          onAnnotationsSent={historyAnnotations.markAllSent}
          onAnnotationsRestore={historyAnnotations.restoreAnnotations}
          controls={(
            <ComposerControls
              provider={historyProvider}
              envName={historyEnv}
              permMode={historyPermMode}
              effort={historyEffort}
              environments={environments}
              enabledEnvironments={enabledEnvironments}
              environmentLocked={Boolean(historyRouteDraft.restoredSource)}
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
                            .catch(showWorkspaceTerminalLaunchError);
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
    const liveEntries = Object.values(liveSessionsByRuntimeIdRef.current).filter((entry) => (
      entry.session.provider === session.source
      && (
        entry.session.runtime_id === session.id
        || entry.session.provider_session_id === session.id
      )
    ));
    const aliasSessionIds = Array.from(new Set(
      liveEntries
        .flatMap((entry) => [entry.session.runtime_id, entry.session.provider_session_id])
        .filter((id): id is string => Boolean(id?.trim()) && id !== session.id),
    ));
    for (const entry of liveEntries) {
      cancelWorkspaceSessionTitleGeneration(
        titleGenerationRevisionsRef.current,
        entry.session.runtime_id,
      );
    }

    const { revision: displayTitleRevision } = await setSessionTitle(
      session.source,
      session.id,
      title,
      aliasSessionIds,
      true,
      liveEntries.map((entry) => entry.session.runtime_id),
    );
    updateLiveSessionsByRuntimeId((previous) =>
      updateWorkspaceLiveSessionDisplayTitle(
        previous,
        session.source,
        session.id,
        title,
        displayTitleRevision,
      )
    );
  }, [setSessionTitle, updateLiveSessionsByRuntimeId]);

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
            onToggleBrowser={() => toggleActiveBrowser(skillsContext.workingDir)}
            envContext={statusStripEnvContext}
            activeRuntimeId={
              workspaceMode === 'live' && activeLiveEntry?.session.provider === 'claude'
                ? activeLiveRuntimeId
                : null
            }
            onNavigateEnvironments={() => onNavigate('environments')}
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
                          initialAnnotations={entry.initialAnnotations}
                          seedMessages={entry.seedMessages}
                          installedSkills={workspaceInstalledSkills}
                          onRefreshSkills={refreshWorkspaceInstalledSkills}
                          workspaceCommands={workspaceCommands}
                          isVisible={isActive && isActiveLiveEntry}
                          onSessionUpdate={handleLiveSessionUpdate}
                          codexInstalled={codexInstalled}
                          opencodeInstalled={opencodeInstalled}
                          onLaunchNewSession={handleNewSession}
                          onForkTurnRequest={openForkTurn}
                          onNavigateEnvironments={() => onNavigate('environments')}
                          onStartNew={() => {
                            setWorkspaceMode('compose');
                            setActiveLiveRuntimeId(null);
                            // "Start New" opens a fresh Composer: reset the
                            // routing opt-in so a prior unsent draft never
                            // leaks into the next launch.
                            updateComposeRouteDraftState(createComposerRouteDraft());
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

        {Object.entries(browserTargetBySessionId).map(([sessionId, target]) => {
          if (!target) return null;
          const isPanelActive = sessionId === activeBrowserSessionId
            && isBrowserPanelTargetVisible(target);
          const panelAgentSessionId = sessionId === activeBrowserSessionId
            ? activeBrowserAgentSessionId ?? undefined
            : undefined;
          const panelKey = String(target.instanceId);
          const panelProps = {
            sessionId: target.surfaceSessionId,
            defaultUrl: target.initialUrl,
            presentationRevision: browserPresentationRevision,
            isActiveSurface: isPanelActive,
            surfaceOccluded: browserSurfaceOccluded || !isPanelActive,
            className: 'h-full w-full',
            onResizeStart: handleBrowserPanelResizeStart,
            onHostShortcut: handleBrowserSurfaceHostShortcut,
            onClose: () => closeBrowserPanel(sessionId),
          };

          return (
            <div
              key={panelKey}
              data-ccem-browser-panel-owner={sessionId}
              data-ccem-browser-panel-instance={target.instanceId}
              className={cn(
                'h-full shrink-0',
                isPanelActive ? 'flex' : 'hidden',
              )}
              style={isPanelActive ? {
                flex: `0 0 ${browserPanelWidthPercent}%`,
                maxWidth: `${BROWSER_PANEL_MAX_WIDTH_PERCENT}%`,
                minWidth: BROWSER_PANEL_MIN_WIDTH_PX,
              } : undefined}
            >
              <BrowserPanel
                key={panelKey}
                {...target}
                {...panelProps}
                agentSessionId={panelAgentSessionId}
              />
            </div>
          );
        })}
      </div>

      <WorkspaceForkDialog
        open={forkDialog !== null}
        target={forkDialog?.target ?? null}
        submitting={isForkingTurn}
        onOpenChange={(next) => {
          if (!next) {
            closeForkTurnDialog();
          }
        }}
        onSubmit={(firstPrompt) => {
          void runForkFromTurn(firstPrompt);
        }}
      />

      <WorkspaceGlobalSearch
        sessions={sessions}
        isOpen={isGlobalSearchOpen}
        onOpenChange={setIsGlobalSearchOpen}
        onSelectSession={handleSelect}
        onSelectProject={handleCreateForProject}
      />

      <WorkspaceCodexModelMigrationDialog
        open={codexModelMigrationWarning !== null}
        warning={codexModelMigrationWarning}
        onCancel={() => settleCodexModelMigrationDecision(false)}
        onContinue={() => settleCodexModelMigrationDecision(true)}
      />
    </div>
  );
}
