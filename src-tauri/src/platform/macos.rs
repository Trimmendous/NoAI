//! macOS: Application Support data, launchd LaunchAgent, Homebrew locations.
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

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
        .args(["kickstart", &format!("gui/{uid}/{}", super::LAUNCHD_LABEL)])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// launchd exports the job label to processes it starts.
pub fn managed_by_service() -> bool {
    std::env::var("XPC_SERVICE_NAME").is_ok_and(|name| name == super::LAUNCHD_LABEL)
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
use super::unix::{install_rule_script, remove_rule_script, sudo_allows, sudo_run, user_name};

pub const WAKE_SUPPORTED: bool = true;
pub const WAKE_DETAIL: &str = "Noai asks macOS to wake this Mac a minute before the next job. Turning this on asks for your admin password once, so Noai can schedule wake-ups (pmset) by itself afterwards. A MacBook with its lid closed and no power may fall back asleep.";
const PMSET: &str = "/usr/bin/pmset";
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

/// pmset takes local time as "MM/dd/yy HH:mm:ss".
fn pmset_time(at: u64) -> Option<String> {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_opt(at as i64, 0)
        .single()
        .map(|time| time.format("%m/%d/%y %H:%M:%S").to_string())
}

pub fn wake_enabled() -> bool {
    sudo_allows(&[PMSET, "schedule", "wake", "01/01/30 00:00:00"])
}

/// Replaces the wake-up Noai scheduled last with one at `at` (or none).
pub fn set_wake(at: Option<u64>) -> Result<(), String> {
    let mut last = LAST_WAKE.lock().unwrap();
    if *last == at {
        return Ok(());
    }
    if let Some(time) = last.take().and_then(pmset_time) {
        let _ = sudo_run(&[PMSET, "schedule", "cancel", "wake", &time]);
    }
    if let Some(at) = at {
        let time = pmset_time(at).ok_or("Invalid wake time")?;
        sudo_run(&[PMSET, "schedule", "wake", &time])?;
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

/// One admin prompt installs a sudoers rule allowing only `pmset schedule
/// wake …` and `pmset schedule cancel wake …` for this user.
pub fn enable_wake() -> Result<(), String> {
    let user = user_name().ok_or("Cannot tell which user you are")?;
    let rule = format!(
        "{user} ALL=(root) NOPASSWD: {PMSET} schedule wake *, {PMSET} schedule cancel wake *"
    );
    as_admin(
        &install_rule_script(&rule, "wheel")?,
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
        &remove_rule_script(),
        "Noai wants to stop waking this Mac for jobs.",
    )
}
