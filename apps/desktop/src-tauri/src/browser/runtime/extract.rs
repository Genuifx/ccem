use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use zip::ZipArchive;

use super::manifest::RuntimeArtifact;
use super::paths::sync_directory;

const COPY_BUFFER_BYTES: usize = 64 * 1024;
const MAX_SYMLINK_TARGET_BYTES: u64 = 16 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ZIP_COMMENT_BYTES: u64 = u16::MAX as u64;
const UNIX_FILE_TYPE_MASK: u32 = 0o170000;
const UNIX_REGULAR_FILE: u32 = 0o100000;
const UNIX_DIRECTORY: u32 = 0o040000;
const UNIX_SYMLINK: u32 = 0o120000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtractionErrorCode {
    InvalidArchive,
    ArchiveSizeMismatch,
    DestinationConflict,
    InvalidPath,
    DuplicatePath,
    CaseCollision,
    UnsupportedEntryType,
    EncryptedEntry,
    EntryLimitExceeded,
    FileSizeLimitExceeded,
    TotalSizeLimitExceeded,
    SymlinkNotDeclared,
    SymlinkTargetMismatch,
    SymlinkUnsupported,
    RequiredEntryMissing,
    Io,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractionError {
    pub code: ExtractionErrorCode,
}

impl ExtractionError {
    fn new(code: ExtractionErrorCode) -> Self {
        Self { code }
    }
}

impl fmt::Display for ExtractionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "runtime extraction failed: {:?}", self.code)
    }
}

impl std::error::Error for ExtractionError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractionOutcome {
    pub candidate_root: PathBuf,
    pub entry_count: u64,
    pub unpacked_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    File,
    Directory,
    Symlink,
}

#[derive(Debug, Clone)]
struct EntryPlan {
    index: usize,
    relative_path: PathBuf,
    portable_path: String,
    kind: EntryKind,
    size: u64,
    unix_mode: Option<u32>,
}

/// Extracts only into an empty, app-owned candidate directory. No shell utility is invoked.
pub fn extract_runtime_archive(
    archive_path: &Path,
    candidate_root: &Path,
    artifact: &RuntimeArtifact,
) -> Result<ExtractionOutcome, ExtractionError> {
    validate_archive_file(archive_path, artifact.archive.byte_size)?;
    prepare_empty_candidate(candidate_root)?;
    let result = extract_inner(archive_path, candidate_root, artifact);
    if result.is_err() {
        let _ = fs::remove_dir_all(candidate_root);
    }
    result
}

