#![cfg(windows)]

use super::model::{
    LaunchedRuntime, OwnershipDomain, OwnershipGuard, PlatformLaunchRequest, PrivateCdpTransport,
    ProcessIdentity, ProcessInspector, RuntimeLauncher, SupervisorError, TransportKind,
};
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{self, Read};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::FromRawHandle;
use std::path::PathBuf;
use std::ptr::{null, null_mut};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, SetHandleInformation, FILETIME, HANDLE, HANDLE_FLAG_INHERIT,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, OpenJobObjectW, QueryInformationJobObject,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetProcessTimes,
    InitializeProcThreadAttributeList, OpenProcess, QueryFullProcessImageNameW, ResumeThread,
    TerminateProcess, UpdateProcThreadAttribute, CREATE_SUSPENDED, EXTENDED_STARTUPINFO_PRESENT,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTUPINFOEXW,
};

const ERROR_FILE_NOT_FOUND: u32 = 2;
const ERROR_INVALID_PARAMETER: u32 = 87;
const ERROR_ALREADY_EXISTS: u32 = 183;
const JOB_OBJECT_QUERY_ACCESS: u32 = 0x0004;
const JOB_OBJECT_TERMINATE_ACCESS: u32 = 0x0008;
const PRIVATE_PIPE_READ_SLICE: Duration = Duration::from_millis(100);
const PRIVATE_PIPE_PUMP_CAPACITY: usize = 8;
const PRIVATE_PIPE_PUMP_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, Default)]
pub(super) struct WindowsRuntimeLauncher;

impl RuntimeLauncher for WindowsRuntimeLauncher {
    fn launch(
        &self,
        mut request: PlatformLaunchRequest,
    ) -> Result<LaunchedRuntime, SupervisorError> {
        request.executable.verify_unchanged()?;
        let pipes = PrivatePipeSet::create()?;
        let child_handles = [pipes.child_read.raw(), pipes.child_write.raw()];
        let final_url = request
            .arguments
            .pop()
            .filter(|value| value == "about:blank")
            .ok_or(SupervisorError::LaunchFailed)?;
        request.arguments.push(OsString::from(format!(
            "--remote-debugging-io-pipes={},{}",
            child_handles[0] as usize, child_handles[1] as usize
        )));
        request.arguments.push(final_url);

        let mut attributes = ProcThreadAttributes::with_handle_list(&child_handles)?;
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.lpAttributeList = attributes.as_mut_ptr();
        let application = wide_nul(request.executable.executable().as_os_str());
        let mut command_line = build_command_line(
            request.executable.executable().as_os_str(),
            &request.arguments,
        );

        let job_name = format!("CCEM.LoginBrowser.{}", request.runtime_id);
        let job_name_wide = wide_nul(OsStr::new(&job_name));
        let job_handle = unsafe { CreateJobObjectW(null(), job_name_wide.as_ptr()) };
        let job = OwnedHandle::new(job_handle)?;
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            return Err(SupervisorError::LaunchFailed);
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(SupervisorError::LaunchFailed);
        }

        let mut process_info = PROCESS_INFORMATION::default();
        // CREATE_SUSPENDED is non-negotiable: the process cannot create descendants before it is
        // assigned to the kill-on-close Job Object. STARTUPINFOEX restricts inheritance to the two
        // Chromium CDP child endpoints, matching Chromium's PipeBuilder contract:
        // https://chromium.googlesource.com/chromium/src/+/main/chrome/test/chromedriver/net/pipe_builder.cc
        let created = unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                null(),
                null(),
                &startup.StartupInfo as *const _,
                &mut process_info,
            )
        };
        if created == 0 {
            return Err(SupervisorError::LaunchFailed);
        }
        let process = OwnedHandle::new(process_info.hProcess)?;
        let thread = OwnedHandle::new(process_info.hThread)?;
        if unsafe { AssignProcessToJobObject(job.raw(), process.raw()) } == 0 {
            unsafe { TerminateProcess(process.raw(), 1) };
            return Err(SupervisorError::LaunchFailed);
        }

        let identity = process_identity_from_handle(process_info.dwProcessId, process.raw())?;
        if identity.executable != request.executable.executable().to_path_buf() {
            unsafe { TerminateJobObject(job.raw(), 1) };
            return Err(SupervisorError::ProcessIdentityMismatch);
        }
        if unsafe { ResumeThread(thread.raw()) } == u32::MAX {
            unsafe { TerminateJobObject(job.raw(), 1) };
            return Err(SupervisorError::LaunchFailed);
        }
        drop(thread);
        drop(attributes);
        let PrivatePipeSet {
            child_read,
            parent_write,
            parent_read,
            child_write,
        } = pipes;
        drop(child_read);
        drop(child_write);
        let reader = PumpedPipeReader::spawn(unsafe {
            File::from_raw_handle(parent_read.into_raw().cast())
        })?;
        let writer = unsafe { File::from_raw_handle(parent_write.into_raw().cast()) };

        Ok(LaunchedRuntime {
            identity,
            ownership_domain: OwnershipDomain::WindowsJob { name: job_name },
            transport_kind: TransportKind::WindowsPrivateHandleList,
            transport: PrivateCdpTransport::new(reader, writer),
            guard: Box::new(WindowsOwnershipGuard { process, job }),
        })
    }
}

