use reqwest::blocking::{Client, Response};
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, ETAG,
    IF_RANGE, LAST_MODIFIED, RANGE,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::paths::{sync_directory, write_private_atomic};

const JOURNAL_SCHEMA_VERSION: u32 = 1;
const MAX_JOURNAL_BYTES: u64 = 64 * 1024;
const JOURNAL_CHECKPOINT_BYTES: u64 = 1024 * 1024;
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(100);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadErrorCode {
    InvalidRequest,
    DestinationConflict,
    JournalCorrupt,
    Network,
    RedirectRejected,
    ResponseEncodingRejected,
    MissingValidator,
    ValidatorChanged,
    RangeRejected,
    SizeLimitExceeded,
    DownloadInterrupted,
    HashMismatch,
    Paused,
    Cancelled,
    Io,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadError {
    pub code: DownloadErrorCode,
}

impl DownloadError {
    fn new(code: DownloadErrorCode) -> Self {
        Self { code }
    }
}

pub struct DownloadSpec {
    pub source_url: String,
    pub expected_size: u64,
    pub expected_sha256: String,
    pub completed_path: PathBuf,
}

#[derive(Debug)]
pub struct DownloadOutcome {
    pub completed_path: PathBuf,
    pub byte_size: u64,
    pub sha256: String,
}

pub trait DownloadProgressReporter: Send + Sync {
    fn try_report(&self, completed_bytes: u64, total_bytes: u64) -> bool;
}

impl DownloadProgressReporter for () {
    fn try_report(&self, _completed_bytes: u64, _total_bytes: u64) -> bool {
        true
    }
}

#[derive(Debug, Clone, Default)]
pub struct DownloadControl {
    signal: Arc<AtomicU8>,
}

impl DownloadControl {
    pub fn pause(&self) {
        self.signal
            .store(ControlSignal::Pause as u8, Ordering::Release);
    }

    pub fn cancel(&self) {
        self.signal
            .store(ControlSignal::Cancel as u8, Ordering::Release);
    }

    pub fn resume(&self) {
        self.signal
            .store(ControlSignal::Continue as u8, Ordering::Release);
    }

    fn current(&self) -> ControlSignal {
        match self.signal.load(Ordering::Acquire) {
            value if value == ControlSignal::Pause as u8 => ControlSignal::Pause,
            value if value == ControlSignal::Cancel as u8 => ControlSignal::Cancel,
            _ => ControlSignal::Continue,
        }
    }
}

#[repr(u8)]
enum ControlSignal {
    Continue = 0,
    Pause = 1,
    Cancel = 2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum JournalStatus {
    Downloading,
    Paused,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
enum DownloadValidator {
    StrongEtag(String),
    LastModified(String),
}

impl DownloadValidator {
    fn header_value(&self) -> &str {
        match self {
            Self::StrongEtag(value) | Self::LastModified(value) => value,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DownloadJournal {
    schema_version: u32,
    source_url: String,
    expected_size: u64,
    expected_sha256: String,
    completed_bytes: u64,
    validator: DownloadValidator,
    status: JournalStatus,
}

struct DownloadPaths {
    completed: PathBuf,
    partial: PathBuf,
    journal: PathBuf,
}

/// Blocking I/O: call only from a dedicated blocking worker.
pub fn download_archive_blocking(
    spec: &DownloadSpec,
    control: &DownloadControl,
) -> Result<DownloadOutcome, DownloadError> {
    download_archive_blocking_with_reporter(spec, control, &())
}

pub fn download_archive_blocking_with_reporter(
    spec: &DownloadSpec,
    control: &DownloadControl,
    reporter: &dyn DownloadProgressReporter,
) -> Result<DownloadOutcome, DownloadError> {
    download_archive_with_options(spec, control, reporter, CONNECT_TIMEOUT, DOWNLOAD_TIMEOUT)
}

fn download_archive_with_options(
    spec: &DownloadSpec,
    control: &DownloadControl,
    reporter: &dyn DownloadProgressReporter,
    connect_timeout: Duration,
    download_timeout: Duration,
) -> Result<DownloadOutcome, DownloadError> {
    validate_spec(spec)?;
    let paths = DownloadPaths::new(&spec.completed_path)?;
    prepare_parent(&paths)?;
    if paths.completed.exists() {
        return verify_existing_completed(spec, &paths);
    }

    let journal = load_resume_state(spec, &paths)?;
    let resume_offset = journal
        .as_ref()
        .map(|value| value.completed_bytes)
        .unwrap_or(0);
    let _ = reporter.try_report(resume_offset, spec.expected_size);
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(connect_timeout)
        .timeout(download_timeout)
        .build()
        .map_err(|_| DownloadError::new(DownloadErrorCode::Network))?;
    let mut request = client
        .get(&spec.source_url)
        .header(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    if let Some(existing) = &journal {
        request = request
            .header(RANGE, format!("bytes={resume_offset}-"))
            .header(IF_RANGE, existing.validator.header_value());
    }
    let response = request
        .send()
        .map_err(|_| DownloadError::new(DownloadErrorCode::Network))?;
    let response = validate_response(spec, response, resume_offset, journal.as_ref())?;
    let response_validator = select_validator(response.headers())?;
    let append = resume_offset > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if append {
        if journal.as_ref().map(|value| &value.validator) != Some(&response_validator) {
            return Err(DownloadError::new(DownloadErrorCode::ValidatorChanged));
        }
    } else {
        remove_regular_if_present(&paths.partial)?;
    }

    let completed_bytes = if append { resume_offset } else { 0 };
    let mut active_journal = DownloadJournal {
        schema_version: JOURNAL_SCHEMA_VERSION,
        source_url: spec.source_url.clone(),
        expected_size: spec.expected_size,
        expected_sha256: spec.expected_sha256.clone(),
        completed_bytes,
        validator: response_validator,
        status: JournalStatus::Downloading,
    };
    persist_journal(&paths.journal, &active_journal)?;
    let mut partial = open_partial(&paths.partial, append)?;
    if !append {
        partial.set_len(0).map_err(|_| io_error())?;
    }
    copy_response(
        response,
        &mut partial,
        spec,
        &paths,
        &mut active_journal,
        control,
        reporter,
    )?;
    partial.sync_all().map_err(|_| io_error())?;
    drop(partial);

    let (size, sha256) = hash_file_bounded(&paths.partial, spec.expected_size)?;
    if size != spec.expected_size {
        persist_interrupted(&paths, &mut active_journal, size)?;
        return Err(DownloadError::new(DownloadErrorCode::DownloadInterrupted));
    }
    if sha256 != spec.expected_sha256 {
        discard_partial(&paths)?;
        return Err(DownloadError::new(DownloadErrorCode::HashMismatch));
    }
    publish_complete(&paths)?;
    Ok(DownloadOutcome {
        completed_path: paths.completed,
        byte_size: size,
        sha256,
    })
}

impl DownloadPaths {
    fn new(completed: &Path) -> Result<Self, DownloadError> {
        let parent = completed
            .parent()
            .ok_or_else(|| DownloadError::new(DownloadErrorCode::InvalidRequest))?;
        let name = completed
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| DownloadError::new(DownloadErrorCode::InvalidRequest))?;
        Ok(Self {
            completed: completed.to_path_buf(),
            partial: parent.join(format!(".{name}.part")),
            journal: parent.join(format!(".{name}.download.json")),
        })
    }
}

fn validate_spec(spec: &DownloadSpec) -> Result<(), DownloadError> {
    let valid_hash = spec.expected_sha256.len() == 64
        && spec
            .expected_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    let parsed = reqwest::Url::parse(&spec.source_url)
        .map_err(|_| DownloadError::new(DownloadErrorCode::InvalidRequest))?;
    if spec.expected_size == 0
        || !valid_hash
        || !matches!(parsed.scheme(), "https" | "http")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(DownloadError::new(DownloadErrorCode::InvalidRequest));
    }
    Ok(())
}

fn prepare_parent(paths: &DownloadPaths) -> Result<(), DownloadError> {
    let parent = paths
        .completed
        .parent()
        .ok_or_else(|| DownloadError::new(DownloadErrorCode::InvalidRequest))?;
    let metadata = fs::symlink_metadata(parent).map_err(|_| io_error())?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(DownloadError::new(DownloadErrorCode::InvalidRequest));
    }
    for path in [&paths.completed, &paths.partial, &paths.journal] {
        reject_symlink(path)?;
        if path.parent() != Some(parent) {
            return Err(DownloadError::new(DownloadErrorCode::InvalidRequest));
        }
    }
    Ok(())
}

fn load_resume_state(
    spec: &DownloadSpec,
    paths: &DownloadPaths,
) -> Result<Option<DownloadJournal>, DownloadError> {
    let Some(journal) = read_journal(&paths.journal)? else {
        if paths.partial.exists() {
            remove_regular_if_present(&paths.partial)?;
        }
        return Ok(None);
    };
    if journal.schema_version != JOURNAL_SCHEMA_VERSION
        || journal.source_url != spec.source_url
        || journal.expected_size != spec.expected_size
        || journal.expected_sha256 != spec.expected_sha256
        || journal.completed_bytes > spec.expected_size
    {
        return Err(DownloadError::new(DownloadErrorCode::JournalCorrupt));
    }
    if journal.status == JournalStatus::Cancelled {
        remove_regular_if_present(&paths.partial)?;
        remove_regular_if_present(&paths.journal)?;
        return Ok(None);
    }
    let metadata = fs::symlink_metadata(&paths.partial)
        .map_err(|_| DownloadError::new(DownloadErrorCode::JournalCorrupt))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(DownloadError::new(DownloadErrorCode::JournalCorrupt));
    }
    if metadata.len() < journal.completed_bytes || metadata.len() > spec.expected_size {
        return Err(DownloadError::new(DownloadErrorCode::JournalCorrupt));
    }
    if metadata.len() > journal.completed_bytes {
        OpenOptions::new()
            .write(true)
            .open(&paths.partial)
            .and_then(|file| file.set_len(journal.completed_bytes))
            .map_err(|_| io_error())?;
    }
    if journal.completed_bytes == spec.expected_size {
        let (size, sha256) = hash_file_bounded(&paths.partial, spec.expected_size)?;
        if size == spec.expected_size && sha256 == spec.expected_sha256 {
            publish_complete(paths)?;
            return Ok(None);
        }
        discard_partial(paths)?;
        return Err(DownloadError::new(DownloadErrorCode::HashMismatch));
    }
    Ok(Some(journal))
}

fn validate_response(
    spec: &DownloadSpec,
    response: Response,
    resume_offset: u64,
    journal: Option<&DownloadJournal>,
) -> Result<Response, DownloadError> {
    if response.status().is_redirection() {
        return Err(DownloadError::new(DownloadErrorCode::RedirectRejected));
    }
    if response
        .headers()
        .get(CONTENT_ENCODING)
        .is_some_and(|value| value.as_bytes() != b"identity")
    {
        return Err(DownloadError::new(
            DownloadErrorCode::ResponseEncodingRejected,
        ));
    }
    let status = response.status();
    if journal.is_some() && status == reqwest::StatusCode::PARTIAL_CONTENT {
        validate_content_range(response.headers(), resume_offset, spec.expected_size)?;
        validate_content_length(response.headers(), spec.expected_size - resume_offset)?;
    } else if status == reqwest::StatusCode::OK {
        validate_content_length(response.headers(), spec.expected_size)?;
    } else {
        return Err(DownloadError::new(if status.is_success() {
            DownloadErrorCode::RangeRejected
        } else {
            DownloadErrorCode::Network
        }));
    }
    Ok(response)
}

fn validate_content_length(headers: &HeaderMap, expected: u64) -> Result<(), DownloadError> {
    // Chunked/HTTP2 responses may omit Content-Length; the streaming hard bound and the signed
    // final size/hash remain authoritative. A present length must be exact.
    if let Some(value) = headers.get(CONTENT_LENGTH) {
        let value = value
            .to_str()
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| DownloadError::new(DownloadErrorCode::SizeLimitExceeded))?;
        if value != expected {
            return Err(DownloadError::new(DownloadErrorCode::SizeLimitExceeded));
        }
    }
    Ok(())
}

fn validate_content_range(
    headers: &HeaderMap,
    start: u64,
    total: u64,
) -> Result<(), DownloadError> {
    let expected = format!("bytes {start}-{}/{total}", total - 1);
    if headers
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        != Some(expected.as_str())
    {
        return Err(DownloadError::new(DownloadErrorCode::RangeRejected));
    }
    Ok(())
}

fn select_validator(headers: &HeaderMap) -> Result<DownloadValidator, DownloadError> {
    if let Some(value) = validated_header(headers, ETAG)? {
        if value.len() >= 2
            && value.starts_with('"')
            && value.ends_with('"')
            && !value[1..value.len() - 1].contains('"')
        {
            return Ok(DownloadValidator::StrongEtag(value));
        }
    }
    if let Some(value) = validated_header(headers, LAST_MODIFIED)? {
        return Ok(DownloadValidator::LastModified(value));
    }
    Err(DownloadError::new(DownloadErrorCode::MissingValidator))
}

fn validated_header(
    headers: &HeaderMap,
    name: reqwest::header::HeaderName,
) -> Result<Option<String>, DownloadError> {
    let Some(value) = headers.get(name) else {
        return Ok(None);
    };
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 1024 || bytes.iter().any(|byte| byte.is_ascii_control()) {
        return Err(DownloadError::new(DownloadErrorCode::MissingValidator));
    }
    Ok(Some(
        value
            .to_str()
            .map_err(|_| DownloadError::new(DownloadErrorCode::MissingValidator))?
            .to_string(),
    ))
}

fn copy_response(
    mut response: Response,
    partial: &mut File,
    spec: &DownloadSpec,
    paths: &DownloadPaths,
    journal: &mut DownloadJournal,
    control: &DownloadControl,
    reporter: &dyn DownloadProgressReporter,
) -> Result<(), DownloadError> {
    let mut completed = journal.completed_bytes;
    let mut checkpoint = completed;
    let mut last_reported = completed;
    let mut last_report_at = Instant::now();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        match control.current() {
            ControlSignal::Pause => {
                partial.sync_all().map_err(|_| io_error())?;
                journal.completed_bytes = completed;
                journal.status = JournalStatus::Paused;
                persist_journal(&paths.journal, journal)?;
                return Err(DownloadError::new(DownloadErrorCode::Paused));
            }
            ControlSignal::Cancel => {
                partial.sync_all().map_err(|_| io_error())?;
                drop_partial_contents(partial)?;
                journal.completed_bytes = 0;
                journal.status = JournalStatus::Cancelled;
                persist_journal(&paths.journal, journal)?;
                return Err(DownloadError::new(DownloadErrorCode::Cancelled));
            }
            ControlSignal::Continue => {}
        }
        let count = match response.read(&mut buffer) {
            Ok(count) => count,
            Err(_) => {
                partial.sync_all().map_err(|_| io_error())?;
                journal.completed_bytes = completed;
                journal.status = JournalStatus::Downloading;
                persist_journal(&paths.journal, journal)?;
                return Err(DownloadError::new(DownloadErrorCode::DownloadInterrupted));
            }
        };
        if count == 0 {
            break;
        }
        completed = completed
            .checked_add(count as u64)
            .ok_or_else(|| DownloadError::new(DownloadErrorCode::SizeLimitExceeded))?;
        if completed > spec.expected_size {
            drop_partial_contents(partial)?;
            remove_regular_if_present(&paths.journal)?;
            return Err(DownloadError::new(DownloadErrorCode::SizeLimitExceeded));
        }
        partial
            .write_all(&buffer[..count])
            .map_err(|_| io_error())?;
        if completed == spec.expected_size
            || (completed - last_reported >= JOURNAL_CHECKPOINT_BYTES
                && last_report_at.elapsed() >= PROGRESS_MIN_INTERVAL)
        {
            let _ = reporter.try_report(completed, spec.expected_size);
            last_reported = completed;
            last_report_at = Instant::now();
        }
        if completed - checkpoint >= JOURNAL_CHECKPOINT_BYTES {
            partial.sync_data().map_err(|_| io_error())?;
            journal.completed_bytes = completed;
            journal.status = JournalStatus::Downloading;
            persist_journal(&paths.journal, journal)?;
            checkpoint = completed;
        }
    }
    journal.completed_bytes = completed;
    journal.status = JournalStatus::Downloading;
    partial.sync_all().map_err(|_| io_error())?;
    persist_journal(&paths.journal, journal)?;
    Ok(())
}

fn drop_partial_contents(file: &mut File) -> Result<(), DownloadError> {
    file.set_len(0).map_err(|_| io_error())?;
    file.seek(SeekFrom::Start(0)).map_err(|_| io_error())?;
    file.sync_all().map_err(|_| io_error())
}

fn open_partial(path: &Path, append: bool) -> Result<File, DownloadError> {
    let mut options = OpenOptions::new();
    options.write(true);
    if append {
        options.append(true);
    } else {
        options.create_new(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|_| io_error())
}

fn read_journal(path: &Path) -> Result<Option<DownloadJournal>, DownloadError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(io_error()),
    };
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_JOURNAL_BYTES
    {
        return Err(DownloadError::new(DownloadErrorCode::JournalCorrupt));
    }
    let bytes = fs::read(path).map_err(|_| io_error())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| DownloadError::new(DownloadErrorCode::JournalCorrupt))
}

