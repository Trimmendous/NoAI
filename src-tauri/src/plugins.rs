//! Plugins: folders in `~/.noai/plugins/<id>/`, each with a `plugin.json`.
//! A plugin can add pages, commands, themes and agents (see PLUGINS.md).
//! Nothing runs until the user enables it in Settings › Plugins; the list of
//! enabled plugins lives in `~/.noai/plugins/enabled.json` so the background
//! service sees the same set as the app.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

/// Big enough for theme packs (100 themes is about 100 KB).
const MAX_MANIFEST: u64 = 1024 * 1024;
/// What a plugin may ask for. Anything else in `permissions` is ignored.
pub const PERMISSIONS: &[&str] = &[
    "chats:read",
    "chats:write",
    "jobs:read",
    "metrics:read",
    "notify",
    "network",
];

pub fn plugins_dir() -> Result<PathBuf, String> {
    Ok(crate::platform::home_dir()?.join(".noai").join("plugins"))
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
}

/// An agent CLI a plugin teaches Noai to run (see `harness::plugin_agent`).
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpec {
    pub id: String,
    pub label: String,
    /// The program, found on PATH like the built-in agents.
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Added only when a model is chosen; `{model}` is replaced by it.
    #[serde(default)]
    pub model_args: Vec<String>,
    #[serde(default)]
    pub models: Vec<String>,
    /// "text" (each output line is reply text) or "jsonl" (take `textField`).
    #[serde(default = "default_output")]
    pub output: String,
    #[serde(default)]
    pub text_field: Option<String>,
}

fn default_output() -> String {
    "text".into()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub path: String,
    pub enabled: bool,
    pub permissions: Vec<String>,
    /// The manifest's pages, commands, themes and agents, as written.
    pub manifest: Value,
    /// Why the plugin can't load, in plain English. Empty when it's fine.
    pub problems: Vec<String>,
}

fn enabled_file(dir: &Path) -> PathBuf {
    dir.join("enabled.json")
}

