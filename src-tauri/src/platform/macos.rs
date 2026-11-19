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
