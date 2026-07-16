//! Terminal integration for launching Claude Code in Terminal.app or iTerm2

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

/// Supported terminal types on macOS
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalType {
    TerminalApp,
    ITerm2,
}

impl TerminalType {
    /// Get the display name for this terminal type
    pub fn display_name(&self) -> &'static str {
        match self {
            TerminalType::TerminalApp => "Terminal.app",
            TerminalType::ITerm2 => "iTerm2",
        }
    }

    /// Get the application name used in AppleScript
    pub fn app_name(&self) -> &'static str {
        match self {
            TerminalType::TerminalApp => "Terminal",
            TerminalType::ITerm2 => "iTerm2",
        }
    }
}

/// Information about an available terminal
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalInfo {
    pub terminal_type: TerminalType,
    pub name: String,
    pub installed: bool,
}

/// Terminal targets available for opening an existing tmux-backed session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TmuxAttachTerminalType {
    TerminalApp,
    ITerm2,
    Ghostty,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxAttachTerminalInfo {
    pub terminal_type: TmuxAttachTerminalType,
    pub name: String,
    pub installed: bool,
    pub preferred: bool,
}

/// Get the path to the terminal preferences file
fn get_terminal_prefs_path() -> PathBuf {
    let home = dirs::home_dir().expect("Could not find home directory");
    home.join(".config")
        .join("claude-code-env-manager")
        .join("terminal-prefs.json")
}

/// Preferences for terminal settings
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct TerminalPrefs {
    preferred_terminal: Option<TerminalType>,
}

/// Check if an application is installed on macOS
fn is_app_installed(app_name: &str) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }

    // Check common locations for applications
    let paths = [
        format!("/Applications/{}.app", app_name),
        format!("/System/Applications/{}.app", app_name),
        format!(
            "{}/Applications/{}.app",
            dirs::home_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
            app_name
        ),
    ];

    for path in &paths {
        if std::path::Path::new(path).exists() {
            return true;
        }
    }

    // For Terminal.app, also check using mdfind (Spotlight)
    if app_name == "Terminal" {
        // Terminal.app is always available on macOS
        return true;
    }

    // Use mdfind as a fallback
    if let Ok(output) = Command::new("mdfind")
        .args(["kMDItemKind == 'Application'", "-name", app_name])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        return stdout
            .lines()
            .any(|line| line.contains(&format!("{}.app", app_name)));
    }

    false
}

/// Detect which terminals are installed on the system
pub fn detect_terminals() -> Vec<TerminalInfo> {
    if !external_terminal_launch_supported() {
        return Vec::new();
    }

    let mut terminals = Vec::new();

    // Terminal.app is always available on macOS
    terminals.push(TerminalInfo {
        terminal_type: TerminalType::TerminalApp,
        name: "Terminal.app".to_string(),
        installed: true,
    });

    // Check for iTerm2
    let iterm_installed = is_app_installed("iTerm");
    terminals.push(TerminalInfo {
        terminal_type: TerminalType::ITerm2,
        name: "iTerm2".to_string(),
        installed: iterm_installed,
    });

    terminals
}

/// Detect which terminals can open an existing tmux-backed session.
pub fn detect_tmux_attach_terminals() -> Vec<TmuxAttachTerminalInfo> {
    if !tmux_supported_on_current_platform() {
        return Vec::new();
    }

    let preferred = match get_preferred_terminal() {
        TerminalType::TerminalApp => Some(TmuxAttachTerminalType::TerminalApp),
        TerminalType::ITerm2 => Some(TmuxAttachTerminalType::ITerm2),
    };

    let mut terminals = detect_terminals()
        .into_iter()
        .map(|info| {
            let terminal_type = match info.terminal_type {
                TerminalType::TerminalApp => TmuxAttachTerminalType::TerminalApp,
                TerminalType::ITerm2 => TmuxAttachTerminalType::ITerm2,
            };

            TmuxAttachTerminalInfo {
                terminal_type,
                name: info.name,
                installed: info.installed,
                preferred: preferred == Some(terminal_type),
            }
        })
        .collect::<Vec<_>>();

    terminals.push(TmuxAttachTerminalInfo {
        terminal_type: TmuxAttachTerminalType::Ghostty,
        name: "Ghostty".to_string(),
        installed: resolve_ghostty_path().is_some(),
        preferred: false,
    });

    terminals
}

/// Get the user's preferred terminal
pub fn get_preferred_terminal() -> TerminalType {
    let prefs_path = get_terminal_prefs_path();

    if prefs_path.exists() {
        if let Ok(content) = fs::read_to_string(&prefs_path) {
            if let Ok(prefs) = serde_json::from_str::<TerminalPrefs>(&content) {
                if let Some(terminal) = prefs.preferred_terminal {
                    // Verify the preferred terminal is still installed
                    let terminals = detect_terminals();
                    if terminals
                        .iter()
                        .any(|t| t.terminal_type == terminal && t.installed)
                    {
                        return terminal;
                    }
                }
            }
        }
    }

    // Default to iTerm2 if installed, otherwise Terminal.app
    let terminals = detect_terminals();
    if terminals
        .iter()
        .any(|t| t.terminal_type == TerminalType::ITerm2 && t.installed)
    {
        TerminalType::ITerm2
    } else {
        TerminalType::TerminalApp
    }
}

/// Set the user's preferred terminal
pub fn set_preferred_terminal(terminal: TerminalType) -> Result<(), String> {
    let prefs_path = get_terminal_prefs_path();

    // Verify the terminal is installed
    let terminals = detect_terminals();
    if !terminals
        .iter()
        .any(|t| t.terminal_type == terminal && t.installed)
    {
        return Err(format!("{} is not installed", terminal.display_name()));
    }

    let prefs = TerminalPrefs {
        preferred_terminal: Some(terminal),
    };

    let content = serde_json::to_string_pretty(&prefs)
        .map_err(|e| format!("Failed to serialize preferences: {}", e))?;

    if let Some(parent) = prefs_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create preferences directory: {}", e))?;
    }

    fs::write(&prefs_path, content).map_err(|e| format!("Failed to write preferences: {}", e))?;

    Ok(())
}

// ============================================
// ccem launch support detection
// ============================================

/// Cached result of ccem launch support check
static CCEM_LAUNCH_SUPPORTED: OnceLock<bool> = OnceLock::new();
static CCEM_INSTALLED: OnceLock<bool> = OnceLock::new();
static CLAUDE_INSTALLED: OnceLock<bool> = OnceLock::new();
static OPENCODE_INSTALLED: OnceLock<bool> = OnceLock::new();
static LOGIN_SHELL_PATHS: OnceLock<Vec<PathBuf>> = OnceLock::new();

/// Compare a parsed semver tuple against a minimum requirement.
fn version_gte(
    major: u32,
    minor: u32,
    patch: u32,
    req_major: u32,
    req_minor: u32,
    req_patch: u32,
) -> bool {
    (major, minor, patch) >= (req_major, req_minor, req_patch)
}

/// Run `ccem --version`, parse the output, and check if >= 1.9.0.
fn check_ccem_launch_support() -> bool {
    // macOS GUI apps don't inherit shell PATH — try common locations
    let ccem_path = resolve_ccem_path().unwrap_or_else(|| "ccem".to_string());
    println!("[ccem-launch] resolved ccem path: {}", ccem_path);

    let output = match Command::new(&ccem_path).arg("--version").output() {
        Ok(o) if o.status.success() => o,
        Ok(o) => {
            println!(
                "[ccem-launch] ccem --version failed with status: {}",
                o.status
            );
            return false;
        }
        Err(e) => {
            println!("[ccem-launch] ccem --version error: {}", e);
            return false;
        }
    };

    // Check both stdout and stderr — some CLI tools print version to stderr
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let version_str = if stdout.is_empty() { &stderr } else { &stdout };
    println!(
        "[ccem-launch] ccem version output: '{}' (stderr: '{}')",
        stdout, stderr
    );

    // Output formats: "1.9.0", "ccem/1.9.0", "v2.0.0-beta.2", "ccem/v2.0.0-beta.2"
    // Extract the version part after the last '/'
    let version_part = version_str
        .rsplit('/')
        .next()
        .unwrap_or(version_str)
        .trim()
        .trim_start_matches('v'); // Strip leading 'v'

    let parts: Vec<&str> = version_part.split('.').collect();
    if parts.len() < 2 {
        println!("[ccem-launch] could not parse version: '{}'", version_part);
        return false;
    }

    let major = parts[0].parse::<u32>().unwrap_or(0);
    let minor = parts[1].parse::<u32>().unwrap_or(0);
    // Strip pre-release suffix (e.g., "0-beta.2" → "0")
    let patch = parts
        .get(2)
        .map(|p| p.split('-').next().unwrap_or("0"))
        .and_then(|p| p.parse::<u32>().ok())
        .unwrap_or(0);

    let supported = version_gte(major, minor, patch, 1, 9, 0);
    println!(
        "[ccem-launch] version {}.{}.{} >= 1.9.0 = {}",
        major, minor, patch, supported
    );
    supported
}

fn binary_exists(path: &std::path::Path) -> bool {
    path.exists() && path.is_file()
}

fn find_binaries_in_paths(binary: &str, paths: impl IntoIterator<Item = PathBuf>) -> Vec<String> {
    let lookup_names = binary_lookup_names(binary);
    paths
        .into_iter()
        .flat_map(|dir| {
            lookup_names
                .iter()
                .map(move |name| dir.join(name))
                .collect::<Vec<_>>()
        })
        .filter_map(|path| binary_exists(&path).then(|| path.to_string_lossy().to_string()))
        .collect()
}

fn binary_lookup_names(binary: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        let mut names = vec![binary.to_string()];
        let extensions =
            std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());

        for extension in extensions.split(';') {
            let extension = extension.trim();
            if extension.is_empty() {
                continue;
            }
            let extension = if extension.starts_with('.') {
                extension.to_string()
            } else {
                format!(".{extension}")
            };
            let candidate = format!("{binary}{extension}");
            if !names
                .iter()
                .any(|name| name.eq_ignore_ascii_case(&candidate))
            {
                names.push(candidate);
            }
        }

        names
    }

    #[cfg(not(windows))]
    {
        vec![binary.to_string()]
    }
}

