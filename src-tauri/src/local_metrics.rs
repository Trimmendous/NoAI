//! Read-only import of harness histories. Persist offsets and metric-only state;
//! never copy prompts, tool arguments, credentials or assistant text into the cache.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

#[derive(Default, Serialize, Deserialize)]
pub struct FileState {
    #[serde(default)]
    parse_errors: usize,
    offset: u64,
    len: u64,
    modified: u128,
    identity: u64,
    pub(crate) session: String,
    pub(crate) model: String,
    pub(crate) totals: [u64; 3],
    pub(crate) rows: BTreeMap<String, Value>,
    /// Set when this transcript is a subagent's: its type ("Explore", "web-fetch"…).
    /// Every row from the file is tagged with it, so any agent's subagents add up the same way.
    #[serde(default)]
    pub(crate) subagent: Option<String>,
}
#[derive(Default, Serialize, Deserialize)]
struct Cache {
    files: BTreeMap<PathBuf, FileState>,
}
#[derive(Default)]
struct Snapshot {
    rows: Vec<Value>,
    files: usize,
    errors: usize,
    updated: u64,
    scanning: bool,
    parse_errors: usize,
}
static HISTORY: OnceLock<Arc<Mutex<Snapshot>>> = OnceLock::new();

pub fn start(dir: PathBuf, home: PathBuf) {
    let state = HISTORY
        .get_or_init(|| {
            Arc::new(Mutex::new(Snapshot {
                scanning: true,
                ..Default::default()
            }))
        })
        .clone();
    std::thread::spawn(move || {
        // v3 tags subagent work; rescan history once to pick it up.
        for old in ["local-metrics-v1.json", "local-metrics-v2.json"] {
            let _ = fs::remove_file(dir.join(old));
        }
        let path = dir.join("local-metrics-v3.json");
        let mut cache: Cache = fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let roots: Vec<_> = crate::harness::all()
            .iter()
            .flat_map(|agent| {
                agent
                    .history_roots(&home)
                    .into_iter()
                    .map(move |root| (root.path, agent.id()))
            })
            .collect();
        loop {
            let mut errors = 0;
            let mut paths = Vec::new();
            for (root, harness) in &roots {
                discover(root, harness, &mut paths, &mut errors);
            }
            let mut changed = false;
            for (file, harness) in &paths {
                match scan(file, harness, cache.files.entry(file.clone()).or_default()) {
                    Ok(did) => changed |= did,
                    Err(_) => errors += 1,
                }
            }
            // Retain cached metrics for histories rotated/deleted by the harness.
            let mut unique: BTreeMap<String, Value> = BTreeMap::new();
            for file in cache.files.values() {
                for (id, row) in &file.rows {
                    let mut row = row.clone();
                    if id.starts_with("local:claude:") && row["type"] == "usage" {
                        if let Some(old) = unique.get(id) {
                            for key in ["inputTokens", "outputTokens", "cacheReadTokens"] {
                                row["usage"][key] =
                                    json!(count(&row["usage"], key).max(count(&old["usage"], key)));
                            }
                        }
                    }
                    unique.insert(id.clone(), row);
                }
            }
            let mut rows: Vec<_> = unique.into_values().collect();
            rows.sort_by_key(|r| r["at"].as_i64().unwrap_or(0));
            if changed {
                if let Err(error) = save(&path, &cache) {
                    eprintln!("Noai usage cache: {error}");
                    errors += 1;
                }
            }
            *state.lock().unwrap() = Snapshot {
                rows,
                files: paths.len(),
                errors,
                updated: crate::scheduler::now_epoch(),
                scanning: false,
                parse_errors: cache.files.values().map(|file| file.parse_errors).sum(),
            };
            std::thread::sleep(Duration::from_secs(30));
        }
    });
}
fn save(path: &Path, cache: &Cache) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    crate::platform::restrict_new_file(&mut options);
    let mut file = options.open(&tmp)?;
    serde_json::to_writer(&mut file, cache)?;
    file.flush()?;
    file.sync_all()?;
    fs::rename(tmp, path)
}
fn discover(
    root: &Path,
    harness: &'static str,
    out: &mut Vec<(PathBuf, &'static str)>,
    errors: &mut usize,
) {
    let entries = match fs::read_dir(root) {
        Ok(v) => v,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
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
            discover(&entry.path(), harness, out, errors)
        } else if kind.is_file() && entry.path().extension().is_some_and(|x| x == "jsonl") {
            out.push((entry.path(), harness));
        }
    }
}
fn scan(path: &Path, harness: &str, state: &mut FileState) -> std::io::Result<bool> {
    let meta = fs::metadata(path)?;
    let modified = meta
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let identity = crate::platform::file_identity(&meta);
    if meta.len() == state.len && modified == state.modified && identity == state.identity {
        return Ok(false);
    }
    if meta.len() < state.offset
        || identity != state.identity
        || (meta.len() == state.len && modified != state.modified)
    {
        *state = FileState::default();
    }
    if state.subagent.is_none() {
        state.subagent = crate::harness::get(harness).and_then(|agent| agent.subagent_type(path));
    }
    let mut reader = BufReader::new(fs::File::open(path)?);
    reader.seek(SeekFrom::Start(state.offset))?;
    let mut line = String::new();
    loop {
        line.clear();
        let size = reader.read_line(&mut line)?;
        if size == 0 || !line.ends_with('\n') {
            break;
        }
        state.offset += size as u64;
        // Avoid parsing the large majority of transcript text and command output.
        if !(line.contains("token_count")
            || line.contains("session_meta")
            || line.contains("turn_context")
            || line.contains("function_call")
            || line.contains("custom_tool_call")
            || line.contains("tool_result")
            || line.contains("api_error")
            || line.contains("stream_error")
            || line.contains("\"type\":\"error\"")
            || line.contains("\"assistant\"")
            || line.contains("\"tokens\":")
            || line.contains("\"projectHash\""))
        {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            parse(harness, &value, state);
        } else {
            state.parse_errors += 1;
        }
    }
    if let Some(kind) = state.subagent.clone() {
        let agent = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        for row in state.rows.values_mut() {
            row["subagent"] = json!(kind);
            row["subagentId"] = json!(agent);
        }
    }
    state.len = meta.len();
    state.modified = modified;
    state.identity = identity;
    Ok(true)
}
pub(crate) fn timestamp(v: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(v["timestamp"].as_str()?)
        .ok()
        .map(|d| d.timestamp())
}
pub(crate) fn count(v: &Value, key: &str) -> u64 {
    v[key].as_u64().unwrap_or(0)
}
pub(crate) fn row(
    id: &str,
    harness: &str,
    session: &str,
    model: &str,
    at: i64,
    kind: &str,
) -> Value {
    json!({"id":id,"at":at,"runId":format!("local:{harness}:{session}"),"sessionId":session,"harness":harness,"model":model,"type":kind,"source":"local"})
}
fn parse(harness: &str, v: &Value, s: &mut FileState) {
    if let Some(agent) = crate::harness::get(harness) {
        agent.metrics_line(v, s);
    }
}

