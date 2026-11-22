//! Linux (and other non-macOS Unix): XDG data, systemd user service.
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

pub fn data_dir(home: &Path) -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"))
        .join("dev.noai.desktop")
}

pub fn extra_executable_dirs(home: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        home.join(".local/share/pnpm"),
        PathBuf::from("/home/linuxbrew/.linuxbrew/bin"),
        home.join(".linuxbrew/bin"),
        PathBuf::from("/snap/bin"),
        PathBuf::from("/var/lib/flatpak/exports/bin"),
        home.join(".local/share/flatpak/exports/bin"),
    ]
}

pub fn executable_names(name: &str) -> Vec<String> {
    vec![name.to_owned()]
}

/// Ask an installed systemd user service to start. Missing units are ignored.
pub fn start_user_service() {
    let _ = Command::new("systemctl")
        .args(["--user", "start", "noai.service"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// systemd sets INVOCATION_ID for every unit it starts.
pub fn managed_by_service() -> bool {
    std::env::var_os("INVOCATION_ID").is_some()
}

/// Opens a web link in the user's default browser.
pub fn open_url(url: &str) -> std::io::Result<()> {
    Command::new("xdg-open")
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
pub const WAKE_DETAIL: &str = "Noai sets the computer's wake alarm (rtcwake) for a minute before the next job. Turning this on asks for your password once, so Noai can set the alarm by itself afterwards.";
static LAST_WAKE: std::sync::Mutex<Option<u64>> = std::sync::Mutex::new(None);

/// The only command Noai's sudoers rule allows. It accepts just
/// `set <unix time>` or `clear`.
const WAKE_HELPER: &str = "/usr/local/libexec/noai-wake";

fn wake_helper_body(rtcwake: &str) -> String {
    format!(
        r#"#!/bin/sh
# Noai wake helper: sets or clears the RTC wake alarm. Installed by Noai;
# its sudoers rule (/etc/sudoers.d/noai-wake) allows only this file.
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
case "$1" in
  set)
    [ "$#" -eq 2 ] || exit 64
    case "$2" in ""|*[!0-9]*) exit 64 ;; esac
    [ "${{#2}}" -le 12 ] || exit 64
    exec {rtcwake} -m no -t "$2" ;;
  clear)
    [ "$#" -eq 1 ] || exit 64
    exec {rtcwake} -m disable ;;
  *) exit 64 ;;
esac"#
    )
}

fn rtcwake() -> Option<&'static str> {
    ["/usr/sbin/rtcwake", "/sbin/rtcwake", "/usr/bin/rtcwake"]
        .into_iter()
        .find(|path| Path::new(path).exists())
}

/// systemd-inhibit blocks idle and sleep while a small shell loop waits for the
/// agent to exit. Without systemd there is nothing to hold, so no guard.
pub fn keep_awake(pid: u32) -> Option<KeepAwake> {
    if pid == 0 {
        return None;
    }
    super::unix::spawn_keep_awake(
        "systemd-inhibit",
        &[
            "--what=idle:sleep".into(),
            "--who=Noai".into(),
            "--why=A Noai job is running".into(),
            "--mode=block".into(),
            "/bin/sh".into(),
            "-c".into(),
            format!("while kill -0 {pid} 2>/dev/null; do sleep 10; done"),
        ],
    )
}

pub fn wake_enabled() -> bool {
    Path::new(WAKE_HELPER).exists() && sudo_allows(&[WAKE_HELPER, "clear"])
}

/// Sets the RTC alarm for `at`, or clears it. There is one alarm, so a new
/// time simply replaces the old one.
pub fn set_wake(at: Option<u64>) -> Result<(), String> {
    let mut last = LAST_WAKE.lock().unwrap();
    if *last == at {
        return Ok(());
    }
    match at {
        Some(at) => sudo_run(&[WAKE_HELPER, "set", &at.to_string()])?,
        None => sudo_run(&[WAKE_HELPER, "clear"])?,
    }
    *last = at;
    Ok(())
}

/// Runs a root shell command after the desktop's polkit password prompt.
fn as_admin(script: &str) -> Result<(), String> {
    let output = Command::new("pkexec")
        .args(["/bin/sh", "-c", script])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("Cannot ask for admin approval (pkexec): {error}"))?;
    match output.status.code() {
        Some(0) => Ok(()),
        Some(126) => Err("Cancelled.".into()),
        _ => Err(String::from_utf8_lossy(&output.stderr).trim().to_owned()),
    }
}

/// One admin prompt installs the wake helper and a sudoers rule allowing only
/// that helper for this user. It also replaces the older, wildcard rtcwake rule.
pub fn enable_wake() -> Result<(), String> {
    let path = rtcwake().ok_or("rtcwake isn't installed (it's in util-linux)")?;
    let user = user_name().ok_or("Cannot tell which user you are")?;
    let rule = wake_rule(&user, WAKE_HELPER);
    as_admin(&install_wake_script(
        WAKE_HELPER,
        &wake_helper_body(path),
        &rule,
        "root",
    )?)?;
    if wake_enabled() {
        Ok(())
    } else {
        Err("The permission was saved, but sudo isn't reading /etc/sudoers.d.".into())
    }
}

pub fn disable_wake() -> Result<(), String> {
    let _ = set_wake(None);
    as_admin(&remove_wake_script(WAKE_HELPER))
}

/// The desktop's notification service, through notify-send (libnotify).
pub fn notify(title: &str, body: &str) {
    let _ = Command::new("notify-send")
        .args(["--app-name=Noai", title, body])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// With echo standing in for rtcwake, the helper passes on only the two
    /// fixed forms and refuses extra flags such as a second `-m off`.
    #[test]
    fn wake_helper_passes_only_fixed_forms() {
        let body = wake_helper_body("/bin/echo");
        let run = |args: &[&str]| {
            Command::new("/bin/sh")
                .args(["-c", &body, "noai-wake"])
                .args(args)
                .output()
                .unwrap()
        };
        let set = run(&["set", "1700000000"]);
        assert_eq!(
            String::from_utf8_lossy(&set.stdout),
            "-m no -t 1700000000\n"
        );
        assert_eq!(
            String::from_utf8_lossy(&run(&["clear"]).stdout),
            "-m disable\n"
        );
        for args in [
            &["set", "1", "-m", "off"][..],
            &["set", "1 -m off"],
            &["clear", "-m", "off"],
            &["set"],
            &["off"],
        ] {
            assert_eq!(
                run(args).status.code(),
                Some(64),
                "{args:?} was not refused"
            );
        }
    }
}
