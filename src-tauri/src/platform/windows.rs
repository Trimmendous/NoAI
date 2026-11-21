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
