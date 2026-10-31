use chrono::Utc;
use serde::Serialize;
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::terminal;

const VERSION_OUTPUT_LIMIT: usize = 2000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    schema_version: u8,
    generated_at: String,
    app_version: String,
    platform: DoctorPlatform,
    process: DoctorProcess,
    environment: DoctorEnvironment,
    commands: Vec<DoctorCommandStatus>,
    paths: Vec<DoctorPathStatus>,
    system: DoctorSystem,
}

/// Machine-wide pressure at export time. A slow UI on one Mac but not another
/// is usually CPU/memory contention or a power policy, not the page itself.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorSystem {
    model: Option<String>,
    memory_bytes: Option<u64>,
    load_average: Option<String>,
    memory_free_percent: Option<u64>,
    low_power_mode: Option<bool>,
    agent_processes: Option<u64>,
    agent_rss_bytes: Option<u64>,
    /// %CPU (100 = one core) of this app and its child processes.
    app_cpu_percent: Option<f64>,
    /// Whole-machine %CPU in the same units: (100 - idle) * cores from the
    /// `top` sample, which includes kernel time and so exceeds the
    /// per-process sum. Compare with the core count for saturation.
    total_cpu_percent: Option<f64>,
    /// Busiest processes by executable name (no arguments), so contention
    /// from WebContent, agents or unrelated apps is visible.
    top_cpu_processes: Option<Vec<DoctorCpuProcess>>,
    /// How the CPU numbers were measured: "instant" (top's 1s interval
    /// sample) or "lifetime-average" (ps fallback — averages since launch).
    cpu_sample: Option<&'static str>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorCpuProcess {
    name: String,
    cpu_percent: f64,
    rss_bytes: u64,
}