/// Anonymous Windows pipes do not support overlapped I/O and synchronous inspection may itself
/// block. Keep every OS read on a dedicated pump thread; protocol code only waits on this bounded
/// channel and therefore always regains control to check its absolute deadline.
struct PumpedPipeReader {
    receiver: Receiver<PipePumpMessage>,
    pending: Vec<u8>,
    pending_offset: usize,
}

enum PipePumpMessage {
    Data(Vec<u8>),
    Eof,
    Failed {
        kind: io::ErrorKind,
        raw_os_error: Option<i32>,
    },
}

impl PumpedPipeReader {
    fn spawn(mut file: File) -> Result<Self, SupervisorError> {
        let (sender, receiver) = mpsc::sync_channel(PRIVATE_PIPE_PUMP_CAPACITY);
        thread::Builder::new()
            .name("ccem-login-cdp-pipe".to_string())
            .spawn(move || {
                let mut buffer = vec![0_u8; PRIVATE_PIPE_PUMP_CHUNK_BYTES];
                loop {
                    match file.read(&mut buffer) {
                        Ok(0) => {
                            let _ = sender.send(PipePumpMessage::Eof);
                            return;
                        }
                        Ok(read) => {
                            if sender
                                .send(PipePumpMessage::Data(buffer[..read].to_vec()))
                                .is_err()
                            {
                                return;
                            }
                        }
                        Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                        Err(error) => {
                            let _ = sender.send(PipePumpMessage::Failed {
                                kind: error.kind(),
                                raw_os_error: error.raw_os_error(),
                            });
                            return;
                        }
                    }
                }
            })
            .map_err(|_| SupervisorError::TransportFailed)?;
        Ok(Self {
            receiver,
            pending: Vec::new(),
            pending_offset: 0,
        })
    }

    fn copy_pending(&mut self, buffer: &mut [u8]) -> usize {
        let remaining = &self.pending[self.pending_offset..];
        let copied = remaining.len().min(buffer.len());
        buffer[..copied].copy_from_slice(&remaining[..copied]);
        self.pending_offset += copied;
        if self.pending_offset == self.pending.len() {
            self.pending.clear();
            self.pending_offset = 0;
        }
        copied
    }
}

impl Read for PumpedPipeReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if !self.pending.is_empty() {
            return Ok(self.copy_pending(buffer));
        }
        match self.receiver.recv_timeout(PRIVATE_PIPE_READ_SLICE) {
            Ok(PipePumpMessage::Data(data)) => {
                self.pending = data;
                Ok(self.copy_pending(buffer))
            }
            Ok(PipePumpMessage::Eof) => Ok(0),
            Ok(PipePumpMessage::Failed { kind, raw_os_error }) => Err(raw_os_error
                .map(io::Error::from_raw_os_error)
                .unwrap_or_else(|| io::Error::from(kind))),
            Err(RecvTimeoutError::Timeout) => Err(io::Error::from(io::ErrorKind::WouldBlock)),
            Err(RecvTimeoutError::Disconnected) => Err(io::Error::from(io::ErrorKind::BrokenPipe)),
        }
    }
}

struct WindowsOwnershipGuard {
    // The Job handle must outlive the process handle. Its KILL_ON_JOB_CLOSE flag guarantees that a
    // controller crash cannot leave browser descendants outside the supervisor's ownership domain.
    process: OwnedHandle,
    job: OwnedHandle,
}

impl OwnershipGuard for WindowsOwnershipGuard {}

impl Drop for WindowsOwnershipGuard {
    fn drop(&mut self) {
        let _ = self.process.raw();
        let _ = self.job.raw();
    }
}

#[derive(Debug, Default)]
pub(super) struct WindowsProcessInspector;