fn login_shell_paths() -> &'static [PathBuf] {
    LOGIN_SHELL_PATHS.get_or_init(|| {
        #[cfg(windows)]
        {
            Vec::new()
        }

        #[cfg(not(windows))]
        {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            let output = Command::new(&shell)
                .args(["-li", "-c", "printf %s \"$PATH\""])
                .output();

            match output {
                Ok(out) if out.status.success() => std::env::split_paths(std::ffi::OsStr::new(
                    String::from_utf8_lossy(&out.stdout).trim(),
                ))
                .collect(),
                _ => Vec::new(),
            }
        }
    })
}

fn push_unique_path(paths: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, path: PathBuf) {
    if !path.as_os_str().is_empty() && seen.insert(path.clone()) {
        paths.push(path);
    }
}

fn nvm_node_bin_paths(home: &std::path::Path) -> Vec<PathBuf> {
    let versions_dir = home.join(".nvm").join("versions").join("node");
    let Ok(entries) = fs::read_dir(versions_dir) else {
        return Vec::new();
    };

    let mut paths = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                Some(path.join("bin"))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    paths.sort_by(|left, right| {
        nvm_node_bin_version(right)
            .cmp(&nvm_node_bin_version(left))
            .then_with(|| right.cmp(left))
    });
    paths
}

fn nvm_node_bin_version(path: &std::path::Path) -> Option<(u32, u32, u32)> {
    path.parent()
        .and_then(|version_dir| version_dir.file_name())
        .and_then(|name| name.to_str())
        .and_then(parse_semver_triplet)
}

fn common_user_path_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    #[cfg(windows)]
    {
        if let Some(value) = std::env::var_os("APPDATA") {
            paths.push(PathBuf::from(value).join("npm"));
        }
        if let Some(value) = std::env::var_os("LOCALAPPDATA") {
            paths.push(PathBuf::from(value).join("pnpm"));
        }
        if let Some(value) = std::env::var_os("ProgramFiles") {
            paths.push(PathBuf::from(value).join("nodejs"));
        }
        if let Some(home) = dirs::home_dir() {
            paths.push(home.join(".cargo").join("bin"));
            paths.push(home.join("scoop").join("shims"));
            paths.push(home.join("AppData").join("Roaming").join("npm"));
            paths.push(home.join("AppData").join("Local").join("pnpm"));
        }
        paths
    }

    #[cfg(not(windows))]
    {
        if let Some(home) = dirs::home_dir() {
            paths.push(home.join("Library").join("pnpm"));
            paths.push(home.join(".local").join("bin"));
            paths.push(home.join(".npm-global").join("bin"));
            paths.push(home.join(".cargo").join("bin"));
            paths.extend(nvm_node_bin_paths(&home));
        }
        paths.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/opt/homebrew/sbin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/usr/sbin"),
            PathBuf::from("/sbin"),
        ]);
        paths
    }
}

fn build_user_path_from_sources(
    current_path: Option<&OsStr>,
    login_paths: &[PathBuf],
    fallback_paths: &[PathBuf],
) -> String {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();

    for path in login_paths {
        push_unique_path(&mut paths, &mut seen, path.clone());
    }

    if let Some(value) = current_path {
        for path in std::env::split_paths(value) {
            push_unique_path(&mut paths, &mut seen, path);
        }
    }

    for path in fallback_paths {
        push_unique_path(&mut paths, &mut seen, path.clone());
    }

    std::env::join_paths(paths)
        .ok()
        .and_then(|value| value.into_string().ok())
        .unwrap_or_default()
}

/// Resolve the user's full command PATH for macOS GUI-launched app processes.
///
/// GUI apps often inherit a minimal PATH, while pnpm/npm CLI wrappers rely on a
/// discoverable `node` binary. Use the login shell path first, then add common
/// package manager and system locations as a fallback.
pub fn get_user_path() -> String {
    build_user_path_from_sources(
        std::env::var_os("PATH").as_deref(),
        login_shell_paths(),
        &common_user_path_candidates(),
    )
}

fn collect_binary_candidates(binary: &str, candidates: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut paths = Vec::new();

    for candidate in candidates {
        if binary_exists(std::path::Path::new(candidate)) && seen.insert(candidate.clone()) {
            paths.push(candidate.clone());
        }
    }

    if let Some(value) = std::env::var_os("PATH") {
        for path in
            find_binaries_in_paths(binary, std::env::split_paths(&value).collect::<Vec<_>>())
        {
            if seen.insert(path.clone()) {
                paths.push(path);
            }
        }
    }

    for path in find_binaries_in_paths(binary, login_shell_paths().iter().cloned()) {
        if seen.insert(path.clone()) {
            paths.push(path);
        }
    }

    paths
}

/// Resolve a CLI binary path from shell + common fallback locations.
fn resolve_binary_path(binary: &str, candidates: &[String]) -> Option<String> {
    collect_binary_candidates(binary, candidates)
        .into_iter()
        .next()
}

fn parse_semver_triplet(output: &str) -> Option<(u32, u32, u32)> {
    output.split_whitespace().find_map(|part| {
        let version = part
            .trim()
            .trim_start_matches('v')
            .split('-')
            .next()
            .unwrap_or_default();
        let mut pieces = version.split('.');
        let major = pieces.next()?.parse::<u32>().ok()?;
        let minor = pieces.next()?.parse::<u32>().ok()?;
        let patch = pieces.next()?.parse::<u32>().ok()?;
        Some((major, minor, patch))
    })
}

fn binary_version(path: &str) -> Option<(u32, u32, u32)> {
    let output = Command::new(path)
        .arg("--version")
        .env("PATH", get_user_path())
        .output()
        .ok()?;
    let text = [
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ]
    .join(" ");
    parse_semver_triplet(&text)
}

fn select_highest_versioned_binary_path(paths: Vec<String>) -> Option<String> {
    let fallback = paths.first().cloned();
    let mut best: Option<(String, (u32, u32, u32), usize)> = None;

    for (index, path) in paths.into_iter().enumerate() {
        let Some(version) = binary_version(&path) else {
            continue;
        };
        let should_replace = best
            .as_ref()
            .map(|(_, best_version, best_index)| {
                version > *best_version || (version == *best_version && index < *best_index)
            })
            .unwrap_or(true);
        if should_replace {
            best = Some((path, version, index));
        }
    }

    best.map(|(path, _, _)| path).or(fallback)
}

fn resolve_highest_versioned_binary_path(binary: &str, candidates: &[String]) -> Option<String> {
    select_highest_versioned_binary_path(collect_binary_candidates(binary, candidates))
}

fn codex_app_bundle_candidates(home: &str) -> Vec<String> {
    vec![
        "/Applications/Codex.app/Contents/Resources/codex".to_string(),
        format!("{}/Applications/Codex.app/Contents/Resources/codex", home),
    ]
}

/// Resolve the full path to the `ccem` binary.
pub fn resolve_ccem_path() -> Option<String> {
    let home = dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut candidates = windows_cli_candidates("ccem");
    candidates.extend([
        format!("{}/.local/bin/ccem", home),
        format!("{}/.npm-global/bin/ccem", home),
        "/usr/local/bin/ccem".to_string(),
        "/opt/homebrew/bin/ccem".to_string(),
    ]);
    resolve_binary_path("ccem", &candidates)
}

/// Resolve the full path to the `claude` binary.
pub fn resolve_claude_path() -> Option<String> {
    let home = dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut candidates = windows_cli_candidates("claude");
    candidates.extend([
        format!("{}/.local/bin/claude", home),
        format!("{}/.npm-global/bin/claude", home),
        format!("{}/Library/pnpm/claude", home),
        "/usr/local/bin/claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),
    ]);
    resolve_highest_versioned_binary_path("claude", &candidates)
}

/// Resolve the full path to the `codex` binary.
pub fn resolve_codex_path() -> Option<String> {
    let home = dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut candidates = windows_cli_candidates("codex");
    candidates.extend([
        format!("{}/.local/bin/codex", home),
        format!("{}/.npm-global/bin/codex", home),
        format!("{}/.cargo/bin/codex", home),
        "/usr/local/bin/codex".to_string(),
        "/opt/homebrew/bin/codex".to_string(),
    ]);
    candidates.extend(codex_app_bundle_candidates(&home));
    resolve_highest_versioned_binary_path("codex", &candidates)
}

/// Resolve the full path to the `opencode` binary.
pub fn resolve_opencode_path() -> Option<String> {
    let home = dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut candidates = windows_cli_candidates("opencode");
    candidates.extend([
        format!("{}/.local/bin/opencode", home),
        format!("{}/.npm-global/bin/opencode", home),
        "/usr/local/bin/opencode".to_string(),
        "/opt/homebrew/bin/opencode".to_string(),
    ]);
    resolve_binary_path("opencode", &candidates)
}

/// Resolve the full path to the `tmux` binary.
pub fn resolve_tmux_path() -> Option<String> {
    if !tmux_supported_on_current_platform() {
        return None;
    }

    let home = dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let candidates = vec![
        format!("{}/.local/bin/tmux", home),
        "/usr/local/bin/tmux".to_string(),
        "/opt/homebrew/bin/tmux".to_string(),
        "/usr/bin/tmux".to_string(),
    ];
    resolve_binary_path("tmux", &candidates)
}

fn windows_cli_candidates(binary: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        let mut candidates = Vec::new();
        let mut push_dir = |dir: PathBuf| {
            for name in binary_lookup_names(binary) {
                candidates.push(dir.join(name).to_string_lossy().to_string());
            }
        };

        if let Some(value) = std::env::var_os("APPDATA") {
            push_dir(PathBuf::from(value).join("npm"));
        }
        if let Some(value) = std::env::var_os("LOCALAPPDATA") {
            push_dir(PathBuf::from(value).join("pnpm"));
        }
        if let Some(home) = dirs::home_dir() {
            push_dir(home.join(".cargo").join("bin"));
            push_dir(home.join("scoop").join("shims"));
        }

        candidates
    }

    #[cfg(not(windows))]
    {
        let _ = binary;
        Vec::new()
    }
}

