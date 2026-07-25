/**
 * Tauri IPC 类型映射
 *
 * 这个文件定义了前端与 Rust 后端之间的 IPC 契约。
 * 每个命令都有明确的输入和输出类型。
 *
 * 格式：[输入类型, 输出类型]
 */

import type { Environment, Session } from '@/store';

// ============================================
// Environment Commands
// ============================================

export interface TauriCommands {
  // 环境管理
  get_environments: [void, Record<string, Environment>];
  get_current_env: [void, string | null];
  set_current_env: [{ name: string }, void];
  add_environment: [
    {
      name: string;
      baseUrl: string;
      authToken?: string;
      defaultOpusModel: string;
      defaultSonnetModel?: string;
      defaultHaikuModel?: string;
      runtimeModel?: string;
      subagentModel?: string;
    },
    void
  ];
  update_environment: [
    {
      oldName: string;
      name: string;
      baseUrl: string;
      authToken?: string;
      defaultOpusModel: string;
      defaultSonnetModel?: string;
      defaultHaikuModel?: string;
      runtimeModel?: string;
      subagentModel?: string;
    },
    void
  ];
  delete_environment: [{ name: string }, void];

  // 应用配置
  get_app_config: [void, AppConfig];
  get_app_version: [void, string];
  check_app_update: [void, AppUpdateMetadata | null];
  install_app_update: [void, void];
  restart_app: [void, void];
  add_favorite: [{ path: string; name: string }, void];
  remove_favorite: [{ path: string }, void];
  add_recent: [{ path: string }, void];
  save_settings: [{ settings: DesktopSettings }, void];
  get_pet_notification_read_state: [void, PetNotificationReadState];
  mark_pet_notification_read: [{ notificationId: string }, PetNotificationReadState];
  open_pet_notification: [{ request: PetOpenSessionRequest }, void];
  open_tray_cockpit: [{ x?: number | null; y?: number | null }, void];
  get_telegram_settings: [void, TelegramSettings];
  save_telegram_settings: [{ settings: TelegramSettings }, void];
  get_telegram_bridge_status: [void, TelegramBridgeStatus];
  start_telegram_bridge: [void, TelegramBridgeStatus];
  stop_telegram_bridge: [void, TelegramBridgeStatus];
  get_wecom_settings: [void, WecomSettings];
  get_wecom_task_binding_defaults: [void, WecomTaskBindingDefault[]];
  get_wecom_task_binding_options: [void, WecomTaskBindingOption[]];
  save_wecom_settings: [{ settings: WecomSettings }, void];
  get_wecom_bridge_status: [void, WecomBridgeStatus];
  start_wecom_bridge: [void, WecomBridgeStatus];
  stop_wecom_bridge: [void, WecomBridgeStatus];
  get_weixin_settings: [void, WeixinSettings];
  save_weixin_settings: [{ settings: WeixinSettings }, void];
  get_weixin_bridge_status: [void, WeixinBridgeStatus];
  start_weixin_bridge: [void, WeixinBridgeStatus];
  stop_weixin_bridge: [void, WeixinBridgeStatus];
  start_weixin_login: [void, WeixinLoginSession];
  poll_weixin_login: [{ sessionKey: string }, WeixinLoginSession];
  get_telegram_forum_topics: [void, TelegramForumTopic[]];
  bind_telegram_topic: [
    {
      projectDir: string;
      envName?: string | null;
      permMode?: string | null;
      threadId?: number | null;
      createNewTopic: boolean;
    },
    TelegramTopicBinding
  ];
  get_proxy_debug_state: [void, ProxyDebugState];
  set_proxy_debug_enabled: [{ enabled: boolean }, ProxyDebugState];
  update_proxy_debug_config: [
    { codexUpstreamBaseUrl: string; recordMode?: string | null },
    ProxyDebugState
  ];
  list_proxy_traffic: [{ limit: number; cursor?: string | null }, ProxyTrafficPage];
  get_proxy_traffic_detail: [{ id: string }, ProxyTrafficDetail];
  clear_proxy_traffic: [void, void];
  generate_workspace_session_title: [{ titleInput: string }, string | null];
  open_text_in_vscode: [{ content: string; suggestedName?: string | null }, string];
  browser_set_active_session: [{ sessionId?: string | null; visible?: boolean | null }, void];
  browser_open: [{ sessionId?: string | null; url?: string | null }, BrowserInfo];
  browser_set_bounds: [
    { sessionId?: string | null; x: number; y: number; width: number; height: number },
    void
  ];
  browser_set_visible: [{ sessionId?: string | null; visible: boolean }, void];
  browser_close: [{ sessionId?: string | null } | void, void];
  browser_navigate: [{ sessionId?: string | null; url: string }, BrowserInfo];
  browser_reload: [{ sessionId?: string | null } | void, BrowserInfo];
  browser_back: [{ sessionId?: string | null } | void, BrowserInfo];
  browser_forward: [{ sessionId?: string | null } | void, BrowserInfo];
  browser_info: [{ sessionId?: string | null } | void, BrowserInfo];
  browser_health_check: [{ sessionId?: string | null } | void, BrowserInfo];
  browser_set_paused: [{ sessionId?: string | null; paused: boolean }, BrowserInfo];
  browser_recent_activity: [{ sessionId?: string | null } | void, BrowserRecentActivity];
  browser_runtime_readiness: [void, BrowserRuntimeReadiness];
  browser_snapshot: [{ sessionId?: string | null } | void, BrowserSnapshot];
  browser_screenshot: [{ sessionId?: string | null } | void, string];
  search_workspace_files: [
    {
      workingDir: string;
      query?: string | null;
      limit?: number | null;
    },
    WorkspaceFileSuggestion[]
  ];
  get_workspace_git_snapshot: [{ workingDir: string }, WorkspaceGitSnapshot];
  get_workspace_file_diff: [{ workingDir: string; filePath: string }, WorkspaceFileDiff];
  get_workspace_media_preview: [
    { workingDir: string; filePath: string },
    WorkspaceMediaPreview,
  ];
  window_control: [
    {
      action: 'close' | 'minimize' | 'toggle-fullscreen' | 'exit-fullscreen';
    },
    void
  ];