impl ProcessInspector for WindowsProcessInspector {
    fn inspect_process(&self, pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
        if pid == 0 {
            return Err(SupervisorError::InspectionFailed);
        }
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return match unsafe { GetLastError() } {
                ERROR_INVALID_PARAMETER => Ok(None),
                _ => Err(SupervisorError::InspectionFailed),
            };
        }
        let handle = OwnedHandle::new(handle)?;
        process_identity_from_handle(pid, handle.raw()).map(Some)
    }

    fn ownership_domain_alive(
        &self,
        ownership_domain: &OwnershipDomain,
    ) -> Result<bool, SupervisorError> {
        let OwnershipDomain::WindowsJob { name } = ownership_domain else {
            return Err(SupervisorError::OwnershipDomainMismatch);
        };
        let name = wide_nul(OsStr::new(name));
        let handle = unsafe { OpenJobObjectW(JOB_OBJECT_QUERY_ACCESS, 0, name.as_ptr()) };
        if handle.is_null() {
            return match unsafe { GetLastError() } {
                ERROR_FILE_NOT_FOUND => Ok(false),
                _ => Err(SupervisorError::InspectionFailed),
            };
        }
        let handle = OwnedHandle::new(handle)?;
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let queried = unsafe {
            QueryInformationJobObject(
                handle.raw(),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        };
        if queried == 0 {
            return Err(SupervisorError::InspectionFailed);
        }
        Ok(accounting.ActiveProcesses > 0)
    }

    fn terminate_ownership_domain(
        &self,
        ownership_domain: &OwnershipDomain,
    ) -> Result<(), SupervisorError> {
        let OwnershipDomain::WindowsJob { name } = ownership_domain else {
            return Err(SupervisorError::OwnershipDomainMismatch);
        };
        let name = wide_nul(OsStr::new(name));
        let handle = unsafe {
            OpenJobObjectW(
                JOB_OBJECT_QUERY_ACCESS | JOB_OBJECT_TERMINATE_ACCESS,
                0,
                name.as_ptr(),
            )
        };
        if handle.is_null() {
            return match unsafe { GetLastError() } {
                ERROR_FILE_NOT_FOUND => Ok(()),
                _ => Err(SupervisorError::InspectionFailed),
            };
        }
        let handle = OwnedHandle::new(handle)?;
        if unsafe { TerminateJobObject(handle.raw(), 1) } == 0 {
            return Err(SupervisorError::InspectionFailed);
        }
        Ok(())
    }
}

struct PrivatePipeSet {
    child_read: OwnedHandle,
    parent_write: OwnedHandle,
    parent_read: OwnedHandle,
    child_write: OwnedHandle,
}

impl PrivatePipeSet {
    fn create() -> Result<Self, SupervisorError> {
        let mut security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        let (child_read, parent_write) = create_pipe(&mut security)?;
        let (parent_read, child_write) = create_pipe(&mut security)?;
        for parent in [&parent_write, &parent_read] {
            if unsafe { SetHandleInformation(parent.raw(), HANDLE_FLAG_INHERIT, 0) } == 0 {
                return Err(SupervisorError::LaunchFailed);
            }
        }
        Ok(Self {
            child_read,
            parent_write,
            parent_read,
            child_write,
        })
    }
}

fn create_pipe(
    security: &mut SECURITY_ATTRIBUTES,
) -> Result<(OwnedHandle, OwnedHandle), SupervisorError> {
    let mut read = null_mut();
    let mut write = null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, security, 0) } == 0 {
        return Err(SupervisorError::LaunchFailed);
    }
    Ok((OwnedHandle::new(read)?, OwnedHandle::new(write)?))
}

struct ProcThreadAttributes {
    storage: Vec<usize>,
    initialized: bool,
}

impl ProcThreadAttributes {
    fn with_handle_list(handles: &[HANDLE; 2]) -> Result<Self, SupervisorError> {
        let mut bytes = 0_usize;
        unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes) };
        if bytes == 0 {
            return Err(SupervisorError::LaunchFailed);
        }
        let mut attributes = Self {
            storage: vec![0_usize; bytes.div_ceil(size_of::<usize>())],
            initialized: false,
        };
        if unsafe { InitializeProcThreadAttributeList(attributes.as_mut_ptr(), 1, 0, &mut bytes) }
            == 0
        {
            return Err(SupervisorError::LaunchFailed);
        }
        attributes.initialized = true;
        if unsafe {
            UpdateProcThreadAttribute(
                attributes.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                size_of_val(handles),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(SupervisorError::LaunchFailed);
        }
        Ok(attributes)
    }

    fn as_mut_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }
}