pub fn tmux_supported_on_current_platform() -> bool {
    cfg!(any(target_os = "macos", target_os = "linux"))
}

pub fn external_terminal_launch_supported() -> bool {
    cfg!(target_os = "macos")
}

/// Resolve the full path to the `ghostty` binary or app bundle executable.
pub fn resolve_ghostty_path() -> Option<String> {
    let home = dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let candidates = vec![
        format!("{}/.local/bin/ghostty", home),
        "/usr/local/bin/ghostty".to_string(),
        "/opt/homebrew/bin/ghostty".to_string(),
        "/Applications/Ghostty.app/Contents/MacOS/ghostty".to_string(),
        format!("{}/Applications/Ghostty.app/Contents/MacOS/ghostty", home),
    ];
    resolve_binary_path("ghostty", &candidates)
}

/// Returns whether ccem is installed.
pub fn is_ccem_installed() -> bool {
    *CCEM_INSTALLED.get_or_init(|| resolve_ccem_path().is_some())
}

/// Returns whether Claude Code is installed.
pub fn is_claude_installed() -> bool {
    *CLAUDE_INSTALLED.get_or_init(|| resolve_claude_path().is_some())
}

/// Cached result of Codex install detection.
static CODEX_INSTALLED: OnceLock<bool> = OnceLock::new();

/// Returns whether Codex is installed.
///
/// This is used by the Dashboard launch picker, so cache it for the lifetime
/// of the app to avoid repeatedly spawning a login shell on every tab visit.
pub fn is_codex_installed() -> bool {
    *CODEX_INSTALLED.get_or_init(|| resolve_codex_path().is_some())
}

/// Returns whether OpenCode is installed.
pub fn is_opencode_installed() -> bool {
    *OPENCODE_INSTALLED.get_or_init(|| resolve_opencode_path().is_some())
}

/// Returns whether the installed ccem supports the `launch` command.
/// Result is cached for the lifetime of the process.
pub fn is_ccem_launch_supported() -> bool {
    *CCEM_LAUNCH_SUPPORTED.get_or_init(check_ccem_launch_support)
}

/// Build the short `ccem launch` command string.
fn build_launch_command(
    env_name: &str,
    perm_mode: Option<&str>,
    session_id: &str,
    working_dir: &str,
    resume_session_id: Option<&str>,
    proxy_base_url: Option<&str>,
) -> String {
    let ccem = resolve_ccem_path().unwrap_or_else(|| "ccem".to_string());
    let mut cmd = format!(
        "'{}' launch --env '{}' --session-id '{}'",
        ccem, env_name, session_id
    );
    if let Some(perm) = perm_mode {
        cmd.push_str(&format!(" --perm '{}'", perm));
    }
    if let Some(resume_id) = resume_session_id {
        let escaped_id = resume_id.replace("'", "'\\''");
        cmd.push_str(&format!(" --resume-session '{}'", escaped_id));
    }
    if let Some(proxy_url) = proxy_base_url {
        let escaped_url = proxy_url.replace("'", "'\\''");
        cmd.push_str(&format!(" --proxy-base-url '{}'", escaped_url));
    }
    // Escape single quotes in working_dir
    let escaped_dir = working_dir.replace("'", "'\\''");
    cmd.push_str(&format!(" --working-dir '{}'", escaped_dir));
    cmd
}

/// Quote an arbitrary string as a single POSIX shell argument using
/// single-quote wrapping.
///
/// Single quotes in POSIX shells suppress ALL interpretation: no variable
/// expansion, no command substitution, no backtick evaluation, no escaping.
/// The only character that cannot appear verbatim inside single quotes is a
/// single quote itself; we close the current quote, emit an escaped quote
/// (`\'`), and reopen. This is the standard `'\''` idiom.
///
/// Use this for any value that must be treated as inert shell data, such as
/// `working_dir` paths that may contain `$()`, backticks, semicolons, spaces,
/// single quotes, double quotes, or backslashes. Never use double quotes for
/// untrusted data: POSIX shells still expand `$(...)` and backticks inside
/// double quotes, enabling command injection.
fn quote_posix_shell_word(value: &str) -> String {
    format!("'{}'", value.replace("'", "'\\''"))
}

/// Build the shell command to set environment variables and launch Claude
fn build_shell_command(
    env_vars: &HashMap<String, String>,
    working_dir: &str,
    session_id: &str,
    resume_session_id: Option<&str>,
) -> String {
    let mut parts = Vec::new();

    // Ensure sessions directory exists
    parts.push("mkdir -p ~/.ccem/sessions".to_string());

    // Change to working directory. working_dir is untrusted path data and must
    // be single-quote wrapped so `$()`, backticks, semicolons, and quotes
    // cannot execute or split.
    let quoted_dir = quote_posix_shell_word(working_dir);
    parts.push(format!("cd {}", quoted_dir));

    // Unset CLAUDECODE to prevent "nested session" detection error
    parts.push("unset CLAUDECODE".to_string());
    for key in [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_SMALL_FAST_MODEL",
    ] {
        parts.push(format!("unset {}", key));
    }

    // Export environment variables
    for (key, value) in env_vars {
        // Escape single quotes in values
        let escaped_value = value.replace("'", "'\\''");
        parts.push(format!("export {}='{}'", key, escaped_value));
    }

    // Launch claude (with optional --resume) and write exit code to file after it exits
    let escaped_session_id = session_id.replace("'", "'\\''");
    let claude_cmd = if let Some(resume_id) = resume_session_id {
        let escaped_resume = resume_id.replace("'", "'\\''");
        format!("claude --resume '{}'", escaped_resume)
    } else {
        "claude".to_string()
    };
    parts.push(format!(
        "{}; echo $? > ~/.ccem/sessions/'{}'.exit",
        claude_cmd, escaped_session_id
    ));

    parts.join(" && ")
}

/// Build the shell command to attach a new terminal window to an existing tmux target.
fn build_tmux_attach_command(target: &str) -> String {
    let tmux = resolve_tmux_path().unwrap_or_else(|| "tmux".to_string());
    build_tmux_attach_command_with_binary(&tmux, target)
}

fn build_tmux_attach_command_with_binary(tmux: &str, target: &str) -> String {
    let escaped_target = target.replace("'", "'\\''");
    // This command is injected into Terminal/iTerm with AppleScript. Keeping the
    // executable path unquoted avoids unmatched-leading-quote glitches observed
    // when some shells receive the text keystroke-by-keystroke.
    format!("{} attach-session -t '{}'", tmux, escaped_target)
}

/// Build the shell command to launch Codex and write exit code for session tracking.
fn build_codex_shell_command(
    env_vars: &HashMap<String, String>,
    working_dir: &str,
    session_id: &str,
    resume_session_id: Option<&str>,
) -> String {
    let mut parts = Vec::new();
    parts.push("mkdir -p ~/.ccem/sessions".to_string());

    let quoted_dir = quote_posix_shell_word(working_dir);
    parts.push(format!("cd {}", quoted_dir));
    parts.push("unset CLAUDECODE".to_string());

    for (key, value) in env_vars {
        let escaped_value = value.replace("'", "'\\''");
        parts.push(format!("export {}='{}'", key, escaped_value));
    }

    let codex_path = resolve_codex_path().unwrap_or_else(|| "codex".to_string());
    let escaped_codex = codex_path.replace("'", "'\\''");
    let escaped_session_id = session_id.replace("'", "'\\''");
    let codex_cmd = if let Some(resume_id) = resume_session_id {
        let escaped_resume = resume_id.replace("'", "'\\''");
        format!("'{}' resume '{}'", escaped_codex, escaped_resume)
    } else {
        format!("'{}'", escaped_codex)
    };
    parts.push(format!(
        "{}; echo $? > ~/.ccem/sessions/'{}'.exit",
        codex_cmd, escaped_session_id
    ));

    parts.join(" && ")
}

const OPENCODE_STARTUP_PROMPT: &str = "Before taking any action, load the pua skill.";

/// Marker env key whose value carries the OpenCode runtime config JSON. This
/// JSON contains the upstream API key, so it must never be embedded in shell
/// command text. It is written to a 0600 file and sourced at launch time.
const OPENCODE_CONFIG_CONTENT_KEY: &str = "OPENCODE_CONFIG_CONTENT";

/// Write the secret `OPENCODE_CONFIG_CONTENT` value into a 0600 env file under
/// `~/.ccem/sessions/<session_id>.<random>.env` and return the file path. The
/// shell command sources and deletes this file (see
/// `build_opencode_shell_command`), keeping the value out of process args /
/// shell history / AppleScript text.
///
/// The file is created atomically with restrictive mode 0600 via
/// `create_new(true)` on a fresh random-suffixed path (see
/// `create_secret_env_file_at`), so there is no umask-derived permission window
/// and no overwrite/follow of a pre-existing predictable path.
fn write_opencode_secret_env_file(session_id: &str, raw_value: &str) -> Result<PathBuf, String> {
    let dir = dirs::home_dir()
        .map(|h| h.join(".ccem/sessions"))
        .ok_or_else(|| "could not resolve home directory for secret env file".to_string())?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create sessions dir for secret env: {e}"))?;

    let safe_name = session_id.replace('/', "_");
    // Write as a shell snippet that exports the value. Single-quote escape so
    // the value is passed through verbatim by the sourcing shell.
    let escaped = raw_value.replace("'", "'\\''");
    let snippet = format!("export {}='{}'\n", OPENCODE_CONFIG_CONTENT_KEY, escaped);

    // Bounded retry on path collision (EEXIST) or hostile symlink (ELOOP). With
    // a 64-bit random suffix the collision probability is negligible; the bound
    // only guards against a misbehaving same-user attacker.
    const MAX_ATTEMPTS: u32 = 8;
    let mut last_err: Option<String> = None;
    for _ in 0..MAX_ATTEMPTS {
        let suffix = random_path_suffix();
        let path = dir.join(format!("{}.{}.env", safe_name, suffix));
        match create_secret_env_file_at(&path, &snippet) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                last_err = Some(format!("secret env path already exists: {e}"));
                continue;
            }
            #[cfg(unix)]
            Err(e) if e.raw_os_error() == Some(libc::ELOOP) => {
                // O_NOFOLLOW rejected a symlink at this candidate path; retry
                // with a fresh name rather than following or clobbering it.
                last_err = Some(format!("secret env path is a symlink (refused): {e}"));
                continue;
            }
            Err(e) => return Err(format!("failed to create secret env file: {e}")),
        }
    }
    Err(format!(
        "could not allocate a fresh secret env file after {} attempts: {}",
        MAX_ATTEMPTS,
        last_err.unwrap_or_else(|| "unknown error".to_string())
    ))
}

