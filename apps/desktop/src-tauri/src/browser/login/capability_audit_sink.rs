use super::{safe_policy_code, AuditFailure, AuditPreRecord, AuditResultRecord, SemanticAuditSink};
use crate::browser::login::policy::BrowserGrantBinding;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const DEFAULT_AUDIT_MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const DEFAULT_AUDIT_ROTATIONS: usize = 3;
const MAX_AUDIT_RECORD_BYTES: usize = 64 * 1024;

/// Durable JSONL audit sink for production wiring. Every append is flushed with `sync_data`.
pub(in crate::browser::login) struct JsonlSemanticAuditSink {
    path: PathBuf,
    write_lock: Mutex<()>,
    max_file_bytes: u64,
    rotations: usize,
}

impl JsonlSemanticAuditSink {
    pub(in crate::browser::login) fn new(path: impl Into<PathBuf>) -> Self {
        Self::with_limits(path, DEFAULT_AUDIT_MAX_FILE_BYTES, DEFAULT_AUDIT_ROTATIONS)
    }

    pub(super) fn with_limits(
        path: impl Into<PathBuf>,
        max_file_bytes: u64,
        rotations: usize,
    ) -> Self {
        debug_assert!(max_file_bytes >= 1024);
        debug_assert!((1..=16).contains(&rotations));
        Self {
            path: path.into(),
            write_lock: Mutex::new(()),
            max_file_bytes,
            rotations,
        }
    }

    fn append<T: Serialize>(&self, phase: &'static str, record: &T) -> Result<(), AuditFailure> {
        #[derive(Serialize)]
        struct Envelope<'a, T> {
            phase: &'static str,
            record: &'a T,
        }

        let _guard = self.write_lock.lock().map_err(|_| AuditFailure)?;
        let parent = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .ok_or(AuditFailure)?;
        ensure_audit_directory(parent)?;
        reject_audit_symlink(&self.path)?;
        let mut line = serde_json::to_vec(&Envelope { phase, record }).map_err(|_| AuditFailure)?;
        if line.len().saturating_add(1) > MAX_AUDIT_RECORD_BYTES
            || line.len().saturating_add(1) as u64 > self.max_file_bytes
        {
            return Err(AuditFailure);
        }
        line.push(b'\n');
        let current_size = fs::metadata(&self.path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if current_size.saturating_add(line.len() as u64) > self.max_file_bytes {
            self.rotate()?;
        }
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(&self.path).map_err(|_| AuditFailure)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|_| AuditFailure)?;
        }
        file.write_all(&line).map_err(|_| AuditFailure)?;
        file.sync_data().map_err(|_| AuditFailure)?;
        sync_audit_directory(parent)
    }

    fn rotate(&self) -> Result<(), AuditFailure> {
        let parent = self.path.parent().ok_or(AuditFailure)?;
        for index in (1..=self.rotations).rev() {
            let source = if index == 1 {
                self.path.clone()
            } else {
                rotated_audit_path(&self.path, index - 1)
            };
            let target = rotated_audit_path(&self.path, index);
            if source.parent() != Some(parent) || target.parent() != Some(parent) {
                return Err(AuditFailure);
            }
            reject_audit_symlink(&source)?;
            reject_audit_symlink(&target)?;
            if target.exists() {
                fs::remove_file(&target).map_err(|_| AuditFailure)?;
            }
            if source.exists() {
                fs::rename(&source, &target).map_err(|_| AuditFailure)?;
            }
        }
        sync_audit_directory(parent)
    }

    pub(in crate::browser::login) fn write_navigation_denied(
        &self,
        binding: &BrowserGrantBinding,
        surface: &'static str,
        cause_code: &'static str,
        target_origin: Option<&str>,
    ) -> Result<(), AuditFailure> {
        if safe_policy_code(surface).is_none() || safe_policy_code(cause_code).is_none() {
            return Err(AuditFailure);
        }
        let target_origin = target_origin.and_then(fingerprint_denied_origin);
        self.append(
            "navigation_decision",
            &NavigationDenyAuditRecord {
                decided_at: chrono::Utc::now().to_rfc3339(),
                workspace_identity: binding.workspace_identity().to_string(),
                profile_id: binding.profile_id().to_string(),
                session_id: binding.session_id().to_string(),
                handoff_epoch: binding.handoff_epoch(),
                surface,
                decision: "denied",
                cause_code,
                target_origin_sha256: target_origin.as_ref().map(|origin| origin.sha256.clone()),
                target_scheme: target_origin
                    .as_ref()
                    .and_then(|origin| origin.scheme.clone()),
                target_port: target_origin.as_ref().and_then(|origin| origin.port),
            },
        )
    }

    pub(in crate::browser::login) fn path(&self) -> &Path {
        &self.path
    }
}

impl SemanticAuditSink for JsonlSemanticAuditSink {
    fn write_pre(&self, record: &AuditPreRecord) -> Result<(), AuditFailure> {
        self.append("decision", record)
    }

    fn write_result(&self, record: &AuditResultRecord) -> Result<(), AuditFailure> {
        self.append("result", record)
    }
}

#[derive(Serialize)]
struct NavigationDenyAuditRecord {
    decided_at: String,
    workspace_identity: String,
    profile_id: String,
    session_id: String,
    handoff_epoch: u64,
    surface: &'static str,
    decision: &'static str,
    cause_code: &'static str,
    target_origin_sha256: Option<String>,
    target_scheme: Option<String>,
    target_port: Option<u16>,
}

struct DeniedOriginFingerprint {
    sha256: String,
    scheme: Option<String>,
    port: Option<u16>,
}

fn fingerprint_denied_origin(value: &str) -> Option<DeniedOriginFingerprint> {
    if value.is_empty() || value.chars().count() > 512 || value.chars().any(char::is_control) {
        return None;
    }
    let parsed = tauri::Url::parse(value).ok();
    let scheme = parsed
        .as_ref()
        .map(tauri::Url::scheme)
        .filter(|scheme| matches!(*scheme, "http" | "https"))
        .map(str::to_string);
    let port = parsed.as_ref().and_then(tauri::Url::port_or_known_default);
    Some(DeniedOriginFingerprint {
        sha256: hex::encode(Sha256::digest(value.as_bytes())),
        scheme,
        port,
    })
}

fn rotated_audit_path(path: &Path, index: usize) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(format!(".{index}"));
    PathBuf::from(value)
}

#[cfg(unix)]
fn sync_audit_directory(path: &Path) -> Result<(), AuditFailure> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| AuditFailure)
}

#[cfg(not(unix))]
fn sync_audit_directory(_path: &Path) -> Result<(), AuditFailure> {
    Ok(())
}

fn ensure_audit_directory(path: &Path) -> Result<(), AuditFailure> {
    let _created = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(AuditFailure);
        }
        Ok(_) => false,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|_| AuditFailure)?;
            match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => true,
                _ => return Err(AuditFailure),
            }
        }
        Err(_) => return Err(AuditFailure),
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if _created {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                .map_err(|_| AuditFailure)?;
        }
        let mode = fs::symlink_metadata(path)
            .map_err(|_| AuditFailure)?
            .permissions()
            .mode();
        if mode & 0o077 != 0 {
            return Err(AuditFailure);
        }
    }
    Ok(())
}

fn reject_audit_symlink(path: &Path) -> Result<(), AuditFailure> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(AuditFailure)
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(AuditFailure),
    }
}
