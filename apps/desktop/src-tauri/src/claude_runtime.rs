//! On-demand, app-pinned Claude Code with explicit system/managed selection.
//! Reading status never installs or changes preference. Installed version directories
//! are immutable and are never removed, so running sessions can keep their path.

#[path = "claude_runtime/package.rs"]
mod package;
#[path = "claude_runtime/registry.rs"]
mod registry;
#[cfg(test)]
#[path = "claude_runtime/tests.rs"]
mod tests;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime},
};

const PROBE_TTL: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MANIFEST_JSON: &str = include_str!("../resources/claude-runtime-manifest.json");

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeRuntimeSource {
    #[default]
    Auto,
    System,
    Managed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedClaudeRuntime {
    pub source: ClaudeRuntimeSource,
    pub path: String,
    pub version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCandidate {
    pub state: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub detail: Option<String>,
}

impl RuntimeCandidate {
    fn missing() -> Self {
        Self {
            state: "missing".into(),
            path: None,
            version: None,
            detail: None,
        }
    }

    fn failed(path: Option<String>, detail: String) -> Self {
        Self {
            state: "error".into(),
            path,
            version: None,
            detail: Some(detail),
        }
    }

    fn resolved(&self, source: ClaudeRuntimeSource) -> Option<ResolvedClaudeRuntime> {
        (self.state == "available").then(|| ResolvedClaudeRuntime {
            source,
            path: self.path.clone().unwrap_or_default(),
            version: self.version.clone().unwrap_or_default(),
        })
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeInstallProgress {
    pub state: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRuntimeStatus {
    pub preference: ClaudeRuntimeSource,
    pub registry_url: String,
    pub registry_error: Option<String>,
    pub recommended_version: String,
    pub minimum_system_version: String,
    pub system: RuntimeCandidate,
    pub managed: RuntimeCandidate,
    pub selected: Option<ResolvedClaudeRuntime>,
    pub install: ClaudeInstallProgress,
    pub supported: bool,
    pub unsupported_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    schema_version: u32,
    sdk_version: String,
    claude_version: String,
    minimum_system_version: String,
    packages: Vec<RuntimePackage>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePackage {
    platform: String,
    url: String,
    integrity: String,
    binary_path: String,
    binary_sha256: String,
    binary_bytes: u64,
    archive_bytes: u64,
    minimum_os_version: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveRuntime {
    version: String,
    platform: String,
    directory: String,
}

fn manifest() -> &'static RuntimeManifest {
    static MANIFEST: OnceLock<RuntimeManifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        let value: RuntimeManifest = serde_json::from_str(MANIFEST_JSON)
            .expect("embedded Claude runtime manifest must be valid");
        assert_eq!(value.schema_version, 1);
        value
    })
}

fn current_platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    format!("{os}-{arch}")
}

fn current_package() -> Result<&'static RuntimePackage, String> {
    static PACKAGE: OnceLock<Result<&'static RuntimePackage, String>> = OnceLock::new();
    PACKAGE.get_or_init(check_platform_package).clone()
}

fn check_platform_package() -> Result<&'static RuntimePackage, String> {
    let platform = current_platform();
    let package = manifest()
        .packages
        .iter()
        .find(|p| p.platform == platform)
        .ok_or_else(|| format!("Managed Claude Code is not available for {platform}"))?;
    #[cfg(target_os = "macos")]
    if let Some(minimum) = package.minimum_os_version.as_deref() {
        let output = bounded_output("/usr/bin/sw_vers", "-productVersion", PROBE_TIMEOUT)?;
        let current = output
            .trim()
            .split('.')
            .next()
            .and_then(|v| v.parse::<u32>().ok());
        let required = minimum
            .split('.')
            .next()
            .and_then(|v| v.parse::<u32>().ok());
        if current
            .zip(required)
            .is_none_or(|(current, required)| current < required)
        {
            return Err(format!(
                "Managed Claude Code requires macOS {minimum} or later"
            ));
        }
    }
    Ok(package)
}

#[derive(Clone, PartialEq, Eq)]
struct FileIdentity {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    inode: u64,
}

fn file_identity(path: &str) -> Option<FileIdentity> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some(FileIdentity {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(unix)]
        inode: {
            use std::os::unix::fs::MetadataExt;
            metadata.ino()
        },
    })
}

