//! On-demand Hermes package management. Construction/status never creates directories or downloads.
//! Reuses CCEM's signed manifest, resumable download, safe zip extraction, activation and lease
//! primitives. Only the Hermes compatibility contract and Python health check live here.

#[path = "hermes_installer/package.rs"]
mod package;
#[cfg(test)]
#[path = "hermes_installer/tests.rs"]
mod tests;

use crate::browser::runtime::{
    activation::{ActivationFault, ActivationStore, ActiveRuntimeLease, VerifiedRuntimeReceipt},
    download::{
        download_archive_with_options, DownloadControl, DownloadErrorCode,
        DownloadProgressReporter, DownloadSpec,
    },
    extract::{extract_runtime_archive_with_cancel, ExtractionErrorCode},
    maintenance::RuntimeMaintenanceStore,
    manifest::{
        ManifestEnvironment, ManifestTrustStore, RuntimeArchitecture, RuntimePlatform,
        VerifiedRuntimeManifest,
    },
    paths::RuntimePaths,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

pub const HERMES_SOURCE_COMMIT: &str = "bc1330eebc0aa8a443501b5f62586eb7361353a5";
pub const HERMES_LOCK_SHA256: &str =
    "6393f09ee88cc5683f0e563306f96b5c068f901a8baa60f7209f302c1ac602d9";
pub const HERMES_PYTHON_VERSION: &str = "3.11.16";
pub const HERMES_PROTOCOL_VERSION: u32 = 1;
const KEY_ID: &str = "ccem-hermes-runtime-2026-01";
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 16 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HermesLaunch {
    pub runtime_root: PathBuf,
    pub python: PathBuf,
    pub source: PathBuf,
    pub host: PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HermesInstallError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl std::fmt::Display for HermesInstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for HermesInstallError {}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesInstallStatus {
    pub state: String,
    pub version: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<HermesInstallError>,
    pub retryable: bool,
    /// A previous verified runtime may remain available after a failed update.
    pub launch: Option<HermesLaunch>,
}

impl Default for HermesInstallStatus {
    fn default() -> Self {
        Self {
            state: "not_installed".into(),
            version: None,
            downloaded_bytes: 0,
            total_bytes: None,
            error: None,
            retryable: false,
            launch: None,
        }
    }
}

/// Hold this for the entire owned gateway process lifetime. Deletion fails while it is held.
pub struct HermesRuntimeLease {
    pub launch: HermesLaunch,
    _lease: ActiveRuntimeLease,
}

/// Synchronously claims the install action before the UI publishes its cancellable state.
/// Moving this value into a blocking worker cannot clear a cancellation already received.
pub struct PreparedHermesInstall {
    installer: HermesInstaller,
    settled: bool,
}

impl PreparedHermesInstall {
    pub fn run(mut self) -> Result<HermesInstallStatus, HermesInstallError> {
        let result = self.installer.finish_install();
        self.settled = true;
        result
    }
}

impl Drop for PreparedHermesInstall {
    fn drop(&mut self) {
        if !self.settled {
            let mut status = self
                .installer
                .progress
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            status.state = "cancelled".into();
            status.retryable = true;
            status.error = Some(failure("interrupted", "安装已中断，可以重试。", true));
        }
        self.installer.busy.store(false, Ordering::Release);
    }
}

#[derive(Clone)]
struct Source {
    manifest_url: String,
    public_key: String,
    development_loopback: bool,
}

#[derive(Clone)]
pub struct HermesInstaller {
    root: PathBuf,
    progress: Arc<Mutex<HermesInstallStatus>>,
    busy: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>,
    download: DownloadControl,
}

impl HermesInstaller {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            progress: Arc::new(Mutex::new(HermesInstallStatus::default())),
            busy: Arc::new(AtomicBool::new(false)),
            cancelled: Arc::new(AtomicBool::new(false)),
            download: DownloadControl::default(),
        }
    }

    /// Cheap read-only status; full package re-verification occurs at install and lease.
    pub fn status(&self) -> HermesInstallStatus {
        let mut status = self
            .progress
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if !self.root.exists() {
            if status.state == "installed" {
                status = HermesInstallStatus::default();
            }
            return status;
        }
        if status.state == "not_installed" {
            if let Some((completed, total)) = read_pending_download(&self.root) {
                status.state = "paused".into();
                status.downloaded_bytes = completed;
                status.total_bytes = Some(total);
                status.retryable = true;
            }
        }
        match self.paths().and_then(|paths| {
            let active = ActivationStore::new(paths.clone())
                .load_pointer()
                .map_err(|_| failure("state_corrupt", "Hermes 安装记录损坏，请重试安装。", true))?;
            Ok(active.map(|p| (p.active.version.clone(), launch_for(&paths, &p.active))))
        }) {
            Ok(Some((version, launch))) => {
                status.version = Some(version);
                status.launch = Some(launch);
                if status.state == "not_installed" {
                    status.state = "installed".into();
                }
            }
            Ok(None) => {
                if status.state == "installed" {
                    status = HermesInstallStatus::default();
                }
            }
            Err(error) => {
                status.state = "error".into();
                status.retryable = error.retryable;
                status.error = Some(error);
                status.launch = None;
            }
        }
        status
    }

    /// Blocking worker only. The UI command should spawn this on Tauri's blocking executor.
    pub fn install(&self) -> Result<HermesInstallStatus, HermesInstallError> {
        self.prepare_install()?.run()
    }

    pub fn prepare_install(&self) -> Result<PreparedHermesInstall, HermesInstallError> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| failure("operation_in_progress", "聊天组件已有操作正在进行。", true))?;
        self.cancelled.store(false, Ordering::Release);
        self.download.resume();
        self.set_phase("checking");
        Ok(PreparedHermesInstall {
            installer: self.clone(),
            settled: false,
        })
    }

    fn finish_install(&self) -> Result<HermesInstallStatus, HermesInstallError> {
        let outcome = self.check_cancel().and_then(|_| self.install_inner());
        match outcome {
            Ok(()) => {
                self.set_phase("installed");
                Ok(self.status())
            }
            Err(error) => {
                let mut progress = self.progress.lock().unwrap_or_else(|p| p.into_inner());
                progress.state = if error.code == "cancelled" {
                    "cancelled"
                } else {
                    "error"
                }
                .into();
                progress.retryable = error.retryable;
                progress.error = Some(error.clone());
                Err(error)
            }
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.download.cancel();
    }

    /// Only the runtime payload/cache is removed. Credentials/profile are outside this root.
    pub fn remove_runtime(&self) -> Result<HermesInstallStatus, HermesInstallError> {
        let _busy = self.begin()?;
        if self.root.exists() {
            RuntimeMaintenanceStore::new(self.paths()?)
                .delete_runtime()
                .map_err(|e| {
                    failure(
                        "runtime_in_use_or_cleanup_failed",
                        &format!("Hermes 运行时无法清理：{e:?}"),
                        true,
                    )
                })?;
        }
        *self.progress.lock().unwrap_or_else(|p| p.into_inner()) = HermesInstallStatus::default();
        Ok(self.status())
    }

    pub fn lease_runtime(&self) -> Result<HermesRuntimeLease, HermesInstallError> {
        let paths = self.paths()?;
        if !paths.active_pointer.exists() {
            return Err(failure("not_installed", "聊天组件尚未安装。", true));
        }
        let lease = ActivationStore::new(paths.clone())
            .lease_active()
            .map_err(|_| failure("state_corrupt", "Hermes 安装验证失败。", true))?
            .ok_or_else(|| failure("not_installed", "聊天组件尚未安装。", true))?;
        let receipt = &lease.pointer().active;
        let launch = launch_for(&paths, receipt);
        let source = Source::configured()?;
        let manifest_bytes = read_regular(
            &launch.runtime_root.join("manifest.json"),
            MAX_MANIFEST_BYTES,
        )?;
        let signature = read_regular(
            &launch.runtime_root.join("manifest.json.sig"),
            MAX_SIGNATURE_BYTES,
        )?;
        let verified =
            self.verify_manifest(&source, &manifest_bytes, &signature, receipt.sequence)?;
        if verified.exact_bytes_sha256 != receipt.manifest_sha256 {
            return Err(failure(
                "manifest_mismatch",
                "Hermes 清单与安装记录不符。",
                false,
            ));
        }
        package::verify_package(&launch, &verified, &archive_path(&paths, &verified))?;
        Ok(HermesRuntimeLease {
            launch,
            _lease: lease,
        })
    }

    fn install_inner(&self) -> Result<(), HermesInstallError> {
        require_supported_platform()?;
        let source = Source::configured()?; // No directories/downloads before configured trust.
        let paths = self.paths()?;
        let _operation = paths.acquire_operation_exclusive().map_err(|_| {
            failure(
                "operation_in_progress_or_permission",
                "安装目录不可写或另一个安装正在进行。",
                true,
            )
        })?;
        let current = ActivationStore::new(paths.clone())
            .load_pointer()
            .map_err(|_| failure("state_corrupt", "聊天组件安装状态无效。", true))?;
        // Refuse an already running version before fetching or extracting anything. The held
        // lease check at activation also covers a gateway started while preparation ran.
        drop(exclusive_active_lease(&paths)?);
        let sequence =
            read_watermark(&paths)?.max(current.as_ref().map(|p| p.active.sequence).unwrap_or(1));
        let manifest = fetch_bounded(&source.manifest_url, MAX_MANIFEST_BYTES)?;
        self.check_cancel()?;
        let signature =
            fetch_bounded(&format!("{}.sig", source.manifest_url), MAX_SIGNATURE_BYTES)?;
        let verified = self.verify_manifest(&source, &manifest, &signature, sequence)?;
        let artifact = &verified.manifest.artifact;
        if let Some(active) = current
            .as_ref()
            .filter(|p| p.active.manifest_sha256 == verified.exact_bytes_sha256)
        {
            let launch = launch_for(&paths, &active.active);
            package::verify_package(&launch, &verified, &archive_path(&paths, &verified)).map_err(
                |_| {
                    failure(
                        "installed_package_corrupt",
                        "组件文件校验失败，请卸载组件后重新安装；连接授权会保留。",
                        false,
                    )
                },
            )?;
            self.check_cancel()?;
            self.try_report(artifact.archive.byte_size, artifact.archive.byte_size);
            return Ok(());
        }
        let allocation = fs2::allocation_granularity(&paths.root).map_err(|_| io_failure())?;
        // Small files and automatically created directories also consume whole filesystem
        // blocks. Byte totals alone undercount this Python/source tree on APFS.
        let rounding = artifact
            .archive
            .max_entries
            .checked_mul(allocation)
            .and_then(|v| v.checked_mul(2))
            .ok_or_else(io_failure)?;
        let required = artifact
            .archive
            .byte_size
            .checked_add(artifact.archive.max_unpacked_bytes)
            .and_then(|v| v.checked_add(rounding))
            .and_then(|v| v.checked_add(64 * 1024 * 1024))
            .ok_or_else(|| failure("size_limit", "运行时磁盘需求超出限制。", false))?;
        if available_space(&paths.root)? < required {
            return Err(failure(
                "insufficient_space",
                "没有足够空间安装聊天组件，请释放空间后重试。",
                true,
            ));
        }
        self.check_cancel()?;
        self.set_phase("downloading");
        let spec = DownloadSpec {
            source_url: source.artifact_url(&artifact.source_url)?,
            expected_size: artifact.archive.byte_size,
            expected_sha256: artifact.archive.sha256.clone(),
            completed_path: archive_path(&paths, &verified),
        };
        // The shared downloader keeps an ETag/Range journal and verifies the entire final hash.
        let mut attempts = 0;
        loop {
            match download_archive_with_options(
                &spec,
                &self.download,
                self,
                Duration::from_secs(10),
                Duration::from_secs(30),
            ) {
                Ok(_) => break,
                Err(error) => {
                    self.check_cancel()?;
                    if matches!(
                        error.code,
                        DownloadErrorCode::ValidatorChanged
                            | DownloadErrorCode::RangeRejected
                            | DownloadErrorCode::JournalCorrupt
                    ) && attempts == 0
                    {
                        reset_partial(&spec.completed_path)?;
                    } else if !matches!(
                        error.code,
                        DownloadErrorCode::Network | DownloadErrorCode::DownloadInterrupted
                    ) || attempts >= 2
                    {
                        return Err(failure(
                            "download_failed",
                            &format!("聊天组件下载失败：{:?}", error.code),
                            !matches!(
                                error.code,
                                DownloadErrorCode::HashMismatch
                                    | DownloadErrorCode::RedirectRejected
                            ),
                        ));
                    }
                    attempts += 1;
                    for _ in 0..attempts * 5 {
                        self.check_cancel()?;
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        }
        self.try_report(artifact.archive.byte_size, artifact.archive.byte_size);
        self.check_cancel()?;
        self.set_phase("verifying");
        let candidate = paths
            .create_candidate(&format!("hermes-{}", random_id()))
            .map_err(|_| io_failure())?;
        let result = (|| {
            extract_runtime_archive_with_cancel(
                &spec.completed_path,
                &candidate,
                artifact,
                &self.cancelled,
            )
            .map_err(|e| {
                if e.code == ExtractionErrorCode::Cancelled {
                    failure("cancelled", "已取消安装。", true)
                } else {
                    failure(
                        "archive_rejected",
                        &format!("聊天组件解包校验失败：{e}"),
                        false,
                    )
                }
            })?;
            self.check_cancel()?;
            let launch = HermesLaunch {
                python: candidate.join("python/bin/python3.11"),
                source: candidate.join("source"),
                host: candidate.join("ccem_gateway_host.py"),
                runtime_root: candidate.clone(),
            };
            package::verify_package(&launch, &verified, &spec.completed_path)?;
            package::health_check(&launch, &self.cancelled)?;
            package::verify_package(&launch, &verified, &spec.completed_path)?;
            self.check_cancel()?;
            let _active_not_in_use = exclusive_active_lease(&paths)?;
            write_private(&candidate.join("manifest.json"), &manifest)?;
            write_private(&candidate.join("manifest.json.sig"), &signature)?;
            // Persist the highest authenticated compatibility sequence before activation. An
            // interruption may require retrying this version but can never allow a downgrade.
            write_private(
                &paths.root.join("manifest-sequence.json"),
                &serde_json::to_vec(&verified.manifest.sequence).map_err(|_| io_failure())?,
            )?;
            self.set_phase("activating");
            ActivationStore::new(paths.clone())
                .activate(
                    &candidate,
                    VerifiedRuntimeReceipt::from_verified_manifest(
                        &verified,
                        chrono::Utc::now().to_rfc3339(),
                    ),
                    ActivationFault::None,
                )
                .map_err(|e| {
                    failure(
                        "activation_failed",
                        &format!("聊天组件激活失败：{e:?}"),
                        true,
                    )
                })?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(candidate);
        }
        result
    }

    fn verify_manifest(
        &self,
        source: &Source,
        bytes: &[u8],
        signature: &[u8],
        minimum_sequence: u64,
    ) -> Result<VerifiedRuntimeManifest, HermesInstallError> {
        let mut trust = ManifestTrustStore::new();
        trust
            .add_minisign_key(KEY_ID, &source.public_key)
            .map_err(|_| failure("invalid_trust_root", "聊天组件签名公钥配置无效。", false))?;
        let environment = ManifestEnvironment {
            platform: RuntimePlatform::Macos,
            architecture: RuntimeArchitecture::Aarch64,
            os_version: os_version()?,
            protocol_version: HERMES_PROTOCOL_VERSION,
            minimum_sequence,
        };
        let verified = trust
            .verify_exact_bytes(
                KEY_ID,
                bytes,
                std::str::from_utf8(signature)
                    .map_err(|_| failure("invalid_signature", "聊天组件签名无效。", false))?,
                &environment,
            )
            .map_err(|e| {
                failure(
                    "manifest_rejected",
                    &format!("聊天组件清单校验失败：{e}"),
                    false,
                )
            })?;
        let artifact = &verified.manifest.artifact;
        if artifact.product_identity.product_name != "CCEM Hermes Runtime"
            || artifact.layout.root_directory != "hermes-runtime"
            || artifact.layout.executable.relative_path != "python/bin/python3.11"
            || verified.manifest.minimum_protocol_version != HERMES_PROTOCOL_VERSION
            || artifact.archive.byte_size > 1024 * 1024 * 1024
            || artifact.archive.max_unpacked_bytes > 4 * 1024 * 1024 * 1024
            || artifact.archive.max_entries > 60_000
        {
            return Err(failure(
                "incompatible_package",
                "聊天组件版本或布局不兼容。",
                false,
            ));
        }
        source.artifact_url(&artifact.source_url)?;
        Ok(verified)
    }

    fn paths(&self) -> Result<RuntimePaths, HermesInstallError> {
        // Reject symlink ancestors, including a substituted app-owned root.
        for parent in self.root.ancestors() {
            match fs::symlink_metadata(parent) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(failure(
                        "unsafe_path",
                        "聊天组件目录不能是符号链接。",
                        false,
                    ))
                }
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(io_failure()),
            }
        }
        #[cfg(unix)]
        if let Ok(meta) = fs::symlink_metadata(&self.root) {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o200 == 0 {
                return Err(io_failure());
            }
        }
        RuntimePaths::under(self.root.clone())
            .map_err(|_| failure("unsafe_path", "聊天组件目录无效。", false))
    }
    fn begin(&self) -> Result<BusyGuard<'_>, HermesInstallError> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| failure("operation_in_progress", "聊天组件已有操作正在进行。", true))?;
        Ok(BusyGuard(&self.busy))
    }
    fn check_cancel(&self) -> Result<(), HermesInstallError> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(failure("cancelled", "已取消安装。", true))
        } else {
            Ok(())
        }
    }
    fn set_phase(&self, state: &str) {
        let mut p = self.progress.lock().unwrap_or_else(|p| p.into_inner());
        p.state = state.into();
        p.error = None;
        p.retryable = false;
    }
}