fn persist_journal(path: &Path, journal: &DownloadJournal) -> Result<(), DownloadError> {
    let bytes = serde_json::to_vec_pretty(journal)
        .map_err(|_| DownloadError::new(DownloadErrorCode::JournalCorrupt))?;
    write_private_atomic(path, &bytes).map_err(|_| io_error())
}

fn persist_interrupted(
    paths: &DownloadPaths,
    journal: &mut DownloadJournal,
    completed: u64,
) -> Result<(), DownloadError> {
    journal.completed_bytes = completed;
    journal.status = JournalStatus::Downloading;
    persist_journal(&paths.journal, journal)
}

fn hash_file_bounded(path: &Path, maximum: u64) -> Result<(u64, String), DownloadError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| io_error())?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(DownloadError::new(DownloadErrorCode::JournalCorrupt));
    }
    if metadata.len() > maximum {
        return Err(DownloadError::new(DownloadErrorCode::SizeLimitExceeded));
    }
    let mut file = File::open(path).map_err(|_| io_error())?;
    let mut digest = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| io_error())?;
        if count == 0 {
            break;
        }
        size = size
            .checked_add(count as u64)
            .ok_or_else(|| DownloadError::new(DownloadErrorCode::SizeLimitExceeded))?;
        if size > maximum {
            return Err(DownloadError::new(DownloadErrorCode::SizeLimitExceeded));
        }
        digest.update(&buffer[..count]);
    }
    Ok((size, hex::encode(digest.finalize())))
}

