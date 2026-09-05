//! macOS has no Job Object: Codex tools can enter a different process group.
//! Capture and quiesce the exact helper lineage BEFORE writing Stop/aborting
//! the SDK. Never infer ownership from a process name or a recycled PID/PGID.
use std::collections::HashSet;
use std::io;
use std::mem::{size_of, zeroed};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Process {
    pid: i32,
    unique: u64,
    parent_unique: u64,
    birth: (u64, u64),
    status: u32,
}

// Apple XNU proc_info.h PROC_PIDUNIQIDENTIFIERINFO. Unlike PPID, the
// original parent's unique ID remains unchanged when a process is reparented.
#[repr(C)]
struct UniqueInfo {
    uuid: [u8; 16],
    unique: u64,
    parent_unique: u64,
    version: i32,
    reserved2: u32,
    reserved3: u64,
    reserved4: u64,
}

fn inspect(pid: i32) -> Result<Option<Process>, String> {
    if pid <= 1 {
        return Ok(None);
    }
    let mut bsd: libc::proc_bsdinfo = unsafe { zeroed() };
    let count = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut bsd as *mut libc::proc_bsdinfo).cast(),
            size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    if count != size_of::<libc::proc_bsdinfo>() as i32 {
        // proc_pidinfo excludes zombies; kill(pid, 0) can still succeed for
        // them until their parent reaps them. ESRCH here means no live task.
        if io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        if unsafe { libc::kill(pid, 0) } == -1
            && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            return Ok(None);
        }
        return Err(format!("Cannot inspect native execution process {pid}"));
    }
    if bsd.pbi_uid != unsafe { libc::geteuid() } {
        return Ok(None);
    }
    let mut unique: UniqueInfo = unsafe { zeroed() };
    let count = unsafe {
        libc::proc_pidinfo(
            pid,
            17,
            0,
            (&mut unique as *mut UniqueInfo).cast(),
            size_of::<UniqueInfo>() as i32,
        )
    };
    if count != size_of::<UniqueInfo>() as i32 {
        if io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        if unsafe { libc::kill(pid, 0) } == -1
            && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            return Ok(None);
        }
        return Err(format!("Cannot identify native execution process {pid}"));
    }
    Ok(Some(Process {
        pid,
        unique: unique.unique,
        parent_unique: unique.parent_unique,
        birth: (bsd.pbi_start_tvsec, bsd.pbi_start_tvusec),
        status: bsd.pbi_status,
    }))
}

fn same_process(a: &Process, b: &Process) -> bool {
    a.pid == b.pid && a.unique == b.unique && a.birth == b.birth
}

fn signal(process: &Process, signal: i32) -> Result<(), String> {
    let Some(current) = inspect(process.pid)? else {
        return Ok(());
    };
    if !same_process(process, &current) || current.status == 5 {
        return Ok(());
    }
    #[cfg(test)]
    tests::injected_signal_error(process, signal)?;
    if unsafe { libc::kill(process.pid, signal) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(format!(
            "Cannot signal owned native execution process {}: {error}",
            process.pid
        ))
    }
}

fn snapshot() -> Result<Vec<Process>, String> {
    // Read same-UID kernel identities only, never argv/environment or names.
    // Enumeration is not authority: only transitive unique-parent membership
    // below can admit a process to the signal set.
    let mut capacity = 256;
    loop {
        let mut pids = vec![0i32; capacity];
        let bytes = unsafe {
            libc::proc_listpids(
                4,
                libc::geteuid(),
                pids.as_mut_ptr().cast(),
                (pids.len() * size_of::<i32>()) as i32,
            )
        };
        if bytes <= 0 {
            return Err("Cannot enumerate native execution identities".into());
        }
        let count = bytes as usize / size_of::<i32>();
        if count == capacity {
            capacity *= 2;
            if capacity > 65536 {
                return Err("Native execution identity inventory is too large".into());
            }
            continue;
        }
        #[cfg(test)]
        tests::after_pid_inventory();
        let mut processes = Vec::new();
        for pid in pids.into_iter().take(count) {
            if let Some(process) = inspect(pid)? {
                processes.push(process);
            }
        }
        return Ok(processes);
    }
}

#[derive(Debug)]
pub(crate) struct NativeExecutionDomain {
    root: Process,
    known: Mutex<HashSet<u64>>,
    operation: Mutex<()>,
}

pub(crate) struct ResumeRoot(Option<Process>);
impl ResumeRoot {
    pub(crate) fn resume(mut self) -> Result<(), String> {
        if let Some(root) = self.0.as_ref() {
            signal(root, libc::SIGCONT)?;
        }
        self.0 = None;
        Ok(())
    }
}
impl Drop for ResumeRoot {
    fn drop(&mut self) {
        if let Some(root) = self.0.take() {
            let _ = signal(&root, libc::SIGCONT);
        }
    }
}

