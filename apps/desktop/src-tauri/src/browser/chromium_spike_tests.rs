use super::{
    listening_tcp_entries, process_group_exists, reap_stale_runtime, take_next_cdp_frame,
    write_private_json, ChromiumPageSmoke, ManagedChromiumSpike, StaleReapOutcome,
};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const BINARY_ENV: &str = "CCEM_CHROMIUM_SPIKE_BINARY";
const OUTPUT_ENV: &str = "CCEM_CHROMIUM_SPIKE_OUTPUT_DIR";
const ORPHAN_CHILD_ENV: &str = "CCEM_CHROMIUM_ORPHAN_PROBE_CHILD";
const ORPHAN_PID_FILE_ENV: &str = "CCEM_CHROMIUM_ORPHAN_PID_FILE";
const ORPHAN_RUNTIME_ROOT_ENV: &str = "CCEM_CHROMIUM_ORPHAN_RUNTIME_ROOT";

#[test]
fn cdp_frame_limit_applies_before_decoding_complete_frames() {
    let mut at_limit = vec![b'x'; 8];
    at_limit.push(0);
    assert_eq!(
        take_next_cdp_frame(&mut at_limit, 8).expect("accept exact frame limit"),
        Some(vec![b'x'; 8])
    );

    let mut oversized = vec![b'x'; 9];
    oversized.push(0);
    let error = take_next_cdp_frame(&mut oversized, 8)
        .expect_err("reject a complete oversized frame before JSON decoding");
    assert!(error.contains("exceeded 8 bytes"));
}

#[derive(Debug, Serialize)]
struct LifecycleProof {
    status: String,
    exit_code: Option<i32>,
    signal: Option<i32>,
    process_group_gone: bool,
}

#[derive(Debug, Serialize)]
struct ChromiumSpikeProof {
    schema_version: u32,
    generated_at_unix_ms: u128,
    executable: String,
    transport: String,
    hardcoded_runtime_path: bool,
    page: ChromiumPageSmoke,
    debug_tcp_listeners: Vec<String>,
    clean_shutdown: LifecycleProof,
    forced_sigkill: LifecycleProof,
    stale_reaper: StaleReapOutcome,
    stale_reaper_exit: LifecycleProof,
    orphan_pipe_close: LifecycleProof,
    orphan_metadata_cleanup: StaleReapOutcome,
}

#[derive(Debug, Serialize, Deserialize)]
struct OrphanProbeInfo {
    browser_pid: u32,
    process_group_id: i32,
    metadata_path: String,
    browser_version: String,
}