pub fn enabled_ids(dir: &Path) -> BTreeSet<String> {
    fs::read(enabled_file(dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|id| valid_id(id))
        .collect()
}

fn text(value: &Value, key: &str, max: usize) -> String {
    value[key]
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect()
}

fn read_entry(dir: &Path, id: &str, enabled: &BTreeSet<String>) -> PluginEntry {
    let folder = dir.join(id);
    let mut problems = Vec::new();
    let manifest_path = folder.join("plugin.json");
    let manifest: Value = match fs::metadata(&manifest_path) {
        Ok(meta) if meta.len() > MAX_MANIFEST => {
            problems.push("plugin.json is larger than 1 MB.".into());
            Value::Null
        }
        Ok(_) => {
            match fs::read(&manifest_path).map(|bytes| serde_json::from_slice::<Value>(&bytes)) {
                Ok(Ok(value)) if value.is_object() => value,
                Ok(Ok(_)) => {
                    problems.push("plugin.json must be a JSON object.".into());
                    Value::Null
                }
                Ok(Err(error)) => {
                    problems.push(format!("plugin.json isn't valid JSON: {error}"));
                    Value::Null
                }
                Err(error) => {
                    problems.push(format!("Cannot read plugin.json: {error}"));
                    Value::Null
                }
            }
        }
        Err(_) => {
            problems.push("No plugin.json in this folder.".into());
            Value::Null
        }
    };
    if !manifest.is_null() && manifest["id"].as_str() != Some(id) {
        problems.push(format!(
            "The \"id\" in plugin.json must match the folder name ({id})."
        ));
    }
    let permissions = manifest["permissions"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .filter(|name| PERMISSIONS.contains(name))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let contributions = ["pages", "commands", "themes", "agents", "main"]
        .into_iter()
        .filter_map(|key| {
            manifest
                .get(key)
                .map(|value| (key.to_owned(), value.clone()))
        })
        .collect::<serde_json::Map<_, _>>();
    PluginEntry {
        id: id.to_owned(),
        name: Some(text(&manifest, "name", 80))
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| id.to_owned()),
        version: text(&manifest, "version", 24),
        description: text(&manifest, "description", 300),
        author: text(&manifest, "author", 80),
        path: folder.to_string_lossy().into_owned(),
        enabled: enabled.contains(id) && problems.is_empty(),
        permissions,
        manifest: Value::Object(contributions),
        problems,
    }
}

/// Every plugin folder, enabled or not, sorted by name.
pub fn list() -> Result<Vec<PluginEntry>, String> {
    let dir = plugins_dir()?;
    let Ok(read) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let enabled = enabled_ids(&dir);
    let mut entries: Vec<_> = read
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .filter(|id| valid_id(id))
        .map(|id| read_entry(&dir, &id, &enabled))
        .collect();
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(entries)
}

pub fn set_enabled(id: &str, on: bool) -> Result<(), String> {
    if !valid_id(id) {
        return Err("Invalid plugin id".into());
    }
    let dir = plugins_dir()?;
    if on && !dir.join(id).join("plugin.json").is_file() {
        return Err("That plugin isn't installed.".into());
    }
    let mut enabled = enabled_ids(&dir);
    if on {
        enabled.insert(id.to_owned());
    } else {
        enabled.remove(id);
    }
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let list: Vec<_> = enabled.into_iter().collect();
    fs::write(
        enabled_file(&dir),
        serde_json::to_vec_pretty(&list).unwrap_or_default(),
    )
    .map_err(|error| format!("Cannot save enabled plugins: {error}"))
}

/// Turns a plugin off and deletes its folder. Only a real folder directly
/// inside the plugins folder can be removed (never a link to elsewhere).
pub fn delete(id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("Invalid plugin id".into());
    }
    let dir = plugins_dir()?;
    let folder = dir.join(id);
    let meta =
        fs::symlink_metadata(&folder).map_err(|_| "That plugin isn't installed.".to_string())?;
    if !meta.is_dir() {
        return Err("That plugin isn't a folder Noai can delete.".into());
    }
    let root = dir.canonicalize().map_err(|error| error.to_string())?;
    if folder
        .canonicalize()
        .map_err(|error| error.to_string())?
        .parent()
        != Some(root.as_path())
    {
        return Err("That plugin isn't inside the plugins folder.".into());
    }
    let _ = set_enabled(id, false);
    fs::remove_dir_all(&folder).map_err(|error| format!("Could not delete the plugin: {error}"))
}

/// Agents from enabled plugins. Their ids are namespaced as `plugin-<id>`.
pub fn agents() -> Vec<AgentSpec> {
    let Ok(entries) = list() else {
        return Vec::new();
    };
    let mut seen = BTreeSet::new();
    entries
        .into_iter()
        .filter(|entry| entry.enabled)
        .flat_map(|entry| {
            serde_json::from_value::<Vec<AgentSpec>>(entry.manifest["agents"].clone())
                .unwrap_or_default()
        })
        .filter_map(|mut agent| {
            let id = format!("plugin-{}", agent.id);
            let usable = valid_id(&agent.id)
                && id.len() <= 32
                && !agent.label.trim().is_empty()
                && !agent.command.trim().is_empty()
                && !agent.command.contains(['/', '\\'])
                && seen.insert(id.clone());
            usable.then(|| {
                agent.id = id;
                agent.label = agent
                    .label
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(40)
                    .collect();
                agent
            })
        })
        .collect()
}

/// Resolves a file inside an enabled plugin's folder, refusing anything that
/// would leave it (`..`, links pointing elsewhere).
pub fn resolve_file(id: &str, relative: &str) -> Result<(PathBuf, PluginEntry), String> {
    if !valid_id(id) || relative.is_empty() || relative.len() > 300 {
        return Err("Not found".into());
    }
    if relative
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == ".." || part.contains('\\'))
    {
        return Err("Not found".into());
    }
    let dir = plugins_dir()?;
    let entry = read_entry(&dir, id, &enabled_ids(&dir));
    if !entry.enabled {
        return Err("Plugin is turned off".into());
    }
    let root = dir
        .join(id)
        .canonicalize()
        .map_err(|_| "Not found".to_string())?;
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|_| "Not found".to_string())?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err("Not found".into());
    }
    Ok((path, entry))
}