#[derive(Clone)]
struct ProbeCache {
    candidate: RuntimeCandidate,
    identity: Option<FileIdentity>,
    at: Instant,
}

pub struct ClaudeRuntimeManager {
    root: PathBuf,
    system_cache: Mutex<Option<ProbeCache>>,
    managed_cache: Mutex<Option<ProbeCache>>,
    progress: Mutex<ClaudeInstallProgress>,
    registry_mutation: Mutex<()>,
    busy: AtomicBool,
    cancelled: AtomicBool,
}

pub fn shared() -> &'static Arc<ClaudeRuntimeManager> {
    static INSTANCE: OnceLock<Arc<ClaudeRuntimeManager>> = OnceLock::new();
    INSTANCE.get_or_init(|| {
        #[cfg(debug_assertions)]
        if let Some(root) = std::env::var_os("CCEM_CLAUDE_RUNTIME_ROOT") {
            let root = PathBuf::from(root);
            if root.is_absolute() {
                return Arc::new(ClaudeRuntimeManager::new(root));
            }
        }
        Arc::new(ClaudeRuntimeManager::new(
            crate::config::get_ccem_dir().join("runtimes/claude"),
        ))
    })
}

impl ClaudeRuntimeManager {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            system_cache: Mutex::new(None),
            managed_cache: Mutex::new(None),
            progress: Mutex::new(ClaudeInstallProgress {
                state: "idle".into(),
                ..Default::default()
            }),
            registry_mutation: Mutex::new(()),
            busy: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
        }
    }

    fn preference_path(&self) -> PathBuf {
        self.root.join("preference.json")
    }

    fn registry_path(&self) -> PathBuf {
        self.root.join("registry.json")
    }

    fn read_registry(&self) -> Result<String, String> {
        let path = self.registry_path();
        reject_symlink(&self.root)?;
        reject_symlink(&path)?;
        match read_small_file(&path, 4096) {
            Ok(bytes) => {
                let value: String = serde_json::from_slice(&bytes).map_err(|error| {
                    format!("Invalid Claude runtime registry configuration: {error}")
                })?;
                registry::normalize(&value)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(registry::DEFAULT_REGISTRY.into())
            }
            Err(error) => Err(format!(
                "Cannot read Claude runtime registry configuration: {error}"
            )),
        }
    }

    pub fn set_registry(&self, value: &str) -> Result<ClaudeRuntimeStatus, String> {
        let guard = self
            .registry_mutation
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.busy.load(Ordering::Acquire) {
            return Err("Wait for the current Claude runtime installation to finish before changing its registry".into());
        }
        let registry_url = registry::normalize(value)?;
        reject_symlink(&self.root)?;
        reject_symlink(&self.registry_path())?;
        crate::secure_fs::write_private_atomic(
            &self.registry_path(),
            &serde_json::to_vec(&registry_url).unwrap(),
        )
        .map_err(|error| format!("Cannot save Claude runtime registry: {error}"))?;
        drop(guard);
        Ok(self.status(false))
    }

    fn read_preference(&self) -> Result<ClaudeRuntimeSource, String> {
        let path = self.preference_path();
        reject_symlink(&self.root)?;
        reject_symlink(&path)?;
        match read_small_file(&path, 4096) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| format!("Invalid Claude runtime preference: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ClaudeRuntimeSource::Auto),
            Err(e) => Err(format!("Cannot read Claude runtime preference: {e}")),
        }
    }

    pub fn set_preference(
        &self,
        source: ClaudeRuntimeSource,
    ) -> Result<ClaudeRuntimeStatus, String> {
        reject_symlink(&self.root)?;
        reject_symlink(&self.preference_path())?;
        crate::secure_fs::write_private_atomic(
            &self.preference_path(),
            &serde_json::to_vec(&source).unwrap(),
        )
        .map_err(|e| format!("Cannot save Claude runtime preference: {e}"))?;
        Ok(self.status(false))
    }

    pub fn status(&self, refresh: bool) -> ClaudeRuntimeStatus {
        let preference = self.read_preference();
        let registry = self.read_registry();
        let system = self.system_candidate(refresh);
        let support = current_package();
        let managed = match &support {
            Ok(package) => self.managed_candidate(package, refresh, false),
            Err(error) => RuntimeCandidate::failed(None, error.clone()),
        };
        let selected = preference
            .as_ref()
            .ok()
            .and_then(|source| select_runtime(*source, &system, &managed));
        let mut install = self
            .progress
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Err(error) = &preference {
            install.error = Some(error.clone());
        }
        ClaudeRuntimeStatus {
            preference: preference.unwrap_or_default(),
            registry_url: registry.as_ref().cloned().unwrap_or_default(),
            registry_error: registry.err(),
            recommended_version: manifest().claude_version.clone(),
            minimum_system_version: manifest().minimum_system_version.clone(),
            system,
            managed,
            selected,
            install,
            supported: support.is_ok(),
            unsupported_reason: support.err(),
        }
    }

    pub fn resolve_for_launch(&self) -> Result<ResolvedClaudeRuntime, String> {
        let status = self.status(false);
        if let Some(selected) = status.selected {
            // A cached status is not an integrity proof for executing managed code.
            if selected.source == ClaudeRuntimeSource::Managed {
                let package =
                    current_package().map_err(|e| required_error(status.preference, &e))?;
                let checked = self.managed_candidate(package, false, true);
                return checked
                    .resolved(ClaudeRuntimeSource::Managed)
                    .ok_or_else(|| {
                        required_error(
                            status.preference,
                            checked
                                .detail
                                .as_deref()
                                .unwrap_or("Managed runtime is unavailable"),
                        )
                    });
            }
            return Ok(selected);
        }
        let detail = match status.preference {
            ClaudeRuntimeSource::System => status.system.detail.as_deref(),
            ClaudeRuntimeSource::Managed => status.managed.detail.as_deref(),
            ClaudeRuntimeSource::Auto => status
                .system
                .detail
                .as_deref()
                .or(status.managed.detail.as_deref()),
        }
        .or(status.install.error.as_deref())
        .unwrap_or("No compatible Claude Code runtime is available");
        Err(required_error(status.preference, detail))
    }

    pub fn is_managed_path(&self, path: &str) -> bool {
        let versions = self.root.join("versions");
        Path::new(path).starts_with(&versions)
            || fs::canonicalize(path)
                .ok()
                .zip(fs::canonicalize(versions).ok())
                .is_some_and(|(path, versions)| path.starts_with(versions))
    }

    /// Revalidate exactly the path captured by an existing session. Never reselect
    /// its runtime just because the source preference or system PATH changed.
    pub fn validate_pinned_path(&self, path: &str) -> Result<(), String> {
        if self.is_managed_path(path) {
            let package = current_package()?;
            let path = Path::new(path);
            let directory = path
                .parent()
                .ok_or("Pinned managed Claude Code path is invalid")?;
            let name = directory
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            if path.file_name().and_then(|name| name.to_str()) != Some(package.binary_name())
                || directory.parent() != Some(self.root.join("versions").as_path())
                || !valid_generation_name(name, package)
            {
                return Err(
                    "Pinned managed Claude Code is not a supported verified version".into(),
                );
            }
            reject_symlink(&self.root)?;
            reject_symlink(&self.root.join("versions"))?;
            reject_symlink(directory)?;
            package::verify_binary(path, package)
        } else {
            let candidate = probe_candidate(path, &manifest().minimum_system_version);
            if candidate.state == "available" {
                Ok(())
            } else {
                Err(candidate
                    .detail
                    .unwrap_or_else(|| "Pinned system Claude Code is missing".into()))
            }
        }
    }

    fn system_candidate(&self, refresh: bool) -> RuntimeCandidate {
        let mut cache = self.system_cache.lock().unwrap_or_else(|e| e.into_inner());
        if !refresh {
            if let Some(cached) = cache.as_ref() {
                let identity = cached.candidate.path.as_deref().and_then(file_identity);
                if cached.at.elapsed() < PROBE_TTL && identity == cached.identity {
                    return cached.candidate.clone();
                }
            }
        }
        #[cfg(debug_assertions)]
        let overridden = std::env::var("CCEM_CLAUDE_SYSTEM_PATH").ok();
        #[cfg(not(debug_assertions))]
        let overridden: Option<String> = None;
        let candidates = overridden
            .map(|path| vec![path])
            .unwrap_or_else(crate::terminal::claude_binary_candidates);
        let candidates = candidates
            .into_iter()
            .filter(|path| !self.is_managed_path(path))
            .collect::<Vec<_>>();
        let probed = std::thread::scope(|scope| {
            let workers = candidates
                .iter()
                .map(|path| {
                    scope.spawn(move || probe_candidate(path, &manifest().minimum_system_version))
                })
                .collect::<Vec<_>>();
            workers
                .into_iter()
                .filter_map(|worker| worker.join().ok())
                .collect::<Vec<_>>()
        });
        let mut best = RuntimeCandidate::missing();
        for candidate in probed {
            let newer = candidate.state == "available"
                && (best.state != "available"
                    || parse_version(candidate.version.as_deref().unwrap_or_default())
                        > parse_version(best.version.as_deref().unwrap_or_default()));
            if newer || (best.state == "missing" && candidate.state != "missing") {
                best = candidate;
            }
        }
        *cache = Some(ProbeCache {
            identity: best.path.as_deref().and_then(file_identity),
            candidate: best.clone(),
            at: Instant::now(),
        });
        best
    }

    fn managed_dir(&self, package: &RuntimePackage) -> PathBuf {
        self.root.join("versions").join(format!(
            "{}-{}",
            manifest().claude_version,
            package.platform
        ))
    }

    fn active_managed_dir(&self, package: &RuntimePackage) -> Result<PathBuf, String> {
        let path = self.root.join("active.json");
        reject_symlink(&self.root)?;
        reject_symlink(&path)?;
        let bytes = match read_small_file(&path, 4096) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(self.managed_dir(package))
            }
            Err(error) => return Err(format!("Cannot read managed Claude activation: {error}")),
        };
        let active: ActiveRuntime = serde_json::from_slice(&bytes)
            .map_err(|_| "Managed Claude activation record is invalid".to_string())?;
        if active.version != manifest().claude_version
            || active.platform != package.platform
            || !valid_generation_name(&active.directory, package)
        {
            return Err("Managed Claude activation does not match this supported release".into());
        }
        Ok(self.root.join("versions").join(active.directory))
    }

    fn activate_managed_dir(
        &self,
        directory: &Path,
        package: &RuntimePackage,
    ) -> Result<(), String> {
        let name = directory
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid managed runtime directory")?;
        if directory.parent() != Some(self.root.join("versions").as_path())
            || !valid_generation_name(name, package)
        {
            return Err("Invalid managed runtime activation path".into());
        }
        let active = ActiveRuntime {
            version: manifest().claude_version.clone(),
            platform: package.platform.clone(),
            directory: name.into(),
        };
        let pointer = self.root.join("active.json");
        reject_symlink(&pointer)?;
        crate::secure_fs::write_private_atomic(&pointer, &serde_json::to_vec(&active).unwrap())
            .map_err(|e| format!("Cannot activate Claude Code: {e}"))
    }

    fn managed_candidate(
        &self,
        package: &RuntimePackage,
        refresh: bool,
        verify: bool,
    ) -> RuntimeCandidate {
        let directory = match self.active_managed_dir(package) {
            Ok(directory) => directory,
            Err(error) => return RuntimeCandidate::failed(None, error),
        };
        let path = directory.join(package.binary_name());
        let path_string = path.to_string_lossy().to_string();
        let mut cache = self.managed_cache.lock().unwrap_or_else(|e| e.into_inner());
        if !verify && !refresh {
            if let Some(cached) = cache.as_ref() {
                if cached.at.elapsed() < PROBE_TTL
                    && cached.candidate.path.as_deref() == Some(path_string.as_str())
                    && cached.identity == file_identity(&path_string)
                {
                    return cached.candidate.clone();
                }
            }
        }
        let candidate = if !path.exists() {
            RuntimeCandidate::missing()
        } else {
            let verified = reject_symlink(&self.root)
                .and_then(|_| reject_symlink(&self.root.join("versions")))
                .and_then(|_| reject_symlink(&directory))
                .and_then(|_| package::verify_binary(&path, package));
            match verified {
                Err(error) => RuntimeCandidate::failed(Some(path_string.clone()), error),
                Ok(()) => RuntimeCandidate {
                    state: "available".into(),
                    path: Some(path_string.clone()),
                    version: Some(manifest().claude_version.clone()),
                    detail: None,
                },
            }
        };
        *cache = Some(ProbeCache {
            candidate: candidate.clone(),
            identity: file_identity(&path_string),
            at: Instant::now(),
        });
        candidate
    }

    pub fn prepare_install(self: &Arc<Self>) -> Result<PreparedClaudeInstall, String> {
        current_package()?;
        let _registry_guard = self
            .registry_mutation
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let registry_url = self.read_registry()?;
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "A Claude runtime installation is already running".to_string())?;
        self.cancelled.store(false, Ordering::Release);
        *self.progress.lock().unwrap_or_else(|e| e.into_inner()) = ClaudeInstallProgress {
            state: "downloading".into(),
            total_bytes: current_package().ok().map(|p| p.archive_bytes),
            ..Default::default()
        };
        Ok(PreparedClaudeInstall {
            manager: self.clone(),
            registry_url,
            settled: false,
        })
    }

    pub fn cancel_install(&self) -> ClaudeRuntimeStatus {
        if self.busy.load(Ordering::Acquire) {
            self.cancelled.store(true, Ordering::Release);
        }
        self.status(false)
    }

    fn check_cancelled(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            Err("Installation cancelled".into())
        } else {
            Ok(())
        }
    }

    fn update_progress(&self, phase: &str, downloaded: Option<u64>) {
        let mut progress = self.progress.lock().unwrap_or_else(|e| e.into_inner());
        progress.state = phase.into();
        if let Some(downloaded) = downloaded {
            progress.downloaded_bytes = downloaded;
        }
    }

    fn finish_install(&self, registry_url: &str) -> Result<ClaudeRuntimeStatus, String> {
        let result = package::install(self, registry_url);
        let mut progress = self.progress.lock().unwrap_or_else(|e| e.into_inner());
        match &result {
            Ok(()) => {
                progress.state = "installed".into();
                progress.error = None;
            }
            Err(error) => {
                progress.state = if self.cancelled.load(Ordering::Acquire) {
                    "cancelled"
                } else {
                    "error"
                }
                .into();
                progress.error = Some(error.clone());
            }
        }
        drop(progress);
        *self.managed_cache.lock().unwrap_or_else(|e| e.into_inner()) = None;
        result.map(|_| self.status(false))
    }
}

