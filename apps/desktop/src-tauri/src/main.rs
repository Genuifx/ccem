// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(dead_code)]
#![allow(clippy::too_many_arguments)]

mod analytics;
mod app_updates;
mod bot_binding;
mod browser;
mod channel;
mod companion;
mod config;
mod cron;
mod crypto;
mod desktop_instance_lock;
mod diagnostic_log;
mod doctor;
mod event_bus;
mod event_dispatcher;
mod external_control;
mod history;
mod interactive_runtime;
#[cfg(test)]
mod ipc_isolation_tests;
mod jsonl_watcher;
mod native_event_log;
mod native_helper_resource;
mod native_runtime;
mod notifications;
mod opencode;
mod permission;
mod permission_preview;
mod pet_notifications;
mod pet_window;
mod prompt_image_store;
mod proxy_debug;
mod remote;
mod runtime;
mod session;
mod session_annotations;
mod session_provenance;
mod session_titles;
mod skills;
mod slash_commands;
mod system_proxy;
mod telegram;
mod terminal;
mod title_overrides;

mod tmux;
mod tray;
mod unified_runtime;
mod unified_session;
mod wecom;
mod weixin;
mod workspace_decorations;
mod workspace_search;

use analytics::{
    get_continuous_usage_days, get_usage_history, get_usage_model_breakdown, get_usage_stats,
};
use bot_binding::{
    BindSessionToBotRequest, BotBindingInboundRequest, BotBindingInfo, BotBindingManager,
    BotBindingOutboxFrame,
};
use browser::BrowserManager;
use channel::ChannelKind;
use config::{
    create_env_with_encrypted_key, resolve_claude_env, resolve_codex_runtime,
    resolve_opencode_runtime, AppConfig, DesktopSettings, EnvConfig, FavoriteProject,
    JetBrainsProject, RecentProject, VSCodeProject,
};
use cron::{start_cron_scheduler, CronScheduler};
use event_dispatcher::EventDispatcher;
use external_control::ExternalControlManager;
use history::{
    get_conversation_detail, get_conversation_history, get_conversation_messages,
    get_conversation_segments, get_session_subagents, get_workspace_overview_snapshot,
    search_conversation_history,
};
use interactive_runtime::{
    InteractiveReplayBatch, InteractiveRuntimeManager, InteractiveSessionOptions,
};
use native_runtime::{
    InteractivePromptAnnotation, NativeHandoffResult, NativeProvider, NativeRuntimeManager,
    NativeSessionOptions, NativeSessionSummary, PromptImage,
};
use opencode::{snapshot_known_session_ids, track_launched_session};
use prompt_image_store::PromptImageStore;
use proxy_debug::{
    ProxyDebugManager, ProxyDebugState, ProxyTrafficDetail, ProxyTrafficPage, RegisterRouteRequest,
};
use remote::RemotePlatform;
use runtime::{
    cleanup_orphaned_runtime_processes, clear_runtime_recovery_candidates_by_claude_session_id,
    dismiss_runtime_recovery_candidate as dismiss_runtime_recovery_candidate_entry,
    list_runtime_recovery_candidates as list_runtime_recovery_candidates_entries,
    HeadlessRuntimeManager, HeadlessSessionOptions, HeadlessSessionSource, HeadlessSessionSummary,
    RuntimeRecoveryCandidate,
};
use session::{
    cleanup_exit_file, cleanup_stale_exit_files_except, start_session_monitor, Session,
    SessionManager,
};
use session_provenance::{
    register_launch, spawn_claude_source_binding, spawn_codex_source_binding,
    SessionProvenanceUpsert, DEFAULT_CONFIG_SOURCE,
};
use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::process::Command;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use telegram::{
    TelegramBridgeManager, TelegramBridgeStatus, TelegramForumTopic, TelegramSettings,
    TelegramTopicBinding,
};
use tmux::ClaudeTerminalState;
use unified_runtime::UnifiedSessionManager;
use unified_session::{RuntimeInput, UnifiedSessionDebugComparison, UnifiedSessionInfo};
use wecom::{WecomBridgeManager, WecomBridgeStatus, WecomSettings, WecomTaskBindingTargetType};
use weixin::{WeixinBridgeManager, WeixinBridgeStatus, WeixinLoginSession, WeixinSettings};
use workspace_decorations::{
    build_workspace_session_decorations, legacy_interactive_runtime_descriptor,
    native_runtime_descriptor, should_replay_decoration_events, unified_runtime_descriptor,
    WorkspaceDecorationSessionInput, WorkspaceSessionDecoration,
};
use workspace_search::search_workspace_files;

/// Global flag: when true, CloseRequested should NOT be intercepted.
static FORCE_QUIT: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
use tauri::window::Color;
use tauri::{webview::PageLoadEvent, Manager, RunEvent, State, WindowEvent};
use terminal::{
    ArrangeLayout, ArrangeSessionInfo, TerminalInfo, TerminalType, TmuxAttachTerminalInfo,
    TmuxAttachTerminalType,
};
use tray::{create_tray, TRAY_COCKPIT_LABEL};

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
struct LoadedEnv {
    name: String,
    original_name: String,
    renamed: bool,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
struct LoadResult {
    count: usize,
    environments: Vec<LoadedEnv>,
}

#[derive(Debug, serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
enum WindowControlAction {
    Close,
    Minimize,
    ToggleFullscreen,
    ExitFullscreen,
}

#[cfg(target_os = "macos")]
fn should_use_reduced_window_effects(settings: &DesktopSettings) -> bool {
    settings.performance_mode == "reduced"
        || matches!(
            std::env::var("VITE_PERF_MODE").ok().as_deref(),
            Some("reduced")
        )
}

#[cfg(target_os = "macos")]
fn reduced_window_background_color(settings: &DesktopSettings) -> Color {
    match settings.theme.as_str() {
        "light" => Color(242, 245, 249, 255),
        _ => Color(22, 24, 29, 255),
    }
}

#[cfg(target_os = "macos")]
fn sync_macos_window_appearance(
    main_window: &tauri::WebviewWindow,
    settings: &DesktopSettings,
) -> Result<(), String> {
    use tauri_plugin_decorum::WebviewWindowExt;
    use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial};

    let _ = clear_vibrancy(main_window);

    if should_use_reduced_window_effects(settings) {
        let _ = main_window.set_background_color(Some(reduced_window_background_color(settings)));
        return Ok(());
    }

    let _ = main_window.set_background_color(None);
    main_window
        .make_transparent()
        .map_err(|error| format!("Failed to enable window transparency: {}", error))?;
    apply_vibrancy(main_window, NSVisualEffectMaterial::Sidebar, None, None)
        .map_err(|error| format!("Failed to apply vibrancy: {}", error))?;
    Ok(())
}

fn generate_session_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    format!("session-{}", timestamp)
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to CCEM Desktop.", name)
}

#[tauri::command]
fn get_system_username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "developer".to_string())
}

#[tauri::command]
fn window_control(app: tauri::AppHandle, action: WindowControlAction) -> Result<(), String> {
    let main_window = app
        .get_window("main")
        .ok_or_else(|| "Main window not available".to_string())?;

    match action {
        WindowControlAction::Close => main_window
            .close()
            .map_err(|error| format!("Failed to close window: {}", error))?,
        WindowControlAction::Minimize => main_window
            .minimize()
            .map_err(|error| format!("Failed to minimize window: {}", error))?,
        WindowControlAction::ToggleFullscreen => {
            let is_fullscreen = main_window
                .is_fullscreen()
                .map_err(|error| format!("Failed to inspect fullscreen state: {}", error))?;
            main_window
                .set_fullscreen(!is_fullscreen)
                .map_err(|error| format!("Failed to toggle fullscreen: {}", error))?;
        }
        WindowControlAction::ExitFullscreen => {
            main_window
                .set_fullscreen(false)
                .map_err(|error| format!("Failed to exit fullscreen: {}", error))?;
        }
    }

    Ok(())
}

#[tauri::command]
async fn get_environments() -> Result<HashMap<String, EnvConfig>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(debug_assertions)]
        let start = std::time::Instant::now();
        let cfg = config::read_config()?;
        let decrypted: HashMap<String, EnvConfig> = cfg
            .registries
            .iter()
            .map(|(k, v)| config::get_env_with_decrypted_key(v).map(|env| (k.clone(), env)))
            .collect::<Result<_, String>>()?;

        #[cfg(debug_assertions)]
        {
            let elapsed_ms = start.elapsed().as_millis();
            if elapsed_ms > 100 {
                eprintln!("CCEM perf: get_environments took {}ms", elapsed_ms);
            }
        }

        Ok(decrypted)
    })
    .await
    .map_err(|e| format!("Failed to join get_environments task: {}", e))?
}

#[tauri::command]
fn get_current_env() -> Result<String, String> {
    let cfg = config::read_config()?;
    Ok(cfg.current.unwrap_or_else(|| "official".to_string()))
}

#[tauri::command]
fn set_current_env(name: String) -> Result<(), String> {
    let mut cfg = config::read_config()?;

    // 校验环境是否存在
    if !cfg.registries.contains_key(&name) {
        return Err(format!("Environment '{}' does not exist", name));
    }

    cfg.current = Some(name);
    config::write_config(&cfg)
}

#[tauri::command]
fn add_environment(
    name: String,
    base_url: String,
    auth_token: Option<String>,
    default_opus_model: String,
    default_sonnet_model: Option<String>,
    default_haiku_model: Option<String>,
    runtime_model: Option<String>,
    subagent_model: Option<String>,
) -> Result<(), String> {
    let mut cfg = config::read_config()?;

    if cfg.registries.contains_key(&name) {
        return Err(format!("Environment '{}' already exists", name));
    }

    let env_config = create_env_with_encrypted_key(
        Some(base_url),
        auth_token,
        Some(default_opus_model),
        default_sonnet_model,
        default_haiku_model,
        runtime_model,
        subagent_model,
    )?;

    cfg.registries.insert(name, env_config);
    config::write_config(&cfg)
}

#[tauri::command]
fn update_environment(
    old_name: String,
    name: String,
    base_url: String,
    auth_token: Option<String>,
    default_opus_model: String,
    default_sonnet_model: Option<String>,
    default_haiku_model: Option<String>,
    runtime_model: Option<String>,
    subagent_model: Option<String>,
) -> Result<(), String> {
    let mut cfg = config::read_config()?;

    if !cfg.registries.contains_key(&old_name) {
        return Err(format!("Environment '{}' does not exist", old_name));
    }

    // If renaming, check that new name doesn't conflict
    if old_name != name && cfg.registries.contains_key(&name) {
        return Err(format!("Environment '{}' already exists", name));
    }

    let env_config = create_env_with_encrypted_key(
        Some(base_url),
        auth_token,
        Some(default_opus_model),
        default_sonnet_model,
        default_haiku_model,
        runtime_model,
        subagent_model,
    )?;

    // Remove old key if renamed
    if old_name != name {
        cfg.registries.remove(&old_name);
        // Update current env pointer if it was pointing to the old name
        if cfg.current.as_ref() == Some(&old_name) {
            cfg.current = Some(name.clone());
        }
    }

    cfg.registries.insert(name, env_config);
    config::write_config(&cfg)
}

#[tauri::command]
fn delete_environment(name: String) -> Result<(), String> {
    if name == "official" {
        return Err("Cannot delete the 'official' environment".to_string());
    }

    let mut cfg = config::read_config()?;

    if !cfg.registries.contains_key(&name) {
        return Err(format!("Environment '{}' does not exist", name));
    }

    cfg.registries.remove(&name);

    if cfg.current.as_ref() == Some(&name) {
        cfg.current = Some("official".to_string());
    }

    config::write_config(&cfg)
}

// ============================================
// App Config Commands (Favorites & Recent)
// ============================================

#[tauri::command]
fn get_app_config() -> Result<AppConfig, String> {
    config::read_app_config()
}

#[tauri::command]
fn add_favorite(path: String, name: String) -> Result<(), String> {
    let mut cfg = config::read_app_config()?;
    // Don't add if already exists
    if cfg.favorites.iter().any(|f| f.path == path) {
        return Ok(());
    }
    cfg.favorites.push(FavoriteProject { path, name });
    config::write_app_config(&cfg)
}

#[tauri::command]
fn remove_favorite(path: String) -> Result<(), String> {
    let mut cfg = config::read_app_config()?;
    cfg.favorites.retain(|f| f.path != path);
    config::write_app_config(&cfg)
}

#[tauri::command]
fn add_recent(path: String) -> Result<(), String> {
    let mut cfg = config::read_app_config()?;
    // Remove if already exists (will re-add at front)
    cfg.recent.retain(|r| r.path != path);
    // Add to front
    cfg.recent.insert(
        0,
        RecentProject {
            path,
            last_used: chrono::Utc::now().to_rfc3339(),
        },
    );
    // Keep max 10
    cfg.recent.truncate(10);
    config::write_app_config(&cfg)
}

// ============================================
// Terminal Management Commands
// ============================================

#[tauri::command]
fn detect_terminals() -> Vec<TerminalInfo> {
    terminal::detect_terminals()
}

#[tauri::command]
fn list_tmux_attach_terminals() -> Vec<TmuxAttachTerminalInfo> {
    if !terminal::tmux_supported_on_current_platform() {
        return Vec::new();
    }

    terminal::detect_tmux_attach_terminals()
}

#[tauri::command]
fn get_preferred_terminal() -> TerminalType {
    terminal::get_preferred_terminal()
}

#[tauri::command]
fn set_preferred_terminal(terminal_type: TerminalType) -> Result<(), String> {
    terminal::set_preferred_terminal(terminal_type)
}

// ============================================
// Interactive Runtime v0 Commands (external terminal-backed)
// ============================================

#[tauri::command]
async fn launch_claude_code(
    state: State<'_, Arc<SessionManager>>,
    proxy_state: State<'_, Arc<ProxyDebugManager>>,
    env_name: String,
    perm_mode: Option<String>,
    working_dir: Option<String>,
    resume_session_id: Option<String>,
    client: Option<String>,
) -> Result<Session, String> {
    let client_name = client
        .unwrap_or_else(|| "claude".to_string())
        .to_lowercase();
    if client_name != "claude" && client_name != "codex" && client_name != "opencode" {
        return Err(format!("Unsupported client '{}'", client_name));
    }

    println!("=== launch_claude_code called ===");
    println!(
        "client: {}, env_name: {}, perm_mode: {:?}, working_dir: {:?}, resume_session_id: {:?}",
        client_name, env_name, perm_mode, working_dir, resume_session_id
    );

    if (client_name == "codex" || client_name == "opencode")
        && perm_mode
            .as_ref()
            .is_some_and(|mode| !mode.trim().is_empty())
    {
        println!("{client_name} launch ignores permission mode");
    }

    // Generate session ID first (needed for launch tracking + proxy route binding)
    let session_id = generate_session_id();

    // Build environment variables map
    let mut env_vars: HashMap<String, String> = HashMap::new();
    let mut claude_upstream_base_url: Option<String> = None;
    let mut resolved_env_name = env_name.clone();
    let mut config_source = Some(DEFAULT_CONFIG_SOURCE.to_string());
    if client_name == "claude" {
        let resolved = resolve_claude_env(&env_name)?;
        claude_upstream_base_url = resolved.upstream_base_url;
        env_vars = resolved.env_vars;
    } else if client_name == "codex" {
        env_vars = system_proxy::resolve_codex_proxy_env();
    } else if client_name == "opencode" {
        let resolved = resolve_opencode_runtime(&env_name)?;
        resolved_env_name = resolved.env_name;
        config_source = Some(resolved.config_source);
        env_vars = resolved.env_vars;
    }

    if proxy_state.is_enabled() {
        if client_name == "opencode" {
            println!("OpenCode launch ignores proxy debug routing");
        } else {
            let upstream_base_url = if client_name == "claude" {
                claude_upstream_base_url
                    .clone()
                    .unwrap_or_else(|| "https://api.anthropic.com".to_string())
            } else {
                proxy_state.codex_upstream_base_url()
            };

            let proxy_route_base_url = proxy_state
                .register_route(RegisterRouteRequest {
                    session_id: session_id.clone(),
                    client: client_name.clone(),
                    env_name: resolved_env_name.clone(),
                    upstream_base_url,
                })
                .await?;

            if client_name == "claude" {
                env_vars.insert("ANTHROPIC_BASE_URL".to_string(), proxy_route_base_url);
            } else {
                env_vars.insert("OPENAI_BASE_URL".to_string(), proxy_route_base_url);
            }
        }
    }

    let work_dir = working_dir.clone().unwrap_or_else(|| {
        dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "~".to_string())
    });

    let perm = if client_name == "claude" {
        resolve_effective_perm_mode(perm_mode.clone())
    } else {
        "n/a".to_string()
    };

    println!("Session ID: {}", session_id);
    println!("Work dir: {}", work_dir);
    println!("Env vars count: {}", env_vars.len());
    let opencode_known_sessions = if client_name == "opencode" {
        Some(snapshot_known_session_ids())
    } else {
        None
    };

    // Get preferred terminal and launch
    let preferred_terminal = terminal::get_preferred_terminal();
    println!("Preferred terminal: {:?}", preferred_terminal);

    let launch_result = terminal::launch_in_terminal(
        preferred_terminal,
        env_vars,
        &work_dir,
        &session_id,
        &resolved_env_name,
        if client_name == "claude" {
            Some(perm.as_str())
        } else {
            perm_mode.as_deref()
        },
        resume_session_id.as_deref(),
        &client_name,
    );

    let (window_id, iterm_session_id) = match &launch_result {
        Ok((wid, sid)) => {
            println!(
                "Terminal launch SUCCESS, window_id: {:?}, iterm_session_id: {:?}",
                wid, sid
            );
            (wid.clone(), sid.clone())
        }
        Err(e) => {
            println!("Terminal launch FAILED: {}", e);
            proxy_state.remove_session_routes(&session_id);
            return Err(e.clone());
        }
    };

    if client_name == "opencode" {
        track_launched_session(
            opencode_known_sessions.unwrap_or_default(),
            resolved_env_name.clone(),
            config_source
                .clone()
                .unwrap_or_else(|| "native".to_string()),
            work_dir.clone(),
            resume_session_id.clone(),
            Some(session_id.clone()),
        );
    }

    let started_at = chrono::Utc::now();

    // Determine terminal type string for session metadata
    let terminal_type_str = match preferred_terminal {
        TerminalType::ITerm2 => "iterm2",
        TerminalType::TerminalApp => "terminalapp",
    };

    let session = Session {
        id: session_id,
        pid: None, // Terminal-launched sessions don't have direct PID access
        client: client_name,
        env_name: resolved_env_name,
        config_source,
        perm_mode: perm,
        working_dir: work_dir,
        start_time: chrono::Utc::now().to_rfc3339(),
        status: "running".to_string(),
        terminal_type: Some(terminal_type_str.to_string()),
        window_id,        // Store window ID for later operations
        iterm_session_id, // Store iTerm2 session unique ID for arrange
        tmux_target: None,
    };

    state.add_session(session.clone());

    if let Err(error) = register_launch(SessionProvenanceUpsert {
        ccem_session_id: session.id.clone(),
        client: session.client.clone(),
        env_name: session.env_name.clone(),
        config_source: session.config_source.clone(),
        working_dir: session.working_dir.clone(),
        perm_mode: Some(session.perm_mode.clone()),
        launch_mode: "external_terminal".to_string(),
        started_via: "desktop".to_string(),
        source_session_id: resume_session_id.clone(),
    }) {
        eprintln!(
            "Failed to register desktop external launch provenance for {}: {}",
            session.id, error
        );
    }

    if session.client == "claude" {
        spawn_claude_source_binding(
            session.id.clone(),
            session.working_dir.clone(),
            started_at,
            resume_session_id.clone(),
        );
    } else if session.client == "codex" {
        spawn_codex_source_binding(
            session.id.clone(),
            session.working_dir.clone(),
            started_at,
            resume_session_id.clone(),
        );
    }

    Ok(session)
}