#[derive(Debug, Default, PartialEq)]
struct CpuSummary {
    sample: Option<&'static str>,
    app_cpu_percent: Option<f64>,
    total_cpu_percent: Option<f64>,
    top: Option<Vec<DoctorCpuProcess>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorPlatform {
    os: String,
    arch: String,
    family: String,
    debug_build: bool,
    capabilities: DoctorCapabilities,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorCapabilities {
    tmux_supported: bool,
    external_terminal_launch_supported: bool,
    native_runtime_supported: bool,
    headless_runtime_supported: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorProcess {
    current_exe: Option<String>,
    current_dir: Option<String>,
    home_dir: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorEnvironment {
    path_entries: Vec<String>,
    safe_vars: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorCommandStatus {
    name: String,
    installed: bool,
    resolved_path: Option<String>,
    version: Option<String>,
    version_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorPathStatus {
    label: String,
    path: String,
    exists: bool,
    is_dir: bool,
    is_file: bool,
    size_bytes: Option<u64>,
    error: Option<String>,
}

#[tauri::command]
pub fn collect_doctor_report() -> DoctorReport {
    build_doctor_report()
}

fn build_doctor_report() -> DoctorReport {
    let user_path = terminal::get_user_path();

    DoctorReport {
        schema_version: 1,
        generated_at: Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: DoctorPlatform {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            family: std::env::consts::FAMILY.to_string(),
            debug_build: cfg!(debug_assertions),
            capabilities: DoctorCapabilities {
                tmux_supported: cfg!(any(target_os = "macos", target_os = "linux")),
                external_terminal_launch_supported: cfg!(target_os = "macos"),
                native_runtime_supported: true,
                headless_runtime_supported: true,
            },
        },
        process: DoctorProcess {
            current_exe: std::env::current_exe().ok().map(path_to_string),
            current_dir: std::env::current_dir().ok().map(path_to_string),
            home_dir: dirs::home_dir().map(path_to_string),
        },
        environment: DoctorEnvironment {
            path_entries: split_path_entries(&user_path),
            safe_vars: collect_safe_env_vars(),
        },
        commands: collect_command_statuses(&user_path),
        paths: collect_path_statuses(),
        system: collect_system_load(),
    }
}

fn command_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(target_os = "macos")]
fn collect_system_load() -> DoctorSystem {
    let sysctl = |name: &str| command_stdout("/usr/sbin/sysctl", &["-n", name]);
    let low_power_mode = command_stdout("/usr/bin/pmset", &["-g"]).and_then(|text| {
        text.lines()
            .find(|line| line.trim_start().starts_with("lowpowermode"))
            .and_then(|line| line.split_whitespace().last())
            .map(|value| value == "1")
    });
    let (agent_processes, agent_rss_bytes) = command_stdout("/bin/ps", &["-axo", "rss=,comm="])
        .map(|text| summarize_agent_processes(&text))
        .unzip();
    // `ps pcpu` averages over a process's whole lifetime, so a daemon that
    // burned CPU an hour ago still ranks high. `top -l 2 -s 1` measures its
    // second sample over the interval; ps runs after top so the process
    // tree, names and RSS are at least as fresh as that sample.
    let top_output = command_stdout(
        "/usr/bin/top",
        &["-l", "2", "-s", "1", "-o", "cpu", "-stats", "pid,cpu"],
    );
    let ps_output = command_stdout("/bin/ps", &["-axo", "pid=,ppid=,pcpu=,rss=,comm="]);
    let cpu = summarize_cpu(
        ps_output.as_deref(),
        top_output.as_deref(),
        sysctl("hw.ncpu").and_then(|value| value.parse::<u64>().ok()),
        std::process::id(),
    );
    DoctorSystem {
        app_cpu_percent: cpu.app_cpu_percent,
        total_cpu_percent: cpu.total_cpu_percent,
        top_cpu_processes: cpu.top,
        cpu_sample: cpu.sample,
        model: sysctl("hw.model"),
        memory_bytes: sysctl("hw.memsize").and_then(|value| value.parse().ok()),
        load_average: sysctl("vm.loadavg"),
        memory_free_percent: sysctl("kern.memorystatus_level").and_then(|value| value.parse().ok()),
        low_power_mode,
        agent_processes,
        agent_rss_bytes,
    }
}

#[cfg(not(target_os = "macos"))]
fn collect_system_load() -> DoctorSystem {
    DoctorSystem::default()
}

/// Counts agent CLIs and runtime helpers from `ps -axo rss=,comm=` output.
/// Matches the executable name only; argument paths such as a
/// `claude-code-env-manager` checkout must not count as agents.
fn summarize_agent_processes(ps_output: &str) -> (u64, u64) {
    const AGENT_EXECUTABLES: [&str; 4] = ["claude", "codex", "opencode", "ccem-node"];
    ps_output
        .lines()
        .filter_map(|line| line.trim_start().split_once(' '))
        .filter(|(_, executable)| {
            let name = executable.trim().rsplit('/').next().unwrap_or_default();
            AGENT_EXECUTABLES.contains(&name)
        })
        .fold((0, 0), |(count, rss), (rss_kb, _)| {
            (count + 1, rss + rss_kb.trim().parse::<u64>().unwrap_or(0) * 1024)
        })
}

/// CPU attribution for the report. Instantaneous values come from the second
/// `top -l 2` sample (measured over the interval — the first sample, like
/// `ps pcpu`, averages since process start); `ps` supplies the process tree,
/// executable names and RSS. All values are %CPU with 100 = one core. Without
/// `top` the numbers fall back to ps lifetime averages and are labeled so.
fn summarize_cpu(
    ps_output: Option<&str>,
    top_output: Option<&str>,
    core_count: Option<u64>,
    app_pid: u32,
) -> CpuSummary {
    const TOP_LIMIT: usize = 8;
    let round = |value: f64| (value * 10.0).round() / 10.0;
    let rows = parse_ps_rows(ps_output.unwrap_or(""));
    let instant = top_output.and_then(parse_top_sample);

    if rows.is_empty() && instant.is_none() {
        return CpuSummary::default();
    }
    let sample: &'static str = if instant.is_some() { "instant" } else { "lifetime-average" };

    let mut app_pids = std::collections::HashSet::from([app_pid]);
    loop {
        let before = app_pids.len();
        for (pid, ppid, ..) in &rows {
            if app_pids.contains(ppid) {
                app_pids.insert(*pid);
            }
        }
        if app_pids.len() == before {
            break;
        }
    }

    if let Some((top_rows, machine_percent)) = &instant {
        // Processes that exited before the sample contribute 0 rather than a
        // stale lifetime average; ones that started after ps ran have no name
        // and drop out of the top list (their CPU still counts in the total).
        let app = top_rows
            .iter()
            .filter(|(pid, _)| app_pids.contains(pid))
            .map(|(_, cpu)| cpu)
            .sum::<f64>();
        let mut top: Vec<DoctorCpuProcess> = top_rows
            .iter()
            .filter_map(|(pid, cpu)| {
                let (_, _, _, rss, comm) = rows.iter().find(|(p, ..)| p == pid)?;
                Some(DoctorCpuProcess {
                    name: comm.rsplit('/').next().unwrap_or_default().to_string(),
                    cpu_percent: *cpu,
                    rss_bytes: *rss,
                })
            })
            .collect();
        top.sort_by(|a, b| b.cpu_percent.total_cmp(&a.cpu_percent));
        top.truncate(TOP_LIMIT);
        // The header idle is machine-wide (% of all cores, kernel included);
        // scale it back to "100 = one core" units to match every other value.
        let total = core_count
            .map(|cores| machine_percent * cores as f64)
            .unwrap_or_else(|| top_rows.iter().map(|(_, cpu)| cpu).sum::<f64>());
        let tree_known = !rows.is_empty();
        return CpuSummary {
            sample: Some(sample),
            app_cpu_percent: tree_known.then_some(round(app)),
            total_cpu_percent: Some(round(total)),
            top: tree_known.then_some(top),
        };
    }

    let mut top: Vec<DoctorCpuProcess> = rows
        .iter()
        .map(|(_, _, cpu, rss, comm)| DoctorCpuProcess {
            name: comm.rsplit('/').next().unwrap_or_default().to_string(),
            cpu_percent: *cpu,
            rss_bytes: *rss,
        })
        .collect();
    top.sort_by(|a, b| b.cpu_percent.total_cmp(&a.cpu_percent));
    top.truncate(TOP_LIMIT);

    CpuSummary {
        sample: Some(sample),
        app_cpu_percent: Some(round(
            rows.iter()
                .filter(|(pid, ..)| app_pids.contains(pid))
                .map(|(_, _, cpu, ..)| cpu)
                .sum(),
        )),
        total_cpu_percent: Some(round(rows.iter().map(|(_, _, cpu, ..)| cpu).sum())),
        top: Some(top),
    }
}

/// Parses `ps -axo pid=,ppid=,pcpu=,rss=,comm=` output. Executable paths may
/// contain spaces, so `comm` is everything after the fourth field.
fn parse_ps_rows(ps_output: &str) -> Vec<(u32, u32, f64, u64, &str)> {
    ps_output
        .lines()
        .filter_map(|line| {
            let mut rest = line.trim_start();
            let mut fields = [""; 4];
            for field in &mut fields {
                let (value, tail) = rest.split_once(char::is_whitespace)?;
                *field = value;
                rest = tail.trim_start();
            }
            Some((
                fields[0].parse().ok()?,
                fields[1].parse().ok()?,
                fields[2].parse().ok()?,
                fields[3].parse::<u64>().ok()? * 1024,
                rest.trim(),
            ))
        })
        .collect()
}

/// Parses the second `top -l 2 -stats pid,cpu` sample: the last `PID` header
/// starts its table (the first sample is a lifetime average like ps). Returns
/// the rows and the machine-wide total from the last `CPU usage:` header line
/// above it — 100 - idle, in % of all cores — which avoids the per-row
/// rounding error of summing a thousand processes.
fn parse_top_sample(top_output: &str) -> Option<(Vec<(u32, f64)>, f64)> {
    let mut header = None;
    for (idx, line) in top_output.lines().enumerate() {
        if line.trim_start().starts_with("PID") {
            header = Some(idx);
        }
    }
    let header = header?;
    let rows: Vec<(u32, f64)> = top_output
        .lines()
        .skip(header + 1)
        .filter_map(|line| {
            let mut fields = line.trim_start().split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let cpu = fields.next()?.parse().ok()?;
            Some((pid, cpu))
        })
        .collect();
    if rows.is_empty() {
        return None;
    }
    let machine_percent = top_output
        .lines()
        .take(header)
        .filter(|line| line.trim_start().starts_with("CPU usage:"))
        .filter_map(|line| {
            let idle = line.rsplit_once(',')?.1.trim();
            Some(100.0 - idle.strip_suffix("% idle")?.parse::<f64>().ok()?)
        })
        .last();
    let total = machine_percent.unwrap_or_else(|| rows.iter().map(|(_, cpu)| cpu).sum::<f64>());
    Some((rows, total))
}

fn collect_command_statuses(user_path: &str) -> Vec<DoctorCommandStatus> {
    let mut statuses = vec![
        doctor_command(
            "node",
            resolve_command_from_path("node", user_path),
            user_path,
        ),
        doctor_command("ccem", terminal::resolve_ccem_path(), user_path),
        doctor_command("claude", terminal::resolve_claude_path(), user_path),
        doctor_command("codex", terminal::resolve_codex_path(), user_path),
        doctor_command("opencode", terminal::resolve_opencode_path(), user_path),
    ];

    if cfg!(any(target_os = "macos", target_os = "linux")) {
        statuses.push(doctor_command(
            "tmux",
            terminal::resolve_tmux_path(),
            user_path,
        ));
    } else {
        statuses.push(DoctorCommandStatus {
            name: "tmux".to_string(),
            installed: false,
            resolved_path: None,
            version: None,
            version_error: Some("tmux is not used by CCEM on this platform".to_string()),
        });
    }

    statuses
}

fn doctor_command(
    name: &str,
    resolved_path: Option<String>,
    user_path: &str,
) -> DoctorCommandStatus {
    let (version, version_error) = resolved_path
        .as_deref()
        .map(|path| command_version(path, user_path))
        .unwrap_or((None, None));

    DoctorCommandStatus {
        name: name.to_string(),
        installed: resolved_path.is_some(),
        resolved_path,
        version,
        version_error,
    }
}

fn command_version(path: &str, user_path: &str) -> (Option<String>, Option<String>) {
    let output = version_command(path)
        .arg("--version")
        .env("PATH", user_path)
        .output();
    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let text = format!("{} {}", stdout.trim(), stderr.trim())
                .trim()
                .to_string();

            if output.status.success() && !text.is_empty() {
                (Some(truncate(text, VERSION_OUTPUT_LIMIT)), None)
            } else if text.is_empty() {
                (
                    None,
                    Some(format!("version exited with status {}", output.status)),
                )
            } else {
                (
                    None,
                    Some(format!(
                        "version exited with status {}: {}",
                        output.status,
                        truncate(text, VERSION_OUTPUT_LIMIT)
                    )),
                )
            }
        }
        Err(error) => (None, Some(error.to_string())),
    }
}

fn version_command(path: &str) -> Command {
    #[cfg(windows)]
    {
        if is_windows_batch_path(path) {
            let shell = std::env::var_os("ComSpec").unwrap_or_else(|| OsString::from("cmd.exe"));
            let mut command = Command::new(shell);
            command.arg("/C").arg(path);
            return command;
        }
    }

    Command::new(path)
}

fn is_windows_batch_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "cmd" | "bat"))
        .unwrap_or(false)
}