fn verify_existing_completed(
    spec: &DownloadSpec,
    paths: &DownloadPaths,
) -> Result<DownloadOutcome, DownloadError> {
    let (size, sha256) = hash_file_bounded(&paths.completed, spec.expected_size)?;
    if size != spec.expected_size || sha256 != spec.expected_sha256 {
        return Err(DownloadError::new(DownloadErrorCode::DestinationConflict));
    }
    remove_regular_if_present(&paths.partial)?;
    remove_regular_if_present(&paths.journal)?;
    Ok(DownloadOutcome {
        completed_path: paths.completed.clone(),
        byte_size: size,
        sha256,
    })
}

fn publish_complete(paths: &DownloadPaths) -> Result<(), DownloadError> {
    reject_symlink(&paths.completed)?;
    if paths.completed.exists() {
        return Err(DownloadError::new(DownloadErrorCode::DestinationConflict));
    }
    fs::rename(&paths.partial, &paths.completed).map_err(|_| io_error())?;
    remove_regular_if_present(&paths.journal)?;
    sync_directory(
        paths
            .completed
            .parent()
            .ok_or_else(|| DownloadError::new(DownloadErrorCode::InvalidRequest))?,
    )
    .map_err(|_| io_error())
}

fn discard_partial(paths: &DownloadPaths) -> Result<(), DownloadError> {
    remove_regular_if_present(&paths.partial)?;
    remove_regular_if_present(&paths.journal)
}

