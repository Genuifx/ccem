use crate::browser::login::capability::{
    BrowserPermissionAuthority, BrowserPermissionAuthorityTicket,
};
use crate::browser::{authorize_browser_tool, BrowserManager, BrowserToolRequest};
use crate::config::{resolve_claude_env, resolve_codex_runtime};
use crate::event_bus::{
    ReplayBatch, SessionEventPayload, SessionPromptAnnotation, SessionPromptImage, SessionStore,
    TodoSnapshotV1,
};
use crate::native_event_log::NativeEventLog;
use crate::native_helper_resource::native_helper_script_path;
use crate::prompt_image_store::PromptImageStore;
use crate::session_provenance::bind_source_session_id;
use crate::system_proxy::resolve_codex_proxy_env;
use crate::terminal::{self, resolve_claude_path, resolve_codex_path, TerminalType};
use chrono::{DateTime, Utc};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const NATIVE_STOP_GRACE_PERIOD: Duration = Duration::from_secs(10);
const NATIVE_PERMISSION_QUARANTINE_KILL_TIMEOUT: Duration = Duration::from_secs(3);
const NATIVE_SETTINGS_UPDATE_ACK_TIMEOUT: Duration = Duration::from_secs(2);
const NATIVE_HELPER_WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const NATIVE_HELPER_WRITE_QUEUE_CAPACITY: usize = 16;
const NATIVE_HELPER_LAUNCHER_ARG: &str = "--ccem-native-helper-launcher";
const MAX_PROMPT_ANNOTATIONS: usize = 20;
const MAX_PROMPT_ANNOTATION_QUOTE_CHARS: usize = 12_000;
const MAX_PROMPT_ANNOTATION_NOTE_CHARS: usize = 4_000;
const MAX_PROMPT_ANNOTATION_TOTAL_CHARS: usize = 60_000;
static NATIVE_RUNTIME_STATE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
const BROWSER_ACTOR_ID_PREFIX: &str = "browser-actor-";
const BROWSER_ACTOR_ID_RANDOM_BYTES: usize = 16;
const MAX_PROVIDER_SESSION_ID_BYTES: usize = 512;

pub(crate) fn run_native_helper_launcher_if_requested() {
    let mut arguments = std::env::args_os();
    let _executable = arguments.next();
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new(NATIVE_HELPER_LAUNCHER_ARG)) {
        return;
    }
    let helper_script = arguments.next().unwrap_or_else(|| {
        eprintln!("Native helper launcher requires an absolute helper script path.");
        std::process::exit(64);
    });
    let controller_pid = arguments
        .next()
        .and_then(|value| value.to_str().and_then(|value| value.parse::<u32>().ok()))
        .filter(|pid| *pid > 0)
        .unwrap_or_else(|| {
            eprintln!("Native helper launcher requires its controller pid.");
            std::process::exit(64);
        });
    if arguments.next().is_some() || !Path::new(&helper_script).is_absolute() {
        eprintln!("Native helper launcher received invalid arguments.");
        std::process::exit(64);
    }
    let executable = std::env::current_exe().unwrap_or_else(|error| {
        eprintln!("Native helper launcher cannot resolve its executable: {error}");
        std::process::exit(70);
    });
    #[cfg(windows)]
    let node_name = "ccem-node.exe";
    #[cfg(not(windows))]
    let node_name = "ccem-node";
    let node = executable
        .parent()
        .map(|parent| parent.join(node_name))
        .unwrap_or_else(|| PathBuf::from(node_name));

    #[cfg(unix)]
    {
        use std::process::Stdio;
        // This runs before Tauri or any worker thread starts. The wrapper stays as the process
        // group leader, and Node plus every provider/tool descendant inherit its dedicated group.
        if unsafe { libc::setpgid(0, 0) } == -1 {
            eprintln!(
                "Native helper launcher could not create its process group: {}",
                io::Error::last_os_error()
            );
            std::process::exit(70);
        }
        if unsafe { libc::getppid() } != controller_pid as i32 {
            eprintln!("Native helper controller changed before launch.");
            std::process::exit(70);
        }
        let mut child = std::process::Command::new(node)
            .arg(helper_script)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap_or_else(|error| {
                eprintln!("Native helper launcher could not start Node: {error}");
                std::process::exit(70);
            });
        loop {
            let controller_gone = unsafe { libc::getppid() } != controller_pid as i32;
            let node_gone = match child.try_wait() {
                Ok(Some(_)) => true,
                Ok(None) => false,
                Err(_) => true,
            };
            if controller_gone || node_gone {
                let group = unsafe { libc::getpgrp() };
                if group > 0 {
                    // SAFETY: the group was created by this launcher before Node started.
                    let _ = unsafe { libc::kill(-group, libc::SIGKILL) };
                }
                std::process::exit(1);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(windows)]
    {
        use std::mem::size_of;
        use std::process::Stdio;
        use std::ptr::null;
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::{
            GetCurrentProcess, OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };

        let job = unsafe { CreateJobObjectW(null(), null()) };
        if job.is_null() {
            eprintln!("Native helper launcher could not create its Job Object.");
            std::process::exit(70);
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 || unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) } == 0 {
            unsafe { CloseHandle(job) };
            eprintln!("Native helper launcher could not establish its Job Object.");
            std::process::exit(70);
        }
        let controller = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, controller_pid) };
        if controller.is_null() {
            unsafe { CloseHandle(job) };
            eprintln!("Native helper launcher could not observe its controller.");
            std::process::exit(70);
        }
        let mut child = std::process::Command::new(node)
            .arg(helper_script)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap_or_else(|error| {
                unsafe {
                    CloseHandle(controller);
                    CloseHandle(job);
                }
                eprintln!("Native helper launcher could not start Node: {error}");
                std::process::exit(70);
            });
        loop {
            match unsafe { WaitForSingleObject(controller, 0) } {
                WAIT_OBJECT_0 => unsafe {
                    TerminateJobObject(job, 1);
                },
                WAIT_TIMEOUT => {}
                other => {
                    eprintln!("Native helper launcher controller wait failed: {other}");
                    unsafe {
                        TerminateJobObject(job, 1);
                    }
                }
            }
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => unsafe {
                    TerminateJobObject(job, 1);
                },
                Ok(None) => {}
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = (node, helper_script);
        eprintln!("Native helper launcher is unsupported on this platform.");
        std::process::exit(70);
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeProvider {
    Claude,
    Codex,
}

impl NativeProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct BrowserActorLineageRef<'a> {
    pub(crate) provider: NativeProvider,
    pub(crate) provider_session_id: Option<&'a str>,
    pub(crate) actor_id: &'a str,
}

pub(crate) fn resolve_browser_actor_id(
    provider: NativeProvider,
    provider_session_id: Option<&str>,
    provisional_actor_id: &str,
    known_lineages: &[BrowserActorLineageRef<'_>],
) -> Result<String, String> {
    if !is_valid_browser_actor_id(provisional_actor_id) {
        return Err("Native browser actor lineage is invalid.".to_string());
    }

    let Some(provider_session_id) = normalize_provider_session_id(provider_session_id)? else {
        return Ok(provisional_actor_id.to_string());
    };

    let mut matched_actor_id: Option<&str> = None;
    for lineage in known_lineages {
        if lineage.provider != provider {
            continue;
        }
        let Ok(Some(known_provider_session_id)) =
            normalize_provider_session_id(lineage.provider_session_id)
        else {
            continue;
        };
        if known_provider_session_id != provider_session_id {
            continue;
        }
        if !is_valid_browser_actor_id(lineage.actor_id) {
            return Err("Native browser actor lineage is invalid.".to_string());
        }
        match matched_actor_id {
            Some(existing) if existing != lineage.actor_id => {
                return Err("Native browser actor lineage is conflicting.".to_string());
            }
            Some(_) => {}
            None => matched_actor_id = Some(lineage.actor_id),
        }
    }

    Ok(matched_actor_id.unwrap_or(provisional_actor_id).to_string())
}

fn normalize_provider_session_id(value: Option<&str>) -> Result<Option<&str>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > MAX_PROVIDER_SESSION_ID_BYTES || trimmed.chars().any(char::is_control) {
        return Err("Native provider session identity is invalid.".to_string());
    }
    Ok(Some(trimmed))
}

fn is_valid_browser_actor_id(actor_id: &str) -> bool {
    actor_id
        .strip_prefix(BROWSER_ACTOR_ID_PREFIX)
        .is_some_and(|suffix| {
            suffix.len() == BROWSER_ACTOR_ID_RANDOM_BYTES * 2
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

fn generate_browser_actor_id() -> Result<String, String> {
    let mut random = [0_u8; BROWSER_ACTOR_ID_RANDOM_BYTES];
    OsRng
        .try_fill_bytes(&mut random)
        .map_err(|_| "Failed to generate native browser actor lineage.".to_string())?;
    Ok(format!(
        "{}{}",
        BROWSER_ACTOR_ID_PREFIX,
        hex::encode(random)
    ))
}

fn legacy_browser_actor_id(provider: NativeProvider, runtime_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ccem-browser-actor-lineage-v1\0");
    hasher.update(provider.as_str().as_bytes());
    hasher.update(b"\0");
    hasher.update(runtime_id.as_bytes());
    let digest = hasher.finalize();
    format!(
        "{}{}",
        BROWSER_ACTOR_ID_PREFIX,
        hex::encode(&digest[..BROWSER_ACTOR_ID_RANDOM_BYTES])
    )
}

fn backfill_browser_actor_lineages(records: &mut [NativeSessionRecord]) {
    let actor_ids = records
        .iter()
        .map(|record| {
            let provider_session_id =
                match normalize_provider_session_id(record.provider_session_id.as_deref()) {
                    Ok(Some(provider_session_id)) => provider_session_id,
                    Ok(None) => {
                        return if is_valid_browser_actor_id(&record.browser_actor_id) {
                            record.browser_actor_id.clone()
                        } else {
                            legacy_browser_actor_id(record.provider, &record.runtime_id)
                        };
                    }
                    Err(_) => {
                        // A malformed persisted provider identity cannot safely participate in
                        // lineage resolution. Quarantine it with an invalid actor so browser routing
                        // fails closed without echoing the raw provider value.
                        return String::new();
                    }
                };

            let matching_records = records.iter().filter(|candidate| {
                candidate.provider == record.provider
                    && normalize_provider_session_id(candidate.provider_session_id.as_deref())
                        .ok()
                        .flatten()
                        == Some(provider_session_id)
            });
            let mut canonical_runtime_id: Option<&str> = None;
            let mut known_actor_id: Option<&str> = None;
            for candidate in matching_records {
                canonical_runtime_id = Some(match canonical_runtime_id {
                    Some(current) if current <= candidate.runtime_id.as_str() => current,
                    _ => candidate.runtime_id.as_str(),
                });
                if !is_valid_browser_actor_id(&candidate.browser_actor_id) {
                    continue;
                }
                match known_actor_id {
                    Some(existing) if existing != candidate.browser_actor_id => {
                        // Conflicting persisted lineages cannot be merged without access to both
                        // provenance ledgers. Quarantine the whole conversation instead of
                        // selecting an actor that could discard existing taint.
                        return String::new();
                    }
                    Some(_) => {}
                    None => known_actor_id = Some(&candidate.browser_actor_id),
                }
            }

            known_actor_id.map(str::to_string).unwrap_or_else(|| {
                legacy_browser_actor_id(
                    record.provider,
                    canonical_runtime_id.unwrap_or(record.runtime_id.as_str()),
                )
            })
        })
        .collect::<Vec<_>>();

    for (record, actor_id) in records.iter_mut().zip(actor_ids) {
        record.browser_actor_id = actor_id;
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeTransport {
    NativeSdk,
    InteractiveTerminal,
    ExternalWeb,
    Headless,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NativeSessionRecord {
    pub runtime_id: String,
    pub provider: NativeProvider,
    pub transport: NativeTransport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(default)]
    pub(crate) browser_actor_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_boundary_message_count: Option<u64>,
    pub project_dir: String,
    pub env_name: String,
    pub perm_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_perm_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub is_active: bool,
    pub can_handoff_to_terminal: bool,
    #[serde(default)]
    pub(crate) permission_quarantined: bool,
    #[serde(default, skip_serializing)]
    pub pending_handoff_terminal: Option<TerminalType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NativeSessionSummary {
    pub runtime_id: String,
    pub provider: NativeProvider,
    pub transport: NativeTransport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_boundary_message_count: Option<u64>,
    pub project_dir: String,
    pub env_name: String,
    pub perm_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_perm_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub is_active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_event_seq: Option<u64>,
    pub can_handoff_to_terminal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeHandoffStatus {
    Opened,
    Pending,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeHandoffResult {
    pub status: NativeHandoffStatus,
}

#[derive(Debug, Clone)]
pub struct NativeTerminalHandoff {
    pub runtime_id: String,
    pub provider: NativeProvider,
    pub env_name: String,
    pub perm_mode: String,
    pub project_dir: String,
    pub resume_session_id: String,
    pub terminal: TerminalType,
    pub env_vars: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct NativeSessionOptions {
    pub provider: NativeProvider,
    pub env_name: String,
    pub perm_mode: String,
    pub runtime_perm_mode: Option<String>,
    pub working_dir: String,
    pub initial_prompt: Option<String>,
    pub display_prompt: Option<String>,
    pub initial_images: Option<Vec<PromptImage>>,
    pub initial_annotations: Option<Vec<SessionPromptAnnotation>>,
    pub provider_session_id: Option<String>,
    pub seed_boundary_message_count: Option<u64>,
    pub helper_env_vars: HashMap<String, String>,
    pub terminal_env_vars: HashMap<String, String>,
    pub claude_path: Option<String>,
    pub codex_path: Option<String>,
    pub codex_base_url: Option<String>,
    pub codex_api_key: Option<String>,
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InteractivePromptAnnotation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptImage {
    pub media_type: String,
    pub base64_data: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
}

fn prompt_images_for_event(
    images: Option<&Vec<PromptImage>>,
    prompt_image_store: &PromptImageStore,
) -> Result<Option<Vec<SessionPromptImage>>, String> {
    let Some(images) = images else {
        return Ok(None);
    };
    if images.is_empty() {
        return Ok(None);
    }

    let mut event_images = Vec::with_capacity(images.len());
    for image in images {
        let stored =
            prompt_image_store.store_base64_image(&image.media_type, &image.base64_data)?;
        event_images.push(SessionPromptImage {
            media_type: stored.media_type,
            base64_data: None,
            storage_path: Some(stored.storage_path),
            sha256: Some(stored.sha256),
            byte_size: Some(stored.byte_size),
            placeholder: image.placeholder.clone(),
        });
    }

    Ok(Some(event_images))
}

fn canonical_user_prompt_hash(
    text: &str,
    images: Option<&Vec<SessionPromptImage>>,
    annotations: Option<&Vec<SessionPromptAnnotation>>,
) -> Option<String> {
    if text.trim().is_empty()
        && images.map(|items| items.is_empty()).unwrap_or(true)
        && annotations.map(|items| items.is_empty()).unwrap_or(true)
    {
        return None;
    }

    let mut hasher = Sha256::new();
    hasher.update(b"ccem-user-prompt-v1\0");
    hasher.update(text.as_bytes());
    hasher.update(b"\0");
    if let Some(images) = images {
        for image in images {
            hasher.update(b"image\0");
            if let Some(sha256) = image.sha256.as_deref() {
                hasher.update(sha256.as_bytes());
            }
            hasher.update(b"\0");
        }
    }
    if let Some(annotations) = annotations {
        for annotation in annotations {
            hasher.update(b"annotation\0");
            hasher.update(annotation.quote.as_bytes());
            hasher.update(b"\0");
            hasher.update(annotation.note.as_bytes());
            hasher.update(b"\0");
        }
    }

    Some(hex::encode(hasher.finalize()))
}

fn validate_prompt_annotations(
    annotations: Option<&Vec<SessionPromptAnnotation>>,
) -> Result<Option<Vec<SessionPromptAnnotation>>, String> {
    let Some(annotations) = annotations else {
        return Ok(None);
    };
    if annotations.is_empty() {
        return Ok(None);
    }
    if annotations.len() > MAX_PROMPT_ANNOTATIONS {
        return Err(format!(
            "A prompt can include at most {MAX_PROMPT_ANNOTATIONS} annotations."
        ));
    }

    let mut total_chars = 0usize;
    let mut validated = Vec::with_capacity(annotations.len());
    for annotation in annotations {
        let quote = annotation.quote.trim();
        let note = annotation.note.trim();
        let quote_chars = quote.chars().count();
        let note_chars = note.chars().count();
        if quote.is_empty() || note.is_empty() {
            return Err("Prompt annotations require both selected text and a note.".to_string());
        }
        if quote_chars > MAX_PROMPT_ANNOTATION_QUOTE_CHARS {
            return Err(format!(
                "Prompt annotation selected text exceeds {MAX_PROMPT_ANNOTATION_QUOTE_CHARS} characters."
            ));
        }
        if note_chars > MAX_PROMPT_ANNOTATION_NOTE_CHARS {
            return Err(format!(
                "Prompt annotation note exceeds {MAX_PROMPT_ANNOTATION_NOTE_CHARS} characters."
            ));
        }
        total_chars = total_chars
            .checked_add(quote_chars + note_chars)
            .ok_or_else(|| "Prompt annotation size overflowed.".to_string())?;
        if total_chars > MAX_PROMPT_ANNOTATION_TOTAL_CHARS {
            return Err(format!(
                "Prompt annotations exceed {MAX_PROMPT_ANNOTATION_TOTAL_CHARS} total characters."
            ));
        }
        validated.push(SessionPromptAnnotation {
            quote: quote.to_string(),
            note: note.to_string(),
        });
    }

    Ok(Some(validated))
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum HelperInputCommand<'a> {
    Init {
        provider: &'a str,
        env_name: &'a str,
        perm_mode: &'a str,
        allow_dangerously_skip_permissions: bool,
        working_dir: &'a str,
        env_vars: &'a HashMap<String, String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        initial_prompt: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        initial_images: Option<&'a [PromptImage]>,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_session_id: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        claude_path: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        codex_path: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        codex_base_url: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        codex_api_key: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        effort: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        todo_snapshot_seed: Option<&'a TodoSnapshotV1>,
    },
    Prompt {
        text: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<&'a [PromptImage]>,
    },
    PermissionResponse {
        request_id: &'a str,
        approved: bool,
    },
    InteractivePromptResponse {
        tool_use_id: &'a str,
        prompt_type: &'a str,
        answers: &'a HashMap<String, String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        annotations: Option<&'a HashMap<String, InteractivePromptAnnotation>>,
    },
    UpdateSettings {
        request_id: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        env_name: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        perm_mode: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        env_vars: Option<&'a HashMap<String, String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        effort: Option<&'a str>,
    },
    RewindFiles {
        checkpoint_id: &'a str,
    },
    BrowserToolResponse {
        request_id: &'a str,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<&'a Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'a str>,
    },
    Stop,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum SettingsUpdateOutcome {
    Applied,
    Failed,
    Deferred,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SettingsUpdateAck {
    outcome: SettingsUpdateOutcome,
    detail: Option<String>,
}

#[derive(Default)]
struct SettingsUpdateAckRegistry {
    pending: Mutex<HashMap<String, mpsc::SyncSender<SettingsUpdateAck>>>,
}

impl SettingsUpdateAckRegistry {
    fn register(&self, request_id: &str) -> Result<mpsc::Receiver<SettingsUpdateAck>, String> {
        if !is_valid_settings_update_request_id(request_id) {
            return Err("Invalid native settings update request id.".to_string());
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Failed to lock native settings acknowledgements".to_string())?;
        if pending.contains_key(request_id) {
            return Err("Duplicate native settings update request id.".to_string());
        }
        pending.insert(request_id.to_string(), sender);
        Ok(receiver)
    }

    fn resolve(&self, request_id: &str, ack: SettingsUpdateAck) -> Result<bool, String> {
        let sender = self
            .pending
            .lock()
            .map_err(|_| "Failed to lock native settings acknowledgements".to_string())?
            .remove(request_id);
        Ok(sender.is_some_and(|sender| sender.send(ack).is_ok()))
    }

    fn cancel(&self, request_id: &str) -> Result<(), String> {
        self.pending
            .lock()
            .map_err(|_| "Failed to lock native settings acknowledgements".to_string())?
            .remove(request_id);
        Ok(())
    }
}

trait NativeHelperCommandSink: Send {
    fn write_command(&mut self, bytes: &[u8]) -> Result<(), String>;
}

impl NativeHelperCommandSink for CommandChild {
    fn write_command(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.write(bytes)
            .map_err(|error| format!("Failed to write to native sidecar stdin: {error}"))
    }
}

struct NativeHelperWriteRequest {
    bytes: Vec<u8>,
    completed: mpsc::SyncSender<Result<(), String>>,
}

#[derive(Clone)]
struct NativeHelperWriter {
    requests: mpsc::SyncSender<NativeHelperWriteRequest>,
}

impl NativeHelperWriter {
    fn spawn(child: CommandChild) -> Result<Self, String> {
        Self::spawn_sink(Box::new(child))
    }

    fn spawn_sink(mut sink: Box<dyn NativeHelperCommandSink>) -> Result<Self, String> {
        let (requests, receiver) =
            mpsc::sync_channel::<NativeHelperWriteRequest>(NATIVE_HELPER_WRITE_QUEUE_CAPACITY);
        std::thread::Builder::new()
            .name("ccem-native-helper-writer".to_string())
            .spawn(move || {
                while let Ok(request) = receiver.recv() {
                    let result = sink.write_command(&request.bytes);
                    let failed = result.is_err();
                    let _ = request.completed.send(result);
                    if failed {
                        break;
                    }
                }
            })
            .map_err(|error| format!("Failed to start native helper writer: {error}"))?;
        Ok(Self { requests })
    }

    fn write_until(&self, bytes: Vec<u8>, deadline: Instant) -> Result<(), String> {
        if Instant::now() >= deadline {
            return Err("Native helper stdin write timed out.".to_string());
        }
        let (completed, receiver) = mpsc::sync_channel(1);
        self.requests
            .try_send(NativeHelperWriteRequest { bytes, completed })
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => {
                    "Native helper writer queue is full; command was not delivered.".to_string()
                }
                mpsc::TrySendError::Disconnected(_) => {
                    "Native helper writer is unavailable.".to_string()
                }
            })?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Native helper stdin write timed out.".to_string());
        }
        match receiver.recv_timeout(remaining) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err("Native helper stdin write timed out.".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("Native helper writer completion channel closed.".to_string())
            }
        }
    }
}

fn is_valid_settings_update_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn new_settings_update_request_id() -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    format!("settings-{}", hex::encode(bytes))
}

fn wait_for_required_settings_ack(
    request_id: &str,
    receiver: mpsc::Receiver<SettingsUpdateAck>,
    timeout: Duration,
) -> Result<(), String> {
    match receiver.recv_timeout(timeout) {
        Ok(SettingsUpdateAck {
            outcome: SettingsUpdateOutcome::Applied,
            ..
        }) => Ok(()),
        Ok(SettingsUpdateAck {
            outcome: SettingsUpdateOutcome::Failed,
            detail,
        }) => Err(format!(
            "Native settings update {request_id} failed{}.",
            settings_ack_detail_suffix(detail.as_deref())
        )),
        Ok(SettingsUpdateAck {
            outcome: SettingsUpdateOutcome::Deferred,
            detail,
        }) => Err(format!(
            "Native settings update {request_id} was deferred{}.",
            settings_ack_detail_suffix(detail.as_deref())
        )),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(format!(
            "Native settings update {request_id} acknowledgement timed out."
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(format!(
            "Native settings update {request_id} acknowledgement channel closed."
        )),
    }
}

fn settings_ack_detail_suffix(detail: Option<&str>) -> String {
    let detail = detail
        .map(str::trim)
        .filter(|detail| !detail.is_empty() && detail.len() <= 160)
        .filter(|detail| !detail.chars().any(char::is_control));
    detail
        .map(|detail| format!(": {detail}"))
        .unwrap_or_default()
}

fn lock_until<'a, T>(
    mutex: &'a Mutex<T>,
    deadline: Instant,
    timeout_message: &str,
) -> Result<MutexGuard<'a, T>, String> {
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(_)) => {
                return Err("Native helper lifecycle lock is poisoned.".to_string())
            }
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(TryLockError::WouldBlock) => return Err(timeout_message.to_string()),
        }
    }
}

fn is_bypass_permission_mode(mode: &str) -> bool {
    matches!(mode, "yolo" | "bypassPermissions")
}

fn effective_native_perm_mode<'a>(
    perm_mode: &'a str,
    runtime_perm_mode: Option<&'a str>,
) -> &'a str {
    runtime_perm_mode.unwrap_or(perm_mode)
}

fn native_session_allows_dangerously_skip_permissions(options: &NativeSessionOptions) -> bool {
    options.provider == NativeProvider::Claude
        && (is_bypass_permission_mode(&options.perm_mode)
            || options
                .runtime_perm_mode
                .as_deref()
                .is_some_and(is_bypass_permission_mode))
}

fn authorize_browser_tool_for_record(
    record: &NativeSessionRecord,
    tool: &str,
) -> Result<(), String> {
    authorize_browser_tool(
        effective_native_perm_mode(
            record.perm_mode.as_str(),
            record.runtime_perm_mode.as_deref(),
        ),
        tool,
    )
}

fn deliver_browser_permission_change<Deliver, Commit, Quarantine>(
    expands_browser_authority: bool,
    deliver: Deliver,
    commit: Commit,
    quarantine: Quarantine,
) -> Result<(), String>
where
    Deliver: FnOnce() -> Result<(), String>,
    Commit: FnOnce() -> Result<(), String>,
    Quarantine: FnOnce() -> Result<(), String>,
{
    let transition = if expands_browser_authority {
        deliver().and_then(|_| commit())
    } else {
        commit().and_then(|_| deliver())
    };

    match transition {
        Ok(()) => Ok(()),
        Err(transition_error) => match quarantine() {
            Ok(()) => Err(transition_error),
            Err(quarantine_error) => Err(format!(
                "{transition_error}; failed to quarantine split permission authority: {quarantine_error}"
            )),
        },
    }
}

#[cfg(unix)]
fn signal_native_helper_termination(pid: u32) -> Result<(), String> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err("Refusing to terminate an invalid native helper pid.".to_string());
    }
    // SAFETY: launch verification proves this exact pid is the dedicated group leader. A negative
    // pid therefore reaches Node, the provider CLI, and every inherited tool descendant.
    let result = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(format!(
            "Failed to terminate native helper process group {pid}: {error}"
        ))
    }
}

#[cfg(unix)]
fn native_helper_process_exists(pid: u32) -> Result<bool, String> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err("Refusing to inspect an invalid native helper pid.".to_string());
    }
    // SAFETY: signal 0 checks the verified dedicated process group without changing it.
    let result = unsafe { libc::kill(-(pid as i32), 0) };
    if result == 0 {
        return Ok(true);
    }
    match io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        Some(libc::EPERM) => Ok(true),
        _ => Err(format!(
            "Failed to inspect native helper process group {pid}: {}",
            io::Error::last_os_error()
        )),
    }
}

#[cfg(unix)]
fn native_helper_leader_exists(pid: u32) -> Result<bool, String> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err("Refusing to inspect an invalid native helper pid.".to_string());
    }
    // SAFETY: signal 0 only inspects the exact still-owned launcher pid.
    let result = unsafe { libc::kill(pid as i32, 0) };
    if result == 0 {
        return Ok(true);
    }
    match io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        Some(libc::EPERM) => Ok(true),
        _ => Err(format!(
            "Failed to inspect native helper pid {pid}: {}",
            io::Error::last_os_error()
        )),
    }
}