fn extract_inner(
    archive_path: &Path,
    candidate_root: &Path,
    artifact: &RuntimeArtifact,
) -> Result<ExtractionOutcome, ExtractionError> {
    let mut archive_file = File::open(archive_path).map_err(|_| io_error())?;
    let central_entry_count =
        preflight_central_directory(&mut archive_file, artifact.archive.max_entries)?;
    archive_file
        .seek(SeekFrom::Start(0))
        .map_err(|_| io_error())?;
    let mut archive = ZipArchive::new(archive_file)
        .map_err(|_| ExtractionError::new(ExtractionErrorCode::InvalidArchive))?;
    if archive.len() != central_entry_count {
        return Err(ExtractionError::new(ExtractionErrorCode::DuplicatePath));
    }
    let plans = preflight_archive(&mut archive, artifact)?;
    let declared_symlinks = artifact
        .layout
        .symlinks
        .iter()
        .map(|link| (link.path.as_str(), link))
        .collect::<BTreeMap<_, _>>();
    let mut unpacked_bytes = 0_u64;

    for plan in plans.iter().filter(|plan| plan.kind != EntryKind::Symlink) {
        let destination = candidate_root.join(&plan.relative_path);
        match plan.kind {
            EntryKind::Directory => ensure_private_directories(candidate_root, &destination)?,
            EntryKind::File => {
                let parent = destination
                    .parent()
                    .ok_or_else(|| ExtractionError::new(ExtractionErrorCode::InvalidPath))?;
                ensure_private_directories(candidate_root, parent)?;
                let mut entry = archive
                    .by_index(plan.index)
                    .map_err(|_| ExtractionError::new(ExtractionErrorCode::InvalidArchive))?;
                let actual = write_new_file_bounded(
                    &mut entry,
                    &destination,
                    plan.size,
                    artifact.archive.max_file_bytes,
                    plan.unix_mode,
                )?;
                unpacked_bytes =
                    checked_total(unpacked_bytes, actual, artifact.archive.max_unpacked_bytes)?;
            }
            EntryKind::Symlink => unreachable!(),
        }
    }

    let mut created_symlinks = BTreeSet::new();
    for plan in plans.iter().filter(|plan| plan.kind == EntryKind::Symlink) {
        let declared = declared_symlinks
            .get(plan.portable_path.as_str())
            .ok_or_else(|| ExtractionError::new(ExtractionErrorCode::SymlinkNotDeclared))?;
        let mut entry = archive
            .by_index(plan.index)
            .map_err(|_| ExtractionError::new(ExtractionErrorCode::InvalidArchive))?;
        let target = read_symlink_target(&mut entry, plan.size)?;
        if target != declared.target || !link_target_stays_inside(&plan.portable_path, &target) {
            return Err(ExtractionError::new(
                ExtractionErrorCode::SymlinkTargetMismatch,
            ));
        }
        let destination = candidate_root.join(&plan.relative_path);
        let parent = destination
            .parent()
            .ok_or_else(|| ExtractionError::new(ExtractionErrorCode::InvalidPath))?;
        ensure_private_directories(candidate_root, parent)?;
        create_declared_symlink(&target, &destination)?;
        created_symlinks.insert(plan.portable_path.clone());
        unpacked_bytes = checked_total(
            unpacked_bytes,
            plan.size,
            artifact.archive.max_unpacked_bytes,
        )?;
    }
    if created_symlinks.len() != declared_symlinks.len()
        || declared_symlinks
            .keys()
            .any(|path| !created_symlinks.contains(*path))
    {
        return Err(ExtractionError::new(
            ExtractionErrorCode::RequiredEntryMissing,
        ));
    }
    let executable = candidate_root.join(&artifact.layout.executable.relative_path);
    let executable_metadata = fs::symlink_metadata(&executable)
        .map_err(|_| ExtractionError::new(ExtractionErrorCode::RequiredEntryMissing))?;
    if !executable_metadata.file_type().is_file() || executable_metadata.file_type().is_symlink() {
        return Err(ExtractionError::new(
            ExtractionErrorCode::RequiredEntryMissing,
        ));
    }
    sync_directory(candidate_root).map_err(|_| io_error())?;
    Ok(ExtractionOutcome {
        candidate_root: candidate_root.to_path_buf(),
        entry_count: plans.len() as u64,
        unpacked_bytes,
    })
}

