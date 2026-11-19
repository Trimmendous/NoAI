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