impl DownloadProgressReporter for HermesInstaller {
    fn try_report(&self, completed: u64, total: u64) -> bool {
        let mut p = self.progress.lock().unwrap_or_else(|p| p.into_inner());
        p.downloaded_bytes = completed;
        p.total_bytes = Some(total);
        true
    }
}
struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl Source {
    fn configured() -> Result<Self, HermesInstallError> {
        #[cfg(debug_assertions)]
        if let Ok(url) = std::env::var("CCEM_HERMES_TEST_MANIFEST_URL") {
            let parsed = reqwest::Url::parse(&url).map_err(|_| source_failure())?;
            if !is_loopback(&parsed) || parsed.scheme() != "http" {
                return Err(source_failure());
            }
            validate_url(&parsed)?;
            let public_key =
                std::env::var("CCEM_HERMES_TEST_PUBLIC_KEY").map_err(|_| source_failure())?;
            return Ok(Self {
                manifest_url: url,
                public_key,
                development_loopback: true,
            });
        }
        let url = option_env!("CCEM_HERMES_RUNTIME_MANIFEST_URL").filter(|s| !s.is_empty());
        let key = option_env!("CCEM_HERMES_RUNTIME_PUBLIC_KEY").filter(|s| !s.is_empty());
        match (url, key) {
            (Some(url), Some(key)) => {
                let parsed = reqwest::Url::parse(url).map_err(|_| source_failure())?;
                if parsed.scheme() != "https" || is_loopback(&parsed) {
                    return Err(source_failure());
                }
                validate_url(&parsed)?;
                Ok(Self {
                    manifest_url: url.into(),
                    public_key: key.into(),
                    development_loopback: false,
                })
            }
            _ => Err(source_failure()),
        }
    }
    fn artifact_url(&self, value: &str) -> Result<String, HermesInstallError> {
        let mut artifact = reqwest::Url::parse(value).map_err(|_| source_failure())?;
        let manifest = reqwest::Url::parse(&self.manifest_url).map_err(|_| source_failure())?;
        validate_url(&artifact)?;
        if artifact.scheme() != "https"
            || artifact.host_str() != manifest.host_str()
            || artifact.port_or_known_default()
                != if self.development_loopback {
                    manifest.port()
                } else {
                    manifest.port_or_known_default()
                }
        {
            return Err(failure(
                "source_rejected",
                "聊天组件下载源不在受信发布源内。",
                false,
            ));
        }
        if self.development_loopback {
            if !cfg!(debug_assertions) || !is_loopback(&artifact) {
                return Err(source_failure());
            }
            artifact.set_scheme("http").map_err(|_| source_failure())?;
        }
        Ok(artifact.into())
    }
}