#[cfg(target_os = "macos")]
fn native_helper_process_birth_token(pid: u32) -> Result<Option<u64>, String> {
    use std::mem::{size_of, zeroed};
    if pid == 0 || pid > i32::MAX as u32 {
        return Err("Refusing to inspect an invalid native helper pid.".to_string());
    }
    let mut info: libc::proc_bsdinfo = unsafe { zeroed() };
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    if read == size_of::<libc::proc_bsdinfo>() as i32 {
        return Ok(Some(
            ((info.pbi_start_tvsec as u64) << 20) | info.pbi_start_tvusec as u64,
        ));
    }
    if native_helper_leader_exists(pid)? {
        Err(format!(
            "Failed to read native helper pid {pid} birth identity."
        ))
    } else {
        Ok(None)
    }
}

#[cfg(target_os = "linux")]
fn native_helper_process_birth_token(pid: u32) -> Result<Option<u64>, String> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err("Refusing to inspect an invalid native helper pid.".to_string());
    }
    let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Failed to read native helper pid {pid} birth identity: {error}"
            ))
        }
    };
    let suffix = stat
        .rfind(')')
        .and_then(|index| stat.get(index + 1..))
        .ok_or_else(|| format!("Native helper pid {pid} has malformed process identity."))?;
    let start_ticks = suffix
        .split_whitespace()
        .nth(19)
        .ok_or_else(|| format!("Native helper pid {pid} has incomplete process identity."))?
        .parse::<u64>()
        .map_err(|_| format!("Native helper pid {pid} has invalid process identity."))?;
    Ok(Some(start_ticks))
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn native_helper_process_birth_token(_pid: u32) -> Result<Option<u64>, String> {
    Err("Native helper birth identity is unsupported on this Unix platform.".to_string())
}

#[cfg(windows)]
fn signal_native_helper_termination(pid: u32) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };
    if pid == 0 {
        return Err("Refusing to terminate an invalid native helper pid.".to_string());
    }
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return match unsafe { GetLastError() } {
            ERROR_INVALID_PARAMETER => Ok(()),
            error => Err(format!(
                "Failed to open native helper pid {pid} for termination: Windows error {error}"
            )),
        };
    }
    let terminated = unsafe { TerminateProcess(handle, 1) };
    let error = if terminated == 0 {
        Some(unsafe { GetLastError() })
    } else {
        None
    };
    unsafe { CloseHandle(handle) };
    match error {
        Some(error) => Err(format!(
            "Failed to terminate native helper pid {pid}: Windows error {error}"
        )),
        None => Ok(()),
    }
}

#[cfg(windows)]
fn native_helper_process_exists(pid: u32) -> Result<bool, String> {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };
    if pid == 0 {
        return Err("Refusing to inspect an invalid native helper pid.".to_string());
    }
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return match unsafe { GetLastError() } {
            ERROR_INVALID_PARAMETER => Ok(false),
            error => Err(format!(
                "Failed to inspect native helper pid {pid}: Windows error {error}"
            )),
        };
    }
    let wait = unsafe { WaitForSingleObject(handle, 0) };
    unsafe { CloseHandle(handle) };
    match wait {
        WAIT_OBJECT_0 => Ok(false),
        WAIT_TIMEOUT => Ok(true),
        other => Err(format!(
            "Failed to inspect native helper pid {pid}: wait result {other}"
        )),
    }
}

#[cfg(windows)]
fn windows_process_creation_ticks_from_handle(
    pid: u32,
    handle: windows_sys::Win32::Foundation::HANDLE,
) -> Result<u64, String> {
    use windows_sys::Win32::Foundation::{GetLastError, FILETIME};
    use windows_sys::Win32::System::Threading::GetProcessTimes;
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(format!(
            "Failed to read native helper pid {pid} identity: Windows error {}",
            unsafe { GetLastError() }
        ));
    }
    Ok(((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
}

#[cfg(windows)]
fn native_helper_process_creation_ticks(pid: u32) -> Result<Option<u64>, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };
    if pid == 0 {
        return Err("Refusing to inspect an invalid native helper pid.".to_string());
    }
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if handle.is_null() {
        return match unsafe { GetLastError() } {
            ERROR_INVALID_PARAMETER => Ok(None),
            error => Err(format!(
                "Failed to inspect native helper pid {pid}: Windows error {error}"
            )),
        };
    }
    let result = windows_process_creation_ticks_from_handle(pid, handle);
    unsafe { CloseHandle(handle) };
    result.map(Some)
}

#[cfg(windows)]
fn native_helper_leader_exists(pid: u32) -> Result<bool, String> {
    native_helper_process_exists(pid)
}

fn terminate_unverified_native_helper(pid: u32, timeout: Duration) -> Result<(), String> {
    #[cfg(unix)]
    {
        if pid == 0 || pid > i32::MAX as u32 {
            return Err("Refusing to terminate an invalid native helper pid.".to_string());
        }
        // The launcher may be immediately before or after setpgid. Target both safe identities;
        // one may report ESRCH, but neither can escape the bounded disappearance proof below.
        let group_result = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        let group_error = io::Error::last_os_error();
        let leader_result = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        let leader_error = io::Error::last_os_error();
        if group_result == -1
            && group_error.raw_os_error() != Some(libc::ESRCH)
            && leader_result == -1
            && leader_error.raw_os_error() != Some(libc::ESRCH)
        {
            return Err(format!(
                "Failed to terminate unverified native helper {pid}: group={group_error}; leader={leader_error}"
            ));
        }
    }
    #[cfg(windows)]
    signal_native_helper_termination(pid)?;

    let deadline = Instant::now() + timeout;
    loop {
        if !native_helper_leader_exists(pid)? && !native_helper_process_exists(pid)? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Unverified native helper {pid} did not exit within {} ms.",
                timeout.as_millis()
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(unix)]
fn terminate_verified_native_helper(
    pid: u32,
    expected_birth_token: u64,
    timeout: Duration,
) -> Result<(), String> {
    if pid == 0 || pid > i32::MAX as u32 || expected_birth_token == 0 {
        return Err("Refusing to terminate an unverified native helper identity.".to_string());
    }
    let current_birth_token = native_helper_process_birth_token(pid)?;
    match current_birth_token {
        Some(current_birth_token) => {
            if current_birth_token != expected_birth_token {
                return Err(format!(
                    "Native helper pid {pid} identity changed before termination."
                ));
            }
            let pgid = unsafe { libc::getpgid(pid as i32) };
            if pgid != pid as i32 {
                return Err(format!(
                    "Native helper pid {pid} no longer owns its verified process group."
                ));
            }
        }
        None if !native_helper_process_exists(pid)? => return Ok(()),
        // The verified leader was reaped but descendants remain in the same orphaned ownership
        // domain. A new unrelated group with this id would require a live leader at `pid`, which
        // the birth-identity probe above would have observed.
        None => {}
    }
    let signalled = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
    if signalled == -1 && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
        return Err(format!(
            "Failed to terminate verified native helper process group {pid}: {}",
            io::Error::last_os_error()
        ));
    }
    let deadline = Instant::now() + timeout;
    loop {
        if !native_helper_process_exists(pid)? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Verified native helper process group {pid} did not exit within {} ms.",
                timeout.as_millis()
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(windows)]
fn terminate_verified_native_helper(
    pid: u32,
    expected_birth_token: u64,
    timeout: Duration,
) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };
    if pid == 0 || expected_birth_token == 0 {
        return Err("Refusing to terminate an unverified native helper identity.".to_string());
    }
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if handle.is_null() {
        return match unsafe { GetLastError() } {
            ERROR_INVALID_PARAMETER => Ok(()),
            error => Err(format!(
                "Failed to open verified native helper pid {pid}: Windows error {error}"
            )),
        };
    }
    let actual_birth_token = windows_process_creation_ticks_from_handle(pid, handle);
    if let Err(error) = actual_birth_token {
        unsafe { CloseHandle(handle) };
        return Err(error);
    }
    if actual_birth_token.unwrap() != expected_birth_token {
        unsafe { CloseHandle(handle) };
        return Err(format!(
            "Native helper pid {pid} identity changed before termination."
        ));
    }
    if unsafe { TerminateProcess(handle, 1) } == 0 {
        let error = unsafe { GetLastError() };
        unsafe { CloseHandle(handle) };
        return Err(format!(
            "Failed to terminate verified native helper pid {pid}: Windows error {error}"
        ));
    }
    let wait_millis = timeout.as_millis().min(u32::MAX as u128) as u32;
    let wait = unsafe { WaitForSingleObject(handle, wait_millis) };
    let wait_error = if wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT {
        Some(unsafe { GetLastError() })
    } else {
        None
    };
    unsafe { CloseHandle(handle) };
    match wait {
        WAIT_OBJECT_0 => Ok(()),
        WAIT_TIMEOUT => Err(format!(
            "Verified native helper {pid} did not exit within {} ms.",
            timeout.as_millis()
        )),
        _ => Err(format!(
            "Failed waiting for verified native helper {pid}: Windows error {}",
            wait_error.unwrap_or_default()
        )),
    }
}

fn native_status_allows_file_rewind(status: &str) -> bool {
    matches!(status, "idle" | "ready" | "interrupted" | "closed_idle")
}

fn retire_browser_agent_control(app: Option<&AppHandle>, runtime_id: &str) -> Result<(), String> {
    let Some(app) = app else {
        return Ok(());
    };
    let Some(browser) = app.try_state::<Arc<BrowserManager>>() else {
        return Ok(());
    };
    browser.retire_agent_control(app, runtime_id).map(|_| ())
}