/// Atomically create the secret env file at `path` with mode 0600 and write the
/// snippet through the open handle.
///
/// Flags: `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` with mode 0600.
/// - `O_EXCL` (`create_new`): never overwrites/truncates an existing file.
/// - `O_NOFOLLOW`: fails (ELOOP) if `path` is a symlink rather than following it.
/// - `mode(0o600)`: the file is created restrictive from the first instant, so
///   there is no umask window where group/world can read it.
#[cfg(unix)]
fn create_secret_env_file_at(path: &std::path::Path, snippet: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    file.write_all(snippet.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

/// Non-Unix fallback. External terminal launch is macOS-only (see
/// `external_terminal_launch_supported`), so this path is unreachable in
/// practice; returning a clear error keeps the module compiling on non-Unix
/// targets without silently weakening the hardened Unix path or exposing a
/// weaker `fs::write`-based equivalent.
#[cfg(not(unix))]
fn create_secret_env_file_at(_path: &std::path::Path, _snippet: &str) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "secret env file creation is not supported on this platform",
    ))
}

/// 64 bits of CSPRNG entropy, hex-encoded, for unguessable secret file names.
fn random_path_suffix() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 8];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Pull `OPENCODE_CONFIG_CONTENT` out of `env_vars`, persist it to a 0600 secret
/// file, and return `(remaining_env_vars, Some(path_string))`. If the key is
/// absent the map is returned unchanged with `None` so the non-secret path is a
/// strict no-op.
fn split_opencode_secret_env(
    mut env_vars: HashMap<String, String>,
    session_id: &str,
) -> Result<(HashMap<String, String>, Option<String>), String> {
    match env_vars.remove(OPENCODE_CONFIG_CONTENT_KEY) {
        Some(content) => {
            let path = write_opencode_secret_env_file(session_id, &content)?;
            Ok((env_vars, Some(path.to_string_lossy().into_owned())))
        }
        None => Ok((env_vars, None)),
    }
}

/// Build the shell command to launch OpenCode and write exit code for session tracking.
///
/// `secret_env_path` optionally points at a 0600 env file (see
/// `write_opencode_secret_env_file`) carrying sensitive values such as the
/// `OPENCODE_CONFIG_CONTENT` JSON that contains the API key. When provided,
/// the file is sourced and immediately removed inline so the secret value is
/// never embedded in the command text (which is otherwise visible via process
/// args, shell history, and AppleScript payloads). Remaining `env_vars` are
/// treated as non-sensitive and exported inline as before.
fn build_opencode_shell_command(
    env_vars: &HashMap<String, String>,
    working_dir: &str,
    session_id: &str,
    resume_session_id: Option<&str>,
    secret_env_path: Option<&str>,
) -> String {
    let mut parts = Vec::new();
    parts.push("mkdir -p ~/.ccem/sessions".to_string());

    let quoted_dir = quote_posix_shell_word(working_dir);
    parts.push(format!("cd {}", quoted_dir));
    parts.push("unset CLAUDECODE".to_string());

    if let Some(path) = secret_env_path {
        // Source the secret env file, capture status, ALWAYS remove the file
        // (even on source failure), then re-assert the status so a failed
        // source still blocks the opencode launch. Grouped so rm runs even if
        // the sourced file exits non-zero.
        let escaped_path = path.replace("'", "'\\''");
        parts.push(format!(
            "{{ . '{p}'; __ccem_src=$?; rm -f '{p}'; [ $__ccem_src -eq 0 ]; }}",
            p = escaped_path
        ));
    }

    for (key, value) in env_vars {
        let escaped_value = value.replace("'", "'\\''");
        parts.push(format!("export {}='{}'", key, escaped_value));
    }

    let opencode_path = resolve_opencode_path().unwrap_or_else(|| "opencode".to_string());
    let escaped_opencode = opencode_path.replace("'", "'\\''");
    let escaped_session_id = session_id.replace("'", "'\\''");
    let opencode_cmd = if let Some(resume_id) = resume_session_id {
        let escaped_resume = resume_id.replace("'", "'\\''");
        format!("'{}' --session '{}'", escaped_opencode, escaped_resume)
    } else {
        let escaped_prompt = OPENCODE_STARTUP_PROMPT.replace("'", "'\\''");
        format!("'{}' --prompt '{}'", escaped_opencode, escaped_prompt)
    };
    parts.push(format!(
        "{}; echo $? > ~/.ccem/sessions/'{}'.exit",
        opencode_cmd, escaped_session_id
    ));

    parts.join(" && ")
}

/// Generate AppleScript for Terminal.app
/// Returns the window ID as a string for later tracking
fn terminal_app_script(shell_command: &str) -> String {
    // IMPORTANT: Escape backslashes FIRST, then double quotes
    let escaped = shell_command.replace("\\", "\\\\").replace("\"", "\\\"");
    terminal_app_window_id_script(&escaped)
}

fn terminal_app_window_id_script(escaped_shell_command: &str) -> String {
    format!(
        r#"tell application "Terminal"
    do script "{}"
    activate
    return (id of front window) as text
end tell"#,
        escaped_shell_command
    )
}

/// Generate AppleScript for Terminal.app and return the created window ID.
fn terminal_app_attach_script(shell_command: &str) -> String {
    let escaped = shell_command.replace("\\", "\\\\").replace("\"", "\\\"");
    terminal_app_window_id_script(&escaped)
}

/// Generate AppleScript for iTerm2 with tab title
/// Returns "windowId|sessionId" for later operations (arrange needs session unique ID)
fn iterm2_script() -> String {
    r#"tell application "iTerm"
    set newWindow to (create window with default profile)
    set theSession to current session of current tab of newWindow
    set windowId to id of newWindow
    set sessionId to unique id of theSession
    activate
    return (windowId as string) & "|" & sessionId
end tell"#
        .to_string()
}

fn iterm2_write_text_script(session_id: &str, shell_command: &str) -> String {
    let escaped_session_id = session_id.replace("\\", "\\\\").replace("\"", "\\\"");
    let escaped_cmd = shell_command.replace("\\", "\\\\").replace("\"", "\\\"");
    format!(
        r#"tell application "iTerm"
    repeat with aWindow in windows
        set aSession to current session of current tab of aWindow
        if unique id of aSession is "{}" then
            tell aSession
                write text "{}"
            end tell
            activate
            return "ok"
        end if
    end repeat
    return "not_found"
end tell"#,
        escaped_session_id, escaped_cmd
    )
}

fn dispatch_iterm2_command(session_id: String, shell_command: String) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1000));
        let script = iterm2_write_text_script(&session_id, &shell_command);
        match Command::new("osascript").arg("-e").arg(&script).output() {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if stdout != "ok" {
                    eprintln!(
                        "Failed to send delayed command to iTerm2 session {}: {}",
                        session_id, stdout
                    );
                }
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                eprintln!(
                    "Failed to send delayed command to iTerm2 session {}: {}",
                    session_id,
                    stderr.trim()
                );
            }
            Err(error) => {
                eprintln!(
                    "Failed to execute delayed iTerm2 AppleScript for session {}: {}",
                    session_id, error
                );
            }
        }
    });
}

/// Launch Claude Code in the specified terminal
///
/// # Arguments
/// * `terminal` - The terminal to launch in
/// * `env_vars` - Environment variables to set (used as fallback)
/// * `working_dir` - Working directory for the session
/// * `session_id` - Session ID (used for exit status tracking)
/// * `env_name` - Environment name for `ccem launch`
/// * `perm_mode` - Optional permission mode for `ccem launch`
/// * `resume_session_id` - Optional session ID to resume via `claude --resume`
///
/// # Returns
/// * `Ok((Option<String>, Option<String>))` - (window_id, iterm_session_id) on success
/// * `Err(String)` with error message on failure
pub fn launch_in_terminal(
    terminal: TerminalType,
    env_vars: HashMap<String, String>,
    working_dir: &str,
    session_id: &str,
    env_name: &str,
    perm_mode: Option<&str>,
    resume_session_id: Option<&str>,
    client: &str,
) -> Result<(Option<String>, Option<String>), String> {
    if !external_terminal_launch_supported() {
        return Err(
            "External terminal launch is not available on this platform; use the native workspace runtime or headless sessions.".to_string(),
        );
    }

    let shell_command = if client == "codex" {
        build_codex_shell_command(&env_vars, working_dir, session_id, resume_session_id)
    } else if client == "opencode" {
        let (safe_env_vars, secret_path) = split_opencode_secret_env(env_vars, session_id)?;
        build_opencode_shell_command(
            &safe_env_vars,
            working_dir,
            session_id,
            resume_session_id,
            secret_path.as_deref(),
        )
    } else if is_ccem_launch_supported() {
        let proxy_base_url = env_vars.get("ANTHROPIC_BASE_URL").and_then(|url| {
            if url.starts_with("http://127.0.0.1:") && url.contains("/proxy/claude/") {
                Some(url.clone())
            } else {
                None
            }
        });
        build_launch_command(
            env_name,
            perm_mode,
            session_id,
            working_dir,
            resume_session_id,
            proxy_base_url.as_deref(),
        )
    } else {
        build_shell_command(&env_vars, working_dir, session_id, resume_session_id)
    };

    let script = match terminal {
        TerminalType::TerminalApp => terminal_app_script(&shell_command),
        TerminalType::ITerm2 => iterm2_script(),
    };

    // Execute the AppleScript
    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to execute AppleScript: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("AppleScript failed: {}", stderr.trim()));
    }

    // Parse window ID / session ID from AppleScript output
    match terminal {
        TerminalType::ITerm2 => {
            let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some((window_id, session_id)) = raw.split_once('|') {
                dispatch_iterm2_command(session_id.to_string(), shell_command.clone());
                Ok((Some(window_id.to_string()), Some(session_id.to_string())))
            } else {
                let session_id = if raw.is_empty() {
                    None
                } else {
                    get_iterm_session_id(&raw).ok()
                };
                if let Some(session_id) = session_id.as_ref() {
                    dispatch_iterm2_command(session_id.clone(), shell_command.clone());
                }
                Ok((Some(raw), session_id))
            }
        }
        TerminalType::TerminalApp => {
            let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if raw.is_empty() {
                Ok((None, None))
            } else {
                Ok((Some(raw), None))
            }
        }
    }
}