pub fn merge(live: Vec<Value>) -> Value {
    let Some(state) = HISTORY.get() else {
        return json!({"records":live});
    };
    let snapshot = state.lock().unwrap();
    merge_snapshot(live, &snapshot)
}

fn merge_snapshot(mut live: Vec<Value>, snapshot: &Snapshot) -> Value {
    let covered: HashSet<_> = snapshot
        .rows
        .iter()
        .filter_map(|r| {
            Some((
                r["harness"].as_str()?.to_owned(),
                r["sessionId"].as_str()?.to_owned(),
                r["type"].as_str()?.to_owned(),
            ))
        })
        .collect();
    let mut sessions = HashMap::new();
    for r in &live {
        if let (Some(run), Some(session)) = (r["runId"].as_str(), r["sessionId"].as_str()) {
            sessions.insert(run.to_owned(), session.to_owned());
        }
    }
    live.retain(|r| {
        let session = r["sessionId"]
            .as_str()
            .or_else(|| {
                r["runId"]
                    .as_str()
                    .and_then(|id| sessions.get(id).map(String::as_str))
            })
            .unwrap_or("");
        !covered.contains(&(
            r["harness"].as_str().unwrap_or("").to_owned(),
            session.to_owned(),
            r["type"].as_str().unwrap_or("").to_owned(),
        ))
    });
    for r in &mut live {
        if let Some(session) = r["sessionId"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| r["runId"].as_str().and_then(|id| sessions.get(id).cloned()))
        {
            let harness = r["harness"].as_str().unwrap_or("");
            if covered
                .iter()
                .any(|(h, s, _)| h == harness && s == &session)
            {
                r["runId"] = json!(format!("local:{harness}:{session}"));
            }
        }
    }
    live.extend(snapshot.rows.iter().cloned());
    json!({"records":live,"importStatus":{"scanning":snapshot.scanning,"files":snapshot.files,"errors":snapshot.errors,"updatedAt":snapshot.updated,"parseErrors":snapshot.parse_errors}})
}

