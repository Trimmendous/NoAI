use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{AppHandle, Manager};

static SAVE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn workspace_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("workspace.json"))
        .map_err(|error| format!("Cannot find app data directory: {error}"))
}

pub fn load(app: &AppHandle) -> Result<Option<Value>, String> {
    let path = workspace_path(app)?;
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("Cannot parse saved workspace: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cannot read workspace: {error}")),
    }
}

pub fn save(app: &AppHandle, workspace: Value) -> Result<(), String> {
    let path = workspace_path(app)?;
    let parent = path.parent().ok_or("Invalid workspace path")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create app data directory: {error}"))?;
    let bytes = serde_json::to_vec_pretty(&workspace)
        .map_err(|error| format!("Cannot serialize workspace: {error}"))?;
    let sequence = SAVE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = path.with_extension(format!("{}.{}.tmp", std::process::id(), sequence));
    let write_result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temp, &path)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_result.map_err(|error| format!("Cannot save workspace: {error}"))
}