  // 会话管理
  launch_claude_code: [
    {
      envName: string;
      permMode?: string;
      workingDir?: string;
      resumeSessionId?: string;
      client?: 'claude' | 'codex' | 'opencode' | null;
    },
    Session
  ];
  create_interactive_session: [
    {
      envName: string;
      permMode?: string | null;
      workingDir?: string | null;
      resumeSessionId?: string | null;
      client?: 'claude' | 'codex' | 'opencode' | null;
      launchTraceId?: string | null;
    },
    Session
  ];
  record_session_launch_trace: [
    {
      event: string;
      details?: Record<string, unknown> | null;
    },
    void
  ];
  get_session_launch_log_path: [void, string];
  list_interactive_sessions: [void, Session[]];
  list_runtime_recovery_candidates: [void, RuntimeRecoveryCandidate[]];
  dismiss_runtime_recovery_candidate: [{ runtimeId: string }, void];
  stop_interactive_session: [{ sessionId: string }, void];
  focus_interactive_session: [{ sessionId: string }, void];
  open_interactive_session_in_terminal: [
    { sessionId: string; terminalType?: TmuxAttachTerminalType | null },
    void
  ];
  close_interactive_session: [{ sessionId: string }, void];
  minimize_interactive_session: [{ sessionId: string }, void];
  write_interactive_input: [{ sessionId: string; data: string }, void];
  get_interactive_session_output: [
    { sessionId: string; sinceSeq?: number | null },
    InteractiveReplayBatch
  ];
  get_interactive_session_events: [
    { sessionId: string; sinceSeq?: number | null },
    ReplayBatch
  ];
  list_unified_sessions: [void, UnifiedSessionInfo[]];
  get_session_events: [
    { runtimeId: string; sinceSeq?: number | null },
    ReplayBatch
  ];
  send_session_input: [
    { runtimeId: string; input: RuntimeInput },
    void
  ];
  stop_unified_session: [{ runtimeId: string }, void];
  attach_channel: [{ runtimeId: string; channel: ChannelKind }, void];
  detach_channel: [{ runtimeId: string; channel: ChannelKind }, void];
  bind_session_to_bot: [{ request: BindSessionToBotRequest }, BotBindingInfo];
  list_session_bot_bindings: [{ runtimeId?: string | null }, BotBindingInfo[]];
  get_session_bot_binding_outbox: [{ bindingId?: string | null }, BotBindingOutboxFrame[]];
  send_bot_bound_session_input: [{ request: BotBindingInboundRequest }, void];
  process_bot_binding_requests: [void, BotBindingInfo[]];
  debug_compare_sessions: [void, UnifiedSessionDebugComparison];
  resize_interactive_session: [{ sessionId: string; cols: number; rows: number }, void];
  create_managed_session: [
    {
      envName: string;
      permMode?: string | null;
      workingDir?: string | null;
      resumeSessionId?: string | null;
      initialPrompt?: string | null;
    },
    ManagedSessionSummary
  ];
  create_headless_session: [
    {
      envName: string;
      permMode?: string | null;
      workingDir?: string | null;
      resumeSessionId?: string | null;
      initialPrompt?: string | null;
    },
    HeadlessSessionSummary
  ];
  list_managed_sessions: [void, ManagedSessionSummary[]];
  list_headless_sessions: [void, HeadlessSessionSummary[]];
  send_to_managed_session: [
    {
      runtimeId: string;
      text: string;
    },
    void
  ];
  send_to_headless_session: [
    {
      runtimeId: string;
      text: string;
    },
    void
  ];
  get_managed_session_events: [
    {
      runtimeId: string;
      sinceSeq?: number | null;
    },
    ReplayBatch
  ];
  get_headless_session_events: [
    {
      runtimeId: string;
      sinceSeq?: number | null;
    },
    ReplayBatch
  ];
  stop_managed_session: [
    {
      runtimeId: string;
    },
    void
  ];
  remove_managed_session: [
    {
      runtimeId: string;
    },
    void
  ];
  stop_headless_session: [
    {
      runtimeId: string;
    },
    void
  ];
  respond_headless_permission: [
    {
      requestId: string;
      approved: boolean;
      responder?: string | null;
    },
    void
  ];
  remove_headless_session: [
    {
      runtimeId: string;
    },
    void
  ];
  create_native_session: [
    {
      provider: 'claude' | 'codex';
      envName: string;
      permMode?: string | null;
      runtimePermMode?: string | null;
      workingDir?: string | null;
      initialPrompt: string;
      initialDisplayPrompt?: string | null;
      initialImages?: NativePromptImageInput[] | null;
      providerSessionId?: string | null;
      effort?: string | null;
      seedBoundaryMessageCount?: number | null;
    },
    NativeSessionSummary
  ];
  list_native_sessions: [void, NativeSessionSummary[]];
  send_native_session_input: [
    {
      runtimeId: string;
      text: string;
      displayText?: string | null;
      images?: NativePromptImageInput[] | null;
    },
    void
  ];
  respond_native_session_permission: [
    {
      runtimeId: string;
      requestId: string;
      approved: boolean;
    },
    void
  ];
  respond_native_session_prompt: [
    {
      runtimeId: string;
      toolUseId: string;
      promptType: 'ask_user_question' | 'plan_exit';
      displayText?: string | null;
      answers: Record<string, string>;
      annotations?: Record<string, InteractivePromptAnnotation> | null;
    },
    void
  ];
  rewind_native_session_files: [
    {
      runtimeId: string;
      checkpointId: string;
    },
    void
  ];
  get_native_session_events: [
    {
      runtimeId: string;
      sinceSeq?: number | null;
      limit?: number | null;
    },
    ReplayBatch
  ];
  read_prompt_image_attachment: [
    {
      storagePath: string;
      mediaType: string;
    },
    string
  ];
  stop_native_session: [
    {
      runtimeId: string;
      source?: string | null;
    },
    void
  ];
  update_native_session_settings: [
    {
      runtimeId: string;
      envName?: string | null;
      permMode?: string | null;
      effort?: string | null;
    },
    void
  ];
  set_native_session_runtime_perm_mode: [
    {
      runtimeId: string;
      runtimePermMode?: string | null;
    },
    void
  ];
  handoff_native_session_to_terminal: [
    {
      runtimeId: string;
      terminalType?: NativeTerminalType | null;
    },
    NativeHandoffResult
  ];
  launch_opencode_web: [
    {
      workingDir?: string | null;
      envName?: string | null;
    },
    void
  ];
  list_sessions: [void, Session[]];
  stop_session: [{ sessionId: string }, void];  // 修正：后端参数是 session_id
  remove_session: [{ id: string }, void];
  focus_session: [{ id: string }, void];
  close_session: [{ id: string }, void];
  minimize_session: [{ id: string }, void];
  arrange_sessions: [{ layout: string }, void];
  check_arrange_support: [void, boolean];