fn resolve_headless_working_dir(working_dir: Option<String>) -> String {
    working_dir
        .filter(|dir| !dir.trim().is_empty())
        .or_else(config::get_default_working_dir)
        .or_else(|| dirs::home_dir().map(|path| path.to_string_lossy().to_string()))
        .unwrap_or_else(|| ".".to_string())
}

fn resolve_default_perm_mode() -> String {
    config::read_config()
        .ok()
        .and_then(|cfg| cfg.default_mode)
        .map(|mode| mode.trim().to_string())
        .filter(|mode| !mode.is_empty())
        .unwrap_or_else(|| "dev".to_string())
}

fn resolve_effective_perm_mode(perm_mode: Option<String>) -> String {
    perm_mode
        .map(|mode| mode.trim().to_string())
        .filter(|mode| !mode.is_empty())
        .unwrap_or_else(resolve_default_perm_mode)
}

fn parse_native_provider(provider: &str) -> Result<NativeProvider, String> {
    match provider.trim().to_lowercase().as_str() {
        "claude" => Ok(NativeProvider::Claude),
        "codex" => Ok(NativeProvider::Codex),
        other => Err(format!(
            "Unsupported native provider '{}'. Use claude or codex.",
            other
        )),
    }
}

// ============================================
// Headless Runtime Commands (`claude -p` / stream-json)
// ============================================

#[tauri::command]
async fn create_managed_session(
    app: tauri::AppHandle,
    runtime_state: State<'_, Arc<HeadlessRuntimeManager>>,
    env_name: String,
    perm_mode: Option<String>,
    working_dir: Option<String>,
    resume_session_id: Option<String>,
    initial_prompt: Option<String>,
) -> Result<HeadlessSessionSummary, String> {
    let resolved = resolve_claude_env(&env_name)?;
    let effective_working_dir = resolve_headless_working_dir(working_dir);
    let resume_target = resume_session_id.clone();

    let summary = runtime_state.create_session(
        app,
        HeadlessSessionOptions {
            env_name: resolved.env_name,
            perm_mode: resolve_effective_perm_mode(perm_mode),
            working_dir: effective_working_dir,
            resume_session_id,
            initial_prompt,
            max_budget_usd: None,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            env_vars: resolved.env_vars,
            source: HeadlessSessionSource::Desktop,
        },
    )?;

    if let Some(session_id) = resume_target.as_deref() {
        if let Err(error) = clear_runtime_recovery_candidates_by_claude_session_id(session_id) {
            eprintln!(
                "Failed to clear recovery candidate for resumed headless session {}: {}",
                session_id, error
            );
        }
    }

    if let Err(error) = register_launch(SessionProvenanceUpsert {
        ccem_session_id: summary.runtime_id.clone(),
        client: "claude".to_string(),
        env_name: summary.env_name.clone(),
        config_source: Some(DEFAULT_CONFIG_SOURCE.to_string()),
        working_dir: summary.project_dir.clone(),
        perm_mode: Some(summary.perm_mode.clone()),
        launch_mode: "headless".to_string(),
        started_via: "desktop".to_string(),
        source_session_id: resume_target.clone(),
    }) {
        eprintln!(
            "Failed to register desktop headless launch provenance for {}: {}",
            summary.runtime_id, error
        );
    }

    Ok(summary)
}

#[tauri::command]
fn list_managed_sessions(
    runtime_state: State<'_, Arc<HeadlessRuntimeManager>>,
) -> Vec<HeadlessSessionSummary> {
    runtime_state.list_sessions()
}

#[tauri::command]
fn send_to_managed_session(
    app: tauri::AppHandle,
    runtime_state: State<'_, Arc<HeadlessRuntimeManager>>,
    runtime_id: String,
    text: String,
) -> Result<(), String> {
    runtime_state.send_user_message(&app, &runtime_id, &text)
}

#[tauri::command]
fn get_managed_session_events(
    runtime_state: State<'_, Arc<HeadlessRuntimeManager>>,
    runtime_id: String,
    since_seq: Option<u64>,
) -> Result<event_bus::ReplayBatch, String> {
    runtime_state.replay_events(&runtime_id, since_seq)
}

#[tauri::command]
fn stop_managed_session(
    app: tauri::AppHandle,
    runtime_state: State<'_, Arc<HeadlessRuntimeManager>>,
    runtime_id: String,
) -> Result<(), String> {
    runtime_state.stop_session(&app, &runtime_id)
}

#[tauri::command]
fn remove_managed_session(
    runtime_state: State<'_, Arc<HeadlessRuntimeManager>>,
    runtime_id: String,
) -> Result<(), String> {
    runtime_state.remove_session(&runtime_id)
}

#[tauri::command]
async fn create_headless_session(
    app: tauri::AppHandle,
    runtime_state: State<'_, Arc<HeadlessRuntimeManager>>,
    env_name: String,
    perm_mode: Option<String>,
    working_dir: Option<String>,
    resume_session_id: Option<String>,
    initial_prompt: Option<String>,
) -> Result<HeadlessSessionSummary, String> {
    create_managed_session(
        app,
        runtime_state,
        env_name,
        perm_mode,
        working_dir,
        resume_session_id,
        initial_prompt,
    )
    .await
}

#[tauri::command]
fn list_headless_sessions(
    runtime_state: State<'_, Arc<HeadlessRuntimeManager>>,
) -> Vec<HeadlessSessionSummary> {
    list_managed_sessions(runtime_state)
}

#[tauri::command]
fn send_to_headless_session(
    app: tauri::AppHandle,
    runtime_state: State<'_, Arc<HeadlessRuntimeManager>>,
    runtime_id: String,
    text: String,
) -> Result<(), String> {
    send_to_managed_session(app, runtime_state, runtime_id, text)
}

#[tauri::command]
fn get_headless_session_events(
    runtime_state: State<'_, Arc<HeadlessRuntimeManager>>,
    runtime_id: String,
    since_seq: Option<u64>,
) -> Result<event_bus::ReplayBatch, String> {
    get_managed_session_events(runtime_state, runtime_id, since_seq)
}

#[tauri::command]
fn stop_headless_session(
    app: tauri::AppHandle,
    runtime_state: State<'_, Arc<HeadlessRuntimeManager>>,
    runtime_id: String,
) -> Result<(), String> {
    stop_managed_session(app, runtime_state, runtime_id)
}

#[tauri::command]
fn remove_headless_session(
    runtime_state: State<'_, Arc<HeadlessRuntimeManager>>,
    runtime_id: String,
) -> Result<(), String> {
    remove_managed_session(runtime_state, runtime_id)
}

#[tauri::command]
fn respond_headless_permission(
    app: tauri::AppHandle,
    runtime_state: State<'_, Arc<HeadlessRuntimeManager>>,
    request_id: String,
    approved: bool,
    responder: Option<String>,
) -> Result<(), String> {
    runtime_state.respond_to_permission(
        &app,
        &request_id,
        approved,
        responder.as_deref().unwrap_or("desktop"),
    )
}

#[tauri::command]
fn list_unified_sessions(
    unified_state: State<'_, Arc<UnifiedSessionManager>>,
) -> Vec<UnifiedSessionInfo> {
    unified_state.list_sessions()
}

#[tauri::command]
fn get_session_events(
    app: tauri::AppHandle,
    unified_state: State<'_, Arc<UnifiedSessionManager>>,
    runtime_id: String,
    since_seq: Option<u64>,
) -> Result<event_bus::ReplayBatch, String> {
    unified_state.get_session_events(&app, &runtime_id, since_seq)
}

#[tauri::command]
async fn get_workspace_session_decorations(
    app: tauri::AppHandle,
    unified_state: State<'_, Arc<UnifiedSessionManager>>,
    native_state: State<'_, Arc<NativeRuntimeManager>>,
    session_state: State<'_, Arc<SessionManager>>,
    sessions: Vec<WorkspaceDecorationSessionInput>,
) -> Result<Vec<WorkspaceSessionDecoration>, String> {
    let unified_state = unified_state.inner().clone();
    let native_state = native_state.inner().clone();
    let session_state = session_state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || {
        let unified_sessions = unified_state.list_sessions();
        let native_sessions = native_state.list_sessions();
        let unified_runtime_ids = unified_sessions
            .iter()
            .map(|runtime| runtime.id.as_str())
            .collect::<HashSet<_>>();
        let legacy_interactive_sessions = session_state
            .list_sessions()
            .into_iter()
            .filter(|session| {
                !unified_runtime_ids.contains(session.id.as_str())
                    && session.terminal_type.as_deref() != Some("embedded")
                    && session.status == "running"
            })
            .collect::<Vec<_>>();

        let mut runtimes = Vec::new();
        runtimes.extend(unified_sessions.iter().map(unified_runtime_descriptor));
        runtimes.extend(native_sessions.iter().map(native_runtime_descriptor));
        runtimes.extend(
            legacy_interactive_sessions
                .iter()
                .map(legacy_interactive_runtime_descriptor),
        );

        let mut events_by_runtime = unified_sessions
            .iter()
            .filter(|runtime| {
                runtime.is_active && should_replay_decoration_events(&runtime.status)
            })
            .filter_map(|runtime| {
                unified_state
                    .get_session_events(&app, &runtime.id, None)
                    .ok()
                    .map(|batch| (runtime.id.clone(), batch.events))
            })
            .collect::<HashMap<_, _>>();
        events_by_runtime.extend(
            native_sessions
                .iter()
                .filter(|runtime| {
                    runtime.is_active && should_replay_decoration_events(&runtime.status)
                })
                .filter_map(|runtime| {
                    native_state
                        .replay_events(&runtime.runtime_id, None)
                        .ok()
                        .map(|batch| (runtime.runtime_id.clone(), batch.events))
                }),
        );

        Ok(build_workspace_session_decorations(
            &sessions,
            &runtimes,
            &events_by_runtime,
        ))
    })
    .await
    .map_err(|error| {
        format!(
            "Failed to join workspace session decoration task: {}",
            error
        )
    })?
}

#[tauri::command]
fn send_session_input(
    app: tauri::AppHandle,
    unified_state: State<'_, Arc<UnifiedSessionManager>>,
    runtime_id: String,
    input: RuntimeInput,
) -> Result<(), String> {
    unified_state.send_input(&app, &runtime_id, input)
}

#[tauri::command]
fn stop_unified_session(
    app: tauri::AppHandle,
    unified_state: State<'_, Arc<UnifiedSessionManager>>,
    runtime_id: String,
) -> Result<(), String> {
    unified_state.stop_session(&app, &runtime_id)
}

#[tauri::command]
fn attach_channel(
    app: tauri::AppHandle,
    unified_state: State<'_, Arc<UnifiedSessionManager>>,
    runtime_id: String,
    channel: ChannelKind,
) -> Result<(), String> {
    match channel {
        ChannelKind::DesktopUi => unified_state.attach_desktop_channel(&app, &runtime_id),
        channel if channel.is_managed_remote() => {
            let platform = channel
                .remote_peer_ref()
                .map(|remote| remote.platform.display_name())
                .unwrap_or("Remote");
            Err(format!(
                "{platform} channels are managed internally by the {platform} bridge"
            ))
        }
        other => Err(format!("Unsupported channel attachment for {:?}", other)),
    }
}

#[tauri::command]
fn detach_channel(
    unified_state: State<'_, Arc<UnifiedSessionManager>>,
    runtime_id: String,
    channel: ChannelKind,
) -> Result<(), String> {
    unified_state.detach_channel(&runtime_id, &channel)
}

#[tauri::command]
fn bind_session_to_bot(
    app: tauri::AppHandle,
    unified_state: State<'_, Arc<UnifiedSessionManager>>,
    native_state: State<'_, Arc<NativeRuntimeManager>>,
    bot_binding_state: State<'_, Arc<BotBindingManager>>,
    wecom_state: State<'_, Arc<WecomBridgeManager>>,
    request: BindSessionToBotRequest,
) -> Result<BotBindingInfo, String> {
    let send_task_card = request.send_task_card;
    let info = bot_binding_state.bind_any_session(
        &app,
        &unified_state,
        native_state.inner().clone(),
        request,
    )?;
    if !send_task_card {
        return Ok(info);
    }
    deliver_bot_binding_task_card(bot_binding_state.inner(), wecom_state.inner(), &info)
}

#[tauri::command]
fn list_session_bot_bindings(
    bot_binding_state: State<'_, Arc<BotBindingManager>>,
    runtime_id: Option<String>,
) -> Vec<BotBindingInfo> {
    bot_binding_state.list_bindings(runtime_id)
}

#[tauri::command]
fn get_session_bot_binding_outbox(
    bot_binding_state: State<'_, Arc<BotBindingManager>>,
    binding_id: Option<String>,
) -> Vec<BotBindingOutboxFrame> {
    bot_binding_state.outbox(binding_id)
}

#[tauri::command]
fn send_bot_bound_session_input(
    app: tauri::AppHandle,
    unified_state: State<'_, Arc<UnifiedSessionManager>>,
    native_state: State<'_, Arc<NativeRuntimeManager>>,
    bot_binding_state: State<'_, Arc<BotBindingManager>>,
    request: BotBindingInboundRequest,
) -> Result<(), String> {
    bot_binding_state.send_inbound_command(
        &app,
        &unified_state,
        native_state.inner().clone(),
        request,
    )
}

#[tauri::command]
fn process_bot_binding_requests(
    app: tauri::AppHandle,
    unified_state: State<'_, Arc<UnifiedSessionManager>>,
    native_state: State<'_, Arc<NativeRuntimeManager>>,
    bot_binding_state: State<'_, Arc<BotBindingManager>>,
    wecom_state: State<'_, Arc<WecomBridgeManager>>,
) -> Result<Vec<BotBindingInfo>, String> {
    let infos = bot_binding_state.process_file_requests(
        &app,
        &unified_state,
        native_state.inner().clone(),
    )?;
    infos
        .into_iter()
        .map(|info| {
            if info.send_task_card {
                deliver_bot_binding_task_card(bot_binding_state.inner(), wecom_state.inner(), &info)
            } else {
                Ok(info)
            }
        })
        .collect()
}

fn deliver_bot_binding_task_card(
    bot_binding_manager: &Arc<BotBindingManager>,
    wecom_manager: &Arc<WecomBridgeManager>,
    info: &BotBindingInfo,
) -> Result<BotBindingInfo, String> {
    if info.platform != RemotePlatform::Wecom {
        return Ok(info.clone());
    }

    let relay_cursor = bot_binding_manager
        .outbox(Some(info.binding_id.clone()))
        .len();
    let pending = bot_binding_manager.mark_task_card_delivery_pending(&info.binding_id)?;
    match wecom_manager.send_markdown_message(
        pending.bot_id.as_deref(),
        &pending.peer_id,
        &format_wecom_task_binding_card(&pending),
    ) {
        Ok(message_id) => {
            let delivered =
                bot_binding_manager.mark_task_card_delivered(&pending.binding_id, message_id)?;
            if let Err(error) = wecom::start_bot_binding_markdown_relay(
                Arc::clone(wecom_manager),
                Arc::clone(bot_binding_manager),
                delivered.clone(),
                relay_cursor,
            ) {
                eprintln!("WeCom bot binding markdown relay start warning: {}", error);
            }
            Ok(delivered)
        }
        Err(error) => {
            bot_binding_manager.mark_task_card_delivery_failed(&pending.binding_id, error)
        }
    }
}

fn format_wecom_task_binding_card(info: &BotBindingInfo) -> String {
    let summary = info
        .task_summary
        .as_deref()
        .filter(|summary| !summary.trim().is_empty())
        .unwrap_or("无摘要");
    let route_id = crate::bot_binding::bot_binding_route_id(info);
    let project = info
        .project_label
        .as_deref()
        .filter(|label| !label.trim().is_empty())
        .map(|label| format!("\n目录：{label}"))
        .unwrap_or_default();
    format!(
        "{}\n\nID：#{}{}\n摘要：{}\n\n回复时带 #{}，或直接引用任意带这个 ID 的消息，即可继续这个 CCEM 会话。",
        info.task_title, route_id, project, summary, route_id
    )
}

#[tauri::command]
fn debug_compare_sessions(
    unified_state: State<'_, Arc<UnifiedSessionManager>>,
) -> UnifiedSessionDebugComparison {
    unified_state.debug_compare_sessions()
}

#[tauri::command]
async fn create_native_session(
    app: tauri::AppHandle,
    native_state: State<'_, Arc<NativeRuntimeManager>>,
    provider: String,
    env_name: String,
    perm_mode: Option<String>,
    runtime_perm_mode: Option<String>,
    working_dir: Option<String>,
    initial_prompt: String,
    initial_display_prompt: Option<String>,
    initial_images: Option<Vec<PromptImage>>,
    provider_session_id: Option<String>,
    effort: Option<String>,
    seed_boundary_message_count: Option<u64>,
) -> Result<NativeSessionSummary, String> {
    let provider = parse_native_provider(&provider)?;
    let effective_working_dir = resolve_headless_working_dir(working_dir);
    let effective_perm_mode = resolve_effective_perm_mode(perm_mode);
    let effective_runtime_perm_mode = runtime_perm_mode
        .map(|mode| mode.trim().to_string())
        .filter(|mode| !mode.is_empty() && mode != &effective_perm_mode);
    let initial_images = initial_images.filter(|images| !images.is_empty());

    let options = match provider {
        NativeProvider::Claude => {
            let resolved = resolve_claude_env(&env_name)?;
            NativeSessionOptions {
                provider,
                env_name: resolved.env_name,
                perm_mode: effective_perm_mode,
                runtime_perm_mode: effective_runtime_perm_mode.clone(),
                working_dir: effective_working_dir,
                initial_prompt: Some(initial_prompt),
                display_prompt: initial_display_prompt.clone(),
                initial_images: initial_images.clone(),
                provider_session_id: provider_session_id.clone(),
                seed_boundary_message_count,
                helper_env_vars: resolved.env_vars.clone(),
                terminal_env_vars: resolved.env_vars,
                claude_path: terminal::resolve_claude_path(),
                codex_path: None,
                codex_base_url: None,
                codex_api_key: None,
                effort: effort.clone(),
            }
        }
        NativeProvider::Codex => {
            let resolved = resolve_codex_runtime(&env_name)?;
            let proxy_env_vars = system_proxy::resolve_codex_proxy_env();
            NativeSessionOptions {
                provider,
                env_name: if resolved.env_name.is_empty() {
                    env_name
                } else {
                    resolved.env_name
                },
                perm_mode: effective_perm_mode,
                runtime_perm_mode: effective_runtime_perm_mode,
                working_dir: effective_working_dir,
                initial_prompt: Some(initial_prompt),
                display_prompt: initial_display_prompt.clone(),
                initial_images: initial_images.clone(),
                provider_session_id: provider_session_id.clone(),
                seed_boundary_message_count,
                helper_env_vars: proxy_env_vars.clone(),
                terminal_env_vars: proxy_env_vars,
                claude_path: None,
                codex_path: terminal::resolve_codex_path(),
                codex_base_url: None,
                codex_api_key: None,
                effort,
            }
        }
    };

    let summary = native_state.create_session(app, options)?;

    if let Err(error) = register_launch(SessionProvenanceUpsert {
        ccem_session_id: summary.runtime_id.clone(),
        client: summary.provider.as_str().to_string(),
        env_name: summary.env_name.clone(),
        config_source: Some(DEFAULT_CONFIG_SOURCE.to_string()),
        working_dir: summary.project_dir.clone(),
        perm_mode: Some(summary.perm_mode.clone()),
        launch_mode: "native_sdk".to_string(),
        started_via: "desktop".to_string(),
        source_session_id: summary.provider_session_id.clone(),
    }) {
        eprintln!(
            "Failed to register native runtime launch provenance for {}: {}",
            summary.runtime_id, error
        );
    }

    Ok(summary)
}

