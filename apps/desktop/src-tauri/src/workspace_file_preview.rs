use std::fs::File;
use std::io::Read;

const MAX_PREVIEW_BYTES: u64 = 1024 * 1024;

#[derive(Debug, serde::Serialize)]
pub struct WorkspaceFilePreview {
    path: String,
    content: String,
    byte_size: u64,
    is_binary: bool,
    truncated: bool,
}

#[tauri::command]
pub async fn get_workspace_file_preview(
    working_dir: String,
    file_path: String,
) -> Result<WorkspaceFilePreview, String> {
    tauri::async_runtime::spawn_blocking(move || read_preview(&working_dir, &file_path))
        .await
        .map_err(|error| error.to_string())?
}

fn read_preview(working_dir: &str, file_path: &str) -> Result<WorkspaceFilePreview, String> {
    let path = crate::resolve_workspace_media_path(working_dir, file_path)?;
    if !path.is_file() {
        return Err("Not a regular file".to_string());
    }
    let file = File::open(&path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Not a regular file".to_string());
    }
    let mut bytes = Vec::new();
    file.take(MAX_PREVIEW_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let truncated = bytes.len() as u64 > MAX_PREVIEW_BYTES;
    bytes.truncate(MAX_PREVIEW_BYTES as usize);
    // A truncated UTF-8 codepoint at the boundary is not a binary file.
    let is_binary = bytes.contains(&0)
        || std::str::from_utf8(&bytes)
            .err()
            .map(|error| error.error_len().is_some() || !truncated)
            .unwrap_or(false);
    let content = if is_binary {
        String::new()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    Ok(WorkspaceFilePreview {
        path: file_path.to_string(),
        content,
        byte_size: metadata.len(),
        is_binary,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, process::Command};

    fn git(root: &std::path::Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn workspace_preview_reads_non_git_markdown_and_bounds_binary_and_large_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_str().unwrap();
        fs::write(temp.path().join("报告.md"), "# 标题\n\n**完成**").unwrap();
        let preview = read_preview(root, "报告.md").unwrap();
        assert_eq!(preview.content, "# 标题\n\n**完成**");
        assert!(!preview.is_binary);
        fs::write(temp.path().join("binary"), [0, 1, 2]).unwrap();
        assert!(read_preview(root, "binary").unwrap().is_binary);
        fs::write(
            temp.path().join("large.md"),
            vec![b'a'; MAX_PREVIEW_BYTES as usize + 10],
        )
        .unwrap();
        let large = read_preview(root, "large.md").unwrap();
        assert!(large.truncated);
        assert_eq!(large.content.len(), MAX_PREVIEW_BYTES as usize);
        assert!(read_preview(root, ".").is_err());
        assert!(read_preview(root, "missing.md").is_err());
    }

    #[test]
    fn workspace_preview_rejects_parent_traversal_and_external_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        fs::create_dir(&project).unwrap();
        fs::write(temp.path().join("outside.md"), "private").unwrap();
        let root = project.to_str().unwrap();
        assert!(read_preview(root, "../outside.md")
            .unwrap_err()
            .contains("escapes working dir"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(temp.path().join("outside.md"), project.join("link.md"))
                .unwrap();
            assert!(read_preview(root, "link.md")
                .unwrap_err()
                .contains("escapes working dir"));
        }
    }

    #[test]
    fn workspace_git_lists_real_filenames_and_reads_diffs_from_subdirectories() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        git(root, &["init", "-q"]);
        git(root, &["config", "user.email", "fixture@example.invalid"]);
        git(root, &["config", "user.name", "Fixture"]);
        fs::create_dir(root.join("docs")).unwrap();
        fs::write(root.join("alpha.txt"), "before\n").unwrap();
        fs::write(root.join("docs/报告.md"), "# Before\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "fixture"]);
        fs::write(root.join("alpha.txt"), "after\n").unwrap();
        fs::write(root.join("docs/报告.md"), "# After\n").unwrap();
        fs::create_dir(root.join("outputs")).unwrap();
        fs::write(root.join("outputs/my report.md"), "# New report\n").unwrap();
        fs::write(root.join("outputs/new\nline.md"), "newline filename\n").unwrap();
        let snapshot = crate::get_workspace_git_snapshot(root.to_string_lossy().into()).unwrap();
        let paths: Vec<_> = snapshot
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert_eq!(
            paths,
            vec![
                "alpha.txt",
                "docs/报告.md",
                "outputs/my report.md",
                "outputs/new\nline.md"
            ]
        );
        assert_eq!(snapshot.dirty_count, 4);
        let nested = root.join("docs").to_string_lossy().to_string();
        let nested_snapshot = crate::get_workspace_git_snapshot(nested.clone()).unwrap();
        assert_eq!(nested_snapshot.files.len(), 1);
        assert_eq!(nested_snapshot.files[0].path, "报告.md");
        let diff = crate::get_workspace_file_diff(nested, "报告.md".into()).unwrap();
        assert_eq!(diff.additions, 1);
        assert_eq!(diff.deletions, 1);
        let new_file = crate::get_workspace_file_diff(
            root.to_string_lossy().into(),
            "outputs/my report.md".into(),
        )
        .unwrap();
        assert!(new_file.is_untracked);
        assert_eq!(new_file.additions, 1);
    }

    #[cfg(unix)]
    #[test]
    fn workspace_diff_preserves_symlink_identity_after_boundary_validation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        git(root, &["init", "-q"]);
        git(root, &["config", "user.email", "fixture@example.invalid"]);
        git(root, &["config", "user.name", "Fixture"]);
        fs::write(root.join("one.md"), "one").unwrap();
        fs::write(root.join("two.md"), "two").unwrap();
        std::os::unix::fs::symlink("one.md", root.join("link.md")).unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "fixture"]);
        fs::remove_file(root.join("link.md")).unwrap();
        std::os::unix::fs::symlink("two.md", root.join("link.md")).unwrap();
        let diff = crate::get_workspace_file_diff(root.to_string_lossy().into(), "link.md".into())
            .unwrap();
        assert_eq!(diff.additions, 1);
        assert_eq!(diff.deletions, 1);
    }
}