fn valid_generation_name(name: &str, package: &RuntimePackage) -> bool {
    let base = format!("{}-{}", manifest().claude_version, package.platform);
    name == base
        || name
            .strip_prefix(&format!("{base}-"))
            .is_some_and(|suffix| {
                suffix.len() == 16 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
}

pub struct PreparedClaudeInstall {
    manager: Arc<ClaudeRuntimeManager>,
    registry_url: String,
    settled: bool,
}

impl PreparedClaudeInstall {
    pub fn run(mut self) -> Result<ClaudeRuntimeStatus, String> {
        let result = self.manager.finish_install(&self.registry_url);
        self.settled = true;
        result
    }
}

impl Drop for PreparedClaudeInstall {
    fn drop(&mut self) {
        if !self.settled {
            let mut progress = self
                .manager
                .progress
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            progress.state = "cancelled".into();
            progress.error = Some("Installation interrupted; retry when ready".into());
        }
        self.manager.busy.store(false, Ordering::Release);
    }
}

fn select_runtime(
    source: ClaudeRuntimeSource,
    system: &RuntimeCandidate,
    managed: &RuntimeCandidate,
) -> Option<ResolvedClaudeRuntime> {
    match source {
        ClaudeRuntimeSource::Auto => system
            .resolved(ClaudeRuntimeSource::System)
            .or_else(|| managed.resolved(ClaudeRuntimeSource::Managed)),
        ClaudeRuntimeSource::System => system.resolved(ClaudeRuntimeSource::System),
        ClaudeRuntimeSource::Managed => managed.resolved(ClaudeRuntimeSource::Managed),
    }
}

fn required_error(preference: ClaudeRuntimeSource, reason: &str) -> String {
    format!(
        "CLAUDE_RUNTIME_REQUIRED: {}",
        serde_json::json!({
            "reason": reason, "preference": preference, "recommendedVersion": manifest().claude_version,
        })
    )
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "Claude runtime storage must not be a symlink: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Cannot inspect Claude runtime storage: {e}")),
    }
}

