//! Recover only the main renderer. This module never owns or changes a session.
//! A WebKit termination callback does not identify the cause (including OOM).
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{Mutex, RwLock},
    time::{Duration, Instant},
};
use tauri::{webview::PageLoadEvent, AppHandle, Manager, Webview};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const RETRY_WINDOW: Duration = Duration::from_secs(600);
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(3),
    Duration::from_secs(10),
];
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const SAMPLE_MIN_INTERVAL: Duration = Duration::from_secs(5);
const MAX_CLOSED_BROWSER_TARGETS: usize = 8192;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendSample {
    pub dom_node_count: u64,
    pub transcript_row_count: u64,
    pub visible: bool,
    pub heap_used_bytes: Option<u64>,
    pub raw_event_count: u64,
    pub projected_message_count: u64,
    pub tool_result_chars: u64,
    pub mounted_session_count: u64,
    pub recovery_draft_count: u64,
    pub recovery_uncertain_submission_count: u64,
    pub recovery_draft_write_failures: u64,
}

impl FrontendSample {
    fn validate(&self) -> Result<(), &'static str> {
        // All fields are counters; reject implausible values instead of logging
        // arbitrary data. JS unsafe integers are not accepted as diagnostics.
        let counters = [
            self.dom_node_count,
            self.transcript_row_count,
            self.raw_event_count,
            self.projected_message_count,
            self.tool_result_chars,
            self.mounted_session_count,
            self.recovery_draft_count,
            self.recovery_uncertain_submission_count,
            self.recovery_draft_write_failures,
            self.heap_used_bytes.unwrap_or(0),
        ];
        if counters.iter().any(|value| *value > 9_007_199_254_740_991) {
            return Err("Invalid renderer diagnostic counter");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendBoot {
    pub generation: u64,
    pub recovered: bool,
    pub document_id: String,
    pub browser_workspace: Option<BrowserWorkspace>,
}

/// Only the browser's routing identity is retained. This is host memory, never a
/// disk snapshot or recovery log, and cannot grant a browser session authority.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserWorkspace {
    version: u8,
    instance_sequence: u64,
    targets: HashMap<String, BrowserWorkspaceTarget>,
    session_keys: BrowserWorkspaceSessionKeys,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserWorkspaceTarget {
    instance_id: u64,
    surface_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    visible: Option<bool>,
    working_dir: String,
    backend: String,
    profile_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    initial_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserWorkspaceSessionKeys {
    runtime: Vec<(String, String)>,
    provider: Vec<(String, String)>,
}

impl BrowserWorkspace {
    fn validate(&self) -> Result<(), &'static str> {
        let bounded = |value: &str, max| !value.is_empty() && value.len() <= max;
        if self.version != 1
            || self.instance_sequence > 9_007_199_254_740_991
            || self.targets.len() > 1024
            || self.session_keys.runtime.len() > 8192
            || self.session_keys.provider.len() > 8192
        {
            return Err("Invalid browser workspace snapshot");
        }
        for (key, target) in &self.targets {
            let valid_profile = match target.profile_mode.as_str() {
                "default" | "new" => target.profile_id.is_none(),
                "saved" => target
                    .profile_id
                    .as_deref()
                    .is_some_and(|id| bounded(id, 160)),
                _ => false,
            };
            if !bounded(key, 1024)
                || target.instance_id == 0
                || target.instance_id > self.instance_sequence
                || !bounded(&target.surface_session_id, 160)
                || !target.surface_session_id.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
                })
                || target.backend != "login"
                || !bounded(&target.working_dir, 8192)
                || !valid_profile
                || target
                    .initial_url
                    .as_deref()
                    .is_some_and(|url| !bounded(url, 16_384))
            {
                return Err("Invalid browser workspace target");
            }
        }
        for (identity, key) in self
            .session_keys
            .runtime
            .iter()
            .chain(&self.session_keys.provider)
        {
            if !bounded(identity, 1024) || !bounded(key, 1024) {
                return Err("Invalid browser workspace session alias");
            }
        }
        if serde_json::to_vec(self)
            .map_err(|_| "Invalid browser workspace snapshot")?
            .len()
            > 2 * 1024 * 1024
        {
            return Err("Browser workspace snapshot is too large");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Loading,
    Ready,
    WaitingToReload,
    Blocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ReloadTicket {
    generation: u64,
    delay: Duration,
}

#[derive(Debug)]
struct RecoveryPolicy {
    generation: u64,
    document_id: Option<String>,
    retired_documents: VecDeque<String>,
    phase: Phase,
    recovered: bool,
    load_started: bool,
    attempts: VecDeque<Instant>,
    termination_count: u64,
}

impl Default for RecoveryPolicy {
    fn default() -> Self {
        Self {
            generation: 0,
            document_id: None,
            retired_documents: VecDeque::new(),
            phase: Phase::Loading,
            recovered: false,
            load_started: false,
            attempts: VecDeque::new(),
            termination_count: 0,
        }
    }
}

impl RecoveryPolicy {
    fn attempts_in_window(&self, now: Instant) -> usize {
        self.attempts
            .iter()
            .filter(|attempt| now.saturating_duration_since(**attempt) < RETRY_WINDOW)
            .count()
    }

    fn invalidate_document(&mut self) {
        if let Some(document_id) = self.document_id.take() {
            self.retired_documents.push_back(document_id);
            while self.retired_documents.len() > 8 {
                self.retired_documents.pop_front();
            }
        }
        self.generation = self.generation.saturating_add(1);
    }

    fn request_reload(&mut self, now: Instant) -> Option<ReloadTicket> {
        self.invalidate_document();
        self.recovered = true;
        self.load_started = false;
        while self
            .attempts
            .front()
            .is_some_and(|previous| now.saturating_duration_since(*previous) >= RETRY_WINDOW)
        {
            self.attempts.pop_front();
        }
        if self.attempts.len() >= RETRY_DELAYS.len() {
            self.phase = Phase::Blocked;
            return None;
        }
        let delay = RETRY_DELAYS[self.attempts.len()];
        self.attempts.push_back(now);
        self.phase = Phase::WaitingToReload;
        Some(ReloadTicket {
            generation: self.generation,
            delay,
        })
    }

    fn terminated(&mut self, now: Instant) -> Option<ReloadTicket> {
        self.termination_count = self.termination_count.saturating_add(1);
        // Duplicate native notifications cannot spend the budget or queue more
        // reloads. A blocked renderer requires explicit user intervention.
        if matches!(self.phase, Phase::WaitingToReload | Phase::Blocked) {
            return None;
        }
        self.request_reload(now)
    }

    fn begin_reload(&mut self, generation: u64) -> bool {
        if self.phase != Phase::WaitingToReload || self.generation != generation {
            return false;
        }
        self.phase = Phase::Loading;
        true
    }

    fn manual_retry(&mut self, now: Instant) -> Option<ReloadTicket> {
        if self.phase != Phase::Blocked {
            return None;
        }
        self.attempts.clear();
        self.request_reload(now)
    }

    fn abort_dispatch(&mut self, generation: u64) -> bool {
        if self.generation != generation
            || !matches!(self.phase, Phase::WaitingToReload | Phase::Loading)
        {
            return false;
        }
        self.invalidate_document();
        self.phase = Phase::Blocked;
        true
    }

    fn timed_out(&mut self, generation: u64, now: Instant) -> Option<ReloadTicket> {
        if self.generation != generation || self.phase != Phase::Loading {
            return None;
        }
        self.request_reload(now)
    }

    fn page_started(&mut self) {
        // request_reload already advances generation and clears load_started.
        // Every later Started must also advance it, even if the preceding boot
        // is still queued and has not registered its document UUID yet.
        if self.phase == Phase::Ready || self.load_started {
            self.invalidate_document();
        }
        if self.phase != Phase::Blocked {
            self.phase = Phase::Loading;
        }
        self.load_started = true;
    }

    fn boot(&mut self, document_id: &str) -> Result<FrontendBoot, &'static str> {
        if !valid_document_id(document_id) {
            return Err("Invalid renderer document identity");
        }
        if matches!(self.phase, Phase::Blocked | Phase::WaitingToReload)
            || self.retired_documents.iter().any(|id| id == document_id)
            || self
                .document_id
                .as_deref()
                .is_some_and(|id| id != document_id)
        {
            return Err("Stale renderer document");
        }
        self.document_id = Some(document_id.to_owned());
        Ok(FrontendBoot {
            generation: self.generation,
            recovered: self.recovered,
            document_id: document_id.to_owned(),
            browser_workspace: None,
        })
    }

    fn accepts_document(&self, document_id: &str, generation: u64) -> bool {
        self.generation == generation
            && self.document_id.as_deref() == Some(document_id)
            && matches!(self.phase, Phase::Loading | Phase::Ready)
    }

    fn ready(&mut self, document_id: &str, generation: u64) -> Result<bool, &'static str> {
        if !self.accepts_document(document_id, generation) {
            return Err("Stale renderer ready acknowledgement");
        }
        let changed = self.phase != Phase::Ready;
        self.phase = Phase::Ready;
        // Never reset attempts on ACK: a crash loop can briefly paint each time.
        Ok(changed)
    }
}

fn valid_document_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

struct RecoveryState {
    policy: RecoveryPolicy,
    browser_document_initialized: bool,
    browser_workspace: Option<BrowserWorkspace>,
    browser_workspace_last_save: Option<BrowserWorkspace>,
    browser_workspace_revision: u64,
    closed_browser_targets: HashSet<String>,
    browser_workspace_closure_overflow: bool,
    last_sample: Option<FrontendSample>,
    last_sample_at: Option<Instant>,
    last_sample_wall_time: Option<String>,
    last_sample_document_id: Option<String>,
    last_sample_generation: Option<u64>,
    logger: RecoveryLogger,
}

struct RecoveryLogger {
    path: Option<PathBuf>,
    app_identifier: String,
    app_version: String,
}

impl RecoveryLogger {
    fn write(&self, record: &serde_json::Value) {
        let Some(path) = &self.path else { return };
        let result = (|| -> std::io::Result<()> {
            let Some(parent) = path.parent() else {
                return Ok(());
            };
            fs::create_dir_all(parent)?;
            let mut line = serde_json::to_vec(record)?;
            line.push(b'\n');
            if fs::metadata(path).map(|meta| meta.len()).unwrap_or(0) + line.len() as u64
                > MAX_LOG_BYTES
            {
                let previous = path.with_extension("previous.jsonl");
                match fs::remove_file(&previous) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
                fs::rename(path, previous)?;
            }
            let mut options = OpenOptions::new();
            options.create(true).append(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options.open(path)?.write_all(&line)
        })();
        if result.is_err() {
            // Raw OS error messages can contain local paths. Diagnostics remain
            // best-effort and never block session execution or recovery.
            eprintln!("CCEM renderer recovery diagnostic write failed");
        }
    }
}

impl RecoveryState {
    fn record(&self, event: &'static str) {
        self.logger.write(&serde_json::json!({
            "schemaVersion": 1,
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "event": event,
            "appIdentifier": self.logger.app_identifier,
            "appVersion": self.logger.app_version,
            "appPid": std::process::id(),
            "webviewLabel": "main",
            "generation": self.policy.generation,
            "documentId": self.policy.document_id,
            "phase": self.policy.phase,
            "recovered": self.policy.recovered,
            "attemptsInWindow": self.policy.attempts_in_window(Instant::now()),
            "terminationCount": self.policy.termination_count,
            "terminationReason": "unknown",
            "lastSampleAt": self.last_sample_wall_time,
            "lastSampleDocumentId": self.last_sample_document_id,
            "lastSampleGeneration": self.last_sample_generation,
            "lastSample": self.last_sample,
        }));
    }
}

// Browser workers hold a shared document guard for their complete transaction;
// boot holds the exclusive guard through lease reset. Native page/termination
// callbacks only lock state, never this guard: waiting on the UI thread would
// deadlock a worker that is waiting for native CEF or Preview dispatch.
pub struct WebContentRecovery(Mutex<RecoveryState>, RwLock<()>);

impl WebContentRecovery {
    fn require_browser_document(&self, document_id: &str, generation: u64) -> Result<(), String> {
        let state = self
            .0
            .lock()
            .map_err(|_| "Renderer recovery state unavailable")?;
        if !state.browser_document_initialized
            || !state.policy.accepts_document(document_id, generation)
        {
            return Err("Stale renderer browser request".into());
        }
        Ok(())
    }