fn preflight_central_directory(
    file: &mut File,
    maximum_entries: u64,
) -> Result<usize, ExtractionError> {
    let archive_size = file.seek(SeekFrom::End(0)).map_err(|_| io_error())?;
    let tail_size = archive_size.min(MAX_ZIP_COMMENT_BYTES + 22);
    file.seek(SeekFrom::End(-(tail_size as i64)))
        .map_err(|_| io_error())?;
    let mut tail = vec![0_u8; tail_size as usize];
    file.read_exact(&mut tail).map_err(|_| io_error())?;
    let eocd_offset = tail
        .windows(4)
        .rposition(|bytes| bytes == b"PK\x05\x06")
        .ok_or_else(|| ExtractionError::new(ExtractionErrorCode::InvalidArchive))?;
    if tail.len() - eocd_offset < 22 {
        return Err(ExtractionError::new(ExtractionErrorCode::InvalidArchive));
    }
    let eocd = &tail[eocd_offset..];
    let disk_number = little_u16(&eocd[4..6]);
    let central_disk = little_u16(&eocd[6..8]);
    let disk_entries = little_u16(&eocd[8..10]);
    let total_entries = little_u16(&eocd[10..12]);
    let central_size = little_u32(&eocd[12..16]) as u64;
    let central_offset = little_u32(&eocd[16..20]) as u64;
    let comment_size = little_u16(&eocd[20..22]) as usize;
    if disk_number != 0
        || central_disk != 0
        || disk_entries != total_entries
        || total_entries as u64 > maximum_entries
        || central_size > MAX_CENTRAL_DIRECTORY_BYTES
        || eocd.len() != 22 + comment_size
        || central_offset
            .checked_add(central_size)
            .is_none_or(|end| end > archive_size)
    {
        return Err(ExtractionError::new(ExtractionErrorCode::InvalidArchive));
    }
    file.seek(SeekFrom::Start(central_offset))
        .map_err(|_| io_error())?;
    let mut central = vec![0_u8; central_size as usize];
    file.read_exact(&mut central).map_err(|_| io_error())?;
    let mut cursor = 0_usize;
    let mut names = BTreeSet::new();
    for _ in 0..total_entries {
        if central.len().saturating_sub(cursor) < 46
            || &central[cursor..cursor + 4] != b"PK\x01\x02"
        {
            return Err(ExtractionError::new(ExtractionErrorCode::InvalidArchive));
        }
        let name_size = little_u16(&central[cursor + 28..cursor + 30]) as usize;
        let extra_size = little_u16(&central[cursor + 30..cursor + 32]) as usize;
        let entry_comment_size = little_u16(&central[cursor + 32..cursor + 34]) as usize;
        let variable_size = name_size
            .checked_add(extra_size)
            .and_then(|value| value.checked_add(entry_comment_size))
            .ok_or_else(|| ExtractionError::new(ExtractionErrorCode::InvalidArchive))?;
        let entry_end = cursor
            .checked_add(46)
            .and_then(|value| value.checked_add(variable_size))
            .filter(|end| *end <= central.len())
            .ok_or_else(|| ExtractionError::new(ExtractionErrorCode::InvalidArchive))?;
        let name = &central[cursor + 46..cursor + 46 + name_size];
        archive_name_utf8(name)?;
        if !names.insert(name.to_vec()) {
            return Err(ExtractionError::new(ExtractionErrorCode::DuplicatePath));
        }
        cursor = entry_end;
    }
    if cursor != central.len() {
        return Err(ExtractionError::new(ExtractionErrorCode::InvalidArchive));
    }
    Ok(total_entries as usize)
}

fn little_u16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes([bytes[0], bytes[1]])
}

fn little_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