impl Drop for ProcThreadAttributes {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { DeleteProcThreadAttributeList(self.as_mut_ptr()) };
        }
    }
}

struct OwnedHandle(HANDLE);

unsafe impl Send for OwnedHandle {}

impl OwnedHandle {
    fn new(handle: HANDLE) -> Result<Self, SupervisorError> {
        if handle.is_null() || handle == (-1_isize as HANDLE) {
            return Err(SupervisorError::LaunchFailed);
        }
        Ok(Self(handle))
    }

    fn raw(&self) -> HANDLE {
        self.0
    }

    fn into_raw(mut self) -> HANDLE {
        let handle = self.0;
        self.0 = null_mut();
        handle
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
        }
    }
}

fn process_identity_from_handle(
    pid: u32,
    process: HANDLE,
) -> Result<ProcessIdentity, SupervisorError> {
    let mut creation: FILETIME = unsafe { zeroed() };
    let mut exit: FILETIME = unsafe { zeroed() };
    let mut kernel: FILETIME = unsafe { zeroed() };
    let mut user: FILETIME = unsafe { zeroed() };
    if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(SupervisorError::InspectionFailed);
    }
    let mut path = vec![0_u16; 32_768];
    let mut length = path.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length) } == 0 {
        return Err(SupervisorError::InspectionFailed);
    }
    path.truncate(length as usize);
    let executable = PathBuf::from(OsString::from_wide(&path))
        .canonicalize()
        .map_err(|_| SupervisorError::InspectionFailed)?;
    let creation_ticks = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
    Ok(ProcessIdentity {
        pid,
        birth_token: format!("windows:{creation_ticks}"),
        executable,
    })
}

fn wide_nul(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn build_command_line(executable: &OsStr, arguments: &[OsString]) -> Vec<u16> {
    let mut command = Vec::new();
    append_quoted(&mut command, executable);
    for argument in arguments {
        command.push(b' ' as u16);
        append_quoted(&mut command, argument);
    }
    command.push(0);
    command
}

fn append_quoted(command: &mut Vec<u16>, argument: &OsStr) {
    command.push(b'"' as u16);
    let units = argument.encode_wide().collect::<Vec<_>>();
    let mut backslashes = 0_usize;
    for unit in units {
        if unit == b'\\' as u16 {
            backslashes += 1;
            continue;
        }
        if unit == b'"' as u16 {
            command.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
        } else {
            command.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
        }
        backslashes = 0;
        command.push(unit);
    }
    command.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
    command.push(b'"' as u16);
}

#[cfg(test)]
mod private_pipe_timeout_tests {
    use super::*;
    use crate::browser::runtime::smoke::{PrivatePipeAdapter, SmokeErrorCode};
    use std::io::{Read, Write};
    use std::time::Instant;

    fn reader_and_writer() -> (PumpedPipeReader, File) {
        let mut security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 0,
        };
        let (read, write) = create_pipe(&mut security).expect("private pipe pair");
        let reader =
            PumpedPipeReader::spawn(unsafe { File::from_raw_handle(read.into_raw().cast()) })
                .expect("reader pump");
        let writer = unsafe { File::from_raw_handle(write.into_raw().cast()) };
        (reader, writer)
    }

    #[test]
    fn private_pipe_reader_yields_for_protocol_deadline_checks() {
        let (mut reader, _writer) = reader_and_writer();
        let started = Instant::now();
        let error = reader
            .read(&mut [0_u8; 1])
            .expect_err("an idle private pipe must not block forever");

        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        assert!(started.elapsed() >= PRIVATE_PIPE_READ_SLICE);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn private_pipe_reader_preserves_available_bytes() {
        let (mut reader, mut writer) = reader_and_writer();
        writer.write_all(b"ok").expect("write fixture");
        let mut bytes = [0_u8; 4];
        let read = reader.read(&mut bytes).expect("read available bytes");
        assert_eq!(&bytes[..read], b"ok");
    }

    #[test]
    fn silent_private_pipe_cannot_defeat_installation_smoke_deadline() {
        let (reader, _writer) = reader_and_writer();
        let mut adapter =
            PrivatePipeAdapter::new(reader, Vec::<u8>::new(), Duration::from_millis(50));
        let started = Instant::now();

        let error = adapter
            .run_installation_smoke("150.0.7871.115")
            .expect_err("silent pipe must reach protocol deadline");

        assert_eq!(error.code, SmokeErrorCode::TimedOut);
        assert!(started.elapsed() < Duration::from_millis(500));
    }
}