    fn with_document<T>(
        &self,
        document_id: &str,
        generation: u64,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _document = self
            .1
            .read()
            .map_err(|_| "Renderer document gate unavailable")?;
        self.require_browser_document(document_id, generation)?;
        operation()
    }

    fn with_exclusive_document<T>(
        &self,
        document_id: &str,
        generation: u64,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _document = self
            .1
            .write()
            .map_err(|_| "Renderer document gate unavailable")?;
        self.require_browser_document(document_id, generation)?;
        operation()
    }

    fn boot_generation_ticket(&self) -> Result<u64, String> {
        Ok(self
            .0
            .lock()
            .map_err(|_| "Renderer recovery state unavailable")?
            .policy
            .generation)
    }

    fn boot_document(
        &self,
        document_id: &str,
        generation_ticket: u64,
        reset: impl FnOnce() -> Result<(), String>,
    ) -> Result<FrontendBoot, String> {
        let _document = self
            .1
            .write()
            .map_err(|_| "Renderer document gate unavailable")?;
        let (mut boot, needs_reset) = {
            let mut state = self
                .0
                .lock()
                .map_err(|_| "Renderer recovery state unavailable")?;
            if state.policy.generation != generation_ticket {
                return Err("Stale renderer boot ticket".into());
            }
            let changed = state.policy.document_id.as_deref() != Some(document_id);
            let boot = state.policy.boot(document_id)?;
            if changed {
                state.browser_document_initialized = false;
                state.browser_workspace_revision = 0;
                state.browser_workspace_last_save = None;
                state.closed_browser_targets.clear();
                state.browser_workspace_closure_overflow = false;
                state.record("frontend_boot");
            }
            (boot, !state.browser_document_initialized)
        };
        if needs_reset {
            reset()?;
        }
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Renderer recovery state unavailable")?;
        if !state.policy.accepts_document(document_id, boot.generation) {
            return Err("Renderer document changed during browser recovery".into());
        }
        state.browser_document_initialized = true;
        boot.browser_workspace = state.browser_workspace.clone();
        Ok(boot)
    }

