import { create } from 'zustand';
import type { PermissionModeName } from '@ccem/core/browser';
import type { UsageStats, Milestone } from '@/types/analytics';

export interface Companion {
  name: string;
  personality: string;
  hatchedAt: number;
  species: string;
  rarity: string;
  eye: string;
  hat: string;
  shiny: boolean;
  stats: Record<string, number>;
}

export interface Environment {
  name: string;
  baseUrl: string;
  authToken?: string;
  defaultOpusModel: string;
  defaultSonnetModel?: string;
  defaultHaikuModel?: string;
  runtimeModel?: string;
  subagentModel?: string;
}

export type ArrangeLayout = 'horizontal2' | 'vertical2' | 'grid4' | 'left_main3';
export type LaunchClient = 'claude' | 'codex' | 'opencode';

/**
 * Lightweight summary published by whichever workspace context (live session,
 * compose, or history) currently owns the review panel. The status-strip entry
 * pill renders from this so a single always-visible trigger stays context-aware.
 */
export interface ReviewEntrySummary {
  envName: string;
  failedTools: number;
  changedFiles: number;
  artifacts: number;
}

export interface Session {
  id: string;
  client: LaunchClient;
  envName: string;
  configSource?: 'ccem' | 'native';
  workingDir: string;
  pid?: number;
  startedAt: Date;
  status: 'running' | 'stopped' | 'idle' | 'interrupted' | 'error';
  permMode: string;
  terminalType?: string;  // "iterm2" | "terminalapp"
  windowId?: string;      // iTerm2 window ID
  itermSessionId?: string; // iTerm2 session unique ID for arrange
  tmuxTarget?: string;
}

export interface FavoriteProject {
  path: string;
  name: string;
}

export interface RecentProject {
  path: string;
  lastUsed: string;
}

export interface VSCodeProject {
  path: string;
  syncedAt: string;
}

export interface JetBrainsProject {
  path: string;
  ide: string;
  syncedAt: string;
}

export interface InstalledSkill {
  id?: string;
  name: string;
  description: string;
  path: string;
  scope: 'enterprise' | 'project' | 'global' | 'plugin' | 'system' | string;
  agents: string[];
  source?: string;
  version?: string;
  provider?: 'claude' | 'codex' | string;
  skillFile?: string;
  displayName?: string;
  invocationLabel?: string;
  pluginName?: string;
  pluginMarketplace?: string;
  disabled?: boolean;
  visibility?: string;
  implicitAllowed?: boolean;
  uiMetadata?: {
    displayName?: string;
    shortDescription?: string;
    brandColor?: string;
    composerIcon?: string;
    logo?: string;
    defaultPrompt?: string;
  } | null;
  diagnostics?: string[];
}

export interface CronTask {
  id: string;
  name: string;
  cronExpression: string;
  prompt: string;
  workingDir: string;
  envName: string | null;
  executionProfile: 'conservative' | 'standard' | 'autonomous';
  maxBudgetUsd?: number | null;
  allowedTools?: string[];
  disallowedTools?: string[];
  enabled: boolean;
  timeoutSecs: number;
  templateId: string | null;
  wecomNotification?: CronWecomNotification | null;
  triggerType: string;
  parentTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CronWecomNotification {
  botId?: string | null;
  peerId?: string | null;
  enabled?: boolean | null;
}

export interface CronTaskRun {
  id: string;
  taskId: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number | null;
  status: string; // "running" | "success" | "failed" | "timeout"
  runtimeId?: string | null;
  runtimeKind?: string | null;
  providerSessionId?: string | null;
  workingDir?: string | null;
}

export interface CronTemplate {
  id: string;
  name: string;
  description: string;
  cronExpression: string;
  prompt: string;
  icon: string;
}

export interface ChannelInfo {
  kind: string; // 'desktop_ui' | 'telegram' | 'weixin' | 'wecom'
  connectedAt: string;
  label?: string;
  /** Raw backend ChannelKind for detach operations */
  rawKind?: import('@/lib/tauri-ipc').ChannelKind;
}

export interface UnifiedSession {
  id: string;
  runtimeKind: 'interactive' | 'headless';
  source: 'desktop' | 'telegram' | 'weixin' | 'wecom' | 'cron' | 'cli';
  status: string;
  projectDir: string;
  envName: string;
  permMode: string;
  createdAt: string;
  isActive: boolean;
  pid?: number;
  claudeSessionId?: string;
  tmuxTarget?: string;
  client?: string;
  channels: ChannelInfo[];
}

interface AppState {
  // Environments
  environments: Environment[];
  currentEnv: string;
  setEnvironments: (envs: Environment[]) => void;
  setCurrentEnv: (name: string) => void;
  addEnvironment: (env: Environment) => void;
  removeEnvironment: (name: string) => void;
  /**
   * Explicit enable list for runtime selectors.
   * null = legacy mode (all environments treated as enabled).
   */
  enabledEnvironments: string[] | null;
  setEnabledEnvironments: (names: string[] | null) => void;

