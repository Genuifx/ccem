use super::*;
use base64::Engine;
use fs2::FileExt;
use sha2::{Digest, Sha256, Sha512};
use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    io::{Read, Write},
};

const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_BINARY_BYTES: u64 = 512 * 1024 * 1024;

impl RuntimePackage {
    pub(super) fn binary_name(&self) -> &str {
        if self.platform.starts_with("win32-") {
            "claude.exe"
        } else {
            "claude"
        }
    }
}

pub(super) fn verify_binary(path: &Path, package: &RuntimePackage) -> Result<(), String> {
    reject_symlink(path)?;
    let mut file = File::open(path).map_err(|e| format!("Cannot open managed Claude Code: {e}"))?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() != package.binary_bytes {
        return Err("Managed Claude Code size does not match the verified release".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("Managed Claude Code is not executable".into());
        }
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if hex::encode(hash.finalize()) != package.binary_sha256 {
        return Err("Managed Claude Code checksum does not match the verified release".into());
    }
    Ok(())
}

struct StagingDirectory(PathBuf);
impl Drop for StagingDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(super) fn install(manager: &ClaudeRuntimeManager) -> Result<(), String> {
    let package = current_package()?;
    manager.check_cancelled()?;
    reject_symlink(&manager.root)?;
    let versions = manager.root.join("versions");
    reject_symlink(&versions)?;
    crate::secure_fs::ensure_private_dir(&versions).map_err(|e| e.to_string())?;
    let lock_path = manager.root.join("install.lock");
    reject_symlink(&lock_path)?;
    let lock = crate::secure_fs::open_private_lock_file(&lock_path).map_err(|e| e.to_string())?;
    lock.try_lock_exclusive()
        .map_err(|_| "Another CCEM process is installing Claude Code".to_string())?;
    if let Ok(active) = manager.active_managed_dir(package) {
        if reject_symlink(&active).is_ok()
            && verify_binary(&active.join(package.binary_name()), package).is_ok()
        {
            return Ok(());
        }
    }
    // Repair publishes a new immutable generation. The previous binary may be
    // pinned by a running process and must never be replaced or removed.
    let destination = versions.join(format!(
        "{}-{}-{:016x}",
        manifest().claude_version,
        package.platform,
        rand::random::<u64>()
    ));
    let staging_root = manager.root.join("staging");
    reject_symlink(&staging_root)?;
    crate::secure_fs::ensure_private_dir(&staging_root).map_err(|e| e.to_string())?;
    let stage = StagingDirectory(staging_root.join(format!(
        "install-{}-{:016x}",
        std::process::id(),
        rand::random::<u64>()
    )));
    fs::create_dir(&stage.0).map_err(|e| e.to_string())?;
    let archive = stage.0.join("package.tgz");
    tauri::async_runtime::block_on(download(manager, package, &archive))?;
    manager.check_cancelled()?;
    manager.update_progress("verifying", None);
    verify_archive(&archive, package, || manager.check_cancelled())?;
    manager.update_progress("extracting", None);
    let extracted = stage.0.join("runtime");
    fs::create_dir(&extracted).map_err(|e| e.to_string())?;
    extract_archive(&archive, &extracted, package, || manager.check_cancelled())?;
    manager.check_cancelled()?;
    let binary = extracted.join(package.binary_name());
    verify_binary(&binary, package)?;
    let probe = probe_candidate(
        &binary.to_string_lossy(),
        &manifest().minimum_system_version,
    );
    if probe.state != "available"
        || probe.version.as_deref() != Some(manifest().claude_version.as_str())
    {
        return Err(probe.detail.unwrap_or_else(|| {
            "Downloaded Claude Code failed its version/capability check".into()
        }));
    }
    manager.check_cancelled()?;
    // Same filesystem, same process lock, atomic publication after every check.
    // Existing runtime directories are never replaced; only the active pointer changes.
    if destination.exists() {
        return Err("Claude runtime destination already exists; refresh status".into());
    }
    fs::rename(&extracted, &destination)
        .map_err(|e| format!("Cannot activate Claude Code: {e}"))?;
    manager.check_cancelled()?;
    manager.activate_managed_dir(&destination, package)?;
    Ok(())
}

async fn download(
    manager: &ClaudeRuntimeManager,
    package: &RuntimePackage,
    destination: &Path,
) -> Result<(), String> {
    let url = reqwest::Url::parse(&package.url).map_err(|e| e.to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("registry.npmjs.org")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !url.path().starts_with("/@anthropic-ai/claude-agent-sdk-")
    {
        return Err("Claude runtime source is not an approved Anthropic npm artifact".into());
    }
    if package.archive_bytes == 0 || package.archive_bytes > MAX_ARCHIVE_BYTES {
        return Err("Claude runtime archive size is outside the allowed limit".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = tokio::time::timeout(Duration::from_secs(15), client.get(url).send())
        .await
        .map_err(|_| "Claude runtime download connection timed out".to_string())?
        .map_err(|e| format!("Cannot download Claude Code: {e}"))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!(
            "Claude runtime server returned {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length != package.archive_bytes)
    {
        return Err("Claude runtime archive length does not match its pinned release".into());
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|e| e.to_string())?;
    let mut downloaded = 0u64;
    let mut last_data = Instant::now();
    loop {
        manager.check_cancelled()?;
        match tokio::time::timeout(Duration::from_secs(1), response.chunk()).await {
            Ok(Ok(Some(chunk))) => {
                downloaded += chunk.len() as u64;
                if downloaded > package.archive_bytes {
                    return Err("Claude runtime archive exceeded its pinned size".into());
                }
                output
                    .write_all(&chunk)
                    .map_err(|e| format!("Cannot save Claude runtime download: {e}"))?;
                manager.update_progress("downloading", Some(downloaded));
                last_data = Instant::now();
            }
            Ok(Ok(None)) => break,
            Ok(Err(error)) => return Err(format!("Claude runtime download failed: {error}")),
            Err(_) if last_data.elapsed() >= Duration::from_secs(30) => {
                return Err("Claude runtime download stopped responding".into())
            }
            Err(_) => continue,
        }
    }
    if downloaded != package.archive_bytes {
        return Err("Claude runtime download is incomplete".into());
    }
    output.sync_all().map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn verify_archive(
    path: &Path,
    package: &RuntimePackage,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    let mut archive = File::open(path).map_err(|e| e.to_string())?;
    if archive.metadata().map_err(|e| e.to_string())?.len() != package.archive_bytes {
        return Err("Claude runtime download is incomplete".into());
    }
    let expected = package
        .integrity
        .strip_prefix("sha512-")
        .ok_or_else(|| "Claude runtime archive has no pinned SHA-512 integrity".to_string())?;
    let expected = base64::engine::general_purpose::STANDARD
        .decode(expected)
        .map_err(|e| e.to_string())?;
    let mut hash = Sha512::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        check()?;
        let count = archive.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if hash.finalize().as_slice() != expected.as_slice() {
        return Err("Claude runtime archive checksum does not match its pinned release".into());
    }
    Ok(())
}

pub(super) fn extract_archive(
    path: &Path,
    destination: &Path,
    package: &RuntimePackage,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    let input = File::open(path).map_err(|e| e.to_string())?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(input));
    let allowed = [
        package.binary_path.as_str(),
        "package/LICENSE.md",
        "package/README.md",
        "package/package.json",
    ];
    let mut found = HashSet::new();
    for entry in archive
        .entries()
        .map_err(|e| format!("Cannot read Claude runtime archive: {e}"))?
    {
        check()?;
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry
            .path()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();
        if !allowed.contains(&path.as_str())
            || !entry.header().entry_type().is_file()
            || !found.insert(path.clone())
        {
            return Err(format!("Unexpected Claude runtime archive member: {path}"));
        }
        let size = entry.size();
        let is_binary = path == package.binary_path;
        if (is_binary && (size != package.binary_bytes || size > MAX_BINARY_BYTES))
            || (!is_binary && size > 64 * 1024)
        {
            return Err(format!(
                "Claude runtime archive member has an invalid size: {path}"
            ));
        }
        if is_binary || path == "package/LICENSE.md" {
            let output_path = destination.join(if is_binary {
                package.binary_name()
            } else {
                "LICENSE.md"
            });
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&output_path)
                .map_err(|e| e.to_string())?;
            let mut buffer = [0u8; 128 * 1024];
            loop {
                check()?;
                let count = entry.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    break;
                }
                output
                    .write_all(&buffer[..count])
                    .map_err(|e| e.to_string())?;
            }
            output.sync_all().map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(
                    &output_path,
                    fs::Permissions::from_mode(if is_binary { 0o500 } else { 0o400 }),
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    if found.len() != allowed.len() {
        return Err("Claude runtime archive is missing required files".into());
    }
    Ok(())
}