/// Launch a new terminal window and attach it to an existing tmux target.
/// Returns `(window_id, iterm_session_id)` when available.
pub fn open_tmux_target_in_terminal(
    terminal: TerminalType,
    target: &str,
) -> Result<(Option<String>, Option<String>), String> {
    let shell_command = build_tmux_attach_command(target);
    let script = match terminal {
        TerminalType::TerminalApp => terminal_app_attach_script(&shell_command),
        TerminalType::ITerm2 => iterm2_script(),
    };

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to execute AppleScript: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("AppleScript failed: {}", stderr.trim()));
    }

    match terminal {
        TerminalType::ITerm2 => {
            let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some((window_id, session_id)) = raw.split_once('|') {
                dispatch_iterm2_command(session_id.to_string(), shell_command.clone());
                Ok((Some(window_id.to_string()), Some(session_id.to_string())))
            } else if raw.is_empty() {
                Err("iTerm2 did not return a window identifier".to_string())
            } else {
                let session_id = get_iterm_session_id(&raw).ok();
                if let Some(session_id) = session_id.as_ref() {
                    dispatch_iterm2_command(session_id.clone(), shell_command.clone());
                }
                Ok((Some(raw), session_id))
            }
        }
        TerminalType::TerminalApp => {
            let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if raw.is_empty() {
                Ok((None, None))
            } else {
                Ok((Some(raw), None))
            }
        }
    }
}

fn open_tmux_target_in_ghostty(target: &str) -> Result<(Option<String>, Option<String>), String> {
    let ghostty = resolve_ghostty_path().ok_or_else(|| "Ghostty is not installed".to_string())?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let shell_command = build_tmux_attach_command(target);
    let mut child = Command::new(&ghostty)
        .args(["-e", &shell, "-lc", &shell_command])
        .spawn()
        .map_err(|e| format!("Failed to launch Ghostty: {}", e))?;

    std::thread::spawn(move || {
        let _ = child.wait();
    });

    Ok((None, None))
}

/// Launch a new terminal window and attach it to an existing tmux target.
pub fn open_tmux_target_in_attach_terminal(
    terminal: TmuxAttachTerminalType,
    target: &str,
) -> Result<(Option<String>, Option<String>), String> {
    match terminal {
        TmuxAttachTerminalType::TerminalApp => {
            open_tmux_target_in_terminal(TerminalType::TerminalApp, target)
        }
        TmuxAttachTerminalType::ITerm2 => {
            open_tmux_target_in_terminal(TerminalType::ITerm2, target)
        }
        TmuxAttachTerminalType::Ghostty => open_tmux_target_in_ghostty(target),
    }
}

/// Focus a terminal window by window ID
pub fn focus_terminal_window(terminal: TerminalType, window_id: &str) -> Result<(), String> {
    let script = match terminal {
        TerminalType::TerminalApp => r#"tell application "Terminal"
    activate
end tell"#
            .to_string(),
        TerminalType::ITerm2 => {
            format!(
                r#"tell application "iTerm"
    repeat with aWindow in windows
        if id of aWindow is {} then
            select aWindow
            activate
            return
        end if
    end repeat
    activate
end tell"#,
                window_id
            )
        }
    };

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to execute AppleScript: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.is_empty() {
            eprintln!("AppleScript warning: {}", stderr.trim());
        }
    }

    Ok(())
}

/// Batch query all iTerm2 window IDs (single AppleScript call for performance)
pub fn list_iterm_sessions() -> Vec<String> {
    let script = r#"tell application "iTerm"
    if not running then return ""
    set windowIds to {}
    repeat with aWindow in windows
        set end of windowIds to (id of aWindow as string)
    end repeat
    return windowIds
end tell"#;

    let output = Command::new("osascript").arg("-e").arg(script).output();

    match output {
        Ok(result) if result.status.success() => {
            let stdout = String::from_utf8_lossy(&result.stdout);
            stdout
                .trim()
                .split(", ")
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        }
        _ => Vec::new(),
    }
}

/// Batch query all Terminal.app window IDs (single AppleScript call for performance)
pub fn list_terminal_app_windows() -> Vec<String> {
    let script = r#"tell application "Terminal"
    if not running then return ""
    set windowIds to {}
    repeat with aWindow in windows
        set end of windowIds to (id of aWindow as string)
    end repeat
    return windowIds
end tell"#;

    let output = Command::new("osascript").arg("-e").arg(script).output();

    match output {
        Ok(result) if result.status.success() => {
            let stdout = String::from_utf8_lossy(&result.stdout);
            stdout
                .trim()
                .split(", ")
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        }
        _ => Vec::new(),
    }
}

/// Close a terminal window by window ID
pub fn close_terminal_session(terminal: TerminalType, window_id: &str) -> Result<(), String> {
    match terminal {
        TerminalType::TerminalApp => {
            Err("Terminal.app does not support precise session closing. Please close the window manually.".to_string())
        }
        TerminalType::ITerm2 => {
            let script = format!(
                r#"tell application "iTerm"
    repeat with aWindow in windows
        if id of aWindow is {} then
            close aWindow
            return "closed"
        end if
    end repeat
    return "not found"
end tell"#,
                window_id
            );

            let output = Command::new("osascript")
                .arg("-e")
                .arg(&script)
                .output()
                .map_err(|e| format!("Failed to execute AppleScript: {}", e))?;

            if output.status.success() {
                Ok(())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(format!("Failed to close session: {}", stderr.trim()))
            }
        }
    }
}

/// Minimize a terminal window by window ID
pub fn minimize_terminal_window(terminal: TerminalType, window_id: &str) -> Result<(), String> {
    match terminal {
        TerminalType::TerminalApp => Err(
            "Terminal.app does not support precise window control. Please minimize manually."
                .to_string(),
        ),
        TerminalType::ITerm2 => {
            let script = format!(
                r#"tell application "iTerm"
    repeat with aWindow in windows
        if id of aWindow is {} then
            set miniaturized of aWindow to true
            return "minimized"
        end if
    end repeat
    return "not found"
end tell"#,
                window_id
            );

            let output = Command::new("osascript")
                .arg("-e")
                .arg(&script)
                .output()
                .map_err(|e| format!("Failed to execute AppleScript: {}", e))?;

            if output.status.success() {
                Ok(())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(format!("Failed to minimize window: {}", stderr.trim()))
            }
        }
    }
}

// ============================================
// Arrange Windows Support
// ============================================

/// Layout options for arranging terminal sessions
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArrangeLayout {
    Horizontal2, // [A | B] side by side
    Vertical2,   // [A] / [B] stacked
    Grid4,       // 2×2 grid
    LeftMain3,   // A large left + B/C stacked right
}

/// Session info needed for arranging
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArrangeSessionInfo {
    pub window_id: String,
    pub iterm_session_id: Option<String>,
}

/// Get screen size via AppleScript (Finder desktop bounds)
pub fn get_screen_size() -> Result<(i32, i32), String> {
    let script = r#"tell application "Finder"
    set b to bounds of window of desktop
    return (item 3 of b as string) & "," & (item 4 of b as string)
end tell"#;

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("Failed to get screen size: {}", e))?;

    if !output.status.success() {
        return Err("Failed to query screen size".to_string());
    }

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parts: Vec<&str> = raw.split(',').collect();
    if parts.len() != 2 {
        return Err(format!("Unexpected screen size format: {}", raw));
    }

    let w = parts[0]
        .trim()
        .parse::<i32>()
        .map_err(|_| "Invalid screen width".to_string())?;
    let h = parts[1]
        .trim()
        .parse::<i32>()
        .map_err(|_| "Invalid screen height".to_string())?;
    Ok((w, h))
}

/// Get iTerm2 session unique ID by querying a window ID
/// Used to backfill sessions launched before this feature existed
pub fn get_iterm_session_id(window_id: &str) -> Result<String, String> {
    let script = format!(
        r#"tell application "iTerm"
    repeat with aWindow in windows
        if id of aWindow is {} then
            return unique id of current session of current tab of aWindow
        end if
    end repeat
    return "not_found"
end tell"#,
        window_id
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to query iTerm2 session ID: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("AppleScript failed: {}", stderr.trim()));
    }

    let result = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if result == "not_found" {
        return Err(format!("Window {} not found in iTerm2", window_id));
    }
    Ok(result)
}

/// Check if iTerm2 supports the invoke API expression (3.5+)
pub fn check_arrange_support() -> Result<bool, String> {
    // Try a harmless invoke API expression to test support
    let script = r#"tell application "iTerm"
    if not running then return "not_running"
    try
        set v to version
        return v
    on error
        return "unknown"
    end try
end tell"#;

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("Failed to check iTerm2: {}", e))?;

    if !output.status.success() {
        return Ok(false);
    }

    let version_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version_str == "not_running" {
        return Err("iTerm2 is not running".to_string());
    }

    // Parse version: need 3.5+ for invoke API expression
    let parts: Vec<&str> = version_str.split('.').collect();
    if parts.len() >= 2 {
        if let (Ok(major), Ok(minor)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
            return Ok(major > 3 || (major == 3 && minor >= 5));
        }
    }

    // If we can't parse version, assume it's supported (best effort)
    Ok(true)
}