fn collect_path_statuses() -> Vec<DoctorPathStatus> {
    let mut paths = Vec::new();

    if let Some(home) = dirs::home_dir() {
        paths.push(path_status("home", home.clone()));
        paths.push(path_status("ccemConfigDir", home.join(".ccem")));
        paths.push(path_status(
            "ccemConfig",
            home.join(".ccem").join("config.json"),
        ));
        paths.push(path_status(
            "ccemNativeRuntimeState",
            home.join(".ccem").join("native-runtime-state.json"),
        ));
        paths.push(path_status("claudeHome", crate::agent_home::claude_home()));
        paths.push(path_status("codexHome", crate::agent_home::codex_home()));
    }

    for (label, key) in [
        ("appData", "APPDATA"),
        ("localAppData", "LOCALAPPDATA"),
        ("programFiles", "ProgramFiles"),
        ("programFilesX86", "ProgramFiles(x86)"),
    ] {
        if let Some(value) = std::env::var_os(key) {
            paths.push(path_status(label, PathBuf::from(value)));
        }
    }

    if let Some(app_data) = std::env::var_os("APPDATA") {
        let base = PathBuf::from(app_data);
        paths.push(path_status(
            "appDataCcemDesktop",
            base.join("com.ccem.desktop"),
        ));
        paths.push(path_status("appDataCcem", base.join("ccem")));
    }

    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let base = PathBuf::from(local_app_data);
        paths.push(path_status(
            "localAppDataCcemDesktop",
            base.join("com.ccem.desktop"),
        ));
        paths.push(path_status("localAppDataCcem", base.join("ccem")));
    }

    paths
}

