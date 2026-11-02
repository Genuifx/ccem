//! A registry changes only where the already-pinned artifact is downloaded.
//! Package identity, version, sizes and checksums always come from the app manifest.

use super::{manifest, RuntimePackage};
use reqwest::{redirect::Policy, Url};

pub(super) const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org/";
const MAX_REGISTRY_LENGTH: usize = 2048;
const MAX_REDIRECT_URL_LENGTH: usize = 8192;
const MAX_REDIRECTS: usize = 5;

pub(super) fn normalize(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_REGISTRY_LENGTH || value.chars().any(char::is_control)
    {
        return Err(
            "Claude runtime registry must be a valid HTTPS URL of at most 2048 characters".into(),
        );
    }
    let mut url =
        Url::parse(value).map_err(|_| "Claude runtime registry URL is invalid".to_string())?;
    validate_https_target(&url)?;
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Claude runtime registry must not include a query or fragment".into());
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    if url.as_str().len() > MAX_REGISTRY_LENGTH {
        return Err("Claude runtime registry URL is too long".into());
    }
    Ok(url.to_string())
}

pub(super) fn download_url(registry: &str, package: &RuntimePackage) -> Result<Url, String> {
    let base = Url::parse(&normalize(registry)?).map_err(|e| e.to_string())?;
    let official = Url::parse(&package.url)
        .map_err(|_| "Embedded Claude artifact URL is invalid".to_string())?;
    let pinned_path = format!(
        "/@anthropic-ai/claude-agent-sdk-{}/-/claude-agent-sdk-{}-{}.tgz",
        package.platform,
        package.platform,
        manifest().sdk_version,
    );
    if official.scheme() != "https"
        || official.host_str() != Some("registry.npmjs.org")
        || !official.username().is_empty()
        || official.password().is_some()
        || official.port().is_some()
        || official.query().is_some()
        || official.fragment().is_some()
        || official.path() != pinned_path
    {
        return Err("Embedded Claude artifact does not match the pinned Anthropic package".into());
    }
    // A relative join retains repository prefixes such as /repository/npm/.
    base.join(pinned_path.trim_start_matches('/'))
        .map_err(|e| e.to_string())
}

fn validate_https_target(url: &Url) -> Result<(), String> {
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err("Claude runtime download sources must use HTTPS".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Claude runtime download URLs must not contain credentials".into());
    }
    Ok(())
}

pub(super) fn validate_redirect(target: &Url, previous_count: usize) -> Result<(), String> {
    // reqwest includes the initial URL in `previous`: count 1 is the first hop.
    if previous_count > MAX_REDIRECTS {
        return Err("Claude runtime download exceeded 5 redirects".into());
    }
    if target.as_str().len() > MAX_REDIRECT_URL_LENGTH {
        return Err("Claude runtime redirect URL is too long".into());
    }
    validate_https_target(target)
}

pub(super) fn redirect_policy() -> Policy {
    Policy::custom(
        |attempt| match validate_redirect(attempt.url(), attempt.previous().len()) {
            Ok(()) => attempt.follow(),
            Err(error) => attempt.error(error),
        },
    )
}