  // Permission Mode
  permissionMode: PermissionModeName;
  defaultMode: PermissionModeName | null;
  setPermissionMode: (mode: PermissionModeName) => void;
  setDefaultMode: (mode: PermissionModeName | null) => void;
  launchClient: LaunchClient;
  setLaunchClient: (client: LaunchClient) => void;

  // Sessions
  sessions: Session[];
  setSessions: (sessions: Session[]) => void;
  addSession: (session: Session) => void;
  removeSession: (id: string) => void;
  updateSessionStatus: (id: string, status: Session['status']) => void;
  arrangeLayout: ArrangeLayout | null;
  setArrangeLayout: (layout: ArrangeLayout | null) => void;

  // Unified Sessions
  unifiedSessions: UnifiedSession[];
  isLoadingUnifiedSessions: boolean;
  sessionFilter: 'all' | 'interactive' | 'headless';
  setUnifiedSessions: (sessions: UnifiedSession[]) => void;
  setLoadingUnifiedSessions: (loading: boolean) => void;
  setSessionFilter: (filter: 'all' | 'interactive' | 'headless') => void;

  // Projects
  favorites: FavoriteProject[];
  recent: RecentProject[];
  vscodeProjects: VSCodeProject[];
  jetbrainsProjects: JetBrainsProject[];
  selectedWorkingDir: string | null;
  setFavorites: (favorites: FavoriteProject[]) => void;
  setRecent: (recent: RecentProject[]) => void;
  setVSCodeProjects: (projects: VSCodeProject[]) => void;
  setJetBrainsProjects: (projects: JetBrainsProject[]) => void;
  addFavorite: (project: FavoriteProject) => void;
  removeFavorite: (path: string) => void;
  setSelectedWorkingDir: (dir: string | null) => void;

  // Default Working Directory (for skills search & cron AI)
  defaultWorkingDir: string | null;
  setDefaultWorkingDir: (dir: string | null) => void;

  // Skills
  installedSkills: InstalledSkill[];
  setInstalledSkills: (skills: InstalledSkill[]) => void;

  // Analytics
  usageStats: UsageStats | null;
  milestones: Milestone[];
  continuousUsageDays: number;
  setUsageStats: (stats: UsageStats) => void;
  setMilestones: (milestones: Milestone[]) => void;
  setContinuousUsageDays: (days: number) => void;

  // Cron
  cronTasks: CronTask[];
  cronRuns: Record<string, CronTaskRun[]>;
  isLoadingCron: boolean;
  setCronTasks: (tasks: CronTask[]) => void;
  setCronRuns: (taskId: string, runs: CronTaskRun[]) => void;
  setLoadingCron: (loading: boolean) => void;