fn remove_regular_if_present(path: &Path) -> Result<(), DownloadError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {
            fs::remove_file(path).map_err(|_| io_error())
        }
        Ok(_) => Err(DownloadError::new(DownloadErrorCode::DestinationConflict)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(io_error()),
    }
}

fn reject_symlink(path: &Path) -> Result<(), DownloadError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(DownloadError::new(DownloadErrorCode::DestinationConflict))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(io_error()),
    }
}

fn io_error() -> DownloadError {
    DownloadError::new(DownloadErrorCode::Io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::thread;

    #[derive(Clone)]
    struct FixtureResponse {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
        advertised_length: Option<usize>,
    }

    struct FixtureServer {
        url: String,
        requests: Arc<Mutex<Vec<Vec<String>>>>,
        handle: thread::JoinHandle<()>,
    }

    #[derive(Default)]
    struct RecordingReporter(Mutex<Vec<(u64, u64)>>);

    impl DownloadProgressReporter for RecordingReporter {
        fn try_report(&self, completed: u64, total: u64) -> bool {
            self.0.lock().unwrap().push((completed, total));
            false
        }
    }

    impl FixtureServer {
        fn start(responses: Vec<FixtureResponse>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let captured = Arc::clone(&requests);
            let handle = thread::spawn(move || {
                for response in responses {
                    let (stream, _) = listener.accept().unwrap();
                    serve(stream, response, &captured);
                }
            });
            Self {
                url: format!("http://{address}/runtime.zip"),
                requests,
                handle,
            }
        }

        fn finish(self) -> Vec<Vec<String>> {
            self.handle.join().unwrap();
            self.requests.lock().unwrap().clone()
        }
    }

    fn serve(
        mut stream: TcpStream,
        response: FixtureResponse,
        requests: &Arc<Mutex<Vec<Vec<String>>>>,
    ) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut lines = Vec::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" || line.is_empty() {
                break;
            }
            lines.push(line.trim_end().to_string());
        }
        requests.lock().unwrap().push(lines);
        let reason = match response.status {
            200 => "OK",
            206 => "Partial Content",
            302 => "Found",
            _ => "Error",
        };
        write!(stream, "HTTP/1.1 {} {}\r\n", response.status, reason).unwrap();
        let length = response.advertised_length.unwrap_or(response.body.len());
        if length != usize::MAX {
            write!(stream, "Content-Length: {length}\r\n").unwrap();
        }
        write!(stream, "Connection: close\r\n").unwrap();
        for (name, value) in response.headers {
            write!(stream, "{name}: {value}\r\n").unwrap();
        }
        write!(stream, "\r\n").unwrap();
        stream.write_all(&response.body).unwrap();
        stream.flush().unwrap();
    }

    fn sha(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn spec(temp: &tempfile::TempDir, url: String, body: &[u8]) -> DownloadSpec {
        DownloadSpec {
            source_url: url,
            expected_size: body.len() as u64,
            expected_sha256: sha(body),
            completed_path: temp.path().join("runtime.zip"),
        }
    }

    fn failure(spec: &DownloadSpec) -> DownloadErrorCode {
        download_archive_blocking(spec, &DownloadControl::default())
            .unwrap_err()
            .code
    }

    fn response(status: u16, etag: &str, body: &[u8]) -> FixtureResponse {
        FixtureResponse {
            status,
            headers: vec![("ETag".to_string(), etag.to_string())],
            body: body.to_vec(),
            advertised_length: None,
        }
    }

    #[test]
    fn resumes_disconnected_response_with_exact_validator_and_range() {
        let body = b"0123456789abcdef";
        let prefix = &body[..6];
        let remainder = &body[6..];
        let server = FixtureServer::start(vec![
            FixtureResponse {
                advertised_length: Some(body.len()),
                ..response(200, "\"v1\"", prefix)
            },
            FixtureResponse {
                headers: vec![
                    ("ETag".to_string(), "\"v1\"".to_string()),
                    (
                        "Content-Range".to_string(),
                        format!("bytes 6-{}/{}", body.len() - 1, body.len()),
                    ),
                ],
                ..response(206, "\"v1\"", remainder)
            },
        ]);
        let temp = tempfile::tempdir().unwrap();
        let spec = spec(&temp, server.url.clone(), body);
        assert_eq!(failure(&spec), DownloadErrorCode::DownloadInterrupted);
        let reporter = RecordingReporter::default();
        let outcome =
            download_archive_blocking_with_reporter(&spec, &DownloadControl::default(), &reporter)
                .unwrap();
        assert_eq!(fs::read(outcome.completed_path).unwrap(), body);
        let progress = reporter.0.into_inner().unwrap();
        assert_eq!(progress.first(), Some(&(6, body.len() as u64)));
        assert_eq!(
            progress.last(),
            Some(&(body.len() as u64, body.len() as u64))
        );
        let requests = server.finish();
        assert!(requests[0]
            .iter()
            .any(|line| line.eq_ignore_ascii_case("accept-encoding: identity")));
        assert!(requests[1]
            .iter()
            .any(|line| line.eq_ignore_ascii_case("range: bytes=6-")));
        assert!(requests[1]
            .iter()
            .any(|line| line.eq_ignore_ascii_case("if-range: \"v1\"")));
    }

    #[test]
    fn validator_change_with_200_response_restarts_without_appending() {
        let body = b"same-complete-body";
        let server = FixtureServer::start(vec![
            FixtureResponse {
                advertised_length: Some(body.len()),
                ..response(200, "\"v1\"", &body[..4])
            },
            response(200, "\"v2\"", body),
        ]);
        let temp = tempfile::tempdir().unwrap();
        let spec = spec(&temp, server.url.clone(), body);
        assert!(download_archive_blocking(&spec, &DownloadControl::default()).is_err());
        let outcome = download_archive_blocking(&spec, &DownloadControl::default()).unwrap();
        assert_eq!(fs::read(outcome.completed_path).unwrap(), body);
        server.finish();
    }

    #[test]
    fn rejects_inexact_content_range() {
        let body = b"range-body";
        let server = FixtureServer::start(vec![
            FixtureResponse {
                advertised_length: Some(body.len()),
                ..response(200, "\"v1\"", &body[..3])
            },
            FixtureResponse {
                headers: vec![
                    ("ETag".to_string(), "\"v1\"".to_string()),
                    (
                        "Content-Range".to_string(),
                        format!("bytes 2-{}/{}", body.len() - 1, body.len()),
                    ),
                ],
                ..response(206, "\"v1\"", &body[3..])
            },
        ]);
        let temp = tempfile::tempdir().unwrap();
        let spec = spec(&temp, server.url.clone(), body);
        assert!(download_archive_blocking(&spec, &DownloadControl::default()).is_err());
        assert_eq!(failure(&spec), DownloadErrorCode::RangeRejected);
        server.finish();
    }

    #[test]
    fn rejects_oversize_and_hash_mismatch_without_publication() {
        let expected = b"four";
        let oversize = FixtureServer::start(vec![response(200, "\"v1\"", b"fives")]);
        let temp = tempfile::tempdir().unwrap();
        let oversize_spec = spec(&temp, oversize.url.clone(), expected);
        assert_eq!(
            failure(&oversize_spec),
            DownloadErrorCode::SizeLimitExceeded
        );
        oversize.finish();
        assert!(!oversize_spec.completed_path.exists());

        let wrong = b"fail";
        let hash_server = FixtureServer::start(vec![response(200, "\"v2\"", wrong)]);
        let mut hash_spec = spec(&temp, hash_server.url.clone(), wrong);
        hash_spec.expected_sha256 = sha(b"pass");
        assert_eq!(failure(&hash_spec), DownloadErrorCode::HashMismatch);
        hash_server.finish();
        assert!(!hash_spec.completed_path.exists());

        let exact = b"chunked-size-bound";
        let no_length = FixtureServer::start(vec![FixtureResponse {
            advertised_length: Some(usize::MAX),
            ..response(200, "\"v3\"", exact)
        }]);
        let no_length_spec = spec(&temp, no_length.url.clone(), exact);
        assert!(download_archive_blocking(&no_length_spec, &DownloadControl::default()).is_ok());
        no_length.finish();
    }

    #[test]
    fn pause_and_cancel_are_persisted() {
        let body = b"control-state";
        for (signal, expected_status, expected_error) in [
            (ControlSignal::Pause, "paused", DownloadErrorCode::Paused),
            (
                ControlSignal::Cancel,
                "cancelled",
                DownloadErrorCode::Cancelled,
            ),
        ] {
            let server = FixtureServer::start(vec![response(200, "\"v1\"", body)]);
            let temp = tempfile::tempdir().unwrap();
            let spec = spec(&temp, server.url.clone(), body);
            let control = DownloadControl::default();
            match signal {
                ControlSignal::Pause => control.pause(),
                ControlSignal::Cancel => control.cancel(),
                ControlSignal::Continue => unreachable!(),
            }
            assert_eq!(
                download_archive_blocking(&spec, &control).unwrap_err().code,
                expected_error
            );
            server.finish();
            let name = spec.completed_path.file_name().unwrap().to_str().unwrap();
            let journal =
                fs::read_to_string(temp.path().join(format!(".{name}.download.json"))).unwrap();
            assert!(journal.contains(&format!("\"status\": \"{expected_status}\"")));
        }
    }

    #[test]
    fn total_deadline_returns_stable_network_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/runtime.zip", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let _connection = listener.accept().unwrap();
            thread::sleep(Duration::from_millis(100));
        });
        let temp = tempfile::tempdir().unwrap();
        let spec = spec(&temp, url, b"deadline");
        let error = download_archive_with_options(
            &spec,
            &DownloadControl::default(),
            &(),
            Duration::from_secs(1),
            Duration::from_millis(20),
        )
        .unwrap_err();
        assert_eq!(error.code, DownloadErrorCode::Network);
        server.join().unwrap();
    }
}