// Session detail reads only its own file, avoiding unrelated parent/subagent usage.
pub fn file_records(path: &Path, harness: &str) -> Result<Vec<Value>, String> {
    let mut state = FileState::default();
    scan(path, harness, &mut state).map_err(|error| error.to_string())?;
    Ok(state.rows.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imported_sessions_replace_duplicate_live_usage() {
        let imported = json!({"id":"local:codex:s:1","harness":"codex","sessionId":"s","runId":"local:codex:s","type":"usage"});
        let live = vec![
            json!({"id":1,"runId":"r","harness":"codex","type":"session","sessionId":"s"}),
            json!({"id":2,"runId":"r","harness":"codex","type":"usage"}),
        ];
        let result = merge_snapshot(
            live,
            &Snapshot {
                rows: vec![imported],
                ..Default::default()
            },
        );
        assert_eq!(result["records"].as_array().unwrap().len(), 2);
        assert_eq!(result["records"][0]["runId"], "local:codex:s");
    }
    fn codex(input: u64, output: u64) -> Value {
        json!({"timestamp":"2026-10-09T12:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":input,"output_tokens":output,"cached_input_tokens":20}}}})
    }
    #[test]
    fn codex_differences_totals_and_skips_repeated_counts() {
        let mut state = FileState {
            session: "s".into(),
            model: "m".into(),
            ..Default::default()
        };
        parse("codex", &codex(100, 10), &mut state);
        parse("codex", &codex(100, 10), &mut state);
        parse("codex", &codex(160, 15), &mut state);
        assert_eq!(state.rows.len(), 2);
        assert_eq!(
            state
                .rows
                .values()
                .map(|r| count(&r["usage"], "inputTokens"))
                .sum::<u64>(),
            160
        );
        assert_eq!(
            state
                .rows
                .values()
                .map(|r| count(&r["usage"], "outputTokens"))
                .sum::<u64>(),
            15
        );
    }
    #[test]
    fn claude_blocks_and_updated_usage_count_one_message() {
        let mut state = FileState::default();
        let mut v = json!({"type":"assistant","timestamp":"2026-10-09T12:00:00Z","sessionId":"s","message":{"id":"msg","model":"sonnet","usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":20,"cache_creation_input_tokens":30},"content":[{"type":"tool_use","id":"t","name":"Read"}]}});
        parse("claude", &v, &mut state);
        v["message"]["usage"]["output_tokens"] = json!(15);
        parse("claude", &v, &mut state);
        assert_eq!(state.rows.len(), 2);
        assert_eq!(state.rows["local:claude:msg"]["usage"]["inputTokens"], 60);
        assert_eq!(state.rows["local:claude:msg"]["usage"]["outputTokens"], 15);
    }
    #[test]
    fn file_offsets_survive_restart_partial_lines_and_truncation() {
        let root = std::env::temp_dir().join(format!("noai-metrics-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("s.jsonl");
        fs::write(&path, format!("{}\n", codex(100, 10))).unwrap();
        let mut state = FileState::default();
        assert!(scan(&path, "codex", &mut state).unwrap());
        let offset = state.offset;
        assert!(!scan(&path, "codex", &mut state).unwrap());
        state = serde_json::from_slice(&serde_json::to_vec(&state).unwrap()).unwrap();
        let next = serde_json::to_string(&codex(160, 15)).unwrap();
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "{}", &next[..20]).unwrap();
        scan(&path, "codex", &mut state).unwrap();
        assert_eq!(state.offset, offset);
        writeln!(file, "{}", &next[20..]).unwrap();
        scan(&path, "codex", &mut state).unwrap();
        assert_eq!(state.rows.len(), 2);
        fs::write(&path, format!("{}\n", codex(20, 2))).unwrap();
        scan(&path, "codex", &mut state).unwrap();
        assert_eq!(state.rows.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn subagents_are_counted_and_tagged() {
        let root = std::env::temp_dir().join(format!("noai-subagents-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let folder = root.join("proj").join("sess").join("subagents");
        fs::create_dir_all(&folder).unwrap();
        let parent = root.join("proj").join("sess.jsonl");
        let launch = json!({"type":"assistant","timestamp":"2026-11-01T10:00:00Z","sessionId":"sess","message":{"id":"m1","model":"opus","usage":{"input_tokens":5,"output_tokens":5},"content":[{"type":"tool_use","id":"call1","name":"Agent","input":{"subagent_type":"Explore","prompt":"secret"}}]}});
        let result = json!({"type":"user","timestamp":"2026-11-01T10:01:00Z","sessionId":"sess","message":{"content":[{"type":"tool_result","tool_use_id":"call1"}]},"toolUseResult":{"status":"completed","totalDurationMs":60000,"totalTokens":900,"totalToolUseCount":4,"resolvedModel":"haiku"}});
        fs::write(&parent, format!("{launch}\n{result}\n")).unwrap();
        let mut state = FileState::default();
        scan(&parent, "claude", &mut state).unwrap();
        let spawn = &state.rows["local:claude:subagent:call1"];
        assert_eq!(
            (
                spawn["subagentType"].as_str(),
                spawn["status"].as_str(),
                spawn["durationMs"].as_u64(),
                spawn["tokens"].as_u64(),
                spawn["subagentModel"].as_str()
            ),
            (
                Some("Explore"),
                Some("completed"),
                Some(60000),
                Some(900),
                Some("haiku")
            )
        );
        assert!(spawn.get("prompt").is_none() && !spawn.to_string().contains("secret"));

        let child = folder.join("agent-abc.jsonl");
        fs::write(
            folder.join("agent-abc.meta.json"),
            r#"{"agentType":"Explore"}"#,
        )
        .unwrap();
        let work = json!({"type":"assistant","isSidechain":true,"timestamp":"2026-11-01T10:00:30Z","sessionId":"sess","message":{"id":"m2","model":"haiku","usage":{"input_tokens":100,"output_tokens":20}}});
        fs::write(&child, format!("{work}\n")).unwrap();
        let mut state = FileState::default();
        scan(&child, "claude", &mut state).unwrap();
        let usage = &state.rows["local:claude:m2"];
        assert_eq!(
            (
                usage["subagent"].as_str(),
                usage["subagentId"].as_str(),
                usage["sessionId"].as_str()
            ),
            (Some("Explore"), Some("agent-abc"), Some("sess"))
        );
        fs::remove_dir_all(root).unwrap();
    }
}