  // UI State
  isLoading: boolean;
  setLoading: (loading: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;

  // Workspace review panel (audit drawer entry lives in the status strip,
  // panel is hosted by whichever context — live / compose / history — is active)
  reviewPanelOpen: boolean;
  setReviewPanelOpen: (open: boolean) => void;
  reviewEntry: ReviewEntrySummary | null;
  setReviewEntry: (entry: ReviewEntrySummary | null) => void;

  // Per-domain loading flags (skeleton screens, never spinners)
  isLoadingEnvs: boolean;
  isLoadingSessions: boolean;
  isLoadingStats: boolean;
  isLoadingSkills: boolean;
  isLoadingSettings: boolean;
  setLoadingEnvs: (loading: boolean) => void;
  setLoadingSessions: (loading: boolean) => void;
  setLoadingStats: (loading: boolean) => void;
  setLoadingSkills: (loading: boolean) => void;
  setLoadingSettings: (loading: boolean) => void;
  // Companion (pet)
  companion: Companion | null;
  setCompanion: (c: Companion | null) => void;
}

function areReviewEntriesEqual(left: ReviewEntrySummary | null, right: ReviewEntrySummary | null) {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.envName === right.envName
    && left.failedTools === right.failedTools
    && left.changedFiles === right.changedFiles
    && left.artifacts === right.artifacts;
}

function areEnvironmentsEqual(left: Environment[], right: Environment[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((env, index) => {
    const candidate = right[index];
    return candidate
      && candidate.name === env.name
      && candidate.baseUrl === env.baseUrl
      && candidate.authToken === env.authToken
      && candidate.defaultOpusModel === env.defaultOpusModel
      && candidate.defaultSonnetModel === env.defaultSonnetModel
      && candidate.defaultHaikuModel === env.defaultHaikuModel
      && candidate.runtimeModel === env.runtimeModel
      && candidate.subagentModel === env.subagentModel;
  });
}

function areSessionsEqual(left: Session[], right: Session[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((session, index) => {
    const candidate = right[index];
    return candidate
      && candidate.id === session.id
      && candidate.client === session.client
      && candidate.envName === session.envName
      && candidate.workingDir === session.workingDir
      && candidate.pid === session.pid
      && candidate.startedAt.getTime() === session.startedAt.getTime()
      && candidate.status === session.status
      && candidate.permMode === session.permMode
      && candidate.terminalType === session.terminalType
      && candidate.windowId === session.windowId
      && candidate.itermSessionId === session.itermSessionId
      && candidate.tmuxTarget === session.tmuxTarget;
  });
}

function areEnabledEnvironmentsEqual(
  left: string[] | null,
  right: string[] | null,
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return left === right;
  if (left.length !== right.length) return false;
  return left.every((name, index) => name === right[index]);
}

export const useAppStore = create<AppState>((set) => ({
  // Environments
  environments: [],
  currentEnv: 'official',
  setEnvironments: (envs) =>
    set((state) => (areEnvironmentsEqual(state.environments, envs) ? state : { environments: envs })),
  setCurrentEnv: (name) =>
    set((state) => (state.currentEnv === name ? state : { currentEnv: name })),
  addEnvironment: (env) =>
    set((state) => ({ environments: [...state.environments, env] })),
  removeEnvironment: (name) =>
    set((state) => ({
      environments: state.environments.filter((e) => e.name !== name),
    })),
  enabledEnvironments: null,
  setEnabledEnvironments: (names) =>
    set((state) =>
      areEnabledEnvironmentsEqual(state.enabledEnvironments, names)
        ? state
        : { enabledEnvironments: names },
    ),

  // Permission Mode
  permissionMode: 'dev',
  defaultMode: null,
  setPermissionMode: (mode) => set({ permissionMode: mode }),
  setDefaultMode: (mode) => set({ defaultMode: mode }),
  launchClient: 'claude',
  setLaunchClient: (client) => set({ launchClient: client }),

  // Sessions
  sessions: [],
  setSessions: (sessions) =>
    set((state) => (areSessionsEqual(state.sessions, sessions) ? state : { sessions })),
  addSession: (session) =>
    set((state) => ({ sessions: [...state.sessions, session] })),
  removeSession: (id) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
    })),
  updateSessionStatus: (id, status) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, status } : s
      ),
    })),
  arrangeLayout: null,
  setArrangeLayout: (layout) => set({ arrangeLayout: layout }),

  // Unified Sessions
  unifiedSessions: [],
  isLoadingUnifiedSessions: false,
  sessionFilter: 'all',
  setUnifiedSessions: (sessions) => set({ unifiedSessions: sessions }),
  setLoadingUnifiedSessions: (loading) => set({ isLoadingUnifiedSessions: loading }),
  setSessionFilter: (filter) => set({ sessionFilter: filter }),

  // Projects
  favorites: [],
  recent: [],
  vscodeProjects: [],
  jetbrainsProjects: [],
  selectedWorkingDir: null,
  setFavorites: (favorites) => set({ favorites }),
  setRecent: (recent) => set({ recent }),
  setVSCodeProjects: (projects) => set({ vscodeProjects: projects }),
  setJetBrainsProjects: (projects) => set({ jetbrainsProjects: projects }),
  addFavorite: (project) =>
    set((state) => ({ favorites: [...state.favorites, project] })),
  removeFavorite: (path) =>
    set((state) => ({
      favorites: state.favorites.filter((f) => f.path !== path),
    })),
  setSelectedWorkingDir: (dir) => set({ selectedWorkingDir: dir }),

  // Default Working Directory
  defaultWorkingDir: null,
  setDefaultWorkingDir: (dir) => set({ defaultWorkingDir: dir }),

  // Skills
  installedSkills: [],
  setInstalledSkills: (skills) => set({ installedSkills: skills }),

  // Analytics
  usageStats: null,
  milestones: [],
  continuousUsageDays: 0,
  setUsageStats: (stats) => set({ usageStats: stats }),
  setMilestones: (milestones) => set({ milestones }),
  setContinuousUsageDays: (days) => set({ continuousUsageDays: days }),

  // Cron
  cronTasks: [],
  cronRuns: {},
  isLoadingCron: false,
  setCronTasks: (tasks) => set({ cronTasks: tasks }),
  setCronRuns: (taskId, runs) => set((state) => ({ cronRuns: { ...state.cronRuns, [taskId]: runs } })),
  setLoadingCron: (loading) => set({ isLoadingCron: loading }),

  // UI State
  isLoading: false,
  setLoading: (loading) => set({ isLoading: loading }),
  error: null,
  setError: (error) => set({ error }),

  // Workspace review panel
  reviewPanelOpen: false,
  setReviewPanelOpen: (open) => set({ reviewPanelOpen: open }),
  reviewEntry: null,
  setReviewEntry: (entry) =>
    set((state) => (areReviewEntriesEqual(state.reviewEntry, entry) ? state : { reviewEntry: entry })),

  // Per-domain loading flags (skeleton screens, never spinners)
  isLoadingEnvs: false,
  isLoadingSessions: false,
  isLoadingStats: false,
  isLoadingSkills: false,
  isLoadingSettings: false,
  setLoadingEnvs: (loading) => set({ isLoadingEnvs: loading }),
  setLoadingSessions: (loading) => set({ isLoadingSessions: loading }),
  setLoadingStats: (loading) => set({ isLoadingStats: loading }),
  setLoadingSkills: (loading) => set({ isLoadingSkills: loading }),
  setLoadingSettings: (loading) => set({ isLoadingSettings: loading }),

  // Companion
  companion: null,
  setCompanion: (c) => set({ companion: c }),
}));