    #[cfg(test)]
    fn save_browser_workspace(
        &self,
        document_id: &str,
        generation: u64,
        revision: u64,
        workspace: BrowserWorkspace,
    ) -> Result<(), String> {
        self.save_browser_workspace_with_cleanup(
            document_id,
            generation,
            revision,
            workspace,
            |_| Ok(false),
        )
    }

    fn save_browser_workspace_with_cleanup(
        &self,
        document_id: &str,
        generation: u64,
        revision: u64,
        mut workspace: BrowserWorkspace,
        mut close_removed: impl FnMut(&str) -> Result<bool, String>,
    ) -> Result<(), String> {
        workspace.validate()?;
        self.with_exclusive_document(document_id, generation, || {
            let removed = {
                let state = self
                    .0
                    .lock()
                    .map_err(|_| "Renderer recovery state unavailable")?;
                // Native callbacks never wait on the document guard, so check
                // the current policy before planning native cleanup.
                if !state.policy.accepts_document(document_id, generation) {
                    return Err("Stale renderer browser workspace".into());
                }
                if revision == 0
                    || revision > 9_007_199_254_740_991
                    || revision < state.browser_workspace_revision
                {
                    return Err("Stale browser workspace revision".into());
                }
                if revision == state.browser_workspace_revision {
                    return if state.browser_workspace_last_save.as_ref() == Some(&workspace) {
                        Ok(())
                    } else {
                        Err("Browser workspace revision already contains different metadata".into())
                    };
                }
                if state.browser_workspace_closure_overflow {
                    return Err(
                        "Browser recovery close history is full; reload before saving new metadata"
                            .into(),
                    );
                }
                let retained: HashSet<&str> = workspace
                    .targets
                    .values()
                    .map(|target| target.surface_session_id.as_str())
                    .collect();
                let mut removed: Vec<String> = state
                    .browser_workspace
                    .as_ref()
                    .into_iter()
                    .flat_map(|previous| previous.targets.values())
                    .filter(|target| !retained.contains(target.surface_session_id.as_str()))
                    .map(|target| target.surface_session_id.clone())
                    .collect();
                removed.sort();
                removed.dedup();
                removed
            };
            // Do not hold RecoveryState across main-thread native dispatch.
            // Record each successful close before attempting the next one, so a
            // partial failure preserves only the metadata that still needs it.
            for panel_session_id in removed {
                if close_removed(&panel_session_id)? {
                    self.forget_closed_browser_target(&panel_session_id)?;
                }
            }
            let mut state = self
                .0
                .lock()
                .map_err(|_| "Renderer recovery state unavailable")?;
            if !state.policy.accepts_document(document_id, generation) {
                return Err("Renderer document changed during browser workspace cleanup".into());
            }
            if state.browser_workspace_closure_overflow {
                return Err(
                    "Browser recovery close history is full; reload before saving new metadata"
                        .into(),
                );
            }
            state.browser_workspace_last_save = Some(workspace.clone());
            // A snapshot queued while native close was in progress cannot
            // resurrect that same physical panel after its close receipt.
            workspace.targets.retain(|_, target| {
                !state
                    .closed_browser_targets
                    .contains(&target.surface_session_id)
            });
            state.browser_workspace = Some(workspace);
            state.browser_workspace_revision = revision;
            Ok(())
        })
    }