#[test]
#[ignore = "requires an explicit Chrome for Testing executable"]
fn managed_chromium_pipe_lifecycle_spike() {
    let executable = required_path_env(BINARY_ENV);
    let output_root = required_path_env(OUTPUT_ENV);
    fs::create_dir_all(&output_root).expect("create Chromium spike output directory");
    let run_root = output_root.join(format!("run-{}", unique_suffix()));
    fs::create_dir_all(&run_root).expect("create Chromium spike run directory");

    let normal_runtime_root = run_root.join("normal");
    let mut normal = ManagedChromiumSpike::launch(&executable, &normal_runtime_root)
        .expect("launch pipe-controlled Chromium");
    let normal_pid = normal.pid();
    let normal_group = normal.process_group_id();
    let debug_tcp_listeners = listening_tcp_entries(normal_pid).expect("inspect TCP listeners");
    assert!(
        debug_tcp_listeners.is_empty(),
        "remote-debugging-pipe unexpectedly opened TCP listeners: {debug_tcp_listeners:?}"
    );
    let marker = "CCEM_CHROMIUM_PIPE_READY";
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>CCEM Chromium spike</title><main><h1>{marker}</h1><p>private pipe smoke</p></main>"
    );
    let url = format!("data:text/html,{}", urlencoding::encode(&html));
    let screenshot_path = output_root.join("chromium-pipe-smoke.png");
    let page = normal
        .run_page_smoke(&url, marker, &screenshot_path)
        .expect("run minimal CDP page smoke");
    assert!(page.final_url.starts_with("data:text/html,"));
    assert_eq!(page.marker_text, marker);
    assert!(page.screenshot_bytes > 1_000);
    let clean_status = normal.close_cleanly().expect("close Chromium cleanly");
    let clean_shutdown = lifecycle_proof(clean_status, normal_group);
    assert!(clean_shutdown.process_group_gone);
    assert!(clean_shutdown.exit_code == Some(0) || clean_shutdown.signal.is_none());

    let forced_runtime_root = run_root.join("forced");
    let mut forced = ManagedChromiumSpike::launch(&executable, &forced_runtime_root)
        .expect("launch Chromium for SIGKILL proof");
    forced.browser_version().expect("probe forced Chromium");
    let forced_group = forced.process_group_id();
    let forced_status = forced.force_kill().expect("SIGKILL Chromium process group");
    let forced_sigkill = lifecycle_proof(forced_status, forced_group);
    assert_eq!(forced_sigkill.signal, Some(libc::SIGKILL));
    assert!(forced_sigkill.process_group_gone);

    let stale_runtime_root = run_root.join("stale");
    let mut stale = ManagedChromiumSpike::launch(&executable, &stale_runtime_root)
        .expect("launch Chromium for stale reaper proof");
    stale.browser_version().expect("probe stale Chromium");
    stale
        .mark_metadata_owner_stale_for_test()
        .expect("mark owner stale in spike metadata");
    let stale_metadata = stale.metadata_path().to_path_buf();
    let stale_group = stale.process_group_id();
    let stale_reaper = reap_stale_runtime(&stale_metadata).expect("reap stale Chromium runtime");
    assert_eq!(stale_reaper, StaleReapOutcome::SignaledVerifiedRuntime);
    let stale_status = stale
        .wait_after_external_reap()
        .expect("wait for stale Chromium exit");
    let stale_reaper_exit = lifecycle_proof(stale_status, stale_group);
    assert!(stale_reaper_exit.process_group_gone);

    let orphan_pid_file = run_root.join("orphan-probe.json");
    let orphan_runtime_root = run_root.join("orphan");
    let child_status = Command::new(env::current_exe().expect("current Rust test executable"))
        .args([
            "--exact",
            "browser::chromium_spike::tests::chromium_orphan_probe_child",
            "--nocapture",
        ])
        .env(ORPHAN_CHILD_ENV, "1")
        .env(BINARY_ENV, &executable)
        .env(ORPHAN_PID_FILE_ENV, &orphan_pid_file)
        .env(ORPHAN_RUNTIME_ROOT_ENV, &orphan_runtime_root)
        .status()
        .expect("run orphan probe child test process");
    assert!(child_status.success(), "orphan probe child failed");
    let orphan_info: OrphanProbeInfo =
        serde_json::from_slice(&fs::read(&orphan_pid_file).expect("read orphan probe metadata"))
            .expect("decode orphan probe metadata");
    let orphan_exited = wait_for_group_exit(orphan_info.process_group_id, Duration::from_secs(10));
    if !orphan_exited {
        let _ = reap_stale_runtime(Path::new(&orphan_info.metadata_path));
    }
    assert!(
        orphan_exited,
        "Chromium survived its controller process and became an orphan"
    );
    let orphan_metadata_cleanup = reap_stale_runtime(Path::new(&orphan_info.metadata_path))
        .expect("clean exited orphan metadata");
    assert_eq!(orphan_metadata_cleanup, StaleReapOutcome::AlreadyExited);
    let orphan_pipe_close = LifecycleProof {
        status: "pipe_owner_process_exited".to_string(),
        exit_code: None,
        signal: None,
        process_group_gone: orphan_exited,
    };

    let proof = ChromiumSpikeProof {
        schema_version: 1,
        generated_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_millis(),
        executable: executable.to_string_lossy().into_owned(),
        transport: "remote-debugging-pipe-fd3-fd4-nul-json".to_string(),
        hardcoded_runtime_path: false,
        page,
        debug_tcp_listeners,
        clean_shutdown,
        forced_sigkill,
        stale_reaper,
        stale_reaper_exit,
        orphan_pipe_close,
        orphan_metadata_cleanup,
    };
    write_private_json(&output_root.join("chromium-spike-report.json"), &proof)
        .expect("write Chromium spike report");
}

#[test]
fn chromium_orphan_probe_child() {
    if env::var(ORPHAN_CHILD_ENV).ok().as_deref() != Some("1") {
        return;
    }
    let executable = required_path_env(BINARY_ENV);
    let pid_file = required_path_env(ORPHAN_PID_FILE_ENV);
    let runtime_root = required_path_env(ORPHAN_RUNTIME_ROOT_ENV);
    let mut runtime =
        ManagedChromiumSpike::launch(&executable, &runtime_root).expect("launch orphan probe");
    let browser_version = runtime.browser_version().expect("probe orphan Chromium");
    let info = OrphanProbeInfo {
        browser_pid: runtime.pid(),
        process_group_id: runtime.process_group_id(),
        metadata_path: runtime.metadata_path().to_string_lossy().into_owned(),
        browser_version,
    };
    write_private_json(&pid_file, &info).expect("write orphan probe info");

    // Intentionally skip Drop. The test process exit closes FD 3/4 from the controller side; the
    // parent test proves Chromium treats that pipe closure as a fatal lifecycle boundary.
    std::mem::forget(runtime);
}

fn required_path_env(name: &str) -> PathBuf {
    env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("{name} must be set for the Chromium spike"))
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos()
}

fn lifecycle_proof(status: std::process::ExitStatus, process_group_id: i32) -> LifecycleProof {
    LifecycleProof {
        status: status.to_string(),
        exit_code: status.code(),
        signal: status.signal(),
        process_group_gone: !process_group_exists(process_group_id),
    }
}

fn wait_for_group_exit(process_group_id: i32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while process_group_exists(process_group_id) {
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(50));
    }
    true
}