fn retire_login_browser_agent_control(
    app: &AppHandle,
    workspace_dir: &str,
    browser_actor_id: &str,
) -> Result<(), String> {
    let Some(login) =
        app.try_state::<Arc<crate::browser::login::session::LoginBrowserSessionManager>>()
    else {
        return Ok(());
    };
    let workspace = crate::browser::login::session::TrustedWorkspacePath::from_trusted_app(
        PathBuf::from(workspace_dir),
    )
    .map_err(|error| error.to_string())?;
    login
        .retire_agent_for_actor(workspace, browser_actor_id)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn notify_browser_policy_changed(
    app: &AppHandle,
    runtime_id: &str,
    permission_revision: u64,
) -> bool {
    let Some(browser) = app.try_state::<Arc<BrowserManager>>() else {
        return true;
    };
    match browser.policy_changed(app, runtime_id, permission_revision) {
        Ok(()) => true,
        Err(error) => {
            eprintln!(
                "Failed to invalidate preview browser policy for {}: {}",
                runtime_id, error
            );
            false
        }
    }
}

fn helper_command_kind(command: &HelperInputCommand<'_>) -> &'static str {
    match command {
        HelperInputCommand::Init { .. } => "init",
        HelperInputCommand::Prompt { .. } => "prompt",
        HelperInputCommand::PermissionResponse { .. } => "permission_response",
        HelperInputCommand::InteractivePromptResponse { .. } => "interactive_prompt_response",
        HelperInputCommand::UpdateSettings { .. } => "update_settings",
        HelperInputCommand::RewindFiles { .. } => "rewind_files",
        HelperInputCommand::BrowserToolResponse { .. } => "browser_tool_response",
        HelperInputCommand::Stop => "stop",
    }
}

const UNATTRIBUTED_STOP_SOURCE: &str = "unattributed";

fn normalize_stop_source(source: Option<&str>) -> String {
    let Some(source) = source.map(str::trim).filter(|source| !source.is_empty()) else {
        return UNATTRIBUTED_STOP_SOURCE.to_string();
    };

    let normalized: String = source
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | ':'))
        .take(80)
        .collect();

    if normalized.is_empty() {
        UNATTRIBUTED_STOP_SOURCE.to_string()
    } else {
        normalized
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum HelperOutputEvent {
    SessionMeta {
        provider_session_id: String,
    },
    Status {
        status: String,
        #[serde(default)]
        detail: Option<String>,
    },
    Event {
        payload: Value,
    },
    BrowserToolRequest {
        request_id: String,
        tool: String,
        #[serde(default)]
        args: Value,
    },
    SettingsUpdateResult {
        request_id: String,
        outcome: SettingsUpdateOutcome,
        #[serde(default)]
        detail: Option<String>,
    },
}

struct NativeSessionHandle {
    generation: u64,
    record: Mutex<NativeSessionRecord>,
    browser_permission: BrowserPermissionAuthority,
    browser_permission_sync: Mutex<()>,
    launcher_pid: AtomicU32,
    launcher_birth_token: AtomicU64,
    writer: Mutex<Option<NativeHelperWriter>>,
    events: Mutex<SessionStore>,
    settings_update_acks: SettingsUpdateAckRegistry,
    helper_env_vars: HashMap<String, String>,
    terminal_env_vars: HashMap<String, String>,
    claude_path: Option<String>,
    codex_path: Option<String>,
    codex_base_url: Option<String>,
    codex_api_key: Option<String>,
    permission_quarantined: AtomicBool,
    alive: AtomicBool,
}

impl NativeSessionHandle {
    fn summary(&self) -> NativeSessionSummary {
        let record = self
            .record
            .lock()
            .expect("native session record poisoned")
            .clone();
        let last_event_seq = self.events.lock().ok().and_then(|store| store.newest_seq());
        NativeSessionSummary {
            runtime_id: record.runtime_id,
            provider: record.provider,
            transport: record.transport,
            provider_session_id: record.provider_session_id,
            seed_boundary_message_count: record.seed_boundary_message_count,
            project_dir: record.project_dir,
            env_name: record.env_name,
            perm_mode: record.perm_mode,
            runtime_perm_mode: record.runtime_perm_mode,
            effort: record.effort,
            status: record.status,
            created_at: record.created_at,
            updated_at: record.updated_at,
            is_active: record.is_active,
            last_event_seq,
            can_handoff_to_terminal: record.can_handoff_to_terminal,
            last_error: record.last_error,
        }
    }
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct TerminalLaunchInvocation {
    terminal: TerminalType,
    working_dir: String,
    runtime_id: String,
    env_name: String,
    perm_mode: Option<String>,
    resume_session_id: Option<String>,
    client: String,
}

#[cfg(test)]
thread_local! {
    static TERMINAL_LAUNCHES: RefCell<Vec<TerminalLaunchInvocation>> =
        const { RefCell::new(Vec::new()) };
}

#[cfg(test)]
fn clear_terminal_launches() {
    TERMINAL_LAUNCHES.with(|launches| launches.borrow_mut().clear());
}

#[cfg(test)]
fn take_terminal_launches() -> Vec<TerminalLaunchInvocation> {
    TERMINAL_LAUNCHES.with(|launches| std::mem::take(&mut *launches.borrow_mut()))
}

#[cfg(not(test))]
fn launch_terminal_for_native_handoff(
    terminal: TerminalType,
    env_vars: HashMap<String, String>,
    working_dir: &str,
    runtime_id: &str,
    env_name: &str,
    perm_mode: Option<&str>,
    resume_session_id: Option<&str>,
    client: &str,
) -> Result<(), String> {
    terminal::launch_in_terminal(
        terminal,
        env_vars,
        working_dir,
        runtime_id,
        env_name,
        perm_mode,
        resume_session_id,
        client,
    )
    .map(|_| ())
}

#[cfg(test)]
fn launch_terminal_for_native_handoff(
    terminal: TerminalType,
    _env_vars: HashMap<String, String>,
    working_dir: &str,
    runtime_id: &str,
    env_name: &str,
    perm_mode: Option<&str>,
    resume_session_id: Option<&str>,
    client: &str,
) -> Result<(), String> {
    TERMINAL_LAUNCHES.with(|launches| {
        launches.borrow_mut().push(TerminalLaunchInvocation {
            terminal,
            working_dir: working_dir.to_string(),
            runtime_id: runtime_id.to_string(),
            env_name: env_name.to_string(),
            perm_mode: perm_mode.map(str::to_string),
            resume_session_id: resume_session_id.map(str::to_string),
            client: client.to_string(),
        });
    });
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct NativeRuntimeState {
    sessions: Vec<NativeSessionRecord>,
}

pub struct NativeRuntimeManager {
    records: Mutex<HashMap<String, NativeSessionRecord>>,
    handles: Mutex<HashMap<String, Arc<NativeSessionHandle>>>,
    permission_quarantine_fences: Mutex<HashSet<String>>,
    permission_transactions: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    lifecycle_transactions: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    next_handle_generation: AtomicU64,
    state_path: PathBuf,
    event_log: NativeEventLog,
    prompt_image_store: PromptImageStore,
}

impl Default for NativeRuntimeManager {
    fn default() -> Self {
        let state_path = native_runtime_state_file_path();
        let records: HashMap<String, NativeSessionRecord> =
            read_native_runtime_state_from(&state_path)
                .unwrap_or_default()
                .sessions
                .into_iter()
                .map(|record| (record.runtime_id.clone(), record))
                .collect();
        let permission_quarantine_fences = records
            .values()
            .filter(|record| record.permission_quarantined)
            .map(|record| record.runtime_id.clone())
            .collect();
        Self {
            records: Mutex::new(records),
            handles: Mutex::new(HashMap::new()),
            permission_quarantine_fences: Mutex::new(permission_quarantine_fences),
            permission_transactions: Mutex::new(HashMap::new()),
            lifecycle_transactions: Mutex::new(HashMap::new()),
            next_handle_generation: AtomicU64::new(1),
            state_path,
            event_log: NativeEventLog::default(),
            prompt_image_store: PromptImageStore::default(),
        }
    }
}

impl NativeRuntimeManager {
    pub fn create_session(
        self: &Arc<Self>,
        app: AppHandle,
        options: NativeSessionOptions,
    ) -> Result<NativeSessionSummary, String> {
        let mut options = options;
        options.initial_annotations =
            validate_prompt_annotations(options.initial_annotations.as_ref())?;
        merge_helper_env_path(&mut options.helper_env_vars, &terminal::get_user_path());
        let runtime_id = generate_runtime_id();
        inject_ccem_runtime_env(&mut options.helper_env_vars, &runtime_id);
        inject_ccem_runtime_env(&mut options.terminal_env_vars, &runtime_id);
        let now = Utc::now();
        let record = NativeSessionRecord {
            runtime_id: runtime_id.clone(),
            provider: options.provider,
            transport: NativeTransport::NativeSdk,
            provider_session_id: options.provider_session_id.clone(),
            browser_actor_id: generate_browser_actor_id()?,
            seed_boundary_message_count: options.seed_boundary_message_count,
            project_dir: options.working_dir.clone(),
            env_name: options.env_name.clone(),
            perm_mode: options.perm_mode.clone(),
            runtime_perm_mode: options.runtime_perm_mode.clone(),
            effort: options.effort.clone(),
            status: "initializing".to_string(),
            created_at: now,
            updated_at: now,
            is_active: true,
            can_handoff_to_terminal: terminal::external_terminal_launch_supported(),
            permission_quarantined: false,
            pending_handoff_terminal: None,
            last_error: None,
        };
        let record = self.insert_record(record)?;

        let handle = Arc::new(NativeSessionHandle {
            generation: self.allocate_handle_generation(),
            record: Mutex::new(record.clone()),
            browser_permission: BrowserPermissionAuthority::new(effective_native_perm_mode(
                record.perm_mode.as_str(),
                record.runtime_perm_mode.as_deref(),
            )),
            browser_permission_sync: Mutex::new(()),
            launcher_pid: AtomicU32::new(0),
            launcher_birth_token: AtomicU64::new(0),
            writer: Mutex::new(None),
            events: Mutex::new(SessionStore::new(runtime_id.clone())),
            settings_update_acks: SettingsUpdateAckRegistry::default(),
            helper_env_vars: options.helper_env_vars.clone(),
            terminal_env_vars: options.terminal_env_vars.clone(),
            claude_path: options.claude_path.clone(),
            codex_path: options.codex_path.clone(),
            codex_base_url: options.codex_base_url.clone(),
            codex_api_key: options.codex_api_key.clone(),
            permission_quarantined: AtomicBool::new(false),
            alive: AtomicBool::new(true),
        });

        self.insert_handle(runtime_id.clone(), handle.clone())?;
        self.append_event(
            &runtime_id,
            SessionEventPayload::Lifecycle {
                stage: "runtime_boot".to_string(),
                detail: format!("Starting {} native runtime.", options.provider.as_str()),
            },
        )?;
        self.append_user_prompt_event(
            &runtime_id,
            options
                .display_prompt
                .as_deref()
                .or(options.initial_prompt.as_deref())
                .unwrap_or_default(),
            options.initial_images.as_ref(),
            options.initial_annotations.as_ref(),
        )?;
        self.spawn_helper(app, &runtime_id, &options, handle)?;
        self.summary_for(&runtime_id)
    }

    pub fn list_sessions(&self) -> Vec<NativeSessionSummary> {
        let handles = self
            .handles
            .lock()
            .ok()
            .map(|handles| handles.clone())
            .unwrap_or_default();
        let records = self
            .records
            .lock()
            .ok()
            .map(|records| records.clone())
            .unwrap_or_default();

        let mut sessions = records
            .into_values()
            .map(|record| {
                if let Some(handle) = handles.get(&record.runtime_id) {
                    handle.summary()
                } else {
                    NativeSessionSummary {
                        runtime_id: record.runtime_id,
                        provider: record.provider,
                        transport: record.transport,
                        provider_session_id: record.provider_session_id,
                        seed_boundary_message_count: record.seed_boundary_message_count,
                        project_dir: record.project_dir,
                        env_name: record.env_name,
                        perm_mode: record.perm_mode,
                        runtime_perm_mode: record.runtime_perm_mode,
                        effort: record.effort,
                        status: record.status,
                        created_at: record.created_at,
                        updated_at: record.updated_at,
                        is_active: record.is_active,
                        last_event_seq: None,
                        can_handoff_to_terminal: record.can_handoff_to_terminal,
                        last_error: record.last_error,
                    }
                }
            })
            .collect::<Vec<_>>();

        sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
        sessions
    }

    pub fn replay_events(
        &self,
        runtime_id: &str,
        since_seq: Option<u64>,
    ) -> Result<ReplayBatch, String> {
        self.replay_events_limited(runtime_id, since_seq, None)
    }

    pub fn replay_events_limited(
        &self,
        runtime_id: &str,
        since_seq: Option<u64>,
        limit: Option<u64>,
    ) -> Result<ReplayBatch, String> {
        match self.event_log.replay(runtime_id, since_seq, limit) {
            Ok(batch) if batch.newest_available_seq.is_some() => return Ok(batch),
            Ok(_) => {}
            Err(error) => eprintln!(
                "Failed to replay native events from sqlite for {}: {}",
                runtime_id, error
            ),
        }

        let handles = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?;
        let Some(handle) = handles.get(runtime_id) else {
            if self.has_record(runtime_id)? {
                return Ok(ReplayBatch {
                    gap_detected: false,
                    truncated: false,
                    oldest_available_seq: None,
                    newest_available_seq: None,
                    events: Vec::new(),
                });
            }
            return Err(format!("Native runtime {} not found", runtime_id));
        };
        handle
            .events
            .lock()
            .map_err(|_| "Failed to lock native session events".to_string())
            .map(|store| {
                let mut batch = store.events_since(since_seq);
                if since_seq.is_none() {
                    if let Some(limit) = limit.and_then(|value| usize::try_from(value).ok()) {
                        if limit > 0 && batch.events.len() > limit {
                            batch.events = batch.events[batch.events.len() - limit..].to_vec();
                            batch.truncated = true;
                        }
                    }
                }
                batch
            })
    }

    pub fn send_user_message(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        text: &str,
        display_text: Option<&str>,
        images: Option<&Vec<PromptImage>>,
        annotations: Option<&Vec<SessionPromptAnnotation>>,
    ) -> Result<(), String> {
        let text = text.trim();
        let has_images = images.as_ref().is_some_and(|imgs| !imgs.is_empty());
        let annotations = validate_prompt_annotations(annotations)?;
        if text.is_empty() && !has_images {
            return Ok(());
        }

        let mut handle = self.ensure_handle(app.clone(), runtime_id)?;
        let image_count = images.as_ref().map(|imgs| imgs.len()).unwrap_or(0);
        if !self.mark_handle_live_if_current(runtime_id, &handle)? {
            handle = self.ensure_handle(app.clone(), runtime_id)?;
            if !self.mark_handle_live_if_current(runtime_id, &handle)? {
                return Err("Native runtime helper was replaced while sending prompt".to_string());
            }
        }
        let record = handle
            .record
            .lock()
            .map_err(|_| "Failed to lock native session record".to_string())?
            .clone();
        self.append_lifecycle_event(
            runtime_id,
            "prompt_send_requested",
            format!(
                "runtime_id={} provider={} status={} handle_generation={} chars={} images={}",
                runtime_id,
                record.provider.as_str(),
                record.status,
                handle.generation,
                text.chars().count(),
                image_count
            ),
        )?;
        let images_ref = images
            .filter(|imgs| !imgs.is_empty())
            .map(|imgs| imgs.as_slice());
        self.write_to_child_with_reconnect(
            app,
            runtime_id,
            handle,
            &HelperInputCommand::Prompt {
                text,
                images: images_ref,
            },
        )?;
        self.append_lifecycle_event(
            runtime_id,
            "prompt_send_written",
            format!(
                "helper accepted prompt command: chars={} images={}",
                text.chars().count(),
                image_count
            ),
        )?;
        self.append_user_prompt_event(
            runtime_id,
            display_text.unwrap_or(text),
            images,
            annotations.as_ref(),
        )
    }

    pub fn respond_to_permission(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        request_id: &str,
        approved: bool,
    ) -> Result<(), String> {
        let handle = self.ensure_handle(app.clone(), runtime_id)?;
        self.write_to_child_with_reconnect(
            app,
            runtime_id,
            handle,
            &HelperInputCommand::PermissionResponse {
                request_id,
                approved,
            },
        )
    }

    pub fn respond_to_prompt(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        tool_use_id: &str,
        prompt_type: &str,
        display_text: Option<&str>,
        answers: &HashMap<String, String>,
        annotations: Option<&HashMap<String, InteractivePromptAnnotation>>,
        prompt_annotations: Option<&Vec<SessionPromptAnnotation>>,
    ) -> Result<(), String> {
        if answers.is_empty() {
            return Err("Interactive prompt response requires at least one answer.".to_string());
        }
        let prompt_annotations = validate_prompt_annotations(prompt_annotations)?;

        let handle = self.ensure_handle(app.clone(), runtime_id)?;
        self.deliver_and_append_interactive_prompt_response(
            runtime_id,
            display_text,
            answers,
            prompt_annotations.as_ref(),
            || {
                self.write_to_child_with_reconnect(
                    app,
                    runtime_id,
                    handle,
                    &HelperInputCommand::InteractivePromptResponse {
                        tool_use_id,
                        prompt_type,
                        answers,
                        annotations,
                    },
                )
            },
        )
    }

    pub fn rewind_files(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        checkpoint_id: &str,
    ) -> Result<(), String> {
        let checkpoint_id = checkpoint_id.trim();
        if checkpoint_id.is_empty() {
            return Err("Checkpoint id is required.".to_string());
        }

        let handle = self.ensure_handle(app.clone(), runtime_id)?;
        let status = handle
            .record
            .lock()
            .map_err(|_| "Failed to lock native session record".to_string())?
            .status
            .clone();
        if !native_status_allows_file_rewind(&status) {
            return Err(format!(
                "Cannot rewind files while native session is {}.",
                status
            ));
        }

        self.write_to_child_with_reconnect(
            app,
            runtime_id,
            handle,
            &HelperInputCommand::RewindFiles { checkpoint_id },
        )
    }

    pub fn update_session_settings(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        env_name: Option<&str>,
        perm_mode: Option<&str>,
        env_vars: Option<&HashMap<String, String>>,
        effort: Option<&str>,
    ) -> Result<(), String> {
        let transaction = self.permission_transaction_lock(runtime_id)?;
        let _transaction = transaction
            .lock()
            .map_err(|_| "Failed to lock native permission transaction".to_string())?;
        let handle = self.ensure_handle(app.clone(), runtime_id)?;
        let request_id = new_settings_update_request_id();
        let command = HelperInputCommand::UpdateSettings {
            request_id: &request_id,
            env_name,
            perm_mode,
            env_vars,
            effort,
        };
        if let Some(mode) = perm_mode {
            let next_perm_mode = mode.to_string();
            let expands = self.browser_permission_change_expands(&handle, &next_perm_mode, None)?;
            let permission_deadline = Instant::now() + NATIVE_SETTINGS_UPDATE_ACK_TIMEOUT;
            let lifecycle = self.lifecycle_transaction_lock(runtime_id)?;
            let _lifecycle = match lock_until(
                lifecycle.as_ref(),
                permission_deadline,
                "Native settings update timed out waiting for helper lifecycle ownership.",
            ) {
                Ok(guard) => guard,
                Err(error) => {
                    self.fence_permission_quarantine_handle(runtime_id, &handle);
                    let quarantine =
                        self.quarantine_permission_transition(app, runtime_id, &handle);
                    return Err(match quarantine {
                        Ok(()) => error,
                        Err(quarantine_error) => format!(
                            "{error}; failed to quarantine split permission authority: {quarantine_error}"
                        ),
                    });
                }
            };
            deliver_browser_permission_change(
                expands,
                || {
                    self.write_settings_with_required_ack(
                        runtime_id,
                        Arc::clone(&handle),
                        &command,
                        &request_id,
                        permission_deadline,
                    )
                },
                || {
                    self.commit_browser_permission_fields(
                        app,
                        runtime_id,
                        &handle,
                        next_perm_mode,
                        None,
                    )
                },
                || self.quarantine_permission_transition(app, runtime_id, &handle),
            )?;
        } else {
            self.write_to_child_with_reconnect(app, runtime_id, handle, &command)?;
        }
        self.update_record(runtime_id, |record| {
            if let Some(name) = env_name {
                record.env_name = name.to_string();
            }
            if let Some(next_effort) = effort {
                record.effort = non_empty_error(next_effort);
            }
            record.updated_at = Utc::now();
        })?;
        Ok(())
    }

    pub fn update_session_runtime_perm_mode(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        runtime_perm_mode: Option<&str>,
    ) -> Result<(), String> {
        let transaction = self.permission_transaction_lock(runtime_id)?;
        let _transaction = transaction
            .lock()
            .map_err(|_| "Failed to lock native permission transaction".to_string())?;
        let handle = self.ensure_handle(app.clone(), runtime_id)?;
        let display_perm_mode = {
            let record = handle
                .record
                .lock()
                .map_err(|_| "Failed to lock native session record".to_string())?;
            record.perm_mode.clone()
        };
        let normalized_runtime_perm_mode = runtime_perm_mode
            .map(|mode| mode.trim().to_string())
            .filter(|mode| !mode.is_empty() && mode != &display_perm_mode);
        let helper_perm_mode = effective_native_perm_mode(
            display_perm_mode.as_str(),
            normalized_runtime_perm_mode.as_deref(),
        )
        .to_string();

        let expands = self.browser_permission_change_expands(
            &handle,
            &display_perm_mode,
            normalized_runtime_perm_mode.as_deref(),
        )?;
        let request_id = new_settings_update_request_id();
        let command = HelperInputCommand::UpdateSettings {
            request_id: &request_id,
            env_name: None,
            perm_mode: Some(&helper_perm_mode),
            env_vars: None,
            effort: None,
        };
        let permission_deadline = Instant::now() + NATIVE_SETTINGS_UPDATE_ACK_TIMEOUT;
        let lifecycle = self.lifecycle_transaction_lock(runtime_id)?;
        let _lifecycle = match lock_until(
            lifecycle.as_ref(),
            permission_deadline,
            "Native settings update timed out waiting for helper lifecycle ownership.",
        ) {
            Ok(guard) => guard,
            Err(error) => {
                self.fence_permission_quarantine_handle(runtime_id, &handle);
                let quarantine = self.quarantine_permission_transition(app, runtime_id, &handle);
                return Err(match quarantine {
                    Ok(()) => error,
                    Err(quarantine_error) => format!(
                        "{error}; failed to quarantine split permission authority: {quarantine_error}"
                    ),
                });
            }
        };
        deliver_browser_permission_change(
            expands,
            || {
                self.write_settings_with_required_ack(
                    runtime_id,
                    Arc::clone(&handle),
                    &command,
                    &request_id,
                    permission_deadline,
                )
            },
            || {
                self.commit_browser_permission_fields(
                    app,
                    runtime_id,
                    &handle,
                    display_perm_mode,
                    normalized_runtime_perm_mode,
                )
            },
            || self.quarantine_permission_transition(app, runtime_id, &handle),
        )
    }

    fn write_settings_with_required_ack(
        &self,
        runtime_id: &str,
        handle: Arc<NativeSessionHandle>,
        command: &HelperInputCommand<'_>,
        request_id: &str,
        deadline: Instant,
    ) -> Result<(), String> {
        let result = (|| {
            if !self.is_current_handle(runtime_id, &handle)? {
                return Err("Native runtime helper changed before settings delivery.".to_string());
            }
            let receiver = handle.settings_update_acks.register(request_id)?;
            if let Err(error) = self.write_to_child_until(&handle, command, deadline) {
                let _ = handle.settings_update_acks.cancel(request_id);
                return Err(error);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let result = wait_for_required_settings_ack(request_id, receiver, remaining);
            let _ = handle.settings_update_acks.cancel(request_id);
            result?;
            if !self.is_current_handle(runtime_id, &handle)?
                || handle.permission_quarantined.load(Ordering::SeqCst)
            {
                return Err(
                    "Native runtime helper changed before settings were committed.".to_string(),
                );
            }
            Ok(())
        })();
        if result.is_err() {
            self.fence_permission_quarantine_handle(runtime_id, &handle);
        }
        result
    }

    fn permission_transaction_lock(&self, runtime_id: &str) -> Result<Arc<Mutex<()>>, String> {
        let mut transactions = self
            .permission_transactions
            .lock()
            .map_err(|_| "Failed to lock native permission transactions".to_string())?;
        Ok(Arc::clone(
            transactions
                .entry(runtime_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        ))
    }

    fn fence_permission_quarantine(&self, runtime_id: &str) {
        let mut fences = match self.permission_quarantine_fences.lock() {
            Ok(fences) => fences,
            Err(poisoned) => poisoned.into_inner(),
        };
        fences.insert(runtime_id.to_string());
    }

    fn clear_permission_quarantine_fence(&self, runtime_id: &str) {
        let mut fences = match self.permission_quarantine_fences.lock() {
            Ok(fences) => fences,
            Err(poisoned) => poisoned.into_inner(),
        };
        fences.remove(runtime_id);
    }

    fn fence_permission_quarantine_handle(
        &self,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
    ) {
        self.fence_permission_quarantine(runtime_id);
        handle.permission_quarantined.store(true, Ordering::SeqCst);
        handle.alive.store(false, Ordering::SeqCst);
    }

    fn is_permission_quarantine_fenced(&self, runtime_id: &str) -> bool {
        let fences = match self.permission_quarantine_fences.lock() {
            Ok(fences) => fences,
            Err(poisoned) => poisoned.into_inner(),
        };
        fences.contains(runtime_id)
    }

    fn lifecycle_transaction_lock(&self, runtime_id: &str) -> Result<Arc<Mutex<()>>, String> {
        let mut transactions = self
            .lifecycle_transactions
            .lock()
            .map_err(|_| "Failed to lock native helper lifecycles".to_string())?;
        Ok(Arc::clone(
            transactions
                .entry(runtime_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        ))
    }

    fn browser_permission_change_expands(
        &self,
        handle: &Arc<NativeSessionHandle>,
        next_perm_mode: &str,
        next_runtime_perm_mode: Option<&str>,
    ) -> Result<bool, String> {
        let record = handle
            .record
            .lock()
            .map_err(|_| "Failed to lock native session record".to_string())?;
        let current = effective_native_perm_mode(
            record.perm_mode.as_str(),
            record.runtime_perm_mode.as_deref(),
        );
        let next = effective_native_perm_mode(next_perm_mode, next_runtime_perm_mode);
        Ok(authorize_browser_tool(current, "click").is_err()
            && authorize_browser_tool(next, "click").is_ok())
    }

    fn commit_browser_permission_fields(
        &self,
        app: &AppHandle,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
        next_perm_mode: String,
        next_runtime_perm_mode: Option<String>,
    ) -> Result<(), String> {
        if !self.is_current_handle(runtime_id, handle)?
            || handle.permission_quarantined.load(Ordering::SeqCst)
        {
            return Err("Native runtime helper changed before permission commit.".to_string());
        }
        let _sync = handle
            .browser_permission_sync
            .lock()
            .map_err(|_| "Failed to lock native browser permission authority".to_string())?;
        let (previous_perm_mode, previous_runtime_perm_mode, workspace_dir, browser_actor_id) = {
            let record = handle
                .record
                .lock()
                .map_err(|_| "Failed to lock native session record".to_string())?;
            (
                record.perm_mode.clone(),
                record.runtime_perm_mode.clone(),
                record.project_dir.clone(),
                record.browser_actor_id.clone(),
            )
        };
        let previous_effective = effective_native_perm_mode(
            previous_perm_mode.as_str(),
            previous_runtime_perm_mode.as_deref(),
        )
        .to_string();
        let next_effective =
            effective_native_perm_mode(next_perm_mode.as_str(), next_runtime_perm_mode.as_deref())
                .to_string();
        let expands_browser_authority = authorize_browser_tool(&previous_effective, "click")
            .is_err()
            && authorize_browser_tool(&next_effective, "click").is_ok();
        let next_ticket = handle
            .browser_permission
            .update_with_invalidation(&next_effective, |revision| {
                notify_browser_policy_changed(app, runtime_id, revision)
            })
            .map_err(|_| "Native browser permission authority is unavailable".to_string())?;
        let sync_result = self.sync_login_browser_permission(
            app,
            &workspace_dir,
            &browser_actor_id,
            next_ticket.clone(),
        );

        if let Err(error) = &sync_result {
            if expands_browser_authority {
                self.rollback_browser_permission_authority(
                    app,
                    runtime_id,
                    handle,
                    &workspace_dir,
                    &browser_actor_id,
                    &previous_effective,
                );
                return Err(error.clone());
            }
        }

        let update_result = self.update_record(runtime_id, |record| {
            record.perm_mode = next_perm_mode;
            record.runtime_perm_mode = next_runtime_perm_mode;
            record.updated_at = Utc::now();
        });
        if let Err(error) = update_result {
            if expands_browser_authority {
                self.rollback_browser_permission_authority(
                    app,
                    runtime_id,
                    handle,
                    &workspace_dir,
                    &browser_actor_id,
                    &previous_effective,
                );
                let _ = self.update_record(runtime_id, |record| {
                    record.perm_mode = previous_perm_mode;
                    record.runtime_perm_mode = previous_runtime_perm_mode;
                    record.updated_at = Utc::now();
                });
            }
            return Err(error);
        }
        sync_result
    }

    fn rollback_browser_permission_authority(
        &self,
        app: &AppHandle,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
        workspace_dir: &str,
        browser_actor_id: &str,
        permission_mode: &str,
    ) {
        if let Ok(ticket) = handle
            .browser_permission
            .update_with_invalidation(permission_mode, |revision| {
                notify_browser_policy_changed(app, runtime_id, revision)
            })
        {
            let _ =
                self.sync_login_browser_permission(app, workspace_dir, browser_actor_id, ticket);
        }
    }

    fn sync_login_browser_permission(
        &self,
        app: &AppHandle,
        workspace_dir: &str,
        browser_actor_id: &str,
        authority: BrowserPermissionAuthorityTicket,
    ) -> Result<(), String> {
        let Some(login) =
            app.try_state::<Arc<crate::browser::login::session::LoginBrowserSessionManager>>()
        else {
            return Ok(());
        };
        let workspace = crate::browser::login::session::TrustedWorkspacePath::from_trusted_app(
            PathBuf::from(workspace_dir),
        )
        .map_err(|error| error.to_string())?;
        login
            .update_permission_for_actor(workspace, browser_actor_id, authority)
            .map_err(|error| error.to_string())
    }

    fn quarantine_permission_transition(
        &self,
        app: &AppHandle,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
    ) -> Result<(), String> {
        // This is the emergency path for a split authority transaction. It deliberately does not
        // wait on the lifecycle mutex: a stalled writer may be the reason quarantine is running.
        // The current handle is atomically fenced and its verified domain is terminated before
        // any browser-side lock is attempted. The runtime-level fence survives generation
        // removal until durable readonly quarantine is written.
        let mut quarantine_errors = Vec::new();
        let browser_identity = self.browser_identity_for_runtime(runtime_id);
        self.fence_permission_quarantine(runtime_id);
        handle.permission_quarantined.store(true, Ordering::SeqCst);
        handle.alive.store(false, Ordering::SeqCst);

        let launcher_pid = handle.launcher_pid.load(Ordering::Acquire);
        let launcher_birth_token = handle.launcher_birth_token.load(Ordering::Acquire);
        if launcher_pid == 0 {
            quarantine_errors.push(
                "native helper has no verified launcher pid for emergency termination".to_string(),
            );
        } else if let Err(error) = terminate_verified_native_helper(
            launcher_pid,
            launcher_birth_token,
            NATIVE_PERMISSION_QUARANTINE_KILL_TIMEOUT,
        ) {
            quarantine_errors.push(format!(
                "failed to confirm native helper termination: {error}"
            ));
        } else if let Err(error) = self.remove_handle_if_current(runtime_id, handle) {
            quarantine_errors.push(format!("failed to remove quarantined helper: {error}"));
        }

        if let Err(error) = self.update_record(runtime_id, |record| {
            record.perm_mode = "readonly".to_string();
            record.runtime_perm_mode = None;
            record.permission_quarantined = true;
            record.status = "permission_quarantined".to_string();
            record.is_active = false;
            record.last_error = Some(
                "Permission update could not be completed safely; the runtime was quarantined."
                    .to_string(),
            );
            record.updated_at = Utc::now();
        }) {
            quarantine_errors.push(format!("failed to persist runtime quarantine: {error}"));
        }

        match handle.browser_permission_sync.try_lock() {
            Ok(_permission_sync) => match handle.browser_permission.try_update("readonly") {
                Ok(ticket) => match browser_identity.as_ref() {
                    Ok((workspace_dir, browser_actor_id)) => {
                        if let Err(error) = self.sync_login_browser_permission(
                            app,
                            workspace_dir,
                            browser_actor_id,
                            ticket,
                        ) {
                            quarantine_errors.push(format!(
                                "failed to retire Login Browser permission: {error}"
                            ));
                        }
                    }
                    Err(error) => quarantine_errors.push(error.clone()),
                },
                Err(_) => quarantine_errors
                    .push("failed to retire native browser permission authority".to_string()),
            },
            Err(_) => quarantine_errors.push(
                "native browser permission retirement was busy; cleanup deferred".to_string(),
            ),
        }
        match browser_identity.as_ref() {
            Ok((workspace_dir, browser_actor_id)) => {
                if let Err(error) =
                    retire_login_browser_agent_control(app, workspace_dir, browser_actor_id)
                {
                    quarantine_errors.push(format!(
                        "failed to retire Login Browser Agent control: {error}"
                    ));
                }
            }
            Err(error) => {
                if !quarantine_errors.iter().any(|existing| existing == error) {
                    quarantine_errors.push(error.clone());
                }
            }
        }
        let _ = self.append_lifecycle_event(
            runtime_id,
            "permission_transition_quarantined",
            "Permission authorities diverged during an update; browser authority was retired and the native helper is being terminated.".to_string(),
        );
        if let Err(error) = retire_browser_agent_control(Some(app), runtime_id) {
            quarantine_errors.push(format!(
                "failed to retire Preview Browser Agent control: {error}"
            ));
        }

        if quarantine_errors.is_empty() {
            Ok(())
        } else {
            Err(quarantine_errors.join("; "))
        }
    }

    pub fn stop_session(self: &Arc<Self>, app: &AppHandle, runtime_id: &str) -> Result<(), String> {
        self.stop_session_from(app, runtime_id, None)
    }

    pub fn stop_session_from(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        source: Option<&str>,
    ) -> Result<(), String> {
        let stop_source = normalize_stop_source(source);
        let stop_status = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?
            .get(runtime_id)
            .map(|record| record.status.clone())
            .unwrap_or_else(|| "missing_record".to_string());
        let stop_handle_generation = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .map(|handle| handle.generation.to_string())
            .unwrap_or_else(|| "none".to_string());
        let browser_identity = self.browser_identity_for_runtime(runtime_id);
        // Fence new Browser handoffs before retiring the existing grant. Without this state
        // transition, a concurrent UI handoff could resolve the actor after retirement selection
        // and recreate Agent ownership while the native conversation is stopping.
        let stop_fence_error = self
            .update_record(runtime_id, |record| {
                record.status = "stopping".to_string();
                record.is_active = false;
                record.updated_at = Utc::now();
            })
            .err();
        let mut browser_retirement_errors = Vec::new();
        if let Some(error) = stop_fence_error {
            browser_retirement_errors.push(format!(
                "failed to persist native Browser handoff stop fence: {error}"
            ));
        }
        match browser_identity {
            Ok((workspace_dir, browser_actor_id)) => {
                if let Err(error) =
                    retire_login_browser_agent_control(app, &workspace_dir, &browser_actor_id)
                {
                    browser_retirement_errors.push(format!(
                        "failed to retire Login Browser Agent control: {error}"
                    ));
                }
            }
            Err(error) => browser_retirement_errors.push(error),
        }
        if let Err(error) = retire_browser_agent_control(Some(app), runtime_id) {
            browser_retirement_errors.push(format!(
                "failed to retire Preview Browser Agent control: {error}"
            ));
        }
        self.append_event(
            runtime_id,
            SessionEventPayload::SessionCompleted {
                reason: "Stopped from desktop workspace.".to_string(),
            },
        )?;
        self.append_lifecycle_event(
            runtime_id,
            "stop_requested",
            format!(
                "Desktop workspace requested native runtime stop. source={stop_source} status={stop_status} handle_generation={stop_handle_generation}"
            ),
        )?;
        if let Some(handle) = self.request_child_stop(runtime_id)? {
            // Graceful stop — the helper aborts the current turn and stays alive.
            // Mark as interrupted so the frontend re-enables the composer for continued use.
            self.update_record(runtime_id, |record| {
                record.status = "interrupted".to_string();
                record.is_active = false;
                record.updated_at = Utc::now();
            })?;
            self.schedule_force_kill(runtime_id.to_string(), handle);
        } else {
            // Hard stop — the child process was already gone.
            self.update_record(runtime_id, |record| {
                record.status = "stopped".to_string();
                record.is_active = false;
                record.updated_at = Utc::now();
            })?;
            self.kill_current_child_confirmed(
                runtime_id,
                NATIVE_PERMISSION_QUARANTINE_KILL_TIMEOUT,
            )?;
        }
        if browser_retirement_errors.is_empty() {
            Ok(())
        } else {
            Err(browser_retirement_errors.join("; "))
        }
    }

    pub fn reconcile_stale_records(&self) -> Result<usize, String> {
        let live_runtime_ids = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .keys()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        let mut changed = 0;
        let now = Utc::now();

        let mut records = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?;

        for record in records.values_mut() {
            if live_runtime_ids.contains(&record.runtime_id) {
                continue;
            }
            if !record.is_active || is_native_terminal_status(&record.status) {
                continue;
            }

            if record.status == "idle" {
                record.is_active = false;
                record.updated_at = now;
                changed += 1;
                continue;
            }

            record.status = "interrupted".to_string();
            record.is_active = false;
            record.updated_at = now;
            if record.last_error.is_none() {
                record.last_error = Some(
                    "Native runtime was interrupted because the desktop app restarted.".to_string(),
                );
            }
            changed += 1;
        }

        if changed > 0 {
            persist_native_runtime_state_to(&self.state_path, records.values().cloned().collect())?;
        }

        Ok(changed)
    }

    pub fn handoff_to_terminal(
        &self,
        runtime_id: &str,
        terminal_type: Option<TerminalType>,
    ) -> Result<NativeHandoffResult, String> {
        if !terminal::external_terminal_launch_supported() {
            return Err(
                "Terminal handoff is not available on this platform; continue in the native workspace runtime.".to_string(),
            );
        }

        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned();

        let record = if let Some(handle) = handle.as_ref() {
            handle
                .record
                .lock()
                .map_err(|_| "Failed to lock native session record".to_string())?
                .clone()
        } else {
            self.records
                .lock()
                .map_err(|_| "Failed to lock native runtime records".to_string())?
                .get(runtime_id)
                .cloned()
                .ok_or_else(|| format!("Native runtime {} not found", runtime_id))?
        };

        let terminal = terminal_type.unwrap_or_else(terminal::get_preferred_terminal);
        self.append_lifecycle_event(
            runtime_id,
            "handoff_requested",
            format!(
                "Terminal handoff requested for {} in {}.",
                record.provider.as_str(),
                terminal.display_name()
            ),
        )?;

        if record.provider_session_id.is_some() {
            self.complete_terminal_handoff(record, terminal)?;
            return Ok(NativeHandoffResult {
                status: NativeHandoffStatus::Opened,
            });
        }

        self.update_record(runtime_id, |entry| {
            entry.status = "handoff_pending".to_string();
            entry.is_active = true;
            entry.updated_at = Utc::now();
            entry.can_handoff_to_terminal = true;
            entry.pending_handoff_terminal = Some(terminal);
            entry.last_error = None;
        })?;
        self.append_event(
            runtime_id,
            SessionEventPayload::Lifecycle {
                stage: "handoff_pending".to_string(),
                detail: format!(
                    "Terminal handoff will open in {} when the provider session id is ready.",
                    terminal.display_name()
                ),
            },
        )?;
        Ok(NativeHandoffResult {
            status: NativeHandoffStatus::Pending,
        })
    }

    pub fn prepare_terminal_handoff(
        &self,
        runtime_id: &str,
        terminal_type: Option<TerminalType>,
    ) -> Result<NativeTerminalHandoff, String> {
        if !terminal::external_terminal_launch_supported() {
            return Err(
                "Terminal handoff is not available on this platform; continue in the native workspace runtime.".to_string(),
            );
        }

        let terminal = terminal_type.unwrap_or_else(terminal::get_preferred_terminal);
        let record = self.current_record(runtime_id)?;
        let resume_session_id = record
            .provider_session_id
            .clone()
            .ok_or_else(|| "Session id is not ready for terminal handoff yet".to_string())?;
        let mut env_vars = self.terminal_env_vars_for_record(&record)?;
        inject_ccem_runtime_env(&mut env_vars, &record.runtime_id);

        Ok(NativeTerminalHandoff {
            runtime_id: record.runtime_id.clone(),
            provider: record.provider,
            env_name: record.env_name.clone(),
            perm_mode: effective_native_perm_mode(
                record.perm_mode.as_str(),
                record.runtime_perm_mode.as_deref(),
            )
            .to_string(),
            project_dir: record.project_dir.clone(),
            resume_session_id,
            terminal,
            env_vars,
        })
    }

    pub fn complete_managed_terminal_handoff(
        &self,
        runtime_id: &str,
        terminal: TerminalType,
    ) -> Result<(), String> {
        let record = self.current_record(runtime_id)?;
        self.update_record(runtime_id, |entry| {
            entry.status = "handoff".to_string();
            entry.is_active = false;
            entry.updated_at = Utc::now();
            entry.can_handoff_to_terminal = true;
            entry.pending_handoff_terminal = None;
        })?;
        self.append_event(
            runtime_id,
            SessionEventPayload::Lifecycle {
                stage: "handoff".to_string(),
                detail: format!(
                    "Opened {} session in {}.",
                    record.provider.as_str(),
                    terminal.display_name()
                ),
            },
        )?;
        self.kill_current_child_confirmed(runtime_id, NATIVE_PERMISSION_QUARANTINE_KILL_TIMEOUT)?;
        Ok(())
    }

    fn current_record(&self, runtime_id: &str) -> Result<NativeSessionRecord, String> {
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned();

        if let Some(handle) = handle {
            return handle
                .record
                .lock()
                .map_err(|_| "Failed to lock native session record".to_string())
                .map(|record| record.clone());
        }

        self.records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?
            .get(runtime_id)
            .cloned()
            .ok_or_else(|| format!("Native runtime {} not found", runtime_id))
    }

    fn terminal_env_vars_for_record(
        &self,
        record: &NativeSessionRecord,
    ) -> Result<HashMap<String, String>, String> {
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(&record.runtime_id)
            .cloned();

        if let Some(handle) = handle {
            return Ok(handle.terminal_env_vars.clone());
        }

        build_runtime_bootstrap_options(record).map(|options| options.terminal_env_vars)
    }

    fn complete_terminal_handoff(
        &self,
        record: NativeSessionRecord,
        terminal: TerminalType,
    ) -> Result<(), String> {
        let runtime_id = record.runtime_id.clone();
        let provider_session_id = record
            .provider_session_id
            .clone()
            .ok_or_else(|| "Session id is not ready for terminal handoff yet".to_string())?;

        let mut env_vars = self.terminal_env_vars_for_record(&record)?;
        inject_ccem_runtime_env(&mut env_vars, &runtime_id);

        if let Err(error) = launch_terminal_for_native_handoff(
            terminal,
            env_vars,
            &record.project_dir,
            &runtime_id,
            &record.env_name,
            Some(effective_native_perm_mode(
                record.perm_mode.as_str(),
                record.runtime_perm_mode.as_deref(),
            )),
            Some(provider_session_id.as_str()),
            record.provider.as_str(),
        ) {
            let _ = self.append_lifecycle_event(
                &runtime_id,
                "handoff_failed",
                format!(
                    "Failed to open {} session in {}: {}",
                    record.provider.as_str(),
                    terminal.display_name(),
                    error
                ),
            );
            return Err(error);
        }

        self.update_record(&runtime_id, |entry| {
            entry.status = "handoff".to_string();
            entry.is_active = false;
            entry.updated_at = Utc::now();
            entry.can_handoff_to_terminal = true;
            entry.pending_handoff_terminal = None;
        })?;
        self.append_event(
            &runtime_id,
            SessionEventPayload::Lifecycle {
                stage: "handoff".to_string(),
                detail: format!(
                    "Opened {} session in {}.",
                    record.provider.as_str(),
                    terminal.display_name()
                ),
            },
        )?;
        self.kill_current_child_confirmed(&runtime_id, NATIVE_PERMISSION_QUARANTINE_KILL_TIMEOUT)?;
        Ok(())
    }

    fn ensure_handle(
        self: &Arc<Self>,
        app: AppHandle,
        runtime_id: &str,
    ) -> Result<Arc<NativeSessionHandle>, String> {
        let transaction = self.lifecycle_transaction_lock(runtime_id)?;
        let _transaction = transaction
            .lock()
            .map_err(|_| "Failed to lock native helper lifecycle".to_string())?;
        self.ensure_handle_locked(app, runtime_id)
    }

    fn ensure_handle_locked(
        self: &Arc<Self>,
        app: AppHandle,
        runtime_id: &str,
    ) -> Result<Arc<NativeSessionHandle>, String> {
        if self.is_permission_quarantine_fenced(runtime_id) {
            return Err(format!(
                "Native runtime {runtime_id} is quarantined after an incomplete permission update."
            ));
        }
        if let Some(handle) = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned()
        {
            let durable_quarantine = handle
                .record
                .lock()
                .map_err(|_| "Failed to lock native session record".to_string())?
                .permission_quarantined;
            if durable_quarantine || handle.permission_quarantined.load(Ordering::SeqCst) {
                return Err(format!(
                    "Native runtime {runtime_id} is quarantined after an incomplete permission update."
                ));
            }
            return Ok(handle);
        }

        let mut record = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?
            .get(runtime_id)
            .cloned()
            .ok_or_else(|| format!("Native runtime {} not found", runtime_id))?;
        if record.permission_quarantined {
            return Err(format!(
                "Native runtime {runtime_id} is quarantined after an incomplete permission update."
            ));
        }
        if matches!(record.status.as_str(), "stopped" | "handoff") {
            return Err(format!(
                "Native runtime {runtime_id} cannot reconnect from terminal status {}.",
                record.status
            ));
        }

        if reactivate_record_for_reconnect(&mut record) {
            let reactivated = record.clone();
            self.update_record(runtime_id, |stored| {
                *stored = reactivated.clone();
            })?;
        }

        let options = build_runtime_bootstrap_options(&record)?;

        let start_seq = self
            .event_log
            .newest_seq(runtime_id)
            .unwrap_or(None)
            .map(|seq| seq + 1)
            .unwrap_or(1);

        let handle = Arc::new(NativeSessionHandle {
            generation: self.allocate_handle_generation(),
            record: Mutex::new(record.clone()),
            browser_permission: BrowserPermissionAuthority::new(effective_native_perm_mode(
                record.perm_mode.as_str(),
                record.runtime_perm_mode.as_deref(),
            )),
            browser_permission_sync: Mutex::new(()),
            launcher_pid: AtomicU32::new(0),
            launcher_birth_token: AtomicU64::new(0),
            writer: Mutex::new(None),
            events: Mutex::new(SessionStore::with_start_seq(
                runtime_id.to_string(),
                start_seq,
            )),
            settings_update_acks: SettingsUpdateAckRegistry::default(),
            helper_env_vars: options.helper_env_vars.clone(),
            terminal_env_vars: options.terminal_env_vars.clone(),
            claude_path: options.claude_path.clone(),
            codex_path: options.codex_path.clone(),
            codex_base_url: options.codex_base_url.clone(),
            codex_api_key: options.codex_api_key.clone(),
            permission_quarantined: AtomicBool::new(record.permission_quarantined),
            alive: AtomicBool::new(true),
        });

        self.insert_handle(runtime_id.to_string(), handle.clone())?;
        self.append_event(
            runtime_id,
            SessionEventPayload::Lifecycle {
                stage: "runtime_resume".to_string(),
                detail: format!(
                    "Reconnected native runtime helper with generation {}.",
                    handle.generation
                ),
            },
        )?;
        self.spawn_helper(app, runtime_id, &options, handle.clone())?;
        Ok(handle)
    }

    fn spawn_helper(
        self: &Arc<Self>,
        app: AppHandle,
        runtime_id: &str,
        options: &NativeSessionOptions,
        handle: Arc<NativeSessionHandle>,
    ) -> Result<(), String> {
        if self.is_permission_quarantine_fenced(runtime_id) {
            self.fence_permission_quarantine_handle(runtime_id, &handle);
            return Err(format!(
                "Native runtime {runtime_id} is quarantined after an incomplete permission update."
            ));
        }
        let todo_snapshot_seed = self.event_log.latest_todo_snapshot(runtime_id)?;
        let helper_path = native_helper_script_path(&app)?;
        let launcher = std::env::current_exe()
            .map_err(|error| format!("Failed to resolve native helper launcher: {error}"))?;
        let command = app
            .shell()
            .command(launcher)
            .arg(NATIVE_HELPER_LAUNCHER_ARG)
            .arg(helper_path.to_string_lossy().to_string())
            .arg(std::process::id().to_string())
            .current_dir(&options.working_dir);

        let (mut rx, child) = match command.spawn() {
            Ok(spawned) => spawned,
            Err(error) => {
                let _ = self.remove_handle_if_current(runtime_id, &handle);
                return Err(format!("Failed to spawn native runtime sidecar: {error}"));
            }
        };
        let launcher_pid = child.pid();

        let launcher_birth_token =
            match self.verify_native_helper_ownership(runtime_id, &handle, launcher_pid) {
                Ok(token) => token,
                Err(error) => {
                    return self.fail_unverified_helper_launch(
                        runtime_id,
                        &handle,
                        launcher_pid,
                        error,
                    )
                }
            };
        handle.launcher_pid.store(launcher_pid, Ordering::Release);
        handle
            .launcher_birth_token
            .store(launcher_birth_token, Ordering::Release);
        if self.is_permission_quarantine_fenced(runtime_id) {
            return self.fail_unverified_helper_launch(
                runtime_id,
                &handle,
                launcher_pid,
                format!(
                    "Native runtime {runtime_id} was quarantined during helper launch verification."
                ),
            );
        }
        let writer = match NativeHelperWriter::spawn(child) {
            Ok(writer) => writer,
            Err(error) => {
                return self.fail_unverified_helper_launch(runtime_id, &handle, launcher_pid, error)
            }
        };
        let mut writer_slot = match handle.writer.lock() {
            Ok(slot) => slot,
            Err(_) => {
                return self.fail_unverified_helper_launch(
                    runtime_id,
                    &handle,
                    launcher_pid,
                    "Failed to lock native helper writer".to_string(),
                )
            }
        };
        *writer_slot = Some(writer);
        drop(writer_slot);

        if self.is_permission_quarantine_fenced(runtime_id) {
            return self.fail_unverified_helper_launch(
                runtime_id,
                &handle,
                launcher_pid,
                format!(
                    "Native runtime {runtime_id} was quarantined before helper initialization."
                ),
            );
        }

        if let Err(write_error) = self.write_to_child(
            &handle,
            &HelperInputCommand::Init {
                provider: options.provider.as_str(),
                env_name: &options.env_name,
                perm_mode: effective_native_perm_mode(
                    options.perm_mode.as_str(),
                    options.runtime_perm_mode.as_deref(),
                ),
                allow_dangerously_skip_permissions:
                    native_session_allows_dangerously_skip_permissions(options),
                working_dir: &options.working_dir,
                env_vars: &handle.helper_env_vars,
                initial_prompt: options.initial_prompt.as_deref(),
                initial_images: options.initial_images.as_deref(),
                provider_session_id: options.provider_session_id.as_deref(),
                claude_path: handle.claude_path.as_deref(),
                codex_path: handle.codex_path.as_deref(),
                codex_base_url: handle.codex_base_url.as_deref(),
                codex_api_key: handle.codex_api_key.as_deref(),
                effort: options.effort.as_deref(),
                todo_snapshot_seed: todo_snapshot_seed.as_ref(),
            },
        ) {
            return self.fail_unverified_helper_launch(
                runtime_id,
                &handle,
                launcher_pid,
                write_error,
            );
        }

        let manager = self.clone();
        let runtime = runtime_id.to_string();
        let event_handle = handle.clone();
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut stdout_buffer = Vec::new();
            let mut stderr_buffer = Vec::new();
            while let Some(event) = rx.recv().await {
                if !manager
                    .is_current_handle(&runtime, &event_handle)
                    .unwrap_or(false)
                {
                    break;
                }

                match event {
                    CommandEvent::Stdout(line) => {
                        for text in drain_helper_output_lines(&mut stdout_buffer, &line) {
                            if let Err(error) = manager.process_helper_stdout_with_app(
                                Some(&app_handle),
                                &runtime,
                                &text,
                            ) {
                                let _ = manager.append_event(
                                    &runtime,
                                    SessionEventPayload::StdErrLine {
                                        line: format!("Failed to process helper output: {}", error),
                                    },
                                );
                            }
                        }
                    }
                    CommandEvent::Stderr(line) => {
                        for text in drain_helper_output_lines(&mut stderr_buffer, &line) {
                            let _ = manager.append_event(
                                &runtime,
                                SessionEventPayload::StdErrLine { line: text },
                            );
                        }
                    }
                    CommandEvent::Error(error) => {
                        manager.flush_helper_output_buffers(
                            Some(&app_handle),
                            &runtime,
                            &mut stdout_buffer,
                            &mut stderr_buffer,
                        );
                        let _ = manager.append_event(
                            &runtime,
                            SessionEventPayload::StdErrLine {
                                line: format!("Native sidecar error: {}", error),
                            },
                        );
                        let _ = manager.mark_process_exit(&runtime, Some(1), &event_handle);
                        break;
                    }
                    CommandEvent::Terminated(payload) => {
                        manager.flush_helper_output_buffers(
                            Some(&app_handle),
                            &runtime,
                            &mut stdout_buffer,
                            &mut stderr_buffer,
                        );
                        let _ = manager.mark_process_exit(&runtime, payload.code, &event_handle);
                        break;
                    }
                    _ => {}
                }
            }
        });

        Ok(())
    }

    fn fail_unverified_helper_launch(
        &self,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
        launcher_pid: u32,
        primary_error: String,
    ) -> Result<(), String> {
        let preserve_existing_fence = self.is_permission_quarantine_fenced(runtime_id);
        self.fence_permission_quarantine(runtime_id);
        handle.launcher_pid.store(launcher_pid, Ordering::Release);
        handle.permission_quarantined.store(true, Ordering::SeqCst);
        handle.alive.store(false, Ordering::SeqCst);
        let birth_token = handle.launcher_birth_token.load(Ordering::Acquire);
        let cleanup = if birth_token == 0 {
            terminate_unverified_native_helper(
                launcher_pid,
                NATIVE_PERMISSION_QUARANTINE_KILL_TIMEOUT,
            )
        } else {
            terminate_verified_native_helper(
                launcher_pid,
                birth_token,
                NATIVE_PERMISSION_QUARANTINE_KILL_TIMEOUT,
            )
        };
        match cleanup {
            Ok(()) => {
                self.remove_handle_if_current(runtime_id, handle)
                    .map_err(|cleanup_error| {
                        format!(
                            "{primary_error}; unverified helper terminated but handle cleanup failed: {cleanup_error}"
                        )
                    })?;
                if !preserve_existing_fence {
                    self.clear_permission_quarantine_fence(runtime_id);
                }
                Err(primary_error)
            }
            Err(cleanup_error) => {
                let persistence = self.update_record(runtime_id, |record| {
                    record.perm_mode = "readonly".to_string();
                    record.runtime_perm_mode = None;
                    record.permission_quarantined = true;
                    record.status = "permission_quarantined".to_string();
                    record.is_active = false;
                    record.last_error = Some(
                        "Native helper ownership could not be verified or safely terminated."
                            .to_string(),
                    );
                    record.updated_at = Utc::now();
                });
                match persistence {
                    Ok(()) => Err(format!(
                        "{primary_error}; failed to confirm unverified helper cleanup: {cleanup_error}; durable quarantine persisted"
                    )),
                    Err(persist_error) => Err(format!(
                        "{primary_error}; failed to confirm unverified helper cleanup: {cleanup_error}; failed to persist durable quarantine: {persist_error}"
                    )),
                }
            }
        }
    }

    fn verify_native_helper_ownership(
        &self,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
        pid: u32,
    ) -> Result<u64, String> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if !self.is_current_handle(runtime_id, handle)? {
                return Err("Native helper owner changed during launch verification.".to_string());
            }
            #[cfg(unix)]
            {
                // SAFETY: `pid` is the exact still-owned launcher process.
                let pgid = unsafe { libc::getpgid(pid as i32) };
                if pgid == pid as i32 && native_helper_process_exists(pid)? {
                    return native_helper_process_birth_token(pid)?.ok_or_else(|| {
                        "Native helper launcher exited during ownership verification.".to_string()
                    });
                }
                if pgid == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                    return Err(
                        "Native helper launcher exited before ownership verification.".to_string(),
                    );
                }
            }
            #[cfg(windows)]
            if native_helper_process_exists(pid)? {
                return native_helper_process_creation_ticks(pid)?.ok_or_else(|| {
                    "Native helper launcher exited during ownership verification.".to_string()
                });
            } else {
                return Err(
                    "Native helper launcher exited before ownership verification.".to_string(),
                );
            }
            if Instant::now() >= deadline {
                #[cfg(unix)]
                {
                    // Try the group first, then the exact launcher if it never established one.
                    let _ = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
                    let _ = unsafe { libc::kill(pid as i32, libc::SIGKILL) };
                }
                #[cfg(windows)]
                let _ = signal_native_helper_termination(pid);
                return Err(
                    "Native helper launcher did not establish a verified ownership domain."
                        .to_string(),
                );
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn process_helper_stdout(&self, runtime_id: &str, line: &str) -> Result<(), String> {
        self.process_helper_stdout_with_app(None, runtime_id, line)
    }

    fn process_helper_stdout_with_app(
        &self,
        app: Option<&AppHandle>,
        runtime_id: &str,
        line: &str,
    ) -> Result<(), String> {
        let mut processed = false;
        for entry in line
            .lines()
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
        {
            processed = true;
            self.process_helper_stdout_line(app, runtime_id, entry)?;
        }
        if !processed {
            return Ok(());
        }
        Ok(())
    }

    fn process_helper_stdout_line(
        &self,
        app: Option<&AppHandle>,
        runtime_id: &str,
        line: &str,
    ) -> Result<(), String> {
        let output: HelperOutputEvent = serde_json::from_str(line)
            .map_err(|error| format!("Failed to parse helper event JSON: {}", error))?;

        match output {
            HelperOutputEvent::SessionMeta {
                provider_session_id,
            } => {
                let (provider, pending_handoff_terminal, provider_session_id) =
                    self.bind_provider_session_lineage(app, runtime_id, &provider_session_id)?;

                if let Err(error) =
                    bind_source_session_id(provider.as_str(), runtime_id, &provider_session_id)
                {
                    eprintln!(
                        "Failed to bind native runtime {} to provider session {}: {}",
                        runtime_id, provider_session_id, error
                    );
                }

                if let Some(terminal) = pending_handoff_terminal {
                    let record = self
                        .records
                        .lock()
                        .map_err(|_| "Failed to lock native runtime records".to_string())?
                        .get(runtime_id)
                        .cloned()
                        .ok_or_else(|| format!("Native runtime {} not found", runtime_id))?;
                    match self.complete_terminal_handoff(record, terminal) {
                        Ok(()) => {}
                        Err(error) => {
                            self.update_record(runtime_id, |record| {
                                record.status = "ready".to_string();
                                record.is_active = true;
                                record.updated_at = Utc::now();
                                record.pending_handoff_terminal = None;
                                record.last_error = Some(error.clone());
                            })?;
                            self.append_event(
                                runtime_id,
                                SessionEventPayload::StdErrLine {
                                    line: format!("Terminal handoff failed: {}", error),
                                },
                            )?;
                        }
                    }
                }

                Ok(())
            }
            HelperOutputEvent::Status { status, detail } => {
                let normalized_detail = detail
                    .as_ref()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());
                let mut applied = false;
                let mut next_status = status.clone();
                self.update_record(runtime_id, |record| {
                    if status == "error"
                        && is_recoverable_native_helper_error(record, normalized_detail.as_deref())
                    {
                        next_status = "interrupted".to_string();
                    }
                    if record.status == "error" && !is_native_terminal_status(&next_status) {
                        return;
                    }
                    applied = true;
                    record.status = next_status.clone();
                    record.is_active = !is_native_terminal_status(&next_status);
                    record.updated_at = Utc::now();
                    if status == "error" {
                        record.last_error = normalized_detail.clone().or_else(|| {
                            Some("Native runtime helper reported an error.".to_string())
                        });
                    } else if matches!(
                        next_status.as_str(),
                        "ready" | "processing" | "initializing"
                    ) {
                        record.last_error = None;
                    }
                })?;
                if !applied {
                    return Ok(());
                }
                if let Some(detail) = normalized_detail {
                    self.append_event(
                        runtime_id,
                        SessionEventPayload::Lifecycle {
                            stage: next_status,
                            detail,
                        },
                    )?;
                }
                if status == "error" {
                    let _ = self.kill_child(runtime_id);
                }
                Ok(())
            }
            HelperOutputEvent::Event { payload } => {
                let payload = serde_json::from_value::<SessionEventPayload>(payload)
                    .map_err(|error| format!("Failed to decode helper payload: {}", error))?;
                self.append_event(runtime_id, payload)
            }
            HelperOutputEvent::BrowserToolRequest {
                request_id,
                tool,
                args,
            } => self.handle_browser_tool_request(
                app,
                runtime_id,
                BrowserToolRequest {
                    request_id,
                    tool,
                    args,
                },
            ),
            HelperOutputEvent::SettingsUpdateResult {
                request_id,
                outcome,
                detail,
            } => {
                if !is_valid_settings_update_request_id(&request_id) {
                    return Err(
                        "Helper returned an invalid settings update request id.".to_string()
                    );
                }
                let handle = self
                    .handles
                    .lock()
                    .map_err(|_| "Failed to lock native runtime handles".to_string())?
                    .get(runtime_id)
                    .cloned()
                    .ok_or_else(|| {
                        format!("Native runtime {runtime_id} helper is not connected")
                    })?;
                let _ = handle
                    .settings_update_acks
                    .resolve(&request_id, SettingsUpdateAck { outcome, detail })?;
                Ok(())
            }
        }
    }

    fn handle_browser_tool_request(
        &self,
        app: Option<&AppHandle>,
        runtime_id: &str,
        request: BrowserToolRequest,
    ) -> Result<(), String> {
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned()
            .ok_or_else(|| format!("Native runtime {} helper is not connected", runtime_id))?;
        if handle.permission_quarantined.load(Ordering::SeqCst) {
            return Err(
                "Native runtime helper is quarantined after an incomplete permission update."
                    .to_string(),
            );
        }

        let response = match app {
            Some(app) => {
                let prepared = {
                    let _sync = handle.browser_permission_sync.lock().map_err(|_| {
                        "Failed to lock native browser permission authority".to_string()
                    })?;
                    if handle.permission_quarantined.load(Ordering::SeqCst) {
                        return Err(
                            "Native runtime helper is quarantined after an incomplete permission update."
                                .to_string(),
                        );
                    }
                    let authority = handle.browser_permission.current_ticket().map_err(|_| {
                        "Native browser permission authority is unavailable".to_string()
                    })?;
                    let (workspace_dir, browser_actor_id) = {
                        let record = handle
                            .record
                            .lock()
                            .map_err(|_| "Failed to lock native session record".to_string())?;
                        let recorded_mode = effective_native_perm_mode(
                            record.perm_mode.as_str(),
                            record.runtime_perm_mode.as_deref(),
                        );
                        if recorded_mode != authority.mode() {
                            return Err(
                                "Native browser permission authority is out of sync.".to_string()
                            );
                        }
                        if !is_valid_browser_actor_id(&record.browser_actor_id) {
                            return Err("Native browser actor lineage is unavailable.".to_string());
                        }
                        (record.project_dir.clone(), record.browser_actor_id.clone())
                    };
                    let authorization = authorize_browser_tool(authority.mode(), &request.tool);
                    let login = app
                        .try_state::<Arc<crate::browser::login::session::LoginBrowserSessionManager>>()
                        .map(|state| Arc::clone(&state));
                    let login_prepared = login
                        .as_ref()
                        .map(|login| {
                            login.prepare_agent_tool_if_handed_off(
                                &workspace_dir,
                                &browser_actor_id,
                                authority.clone(),
                                &request,
                            )
                        })
                        .transpose()?;
                    Ok::<_, String>((
                        workspace_dir,
                        browser_actor_id,
                        authority,
                        authorization,
                        login.zip(login_prepared.flatten()),
                    ))
                };
                match prepared {
                    Ok((_, _, _, _, Some((login, prepared)))) => {
                        login.execute_prepared_agent_tool(&request, prepared)
                    }
                    Ok((workspace_dir, _, authority, authorization, None)) => {
                        match app.try_state::<Arc<BrowserManager>>() {
                            Some(browser) => {
                                if authority.validate_current().is_err() {
                                    Err("Browser permission changed before execution.".to_string())
                                } else {
                                    let audit = browser.audit_policy_decision(
                                        &workspace_dir,
                                        runtime_id,
                                        authority.mode(),
                                        &request,
                                        authorization.is_ok(),
                                        authorization.as_ref().err().map(String::as_str),
                                    );
                                    match authorization {
                                        Ok(()) => audit.and_then(|_| {
                                            browser.run_tool_with_permission(
                                                app,
                                                runtime_id,
                                                &workspace_dir,
                                                &request,
                                                &authority,
                                            )
                                        }),
                                        Err(policy_error) => {
                                            if let Err(audit_error) = audit {
                                                eprintln!(
                                                "Failed to append denied preview browser audit: {audit_error}"
                                            );
                                            }
                                            Err(policy_error)
                                        }
                                    }
                                }
                            }
                            None => Err("Browser manager is not registered.".to_string()),
                        }
                    }
                    Err(error) => Err(error),
                }
            }
            None => Err("Browser tool request requires an app handle.".to_string()),
        };

        match response {
            Ok(result) => self.write_to_child(
                &handle,
                &HelperInputCommand::BrowserToolResponse {
                    request_id: &request.request_id,
                    ok: true,
                    result: Some(&result),
                    error: None,
                },
            ),
            Err(error) => self.write_to_child(
                &handle,
                &HelperInputCommand::BrowserToolResponse {
                    request_id: &request.request_id,
                    ok: false,
                    result: None,
                    error: Some(&error),
                },
            ),
        }
    }

    fn mark_process_exit(
        &self,
        runtime_id: &str,
        exit_code: Option<i32>,
        handle: &Arc<NativeSessionHandle>,
    ) -> Result<(), String> {
        let lifecycle = self.lifecycle_transaction_lock(runtime_id)?;
        let _lifecycle = lifecycle
            .lock()
            .map_err(|_| "Failed to lock native helper lifecycle".to_string())?;
        if !self.is_current_handle(runtime_id, handle)? {
            return Ok(());
        }

        let expected_terminal = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?
            .get(runtime_id)
            .map(|record| is_native_terminal_status(&record.status))
            .unwrap_or(false);

        if !expected_terminal {
            let exit_reason = format!(
                "Native runtime sidecar exited unexpectedly{}.",
                exit_code
                    .map(|code| format!(" with code {}", code))
                    .unwrap_or_default()
            );
            self.update_record(runtime_id, |record| {
                let recoverable = is_recoverable_native_process_exit(record);
                record.status = if recoverable { "interrupted" } else { "error" }.to_string();
                record.is_active = false;
                record.pending_handoff_terminal = None;
                record.can_handoff_to_terminal =
                    recoverable && terminal::external_terminal_launch_supported();
                record.updated_at = Utc::now();
                if record.last_error.is_none() {
                    record.last_error = Some(exit_reason.clone());
                }
            })?;
            self.append_event(
                runtime_id,
                SessionEventPayload::SessionCompleted {
                    reason: exit_reason,
                },
            )?;
        }

        self.remove_handle_if_current(runtime_id, handle)
    }

    fn write_to_child(
        &self,
        handle: &Arc<NativeSessionHandle>,
        command: &HelperInputCommand<'_>,
    ) -> Result<(), String> {
        self.write_to_child_until(
            handle,
            command,
            Instant::now() + NATIVE_HELPER_WRITE_TIMEOUT,
        )
    }

    fn write_to_child_until(
        &self,
        handle: &Arc<NativeSessionHandle>,
        command: &HelperInputCommand<'_>,
        deadline: Instant,
    ) -> Result<(), String> {
        if handle.permission_quarantined.load(Ordering::SeqCst) {
            return Err(
                "Native runtime helper is quarantined after an incomplete permission update."
                    .to_string(),
            );
        }
        let mut line = serde_json::to_vec(command)
            .map_err(|error| format!("Failed to encode helper command: {}", error))?;
        line.push(b'\n');
        let writer = handle
            .writer
            .lock()
            .map_err(|_| "Failed to lock native helper writer".to_string())?
            .clone()
            .ok_or_else(|| "Native sidecar child is not available".to_string())?;
        if handle.permission_quarantined.load(Ordering::SeqCst) {
            return Err(
                "Native runtime helper is quarantined after an incomplete permission update."
                    .to_string(),
            );
        }
        writer.write_until(line, deadline)
    }

    fn write_to_child_with_reconnect(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        handle: Arc<NativeSessionHandle>,
        command: &HelperInputCommand<'_>,
    ) -> Result<(), String> {
        let transaction = self.lifecycle_transaction_lock(runtime_id)?;
        let _transaction = transaction
            .lock()
            .map_err(|_| "Failed to lock native helper lifecycle".to_string())?;
        self.write_to_child_with_reconnect_locked(app, runtime_id, handle, command)
    }

    fn write_to_child_with_reconnect_locked(
        self: &Arc<Self>,
        app: &AppHandle,
        runtime_id: &str,
        handle: Arc<NativeSessionHandle>,
        command: &HelperInputCommand<'_>,
    ) -> Result<(), String> {
        if !self.is_current_handle(runtime_id, &handle)? {
            return Err("Native runtime helper changed before command delivery.".to_string());
        }
        match self.write_to_child(&handle, command) {
            Ok(()) => Ok(()),
            Err(error) if is_retryable_native_child_write_error(&error) => {
                let _ = self.append_event(
                    runtime_id,
                    SessionEventPayload::Lifecycle {
                        stage: "runtime_resume".to_string(),
                        detail: format!(
                            "Restarting native runtime helper generation {} for {} after write failed: {}",
                            handle.generation,
                            helper_command_kind(command),
                            error
                        ),
                    },
                );
                self.kill_child_confirmed(
                    runtime_id,
                    &handle,
                    NATIVE_PERMISSION_QUARANTINE_KILL_TIMEOUT,
                )?;
                self.update_record(runtime_id, |record| {
                    record.status = "initializing".to_string();
                    record.is_active = true;
                    record.last_error = None;
                    record.updated_at = Utc::now();
                })?;
                let next_handle = self.ensure_handle_locked(app.clone(), runtime_id)?;
                self.write_to_child(&next_handle, command)
            }
            Err(error) if is_unknown_native_child_delivery_error(&error) => {
                let command_kind = helper_command_kind(command);
                self.fence_permission_quarantine_handle(runtime_id, &handle);
                let _ = self.append_event(
                    runtime_id,
                    SessionEventPayload::Lifecycle {
                        stage: "helper_delivery_unknown".to_string(),
                        detail: format!(
                            "Stopping native runtime helper generation {} after indeterminate {} delivery; the command will not be replayed automatically.",
                            handle.generation, command_kind
                        ),
                    },
                );
                if let Err(kill_error) = self.kill_child_confirmed(
                    runtime_id,
                    &handle,
                    NATIVE_PERMISSION_QUARANTINE_KILL_TIMEOUT,
                ) {
                    let persistence = self.update_record(runtime_id, |record| {
                        record.perm_mode = "readonly".to_string();
                        record.runtime_perm_mode = None;
                        record.permission_quarantined = true;
                        record.status = "permission_quarantined".to_string();
                        record.is_active = false;
                        record.last_error = Some(format!(
                            "Native {command_kind} delivery was indeterminate and the helper could not be safely terminated."
                        ));
                        record.updated_at = Utc::now();
                    });
                    return Err(match persistence {
                        Ok(()) => format!(
                            "{error}; native {command_kind} delivery is indeterminate; failed to terminate helper: {kill_error}; durable quarantine persisted"
                        ),
                        Err(persist_error) => format!(
                            "{error}; native {command_kind} delivery is indeterminate; failed to terminate helper: {kill_error}; failed to persist durable quarantine: {persist_error}"
                        ),
                    });
                }
                self.update_record(runtime_id, |record| {
                    record.status = if record.provider_session_id.is_some() {
                        "interrupted"
                    } else {
                        "error"
                    }
                    .to_string();
                    record.is_active = false;
                    record.last_error = Some(format!(
                        "Native {command_kind} delivery was indeterminate; it was not replayed automatically."
                    ));
                    record.updated_at = Utc::now();
                })?;
                self.clear_permission_quarantine_fence(runtime_id);
                Err(format!(
                    "{error}; native {command_kind} delivery is indeterminate and was not replayed"
                ))
            }
            Err(error) => Err(error),
        }
    }

    fn request_child_stop(
        &self,
        runtime_id: &str,
    ) -> Result<Option<Arc<NativeSessionHandle>>, String> {
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned();
        let Some(handle) = handle else {
            return Ok(None);
        };

        handle.alive.store(false, Ordering::SeqCst);
        let has_writer = handle
            .writer
            .lock()
            .map_err(|_| "Failed to lock native helper writer".to_string())?
            .is_some();
        if !has_writer || handle.launcher_pid.load(Ordering::Acquire) == 0 {
            return Ok(None);
        }

        match self.write_to_child(&handle, &HelperInputCommand::Stop) {
            Ok(()) => {
                self.append_lifecycle_event(
                    runtime_id,
                    "stop_written",
                    format!(
                        "Native helper generation {} accepted stop command.",
                        handle.generation
                    ),
                )?;
                Ok(Some(handle))
            }
            Err(error) => {
                let _ = self.append_event(
                    runtime_id,
                    SessionEventPayload::StdErrLine {
                        line: format!("Failed to request native helper stop: {}", error),
                    },
                );
                let _ = self.append_lifecycle_event(
                    runtime_id,
                    "stop_write_failed",
                    format!("Failed to write native helper stop command: {}", error),
                );
                Ok(None)
            }
        }
    }

    fn schedule_force_kill(self: &Arc<Self>, runtime_id: String, handle: Arc<NativeSessionHandle>) {
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn_blocking(move || {
            std::thread::sleep(NATIVE_STOP_GRACE_PERIOD);
            if let Err(error) = manager.force_kill_stopped_handle(&runtime_id, &handle) {
                let _ = manager.append_lifecycle_event(
                    &runtime_id,
                    "stop_force_kill_failed",
                    format!("Failed to confirm native helper termination: {error}"),
                );
                let _ = manager.set_last_error(
                    &runtime_id,
                    format!("Failed to confirm native helper termination: {error}"),
                );
            }
        });
    }

    fn force_kill_stopped_handle(
        &self,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
    ) -> Result<bool, String> {
        let lifecycle = self.lifecycle_transaction_lock(runtime_id)?;
        let _lifecycle = lifecycle
            .lock()
            .map_err(|_| "Failed to lock native helper lifecycle".to_string())?;
        {
            let handles = self
                .handles
                .lock()
                .map_err(|_| "Failed to lock native runtime handles".to_string())?;
            let Some(current) = handles.get(runtime_id) else {
                return Ok(false);
            };
            if !Self::same_handle(current, handle) || handle.alive.load(Ordering::SeqCst) {
                return Ok(false);
            }
        }

        self.kill_child_confirmed(
            runtime_id,
            handle,
            NATIVE_PERMISSION_QUARANTINE_KILL_TIMEOUT,
        )?;

        let detail = format!(
            "Native helper generation {} did not settle after stop; termination was confirmed before releasing its handle.",
            handle.generation
        );
        let event = handle
            .events
            .lock()
            .map_err(|_| "Failed to lock native session store".to_string())?
            .append(SessionEventPayload::Lifecycle {
                stage: "stop_force_killed".to_string(),
                detail,
            });
        if let Err(error) = self.event_log.append(&event) {
            eprintln!(
                "Failed to persist native event {}:{}: {}",
                event.runtime_id, event.seq, error
            );
        }

        self.update_record(runtime_id, |record| {
            record.status = "interrupted".to_string();
            record.is_active = false;
            record.updated_at = Utc::now();
        })?;
        Ok(true)
    }

    fn append_user_prompt_event(
        &self,
        runtime_id: &str,
        text: &str,
        images: Option<&Vec<PromptImage>>,
        annotations: Option<&Vec<SessionPromptAnnotation>>,
    ) -> Result<(), String> {
        let text = text.trim();
        let image_count = images.map(|items| items.len()).unwrap_or(0);
        let annotations = validate_prompt_annotations(annotations)?;
        if text.is_empty() && image_count == 0 && annotations.is_none() {
            return Ok(());
        }
        let event_images = prompt_images_for_event(images, &self.prompt_image_store)?;
        let canonical_hash =
            canonical_user_prompt_hash(text, event_images.as_ref(), annotations.as_ref());

        self.append_event(
            runtime_id,
            SessionEventPayload::UserPrompt {
                text: text.to_string(),
                image_count: image_count as u64,
                images: event_images,
                annotations,
                canonical_hash,
            },
        )
    }

    fn append_interactive_prompt_response_event(
        &self,
        runtime_id: &str,
        display_text: Option<&str>,
        answers: &HashMap<String, String>,
        annotations: Option<&Vec<SessionPromptAnnotation>>,
    ) -> Result<(), String> {
        let Some(text) = summarize_interactive_prompt_response(display_text, answers) else {
            return Ok(());
        };
        self.append_user_prompt_event(runtime_id, &text, None, annotations)
    }

    fn deliver_and_append_interactive_prompt_response(
        &self,
        runtime_id: &str,
        display_text: Option<&str>,
        answers: &HashMap<String, String>,
        annotations: Option<&Vec<SessionPromptAnnotation>>,
        deliver: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        deliver()?;
        self.append_interactive_prompt_response_event(
            runtime_id,
            display_text,
            answers,
            annotations,
        )
    }

    fn append_event(&self, runtime_id: &str, payload: SessionEventPayload) -> Result<(), String> {
        let last_error = payload_last_error(&payload);
        let handles = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?;
        let Some(handle) = handles.get(runtime_id) else {
            return Ok(());
        };
        {
            let mut store = handle
                .events
                .lock()
                .map_err(|_| "Failed to lock native session store".to_string())?;
            let record = store.append(payload);
            if let Err(error) = self.event_log.append(&record) {
                eprintln!(
                    "Failed to persist native event {}:{}: {}",
                    record.runtime_id, record.seq, error
                );
            }
        }
        drop(handles);
        if let Some(message) = last_error {
            self.set_last_error(runtime_id, message)?;
        }
        Ok(())
    }

    fn append_lifecycle_event(
        &self,
        runtime_id: &str,
        stage: &str,
        detail: impl Into<String>,
    ) -> Result<(), String> {
        self.append_event(
            runtime_id,
            SessionEventPayload::Lifecycle {
                stage: stage.to_string(),
                detail: detail.into(),
            },
        )
    }

    fn insert_record(
        &self,
        mut record: NativeSessionRecord,
    ) -> Result<NativeSessionRecord, String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?;
        {
            let known_lineages = records
                .values()
                .map(|known| BrowserActorLineageRef {
                    provider: known.provider,
                    provider_session_id: known.provider_session_id.as_deref(),
                    actor_id: &known.browser_actor_id,
                })
                .collect::<Vec<_>>();
            record.browser_actor_id = resolve_browser_actor_id(
                record.provider,
                record.provider_session_id.as_deref(),
                &record.browser_actor_id,
                &known_lineages,
            )?;
        }
        records.insert(record.runtime_id.clone(), record.clone());
        persist_native_runtime_state_to(&self.state_path, records.values().cloned().collect())?;
        Ok(record)
    }

    fn bind_provider_session_lineage(
        &self,
        app: Option<&AppHandle>,
        runtime_id: &str,
        provider_session_id: &str,
    ) -> Result<(NativeProvider, Option<TerminalType>, String), String> {
        self.bind_provider_session_lineage_with_retirement(
            runtime_id,
            provider_session_id,
            |workspace_dir, invalidated_actor_id| match app {
                Some(app) => {
                    retire_login_browser_agent_control(app, workspace_dir, invalidated_actor_id)
                }
                None => Ok(()),
            },
        )
    }

    fn bind_provider_session_lineage_with_retirement<Retire>(
        &self,
        runtime_id: &str,
        provider_session_id: &str,
        mut retire_invalidated_actor: Retire,
    ) -> Result<(NativeProvider, Option<TerminalType>, String), String>
    where
        Retire: FnMut(&str, &str) -> Result<(), String>,
    {
        let provider_session_id = normalize_provider_session_id(Some(provider_session_id))?
            .ok_or_else(|| "Native provider session identity is invalid.".to_string())?
            .to_string();
        let (updated, invalidated_actor, persistence) = {
            let mut records = self
                .records
                .lock()
                .map_err(|_| "Failed to lock native runtime records".to_string())?;
            let current = records
                .get(runtime_id)
                .cloned()
                .ok_or_else(|| format!("Native runtime {} not found", runtime_id))?;
            let known = records
                .iter()
                .filter(|(known_runtime_id, _)| known_runtime_id.as_str() != runtime_id)
                .map(|(_, record)| {
                    (
                        record.provider,
                        record.provider_session_id.clone(),
                        record.browser_actor_id.clone(),
                    )
                })
                .collect::<Vec<_>>();
            let known_refs = known
                .iter()
                .map(
                    |(provider, provider_session_id, actor_id)| BrowserActorLineageRef {
                        provider: *provider,
                        provider_session_id: provider_session_id.as_deref(),
                        actor_id,
                    },
                )
                .collect::<Vec<_>>();
            let resolved = resolve_browser_actor_id(
                current.provider,
                Some(&provider_session_id),
                &current.browser_actor_id,
                &known_refs,
            );
            let browser_actor_id = match resolved {
                Ok(actor_id) if actor_id == current.browser_actor_id => actor_id,
                // Rebinding to another actor after either runtime may already have read page data
                // could discard taint. Quarantine this late binder instead; future requests fail
                // closed and subsequent resumes also see the conflicting persisted lineage.
                Ok(_) | Err(_) => String::new(),
            };
            let invalidated_actor = (browser_actor_id.is_empty()
                && is_valid_browser_actor_id(&current.browser_actor_id))
            .then(|| {
                (
                    current.project_dir.clone(),
                    current.browser_actor_id.clone(),
                )
            });
            let record = records
                .get_mut(runtime_id)
                .ok_or_else(|| format!("Native runtime {} not found", runtime_id))?;
            record.provider_session_id = Some(provider_session_id.clone());
            record.browser_actor_id = browser_actor_id;
            record.can_handoff_to_terminal = terminal::external_terminal_launch_supported();
            record.updated_at = Utc::now();
            let updated = record.clone();
            let persistence = persist_native_runtime_state_to(
                &self.state_path,
                records.values().cloned().collect(),
            );
            (updated, invalidated_actor, persistence)
        };

        let handle = match self.handles.lock() {
            Ok(handles) => Ok(handles.get(runtime_id).cloned()),
            Err(_) => Err("Failed to lock native runtime handles".to_string()),
        };
        let handle_update = match handle {
            Ok(Some(handle)) => handle
                .record
                .lock()
                .map_err(|_| "Failed to lock native session record".to_string())
                .map(|mut record| *record = updated.clone()),
            Ok(None) => Ok(()),
            Err(error) => Err(error),
        };
        let retirement = invalidated_actor
            .as_ref()
            .map(|(workspace_dir, actor_id)| {
                retire_invalidated_actor(workspace_dir, actor_id).map_err(|error| {
                    format!(
                        "Native browser lineage was invalidated but its exact handoff retirement failed: {error}"
                    )
                })
            })
            .unwrap_or(Ok(()));
        let mut errors = Vec::new();
        for result in [persistence, handle_update, retirement] {
            if let Err(error) = result {
                errors.push(error);
            }
        }
        if !errors.is_empty() {
            return Err(errors.join("; "));
        }
        Ok((
            updated.provider,
            updated.pending_handoff_terminal,
            provider_session_id,
        ))
    }

    fn insert_handle(
        &self,
        runtime_id: String,
        handle: Arc<NativeSessionHandle>,
    ) -> Result<(), String> {
        if self.is_permission_quarantine_fenced(&runtime_id) {
            return Err(format!(
                "Native runtime {runtime_id} is quarantined after an incomplete permission update."
            ));
        }
        let mut handles = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?;
        if handles.contains_key(&runtime_id) {
            return Err(format!(
                "Native runtime {runtime_id} already has a live helper owner."
            ));
        }
        handles.insert(runtime_id, handle);
        Ok(())
    }

    #[cfg(test)]
    fn replace_handle_for_test(
        &self,
        runtime_id: String,
        handle: Arc<NativeSessionHandle>,
    ) -> Result<(), String> {
        self.handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .insert(runtime_id, handle);
        Ok(())
    }

    fn allocate_handle_generation(&self) -> u64 {
        self.next_handle_generation.fetch_add(1, Ordering::SeqCst)
    }

    fn same_handle(current: &Arc<NativeSessionHandle>, handle: &Arc<NativeSessionHandle>) -> bool {
        let same_generation = current.generation == handle.generation;
        if same_generation {
            debug_assert!(
                Arc::ptr_eq(current, handle),
                "native handle generation reused for a different Arc"
            );
        }
        same_generation && Arc::ptr_eq(current, handle)
    }

    fn mark_handle_live_if_current(
        &self,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
    ) -> Result<bool, String> {
        // A stopped handle may be claimed either by prompt delivery or by the delayed force-kill
        // path. Serialize the check-and-mark with that lifecycle transaction so force-kill cannot
        // validate `alive == false` and then remove the same handle after this method returns true.
        let lifecycle = self.lifecycle_transaction_lock(runtime_id)?;
        let _lifecycle = lifecycle
            .lock()
            .map_err(|_| "Failed to lock native helper lifecycle".to_string())?;
        if self.is_permission_quarantine_fenced(runtime_id) {
            return Ok(false);
        }
        let handles = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?;
        let is_current = handles
            .get(runtime_id)
            .map(|current| Self::same_handle(current, handle))
            .unwrap_or(false);
        if is_current && !handle.permission_quarantined.load(Ordering::SeqCst) {
            handle.alive.store(true, Ordering::SeqCst);
            return Ok(true);
        }
        Ok(false)
    }

    fn remove_handle_if_current(
        &self,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
    ) -> Result<(), String> {
        let mut handles = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?;
        let is_current = handles
            .get(runtime_id)
            .map(|current| Self::same_handle(current, handle))
            .unwrap_or(false);
        if is_current {
            handles.remove(runtime_id);
        }
        Ok(())
    }

    fn is_current_handle(
        &self,
        runtime_id: &str,
        handle: &Arc<NativeSessionHandle>,
    ) -> Result<bool, String> {
        Ok(self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .map(|current| Self::same_handle(current, handle))
            .unwrap_or(false))
    }

    fn kill_current_child_confirmed(
        &self,
        runtime_id: &str,
        timeout: Duration,
    ) -> Result<(), String> {
        let lifecycle = self.lifecycle_transaction_lock(runtime_id)?;
        let _lifecycle = lifecycle
            .lock()
            .map_err(|_| "Failed to lock native helper lifecycle".to_string())?;
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned();
        match handle {
            Some(handle) => self.kill_child_confirmed(runtime_id, &handle, timeout),
            None => Ok(()),
        }
    }

    fn kill_child_confirmed(
        &self,
        runtime_id: &str,
        expected: &Arc<NativeSessionHandle>,
        timeout: Duration,
    ) -> Result<(), String> {
        if !self.is_current_handle(runtime_id, expected)? {
            return Err(
                "Native runtime helper changed before termination could be confirmed.".to_string(),
            );
        }
        let pid = expected.launcher_pid.load(Ordering::Acquire);
        if pid == 0 {
            self.remove_handle_if_current(runtime_id, expected)?;
            return Ok(());
        }

        expected.alive.store(false, Ordering::SeqCst);
        terminate_verified_native_helper(
            pid,
            expected.launcher_birth_token.load(Ordering::Acquire),
            timeout,
        )?;
        let current = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned();
        match current {
            Some(current) if Self::same_handle(&current, expected) => {
                self.remove_handle_if_current(runtime_id, expected)
            }
            None => Ok(()),
            Some(_) => {
                Err("Native helper ownership changed before termination completed.".to_string())
            }
        }
    }

    fn kill_child(&self, runtime_id: &str) -> Result<(), String> {
        let lifecycle = self.lifecycle_transaction_lock(runtime_id)?;
        let _lifecycle = lifecycle
            .lock()
            .map_err(|_| "Failed to lock native helper lifecycle".to_string())?;
        let handle = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned();
        let Some(handle) = handle else {
            return Ok(());
        };
        handle.alive.store(false, Ordering::SeqCst);
        let pid = handle.launcher_pid.load(Ordering::Acquire);
        if pid == 0 {
            Ok(())
        } else {
            terminate_verified_native_helper(
                pid,
                handle.launcher_birth_token.load(Ordering::Acquire),
                NATIVE_PERMISSION_QUARANTINE_KILL_TIMEOUT,
            )
        }
    }

    fn update_record<F>(&self, runtime_id: &str, update: F) -> Result<(), String>
    where
        F: FnOnce(&mut NativeSessionRecord),
    {
        let updated_record = {
            let mut records = self
                .records
                .lock()
                .map_err(|_| "Failed to lock native runtime records".to_string())?;
            let record = records
                .get_mut(runtime_id)
                .ok_or_else(|| format!("Native runtime {} not found", runtime_id))?;
            update(record);
            record.clone()
        };

        if let Some(handle) = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned()
        {
            if let Ok(mut record) = handle.record.lock() {
                *record = updated_record;
            }
        }

        let records = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?;
        persist_native_runtime_state_to(&self.state_path, records.values().cloned().collect())
    }

    fn set_last_error(&self, runtime_id: &str, message: String) -> Result<(), String> {
        self.update_record(runtime_id, |record| {
            record.last_error = Some(message);
            record.updated_at = Utc::now();
        })
    }

    fn has_record(&self, runtime_id: &str) -> Result<bool, String> {
        self.records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())
            .map(|records| records.contains_key(runtime_id))
    }

    fn browser_identity_for_runtime(&self, runtime_id: &str) -> Result<(String, String), String> {
        let records = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?;
        let record = records
            .get(runtime_id)
            .ok_or_else(|| format!("Native runtime {runtime_id} not found"))?;
        if !is_valid_browser_actor_id(&record.browser_actor_id) {
            return Err("Native browser actor lineage is unavailable.".to_string());
        }
        Ok((record.project_dir.clone(), record.browser_actor_id.clone()))
    }

    pub(crate) fn browser_actor_id_for_runtime(&self, runtime_id: &str) -> Result<String, String> {
        let quarantine_fences = self
            .permission_quarantine_fences
            .lock()
            .map_err(|_| "Failed to lock native runtime quarantine fences".to_string())?;
        if quarantine_fences.contains(runtime_id) {
            return Err(format!(
                "Native runtime {runtime_id} is quarantined after an incomplete permission update."
            ));
        }
        let records = self
            .records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?;
        let record = records
            .get(runtime_id)
            .ok_or_else(|| format!("Native runtime {runtime_id} not found"))?;
        if record.permission_quarantined {
            return Err(format!(
                "Native runtime {runtime_id} is quarantined after an incomplete permission update."
            ));
        }
        if !record.is_active {
            return Err(format!("Native runtime {runtime_id} is not active."));
        }
        if is_native_terminal_status(&record.status) {
            return Err(format!(
                "Native runtime {runtime_id} has terminal status {}.",
                record.status
            ));
        }
        let actor_id = record.browser_actor_id.clone();
        if !is_valid_browser_actor_id(&actor_id) {
            return Err("Native browser actor lineage is unavailable.".to_string());
        }
        Ok(actor_id)
    }

    fn summary_for(&self, runtime_id: &str) -> Result<NativeSessionSummary, String> {
        if let Some(handle) = self
            .handles
            .lock()
            .map_err(|_| "Failed to lock native runtime handles".to_string())?
            .get(runtime_id)
            .cloned()
        {
            return Ok(handle.summary());
        }

        self.records
            .lock()
            .map_err(|_| "Failed to lock native runtime records".to_string())?
            .get(runtime_id)
            .cloned()
            .map(|record| NativeSessionSummary {
                runtime_id: record.runtime_id,
                provider: record.provider,
                transport: record.transport,
                provider_session_id: record.provider_session_id,
                seed_boundary_message_count: record.seed_boundary_message_count,
                project_dir: record.project_dir,
                env_name: record.env_name,
                perm_mode: record.perm_mode,
                runtime_perm_mode: record.runtime_perm_mode,
                effort: record.effort,
                status: record.status,
                created_at: record.created_at,
                updated_at: record.updated_at,
                is_active: record.is_active,
                last_event_seq: None,
                can_handoff_to_terminal: record.can_handoff_to_terminal,
                last_error: record.last_error,
            })
            .ok_or_else(|| format!("Native runtime {} not found", runtime_id))
    }

    fn flush_helper_output_buffers(
        &self,
        app: Option<&AppHandle>,
        runtime_id: &str,
        stdout_buffer: &mut Vec<u8>,
        stderr_buffer: &mut Vec<u8>,
    ) {
        if let Some(text) = take_remaining_helper_output_line(stdout_buffer) {
            if let Err(error) = self.process_helper_stdout_with_app(app, runtime_id, &text) {
                let _ = self.append_event(
                    runtime_id,
                    SessionEventPayload::StdErrLine {
                        line: format!("Failed to process helper output: {}", error),
                    },
                );
            }
        }
        if let Some(text) = take_remaining_helper_output_line(stderr_buffer) {
            let _ = self.append_event(runtime_id, SessionEventPayload::StdErrLine { line: text });
        }
    }
}

fn trim_helper_output_line(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes)
        .trim_matches(['\r', '\n'])
        .trim()
        .to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn drain_helper_output_lines(buffer: &mut Vec<u8>, chunk: &[u8]) -> Vec<String> {
    buffer.extend_from_slice(chunk);
    let mut lines = Vec::new();
    while let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
        let line = buffer.drain(..=index).collect::<Vec<_>>();
        if let Some(text) = trim_helper_output_line(&line) {
            lines.push(text);
        }
    }
    lines
}

fn take_remaining_helper_output_line(buffer: &mut Vec<u8>) -> Option<String> {
    if buffer.is_empty() {
        return None;
    }
    let line = std::mem::take(buffer);
    trim_helper_output_line(&line)
}

fn summarize_interactive_prompt_response(
    display_text: Option<&str>,
    answers: &HashMap<String, String>,
) -> Option<String> {
    if let Some(text) = display_text
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(text.to_string());
    }

    let mut entries = answers
        .iter()
        .filter_map(|(question, answer)| {
            let answer = answer.trim();
            if answer.is_empty() {
                return None;
            }
            Some((question.trim(), answer))
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.cmp(right.0));

    match entries.as_slice() {
        [] => None,
        [(_, answer)] => Some((*answer).to_string()),
        _ => Some(
            entries
                .into_iter()
                .map(|(question, answer)| {
                    if question.is_empty() {
                        answer.to_string()
                    } else {
                        format!("{question}: {answer}")
                    }
                })
                .collect::<Vec<_>>()
                .join("\n"),
        ),
    }
}

fn payload_last_error(payload: &SessionEventPayload) -> Option<String> {
    match payload {
        SessionEventPayload::StdErrLine { line } if !is_context_usage_probe_error(line) => {
            non_empty_error(line)
        }
        SessionEventPayload::Lifecycle { stage, detail } if stage == "error" => {
            non_empty_error(detail)
        }
        SessionEventPayload::SessionCompleted { reason }
            if !reason.contains("Stopped from desktop workspace") =>
        {
            non_empty_error(reason)
        }
        _ => None,
    }
}

fn is_context_usage_probe_error(message: &str) -> bool {
    message
        .trim_start()
        .starts_with("[context_usage] getContextUsage failed:")
}

fn is_native_terminal_status(status: &str) -> bool {
    matches!(
        status,
        "stopped" | "error" | "handoff" | "interrupted" | "closed_idle" | "permission_quarantined"
    )
}

fn is_recoverable_native_process_exit(record: &NativeSessionRecord) -> bool {
    record
        .provider_session_id
        .as_deref()
        .is_some_and(|session_id| !session_id.trim().is_empty())
}

fn is_recoverable_native_helper_error(record: &NativeSessionRecord, detail: Option<&str>) -> bool {
    is_recoverable_native_process_exit(record)
        && detail.is_some_and(is_recoverable_native_process_error)
}

fn is_recoverable_native_process_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("terminated by signal")
        || normalized.contains("signal sigkill")
        || normalized.contains("sigkill")
}