fn path_status(label: &str, path: PathBuf) -> DoctorPathStatus {
    let path_string = path_to_string(path.clone());
    match fs::metadata(&path) {
        Ok(metadata) => DoctorPathStatus {
            label: label.to_string(),
            path: path_string,
            exists: true,
            is_dir: metadata.is_dir(),
            is_file: metadata.is_file(),
            size_bytes: metadata.is_file().then_some(metadata.len()),
            error: None,
        },
        Err(error) => DoctorPathStatus {
            label: label.to_string(),
            path: path_string,
            exists: false,
            is_dir: false,
            is_file: false,
            size_bytes: None,
            error: Some(error.to_string()),
        },
    }
}

fn collect_safe_env_vars() -> BTreeMap<String, String> {
    let mut vars = BTreeMap::new();
    for key in SAFE_ENV_KEYS {
        if is_secret_env_key(key) {
            continue;
        }
        if let Ok(value) = std::env::var(key) {
            vars.insert((*key).to_string(), truncate(value, 8000));
        }
    }
    vars
}

const SAFE_ENV_KEYS: &[&str] = &[
    "APPDATA",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "ComSpec",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "OS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "SHELL",
    "USERPROFILE",
];

fn is_secret_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    [
        "API_KEY",
        "AUTH",
        "CREDENTIAL",
        "KEY",
        "PASSWORD",
        "SECRET",
        "TOKEN",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
}