fn preflight_archive(
    archive: &mut ZipArchive<File>,
    artifact: &RuntimeArtifact,
) -> Result<Vec<EntryPlan>, ExtractionError> {
    if archive.len() as u64 > artifact.archive.max_entries {
        return Err(ExtractionError::new(
            ExtractionErrorCode::EntryLimitExceeded,
        ));
    }
    let declared_symlinks = artifact
        .layout
        .symlinks
        .iter()
        .map(|link| link.path.as_str())
        .collect::<BTreeSet<_>>();
    let mut plans = Vec::with_capacity(archive.len());
    let mut exact_paths = BTreeSet::new();
    let mut folded_paths = BTreeMap::new();
    let mut path_kinds = BTreeMap::new();
    let mut declared_total = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| ExtractionError::new(ExtractionErrorCode::InvalidArchive))?;
        if entry.encrypted() {
            return Err(ExtractionError::new(ExtractionErrorCode::EncryptedEntry));
        }
        let name = archive_name_utf8(entry.name_raw())?;
        let (relative_path, portable_path) =
            normalize_archive_path(name, &artifact.layout.root_directory, entry.is_dir())?;
        if portable_path.is_empty() {
            if entry.is_dir() {
                continue;
            }
            return Err(ExtractionError::new(ExtractionErrorCode::InvalidPath));
        }
        let kind = classify_entry(entry.is_dir(), entry.is_symlink(), entry.unix_mode())?;
        if kind == EntryKind::Symlink && !declared_symlinks.contains(portable_path.as_str()) {
            return Err(ExtractionError::new(
                ExtractionErrorCode::SymlinkNotDeclared,
            ));
        }
        if kind != EntryKind::Symlink && declared_symlinks.contains(portable_path.as_str()) {
            return Err(ExtractionError::new(
                ExtractionErrorCode::SymlinkTargetMismatch,
            ));
        }
        if path_has_symlink_ancestor(&portable_path, &declared_symlinks) {
            return Err(ExtractionError::new(ExtractionErrorCode::InvalidPath));
        }
        if !exact_paths.insert(portable_path.clone()) {
            return Err(ExtractionError::new(ExtractionErrorCode::DuplicatePath));
        }
        let folded = portable_path.to_lowercase();
        if folded_paths.insert(folded, portable_path.clone()).is_some() {
            return Err(ExtractionError::new(ExtractionErrorCode::CaseCollision));
        }
        reject_tree_conflict(&portable_path, kind, &path_kinds)?;
        path_kinds.insert(portable_path.clone(), kind);
        let size = entry.size();
        if kind == EntryKind::File && size > artifact.archive.max_file_bytes {
            return Err(ExtractionError::new(
                ExtractionErrorCode::FileSizeLimitExceeded,
            ));
        }
        if kind == EntryKind::Symlink && size > MAX_SYMLINK_TARGET_BYTES {
            return Err(ExtractionError::new(
                ExtractionErrorCode::FileSizeLimitExceeded,
            ));
        }
        declared_total = checked_total(declared_total, size, artifact.archive.max_unpacked_bytes)?;
        plans.push(EntryPlan {
            index,
            relative_path,
            portable_path,
            kind,
            size,
            unix_mode: entry.unix_mode(),
        });
    }
    for path in &declared_symlinks {
        if !exact_paths.contains(*path) {
            return Err(ExtractionError::new(
                ExtractionErrorCode::RequiredEntryMissing,
            ));
        }
    }
    Ok(plans)
}

fn archive_name_utf8(raw_name: &[u8]) -> Result<&str, ExtractionError> {
    std::str::from_utf8(raw_name)
        .map_err(|_| ExtractionError::new(ExtractionErrorCode::InvalidPath))
}

fn normalize_archive_path(
    name: &str,
    root: &str,
    directory: bool,
) -> Result<(PathBuf, String), ExtractionError> {
    if name.is_empty()
        || name.contains(['\0', '\\', ':'])
        || name.starts_with('/')
        || name.starts_with("//")
        || name.as_bytes().get(1) == Some(&b':')
    {
        return Err(ExtractionError::new(ExtractionErrorCode::InvalidPath));
    }
    let trimmed = if directory {
        name.strip_suffix('/')
            .ok_or_else(|| ExtractionError::new(ExtractionErrorCode::InvalidPath))?
    } else {
        if name.ends_with('/') {
            return Err(ExtractionError::new(ExtractionErrorCode::InvalidPath));
        }
        name
    };
    if trimmed.split('/').any(|part| part.is_empty()) {
        return Err(ExtractionError::new(ExtractionErrorCode::InvalidPath));
    }
    let components = trimmed.split('/').collect::<Vec<_>>();
    let root_components = root.split('/').collect::<Vec<_>>();
    if components.len() < root_components.len()
        || components[..root_components.len()] != root_components
    {
        return Err(ExtractionError::new(ExtractionErrorCode::InvalidPath));
    }
    let remaining = &components[root_components.len()..];
    if remaining.iter().any(|part| {
        *part == "." || *part == ".." || part.chars().any(char::is_control) || part.contains(':')
    }) {
        return Err(ExtractionError::new(ExtractionErrorCode::InvalidPath));
    }
    let portable = remaining.join("/");
    let relative = remaining.iter().collect::<PathBuf>();
    if !path_is_normal(&relative) {
        return Err(ExtractionError::new(ExtractionErrorCode::InvalidPath));
    }
    Ok((relative, portable))
}