fn reactivate_record_for_reconnect(record: &mut NativeSessionRecord) -> bool {
    if record.permission_quarantined {
        return false;
    }
    if !matches!(
        record.status.as_str(),
        "error" | "interrupted" | "closed_idle"
    ) {
        return false;
    }

    record.status = "initializing".to_string();
    record.is_active = true;
    record.last_error = None;
    record.updated_at = Utc::now();
    true
}

fn is_retryable_native_child_write_error(message: &str) -> bool {
    message == "Native sidecar child is not available"
        || message == "Native helper writer is unavailable."
        || message.starts_with("Native helper writer queue is full;")
}

fn is_unknown_native_child_delivery_error(message: &str) -> bool {
    message == "Native helper stdin write timed out."
        || message == "Native helper writer completion channel closed."
        || message.starts_with("Failed to write to native sidecar stdin:")
}

fn env_path_separator() -> char {
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
}

fn merge_path_values_with_separator(primary: &str, secondary: &str, separator: char) -> String {
    let mut parts = Vec::new();
    for value in [primary, secondary] {
        for part in value
            .split(separator)
            .map(str::trim)
            .filter(|part| !part.is_empty())
        {
            if !parts.iter().any(|existing| existing == part) {
                parts.push(part.to_string());
            }
        }
    }
    parts.join(&separator.to_string())
}