fn read_small_file(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Claude runtime record is too large",
        ));
    }
    Ok(bytes)
}

fn parse_version(output: &str) -> Option<semver::Version> {
    output
        .split_whitespace()
        .find_map(|part| semver::Version::parse(part.trim_start_matches('v')).ok())
}

fn probe_candidate(path: &str, minimum: &str) -> RuntimeCandidate {
    if !Path::new(path).is_file() {
        return RuntimeCandidate::missing();
    }
    let result = bounded_output(path, "--version", PROBE_TIMEOUT).and_then(|output| {
        let version = parse_version(&output).ok_or_else(|| "Claude Code did not return a valid version".to_string())?;
        let floor = semver::Version::parse(minimum).unwrap();
        if version < floor || version.major != floor.major || !version.pre.is_empty() {
            return Ok(RuntimeCandidate { state: "incompatible".into(), path: Some(path.into()), version: Some(version.to_string()),
                detail: Some(format!("Claude Code {version} is incompatible; requires stable {minimum} or newer in major {}", floor.major)) });
        }
        let help = bounded_output(path, "--help", PROBE_TIMEOUT)?;
        let missing = ["--input-format", "--output-format", "--permission-mode", "--resume"]
            .into_iter().find(|flag| !help.contains(flag));
        Ok(RuntimeCandidate {
            state: if missing.is_some() { "incompatible" } else { "available" }.into(),
            path: Some(path.into()), version: Some(version.to_string()),
            detail: missing.map(|flag| format!("Claude Code does not support required option {flag}")),
        })
    });
    result.unwrap_or_else(|error| RuntimeCandidate::failed(Some(path.into()), error))
}