    fn forget_closed_browser_target(&self, panel_session_id: &str) -> Result<(), String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Renderer recovery state unavailable")?;
        if state.closed_browser_targets.len() < MAX_CLOSED_BROWSER_TARGETS
            || state.closed_browser_targets.contains(panel_session_id)
        {
            state
                .closed_browser_targets
                .insert(panel_session_id.to_owned());
        } else {
            // Never evict an old tombstone or close an unrelated live runtime.
            // Until a new document boots, reject fresh snapshots instead.
            state.browser_workspace_closure_overflow = true;
        }
        if let Some(workspace) = state.browser_workspace.as_mut() {
            workspace
                .targets
                .retain(|_, target| target.surface_session_id != panel_session_id);
        }
        Ok(())
    }
}

/// Must only be called from a blocking worker, including for Preview commands.
pub(crate) fn with_frontend_browser_document<T>(
    app: &AppHandle,
    document_id: &str,
    generation: u64,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    app.try_state::<WebContentRecovery>()
        .ok_or_else(|| "Renderer recovery state unavailable".to_string())?
        .with_document(document_id, generation, operation)
}

/// Close commits both native lifetime and recovery metadata. The exclusive
/// transaction also prevents an already queued acquire from reusing the closed
/// identity between native removal and its metadata tombstone.
pub(crate) fn with_frontend_browser_document_exclusive<T>(
    app: &AppHandle,
    document_id: &str,
    generation: u64,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    app.try_state::<WebContentRecovery>()
        .ok_or_else(|| "Renderer recovery state unavailable".to_string())?
        .with_exclusive_document(document_id, generation, operation)
}

/// Called inside the document transaction before creating or re-acquiring a
/// native runtime. An unacknowledged frontend identity must not create an orphan.
pub(crate) fn require_saved_browser_target(
    app: &AppHandle,
    panel_session_id: &str,
) -> Result<(), String> {
    let recovery = app
        .try_state::<WebContentRecovery>()
        .ok_or_else(|| "Renderer recovery state unavailable".to_string())?;
    let state = recovery
        .0
        .lock()
        .map_err(|_| "Renderer recovery state unavailable")?;
    if !state.browser_workspace.as_ref().is_some_and(|workspace| {
        workspace
            .targets
            .values()
            .any(|target| target.surface_session_id == panel_session_id)
    }) {
        return Err("Browser target identity has not been saved for recovery".into());
    }
    Ok(())
}

/// The caller still holds its document guard after native close. Boot cannot
/// observe the closed runtime's saved identity between these two commits.
pub(crate) fn forget_closed_browser_target(
    app: &AppHandle,
    panel_session_id: &str,
) -> Result<(), String> {
    app.try_state::<WebContentRecovery>()
        .ok_or_else(|| "Renderer recovery state unavailable".to_string())?
        .forget_closed_browser_target(panel_session_id)
}

/// Call in app setup before the initial main page finishes loading.
pub fn initialize(app: &AppHandle) {
    let logger = RecoveryLogger {
        path: app
            .path()
            .app_log_dir()
            .ok()
            .map(|dir| dir.join("webcontent-recovery.jsonl")),
        app_identifier: app.config().identifier.clone(),
        app_version: app.package_info().version.to_string(),
    };
    let state = RecoveryState {
        policy: RecoveryPolicy::default(),
        browser_document_initialized: false,
        browser_workspace: None,
        browser_workspace_last_save: None,
        browser_workspace_revision: 0,
        closed_browser_targets: HashSet::new(),
        browser_workspace_closure_overflow: false,
        last_sample: None,
        last_sample_at: None,
        last_sample_wall_time: None,
        last_sample_document_id: None,
        last_sample_generation: None,
        logger,
    };
    state.record("native_recovery_initialized");
    app.manage(WebContentRecovery(Mutex::new(state), RwLock::new(())));
}

pub fn handle_page_load(webview: &Webview, event: PageLoadEvent) {
    if webview.label() != "main" {
        return;
    }
    let Some(manager) = webview.app_handle().try_state::<WebContentRecovery>() else {
        return;
    };
    let Ok(mut state) = manager.0.lock() else {
        return;
    };
    match event {
        PageLoadEvent::Started => {
            state.policy.page_started();
            state.record("page_load_started");
        }
        PageLoadEvent::Finished => state.record("page_load_finished"),
    }
}

/// Register on the application builder so child webviews do not get upstream's
/// default unconditional reload. This callback intentionally ignores children.
pub fn handle_termination(webview: &Webview) {
    if webview.label() != "main" {
        return;
    }
    let app = webview.app_handle();
    let Some(manager) = app.try_state::<WebContentRecovery>() else {
        return;
    };
    let (ticket, newly_blocked) = {
        let Ok(mut state) = manager.0.lock() else {
            return;
        };
        let previously_blocked = state.policy.phase == Phase::Blocked;
        let ticket = state.policy.terminated(Instant::now());
        state.record("web_content_process_terminated");
        (
            ticket,
            !previously_blocked && state.policy.phase == Phase::Blocked,
        )
    };
    dispatch_recovery(app, ticket, newly_blocked);
}

fn recovery_failed(app: &AppHandle, generation: u64, event: &'static str) {
    let Some(manager) = app.try_state::<WebContentRecovery>() else {
        return;
    };
    let (ticket, newly_blocked) = {
        let Ok(mut state) = manager.0.lock() else {
            return;
        };
        if state.policy.generation != generation || state.policy.phase != Phase::Loading {
            return;
        }
        state.record(event);
        let ticket = state.policy.timed_out(generation, Instant::now());
        (ticket, state.policy.phase == Phase::Blocked)
    };
    dispatch_recovery(app, ticket, newly_blocked);
}

fn recovery_aborted(app: &AppHandle, generation: u64, event: &'static str) {
    let Some(manager) = app.try_state::<WebContentRecovery>() else {
        return;
    };
    let newly_blocked = {
        let Ok(mut state) = manager.0.lock() else {
            return;
        };
        if !state.policy.abort_dispatch(generation) {
            return;
        }
        state.record(event);
        true
    };
    dispatch_recovery(app, None, newly_blocked);
}

fn dispatch_recovery(app: &AppHandle, ticket: Option<ReloadTicket>, newly_blocked: bool) {
    if newly_blocked {
        if let Some(manager) = app.try_state::<WebContentRecovery>() {
            if let Ok(state) = manager.0.lock() {
                state.record("recovery_circuit_open");
            }
        }
        let retry_app = app.clone();
        app.dialog()
            .message("主界面连续恢复失败，已停止自动刷新。后台会话未在恢复过程中被停止。诊断已记录到 webcontent-recovery.jsonl。")
            .title("CCEM 界面恢复失败")
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::OkCancelCustom("重新加载界面".into(), "保留现场".into()))
            .show(move |retry| {
                if !retry { return; }
                let Some(manager) = retry_app.try_state::<WebContentRecovery>() else { return };
                let ticket = {
                    let Ok(mut state) = manager.0.lock() else { return };
                    let ticket = state.policy.manual_retry(Instant::now());
                    if ticket.is_some() { state.record("manual_recovery_requested"); }
                    ticket
                };
                dispatch_recovery(&retry_app, ticket, false);
            });
    }
    let Some(ticket) = ticket else { return };
    let recovery_app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("ccem-renderer-recovery".into())
        .spawn(move || {
            std::thread::sleep(ticket.delay);
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            let main_app = recovery_app.clone();
            // Wry executes reload inline on the main thread. Fence here, not on
            // this worker before posting an unfenced WebviewMessage::Reload.
            let dispatch = recovery_app.run_on_main_thread(move || {
                let result = (|| -> Result<bool, &'static str> {
                    let Some(manager) = main_app.try_state::<WebContentRecovery>() else {
                        return Err("recovery_state_unavailable");
                    };
                    {
                        let mut state =
                            manager.0.lock().map_err(|_| "recovery_state_unavailable")?;
                        if !state.policy.begin_reload(ticket.generation) {
                            return Ok(false);
                        }
                        state.record("reload_requested");
                    }
                    // Release the mutex before WebKit can synchronously deliver
                    // page/termination callbacks into the recovery controller.
                    let window = main_app
                        .get_webview_window("main")
                        .ok_or("main_webview_missing")?;
                    window.reload().map_err(|_| "reload_request_failed")?;
                    Ok(true)
                })();
                let _ = sender.send(result);
            });
            if dispatch.is_err() {
                recovery_aborted(
                    &recovery_app,
                    ticket.generation,
                    "main_thread_dispatch_failed",
                );
                return;
            }
            match receiver.recv_timeout(READY_TIMEOUT) {
                Ok(Ok(true)) => {}
                Ok(Ok(false)) => return,
                Ok(Err(event)) => {
                    recovery_failed(&recovery_app, ticket.generation, event);
                    return;
                }
                Err(_) => {
                    // A late queued closure must fail its fence, never reload a
                    // document after this watchdog has stopped the attempt.
                    recovery_aborted(
                        &recovery_app,
                        ticket.generation,
                        "main_thread_dispatch_timeout",
                    );
                    return;
                }
            }
            std::thread::sleep(READY_TIMEOUT);
            recovery_failed(&recovery_app, ticket.generation, "frontend_ready_timeout");
        });
    if spawned.is_err() {
        recovery_aborted(app, ticket.generation, "recovery_worker_unavailable");
    }
}

fn require_main(webview: &Webview) -> Result<(), &'static str> {
    if webview.label() == "main" {
        Ok(())
    } else {
        Err("Renderer recovery is restricted to main")
    }
}

