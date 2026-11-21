//! Read-only session browsing. File access is restricted to discovered history files.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};
use tauri::{AppHandle, Manager};

#[derive(Clone)]
struct Entry {
    path: PathBuf,
    harness: String,
    len: u64,
    modified: SystemTime,
    summary: Value,
}
static INDEX: OnceLock<Mutex<BTreeMap<String, Entry>>> = OnceLock::new();

fn discover(
    root: &Path,
    harness: &str,
    archived: bool,
    files: &mut Vec<(PathBuf, String, bool)>,
    errors: &mut usize,
) {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                *errors += 1;
            }
            return;
        }
    };
    for entry in entries {
        let Ok(entry) = entry else {
            *errors += 1;
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            *errors += 1;
            continue;
        };
        if kind.is_dir() {
            discover(&entry.path(), harness, archived, files, errors);
        } else if kind.is_file()
            && entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "jsonl")
        {
            files.push((entry.path(), harness.into(), archived));
        }
    }
}
fn timestamp(value: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value["timestamp"].as_str()?)
        .ok()
        .map(|date| date.timestamp())
}
fn message(harness: &str, value: &Value) -> Option<Value> {
    let message = crate::harness::get(harness)?.session_message(value)?;
    if message.text.is_empty() && message.activities.is_empty() {
        return None;
    }
    Some(
        json!({"role":message.role,"text":message.text,"at":timestamp(value),"activities":message.activities}),
    )
}
fn summarize(path: &Path, harness: &str, archived: bool, updated: u64) -> Result<Value, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut summary = json!({"id":path.to_string_lossy(),"sessionId":path.file_stem().unwrap_or_default().to_string_lossy(),"harness":harness,"title":"Untitled session","projectPath":"","model":"","updatedAt":updated,"startedAt":null,"archived":archived,"messageCount":0,"sourcePath":path.to_string_lossy()});
    let mut count = 0;
    let mut parse_errors = 0;
    let mut usage = crate::harness::SessionUsage::default();
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| error.to_string())?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            parse_errors += 1;
            continue;
        };
        if summary["startedAt"].is_null() {
            if let Some(at) = timestamp(&value) {
                summary["startedAt"] = json!(at);
            }
        }
        if let Some(agent) = crate::harness::get(harness) {
            agent.session_usage(&value, &mut usage);
            let meta = agent.session_meta(&value);
            if let Some(id) = meta.session_id {
                summary["sessionId"] = json!(id);
            }
            if let Some(path) = meta.project_path {
                summary["projectPath"] = json!(path);
            }
            if let Some(model) = meta.model {
                summary["model"] = json!(model);
            }
        }
        if let Some(message) = message(harness, &value) {
            count += 1;
            let text = message["text"].as_str().unwrap_or("");
            if summary["title"] == "Untitled session"
                && message["role"] == "user"
                && !text.starts_with("<")
                && !text.starts_with("# AGENTS.md")
            {
                summary["title"] = json!(text
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(100)
                    .collect::<String>());
            }
        }
    }
    summary["messageCount"] = json!(count);
    summary["parseErrors"] = json!(parse_errors);
    if !usage.calls.is_empty() {
        summary["tokens"] = json!(usage.tokens());
    }
    if let (Some(used), Some(window)) = (usage.context_used, usage.context_window) {
        summary["context"] = json!({"used":used,"window":window});
    }
    Ok(summary)
}
pub(crate) fn list(home: PathBuf) -> Result<Value, String> {
    let mut files = Vec::new();
    let mut errors = 0;
    for agent in crate::harness::all() {
        for root in agent.history_roots(&home) {
            discover(
                &root.path,
                agent.id(),
                root.archived,
                &mut files,
                &mut errors,
            );
        }
    }
    let mut index = INDEX
        .get_or_init(Default::default)
        .lock()
        .map_err(|error| error.to_string())?;
    let mut next = BTreeMap::new();
    for (path, harness, archived) in files {
        let Ok(meta) = fs::metadata(&path) else {
            errors += 1;
            continue;
        };
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let id = path.to_string_lossy().into_owned();
        if let Some(old) = index
            .get(&id)
            .filter(|old| old.len == meta.len() && old.modified == modified)
        {
            next.insert(id, old.clone());
            continue;
        }
        match summarize(
            &path,
            &harness,
            archived,
            modified
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        ) {
            Ok(summary) => {
                next.insert(
                    id,
                    Entry {
                        path,
                        harness,
                        len: meta.len(),
                        modified,
                        summary,
                    },
                );
            }
            Err(_) => errors += 1,
        }
    }
    *index = next;
    Ok(
        json!({"sessions":with_subagents(&index),"errors":errors,"parseErrors":index.values().map(|entry| entry.summary["parseErrors"].as_u64().unwrap_or(0)).sum::<u64>()}),
    )
}
/// Lists sessions with each subagent transcript folded into its parent: the
/// parent's `subagents` holds their count and summed tokens, and the subagents
/// are not listed on their own.
fn with_subagents(index: &BTreeMap<String, Entry>) -> Vec<Value> {
    let mut children: BTreeMap<String, (u64, crate::harness::Tokens)> = BTreeMap::new();
    let mut hidden = std::collections::HashSet::new();
    for (id, entry) in index {
        let Some(parent) = crate::harness::get(&entry.harness)
            .and_then(|agent| agent.subagent_parent(&entry.path))
            .map(|parent| parent.to_string_lossy().into_owned())
            .filter(|parent| index.contains_key(parent))
        else {
            continue;
        };
        let tokens: crate::harness::Tokens =
            serde_json::from_value(entry.summary["tokens"].clone()).unwrap_or_default();
        let child = children.entry(parent).or_default();
        child.0 += 1;
        child.1 = child.1.add(tokens);
        hidden.insert(id.clone());
    }
    index
        .iter()
        .filter(|(id, _)| !hidden.contains(*id))
        .map(|(id, entry)| {
            let mut summary = entry.summary.clone();
            if let Some((count, tokens)) = children.get(id) {
                summary["subagents"] = json!({"count":count,"tokens":tokens});
            }
            summary
        })
        .collect()
}
fn detail(id: String, offset: usize) -> Result<Value, String> {
    let entry = INDEX
        .get_or_init(Default::default)
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned()
        .ok_or("Session not found. Refresh the session list.")?;
    // Do not follow a file that has been replaced with a symbolic link since discovery.
    if fs::symlink_metadata(&entry.path)
        .map_err(|error| error.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Session file changed. Refresh the list.".into());
    }
    let file = fs::File::open(&entry.path).map_err(|error| error.to_string())?;
    let mut messages = Vec::new();
    let mut skipped = 0;
    let mut more = false;
    let mut parse_errors = 0;
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| error.to_string())?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            parse_errors += 1;
            continue;
        };
        if let Some(message) = message(&entry.harness, &value) {
            if skipped < offset {
                skipped += 1;
                continue;
            }
            if messages.len() == 100 {
                more = true;
                break;
            }
            messages.push(message);
        }
    }
    let metrics = if offset == 0 {
        crate::local_metrics::file_records(&entry.path, &entry.harness)?
    } else {
        Vec::new()
    };
    Ok(
        json!({"session":entry.summary,"messages":messages,"nextOffset":if more {Some(offset + messages.len())} else {None},"records":metrics,"parseErrors":parse_errors}),
    )
}
#[tauri::command]
pub async fn list_local_sessions(app: AppHandle) -> Result<Value, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    tokio::task::spawn_blocking(move || list(home))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn get_local_session(id: String, offset: usize) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || detail(id, offset))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transcript_blocks_are_text_and_tools_not_executable_markup() {
        let value = json!({"type":"response_item","timestamp":"2026-01-01T00:00:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<script>example</script>"}]}});
        assert_eq!(
            message("codex", &value).unwrap()["text"],
            "<script>example</script>"
        );
        let claude = json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"},{"type":"tool_use","name":"Read","input":{"file":"a"}}]}});
        assert!(message("claude", &claude).unwrap()["activities"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Read"));
        assert!(message(
            "codex",
            &json!({"type":"event_msg","payload":{"type":"agent_message","message":"duplicate"}})
        )
        .is_none());
    }
    #[test]
    fn recorded_thinking_and_tools_remain_separate_from_visible_text() {
        let value = json!({"type":"assistant","message":{"role":"assistant","content":[
            {"type":"text","text":"Visible response"},
            {"type":"thinking","thinking":"Recorded example"},
            {"type":"redacted_thinking","data":"opaque"},
            {"type":"tool_use","name":"Read","input":{"file":"example"}}
        ]}});
        let result = message("claude", &value).unwrap();
        assert_eq!(result["text"], "Visible response");
        assert_eq!(result["activities"].as_array().unwrap().len(), 2);
        assert_eq!(result["activities"][0]["kind"], "thinking");
        let opaque = json!({"type":"response_item","payload":{"type":"reasoning","encrypted_content":"opaque"}});
        assert!(message("codex", &opaque).is_none());
        let summary = json!({"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"Recorded summary"}]}});
        assert_eq!(
            message("codex", &summary).unwrap()["text"],
            "Recorded summary"
        );
    }
    #[test]
    fn reads_metadata_archives_and_pages_transcripts() {
        let dir = std::env::temp_dir().join(format!("noai-session-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.jsonl");
        let mut lines = vec![json!({"type":"session_meta","timestamp":"2026-01-01T00:00:00Z","payload":{"id":"provider-session","cwd":"/project"}}).to_string(), json!({"type":"turn_context","payload":{"model":"recorded-model"}}).to_string()];
        for index in 0..102 {
            lines.push(json!({"type":"response_item","timestamp":"2026-01-01T00:01:00Z","payload":{"type":"message","role":if index == 0 {"user"} else {"assistant"},"content":[{"type":"output_text","text":format!("Message {index}")}]}}).to_string());
        }
        lines.push("{partial".into());
        fs::write(&path, lines.join("\n") + "\n").unwrap();
        let summary = summarize(&path, "codex", true, 200).unwrap();
        assert_eq!(summary["title"], "Message 0");
        assert_eq!(summary["model"], "recorded-model");
        assert_eq!(summary["projectPath"], "/project");
        assert_eq!(summary["messageCount"], 102);
        assert_eq!(summary["archived"], true);
        assert_eq!(summary["parseErrors"], 1);
        let id = path.to_string_lossy().into_owned();
        INDEX.get_or_init(Default::default).lock().unwrap().insert(
            id.clone(),
            Entry {
                path: path.clone(),
                harness: "codex".into(),
                len: 0,
                modified: SystemTime::UNIX_EPOCH,
                summary,
            },
        );
        let first = detail(id.clone(), 0).unwrap();
        assert_eq!(first["messages"].as_array().unwrap().len(), 100);
        assert_eq!(first["nextOffset"], 100);
        let last = detail(id.clone(), 100).unwrap();
        assert_eq!(last["messages"].as_array().unwrap().len(), 2);
        assert!(last["nextOffset"].is_null());
        INDEX.get().unwrap().lock().unwrap().remove(&id);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn subagent_sessions_fold_into_their_parent() {
        let dir = std::env::temp_dir().join(format!("noai-subagents-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("abc/subagents")).unwrap();
        let call = |id: &str, input: u64| {
            json!({"type":"assistant","sessionId":"abc","message":{"id":id,"model":"m","role":"assistant","content":"hi","usage":{"input_tokens":input,"output_tokens":1}}}).to_string() + "\n"
        };
        let parent = dir.join("abc.jsonl");
        let child = dir.join("abc/subagents/agent-1.jsonl");
        fs::write(&parent, call("p", 100)).unwrap();
        fs::write(&child, call("c", 50)).unwrap();
        let mut index = BTreeMap::new();
        for path in [&parent, &child] {
            let summary = summarize(path, "claude", false, 1).unwrap();
            index.insert(
                path.to_string_lossy().into_owned(),
                Entry {
                    path: path.clone(),
                    harness: "claude".into(),
                    len: 0,
                    modified: SystemTime::UNIX_EPOCH,
                    summary,
                },
            );
        }
        let sessions = with_subagents(&index);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["tokens"]["input"], 100);
        assert_eq!(sessions[0]["context"]["used"], 101);
        assert_eq!(sessions[0]["subagents"]["count"], 1);
        assert_eq!(sessions[0]["subagents"]["tokens"]["input"], 50);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_unindexed_paths() {
        assert!(detail("/etc/passwd".into(), 0).is_err());
    }
}
