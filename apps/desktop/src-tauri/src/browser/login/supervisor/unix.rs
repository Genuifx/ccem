#![cfg(unix)]

use super::model::{
    LaunchedRuntime, OwnershipDomain, OwnershipGuard, PlatformLaunchRequest, PrivateCdpTransport,
    ProcessIdentity, ProcessInspector, RuntimeLauncher, SupervisorError, TransportKind,
};
#[cfg(target_os = "linux")]
use std::fs;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

const PRIVATE_PIPE_READ_SLICE: Duration = Duration::from_millis(100);

#[derive(Debug, Default)]
pub(super) struct UnixRuntimeLauncher;

impl RuntimeLauncher for UnixRuntimeLauncher {
    fn launch(&self, request: PlatformLaunchRequest) -> Result<LaunchedRuntime, SupervisorError> {
        request.executable.verify_unchanged()?;
        let (parent_command, child_command) =
            UnixStream::pair().map_err(|_| SupervisorError::LaunchFailed)?;
        let (child_response, parent_response) =
            UnixStream::pair().map_err(|_| SupervisorError::LaunchFailed)?;
        let child_command_fd = duplicate_fd_above_reserved(child_command.as_raw_fd())?;
        let child_response_fd = duplicate_fd_above_reserved(child_response.as_raw_fd())?;
        parent_command
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|_| SupervisorError::TransportFailed)?;
        configure_private_pipe_reader(&parent_response)?;

        let mut command = Command::new(request.executable.executable());
        command
            .args(&request.arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let command_fd = child_command_fd.as_raw_fd();
        let response_fd = child_response_fd.as_raw_fd();
        // SAFETY: the closure contains only async-signal-safe libc operations. Source descriptors
        // are duplicated above stdio and Chromium's reserved FD 3/4 pair before pre_exec.
        unsafe {
            command.pre_exec(move || {
                if libc::setpgid(0, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::dup2(command_fd, 3) == -1 || libc::dup2(response_fd, 4) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                libc::close(command_fd);
                libc::close(response_fd);
                Ok(())
            });
        }

        let mut child = command.spawn().map_err(|_| SupervisorError::LaunchFailed)?;
        drop(command);
        drop(child_command);
        drop(child_response);
        drop(child_command_fd);
        drop(child_response_fd);

        let pid = child.id();
        let pgid = unsafe { libc::getpgid(pid as libc::pid_t) };
        if pgid != pid as libc::pid_t {
            let _ = child.kill();
            let _ = child.wait();
            return Err(SupervisorError::OwnershipDomainMismatch);
        }
        let inspector = UnixProcessInspector;
        let identity = match inspector.inspect_process(pid) {
            Ok(Some(identity))
                if identity.executable == request.executable.executable().to_path_buf() =>
            {
                identity
            }
            Ok(_) | Err(_) => {
                let _ = signal_process_group(pid as i32, libc::SIGKILL);
                let _ = child.wait();
                return Err(SupervisorError::ProcessIdentityMismatch);
            }
        };
        Ok(LaunchedRuntime {
            identity,
            ownership_domain: OwnershipDomain::UnixProcessGroup { pgid: pid as i32 },
            transport_kind: TransportKind::UnixPrivateFd3Fd4,
            transport: PrivateCdpTransport::new(parent_response, parent_command),
            guard: Box::new(UnixOwnershipGuard { child }),
        })
    }
}

struct UnixOwnershipGuard {
    child: Child,
}

impl OwnershipGuard for UnixOwnershipGuard {
    fn reap_leader_if_exited(&mut self) {
        let _ = self.child.try_wait();
    }
}

impl Drop for UnixOwnershipGuard {
    fn drop(&mut self) {
        // The supervisor has already proved the whole process group gone before dropping this
        // guard. Reap the leader if it has become a zombie; never target an unrelated PID here.
        let _ = self.child.try_wait();
    }
}

#[derive(Debug, Default)]
pub(super) struct UnixProcessInspector;

impl ProcessInspector for UnixProcessInspector {
    fn inspect_process(&self, pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
        if pid == 0 || pid > i32::MAX as u32 {
            return Err(SupervisorError::InspectionFailed);
        }
        inspect_process_platform(pid)
    }

    fn ownership_domain_alive(
        &self,
        ownership_domain: &OwnershipDomain,
    ) -> Result<bool, SupervisorError> {
        let OwnershipDomain::UnixProcessGroup { pgid } = ownership_domain else {
            return Err(SupervisorError::OwnershipDomainMismatch);
        };
        if *pgid <= 0 {
            return Err(SupervisorError::OwnershipDomainMismatch);
        }
        let result = unsafe { libc::kill(-*pgid, 0) };
        if result == 0 {
            return Ok(true);
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ESRCH) => Ok(false),
            Some(libc::EPERM) => Ok(true),
            _ => Err(SupervisorError::InspectionFailed),
        }
    }

    fn terminate_ownership_domain(
        &self,
        ownership_domain: &OwnershipDomain,
    ) -> Result<(), SupervisorError> {
        let OwnershipDomain::UnixProcessGroup { pgid } = ownership_domain else {
            return Err(SupervisorError::OwnershipDomainMismatch);
        };
        signal_process_group(*pgid, libc::SIGKILL)
    }
}

fn duplicate_fd_above_reserved(fd: RawFd) -> Result<OwnedFd, SupervisorError> {
    let duplicated = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
    if duplicated == -1 {
        return Err(SupervisorError::LaunchFailed);
    }
    Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
}

fn signal_process_group(pgid: i32, signal: i32) -> Result<(), SupervisorError> {
    if pgid <= 0 {
        return Err(SupervisorError::OwnershipDomainMismatch);
    }
    let result = unsafe { libc::kill(-pgid, signal) };
    if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(SupervisorError::InspectionFailed)
    }
}

