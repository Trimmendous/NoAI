//! macOS: Application Support data, launchd LaunchAgent, Homebrew locations.
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

// Keep in sync with `scripts/service/launchd.mjs`.
const LAUNCHD_LABEL: &str = "dev.noai.daemon";

pub fn data_dir(home: &Path) -> PathBuf {
    home.join("Library/Application Support/dev.noai.desktop")
}

pub fn extra_executable_dirs(home: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        home.join("Library/pnpm"),
        home.join("Library/Application Support/Herd/bin"),
        PathBuf::from("/Applications/Codex.app/Contents/Resources"),
        PathBuf::from("/opt/local/bin"),
    ]
}

pub fn executable_names(name: &str) -> Vec<String> {
    vec![name.to_owned()]
}

/// Ask an installed LaunchAgent to start. Missing agents are ignored.
pub fn start_user_service() {
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    let _ = Command::new("launchctl")
        .args(["kickstart", &format!("gui/{uid}/{LAUNCHD_LABEL}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// launchd exports the job label to processes it starts.
pub fn managed_by_service() -> bool {
    std::env::var("XPC_SERVICE_NAME").is_ok_and(|name| name == LAUNCHD_LABEL)
}

/// Opens a web link in the user's default browser.
pub fn open_url(url: &str) -> std::io::Result<()> {
    Command::new("open")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(drop)
}

// ---- Sleep and wake ----------------------------------------------------

pub use super::unix::KeepAwake;
use super::unix::{
    install_wake_script, remove_wake_script, sudo_allows, sudo_run, user_name, wake_rule,
};

pub const WAKE_SUPPORTED: bool = true;
pub const WAKE_DETAIL: &str = "Noai asks macOS to wake this Mac a minute before the next job. Turning this on asks for your admin password once, so Noai can schedule wake-ups (pmset) by itself afterwards. A MacBook with its lid closed and no power may fall back asleep.";
/// The only command Noai's sudoers rule allows. It lives in a root-owned
/// folder and accepts just `set|cancel <unix time>`.
const WAKE_HELPER: &str = "/Library/PrivilegedHelperTools/dev.noai.wake";
const WAKE_HELPER_BODY: &str = r#"#!/bin/sh
# Noai wake helper: schedules or cancels one pmset wake-up. Installed by Noai;
# its sudoers rule (/etc/sudoers.d/noai-wake) allows only this file.
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
[ "$#" -eq 2 ] || exit 64
case "$2" in ""|*[!0-9]*) exit 64 ;; esac
[ "${#2}" -le 12 ] || exit 64
when=$(date -r "$2" "+%m/%d/%y %H:%M:%S") || exit 65
case "$1" in
  set) exec /usr/bin/pmset schedule wake "$when" ;;
  cancel) exec /usr/bin/pmset schedule cancel wake "$when" ;;
  *) exit 64 ;;
esac"#;
static LAST_WAKE: std::sync::Mutex<Option<u64>> = std::sync::Mutex::new(None);

/// caffeinate holds off idle and system sleep until the agent process exits.
pub fn keep_awake(pid: u32) -> Option<KeepAwake> {
    if pid == 0 {
        return None;
    }
    super::unix::spawn_keep_awake(
        "/usr/bin/caffeinate",
        &["-i".into(), "-s".into(), "-w".into(), pid.to_string()],
    )
}

pub fn wake_enabled() -> bool {
    std::path::Path::new(WAKE_HELPER).exists() && sudo_allows(&[WAKE_HELPER, "set", "1"])
}

/// Replaces the wake-up Noai scheduled last with one at `at` (or none).
pub fn set_wake(at: Option<u64>) -> Result<(), String> {
    let mut last = LAST_WAKE.lock().unwrap();
    if *last == at {
        return Ok(());
    }
    if let Some(previous) = last.take() {
        let _ = sudo_run(&[WAKE_HELPER, "cancel", &previous.to_string()]);
    }
    if let Some(at) = at {
        sudo_run(&[WAKE_HELPER, "set", &at.to_string()])?;
        *last = Some(at);
    }
    Ok(())
}

/// Runs a root shell command after the standard macOS admin password prompt.
fn as_admin(script: &str, prompt: &str) -> Result<(), String> {
    let quote = |text: &str| text.replace('\\', "\\\\").replace('"', "\\\"");
    let output = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(format!(
            "do shell script \"{}\" with prompt \"{}\" with administrator privileges",
            quote(script),
            quote(prompt)
        ))
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("Cannot ask for admin approval: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let message = String::from_utf8_lossy(&output.stderr);
        Err(if message.contains("-128") {
            "Cancelled.".into()
        } else {
            message.trim().to_owned()
        })
    }
}

/// One admin prompt installs the wake helper and a sudoers rule allowing only
/// that helper for this user. It also replaces the older, wildcard pmset rule.
pub fn enable_wake() -> Result<(), String> {
    let user = user_name().ok_or("Cannot tell which user you are")?;
    let rule = wake_rule(&user, WAKE_HELPER);
    as_admin(
        &install_wake_script(WAKE_HELPER, WAKE_HELPER_BODY, &rule, "wheel")?,
        "Noai wants to wake this Mac for scheduled jobs.",
    )?;
    if wake_enabled() {
        Ok(())
    } else {
        Err(
            "The permission was saved, but macOS isn't using it yet. Try again after restarting."
                .into(),
        )
    }
}

pub fn disable_wake() -> Result<(), String> {
    let _ = set_wake(None);
    as_admin(
        &remove_wake_script(WAKE_HELPER),
        "Noai wants to stop waking this Mac for jobs.",
    )
}

/// Notification Center, through AppleScript (no extra permissions needed).
pub fn notify(title: &str, body: &str) {
    let quote = |text: &str| text.replace('\\', "\\\\").replace('"', "\\\"");
    let _ = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(format!(
            "display notification \"{}\" with title \"{}\"",
            quote(body),
            quote(title)
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the helper as the current user. Every case here must be refused
    /// before pmset is reached, so nothing is scheduled.
    #[test]
    fn wake_helper_refuses_anything_but_a_plain_time() {
        let refused = [
            vec!["set"],
            vec!["set", "1", "extra"],
            vec!["set", "1 -a"],
            vec!["set", "-1"],
            vec!["set", ""],
            vec!["set", "1234567890123"],
            vec!["sleep", "1"],
            vec!["poweroff", "now"],
        ];
        for args in refused {
            let status = Command::new("/bin/sh")
                .args(["-c", WAKE_HELPER_BODY, "noai-wake"])
                .args(&args)
                .status()
                .unwrap();
            assert_eq!(status.code(), Some(64), "{args:?} was not refused");
        }
    }
}
