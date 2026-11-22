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

/// Holds the computer awake until dropped or until the watched process exits.
/// It wraps the OS helper process (caffeinate / systemd-inhibit).
pub struct KeepAwake(std::process::Child);

impl Drop for KeepAwake {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Starts a helper that keeps the machine awake; `None` if it isn't installed.
pub fn spawn_keep_awake(program: &str, args: &[String]) -> Option<KeepAwake> {
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
        .map(KeepAwake)
}

/// Where Noai's one sudoers rule lives. It allows only the wake commands.
pub const SUDOERS_FILE: &str = "/etc/sudoers.d/noai-wake";

/// The login name, checked to be safe to write into a sudoers rule.
pub fn user_name() -> Option<String> {
    let valid = |name: &str| {
        !name.is_empty()
            && name.len() <= 64
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    if let Ok(name) = std::env::var("USER") {
        if valid(&name) {
            return Some(name);
        }
    }
    // SAFETY: getpwuid returns a pointer to static storage or null; it is read
    // immediately and not kept.
    unsafe {
        let entry = libc::getpwuid(libc::getuid());
        if entry.is_null() {
            return None;
        }
        let name = std::ffi::CStr::from_ptr((*entry).pw_name)
            .to_string_lossy()
            .into_owned();
        valid(&name).then_some(name)
    }
}

/// True when `sudo` allows `args` without asking for a password.
pub fn sudo_allows(args: &[&str]) -> bool {
    Command::new("/usr/bin/sudo")
        .arg("-n")
        .arg("-l")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Runs `args` through `sudo -n`, which fails instead of prompting.
pub fn sudo_run(args: &[&str]) -> Result<(), String> {
    let output = Command::new("/usr/bin/sudo")
        .arg("-n")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("Cannot run sudo: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

/// A root shell script that checks `rule` with visudo, then installs it as
/// Noai's sudoers file. A rule that fails the check is never installed.
pub fn install_rule_script(rule: &str, group: &str) -> Result<String, String> {
    if rule.contains('\'') || rule.contains('\n') {
        return Err("Unexpected characters in the sudoers rule".into());
    }
    Ok(format!(
        "tmp=$(mktemp) && printf '%s\\n' '{rule}' > \"$tmp\" && visudo -cf \"$tmp\" >/dev/null && install -m 0440 -o root -g {group} \"$tmp\" {SUDOERS_FILE}; status=$?; rm -f \"$tmp\"; exit $status"
    ))
}

pub fn remove_rule_script() -> String {
    format!("rm -f {SUDOERS_FILE}")
}

#[cfg(test)]
mod wake_tests {
    use super::*;

    #[test]
    fn sudoers_script_checks_the_rule_before_installing_it() {
        let script = install_rule_script(
            "me ALL=(root) NOPASSWD: /usr/bin/pmset schedule wake *",
            "wheel",
        )
        .unwrap();
        let check = script.find("visudo -cf").unwrap();
        let install = script.find("install -m 0440").unwrap();
        assert!(check < install && script.contains(SUDOERS_FILE));
        assert!(install_rule_script("me' ALL", "wheel").is_err());
    }
}
