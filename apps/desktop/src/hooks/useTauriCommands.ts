import { invoke } from '@tauri-apps/api/core';
import { resolveEnvConfigForRuntime } from '@ccem/core/browser';
import type {
  RouterConfig,
  RouterStatus,
  SessionRouterState,
  UpdateSessionRouterPatch,
} from '@ccem/core/browser';
import { useAppStore, type Environment, type Session, type ArrangeLayout, type InstalledSkill, type CronTask, type CronTaskRun, type CronTemplate, type CronWecomNotification, type LaunchClient } from '@/store';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { shallow } from 'zustand/shallow';
import type { SessionStickerId, SessionTaskStage, SessionSubagentsPayload } from '@/features/conversations/types';
import {
  formatInteractiveSessionLaunchError,
  launchInteractiveSession,
  openExistingInteractiveSessionTerminal,
} from '@/lib/interactiveSessionLaunch';
import type {
  ChannelKind,
  BindSessionToBotRequest,
  BotBindingInboundRequest,
  BotBindingInfo,
  BotBindingOutboxFrame,
  DesktopSettings,
  HeadlessSessionSummary,
  InteractivePromptAnnotation,
  InteractiveReplayBatch,
  ManagedSessionSummary,
  NativeHandoffResult,
  NativePromptImageInput,
  SessionPromptAnnotation,
  NativeSessionSummary,
  NativeTerminalType,
  PlatformCapabilities,
  ReplayBatch,
  RuntimeInput,
  RuntimeRecoveryCandidate,
  TelegramBridgeStatus,
  TelegramForumTopic,
  TelegramSettings,
  TelegramTopicBinding,
  WecomBridgeStatus,
  WecomSettings,
  WecomTaskBindingDefault,
  WecomTaskBindingOption,
  WeixinBridgeStatus,
  WeixinLoginSession,
  WeixinSettings,
  TmuxAttachTerminalInfo,
  TmuxAttachTerminalType,
  UnifiedSessionDebugComparison,
  UnifiedSessionInfo,
  WorkspaceFileSuggestion,
  WorkspaceGitSnapshot,
  WorkspaceFileDiff,
  WorkspaceMediaPreview,
  WorkspaceCommand,
} from '@/lib/tauri-ipc';
import { extractRouterServiceError, type RouterServiceError } from '@/lib/routerConflict';
import { coordinateEnvDelete } from '@/lib/envDeleteCoordination';

