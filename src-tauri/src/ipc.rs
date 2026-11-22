//! Desktop client for the single-owner Noai daemon.

/// Which binary this process started from: its path and modification time.
/// The daemon records it at startup, so after a rebuild the app can tell the
/// running daemon is older than itself and replace it.
pub fn build_stamp() -> &'static str {
    static STAMP: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    STAMP.get_or_init(|| {
        std::env::current_exe()
            .ok()
            .map(|path| {
                let modified = std::fs::metadata(&path)
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |age| age.as_secs());
                format!("{}|{modified}", path.display())
            })
            .unwrap_or_default()
    })
}

/// True when a daemon reporting `stamp` should make way for this binary: it
/// runs an older copy of the same file, or predates build stamps. A daemon
/// from a different binary (another install) is left alone. One run by the
/// user service is started again by it, from its configured binary.
#[cfg_attr(not(unix), allow(dead_code))]
pub fn daemon_is_stale(stamp: Option<&str>, ours: &str) -> bool {
    match stamp {
        None => true,
        Some(theirs) => {
            theirs != ours
                && theirs.rsplit_once('|').map(|(path, _)| path)
                    == ours.rsplit_once('|').map(|(path, _)| path)
        }
    }
}
#[cfg(unix)]
mod unix {
    use serde::de::DeserializeOwned;
    use serde_json::Value;
    use std::{
        io::{Read, Write},
        os::unix::net::UnixStream,
        path::{Path, PathBuf},
        process::{Command, Stdio},
        thread,
        time::Duration,
    };
    use tauri::{AppHandle, Emitter};

    static REPLAY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    pub fn replay_events() {
        REPLAY.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    // Must be the daemon's own directory, not Tauri's: the daemon runs headless
    // and resolves its path without an AppHandle.
    fn socket_path(_app: &AppHandle) -> Result<PathBuf, String> {
        crate::platform::app_data_dir().map(|dir| dir.join("control.sock"))
    }

    fn connect(path: &Path) -> Result<UnixStream, String> {
        let stream =
            UnixStream::connect(path).map_err(|e| format!("Noai daemon is unavailable: {e}"))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(15)))
            .map_err(|e| e.to_string())?;
        Ok(stream)
    }

    /// Asks a daemon left over from an older build of this same binary to
    /// exit, so the code below starts the new one. A daemon with runs in
    /// progress refuses and keeps going; the app then uses it as before.
    fn replace_stale_daemon(app: &AppHandle, path: &Path) {
        let Ok(info) = request::<Value>(app, serde_json::json!({"command":"ping"})) else {
            return;
        };
        let stamp = info.get("build").and_then(Value::as_str);
        if !super::daemon_is_stale(stamp, super::build_stamp()) {
            return;
        }
        if request::<Value>(app, serde_json::json!({"command":"shutdown"})).is_err() {
            return;
        }
        for _ in 0..50 {
            if connect(path).is_err() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    pub fn ensure_started(app: &AppHandle) -> Result<(), String> {
        let path = socket_path(app)?;
        if connect(&path).is_ok() {
            replace_stale_daemon(app, &path);
        }
        if connect(&path).is_ok() {
            return Ok(());
        }
        // An installed user service is the preferred owner. A detached local daemon
        // keeps developer builds and portable launches usable too.
        crate::platform::start_user_service();
        for _ in 0..20 {
            if connect(&path).is_ok() {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let dir = crate::platform::app_data_dir()?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let log_path = dir.join("daemon.log");
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|e| format!("Cannot open {}: {e}", log_path.display()))?;
        let log_err = log.try_clone().map_err(|e| e.to_string())?;
        Command::new(executable)
            .arg("--daemon")
            .stdin(Stdio::null())
            .stdout(log)
            .stderr(log_err)
            .spawn()
            .map_err(|e| format!("Cannot start Noai daemon: {e}"))?;
        for _ in 0..50 {
            if connect(&path).is_ok() {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }
        Err(format!(
            "Noai daemon did not open {}; see {}",
            path.display(),
            log_path.display()
        ))
    }

    pub fn request<T: DeserializeOwned>(app: &AppHandle, command: Value) -> Result<T, String> {
        let path = socket_path(app)?;
        let mut stream = connect(&path)?;
        let mut bytes = serde_json::to_vec(&command).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        stream
            .write_all(&bytes)
            .map_err(|e| format!("Cannot send daemon request: {e}"))?;
        stream
            .shutdown(std::net::Shutdown::Write)
            .map_err(|e| e.to_string())?;
        let mut response = Vec::new();
        Read::by_ref(&mut stream)
            .take(32 * 1024 * 1024)
            .read_to_end(&mut response)
            .map_err(|e| format!("Cannot read daemon response: {e}"))?;
        let value: Value = serde_json::from_slice(&response)
            .map_err(|e| format!("Invalid daemon response: {e}"))?;
        if value.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Daemon request failed")
                .to_string());
        }
        serde_json::from_value(value.get("data").cloned().unwrap_or(Value::Null))
            .map_err(|e| format!("Invalid daemon data: {e}"))
    }

    pub fn start_event_relay(app: AppHandle) {
        thread::Builder::new()
            .name("noai-event-relay".into())
            .spawn(move || {
                let mut cursor = 0_u64;
                let mut daemon_pid = 0_u64;
                let mut generation = REPLAY.load(std::sync::atomic::Ordering::SeqCst);
                loop {
                    let current = REPLAY.load(std::sync::atomic::Ordering::SeqCst);
                    if current != generation {
                        cursor = 0;
                        generation = current;
                    }
                    let result = request::<Value>(
                        &app,
                        serde_json::json!({"command":"poll_events", "since":cursor}),
                    );
                    match result {
                        Ok(data) => {
                            let pid = data.get("instance").and_then(Value::as_u64).unwrap_or(0);
                            if daemon_pid != 0 && daemon_pid != pid {
                                cursor = 0;
                                daemon_pid = pid;
                                continue;
                            }
                            daemon_pid = pid;
                            if let Some(events) = data.get("events").and_then(Value::as_array) {
                                for item in events {
                                    if let (Some(channel), Some(payload)) = (
                                        item.get("channel").and_then(Value::as_str),
                                        item.get("payload"),
                                    ) {
                                        let _ = app.emit(channel, payload.clone());
                                    }
                                }
                            }
                            cursor = data.get("cursor").and_then(Value::as_u64).unwrap_or(cursor);
                        }
                        Err(error) => eprintln!("Noai daemon event relay: {error}"),
                    }
                    thread::sleep(Duration::from_millis(500));
                }
            })
            .ok();
    }
}
#[cfg(unix)]
pub use unix::{ensure_started, replay_events, request, start_event_relay};

#[cfg(test)]
mod tests {
    use super::daemon_is_stale;

    #[test]
    fn only_an_older_copy_of_the_same_binary_is_replaced() {
        let ours = "/app/noai|200";
        assert!(daemon_is_stale(Some("/app/noai|100"), ours));
        assert!(!daemon_is_stale(Some(ours), ours));
        assert!(!daemon_is_stale(
            Some("/Applications/Noai.app/noai|100"),
            ours
        ));
        assert!(daemon_is_stale(None, ours));
    }
}