#[tauri::command]
fn list_native_sessions(
    native_state: State<'_, Arc<NativeRuntimeManager>>,
) -> Vec<NativeSessionSummary> {
    native_state.list_sessions()
}

#[tauri::command]
fn send_native_session_input(
    app: tauri::AppHandle,
    native_state: State<'_, Arc<NativeRuntimeManager>>,
    runtime_id: String,
    text: String,
    display_text: Option<String>,
    images: Option<Vec<PromptImage>>,
) -> Result<(), String> {
    native_state.send_user_message(
        &app,
        &runtime_id,
        &text,
        display_text.as_deref(),
        images.as_ref(),
    )
}

#[tauri::command]
fn respond_native_session_permission(
    app: tauri::AppHandle,
    native_state: State<'_, Arc<NativeRuntimeManager>>,
    runtime_id: String,
    request_id: String,
    approved: bool,
) -> Result<(), String> {
    native_state.respond_to_permission(&app, &runtime_id, &request_id, approved)
}

#[tauri::command]
fn respond_native_session_prompt(
    app: tauri::AppHandle,
    native_state: State<'_, Arc<NativeRuntimeManager>>,
    runtime_id: String,
    tool_use_id: String,
    prompt_type: String,
    display_text: Option<String>,
    answers: HashMap<String, String>,
    annotations: Option<HashMap<String, InteractivePromptAnnotation>>,
) -> Result<(), String> {
    native_state.respond_to_prompt(
        &app,
        &runtime_id,
        &tool_use_id,
        &prompt_type,
        display_text.as_deref(),
        &answers,
        annotations.as_ref(),
    )
}

#[tauri::command]
fn rewind_native_session_files(
    app: tauri::AppHandle,
    native_state: State<'_, Arc<NativeRuntimeManager>>,
    runtime_id: String,
    checkpoint_id: String,
) -> Result<(), String> {
    native_state.rewind_files(&app, &runtime_id, &checkpoint_id)
}

#[tauri::command]
fn get_native_session_events(
    native_state: State<'_, Arc<NativeRuntimeManager>>,
    runtime_id: String,
    since_seq: Option<u64>,
    limit: Option<u64>,
) -> Result<event_bus::ReplayBatch, String> {
    native_state.replay_events_limited(&runtime_id, since_seq, limit)
}

#[tauri::command]
fn read_prompt_image_attachment(
    storage_path: String,
    media_type: String,
) -> Result<String, String> {
    PromptImageStore::default().read_data_url(&storage_path, &media_type)
}

#[tauri::command]
fn update_native_session_settings(
    app: tauri::AppHandle,
    native_state: State<'_, Arc<NativeRuntimeManager>>,
    runtime_id: String,
    env_name: Option<String>,
    perm_mode: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    let current = native_state
        .list_sessions()
        .into_iter()
        .find(|session| session.runtime_id == runtime_id)
        .ok_or_else(|| format!("Native runtime {} not found", runtime_id))?;
    let (resolved_env_name, env_vars) = match env_name.as_deref() {
        Some(name) if !name.trim().is_empty() => match current.provider {
            NativeProvider::Claude => {
                let resolved = resolve_claude_env(name)?;
                (Some(resolved.env_name), Some(resolved.env_vars))
            }
            NativeProvider::Codex => {
                let resolved = resolve_codex_runtime(name)?;
                let resolved_name = if resolved.env_name.is_empty() {
                    name.to_string()
                } else {
                    resolved.env_name
                };
                (
                    Some(resolved_name),
                    Some(system_proxy::resolve_codex_proxy_env()),
                )
            }
        },
        _ => (None, None),
    };
    native_state.update_session_settings(
        &app,
        &runtime_id,
        resolved_env_name.as_deref(),
        perm_mode.as_deref(),
        env_vars.as_ref(),
        effort.as_deref(),
    )
}

#[tauri::command]
fn set_native_session_runtime_perm_mode(
    app: tauri::AppHandle,
    native_state: State<'_, Arc<NativeRuntimeManager>>,
    runtime_id: String,
    runtime_perm_mode: Option<String>,
) -> Result<(), String> {
    native_state.update_session_runtime_perm_mode(&app, &runtime_id, runtime_perm_mode.as_deref())
}

#[tauri::command]
fn stop_native_session(
    native_state: State<'_, Arc<NativeRuntimeManager>>,
    runtime_id: String,
    source: Option<String>,
) -> Result<(), String> {
    native_state.stop_session_from(&runtime_id, source.as_deref())
}

#[tauri::command]
fn handoff_native_session_to_terminal(
    app: tauri::AppHandle,
    state: State<'_, Arc<SessionManager>>,
    interactive_state: State<'_, Arc<InteractiveRuntimeManager>>,
    native_state: State<'_, Arc<NativeRuntimeManager>>,
    browser_state: State<'_, Arc<BrowserManager>>,
    runtime_id: String,
    terminal_type: Option<TerminalType>,
) -> Result<NativeHandoffResult, String> {
    let handoff = match native_state.prepare_terminal_handoff(&runtime_id, terminal_type) {
        Ok(handoff) => handoff,
        Err(error) if error == "Session id is not ready for terminal handoff yet" => {
            return native_state.handoff_to_terminal(&runtime_id, terminal_type);
        }
        Err(error) => return Err(error),
    };

    let attach_terminal = attach_terminal_for_native_terminal(handoff.terminal);
    let session_manager = state.inner().clone();
    let create_result = interactive_state.create_session(
        app.clone(),
        session_manager,
        InteractiveSessionOptions {
            session_id: handoff.runtime_id.clone(),
            client: handoff.provider.as_str().to_string(),
            env_name: handoff.env_name.clone(),
            config_source: Some(DEFAULT_CONFIG_SOURCE.to_string()),
            perm_mode: handoff.perm_mode.clone(),
            working_dir: handoff.project_dir.clone(),
            resume_session_id: Some(handoff.resume_session_id.clone()),
            initial_prompt: None,
            env_vars: handoff.env_vars.clone(),
            launch_trace_id: format!("handoff-{}", handoff.runtime_id),
        },
    );

    let session = create_result?;

    if let Err(error) =
        open_tmux_backed_session_in_terminal(state.inner(), &session.id, attach_terminal)
    {
        let _ = interactive_state.stop_session(&session.id);
        state.remove_session(&session.id);
        return Err(error);
    }

    native_state.complete_managed_terminal_handoff(&handoff.runtime_id, handoff.terminal)?;
    if let Err(error) = browser_state.close(&app, Some(&handoff.runtime_id)) {
        eprintln!(
            "Failed to destroy preview browser for terminal handoff {}: {}",
            handoff.runtime_id, error
        );
    }

    if let Err(error) = register_launch(SessionProvenanceUpsert {
        ccem_session_id: session.id.clone(),
        client: session.client.clone(),
        env_name: session.env_name.clone(),
        config_source: session.config_source.clone(),
        working_dir: session.working_dir.clone(),
        perm_mode: Some(session.perm_mode.clone()),
        launch_mode: "interactive_handoff".to_string(),
        started_via: "desktop".to_string(),
        source_session_id: Some(handoff.resume_session_id.clone()),
    }) {
        eprintln!(
            "Failed to register native terminal handoff launch provenance for {}: {}",
            session.id, error
        );
    }

    if let Err(error) =
        clear_runtime_recovery_candidates_by_claude_session_id(&handoff.resume_session_id)
    {
        eprintln!(
            "Failed to clear recovery candidate for native handoff {}: {}",
            handoff.resume_session_id, error
        );
    }

    Ok(NativeHandoffResult {
        status: native_runtime::NativeHandoffStatus::Opened,
    })
}

#[tauri::command]
fn launch_opencode_web(
    working_dir: Option<String>,
    env_name: Option<String>,
) -> Result<(), String> {
    let effective_working_dir = resolve_headless_working_dir(working_dir);
    let opencode_path = terminal::resolve_opencode_path()
        .ok_or_else(|| "OpenCode CLI is not installed".to_string())?;
    let resolved = env_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .map(resolve_opencode_runtime)
        .transpose()?;

    let mut command = Command::new(opencode_path);
    command.arg("web").current_dir(&effective_working_dir);
    if let Some(runtime) = resolved {
        command.envs(runtime.env_vars);
    }

    command
        .spawn()
        .map_err(|error| format!("Failed to launch OpenCode Web UI: {}", error))?;
    Ok(())
}

#[tauri::command]
async fn create_interactive_session(
    app: tauri::AppHandle,
    state: State<'_, Arc<SessionManager>>,
    interactive_state: State<'_, Arc<InteractiveRuntimeManager>>,
    proxy_state: State<'_, Arc<ProxyDebugManager>>,
    env_name: String,
    perm_mode: Option<String>,
    working_dir: Option<String>,
    resume_session_id: Option<String>,
    client: Option<String>,
    initial_prompt: Option<String>,
    launch_trace_id: Option<String>,
) -> Result<Session, String> {
    let trace_id = launch_trace_id
        .unwrap_or_else(|| format!("backend-{}", chrono::Utc::now().timestamp_millis()));
    let client_name = client
        .unwrap_or_else(|| "claude".to_string())
        .to_lowercase();
    diagnostic_log::append_session_launch_event(
        "backend.create_interactive_session.entry",
        serde_json::json!({
            "trace_id": &trace_id,
            "client": &client_name,
            "env_name": &env_name,
            "perm_mode": &perm_mode,
            "working_dir": &working_dir,
            "resume": resume_session_id.as_ref().is_some_and(|value| !value.trim().is_empty()),
            "initial_prompt": initial_prompt.as_ref().is_some_and(|value| !value.trim().is_empty()),
        }),
    );
    if client_name != "claude" && client_name != "codex" && client_name != "opencode" {
        diagnostic_log::append_session_launch_event(
            "backend.create_interactive_session.unsupported_client",
            serde_json::json!({
                "trace_id": &trace_id,
                "client": &client_name,
            }),
        );
        return Err(format!("Unsupported client '{}'", client_name));
    }

    if tmux::TmuxManager::check_tmux_installed().is_err() {
        println!(
            "tmux unavailable, falling back to external terminal launch for {}",
            client_name
        );
        return launch_claude_code(
            state,
            proxy_state,
            env_name,
            perm_mode,
            working_dir,
            resume_session_id,
            Some(client_name),
        )
        .await;
    }

    if client_name == "codex"
        && !resume_session_id
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
        && resume_session_id.is_some()
    {
        let session_id = generate_session_id();
        let effective_working_dir = resolve_headless_working_dir(working_dir);
        let mut env_vars = HashMap::new();
        let resume_target = resume_session_id.clone();
        let started_at = chrono::Utc::now();

        if proxy_state.is_enabled() {
            let proxy_route_base_url = proxy_state
                .register_route(RegisterRouteRequest {
                    session_id: session_id.clone(),
                    client: client_name.clone(),
                    env_name: env_name.clone(),
                    upstream_base_url: proxy_state.codex_upstream_base_url(),
                })
                .await?;
            env_vars.insert("OPENAI_BASE_URL".to_string(), proxy_route_base_url);
        }

        let session_manager = state.inner().clone();
        let create_result = interactive_state.create_session(
            app,
            session_manager,
            InteractiveSessionOptions {
                session_id: session_id.clone(),
                client: client_name.clone(),
                env_name,
                config_source: Some(DEFAULT_CONFIG_SOURCE.to_string()),
                perm_mode: "n/a".to_string(),
                working_dir: effective_working_dir,
                resume_session_id,
                initial_prompt: initial_prompt.clone(),
                env_vars,
                launch_trace_id: trace_id.clone(),
            },
        );

        if create_result.is_err() {
            proxy_state.remove_session_routes(&session_id);
        }

        let session = match create_result {
            Ok(session) => session,
            Err(error) => {
                diagnostic_log::append_session_launch_event(
                    "backend.create_interactive_session.error",
                    serde_json::json!({
                        "trace_id": &trace_id,
                        "session_id": &session_id,
                        "client": &client_name,
                        "error": &error,
                    }),
                );
                return Err(error);
            }
        };
        diagnostic_log::append_session_launch_event(
            "backend.create_interactive_session.ok",
            serde_json::json!({
                "trace_id": &trace_id,
                "session_id": &session.id,
                "client": &session.client,
                "tmux_target": &session.tmux_target,
            }),
        );
        if let Err(error) = register_launch(SessionProvenanceUpsert {
            ccem_session_id: session.id.clone(),
            client: session.client.clone(),
            env_name: session.env_name.clone(),
            config_source: session.config_source.clone(),
            working_dir: session.working_dir.clone(),
            perm_mode: Some(session.perm_mode.clone()),
            launch_mode: "interactive".to_string(),
            started_via: "desktop".to_string(),
            source_session_id: resume_target.clone(),
        }) {
            eprintln!(
                "Failed to register desktop interactive launch provenance for {}: {}",
                session.id, error
            );
        }
        spawn_codex_source_binding(
            session.id.clone(),
            session.working_dir.clone(),
            started_at,
            resume_target.clone(),
        );
        if let Some(session_id) = resume_target.as_deref() {
            if let Err(error) = clear_runtime_recovery_candidates_by_claude_session_id(session_id) {
                eprintln!(
                    "Failed to clear recovery candidate for resumed interactive session {}: {}",
                    session_id, error
                );
            }
        }

        return Ok(session);
    }

    if client_name == "codex" {
        return launch_claude_code(
            state,
            proxy_state,
            env_name,
            perm_mode,
            working_dir,
            resume_session_id,
            Some(client_name),
        )
        .await;
    }

    if client_name == "opencode" {
        let session_id = generate_session_id();
        let resolved = resolve_opencode_runtime(&env_name)?;
        let resolved_env_name = resolved.env_name.clone();
        let resolved_config_source = resolved.config_source.clone();
        let effective_working_dir = resolve_headless_working_dir(working_dir);
        let resume_target = resume_session_id.clone();
        let before_session_ids = snapshot_known_session_ids();
        let env_vars = resolved.env_vars;

        if proxy_state.is_enabled() {
            println!("OpenCode interactive sessions ignore proxy debug routing");
        }

        let session_manager = state.inner().clone();
        let create_result = interactive_state.create_session(
            app,
            session_manager,
            InteractiveSessionOptions {
                session_id: session_id.clone(),
                client: client_name.clone(),
                env_name: resolved_env_name.clone(),
                config_source: Some(resolved_config_source.clone()),
                perm_mode: "n/a".to_string(),
                working_dir: effective_working_dir.clone(),
                resume_session_id,
                initial_prompt: initial_prompt.clone(),
                env_vars,
                launch_trace_id: trace_id.clone(),
            },
        );

        let session = match create_result {
            Ok(session) => session,
            Err(error) => {
                diagnostic_log::append_session_launch_event(
                    "backend.create_interactive_session.error",
                    serde_json::json!({
                        "trace_id": &trace_id,
                        "session_id": &session_id,
                        "client": &client_name,
                        "error": &error,
                    }),
                );
                return Err(error);
            }
        };
        diagnostic_log::append_session_launch_event(
            "backend.create_interactive_session.ok",
            serde_json::json!({
                "trace_id": &trace_id,
                "session_id": &session.id,
                "client": &session.client,
                "tmux_target": &session.tmux_target,
            }),
        );
        if let Err(error) = register_launch(SessionProvenanceUpsert {
            ccem_session_id: session.id.clone(),
            client: session.client.clone(),
            env_name: session.env_name.clone(),
            config_source: session.config_source.clone(),
            working_dir: session.working_dir.clone(),
            perm_mode: Some(session.perm_mode.clone()),
            launch_mode: "interactive".to_string(),
            started_via: "desktop".to_string(),
            source_session_id: resume_target.clone(),
        }) {
            eprintln!(
                "Failed to register desktop interactive launch provenance for {}: {}",
                session.id, error
            );
        }
        track_launched_session(
            before_session_ids,
            resolved_env_name,
            resolved_config_source,
            effective_working_dir.clone(),
            resume_target.clone(),
            Some(session.id.clone()),
        );
        if let Some(session_id) = resume_target.as_deref() {
            if let Err(error) = clear_runtime_recovery_candidates_by_claude_session_id(session_id) {
                eprintln!(
                    "Failed to clear recovery candidate for resumed interactive session {}: {}",
                    session_id, error
                );
            }
        }

        return Ok(session);
    }

    let session_id = generate_session_id();
    let resolved = resolve_claude_env(&env_name)?;
    let effective_working_dir = resolve_headless_working_dir(working_dir);
    let effective_perm_mode = resolve_effective_perm_mode(perm_mode);
    let mut env_vars = resolved.env_vars;
    let resume_target = resume_session_id.clone();

    if proxy_state.is_enabled() {
        let upstream_base_url = resolved
            .upstream_base_url
            .clone()
            .unwrap_or_else(|| "https://api.anthropic.com".to_string());
        let proxy_route_base_url = proxy_state
            .register_route(RegisterRouteRequest {
                session_id: session_id.clone(),
                client: client_name.clone(),
                env_name: resolved.env_name.clone(),
                upstream_base_url,
            })
            .await?;
        env_vars.insert("ANTHROPIC_BASE_URL".to_string(), proxy_route_base_url);
    }

    let session_manager = state.inner().clone();
    let create_result = interactive_state.create_session(
        app,
        session_manager,
        InteractiveSessionOptions {
            session_id: session_id.clone(),
            client: client_name.clone(),
            env_name: resolved.env_name,
            config_source: Some(DEFAULT_CONFIG_SOURCE.to_string()),
            perm_mode: effective_perm_mode,
            working_dir: effective_working_dir,
            resume_session_id,
            initial_prompt,
            env_vars,
            launch_trace_id: trace_id.clone(),
        },
    );

    if create_result.is_err() {
        proxy_state.remove_session_routes(&session_id);
    }

    let session = match create_result {
        Ok(session) => session,
        Err(error) => {
            diagnostic_log::append_session_launch_event(
                "backend.create_interactive_session.error",
                serde_json::json!({
                    "trace_id": &trace_id,
                    "session_id": &session_id,
                    "client": &client_name,
                    "error": &error,
                }),
            );
            return Err(error);
        }
    };
    diagnostic_log::append_session_launch_event(
        "backend.create_interactive_session.ok",
        serde_json::json!({
            "trace_id": &trace_id,
            "session_id": &session.id,
            "client": &session.client,
            "tmux_target": &session.tmux_target,
        }),
    );
    if let Err(error) = register_launch(SessionProvenanceUpsert {
        ccem_session_id: session.id.clone(),
        client: session.client.clone(),
        env_name: session.env_name.clone(),
        config_source: session.config_source.clone(),
        working_dir: session.working_dir.clone(),
        perm_mode: Some(session.perm_mode.clone()),
        launch_mode: "interactive".to_string(),
        started_via: "desktop".to_string(),
        source_session_id: resume_target.clone(),
    }) {
        eprintln!(
            "Failed to register desktop interactive launch provenance for {}: {}",
            session.id, error
        );
    }
    if let Some(session_id) = resume_target.as_deref() {
        if let Err(error) = clear_runtime_recovery_candidates_by_claude_session_id(session_id) {
            eprintln!(
                "Failed to clear recovery candidate for resumed interactive session {}: {}",
                session_id, error
            );
        }
    }

    Ok(session)
}

#[tauri::command]
fn list_runtime_recovery_candidates() -> Result<Vec<RuntimeRecoveryCandidate>, String> {
    list_runtime_recovery_candidates_entries().map_err(|error| error.to_string())
}

#[tauri::command]
fn record_session_launch_trace(event: String, details: Option<serde_json::Value>) {
    diagnostic_log::append_session_launch_event(
        &format!("frontend.{}", event),
        details.unwrap_or_else(|| serde_json::json!({})),
    );
}