fn merge_path_values(primary: &str, secondary: &str) -> String {
    merge_path_values_with_separator(primary, secondary, env_path_separator())
}

fn merge_helper_env_path(env_vars: &mut HashMap<String, String>, user_path: &str) {
    let user_path = user_path.trim();
    if user_path.is_empty() {
        return;
    }

    let merged = env_vars
        .get("PATH")
        .map(|existing| merge_path_values(user_path, existing))
        .unwrap_or_else(|| user_path.to_string());
    env_vars.insert("PATH".to_string(), merged);
}

fn non_empty_error(message: &str) -> Option<String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn generate_runtime_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("native-{}", timestamp)
}

fn native_runtime_state_file_path() -> PathBuf {
    dirs::home_dir()
        .map(|home| home.join(".ccem/native-runtime-state.json"))
        .unwrap_or_else(|| PathBuf::from(".ccem/native-runtime-state.json"))
}

fn read_native_runtime_state_from(path: &Path) -> io::Result<NativeRuntimeState> {
    if !path.exists() {
        return Ok(NativeRuntimeState::default());
    }

    let content = fs::read_to_string(path)?;
    let mut state = serde_json::from_str::<NativeRuntimeState>(&content)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;

    backfill_browser_actor_lineages(&mut state.sessions);
    for record in &mut state.sessions {
        if record
            .last_error
            .as_deref()
            .is_some_and(is_context_usage_probe_error)
        {
            record.last_error = None;
        }
    }

    Ok(state)
}

fn persist_native_runtime_state_to(
    path: &Path,
    records: Vec<NativeSessionRecord>,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("Failed to create native runtime state directory: {}", error)
        })?;
    }

    let state = NativeRuntimeState { sessions: records };
    let serialized = serde_json::to_vec_pretty(&state)
        .map_err(|error| format!("Failed to serialize native runtime state: {}", error))?;
    let temp_path = native_runtime_state_temp_file_path(path);
    fs::write(&temp_path, serialized)
        .map_err(|error| format!("Failed to write native runtime state: {}", error))?;
    fs::rename(&temp_path, path)
        .map_err(|error| format!("Failed to finalize native runtime state: {}", error))
}

fn native_runtime_state_temp_file_path(path: &Path) -> PathBuf {
    let counter = NATIVE_RUNTIME_STATE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("native-runtime-state.json");
    path.with_file_name(format!(
        ".{}.{}.{}.tmp",
        file_name,
        std::process::id(),
        counter
    ))
}

