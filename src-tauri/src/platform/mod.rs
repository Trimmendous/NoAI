//! Every OS-specific behaviour lives under this module. Other modules call the
//! functions re-exported here and do not use `cfg(...)` for OS behaviour.
//!
//! Layout:
//! - `unix.rs`    shared by macOS and Linux (process groups, file modes, login shell)
//! - `macos.rs`   data directory, launchd service, Homebrew/app install locations
//! - `linux.rs`   XDG data directory, systemd user service, distro install locations
//! - `windows.rs` %APPDATA% data directory, job-tree kill, npm/winget locations
//!
//! The local control socket (`control.rs`/`ipc.rs`) is still Unix-only; a named-pipe
//! transport is required before the Windows build is usable.

#[cfg(unix)]
mod unix;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as os;

#[cfg(all(unix, not(target_os = "macos")))]
mod linux;
#[cfg(all(unix, not(target_os = "macos")))]
use linux as os;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as os;

#[cfg(unix)]
use unix as family;
#[cfg(windows)]
use windows as family;

pub use family::{
    file_identity, isolate_process_group, kill_process_tree, restrict_dir, restrict_new_file,
    sync_parent_dir,
};
pub use os::{managed_by_service, start_user_service};

/// Opens an http(s) link in the default browser. Anything else is refused.
pub fn open_web_link(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://"))
        || url.len() > 2048
        || url.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("Only web links can be opened".into());
    }
    os::open_url(url).map_err(|error| format!("Could not open the link: {error}"))
}

use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// launchd label for the macOS LaunchAgent written by `noai service install`.
/// Keep in sync with `scripts/service/launchd.mjs`.
pub const LAUNCHD_LABEL: &str = "dev.noai.daemon";

fn home() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The single data directory shared by the daemon, desktop client and CLI.
/// Matches Tauri's `app_data_dir` for `dev.noai.desktop` and `defaultSocketPath`
/// in `bin/noai`. All three must agree or clients cannot find the daemon.
/// `NOAI_DATA_DIR` overrides it for tests and portable installs.
pub fn app_data_dir() -> Result<PathBuf, String> {
    if let Some(dir) = env::var_os("NOAI_DATA_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    let home = home().ok_or("HOME is unavailable")?;
    Ok(os::data_dir(&home))
}

pub fn home_dir() -> Result<PathBuf, String> {
    home().ok_or_else(|| "HOME is unavailable".into())
}

/// Directories where coding-agent CLIs are commonly installed but which a GUI
/// launch (Finder, Dock, desktop launcher, Start menu) often lacks on PATH.
pub fn executable_dirs() -> Vec<PathBuf> {
    let Some(home) = home() else {
        return Vec::new();
    };
    let mut dirs = vec![
        // Claude Code native installer, pipx, uv tool and many curl installers.
        home.join(".local/bin"),
        // Legacy Claude Code local install.
        home.join(".claude/local"),
        home.join(".npm-global/bin"),
        home.join(".bun/bin"),
        home.join(".volta/bin"),
        home.join(".deno/bin"),
        home.join(".cargo/bin"),
        home.join(".yarn/bin"),
        home.join(".codex/bin"),
    ];
    dirs.extend(node_version_manager_dirs(&home));
    dirs.extend(os::extra_executable_dirs(&home));
    dirs
}

/// Newest-first `bin` directories of nvm/fnm/asdf-managed Node installs.
fn node_version_manager_dirs(home: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for (root, suffix) in [
        (home.join(".nvm/versions/node"), "bin"),
        (
            home.join(".local/share/fnm/node-versions"),
            "installation/bin",
        ),
        (
            home.join("Library/Application Support/fnm/node-versions"),
            "installation/bin",
        ),
        (home.join(".asdf/installs/nodejs"), "bin"),
    ] {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        let mut versions: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path().join(suffix))
            .filter(|path| path.is_dir())
            .collect();
        versions.sort();
        versions.reverse();
        found.extend(versions);
    }
    found
}