fn classify_entry(
    is_directory: bool,
    is_symlink: bool,
    unix_mode: Option<u32>,
) -> Result<EntryKind, ExtractionError> {
    if let Some(mode) = unix_mode {
        match mode & UNIX_FILE_TYPE_MASK {
            UNIX_DIRECTORY => return Ok(EntryKind::Directory),
            UNIX_SYMLINK => return Ok(EntryKind::Symlink),
            UNIX_REGULAR_FILE | 0 => {}
            _ => {
                return Err(ExtractionError::new(
                    ExtractionErrorCode::UnsupportedEntryType,
                ))
            }
        }
    }
    if is_symlink {
        Ok(EntryKind::Symlink)
    } else if is_directory {
        Ok(EntryKind::Directory)
    } else {
        Ok(EntryKind::File)
    }
}

fn reject_tree_conflict(
    path: &str,
    kind: EntryKind,
    existing: &BTreeMap<String, EntryKind>,
) -> Result<(), ExtractionError> {
    let mut components = path.split('/').collect::<Vec<_>>();
    while components.len() > 1 {
        components.pop();
        if existing
            .get(&components.join("/"))
            .is_some_and(|existing_kind| *existing_kind != EntryKind::Directory)
        {
            return Err(ExtractionError::new(ExtractionErrorCode::InvalidPath));
        }
    }
    if kind != EntryKind::Directory
        && existing.keys().any(|existing_path| {
            existing_path
                .strip_prefix(path)
                .is_some_and(|tail| tail.starts_with('/'))
        })
    {
        return Err(ExtractionError::new(ExtractionErrorCode::InvalidPath));
    }
    Ok(())
}

fn path_has_symlink_ancestor(path: &str, declared: &BTreeSet<&str>) -> bool {
    let mut components = path.split('/').collect::<Vec<_>>();
    while components.len() > 1 {
        components.pop();
        if declared.contains(components.join("/").as_str()) {
            return true;
        }
    }
    false
}

fn prepare_empty_candidate(path: &Path) -> Result<(), ExtractionError> {
    let parent = path
        .parent()
        .ok_or_else(|| ExtractionError::new(ExtractionErrorCode::InvalidPath))?;
    let parent_metadata = fs::symlink_metadata(parent).map_err(|_| io_error())?;
    if !parent_metadata.file_type().is_dir() || parent_metadata.file_type().is_symlink() {
        return Err(ExtractionError::new(ExtractionErrorCode::InvalidPath));
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.file_type().is_dir()
                || metadata.file_type().is_symlink()
                || fs::read_dir(path).map_err(|_| io_error())?.next().is_some()
            {
                return Err(ExtractionError::new(
                    ExtractionErrorCode::DestinationConflict,
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|_| io_error())?;
        }
        Err(_) => return Err(io_error()),
    }
    set_private_directory(path)
}

fn ensure_private_directories(root: &Path, destination: &Path) -> Result<(), ExtractionError> {
    let relative = destination
        .strip_prefix(root)
        .map_err(|_| ExtractionError::new(ExtractionErrorCode::InvalidPath))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(ExtractionError::new(ExtractionErrorCode::InvalidPath));
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
                    return Err(ExtractionError::new(
                        ExtractionErrorCode::DestinationConflict,
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|_| io_error())?;
            }
            Err(_) => return Err(io_error()),
        }
        set_private_directory(&current)?;
    }
    Ok(())
}