pub fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// The security policy for a plugin's pages: its own files only, no network
/// unless it asked for the "network" permission.
pub fn page_policy(entry: &PluginEntry) -> String {
    let own = "noaiplugin: http://noaiplugin.localhost";
    let connect = if entry.permissions.iter().any(|name| name == "network") {
        "https:"
    } else {
        "'none'"
    };
    format!("default-src {own}; script-src {own} 'unsafe-inline'; style-src {own} 'unsafe-inline'; img-src {own} data:; font-src {own}; connect-src {connect}; object-src 'none'; base-uri 'none'")
}

/// Writes a small example plugin showing every kind of contribution.
pub fn create_example() -> Result<String, String> {
    let dir = plugins_dir()?.join("hello-noai");
    if dir.exists() {
        return Ok(dir.to_string_lossy().into_owned());
    }
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    for (name, body) in EXAMPLE {
        fs::write(dir.join(name), body).map_err(|error| format!("Cannot write {name}: {error}"))?;
    }
    Ok(dir.to_string_lossy().into_owned())
}

const EXAMPLE: &[(&str, &str)] = &[
    (
        "plugin.json",
        include_str!("../../examples/plugins/hello-noai/plugin.json"),
    ),
    (
        "page.html",
        include_str!("../../examples/plugins/hello-noai/page.html"),
    ),
    (
        "main.js",
        include_str!("../../examples/plugins/hello-noai/main.js"),
    ),
    (
        "README.md",
        include_str!("../../examples/plugins/hello-noai/README.md"),
    ),
];

const SDK_JS: &str = include_str!("../../src/plugin-sdk/noai.js");
const SDK_CSS: &str = include_str!("../../src/plugin-sdk/noai.css");