/// Read-only smoke probe. The SPI is excluded from release builds and cannot
/// target any WebView other than this named development instance's main view.
/// WebKit declares `_webProcessIdentifier` as pid_t in WKWebViewPrivate.h.
#[cfg(all(target_os = "macos", debug_assertions))]
fn process_probe_enabled(flag: Option<&str>, identifier: &str) -> bool {
    flag == Some("1")
        && identifier
            .strip_prefix("com.ccem.desktop.dev.i")
            .is_some_and(|suffix| {
                suffix.len() == 8 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
}

#[cfg(all(target_os = "macos", debug_assertions))]
#[tauri::command]
pub async fn webcontent_debug_main_process_id(webview: Webview) -> Result<i32, String> {
    require_main(&webview)?;
    if !process_probe_enabled(
        std::env::var("CCEM_WEBCONTENT_RECOVERY_SMOKE")
            .ok()
            .as_deref(),
        &webview.app_handle().config().identifier,
    ) {
        return Err(
            "Renderer process probe requires an explicitly enabled named dev instance".into(),
        );
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            use objc2::{
                msg_send,
                runtime::{AnyObject, Bool},
                sel,
            };
            let result = (|| -> Result<i32, &'static str> {
                let pointer = platform.inner().cast::<AnyObject>();
                if pointer.is_null() {
                    return Err("Main WKWebView is unavailable");
                }
                // SAFETY: Tauri owns this live WKWebView and calls this closure on
                // its main thread. The selector's presence and pid_t ABI are checked
                // before sending it; no retain, delegate, or process is modified.
                let pid: libc::pid_t = unsafe {
                    let object = &*pointer;
                    let supported: Bool =
                        msg_send![object, respondsToSelector: sel!(_webProcessIdentifier)];
                    if !supported.as_bool() {
                        return Err("WebKit process identity SPI is unavailable");
                    }
                    msg_send![object, _webProcessIdentifier]
                };
                if pid <= 1 || pid as u32 == std::process::id() {
                    return Err("Main WebContent has no valid separate process");
                }
                Ok(pid)
            })();
            let _ = sender.send(result);
        })
        .map_err(|_| "Main WebView process probe dispatch failed")?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(3))
            .map_err(|_| "Main WebView process probe timed out".to_string())?
            .map_err(str::to_owned)
    })
    .await
    .map_err(|_| "Main WebView process probe worker failed".to_string())?
}

/// A rebuilt main document cannot own native browser surfaces.
///
/// Hides every retained embedded surface, invalidates the leases minted for the
/// previous document, and restarts the presentation epoch, so an orphaned native
/// view can never outlive the UI document that used to own it. The rebuilt UI
/// re-acquires and syncs whatever panel it actually shows again.
fn reset_embedded_surfaces_for_frontend_boot(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(any(target_os = "macos", windows))]
    {
        let Some(surfaces) = app.try_state::<std::sync::Arc<
            crate::browser::login::surface_commands::LoginBrowserSurfaceManager,
        >>() else {
            return Ok(());
        };
        let Some(cef_host) =
            app.try_state::<std::sync::Arc<crate::browser::login::cef::host::CefHostController>>()
        else {
            return Ok(());
        };
        surfaces
            .inner()
            .reset_for_frontend_boot(app, cef_host.inner())?;
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = app;
    if let Some(preview) = app.try_state::<std::sync::Arc<crate::browser::BrowserManager>>() {
        preview.hide_all(app)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn webcontent_frontend_boot(
    app: tauri::AppHandle,
    webview: Webview,
    document_id: String,
) -> Result<FrontendBoot, String> {
    require_main(&webview)?;
    // Capture before dispatch or waiting on the document gate. A later native
    // page start must be able to retire this queued boot before it claims a UUID.
    let generation_ticket = app
        .try_state::<WebContentRecovery>()
        .ok_or_else(|| "Renderer recovery state unavailable".to_string())?
        .boot_generation_ticket()?;
    tauri::async_runtime::spawn_blocking(move || {
        app.try_state::<WebContentRecovery>()
            .ok_or_else(|| "Renderer recovery state unavailable".to_string())?
            .boot_document(&document_id, generation_ticket, || {
                reset_embedded_surfaces_for_frontend_boot(&app)
            })
    })
    .await
    .map_err(|error| format!("join frontend browser recovery: {error}"))?
}

#[tauri::command]
pub async fn webcontent_browser_workspace_save(
    app: tauri::AppHandle,
    webview: Webview,
    document_id: String,
    generation: u64,
    revision: u64,
    workspace: BrowserWorkspace,
) -> Result<(), String> {
    require_main(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.try_state::<WebContentRecovery>()
            .ok_or_else(|| "Renderer recovery state unavailable".to_string())?
            .save_browser_workspace_with_cleanup(
                &document_id,
                generation,
                revision,
                workspace,
                |panel_session_id| close_removed_workspace_browser_target(&app, panel_session_id),
            )
    })
    .await
    .map_err(|error| format!("join browser workspace save: {error}"))?
}

fn close_removed_workspace_browser_target(
    app: &AppHandle,
    panel_session_id: &str,
) -> Result<bool, String> {
    #[cfg(any(target_os = "macos", windows))]
    {
        use crate::browser::login::{
            session::LoginBrowserSessionManager, surface_commands::LoginBrowserSurfaceManager,
        };
        let surfaces = app
            .try_state::<std::sync::Arc<LoginBrowserSurfaceManager>>()
            .ok_or_else(|| {
                "Browser surface manager unavailable during workspace cleanup".to_string()
            })?;
        let sessions = app
            .try_state::<std::sync::Arc<LoginBrowserSessionManager>>()
            .ok_or_else(|| {
                "Browser session manager unavailable during workspace cleanup".to_string()
            })?;
        surfaces.close_removed_workspace_target(sessions.inner(), panel_session_id)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, panel_session_id);
        Ok(false)
    }
}

#[tauri::command]
pub fn webcontent_frontend_ready(
    webview: Webview,
    state: tauri::State<'_, WebContentRecovery>,
    document_id: String,
    generation: u64,
) -> Result<(), String> {
    require_main(&webview)?;
    let mut state = state
        .0
        .lock()
        .map_err(|_| "Renderer recovery state unavailable")?;
    if state.policy.ready(&document_id, generation)? {
        state.record("frontend_ready");
    }
    Ok(())
}