fn build_runtime_bootstrap_options(
    record: &NativeSessionRecord,
) -> Result<NativeSessionOptions, String> {
    let (mut helper_env_vars, mut terminal_env_vars, codex_base_url, codex_api_key) =
        match record.provider {
            NativeProvider::Claude => {
                let resolved = resolve_claude_env(&record.env_name)?;
                (resolved.env_vars.clone(), resolved.env_vars, None, None)
            }
            NativeProvider::Codex => {
                resolve_codex_runtime(&record.env_name)?;
                let proxy_env_vars = resolve_codex_proxy_env();
                (proxy_env_vars.clone(), proxy_env_vars, None, None)
            }
        };
    merge_helper_env_path(&mut helper_env_vars, &terminal::get_user_path());
    inject_ccem_runtime_env(&mut helper_env_vars, &record.runtime_id);
    inject_ccem_runtime_env(&mut terminal_env_vars, &record.runtime_id);

    Ok(NativeSessionOptions {
        provider: record.provider,
        env_name: record.env_name.clone(),
        perm_mode: record.perm_mode.clone(),
        runtime_perm_mode: record.runtime_perm_mode.clone(),
        working_dir: record.project_dir.clone(),
        initial_prompt: None,
        display_prompt: None,
        initial_images: None,
        initial_annotations: None,
        provider_session_id: record.provider_session_id.clone(),
        seed_boundary_message_count: record.seed_boundary_message_count,
        helper_env_vars,
        terminal_env_vars,
        claude_path: resolve_claude_path(),
        codex_path: resolve_codex_path(),
        codex_base_url,
        codex_api_key,
        effort: record.effort.clone(),
    })
}

fn inject_ccem_runtime_env(env_vars: &mut HashMap<String, String>, runtime_id: &str) {
    env_vars.insert("CCEM_RUNTIME_ID".to_string(), runtime_id.to_string());
    env_vars.insert("CCEM_SESSION_ID".to_string(), runtime_id.to_string());
}

#[cfg(test)]
mod tests {
    use super::{
        authorize_browser_tool_for_record, clear_terminal_launches, drain_helper_output_lines,
        is_retryable_native_child_write_error, is_unknown_native_child_delivery_error,
        launch_terminal_for_native_handoff, merge_helper_env_path,
        merge_path_values_with_separator, native_runtime_state_temp_file_path,
        native_session_allows_dangerously_skip_permissions, native_status_allows_file_rewind,
        reactivate_record_for_reconnect, read_native_runtime_state_from, take_terminal_launches,
        HelperInputCommand, NativeProvider, NativeRuntimeManager, NativeSessionHandle,
        NativeSessionOptions, NativeSessionRecord, NativeTransport, PromptImage,
    };
    use crate::event_bus::{
        SessionEventPayload, SessionPromptAnnotation, SessionStore, TodoSnapshotItemV1,
        TodoSnapshotV1,
    };
    use crate::native_event_log::NativeEventLog;
    use crate::prompt_image_store::PromptImageStore;
    use chrono::Utc;
    use std::collections::{HashMap, HashSet};
    use std::fs;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
    use std::sync::{mpsc, Arc, Barrier, Condvar, Mutex};
    use std::time::{Duration, Instant};

    fn native_session_handle(record: NativeSessionRecord) -> Arc<NativeSessionHandle> {
        native_session_handle_with_terminal_env(record, HashMap::new())
    }

    fn native_session_handle_with_generation(
        record: NativeSessionRecord,
        generation: u64,
    ) -> Arc<NativeSessionHandle> {
        native_session_handle_with_terminal_env_and_generation(record, HashMap::new(), generation)
    }

    fn native_session_handle_with_terminal_env(
        record: NativeSessionRecord,
        terminal_env_vars: HashMap<String, String>,
    ) -> Arc<NativeSessionHandle> {
        native_session_handle_with_terminal_env_and_generation(record, terminal_env_vars, 1)
    }

    fn native_session_handle_with_terminal_env_and_generation(
        record: NativeSessionRecord,
        terminal_env_vars: HashMap<String, String>,
        generation: u64,
    ) -> Arc<NativeSessionHandle> {
        let runtime_id = record.runtime_id.clone();
        Arc::new(NativeSessionHandle {
            generation,
            browser_permission: super::BrowserPermissionAuthority::new(
                super::effective_native_perm_mode(
                    record.perm_mode.as_str(),
                    record.runtime_perm_mode.as_deref(),
                ),
            ),
            browser_permission_sync: Mutex::new(()),
            record: Mutex::new(record),
            launcher_pid: AtomicU32::new(0),
            launcher_birth_token: AtomicU64::new(0),
            writer: Mutex::new(None),
            events: Mutex::new(SessionStore::new(&runtime_id)),
            settings_update_acks: super::SettingsUpdateAckRegistry::default(),
            helper_env_vars: HashMap::new(),
            terminal_env_vars,
            claude_path: None,
            codex_path: None,
            codex_base_url: None,
            codex_api_key: None,
            permission_quarantined: AtomicBool::new(false),
            alive: AtomicBool::new(true),
        })
    }

    fn manager_with_handle(runtime_id: &str) -> NativeRuntimeManager {
        let record = NativeSessionRecord {
            runtime_id: runtime_id.to_string(),
            provider: NativeProvider::Claude,
            transport: NativeTransport::NativeSdk,
            provider_session_id: None,
            browser_actor_id: super::legacy_browser_actor_id(NativeProvider::Claude, runtime_id),
            seed_boundary_message_count: None,
            project_dir: "/tmp/project".to_string(),
            env_name: "DeepSeek".to_string(),
            perm_mode: "dev".to_string(),
            runtime_perm_mode: None,
            effort: None,
            status: "processing".to_string(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            is_active: true,
            can_handoff_to_terminal: false,
            permission_quarantined: false,
            pending_handoff_terminal: None,
            last_error: None,
        };
        let handle = native_session_handle(record.clone());
        let manager = NativeRuntimeManager {
            records: Mutex::new(HashMap::from([(runtime_id.to_string(), record)])),
            handles: Mutex::new(HashMap::from([(runtime_id.to_string(), handle)])),
            permission_quarantine_fences: Mutex::new(HashSet::new()),
            permission_transactions: Mutex::new(HashMap::new()),
            lifecycle_transactions: Mutex::new(HashMap::new()),
            next_handle_generation: AtomicU64::new(2),
            state_path: std::env::temp_dir()
                .join(format!("ccem-native-runtime-test-{runtime_id}.json")),
            event_log: NativeEventLog::new(
                std::env::temp_dir().join(format!("ccem-native-runtime-test-{runtime_id}.sqlite")),
            ),
            prompt_image_store: PromptImageStore::new(
                std::env::temp_dir()
                    .join(format!("ccem-native-runtime-test-{runtime_id}-attachments")),
            ),
        };
        manager
    }

    fn manager_with_records(
        runtime_id: &str,
        records: Vec<NativeSessionRecord>,
    ) -> NativeRuntimeManager {
        NativeRuntimeManager {
            records: Mutex::new(
                records
                    .into_iter()
                    .map(|record| (record.runtime_id.clone(), record))
                    .collect(),
            ),
            handles: Mutex::new(HashMap::new()),
            permission_quarantine_fences: Mutex::new(HashSet::new()),
            permission_transactions: Mutex::new(HashMap::new()),
            lifecycle_transactions: Mutex::new(HashMap::new()),
            next_handle_generation: AtomicU64::new(1),
            state_path: std::env::temp_dir().join(format!(
                "ccem-native-runtime-reconcile-test-{runtime_id}.json"
            )),
            event_log: NativeEventLog::new(std::env::temp_dir().join(format!(
                "ccem-native-runtime-reconcile-test-{runtime_id}.sqlite"
            ))),
            prompt_image_store: PromptImageStore::new(std::env::temp_dir().join(format!(
                "ccem-native-runtime-reconcile-test-{runtime_id}-attachments"
            ))),
        }
    }

    fn native_record(runtime_id: &str, status: &str, is_active: bool) -> NativeSessionRecord {
        NativeSessionRecord {
            runtime_id: runtime_id.to_string(),
            provider: NativeProvider::Claude,
            transport: NativeTransport::NativeSdk,
            provider_session_id: None,
            browser_actor_id: super::legacy_browser_actor_id(NativeProvider::Claude, runtime_id),
            seed_boundary_message_count: None,
            project_dir: "/tmp/project".to_string(),
            env_name: "DeepSeek".to_string(),
            perm_mode: "dev".to_string(),
            runtime_perm_mode: None,
            effort: None,
            status: status.to_string(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            is_active,
            can_handoff_to_terminal: false,
            permission_quarantined: false,
            pending_handoff_terminal: None,
            last_error: None,
        }
    }

    struct BlockingCommandSink {
        released: Arc<(Mutex<bool>, Condvar)>,
    }

    impl super::NativeHelperCommandSink for BlockingCommandSink {
        fn write_command(&mut self, _bytes: &[u8]) -> Result<(), String> {
            let (lock, changed) = self.released.as_ref();
            let mut released = lock.lock().unwrap();
            while !*released {
                released = changed.wait(released).unwrap();
            }
            Ok(())
        }
    }

    #[test]
    fn browser_policy_uses_runtime_permission_override_from_record() {
        let mut record = native_record("native-browser-policy", "ready", true);
        record.perm_mode = "dev".to_string();
        record.runtime_perm_mode = Some("readonly".to_string());

        assert!(authorize_browser_tool_for_record(&record, "snapshot").is_ok());
        assert!(authorize_browser_tool_for_record(&record, "click").is_err());

        record.perm_mode = "readonly".to_string();
        record.runtime_perm_mode = Some("dev".to_string());

        assert!(authorize_browser_tool_for_record(&record, "click").is_ok());
    }

    #[test]
    fn failed_permission_upgrade_delivery_never_commits_browser_authority() {
        let steps = Mutex::new(Vec::new());
        let error = super::deliver_browser_permission_change(
            true,
            || {
                steps.lock().unwrap().push("deliver");
                Err("helper unavailable".to_string())
            },
            || {
                steps.lock().unwrap().push("commit");
                Ok(())
            },
            || {
                steps.lock().unwrap().push("quarantine");
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(error, "helper unavailable");
        assert_eq!(*steps.lock().unwrap(), vec!["deliver", "quarantine"]);
    }

    #[test]
    fn permission_downgrade_retires_browser_authority_before_helper_delivery() {
        let steps = Mutex::new(Vec::new());
        let error = super::deliver_browser_permission_change(
            false,
            || {
                steps.lock().unwrap().push("deliver");
                Err("helper unavailable".to_string())
            },
            || {
                steps.lock().unwrap().push("commit");
                Ok(())
            },
            || {
                steps.lock().unwrap().push("quarantine");
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(error, "helper unavailable");
        assert_eq!(
            *steps.lock().unwrap(),
            vec!["commit", "deliver", "quarantine"]
        );
    }

    #[test]
    fn failed_permission_upgrade_commit_quarantines_the_expanded_helper() {
        let steps = Mutex::new(Vec::new());
        let error = super::deliver_browser_permission_change(
            true,
            || {
                steps.lock().unwrap().push("deliver");
                Ok(())
            },
            || {
                steps.lock().unwrap().push("commit");
                Err("browser commit failed".to_string())
            },
            || {
                steps.lock().unwrap().push("quarantine");
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(error, "browser commit failed");
        assert_eq!(
            *steps.lock().unwrap(),
            vec!["deliver", "commit", "quarantine"]
        );
    }

    #[test]
    fn correlated_settings_ack_accepts_only_applied_for_the_exact_request() {
        let acks = super::SettingsUpdateAckRegistry::default();
        let receiver = acks.register("settings-request-a").expect("register ack");

        assert!(!acks
            .resolve(
                "settings-request-b",
                super::SettingsUpdateAck {
                    outcome: super::SettingsUpdateOutcome::Applied,
                    detail: None,
                },
            )
            .expect("ignore wrong request"));
        assert!(acks
            .resolve(
                "settings-request-a",
                super::SettingsUpdateAck {
                    outcome: super::SettingsUpdateOutcome::Applied,
                    detail: None,
                },
            )
            .expect("resolve exact request"));

        super::wait_for_required_settings_ack(
            "settings-request-a",
            receiver,
            Duration::from_millis(10),
        )
        .expect("applied ack");
    }

    #[test]
    fn helper_settings_ack_cannot_cross_runtime_or_request_boundaries() {
        let runtime_a = "native-settings-runtime-a";
        let runtime_b = "native-settings-runtime-b";
        let manager = manager_with_handle(runtime_a);
        let handle_a = manager
            .handles
            .lock()
            .unwrap()
            .get(runtime_a)
            .cloned()
            .unwrap();
        let record_b = native_record(runtime_b, "ready", true);
        let handle_b = native_session_handle(record_b.clone());
        manager
            .records
            .lock()
            .unwrap()
            .insert(runtime_b.to_string(), record_b);
        manager
            .handles
            .lock()
            .unwrap()
            .insert(runtime_b.to_string(), handle_b);

        let receiver = handle_a
            .settings_update_acks
            .register("settings-exact-request")
            .unwrap();
        manager
            .process_helper_stdout(
                runtime_b,
                r#"{"type":"settings_update_result","request_id":"settings-exact-request","outcome":"applied"}"#,
            )
            .unwrap();
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(5)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        );
        manager
            .process_helper_stdout(
                runtime_a,
                r#"{"type":"settings_update_result","request_id":"settings-wrong-request","outcome":"applied"}"#,
            )
            .unwrap();
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(5)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        );
        manager
            .process_helper_stdout(
                runtime_a,
                r#"{"type":"settings_update_result","request_id":"settings-exact-request","outcome":"applied"}"#,
            )
            .unwrap();
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(10)).unwrap(),
            super::SettingsUpdateAck {
                outcome: super::SettingsUpdateOutcome::Applied,
                detail: None,
            }
        );
    }

    #[test]
    fn correlated_settings_ack_rejects_failed_delivery() {
        let acks = super::SettingsUpdateAckRegistry::default();
        let receiver = acks.register("settings-request-failed").unwrap();
        acks.resolve(
            "settings-request-failed",
            super::SettingsUpdateAck {
                outcome: super::SettingsUpdateOutcome::Failed,
                detail: Some("provider rejected mode".to_string()),
            },
        )
        .unwrap();

        let error = super::wait_for_required_settings_ack(
            "settings-request-failed",
            receiver,
            Duration::from_millis(10),
        )
        .expect_err("failed ack must fail closed");
        assert!(error.contains("failed"));
        assert!(error.contains("provider rejected mode"));
    }

    #[test]
    fn correlated_settings_ack_rejects_deferred_delivery() {
        let acks = super::SettingsUpdateAckRegistry::default();
        let receiver = acks.register("settings-request-deferred").unwrap();
        acks.resolve(
            "settings-request-deferred",
            super::SettingsUpdateAck {
                outcome: super::SettingsUpdateOutcome::Deferred,
                detail: Some("next turn".to_string()),
            },
        )
        .unwrap();

        let error = super::wait_for_required_settings_ack(
            "settings-request-deferred",
            receiver,
            Duration::from_millis(10),
        )
        .expect_err("deferred ack is not applied");
        assert!(error.contains("deferred"));
    }

    #[test]
    fn correlated_settings_ack_times_out_without_exact_response() {
        let acks = super::SettingsUpdateAckRegistry::default();
        let receiver = acks.register("settings-request-timeout").unwrap();

        let error = super::wait_for_required_settings_ack(
            "settings-request-timeout",
            receiver,
            Duration::from_millis(5),
        )
        .expect_err("missing ack must time out");
        assert!(error.contains("timed out"));
        acks.cancel("settings-request-timeout").unwrap();
    }

    #[test]
    fn blocked_helper_stdin_write_obeys_the_absolute_permission_deadline() {
        let released = Arc::new((Mutex::new(false), Condvar::new()));
        let writer = super::NativeHelperWriter::spawn_sink(Box::new(BlockingCommandSink {
            released: Arc::clone(&released),
        }))
        .expect("spawn bounded writer");
        let started = Instant::now();

        let error = writer
            .write_until(
                b"{\"type\":\"update_settings\"}\n".to_vec(),
                started + Duration::from_millis(40),
            )
            .expect_err("blocked helper stdin must time out");

        assert!(error.contains("stdin write timed out"));
        assert!(started.elapsed() < Duration::from_millis(500));
        let (lock, changed) = released.as_ref();
        *lock.lock().unwrap() = true;
        changed.notify_all();
    }

    #[test]
    fn helper_write_and_applied_ack_share_one_total_deadline() {
        let released = Arc::new((Mutex::new(false), Condvar::new()));
        let writer = super::NativeHelperWriter::spawn_sink(Box::new(BlockingCommandSink {
            released: Arc::clone(&released),
        }))
        .expect("spawn bounded writer");
        let acks = super::SettingsUpdateAckRegistry::default();
        let receiver = acks.register("settings-shared-deadline").unwrap();
        let started = Instant::now();
        let deadline = started + Duration::from_millis(100);
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            let (lock, changed) = released.as_ref();
            *lock.lock().unwrap() = true;
            changed.notify_all();
        });

        writer
            .write_until(b"settings\n".to_vec(), deadline)
            .expect("write completes inside total deadline");
        let error = super::wait_for_required_settings_ack(
            "settings-shared-deadline",
            receiver,
            deadline.saturating_duration_since(Instant::now()),
        )
        .expect_err("missing applied ack uses only the remaining time");

        assert!(error.contains("acknowledgement timed out"));
        assert!(started.elapsed() < Duration::from_millis(250));
        release.join().unwrap();
        acks.cancel("settings-shared-deadline").unwrap();
    }

    #[test]
    fn permission_quarantine_blocks_all_future_helper_commands() {
        let runtime_id = "native-permission-quarantine";
        let manager = manager_with_handle(runtime_id);
        let handle = manager
            .handles
            .lock()
            .unwrap()
            .get(runtime_id)
            .cloned()
            .expect("native handle");
        handle.permission_quarantined.store(true, Ordering::SeqCst);

        let error = manager
            .write_to_child(&handle, &HelperInputCommand::Stop)
            .expect_err("quarantined helper must reject every command");

        assert!(error.contains("quarantined"));
        assert!(!manager
            .mark_handle_live_if_current(runtime_id, &handle)
            .expect("inspect handle"));
    }

    #[test]
    fn durable_permission_quarantine_never_reactivates_as_a_normal_error() {
        let mut record = native_record("native-durable-quarantine", "error", false);
        record.permission_quarantined = true;
        record.perm_mode = "readonly".to_string();

        assert!(!reactivate_record_for_reconnect(&mut record));
        assert!(record.permission_quarantined);
        assert_eq!(record.perm_mode, "readonly");
        assert_eq!(record.status, "error");

        let encoded = serde_json::to_vec(&record).expect("serialize quarantine");
        let decoded: NativeSessionRecord =
            serde_json::from_slice(&encoded).expect("restore quarantine");
        assert!(decoded.permission_quarantined);
    }

    #[test]
    fn browser_actor_lookup_rejects_quarantined_inactive_and_terminal_runtimes() {
        let mut active = native_record("native-actor-active", "processing", true);
        let expected_actor = active.browser_actor_id.clone();
        let mut quarantined =
            native_record("native-actor-quarantined", "permission_quarantined", false);
        quarantined.permission_quarantined = true;
        let inactive = native_record("native-actor-inactive", "ready", false);
        let terminal = native_record("native-actor-terminal", "stopped", true);
        let manager = manager_with_records(
            "browser-actor-eligibility",
            vec![active.clone(), quarantined, inactive, terminal],
        );

        assert_eq!(
            manager
                .browser_actor_id_for_runtime(&active.runtime_id)
                .expect("active runtime actor"),
            expected_actor
        );
        assert!(manager
            .browser_actor_id_for_runtime("native-actor-quarantined")
            .unwrap_err()
            .contains("quarantined"));
        assert!(manager
            .browser_actor_id_for_runtime("native-actor-inactive")
            .unwrap_err()
            .contains("not active"));
        assert!(manager
            .browser_actor_id_for_runtime("native-actor-terminal")
            .unwrap_err()
            .contains("terminal"));
        manager.fence_permission_quarantine("native-actor-active");
        assert!(manager
            .browser_actor_id_for_runtime("native-actor-active")
            .unwrap_err()
            .contains("quarantined"));

        active.browser_actor_id.clear();
        let invalid = manager_with_records("browser-actor-invalid", vec![active]);
        assert!(invalid
            .browser_actor_id_for_runtime("native-actor-active")
            .unwrap_err()
            .contains("lineage"));
    }

    #[test]
    fn failed_unverified_helper_cleanup_persists_quarantine_and_retains_owner() {
        let runtime_id = "native-unverified-helper-quarantine";
        let manager = manager_with_handle(runtime_id);
        let _ = fs::remove_file(&manager.state_path);
        let handle = manager
            .handles
            .lock()
            .unwrap()
            .get(runtime_id)
            .cloned()
            .expect("native handle");

        let error = manager
            .fail_unverified_helper_launch(
                runtime_id,
                &handle,
                0,
                "ownership verification failed".to_string(),
            )
            .expect_err("an unverified helper can never be accepted");

        assert!(error.contains("failed to confirm unverified helper cleanup"));
        assert!(error.contains("durable quarantine persisted"));
        assert!(handle.permission_quarantined.load(Ordering::SeqCst));
        assert!(!handle.alive.load(Ordering::SeqCst));
        assert!(manager.is_current_handle(runtime_id, &handle).unwrap());
        let stored = read_native_runtime_state_from(&manager.state_path)
            .expect("read durable quarantine")
            .sessions
            .into_iter()
            .find(|record| record.runtime_id == runtime_id)
            .expect("persisted runtime record");
        assert!(stored.permission_quarantined);
        assert_eq!(stored.perm_mode, "readonly");
        assert_eq!(stored.status, "permission_quarantined");
        assert!(!stored.is_active);
        let _ = fs::remove_file(&manager.state_path);
    }

    #[cfg(unix)]
    #[test]
    fn confirmed_verified_helper_cleanup_uses_birth_identity_and_removes_current_owner() {
        use std::os::unix::process::CommandExt as _;
        let runtime_id = "native-unverified-helper-cleanup";
        let manager = manager_with_handle(runtime_id);
        let handle = manager
            .handles
            .lock()
            .unwrap()
            .get(runtime_id)
            .cloned()
            .expect("native handle");
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "while :; do sleep 1; done"]);
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut child = command.spawn().expect("spawn unverified helper sentinel");
        let pid = child.id();
        let birth_token = super::native_helper_process_birth_token(pid)
            .expect("read helper birth identity")
            .expect("live helper birth identity");
        handle.launcher_pid.store(pid, Ordering::Release);
        handle
            .launcher_birth_token
            .store(birth_token, Ordering::Release);
        let waiter = std::thread::spawn(move || child.wait());

        let error = manager
            .fail_unverified_helper_launch(
                runtime_id,
                &handle,
                pid,
                "ownership verification failed".to_string(),
            )
            .expect_err("unverified helper launch must fail");

        assert_eq!(error, "ownership verification failed");
        waiter
            .join()
            .expect("join process waiter")
            .expect("reap helper");
        assert!(!super::native_helper_process_exists(pid).unwrap());
        assert!(!manager.is_current_handle(runtime_id, &handle).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn native_helper_sigkill_is_observable_before_control_is_released() {
        use std::os::unix::process::CommandExt as _;
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "while :; do sleep 1; done"]);
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut child = command.spawn().expect("spawn termination sentinel");
        let pid = child.id();
        let waiter = std::thread::spawn(move || child.wait());

        super::signal_native_helper_termination(pid).expect("signal exact helper pid");
        let deadline = Instant::now() + Duration::from_secs(2);
        while super::native_helper_process_exists(pid).unwrap() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        waiter
            .join()
            .expect("join process waiter")
            .expect("reap helper");

        assert!(!super::native_helper_process_exists(pid).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn verified_helper_termination_rejects_birth_identity_mismatch_without_signalling() {
        use std::os::unix::process::CommandExt as _;
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "while :; do sleep 1; done"]);
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut child = command.spawn().expect("spawn identity sentinel");
        let pid = child.id();
        let birth_token = super::native_helper_process_birth_token(pid)
            .unwrap()
            .expect("live birth identity");

        let error = super::terminate_verified_native_helper(
            pid,
            birth_token.saturating_add(1),
            Duration::from_millis(100),
        )
        .expect_err("mismatched birth identity must not be signalled");

        assert!(error.contains("identity changed"));
        assert!(super::native_helper_process_exists(pid).unwrap());
        let waiter = std::thread::spawn(move || child.wait());
        super::terminate_unverified_native_helper(pid, Duration::from_secs(2))
            .expect("cleanup sentinel");
        waiter
            .join()
            .expect("join identity waiter")
            .expect("reap sentinel");
    }