#[tauri::command]
fn get_session_launch_log_path() -> String {
    diagnostic_log::launch_log_path()
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
fn dismiss_runtime_recovery_candidate(runtime_id: String) -> Result<(), String> {
    dismiss_runtime_recovery_candidate_entry(&runtime_id).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_interactive_sessions(state: State<'_, Arc<SessionManager>>) -> Vec<Session> {
    list_sessions(state)
}

fn session_terminal_window_type(session: &Session) -> Option<TerminalType> {
    match session.terminal_type.as_deref() {
        Some("iterm2") => Some(TerminalType::ITerm2),
        Some("terminalapp") => Some(TerminalType::TerminalApp),
        _ => None,
    }
}

fn session_has_window_control(session: &Session) -> bool {
    session_terminal_window_type(session).is_some()
        && session
            .window_id
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty())
}

fn attach_terminal_for_native_terminal(terminal: TerminalType) -> TmuxAttachTerminalType {
    match terminal {
        TerminalType::TerminalApp => TmuxAttachTerminalType::TerminalApp,
        TerminalType::ITerm2 => TmuxAttachTerminalType::ITerm2,
    }
}

fn open_tmux_backed_session_in_terminal(
    state: &Arc<SessionManager>,
    session_id: &str,
    attach_terminal: TmuxAttachTerminalType,
) -> Result<(), String> {
    let session = state
        .get_session(session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;

    if !session.is_tmux_backed() {
        return Err(
            "Only tmux-backed interactive sessions can be opened in a new terminal".to_string(),
        );
    }

    if session.status != "running" {
        return Err(format!("Interactive session {} is not running", session_id));
    }

    let persisted_target = session.resolved_tmux_target();
    let target = match tmux::TmuxManager::default()
        .resolve_live_attach_target(session_id, persisted_target)
    {
        Ok(target) => target,
        Err(error) => {
            state.update_session_status(session_id, "stopped");
            return Err(format!(
                "Interactive session {} is no longer available: {}",
                session_id, error
            ));
        }
    };

    let (window_id, iterm_session_id) =
        terminal::open_tmux_target_in_attach_terminal(attach_terminal, &target)?;

    match attach_terminal {
        TmuxAttachTerminalType::TerminalApp => {
            state.attach_tmux_terminal(session_id, "terminalapp", window_id.as_deref(), None);
        }
        TmuxAttachTerminalType::ITerm2 => {
            state.attach_tmux_terminal(
                session_id,
                "iterm2",
                window_id.as_deref(),
                iterm_session_id.as_deref(),
            );
        }
        TmuxAttachTerminalType::Ghostty => {}
    }

    Ok(())
}

#[tauri::command]
fn stop_interactive_session(
    state: State<'_, Arc<SessionManager>>,
    interactive_state: State<'_, Arc<InteractiveRuntimeManager>>,
    proxy_state: State<'_, Arc<ProxyDebugManager>>,
    session_id: String,
) -> Result<(), String> {
    if state
        .get_session(&session_id)
        .is_some_and(|session| session.is_tmux_backed())
    {
        interactive_state.stop_session(&session_id)?;
        state.update_session_status(&session_id, "stopped");
        proxy_state.remove_session_routes(&session_id);
        return Ok(());
    }

    stop_session(state, proxy_state, session_id)
}

#[tauri::command]
fn focus_interactive_session(
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<(), String> {
    if let Some(session) = state.get_session(&session_id) {
        if session.is_tmux_backed() {
            if session_has_window_control(&session) {
                return focus_session(state, session_id);
            }
            return Ok(());
        }
    }

    focus_session(state, session_id)
}

#[tauri::command]
fn open_interactive_session_in_terminal(
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
    terminal_type: Option<TmuxAttachTerminalType>,
) -> Result<(), String> {
    let attach_terminal =
        terminal_type.unwrap_or_else(|| match terminal::get_preferred_terminal() {
            TerminalType::TerminalApp => TmuxAttachTerminalType::TerminalApp,
            TerminalType::ITerm2 => TmuxAttachTerminalType::ITerm2,
        });
    open_tmux_backed_session_in_terminal(state.inner(), &session_id, attach_terminal)
}

#[tauri::command]
fn close_interactive_session(
    state: State<'_, Arc<SessionManager>>,
    interactive_state: State<'_, Arc<InteractiveRuntimeManager>>,
    proxy_state: State<'_, Arc<ProxyDebugManager>>,
    session_id: String,
) -> Result<(), String> {
    if let Some(session) = state.get_session(&session_id) {
        if session.is_tmux_backed() {
            if session_has_window_control(&session) {
                if let (Some(term_type), Some(window_id)) = (
                    session_terminal_window_type(&session),
                    session.window_id.as_deref(),
                ) {
                    let _ = terminal::close_terminal_session(term_type, window_id);
                }
            }

            let _ = interactive_state.stop_session(&session_id);
            interactive_state.remove_session(&session_id);
            cleanup_exit_file(&session_id);
            state.remove_session(&session_id);
            proxy_state.remove_session_routes(&session_id);
            return Ok(());
        }
    }

    close_session(state, proxy_state, session_id)
}

/// Close a unified interactive session with full cleanup.
///
/// Unlike `stop_unified_session` (which only stops the runtime but leaves the
/// handle/records intact), this command mirrors `close_interactive_session`
/// semantics: stop runtime, remove handle, clean exit file, remove persisted
/// session, and clear proxy routes. It succeeds even when the legacy
/// `SessionManager` record is absent, as long as an interactive runtime
/// handle existed.
#[tauri::command]
fn close_unified_interactive_session(
    state: State<'_, Arc<SessionManager>>,
    interactive_state: State<'_, Arc<InteractiveRuntimeManager>>,
    proxy_state: State<'_, Arc<ProxyDebugManager>>,
    runtime_id: String,
) -> Result<(), String> {
    let interactive_exists = interactive_state.summary(&runtime_id).is_some();

    if !interactive_exists {
        return Err(format!(
            "Unified interactive session not found: {}",
            runtime_id
        ));
    }

    // Best-effort: close external terminal window if we have legacy metadata.
    if let Some(session) = state.get_session(&runtime_id) {
        if session.is_tmux_backed() && session_has_window_control(&session) {
            if let (Some(term_type), Some(window_id)) = (
                session_terminal_window_type(&session),
                session.window_id.as_deref(),
            ) {
                let _ = terminal::close_terminal_session(term_type, window_id);
            }
        }
    }

    // Best-effort stop — ok if it fails because the session was already stopped.
    let _ = interactive_state.stop_session(&runtime_id);
    interactive_state.remove_session(&runtime_id);
    cleanup_exit_file(&runtime_id);
    state.remove_session(&runtime_id);
    proxy_state.remove_session_routes(&runtime_id);

    Ok(())
}

#[tauri::command]
fn minimize_interactive_session(
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<(), String> {
    if let Some(session) = state.get_session(&session_id) {
        if session.is_tmux_backed() {
            if session_has_window_control(&session) {
                return minimize_session(state, session_id);
            }
            return Ok(());
        }
    }

    minimize_session(state, session_id)
}

#[tauri::command]
fn write_interactive_input(
    interactive_state: State<'_, Arc<InteractiveRuntimeManager>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    interactive_state.write_input(&session_id, &data)
}

#[tauri::command]
fn send_interactive_input(
    interactive_state: State<'_, Arc<InteractiveRuntimeManager>>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    interactive_state.send_message(&session_id, &text)
}

#[tauri::command]
fn send_interactive_approval(
    interactive_state: State<'_, Arc<InteractiveRuntimeManager>>,
    session_id: String,
    approved: bool,
) -> Result<(), String> {
    interactive_state.send_approval(&session_id, approved)
}

#[tauri::command]
fn get_interactive_session_output(
    interactive_state: State<'_, Arc<InteractiveRuntimeManager>>,
    session_id: String,
    since_seq: Option<u64>,
) -> Result<InteractiveReplayBatch, String> {
    interactive_state.replay_output(&session_id, since_seq)
}

#[tauri::command]
fn get_interactive_session_events(
    interactive_state: State<'_, Arc<InteractiveRuntimeManager>>,
    session_id: String,
    since_seq: Option<u64>,
) -> Result<event_bus::ReplayBatch, String> {
    interactive_state.replay_events(&session_id, since_seq)
}

#[tauri::command]
fn get_interactive_state(
    interactive_state: State<'_, Arc<InteractiveRuntimeManager>>,
    session_id: String,
) -> Result<ClaudeTerminalState, String> {
    interactive_state.get_state(&session_id)
}

#[tauri::command]
fn resize_interactive_session(
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
    _cols: u16,
    _rows: u16,
) -> Result<(), String> {
    let _ = state
        .get_session(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;
    Ok(())
}

#[tauri::command]
fn list_sessions(state: State<Arc<SessionManager>>) -> Vec<Session> {
    state.list_sessions()
}

#[tauri::command]
fn stop_session(
    state: State<Arc<SessionManager>>,
    proxy_state: State<Arc<ProxyDebugManager>>,
    session_id: String,
) -> Result<(), String> {
    let session = state
        .get_session(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    if let Some(pid) = session.pid {
        #[cfg(unix)]
        {
            Command::new("kill")
                .arg("-15")
                .arg(pid.to_string())
                .output()
                .map_err(|e| format!("Failed to stop process: {}", e))?;
        }

        #[cfg(windows)]
        {
            Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .output()
                .map_err(|e| format!("Failed to stop process: {}", e))?;
        }
    }

    state.update_session_status(&session_id, "stopped");
    proxy_state.remove_session_routes(&session_id);
    Ok(())
}

#[tauri::command]
fn remove_session(
    state: State<Arc<SessionManager>>,
    interactive_state: State<Arc<InteractiveRuntimeManager>>,
    proxy_state: State<Arc<ProxyDebugManager>>,
    session_id: String,
) {
    if state
        .get_session(&session_id)
        .is_some_and(|session| session.is_tmux_backed())
    {
        interactive_state.remove_session(&session_id);
    }

    // Clean up exit file when removing session
    cleanup_exit_file(&session_id);
    state.remove_session(&session_id);
    proxy_state.remove_session_routes(&session_id);
}

#[tauri::command]
fn focus_session(state: State<Arc<SessionManager>>, session_id: String) -> Result<(), String> {
    let session = state
        .get_session(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    let terminal_type = session
        .terminal_type
        .as_ref()
        .ok_or("Session has no terminal type")?;
    let window_id = session
        .window_id
        .as_ref()
        .ok_or("Session has no window ID")?;

    let term_type = match terminal_type.as_str() {
        "iterm2" => TerminalType::ITerm2,
        "terminalapp" => TerminalType::TerminalApp,
        _ => return Err(format!("Unknown terminal type: {}", terminal_type)),
    };

    terminal::focus_terminal_window(term_type, window_id)
}

#[tauri::command]
fn close_session(
    state: State<Arc<SessionManager>>,
    proxy_state: State<Arc<ProxyDebugManager>>,
    session_id: String,
) -> Result<(), String> {
    let session = state
        .get_session(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    let terminal_type = session
        .terminal_type
        .as_ref()
        .ok_or("Session has no terminal type")?;
    let window_id = session
        .window_id
        .as_ref()
        .ok_or("Session has no window ID")?;

    let term_type = match terminal_type.as_str() {
        "iterm2" => TerminalType::ITerm2,
        "terminalapp" => TerminalType::TerminalApp,
        _ => return Err(format!("Unknown terminal type: {}", terminal_type)),
    };

    terminal::close_terminal_session(term_type, window_id)?;

    // Clean up and remove session after closing
    cleanup_exit_file(&session_id);
    state.remove_session(&session_id);
    proxy_state.remove_session_routes(&session_id);
    Ok(())
}

#[tauri::command]
fn minimize_session(state: State<Arc<SessionManager>>, session_id: String) -> Result<(), String> {
    let session = state
        .get_session(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    let terminal_type = session
        .terminal_type
        .as_ref()
        .ok_or("Session has no terminal type")?;
    let window_id = session
        .window_id
        .as_ref()
        .ok_or("Session has no window ID")?;

    let term_type = match terminal_type.as_str() {
        "iterm2" => TerminalType::ITerm2,
        "terminalapp" => TerminalType::TerminalApp,
        _ => return Err(format!("Unknown terminal type: {}", terminal_type)),
    };

    terminal::minimize_terminal_window(term_type, window_id)
}

// ============================================
// Arrange Windows Commands
// ============================================

#[derive(Debug, serde::Deserialize)]
struct ArrangeRequest {
    session_ids: Vec<String>,
    layout: ArrangeLayout,
}

#[tauri::command]
fn arrange_sessions(
    state: State<Arc<SessionManager>>,
    request: ArrangeRequest,
) -> Result<String, String> {
    let sessions = state.list_sessions();

    // Collect the requested sessions, verify they're running
    let mut arrange_infos: Vec<ArrangeSessionInfo> = Vec::new();
    let mut terminal_type: Option<TerminalType> = None;

    for sid in &request.session_ids {
        let session = sessions
            .iter()
            .find(|s| &s.id == sid)
            .ok_or_else(|| format!("Session not found: {}", sid))?;

        if session.status != "running" {
            return Err(format!("Session {} is not running", sid));
        }

        let term_type_str = session
            .terminal_type
            .as_ref()
            .ok_or_else(|| format!("Session {} has no terminal type", sid))?;
        let term_type = match term_type_str.as_str() {
            "iterm2" => TerminalType::ITerm2,
            "terminalapp" => TerminalType::TerminalApp,
            _ => return Err(format!("Unknown terminal type: {}", term_type_str)),
        };

        // All sessions must be the same terminal type
        if let Some(ref expected) = terminal_type {
            if *expected != term_type {
                return Err("Cannot arrange sessions from different terminal types".to_string());
            }
        } else {
            terminal_type = Some(term_type);
        }

        let window_id = session
            .window_id
            .clone()
            .ok_or_else(|| format!("Session {} has no window ID", sid))?;

        // For iTerm2, try to get session ID (backfill if missing)
        let iterm_session_id = if term_type == TerminalType::ITerm2 {
            match &session.iterm_session_id {
                Some(id) => Some(id.clone()),
                None => {
                    // Try to backfill from iTerm2
                    match terminal::get_iterm_session_id(&window_id) {
                        Ok(id) => {
                            // Update the session manager with the backfilled ID
                            state.update_session_iterm_id(sid, &id);
                            Some(id)
                        }
                        Err(e) => {
                            eprintln!(
                                "Warning: could not backfill iTerm2 session ID for {}: {}",
                                sid, e
                            );
                            None
                        }
                    }
                }
            }
        } else {
            None
        };

        arrange_infos.push(ArrangeSessionInfo {
            window_id,
            iterm_session_id,
        });
    }

    let term = terminal_type.ok_or("No sessions to arrange")?;

    // Perform the arrangement
    let result = terminal::arrange_sessions(term, &arrange_infos, &request.layout)?;

    // For iTerm2, update all sessions with the new shared window ID
    if term == TerminalType::ITerm2 && result != "arranged" {
        for sid in &request.session_ids {
            state.update_session_window_id(sid, &result);
        }
    }

    Ok(result)
}

#[tauri::command]
fn check_arrange_support() -> Result<bool, String> {
    terminal::check_arrange_support()
}

// ============================================
// Directory & VS Code Sync Commands
// ======================================================

#[tauri::command]
async fn open_directory_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    if let Some(path) = std::env::var("CCEM_TEST_DIRECTORY_PICKER_PATH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return Ok(Some(path));
    }

    let (tx, rx) = std::sync::mpsc::channel();

    app.dialog().file().pick_folder(move |folder_path| {
        let _ = tx.send(folder_path.map(|p| p.to_string()));
    });

    rx.recv().map_err(|e| format!("Dialog error: {}", e))
}

#[tauri::command]
fn sync_vscode_projects() -> Result<Vec<VSCodeProject>, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let storage_path =
        home.join("Library/Application Support/Code/User/globalStorage/storage.json");

    if !storage_path.exists() {
        return Ok(vec![]);
    }

    let content = std::fs::read_to_string(&storage_path)
        .map_err(|e| format!("Failed to read VS Code storage: {}", e))?;

    // Parse the JSON
    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse VS Code storage: {}", e))?;

    let mut projects = Vec::new();
    let mut seen_paths = std::collections::HashSet::new();
    let now = chrono::Utc::now().to_rfc3339();

    // Helper function to recursively extract openRecentFolder items
    fn extract_recent_folders(
        value: &serde_json::Value,
        projects: &mut Vec<VSCodeProject>,
        seen_paths: &mut std::collections::HashSet<String>,
        now: &str,
    ) {
        match value {
            serde_json::Value::Object(map) => {
                // Check if this is an openRecentFolder entry with uri.path
                if let Some(id) = map.get("id").and_then(|v| v.as_str()) {
                    if id == "openRecentFolder" {
                        if let Some(path) = map
                            .get("uri")
                            .and_then(|u| u.get("path"))
                            .and_then(|p| p.as_str())
                        {
                            if !seen_paths.contains(path) {
                                seen_paths.insert(path.to_string());
                                projects.push(VSCodeProject {
                                    path: path.to_string(),
                                    synced_at: now.to_string(),
                                });
                            }
                        }
                    }
                }
                // Recurse into all values
                for v in map.values() {
                    extract_recent_folders(v, projects, seen_paths, now);
                }
            }
            serde_json::Value::Array(arr) => {
                for item in arr {
                    extract_recent_folders(item, projects, seen_paths, now);
                }
            }
            _ => {}
        }
    }

    extract_recent_folders(&json, &mut projects, &mut seen_paths, &now);

    // Update app config with synced projects
    let mut cfg = config::read_app_config()?;
    cfg.vscode_projects = projects.clone();
    config::write_app_config(&cfg)?;

    Ok(projects)
}

#[tauri::command]
fn sync_jetbrains_projects() -> Result<Vec<JetBrainsProject>, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let jetbrains_dir = home.join("Library/Application Support/JetBrains");

    if !jetbrains_dir.exists() {
        return Ok(vec![]);
    }

    let mut projects = Vec::new();
    let mut seen_paths = std::collections::HashSet::new();
    let now = chrono::Utc::now().to_rfc3339();

    // Map directory prefixes to IDE names
    let ide_prefixes = [
        ("WebStorm", "WebStorm"),
        ("IntelliJIdea", "IntelliJ IDEA"),
        ("PyCharm", "PyCharm"),
        ("GoLand", "GoLand"),
        ("RustRover", "RustRover"),
        ("CLion", "CLion"),
        ("PhpStorm", "PhpStorm"),
        ("Rider", "Rider"),
        ("DataGrip", "DataGrip"),
        ("RubyMine", "RubyMine"),
        ("AppCode", "AppCode"),
        ("AndroidStudio", "Android Studio"),
    ];

    // Iterate through JetBrains directories
    if let Ok(entries) = std::fs::read_dir(&jetbrains_dir) {
        for entry in entries.flatten() {
            let dir_name = entry.file_name().to_string_lossy().to_string();

            // Find matching IDE
            let ide_name = ide_prefixes
                .iter()
                .find(|(prefix, _)| dir_name.starts_with(prefix))
                .map(|(_, name)| *name);

            if let Some(ide) = ide_name {
                let recent_path = entry.path().join("options/recentProjects.xml");

                if recent_path.exists() {
                    if let Ok(content) = std::fs::read_to_string(&recent_path) {
                        // Parse XML to extract project paths
                        extract_jetbrains_projects(
                            &content,
                            ide,
                            &mut projects,
                            &mut seen_paths,
                            &now,
                        );
                    }
                }
            }
        }
    }

    // Update app config with synced projects
    let mut cfg = config::read_app_config()?;
    cfg.jetbrains_projects = projects.clone();
    config::write_app_config(&cfg)?;

    Ok(projects)
}

/// Extract project paths from JetBrains recentProjects.xml
fn extract_jetbrains_projects(
    xml_content: &str,
    ide: &str,
    projects: &mut Vec<JetBrainsProject>,
    seen_paths: &mut std::collections::HashSet<String>,
    now: &str,
) {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml_content);

    let mut buf = Vec::new();
    let mut in_recent_project_manager = false;
    let mut in_additional_info = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let name = e.name();
                let name_str = std::str::from_utf8(name.as_ref()).unwrap_or("");

                if name_str == "component" {
                    // Check if this is RecentProjectsManager
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"name" {
                            let value = String::from_utf8_lossy(&attr.value);
                            if value == "RecentProjectsManager" {
                                in_recent_project_manager = true;
                            }
                        }
                    }
                } else if name_str == "map" && in_recent_project_manager {
                    // We're in the additionalInfo map
                    in_additional_info = true;
                } else if name_str == "entry" && in_additional_info {
                    // Extract project path from key attribute
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"key" {
                            let value = String::from_utf8_lossy(&attr.value);
                            // Path format: $USER_HOME$/path/to/project
                            let path = value.replace(
                                "$USER_HOME$",
                                &dirs::home_dir()
                                    .map(|p| p.to_string_lossy().to_string())
                                    .unwrap_or_else(|| "~".to_string()),
                            );

                            if !seen_paths.contains(&path) && std::path::Path::new(&path).exists() {
                                seen_paths.insert(path.clone());
                                projects.push(JetBrainsProject {
                                    path,
                                    ide: ide.to_string(),
                                    synced_at: now.to_string(),
                                });
                            }
                        }
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let name_bytes = e.name();
                let name = std::str::from_utf8(name_bytes.as_ref()).unwrap_or("");
                if name == "component" {
                    in_recent_project_manager = false;
                    in_additional_info = false;
                } else if name == "map" {
                    in_additional_info = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
}

// ============================================
// Remote Environment Loading Commands
// ============================================

#[tauri::command]
fn check_ccem_installed() -> bool {
    terminal::is_ccem_installed()
}

#[tauri::command]
fn check_claude_installed() -> bool {
    terminal::is_claude_installed()
}

#[tauri::command]
fn check_codex_installed() -> bool {
    terminal::is_codex_installed()
}

#[tauri::command]
fn check_opencode_installed() -> bool {
    terminal::is_opencode_installed()
}

#[tauri::command]
fn check_tmux_installed() -> bool {
    if !terminal::tmux_supported_on_current_platform() {
        return false;
    }

    tmux::TmuxManager::check_tmux_installed().is_ok()
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformCapabilities {
    os: &'static str,
    is_windows: bool,
    is_macos: bool,
    is_linux: bool,
    tmux_supported: bool,
    tmux_installed: bool,
    interactive_tmux_supported: bool,
    external_terminal_launch_supported: bool,
    native_runtime_supported: bool,
    headless_runtime_supported: bool,
    tmux_install_command: Option<&'static str>,
}

fn current_os_label() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

fn tmux_install_command_for_current_platform() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        Some("brew install tmux")
    } else if cfg!(target_os = "linux") {
        Some("sudo apt install tmux")
    } else {
        None
    }
}

#[tauri::command]
fn get_platform_capabilities() -> PlatformCapabilities {
    let tmux_supported = terminal::tmux_supported_on_current_platform();
    let tmux_installed = if tmux_supported {
        tmux::TmuxManager::check_tmux_installed().is_ok()
    } else {
        false
    };

    PlatformCapabilities {
        os: current_os_label(),
        is_windows: cfg!(target_os = "windows"),
        is_macos: cfg!(target_os = "macos"),
        is_linux: cfg!(target_os = "linux"),
        tmux_supported,
        tmux_installed,
        interactive_tmux_supported: tmux_supported && tmux_installed,
        external_terminal_launch_supported: terminal::external_terminal_launch_supported(),
        native_runtime_supported: true,
        headless_runtime_supported: true,
        tmux_install_command: tmux_install_command_for_current_platform(),
    }
}

#[derive(Debug, serde::Deserialize)]
struct RemoteResponse {
    encrypted: String,
}

#[derive(Debug, serde::Deserialize)]
struct RemoteEnvConfig {
    #[serde(rename = "ANTHROPIC_BASE_URL")]
    base_url: Option<String>,
    #[serde(rename = "ANTHROPIC_AUTH_TOKEN")]
    auth_token: Option<String>,
    #[serde(rename = "ANTHROPIC_API_KEY")]
    api_key: Option<String>,
    #[serde(rename = "ANTHROPIC_DEFAULT_OPUS_MODEL")]
    default_opus_model: Option<String>,
    #[serde(rename = "ANTHROPIC_DEFAULT_SONNET_MODEL")]
    default_sonnet_model: Option<String>,
    #[serde(rename = "ANTHROPIC_DEFAULT_HAIKU_MODEL")]
    default_haiku_model: Option<String>,
    #[serde(rename = "ANTHROPIC_MODEL")]
    model: Option<String>,
    #[serde(rename = "ANTHROPIC_SMALL_FAST_MODEL")]
    small_fast_model: Option<String>,
    #[serde(rename = "CLAUDE_CODE_SUBAGENT_MODEL")]
    subagent_model: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct RemoteEnvironments {
    environments: HashMap<String, RemoteEnvConfig>,
}

/// Build the argv vector for invoking `ccem load` (Path A).
///
/// Credentials are deliberately NOT placed in argv: process listings, crash
/// dumps, and diagnostic collectors can capture argv. Instead the CLI reads
/// credentials from stdin via `--credentials-stdin`; see
/// [`build_remote_load_stdin_payload`].
fn build_remote_load_args(url: &str) -> Vec<String> {
    vec![
        "load".into(),
        url.to_string(),
        "--credentials-stdin".into(),
        "--json".into(),
    ]
}

/// Build the JSON payload piped to the CLI's stdin for `--credentials-stdin`.
///
/// Kept separate from [`build_remote_load_args`] so unit tests can assert that
/// no secret/key value ever lands in the argv vector. `key` is omitted when
/// empty — the CLI then falls back to `secret` for authentication (legacy
/// compat).
fn build_remote_load_stdin_payload(key: &str, secret: &str) -> String {
    let mut obj = serde_json::json!({ "secret": secret });
    if !key.is_empty() {
        obj["key"] = serde_json::Value::String(key.to_string());
    }
    obj.to_string()
}

#[tauri::command]
fn load_from_remote(url: String, key: String, secret: String) -> Result<LoadResult, String> {
    // Path A: try CLI if installed. Credentials are piped via stdin, never argv.
    if let Some(ccem_path) = terminal::resolve_ccem_path() {
        let args = build_remote_load_args(&url);
        let stdin_payload = build_remote_load_stdin_payload(&key, &secret);

        let spawn_result = Command::new(&ccem_path)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();

        if let Ok(mut child) = spawn_result {
            if let Some(stdin) = child.stdin.as_mut() {
                use std::io::Write;
                let _ = stdin.write_all(stdin_payload.as_bytes());
            }
            // Drop stdin handle to signal EOF so the CLI proceeds to read.
            child.stdin.take();

            let output = child.wait_with_output();

            if let Ok(out) = output {
                if out.status.success() {
                    // CLI succeeded — parse JSON output to get imported environments
                    let stdout = String::from_utf8_lossy(&out.stdout);

                    // 查找 JSON 输出（跳过前面的日志行）
                    if let Some(json_line) =
                        stdout.lines().find(|line| line.trim().starts_with('{'))
                    {
                        if let Ok(result) = serde_json::from_str::<LoadResult>(json_line) {
                            return Ok(result);
                        }
                    }

                    // 如果无法解析 JSON，返回错误
                    return Err("Failed to parse CLI output".to_string());
                }
                // CLI failed — fall through to native path
            }
            // wait_with_output failed — fall through to native path (no credential values logged)
        }
    }

    // Path B: native Rust implementation
    // Use key for auth header; fall back to secret for backward compatibility
    let header_val = if key.is_empty() { &secret } else { &key };
    let client = reqwest::blocking::Client::new();
    let response = client
        .get(&url)
        .header("X-CCEM-Key", header_val)
        .send()
        .map_err(|e| format!("Network error: {}", e))?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Unauthorized: invalid credentials".to_string());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("Rate limited: please try again later".to_string());
    }
    if !status.is_success() {
        return Err(format!("Server returned HTTP {}", status.as_u16()));
    }

    let remote_resp: RemoteResponse = response
        .json()
        .map_err(|e| format!("Invalid server response: {}", e))?;

    let decrypted = crypto::decrypt_remote(&remote_resp.encrypted, &secret)?;

    let remote_envs: RemoteEnvironments =
        serde_json::from_str(&decrypted).map_err(|e| format!("Invalid environment data: {}", e))?;

    let mut cfg = config::read_config()?;
    let mut loaded: Vec<LoadedEnv> = Vec::new();

    for (orig_name, env) in remote_envs.environments {
        // Generate unique name if duplicate
        let mut final_name = orig_name.clone();
        if cfg.registries.contains_key(&final_name) {
            final_name = format!("{}-remote", orig_name);
            let mut counter = 2;
            while cfg.registries.contains_key(&final_name) {
                final_name = format!("{}-remote-{}", orig_name, counter);
                counter += 1;
            }
        }

        let renamed = final_name != orig_name;

        let has_tier_defaults = env.default_opus_model.is_some()
            || env.default_sonnet_model.is_some()
            || env.default_haiku_model.is_some();
        let default_opus_model = env.default_opus_model.or_else(|| {
            if has_tier_defaults {
                None
            } else {
                env.model.clone()
            }
        });
        let default_sonnet_model = env
            .default_sonnet_model
            .or_else(|| default_opus_model.clone())
            .or_else(|| {
                if has_tier_defaults {
                    None
                } else {
                    env.model.clone()
                }
            });
        let default_haiku_model = env.default_haiku_model.or(env.small_fast_model);
        let runtime_model = Some(if has_tier_defaults {
            env.model.unwrap_or_else(|| "opus".to_string())
        } else {
            "opus".to_string()
        });

        let env_config = create_env_with_encrypted_key(
            env.base_url,
            env.auth_token.or(env.api_key),
            default_opus_model,
            default_sonnet_model,
            default_haiku_model,
            runtime_model,
            env.subagent_model,
        )?;

        cfg.registries.insert(final_name.clone(), env_config);
        loaded.push(LoadedEnv {
            name: final_name,
            original_name: orig_name,
            renamed,
        });
    }

    config::write_config(&cfg)?;

    Ok(LoadResult {
        count: loaded.len(),
        environments: loaded,
    })
}

#[tauri::command]
fn get_default_working_dir() -> Result<Option<String>, String> {
    let cfg = config::read_app_config()?;
    Ok(cfg.default_working_dir)
}

#[tauri::command]
fn set_default_working_dir(path: Option<String>) -> Result<(), String> {
    let mut cfg = config::read_app_config()?;
    cfg.default_working_dir = path;
    config::write_app_config(&cfg)
}

// ============================================
// Settings Commands
// ============================================

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> Result<DesktopSettings, String> {
    let mut settings = config::read_settings()?;
    // Merge defaultMode from config.json (source of truth for permission mode)
    let cfg = config::read_config()?;
    settings.default_mode = cfg.default_mode;
    // Reflect actual system autostart state
    {
        use tauri_plugin_autostart::ManagerExt;
        let autostart = app.autolaunch();
        if let Ok(enabled) = autostart.is_enabled() {
            settings.auto_start = enabled;
        }
    }
    Ok(settings)
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: DesktopSettings) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();

    // Save defaultMode to config.json (shared with CLI)
    match config::read_config() {
        Ok(mut cfg) => {
            cfg.default_mode = settings.default_mode.clone();
            if let Err(e) = config::write_config(&cfg) {
                errors.push(format!("config.json: {}", e));
            }
        }
        Err(e) => errors.push(format!("read config: {}", e)),
    }

    // Sync autostart with system
    {
        use tauri_plugin_autostart::ManagerExt;
        let autostart = app.autolaunch();
        let result = if settings.auto_start {
            autostart.enable()
        } else {
            autostart.disable()
        };
        if let Err(e) = result {
            errors.push(format!("autostart: {}", e));
        }
    }

    // Save desktop-specific settings to settings.json.
    // Merge fields that are not part of the Settings page payload to avoid resetting
    // proxy-debug config when users change unrelated options.
    let mut merged_settings = config::read_settings().unwrap_or_default();
    merged_settings.theme = settings.theme;
    merged_settings.auto_start = settings.auto_start;
    merged_settings.start_minimized = settings.start_minimized;
    merged_settings.close_to_tray = settings.close_to_tray;
    merged_settings.desktop_pet_enabled = settings.desktop_pet_enabled;
    merged_settings.default_mode = settings.default_mode;
    merged_settings.performance_mode = settings.performance_mode;
    merged_settings.desktop_notifications_enabled = settings.desktop_notifications_enabled;
    merged_settings.notify_on_task_completed = settings.notify_on_task_completed;
    merged_settings.notify_on_task_failed = settings.notify_on_task_failed;
    merged_settings.notify_on_action_required = settings.notify_on_action_required;
    merged_settings.ai_enhanced = settings.ai_enhanced;
    merged_settings.ai_env_name = settings.ai_env_name;
    // Only overwrite enablement when the payload explicitly includes it.
    // Settings page saves omit this field; environment page writes include it.
    if settings.enabled_environments.is_some() {
        merged_settings.enabled_environments = settings.enabled_environments;
    }
    config::write_settings(&merged_settings)?;
    if let Err(e) =
        pet_window::sync_pet_window_visibility(&app, merged_settings.desktop_pet_enabled)
    {
        errors.push(format!("desktop pet: {}", e));
    }
    if let Some(notification_prefs_state) = app.try_state::<notifications::NotificationPrefsState>()
    {
        notification_prefs_state.replace_from_settings(&merged_settings);
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(main_window) = app.get_webview_window("main") {
            if let Err(error) = sync_macos_window_appearance(&main_window, &merged_settings) {
                errors.push(format!("window appearance: {}", error));
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("Partial save failures: {}", errors.join("; ")))
    }
}

#[tauri::command]
fn send_test_notification(app: tauri::AppHandle) -> Result<(), String> {
    notifications::send_test_notification(&app)
}

#[tauri::command]
fn get_telegram_settings() -> Result<TelegramSettings, String> {
    telegram::read_telegram_settings()
}

#[tauri::command]
fn get_weixin_settings() -> Result<WeixinSettings, String> {
    weixin::read_weixin_settings()
}

#[tauri::command]
fn get_wecom_settings() -> Result<WecomSettings, String> {
    wecom::read_wecom_settings()
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WecomTaskBindingDefault {
    bot_id: String,
    target_type: WecomTaskBindingTargetType,
    peer_id: String,
    auto_send_card: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WecomTaskBindingTargetOption {
    target_type: WecomTaskBindingTargetType,
    peer_id: String,
    label: String,
    is_default: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WecomTaskBindingOption {
    bot_id: String,
    name: String,
    auto_send_card: bool,
    targets: Vec<WecomTaskBindingTargetOption>,
}

#[tauri::command]
fn get_wecom_task_binding_defaults() -> Result<Vec<WecomTaskBindingDefault>, String> {
    let settings = wecom::read_wecom_settings()?;
    Ok(settings
        .bots
        .into_iter()
        .filter_map(|bot| {
            let peer_id = bot.task_binding_default_peer_id?.trim().to_string();
            if !bot.enabled || bot.bot_id.trim().is_empty() || peer_id.is_empty() {
                return None;
            }
            Some(WecomTaskBindingDefault {
                bot_id: bot.bot_id,
                target_type: bot
                    .task_binding_default_target_type
                    .unwrap_or(WecomTaskBindingTargetType::User),
                peer_id,
                auto_send_card: bot.task_binding_auto_send_card,
            })
        })
        .collect())
}

#[tauri::command]
fn get_wecom_task_binding_options() -> Result<Vec<WecomTaskBindingOption>, String> {
    let settings = wecom::read_wecom_settings()?;
    Ok(settings
        .bots
        .into_iter()
        .filter(|bot| bot.enabled && !bot.bot_id.trim().is_empty())
        .map(|bot| {
            let default_target_type = bot
                .task_binding_default_target_type
                .clone()
                .unwrap_or(WecomTaskBindingTargetType::User);
            let mut targets = Vec::<WecomTaskBindingTargetOption>::new();
            if let Some(peer_id) = bot
                .task_binding_default_peer_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                push_wecom_task_target(
                    &mut targets,
                    default_target_type.clone(),
                    peer_id,
                    "Default",
                    true,
                );
            }
            for user_id in &bot.admin_user_ids {
                push_wecom_task_target(
                    &mut targets,
                    WecomTaskBindingTargetType::User,
                    user_id,
                    "Admin",
                    false,
                );
            }
            for user_id in &bot.allowed_user_ids {
                push_wecom_task_target(
                    &mut targets,
                    WecomTaskBindingTargetType::User,
                    user_id,
                    "User",
                    false,
                );
            }
            for group_id in &bot.allowed_group_chat_ids {
                push_wecom_task_target(
                    &mut targets,
                    WecomTaskBindingTargetType::Group,
                    group_id,
                    "Group",
                    false,
                );
            }
            WecomTaskBindingOption {
                bot_id: bot.bot_id,
                name: if bot.name.trim().is_empty() {
                    bot.id
                } else {
                    bot.name
                },
                auto_send_card: bot.task_binding_auto_send_card,
                targets,
            }
        })
        .collect())
}

fn push_wecom_task_target(
    targets: &mut Vec<WecomTaskBindingTargetOption>,
    target_type: WecomTaskBindingTargetType,
    peer_id: &str,
    kind: &str,
    is_default: bool,
) {
    let peer_id = peer_id.trim();
    if peer_id.is_empty()
        || targets
            .iter()
            .any(|target| target.target_type == target_type && target.peer_id == peer_id)
    {
        return;
    }
    let scope = match &target_type {
        WecomTaskBindingTargetType::User => "user",
        WecomTaskBindingTargetType::Group => "group",
    };
    targets.push(WecomTaskBindingTargetOption {
        target_type,
        peer_id: peer_id.to_string(),
        label: format!("{kind} {scope} · {}", compact_wecom_peer_id(peer_id)),
        is_default,
    });
}

fn compact_wecom_peer_id(peer_id: &str) -> String {
    if peer_id.chars().count() <= 18 {
        return peer_id.to_string();
    }
    let start = peer_id.chars().take(8).collect::<String>();
    let end = peer_id
        .chars()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    format!("{start}...{end}")
}

#[tauri::command]
async fn save_telegram_settings(
    telegram_state: State<'_, Arc<TelegramBridgeManager>>,
    settings: TelegramSettings,
) -> Result<(), String> {
    let manager = telegram_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let was_running = manager.status().running;
        let previous_settings = telegram::read_telegram_settings().ok();
        telegram::write_telegram_settings(&settings)?;
        manager.sync_settings(&settings);
        if was_running {
            telegram::reconcile_registered_commands(previous_settings.as_ref(), &settings)?;
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("Failed to join save_telegram_settings task: {}", error))?
}

#[tauri::command]
async fn save_weixin_settings(
    weixin_state: State<'_, Arc<WeixinBridgeManager>>,
    settings: WeixinSettings,
) -> Result<(), String> {
    let manager = weixin_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        weixin::write_weixin_settings(&settings)?;
        manager.sync_settings(&settings);
        Ok(())
    })
    .await
    .map_err(|error| format!("Failed to join save_weixin_settings task: {}", error))?
}

#[tauri::command]
async fn save_wecom_settings(
    wecom_state: State<'_, Arc<WecomBridgeManager>>,
    settings: WecomSettings,
) -> Result<(), String> {
    let manager = wecom_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        wecom::write_wecom_settings(&settings)?;
        manager.sync_settings(&settings);
        Ok(())
    })
    .await
    .map_err(|error| format!("Failed to join save_wecom_settings task: {}", error))?
}

#[tauri::command]
fn get_telegram_bridge_status(
    telegram_state: State<'_, Arc<TelegramBridgeManager>>,
) -> TelegramBridgeStatus {
    telegram_state.status()
}

#[tauri::command]
fn get_weixin_bridge_status(
    weixin_state: State<'_, Arc<WeixinBridgeManager>>,
) -> WeixinBridgeStatus {
    weixin_state.status()
}

#[tauri::command]
fn get_wecom_bridge_status(wecom_state: State<'_, Arc<WecomBridgeManager>>) -> WecomBridgeStatus {
    wecom_state.status()
}

#[tauri::command]
async fn start_telegram_bridge(
    app: tauri::AppHandle,
    telegram_state: State<'_, Arc<TelegramBridgeManager>>,
    runtime_state: State<'_, Arc<HeadlessRuntimeManager>>,
    interactive_state: State<'_, Arc<InteractiveRuntimeManager>>,
) -> Result<TelegramBridgeStatus, String> {
    let manager = telegram_state.inner().clone();
    let runtime_manager = runtime_state.inner().clone();
    let interactive_manager = interactive_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.start(app, runtime_manager, interactive_manager)
    })
    .await
    .map_err(|error| format!("Failed to join start_telegram_bridge task: {}", error))?
}

#[tauri::command]
async fn start_wecom_bridge(
    app: tauri::AppHandle,
    wecom_state: State<'_, Arc<WecomBridgeManager>>,
    runtime_state: State<'_, Arc<HeadlessRuntimeManager>>,
) -> Result<WecomBridgeStatus, String> {
    let manager = wecom_state.inner().clone();
    let runtime_manager = runtime_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.start(app, runtime_manager))
        .await
        .map_err(|error| format!("Failed to join start_wecom_bridge task: {}", error))?
}