  // 使用统计
  get_usage_stats: [void, UsageStats];
  get_usage_history: [{ days: number }, UsageHistoryEntry[]];
  get_continuous_usage_days: [void, number];
  check_ccem_installed: [void, boolean];
  check_claude_installed: [void, boolean];
  check_codex_installed: [void, boolean];
  check_opencode_installed: [void, boolean];
  check_tmux_installed: [void, boolean];
  get_platform_capabilities: [void, PlatformCapabilities];
  collect_doctor_report: [void, unknown];

  // 历史记录
  get_conversation_history: [void, ConversationHistoryEntry[]];
  get_conversation_messages: [{ projectId: string }, ConversationMessage[]];
  get_conversation_segments: [
    { projectId: string },
    ConversationSegment[]
  ];

  // Skills
  search_skills_stream: [{ query: string }, void];
  list_installed_skills: [void, InstalledSkill[]];
  list_workspace_skills: [
    { workingDir?: string | null; provider?: string | null },
    InstalledSkill[]
  ];
  list_workspace_commands: [
    { workingDir?: string | null; provider?: string | null },
    WorkspaceCommand[]
  ];
  read_skill_files: [{ skillFiles: string[] }, SelectedSkillContent[]];
  get_ccem_agent_skill_status: [void, CcemAgentSkillStatus];
  install_ccem_agent_skill: [void, CcemAgentSkillStatus];
  install_skill: [{ packageId: string; global: boolean }, void];  // 修正：后端参数是 package_id + global
  uninstall_skill: [{ name: string }, void];