// Roll back only state transitions owned by this operation. In particular,
// a child already stopped before prepare_stop must remain stopped on error.
struct ResumeStopped(Vec<Process>);
impl Drop for ResumeStopped {
    fn drop(&mut self) {
        for process in &self.0 {
            let _ = signal(process, libc::SIGCONT);
        }
    }
}

impl NativeExecutionDomain {
    pub(crate) fn attach(pid: u32) -> Result<Self, String> {
        let root = inspect(pid as i32)?.ok_or("Native execution root disappeared")?;
        Ok(Self {
            known: Mutex::new(HashSet::from([root.unique])),
            root,
            operation: Mutex::new(()),
        })
    }

    fn members(&self) -> Result<Vec<Process>, String> {
        let all = snapshot()?;
        let mut known = self
            .known
            .lock()
            .map_err(|_| "Native execution identity lock poisoned")?;
        loop {
            let before = known.len();
            for process in &all {
                if known.contains(&process.parent_unique) {
                    known.insert(process.unique);
                }
            }
            if before == known.len() {
                break;
            }
        }
        Ok(all
            .into_iter()
            .filter(|p| known.contains(&p.unique))
            .collect())
    }

    pub(crate) fn observe_lineage(&self) -> Result<(), String> {
        self.members().map(drop)
    }