fn bounded_output(path: &str, argument: &str, timeout: Duration) -> Result<String, String> {
    let mut command = Command::new(path);
    command
        .arg(argument)
        .env("DISABLE_AUTOUPDATER", "1")
        .env("PATH", crate::terminal::get_user_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot run Claude Code: {e}"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (output_tx, output_rx) = std::sync::mpsc::channel();
    let error_tx = output_tx.clone();
    std::thread::spawn(move || {
        let _ = output_tx.send(read_probe_output(stdout));
    });
    std::thread::spawn(move || {
        let _ = error_tx.send(read_probe_output(stderr));
    });
    let started = Instant::now();
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err(format!("Claude Code {argument} exited with {status}"))
                }
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!("Cannot inspect Claude Code process: {error}"));
            }
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!("Claude Code {argument} timed out"));
            }
            _ => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    result?;
    // An exited wrapper may leave a grandchild holding its pipes open. Read via
    // deadlines rather than joining the readers, including on a zero exit code.
    let output = output_rx
        .recv_timeout(timeout.saturating_sub(started.elapsed()))
        .map_err(|_| format!("Claude Code {argument} output timed out"))?;
    let errors = output_rx
        .recv_timeout(timeout.saturating_sub(started.elapsed()))
        .map_err(|_| format!("Claude Code {argument} output timed out"))?;
    Ok(format!(
        "{}\n{}",
        String::from_utf8_lossy(&output),
        String::from_utf8_lossy(&errors)
    ))
}

fn read_probe_output(mut reader: impl Read) -> Vec<u8> {
    let mut result = Vec::new();
    let _ = reader.by_ref().take(256 * 1024).read_to_end(&mut result);
    result
}