  // Cron 任务
  list_cron_tasks: [void, CronTask[]];
  add_cron_task: [
    {
      name: string;
      cronExpression: string;
      prompt: string;
      workingDir: string;
      envName?: string | null;
      executionProfile?: 'conservative' | 'standard' | 'autonomous' | null;
      maxBudgetUsd?: number | null;
      allowedTools?: string[] | null;
      disallowedTools?: string[] | null;
      timeoutSecs?: number;
      templateId?: string | null;
      wecomNotification?: CronWecomNotification | null;
    },
    CronTask
  ];
  update_cron_task: [
    {
      id: string;
      name?: string;
      cronExpression?: string;
      prompt?: string;
      workingDir?: string;
      envName?: string | null;
      executionProfile?: 'conservative' | 'standard' | 'autonomous' | null;
      maxBudgetUsd?: number | null;
      allowedTools?: string[] | null;
      disallowedTools?: string[] | null;
      timeoutSecs?: number;
      wecomNotification?: CronWecomNotification | null;
    },
    CronTask
  ];
  delete_cron_task: [{ id: string }, void];
  toggle_cron_task: [{ id: string }, void];
  get_cron_task_runs: [{ taskId: string }, CronTaskRun[]];
  retry_cron_task: [{ id: string }, void];
  get_cron_run_detail: [{ runId: string }, CronRunDetail];
  list_cron_templates: [void, CronTemplate[]];
  get_cron_next_runs: [{ schedule: string; count: number }, string[]];
  generate_cron_task_stream: [{ prompt: string }, void];

  // 终端
  detect_terminals: [void, TerminalInfo[]];
  list_tmux_attach_terminals: [void, TmuxAttachTerminalInfo[]];
  get_preferred_terminal: [void, string | null];
  set_preferred_terminal: [{ terminalType: string }, void];

  // IDE 同步
  sync_vscode_projects: [void, VSCodeProject[]];
  sync_jetbrains_projects: [void, JetBrainsProject[]];
  open_directory_dialog: [void, string | null];
  save_file_dialog: [{ content: string; defaultName: string }, boolean];

  // 远程加载
  load_from_remote: [
    { url: string; key: string; secret: string },
    LoadResult
  ];

  // 其他
  get_default_working_dir: [void, string | null];
}

// ============================================
// 类型定义
// ============================================

