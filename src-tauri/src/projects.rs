use std::{fs, path::Path};
use tauri::{AppHandle, Manager};

/// An omitted folder gets a new workspace; explicit folders must already exist.
#[tauri::command]
pub fn ensure_project(app: AppHandle, project_path: Option<String>) -> Result<String, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    ensure_project_path(project_path, &home)
}

pub fn ensure_project_path(project_path: Option<String>, home: &Path) -> Result<String, String> {
    let selected = project_path.as_deref().unwrap_or("").trim();
    let path = if selected.is_empty() {
        create_workspace(home)?
    } else {
        Path::new(selected).to_path_buf()
    };
    if !path.is_dir() {
        return Err("Project folder does not exist or is not a directory.".into());
    }
    path.canonicalize()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| format!("Cannot open project folder: {error}"))
}

fn create_workspace(home: &Path) -> Result<std::path::PathBuf, String> {
    let root = home.join(".noai");
    fs::create_dir_all(&root).map_err(|error| format!("Cannot create ~/.noai: {error}"))?;
    let path = root.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&path).map_err(|error| format!("Cannot create workspace: {error}"))?;
    crate::platform::restrict_dir(&path)
        .map_err(|error| format!("Cannot protect workspace: {error}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn new_workspaces_have_distinct_uuid_names_and_keep_existing_files() {
        let home = std::env::temp_dir().join(format!("noai-home-{}", uuid::Uuid::new_v4()));
        let a = create_workspace(&home).unwrap();
        fs::write(a.join("keep.txt"), "saved").unwrap();
        let b = create_workspace(&home).unwrap();
        assert_ne!(a, b);
        assert_eq!(a.parent().unwrap(), home.join(".noai"));
        assert!(uuid::Uuid::parse_str(a.file_name().unwrap().to_str().unwrap()).is_ok());
        assert_eq!(fs::read_to_string(a.join("keep.txt")).unwrap(), "saved");
        fs::remove_dir_all(home).unwrap();
    }
}