    #[cfg(unix)]
    #[test]
    fn verified_cleanup_kills_orphaned_group_after_launcher_leader_is_reaped() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::process::CommandExt as _;
        use std::process::Stdio;
        let mut command = std::process::Command::new("sh");
        command
            .args([
                "-c",
                "trap '' HUP; sleep 30 </dev/null >/dev/null 2>&1 & echo $!; read ready; exit 0",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut leader = command.spawn().expect("spawn orphan group leader");
        let leader_pid = leader.id();
        let birth_token = super::native_helper_process_birth_token(leader_pid)
            .unwrap()
            .expect("leader birth identity");
        let mut child_line = String::new();
        BufReader::new(leader.stdout.take().unwrap())
            .read_line(&mut child_line)
            .expect("read descendant pid");
        let descendant_pid = child_line.trim().parse::<i32>().expect("descendant pid");
        leader
            .stdin
            .take()
            .unwrap()
            .write_all(b"release\n")
            .expect("release leader");
        leader.wait().expect("reap launcher leader");
        assert!(super::native_helper_process_birth_token(leader_pid)
            .unwrap()
            .is_none());
        assert!(super::native_helper_process_exists(leader_pid).unwrap());

        super::terminate_verified_native_helper(leader_pid, birth_token, Duration::from_secs(2))
            .expect("terminate orphaned ownership group");

        assert!(!super::native_helper_process_exists(leader_pid).unwrap());
        let descendant_alive = unsafe { libc::kill(descendant_pid, 0) } == 0;
        assert!(!descendant_alive);
    }

    fn native_session_options(
        perm_mode: &str,
        runtime_perm_mode: Option<&str>,
    ) -> NativeSessionOptions {
        NativeSessionOptions {
            provider: NativeProvider::Claude,
            env_name: "default".to_string(),
            perm_mode: perm_mode.to_string(),
            runtime_perm_mode: runtime_perm_mode.map(str::to_string),
            working_dir: "/tmp/project".to_string(),
            initial_prompt: None,
            display_prompt: None,
            initial_images: None,
            initial_annotations: None,
            provider_session_id: None,
            seed_boundary_message_count: None,
            helper_env_vars: HashMap::new(),
            terminal_env_vars: HashMap::new(),
            claude_path: None,
            codex_path: None,
            codex_base_url: None,
            codex_api_key: None,
            effort: None,
        }
    }

    #[test]
    fn helper_stdout_accepts_multiple_jsonl_events_in_one_chunk() {
        let runtime_id = "native-jsonl";
        let manager = manager_with_handle(runtime_id);
        let chunk = concat!(
            r#"{"type":"event","payload":{"type":"stderr_line","line":"first error"}}"#,
            "\n",
            r#"{"type":"event","payload":{"type":"session_completed","reason":"done"}}"#,
            "\n",
        );

        manager
            .process_helper_stdout(runtime_id, chunk)
            .expect("process jsonl chunk");

        let batch = manager
            .replay_events(runtime_id, None)
            .expect("replay events");

        assert_eq!(batch.events.len(), 2);
        assert_eq!(
            batch.events[0].payload,
            SessionEventPayload::StdErrLine {
                line: "first error".to_string(),
            }
        );
        assert_eq!(
            batch.events[1].payload,
            SessionEventPayload::SessionCompleted {
                reason: "done".to_string(),
            }
        );
    }

    #[test]
    fn helper_token_usage_records_official_token_counts() {
        let runtime_id = "native-token-usage";
        let manager = manager_with_handle(runtime_id);

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"event","payload":{"type":"token_usage","provider":"claude","input_tokens":10,"output_tokens":120,"cache_read_tokens":0,"cache_creation_tokens":0}}"#,
            )
            .expect("process token usage");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.runtime_id, runtime_id);

        let batch = manager
            .replay_events(runtime_id, None)
            .expect("replay events");
        assert_eq!(batch.events.len(), 1);
        match &batch.events[0].payload {
            SessionEventPayload::TokenUsage {
                input_tokens,
                output_tokens,
                ..
            } => {
                assert_eq!(*input_tokens, 10);
                assert_eq!(*output_tokens, 120);
            }
            payload => panic!("unexpected payload: {:?}", payload),
        }
    }

    #[test]
    fn context_usage_probe_stderr_does_not_set_last_error() {
        let runtime_id = "native-context-usage-probe";
        let manager = manager_with_handle(runtime_id);

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"event","payload":{"type":"stderr_line","line":"[context_usage] getContextUsage failed: Error: q.match is not a function"}}"#,
            )
            .expect("process context usage probe stderr");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.last_error, None);

        let batch = manager
            .replay_events(runtime_id, None)
            .expect("replay events");
        assert_eq!(batch.events.len(), 1);
        assert_eq!(
            batch.events[0].payload,
            SessionEventPayload::StdErrLine {
                line: "[context_usage] getContextUsage failed: Error: q.match is not a function"
                    .to_string(),
            }
        );
    }

    #[test]
    fn read_state_clears_persisted_context_usage_probe_error() {
        let mut record = native_record("native-context-usage-state", "ready", true);
        record.last_error = Some(
            "[context_usage] getContextUsage failed: Error: q.match is not a function".to_string(),
        );
        let state_path = std::env::temp_dir().join(format!(
            "ccem-native-runtime-context-usage-state-{}.json",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let serialized = serde_json::to_string(&serde_json::json!({
            "sessions": [record],
        }))
        .expect("serialize state");
        fs::write(&state_path, serialized).expect("write state");

        let state = read_native_runtime_state_from(&state_path).expect("read state");

        assert_eq!(state.sessions.len(), 1);
        assert_eq!(state.sessions[0].last_error, None);

        let _ = fs::remove_file(state_path);
    }

    #[test]
    fn provider_session_binding_keeps_the_provisional_browser_actor_lineage() {
        let runtime_id = "native-browser-actor-bind";
        let manager = manager_with_handle(runtime_id);
        let before = manager
            .records
            .lock()
            .expect("records")
            .get(runtime_id)
            .expect("record")
            .browser_actor_id
            .clone();

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"session_meta","provider_session_id":"raw-provider-session-id"}"#,
            )
            .expect("bind provider session");

        let records = manager.records.lock().expect("records");
        let record = records.get(runtime_id).expect("record");
        assert_eq!(
            record.provider_session_id.as_deref(),
            Some("raw-provider-session-id")
        );
        assert_eq!(record.browser_actor_id, before);
        assert!(!record.browser_actor_id.contains("raw-provider-session-id"));

        let _ = fs::remove_file(&manager.state_path);
    }

    #[test]
    fn two_late_bound_runtimes_cannot_split_one_provider_conversation_lineage() {
        let runtime_a = "native-late-lineage-a";
        let runtime_b = "native-late-lineage-b";
        let actor_a = "browser-actor-11111111111111111111111111111111";
        let actor_b = "browser-actor-22222222222222222222222222222222";
        let mut record_a = native_record(runtime_a, "ready", true);
        record_a.browser_actor_id = actor_a.to_string();
        let mut record_b = native_record(runtime_b, "ready", true);
        record_b.browser_actor_id = actor_b.to_string();
        let manager = manager_with_records(runtime_a, vec![record_a, record_b]);

        manager
            .process_helper_stdout(
                runtime_a,
                r#"{"type":"session_meta","provider_session_id":"shared-provider-session"}"#,
            )
            .expect("bind first runtime");
        manager
            .process_helper_stdout(
                runtime_b,
                r#"{"type":"session_meta","provider_session_id":"shared-provider-session"}"#,
            )
            .expect("bind second runtime without exposing the raw identity");

        let records = manager.records.lock().expect("records");
        assert_eq!(records[runtime_a].browser_actor_id, actor_a);
        assert!(
            records[runtime_b].browser_actor_id.is_empty(),
            "the conflicting late lineage must be quarantined, never rebound as untainted"
        );
        drop(records);
        let _ = fs::remove_file(&manager.state_path);
    }

    #[test]
    fn conflicting_late_lineage_retires_the_previous_exact_browser_actor() {
        let runtime_a = "native-late-retire-a";
        let runtime_b = "native-late-retire-b";
        let actor_a = "browser-actor-11111111111111111111111111111111";
        let actor_b = "browser-actor-22222222222222222222222222222222";
        let manager = manager_with_handle(runtime_b);
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_b)
            .cloned()
            .expect("runtime B handle");
        {
            let mut records = manager.records.lock().expect("records");
            let runtime_b_record = records.get_mut(runtime_b).expect("runtime B record");
            runtime_b_record.browser_actor_id = actor_b.to_string();
            let mut runtime_a_record = native_record(runtime_a, "ready", true);
            runtime_a_record.provider_session_id = Some("shared-provider-session".to_string());
            runtime_a_record.browser_actor_id = actor_a.to_string();
            records.insert(runtime_a.to_string(), runtime_a_record);
        }
        handle
            .record
            .lock()
            .expect("handle record")
            .browser_actor_id = actor_b.to_string();

        let mut retired = Vec::new();
        manager
            .bind_provider_session_lineage_with_retirement(
                runtime_b,
                "shared-provider-session",
                |workspace, actor_id| {
                    assert!(
                        manager.browser_actor_id_for_runtime(runtime_b).is_err(),
                        "UI handoff routing must be fenced before exact retirement begins"
                    );
                    assert!(
                        handle
                            .record
                            .lock()
                            .expect("handle record during retirement")
                            .browser_actor_id
                            .is_empty(),
                        "new browser requests must be fenced before retiring the old handoff"
                    );
                    retired.push((workspace.to_string(), actor_id.to_string()));
                    Ok(())
                },
            )
            .expect("conflicting lineage retirement");

        assert_eq!(
            retired,
            vec![("/tmp/project".to_string(), actor_b.to_string())]
        );
        assert!(manager
            .records
            .lock()
            .expect("records")
            .get(runtime_b)
            .expect("runtime B record")
            .browser_actor_id
            .is_empty());

        let _ = fs::remove_file(&manager.state_path);
    }

    #[test]
    fn conflicting_late_lineage_remains_fenced_when_exact_retirement_reports_failure() {
        let runtime_a = "native-late-retire-failure-a";
        let runtime_b = "native-late-retire-failure-b";
        let actor_a = "browser-actor-11111111111111111111111111111111";
        let actor_b = "browser-actor-22222222222222222222222222222222";
        let manager = manager_with_handle(runtime_b);
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_b)
            .cloned()
            .expect("runtime B handle");
        {
            let mut records = manager.records.lock().expect("records");
            let runtime_b_record = records.get_mut(runtime_b).expect("runtime B record");
            runtime_b_record.browser_actor_id = actor_b.to_string();
            let mut runtime_a_record = native_record(runtime_a, "ready", true);
            runtime_a_record.provider_session_id = Some("shared-provider-session".to_string());
            runtime_a_record.browser_actor_id = actor_a.to_string();
            records.insert(runtime_a.to_string(), runtime_a_record);
        }
        handle
            .record
            .lock()
            .expect("handle record")
            .browser_actor_id = actor_b.to_string();

        let error = manager
            .bind_provider_session_lineage_with_retirement(
                runtime_b,
                "shared-provider-session",
                |workspace, actor_id| {
                    assert_eq!(workspace, "/tmp/project");
                    assert_eq!(actor_id, actor_b);
                    Err("backend owner acknowledgement failed".to_string())
                },
            )
            .expect_err("retirement failure must remain observable");

        assert!(error.contains("exact handoff retirement failed"));
        assert!(manager
            .records
            .lock()
            .expect("records")
            .get(runtime_b)
            .expect("runtime B record")
            .browser_actor_id
            .is_empty());
        assert!(
            handle
                .record
                .lock()
                .expect("handle record after failed retirement")
                .browser_actor_id
                .is_empty(),
            "the live helper route must remain fenced after retirement failure"
        );

        let _ = fs::remove_file(&manager.state_path);
    }

    #[test]
    fn conflicting_late_lineage_still_fences_and_retires_when_persistence_fails() {
        let runtime_a = "native-late-retire-persist-a";
        let runtime_b = "native-late-retire-persist-b";
        let actor_a = "browser-actor-11111111111111111111111111111111";
        let actor_b = "browser-actor-22222222222222222222222222222222";
        let mut manager = manager_with_handle(runtime_b);
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_b)
            .cloned()
            .expect("runtime B handle");
        {
            let mut records = manager.records.lock().expect("records");
            let runtime_b_record = records.get_mut(runtime_b).expect("runtime B record");
            runtime_b_record.browser_actor_id = actor_b.to_string();
            let mut runtime_a_record = native_record(runtime_a, "ready", true);
            runtime_a_record.provider_session_id = Some("shared-provider-session".to_string());
            runtime_a_record.browser_actor_id = actor_a.to_string();
            records.insert(runtime_a.to_string(), runtime_a_record);
        }
        handle
            .record
            .lock()
            .expect("handle record")
            .browser_actor_id = actor_b.to_string();

        let blocked_parent = std::env::temp_dir().join(format!(
            "ccem-native-runtime-state-parent-blocked-{}",
            std::process::id()
        ));
        fs::write(&blocked_parent, b"not a directory").expect("create blocked state parent");
        manager.state_path = blocked_parent.join("state.json");

        let mut retired = Vec::new();
        let error = manager
            .bind_provider_session_lineage_with_retirement(
                runtime_b,
                "shared-provider-session",
                |workspace, actor_id| {
                    retired.push((workspace.to_string(), actor_id.to_string()));
                    Ok(())
                },
            )
            .expect_err("persistence failure must remain observable");

        assert!(error.contains("Failed to create native runtime state directory"));
        assert_eq!(
            retired,
            vec![("/tmp/project".to_string(), actor_b.to_string())]
        );
        assert!(
            handle
                .record
                .lock()
                .expect("handle record after failed persistence")
                .browser_actor_id
                .is_empty(),
            "the live helper route must fail closed even when persistence fails"
        );
        assert!(manager
            .records
            .lock()
            .expect("records")
            .get(runtime_b)
            .expect("runtime B record")
            .browser_actor_id
            .is_empty());

        let _ = fs::remove_file(blocked_parent);
    }

    #[test]
    fn conflicting_late_lineage_still_retires_when_handle_registry_is_poisoned() {
        let runtime_a = "native-late-retire-poison-a";
        let runtime_b = "native-late-retire-poison-b";
        let actor_a = "browser-actor-11111111111111111111111111111111";
        let actor_b = "browser-actor-22222222222222222222222222222222";
        let mut record_a = native_record(runtime_a, "ready", true);
        record_a.provider_session_id = Some("shared-provider-session".to_string());
        record_a.browser_actor_id = actor_a.to_string();
        let mut record_b = native_record(runtime_b, "ready", true);
        record_b.browser_actor_id = actor_b.to_string();
        let manager = manager_with_records(runtime_b, vec![record_a, record_b]);

        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _handles = manager.handles.lock().expect("handles before poison");
            panic!("poison native handle registry");
        }));
        assert!(poisoned.is_err());

        let mut retired = Vec::new();
        let error = manager
            .bind_provider_session_lineage_with_retirement(
                runtime_b,
                "shared-provider-session",
                |workspace, actor_id| {
                    retired.push((workspace.to_string(), actor_id.to_string()));
                    Ok(())
                },
            )
            .expect_err("poisoned handle registry must remain observable");

        assert!(error.contains("Failed to lock native runtime handles"));
        assert_eq!(
            retired,
            vec![("/tmp/project".to_string(), actor_b.to_string())]
        );
        assert!(manager
            .records
            .lock()
            .expect("records")
            .get(runtime_b)
            .expect("runtime B record")
            .browser_actor_id
            .is_empty());

        let _ = fs::remove_file(&manager.state_path);
    }

    #[test]
    fn insert_record_reuses_one_opaque_actor_for_the_same_provider_conversation() {
        let runtime_a = "native-browser-actor-a";
        let runtime_b = "native-browser-actor-b";
        let raw_provider_session_id = "raw-provider-session-id";
        let mut first = native_record(runtime_a, "ready", true);
        first.provider_session_id = Some(raw_provider_session_id.to_string());
        first.browser_actor_id = "browser-actor-11111111111111111111111111111111".to_string();
        let manager = manager_with_records(runtime_b, vec![first.clone()]);
        let mut resumed = native_record(runtime_b, "initializing", true);
        resumed.provider_session_id = Some(raw_provider_session_id.to_string());
        resumed.browser_actor_id = "browser-actor-22222222222222222222222222222222".to_string();

        let inserted = manager
            .insert_record(resumed)
            .expect("insert resumed record");

        assert_eq!(inserted.browser_actor_id, first.browser_actor_id);
        assert!(!inserted.browser_actor_id.contains(raw_provider_session_id));
        let persisted = read_native_runtime_state_from(&manager.state_path).expect("read state");
        assert!(persisted
            .sessions
            .iter()
            .all(|record| record.browser_actor_id == first.browser_actor_id));

        let _ = fs::remove_file(&manager.state_path);
    }

    #[test]
    fn conflicting_actor_lineages_for_one_provider_conversation_fail_closed() {
        let raw_provider_session_id = "raw-provider-session-id";
        let error = super::resolve_browser_actor_id(
            NativeProvider::Claude,
            Some(raw_provider_session_id),
            "browser-actor-33333333333333333333333333333333",
            &[
                super::BrowserActorLineageRef {
                    provider: NativeProvider::Claude,
                    provider_session_id: Some(raw_provider_session_id),
                    actor_id: "browser-actor-11111111111111111111111111111111",
                },
                super::BrowserActorLineageRef {
                    provider: NativeProvider::Claude,
                    provider_session_id: Some(raw_provider_session_id),
                    actor_id: "browser-actor-22222222222222222222222222222222",
                },
            ],
        )
        .expect_err("conflicting lineage must fail closed");

        assert_eq!(error, "Native browser actor lineage is conflicting.");
        assert!(!error.contains(raw_provider_session_id));
    }

    #[test]
    fn read_state_backfills_a_stable_opaque_actor_for_pre_lineage_records() {
        let runtime_a = "native-legacy-runtime-a";
        let runtime_b = "native-legacy-runtime-b";
        let raw_provider_session_id = "raw-provider-session-id";
        let mut record_a = native_record(runtime_a, "ready", false);
        record_a.provider_session_id = Some(raw_provider_session_id.to_string());
        let mut record_b = native_record(runtime_b, "ready", true);
        record_b.provider_session_id = Some(raw_provider_session_id.to_string());
        let state_path = std::env::temp_dir().join(format!(
            "ccem-native-runtime-browser-actor-state-{}.json",
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        ));
        let mut serialized = serde_json::to_value(serde_json::json!({
            "sessions": [record_a, record_b],
        }))
        .expect("serialize state");
        for session in serialized["sessions"]
            .as_array_mut()
            .expect("sessions array")
        {
            session
                .as_object_mut()
                .expect("session object")
                .remove("browser_actor_id");
        }
        fs::write(
            &state_path,
            serde_json::to_vec(&serialized).expect("encode state"),
        )
        .expect("write state");

        let first = read_native_runtime_state_from(&state_path).expect("first read");
        let second = read_native_runtime_state_from(&state_path).expect("second read");
        let actor_id = &first.sessions[0].browser_actor_id;

        assert_eq!(actor_id, &second.sessions[0].browser_actor_id);
        assert_eq!(actor_id, &first.sessions[1].browser_actor_id);
        assert_eq!(actor_id, &second.sessions[1].browser_actor_id);
        assert!(super::is_valid_browser_actor_id(actor_id));
        assert!(!actor_id.contains(runtime_a));
        assert!(!actor_id.contains(runtime_b));
        assert!(!actor_id.contains(raw_provider_session_id));

        let _ = fs::remove_file(state_path);
    }

    #[test]
    fn malformed_persisted_provider_identity_quarantines_browser_authority() {
        let raw_invalid = format!(
            "provider-{}",
            "x".repeat(super::MAX_PROVIDER_SESSION_ID_BYTES + 1)
        );
        let mut record = native_record("native-invalid-lineage", "ready", true);
        record.provider_session_id = Some(raw_invalid.clone());
        record.browser_actor_id = "browser-actor-11111111111111111111111111111111".to_string();

        super::backfill_browser_actor_lineages(std::slice::from_mut(&mut record));

        assert!(record.browser_actor_id.is_empty());
        assert!(!record.browser_actor_id.contains(&raw_invalid));
    }

    #[test]
    fn native_runtime_state_temp_paths_are_unique_per_write() {
        let state_path = std::env::temp_dir().join("ccem-native-runtime-state-test.json");

        let first = native_runtime_state_temp_file_path(&state_path);
        let second = native_runtime_state_temp_file_path(&state_path);

        assert_ne!(first, second);
        assert_eq!(first.parent(), state_path.parent());
        assert_eq!(second.parent(), state_path.parent());
        assert!(first
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.contains("ccem-native-runtime-state-test.json")));
    }

    #[test]
    fn helper_output_buffers_partial_json_until_newline() {
        let mut buffer = Vec::new();
        let first = drain_helper_output_lines(&mut buffer, br#"{"type":"status","status":"ready""#);
        assert!(first.is_empty());

        let second = drain_helper_output_lines(
            &mut buffer,
            br#","detail":"ok"}
{"type":"status","status":"processing","detail":"go"}
"#,
        );

        assert_eq!(
            second,
            vec![
                r#"{"type":"status","status":"ready","detail":"ok"}"#.to_string(),
                r#"{"type":"status","status":"processing","detail":"go"}"#.to_string(),
            ]
        );
    }

    #[test]
    fn helper_init_serializes_initial_images_for_first_turn() {
        let env_vars = HashMap::new();
        let images = vec![PromptImage {
            media_type: "image/png".to_string(),
            base64_data: "iVBORw0KGgo=".to_string(),
            placeholder: Some("[Image #1]".to_string()),
        }];

        let command = HelperInputCommand::Init {
            provider: "claude",
            env_name: "default",
            perm_mode: "dev",
            allow_dangerously_skip_permissions: false,
            working_dir: "/tmp/project",
            env_vars: &env_vars,
            initial_prompt: Some("describe this"),
            initial_images: Some(images.as_slice()),
            provider_session_id: None,
            claude_path: None,
            codex_path: None,
            codex_base_url: None,
            codex_api_key: None,
            effort: None,
            todo_snapshot_seed: None,
        };

        let serialized = serde_json::to_value(command).expect("serialize init command");
        assert_eq!(serialized["initial_prompt"], "describe this");
        assert_eq!(serialized["initial_images"][0]["mediaType"], "image/png");
        assert_eq!(
            serialized["initial_images"][0]["base64Data"],
            "iVBORw0KGgo="
        );
        assert_eq!(serialized["initial_images"][0]["placeholder"], "[Image #1]");
    }

    #[test]
    fn helper_init_serializes_todo_snapshot_seed_for_reconnect() {
        let env_vars = HashMap::new();
        let seed = TodoSnapshotV1 {
            version: 1,
            provider: "claude".to_string(),
            source: "TaskList".to_string(),
            revision: 7,
            items: vec![TodoSnapshotItemV1 {
                id: "task-1".to_string(),
                text: "Preserve this task".to_string(),
                status: "pending".to_string(),
                active_text: None,
            }],
        };
        let command = HelperInputCommand::Init {
            provider: "claude",
            env_name: "default",
            perm_mode: "dev",
            allow_dangerously_skip_permissions: false,
            working_dir: "/tmp/project",
            env_vars: &env_vars,
            initial_prompt: None,
            initial_images: None,
            provider_session_id: Some("provider-session"),
            claude_path: None,
            codex_path: None,
            codex_base_url: None,
            codex_api_key: None,
            effort: None,
            todo_snapshot_seed: Some(&seed),
        };

        let serialized = serde_json::to_value(command).expect("serialize init command");
        assert_eq!(serialized["todo_snapshot_seed"]["revision"], 7);
        assert_eq!(
            serialized["todo_snapshot_seed"]["items"][0]["text"],
            "Preserve this task"
        );
    }

    #[test]
    fn helper_init_can_enable_later_bypass_restore_while_starting_in_plan() {
        let env_vars = HashMap::new();
        let command = HelperInputCommand::Init {
            provider: "claude",
            env_name: "default",
            perm_mode: "plan",
            allow_dangerously_skip_permissions: true,
            working_dir: "/tmp/project",
            env_vars: &env_vars,
            initial_prompt: None,
            initial_images: None,
            provider_session_id: None,
            claude_path: None,
            codex_path: None,
            codex_base_url: None,
            codex_api_key: None,
            effort: None,
            todo_snapshot_seed: None,
        };

        let serialized = serde_json::to_value(command).expect("serialize init command");
        assert_eq!(serialized["perm_mode"], "plan");
        assert_eq!(serialized["allow_dangerously_skip_permissions"], true);
    }

    #[test]
    fn yolo_session_started_in_runtime_plan_mode_keeps_bypass_available() {
        let options = native_session_options("yolo", Some("plan"));

        assert!(native_session_allows_dangerously_skip_permissions(&options));
    }

    #[test]
    fn non_yolo_plan_session_does_not_enable_bypass_restore() {
        let options = native_session_options("dev", Some("plan"));

        assert!(!native_session_allows_dangerously_skip_permissions(
            &options
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn terminal_handoff_preparation_preserves_desktop_terminal_env() {
        let runtime_id = "native-handoff-terminal-env";
        let mut record = native_record(runtime_id, "ready", true);
        record.provider_session_id = Some("provider-session-bridge".to_string());
        let mut terminal_env_vars = HashMap::new();
        terminal_env_vars.insert("CCEM_RUNTIME_ID".to_string(), runtime_id.to_string());
        terminal_env_vars.insert("CCEM_SESSION_ID".to_string(), runtime_id.to_string());
        terminal_env_vars.insert(
            "CCEM_TEST_DESKTOP_PERMISSION_BRIDGE".to_string(),
            "connected".to_string(),
        );
        let handle = native_session_handle_with_terminal_env(record.clone(), terminal_env_vars);
        let manager = NativeRuntimeManager {
            records: Mutex::new(HashMap::from([(runtime_id.to_string(), record)])),
            handles: Mutex::new(HashMap::from([(runtime_id.to_string(), handle)])),
            permission_quarantine_fences: Mutex::new(HashSet::new()),
            permission_transactions: Mutex::new(HashMap::new()),
            lifecycle_transactions: Mutex::new(HashMap::new()),
            next_handle_generation: AtomicU64::new(2),
            state_path: std::env::temp_dir().join(format!(
                "ccem-native-runtime-terminal-env-test-{runtime_id}.json"
            )),
            event_log: NativeEventLog::new(std::env::temp_dir().join(format!(
                "ccem-native-runtime-terminal-env-test-{runtime_id}.sqlite"
            ))),
            prompt_image_store: PromptImageStore::new(std::env::temp_dir().join(format!(
                "ccem-native-runtime-terminal-env-test-{runtime_id}-attachments"
            ))),
        };

        let handoff = manager
            .prepare_terminal_handoff(runtime_id, Some(crate::terminal::TerminalType::TerminalApp))
            .expect("handoff should be ready");

        assert_eq!(handoff.resume_session_id, "provider-session-bridge");
        assert_eq!(handoff.runtime_id, runtime_id);
        assert_eq!(
            handoff.env_vars.get("CCEM_RUNTIME_ID").map(String::as_str),
            Some(runtime_id)
        );
        assert_eq!(
            handoff.env_vars.get("CCEM_SESSION_ID").map(String::as_str),
            Some(runtime_id)
        );
        assert_eq!(
            handoff
                .env_vars
                .get("CCEM_TEST_DESKTOP_PERMISSION_BRIDGE")
                .map(String::as_str),
            Some("connected")
        );
    }

    #[test]
    fn native_user_prompt_events_are_replayable() {
        let runtime_id = format!(
            "native-user-prompt-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let manager = manager_with_handle(&runtime_id);
        let images = vec![PromptImage {
            media_type: "image/png".to_string(),
            base64_data: "iVBORw0KGgo=".to_string(),
            placeholder: Some("[Image #1]".to_string()),
        }];
        let prompt_annotations = vec![SessionPromptAnnotation {
            quote: "selected code".to_string(),
            note: "keep the user input visible".to_string(),
        }];

        manager
            .append_user_prompt_event(
                &runtime_id,
                "continue",
                Some(&images),
                Some(&prompt_annotations),
            )
            .expect("append user prompt event");

        let batch = manager
            .replay_events(&runtime_id, None)
            .expect("replay events");

        assert_eq!(batch.events.len(), 1);
        let SessionEventPayload::UserPrompt {
            text,
            image_count,
            images,
            annotations,
            canonical_hash,
        } = &batch.events[0].payload
        else {
            panic!("expected user prompt event");
        };
        assert_eq!(text, "continue");
        assert_eq!(*image_count, 1);
        assert_eq!(annotations, &Some(prompt_annotations));
        assert_eq!(canonical_hash.as_deref().map(str::len), Some(64));
        let image = images
            .as_ref()
            .and_then(|items| items.first())
            .expect("stored prompt image");
        assert_eq!(image.media_type, "image/png");
        assert_eq!(image.base64_data, None);
        assert_eq!(image.byte_size, Some(8));
        assert_eq!(image.placeholder.as_deref(), Some("[Image #1]"));
        assert_eq!(image.sha256.as_deref().map(str::len), Some(64));
        let storage_path = image
            .storage_path
            .as_deref()
            .expect("stored prompt image path");
        assert!(storage_path.ends_with(".png"));
        assert_eq!(
            manager
                .prompt_image_store
                .read_data_url(storage_path, &image.media_type)
                .expect("read stored prompt image"),
            "data:image/png;base64,iVBORw0KGgo="
        );

        let persisted_json = serde_json::to_value(&batch.events[0].payload)
            .expect("serialize persisted user prompt event");
        assert!(persisted_json["images"][0].get("base64Data").is_none());
        assert_eq!(
            persisted_json["images"][0]["storagePath"],
            serde_json::Value::String(storage_path.to_string())
        );
        assert_eq!(
            persisted_json["canonical_hash"].as_str().map(str::len),
            Some(64)
        );
    }

    #[test]
    fn native_user_prompt_rejects_annotation_overflow_without_persisting_an_event() {
        let runtime_id = format!(
            "native-user-prompt-annotation-limit-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let manager = manager_with_handle(&runtime_id);
        let annotations = (0..21)
            .map(|index| SessionPromptAnnotation {
                quote: format!("quote {index}"),
                note: format!("note {index}"),
            })
            .collect::<Vec<_>>();

        let error = manager
            .append_user_prompt_event(&runtime_id, "continue", None, Some(&annotations))
            .expect_err("annotation overflow must fail");

        assert!(error.contains("at most 20 annotations"));
        assert!(manager
            .replay_events(&runtime_id, None)
            .expect("replay events")
            .events
            .is_empty());
    }

    #[test]
    fn native_session_summary_preserves_seed_boundary_message_count() {
        let runtime_id = "native-seed-boundary-summary";
        let mut record = native_record(runtime_id, "processing", true);
        record.provider_session_id = Some("provider-session-1".to_string());
        record.seed_boundary_message_count = Some(12);
        let manager = manager_with_records(runtime_id, vec![record]);

        let summary = manager.summary_for(runtime_id).expect("summary");

        assert_eq!(summary.seed_boundary_message_count, Some(12));
    }

    #[test]
    fn interactive_prompt_response_is_replayable_as_user_prompt() {
        let runtime_id = format!(
            "native-interactive-response-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let manager = manager_with_handle(&runtime_id);
        let answers = HashMap::from([("Pick one".to_string(), "Use the SQLite path".to_string())]);
        let prompt_annotations = vec![SessionPromptAnnotation {
            quote: "current query".to_string(),
            note: "keep the response visible".to_string(),
        }];

        manager
            .append_interactive_prompt_response_event(
                &runtime_id,
                Some("Use the SQLite path"),
                &answers,
                Some(&prompt_annotations),
            )
            .expect("append interactive response event");

        let batch = manager
            .replay_events(&runtime_id, None)
            .expect("replay events");

        assert_eq!(batch.events.len(), 1);
        let SessionEventPayload::UserPrompt {
            text,
            image_count,
            images,
            annotations,
            canonical_hash,
        } = &batch.events[0].payload
        else {
            panic!("expected user prompt event");
        };
        assert_eq!(text, "Use the SQLite path");
        assert_eq!(*image_count, 0);
        assert_eq!(images, &None);
        assert_eq!(annotations, &Some(prompt_annotations));
        assert_eq!(canonical_hash.as_deref().map(str::len), Some(64));
    }

    #[test]
    fn failed_interactive_prompt_delivery_does_not_persist_a_user_prompt() {
        let runtime_id = format!(
            "native-interactive-response-failed-write-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let manager = manager_with_handle(&runtime_id);
        let answers = HashMap::from([("Pick one".to_string(), "Use SQLite".to_string())]);
        let prompt_annotations = vec![SessionPromptAnnotation {
            quote: "current query".to_string(),
            note: "only persist after delivery".to_string(),
        }];

        let error = manager
            .deliver_and_append_interactive_prompt_response(
                &runtime_id,
                Some("Use SQLite"),
                &answers,
                Some(&prompt_annotations),
                || Err("Failed to write to native sidecar stdin: Broken pipe".to_string()),
            )
            .expect_err("failed helper delivery must be returned");

        assert!(error.contains("Broken pipe"));
        assert!(manager
            .replay_events(&runtime_id, None)
            .expect("replay events")
            .events
            .is_empty());
    }

    #[test]
    fn helper_stop_serializes_shutdown_command() {
        let serialized = serde_json::to_value(HelperInputCommand::Stop).expect("serialize stop");

        assert_eq!(serialized["type"], "stop");
    }

    #[test]
    fn helper_rewind_files_serializes_checkpoint_command() {
        let serialized = serde_json::to_value(HelperInputCommand::RewindFiles {
            checkpoint_id: "checkpoint-1",
        })
        .expect("serialize rewind files");

        assert_eq!(serialized["type"], "rewind_files");
        assert_eq!(serialized["checkpoint_id"], "checkpoint-1");
    }

    #[test]
    fn helper_update_settings_serializes_correlated_request_id() {
        let serialized = serde_json::to_value(HelperInputCommand::UpdateSettings {
            request_id: "settings-request-serialization",
            env_name: None,
            perm_mode: Some("readonly"),
            env_vars: None,
            effort: None,
        })
        .expect("serialize settings update");

        assert_eq!(serialized["type"], "update_settings");
        assert_eq!(serialized["request_id"], "settings-request-serialization");
        assert_eq!(serialized["perm_mode"], "readonly");
    }

    #[test]
    fn file_rewind_is_limited_to_idle_like_native_statuses() {
        for status in ["idle", "ready", "interrupted", "closed_idle"] {
            assert!(native_status_allows_file_rewind(status), "{status}");
        }
        for status in [
            "initializing",
            "processing",
            "handoff_pending",
            "handoff",
            "stopped",
            "error",
        ] {
            assert!(!native_status_allows_file_rewind(status), "{status}");
        }
    }

    #[test]
    fn reconcile_stale_records_marks_active_records_interrupted() {
        let manager = manager_with_records(
            "native-reconcile",
            vec![
                native_record("native-reconcile-active", "processing", true),
                native_record("native-reconcile-stopped", "stopped", false),
                native_record("native-reconcile-idle", "idle", true),
            ],
        );

        let reconciled = manager
            .reconcile_stale_records()
            .expect("reconcile stale records");

        assert_eq!(reconciled, 2);
        let active = manager
            .summary_for("native-reconcile-active")
            .expect("active summary");
        let stopped = manager
            .summary_for("native-reconcile-stopped")
            .expect("stopped summary");
        let idle = manager
            .summary_for("native-reconcile-idle")
            .expect("idle summary");

        assert_eq!(active.status, "interrupted");
        assert!(!active.is_active);
        assert_eq!(stopped.status, "stopped");
        assert!(!stopped.is_active);
        assert_eq!(idle.status, "idle");
        assert!(!idle.is_active);
    }

    #[test]
    fn summary_includes_persisted_effort() {
        let mut record = native_record("native-effort", "ready", true);
        record.effort = Some("max".to_string());
        let manager = manager_with_records("native-effort", vec![record]);

        let summary = manager.summary_for("native-effort").expect("summary");

        assert_eq!(summary.effort.as_deref(), Some("max"));
    }

    #[test]
    fn status_error_keeps_last_error_when_late_processing_arrives() {
        let runtime_id = "native-status-error";
        let manager = manager_with_handle(runtime_id);

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"status","status":"error","detail":"Native CLI binary not found"}"#,
            )
            .expect("process error status");
        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"status","status":"processing","detail":"Claude is processing a turn."}"#,
            )
            .expect("ignore late processing");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "error");
        assert!(!summary.is_active);
        assert_eq!(
            summary.last_error.as_deref(),
            Some("Native CLI binary not found")
        );
    }

    #[test]
    fn provider_sigkill_error_is_recoverable_after_session_meta() {
        let runtime_id = "native-provider-sigkill";
        let manager = manager_with_handle(runtime_id);
        manager
            .update_record(runtime_id, |record| {
                record.provider_session_id = Some("provider-session-1".to_string());
                record.can_handoff_to_terminal = true;
                record.status = "processing".to_string();
                record.is_active = true;
            })
            .expect("set processing record");

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"status","status":"error","detail":"Claude Code process terminated by signal SIGKILL"}"#,
            )
            .expect("process recoverable error status");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "interrupted");
        assert!(!summary.is_active);
        assert_eq!(
            summary.last_error.as_deref(),
            Some("Claude Code process terminated by signal SIGKILL")
        );
    }

    #[test]
    fn provider_sigkill_without_session_meta_stays_error() {
        let runtime_id = "native-provider-startup-sigkill";
        let manager = manager_with_handle(runtime_id);

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"status","status":"error","detail":"Claude Code process terminated by signal SIGKILL"}"#,
            )
            .expect("process error status");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "error");
        assert!(!summary.is_active);
        assert_eq!(
            summary.last_error.as_deref(),
            Some("Claude Code process terminated by signal SIGKILL")
        );
    }

    #[test]
    fn child_write_failures_replay_only_when_non_delivery_is_proven() {
        assert!(is_retryable_native_child_write_error(
            "Native sidecar child is not available"
        ));
        assert!(!is_retryable_native_child_write_error(
            "Failed to write to native sidecar stdin: Broken pipe"
        ));
        assert!(!is_retryable_native_child_write_error(
            "Native helper stdin write timed out."
        ));
        assert!(is_retryable_native_child_write_error(
            "Native helper writer queue is full; command was not delivered."
        ));
        assert!(!is_retryable_native_child_write_error(
            "Failed to encode helper command: invalid payload"
        ));
        assert!(is_unknown_native_child_delivery_error(
            "Failed to write to native sidecar stdin: Broken pipe"
        ));
        assert!(is_unknown_native_child_delivery_error(
            "Native helper stdin write timed out."
        ));
        assert!(!is_unknown_native_child_delivery_error(
            "Native helper writer queue is full; command was not delivered."
        ));
    }

    #[test]
    fn terminal_launch_capture_is_isolated_between_parallel_test_threads() {
        clear_terminal_launches();
        let launch_barrier = Arc::new(Barrier::new(3));

        let launch_and_take = |runtime_id: &'static str| {
            let launch_barrier = Arc::clone(&launch_barrier);
            std::thread::spawn(move || {
                launch_terminal_for_native_handoff(
                    crate::terminal::TerminalType::TerminalApp,
                    HashMap::new(),
                    "/tmp/project",
                    runtime_id,
                    "official",
                    Some("dev"),
                    None,
                    "claude",
                )
                .expect("capture terminal launch");
                launch_barrier.wait();

                let launches = take_terminal_launches();
                assert_eq!(launches.len(), 1);
                assert_eq!(launches[0].runtime_id, runtime_id);
            })
        };

        let first = launch_and_take("parallel-terminal-capture-a");
        let second = launch_and_take("parallel-terminal-capture-b");
        launch_barrier.wait();
        first.join().expect("first capture thread");
        second.join().expect("second capture thread");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn handoff_without_provider_session_waits_for_session_meta() {
        let runtime_id = "native-fresh-handoff";
        let manager = manager_with_handle(runtime_id);
        clear_terminal_launches();

        manager
            .handoff_to_terminal(runtime_id, Some(crate::terminal::TerminalType::TerminalApp))
            .expect("handoff should enter pending state");

        assert!(take_terminal_launches().is_empty());

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "handoff_pending");
        assert!(summary.is_active);
        assert_eq!(summary.provider_session_id, None);
        assert!(manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .is_some());
    }

    #[test]
    fn session_meta_completes_pending_handoff_with_resume_id() {
        let runtime_id = "native-pending-handoff";
        let manager = manager_with_handle(runtime_id);
        clear_terminal_launches();
        manager
            .update_record(runtime_id, |record| {
                record.status = "handoff_pending".to_string();
                record.pending_handoff_terminal = Some(crate::terminal::TerminalType::TerminalApp);
            })
            .expect("set pending handoff");

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"session_meta","provider_session_id":"provider-session-1"}"#,
            )
            .expect("process session meta");

        let launches = take_terminal_launches();
        assert_eq!(launches.len(), 1);
        assert_eq!(
            launches[0].resume_session_id.as_deref(),
            Some("provider-session-1")
        );
        assert_eq!(launches[0].runtime_id, runtime_id);
        assert_eq!(launches[0].perm_mode.as_deref(), Some("dev"));

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "handoff");
        assert!(!summary.is_active);
        assert_eq!(
            summary.provider_session_id.as_deref(),
            Some("provider-session-1")
        );
        assert!(manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .is_none());

        let runtime_id = "native-pending-handoff-runtime-perm";
        let manager = manager_with_handle(runtime_id);
        clear_terminal_launches();
        manager
            .update_record(runtime_id, |record| {
                record.status = "handoff_pending".to_string();
                record.perm_mode = "yolo".to_string();
                record.runtime_perm_mode = Some("plan".to_string());
                record.pending_handoff_terminal = Some(crate::terminal::TerminalType::TerminalApp);
            })
            .expect("set pending handoff");

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"session_meta","provider_session_id":"provider-session-2"}"#,
            )
            .expect("process session meta");

        let launches = take_terminal_launches();
        assert_eq!(launches.len(), 1);
        assert_eq!(
            launches[0].resume_session_id.as_deref(),
            Some("provider-session-2")
        );
        assert_eq!(launches[0].runtime_id, runtime_id);
        assert_eq!(launches[0].perm_mode.as_deref(), Some("plan"));

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "handoff");
        assert!(!summary.is_active);
        assert_eq!(
            summary.provider_session_id.as_deref(),
            Some("provider-session-2")
        );
    }

    #[test]
    fn pending_handoff_exit_reconnect_session_meta_does_not_launch_old_terminal() {
        let runtime_id = "native-pending-handoff-exit-reconnect";
        let manager = manager_with_handle(runtime_id);
        clear_terminal_launches();
        manager
            .update_record(runtime_id, |record| {
                record.status = "handoff_pending".to_string();
                record.is_active = true;
                record.can_handoff_to_terminal = true;
                record.pending_handoff_terminal = Some(crate::terminal::TerminalType::TerminalApp);
            })
            .expect("set pending handoff");
        let exited_handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("pending handoff handle")
            .clone();

        manager
            .mark_process_exit(runtime_id, Some(1), &exited_handle)
            .expect("mark pending helper exit");

        let exited = manager.summary_for(runtime_id).expect("exited summary");
        assert_eq!(exited.status, "error");
        assert!(!exited.is_active);
        assert!(!exited.can_handoff_to_terminal);
        let mut reconnected_record = manager
            .records
            .lock()
            .expect("records")
            .get(runtime_id)
            .expect("persisted exited record")
            .clone();
        assert_eq!(reconnected_record.pending_handoff_terminal, None);
        assert!(reactivate_record_for_reconnect(&mut reconnected_record));
        manager
            .update_record(runtime_id, |record| {
                *record = reconnected_record.clone();
            })
            .expect("persist reconnected record");
        manager
            .insert_handle(
                runtime_id.to_string(),
                native_session_handle_with_generation(reconnected_record, 2),
            )
            .expect("insert reconnected handle");

        manager
            .process_helper_stdout(
                runtime_id,
                r#"{"type":"session_meta","provider_session_id":"provider-session-after-reconnect"}"#,
            )
            .expect("process session meta after reconnect");

        assert!(
            take_terminal_launches().is_empty(),
            "stale pending handoff must not open a terminal after reconnect"
        );
        let summary = manager
            .summary_for(runtime_id)
            .expect("reconnected summary");
        assert_eq!(summary.status, "initializing");
        assert!(summary.is_active);
        assert_eq!(
            summary.provider_session_id.as_deref(),
            Some("provider-session-after-reconnect")
        );
        assert_eq!(
            manager
                .records
                .lock()
                .expect("records")
                .get(runtime_id)
                .expect("reconnected record")
                .pending_handoff_terminal,
            None
        );
    }

    #[test]
    fn stale_helper_exit_does_not_mark_reconnected_session_error() {
        let runtime_id = "native-stale-helper-exit";
        let manager = manager_with_handle(runtime_id);
        let stale_handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("stale handle")
            .clone();

        let replacement_record = native_record(runtime_id, "ready", true);
        let replacement_handle = native_session_handle_with_generation(replacement_record, 2);
        manager
            .replace_handle_for_test(runtime_id.to_string(), replacement_handle.clone())
            .expect("insert replacement handle");
        manager
            .update_record(runtime_id, |record| {
                record.status = "ready".to_string();
                record.is_active = true;
                record.last_error = None;
            })
            .expect("set reconnected record ready");

        manager
            .mark_process_exit(runtime_id, Some(1), &stale_handle)
            .expect("ignore stale exit");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "ready");
        assert!(summary.is_active);
        assert_eq!(summary.last_error, None);
        assert!(manager
            .is_current_handle(runtime_id, &replacement_handle)
            .expect("current handle check"));
    }

    #[test]
    fn stop_force_kill_removes_only_current_stopped_handle() {
        let runtime_id = "native-stop-force-kill";
        let manager = manager_with_handle(runtime_id);
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();
        handle.alive.store(false, Ordering::SeqCst);

        let removed = manager
            .force_kill_stopped_handle(runtime_id, &handle)
            .expect("force kill stopped handle");

        assert!(removed);
        assert!(!manager
            .is_current_handle(runtime_id, &handle)
            .expect("current handle check"));

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "interrupted");
        assert!(!summary.is_active);

        let replay = manager
            .replay_events_limited(runtime_id, None, None)
            .expect("replay events");
        assert!(replay.events.iter().any(|event| matches!(
            &event.payload,
            SessionEventPayload::Lifecycle { stage, .. } if stage == "stop_force_killed"
        )));
    }

    #[test]
    fn stop_force_kill_does_not_remove_replacement_handle() {
        let runtime_id = "native-stop-force-kill-stale";
        let manager = manager_with_handle(runtime_id);
        let stale_handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("stale handle")
            .clone();
        stale_handle.alive.store(false, Ordering::SeqCst);

        let replacement_record = native_record(runtime_id, "processing", true);
        let replacement_handle = native_session_handle_with_generation(replacement_record, 2);
        manager
            .replace_handle_for_test(runtime_id.to_string(), replacement_handle.clone())
            .expect("insert replacement handle");

        let removed = manager
            .force_kill_stopped_handle(runtime_id, &stale_handle)
            .expect("ignore stale stopped handle");

        assert!(!removed);
        assert!(manager
            .is_current_handle(runtime_id, &replacement_handle)
            .expect("current handle check"));
    }

    #[test]
    fn handle_generations_are_monotonic() {
        let manager = manager_with_records("native-handle-generation", Vec::new());

        let first = manager.allocate_handle_generation();
        let second = manager.allocate_handle_generation();
        let third = manager.allocate_handle_generation();

        assert_eq!(first, 1);
        assert_eq!(second, 2);
        assert_eq!(third, 3);
    }

    #[test]
    fn live_helper_owner_cannot_be_overwritten_by_a_concurrent_generation() {
        let runtime_id = "native-owner-cas";
        let manager = manager_with_handle(runtime_id);
        let original = manager
            .handles
            .lock()
            .unwrap()
            .get(runtime_id)
            .cloned()
            .unwrap();
        let replacement = native_session_handle_with_generation(
            native_record(runtime_id, "initializing", true),
            original.generation + 1,
        );

        assert!(manager
            .insert_handle(runtime_id.to_string(), replacement)
            .unwrap_err()
            .contains("live helper owner"));
        assert!(manager
            .is_current_handle(runtime_id, &original)
            .expect("current owner"));
    }

    #[test]
    fn runtime_quarantine_fence_survives_old_owner_removal_and_rejects_replacement() {
        let runtime_id = "native-quarantine-generation-fence";
        let manager = manager_with_handle(runtime_id);
        let original = manager
            .handles
            .lock()
            .unwrap()
            .get(runtime_id)
            .cloned()
            .unwrap();
        manager.fence_permission_quarantine_handle(runtime_id, &original);
        manager
            .remove_handle_if_current(runtime_id, &original)
            .expect("remove old generation after exit");
        let replacement = native_session_handle_with_generation(
            native_record(runtime_id, "initializing", true),
            original.generation + 1,
        );

        let error = manager
            .insert_handle(runtime_id.to_string(), replacement)
            .expect_err("runtime-level fence must reject every later generation");

        assert!(error.contains("quarantined"));
        assert!(manager.handles.lock().unwrap().get(runtime_id).is_none());
        assert!(manager.is_permission_quarantine_fenced(runtime_id));
    }

    #[test]
    fn lifecycle_guard_keeps_generation_stable_across_permission_commit_window() {
        let runtime_id = "native-permission-generation-stability";
        let manager = Arc::new(manager_with_handle(runtime_id));
        let handle = manager
            .handles
            .lock()
            .unwrap()
            .get(runtime_id)
            .cloned()
            .unwrap();
        let lifecycle = manager.lifecycle_transaction_lock(runtime_id).unwrap();
        let guard = lifecycle.lock().unwrap();
        let worker_manager = Arc::clone(&manager);
        let worker_handle = Arc::clone(&handle);
        let (started, started_rx) = mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            started.send(()).unwrap();
            worker_manager.mark_process_exit(runtime_id, Some(1), &worker_handle)
        });
        started_rx.recv().unwrap();
        std::thread::sleep(Duration::from_millis(30));

        assert!(manager.is_current_handle(runtime_id, &handle).unwrap());

        drop(guard);
        worker.join().unwrap().unwrap();
        assert!(!manager.is_current_handle(runtime_id, &handle).unwrap());
    }

    #[test]
    fn stop_source_normalization_keeps_lifecycle_details_bounded() {
        assert_eq!(super::normalize_stop_source(None), "unattributed");
        assert_eq!(
            super::normalize_stop_source(Some(" workspace_escape ")),
            "workspace_escape"
        );
        assert_eq!(
            super::normalize_stop_source(Some("native session stop button!")),
            "nativesessionstopbutton"
        );
        assert_eq!(super::normalize_stop_source(Some("!!!")), "unattributed");
    }

    #[test]
    fn mark_handle_live_rejects_stale_generation() {
        let runtime_id = "native-stale-handle-live-mark";
        let manager = manager_with_handle(runtime_id);
        let stale_handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("stale handle")
            .clone();
        stale_handle.alive.store(false, Ordering::SeqCst);

        let replacement_record = native_record(runtime_id, "processing", true);
        let replacement_handle = native_session_handle_with_generation(replacement_record, 2);
        replacement_handle.alive.store(false, Ordering::SeqCst);
        manager
            .replace_handle_for_test(runtime_id.to_string(), replacement_handle.clone())
            .expect("insert replacement handle");

        assert!(!manager
            .mark_handle_live_if_current(runtime_id, &stale_handle)
            .expect("stale live mark"));
        assert!(!stale_handle.alive.load(Ordering::SeqCst));

        assert!(manager
            .mark_handle_live_if_current(runtime_id, &replacement_handle)
            .expect("replacement live mark"));
        assert!(replacement_handle.alive.load(Ordering::SeqCst));
        assert!(manager
            .is_current_handle(runtime_id, &replacement_handle)
            .expect("current handle check"));
    }

    #[test]
    fn mark_handle_live_and_force_kill_race_has_only_safe_outcomes() {
        let runtime_id = "native-live-force-kill-race";
        let manager = Arc::new(manager_with_handle(runtime_id));
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();
        handle.alive.store(false, Ordering::SeqCst);

        let barrier = Arc::new(Barrier::new(3));

        let mark_manager = Arc::clone(&manager);
        let mark_barrier = Arc::clone(&barrier);
        let mark_handle = Arc::clone(&handle);
        let mark_runtime_id = runtime_id.to_string();
        let mark_thread = std::thread::spawn(move || {
            mark_barrier.wait();
            mark_manager
                .mark_handle_live_if_current(&mark_runtime_id, &mark_handle)
                .expect("mark handle live")
        });

        let kill_manager = Arc::clone(&manager);
        let kill_barrier = Arc::clone(&barrier);
        let kill_handle = Arc::clone(&handle);
        let kill_runtime_id = runtime_id.to_string();
        let kill_thread = std::thread::spawn(move || {
            kill_barrier.wait();
            kill_manager
                .force_kill_stopped_handle(&kill_runtime_id, &kill_handle)
                .expect("force kill stopped handle")
        });

        barrier.wait();
        let marked_live = mark_thread.join().expect("mark thread");
        let force_killed = kill_thread.join().expect("kill thread");

        assert_ne!(
            marked_live, force_killed,
            "exactly one race participant should win the stopped handle"
        );

        if marked_live {
            assert!(handle.alive.load(Ordering::SeqCst));
            assert!(manager
                .is_current_handle(runtime_id, &handle)
                .expect("current handle check"));
            let summary = manager.summary_for(runtime_id).expect("summary");
            assert_eq!(summary.status, "processing");
            assert!(summary.is_active);
        } else {
            assert!(force_killed);
            assert!(!manager
                .is_current_handle(runtime_id, &handle)
                .expect("current handle check"));
            let summary = manager.summary_for(runtime_id).expect("summary");
            assert_eq!(summary.status, "interrupted");
            assert!(!summary.is_active);
        }
    }

    #[test]
    fn stop_force_kill_does_not_remove_reused_live_handle() {
        let runtime_id = "native-stop-force-kill-reused";
        let manager = manager_with_handle(runtime_id);
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();
        handle.alive.store(true, Ordering::SeqCst);

        let removed = manager
            .force_kill_stopped_handle(runtime_id, &handle)
            .expect("skip live handle");

        assert!(!removed);
        assert!(manager
            .is_current_handle(runtime_id, &handle)
            .expect("current handle check"));
    }

    #[test]
    fn unexpected_helper_exit_after_provider_session_is_recoverable() {
        let runtime_id = "native-helper-reclaimed";
        let manager = manager_with_handle(runtime_id);
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();
        manager
            .update_record(runtime_id, |record| {
                record.provider_session_id = Some("provider-session-1".to_string());
                record.can_handoff_to_terminal = true;
                record.status = "ready".to_string();
                record.is_active = true;
            })
            .expect("set ready record");

        manager
            .mark_process_exit(runtime_id, Some(9), &handle)
            .expect("mark process exit");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "interrupted");
        assert!(!summary.is_active);
        assert_eq!(
            summary.last_error.as_deref(),
            Some("Native runtime sidecar exited unexpectedly with code 9.")
        );
        assert!(!manager
            .is_current_handle(runtime_id, &handle)
            .expect("current handle check"));
    }

    #[test]
    fn unexpected_helper_exit_before_provider_session_stays_error() {
        let runtime_id = "native-helper-startup-crash";
        let manager = manager_with_handle(runtime_id);
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();

        manager
            .mark_process_exit(runtime_id, Some(1), &handle)
            .expect("mark process exit");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "error");
        assert!(!summary.is_active);
        assert_eq!(
            summary.last_error.as_deref(),
            Some("Native runtime sidecar exited unexpectedly with code 1.")
        );
    }

    #[test]
    fn interrupted_helper_exit_keeps_recoverable_status() {
        let runtime_id = "native-interrupted-helper-exit";
        let manager = manager_with_handle(runtime_id);
        let handle = manager
            .handles
            .lock()
            .expect("handles")
            .get(runtime_id)
            .expect("handle")
            .clone();
        manager
            .update_record(runtime_id, |record| {
                record.provider_session_id = Some("provider-session-1".to_string());
                record.status = "interrupted".to_string();
                record.is_active = false;
                record.last_error = Some("Turn interrupted.".to_string());
            })
            .expect("set interrupted record");

        manager
            .mark_process_exit(runtime_id, Some(9), &handle)
            .expect("mark process exit");

        let summary = manager.summary_for(runtime_id).expect("summary");
        assert_eq!(summary.status, "interrupted");
        assert!(!summary.is_active);
        assert_eq!(summary.last_error.as_deref(), Some("Turn interrupted."));
    }

    #[test]
    fn closed_idle_record_reconnects_like_recoverable_terminal_status() {
        let mut record = native_record("native-closed-idle-reconnect", "closed_idle", false);

        assert!(super::is_native_terminal_status(&record.status));
        assert!(reactivate_record_for_reconnect(&mut record));
        assert_eq!(record.status, "initializing");
        assert!(record.is_active);
    }

    #[test]
    fn reconnect_reactivates_error_record_for_user_continue() {
        let mut record = native_record("native-reactivate-error", "error", false);
        record.last_error = Some("Native runtime sidecar exited unexpectedly.".to_string());

        assert!(reactivate_record_for_reconnect(&mut record));
        assert_eq!(record.status, "initializing");
        assert!(record.is_active);
        assert_eq!(record.last_error, None);
    }

    #[test]
    fn helper_env_path_preserves_api_vars_and_adds_user_path() {
        let mut env_vars = HashMap::from([(
            "ANTHROPIC_AUTH_TOKEN".to_string(),
            "secret-token".to_string(),
        )]);

        merge_helper_env_path(
            &mut env_vars,
            "/Users/test/.nvm/versions/node/v22/bin:/usr/bin",
        );

        assert_eq!(
            env_vars.get("ANTHROPIC_AUTH_TOKEN").map(String::as_str),
            Some("secret-token")
        );
        assert_eq!(
            env_vars.get("PATH").map(String::as_str),
            Some("/Users/test/.nvm/versions/node/v22/bin:/usr/bin")
        );
    }

    #[test]
    fn helper_env_path_prepends_user_path_to_existing_path() {
        let (existing_path, user_path, expected_path) = if cfg!(windows) {
            (
                r"C:\custom\bin",
                r"D:\Users\test\AppData\Roaming\npm;C:\Program Files\nodejs",
                r"D:\Users\test\AppData\Roaming\npm;C:\Program Files\nodejs;C:\custom\bin",
            )
        } else {
            (
                "/custom/bin",
                "/Users/test/.nvm/versions/node/v22/bin:/usr/bin",
                "/Users/test/.nvm/versions/node/v22/bin:/usr/bin:/custom/bin",
            )
        };
        let mut env_vars = HashMap::from([("PATH".to_string(), existing_path.to_string())]);

        merge_helper_env_path(&mut env_vars, user_path);

        assert_eq!(
            env_vars.get("PATH").map(String::as_str),
            Some(expected_path)
        );
    }

    #[test]
    fn helper_env_path_merges_windows_paths_without_splitting_drive_letters() {
        assert_eq!(
            merge_path_values_with_separator(
                r"D:\Users\test\AppData\Roaming\npm;C:\Program Files\nodejs",
                r"C:\custom\bin;D:\Users\test\AppData\Roaming\npm",
                ';'
            ),
            r"D:\Users\test\AppData\Roaming\npm;C:\Program Files\nodejs;C:\custom\bin"
        );
    }
}