fn configure_private_pipe_reader(reader: &UnixStream) -> Result<(), SupervisorError> {
    reader
        .set_read_timeout(Some(PRIVATE_PIPE_READ_SLICE))
        .map_err(|_| SupervisorError::TransportFailed)
}

#[cfg(test)]
mod private_pipe_timeout_tests {
    use super::*;
    use std::io::Read;
    use std::time::{Duration, Instant};

    #[test]
    fn private_pipe_reader_yields_for_protocol_deadline_checks() {
        let (mut reader, _writer) = UnixStream::pair().expect("private pipe pair");
        configure_private_pipe_reader(&reader).expect("configure bounded reader");

        let started = Instant::now();
        let error = reader
            .read(&mut [0_u8; 1])
            .expect_err("an idle private pipe must not block forever");

        assert!(matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ));
        assert!(started.elapsed() >= PRIVATE_PIPE_READ_SLICE);
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}

#[cfg(target_os = "macos")]
fn inspect_process_platform(pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
    use std::mem::{size_of, zeroed};
    let mut info: libc::proc_bsdinfo = unsafe { zeroed() };
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    if read != size_of::<libc::proc_bsdinfo>() as i32 {
        return if process_absent(pid) {
            Ok(None)
        } else {
            Err(SupervisorError::InspectionFailed)
        };
    }
    let mut path = vec![0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let path_length =
        unsafe { libc::proc_pidpath(pid as i32, path.as_mut_ptr().cast(), path.len() as u32) };
    if path_length <= 0 {
        return if process_absent(pid) {
            Ok(None)
        } else {
            Err(SupervisorError::InspectionFailed)
        };
    }
    path.truncate(path_length as usize);
    let executable = PathBuf::from(std::ffi::OsString::from_vec(path))
        .canonicalize()
        .map_err(|_| SupervisorError::InspectionFailed)?;
    Ok(Some(ProcessIdentity {
        pid,
        birth_token: format!("mac:{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
        executable,
    }))
}

#[cfg(target_os = "macos")]
use std::os::unix::ffi::OsStringExt;

#[cfg(target_os = "linux")]
fn inspect_process_platform(pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
    let stat = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) if process_absent(pid) => return Ok(None),
        Err(_) => return Err(SupervisorError::InspectionFailed),
    };
    let fields = stat
        .rsplit_once(") ")
        .ok_or(SupervisorError::InspectionFailed)?
        .1
        .split_ascii_whitespace()
        .collect::<Vec<_>>();
    // The remainder starts at proc field 3 (state), making starttime field 22 index 19.
    let start_time = fields.get(19).ok_or(SupervisorError::InspectionFailed)?;
    let executable = match fs::read_link(format!("/proc/{pid}/exe")) {
        Ok(path) => path
            .canonicalize()
            .map_err(|_| SupervisorError::InspectionFailed)?,
        Err(_) if process_absent(pid) => return Ok(None),
        Err(_) => return Err(SupervisorError::InspectionFailed),
    };
    Ok(Some(ProcessIdentity {
        pid,
        birth_token: format!("linux:{start_time}"),
        executable,
    }))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn inspect_process_platform(_pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
    Err(SupervisorError::UnsupportedPlatform)
}

fn process_absent(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Instant;

    struct ProcessTree {
        pgid: i32,
        leader: Option<Child>,
        member: Option<Child>,
    }

    impl Drop for ProcessTree {
        fn drop(&mut self) {
            let _ = signal_process_group(self.pgid, libc::SIGKILL);
            for child in [&mut self.leader, &mut self.member] {
                if let Some(mut child) = child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    }

    #[test]
    fn exact_process_group_cleanup_kills_children_after_the_leader_is_reaped() {
        let mut leader_command = Command::new("/bin/sh");
        leader_command
            .args(["-c", "exec sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            leader_command.pre_exec(|| {
                if libc::setpgid(0, 0) == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let leader = leader_command.spawn().expect("spawn process-group leader");
        let pgid = leader.id() as i32;

        let mut member_command = Command::new("/bin/sh");
        member_command
            .args(["-c", "exec sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            member_command.pre_exec(move || {
                if libc::setpgid(0, pgid) == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let member = member_command.spawn().expect("spawn owned group member");
        let mut tree = ProcessTree {
            pgid,
            leader: Some(leader),
            member: Some(member),
        };
        assert_eq!(
            unsafe { libc::getpgid(tree.member.as_ref().unwrap().id() as i32) },
            pgid
        );

        assert_eq!(unsafe { libc::kill(pgid, libc::SIGKILL) }, 0);
        tree.leader
            .as_mut()
            .unwrap()
            .wait()
            .expect("reap process-group leader");
        tree.leader.take();

        let inspector = UnixProcessInspector;
        let domain = OwnershipDomain::UnixProcessGroup { pgid };
        assert!(inspector.inspect_process(pgid as u32).unwrap().is_none());
        assert!(inspector.ownership_domain_alive(&domain).unwrap());

        inspector
            .terminate_ownership_domain(&domain)
            .expect("terminate exact orphaned process group");
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if tree.member.as_mut().unwrap().try_wait().unwrap().is_some() {
                tree.member.take();
                break;
            }
            assert!(Instant::now() < deadline, "owned group member did not exit");
            thread::sleep(Duration::from_millis(10));
        }
        let domain_deadline = Instant::now() + Duration::from_secs(2);
        while inspector.ownership_domain_alive(&domain).unwrap() {
            assert!(
                Instant::now() < domain_deadline,
                "owned process group stayed observable after every child was reaped"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}
