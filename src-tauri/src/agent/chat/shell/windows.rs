//! A shell starts suspended and joins its job before any user code can create descendants.

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::process::Child;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, THREADENTRY32, TH32CS_SNAPTHREAD};
use windows::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

pub(super) struct Job(OwnedHandle);

fn owned(handle: HANDLE) -> OwnedHandle {
    // Every caller transfers a newly created, non-null handle exactly once.
    unsafe { OwnedHandle::from_raw_handle(handle.0) }
}

impl Job {
    pub fn new() -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(None, None) }.map_err(|error| error.to_string())?;
        let job = Self(owned(handle));
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe { SetInformationJobObject(job.handle(), JobObjectExtendedLimitInformation,
            &limits as *const _ as _, std::mem::size_of_val(&limits) as u32) }.map_err(|error| error.to_string())?;
        Ok(job)
    }

    fn handle(&self) -> HANDLE { HANDLE(self.0.as_raw_handle()) }

    pub fn assign_and_resume(&self, child: &Child) -> Result<(), String> {
        unsafe { AssignProcessToJobObject(self.handle(), HANDLE(child.as_raw_handle())) }
            .map_err(|error| format!("Failed to contain the shell process: {error}"))?;
        // std::process::Child does not retain the primary thread handle. Before the suspended
        // process starts, ToolHelp can identify its sole thread without starting an uncontained helper.
        let snapshot = owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }.map_err(|error| error.to_string())?);
        let mut entry = THREADENTRY32 { dwSize: std::mem::size_of::<THREADENTRY32>() as u32, ..Default::default() };
        unsafe { Thread32First(HANDLE(snapshot.as_raw_handle()), &mut entry) }.map_err(|error| error.to_string())?;
        let mut threads = Vec::new();
        loop {
            if entry.th32OwnerProcessID == child.id() { threads.push(entry.th32ThreadID); }
            if unsafe { Thread32Next(HANDLE(snapshot.as_raw_handle()), &mut entry) }.is_err() { break; }
        }
        if threads.len() != 1 { return Err("Could not identify the suspended shell thread".into()); }
        let thread = owned(unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, threads[0]) }.map_err(|error| error.to_string())?);
        let previous = unsafe { ResumeThread(HANDLE(thread.as_raw_handle())) };
        if previous == u32::MAX { return Err(std::io::Error::last_os_error().to_string()); }
        if previous != 1 { return Err("chat_shell_start_uncertain: The shell suspension state changed unexpectedly".into()); }
        Ok(())
    }

    pub fn terminate(&self) { let _ = unsafe { TerminateJobObject(self.handle(), 1) }; }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    use windows::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED, GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    const HELPER: &str = "agent::chat::shell::windows::tests::process_helper";

    fn helper(directory: &std::path::Path, role: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", HELPER, "--ignored", "--nocapture"])
            .env("VLX_JOB_TEST_DIRECTORY", directory).env("VLX_JOB_TEST_ROLE", role)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        command
    }

    fn directory() -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let directory = std::env::temp_dir().join(format!("vlx-job-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn wait_until(mut check: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !check() {
            assert!(Instant::now() < deadline, "Windows process probe exceeded its deadline");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    #[ignore = "invoked only by the bounded Windows Job integration tests"]
    fn process_helper() {
        let directory = std::path::PathBuf::from(std::env::var_os("VLX_JOB_TEST_DIRECTORY").expect("helper directory"));
        let role = std::env::var("VLX_JOB_TEST_ROLE").expect("helper role");
        std::fs::write(directory.join(format!("{role}.started")), std::process::id().to_string()).unwrap();
        if role == "parent" {
            let child = helper(&directory, "descendant").spawn().unwrap();
            std::fs::write(directory.join("descendant.pid"), child.id().to_string()).unwrap();
            wait_until(|| directory.join("descendant.started").exists());
        } else if role == "descendant" {
            std::thread::sleep(Duration::from_secs(30));
        }
    }

    #[test]
    fn suspension_prevents_code_running_before_job_assignment() {
        let directory = directory();
        let job = Job::new().unwrap();
        let mut child = helper(&directory, "suspended").creation_flags(CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(150));
        assert!(!directory.join("suspended.started").exists());
        if let Err(error) = job.assign_and_resume(&child) { let _ = child.kill(); panic!("{error}"); }
        wait_until(|| directory.join("suspended.started").exists());
        wait_until(|| child.try_wait().unwrap().is_some());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn normal_parent_exit_does_not_release_its_descendant_from_the_job() {
        let directory = directory();
        let job = Job::new().unwrap();
        let mut parent = helper(&directory, "parent").creation_flags(CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0).spawn().unwrap();
        if let Err(error) = job.assign_and_resume(&parent) { let _ = parent.kill(); panic!("{error}"); }
        wait_until(|| directory.join("descendant.started").exists());
        let pid: u32 = std::fs::read_to_string(directory.join("descendant.pid")).unwrap().parse().unwrap();
        let handle = owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.unwrap());
        wait_until(|| parent.try_wait().unwrap().is_some());
        let active = || {
            let mut code = 0;
            unsafe { GetExitCodeProcess(HANDLE(handle.as_raw_handle()), &mut code) }.unwrap();
            code == 259
        };
        assert!(active(), "the descendant must outlive its parent before cleanup");
        job.terminate();
        wait_until(|| !active());
        let _ = std::fs::remove_dir_all(directory);
    }
}