export interface BrowserInfo {
  label: string;
  session_id?: string | null;
  url?: string | null;
  title?: string | null;
  visible: boolean;
  can_go_back?: boolean;
  can_go_forward?: boolean;
  lifecycle?: 'creating' | 'ready' | 'navigating' | 'interactive' | 'crashed' | 'destroyed';
  loading?: boolean;
  error?: string | null;
  control?: 'user' | 'agent' | 'paused';
  paused?: boolean;
  generation?: number;
  last_agent_action?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface BrowserSessionStateEvent {
  sessionId: string;
  label: string;
  url?: string | null;
  title?: string | null;
  visible: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  lifecycle: NonNullable<BrowserInfo['lifecycle']>;
  loading: boolean;
  error?: string | null;
  control: NonNullable<BrowserInfo['control']>;
  paused: boolean;
  generation: number;
  lastAgentAction?: string | null;
  createdAt: string;
  updatedAt: string;
  cause: string;
}

export interface BrowserSnapshotElement {
  ref: number;
  element_id?: string;
  tag: string;
  role?: string | null;
  type?: string | null;
  name?: string | null;
  label?: string | null;
  href?: string | null;
  disabled?: boolean;
  hidden?: boolean;
  focusable?: boolean;
  editable?: boolean;
  readonly?: boolean;
  checked?: boolean | null;
  value?: string | null;
  value_redacted?: boolean;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface BrowserSnapshot {
  ok?: boolean;
  url?: string;
  title?: string;
  text?: string;
  text_blocks?: Array<{ tag: string; text: string }>;
  hidden_text_count?: number;
  hidden_text_scan_truncated?: boolean;
  snapshot_id?: string;
  generation?: number;
  navigation_seq?: number;
  frame_id?: string;
  elements?: BrowserSnapshotElement[];
}

export interface BrowserRecentArtifact {
  kind: 'screenshot' | 'interaction_snapshot' | string;
  path: string;
  file_name: string;
  byte_size: number;
  modified_at: string;
}

export interface BrowserRecentActivity {
  artifacts: BrowserRecentArtifact[];
  console_log_path?: string | null;
  audit_log_path?: string | null;
}

export type BrowserRuntimeReadinessStatus = 'unavailable' | 'preparing' | 'ready' | 'failed';

export interface BrowserRuntimeReadiness {
  status: BrowserRuntimeReadinessStatus;
  version?: string | null;
  error?: string | null;
  checked_at: string;
}

export interface AppConfig {
  favorites: FavoriteProject[];
  recent: RecentProject[];
  vscodeProjects: VSCodeProject[];
  jetbrainsProjects: JetBrainsProject[];
  defaultWorkingDir?: string;
}

export interface AppUpdateMetadata {
  version: string;
  currentVersion: string;
  channel: 'beta' | 'stable';
  releaseTag: string;
  releaseUrl: string;
  date?: string | null;
  body?: string | null;
}

export interface AppUpdateProgressEvent {
  phase: 'download-started' | 'download-progress' | 'download-finished' | 'installed';
  version: string;
  downloaded: number;
  total?: number | null;
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

export interface DesktopSettings {
  theme: string;
  autoStart: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  desktopPetEnabled?: boolean;
  desktopNotificationsEnabled?: boolean;
  notifyOnTaskCompleted?: boolean;
  notifyOnTaskFailed?: boolean;
  notifyOnActionRequired?: boolean;
  defaultMode?: string;
  performanceMode?: 'auto' | 'reduced' | 'default';
  aiEnhanced?: boolean;
  aiEnvName?: string | null;
  /** null/undefined = legacy all-enabled; string[] = explicit enable list */
  enabledEnvironments?: string[] | null;
  proxyDebugEnabled?: boolean;
  proxyDebugCodexUpstreamBaseUrl?: string;
  proxyDebugLogMaxBytes?: number;
  proxyDebugRecordMode?: string;
}

export interface PetNotificationReadState {
  readNotificationIds: string[];
}

export interface PetOpenSessionRequest {
  notificationId: string;
  runtimeId: string;
  providerSessionId?: string | null;
  provider?: string | null;
  status: string;
  markRead: boolean;
}

export interface TelegramSettings {
  enabled: boolean;
  botToken?: string | null;
  allowedUserIds?: number[];
  allowedChatId?: number | null;
  notificationsChatId?: number | null;
  notificationsThreadId?: number | null;
  defaultEnvName?: string | null;
  defaultPermMode?: string | null;
  defaultWorkingDir?: string | null;
  topicBindings?: TelegramTopicBinding[];
  useChannelMonitor?: boolean;
  preferences?: TelegramBridgePreferences;
}

export interface TelegramTopicBinding {
  threadId: number;
  projectDir: string;
  preferredEnv?: string | null;
  preferredPermMode?: string | null;
  activeRuntimeId?: string | null;
  lastClaudeSessionId?: string | null;
  createdAt: string;
}

export interface TelegramBridgePreferences {
  showToolCalls: boolean;
  showLowRiskTools: boolean;
  flushIntervalMs: number;
}

export interface TelegramBridgeStatus {
  configured: boolean;
  running: boolean;
  botUsername?: string | null;
  lastError?: string | null;
  allowedChatId?: number | null;
}

export interface TelegramForumTopic {
  threadId: number;
  name: string;
  iconColor?: number | null;
  isBound: boolean;
  boundProject?: string | null;
}

export interface WeixinSettings {
  enabled: boolean;
  apiBaseUrl: string;
  botToken?: string | null;
  botAccountId?: string | null;
  allowedPeerIds?: string[];
  defaultEnvName?: string | null;
  defaultPermMode?: string | null;
  defaultWorkingDir?: string | null;
  flushIntervalMs: number;
}

export interface WeixinBridgeStatus {
  configured: boolean;
  running: boolean;
  botAccountId?: string | null;
  lastError?: string | null;
}

export interface WeixinLoginSession {
  sessionKey: string;
  status: 'pending' | 'scanned' | 'confirmed' | 'expired' | 'failed' | string;
  qrCodeUrl?: string | null;
  message: string;
  botAccountId?: string | null;
  expiresAt?: string | null;
}

export interface WecomSettings {
  enabled: boolean;
  bots: WecomBotConfig[];
}

export type WecomTaskBindingTargetType = 'user' | 'group';

export interface WecomBotConfig {
  id: string;
  name?: string;
  botId: string;
  secret?: string | null;
  enabled: boolean;
  workspaceDir: string;
  adminUserIds: string[];
  allowedUserIds: string[];
  allowedGroupChatIds: string[];
  allowedIntents: string[];
  userAccessPolicy: string;
  requireMention: boolean;
  mentionPatterns: string[];
  adminPermMode: string;
  userPermMode: string;
  defaultEnvName?: string | null;
  taskBindingDefaultTargetType?: WecomTaskBindingTargetType | null;
  taskBindingDefaultPeerId?: string | null;
  taskBindingAutoSendCard?: boolean;
  wsUrl: string;
}

export interface WecomTaskBindingDefault {
  botId: string;
  targetType: WecomTaskBindingTargetType;
  peerId: string;
  autoSendCard: boolean;
}

export interface WecomTaskBindingTargetOption {
  targetType: WecomTaskBindingTargetType;
  peerId: string;
  label: string;
  isDefault: boolean;
}

export interface WecomTaskBindingOption {
  botId: string;
  name: string;
  autoSendCard: boolean;
  targets: WecomTaskBindingTargetOption[];
}

export interface WecomBridgeStatus {
  configured: boolean;
  running: boolean;
  activeBotCount: number;
  lastError?: string | null;
  bots: WecomBotStatus[];
}

export interface WecomBotStatus {
  id: string;
  botId: string;
  name: string;
  configured: boolean;
  running: boolean;
  lastError?: string | null;
  connectedAt?: string | null;
}

export interface ProxyDebugState {
  enabled: boolean;
  running: boolean;
  listenPort?: number;
  baseUrl?: string;
  codexUpstreamBaseUrl: string;
  logMaxBytes: number;
  recordMode: string;
  routeCount: number;
  metrics: ProxyMetrics;
}

export interface ProxyMetrics {
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  routeNotFoundRequests: number;
  avgResponseMs: number;
  activeConnections: number;
}

export interface ManagedSessionSummary {
  runtime_id: string;
  claude_session_id?: string | null;
  pid?: number | null;
  project_dir: string;
  env_name: string;
  perm_mode: string;
  source: ManagedSessionSource;
  status: string;
  created_at: string;
  is_active: boolean;
  last_event_seq?: number | null;
}

export type NativeProvider = 'claude' | 'codex';

export interface PlatformCapabilities {
  os: 'windows' | 'macos' | 'linux' | 'unknown';
  isWindows: boolean;
  isMacos: boolean;
  isLinux: boolean;
  tmuxSupported: boolean;
  tmuxInstalled: boolean;
  interactiveTmuxSupported: boolean;
  externalTerminalLaunchSupported: boolean;
  nativeRuntimeSupported: boolean;
  headlessRuntimeSupported: boolean;
  tmuxInstallCommand?: string | null;
}

export type NativeTransport =
  | 'native_sdk'
  | 'interactive_terminal'
  | 'external_web'
  | 'headless';

export type NativeTerminalType = 'terminalapp' | 'iterm2';

export interface NativeSessionSummary {
  runtime_id: string;
  provider: NativeProvider;
  transport: NativeTransport;
  provider_session_id?: string | null;
  project_dir: string;
  env_name: string;
  perm_mode: string;
  runtime_perm_mode?: string | null;
  effort?: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  is_active: boolean;
  last_event_seq?: number | null;
  seed_boundary_message_count?: number | null;
  can_handoff_to_terminal: boolean;
  last_error?: string | null;
}

export interface NativeHandoffResult {
  status: 'opened' | 'pending';
}

export type ManagedSessionSource =
  | { type: 'desktop' }
  | { type: 'telegram'; chat_id: number; thread_id: number }
  | { type: 'weixin'; peer_id: string }
  | { type: 'wecom'; bot_id: string; peer_id: string }
  | { type: 'cron'; task_id: string };

export interface RuntimeRecoveryCandidate {
  runtime_id: string;
  runtime_kind: 'interactive' | 'headless';
  claude_session_id: string;
  project_dir: string;
  env_name: string;
  perm_mode: string;
  source: ManagedSessionSource;
  saved_at: string;
}

export interface InteractiveReplayBatch {
  gap_detected: boolean;
  oldest_available_seq?: number | null;
  newest_available_seq?: number | null;
  chunks: InteractiveOutputChunk[];
}

export interface InteractiveOutputChunk {
  session_id: string;
  seq: number;
  occurred_at: string;
  data: string;
}

export type HeadlessSessionSummary = ManagedSessionSummary;

export type ChannelKind =
  | { kind: 'desktop_ui' }
  | { kind: 'telegram'; chat_id: number; thread_id?: number | null }
  | { kind: 'weixin'; peer_id: string }
  | { kind: 'wecom'; bot_id: string; peer_id: string }
  | {
      kind: 'bot_binding';
      binding_id: string;
      platform: 'telegram' | 'weixin' | 'wecom';
      peer_id: string;
      thread_id?: string | null;
      bot_id?: string | null;
    };

export interface AttachedChannelInfo {
  kind: ChannelKind;
  connected_at: string;
  label?: string | null;
}

export type RuntimeInput =
  | { type: 'message'; text: string }
  | { type: 'approval'; approved: boolean; responder?: string | null }
  | { type: 'raw_terminal'; data: string };

export interface BindSessionToBotRequest {
  runtime_id: string;
  platform: 'telegram' | 'weixin' | 'wecom';
  peer_id: string;
  thread_id?: string | null;
  bot_id?: string | null;
  task_title?: string | null;
  task_summary?: string | null;
  send_task_card?: boolean;
}

export interface BotBindingInfo {
  binding_id: string;
  runtime_id: string;
  task_id: string;
  platform: 'telegram' | 'weixin' | 'wecom';
  peer_id: string;
  thread_id?: string | null;
  bot_id?: string | null;
  task_title: string;
  task_summary?: string | null;
  send_task_card?: boolean;
  correlation_marker: string;
  task_card_message_id?: string | null;
  delivery_status: BotBindingDeliveryStatus;
  last_delivery_error?: string | null;
  delivered_at?: string | null;
  connected_at: string;
}

export type BotBindingDeliveryStatus =
  | 'bound_only'
  | 'pending'
  | 'delivered'
  | 'failed';

export type BotBindingOutboxFrameKind =
  | 'task_card'
  | 'event_update'
  | 'interactive_output'
  | 'inbound_command'
  | 'permission_prompt'
  | 'session_completed'
  | 'error';

export interface BotBindingOutboxFrame {
  frame_id: string;
  binding_id: string;
  runtime_id: string;
  task_id: string;
  kind: BotBindingOutboxFrameKind;
  title: string;
  text: string;
  quoted_task_id?: string | null;
  correlation_marker?: string | null;
  delivery_message_id?: string | null;
  occurred_at: string;
}

export interface BotBindingInboundRequest {
  binding_id: string;
  text: string;
  quoted_task_id?: string | null;
  responder?: string | null;
}

export interface UnifiedSessionInfo {
  id: string;
  runtime_kind: 'interactive' | 'headless';
  source: ManagedSessionSource;
  status: string;
  project_dir: string;
  env_name: string;
  perm_mode: string;
  created_at: string;
  is_active: boolean;
  pid?: number | null;
  claude_session_id?: string | null;
  tmux_target?: string | null;
  client?: string | null;
  channels: AttachedChannelInfo[];
}

export interface UnifiedSessionDebugComparison {
  headless_count: number;
  interactive_count: number;
  unified_count: number;
  matched: boolean;
}

export interface WorkspaceFileSuggestion {
  absolute_path: string;
  relative_path: string;
  display_name: string;
  is_dir: boolean;
}

export interface WorkspaceGitChangedFile {
  path: string;
  status: string;
  additions?: number | null;
  deletions?: number | null;
}

export interface WorkspaceGitSnapshot {
  is_repo: boolean;
  root?: string | null;
  branch?: string | null;
  sha?: string | null;
  upstream?: string | null;
  dirty_count: number;
  files: WorkspaceGitChangedFile[];
  error?: string | null;
}

export type WorkspaceDiffLineKind = 'context' | 'addition' | 'deletion' | 'hunk' | 'meta';

export interface WorkspaceDiffLine {
  kind: WorkspaceDiffLineKind;
  text: string;
  old_line?: number | null;
  new_line?: number | null;
}

export interface WorkspaceFileDiff {
  path: string;
  is_repo: boolean;
  is_binary: boolean;
  is_untracked: boolean;
  additions: number;
  deletions: number;
  lines: WorkspaceDiffLine[];
  truncated: boolean;
  error?: string | null;
}

export type WorkspaceMediaKind = 'image' | 'audio' | 'video' | 'unsupported';

export interface WorkspaceMediaPreview {
  path: string;
  kind: WorkspaceMediaKind;
  media_type: string;
  data_url?: string | null;
  byte_size: number;
  error?: string | null;
}

export interface ReplayBatch {
  gap_detected: boolean;
  truncated?: boolean;
  oldest_available_seq?: number | null;
  newest_available_seq?: number | null;
  events: SessionEventRecord[];
}

export interface SessionEventRecord {
  runtime_id: string;
  seq: number;
  occurred_at: string;
  payload: SessionEventPayload;
}

export type UserInputKind = 'question' | 'plan_entry' | 'plan_exit';

export type ToolCategory =
  | { category: 'user_input'; kind: UserInputKind; raw_name: string }
  | { category: 'file_op'; raw_name: string }
  | { category: 'execution'; raw_name: string }
  | { category: 'search'; raw_name: string }
  | { category: 'task_mgmt'; raw_name: string }
  | { category: 'unknown'; raw_name: string };

export interface ToolQuestionOption {
  label: string;
  description?: string | null;
  preview?: string | null;
}

export interface InteractivePromptAnnotation {
  preview?: string;
  notes?: string;
}

export interface ToolQuestionPrompt {
  question: string;
  header?: string | null;
  multiSelect: boolean;
  options: ToolQuestionOption[];
}

export type InteractiveToolPrompt =
  | { prompt_type: 'ask_user_question'; questions: ToolQuestionPrompt[] }
  | { prompt_type: 'plan_entry' }
  | {
      prompt_type: 'plan_exit';
      allowed_prompts?: string[];
      plan_summary?: string | null;
    };

export type TerminalPromptKind = 'permission';

export interface SessionPromptImage {
  mediaType: string;
  base64Data?: string | null;
  storagePath?: string | null;
  sha256?: string | null;
  byteSize?: number | null;
  placeholder?: string | null;
}

export interface NativePromptImageInput {
  mediaType: string;
  base64Data: string;
  placeholder?: string;
}

export type TodoSnapshotStatusV1 = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface TodoSnapshotItemV1 {
  id: string;
  text: string;
  status: TodoSnapshotStatusV1;
  active_text?: string;
}

export interface TodoSnapshotV1 {
  version: 1;
  provider: 'claude' | 'codex';
  source: 'TodoWrite' | 'TaskCreate' | 'TaskUpdate' | 'TaskList' | 'todo_list';
  revision: number;
  items: TodoSnapshotItemV1[];
}

export type SessionEventPayload =
  | { type: 'user_prompt'; text: string; image_count: number; images?: SessionPromptImage[] | null; canonical_hash?: string | null }
  | { type: 'system_message'; message: string }
  | { type: 'lifecycle'; stage: string; detail: string }
  | { type: 'claude_json'; message_type?: string | null; raw_json: string }
  | { type: 'stderr_line'; line: string }
  | { type: 'assistant_chunk'; text: string }
  | {
      type: 'tool_use_started';
      tool_use_id: string;
      category: ToolCategory;
      raw_name: string;
      input_summary: string;
      needs_response: boolean;
      prompt?: InteractiveToolPrompt | null;
      todo_snapshot?: TodoSnapshotV1 | null;
    }
  | {
      type: 'tool_use_completed';
      tool_use_id: string;
      raw_name: string;
      result_summary: string;
      result_content?: string | null;
      success: boolean;
      todo_snapshot?: TodoSnapshotV1 | null;
    }
  | {
      type: 'permission_required';
      request_id: string;
      tool_use_id?: string | null;
      tool_name: string;
      input_summary?: string | null;
    }
  | {
      type: 'permission_responded';
      request_id: string;
      tool_use_id?: string | null;
      approved: boolean;
      responder: string;
    }
  | {
      type: 'checkpoint_created';
      provider: 'claude';
      checkpoint_id: string;
      provider_session_id?: string | null;
      prompt_summary?: string | null;
      source: 'claude-file-checkpoint';
    }
  | {
      type: 'files_rewound';
      provider: 'claude';
      checkpoint_id: string;
      files_changed: string[];
      insertions?: number | null;
      deletions?: number | null;
    }
  | {
      type: 'file_rewind_failed';
      provider: 'claude';
      checkpoint_id: string;
      error: string;
    }
  | { type: 'terminal_prompt_required'; prompt_kind: TerminalPromptKind; prompt_text: string }
  | { type: 'terminal_prompt_resolved'; prompt_kind: TerminalPromptKind; approved: boolean }
  | { type: 'session_completed'; reason: string }
  | { type: 'gap_notification'; last_seen_seq: number; oldest_available_seq: number }
  | {
      type: 'token_usage';
      provider: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      total_cost_usd?: number | null;
      scope?: string | null;
    }
  | {
      type: 'context_usage';
      provider: string;
      used_tokens: number;
      max_tokens: number;
      raw_max_tokens?: number | null;
      percentage: number;
      auto_compact_threshold?: number | null;
      is_auto_compact_enabled: boolean;
      model: string;
      categories: Array<{ name: string; tokens: number }>;
    };

export interface ProxyTrafficPage {
  items: ProxyTrafficItem[];
  nextCursor?: string;
}

export interface ProxyTrafficItem {
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
  reduced?: ReducedStreamLog;
}

export interface ProxyTrafficDetail {
  item: ProxyTrafficItem;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  reduced?: ReducedStreamLog;
}

export interface ReducedStreamLog {
  finalText: string;
  finishReason?: string;
  streamStatus: string;
  firstTokenMs?: number;
  totalStreamMs?: number;
}

export interface UsageStats {
  totalTokens: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface UsageHistoryEntry {
  date: string;
  tokens: number;
  cost: number;
}

export interface ConversationHistoryEntry {
  projectId: string;
  projectName: string;
  lastModified: string;
  messageCount: number;
}

export interface ConversationMessage {
  role: string;
  content: string;
  timestamp: string;
}

export interface ConversationSegment {
  index: number;
  startMessage: number;
  endMessage: number;
  messageCount: number;
}

export interface InstalledSkill {
  id?: string;
  name: string;
  description: string;
  path: string;
  scope: string;
  agents: string[];
  source?: string;
  version?: string;
  provider?: string;
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

export interface WorkspaceCommand {
  token: string;
  name: string;
  description?: string | null;
  path: string;
  scope: string;
  source: string;
  namespace?: string | null;
  provider: string;
}

export interface SelectedSkillContent {
  skillFile: string;
  directory: string;
  name?: string | null;
  description?: string | null;
  content: string;
  resourceHints: string[];
  diagnostics: string[];
}

export interface CcemAgentSkillTarget {
  agent: string;
  path: string;
  installed: boolean;
  upToDate: boolean;
}

export interface CcemAgentSkillStatus {
  name: string;
  installed: boolean;
  upToDate: boolean;
  targets: CcemAgentSkillTarget[];
}

export interface CronTask {
  id: string;
  name: string;
  cronExpression: string;
  prompt: string;
  workingDir: string;
  envName?: string | null;
  executionProfile: 'conservative' | 'standard' | 'autonomous';
  maxBudgetUsd?: number | null;
  allowedTools?: string[];
  disallowedTools?: string[];
  enabled: boolean;
  timeoutSecs: number;
  templateId?: string | null;
  wecomNotification?: CronWecomNotification | null;
  triggerType: string;
  parentTaskId?: string | null;
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
  finishedAt?: string | null;
  status: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number | null;
  runtimeId?: string | null;
  runtimeKind?: string | null;
  providerSessionId?: string | null;
  workingDir?: string | null;
}

export interface CronRunDetail {
  id: string;
  taskId: string;
  startTime: string;
  endTime?: string;
  status: string;
  exitCode?: number;
  output: string;
}

export interface CronTemplate {
  name: string;
  description: string;
  schedule: string;
  command: string;
}

export interface TerminalInfo {
  terminalType: string;
  displayName: string;
  available: boolean;
}

export type TmuxAttachTerminalType = 'terminalapp' | 'iterm2' | 'ghostty';

export interface TmuxAttachTerminalInfo {
  terminal_type: TmuxAttachTerminalType;
  name: string;
  installed: boolean;
  preferred: boolean;
}

export interface LoadResult {
  count: number;
  environments: LoadedEnv[];
}

export interface LoadedEnv {
  name: string;
  originalName: string;
  renamed: boolean;
}
