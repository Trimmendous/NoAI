//! Windows: %APPDATA% data, taskkill process trees, npm/winget locations.
//! Not yet built in CI; the control socket still needs a named-pipe transport.
use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

pub fn data_dir(home: &Path) -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Roaming"))
        .join("dev.noai.desktop")
}

pub fn extra_executable_dirs(home: &Path) -> Vec<PathBuf> {
    let appdata = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Roaming"));
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Local"));
    vec![
        appdata.join("npm"),
        local.join("Microsoft/WinGet/Links"),
        local.join("Programs/claude"),
        local.join("pnpm"),
        home.join("scoop/shims"),
    ]
}

/// npm installs `.cmd` shims on Windows.
pub fn executable_names(name: &str) -> Vec<String> {
    ["exe", "cmd", "bat"]
        .iter()
        .map(|ext| format!("{name}.{ext}"))
        .collect()
}

pub fn is_executable(_path: &Path) -> bool {
    true
}

pub fn login_shell_lookup(_name: &str) -> Option<PathBuf> {
    None
}

pub fn isolate_process_group(_command: &mut Command) {}

pub fn kill_process_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

pub fn restrict_new_file(_options: &mut OpenOptions) {}

pub fn restrict_dir(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

pub fn sync_parent_dir(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

pub fn file_identity(_meta: &fs::Metadata) -> u64 {
    0
}

pub fn start_user_service() {}

pub fn managed_by_service() -> bool {
    false
}

/// Opens a web link in the user's default browser without going through a shell.
pub fn open_url(url: &str) -> std::io::Result<()> {
    Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(drop)
}

// ---- Sleep and wake ----------------------------------------------------
// Windows needs no admin approval: a thread asks the system to stay awake,
// and a waitable timer with "resume" set wakes the PC when it fires (if the
// power plan allows wake timers).

use std::{
    ffi::c_void,
    sync::{mpsc, Mutex},
    thread,
};

const ES_CONTINUOUS: u32 = 0x8000_0000;
const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
/// Seconds between 1601-01-01 (Windows FILETIME) and 1970-01-01.
const FILETIME_EPOCH: u64 = 11_644_473_600;

#[link(name = "kernel32")]
extern "system" {
    fn SetThreadExecutionState(flags: u32) -> u32;
    fn CreateWaitableTimerW(
        attributes: *const c_void,
        manual_reset: i32,
        name: *const u16,
    ) -> *mut c_void;
    fn SetWaitableTimer(
        timer: *mut c_void,
        due: *const i64,
        period: i32,
        completion: *const c_void,
        argument: *const c_void,
        resume: i32,
    ) -> i32;
    fn CancelWaitableTimer(timer: *mut c_void) -> i32;
    fn CloseHandle(handle: *mut c_void) -> i32;
}

pub const WAKE_SUPPORTED: bool = true;
pub const WAKE_DETAIL: &str = "Noai sets a Windows wake timer for a minute before the next job. Windows only honours it when “Allow wake timers” is on in your power plan.";

/// Keeps the system awake until dropped. The execution state belongs to the
/// thread that set it, so a small thread holds it.
pub struct KeepAwake(Option<mpsc::Sender<()>>);

impl Drop for KeepAwake {
    fn drop(&mut self) {
        // Closing the channel ends the holding thread, which clears the state.
        self.0.take();
    }
}

pub fn keep_awake(_pid: u32) -> Option<KeepAwake> {
    let (stop, wait) = mpsc::channel::<()>();
    thread::Builder::new()
        .name("noai-keep-awake".into())
        .spawn(move || {
            // SAFETY: plain flag call on the current thread; no pointers.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
            let _ = wait.recv();
            // SAFETY: as above; resets this thread's request.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        })
        .ok()?;
    Some(KeepAwake(Some(stop)))
}

fn wake_flag() -> Option<PathBuf> {
    super::app_data_dir()
        .ok()
        .map(|dir| dir.join("wake-for-jobs"))
}

pub fn wake_enabled() -> bool {
    wake_flag().is_some_and(|path| path.exists())
}

/// The pending wake-up: its time and the channel that cancels it.
static WAKE: Mutex<Option<(u64, mpsc::Sender<()>)>> = Mutex::new(None);

pub fn set_wake(at: Option<u64>) -> Result<(), String> {
    let mut current = WAKE.lock().unwrap();
    if current.as_ref().map(|(time, _)| *time) == at {
        return Ok(());
    }
    current.take(); // dropping the sender cancels the old timer
    let Some(at) = at else { return Ok(()) };
    let due = ((at + FILETIME_EPOCH) * 10_000_000) as i64; // positive = absolute UTC
    let (cancel, wait) = mpsc::channel::<()>();
    let (ready, started) = mpsc::channel::<bool>();
    thread::Builder::new()
        .name("noai-wake-timer".into())
        .spawn(move || {
            // SAFETY: the handle is created, used and closed on this thread;
            // `due` outlives the SetWaitableTimer call.
            unsafe {
                let timer = CreateWaitableTimerW(std::ptr::null(), 1, std::ptr::null());
                let armed = !timer.is_null()
                    && SetWaitableTimer(timer, &due, 0, std::ptr::null(), std::ptr::null(), 1) != 0;
                let _ = ready.send(armed);
                if armed {
                    let _ = wait.recv();
                    CancelWaitableTimer(timer);
                }
                if !timer.is_null() {
                    CloseHandle(timer);
                }
            }
        })
        .map_err(|error| error.to_string())?;
    if started.recv().unwrap_or(false) {
        *current = Some((at, cancel));
        Ok(())
    } else {
        Err("Windows refused the wake timer".into())
    }
}

pub fn enable_wake() -> Result<(), String> {
    let path = wake_flag().ok_or("No data folder")?;
    fs::write(path, b"on").map_err(|error| error.to_string())
}

pub fn disable_wake() -> Result<(), String> {
    let _ = set_wake(None);
    match wake_flag() {
        Some(path) if path.exists() => fs::remove_file(path).map_err(|error| error.to_string()),
        _ => Ok(()),
    }
}