#[tauri::command]
async fn start_weixin_bridge(
    app: tauri::AppHandle,
    weixin_state: State<'_, Arc<WeixinBridgeManager>>,
    runtime_state: State<'_, Arc<HeadlessRuntimeManager>>,
) -> Result<WeixinBridgeStatus, String> {
    let manager = weixin_state.inner().clone();
    let runtime_manager = runtime_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.start(app, runtime_manager))
        .await
        .map_err(|error| format!("Failed to join start_weixin_bridge task: {}", error))?
}

#[tauri::command]
async fn stop_wecom_bridge(
    wecom_state: State<'_, Arc<WecomBridgeManager>>,
) -> Result<WecomBridgeStatus, String> {
    let manager = wecom_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.stop())
        .await
        .map_err(|error| format!("Failed to join stop_wecom_bridge task: {}", error))
}

#[tauri::command]
async fn stop_telegram_bridge(
    telegram_state: State<'_, Arc<TelegramBridgeManager>>,
) -> Result<TelegramBridgeStatus, String> {
    let manager = telegram_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.stop())
        .await
        .map_err(|error| format!("Failed to join stop_telegram_bridge task: {}", error))
}

#[tauri::command]
async fn stop_weixin_bridge(
    weixin_state: State<'_, Arc<WeixinBridgeManager>>,
) -> Result<WeixinBridgeStatus, String> {
    let manager = weixin_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.stop())
        .await
        .map_err(|error| format!("Failed to join stop_weixin_bridge task: {}", error))
}

