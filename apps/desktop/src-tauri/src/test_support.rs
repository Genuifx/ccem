//! Test-only filesystem helpers. These do not validate containment or resolve links.

use std::fs;
use std::io;
use std::path::Path;

/// Create the requested kind of link, including a dangling or relative target.
/// Never infer the kind by following the target, which may deliberately be absent.
pub(crate) fn symlink_file(source: impl AsRef<Path>, target: impl AsRef<Path>) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, target)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(source, target)
    }
}

pub(crate) fn symlink_dir(source: impl AsRef<Path>, target: impl AsRef<Path>) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, target)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(source, target)
    }
}

/// Assert the stored target, tolerating only Windows' native/verbatim prefix
/// difference. This still requires a symlink and works after its target is gone.
/// For an exact serialized spelling contract, retain a raw assertion instead.
pub(crate) fn assert_symlink_target(link: impl AsRef<Path>, expected: impl AsRef<Path>) {
    let link = link.as_ref();
    let actual = fs::read_link(link).unwrap_or_else(|error| {
        panic!("read symlink target {}: {error}", link.display());
    });
    assert!(
        same_target_spelling(&actual, expected.as_ref()),
        "symlink {} target mismatch: actual {:?}, expected {:?}",
        link.display(),
        actual,
        expected.as_ref(),
    );
}

#[cfg(not(windows))]
fn same_target_spelling(left: &Path, right: &Path) -> bool {
    left.as_os_str() == right.as_os_str()
}

#[cfg(windows)]
fn same_target_spelling(left: &Path, right: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Component, Prefix};

    // Preserve all spelling except the two equivalent Windows prefix forms.
    // In particular, do not canonicalize, case-fold, or collapse '..'.
    fn spelling(path: &Path) -> Vec<u16> {
        let units: Vec<u16> = path.as_os_str().encode_wide().collect();
        match path.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::VerbatimDisk(_) => units[4..].to_vec(),
                Prefix::VerbatimUNC(_, _) => {
                    let mut native = vec![b'\\' as u16, b'\\' as u16];
                    native.extend_from_slice(&units[8..]);
                    native
                }
                _ => units,
            },
            _ => units,
        }
    }
    spelling(left) == spelling(right)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_and_directory_links_keep_their_targets() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let file = root.join("file # % 中文");
        let directory = root.join("directory");
        fs::write(&file, b"fixture").unwrap();
        fs::create_dir(&directory).unwrap();
        symlink_file(&file, root.join("file-link")).unwrap();
        symlink_dir(&directory, root.join("directory-link")).unwrap();
        assert_symlink_target(root.join("file-link"), &file);
        assert_symlink_target(root.join("directory-link"), &directory);
        fs::remove_file(&file).unwrap();
        fs::remove_dir(&directory).unwrap();
        assert_symlink_target(root.join("file-link"), &file);
        assert_symlink_target(root.join("directory-link"), &directory);
    }

    #[test]
    fn relative_dangling_targets_keep_their_literal_parent_segments() {
        let temporary = tempfile::tempdir().unwrap();
        let link = temporary.path().join("dangling");
        let target = Path::new("..").join("missing");
        symlink_file(&target, &link).unwrap();
        assert_symlink_target(&link, &target);
        assert!(!same_target_spelling(
            Path::new("../missing"),
            Path::new("missing")
        ));
        assert!(!same_target_spelling(Path::new("a/../b"), Path::new("b")));
    }

    #[test]
    #[should_panic(expected = "target mismatch")]
    fn rejects_a_different_target() {
        let temporary = tempfile::tempdir().unwrap();
        let link = temporary.path().join("link");
        symlink_file("missing-one", &link).unwrap();
        assert_symlink_target(&link, "missing-two");
    }

    #[test]
    #[should_panic(expected = "read symlink target")]
    fn rejects_regular_files_even_when_the_expected_path_matches() {
        let temporary = tempfile::tempdir().unwrap();
        let file = temporary.path().join("file");
        fs::write(&file, b"fixture").unwrap();
        assert_symlink_target(&file, &file);
    }

    #[cfg(windows)]
    #[test]
    fn only_native_and_verbatim_disk_or_unc_prefixes_are_equivalent() {
        for (native, verbatim) in [
            (r"C:\missing\skills", r"\\?\C:\missing\skills"),
            (r"\\server\share\missing", r"\\?\UNC\server\share\missing"),
        ] {
            assert!(same_target_spelling(Path::new(native), Path::new(verbatim)));
            assert!(same_target_spelling(Path::new(verbatim), Path::new(native)));
        }
        for changed in [
            r"D:\missing\skills",
            r"C:\other\skills",
            r"C:\missing\skills\child",
            r"missing\skills",
            r"C:\missing\..\skills",
        ] {
            assert!(!same_target_spelling(
                Path::new(changed),
                Path::new(r"\\?\C:\missing\skills")
            ));
        }
        assert!(!same_target_spelling(
            Path::new(r"\\server\other\missing"),
            Path::new(r"\\?\UNC\server\share\missing")
        ));
    }
}
