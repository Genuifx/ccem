use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

// Resolve the CI-selected interpreter before GatewayProcess clears the child
// environment. Every real host fixture must use this same absolute executable.
pub(super) fn python() -> &'static Path {
    static PYTHON: OnceLock<PathBuf> = OnceLock::new();
    PYTHON
        .get_or_init(|| {
            let output = Command::new(if cfg!(windows) { "python.exe" } else { "python3" })
                .args(["-I", "-c", "import sys; print(sys.executable)"])
                .output()
                .expect("the gateway fixture requires Python 3 on PATH");
            assert!(
                output.status.success(),
                "Python fixture lookup failed ({}): {}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            );
            let python = PathBuf::from(
                String::from_utf8(output.stdout)
                    .expect("Python fixture path must be UTF-8")
                    .trim(),
            );
            assert!(python.is_absolute(), "Python fixture path must be absolute");
            python
        })
        .as_path()
}
