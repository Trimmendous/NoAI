//! Behaviour shared by macOS and Linux.
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

/// Start a child as its own process-group leader so cancelling a run can kill
/// the agent together with every tool it launched.
pub fn isolate_process_group(command: &mut Command) {
    command.process_group(0);
}

/// Kill a process group created by `isolate_process_group`.
pub fn kill_process_tree(pid: u32) {
    // SAFETY: callers pass the PID of a process-group leader they started.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

/// New files holding agent output or job state are readable by the user only.
pub fn restrict_new_file(options: &mut OpenOptions) {
    options.mode(0o600);
}

pub fn restrict_dir(path: &Path) -> std::io::Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

/// Make a completed rename durable by syncing its directory entry.
pub fn sync_parent_dir(path: &Path) -> std::io::Result<()> {
    match path.parent() {
        Some(parent) => File::open(parent)?.sync_all(),
        None => Ok(()),
    }
}

/// Stable identity used to notice a log file replaced at the same path.
pub fn file_identity(meta: &fs::Metadata) -> u64 {
    meta.ino()
}

pub fn is_executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0)
}

/// Ask the user's login + interactive shell where `name` is, which picks up PATH
/// changes made in ~/.zshrc, ~/.bashrc, version managers, etc. Bounded to 4s.
pub fn login_shell_lookup(name: &str) -> Option<PathBuf> {
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|shell| shell.starts_with('/'))
        .unwrap_or_else(|| "/bin/sh".into());
    let mut command = Command::new(shell);
    command
        .args(["-l", "-i", "-c", &format!("command -v {name}")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    isolate_process_group(&mut command);
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            _ => {
                kill_process_tree(child.id());
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut output = String::new();
    child
        .stdout
        .take()?
        .take(64 * 1024)
        .read_to_string(&mut output)
        .ok()?;
    // Interactive shells may print banners; the answer is the last absolute path.
    output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with('/'))
        .map(PathBuf::from)
}