#[tauri::command]
async fn start_weixin_login(
    weixin_state: State<'_, Arc<WeixinBridgeManager>>,
) -> Result<WeixinLoginSession, String> {
    let manager = weixin_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.start_login())
        .await
        .map_err(|error| format!("Failed to join start_weixin_login task: {}", error))?
}

#[tauri::command]
async fn poll_weixin_login(
    weixin_state: State<'_, Arc<WeixinBridgeManager>>,
    session_key: String,
) -> Result<WeixinLoginSession, String> {
    let manager = weixin_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.poll_login(&session_key))
        .await
        .map_err(|error| format!("Failed to join poll_weixin_login task: {}", error))?
}

#[tauri::command]
fn get_telegram_forum_topics(
    telegram_state: State<'_, Arc<TelegramBridgeManager>>,
) -> Result<Vec<TelegramForumTopic>, String> {
    telegram::get_known_forum_topics(telegram_state.inner())
}

#[tauri::command]
async fn bind_telegram_topic(
    telegram_state: State<'_, Arc<TelegramBridgeManager>>,
    project_dir: String,
    env_name: Option<String>,
    perm_mode: Option<String>,
    thread_id: Option<i64>,
    create_new_topic: bool,
) -> Result<TelegramTopicBinding, String> {
    let manager = telegram_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        telegram::bind_topic_from_desktop(
            &manager,
            project_dir,
            env_name,
            perm_mode,
            thread_id,
            create_new_topic,
        )
    })
    .await
    .map_err(|error| format!("Failed to join bind_telegram_topic task: {}", error))?
}

#[tauri::command]
fn get_proxy_debug_state(state: State<Arc<ProxyDebugManager>>) -> ProxyDebugState {
    state.get_state()
}

#[tauri::command]
async fn set_proxy_debug_enabled(
    state: State<'_, Arc<ProxyDebugManager>>,
    enabled: bool,
) -> Result<ProxyDebugState, String> {
    state.set_enabled(enabled).await
}

#[tauri::command]
async fn update_proxy_debug_config(
    state: State<'_, Arc<ProxyDebugManager>>,
    codex_upstream_base_url: String,
    record_mode: Option<String>,
) -> Result<ProxyDebugState, String> {
    state
        .update_config(codex_upstream_base_url, record_mode)
        .await
}

#[tauri::command]
fn list_proxy_traffic(
    state: State<Arc<ProxyDebugManager>>,
    limit: u32,
    cursor: Option<String>,
) -> Result<ProxyTrafficPage, String> {
    state.list_traffic(limit, cursor)
}

#[tauri::command]
fn get_proxy_traffic_detail(
    state: State<Arc<ProxyDebugManager>>,
    id: String,
) -> Result<ProxyTrafficDetail, String> {
    state.get_traffic_detail(id)
}

#[tauri::command]
fn clear_proxy_traffic(state: State<Arc<ProxyDebugManager>>) -> Result<(), String> {
    state.clear_traffic()
}

#[derive(Debug, serde::Serialize)]
struct WorkspaceGitChangedFile {
    path: String,
    status: String,
    additions: Option<u64>,
    deletions: Option<u64>,
}

#[derive(Debug, serde::Serialize)]
struct WorkspaceGitSnapshot {
    is_repo: bool,
    root: Option<String>,
    branch: Option<String>,
    sha: Option<String>,
    upstream: Option<String>,
    dirty_count: u64,
    files: Vec<WorkspaceGitChangedFile>,
    error: Option<String>,
}

fn run_git_command(working_dir: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(working_dir)
        .args(args)
        .output()
        .map_err(|error| format!("Failed to run git: {}", error))?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("git exited with status {}", output.status)
    } else {
        stderr
    })
}

fn normalize_git_changed_path(raw_path: &str) -> String {
    let path = raw_path.trim().trim_matches('"');

    if let Some(open_brace_index) = path.find('{') {
        if let Some(close_brace_offset) = path[open_brace_index + 1..].find('}') {
            let close_brace_index = open_brace_index + 1 + close_brace_offset;
            let inner = &path[open_brace_index + 1..close_brace_index];
            if let Some((_, new_name)) = inner.rsplit_once(" => ") {
                return format!(
                    "{}{}{}",
                    &path[..open_brace_index],
                    new_name.trim().trim_matches('"'),
                    &path[close_brace_index + 1..],
                );
            }
        }
    }

    path.rsplit_once(" -> ")
        .or_else(|| path.rsplit_once(" => "))
        .map(|(_, new_path)| new_path.trim().trim_matches('"').to_string())
        .unwrap_or_else(|| path.to_string())
}

fn parse_git_status_line(line: &str) -> Option<(String, String)> {
    if line.len() < 4 {
        return None;
    }
    let status = line.get(0..2)?.trim().to_string();
    let raw_path = line.get(3..)?.trim();
    let path = normalize_git_changed_path(raw_path);
    if path.is_empty() {
        return None;
    }
    Some((path, status))
}

fn parse_numstat_value(value: &str) -> Option<u64> {
    value.parse::<u64>().ok()
}

fn merge_git_numstat(files: &mut HashMap<String, WorkspaceGitChangedFile>, output: &str) {
    for line in output.lines() {
        let mut parts = line.splitn(3, '\t');
        let additions = parts.next().and_then(parse_numstat_value);
        let deletions = parts.next().and_then(parse_numstat_value);
        let Some(raw_path) = parts.next().map(str::trim).filter(|path| !path.is_empty()) else {
            continue;
        };
        let path = normalize_git_changed_path(raw_path);
        let entry = files
            .entry(path.clone())
            .or_insert_with(|| WorkspaceGitChangedFile {
                path: path.clone(),
                status: "M".to_string(),
                additions: None,
                deletions: None,
            });
        entry.additions = Some(entry.additions.unwrap_or(0) + additions.unwrap_or(0));
        entry.deletions = Some(entry.deletions.unwrap_or(0) + deletions.unwrap_or(0));
    }
}

