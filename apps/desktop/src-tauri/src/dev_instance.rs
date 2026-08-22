const DEFAULT_MCP_BASE_PORT: u16 = 9223;

pub fn mcp_base_port() -> u16 {
    let value = std::env::var("CCEM_TAURI_MCP_PORT").ok();
    parse_mcp_base_port(value.as_deref())
}

pub fn automatic_background_services_enabled() -> bool {
    let instance_id = std::env::var("CCEM_DESKTOP_DEV_INSTANCE_ID").ok();
    let override_value = std::env::var("CCEM_DESKTOP_DEV_BACKGROUND_SERVICES").ok();
    background_services_enabled(
        cfg!(debug_assertions),
        instance_id.as_deref(),
        override_value.as_deref(),
    )
}

fn parse_mcp_base_port(value: Option<&str>) -> u16 {
    value
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| (1024..=65436).contains(port))
        .unwrap_or(DEFAULT_MCP_BASE_PORT)
}

fn background_services_enabled(
    debug_assertions: bool,
    instance_id: Option<&str>,
    override_value: Option<&str>,
) -> bool {
    if !debug_assertions {
        return true;
    }

    if let Some(value) = override_value {
        return matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        );
    }

    !instance_id.is_some_and(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::{background_services_enabled, parse_mcp_base_port, DEFAULT_MCP_BASE_PORT};

    #[test]
    fn named_dev_instances_disable_automatic_shared_services_by_default() {
        assert!(!background_services_enabled(
            true,
            Some("feature-alpha-12345678"),
            None,
        ));
        assert!(background_services_enabled(
            true,
            Some("feature-alpha-12345678"),
            Some("1"),
        ));
        assert!(!background_services_enabled(
            true,
            Some("feature-alpha-12345678"),
            Some("0"),
        ));
    }

    #[test]
    fn legacy_debug_and_release_startup_remain_compatible() {
        assert!(background_services_enabled(true, None, None));
        assert!(background_services_enabled(
            false,
            Some("ignored"),
            Some("0")
        ));
    }

    #[test]
    fn mcp_base_port_accepts_only_a_complete_scan_range() {
        assert_eq!(parse_mcp_base_port(Some("42200")), 42200);
        assert_eq!(parse_mcp_base_port(Some("1024")), 1024);
        assert_eq!(parse_mcp_base_port(Some("65436")), 65436);
        for invalid in [None, Some(""), Some("1023"), Some("65437"), Some("oops")] {
            assert_eq!(parse_mcp_base_port(invalid), DEFAULT_MCP_BASE_PORT);
        }
    }
}