fn write_new_file_bounded<R: Read>(
    reader: &mut R,
    destination: &Path,
    declared_size: u64,
    maximum: u64,
    unix_mode: Option<u32>,
) -> Result<u64, ExtractionError> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(destination).map_err(|_| io_error())?;
    let mut copied = 0_u64;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|_| ExtractionError::new(ExtractionErrorCode::InvalidArchive))?;
        if count == 0 {
            break;
        }
        copied = copied
            .checked_add(count as u64)
            .ok_or_else(|| ExtractionError::new(ExtractionErrorCode::FileSizeLimitExceeded))?;
        if copied > maximum || copied > declared_size {
            return Err(ExtractionError::new(
                ExtractionErrorCode::FileSizeLimitExceeded,
            ));
        }
        output.write_all(&buffer[..count]).map_err(|_| io_error())?;
    }
    if copied != declared_size {
        return Err(ExtractionError::new(ExtractionErrorCode::InvalidArchive));
    }
    output.sync_all().map_err(|_| io_error())?;
    set_private_file(destination, unix_mode)?;
    Ok(copied)
}

fn read_symlink_target<R: Read>(
    reader: &mut R,
    declared_size: u64,
) -> Result<String, ExtractionError> {
    if declared_size > MAX_SYMLINK_TARGET_BYTES {
        return Err(ExtractionError::new(
            ExtractionErrorCode::FileSizeLimitExceeded,
        ));
    }
    let mut bytes = Vec::with_capacity(declared_size as usize);
    reader
        .take(MAX_SYMLINK_TARGET_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ExtractionError::new(ExtractionErrorCode::InvalidArchive))?;
    if bytes.len() as u64 != declared_size || bytes.contains(&0) {
        return Err(ExtractionError::new(
            ExtractionErrorCode::SymlinkTargetMismatch,
        ));
    }
    String::from_utf8(bytes)
        .map_err(|_| ExtractionError::new(ExtractionErrorCode::SymlinkTargetMismatch))
}

fn link_target_stays_inside(link_path: &str, target: &str) -> bool {
    if target.is_empty() || target.contains(['\0', '\\', ':']) || target.starts_with('/') {
        return false;
    }
    let mut stack = link_path.split('/').collect::<Vec<_>>();
    stack.pop();
    for component in target.split('/') {
        match component {
            "" => return false,
            "." => {}
            ".." => {
                if stack.pop().is_none() {
                    return false;
                }
            }
            value if value.chars().any(char::is_control) => return false,
            value => stack.push(value),
        }
    }
    !stack.is_empty()
}

#[cfg(unix)]
fn create_declared_symlink(target: &str, destination: &Path) -> Result<(), ExtractionError> {
    std::os::unix::fs::symlink(target, destination).map_err(|_| io_error())
}

#[cfg(not(unix))]
fn create_declared_symlink(_target: &str, _destination: &Path) -> Result<(), ExtractionError> {
    Err(ExtractionError::new(
        ExtractionErrorCode::SymlinkUnsupported,
    ))
}

fn validate_archive_file(path: &Path, expected_size: u64) -> Result<(), ExtractionError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| io_error())?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(ExtractionError::new(ExtractionErrorCode::InvalidArchive));
    }
    if metadata.len() != expected_size {
        return Err(ExtractionError::new(
            ExtractionErrorCode::ArchiveSizeMismatch,
        ));
    }
    Ok(())
}

fn checked_total(current: u64, addition: u64, maximum: u64) -> Result<u64, ExtractionError> {
    let total = current
        .checked_add(addition)
        .ok_or_else(|| ExtractionError::new(ExtractionErrorCode::TotalSizeLimitExceeded))?;
    if total > maximum {
        return Err(ExtractionError::new(
            ExtractionErrorCode::TotalSizeLimitExceeded,
        ));
    }
    Ok(total)
}

fn path_is_normal(path: &Path) -> bool {
    path.components()
        .all(|component| matches!(component, Component::Normal(_)))
}

#[cfg(unix)]
fn set_private_directory(path: &Path) -> Result<(), ExtractionError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| io_error())
}