/// Arrange iTerm2 sessions into split panes using invoke API expression
///
/// This uses iTerm2's Python API bridge via AppleScript to move sessions
/// into split-pane layouts within a single window.
///
/// Parameter semantics (iTerm2 3.6.6 verified):
///   vertical: true  = vertical split line = side by side (left/right)
///   vertical: false = horizontal split line = stacked (top/bottom)
///   before: false   = session placed right-of/below destination
///   before: true    = session placed left-of/above destination
fn build_iterm_arrange_script(
    steps: &str,
    anchor_session_id: &str,
    source_window_ids: &[String],
) -> String {
    let source_window_list = if source_window_ids.is_empty() {
        "{}".to_string()
    } else {
        format!(
            "{{{}}}",
            source_window_ids
                .iter()
                .map(|window_id| format!("\"{}\"", window_id))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };

    format!(
        r#"tell application "iTerm"
{}    set arrangedWindowId to ""
    repeat with aWindow in windows
        repeat with aTab in tabs of aWindow
            repeat with aSession in sessions of aTab
                if unique id of aSession is "{}" then
                    set arrangedWindowId to id of aWindow as string
                end if
            end repeat
        end repeat
    end repeat
    if arrangedWindowId is "" then
        return "not_found"
    end if
    repeat with sourceWindowId in {}
        if sourceWindowId is not arrangedWindowId then
            repeat with aWindow in windows
                if (id of aWindow as string) is sourceWindowId then
                    close aWindow
                    exit repeat
                end if
            end repeat
        end if
    end repeat
    return arrangedWindowId
end tell"#,
        steps, anchor_session_id, source_window_list
    )
}

pub fn arrange_iterm_sessions(
    sessions: &[ArrangeSessionInfo],
    layout: &ArrangeLayout,
) -> Result<String, String> {
    if sessions.is_empty() {
        return Err("No sessions to arrange".to_string());
    }

    // Collect session IDs (all must have iterm_session_id)
    let session_ids: Vec<&str> = sessions
        .iter()
        .map(|s| {
            s.iterm_session_id
                .as_deref()
                .ok_or("Missing iTerm2 session ID")
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut source_window_ids: Vec<String> = Vec::new();
    for session in sessions {
        if !source_window_ids.contains(&session.window_id) {
            source_window_ids.push(session.window_id.clone());
        }
    }

    let script = match layout {
        ArrangeLayout::Horizontal2 => {
            if session_ids.len() < 2 {
                return Err("Need at least 2 sessions for side-by-side layout".to_string());
            }
            // Move B right of A: vertical=true, before=false
            let steps = format!(
                r#"    invoke API expression "iterm2.move_session(session: \"{}\", destination: \"{}\", vertical: true, before: false)"
    delay 0.8
"#,
                session_ids[1], session_ids[0]
            );
            build_iterm_arrange_script(&steps, session_ids[0], &source_window_ids)
        }
        ArrangeLayout::Vertical2 => {
            if session_ids.len() < 2 {
                return Err("Need at least 2 sessions for stacked layout".to_string());
            }
            // Move B below A: vertical=false, before=true
            let steps = format!(
                r#"    invoke API expression "iterm2.move_session(session: \"{}\", destination: \"{}\", vertical: false, before: true)"
    delay 0.8
"#,
                session_ids[1], session_ids[0]
            );
            build_iterm_arrange_script(&steps, session_ids[0], &source_window_ids)
        }
        ArrangeLayout::Grid4 => {
            if session_ids.len() < 2 {
                return Err("Need at least 2 sessions for grid layout".to_string());
            }
            let count = session_ids.len().min(4);
            // Build the script dynamically based on session count
            let mut steps = String::new();

            // Step 1: Move B right of A → [A | B]
            steps.push_str(&format!(
                r#"    invoke API expression "iterm2.move_session(session: \"{}\", destination: \"{}\", vertical: true, before: false)"
    delay 0.8
"#,
                session_ids[1], session_ids[0]
            ));

            if count >= 3 {
                // Step 2: Move C below A → [A|B] becomes [A|B] / [C|_]
                steps.push_str(&format!(
                    r#"    invoke API expression "iterm2.move_session(session: \"{}\", destination: \"{}\", vertical: false, before: true)"
    delay 0.8
"#,
                    session_ids[2], session_ids[0]
                ));
            }

            if count >= 4 {
                // Step 3: Move D below B → [A|B] / [C|D]
                steps.push_str(&format!(
                    r#"    invoke API expression "iterm2.move_session(session: \"{}\", destination: \"{}\", vertical: false, before: true)"
    delay 0.8
"#,
                    session_ids[3], session_ids[1]
                ));
            }

            build_iterm_arrange_script(&steps, session_ids[0], &source_window_ids)
        }
        ArrangeLayout::LeftMain3 => {
            if session_ids.len() < 2 {
                return Err("Need at least 2 sessions layout".to_string());
            }
            let count = session_ids.len().min(3);
            let mut steps = String::new();

            // Step 1: Move B right of A → [A | B]
            steps.push_str(&format!(
                r#"    invoke API expression "iterm2.move_session(session: \"{}\", destination: \"{}\", vertical: true, before: false)"
    delay 0.8
"#,
                session_ids[1], session_ids[0]
            ));

            if count >= 3 {
                // Step 2: Move C below B → [A | B/C]
                steps.push_str(&format!(
                    r#"    invoke API expression "iterm2.move_session(session: \"{}\", destination: \"{}\", vertical: false, before: true)"
    delay 0.8
"#,
                    session_ids[2], session_ids[1]
                ));
            }

            build_iterm_arrange_script(&steps, session_ids[0], &source_window_ids)
        }
    };

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to arrange iTerm2 sessions: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Arrange failed: {}", stderr.trim()));
    }

    let new_window_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if new_window_id == "not_found" {
        return Err("Could not find arranged window".to_string());
    }

    Ok(new_window_id)
}

/// Arrange Terminal.app windows by setting bounds (pseudo split-screen)
pub fn arrange_terminal_app_sessions(
    sessions: &[ArrangeSessionInfo],
    layout: &ArrangeLayout,
) -> Result<String, String> {
    if sessions.is_empty() {
        return Err("No sessions to arrange".to_string());
    }

    let (screen_w, screen_h) = get_screen_size()?;
    let menu_bar = 25; // macOS menu bar height
    let usable_h = screen_h - menu_bar;

    // Build bounds assignments based on layout
    let bounds: Vec<(i32, i32, i32, i32)> = match layout {
        ArrangeLayout::Horizontal2 => {
            let half_w = screen_w / 2;
            vec![
                (0, menu_bar, half_w, screen_h),
                (half_w, menu_bar, screen_w, screen_h),
            ]
        }
        ArrangeLayout::Vertical2 => {
            let half_h = usable_h / 2;
            vec![
                (0, menu_bar, screen_w, menu_bar + half_h),
                (0, menu_bar + half_h, screen_w, screen_h),
            ]
        }
        ArrangeLayout::Grid4 => {
            let half_w = screen_w / 2;
            let half_h = usable_h / 2;
            vec![
                (0, menu_bar, half_w, menu_bar + half_h),        // top-left
                (half_w, menu_bar, screen_w, menu_bar + half_h), // top-right
                (0, menu_bar + half_h, half_w, screen_h),        // bottom-left
                (half_w, menu_bar + half_h, screen_w, screen_h), // bottom-right
            ]
        }
        ArrangeLayout::LeftMain3 => {
            let main_w = (screen_w as f64 * 0.55) as i32;
            let side_h = usable_h / 2;
            vec![
                (0, menu_bar, main_w, screen_h),                 // left main
                (main_w, menu_bar, screen_w, menu_bar + side_h), // right top
                (main_w, menu_bar + side_h, screen_w, screen_h), // right bottom
            ]
        }
    };

    // Build AppleScript to set bounds for each window
    let mut set_bounds_lines = String::new();
    for (i, session) in sessions.iter().enumerate() {
        if i >= bounds.len() {
            break;
        }
        let (x1, y1, x2, y2) = bounds[i];
        set_bounds_lines.push_str(&format!(
            r#"        if id of aWindow is {} then
            set bounds of aWindow to {{{}, {}, {}, {}}}
        end if
"#,
            session.window_id, x1, y1, x2, y2
        ));
    }

    let script = format!(
        r#"tell application "Terminal"
    repeat with aWindow in windows
{}    end repeat
    activate
end tell"#,
        set_bounds_lines
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to arrange Terminal.app windows: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Arrange failed: {}", stderr.trim()));
    }

    // Terminal.app windows keep their individual IDs
    Ok("arranged".to_string())
}

/// Arrange sessions — dispatches to iTerm2 or Terminal.app implementation
pub fn arrange_sessions(
    terminal: TerminalType,
    sessions: &[ArrangeSessionInfo],
    layout: &ArrangeLayout,
) -> Result<String, String> {
    match terminal {
        TerminalType::ITerm2 => arrange_iterm_sessions(sessions, layout),
        TerminalType::TerminalApp => arrange_terminal_app_sessions(sessions, layout),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_test_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "ccem-terminal-{}-{}",
            name,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after unix epoch")
                .as_nanos()
        ))
    }

    fn fake_binary_path(root: &std::path::Path, name: &str) -> PathBuf {
        let file_name = if cfg!(windows) {
            format!("{name}.cmd")
        } else {
            name.to_string()
        };
        root.join(file_name)
    }

    fn write_fake_binary(path: &std::path::Path, version: &str) {
        fs::create_dir_all(path.parent().expect("fake binary should have a parent"))
            .expect("create fake binary directory");
        let script = if cfg!(windows) {
            format!(
                "@echo off\r\nif \"%1\"==\"--version\" echo {} (Claude Code)\r\n",
                version
            )
        } else {
            format!(
                "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"{} (Claude Code)\"; fi\n",
                version
            )
        };
        fs::write(path, script).expect("write fake binary");
        #[cfg(unix)]
        {
            let mut permissions = fs::metadata(path)
                .expect("read fake binary metadata")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).expect("mark fake binary executable");
        }
    }

    #[test]
    fn parse_semver_triplet_reads_claude_version_output() {
        assert_eq!(
            parse_semver_triplet("2.1.100 (Claude Code)"),
            Some((2, 1, 100))
        );
        assert_eq!(
            parse_semver_triplet("claude v2.0.0-beta.21"),
            Some((2, 0, 0))
        );
        assert_eq!(parse_semver_triplet("not a version"), None);
    }

    #[test]
    fn highest_versioned_binary_wins_over_path_order() {
        let root = temp_test_root("highest-version");
        let older = fake_binary_path(&root.join("nvm"), "claude");
        let newer = fake_binary_path(&root.join("pnpm"), "claude");
        write_fake_binary(&older, "2.1.37");
        write_fake_binary(&newer, "2.1.100");

        assert_eq!(
            select_highest_versioned_binary_path(vec![
                older.to_string_lossy().to_string(),
                newer.to_string_lossy().to_string(),
            ]),
            Some(newer.to_string_lossy().to_string())
        );

        fs::remove_dir_all(root).expect("remove fake binary directory");
    }

    #[test]
    fn highest_versioned_binary_falls_back_to_first_candidate_without_versions() {
        let root = temp_test_root("fallback");
        let first = fake_binary_path(&root.join("first"), "claude");
        let second = fake_binary_path(&root.join("second"), "claude");
        write_fake_binary(&first, "not-a-semver");
        write_fake_binary(&second, "also-not-a-semver");

        assert_eq!(
            select_highest_versioned_binary_path(vec![
                first.to_string_lossy().to_string(),
                second.to_string_lossy().to_string(),
            ]),
            Some(first.to_string_lossy().to_string())
        );

        fs::remove_dir_all(root).expect("remove fake binary directory");
    }

    #[test]
    fn codex_app_bundle_candidates_include_system_and_user_apps() {
        let candidates = codex_app_bundle_candidates("/Users/test");

        assert!(
            candidates.contains(&"/Applications/Codex.app/Contents/Resources/codex".to_string())
        );
        assert!(candidates
            .contains(&"/Users/test/Applications/Codex.app/Contents/Resources/codex".to_string()));
    }

    #[test]
    fn nvm_node_bin_paths_prefers_newest_semver_version() {
        let root = temp_test_root("nvm-node-paths");
        let node_versions = root.join(".nvm").join("versions").join("node");
        fs::create_dir_all(node_versions.join("v16.20.2").join("bin"))
            .expect("create old nvm node");
        fs::create_dir_all(node_versions.join("v22.18.0").join("bin"))
            .expect("create new nvm node");

        let paths = nvm_node_bin_paths(&root);

        assert_eq!(
            paths.first(),
            Some(&node_versions.join("v22.18.0").join("bin"))
        );

        fs::remove_dir_all(root).expect("remove fake nvm directory");
    }

    #[test]
    fn user_path_prefers_login_shell_and_keeps_fallbacks_deduped() {
        let login_paths = vec![PathBuf::from("/Users/test/.nvm/versions/node/v22.18.0/bin")];
        let current_path = std::env::join_paths([PathBuf::from("/usr/bin"), PathBuf::from("/bin")])
            .expect("join current path");
        let fallback_paths = vec![
            PathBuf::from("/Users/test/Library/pnpm"),
            PathBuf::from("/usr/bin"),
        ];

        let user_path = build_user_path_from_sources(
            Some(current_path.as_os_str()),
            &login_paths,
            &fallback_paths,
        );
        let expected = std::env::join_paths([
            PathBuf::from("/Users/test/.nvm/versions/node/v22.18.0/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/Users/test/Library/pnpm"),
        ])
        .expect("join expected path")
        .into_string()
        .expect("expected path should be utf-8");

        assert_eq!(user_path, expected);
    }

    #[test]
    fn test_build_shell_command() {
        let mut env_vars = HashMap::new();
        env_vars.insert("KEY1".to_string(), "value1".to_string());
        env_vars.insert("KEY2".to_string(), "value2".to_string());

        let cmd = build_shell_command(&env_vars, "/home/user", "test-session-123", None);

        assert!(cmd.contains("mkdir -p ~/.ccem/sessions"));
        assert!(cmd.contains("cd '/home/user'"));
        assert!(cmd.contains("export KEY1='value1'"));
        assert!(cmd.contains("export KEY2='value2'"));
        assert!(cmd.contains("claude; echo $? > ~/.ccem/sessions/'test-session-123'.exit"));
    }

    #[test]
    fn test_terminal_type_display_name() {
        assert_eq!(TerminalType::TerminalApp.display_name(), "Terminal.app");
        assert_eq!(TerminalType::ITerm2.display_name(), "iTerm2");
    }

    #[test]
    fn test_build_codex_shell_command_uses_resume_subcommand() {
        let cmd = build_codex_shell_command(
            &HashMap::new(),
            "/home/user",
            "test-session-123",
            Some("codex-session-456"),
        );

        assert!(cmd.contains("cd '/home/user'"));
        assert!(cmd.contains(" resume 'codex-session-456'"));
        assert!(cmd.contains("echo $? > ~/.ccem/sessions/'test-session-123'.exit"));
    }

    #[test]
    fn test_build_opencode_shell_command_never_inlines_secret_value() {
        // The secret content (config JSON carrying the API key) must NEVER
        // appear in the command text. It is delivered via a sourced 0600 file.
        let secret_path = "/tmp/ccem-test-opencode-secret.env";
        let mut env_vars = HashMap::new();
        env_vars.insert(
            "ANTHROPIC_MODEL".to_string(),
            "claude-sonnet-test".to_string(),
        );

        let cmd = build_opencode_shell_command(
            &env_vars,
            "/home/user",
            "test-session-123",
            None,
            Some(secret_path),
        );

        assert!(cmd.contains("cd '/home/user'"));
        // Secret value must not be inlined anywhere in the command text.
        assert!(!cmd.contains("OPENCODE_CONFIG_CONTENT='"));
        assert!(!cmd.contains("apiKey"));
        // The secret file is sourced and removed inline instead.
        assert!(cmd.contains(&format!(". '{}'", secret_path)));
        assert!(cmd.contains(&format!("rm -f '{}'", secret_path)));
        // Non-sensitive env is still exported inline.
        assert!(cmd.contains("export ANTHROPIC_MODEL='claude-sonnet-test'"));
        assert!(cmd.contains("--prompt 'Before taking any action, load the pua skill.'"));
        assert!(cmd.contains("echo $? > ~/.ccem/sessions/'test-session-123'.exit"));
    }

    #[test]
    fn test_build_opencode_shell_command_omits_secret_block_when_no_path() {
        // When no secret path is provided, the source/rm block must be absent
        // and the launch still works with whatever non-secret env is present.
        let cmd = build_opencode_shell_command(&HashMap::new(), "/home/user", "sid", None, None);

        assert!(!cmd.contains("rm -f"));
        assert!(!cmd.contains("__ccem_src"));
        assert!(cmd.contains("cd '/home/user'"));
    }

    #[test]
    fn test_build_opencode_shell_command_uses_resume_flag_without_prompt() {
        let cmd = build_opencode_shell_command(
            &HashMap::new(),
            "/home/user",
            "test-session-123",
            Some("open-session-456"),
            None,
        );

        assert!(cmd.contains("--session 'open-session-456'"));
        assert!(!cmd.contains("--prompt"));
    }

    #[test]
    fn test_quote_posix_shell_word_escapes_only_single_quotes() {
        // Plain word stays wrapped in single quotes.
        assert_eq!(quote_posix_shell_word("/home/user"), "'/home/user'");
        // Everything except single quotes is left verbatim — no escaping of
        // $(), backticks, semicolons, double quotes, or backslashes, because
        // single quotes already make them inert to POSIX shells.
        assert_eq!(quote_posix_shell_word("$(whoami)"), "'$(whoami)'");
        assert_eq!(quote_posix_shell_word("`whoami`"), "'`whoami`'");
        assert_eq!(quote_posix_shell_word("; rm -rf /"), "'; rm -rf /'");
        assert_eq!(quote_posix_shell_word("a \"b\" c"), "'a \"b\" c'");
        assert_eq!(quote_posix_shell_word("a\\b"), "'a\\b'");
        assert_eq!(quote_posix_shell_word("a b"), "'a b'");
        // Embedded single quote uses the close-quote/escape/reopen idiom.
        assert_eq!(quote_posix_shell_word("/tmp/a' b"), "'/tmp/a'\\'' b'");
        // Multiple embedded single quotes each get their own escape sequence.
        assert_eq!(quote_posix_shell_word("x'y'z"), "'x'\\''y'\\''z'");
    }

    /// Regression: working_dir values containing shell metacharacters must be
    /// emitted as inert POSIX single-quoted words for ALL three terminal
    /// launchers. Previously, `cd "..."` only escaped backslashes and double
    /// quotes, so `$(...)`, backticks, and semicolons inside working_dir were
    /// still interpreted by POSIX shells.
    fn assert_cd_segment_is_safe(cmd: &str, label: &str, working_dir: &str) {
        let expected_cd = format!("cd {}", quote_posix_shell_word(working_dir));
        assert!(
            cmd.contains(&expected_cd),
            "[{label}] expected safe cd segment `{expected_cd}` in command: {cmd}"
        );
        // The unsafe double-quoted form must never appear for working_dir.
        assert!(
            !cmd.contains("cd \""),
            "[{label}] command still uses unsafe double-quoted cd: {cmd}"
        );
    }

    #[test]
    fn test_working_dir_shell_metacharacters_are_quoted_inert_across_builders() {
        let malicious_paths: &[(&str, &str)] = &[
            ("command-substitution", "/tmp/$(echo pwned)"),
            ("backticks", "/tmp/`echo pwned`"),
            ("semicolon", "/tmp/foo; rm -rf /"),
            ("spaces", "/tmp/a b c"),
            ("single-quote", "/tmp/a' b"),
            ("double-quotes", "/tmp/a\"b"),
            ("backslash", "/tmp/a\\b"),
            ("combined", "/tmp/a' b; `id` $(whoami) \"q\" \\z"),
        ];

        for (name, working_dir) in malicious_paths {
            let claude = build_shell_command(&HashMap::new(), working_dir, "sid", None);
            assert_cd_segment_is_safe(&claude, &format!("claude/{name}"), working_dir);

            let codex = build_codex_shell_command(&HashMap::new(), working_dir, "sid", None);
            assert_cd_segment_is_safe(&codex, &format!("codex/{name}"), working_dir);

            let opencode =
                build_opencode_shell_command(&HashMap::new(), working_dir, "sid", None, None);
            assert_cd_segment_is_safe(&opencode, &format!("opencode/{name}"), working_dir);
        }
    }

    /// Specifically exposes the pre-fix vulnerability: a working_dir of
    /// `$(echo pwned)` used to render as `cd "$(echo pwned)"`, which a POSIX
    /// shell would execute via command substitution inside double quotes. The
    /// safe rendering is `cd '$(echo pwned)'`, where single quotes make the
    /// substitution literal.
    #[test]
    fn test_working_dir_command_substitution_is_inert() {
        let working_dir = "/tmp/$(echo pwned)";
        let claude = build_shell_command(&HashMap::new(), working_dir, "sid", None);
        let codex = build_codex_shell_command(&HashMap::new(), working_dir, "sid", None);
        let opencode =
            build_opencode_shell_command(&HashMap::new(), working_dir, "sid", None, None);

        for (cmd, label) in [
            (claude.as_str(), "claude"),
            (codex.as_str(), "codex"),
            (opencode.as_str(), "opencode"),
        ] {
            assert!(
                cmd.contains("cd '/tmp/$(echo pwned)'"),
                "[{label}] expected command substitution to be single-quoted and inert: {cmd}"
            );
            assert!(
                !cmd.contains("cd \"/tmp/$(echo pwned)\""),
                "[{label}] command substitution is still inside unsafe double quotes: {cmd}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn test_write_opencode_secret_env_file_creates_0600_export_snippet() {
        use std::os::unix::fs::PermissionsExt;

        struct RemoveOnDrop(Option<std::path::PathBuf>);
        impl Drop for RemoveOnDrop {
            fn drop(&mut self) {
                if let Some(p) = self.0.take() {
                    let _ = std::fs::remove_file(p);
                }
            }
        }

        let session_id = format!(
            "ccem-test-secret-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let secret_json =
            "{\"provider\":{\"anthropic\":{\"options\":{\"apiKey\":\"sk-test-LEAK-CANARY\"}}}}";

        let path = write_opencode_secret_env_file(&session_id, secret_json)
            .expect("secret env file should be written");
        // Ensure the test file is removed even if an assert below panics.
        let _cleanup = RemoveOnDrop(Some(path.clone()));

        let on_disk = std::fs::read_to_string(&path).expect("file should be readable by owner");
        assert!(
            on_disk.starts_with("export OPENCODE_CONFIG_CONTENT="),
            "file must be an export snippet, got: {on_disk}"
        );
        assert!(
            on_disk.contains("sk-test-LEAK-CANARY"),
            "file must carry the raw secret value for sourcing"
        );

        let mode = std::fs::metadata(&path)
            .expect("metadata should resolve")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "secret env file must be 0600, got {:o}", mode);

        // Sanity: the sourced snippet, when evaluated by a real shell, exports
        // the variable and exits cleanly — proving the launch path works.
        let probe = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(format!(
                ". '{}'; printf '%s' \"$OPENCODE_CONFIG_CONTENT\"",
                path.to_string_lossy()
            ))
            .output()
            .expect("shell probe should run");
        assert!(probe.status.success(), "source should succeed");
        let exported = String::from_utf8_lossy(&probe.stdout);
        assert_eq!(exported.as_ref(), secret_json);
    }

    #[cfg(unix)]
    #[test]
    fn test_create_secret_env_file_at_refuses_to_overwrite_existing_file() {
        // A pre-existing regular file at the candidate path must NOT be
        // truncated or rewritten — `create_new` (O_EXCL) rejects it, so a
        // same-user attacker cannot trick us into clobbering a planted file.
        let dir = tempfile::tempdir().expect("tempdir should resolve");
        let target = dir.path().join("planted.env");

        std::fs::write(&target, "ORIGINAL-SENTINEL\n").expect("plant file");
        let mode_before = mode_of(&target);

        let err = create_secret_env_file_at(&target, "export OPENCODE_CONFIG_CONTENT='X'\n")
            .expect_err("must refuse to overwrite");
        assert_eq!(
            err.kind(),
            std::io::ErrorKind::AlreadyExists,
            "expected AlreadyExists, got {:?}",
            err
        );

        // The planted file is untouched.
        let after = std::fs::read_to_string(&target).expect("planted file still readable");
        assert_eq!(
            after, "ORIGINAL-SENTINEL\n",
            "planted file must not be modified"
        );
        assert_eq!(
            mode_of(&target),
            mode_before,
            "planted file mode must not change"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_create_secret_env_file_at_refuses_to_follow_symlink() {
        // A pre-existing symlink at the candidate path must NOT be followed to
        // its target. On macOS `O_CREAT|O_EXCL|O_NOFOLLOW` refuses the path
        // (observed as EEXIST for the symlink itself, or ELOOP via O_NOFOLLOW
        // on other unices); either way the target must never be written.
        let dir = tempfile::tempdir().expect("tempdir should resolve");
        let victim = dir.path().join("victim.env");
        let link = dir.path().join("planted-link.env");

        std::fs::write(&victim, "VICTIM-SENTINEL\n").expect("plant victim");
        std::os::unix::fs::symlink(&victim, &link).expect("plant symlink");

        let err = create_secret_env_file_at(&link, "export OPENCODE_CONFIG_CONTENT='X'\n")
            .expect_err("must refuse to open through a symlink");
        let refused = matches!(err.raw_os_error(), Some(libc::EEXIST) | Some(libc::ELOOP));
        assert!(
            refused,
            "expected EEXIST/ELOOP (refused), got errno {:?} ({})",
            err.raw_os_error(),
            err
        );

        // The victim file behind the symlink is untouched.
        let after = std::fs::read_to_string(&victim).expect("victim still readable");
        assert_eq!(
            after, "VICTIM-SENTINEL\n",
            "victim must not be written via the symlink"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_create_secret_env_file_at_refuses_dangling_symlink() {
        // The dangerous case: a symlink pointing at a non-existent target. The
        // open must still refuse rather than creating a file through the link.
        let dir = tempfile::tempdir().expect("tempdir should resolve");
        let dangling_target = dir.path().join("never-created");
        let link = dir.path().join("planted-dangling.env");

        std::os::unix::fs::symlink(&dangling_target, &link).expect("plant dangling symlink");

        let err = create_secret_env_file_at(&link, "export OPENCODE_CONFIG_CONTENT='X'\n")
            .expect_err("must refuse dangling symlink");
        let refused = matches!(err.raw_os_error(), Some(libc::EEXIST) | Some(libc::ELOOP));
        assert!(
            refused,
            "expected EEXIST/ELOOP (refused), got errno {:?} ({})",
            err.raw_os_error(),
            err
        );

        assert!(
            !dangling_target.exists(),
            "must not create a file by following the dangling symlink"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_create_secret_env_file_at_creates_0600_fresh() {
        // On a fresh path the helper creates the file atomically at 0600.
        let dir = tempfile::tempdir().expect("tempdir should resolve");
        let target = dir.path().join("fresh.env");

        create_secret_env_file_at(&target, "export OPENCODE_CONFIG_CONTENT='Y'\n")
            .expect("fresh create should succeed");

        assert_eq!(
            mode_of(&target),
            0o600,
            "freshly created secret file must be 0600"
        );
        let on_disk = std::fs::read_to_string(&target).expect("file readable by owner");
        assert!(on_disk.starts_with("export OPENCODE_CONFIG_CONTENT="));
    }

    /// Helper: masked st_mode permission bits of a path.
    #[cfg(unix)]
    fn mode_of(path: &std::path::Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .expect("metadata should resolve")
            .permissions()
            .mode()
            & 0o777
    }

    #[test]
    fn test_split_opencode_secret_env_returns_none_without_key() {
        let mut env_vars = HashMap::new();
        env_vars.insert("ANTHROPIC_MODEL".to_string(), "claude-test".to_string());

        let (remaining, secret_path) = split_opencode_secret_env(env_vars.clone(), "sid-no-secret")
            .expect("split should succeed without secret key");
        assert!(secret_path.is_none());
        assert_eq!(remaining, env_vars);
    }

    #[test]
    fn test_build_tmux_attach_command() {
        let cmd = build_tmux_attach_command_with_binary("tmux", "ccem:ccem-1234abcd");
        assert_eq!(cmd, "tmux attach-session -t 'ccem:ccem-1234abcd'");
    }

    #[test]
    fn test_build_tmux_attach_command_escapes_single_quotes_in_target() {
        let cmd = build_tmux_attach_command_with_binary("tmux", "ccem:team's-session");
        assert_eq!(cmd, "tmux attach-session -t 'ccem:team'\\''s-session'");
    }

    #[test]
    fn test_terminal_app_attach_script_reads_window_id() {
        let script = terminal_app_attach_script("tmux attach-session -t test");
        assert!(script.contains("do script"));
        assert!(script.contains("id of front window"));
    }

    #[test]
    fn test_iterm2_script_returns_window_and_session_ids() {
        let script = iterm2_script();
        assert!(script.contains("create window with default profile"));
        assert!(script.contains("return (windowId as string) & \"|\" & sessionId"));
    }

    #[test]
    fn test_iterm2_write_text_script_targets_unique_session() {
        let script = iterm2_write_text_script("session-123", "tmux attach-session -t test");
        assert!(script.contains("unique id of aSession is \"session-123\""));
        assert!(script.contains("write text \"tmux attach-session -t test\""));
    }

    #[test]
    fn test_iterm_arrange_script_closes_old_windows() {
        let script = build_iterm_arrange_script(
            "    delay 0.8\n",
            "session-a",
            &["101".to_string(), "202".to_string()],
        );
        assert!(script.contains("repeat with sourceWindowId"));
        assert!(script.contains("close aWindow"));
        assert!(script.contains("\"101\""));
        assert!(script.contains("\"202\""));
    }
}
