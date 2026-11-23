//! Markdown summaries for a run or session: the first of SUMMARY.md,
//! summary.md, README.md, readme.md found in the folder it worked in.
use serde::Serialize;
use std::{fs, path::Path, time::UNIX_EPOCH};

/// Preferred first. Matched exactly, so the order holds on case-insensitive disks too.
const NAMES: [&str; 4] = ["SUMMARY.md", "summary.md", "README.md", "readme.md"];
const MAX_BYTES: u64 = 512 * 1024;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub name: String,
    pub path: String,
    pub text: String,
    pub modified: Option<u64>,
    pub truncated: bool,
}

/// Looks in each folder in turn and returns the first summary found.
pub fn find(dirs: &[String]) -> Option<Summary> {
    dirs.iter()
        .filter(|dir| !dir.trim().is_empty())
        .find_map(|dir| in_dir(Path::new(dir)))
}

fn in_dir(dir: &Path) -> Option<Summary> {
    let present: Vec<String> = fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
        })
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    let name = NAMES
        .iter()
        .find(|name| present.iter().any(|file| file == *name))?;
    let path = dir.join(name);
    let meta = fs::metadata(&path).ok()?;
    let bytes = fs::read(&path).ok()?;
    let truncated = meta.len() > MAX_BYTES;
    let mut text =
        String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_BYTES as usize)]).into_owned();
    if truncated {
        text.push_str("\n\n…");
    }
    Some(Summary {
        name: (*name).to_string(),
        path: path.to_string_lossy().into_owned(),
        text,
        modified: meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|age| age.as_secs()),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("noai-summary-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn prefers_summary_then_readme_capitals_first() {
        let dir = temp("order");
        fs::write(dir.join("readme.md"), "lower readme").unwrap();
        assert_eq!(
            find(&[dir.to_string_lossy().into()]).unwrap().name,
            "readme.md"
        );
        fs::write(dir.join("README.md"), "readme").ok();
        let found = find(&[dir.to_string_lossy().into()]).unwrap();
        // A case-insensitive disk keeps one file under its first name.
        assert!(found.name == "README.md" || found.name == "readme.md");
        fs::write(dir.join("summary.md"), "summary").unwrap();
        assert_eq!(
            find(&[dir.to_string_lossy().into()]).unwrap().text,
            "summary"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn falls_through_folders_and_skips_missing_ones() {
        let empty = temp("empty");
        let full = temp("full");
        fs::write(full.join("SUMMARY.md"), "# Done").unwrap();
        let found = find(&[
            "".into(),
            "/no/such/folder".into(),
            empty.to_string_lossy().into(),
            full.to_string_lossy().into(),
        ])
        .unwrap();
        assert_eq!(found.name, "SUMMARY.md");
        assert!(find(&[empty.to_string_lossy().into()]).is_none());
        let _ = fs::remove_dir_all(&empty);
        let _ = fs::remove_dir_all(&full);
    }
}