#[cfg(not(unix))]
fn set_private_directory(_path: &Path) -> Result<(), ExtractionError> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file(path: &Path, unix_mode: Option<u32>) -> Result<(), ExtractionError> {
    use std::os::unix::fs::PermissionsExt;
    let executable = unix_mode.is_some_and(|mode| mode & 0o111 != 0);
    let mode = if executable { 0o700 } else { 0o600 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|_| io_error())
}

#[cfg(not(unix))]
fn set_private_file(_path: &Path, _unix_mode: Option<u32>) -> Result<(), ExtractionError> {
    Ok(())
}

fn io_error() -> ExtractionError {
    ExtractionError::new(ExtractionErrorCode::Io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::runtime::manifest::RuntimeDeclaredSymlink;
    use crate::browser::runtime::manifest::{
        RuntimeArchitecture, RuntimeArchiveFormat, RuntimeArchiveIdentity,
        RuntimeExecutableIdentity, RuntimeLayout, RuntimePlatform, RuntimeProductIdentity,
    };
    use sha2::{Digest, Sha256};
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn artifact(archive_size: u64) -> RuntimeArtifact {
        RuntimeArtifact {
            platform: RuntimePlatform::Macos,
            architecture: RuntimeArchitecture::Aarch64,
            version: "150.0.1".to_string(),
            minimum_os_version: "12.0".to_string(),
            source_url: "https://example.invalid/150.0.1/runtime.zip".to_string(),
            archive: RuntimeArchiveIdentity {
                format: RuntimeArchiveFormat::Zip,
                byte_size: archive_size,
                sha256: "a".repeat(64),
                max_entries: 10,
                max_unpacked_bytes: 1024,
                max_file_bytes: 512,
            },
            layout: RuntimeLayout {
                root_directory: "runtime-root".to_string(),
                executable: RuntimeExecutableIdentity {
                    relative_path: "App/Browser".to_string(),
                    byte_size: 7,
                    sha256: hex::encode(Sha256::digest(b"browser")),
                },
                symlinks: Vec::new(),
            },
            product_identity: RuntimeProductIdentity {
                product_name: "Browser".to_string(),
                product_version: "150.0.1".to_string(),
                bundle_identifier: Some("org.example.browser".to_string()),
                publisher: None,
            },
        }
    }

    fn write_zip<F>(temp: &tempfile::TempDir, build: F) -> PathBuf
    where
        F: FnOnce(&mut ZipWriter<File>),
    {
        let path = temp.path().join("archive.zip");
        let file = File::create(&path).unwrap();
        let mut writer = ZipWriter::new(file);
        build(&mut writer);
        writer.finish().unwrap();
        path
    }

    fn add_file(writer: &mut ZipWriter<File>, name: &str, bytes: &[u8]) {
        writer
            .start_file(name, SimpleFileOptions::default().unix_permissions(0o755))
            .unwrap();
        writer.write_all(bytes).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn extracts_files_and_only_exact_declared_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let archive = write_zip(&temp, |writer| {
            add_file(writer, "runtime-root/App/Browser", b"browser");
            writer
                .add_symlink(
                    "runtime-root/App/Current",
                    "Browser",
                    SimpleFileOptions::default(),
                )
                .unwrap();
        });
        let mut artifact = artifact(fs::metadata(&archive).unwrap().len());
        artifact.layout.symlinks.push(RuntimeDeclaredSymlink {
            path: "App/Current".to_string(),
            target: "Browser".to_string(),
        });
        let candidate = temp.path().join("candidate");
        let outcome = extract_runtime_archive(&archive, &candidate, &artifact).unwrap();
        assert_eq!(outcome.entry_count, 2);
        assert_eq!(fs::read(candidate.join("App/Browser")).unwrap(), b"browser");
        assert_eq!(
            fs::read_link(candidate.join("App/Current")).unwrap(),
            PathBuf::from("Browser")
        );
    }

    #[test]
    fn rejects_case_collisions_duplicates_and_resource_bombs() {
        let temp = tempfile::tempdir().unwrap();
        let case_archive = write_zip(&temp, |writer| {
            add_file(writer, "runtime-root/App/Browser", b"browser");
            add_file(writer, "runtime-root/app/Browser", b"other");
        });
        let case_artifact = artifact(fs::metadata(&case_archive).unwrap().len());
        assert_eq!(
            extract_runtime_archive(&case_archive, &temp.path().join("case"), &case_artifact)
                .unwrap_err()
                .code,
            ExtractionErrorCode::CaseCollision
        );

        // ZipWriter prevents duplicates, so turn the case-collision fixture into a duplicate by
        // replacing the equal-length local and central-directory names after writing.
        let mut duplicate_bytes = fs::read(&case_archive).unwrap();
        let from = b"runtime-root/app/Browser";
        let to = b"runtime-root/App/Browser";
        let mut replacements = 0;
        for offset in 0..=duplicate_bytes.len() - from.len() {
            if &duplicate_bytes[offset..offset + from.len()] == from {
                duplicate_bytes[offset..offset + from.len()].copy_from_slice(to);
                replacements += 1;
            }
        }
        assert_eq!(replacements, 2);
        let duplicate_archive = temp.path().join("duplicate.zip");
        fs::write(&duplicate_archive, duplicate_bytes).unwrap();
        let duplicate_artifact = artifact(fs::metadata(&duplicate_archive).unwrap().len());
        assert_eq!(
            extract_runtime_archive(
                &duplicate_archive,
                &temp.path().join("duplicate"),
                &duplicate_artifact,
            )
            .unwrap_err()
            .code,
            ExtractionErrorCode::DuplicatePath
        );

        let bomb_temp = tempfile::tempdir().unwrap();
        let bomb_archive = write_zip(&bomb_temp, |writer| {
            add_file(writer, "runtime-root/App/Browser", b"browser");
        });
        let mut bomb_artifact = artifact(fs::metadata(&bomb_archive).unwrap().len());
        bomb_artifact.archive.max_unpacked_bytes = 3;
        assert_eq!(
            extract_runtime_archive(
                &bomb_archive,
                &bomb_temp.path().join("candidate"),
                &bomb_artifact,
            )
            .unwrap_err()
            .code,
            ExtractionErrorCode::TotalSizeLimitExceeded
        );
    }

    #[test]
    fn rejects_zip_slip_absolute_unc_ads_nul_and_non_utf8_names() {
        for invalid in [
            "runtime-root/../escape",
            "/runtime-root/App/Browser",
            "\\\\server\\runtime-root\\App",
            "runtime-root/App/file:stream",
            "runtime-root/App/\0bad",
        ] {
            assert_eq!(
                normalize_archive_path(invalid, "runtime-root", false)
                    .unwrap_err()
                    .code,
                ExtractionErrorCode::InvalidPath,
                "{invalid:?}"
            );
        }
        let invalid_utf8 = vec![0xff, 0xfe];
        assert_eq!(
            archive_name_utf8(&invalid_utf8).unwrap_err().code,
            ExtractionErrorCode::InvalidPath
        );
    }

    #[test]
    fn rejects_unknown_unix_types_and_undeclared_symlink() {
        assert_eq!(
            classify_entry(false, false, Some(0o060000))
                .unwrap_err()
                .code,
            ExtractionErrorCode::UnsupportedEntryType
        );
        let temp = tempfile::tempdir().unwrap();
        let archive = write_zip(&temp, |writer| {
            add_file(writer, "runtime-root/App/Browser", b"browser");
            writer
                .add_symlink(
                    "runtime-root/App/Current",
                    "Browser",
                    SimpleFileOptions::default(),
                )
                .unwrap();
        });
        let artifact = artifact(fs::metadata(&archive).unwrap().len());
        assert_eq!(
            extract_runtime_archive(&archive, &temp.path().join("candidate"), &artifact)
                .unwrap_err()
                .code,
            ExtractionErrorCode::SymlinkNotDeclared
        );
    }
}
