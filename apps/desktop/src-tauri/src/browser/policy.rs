const READ_ONLY_BROWSER_TOOLS: &[&str] = &[
    "get_url",
    "snapshot",
    "screenshot",
    "read_console_log",
    "read_network_log",
];

fn browser_mode_is_restricted(mode: &str) -> bool {
    matches!(mode, "readonly" | "audit" | "plan" | "safe" | "ci")
}

fn browser_tool_is_known(tool: &str) -> bool {
    matches!(
        tool,
        "navigate"
            | "get_url"
            | "snapshot"
            | "click"
            | "type"
            | "press_key"
            | "scroll"
            | "screenshot"
            | "evaluate"
            | "wait_for"
            | "read_console_log"
            | "read_network_log"
    )
}

pub(crate) fn authorize_browser_tool(permission_mode: &str, tool: &str) -> Result<(), String> {
    if !browser_tool_is_known(tool) {
        return Err(format!(
            "Browser tool '{tool}' is not recognized by Rust policy."
        ));
    }
    if browser_mode_is_restricted(permission_mode) && !READ_ONLY_BROWSER_TOOLS.contains(&tool) {
        return Err(format!(
            "Browser tool '{tool}' is blocked by current permission mode '{permission_mode}'."
        ));
    }
    if !matches!(
        permission_mode,
        "dev" | "yolo" | "bypassPermissions" | "readonly" | "audit" | "plan" | "safe" | "ci"
    ) && !READ_ONLY_BROWSER_TOOLS.contains(&tool)
    {
        return Err(format!(
            "Browser tool '{tool}' is blocked because permission mode '{permission_mode}' is unknown."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::authorize_browser_tool;

    #[test]
    fn restricted_modes_allow_diagnostics_and_block_page_mutation() {
        for mode in ["readonly", "audit", "plan", "safe", "ci"] {
            for tool in [
                "get_url",
                "snapshot",
                "screenshot",
                "read_console_log",
                "read_network_log",
            ] {
                authorize_browser_tool(mode, tool)
                    .unwrap_or_else(|error| panic!("{mode}/{tool}: {error}"));
            }
            for tool in [
                "navigate",
                "click",
                "type",
                "press_key",
                "scroll",
                "evaluate",
            ] {
                assert!(
                    authorize_browser_tool(mode, tool).is_err(),
                    "{mode} must block {tool}"
                );
            }
        }
    }

    #[test]
    fn development_modes_allow_semantic_browser_tools() {
        for mode in ["dev", "yolo", "bypassPermissions"] {
            for tool in [
                "navigate",
                "get_url",
                "snapshot",
                "click",
                "type",
                "press_key",
                "scroll",
                "screenshot",
                "evaluate",
                "wait_for",
            ] {
                authorize_browser_tool(mode, tool)
                    .unwrap_or_else(|error| panic!("{mode}/{tool}: {error}"));
            }
        }
    }

    #[test]
    fn unknown_modes_and_unknown_tools_fail_closed() {
        assert!(authorize_browser_tool("custom", "click").is_err());
        assert!(authorize_browser_tool("dev", "raw_cdp").is_err());
        assert!(authorize_browser_tool("custom", "snapshot").is_ok());
        assert!(authorize_browser_tool("custom", "read_network_log").is_ok());
    }
}