fn resolve_command_from_path(binary: &str, path_value: &str) -> Option<String> {
    let names = command_lookup_names(binary);
    for dir in split_pathbufs(path_value) {
        for name in &names {
            let candidate = dir.join(name);
            if is_executable_candidate(&candidate) {
                return Some(path_to_string(candidate));
            }
        }
    }
    None
}

fn command_lookup_names(binary: &str) -> Vec<OsString> {
    #[cfg(windows)]
    {
        let binary_path = Path::new(binary);
        if binary_path.extension().is_some() {
            return vec![OsString::from(binary)];
        }

        let mut names = vec![OsString::from(binary)];
        let pathext =
            std::env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
        for ext in pathext.to_string_lossy().split(';') {
            let ext = ext.trim();
            if ext.is_empty() {
                continue;
            }
            names.push(OsString::from(format!(
                "{}{}",
                binary,
                ext.to_ascii_lowercase()
            )));
            names.push(OsString::from(format!(
                "{}{}",
                binary,
                ext.to_ascii_uppercase()
            )));
        }
        names
    }

    #[cfg(not(windows))]
    {
        vec![OsString::from(binary)]
    }
}

fn is_executable_candidate(path: &Path) -> bool {
    path.is_file()
}

fn split_path_entries(path_value: &str) -> Vec<String> {
    split_pathbufs(path_value)
        .into_iter()
        .map(path_to_string)
        .collect()
}

