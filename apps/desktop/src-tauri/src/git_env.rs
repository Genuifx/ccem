//! Keep git's fsmonitor daemon out of every git process CCEM starts.
//!
//! With `core.fsmonitor=true`, git asks the daemon what changed before reading
//! the index and waits on that socket with no timeout. When the daemon stops
//! answering (seen on macOS with many long-lived daemons), `git status` from the
//! workspace snapshot and `git worktree add` from an agent's EnterWorktree block
//! forever, so the task looks frozen. A full scan is fast enough for our repos.

use std::process::Command;

const GIT_FSMONITOR_KEY: &str = "core.fsmonitor";
const GIT_FSMONITOR_VALUE: &str = "false";

/// `-c` arguments for git commands CCEM runs itself.
pub(crate) const GIT_NO_FSMONITOR_ARGS: [&str; 2] = ["-c", "core.fsmonitor=false"];

/// Environment entries that append `core.fsmonitor=false` to git's
/// `GIT_CONFIG_COUNT` list, keeping any entries the user already exported.
fn fsmonitor_off_env(existing_count: Option<&str>) -> [(String, String); 3] {
    let index = existing_count
        .and_then(|count| count.trim().parse::<usize>().ok())
        .unwrap_or(0);
    [
        (format!("GIT_CONFIG_KEY_{index}"), GIT_FSMONITOR_KEY.to_string()),
        (format!("GIT_CONFIG_VALUE_{index}"), GIT_FSMONITOR_VALUE.to_string()),
        ("GIT_CONFIG_COUNT".to_string(), (index + 1).to_string()),
    ]
}

/// Apply to processes that run git indirectly (agent sessions, cron agents):
/// every git they spawn inherits the setting.
pub(crate) fn disable_git_fsmonitor(command: &mut Command) {
    let existing = std::env::var("GIT_CONFIG_COUNT").ok();
    command.envs(fsmonitor_off_env(existing.as_deref()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_after_existing_git_config_entries() {
        assert_eq!(
            fsmonitor_off_env(None),
            [
                ("GIT_CONFIG_KEY_0".to_string(), "core.fsmonitor".to_string()),
                ("GIT_CONFIG_VALUE_0".to_string(), "false".to_string()),
                ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
            ]
        );
        let appended = fsmonitor_off_env(Some("2"));
        assert_eq!(appended[0].0, "GIT_CONFIG_KEY_2");
        assert_eq!(appended[2], ("GIT_CONFIG_COUNT".to_string(), "3".to_string()));
        assert_eq!(fsmonitor_off_env(Some("bogus"))[0].0, "GIT_CONFIG_KEY_0");
    }

    #[test]
    fn child_git_sees_fsmonitor_disabled_despite_repo_config() {
        let dir = tempfile::tempdir().expect("temp repo");
        let git = |args: &[&str]| {
            Command::new("git").arg("-C").arg(dir.path()).args(args).output().expect("run git")
        };
        assert!(git(&["init", "-q"]).status.success());
        assert!(git(&["config", "core.fsmonitor", "true"]).status.success());

        let mut command = Command::new("git");
        command.arg("-C").arg(dir.path()).args(["config", "--get", "core.fsmonitor"]);
        disable_git_fsmonitor(&mut command);
        let output = command.output().expect("run git with env");
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "false");

        let output = Command::new("git")
            .args(GIT_NO_FSMONITOR_ARGS)
            .arg("-C")
            .arg(dir.path())
            .args(["config", "--get", "core.fsmonitor"])
            .output()
            .expect("run git with -c");
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "false");
    }

    #[test]
    fn agent_env_lets_git_status_skip_a_hung_fsmonitor() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("temp repo");
        let hooks = tempfile::tempdir().expect("hook dir");
        let hook = hooks.path().join("hung-fsmonitor");
        std::fs::write(&hook, "#!/bin/sh\nsleep 60\n").expect("write hook");
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let git = |args: &[&str]| {
            Command::new("git").arg("-C").arg(dir.path()).args(args).output().expect("run git")
        };
        assert!(git(&["init", "-q"]).status.success());
        assert!(git(&["config", "core.fsmonitor", hook.to_str().unwrap()]).status.success());

        let started = std::time::Instant::now();
        let mut command = Command::new("git");
        command.arg("-C").arg(dir.path()).args(["status", "--porcelain"]);
        disable_git_fsmonitor(&mut command);
        assert!(command.output().expect("run git status").status.success());
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "{:?}", started.elapsed());
    }
}