#[tauri::command]
pub fn webcontent_frontend_sample(
    webview: Webview,
    state: tauri::State<'_, WebContentRecovery>,
    document_id: String,
    generation: u64,
    sample: FrontendSample,
) -> Result<(), String> {
    require_main(&webview)?;
    sample.validate()?;
    let mut state = state
        .0
        .lock()
        .map_err(|_| "Renderer recovery state unavailable")?;
    if !state.policy.accepts_document(&document_id, generation) {
        return Err("Stale renderer diagnostic sample".into());
    }
    let now = Instant::now();
    if state
        .last_sample_at
        .is_some_and(|previous| now.saturating_duration_since(previous) < SAMPLE_MIN_INTERVAL)
    {
        return Ok(());
    }
    state.last_sample = Some(sample);
    state.last_sample_at = Some(now);
    state.last_sample_wall_time = Some(chrono::Utc::now().to_rfc3339());
    state.last_sample_document_id = Some(document_id);
    state.last_sample_generation = Some(generation);
    state.record("frontend_sample");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const DOCUMENT_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const DOCUMENT_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    include!("webcontent_recovery_browser_tests.rs");

    fn browser_recovery() -> WebContentRecovery {
        WebContentRecovery(
            Mutex::new(RecoveryState {
                policy: RecoveryPolicy::default(),
                browser_document_initialized: false,
                browser_workspace: None,
                browser_workspace_last_save: None,
                browser_workspace_revision: 0,
                closed_browser_targets: HashSet::new(),
                browser_workspace_closure_overflow: false,
                last_sample: None,
                last_sample_at: None,
                last_sample_wall_time: None,
                last_sample_document_id: None,
                last_sample_generation: None,
                logger: RecoveryLogger {
                    path: None,
                    app_identifier: "test".into(),
                    app_version: "test".into(),
                },
            }),
            RwLock::new(()),
        )
    }

    fn workspace_fixture(sequence: u64) -> BrowserWorkspace {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "instanceSequence": sequence,
            "targets": {"runtime:session-a": {
                "instanceId": sequence, "surfaceSessionId": "runtime:session-a:2",
                "workingDir": "/tmp/browser-recovery", "backend": "login",
                "profileMode": "default", "visible": true
            }},
            "sessionKeys": {"runtime": [["runtime-a", "runtime:session-a"]],
                "provider": [["claude:provider-a", "runtime:session-a"]]}
        }))
        .unwrap()
    }

    #[test]
    fn browser_cold_start_accepts_generation_zero_and_echoes_the_document() {
        let recovery = browser_recovery();
        assert!(recovery.with_document(DOCUMENT_A, 0, || Ok(())).is_err());
        let boot = recovery.boot_document(DOCUMENT_A, 0, || Ok(())).unwrap();
        assert_eq!(boot.generation, 0);
        assert_eq!(boot.document_id, DOCUMENT_A);
        assert!(boot.browser_workspace.is_none());
        assert_eq!(
            recovery
                .with_document(DOCUMENT_A, 0, || Ok("allowed"))
                .unwrap(),
            "allowed"
        );
        assert!(recovery.with_document(DOCUMENT_B, 0, || Ok(())).is_err());
    }

    #[test]
    fn workspace_survives_reload_and_rejects_out_of_order_or_retired_saves() {
        let recovery = browser_recovery();
        recovery.boot_document(DOCUMENT_A, 0, || Ok(())).unwrap();
        recovery
            .save_browser_workspace(DOCUMENT_A, 0, 2, workspace_fixture(2))
            .unwrap();
        assert!(recovery
            .save_browser_workspace(DOCUMENT_A, 0, 1, workspace_fixture(1))
            .is_err());
        // A duplicate boot is idempotent; it must not invalidate leases or permit revision rollback.
        let duplicate = recovery
            .boot_document(DOCUMENT_A, 0, || panic!("duplicate reset"))
            .unwrap();
        assert_eq!(duplicate.browser_workspace.unwrap().instance_sequence, 2);
        assert!(recovery
            .save_browser_workspace(DOCUMENT_A, 0, 2, workspace_fixture(2))
            .is_ok());
        assert!(recovery
            .save_browser_workspace(DOCUMENT_A, 0, 2, workspace_fixture(3))
            .is_err());
        {
            let mut state = recovery.0.lock().unwrap();
            state.policy.ready(DOCUMENT_A, 0).unwrap();
            state.policy.page_started();
        }
        let boot = recovery.boot_document(DOCUMENT_B, 1, || Ok(())).unwrap();
        assert_eq!(boot.generation, 1);
        let workspace = boot.browser_workspace.unwrap();
        assert_eq!(
            workspace.targets["runtime:session-a"].surface_session_id,
            "runtime:session-a:2"
        );
        assert_eq!(workspace.session_keys.provider[0].1, "runtime:session-a");
        assert!(recovery
            .save_browser_workspace(DOCUMENT_A, 0, 99, workspace_fixture(99))
            .is_err());
        recovery
            .save_browser_workspace(DOCUMENT_B, 1, 1, workspace_fixture(3))
            .unwrap();
        assert_eq!(
            recovery
                .0
                .lock()
                .unwrap()
                .browser_workspace
                .as_ref()
                .unwrap()
                .instance_sequence,
            3
        );
    }

    #[test]
    fn boot_waits_for_inflight_browser_commit_without_blocking_native_invalidation() {
        use std::sync::{mpsc, Arc};
        let recovery = Arc::new(browser_recovery());
        recovery.boot_document(DOCUMENT_A, 0, || Ok(())).unwrap();
        recovery
            .0
            .lock()
            .unwrap()
            .policy
            .ready(DOCUMENT_A, 0)
            .unwrap();
        let committed = Arc::new(Mutex::new(Vec::new()));
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (finish_tx, finish_rx) = mpsc::sync_channel(1);
        let worker_recovery = Arc::clone(&recovery);
        let worker_committed = Arc::clone(&committed);
        let worker = std::thread::spawn(move || {
            worker_recovery.with_document(DOCUMENT_A, 0, || {
                started_tx.send(()).unwrap();
                finish_rx.recv_timeout(Duration::from_secs(3)).unwrap();
                worker_committed.lock().unwrap().push("old native commit");
                Ok(())
            })
        });
        started_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(recovery.1.try_write().is_err());
        // This models the main-thread PageLoadEvent callback. It must finish
        // even while a browser worker awaits its main-thread native operation.
        recovery.0.lock().unwrap().policy.page_started();
        let boot_recovery = Arc::clone(&recovery);
        let boot_committed = Arc::clone(&committed);
        let boot_worker = std::thread::spawn(move || {
            boot_recovery.boot_document(DOCUMENT_B, 1, || {
                boot_committed.lock().unwrap().push("new document reset");
                Ok(())
            })
        });
        finish_tx.send(()).unwrap();
        worker.join().unwrap().unwrap();
        let boot = boot_worker.join().unwrap().unwrap();
        assert_eq!(
            *committed.lock().unwrap(),
            ["old native commit", "new document reset"]
        );
        assert!(recovery
            .with_document::<()>(DOCUMENT_A, 0, || panic!("stale request executed"))
            .is_err());
        assert!(recovery
            .boot_document(DOCUMENT_A, 0, || panic!("stale boot reset"))
            .is_err());
        assert_eq!(
            recovery
                .with_document(DOCUMENT_B, boot.generation, || Ok(7))
                .unwrap(),
            7
        );
    }

    #[test]
    fn failed_boot_reset_is_retried_before_browser_mutations_are_admitted() {
        let recovery = browser_recovery();
        assert!(recovery
            .boot_document(DOCUMENT_A, 0, || Err("hide failed".into()))
            .is_err());
        assert!(recovery.with_document(DOCUMENT_A, 0, || Ok(())).is_err());
        recovery.boot_document(DOCUMENT_A, 0, || Ok(())).unwrap();
        recovery.with_document(DOCUMENT_A, 0, || Ok(())).unwrap();
    }

    #[test]
    fn native_close_removes_only_its_exact_target_before_reload() {
        let recovery = browser_recovery();
        recovery.boot_document(DOCUMENT_A, 0, || Ok(())).unwrap();
        let mut original = workspace_fixture(3);
        let mut replacement = original.targets["runtime:session-a"].clone();
        replacement.surface_session_id = "runtime:session-a:3".into();
        original
            .targets
            .insert("runtime:session-b".into(), replacement);
        recovery
            .save_browser_workspace(DOCUMENT_A, 0, 1, original.clone())
            .unwrap();
        recovery
            .with_document(DOCUMENT_A, 0, || {
                recovery.forget_closed_browser_target("runtime:session-a:2")
            })
            .unwrap();
        {
            let state = recovery.0.lock().unwrap();
            let workspace = state.browser_workspace.as_ref().unwrap();
            assert!(!workspace.targets.contains_key("runtime:session-a"));
            assert_eq!(
                workspace.targets["runtime:session-b"].surface_session_id,
                "runtime:session-a:3"
            );
            assert_eq!(workspace.instance_sequence, 3);
            assert_eq!(workspace.session_keys, original.session_keys);
        }
        // Duplicate ACKs compare the actual submitted payload, even after the
        // host has removed a closed panel from its recovery projection.
        recovery
            .save_browser_workspace(DOCUMENT_A, 0, 1, original.clone())
            .unwrap();
        let mut different = original.clone();
        different
            .targets
            .get_mut("runtime:session-a")
            .unwrap()
            .visible = Some(false);
        assert!(recovery
            .save_browser_workspace(DOCUMENT_A, 0, 1, different)
            .is_err());
        // A newer snapshot may have been enqueued while native close was in
        // flight. Its retired physical ID is filtered rather than resurrected.
        recovery
            .save_browser_workspace(DOCUMENT_A, 0, 2, original)
            .unwrap();
        assert!(!recovery
            .0
            .lock()
            .unwrap()
            .browser_workspace
            .as_ref()
            .unwrap()
            .targets
            .contains_key("runtime:session-a"));
        {
            let mut state = recovery.0.lock().unwrap();
            state.policy.ready(DOCUMENT_A, 0).unwrap();
            state.policy.page_started();
        }
        let boot = recovery.boot_document(DOCUMENT_B, 1, || Ok(())).unwrap();
        let restored = boot.browser_workspace.unwrap();
        assert_eq!(restored.targets.len(), 1);
        assert!(restored.targets.contains_key("runtime:session-b"));
        assert!(recovery.0.lock().unwrap().closed_browser_targets.is_empty());
        assert!(recovery
            .save_browser_workspace(DOCUMENT_A, 0, 3, workspace_fixture(3))
            .is_err());
    }

    #[test]
    fn closed_target_history_overflow_preserves_live_targets_and_blocks_new_snapshots() {
        let recovery = browser_recovery();
        recovery.boot_document(DOCUMENT_A, 0, || Ok(())).unwrap();
        recovery
            .save_browser_workspace(DOCUMENT_A, 0, 1, workspace_fixture(2))
            .unwrap();
        recovery
            .0
            .lock()
            .unwrap()
            .closed_browser_targets
            .extend((0..MAX_CLOSED_BROWSER_TARGETS).map(|index| format!("closed:{index}")));
        recovery
            .forget_closed_browser_target("another-closed-panel")
            .unwrap();
        {
            let state = recovery.0.lock().unwrap();
            assert_eq!(
                state.closed_browser_targets.len(),
                MAX_CLOSED_BROWSER_TARGETS
            );
            assert!(state.browser_workspace_closure_overflow);
            assert!(state
                .browser_workspace
                .as_ref()
                .unwrap()
                .targets
                .contains_key("runtime:session-a"));
        }
        assert!(recovery
            .save_browser_workspace(DOCUMENT_A, 0, 2, workspace_fixture(3))
            .is_err());
        // Identical retries are still ACKed; they do not change the projection.
        recovery
            .save_browser_workspace(DOCUMENT_A, 0, 1, workspace_fixture(2))
            .unwrap();
        {
            let mut state = recovery.0.lock().unwrap();
            state.policy.ready(DOCUMENT_A, 0).unwrap();
            state.policy.page_started();
        }
        recovery.boot_document(DOCUMENT_B, 1, || Ok(())).unwrap();
        recovery
            .save_browser_workspace(DOCUMENT_B, 1, 1, workspace_fixture(3))
            .unwrap();
    }

    #[test]
    fn close_transaction_keeps_native_commit_and_identity_removal_atomic_for_acquire() {
        use std::sync::{mpsc, Arc};
        let recovery = Arc::new(browser_recovery());
        recovery.boot_document(DOCUMENT_A, 0, || Ok(())).unwrap();
        recovery
            .save_browser_workspace(DOCUMENT_A, 0, 1, workspace_fixture(2))
            .unwrap();
        let (closed_tx, closed_rx) = mpsc::sync_channel(1);
        let (finish_tx, finish_rx) = mpsc::sync_channel(1);
        let closing_recovery = Arc::clone(&recovery);
        let close_worker = std::thread::spawn(move || {
            closing_recovery.with_exclusive_document(DOCUMENT_A, 0, || {
                closed_tx.send(()).unwrap();
                finish_rx.recv_timeout(Duration::from_secs(3)).unwrap();
                closing_recovery.forget_closed_browser_target("runtime:session-a:2")
            })
        });
        closed_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(
            recovery.1.try_read().is_err(),
            "an acquire cannot enter halfway through close"
        );
        let acquiring_recovery = Arc::clone(&recovery);
        let acquire_worker = std::thread::spawn(move || {
            acquiring_recovery.with_document(DOCUMENT_A, 0, || {
                Ok(acquiring_recovery
                    .0
                    .lock()
                    .unwrap()
                    .browser_workspace
                    .as_ref()
                    .unwrap()
                    .targets
                    .contains_key("runtime:session-a"))
            })
        });
        finish_tx.send(()).unwrap();
        close_worker.join().unwrap().unwrap();
        assert!(!acquire_worker.join().unwrap().unwrap());
    }

    #[test]
    fn browser_workspace_rejects_unbounded_or_incompatible_identity() {
        let mut workspace = workspace_fixture(2);
        workspace.validate().unwrap();
        workspace.instance_sequence = 1;
        assert!(workspace.validate().is_err());
        workspace.instance_sequence = 2;
        workspace
            .targets
            .get_mut("runtime:session-a")
            .unwrap()
            .backend = "preview".into();
        assert!(workspace.validate().is_err());
        let mut value = serde_json::to_value(workspace_fixture(2)).unwrap();
        value["arbitraryState"] = serde_json::json!({"secret": "must not be accepted"});
        assert!(serde_json::from_value::<BrowserWorkspace>(value).is_err());
    }

    #[cfg(all(target_os = "macos", debug_assertions))]
    #[test]
    fn process_probe_requires_explicit_flag_and_exact_dev_namespace() {
        let dev = "com.ccem.desktop.dev.i0123abcd";
        assert!(process_probe_enabled(Some("1"), dev));
        assert!(!process_probe_enabled(None, dev));
        assert!(!process_probe_enabled(Some("0"), dev));
        assert!(!process_probe_enabled(Some("true"), dev));
        assert!(!process_probe_enabled(Some("1"), "com.ccem.desktop"));
        assert!(!process_probe_enabled(
            Some("1"),
            "com.ccem.desktop.dev.invalid"
        ));
    }

    #[test]
    fn crash_invalidates_old_document_and_requires_new_ready_ack() {
        let mut policy = RecoveryPolicy::default();
        assert!(!policy.boot(DOCUMENT_A).unwrap().recovered);
        policy.ready(DOCUMENT_A, 0).unwrap();
        let ticket = policy.terminated(Instant::now()).unwrap();
        assert!(policy.ready(DOCUMENT_A, 0).is_err());
        assert!(policy.boot(DOCUMENT_A).is_err());
        assert!(policy.boot(DOCUMENT_B).is_err());
        assert!(policy.begin_reload(ticket.generation));
        policy.page_started();
        assert!(policy.boot(DOCUMENT_A).is_err());
        let boot = policy.boot(DOCUMENT_B).unwrap();
        assert!(boot.recovered);
        assert_eq!(boot.generation, ticket.generation);
        assert!(policy.ready(DOCUMENT_A, boot.generation).is_err());
        assert!(policy.ready(DOCUMENT_B, boot.generation).unwrap());
        assert!(!policy.ready(DOCUMENT_B, boot.generation).unwrap());
        assert!(policy
            .timed_out(ticket.generation, Instant::now())
            .is_none());
    }

    #[test]
    fn brief_success_does_not_reset_crash_budget() {
        let now = Instant::now();
        let mut policy = RecoveryPolicy::default();
        for attempt in 0..3 {
            let ticket = policy
                .terminated(now + Duration::from_secs(attempt * 30))
                .unwrap();
            assert_eq!(ticket.delay, RETRY_DELAYS[attempt as usize]);
            policy.begin_reload(ticket.generation);
            let document = format!("{:08x}-aaaa-4aaa-8aaa-aaaaaaaaaaaa", attempt);
            policy.boot(&document).unwrap();
            policy.ready(&document, ticket.generation).unwrap();
        }
        assert!(policy.terminated(now + Duration::from_secs(100)).is_none());
        assert_eq!(policy.phase, Phase::Blocked);
        assert!(policy.terminated(now + RETRY_WINDOW * 2).is_none());
    }

    #[test]
    fn duplicate_termination_and_stale_timer_cannot_start_parallel_reloads() {
        let now = Instant::now();
        let mut policy = RecoveryPolicy::default();
        let first = policy.terminated(now).unwrap();
        assert!(policy.terminated(now).is_none());
        assert_eq!(policy.attempts.len(), 1);
        assert!(policy.begin_reload(first.generation));
        assert!(!policy.begin_reload(first.generation));
        let second = policy.timed_out(first.generation, now).unwrap();
        assert!(!policy.begin_reload(first.generation));
        assert!(policy.timed_out(first.generation, now).is_none());
        assert!(policy.begin_reload(second.generation));
    }

    #[test]
    fn late_main_thread_dispatch_cannot_reload_after_timeout_or_new_navigation() {
        let now = Instant::now();
        let mut policy = RecoveryPolicy::default();
        let ticket = policy.terminated(now).unwrap();
        assert!(policy.abort_dispatch(ticket.generation));
        assert!(!policy.begin_reload(ticket.generation));
        assert!(!policy.abort_dispatch(ticket.generation));
        let next = policy.manual_retry(now).unwrap();
        policy.page_started();
        policy.boot(DOCUMENT_A).unwrap();
        policy.ready(DOCUMENT_A, next.generation).unwrap();
        assert!(!policy.begin_reload(next.generation));
        assert!(!policy.abort_dispatch(next.generation));
    }

    #[test]
    fn stable_window_ages_out_attempts_without_ack_reset() {
        let now = Instant::now();
        let mut policy = RecoveryPolicy::default();
        let ticket = policy.terminated(now).unwrap();
        policy.begin_reload(ticket.generation);
        policy.boot(DOCUMENT_A).unwrap();
        policy.ready(DOCUMENT_A, ticket.generation).unwrap();
        let next = policy.terminated(now + RETRY_WINDOW).unwrap();
        assert_eq!(next.delay, RETRY_DELAYS[0]);
        assert_eq!(policy.attempts.len(), 1);
    }

    #[test]
    fn diagnostic_attempt_count_expires_at_window_boundary_without_pruning_policy() {
        let now = Instant::now();
        let mut policy = RecoveryPolicy::default();
        let first = policy.terminated(now).unwrap();
        policy.begin_reload(first.generation);
        policy.terminated(now + Duration::from_secs(30)).unwrap();
        assert_eq!(
            policy.attempts_in_window(now + RETRY_WINDOW - Duration::from_millis(1)),
            2
        );
        assert_eq!(policy.attempts_in_window(now + RETRY_WINDOW), 1);
        assert_eq!(
            policy.attempts_in_window(now + RETRY_WINDOW + Duration::from_secs(30)),
            0
        );
        assert_eq!(
            policy.attempts.len(),
            2,
            "diagnostic reads must not mutate retry policy"
        );
    }

    #[test]
    fn manual_navigation_fences_previous_ack() {
        let mut policy = RecoveryPolicy::default();
        policy.page_started();
        policy.boot(DOCUMENT_A).unwrap();
        policy.ready(DOCUMENT_A, 0).unwrap();
        policy.page_started();
        assert!(policy.ready(DOCUMENT_A, 0).is_err());
        assert_eq!(policy.boot(DOCUMENT_B).unwrap().generation, 1);
    }

    #[test]
    fn only_explicit_manual_retry_can_reopen_the_circuit() {
        let now = Instant::now();
        let mut policy = RecoveryPolicy::default();
        assert!(policy.manual_retry(now).is_none());
        for _ in 0..3 {
            let ticket = policy.terminated(now).unwrap();
            policy.begin_reload(ticket.generation);
        }
        assert!(policy.terminated(now).is_none());
        let ticket = policy.manual_retry(now).unwrap();
        assert_eq!(ticket.delay, RETRY_DELAYS[0]);
        assert_eq!(policy.attempts.len(), 1);
        assert_eq!(policy.phase, Phase::WaitingToReload);
        assert!(policy.manual_retry(now).is_none());
    }

    #[test]
    fn diagnostics_reject_bodies_and_invalid_document_ids() {
        assert!(!valid_document_id("secret prompt"));
        assert!(!valid_document_id(&"x".repeat(2000)));
        assert!(serde_json::from_value::<FrontendSample>(serde_json::json!({
            "domNodeCount": 0, "transcriptRowCount": 0, "visible": true,
            "heapUsedBytes": null, "rawEventCount": 0,
            "projectedMessageCount": 0, "toolResultChars": 0,
            "mountedSessionCount": 0, "recoveryDraftCount": 0,
            "recoveryUncertainSubmissionCount": 0, "recoveryDraftWriteFailures": 0,
            "prompt": "must not log"
        }))
        .is_err());
        assert!(FrontendSample {
            dom_node_count: u64::MAX,
            ..Default::default()
        }
        .validate()
        .is_err());
    }

    #[test]
    fn diagnostics_rotate_with_one_previous_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("webcontent-recovery.jsonl");
        let logger = RecoveryLogger {
            path: Some(path.clone()),
            app_identifier: "test".into(),
            app_version: "0".into(),
        };
        fs::write(&path, vec![b'x'; MAX_LOG_BYTES as usize - 1]).unwrap();
        logger.write(&serde_json::json!({"event": "test"}));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"event\":\"test\"}\n");
        let previous = path.with_extension("previous.jsonl");
        assert_eq!(fs::metadata(previous).unwrap().len(), MAX_LOG_BYTES - 1);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
    }
}