function makeLaunchTraceId(): string {
  return `launch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function recordSessionLaunchTrace(
  event: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await invoke('record_session_launch_trace', { event, details });
  } catch {
    // Diagnostic logging must never block the launch path.
  }
}

interface TauriEnvConfig {
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
  ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
  ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
  ANTHROPIC_MODEL?: string;
  CLAUDE_CODE_SUBAGENT_MODEL?: string;
  CCEM_LIMIT_WRITE_TOOLS?: boolean;
}

interface TauriSession {
  id: string;
  pid?: number;
  client?: string;
  env_name: string;
  config_source?: 'ccem' | 'native';
  perm_mode: string;
  working_dir: string;
  start_time: string;
  status: string;  // native runtime status, e.g. "running" | "stopped" | "interrupted" | "closed_idle"
  terminal_type?: string;  // "iterm2" | "terminalapp"
  window_id?: string;      // iTerm2 window ID
  iterm_session_id?: string; // iTerm2 session unique ID for arrange
  tmux_target?: string | null;
}

interface TauriFavoriteProject {
  path: string;
  name: string;
}

interface TauriRecentProject {
  path: string;
  lastUsed: string;
}

interface TauriVSCodeProject {
  path: string;
  syncedAt: string;
}

interface TauriJetBrainsProject {
  path: string;
  ide: string;
  syncedAt: string;
}

interface TauriAppConfig {
  favorites: TauriFavoriteProject[];
  recent: TauriRecentProject[];
  vscodeProjects: TauriVSCodeProject[];
  jetbrainsProjects: TauriJetBrainsProject[];
}

interface ProxyDebugState {
  enabled: boolean;
  running: boolean;
  listenPort?: number;
  baseUrl?: string;
  codexUpstreamBaseUrl: string;
  logMaxBytes: number;
  recordMode: string;
  routeCount: number;
  metrics: {
    totalRequests: number;
    successRequests: number;
    failedRequests: number;
    routeNotFoundRequests: number;
    avgResponseMs: number;
    activeConnections: number;
  };
}

interface ProxyTrafficItem {
  id: string;
  timestamp: number;
  client: string;
  sessionId: string;
  envName: string;
  method: string;
  path: string;
  query?: string;
  status: number;
  durationMs: number;
  requestBodySize: number;
  responseBodySize: number;
  promptPreview?: string;
  logDropped: boolean;
  responseIncomplete: boolean;
  logPartial: boolean;
  logDroppedBytes: number;
  reduced?: {
    finalText: string;
    finishReason?: string;
    streamStatus: string;
    firstTokenMs?: number;
    totalStreamMs?: number;
  };
}

interface ProxyTrafficPage {
  items: ProxyTrafficItem[];
  nextCursor?: string;
}

interface ProxyTrafficDetail {
  item: ProxyTrafficItem;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  reduced?: ProxyTrafficItem['reduced'];
}

function normalizeLaunchClient(client?: string): LaunchClient {
  switch (client?.toLowerCase()) {
    case 'codex':
      return 'codex';
    case 'opencode':
      return 'opencode';
    default:
      return 'claude';
  }
}

function toFrontendSession(tauriSession: TauriSession): Session {
  return {
    id: tauriSession.id,
    client: normalizeLaunchClient(tauriSession.client),
    envName: tauriSession.env_name,
    configSource: tauriSession.config_source,
    workingDir: tauriSession.working_dir,
    pid: tauriSession.pid,
    startedAt: new Date(tauriSession.start_time),
    status: tauriSession.status as Session['status'],
    permMode: tauriSession.perm_mode,
    terminalType: tauriSession.terminal_type,
    windowId: tauriSession.window_id,
    itermSessionId: tauriSession.iterm_session_id,
    tmuxTarget: tauriSession.tmux_target ?? undefined,
  };
}

export function useTauriCommands() {
  const {
    setEnvironments,
    setCurrentEnv,
    setEnabledEnvironments,
    setLoading,
    setLoadingEnvs,
    setError,
    addSession,
    setSessions,
    removeSession,
    updateSessionStatus,
    setFavorites,
    setRecent,
    setVSCodeProjects,
    setJetBrainsProjects,
    setInstalledSkills,
    setCronTasks,
    setCronRuns,
    setLoadingCron,
    setDefaultWorkingDir,
    setRouterConfig,
    setRouterStatus,
    setSessionRouter,
  } = useAppStore(
    (state) => ({
      setEnvironments: state.setEnvironments,
      setCurrentEnv: state.setCurrentEnv,
      setEnabledEnvironments: state.setEnabledEnvironments,
      setLoading: state.setLoading,
      setLoadingEnvs: state.setLoadingEnvs,
      setError: state.setError,
      addSession: state.addSession,
      setSessions: state.setSessions,
      removeSession: state.removeSession,
      updateSessionStatus: state.updateSessionStatus,
      setFavorites: state.setFavorites,
      setRecent: state.setRecent,
      setVSCodeProjects: state.setVSCodeProjects,
      setJetBrainsProjects: state.setJetBrainsProjects,
      setInstalledSkills: state.setInstalledSkills,
      setCronTasks: state.setCronTasks,
      setCronRuns: state.setCronRuns,
      setLoadingCron: state.setLoadingCron,
      setDefaultWorkingDir: state.setDefaultWorkingDir,
      setRouterConfig: state.setRouterConfig,
      setRouterStatus: state.setRouterStatus,
      setSessionRouter: state.setSessionRouter,
    }),
    shallow
  );

  const getSessionDefaults = useCallback(() => {
    const { currentEnv, permissionMode, selectedWorkingDir } = useAppStore.getState();
    return { currentEnv, permissionMode, selectedWorkingDir };
  }, []);

  const loadEnvironments = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!silent) {
      setLoading(true);
      setLoadingEnvs(true);
    }
    try {
      const envs = await invoke<Record<string, TauriEnvConfig>>('get_environments');
      const envList: Environment[] = Object.entries(envs).map(([name, config]) => {
        const displayConfig = resolveEnvConfigForRuntime(name, config);
        return {
          name,
          baseUrl: displayConfig.ANTHROPIC_BASE_URL || '',
          authToken: displayConfig.ANTHROPIC_AUTH_TOKEN,
          defaultOpusModel: displayConfig.ANTHROPIC_DEFAULT_OPUS_MODEL || '',
          defaultSonnetModel: displayConfig.ANTHROPIC_DEFAULT_SONNET_MODEL,
          defaultHaikuModel: displayConfig.ANTHROPIC_DEFAULT_HAIKU_MODEL,
          runtimeModel: displayConfig.ANTHROPIC_MODEL || 'opus',
          subagentModel: displayConfig.CLAUDE_CODE_SUBAGENT_MODEL,
          limitWriteTools: Boolean(displayConfig.CCEM_LIMIT_WRITE_TOOLS),
        };
      });
      envList.sort((a, b) => a.name.localeCompare(b.name));
      setEnvironments(envList);
      setError(null);
      return true;
    } catch (err) {
      setError(`Failed to load environments: ${err}`);
      return false;
    } finally {
      if (!silent) {
        setLoading(false);
        setLoadingEnvs(false);
      }
    }
  }, [setEnvironments, setLoading, setLoadingEnvs, setError]);

  const loadCurrentEnv = useCallback(async () => {
    try {
      const current = await invoke<string>('get_current_env');
      setCurrentEnv(current);
    } catch (err) {
      console.error('Failed to load current env:', err);
    }
  }, [setCurrentEnv]);

  const switchEnvironment = useCallback(async (name: string) => {
    setLoading(true);
    try {
      await invoke('set_current_env', { name });
      setCurrentEnv(name);
      setError(null);
    } catch (err) {
      setError(`Failed to switch environment: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [setCurrentEnv, setLoading, setError]);

  const addEnvironment = useCallback(async (env: Environment) => {
    setLoading(true);
    try {
      await invoke('add_environment', {
        name: env.name,
        baseUrl: env.baseUrl,
        authToken: env.authToken,
        defaultOpusModel: env.defaultOpusModel,
        defaultSonnetModel: env.defaultSonnetModel,
        defaultHaikuModel: env.defaultHaikuModel,
        runtimeModel: env.runtimeModel,
        subagentModel: env.subagentModel,
        limitWriteTools: env.limitWriteTools,
      });
      await loadEnvironments();
      // In managed enable mode, newly created/copied envs start enabled.
      const currentEnabled = useAppStore.getState().enabledEnvironments;
      if (currentEnabled != null && !currentEnabled.includes(env.name)) {
        const next = [...currentEnabled, env.name];
        await invoke('save_enabled_environments', { names: next });
        setEnabledEnvironments(next);
      }
      setError(null);
    } catch (err) {
      setError(`Failed to add environment: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [loadEnvironments, setEnabledEnvironments, setLoading, setError]);

  const updateEnvironment = useCallback(async (env: Environment, oldName?: string) => {
    setLoading(true);
    try {
      const previousName = oldName ?? env.name;
      await invoke('update_environment', {
        oldName: previousName,
        name: env.name,
        baseUrl: env.baseUrl,
        authToken: env.authToken,
        defaultOpusModel: env.defaultOpusModel,
        defaultSonnetModel: env.defaultSonnetModel,
        defaultHaikuModel: env.defaultHaikuModel,
        runtimeModel: env.runtimeModel,
        subagentModel: env.subagentModel,
        limitWriteTools: env.limitWriteTools,
      });
      await loadEnvironments();
      await loadCurrentEnv();
      // Keep managed enable list aligned when an environment is renamed.
      const currentEnabled = useAppStore.getState().enabledEnvironments;
      if (
        currentEnabled != null &&
        previousName !== env.name &&
        currentEnabled.includes(previousName)
      ) {
        const next = currentEnabled.map((envName) =>
          envName === previousName ? env.name : envName,
        );
        await invoke('save_enabled_environments', { names: next });
        setEnabledEnvironments(next);
      }
      // Backend cascades RouterConfig env references on rename; refresh the
      // authoritative routerConfig so useRouterConfigEditor (which skips
      // refetch when cached) doesn't keep stale env names in rules/profiles.
      if (previousName !== env.name) {
        try {
          const router = await invoke<RouterConfig>('get_router_settings');
          setRouterConfig(router);
        } catch {
          // Router may be disabled/absent; non-fatal.
        }
      }
      setError(null);
    } catch (err) {
      setError(`Failed to update environment: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [loadEnvironments, loadCurrentEnv, setEnabledEnvironments, setRouterConfig, setLoading, setError]);

  const getEnvironmentRouterReferences = useCallback(async (name: string): Promise<string[]> => {
    return invoke<string[]>('get_environment_router_references', { name });
  }, []);

  const deleteEnvironment = useCallback(async (name: string) => {
    setLoading(true);
    try {
      // Capture the pre-delete local state to plan the local removal. The remote
      // delete does not mutate these, so this is correct regardless of outcome.
      const before = useAppStore.getState();
      const nextEnvironments = before.environments.filter((env) => env.name !== name);
      const beforeEnabled = before.enabledEnvironments;
      const enabledChanged = beforeEnabled != null && beforeEnabled.includes(name);
      const nextEnabled = beforeEnabled != null
        ? beforeEnabled.filter((n) => n !== name)
        : null;

      // coordinateEnvDelete enforces the commit boundary: only deleteRemote may
      // throw outward (→ App keeps the dialog). Post-commit failures are captured
      // into `partial`; the delete always resolves once committed.
      const partial = await coordinateEnvDelete({
        deleteRemote: () => invoke('delete_environment', { name }),
        removeLocal: () => {
          setEnvironments(nextEnvironments);
          if (enabledChanged && nextEnabled != null) setEnabledEnvironments(nextEnabled);
        },
        persistEnabled:
          enabledChanged && nextEnabled != null
            ? () => invoke('save_enabled_environments', { names: nextEnabled })
            : async () => undefined,
        refresh: async () => {
          if (!(await loadEnvironments())) throw new Error('environment refresh failed');
        },
      });

      if (partial.length > 0) {
        setError(`Environment "${name}" deleted, but: ${partial.join('; ')}.`);
      } else {
        setError(null);
      }
      // Resolves post-commit (delete committed) — App closes the dialog.
    } catch (err) {
      // deleteRemote (commit boundary) failed → surface + keep dialog (rethrow).
      setError(`Failed to delete environment: ${err}`);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [loadEnvironments, setEnvironments, setEnabledEnvironments, setLoading, setError]);

  const loadEnabledEnvironments = useCallback(async () => {
    try {
      const settings = await invoke<DesktopSettings>('get_settings');
      const enabled = settings.enabledEnvironments ?? null;
      setEnabledEnvironments(enabled);
      return enabled;
    } catch (err) {
      console.error('Failed to load enabled environments:', err);
      return null;
    }
  }, [setEnabledEnvironments]);

  const saveEnabledEnvironments = useCallback(async (names: string[] | null) => {
    await invoke('save_enabled_environments', { names });
    setEnabledEnvironments(names);
  }, [setEnabledEnvironments]);

  const syncInteractiveSessions = useCallback(async (): Promise<Session[]> => {
    const tauriSessions = await invoke<TauriSession[]>('list_interactive_sessions');
    const sessions = tauriSessions.map(toFrontendSession);
    setSessions(sessions);
    return sessions;
  }, [setSessions]);

  const loadAppConfig = useCallback(async () => {
    try {
      const config = await invoke<TauriAppConfig>('get_app_config');
      setFavorites(config.favorites);
      setRecent(config.recent);
      setVSCodeProjects(config.vscodeProjects);
      setJetBrainsProjects(config.jetbrainsProjects || []);
    } catch (err) {
      console.error('Failed to load app config:', err);
    }
    // Also load default working dir
    try {
      const dir = await invoke<string | null>('get_default_working_dir');
      setDefaultWorkingDir(dir);
    } catch {
      // ignore
    }
  }, [setFavorites, setRecent, setVSCodeProjects, setJetBrainsProjects, setDefaultWorkingDir]);

  const createInteractiveSession = useCallback(async (options: {
    envName?: string;
    permMode?: string;
    workingDir?: string | null;
    resumeSessionId?: string | null;
    client?: LaunchClient;
    initialPrompt?: string | null;
  } = {}): Promise<Session> => {
    setLoading(true);
    const launchTraceId = makeLaunchTraceId();
    try {
      const { currentEnv, permissionMode, selectedWorkingDir } = getSessionDefaults();
      const workDir = options.workingDir ?? selectedWorkingDir ?? null;

      return await launchInteractiveSession({
        traceId: launchTraceId,
        createStartDetails: {
          trace_id: launchTraceId,
          client: options.client ?? 'claude',
          env_name: options.envName ?? currentEnv,
          perm_mode: options.permMode ?? permissionMode,
          working_dir: workDir,
          resume: Boolean(options.resumeSessionId),
          initial_prompt: Boolean(options.initialPrompt),
        },
        createSession: async () => {
          const tauriSession = await invoke<TauriSession>('create_interactive_session', {
            envName: options.envName ?? currentEnv,
            permMode: options.permMode ?? permissionMode,
            workingDir: workDir,
            resumeSessionId: options.resumeSessionId ?? null,
            client: options.client ?? 'claude',
            initialPrompt: options.initialPrompt ?? null,
            launchTraceId,
          });
          return toFrontendSession(tauriSession);
        },
        describeCreatedSession: (session) => ({
          session_id: session.id,
          client: session.client,
          terminal_type: session.terminalType,
          tmux_target: session.tmuxTarget,
        }),
        onCreateError: (error) => {
          const clientLabel = options.client === 'codex'
            ? 'Codex'
            : options.client === 'opencode'
              ? 'OpenCode'
              : 'Claude Code';
          setError(
            `Failed to launch ${clientLabel}: `
            + formatInteractiveSessionLaunchError(error),
          );
        },
        onSessionCreated: async (session) => {
          addSession(session);
          await recordSessionLaunchTrace('store.add_session.ok', {
            trace_id: launchTraceId,
            session_id: session.id,
            terminal_type: session.terminalType,
            tmux_target: session.tmuxTarget,
          });

          if (workDir) {
            try {
              await invoke('add_recent', { path: workDir });
              await loadAppConfig();
            } catch (error) {
              console.error('Failed to refresh recent projects after session creation:', error);
            }
          }

          setError(null);
        },
        openTerminal: async (sessionId) => {
          await invoke('open_interactive_session_in_terminal', {
            sessionId,
            terminalType: null,
          });
        },
        syncSessions: syncInteractiveSessions,
        recordTrace: recordSessionLaunchTrace,
        onTerminalOpenError: (error) => {
          console.error('Interactive session created but failed to open terminal:', error);
        },
        onSessionSyncError: (error) => {
          console.error('Failed to sync sessions after terminal open attempt:', error);
        },
      });
    } finally {
      setLoading(false);
    }
  }, [
    addSession,
    getSessionDefaults,
    loadAppConfig,
    setLoading,
    setError,
    syncInteractiveSessions,
  ]);

  const launchClaudeCode = useCallback(async (
    workingDir?: string,
    resumeSessionId?: string,
    client: LaunchClient = 'claude',
    envName?: string,
    initialPrompt?: string,
  ): Promise<Session> => {
    return createInteractiveSession({
      envName: envName ?? undefined,
      workingDir: workingDir ?? null,
      resumeSessionId: resumeSessionId ?? null,
      client,
      initialPrompt: initialPrompt ?? null,
    });
  }, [createInteractiveSession]);

  const listInteractiveSessions = useCallback(async (): Promise<Session[]> => {
    return syncInteractiveSessions();
  }, [syncInteractiveSessions]);

  const listRuntimeRecoveryCandidates = useCallback(async (): Promise<RuntimeRecoveryCandidate[]> => {
    return invoke<RuntimeRecoveryCandidate[]>('list_runtime_recovery_candidates');
  }, []);

  const dismissRuntimeRecoveryCandidate = useCallback(async (runtimeId: string): Promise<void> => {
    await invoke('dismiss_runtime_recovery_candidate', { runtimeId });
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      await listInteractiveSessions();
    } catch (err) {
      console.error('Failed to load sessions:', err);
    }
  }, [listInteractiveSessions]);

  const stopInteractiveSession = useCallback(async (sessionId: string) => {
    try {
      await invoke('stop_interactive_session', { sessionId });
      updateSessionStatus(sessionId, 'stopped');
    } catch (err) {
      setError(`Failed to stop session: ${err}`);
    }
  }, [updateSessionStatus, setError]);

  const stopSession = useCallback(async (sessionId: string) => {
    await stopInteractiveSession(sessionId);
  }, [stopInteractiveSession]);

  const writeInteractiveInput = useCallback(async (sessionId: string, data: string): Promise<void> => {
    await invoke('write_interactive_input', { sessionId, data });
  }, []);

  const getInteractiveSessionOutput = useCallback(async (
    sessionId: string,
    sinceSeq?: number | null,
  ): Promise<InteractiveReplayBatch> => {
    return invoke<InteractiveReplayBatch>('get_interactive_session_output', {
      sessionId,
      sinceSeq: sinceSeq ?? null,
    });
  }, []);

  const getInteractiveSessionEvents = useCallback(async (
    sessionId: string,
    sinceSeq?: number | null,
  ): Promise<ReplayBatch> => {
    return invoke<ReplayBatch>('get_interactive_session_events', {
      sessionId,
      sinceSeq: sinceSeq ?? null,
    });
  }, []);

  const listUnifiedSessions = useCallback(async (): Promise<UnifiedSessionInfo[]> => {
    return invoke<UnifiedSessionInfo[]>('list_unified_sessions');
  }, []);

  const getSessionEvents = useCallback(async (
    runtimeId: string,
    sinceSeq?: number | null,
  ): Promise<ReplayBatch> => {
    return invoke<ReplayBatch>('get_session_events', {
      runtimeId,
      sinceSeq: sinceSeq ?? null,
    });
  }, []);

  const sendSessionInput = useCallback(async (
    runtimeId: string,
    input: RuntimeInput,
  ): Promise<void> => {
    await invoke('send_session_input', { runtimeId, input });
  }, []);

  const stopUnifiedSession = useCallback(async (runtimeId: string): Promise<void> => {
    await invoke('stop_unified_session', { runtimeId });
  }, []);

  const closeUnifiedInteractiveSession = useCallback(async (runtimeId: string): Promise<void> => {
    await invoke('close_unified_interactive_session', { runtimeId });
    await syncInteractiveSessions();
  }, [syncInteractiveSessions]);

  const attachChannel = useCallback(async (
    runtimeId: string,
    channel: ChannelKind,
  ): Promise<void> => {
    await invoke('attach_channel', { runtimeId, channel });
  }, []);

  const detachChannel = useCallback(async (
    runtimeId: string,
    channel: ChannelKind,
  ): Promise<void> => {
    await invoke('detach_channel', { runtimeId, channel });
  }, []);

  const bindSessionToBot = useCallback(async (
    request: BindSessionToBotRequest,
  ): Promise<BotBindingInfo> => {
    return invoke<BotBindingInfo>('bind_session_to_bot', { request });
  }, []);

  const listSessionBotBindings = useCallback(async (
    runtimeId?: string | null,
  ): Promise<BotBindingInfo[]> => {
    return invoke<BotBindingInfo[]>('list_session_bot_bindings', {
      runtimeId: runtimeId ?? null,
    });
  }, []);

  const getSessionBotBindingOutbox = useCallback(async (
    bindingId?: string | null,
  ): Promise<BotBindingOutboxFrame[]> => {
    return invoke<BotBindingOutboxFrame[]>('get_session_bot_binding_outbox', {
      bindingId: bindingId ?? null,
    });
  }, []);

  const sendBotBoundSessionInput = useCallback(async (
    request: BotBindingInboundRequest,
  ): Promise<void> => {
    await invoke('send_bot_bound_session_input', { request });
  }, []);

  const processBotBindingRequests = useCallback(async (): Promise<BotBindingInfo[]> => {
    return invoke<BotBindingInfo[]>('process_bot_binding_requests');
  }, []);

  const debugCompareSessions = useCallback(async (): Promise<UnifiedSessionDebugComparison> => {
    return invoke<UnifiedSessionDebugComparison>('debug_compare_sessions');
  }, []);

  const resizeInteractiveSession = useCallback(async (
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<void> => {
    await invoke('resize_interactive_session', { sessionId, cols, rows });
  }, []);

  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      await invoke('remove_session', { sessionId });
      removeSession(sessionId);
    } catch (err) {
      setError(`Failed to remove session: ${err}`);
    }
  }, [removeSession, setError]);

  const focusSession = useCallback(async (sessionId: string) => {
    try {
      await invoke('focus_interactive_session', { sessionId });
      toast.success('Session focused successfully');
    } catch (err) {
      toast.error(`Failed to focus session: ${err}`);
    }
  }, []);

  const listTmuxAttachTerminals = useCallback(async (): Promise<TmuxAttachTerminalInfo[]> => {
    return invoke<TmuxAttachTerminalInfo[]>('list_tmux_attach_terminals');
  }, []);

  const openInteractiveSessionInTerminal = useCallback(async (
    sessionId: string,
    terminalType?: TmuxAttachTerminalType,
    options: { notifyOnError?: boolean } = {},
  ) => {
    try {
      await openExistingInteractiveSessionTerminal({
        openTerminal: () => invoke('open_interactive_session_in_terminal', {
          sessionId,
          terminalType: terminalType ?? null,
        }),
        syncSessions: syncInteractiveSessions,
        onSessionSyncError: (syncError) => {
          console.error('Failed to sync sessions after terminal open attempt:', syncError);
        },
      });
    } catch (err) {
      if (options.notifyOnError !== false) {
        toast.error(`Failed to open session in terminal: ${err}`);
      }
      throw err;
    }
  }, [syncInteractiveSessions]);

  const closeSession = useCallback(async (sessionId: string) => {
    try {
      await invoke('close_interactive_session', { sessionId });
      removeSession(sessionId);
      toast.success('Session closed successfully');
    } catch (err) {
      toast.error(`Failed to close session: ${err}`);
    }
  }, [removeSession]);

  const createHeadlessSession = useCallback(async (
    options: {
      envName?: string;
      permMode?: string;
      workingDir?: string | null;
      resumeSessionId?: string | null;
      initialPrompt?: string | null;
    } = {},
  ): Promise<HeadlessSessionSummary> => {
    const { currentEnv, permissionMode, selectedWorkingDir } = getSessionDefaults();
    return invoke<HeadlessSessionSummary>('create_headless_session', {
      envName: options.envName ?? currentEnv,
      permMode: options.permMode ?? permissionMode,
      workingDir: options.workingDir ?? selectedWorkingDir ?? null,
      resumeSessionId: options.resumeSessionId ?? null,
      initialPrompt: options.initialPrompt ?? null,
    });
  }, [getSessionDefaults]);

  const createManagedSession = useCallback(async (
    options: {
      envName?: string;
      permMode?: string;
      workingDir?: string | null;
      resumeSessionId?: string | null;
      initialPrompt?: string | null;
    } = {},
  ): Promise<ManagedSessionSummary> => {
    return createHeadlessSession(options);
  }, [createHeadlessSession]);

  const listHeadlessSessions = useCallback(async (): Promise<HeadlessSessionSummary[]> => {
    return invoke<HeadlessSessionSummary[]>('list_headless_sessions');
  }, []);

  const listManagedSessions = useCallback(async (): Promise<ManagedSessionSummary[]> => {
    return listHeadlessSessions();
  }, [listHeadlessSessions]);

  const sendToHeadlessSession = useCallback(async (runtimeId: string, text: string): Promise<void> => {
    await invoke('send_to_headless_session', { runtimeId, text });
  }, []);

  const sendToManagedSession = useCallback(async (runtimeId: string, text: string): Promise<void> => {
    await sendToHeadlessSession(runtimeId, text);
  }, [sendToHeadlessSession]);

  const getHeadlessSessionEvents = useCallback(async (
    runtimeId: string,
    sinceSeq?: number | null,
  ): Promise<ReplayBatch> => {
    return invoke<ReplayBatch>('get_headless_session_events', {
      runtimeId,
      sinceSeq: sinceSeq ?? null,
    });
  }, []);

  const getManagedSessionEvents = useCallback(async (
    runtimeId: string,
    sinceSeq?: number | null,
  ): Promise<ReplayBatch> => {
    return getHeadlessSessionEvents(runtimeId, sinceSeq);
  }, [getHeadlessSessionEvents]);

  const stopHeadlessSession = useCallback(async (runtimeId: string): Promise<void> => {
    await invoke('stop_headless_session', { runtimeId });
  }, []);

  const stopManagedSession = useCallback(async (runtimeId: string): Promise<void> => {
    await stopHeadlessSession(runtimeId);
  }, [stopHeadlessSession]);

  const respondHeadlessPermission = useCallback(async (
    requestId: string,
    approved: boolean,
    responder = 'desktop',
  ): Promise<void> => {
    await invoke('respond_headless_permission', {
      requestId,
      approved,
      responder,
    });
  }, []);

  const removeHeadlessSession = useCallback(async (runtimeId: string): Promise<void> => {
    await invoke('remove_headless_session', { runtimeId });
  }, []);

  const removeManagedSession = useCallback(async (runtimeId: string): Promise<void> => {
    await removeHeadlessSession(runtimeId);
  }, [removeHeadlessSession]);

  const createNativeSession = useCallback(async (options: {
    provider: 'claude' | 'codex';
    envName?: string;
    permMode?: string;
    runtimePermMode?: string | null;
    workingDir?: string | null;
    initialPrompt: string;
    initialDisplayPrompt?: string | null;
    initialImages?: NativePromptImageInput[];
    initialAnnotations?: SessionPromptAnnotation[];
    providerSessionId?: string | null;
    effort?: string | null;
    seedBoundaryMessageCount?: number | null;
  }): Promise<NativeSessionSummary> => {
    const { currentEnv, permissionMode, selectedWorkingDir } = getSessionDefaults();
    return invoke<NativeSessionSummary>('create_native_session', {
      provider: options.provider,
      envName: options.envName ?? currentEnv,
      permMode: options.permMode ?? permissionMode,
      runtimePermMode: options.runtimePermMode ?? null,
      workingDir: options.workingDir ?? selectedWorkingDir ?? null,
      initialPrompt: options.initialPrompt,
      initialDisplayPrompt: options.initialDisplayPrompt ?? null,
      initialImages: options.initialImages?.length ? options.initialImages : null,
      initialAnnotations: options.initialAnnotations?.length ? options.initialAnnotations : null,
      providerSessionId: options.providerSessionId ?? null,
      effort: options.effort ?? null,
      seedBoundaryMessageCount: options.seedBoundaryMessageCount ?? null,
    });
  }, [getSessionDefaults]);

  const listNativeSessions = useCallback(async (): Promise<NativeSessionSummary[]> => {
    return invoke<NativeSessionSummary[]>('list_native_sessions');
  }, []);

  const sendNativeSessionInput = useCallback(async (
    runtimeId: string,
    text: string,
    images?: NativePromptImageInput[],
    displayText?: string | null,
    annotations?: SessionPromptAnnotation[],
  ): Promise<void> => {
    await invoke('send_native_session_input', {
      runtimeId,
      text,
      displayText: displayText ?? null,
      images: images?.length ? images : null,
      annotations: annotations?.length ? annotations : null,
    });
  }, []);

  const respondNativeSessionPermission = useCallback(async (
    runtimeId: string,
    requestId: string,
    approved: boolean,
  ): Promise<void> => {
    await invoke('respond_native_session_permission', {
      runtimeId,
      requestId,
      approved,
    });
  }, []);

  const respondNativeSessionPrompt = useCallback(async (
    runtimeId: string,
    payload: {
      toolUseId: string;
      promptType: 'ask_user_question' | 'plan_exit';
      displayText?: string | null;
      answers: Record<string, string>;
      annotations?: Record<string, InteractivePromptAnnotation>;
      promptAnnotations?: SessionPromptAnnotation[];
    },
  ): Promise<void> => {
    await invoke('respond_native_session_prompt', {
      runtimeId,
      toolUseId: payload.toolUseId,
      promptType: payload.promptType,
      displayText: payload.displayText ?? null,
      answers: payload.answers,
      annotations: payload.annotations ?? null,
      promptAnnotations: payload.promptAnnotations?.length
        ? payload.promptAnnotations
        : null,
    });
  }, []);

  const rewindNativeSessionFiles = useCallback(async (
    runtimeId: string,
    checkpointId: string,
  ): Promise<void> => {
    await invoke('rewind_native_session_files', {
      runtimeId,
      checkpointId,
    });
  }, []);

  const getNativeSessionEvents = useCallback(async (
    runtimeId: string,
    sinceSeq?: number | null,
    limit?: number | null,
  ): Promise<ReplayBatch> => {
    return invoke<ReplayBatch>('get_native_session_events', {
      runtimeId,
      sinceSeq: sinceSeq ?? null,
      limit: limit ?? null,
    });
  }, []);

  const stopNativeSession = useCallback(async (
    runtimeId: string,
    source?: string | null,
  ): Promise<void> => {
    await invoke('stop_native_session', {
      runtimeId,
      source: source ?? null,
    });
  }, []);

  const updateNativeSessionSettings = useCallback(async (
    runtimeId: string,
    envName?: string | null,
    permMode?: string | null,
    effort?: string | null,
  ): Promise<void> => {
    await invoke('update_native_session_settings', {
      runtimeId,
      envName: envName ?? null,
      permMode: permMode ?? null,
      effort: effort ?? null,
    });
  }, []);

  const setNativeSessionRuntimePermMode = useCallback(async (
    runtimeId: string,
    runtimePermMode?: string | null,
  ): Promise<void> => {
    await invoke('set_native_session_runtime_perm_mode', {
      runtimeId,
      runtimePermMode: runtimePermMode ?? null,
    });
  }, []);

  const handoffNativeSessionToTerminal = useCallback(async (
    runtimeId: string,
    terminalType?: NativeTerminalType,
  ): Promise<NativeHandoffResult> => {
    return await invoke<NativeHandoffResult>('handoff_native_session_to_terminal', {
      runtimeId,
      terminalType: terminalType ?? null,
    });
  }, []);

  const getWorkspaceGitSnapshot = useCallback(async (
    workingDir: string,
  ): Promise<WorkspaceGitSnapshot> => {
    return invoke<WorkspaceGitSnapshot>('get_workspace_git_snapshot', { workingDir });
  }, []);

  const getWorkspaceFileDiff = useCallback(async (
    workingDir: string,
    filePath: string,
  ): Promise<WorkspaceFileDiff> => {
    return invoke<WorkspaceFileDiff>('get_workspace_file_diff', { workingDir, filePath });
  }, []);

  const getWorkspaceMediaPreview = useCallback(async (
    workingDir: string,
    filePath: string,
  ): Promise<WorkspaceMediaPreview> => {
    return invoke<WorkspaceMediaPreview>('get_workspace_media_preview', { workingDir, filePath });
  }, []);

  const getSessionSubagents = useCallback(async (
    sessionId: string,
    source: string,
    detailAgentId?: string | null,
  ): Promise<SessionSubagentsPayload> => {
    return invoke<SessionSubagentsPayload>('get_session_subagents', {
      sessionId,
      source,
      detailAgentId: detailAgentId ?? null,
    });
  }, []);

  const launchOpenCodeWeb = useCallback(async (
    workingDir?: string | null,
    envName?: string | null,
  ): Promise<void> => {
    await invoke('launch_opencode_web', {
      workingDir: workingDir ?? null,
      envName: envName ?? null,
    });
  }, []);

  const minimizeSession = useCallback(async (sessionId: string) => {
    try {
      await invoke('minimize_interactive_session', { sessionId });
      toast.success('Session minimized successfully');
    } catch (err) {
      toast.error(`Failed to minimize session: ${err}`);
    }
  }, []);

  const addFavoriteProject = useCallback(async (path: string, name: string) => {
    try {
      await invoke('add_favorite', { path, name });
      await loadAppConfig();
    } catch (err) {
      setError(`Failed to add favorite: ${err}`);
    }
  }, [loadAppConfig, setError]);

  const removeFavoriteProject = useCallback(async (path: string) => {
    try {
      await invoke('remove_favorite', { path });
      await loadAppConfig();
    } catch (err) {
      setError(`Failed to remove favorite: ${err}`);
    }
  }, [loadAppConfig, setError]);

  const openDirectoryPicker = useCallback(async (): Promise<string | null> => {
    try {
      const path = await invoke<string | null>('open_directory_dialog');
      return path;
    } catch (err) {
      setError(`Failed to open directory picker: ${err}`);
      return null;
    }
  }, [setError]);

  const searchWorkspaceFiles = useCallback(async (
    workingDir: string,
    query?: string,
    limit = 12,
  ): Promise<WorkspaceFileSuggestion[]> => {
    return invoke<WorkspaceFileSuggestion[]>('search_workspace_files', {
      workingDir,
      query: query ?? null,
      limit,
    });
  }, []);

  const syncVSCodeProjects = useCallback(async () => {
    try {
      await invoke('sync_vscode_projects');
      await loadAppConfig();
    } catch (err) {
      setError(`Failed to sync VS Code projects: ${err}`);
    }
  }, [loadAppConfig, setError]);

  const syncJetBrainsProjects = useCallback(async () => {
    try {
      await invoke('sync_jetbrains_projects');
      await loadAppConfig();
    } catch (err) {
      setError(`Failed to sync JetBrains projects: ${err}`);
    }
  }, [loadAppConfig, setError]);

  const loadFromRemote = useCallback(async (url: string, key: string, secret: string) => {
    const result = await invoke<{
      count: number;
      environments: Array<{ name: string; original_name: string; renamed: boolean }>;
    }>('load_from_remote', { url, key, secret });
    await loadEnvironments();
    return result;
  }, [loadEnvironments]);

  const arrangeSessions = useCallback(async (sessionIds: string[], layout: ArrangeLayout) => {
    try {
      const result = await invoke<string>('arrange_sessions', {
        request: { session_ids: sessionIds, layout },
      });
      await loadSessions();
      return result;
    } catch (err) {
      throw err;
    }
  }, [loadSessions]);

  const checkArrangeSupport = useCallback(async (): Promise<boolean> => {
    try {
      return await invoke<boolean>('check_arrange_support');
    } catch {
      return false;
    }
  }, []);

  const checkCodexInstalled = useCallback(async (): Promise<boolean> => {
    try {
      return await invoke<boolean>('check_codex_installed');
    } catch {
      return false;
    }
  }, []);

  const checkOpenCodeInstalled = useCallback(async (): Promise<boolean> => {
    try {
      return await invoke<boolean>('check_opencode_installed');
    } catch {
      return false;
    }
  }, []);

  const checkTmuxInstalled = useCallback(async (): Promise<boolean> => {
    try {
      return await invoke<boolean>('check_tmux_installed');
    } catch {
      return false;
    }
  }, []);

  const getPlatformCapabilities = useCallback(async (): Promise<PlatformCapabilities> => {
    return invoke<PlatformCapabilities>('get_platform_capabilities');
  }, []);

  const loadInstalledSkills = useCallback(async (): Promise<InstalledSkill[]> => {
    try {
      const skills = await invoke<InstalledSkill[]>('list_installed_skills');
      setInstalledSkills(skills);
      return skills;
    } catch (err) {
      console.error('Failed to load installed skills:', err);
      return [];
    }
  }, [setInstalledSkills]);

  const loadWorkspaceSkills = useCallback(async (options: {
    workingDir?: string | null;
    provider?: string | null;
  } = {}): Promise<InstalledSkill[]> => {
    try {
      return await invoke<InstalledSkill[]>('list_workspace_skills', {
        workingDir: options.workingDir ?? null,
        provider: options.provider ?? null,
      });
    } catch (err) {
      console.error('Failed to load workspace skills:', err);
      return [];
    }
  }, []);

  const loadWorkspaceCommands = useCallback(async (options: {
    workingDir?: string | null;
    provider?: string | null;
  } = {}): Promise<WorkspaceCommand[]> => {
    try {
      return await invoke<WorkspaceCommand[]>('list_workspace_commands', {
        workingDir: options.workingDir ?? null,
        provider: options.provider ?? null,
      });
    } catch (err) {
      console.error('Failed to load workspace commands:', err);
      return [];
    }
  }, []);

  // Cron commands
  const loadCronTasks = useCallback(async () => {
    setLoadingCron(true);
    try {
      const tasks = await invoke<CronTask[]>('list_cron_tasks');
      setCronTasks(tasks);
    } finally {
      setLoadingCron(false);
    }
  }, [setCronTasks, setLoadingCron]);

  const addCronTask = useCallback(async (data: {
    name: string;
    cronExpression: string;
    prompt: string;
    workingDir: string;
    envName?: string;
    executionProfile?: 'conservative' | 'standard' | 'autonomous';
    maxBudgetUsd?: number | null;
    allowedTools?: string[];
    disallowedTools?: string[];
    timeoutSecs?: number;
    templateId?: string;
    wecomNotification?: CronWecomNotification | null;
  }) => {
    const task = await invoke<CronTask>('add_cron_task', {
      name: data.name,
      cronExpression: data.cronExpression,
      prompt: data.prompt,
      workingDir: data.workingDir,
      envName: data.envName || null,
      executionProfile: data.executionProfile || 'conservative',
      maxBudgetUsd: data.maxBudgetUsd ?? null,
      allowedTools: data.allowedTools ?? [],
      disallowedTools: data.disallowedTools ?? [],
      timeoutSecs: data.timeoutSecs || 300,
      templateId: data.templateId || null,
      wecomNotification: data.wecomNotification ?? null,
    });
    const tasks = await invoke<CronTask[]>('list_cron_tasks');
    setCronTasks(tasks);
    return task;
  }, [setCronTasks]);

  const updateCronTask = useCallback(async (data: {
    id: string;
    name?: string;
    cronExpression?: string;
    prompt?: string;
    workingDir?: string;
    envName?: string;
    executionProfile?: 'conservative' | 'standard' | 'autonomous';
    maxBudgetUsd?: number | null;
    allowedTools?: string[];
    disallowedTools?: string[];
    timeoutSecs?: number;
    wecomNotification?: CronWecomNotification | null;
  }) => {
    const task = await invoke<CronTask>('update_cron_task', data);
    const tasks = await invoke<CronTask[]>('list_cron_tasks');
    setCronTasks(tasks);
    return task;
  }, [setCronTasks]);

  const deleteCronTask = useCallback(async (id: string) => {
    await invoke('delete_cron_task', { id });
    const tasks = await invoke<CronTask[]>('list_cron_tasks');
    setCronTasks(tasks);
  }, [setCronTasks]);

  const toggleCronTask = useCallback(async (id: string) => {
    await invoke('toggle_cron_task', { id });
    const tasks = await invoke<CronTask[]>('list_cron_tasks');
    setCronTasks(tasks);
  }, [setCronTasks]);

  const loadCronTaskRuns = useCallback(async (taskId: string) => {
    const runs = await invoke<CronTaskRun[]>('get_cron_task_runs', { taskId });
    setCronRuns(taskId, runs);
  }, [setCronRuns]);

  const getCronRunDetail = useCallback(async (taskId: string, runId: string) => {
    return invoke<CronTaskRun>('get_cron_run_detail', { taskId, runId });
  }, []);

  const retryCronTask = useCallback(async (id: string) => {
    await invoke('retry_cron_task', { id });
  }, []);

  const getCronNextRuns = useCallback(async (cronExpression: string, count?: number) => {
    return invoke<string[]>('get_cron_next_runs', { cronExpression, count: count || 5 });
  }, []);

  const listCronTemplates = useCallback(async () => {
    return invoke<CronTemplate[]>('list_cron_templates');
  }, []);

  const generateCronTaskStream = useCallback(async (query: string) => {
    await invoke('generate_cron_task_stream', { query });
  }, []);

  const saveDefaultWorkingDir = useCallback(async (path: string | null) => {
    try {
      await invoke('set_default_working_dir', { path });
      setDefaultWorkingDir(path);
    } catch (err) {
      console.error('Failed to save default working dir:', err);
    }
  }, [setDefaultWorkingDir]);

  const getProxyDebugState = useCallback(async (): Promise<ProxyDebugState> => {
    return invoke<ProxyDebugState>('get_proxy_debug_state');
  }, []);

  const getTelegramSettings = useCallback(async (): Promise<TelegramSettings> => {
    return invoke<TelegramSettings>('get_telegram_settings');
  }, []);

  const saveTelegramSettings = useCallback(async (settings: TelegramSettings): Promise<void> => {
    await invoke('save_telegram_settings', { settings });
  }, []);

  const getTelegramBridgeStatus = useCallback(async (): Promise<TelegramBridgeStatus> => {
    return invoke<TelegramBridgeStatus>('get_telegram_bridge_status');
  }, []);

  const startTelegramBridge = useCallback(async (): Promise<TelegramBridgeStatus> => {
    return invoke<TelegramBridgeStatus>('start_telegram_bridge');
  }, []);

  const stopTelegramBridge = useCallback(async (): Promise<TelegramBridgeStatus> => {
    return invoke<TelegramBridgeStatus>('stop_telegram_bridge');
  }, []);

  const getWecomSettings = useCallback(async (): Promise<WecomSettings> => {
    return invoke<WecomSettings>('get_wecom_settings');
  }, []);

  const getWecomTaskBindingDefaults = useCallback(async (): Promise<WecomTaskBindingDefault[]> => {
    return invoke<WecomTaskBindingDefault[]>('get_wecom_task_binding_defaults');
  }, []);

  const getWecomTaskBindingOptions = useCallback(async (): Promise<WecomTaskBindingOption[]> => {
    return invoke<WecomTaskBindingOption[]>('get_wecom_task_binding_options');
  }, []);

  const saveWecomSettings = useCallback(async (settings: WecomSettings): Promise<void> => {
    await invoke('save_wecom_settings', { settings });
  }, []);

  const getWecomBridgeStatus = useCallback(async (): Promise<WecomBridgeStatus> => {
    return invoke<WecomBridgeStatus>('get_wecom_bridge_status');
  }, []);

  const startWecomBridge = useCallback(async (): Promise<WecomBridgeStatus> => {
    return invoke<WecomBridgeStatus>('start_wecom_bridge');
  }, []);

  const stopWecomBridge = useCallback(async (): Promise<WecomBridgeStatus> => {
    return invoke<WecomBridgeStatus>('stop_wecom_bridge');
  }, []);

  const getTelegramForumTopics = useCallback(async (): Promise<TelegramForumTopic[]> => {
    return invoke<TelegramForumTopic[]>('get_telegram_forum_topics');
  }, []);

  const getWeixinSettings = useCallback(async (): Promise<WeixinSettings> => {
    return invoke<WeixinSettings>('get_weixin_settings');
  }, []);

  const saveWeixinSettings = useCallback(async (settings: WeixinSettings): Promise<void> => {
    await invoke('save_weixin_settings', { settings });
  }, []);

  const getWeixinBridgeStatus = useCallback(async (): Promise<WeixinBridgeStatus> => {
    return invoke<WeixinBridgeStatus>('get_weixin_bridge_status');
  }, []);

  const startWeixinBridge = useCallback(async (): Promise<WeixinBridgeStatus> => {
    return invoke<WeixinBridgeStatus>('start_weixin_bridge');
  }, []);

  const stopWeixinBridge = useCallback(async (): Promise<WeixinBridgeStatus> => {
    return invoke<WeixinBridgeStatus>('stop_weixin_bridge');
  }, []);

  const startWeixinLogin = useCallback(async (): Promise<WeixinLoginSession> => {
    return invoke<WeixinLoginSession>('start_weixin_login');
  }, []);

  const pollWeixinLogin = useCallback(async (sessionKey: string): Promise<WeixinLoginSession> => {
    return invoke<WeixinLoginSession>('poll_weixin_login', { sessionKey });
  }, []);

  const bindTelegramTopic = useCallback(async (options: {
    projectDir: string;
    envName?: string | null;
    permMode?: string | null;
    threadId?: number | null;
    createNewTopic: boolean;
  }): Promise<TelegramTopicBinding> => {
    return invoke<TelegramTopicBinding>('bind_telegram_topic', {
      projectDir: options.projectDir,
      envName: options.envName ?? null,
      permMode: options.permMode ?? null,
      threadId: options.threadId ?? null,
      createNewTopic: options.createNewTopic,
    });
  }, []);

  const setProxyDebugEnabled = useCallback(async (enabled: boolean): Promise<ProxyDebugState> => {
    return invoke<ProxyDebugState>('set_proxy_debug_enabled', { enabled });
  }, []);

  const updateProxyDebugConfig = useCallback(async (
    codexUpstreamBaseUrl: string,
    recordMode?: string,
  ): Promise<ProxyDebugState> => {
    return invoke<ProxyDebugState>('update_proxy_debug_config', {
      codexUpstreamBaseUrl,
      recordMode: recordMode ?? null,
    });
  }, []);

  const listProxyTraffic = useCallback(async (
    limit: number,
    cursor?: string | null,
  ): Promise<ProxyTrafficPage> => {
    return invoke<ProxyTrafficPage>('list_proxy_traffic', {
      limit,
      cursor: cursor ?? null,
    });
  }, []);

  const getProxyTrafficDetail = useCallback(async (id: string): Promise<ProxyTrafficDetail> => {
    return invoke<ProxyTrafficDetail>('get_proxy_traffic_detail', { id });
  }, []);

  const clearProxyTraffic = useCallback(async (): Promise<void> => {
    await invoke('clear_proxy_traffic');
  }, []);

  // ---- Router (CCEM Router) ----

  const loadRouterSettings = useCallback(async (): Promise<RouterConfig> => {
    const config = await invoke<RouterConfig>('get_router_settings');
    setRouterConfig(config);
    return config;
  }, [setRouterConfig]);

  const saveRouterSettings = useCallback(async (config: RouterConfig): Promise<RouterStatus> => {
    const status = await invoke<RouterStatus>('update_router_settings', { settings: config });
    // update_router_settings writes config.router verbatim after validation,
    // so the sent config is the stored config.
    setRouterConfig(config);
    setRouterStatus(status);
    return status;
  }, [setRouterConfig, setRouterStatus]);

  const loadRouterStatus = useCallback(async (): Promise<RouterStatus> => {
    const status = await invoke<RouterStatus>('router_status');
    setRouterStatus(status);
    return status;
  }, [setRouterStatus]);

  const getSessionRouter = useCallback(async (runtimeId: string): Promise<SessionRouterState> => {
    const router = await invoke<SessionRouterState>('get_session_router', { runtimeId });
    setSessionRouter(runtimeId, router);
    return router;
  }, [setSessionRouter]);

  /**
   * CAS update_session_router. Never throws: returns a discriminated result so
   * the caller can rebase on conflict (the store is already updated with
   * `conflict.current` when present) and decide whether to retry or inform.
   */
  const updateSessionRouter = useCallback(async (
    runtimeId: string,
    expectedRevision: number,
    patch: UpdateSessionRouterPatch,
  ): Promise<
    | { ok: true; router: SessionRouterState }
    | { ok: false; conflict: RouterServiceError }
  > => {
    try {
      const router = await invoke<SessionRouterState>('update_session_router', {
        request: { runtimeId, expectedRevision, patch },
      });
      setSessionRouter(runtimeId, router);
      return { ok: true, router };
    } catch (err) {
      const conflict = extractRouterServiceError(err);
      if (conflict.current) {
        setSessionRouter(runtimeId, conflict.current);
      }
      return { ok: false, conflict };
    }
  }, [setSessionRouter]);

  const restartNativeSessionDirect = useCallback(async (
    runtimeId: string,
  ): Promise<SessionRouterState> => {
    const router = await invoke<SessionRouterState>('restart_native_session_direct', { runtimeId });
    setSessionRouter(runtimeId, router);
    return router;
  }, [setSessionRouter]);

  const generateWorkspaceSessionTitle = useCallback(async (titleInput: string): Promise<string | null> => {
    return invoke<string | null>('generate_workspace_session_title', { titleInput });
  }, []);

  const openTextInVSCode = useCallback(async (
    content: string,
    suggestedName?: string,
  ): Promise<string> => {
    return invoke<string>('open_text_in_vscode', {
      content,
      suggestedName: suggestedName ?? null,
    });
  }, []);

  const setSessionTitle = useCallback(async (source: string, sessionId: string, title: string): Promise<void> => {
    await invoke('set_session_title', { source, sessionId, title });
  }, []);

  const setSessionAnnotation = useCallback(async (
    source: string,
    sessionId: string,
    annotation: {
      stage?: SessionTaskStage;
      sticker?: SessionStickerId;
      label?: string;
    }
  ): Promise<void> => {
    await invoke('set_session_annotation', {
      source,
      sessionId,
      stage: annotation.stage ?? null,
      sticker: annotation.sticker ?? null,
      label: annotation.label ?? null,
    });
  }, []);

  return {
    loadEnvironments,
    loadCurrentEnv,
    switchEnvironment,
    addEnvironment,
    updateEnvironment,
    deleteEnvironment,
    getEnvironmentRouterReferences,
    loadEnabledEnvironments,
    saveEnabledEnvironments,
    launchClaudeCode,
    createInteractiveSession,
    loadSessions,
    listInteractiveSessions,
    listRuntimeRecoveryCandidates,
    dismissRuntimeRecoveryCandidate,
    stopSession,
    stopInteractiveSession,
    writeInteractiveInput,
    getInteractiveSessionOutput,
    getInteractiveSessionEvents,
    listUnifiedSessions,
    getSessionEvents,
    sendSessionInput,
    stopUnifiedSession,
    closeUnifiedInteractiveSession,
    attachChannel,
    detachChannel,
    bindSessionToBot,
    listSessionBotBindings,
    getSessionBotBindingOutbox,
    sendBotBoundSessionInput,
    processBotBindingRequests,
    debugCompareSessions,
    resizeInteractiveSession,
    deleteSession,
    focusSession,
    listTmuxAttachTerminals,
    openInteractiveSessionInTerminal,
    closeSession,
    minimizeSession,
    createHeadlessSession,
    createManagedSession,
    listHeadlessSessions,
    listManagedSessions,
    sendToHeadlessSession,
    sendToManagedSession,
    getHeadlessSessionEvents,
    getManagedSessionEvents,
    stopHeadlessSession,
    stopManagedSession,
    respondHeadlessPermission,
    removeHeadlessSession,
    removeManagedSession,
    createNativeSession,
    listNativeSessions,
    sendNativeSessionInput,
    respondNativeSessionPermission,
    respondNativeSessionPrompt,
    rewindNativeSessionFiles,
    getNativeSessionEvents,
    stopNativeSession,
    updateNativeSessionSettings,
    setNativeSessionRuntimePermMode,
    handoffNativeSessionToTerminal,
    getWorkspaceGitSnapshot,
    getWorkspaceFileDiff,
    getWorkspaceMediaPreview,
    getSessionSubagents,
    launchOpenCodeWeb,
    loadAppConfig,
    addFavoriteProject,
    removeFavoriteProject,
    openDirectoryPicker,
    searchWorkspaceFiles,
    syncVSCodeProjects,
    syncJetBrainsProjects,
    loadFromRemote,
    arrangeSessions,
    checkArrangeSupport,
    checkCodexInstalled,
    checkOpenCodeInstalled,
    checkTmuxInstalled,
    getPlatformCapabilities,
    loadInstalledSkills,
    loadWorkspaceSkills,
    loadWorkspaceCommands,
    loadCronTasks,
    addCronTask,
    updateCronTask,
    deleteCronTask,
    toggleCronTask,
    loadCronTaskRuns,
    getCronRunDetail,
    retryCronTask,
    getCronNextRuns,
    listCronTemplates,
    generateCronTaskStream,
    saveDefaultWorkingDir,
    getTelegramSettings,
    saveTelegramSettings,
    getTelegramBridgeStatus,
    startTelegramBridge,
    stopTelegramBridge,
    getTelegramForumTopics,
    bindTelegramTopic,
    getWecomSettings,
    getWecomTaskBindingDefaults,
    getWecomTaskBindingOptions,
    saveWecomSettings,
    getWecomBridgeStatus,
    startWecomBridge,
    stopWecomBridge,
    getWeixinSettings,
    saveWeixinSettings,
    getWeixinBridgeStatus,
    startWeixinBridge,
    stopWeixinBridge,
    startWeixinLogin,
    pollWeixinLogin,
    getProxyDebugState,
    setProxyDebugEnabled,
    updateProxyDebugConfig,
    listProxyTraffic,
    getProxyTrafficDetail,
    clearProxyTraffic,
    loadRouterSettings,
    saveRouterSettings,
    loadRouterStatus,
    getSessionRouter,
    updateSessionRouter,
    restartNativeSessionDirect,
    generateWorkspaceSessionTitle,
    openTextInVSCode,
    setSessionTitle,
    setSessionAnnotation,
  };
}
