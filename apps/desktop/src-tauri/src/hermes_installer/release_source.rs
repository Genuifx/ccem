use super::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::{redirect::Policy, Url};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseSource {
    schema_version: u32,
    version: String,
    sequence: u64,
    manifest_url: String,
}

/// The updater key is already pinned in the application binary. A downloaded public key
/// must never be able to replace it. CI signs Hermes with the same publisher identity.
pub(super) fn pinned_source() -> Result<(String, String), HermesInstallError> {
    let source: ReleaseSource =
        serde_json::from_str(include_str!("../../hermes-runtime-source.json"))
            .map_err(|_| source_failure())?;
    let expected = format!(
        "https://github.com/Genuifx/ccem/releases/download/{}/manifest.json",
        source.version
    );
    if source.schema_version != 1
        || source.sequence == 0
        || source.version.split('.').count() != 4
        || source
            .version
            .split('.')
            .any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
        || source.manifest_url != expected
    {
        return Err(source_failure());
    }
    let config: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
        .map_err(|_| source_failure())?;
    let encoded = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or_else(source_failure)?;
    let public_key = String::from_utf8(STANDARD.decode(encoded).map_err(|_| source_failure())?)
        .map_err(|_| source_failure())?;
    let mut trust = ManifestTrustStore::new();
    trust
        .add_minisign_key(KEY_ID, &public_key)
        .map_err(|_| source_failure())?;
    Ok((source.manifest_url, public_key))
}

pub(super) fn is_release_asset(url: &Url) -> bool {
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let Some(parts) = url.path().strip_prefix("/Genuifx/ccem/releases/download/") else {
        return false;
    };
    let parts: Vec<_> = parts.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && *part != "."
                && *part != ".."
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
        })
}

fn allowed_redirect(initial: &Url, previous: &[Url], destination: &Url) -> bool {
    is_release_asset(initial)
        && previous.first() == Some(initial)
        && previous.len() <= 3
        && previous.iter().skip(1).all(is_asset_cdn)
        && is_asset_cdn(destination)
}

fn is_asset_cdn(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("release-assets.githubusercontent.com")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

pub(super) fn redirect_policy(initial_url: &str) -> Policy {
    let initial = Url::parse(initial_url).ok();
    Policy::custom(move |attempt| {
        if initial
            .as_ref()
            .is_some_and(|initial| allowed_redirect(initial, attempt.previous(), attempt.url()))
        {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_release_is_pinned_and_uses_the_existing_publisher_key() {
        let (url, key) = pinned_source().unwrap();
        assert!(is_release_asset(&Url::parse(&url).unwrap()));
        assert!(key.starts_with("untrusted comment: minisign public key:"));
        let source = Source::configured().unwrap();
        assert!(!source.development_loopback);
    }

    #[test]
    fn only_exact_release_origin_can_follow_to_the_signed_cdn_url() {
        let initial = Url::parse(
            "https://github.com/Genuifx/ccem/releases/download/2026.10.2.1/manifest.json",
        )
        .unwrap();
        let cdn = Url::parse("https://release-assets.githubusercontent.com/github-production-release-asset/1?se=expires&sig=signature").unwrap();
        assert!(allowed_redirect(
            &initial,
            std::slice::from_ref(&initial),
            &cdn
        ));
        for invalid in [
            "http://release-assets.githubusercontent.com/file",
            "https://release-assets.githubusercontent.com:444/file",
            "https://release-assets.githubusercontent.com.evil.test/file",
            "https://raw.githubusercontent.com/Genuifx/ccem/main/file",
            "https://user:password@release-assets.githubusercontent.com/file",
            "https://release-assets.githubusercontent.com/file#fragment",
            "https://github.com/other/repo/releases/download/tag/file",
        ] {
            assert!(
                !allowed_redirect(
                    &initial,
                    std::slice::from_ref(&initial),
                    &Url::parse(invalid).unwrap()
                ),
                "{invalid}"
            );
        }
        let other = Url::parse("https://github.com/other/repo/releases/download/tag/file").unwrap();
        assert!(!allowed_redirect(
            &other,
            std::slice::from_ref(&other),
            &cdn
        ));
        assert!(!allowed_redirect(
            &initial,
            &[initial.clone(), cdn.clone(), cdn.clone(), cdn.clone()],
            &cdn
        ));
    }

    #[test]
    #[ignore = "requires network; reads only an existing public release asset"]
    fn real_github_release_download_keeps_the_fixed_url_and_verifies_the_hash() {
        let url = "https://github.com/Genuifx/ccem/releases/download/v2.91.0/latest.json";
        let bytes = fetch_bounded(url, MAX_MANIFEST_BYTES).unwrap();
        assert!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["version"].is_string()
        );
        use sha2::{Digest, Sha256};
        let root = tempfile::tempdir().unwrap();
        let spec = DownloadSpec {
            source_url: url.into(),
            expected_size: bytes.len() as u64,
            expected_sha256: hex::encode(Sha256::digest(&bytes)),
            completed_path: root.path().join("asset.json"),
        };
        // A restarted app obtains a fresh CDN URL from the fixed origin. Its persisted
        // Range validator and verified prefix must remain valid across that redirect.
        let probe = reqwest::blocking::Client::builder()
            .redirect(redirect_policy(url))
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap()
            .get(url)
            .header("Range", "bytes=0-0")
            .header("Accept-Encoding", "identity")
            .send()
            .unwrap();
        assert_eq!(probe.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            probe.headers()["content-range"],
            format!("bytes 0-0/{}", bytes.len())
        );
        let etag = probe.headers()["etag"].to_str().unwrap().to_string();
        assert!(!etag.starts_with("W/"));
        assert_eq!(probe.bytes().unwrap().as_ref(), &bytes[..1]);
        let offset = bytes.len() / 2;
        fs::write(root.path().join(".asset.json.part"), &bytes[..offset]).unwrap();
        fs::write(
            root.path().join(".asset.json.download.json"),
            serde_json::to_vec(&serde_json::json!({
                "schema_version": 1, "source_url": url, "expected_size": bytes.len(),
                "expected_sha256": spec.expected_sha256, "completed_bytes": offset,
                "validator": {"kind": "strong_etag", "value": etag}, "status": "paused"
            }))
            .unwrap(),
        )
        .unwrap();
        let outcome = download_archive_with_redirect_policy(
            &spec,
            &DownloadControl::default(),
            &(),
            Duration::from_secs(10),
            Duration::from_secs(30),
            redirect_policy(url),
        )
        .unwrap();
        assert_eq!(outcome.byte_size, bytes.len() as u64);
        assert_eq!(fs::read(outcome.completed_path).unwrap(), bytes);
    }
}
