//! Exercise the release verifier against real signed code during a macOS bundle replacement.
use super::cef::bootstrap::verify_adhoc_signature;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const CHILD_ROOT: &str = "CCEM_ADHOC_UPDATE_TEST_ROOT";
const TIMEOUT: Duration = Duration::from_secs(20);

struct OwnedChild(Option<Child>);

impl Drop for OwnedChild {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn codesign(args: &[&str], target: &Path) -> String {
    let output = Command::new("/usr/bin/codesign")
        .args(args)
        .arg(target)
        .output()
        .expect("run codesign for the owned test bundle");
    assert!(
        output.status.success(),
        "codesign {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn signed_bundle(app: &Path, version: &str) -> PathBuf {
    let executable = app.join("Contents/MacOS/ccem-desktop");
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    fs::create_dir_all(app.join("Contents/Resources")).unwrap();
    fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
    fs::write(
        app.join("Contents/Info.plist"),
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.ccem.desktop</string>
<key>CFBundleExecutable</key><string>ccem-desktop</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>{version}</string>
</dict></plist>"#
        ),
    )
    .unwrap();
    fs::write(app.join("Contents/Resources/version.txt"), version).unwrap();
    codesign(&["--force", "--sign", "-"], app);
    executable
}

fn wait_for_file(path: &Path) {
    let deadline = Instant::now() + TIMEOUT;
    while !path.exists() {
        assert!(Instant::now() < deadline, "timed out waiting for {path:?}");
        thread::sleep(Duration::from_millis(20));
    }
}

fn cdhash(inspection: &str) -> &str {
    inspection
        .lines()
        .find_map(|line| line.strip_prefix("CDHash="))
        .expect("codesign must report a CDHash")
}

#[test]
fn cef_bootstrap_adhoc_verification_survives_bundle_replacement() {
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        let root = PathBuf::from(root);
        let executable = std::env::current_exe().unwrap();
        verify_adhoc_signature(&executable).expect("initial matching bundle must verify");
        let process = PathBuf::from(format!("+{}", std::process::id()));
        let running = codesign(&["--display", "--verbose=4"], &process);
        fs::write(root.join("ready"), b"ready").unwrap();
        wait_for_file(&root.join("replaced"));

        let app = root.join("CCEM Desktop.app");
        let disk = codesign(&["--display", "--verbose=4"], &app);
        assert_ne!(
            cdhash(&disk),
            cdhash(&running),
            "must exercise two real builds"
        );
        let executable = std::env::current_exe().expect("resolve current executable after update");
        verify_adhoc_signature(&executable)
            .expect("a valid installed update must not block the still-running process");

        fs::write(app.join("Contents/Resources/version.txt"), b"damaged").unwrap();
        let error = verify_adhoc_signature(&executable).unwrap_err();
        assert!(
            error.contains("bundle signature verification failed"),
            "{error}"
        );
        println!("PASS: real CDHash mismatch accepted; damaged bundle rejected");
        return;
    }

    let root = tempfile::tempdir().unwrap();
    let app = root.path().join("CCEM Desktop.app");
    let executable = signed_bundle(&app, "1");
    let replacement = root.path().join("replacement/CCEM Desktop.app");
    signed_bundle(&replacement, "2");
    let test = format!(
        "{}::cef_bootstrap_adhoc_verification_survives_bundle_replacement",
        module_path!().split_once("::").unwrap().1
    );
    let mut child = OwnedChild(Some(
        Command::new(&executable)
            .args(["--exact", &test, "--nocapture"])
            .env(CHILD_ROOT, root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    ));
    wait_for_file(&root.path().join("ready"));
    // Match Tauri's updater: move the old bundle aside and install the new one before restart.
    fs::rename(&app, root.path().join("previous.app")).unwrap();
    fs::rename(&replacement, &app).unwrap();
    // Tauri drops its temporary backup when installation completes, still before restart.
    fs::remove_dir_all(root.path().join("previous.app")).unwrap();
    fs::write(root.path().join("replaced"), b"replaced").unwrap();
    let deadline = Instant::now() + TIMEOUT;
    while child.0.as_mut().unwrap().try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < deadline,
            "owned verification child timed out"
        );
        thread::sleep(Duration::from_millis(20));
    }
    let output = child.0.take().unwrap().wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "verification child failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout)
        .contains("PASS: real CDHash mismatch accepted; damaged bundle rejected"));
}
