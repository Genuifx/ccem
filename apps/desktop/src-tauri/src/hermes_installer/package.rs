use super::*;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::File,
    process::{Command, Stdio},
    time::Instant,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageIdentity {
    schema_version: u32,
    protocol_version: u32,
    hermes_commit: String,
    uv_lock_sha256: String,
    python_version: String,
    platform: String,
    architecture: String,
    channels: Vec<String>,
    files: Vec<PackageFile>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PackageFile {
    path: String,
    size: u64,
    sha256: String,
}

/// Authenticate the cached zip, then compare its inventory with every installed payload file.
/// A mutable receipt alone cannot authorize a replaced Python module or host script on restart.
pub(super) fn verify_package(
    launch: &HermesLaunch,
    manifest: &VerifiedRuntimeManifest,
    archive: &Path,
) -> Result<(), HermesInstallError> {
    let artifact = &manifest.manifest.artifact;
    if hash_file(archive, artifact.archive.byte_size)? != artifact.archive.sha256 {
        return Err(failure(
            "archive_hash",
            "聊天组件缓存校验失败，请重新安装。",
            true,
        ));
    }
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|_| io_failure())?)
        .map_err(|_| failure("archive_rejected", "聊天组件缓存无效。", false))?;
    let mut entry = zip
        .by_name("hermes-runtime/runtime.json")
        .map_err(|_| failure("package_identity", "聊天组件缺少版本清单。", false))?;
    if entry.size() > 16 * 1024 * 1024 {
        return Err(failure("package_identity", "聊天组件文件清单过大。", false));
    }
    let mut identity_bytes = Vec::new();
    entry
        .read_to_end(&mut identity_bytes)
        .map_err(|_| io_failure())?;
    let identity: PackageIdentity = serde_json::from_slice(&identity_bytes)
        .map_err(|_| failure("package_identity", "聊天组件文件清单无效。", false))?;
    if identity.schema_version != 1
        || identity.protocol_version != HERMES_PROTOCOL_VERSION
        || identity.hermes_commit != HERMES_SOURCE_COMMIT
        || identity.uv_lock_sha256 != HERMES_LOCK_SHA256
        || identity.python_version != HERMES_PYTHON_VERSION
        || identity.platform != "macos"
        || identity.architecture != "aarch64"
        || identity.channels != ["wecom", "feishu"]
        || identity.files.len() > 60_000
    {
        return Err(failure(
            "package_identity",
            "聊天组件与已审核的兼容版本不符。",
            false,
        ));
    }
    if read_regular(&launch.runtime_root.join("runtime.json"), 16 * 1024 * 1024)? != identity_bytes
    {
        return Err(failure(
            "package_integrity",
            "聊天组件版本清单已变化。",
            false,
        ));
    }
    let mut expected = BTreeSet::new();
    let root = fs::canonicalize(&launch.runtime_root).map_err(|_| io_failure())?;
    for item in &identity.files {
        if !safe_path(&item.path)
            || [
                "runtime.json",
                "manifest.json",
                "manifest.json.sig",
                "verification-receipt.json",
            ]
            .contains(&item.path.as_str())
            || !expected.insert(item.path.clone())
            || item.size > artifact.archive.max_file_bytes
            || item.sha256.len() != 64
        {
            return Err(failure(
                "package_identity",
                "聊天组件文件清单包含无效路径。",
                false,
            ));
        }
        let file = root.join(&item.path);
        let canonical = fs::canonicalize(&file).map_err(|_| io_failure())?;
        if !canonical.starts_with(&root) || hash_file(&file, item.size)? != item.sha256 {
            return Err(failure(
                "package_integrity",
                "聊天组件文件校验失败。",
                false,
            ));
        }
    }
    if ![
        "python/bin/python3.11",
        "source/uv.lock",
        "ccem_gateway_host.py",
        "LICENSE",
        "NOTICE",
    ]
    .iter()
    .all(|p| expected.contains(*p))
    {
        return Err(failure("package_identity", "聊天组件不完整。", false));
    }
    // Only signed payload files and the three installer-created records may be present. Python
    // bytecode is disabled at launch; no runtime writes belong inside the version directory.
    let mut pending = vec![root.clone()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(dir).map_err(|_| io_failure())? {
            let entry = entry.map_err(|_| io_failure())?;
            let meta = fs::symlink_metadata(entry.path()).map_err(|_| io_failure())?;
            let relative = entry
                .path()
                .strip_prefix(&root)
                .map_err(|_| io_failure())?
                .to_str()
                .ok_or_else(io_failure)?
                .to_owned();
            if meta.file_type().is_symlink() {
                return Err(failure(
                    "package_integrity",
                    "聊天组件含非预期符号链接。",
                    false,
                ));
            }
            if meta.is_dir() {
                pending.push(entry.path());
            } else if !expected.contains(&relative)
                && ![
                    "runtime.json",
                    "manifest.json",
                    "manifest.json.sig",
                    "verification-receipt.json",
                ]
                .contains(&relative.as_str())
            {
                return Err(failure(
                    "package_integrity",
                    "聊天组件目录含非预期文件。",
                    false,
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn health_check(
    launch: &HermesLaunch,
    cancelled: &AtomicBool,
) -> Result<(), HermesInstallError> {
    // A private bounded output file avoids inherited pipe handles keeping a reader alive. The
    // exact owned child is killed/reaped on timeout/cancel; no system Python, shell or pip runs.
    let output_path = launch.runtime_root.join(format!(".health-{}", random_id()));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true).read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let output = options.open(&output_path).map_err(|_| io_failure())?;
    let result = (|| {
        let mut child = Command::new(&launch.python)
            .arg("-I")
            .arg("-B")
            .arg(&launch.host)
            .arg("--self-test")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LANG", "en_US.UTF-8")
            .env("HOME", &launch.runtime_root)
            .current_dir(&launch.runtime_root)
            .stdin(Stdio::null())
            .stdout(Stdio::from(output.try_clone().map_err(|_| io_failure())?))
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| failure("health_check", "聊天组件解释器无法启动。", true))?;
        let started = Instant::now();
        loop {
            if cancelled.load(Ordering::Acquire)
                || started.elapsed() > Duration::from_secs(30)
                || output.metadata().map_err(|_| io_failure())?.len() > 64 * 1024
            {
                let _ = child.kill();
                let _ = child.wait();
                return Err(failure(
                    if cancelled.load(Ordering::Acquire) {
                        "cancelled"
                    } else {
                        "health_check"
                    },
                    "聊天组件健康检查取消或超时。",
                    true,
                ));
            }
            if let Some(status) = child.try_wait().map_err(|_| io_failure())? {
                if !status.success() {
                    return Err(failure("health_check", "聊天组件健康检查未通过。", true));
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let body = read_regular(&output_path, 64 * 1024)?;
        let reply: serde_json::Value = serde_json::from_slice(&body)
            .map_err(|_| failure("health_check", "聊天组件健康检查返回无效数据。", false))?;
        if reply.get("ok") != Some(&serde_json::Value::Bool(true))
            || reply.get("protocolVersion").and_then(|v| v.as_u64())
                != Some(HERMES_PROTOCOL_VERSION as u64)
        {
            return Err(failure("health_check", "聊天组件桥协议不兼容。", false));
        }
        Ok(())
    })();
    drop(output);
    let _ = fs::remove_file(output_path);
    result
}

fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains(['\\', '\0'])
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
        && Path::new(path)
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}
fn hash_file(path: &Path, size: u64) -> Result<String, HermesInstallError> {
    let meta = fs::symlink_metadata(path).map_err(|_| io_failure())?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() != size {
        return Err(failure(
            "package_integrity",
            "聊天组件文件类型或大小不符。",
            false,
        ));
    }
    let mut file = File::open(path).map_err(|_| io_failure())?.take(size + 1);
    let mut hash = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total = 0;
    loop {
        let read = file.read(&mut buf).map_err(|_| io_failure())?;
        if read == 0 {
            break;
        }
        total += read as u64;
        hash.update(&buf[..read]);
    }
    if total != size {
        return Err(failure(
            "package_integrity",
            "聊天组件文件大小发生变化。",
            false,
        ));
    }
    Ok(hex::encode(hash.finalize()))
}