fn split_pathbufs(path_value: &str) -> Vec<PathBuf> {
    std::env::split_paths(OsStr::new(path_value)).collect()
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

fn truncate(value: String, limit: usize) -> String {
    if value.len() <= limit {
        return value;
    }

    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...<truncated>", &value[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_env_keys_are_filtered() {
        assert!(is_secret_env_key("ANTHROPIC_API_KEY"));
        assert!(is_secret_env_key("SOME_AUTH_TOKEN"));
        assert!(!is_secret_env_key("PATH"));
        assert!(!is_secret_env_key("LOCALAPPDATA"));
    }

    #[test]
    fn path_status_reports_metadata_without_contents() {
        let status = path_status("missing", PathBuf::from("/definitely/not/a/ccem/path"));
        assert_eq!(status.label, "missing");
        assert!(!status.exists);
        assert!(status.error.is_some());
    }

    #[test]
    fn truncate_preserves_utf8_boundaries() {
        let truncated = truncate("hello世界".to_string(), 7);
        assert!(truncated.starts_with("hello"));
        assert!(truncated.ends_with("...<truncated>"));
    }

    #[test]
    fn detects_windows_batch_wrappers_for_version_probe() {
        assert!(is_windows_batch_path(
            "C:\\Users\\wzt\\AppData\\Roaming\\npm\\claude.cmd"
        ));
        assert!(is_windows_batch_path("ccem.BAT"));
        assert!(!is_windows_batch_path("/usr/local/bin/node"));
    }

    #[test]
    fn agent_process_summary_counts_cli_and_helpers_only() {
        let ps = "  420192 /opt/node_modules/@anthropic-ai/claude-code/bin/claude\n\
                  75840 /Applications/CCEM Desktop.app/Contents/MacOS/ccem-node\n\
                  2048 /Users/me/claude-code-env-manager/node_modules/@esbuild/darwin-arm64/bin/esbuild\n\
                  1024 /usr/local/bin/codex\n\
                  999 /bin/zsh\n";
        assert_eq!(summarize_agent_processes(ps), (3, (420192 + 75840 + 1024) * 1024));
    }

    #[test]
    fn cpu_summary_attributes_the_app_tree_and_ranks_busiest_processes() {
        let ps = "    1     0   1.0    100 /sbin/launchd\n\
                  500     1  12.5   2048 /Applications/CCEM Desktop.app/Contents/MacOS/ccem-desktop\n\
                  510   500  30.0   4096 /usr/local/bin/claude\n\
                  520   510   5.5   1024 /bin/zsh\n\
                  600     1  80.0   8192 /System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent\n\
                  garbage line\n";
        // Without top the numbers are ps lifetime averages, labeled as such.
        let summary = summarize_cpu(Some(ps), None, None, 500);
        assert_eq!(summary.sample, Some("lifetime-average"));
        assert_eq!(summary.app_cpu_percent, Some(48.0));
        assert_eq!(summary.total_cpu_percent, Some(129.0));
        let top = summary.top.unwrap();
        assert_eq!(top.len(), 5);
        assert_eq!(
            top[0],
            DoctorCpuProcess {
                name: "com.apple.WebKit.WebContent".to_string(),
                cpu_percent: 80.0,
                rss_bytes: 8192 * 1024,
            }
        );
        assert_eq!(top[2].name, "ccem-desktop");
    }

    #[test]
    fn cpu_summary_prefers_the_second_top_sample_over_ps_averages() {
        // ps carries lifetime averages that must not rank: claude shows 95.0
        // there but is idling at 77.5 in the interval sample, WebKit burned
        // 80.0 historically but is absent from the sample entirely.
        let ps = "    1     0   1.0    100 /sbin/launchd\n\
                  500     1  12.5   2048 /Applications/CCEM Desktop.app/Contents/MacOS/ccem-desktop\n\
                  510   500  95.0   4096 /usr/local/bin/claude\n\
                  600     1  80.0   8192 /System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent\n";
        // Shaped after real `top -l 2 -stats pid,cpu` output (trailing spaces
        // included); the first sample's values must be ignored.
        let top = "Processes: 400 total, 2 running, 398 sleeping, 1500 threads \n\
                   2026/10/31 18:18:58\n\
                   Load Avg: 1.5, 1.2, 1.1 \n\
                   CPU usage: 5.0% user, 5.0% sys, 90.0% idle \n\
                   \n\
                   PID    %CPU\n\
                   500    90.0\n\
                   510    3.0\n\
                   \n\
                   Processes: 400 total, 2 running, 398 sleeping, 1500 threads \n\
                   2026/10/31 18:19:00\n\
                   Load Avg: 1.5, 1.2, 1.1 \n\
                   CPU usage: 29.15% user, 12.8% sys, 58.76% idle \n\
                   \n\
                   PID    %CPU\n\
                   510    77.5\n\
                   500    41.4\n\
                   1      0.0\n";
        let summary = summarize_cpu(Some(ps), Some(top), Some(10), 500);
        assert_eq!(summary.sample, Some("instant"));
        // App tree {500, 510} from the interval sample, not the first
        // sample's 90.0 and not ps's 12.5/95.0.
        assert_eq!(summary.app_cpu_percent, Some(118.9));
        // (100 - 58.76) * 10 cores from the header, not the row sum 118.9.
        assert_eq!(summary.total_cpu_percent, Some(412.4));
        let top = summary.top.unwrap();
        assert_eq!(top.len(), 3);
        assert_eq!(
            top[0],
            DoctorCpuProcess {
                name: "claude".to_string(),
                cpu_percent: 77.5,
                rss_bytes: 4096 * 1024,
            }
        );
        assert_eq!(top[1].name, "ccem-desktop");
        assert_eq!(top[1].cpu_percent, 41.4);
        // WebKit (ps lifetime 80.0, missing from the sample) does not rank.
        assert!(top.iter().all(|entry| entry.name != "com.apple.WebKit.WebContent"));
    }

    #[test]
    fn cpu_summary_keeps_only_the_busiest_processes() {
        let ps: String = (1..=12)
            .map(|pid| format!("{pid} 0 {pid}.0 10 /bin/p{pid}\n"))
            .collect();
        let summary = summarize_cpu(Some(&ps), None, None, 999);
        assert_eq!(summary.app_cpu_percent, Some(0.0));
        let top = summary.top.unwrap();
        assert_eq!(top.len(), 8);
        assert_eq!(top[0].name, "p12");
        assert_eq!(top[7].name, "p5");
    }

    #[test]
    fn parse_top_sample_rejects_output_without_a_table() {
        assert_eq!(parse_top_sample("Processes: 1\ngarbage\n"), None);
    }
}