    fn freeze(&self) -> Result<(Vec<Process>, ResumeStopped, ResumeRoot), String> {
        let resume = ResumeRoot(
            inspect(self.root.pid)?.filter(|p| same_process(p, &self.root) && p.status != 4),
        );
        signal(&self.root, libc::SIGSTOP)?;
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut frozen = ResumeStopped(Vec::new());
        let mut stopped_inventory: Option<Vec<Process>> = None;
        loop {
            let members = self.members()?;
            let mut settled = true;
            for process in &members {
                if process.status != 4 && process.status != 5 {
                    settled = false;
                    signal(process, libc::SIGSTOP)?;
                    if !frozen.0.iter().any(|p| same_process(p, process)) {
                        frozen.0.push(process.clone());
                    }
                }
            }
            // PID enumeration and per-PID inspection are not atomic: a parent
            // may fork after enumeration and stop before inspection. Only an
            // additional complete inventory, begun after all observed parents
            // were stopped, can certify that no new child was missed.
            if settled && stopped_inventory.as_ref().is_some_and(|previous| {
                previous.len() == members.len()
                    && previous.iter().all(|p| members.iter().any(|m| same_process(p, m)))
            }) {
                return Ok((members, frozen, resume));
            }
            stopped_inventory = settled.then_some(members);
            if Instant::now() >= deadline {
                return Err("Native execution domain did not quiesce".into());
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn terminate(&self, include_root: bool) -> Result<ResumeRoot, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "Native execution operation lock poisoned")?;
        let (members, mut frozen, mut resume) = self.freeze()?;
        let targets = members
            .into_iter()
            .filter(|p| include_root || p.unique != self.root.unique)
            .collect::<Vec<_>>();
        for process in &targets {
            signal(process, libc::SIGKILL)?;
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let mut live = false;
            for process in &targets {
                if let Some(current) = inspect(process.pid)? {
                    if same_process(process, &current) && current.status != 5 {
                        live = true;
                    }
                }
            }
            if !live {
                break;
            }
            if Instant::now() >= deadline {
                return Err("Owned native tools have not exited".into());
            }
            thread::sleep(Duration::from_millis(5));
        }
        if include_root {
            resume.0 = None;
        }
        frozen.0.clear();
        Ok(resume)
    }

    /// Keep helper frozen until Stop is in its stdin; tools are already dead.
    pub(crate) fn prepare_stop(&self) -> Result<ResumeRoot, String> {
        self.terminate(false)
    }

    pub(crate) fn kill(&self) -> Result<(), String> {
        self.terminate(true).map(drop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};

    use std::cell::RefCell;
    use std::rc::Rc;

    thread_local! {
        static FAIL_KILL: RefCell<Option<Process>> = const { RefCell::new(None) };
        static AFTER_INVENTORY: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
    }

    pub(super) fn injected_signal_error(process: &Process, requested: i32) -> Result<(), String> {
        if requested == libc::SIGKILL && FAIL_KILL.with(|target|
            target.borrow().as_ref().is_some_and(|target| same_process(target, process)))
        {
            Err("Injected EPERM for exact test-owned process".into())
        } else {
            Ok(())
        }
    }

    pub(super) fn after_pid_inventory() {
        let hook = AFTER_INVENTORY.with(|hook| hook.borrow_mut().take());
        if let Some(hook) = hook { hook(); }
    }

    struct ResetHooks;
    impl Drop for ResetHooks {
        fn drop(&mut self) {
            FAIL_KILL.with(|target| *target.borrow_mut() = None);
            AFTER_INVENTORY.with(|hook| *hook.borrow_mut() = None);
        }
    }

    struct OwnedTestTree {
        root: std::process::Child,
        members: Rc<RefCell<Vec<Process>>>,
        files: Vec<std::path::PathBuf>,
    }
    impl OwnedTestTree {
        fn new(root: std::process::Child) -> Self {
            let identity = inspect(root.id() as i32).unwrap().unwrap();
            Self { root, members: Rc::new(RefCell::new(vec![identity])), files: vec![] }
        }
        fn remember(&self, pid: i32) -> Process {
            let identity = inspect(pid).unwrap().unwrap();
            self.members.borrow_mut().push(identity.clone());
            identity
        }
    }
    impl Drop for OwnedTestTree {
        fn drop(&mut self) {
            // A failed assertion must not strand this test's frozen workers.
            FAIL_KILL.with(|target| *target.borrow_mut() = None);
            AFTER_INVENTORY.with(|hook| *hook.borrow_mut() = None);
            for member in self.members.borrow().iter().rev() {
                let _ = signal(member, libc::SIGKILL);
            }
            let _ = self.root.wait();
            for file in &self.files { let _ = std::fs::remove_file(file); }
        }
    }

    fn wait_for_stopped(identity: &Process) {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if inspect(identity.pid).unwrap().is_some_and(|current|
                same_process(identity, &current) && current.status == 4)
            { return; }
            assert!(Instant::now() < deadline, "owned test process did not stop");
            thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn failed_kill_preserves_a_child_stopped_before_the_operation() {
        let root = Command::new("python3").args(["-u", "-c", r#"
import os, sys, signal, time
sys.stdin.readline()
pid = os.fork()
if pid == 0:
    os.setsid()
    os.kill(os.getpid(), signal.SIGSTOP)
    time.sleep(30)
    os._exit(0)
print(pid, flush=True)
sys.stdin.readline()
"#]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut owned = OwnedTestTree::new(root);
        let domain = NativeExecutionDomain::attach(owned.root.id()).unwrap();
        owned.root.stdin.as_mut().unwrap().write_all(b"start\n").unwrap();
        let mut line = String::new();
        BufReader::new(owned.root.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let child = owned.remember(line.trim().parse().unwrap());
        wait_for_stopped(&child);
        let _hooks = ResetHooks;
        FAIL_KILL.with(|target| *target.borrow_mut() = Some(child.clone()));
        let result = domain.prepare_stop();
        FAIL_KILL.with(|target| *target.borrow_mut() = None);
        thread::sleep(Duration::from_millis(30));
        let after = inspect(child.pid).unwrap();
        let root_after = inspect(owned.root.id() as i32).unwrap();
        assert!(result.as_ref().err().is_some_and(|error| error.contains("Injected EPERM")));
        assert!(after.is_some_and(|current| same_process(&child, &current) && current.status == 4),
            "rollback must not resume a child stopped before this operation");
        assert!(root_after.is_some_and(|current| same_process(&domain.root, &current) && current.status != 4),
            "rollback must resume the root stopped by this operation");
    }

    #[test]
    fn stop_catches_tool_forked_after_pid_inventory_before_parent_reports_stopped() {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let fork_file = std::env::temp_dir().join(format!("ccem-domain-{}-{nonce}-fork", std::process::id()));
        let tool_file = std::env::temp_dir().join(format!("ccem-domain-{}-{nonce}-tool", std::process::id()));
        let root = Command::new("python3").args(["-u", "-c", r#"
import os, sys, time, signal
from pathlib import Path
fork_file, tool_file = Path(sys.argv[1]), Path(sys.argv[2])
sys.stdin.readline()
worker = os.fork()
if worker == 0:
    while not fork_file.exists(): time.sleep(0.001)
    tool = os.fork()
    if tool == 0:
        os.setsid()
        os.execl('/bin/sleep', 'sleep', '30')
    tool_file.write_text(str(tool))
    os.kill(os.getpid(), signal.SIGSTOP)
    time.sleep(30)
    os._exit(0)
print(worker, flush=True)
sys.stdin.readline()
"#]).arg(&fork_file).arg(&tool_file).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut owned = OwnedTestTree::new(root);
        owned.files = vec![fork_file.clone(), tool_file.clone()];
        let domain = NativeExecutionDomain::attach(owned.root.id()).unwrap();
        owned.root.stdin.as_mut().unwrap().write_all(b"start\n").unwrap();
        let mut line = String::new();
        BufReader::new(owned.root.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let worker = owned.remember(line.trim().parse().unwrap());
        let late_tool = Rc::new(RefCell::new(None::<Process>));
        let captured_tool = late_tool.clone();
        let members = owned.members.clone();
        let _hooks = ResetHooks;
        AFTER_INVENTORY.with(|hook| *hook.borrow_mut() = Some(Box::new(move || {
            std::fs::write(fork_file, b"fork").unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                if let Ok(pid) = std::fs::read_to_string(&tool_file) {
                    if let Ok(pid) = pid.trim().parse() {
                        let tool = inspect(pid).unwrap().unwrap();
                        members.borrow_mut().push(tool.clone());
                        *captured_tool.borrow_mut() = Some(tool);
                        break;
                    }
                }
                assert!(Instant::now() < deadline, "owned worker did not fork its tool");
                thread::sleep(Duration::from_millis(1));
            }
            wait_for_stopped(&worker);
        })));
        let prepared = domain.prepare_stop();
        let tool = late_tool.borrow().clone().expect("inventory hook must run");
        let tool_survived = inspect(tool.pid).unwrap().is_some_and(|current|
            same_process(&tool, &current) && current.status != 5);
        assert!(prepared.is_ok(), "{:?}", prepared.as_ref().err());
        assert!(!tool_survived, "Stop must catch a child forked after PID enumeration; a single settled inventory is insufficient");
        drop(prepared);
    }

    #[test]
    fn stop_reaps_separate_tool_group_before_helper_ack_and_preserves_sibling() {
        let mut sibling = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut root = Command::new("python3")
            .args([
                "-u",
                "-c",
                r#"
import os, sys, time
sys.stdin.readline()
pid = os.fork()
if pid == 0:
    os.setsid()
    os.execl('/bin/sleep', 'sleep', '30')
print(pid, flush=True)
sys.stdin.readline()
"#,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let domain = NativeExecutionDomain::attach(root.id()).unwrap();
        root.stdin.as_mut().unwrap().write_all(b"start\n").unwrap();
        let mut line = String::new();
        BufReader::new(root.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let tool_pid = line.trim().parse::<i32>().unwrap();
        let tool = inspect(tool_pid).unwrap().unwrap();
        let result = domain.prepare_stop();
        // Always clean test-owned processes even if the assertion fails.
        if result.is_err() {
            let _ = signal(&tool, libc::SIGKILL);
        }
        let tool_alive = inspect(tool_pid)
            .unwrap()
            .is_some_and(|p| same_process(&p, &tool) && p.status != 5);
        let sibling_alive = sibling.try_wait().unwrap().is_none();
        let stop_error = result.as_ref().err().cloned();
        let _ = root.kill();
        let _ = root.wait();
        drop(result);
        let _ = sibling.kill();
        let _ = sibling.wait();
        assert!(stop_error.is_none(), "{stop_error:?}");
        assert!(
            !tool_alive,
            "cross-PGID tool must exit before stop proceeds"
        );
        assert!(sibling_alive, "other runtime/process must survive");
    }

    #[test]
    fn original_parent_identity_retains_owned_orphan_after_root_exit() {
        let mut root = Command::new("python3")
            .args([
                "-u",
                "-c",
                r#"
import os, sys
sys.stdin.readline()
pid = os.fork()
if pid == 0:
    os.setsid()
    os.execl('/bin/sleep', 'sleep', '30')
print(pid, flush=True)
"#,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let domain = NativeExecutionDomain::attach(root.id()).unwrap();
        root.stdin.as_mut().unwrap().write_all(b"start\n").unwrap();
        let mut line = String::new();
        BufReader::new(root.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let pid = line.trim().parse::<i32>().unwrap();
        let tool = inspect(pid).unwrap().unwrap();
        root.wait().unwrap();
        let result = domain.kill();
        let alive = inspect(pid)
            .unwrap()
            .is_some_and(|p| same_process(&p, &tool) && p.status != 5);
        if alive {
            let _ = signal(&tool, libc::SIGKILL);
        }
        result.unwrap();
        assert!(!alive);
    }

    #[test]
    fn reused_pid_and_new_generation_are_not_the_same_execution() {
        let a = Process {
            pid: 9999,
            unique: 11,
            parent_unique: 1,
            birth: (1, 2),
            status: 2,
        };
        let mut b = a.clone();
        b.unique = 12;
        assert!(!same_process(&a, &b));
        b.unique = a.unique;
        b.birth = (2, 2);
        assert!(!same_process(&a, &b));
    }
}