fn candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    os::executable_names(name)
        .into_iter()
        .map(|file| dir.join(file))
        .collect()
}

fn is_executable(path: &Path) -> bool {
    path.is_file() && family::is_executable(path)
}

/// Finds a CLI on PATH, then by asking the user's login shell, then in common
/// install locations. Results from the (slow) shell lookup are cached.
pub fn find_executable(name: &str) -> Option<PathBuf> {
    let first_in = |dirs: &[PathBuf]| {
        dirs.iter().find_map(|dir| {
            candidates(dir, name)
                .into_iter()
                .find(|path| is_executable(path))
        })
    };
    let path_dirs = env::var_os("PATH")
        .map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .unwrap_or_default();
    // 1. The PATH this process was given.
    if let Some(found) = first_in(&path_dirs) {
        return Some(found);
    }
    // 2. The user's own login shell: it knows their rc-file PATH, the active
    //    nvm/asdf version and custom installs, so it beats guessing directories.
    static SHELL_CACHE: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);
    if let Some(cached) = SHELL_CACHE
        .lock()
        .ok()
        .and_then(|cache| cache.as_ref()?.get(name).cloned())
        .filter(|path| is_executable(path))
    {
        return Some(cached);
    }
    if let Some(found) = family::login_shell_lookup(name).filter(|path| is_executable(path)) {
        if let Ok(mut cache) = SHELL_CACHE.lock() {
            cache
                .get_or_insert_with(HashMap::new)
                .insert(name.to_owned(), found.clone());
        }
        return Some(found);
    }
    // 3. Common install locations, for shells that fail or print noise.
    first_in(&executable_dirs())
}

/// PATH for an agent process: the agent's own directory first (so npm shims find
/// a sibling `node`), then the inherited PATH, then common install locations.
pub fn child_path(binary: &Path) -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut push = |dir: PathBuf| {
        if !dir.as_os_str().is_empty() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    };
    if let Some(parent) = binary.parent() {
        push(parent.to_path_buf());
    }
    if let Ok(resolved) = std::fs::canonicalize(binary) {
        if let Some(parent) = resolved.parent() {
            push(parent.to_path_buf());
        }
    }
    if let Some(paths) = env::var_os("PATH") {
        env::split_paths(&paths).for_each(&mut push);
    }
    executable_dirs().into_iter().for_each(&mut push);
    env::join_paths(dirs).unwrap_or_else(|_| env::var_os("PATH").unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_dir_matches_platform_convention() {
        let home = Path::new("/home/example");
        let dir = os::data_dir(home);
        if cfg!(target_os = "macos") {
            assert_eq!(
                dir,
                home.join("Library/Application Support/dev.noai.desktop")
            );
        } else if cfg!(unix) {
            assert!(dir.ends_with("dev.noai.desktop"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn finds_executables_outside_path_in_common_locations() {
        use std::os::unix::fs::PermissionsExt;
        let home = env::temp_dir().join(format!("noai-find-{}", std::process::id()));
        let bin = home.join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let tool = bin.join("noai-fake-agent");
        std::fs::write(&tool, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(candidates(&bin, "noai-fake-agent")
            .iter()
            .any(|path| is_executable(path)));
        let path = child_path(&tool);
        assert_eq!(env::split_paths(&path).next(), Some(bin.clone()));
        std::fs::remove_dir_all(home).unwrap();
    }
}

#[cfg(test)]
mod live_tests {
    /// Manual check: `cargo test -- --ignored --nocapture live_detection`
    /// simulates a Finder/Dock launch, which inherits only the system PATH.
    #[test]
    #[ignore]
    fn live_detection_with_gui_path() {
        // Manual, run alone: no other test reads PATH concurrently.
        std::env::set_var("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        for name in ["claude", "codex"] {
            println!("{name}: {:?}", super::find_executable(name));
        }
    }
}