fn validate_url(url: &reqwest::Url) -> Result<(), HermesInstallError> {
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        Err(source_failure())
    } else {
        Ok(())
    }
}
fn is_loopback(url: &reqwest::Url) -> bool {
    url.host_str()
        .is_some_and(|host| host == "127.0.0.1" || host == "[::1]" || host == "::1")
}
fn fetch_bounded(url: &str, maximum: u64) -> Result<Vec<u8>, HermesInstallError> {
    let response = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| failure("network", "无法连接聊天组件发布源。", true))?
        .get(url)
        .send()
        .map_err(|_| failure("network", "无法连接聊天组件发布源。", true))?;
    if response.status() != reqwest::StatusCode::OK
        || response.content_length().is_some_and(|n| n > maximum)
    {
        return Err(failure("source_response", "聊天组件清单下载失败。", true));
    }
    let mut bytes = Vec::new();
    response
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failure("network", "聊天组件清单下载中断。", true))?;
    if bytes.is_empty() || bytes.len() as u64 > maximum {
        return Err(failure("size_limit", "聊天组件清单大小无效。", false));
    }
    Ok(bytes)
}
fn archive_path(paths: &RuntimePaths, manifest: &VerifiedRuntimeManifest) -> PathBuf {
    paths
        .downloads
        .join(format!("{}.zip", manifest.manifest.artifact.archive.sha256))
}
fn exclusive_active_lease(paths: &RuntimePaths) -> Result<Option<fs::File>, HermesInstallError> {
    use fs2::FileExt;
    let _mutation = paths.acquire_exclusive().map_err(|_| io_failure())?;
    let pointer = ActivationStore::new(paths.clone())
        .load_pointer()
        .map_err(|_| io_failure())?;
    let Some(pointer) = pointer else {
        return Ok(None);
    };
    let name = format!(
        "runtime-{}-{}",
        pointer.active.version,
        &pointer.active.manifest_sha256[..16]
    );
    let path = paths.version_lease_path(&name).map_err(|_| io_failure())?;
    let mut options = fs::OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|_| io_failure())?;
    file.try_lock_exclusive()
        .map_err(|_| failure("runtime_in_use", "请先停止聊天连接，再更新组件。", true))?;
    Ok(Some(file))
}
fn read_pending_download(root: &Path) -> Option<(u64, u64)> {
    let entries = fs::read_dir(root.join("downloads")).ok()?;
    for entry in entries.take(256).flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .ends_with(".download.json")
        {
            continue;
        }
        let Ok(bytes) = read_regular(&entry.path(), 64 * 1024) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        let completed = value.get("completed_bytes")?.as_u64()?;
        let total = value.get("expected_size")?.as_u64()?;
        if value.get("status")?.as_str()? != "cancelled"
            && completed <= total
            && total <= 1024 * 1024 * 1024
        {
            return Some((completed, total));
        }
    }
    None
}
fn available_space(root: &Path) -> Result<u64, HermesInstallError> {
    #[cfg(debug_assertions)]
    if std::env::var_os("CCEM_HERMES_TEST_MANIFEST_URL").is_some() {
        if let Ok(value) = std::env::var("CCEM_HERMES_TEST_AVAILABLE_BYTES") {
            return value.parse().map_err(|_| io_failure());
        }
    }
    fs2::available_space(root).map_err(|_| io_failure())
}
fn launch_for(paths: &RuntimePaths, receipt: &VerifiedRuntimeReceipt) -> HermesLaunch {
    let root = paths.versions.join(format!(
        "runtime-{}-{}",
        receipt.version,
        &receipt.manifest_sha256[..16]
    ));
    HermesLaunch {
        python: root.join("python/bin/python3.11"),
        source: root.join("source"),
        host: root.join("ccem_gateway_host.py"),
        runtime_root: root,
    }
}
fn read_watermark(paths: &RuntimePaths) -> Result<u64, HermesInstallError> {
    let path = paths.root.join("manifest-sequence.json");
    if !path.exists() {
        return Ok(1);
    }
    serde_json::from_slice(&read_regular(&path, 128)?)
        .map_err(|_| failure("state_corrupt", "聊天组件版本记录损坏。", false))
}
fn reset_partial(completed: &Path) -> Result<(), HermesInstallError> {
    let name = completed
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(io_failure)?;
    for suffix in ["part", "download.json"] {
        let path = completed.with_file_name(format!(".{name}.{suffix}"));
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {
                fs::remove_file(path).map_err(|_| io_failure())?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(io_failure()),
        }
    }
    Ok(())
}
fn require_supported_platform() -> Result<(), HermesInstallError> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Ok(())
    } else {
        Err(failure(
            "unsupported_platform",
            "此系统架构的聊天组件尚未验证。",
            false,
        ))
    }
}
fn os_version() -> Result<String, HermesInstallError> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .map_err(|_| io_failure())?;
        if !output.status.success() {
            return Err(io_failure());
        }
        return Ok(String::from_utf8(output.stdout)
            .map_err(|_| io_failure())?
            .trim()
            .to_owned());
    }
    #[cfg(not(target_os = "macos"))]
    Err(failure(
        "unsupported_platform",
        "此系统架构的聊天组件尚未验证。",
        false,
    ))
}
fn read_regular(path: &Path, maximum: u64) -> Result<Vec<u8>, HermesInstallError> {
    let meta = fs::symlink_metadata(path).map_err(|_| io_failure())?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > maximum {
        return Err(io_failure());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| io_failure())?
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| io_failure())?;
    if bytes.len() as u64 > maximum {
        return Err(io_failure());
    }
    Ok(bytes)
}
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), HermesInstallError> {
    use std::io::Write;
    let temp = path.with_extension(format!("tmp-{}", random_id()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(&temp).map_err(|_| io_failure())?;
        file.write_all(bytes).map_err(|_| io_failure())?;
        file.sync_all().map_err(|_| io_failure())?;
        fs::rename(&temp, path).map_err(|_| io_failure())?;
        fs::File::open(path.parent().ok_or_else(io_failure)?)
            .and_then(|d| d.sync_all())
            .map_err(|_| io_failure())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn failure(code: &str, message: &str, retryable: bool) -> HermesInstallError {
    HermesInstallError {
        code: code.into(),
        message: message.into(),
        retryable,
    }
}
fn io_failure() -> HermesInstallError {
    failure(
        "filesystem",
        "聊天组件目录无法读写，请检查权限与磁盘空间后重试。",
        true,
    )
}
fn source_failure() -> HermesInstallError {
    failure(
        "source_not_configured",
        "此版本尚未配置受信聊天组件发布源。",
        false,
    )
}
fn random_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