#[tauri::command]
fn get_workspace_git_snapshot(working_dir: String) -> Result<WorkspaceGitSnapshot, String> {
    let root = match run_git_command(&working_dir, &["rev-parse", "--show-toplevel"]) {
        Ok(value) if !value.is_empty() => value,
        Ok(_) => {
            return Ok(WorkspaceGitSnapshot {
                is_repo: false,
                root: None,
                branch: None,
                sha: None,
                upstream: None,
                dirty_count: 0,
                files: Vec::new(),
                error: Some("Not a git repository".to_string()),
            });
        }
        Err(error) => {
            return Ok(WorkspaceGitSnapshot {
                is_repo: false,
                root: None,
                branch: None,
                sha: None,
                upstream: None,
                dirty_count: 0,
                files: Vec::new(),
                error: Some(error),
            });
        }
    };

    let branch = run_git_command(&working_dir, &["branch", "--show-current"])
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| run_git_command(&working_dir, &["rev-parse", "--short", "HEAD"]).ok());
    let sha = run_git_command(&working_dir, &["rev-parse", "--short", "HEAD"]).ok();
    let upstream = run_git_command(
        &working_dir,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok();

    let mut files = HashMap::new();
    if let Ok(status_output) = run_git_command(&working_dir, &["status", "--porcelain=v1"]) {
        for line in status_output.lines() {
            if let Some((path, status)) = parse_git_status_line(line) {
                files.insert(
                    path.clone(),
                    WorkspaceGitChangedFile {
                        path,
                        status,
                        additions: None,
                        deletions: None,
                    },
                );
            }
        }
    }

    if let Ok(output) = run_git_command(&working_dir, &["diff", "--numstat"]) {
        merge_git_numstat(&mut files, &output);
    }
    if let Ok(output) = run_git_command(&working_dir, &["diff", "--cached", "--numstat"]) {
        merge_git_numstat(&mut files, &output);
    }

    let mut file_list = files.into_values().collect::<Vec<_>>();
    file_list.sort_by(|left, right| left.path.cmp(&right.path));
    let dirty_count = file_list.len() as u64;

    Ok(WorkspaceGitSnapshot {
        is_repo: true,
        root: Some(root),
        branch,
        sha,
        upstream,
        dirty_count,
        files: file_list,
        error: None,
    })
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum WorkspaceDiffLineKind {
    Context,
    Addition,
    Deletion,
    Hunk,
    Meta,
}

#[derive(Debug, serde::Serialize)]
struct WorkspaceDiffLine {
    kind: WorkspaceDiffLineKind,
    text: String,
    old_line: Option<u64>,
    new_line: Option<u64>,
}

#[derive(Debug, serde::Serialize)]
struct WorkspaceFileDiff {
    path: String,
    is_repo: bool,
    is_binary: bool,
    is_untracked: bool,
    additions: u64,
    deletions: u64,
    lines: Vec<WorkspaceDiffLine>,
    truncated: bool,
    error: Option<String>,
}

const MAX_DIFF_LINES: usize = 2000;

fn parse_unified_diff(
    raw: &str,
    untracked: bool,
) -> (Vec<WorkspaceDiffLine>, u64, u64, bool, bool) {
    let mut lines = Vec::new();
    let mut additions = 0u64;
    let mut deletions = 0u64;
    let mut is_binary = false;
    let mut old_line: u64 = 0;
    let mut new_line: u64 = 0;
    let mut truncated = false;

    for raw_line in raw.lines() {
        if lines.len() >= MAX_DIFF_LINES {
            truncated = true;
            break;
        }

        if raw_line.starts_with("Binary files") || raw_line.starts_with("GIT binary patch") {
            is_binary = true;
            continue;
        }
        // Skip the file header noise; hunks carry the useful signal.
        if raw_line.starts_with("diff --git")
            || raw_line.starts_with("index ")
            || raw_line.starts_with("--- ")
            || raw_line.starts_with("+++ ")
            || raw_line.starts_with("new file mode")
            || raw_line.starts_with("deleted file mode")
            || raw_line.starts_with("similarity index")
            || raw_line.starts_with("rename from")
            || raw_line.starts_with("rename to")
            || raw_line.starts_with("old mode")
            || raw_line.starts_with("new mode")
        {
            continue;
        }

        if let Some(rest) = raw_line.strip_prefix("@@") {
            // Format: @@ -oldStart,oldCount +newStart,newCount @@ optional
            if let Some(end) = rest.find("@@") {
                let spec = &rest[..end];
                for token in spec.split_whitespace() {
                    if let Some(value) = token.strip_prefix('-') {
                        old_line = value
                            .split(',')
                            .next()
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(0);
                    } else if let Some(value) = token.strip_prefix('+') {
                        new_line = value
                            .split(',')
                            .next()
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(0);
                    }
                }
            }
            lines.push(WorkspaceDiffLine {
                kind: WorkspaceDiffLineKind::Hunk,
                text: raw_line.to_string(),
                old_line: None,
                new_line: None,
            });
            continue;
        }

        if let Some(text) = raw_line.strip_prefix('+') {
            additions += 1;
            lines.push(WorkspaceDiffLine {
                kind: WorkspaceDiffLineKind::Addition,
                text: text.to_string(),
                old_line: None,
                new_line: Some(new_line),
            });
            new_line += 1;
        } else if let Some(text) = raw_line.strip_prefix('-') {
            deletions += 1;
            lines.push(WorkspaceDiffLine {
                kind: WorkspaceDiffLineKind::Deletion,
                text: text.to_string(),
                old_line: Some(old_line),
                new_line: None,
            });
            old_line += 1;
        } else if let Some(text) = raw_line.strip_prefix(' ') {
            lines.push(WorkspaceDiffLine {
                kind: WorkspaceDiffLineKind::Context,
                text: text.to_string(),
                old_line: Some(old_line),
                new_line: Some(new_line),
            });
            old_line += 1;
            new_line += 1;
        } else if raw_line == "\\ No newline at end of file" {
            lines.push(WorkspaceDiffLine {
                kind: WorkspaceDiffLineKind::Meta,
                text: raw_line.to_string(),
                old_line: None,
                new_line: None,
            });
        }
    }

    // For an untracked file rendered via --no-index, every body line counts as an addition.
    if untracked {
        deletions = 0;
    }

    (lines, additions, deletions, is_binary, truncated)
}

#[tauri::command]
fn get_workspace_file_diff(
    working_dir: String,
    file_path: String,
) -> Result<WorkspaceFileDiff, String> {
    let not_repo = |error: Option<String>| WorkspaceFileDiff {
        path: file_path.clone(),
        is_repo: false,
        is_binary: false,
        is_untracked: false,
        additions: 0,
        deletions: 0,
        lines: Vec::new(),
        truncated: false,
        error,
    };

    match run_git_command(&working_dir, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(value) if value.trim() == "true" => {}
        Ok(_) => return Ok(not_repo(Some("Not a git repository".to_string()))),
        Err(error) => return Ok(not_repo(Some(error))),
    }

    // Detect untracked files — they have no HEAD/index entry, so use --no-index against /dev/null.
    let status = run_git_command(
        &working_dir,
        &["status", "--porcelain=v1", "--", &file_path],
    )
    .unwrap_or_default();
    let is_untracked = status.lines().any(|line| line.starts_with("??"));

    let raw = if is_untracked {
        // --no-index exits non-zero when files differ, so tolerate the error and use stdout.
        let output = Command::new("git")
            .arg("-C")
            .arg(&working_dir)
            .args([
                "diff",
                "--no-color",
                "--no-index",
                "--",
                "/dev/null",
                &file_path,
            ])
            .output()
            .map_err(|error| format!("Failed to run git: {}", error))?;
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        run_git_command(
            &working_dir,
            &["diff", "--no-color", "HEAD", "--", &file_path],
        )
        .or_else(|_| run_git_command(&working_dir, &["diff", "--no-color", "--", &file_path]))
        .unwrap_or_default()
    };

    let (lines, additions, deletions, is_binary, truncated) =
        parse_unified_diff(&raw, is_untracked);

    Ok(WorkspaceFileDiff {
        path: file_path,
        is_repo: true,
        is_binary,
        is_untracked,
        additions,
        deletions,
        lines,
        truncated,
        error: None,
    })
}

#[derive(Debug, serde::Serialize)]
struct WorkspaceMediaPreview {
    path: String,
    kind: String,
    media_type: String,
    data_url: Option<String>,
    byte_size: u64,
    error: Option<String>,
}

/// Cap media preview payloads to avoid base64 inflation in the IPC bridge.
/// Files above this ceiling return `error` instead of `data_url`.
const WORKSPACE_MEDIA_MAX_BYTES: u64 = 25 * 1024 * 1024;

fn media_kind_for_extension(path: &str) -> Option<(&'static str, &'static str)> {
    let lower = path.to_ascii_lowercase();
    let ext = lower.rsplit('.').next()?;
    if ext.is_empty() || ext.contains('/') || ext.contains('\\') {
        return None;
    }
    match ext {
        "png" => Some(("image", "image/png")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "gif" => Some(("image", "image/gif")),
        "webp" => Some(("image", "image/webp")),
        "bmp" => Some(("image", "image/bmp")),
        "svg" => Some(("image", "image/svg+xml")),
        "ico" => Some(("image", "image/x-icon")),
        "avif" => Some(("image", "image/avif")),
        "mp3" => Some(("audio", "audio/mpeg")),
        "wav" => Some(("audio", "audio/wav")),
        "ogg" => Some(("audio", "audio/ogg")),
        "m4a" => Some(("audio", "audio/mp4")),
        "flac" => Some(("audio", "audio/flac")),
        "aac" => Some(("audio", "audio/aac")),
        "mp4" => Some(("video", "video/mp4")),
        "webm" => Some(("video", "video/webm")),
        "mov" => Some(("video", "video/quicktime")),
        "mkv" => Some(("video", "video/x-matroska")),
        "avi" => Some(("video", "video/x-msvideo")),
        _ => None,
    }
}

fn resolve_workspace_media_path(
    working_dir: &str,
    file_path: &str,
) -> Result<std::path::PathBuf, String> {
    let working = std::path::Path::new(working_dir)
        .canonicalize()
        .map_err(|err| format!("Invalid working_dir {}: {}", working_dir, err))?;
    let candidate = if std::path::Path::new(file_path).is_absolute() {
        std::path::PathBuf::from(file_path)
    } else {
        working.join(file_path)
    };
    let resolved = candidate
        .canonicalize()
        .map_err(|err| format!("Cannot resolve path {}: {}", candidate.display(), err))?;
    if !resolved.starts_with(&working) {
        return Err(format!("Path '{}' escapes working dir", file_path));
    }
    Ok(resolved)
}

#[tauri::command]
fn get_workspace_media_preview(
    working_dir: String,
    file_path: String,
) -> Result<WorkspaceMediaPreview, String> {
    let unsupported = || WorkspaceMediaPreview {
        path: file_path.clone(),
        kind: "unsupported".to_string(),
        media_type: String::new(),
        data_url: None,
        byte_size: 0,
        error: Some("Not a recognized media file".to_string()),
    };

    let (kind, media_type) = match media_kind_for_extension(&file_path) {
        Some(value) => value,
        None => return Ok(unsupported()),
    };

    let absolute_path = match resolve_workspace_media_path(&working_dir, &file_path) {
        Ok(path) => path,
        Err(err) => {
            return Ok(WorkspaceMediaPreview {
                path: file_path,
                kind: kind.to_string(),
                media_type: media_type.to_string(),
                data_url: None,
                byte_size: 0,
                error: Some(err),
            });
        }
    };

    let metadata = match std::fs::metadata(&absolute_path) {
        Ok(meta) => meta,
        Err(err) => {
            return Ok(WorkspaceMediaPreview {
                path: file_path,
                kind: kind.to_string(),
                media_type: media_type.to_string(),
                data_url: None,
                byte_size: 0,
                error: Some(format!("Failed to stat file: {}", err)),
            });
        }
    };

    let byte_size = metadata.len();
    if byte_size > WORKSPACE_MEDIA_MAX_BYTES {
        return Ok(WorkspaceMediaPreview {
            path: file_path,
            kind: kind.to_string(),
            media_type: media_type.to_string(),
            data_url: None,
            byte_size,
            error: Some(format!(
                "File too large ({} bytes > {} bytes cap)",
                byte_size, WORKSPACE_MEDIA_MAX_BYTES
            )),
        });
    }

    let bytes = match std::fs::read(&absolute_path) {
        Ok(value) => value,
        Err(err) => {
            return Ok(WorkspaceMediaPreview {
                path: file_path,
                kind: kind.to_string(),
                media_type: media_type.to_string(),
                data_url: None,
                byte_size,
                error: Some(format!("Failed to read file: {}", err)),
            });
        }
    };

    // SVG is XML text — embed as UTF-8 when valid to skip base64 inflation.
    let data_url = if media_type == "image/svg+xml" {
        match std::str::from_utf8(&bytes) {
            Ok(text) => format!("data:{};utf8,{}", media_type, text),
            Err(_) => {
                use base64::Engine as _;
                let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                format!("data:{};base64,{}", media_type, encoded)
            }
        }
    } else {
        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        format!("data:{};base64,{}", media_type, encoded)
    };

    Ok(WorkspaceMediaPreview {
        path: file_path,
        kind: kind.to_string(),
        media_type: media_type.to_string(),
        data_url: Some(data_url),
        byte_size,
        error: None,
    })
}

/// Resolve a candidate `file_path` against `working_dir`, enforcing that the
/// final canonicalized path lives inside the canonicalized working dir.
///
/// Handles four escape vectors that a naive prefix check would miss:
/// * relative `../` escape — `Path::starts_with` runs after canonicalization
/// * symlink escape — parent dir canonicalization resolves symlinks; the leaf
///   component is appended post-resolution so we never follow a symlink at the
///   leaf without first checking its parent
/// * sibling-prefix absolute paths — `/proj-evil/...` must not match `/proj`,
///   which `Path::starts_with` (rather than `String::starts_with`) guarantees
/// * absolute paths outside the workspace — `starts_with` fails and we reject
///
/// The leaf file is allowed to not exist yet (so callers can open editors that
/// create it on focus); we canonicalize the parent and re-append the file name.
/// If the parent itself is missing we walk up until we find an existing
/// ancestor, canonicalize that, then re-append the remaining relative tail.
/// This bounds the lookup to the filesystem root and keeps the workspace guard
/// effective even when intermediate directories are pending creation.
fn resolve_workspace_path(
    working_dir: &str,
    file_path: &str,
) -> Result<std::path::PathBuf, String> {
    let working = std::path::Path::new(working_dir)
        .canonicalize()
        .map_err(|err| format!("Invalid working_dir {}: {}", working_dir, err))?;

    let candidate = if std::path::Path::new(file_path).is_absolute() {
        std::path::PathBuf::from(file_path)
    } else {
        working.join(file_path)
    };

    // Fast path: file exists, so canonicalize resolves the leaf too.
    if let Ok(resolved) = candidate.canonicalize() {
        if !resolved.starts_with(&working) {
            return Err(format!(
                "Path '{}' escapes working dir '{}'",
                file_path,
                working.display()
            ));
        }
        return Ok(resolved);
    }

    // Slow path: leaf (or some ancestor) does not exist. Walk up to the first
    // existing ancestor, canonicalize it (this resolves any symlinks in the
    // chain), then re-append the remaining tail components. After rejoining we
    // run `starts_with` on the canonical ancestor to keep the guard sound.
    let mut existing = candidate.clone();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        let filename = match existing.file_name() {
            Some(name) => name.to_os_string(),
            None => {
                return Err(format!(
                    "Cannot resolve path '{}' (reached root without matching working dir)",
                    file_path
                ));
            }
        };
        tail.push(filename);
        match existing.parent() {
            Some(parent) => existing = parent.to_path_buf(),
            None => {
                return Err(format!(
                    "Cannot resolve path '{}' (no parent to canonicalize)",
                    file_path
                ));
            }
        }
    }
    tail.reverse();

    let canonical_ancestor = existing
        .canonicalize()
        .map_err(|err| format!("Cannot canonicalize '{}': {}", existing.display(), err))?;

    // The canonicalized ancestor must itself be inside the working dir; this
    // catches symlink chains that escape before we even consider the tail.
    if !canonical_ancestor.starts_with(&working) && canonical_ancestor != working {
        return Err(format!(
            "Path '{}' escapes working dir '{}'",
            file_path,
            working.display()
        ));
    }

    let mut resolved = canonical_ancestor;
    for component in tail {
        resolved.push(component);
    }

    if !resolved.starts_with(&working) {
        return Err(format!(
            "Path '{}' escapes working dir '{}'",
            file_path,
            working.display()
        ));
    }

    Ok(resolved)
}

/// Open a file in the OS default editor, constrained to `working_dir`.
///
/// This is the IPC surface used by Workspace Review's "open file" affordance.
/// We deliberately do NOT expose a generic open-path command — every call must
/// pass the session's project_dir, which the guard canonicalizes and checks
/// via `Path::starts_with` (post-symlink-resolution).
#[tauri::command]
fn open_file_in_workspace(working_dir: String, file_path: String) -> Result<bool, String> {
    let resolved = resolve_workspace_path(&working_dir, &file_path)?;

    // We intentionally do not canonicalize again right before spawn: the
    // earlier `resolve_workspace_path` already verified the path is inside the
    // workspace. A TOCTOU swap (e.g. replacing a file with a symlink between
    // resolve and spawn) can only redirect the OS handler, not escape the
    // workspace itself — and the OS open handler is the user's chosen editor,
    // which has no extra authority from this app.
    #[cfg(target_os = "macos")]
    let spawn_result = Command::new("open").arg(&resolved).spawn();
    #[cfg(target_os = "windows")]
    let spawn_result = Command::new("cmd")
        .args(["/C", "start", ""])
        .arg(&resolved)
        .spawn();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let spawn_result = Command::new("xdg-open").arg(&resolved).spawn();

    match spawn_result {
        Ok(_) => Ok(true),
        Err(err) => Err(format!(
            "Failed to open file '{}': {}",
            resolved.display(),
            err
        )),
    }
}

#[cfg(test)]
mod workspace_guard_tests {
    use super::resolve_workspace_path;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    fn make_temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    #[test]
    fn relative_path_inside_workspace_is_allowed() {
        let tmp = make_temp_dir();
        let project = tmp.path().join("proj");
        let src = project.join("src");
        fs::create_dir_all(&src).unwrap();
        let file = src.join("foo.ts");
        fs::write(&file, "// hi").unwrap();

        let resolved = resolve_workspace_path(project.to_str().unwrap(), "src/foo.ts")
            .expect("relative inside path should resolve");
        assert_eq!(resolved, file.canonicalize().unwrap());
    }

    #[test]
    fn absolute_path_inside_workspace_is_allowed() {
        let tmp = make_temp_dir();
        let project = tmp.path().join("proj");
        let src = project.join("src");
        fs::create_dir_all(&src).unwrap();
        let file = src.join("bar.ts");
        fs::write(&file, "").unwrap();

        let abs = file.to_str().unwrap().to_string();
        let resolved = resolve_workspace_path(project.to_str().unwrap(), &abs)
            .expect("absolute inside path should resolve");
        assert_eq!(resolved, file.canonicalize().unwrap());
    }

    #[test]
    fn dotdot_escape_outside_workspace_is_rejected() {
        let tmp = make_temp_dir();
        let project = tmp.path().join("proj");
        fs::create_dir_all(&project).unwrap();
        let sibling_secret = tmp.path().join("secret.txt");
        fs::write(&sibling_secret, "shh").unwrap();

        let err = resolve_workspace_path(project.to_str().unwrap(), "../../secret.txt")
            .expect_err("../ escape should be rejected");
        assert!(
            err.contains("escapes working dir"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn sibling_prefix_absolute_path_is_rejected() {
        // /tmp/proj-evil/x must NOT be considered inside /tmp/proj
        let tmp = make_temp_dir();
        let project = tmp.path().join("proj");
        fs::create_dir_all(&project).unwrap();
        let evil = tmp.path().join("proj-evil");
        fs::create_dir_all(&evil).unwrap();
        let evil_file = evil.join("payload.txt");
        fs::write(&evil_file, "").unwrap();

        let err = resolve_workspace_path(project.to_str().unwrap(), evil_file.to_str().unwrap())
            .expect_err("sibling-prefix absolute path must be rejected");
        assert!(
            err.contains("escapes working dir"),
            "unexpected error: {}",
            err
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_inside_workspace_is_rejected() {
        let tmp = make_temp_dir();
        let project = tmp.path().join("proj");
        fs::create_dir_all(&project).unwrap();
        // /tmp/proj/link -> /etc — canonicalize should resolve and reject
        let link = project.join("passwd-link");
        symlink("/etc", &link).unwrap();
        let candidate = link.join("passwd");

        let err = resolve_workspace_path(project.to_str().unwrap(), candidate.to_str().unwrap())
            .expect_err("symlink escape must be rejected");
        assert!(
            err.contains("escapes working dir"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn missing_leaf_file_under_existing_dir_is_allowed() {
        let tmp = make_temp_dir();
        let project = tmp.path().join("proj");
        let src = project.join("src");
        fs::create_dir_all(&src).unwrap();
        // file does not exist, but parent dir does. Canonicalize the parent so
        // the expected path matches (macOS `/var` -> `/private/var`).
        let canonical_src = src.canonicalize().unwrap();
        let missing = canonical_src.join("not-yet.ts");

        let resolved = resolve_workspace_path(project.to_str().unwrap(), "src/not-yet.ts")
            .expect("missing leaf under existing dir should resolve");
        assert_eq!(resolved, missing);
    }

    #[test]
    fn missing_intermediate_dir_under_workspace_is_allowed() {
        let tmp = make_temp_dir();
        let project = tmp.path().join("proj");
        fs::create_dir_all(&project).unwrap();
        // Canonicalize project root so expected path matches across symlinked
        // system temp dirs (macOS `/var` -> `/private/var`).
        let canonical_project = project.canonicalize().unwrap();
        let missing_file = canonical_project.join("newdir").join("deeper.ts");

        let resolved = resolve_workspace_path(project.to_str().unwrap(), "newdir/deeper.ts")
            .expect("missing intermediate dir should resolve via parent walk");
        assert_eq!(resolved, missing_file);
    }

    #[test]
    fn invalid_working_dir_is_rejected() {
        let tmp = make_temp_dir();
        let bogus = tmp.path().join("never-existed");
        let err = resolve_workspace_path(bogus.to_str().unwrap(), "anything.ts")
            .expect_err("invalid working_dir should be rejected");
        assert!(
            err.contains("Invalid working_dir"),
            "unexpected error: {}",
            err
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_inside_workspace_pointing_inside_is_allowed() {
        let tmp = make_temp_dir();
        let project = tmp.path().join("proj");
        let real = project.join("real");
        fs::create_dir_all(&real).unwrap();
        let real_file = real.join("inner.ts");
        fs::write(&real_file, "").unwrap();
        // proj/alias -> proj/real (alias is a symlink but stays inside)
        let alias = project.join("alias");
        symlink(&real, &alias).unwrap();

        let resolved = resolve_workspace_path(project.to_str().unwrap(), "alias/inner.ts")
            .expect("in-workspace symlink should be allowed");
        assert_eq!(resolved, real_file.canonicalize().unwrap());
    }
}

#[tauri::command]
fn open_text_in_vscode(content: String, suggested_name: Option<String>) -> Result<String, String> {
    let sanitized = sanitize_filename(suggested_name.as_deref().unwrap_or("proxy-debug"));
    let extension = if serde_json::from_str::<serde_json::Value>(&content).is_ok() {
        "json"
    } else {
        "txt"
    };

    let timestamp = chrono::Utc::now().timestamp_millis();
    let random_suffix = rand::random::<u32>();
    let filename = format!(
        "ccem-{}-{}-{:08x}.{}",
        sanitized, timestamp, random_suffix, extension
    );
    let temp_path = std::env::temp_dir().join(filename);

    fs::write(&temp_path, content)
        .map_err(|e| format!("Failed to write temp file for VS Code: {}", e))?;

    let code_result = Command::new("code").arg("-r").arg(&temp_path).spawn();

    if code_result.is_ok() {
        return Ok(temp_path.to_string_lossy().to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let open_result = Command::new("open")
            .arg("-a")
            .arg("Visual Studio Code")
            .arg(&temp_path)
            .spawn();
        if open_result.is_ok() {
            return Ok(temp_path.to_string_lossy().to_string());
        }
    }

    Err("Failed to open VS Code. Ensure 'code' CLI is installed and available in PATH.".to_string())
}

fn sanitize_filename(raw: &str) -> String {
    let trimmed = raw.trim();
    let fallback = "proxy-debug".to_string();
    if trimmed.is_empty() {
        return fallback;
    }

    let sanitized: String = trimmed
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .take(40)
        .collect();

    if sanitized.is_empty() {
        fallback
    } else {
        sanitized
    }
}

/// Save content to a file via native save dialog.
#[tauri::command]
async fn save_file_dialog(
    app: tauri::AppHandle,
    content: String,
    default_name: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();

    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("JSON", &["json"])
        .save_file(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });

    match rx.recv().map_err(|e| format!("Dialog error: {}", e))? {
        Some(path) => {
            fs::write(&path, &content).map_err(|e| format!("Failed to write file: {}", e))?;
            Ok(true)
        }
        None => Ok(false), // user cancelled
    }
}

#[tauri::command]
async fn save_image_dialog(
    app: tauri::AppHandle,
    base64_png: String,
    default_name: String,
) -> Result<bool, String> {
    use base64::Engine as _;
    use std::path::PathBuf;
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();

    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("PNG Image", &["png"])
        .save_file(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });

    match rx.recv().map_err(|e| format!("Dialog error: {}", e))? {
        Some(path) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(base64_png)
                .map_err(|e| format!("Failed to decode image data: {}", e))?;
            let path_buf = PathBuf::from(path);
            let target_path = if path_buf.extension().is_some() {
                path_buf
            } else {
                path_buf.with_extension("png")
            };

            fs::write(&target_path, bytes)
                .map_err(|e| format!("Failed to write image file: {}", e))?;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[cfg(target_os = "macos")]
fn copy_png_to_clipboard_native(app: &tauri::AppHandle, png_bytes: Vec<u8>) -> Result<(), String> {
    use objc2::runtime::ProtocolObject;
    use objc2::ClassType;
    use objc2_app_kit::{NSImage, NSPasteboard};
    use objc2_foundation::{NSArray, NSData};

    let (tx, rx) = std::sync::mpsc::channel();

    app.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let data = NSData::with_bytes(&png_bytes);
            let image = NSImage::initWithData(NSImage::alloc(), &data)
                .ok_or_else(|| "Failed to decode PNG image".to_string())?;
            let pasteboard = unsafe { NSPasteboard::generalPasteboard() };
            let writer = ProtocolObject::from_retained(image);
            let writers = NSArray::from_vec(vec![writer]);

            unsafe {
                pasteboard.clearContents();
            }

            let wrote = unsafe { pasteboard.writeObjects(&writers) };
            if !wrote {
                return Err("Failed to write image to clipboard".to_string());
            }

            Ok(())
        })();

        let _ = tx.send(result);
    })
    .map_err(|e| format!("Failed to schedule clipboard copy: {}", e))?;

    rx.recv()
        .map_err(|e| format!("Clipboard copy channel error: {}", e))?
}

#[cfg(not(target_os = "macos"))]
fn copy_png_to_clipboard_native(
    _app: &tauri::AppHandle,
    _png_bytes: Vec<u8>,
) -> Result<(), String> {
    Err("Native image clipboard copy is not implemented on this platform".to_string())
}

#[tauri::command]
async fn copy_image_to_clipboard(app: tauri::AppHandle, base64_png: String) -> Result<(), String> {
    use base64::Engine as _;

    let png_bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_png)
        .map_err(|e| format!("Failed to decode image data: {}", e))?;

    copy_png_to_clipboard_native(&app, png_bytes)
}

/// Force-quit the app, bypassing closeToTray.
/// Called from frontend Cmd+Q handler.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    FORCE_QUIT.store(true, Ordering::SeqCst);
    app.exit(0);
}

fn main() {
    let desktop_instance_lock = match desktop_instance_lock::acquire_desktop_instance_lock() {
        Ok(lock) => lock,
        Err(error) => {
            eprintln!("{}", error);
            return;
        }
    };

    // Create SessionManager from persisted sessions (or empty if first run)
    let session_manager = Arc::new(SessionManager::load_from_disk());
    let interactive_runtime_manager = Arc::new(InteractiveRuntimeManager::default());
    let headless_runtime_manager = Arc::new(HeadlessRuntimeManager::default());
    let native_runtime_manager = Arc::new(NativeRuntimeManager::default());
    let browser_manager = Arc::new(BrowserManager::default());
    let external_control_manager =
        Arc::new(ExternalControlManager::new(native_runtime_manager.clone()));
    let event_dispatcher = Arc::new(EventDispatcher::default());
    let unified_session_manager = Arc::new(UnifiedSessionManager::new(
        headless_runtime_manager.clone(),
        interactive_runtime_manager.clone(),
        event_dispatcher.clone(),
    ));
    let proxy_debug_manager = ProxyDebugManager::new(session_manager.clone())
        .expect("failed to initialize proxy debug manager");
    let telegram_bridge_manager = Arc::new(TelegramBridgeManager::default());
    let wecom_bridge_manager = Arc::new(WecomBridgeManager::default());
    let weixin_bridge_manager = Arc::new(WeixinBridgeManager::default());
    let bot_binding_manager = Arc::new(BotBindingManager::load_from_disk());
    let session_manager_for_setup = session_manager.clone();
    let proxy_manager_for_setup = proxy_debug_manager.clone();
    let proxy_manager_for_run = proxy_debug_manager.clone();
    let external_control_manager_for_setup = external_control_manager.clone();
    let external_control_manager_for_run = external_control_manager.clone();
    let interactive_manager_for_setup = interactive_runtime_manager.clone();
    let interactive_manager_for_run = interactive_runtime_manager.clone();
    let headless_manager_for_run = headless_runtime_manager.clone();
    let telegram_manager_for_setup = telegram_bridge_manager.clone();
    let telegram_manager_for_run = telegram_bridge_manager.clone();
    let wecom_manager_for_setup = wecom_bridge_manager.clone();
    let wecom_manager_for_run = wecom_bridge_manager.clone();
    let weixin_manager_for_setup = weixin_bridge_manager.clone();
    let weixin_manager_for_run = weixin_bridge_manager.clone();
    let bot_binding_manager_for_setup = bot_binding_manager.clone();
    let notification_prefs_state = notifications::NotificationPrefsState::new();
    let main_window_boot_shown = Arc::new(AtomicBool::new(false));
    let main_window_boot_shown_for_page_load = main_window_boot_shown.clone();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_decorum::init());

    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None,
    ));

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

    builder
        .manage(session_manager.clone())
        .manage(interactive_runtime_manager.clone())
        .manage(headless_runtime_manager.clone())
        .manage(native_runtime_manager.clone())
        .manage(browser_manager.clone())
        .manage(external_control_manager.clone())
        .manage(event_dispatcher.clone())
        .manage(unified_session_manager.clone())
        .manage(telegram_bridge_manager.clone())
        .manage(wecom_bridge_manager.clone())
        .manage(weixin_bridge_manager.clone())
        .manage(bot_binding_manager.clone())
        .manage(proxy_debug_manager.clone())
        .manage(desktop_instance_lock)
        .manage(app_updates::PendingUpdate::default())
        .manage(notification_prefs_state)
        .on_page_load(move |webview, payload| {
            if webview.window().label() != "main" || payload.event() != PageLoadEvent::Finished {
                return;
            }
            if main_window_boot_shown_for_page_load.swap(true, Ordering::SeqCst) {
                return;
            }

            let start_minimized = config::read_settings()
                .map(|settings| settings.start_minimized)
                .unwrap_or(false);
            if start_minimized {
                return;
            }

            let main_window = webview.window();
            if let Err(error) = main_window.show() {
                eprintln!("Main window boot show warning: {}", error);
            }
            if let Err(error) = main_window.set_focus() {
                eprintln!("Main window boot focus warning: {}", error);
            }
        })
        .invoke_handler(tauri::generate_handler![
            companion::get_companion,
            pet_notifications::get_pet_notification_read_state,
            pet_notifications::mark_pet_notification_read,
            pet_notifications::open_pet_notification,
            pet_window::resize_pet_window,
            pet_window::set_pet_window_content_visible,
            browser::browser_set_active_session,
            browser::browser_open,
            browser::browser_set_bounds,
            browser::browser_set_visible,
            browser::browser_close,
            browser::browser_navigate,
            browser::browser_reload,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_info,
            browser::browser_health_check,
            browser::browser_set_paused,
            browser::browser_recent_activity,
            browser::browser_runtime_readiness,
            browser::browser_snapshot,
            browser::browser_screenshot,
            tray::open_tray_cockpit,
            app_updates::get_app_version,
            app_updates::check_app_update,
            app_updates::install_app_update,
            app_updates::restart_app,
            doctor::collect_doctor_report,
            greet,
            get_system_username,
            get_environments,
            get_current_env,
            set_current_env,
            add_environment,
            update_environment,
            delete_environment,
            get_app_config,
            add_favorite,
            remove_favorite,
            add_recent,
            detect_terminals,
            list_tmux_attach_terminals,
            get_preferred_terminal,
            set_preferred_terminal,
            launch_claude_code,
            create_interactive_session,
            record_session_launch_trace,
            get_session_launch_log_path,
            list_runtime_recovery_candidates,
            dismiss_runtime_recovery_candidate,
            list_interactive_sessions,
            stop_interactive_session,
            focus_interactive_session,
            open_interactive_session_in_terminal,
            close_interactive_session,
            close_unified_interactive_session,
            minimize_interactive_session,
            write_interactive_input,
            send_interactive_input,
            send_interactive_approval,
            get_interactive_session_output,
            get_interactive_session_events,
            get_interactive_state,
            resize_interactive_session,
            create_managed_session,
            list_managed_sessions,
            send_to_managed_session,
            get_managed_session_events,
            stop_managed_session,
            remove_managed_session,
            create_headless_session,
            list_headless_sessions,
            send_to_headless_session,
            get_headless_session_events,
            stop_headless_session,
            remove_headless_session,
            respond_headless_permission,
            create_native_session,
            list_native_sessions,
            send_native_session_input,
            respond_native_session_permission,
            respond_native_session_prompt,
            rewind_native_session_files,
            get_native_session_events,
            read_prompt_image_attachment,
            update_native_session_settings,
            set_native_session_runtime_perm_mode,
            stop_native_session,
            handoff_native_session_to_terminal,
            launch_opencode_web,
            list_unified_sessions,
            get_session_events,
            get_workspace_session_decorations,
            send_session_input,
            stop_unified_session,
            attach_channel,
            detach_channel,
            bind_session_to_bot,
            list_session_bot_bindings,
            get_session_bot_binding_outbox,
            send_bot_bound_session_input,
            process_bot_binding_requests,
            debug_compare_sessions,
            list_sessions,
            stop_session,
            remove_session,
            focus_session,
            close_session,
            minimize_session,
            open_directory_dialog,
            sync_vscode_projects,
            sync_jetbrains_projects,
            get_usage_stats,
            get_usage_history,
            get_usage_model_breakdown,
            get_continuous_usage_days,
            check_ccem_installed,
            check_claude_installed,
            check_codex_installed,
            check_opencode_installed,
            check_tmux_installed,
            get_platform_capabilities,
            load_from_remote,
            arrange_sessions,
            check_arrange_support,
            get_conversation_detail,
            get_conversation_history,
            get_workspace_overview_snapshot,
            get_conversation_messages,
            get_conversation_segments,
            get_session_subagents,
            search_conversation_history,
            title_overrides::set_session_title,
            session_titles::generate_workspace_session_title,
            session_annotations::set_session_annotation,
            session_annotations::clear_session_annotation,
            slash_commands::list_workspace_commands,
            skills::search_skills_stream,
            skills::list_installed_skills,
            skills::list_workspace_skills,
            skills::read_skill_files,
            skills::get_ccem_agent_skill_status,
            skills::install_ccem_agent_skill,
            skills::get_curated_skills,
            skills::install_skill,
            skills::uninstall_skill,
            search_workspace_files,
            cron::list_cron_tasks,
            cron::add_cron_task,
            cron::update_cron_task,
            cron::delete_cron_task,
            cron::toggle_cron_task,
            cron::get_cron_task_runs,
            cron::retry_cron_task,
            cron::get_cron_run_detail,
            cron::list_cron_templates,
            cron::get_cron_next_runs,
            cron::generate_cron_task_stream,
            get_default_working_dir,
            set_default_working_dir,
            get_settings,
            save_settings,
            send_test_notification,
            get_telegram_settings,
            get_wecom_settings,
            get_wecom_task_binding_defaults,
            get_wecom_task_binding_options,
            get_weixin_settings,
            save_telegram_settings,
            save_wecom_settings,
            save_weixin_settings,
            get_telegram_bridge_status,
            get_wecom_bridge_status,
            get_weixin_bridge_status,
            start_telegram_bridge,
            start_wecom_bridge,
            start_weixin_bridge,
            stop_telegram_bridge,
            stop_wecom_bridge,
            stop_weixin_bridge,
            start_weixin_login,
            poll_weixin_login,
            get_telegram_forum_topics,
            bind_telegram_topic,
            get_proxy_debug_state,
            set_proxy_debug_enabled,
            update_proxy_debug_config,
            list_proxy_traffic,
            get_proxy_traffic_detail,
            clear_proxy_traffic,
            get_workspace_git_snapshot,
            get_workspace_file_diff,
            get_workspace_media_preview,
            open_file_in_workspace,
            open_text_in_vscode,
            save_file_dialog,
            save_image_dialog,
            copy_image_to_clipboard,
            window_control,
            quit_app
        ])
        .on_window_event(|window, event| {
            if window.label() == TRAY_COCKPIT_LABEL {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Err(error) = tray::hide_tray_cockpit(window.app_handle()) {
                        eprintln!("Tray cockpit close warning: {}", error);
                    }
                }
                return;
            }

            if window.label() != "main" {
                return;
            }

            match event {
                WindowEvent::CloseRequested { api, .. }
                    // Only intercept the main window, and never when force-quit is requested
                    if !FORCE_QUIT.load(Ordering::SeqCst) => {
                        let close_to_tray = config::read_settings()
                            .map(|s| s.close_to_tray)
                            .unwrap_or(true);
                        if close_to_tray {
                            api.prevent_close();
                            let _ = window.hide();
                        }
                    }
                _ => {}
            }
        })
        .setup(move |app| {
            if let Err(error) = cleanup_orphaned_runtime_processes() {
                eprintln!("Runtime orphan cleanup warning: {}", error);
            }

            // Clean up stale exit files not belonging to any persisted session
            cleanup_stale_exit_files_except(&session_manager_for_setup);

            // Validate persisted sessions against actual terminal state
            session_manager_for_setup.validate_and_reconcile();
            match native_runtime_manager.reconcile_stale_records() {
                Ok(count) if count > 0 => {
                    eprintln!("Reconciled {} stale native runtime record(s)", count);
                }
                Ok(_) => {}
                Err(error) => eprintln!("Native runtime reconcile warning: {}", error),
            }
            if let Err(error) = interactive_manager_for_setup
                .rehydrate_existing(app.handle().clone(), session_manager_for_setup.clone())
            {
                eprintln!("Interactive tmux rehydrate warning: {}", error);
            }
            match interactive_manager_for_setup.cleanup_orphaned_tmux_sessions() {
                Ok(cleaned) if !cleaned.is_empty() => {
                    eprintln!(
                        "Cleaned {} orphaned CCEM tmux target(s): {}",
                        cleaned.len(),
                        cleaned.join(", ")
                    );
                }
                Ok(_) => {}
                Err(error) => eprintln!("Interactive tmux orphan cleanup warning: {}", error),
            }

            proxy_manager_for_setup.set_app_handle(app.handle().clone());
            if let Err(error) = external_control_manager_for_setup.start(app.handle().clone()) {
                eprintln!("External control startup warning: {}", error);
            }

            // Auto-migrate configuration if needed
            if let Err(e) = config::migrate_if_needed() {
                eprintln!("Config migration warning: {}", e);
            }

            // Load desktop settings once for startup logic
            let startup_settings = config::read_settings().unwrap_or_default();

            // Sync autostart state from settings
            {
                use tauri_plugin_autostart::ManagerExt;
                let autostart = app.autolaunch();
                if startup_settings.auto_start {
                    let _ = autostart.enable();
                } else {
                    let _ = autostart.disable();
                }
            }

            // macOS titlebar and traffic-light position are configured in tauri.conf.json.
            // Keep decorum's macOS delegate out of the process so resize does not repaint controls.
            #[cfg(target_os = "macos")]
            {
                let main_window = app.get_webview_window("main").unwrap();
                if let Err(error) = sync_macos_window_appearance(&main_window, &startup_settings) {
                    eprintln!("Window appearance warning: {}", error);
                }
            }

            // startMinimized: hide window immediately after setup (platform-independent)
            if startup_settings.start_minimized {
                if let Some(w) = app.get_window("main") {
                    let _ = w.hide();
                }
            }

            if startup_settings.desktop_pet_enabled {
                let app_handle = app.handle().clone();
                if let Err(error) = pet_window::sync_pet_window_visibility(
                    &app_handle,
                    startup_settings.desktop_pet_enabled,
                ) {
                    eprintln!("Desktop pet startup warning: {}", error);
                }
            }

            let _ = create_tray(app.handle())?;

            // Start session monitor background task
            start_session_monitor(app.handle().clone(), session_manager_for_setup.clone());

            // Start proxy debug server if enabled in settings.
            let proxy_for_boot = proxy_manager_for_setup.clone();
            tauri::async_runtime::spawn(async move {
                proxy_for_boot.maybe_start_on_boot().await;
            });

            // Start cron scheduler background task
            let cron_scheduler = Arc::new(CronScheduler::default());
            app.manage(cron_scheduler.clone());
            let cron_app = app.handle().clone();
            start_cron_scheduler(cron_app, cron_scheduler, unified_session_manager.clone());
            bot_binding_manager_for_setup.start_request_watcher(
                app.handle().clone(),
                unified_session_manager.clone(),
                native_runtime_manager.clone(),
                {
                    let bot_binding_manager = bot_binding_manager_for_setup.clone();
                    let wecom_manager = wecom_manager_for_setup.clone();
                    move |infos| {
                        for info in infos {
                            if info.send_task_card {
                                let _ = deliver_bot_binding_task_card(
                                    &bot_binding_manager,
                                    &wecom_manager,
                                    &info,
                                );
                            }
                        }
                    }
                },
            );

            if let Ok(settings) = telegram::read_telegram_settings() {
                telegram_manager_for_setup.sync_settings(&settings);
                if settings.enabled
                    && settings
                        .bot_token
                        .as_ref()
                        .is_some_and(|value| !value.trim().is_empty())
                {
                    if let Err(error) = telegram_manager_for_setup.clone().start(
                        app.handle().clone(),
                        headless_runtime_manager.clone(),
                        interactive_runtime_manager.clone(),
                    ) {
                        eprintln!("Telegram bridge auto-start warning: {}", error);
                    }
                }
            }

            if let Ok(settings) = weixin::read_weixin_settings() {
                weixin_manager_for_setup.sync_settings(&settings);
                if settings.enabled
                    && settings
                        .bot_token
                        .as_ref()
                        .is_some_and(|value| !value.trim().is_empty())
                {
                    if let Err(error) = weixin_manager_for_setup
                        .clone()
                        .start(app.handle().clone(), headless_runtime_manager.clone())
                    {
                        eprintln!("Weixin bridge auto-start warning: {}", error);
                    }
                }
            }

            if let Ok(settings) = wecom::read_wecom_settings() {
                wecom_manager_for_setup.sync_settings(&settings);
                if settings.enabled
                    && settings.bots.iter().any(|bot| {
                        bot.enabled
                            && !bot.bot_id.trim().is_empty()
                            && bot
                                .secret
                                .as_ref()
                                .is_some_and(|value| !value.trim().is_empty())
                    })
                {
                    if let Err(error) = wecom_manager_for_setup
                        .clone()
                        .start(app.handle().clone(), headless_runtime_manager.clone())
                    {
                        eprintln!("WeCom bridge auto-start warning: {}", error);
                    }
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app_handle, event| {
            #[cfg(not(target_os = "macos"))]
            let _ = &app_handle;

            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = &event {
                // macOS Dock icon click should reopen/show the main window.
                if let Some(window) = app_handle.get_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                return;
            }

            if let RunEvent::Exit = event {
                telegram_manager_for_run.stop();
                wecom_manager_for_run.stop();
                weixin_manager_for_run.stop();
                interactive_manager_for_run.shutdown_all();
                headless_manager_for_run.shutdown_all();
                let proxy_for_shutdown = proxy_manager_for_run.clone();
                tauri::async_runtime::block_on(async move {
                    proxy_for_shutdown.shutdown().await;
                });
                external_control_manager_for_run.shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        build_remote_load_args, build_remote_load_stdin_payload, media_kind_for_extension,
        merge_git_numstat, normalize_git_changed_path, parse_git_status_line,
        WorkspaceGitChangedFile,
    };
    use std::collections::HashMap;

    #[test]
    fn test_set_current_env_validates_existence() {
        // 这个测试需要临时配置文件，暂时跳过
        // 实际测试应该在集成测试中进行
    }

    #[test]
    fn test_launch_claude_code_validates_env() {
        // 这个测试需要完整的 Tauri 上下文，暂时跳过
        // 实际测试应该在集成测试中进行
    }

    // -----------------------------------------------------------------
    // Remote-load credential isolation: argv must never carry the
    // encryption secret or access key. They travel through a stdin
    // pipe instead, so process listings / crash dumps cannot capture them.
    // -----------------------------------------------------------------
    #[test]
    fn remote_load_args_never_carry_credentials() {
        let args = build_remote_load_args("https://example.com/config");

        // The server URL is fine — it is a public address, not a credential.
        assert!(args.contains(&"https://example.com/config".to_string()));

        // No credential flags may appear in argv.
        assert!(!args.iter().any(|a| a == "--secret"));
        assert!(!args.iter().any(|a| a == "--key"));

        // The stdin channel must be requested.
        assert!(args.contains(&"--credentials-stdin".to_string()));

        // JSON output mode stays on so the desktop can parse the result.
        assert!(args.contains(&"--json".to_string()));
    }

    #[test]
    fn remote_load_stdin_payload_carries_credentials_separately() {
        let payload = build_remote_load_stdin_payload("access-key-abc", "encryption-secret-xyz");
        let parsed: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed["secret"], "encryption-secret-xyz");
        assert_eq!(parsed["key"], "access-key-abc");

        // Empty key is omitted — the CLI falls back to secret for auth.
        let payload_no_key = build_remote_load_stdin_payload("", "encryption-secret-xyz");
        let parsed_no_key: serde_json::Value = serde_json::from_str(&payload_no_key).unwrap();
        assert_eq!(parsed_no_key["secret"], "encryption-secret-xyz");
        assert!(parsed_no_key.get("key").is_none() || parsed_no_key["key"].is_null());
    }

    #[test]
    fn remote_load_args_and_stdin_keep_secret_out_of_argv() {
        // End-to-end contract: a real secret value must only appear in the
        // stdin payload, never in the argv vector built for the same call.
        let secret = "sk-ant-secret-DO-NOT-LEAK";
        let key = "access-key-DO-NOT-LEAK";
        let url = "https://example.com/config";

        let args = build_remote_load_args(url);
        let stdin = build_remote_load_stdin_payload(key, secret);

        assert!(!args.iter().any(|a| a.contains(secret)));
        assert!(!args.iter().any(|a| a.contains(key)));
        assert!(stdin.contains(secret));
        assert!(stdin.contains(key));
    }

    #[test]
    fn git_status_parser_keeps_final_rename_path() {
        assert_eq!(
            parse_git_status_line("R  old/path.txt -> new/path.txt"),
            Some(("new/path.txt".to_string(), "R".to_string()))
        );
        assert_eq!(
            parse_git_status_line("?? docs/report.html"),
            Some(("docs/report.html".to_string(), "??".to_string()))
        );
    }

    #[test]
    fn git_changed_path_normalizes_numstat_rename_syntax() {
        assert_eq!(
            normalize_git_changed_path("src/{old_name.rs => new_name.rs}"),
            "src/new_name.rs"
        );
        assert_eq!(
            normalize_git_changed_path("old/path.txt => new/path.txt"),
            "new/path.txt"
        );
    }

    #[test]
    fn git_numstat_merges_worktree_and_cached_counts() {
        let mut files = HashMap::from([(
            "src/app.ts".to_string(),
            WorkspaceGitChangedFile {
                path: "src/app.ts".to_string(),
                status: "M".to_string(),
                additions: None,
                deletions: None,
            },
        )]);

        merge_git_numstat(
            &mut files,
            "2\t1\tsrc/app.ts\n-\t-\tassets/{old.png => logo.png}",
        );
        merge_git_numstat(&mut files, "3\t4\tsrc/app.ts");

        let app = files.get("src/app.ts").unwrap();
        assert_eq!(app.additions, Some(5));
        assert_eq!(app.deletions, Some(5));
        let logo = files.get("assets/logo.png").unwrap();
        assert_eq!(logo.additions, Some(0));
        assert_eq!(logo.deletions, Some(0));
    }

    #[test]
    fn media_kind_resolver_maps_common_extensions() {
        assert_eq!(
            media_kind_for_extension("screenshot.png"),
            Some(("image", "image/png"))
        );
        assert_eq!(
            media_kind_for_extension("photo.JPG"),
            Some(("image", "image/jpeg"))
        );
        assert_eq!(
            media_kind_for_extension("assets/anim.gif"),
            Some(("image", "image/gif"))
        );
        assert_eq!(
            media_kind_for_extension("icon.svg"),
            Some(("image", "image/svg+xml"))
        );
        assert_eq!(
            media_kind_for_extension("clip.mp4"),
            Some(("video", "video/mp4"))
        );
        assert_eq!(
            media_kind_for_extension("voice.m4a"),
            Some(("audio", "audio/mp4"))
        );
    }

    #[test]
    fn media_kind_resolver_rejects_non_media_extensions() {
        assert_eq!(media_kind_for_extension("README.md"), None);
        assert_eq!(media_kind_for_extension("src/app.tsx"), None);
        assert_eq!(media_kind_for_extension("noext"), None);
        assert_eq!(media_kind_for_extension(""), None);
    }
}
