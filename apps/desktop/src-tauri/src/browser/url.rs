pub(super) fn parse_browser_url(raw: &str) -> Result<tauri::Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Browser URL cannot be empty".to_string());
    }

    let candidate = if has_explicit_browser_url_scheme(trimmed) {
        trimmed.to_string()
    } else {
        let scheme = if browser_host_defaults_to_http(trimmed) {
            "http"
        } else {
            "https"
        };
        format!("{scheme}://{trimmed}")
    };
    let parsed =
        tauri::Url::parse(&candidate).map_err(|error| format!("Invalid browser URL: {error}"))?;
    if is_allowed_browser_navigation(&parsed) {
        Ok(parsed)
    } else {
        Err("Browser URL must use http://, https://, or about:blank".to_string())
    }
}

fn has_explicit_browser_url_scheme(raw: &str) -> bool {
    let Some(colon) = raw.find(':') else {
        return false;
    };
    let scheme = &raw[..colon];
    let mut chars = scheme.chars();
    if !chars.next().is_some_and(|ch| ch.is_ascii_alphabetic())
        || !chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
    {
        return false;
    }

    // A bare host with a numeric port (for example localhost:3000) is not a URL scheme.
    let port_candidate = raw[colon + 1..]
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    port_candidate.is_empty() || !port_candidate.chars().all(|ch| ch.is_ascii_digit())
}

fn browser_host_defaults_to_http(raw: &str) -> bool {
    use std::net::IpAddr;

    let authority = raw.split(['/', '?', '#']).next().unwrap_or_default().trim();
    let host = if authority.starts_with('[') {
        authority
            .find(']')
            .map(|closing| &authority[1..closing])
            .unwrap_or(authority)
    } else {
        authority
            .rsplit_once(':')
            .filter(|(_, port)| !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()))
            .map(|(host, _)| host)
            .unwrap_or(authority)
    };

    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false)
}

pub(super) fn is_allowed_browser_navigation(url: &tauri::Url) -> bool {
    match url.scheme() {
        "http" | "https" => url.host_str().is_some(),
        "about" => url.as_str().eq_ignore_ascii_case("about:blank"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{is_allowed_browser_navigation, parse_browser_url};

    #[test]
    fn parse_browser_url_adds_https_when_missing() {
        let parsed = parse_browser_url("example.com").expect("parse url");
        assert_eq!(parsed.as_str(), "https://example.com/");
    }

    #[test]
    fn parse_browser_url_defaults_loopback_hosts_to_http() {
        for (input, expected) in [
            ("localhost:3000/app", "http://localhost:3000/app"),
            ("127.0.0.1:5173", "http://127.0.0.1:5173/"),
            ("127.42.0.8/path", "http://127.42.0.8/path"),
            ("[::1]:8080", "http://[::1]:8080/"),
        ] {
            let parsed =
                parse_browser_url(input).unwrap_or_else(|error| panic!("{input}: {error}"));
            assert_eq!(parsed.as_str(), expected);
        }

        assert_eq!(
            parse_browser_url("example.com:8443")
                .expect("public host")
                .as_str(),
            "https://example.com:8443/"
        );
    }

    #[test]
    fn parse_browser_url_accepts_only_preview_schemes() {
        for input in [
            "http://127.0.0.1:3000",
            "https://example.com/path",
            "about:blank",
        ] {
            parse_browser_url(input).unwrap_or_else(|error| panic!("{input}: {error}"));
        }

        for input in [
            "file:///tmp/secret",
            "data:text/html,hello",
            "javascript:alert(1)",
            "tauri://localhost/index.html",
            "about:srcdoc",
            "mailto:test@example.com",
        ] {
            assert!(
                parse_browser_url(input).is_err(),
                "unsupported scheme should be rejected: {input}"
            );
        }
    }

    #[test]
    fn browser_navigation_policy_blocks_non_preview_schemes() {
        for input in [
            "http://127.0.0.1:3000",
            "https://example.com/path",
            "about:blank",
        ] {
            let url = tauri::Url::parse(input).expect("valid test URL");
            assert!(is_allowed_browser_navigation(&url), "should allow {input}");
        }

        for input in [
            "file:///tmp/secret",
            "data:text/html,hello",
            "javascript:alert(1)",
            "tauri://localhost/index.html",
            "about:srcdoc",
        ] {
            let url = tauri::Url::parse(input).expect("valid test URL");
            assert!(
                !is_allowed_browser_navigation(&url),
                "should reject {input}"
            );
        }
    }
}