fn decode(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Serves `noaiplugin://localhost/<id>/<file>` (and the SDK at `/_sdk/`)
/// to plugin frames. Only enabled plugins' own files are reachable.
pub fn respond(path: &str) -> tauri::http::Response<Vec<u8>> {
    let reply = |status: u16, kind: &str, policy: Option<String>, body: Vec<u8>| {
        let mut builder = tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", kind)
            .header("X-Content-Type-Options", "nosniff")
            .header("Cache-Control", "no-store");
        if let Some(policy) = policy {
            builder = builder.header("Content-Security-Policy", policy);
        }
        builder.body(body).unwrap_or_default()
    };
    let not_found = || reply(404, "text/plain", None, b"Not found".to_vec());
    let Some(path) = decode(path.trim_start_matches('/')) else {
        return not_found();
    };
    match path.as_str() {
        "_sdk/noai.js" => {
            return reply(
                200,
                "text/javascript; charset=utf-8",
                None,
                SDK_JS.as_bytes().to_vec(),
            )
        }
        "_sdk/noai.css" => {
            return reply(
                200,
                "text/css; charset=utf-8",
                None,
                SDK_CSS.as_bytes().to_vec(),
            )
        }
        _ => {}
    }
    let Some((id, relative)) = path.split_once('/') else {
        return not_found();
    };
    // A plugin's background script runs in a small generated page.
    if relative == "__main.html" {
        let dir = match plugins_dir() {
            Ok(dir) => dir,
            Err(_) => return not_found(),
        };
        let entry = read_entry(&dir, id, &enabled_ids(&dir));
        let Some(main) = entry.manifest["main"].as_str().map(str::to_owned) else {
            return not_found();
        };
        if !entry.enabled || resolve_file(id, &main).is_err() || main.contains(['"', '<', '>']) {
            return not_found();
        }
        let html = format!("<!doctype html><meta charset=\"utf-8\"><script src=\"../_sdk/noai.js\"></script><script src=\"{main}\"></script>");
        return reply(
            200,
            "text/html; charset=utf-8",
            Some(page_policy(&entry)),
            html.into_bytes(),
        );
    }
    match resolve_file(id, relative) {
        Ok((file, entry)) => match fs::read(&file) {
            Ok(body) => reply(200, content_type(&file), Some(page_policy(&entry)), body),
            Err(_) => not_found(),
        },
        Err(_) => not_found(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_files_never_leave_the_plugin_folder() {
        for bad in ["../x", "a/../../b", "/etc/passwd", "a//b", "a\\b", ""] {
            assert!(resolve_file("hello-noai", bad).is_err(), "{bad}");
        }
        assert!(resolve_file("../evil", "page.html").is_err());
    }

    #[test]
    fn ids_are_plain_lowercase_names() {
        assert!(valid_id("hello-noai"));
        assert!(!valid_id("Hello"));
        assert!(!valid_id("-x"));
        assert!(!valid_id("a/b"));
    }

    #[test]
    fn policy_blocks_the_network_unless_asked() {
        let mut entry = PluginEntry {
            id: "x".into(),
            name: "x".into(),
            version: String::new(),
            description: String::new(),
            author: String::new(),
            path: String::new(),
            enabled: true,
            permissions: vec![],
            manifest: Value::Null,
            problems: vec![],
        };
        assert!(page_policy(&entry).contains("connect-src 'none'"));
        entry.permissions.push("network".into());
        assert!(page_policy(&entry).contains("connect-src https:"));
    }
}

/// End to end against a throwaway home folder:
/// `HOME=$(mktemp -d) cargo test plugins_e2e -- --ignored`
#[cfg(test)]
mod e2e {
    use super::*;

    #[test]
    #[ignore = "writes a plugin under $HOME; run with a temporary HOME"]
    fn plugins_e2e() {
        create_example().unwrap();
        let body = |path: &str| {
            let response = respond(path);
            (
                response.status().as_u16(),
                String::from_utf8_lossy(response.body()).into_owned(),
                response
                    .headers()
                    .get("Content-Security-Policy")
                    .map(|value| value.to_str().unwrap_or("").to_owned()),
            )
        };
        // Off by default: nothing is served.
        assert_eq!(body("/hello-noai/page.html").0, 404);
        set_enabled("hello-noai", true).unwrap();
        let (status, html, policy) = body("/hello-noai/page.html");
        assert_eq!(status, 200);
        assert!(html.contains("../_sdk/noai.js"));
        assert!(policy.unwrap().contains("connect-src 'none'"));
        let (status, main, _) = body("/hello-noai/__main.html");
        assert_eq!(status, 200);
        assert!(main.contains("src=\"main.js\""));
        assert_eq!(body("/_sdk/noai.js").0, 200);
        assert_eq!(body("/hello-noai/..%2Fenabled.json").0, 404);
        assert_eq!(body("/hello-noai/%2e%2e/enabled.json").0, 404);
        // The plugin's agent shows up as a harness, then goes when it's off.
        crate::harness::reload_plugins();
        assert!(crate::harness::get("plugin-echo").is_some());
        set_enabled("hello-noai", false).unwrap();
        crate::harness::reload_plugins();
        assert!(crate::harness::get("plugin-echo").is_none());
        assert_eq!(body("/hello-noai/page.html").0, 404);
        // Deleting removes the folder and its enabled entry.
        set_enabled("hello-noai", true).unwrap();
        delete("hello-noai").unwrap();
        assert!(!plugins_dir().unwrap().join("hello-noai").exists());
        assert!(!enabled_ids(&plugins_dir().unwrap()).contains("hello-noai"));
        assert!(delete("hello-noai").is_err());
        assert!(delete("../x").is_err());
    }
}
