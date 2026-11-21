//! Anthropic Claude Code CLI (`claude --print --output-format stream-json`).

use super::{
    config_dir, content_text, token_event, BoxFuture, Harness, HistoryRoot, Permission,
    SessionMessage, SessionMeta, SessionUsage, TokenKeys, Tokens,
};
use crate::adapters::{find_binary, JobPermissions, RunEvent, RunRequest};
use crate::local_metrics::{count, row, timestamp, FileState};
use crate::providers::{
    cache_identity, now, unavailable, HarnessModel, ProviderUsageSnapshot, ProviderUsageWindow,
};
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    time::timeout,
};

pub struct Claude;

const TOKENS_SNAKE: TokenKeys = TokenKeys {
    input: "input_tokens",
    output: "output_tokens",
    cache_read: "cache_read_input_tokens",
    cache_write: "cache_creation_input_tokens",
    input_includes_cache: true,
};
const TOKENS_CAMEL: TokenKeys = TokenKeys {
    input: "inputTokens",
    output: "outputTokens",
    cache_read: "cacheReadInputTokens",
    cache_write: "cacheCreationInputTokens",
    input_includes_cache: true,
};

const PERMISSIONS: &[Permission] = &[
    Permission {
        id: JobPermissions::AutoReview,
        label: "Automatic permission review",
        description: "Claude reviews tool actions automatically. Requires a supported account and model; denials still apply. This is not an operating-system sandbox.",
    },
    Permission {
        id: JobPermissions::ProviderDefault,
        label: "Existing CLI settings",
        description: "Keep Claude Code’s configured permissions. Actions that need approval are denied, since nobody is there to answer.",
    },
];

impl Harness for Claude {
    fn id(&self) -> &'static str {
        "claude"
    }
    fn label(&self) -> &'static str {
        "Claude Code"
    }
    fn permissions(&self) -> &'static [Permission] {
        PERMISSIONS
    }
    fn read_only(&self) -> JobPermissions {
        // dontAsk: anything needing approval is denied, so no edits or commands.
        JobPermissions::ProviderDefault
    }
    fn bypass_description(&self) -> &'static str {
        "Skip Claude Code tool permission checks."
    }

    fn args(&self, request: &RunRequest) -> Vec<String> {
        let mut args: Vec<String> = vec![
            "--print".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
        ];
        if request.dangerously_bypass_permissions {
            args.push("--dangerously-skip-permissions".into());
        } else {
            // Headless approval requests cannot be answered through this adapter.
            let mode = if request.permissions == Some(JobPermissions::AutoReview) {
                "auto"
            } else {
                "dontAsk"
            };
            args.extend(["--permission-mode".into(), mode.into()]);
        }
        if let Some(resume_id) = &request.resume_id {
            args.extend(["--resume".into(), resume_id.clone()]);
        }
        if let Some(model) = &request.model {
            args.extend(["--model".into(), model.clone()]);
        }
        args
    }

    fn parse(&self, request: &RunRequest, value: &Value) -> Vec<RunEvent> {
        parse_claude(request, value)
    }

    fn models(&self) -> BoxFuture<Vec<HarnessModel>> {
        Box::pin(claude_models())
    }

    fn configured_models(&self, home: &Path) -> Vec<String> {
        let dir = config_dir(home, "CLAUDE_CONFIG_DIR", ".claude");
        let settings: Vec<Value> = ["settings.json", "settings.local.json"]
            .iter()
            .filter_map(|name| std::fs::read_to_string(dir.join(name)).ok())
            .filter_map(|text| serde_json::from_str(&text).ok())
            .collect();
        let env: Vec<(String, String)> = std::env::vars().collect();
        claude_configured_models(&settings, &env)
    }

    fn usage(&self) -> BoxFuture<ProviderUsageSnapshot> {
        Box::pin(claude_usage())
    }

    fn identity(&self) -> BoxFuture<Option<String>> {
        Box::pin(async {
            claude_auth()
                .await
                .ok()
                .and_then(|auth| claude_identity(&auth))
        })
    }

    fn exhausted_reset(&self, now_epoch: u64) -> BoxFuture<Option<u64>> {
        Box::pin(async move {
            let (at, info) = read_limits()?;
            // Only a fresh report may postpone a retry.
            if now_epoch.saturating_sub(at) > 15 * 60 {
                return None;
            }
            limit_windows(&info)
                .into_iter()
                .filter(|window| window.used_percent.is_some_and(|used| used >= 100.0))
                .filter_map(|window| window.resets_at)
                .filter(|reset| *reset > now_epoch && *reset - now_epoch <= 8 * 24 * 3600)
                .max()
        })
    }

    fn history_roots(&self, home: &Path) -> Vec<HistoryRoot> {
        vec![HistoryRoot {
            path: config_dir(home, "CLAUDE_CONFIG_DIR", ".claude").join("projects"),
            archived: false,
        }]
    }

    fn session_meta(&self, line: &Value) -> SessionMeta {
        SessionMeta {
            session_id: line["sessionId"].as_str().map(str::to_owned),
            project_path: line["cwd"].as_str().map(str::to_owned),
            model: line["message"]["model"]
                .as_str()
                .filter(|model| *model != "<synthetic>")
                .map(str::to_owned),
        }
    }

    fn session_message(&self, line: &Value) -> Option<SessionMessage> {
        if !matches!(line["type"].as_str(), Some("user" | "assistant")) {
            return None;
        }
        let mut activities = Vec::new();
        let blocks = &line["message"]["content"];
        let text = if let Some(blocks) = blocks.as_array() {
            let mut texts = Vec::new();
            for block in blocks {
                match block["type"].as_str() {
                    Some("text") => {
                        if let Some(text) = block["text"].as_str() {
                            texts.push(text.to_owned());
                        }
                    }
                    Some("thinking") => {
                        if let Some(text) = block["thinking"].as_str() {
                            activities.push(json!({"kind":"thinking","text":text}));
                        }
                    }
                    Some("tool_use" | "tool_result") => {
                        activities.push(json!({"kind":"tool","text":content_text(&json!([block]))}))
                    }
                    _ => {} // Encrypted/redacted thinking has no readable text.
                }
            }
            texts.join("\n\n")
        } else {
            content_text(blocks)
        };
        Some(SessionMessage {
            role: line["message"]["role"]
                .as_str()
                .unwrap_or("assistant")
                .into(),
            text,
            activities,
        })
    }

    fn session_usage(&self, v: &Value, usage: &mut SessionUsage) {
        if v["type"] != "assistant" {
            return;
        }
        let m = &v["message"];
        let (Some(id), Some(u)) = (m["id"].as_str(), m["usage"].as_object()) else {
            return;
        };
        let model = m["model"].as_str().unwrap_or("");
        if model == "<synthetic>" {
            return;
        }
        let read = |key: &str| u.get(key).and_then(Value::as_u64).unwrap_or(0);
        let call = Tokens {
            input: read("input_tokens"),
            cache_read: read("cache_read_input_tokens"),
            cache_write: read("cache_creation_input_tokens"),
            output: read("output_tokens"),
        };
        let call = usage
            .calls
            .get(id)
            .map_or(call, |previous| previous.max(call));
        usage.calls.insert(id.to_owned(), call);
        if !v["isSidechain"].as_bool().unwrap_or(false) {
            let used = call.total();
            usage.context_used = Some(used);
            usage.context_window = Some(context_window(model, used));
        }
    }

    fn subagent_parent(&self, path: &Path) -> Option<PathBuf> {
        // <project>/<session id>/subagents/agent-*.jsonl belongs to <project>/<session id>.jsonl.
        let folder = path.parent()?;
        if folder.file_name()? != "subagents" {
            return None;
        }
        Some(folder.parent()?.with_extension("jsonl"))
    }

    fn metrics_line(&self, v: &Value, s: &mut FileState) {
        let harness = self.id();
        match v["type"].as_str() {
            Some("user") => return outcome_rows(harness, v, s),
            Some("system") if v["subtype"] == "api_error" => return api_error_row(harness, v, s),
            Some("assistant") => {}
            _ => return,
        }
        let m = &v["message"];
        let Some(message) = m["id"].as_str() else {
            return;
        };
        let Some(at) = timestamp(v) else { return };
        let session = v["sessionId"].as_str().unwrap_or("");
        let model = m["model"].as_str().unwrap_or("");
        if model == "<synthetic>" {
            return;
        }
        s.model = model.into();
        let id = format!("local:claude:{message}");
        let u = &m["usage"];
        if u.is_object() {
            let cached = count(u, "cache_read_input_tokens");
            let input = count(u, "input_tokens") + cached + count(u, "cache_creation_input_tokens");
            let mut r = row(&id, harness, session, model, at, "usage");
            r["usage"] = json!({"kind":"tokens","scope":"turn","inputTokens":input,"outputTokens":count(u,"output_tokens"),"cacheReadTokens":cached});
            // Multiple content blocks share one message; final snapshots can raise output usage.
            if let Some(old) = s.rows.get(&id) {
                for key in ["inputTokens", "outputTokens", "cacheReadTokens"] {
                    r["usage"][key] = json!(count(&r["usage"], key).max(count(&old["usage"], key)));
                }
            }
            s.rows.insert(id, r);
        }
        if let Some(blocks) = m["content"].as_array() {
            for block in blocks {
                if block["type"] == "tool_use" {
                    if let Some(tool) = block["id"].as_str() {
                        let id = format!("local:claude:tool:{tool}");
                        let mut r = row(&id, harness, session, model, at, "activity");
                        r["tool"] = block["name"].clone();
                        s.rows.insert(id, r);
                    }
                }
            }
        }
    }
}

/// Context window size. Transcripts don't record the 1M-token option, so a call
/// past 200K is the only sign of it.
fn context_window(model: &str, used: u64) -> u64 {
    if model.contains("[1m]") || used > 200_000 {
        1_000_000
    } else {
        200_000
    }
}

/// One outcome row per tool result: `tool_ok`, or `tool_error` when the tool failed.
fn outcome_rows(harness: &str, v: &Value, s: &mut FileState) {
    let Some(blocks) = v["message"]["content"].as_array() else {
        return;
    };
    let Some(at) = timestamp(v) else { return };
    let session = v["sessionId"].as_str().unwrap_or("");
    for block in blocks.iter().filter(|block| block["type"] == "tool_result") {
        let Some(call) = block["tool_use_id"].as_str() else {
            continue;
        };
        let id = format!("local:claude:result:{call}");
        let mut r = row(&id, harness, session, &s.model, at, "outcome");
        r["outcome"] = json!(if block["is_error"] == true {
            "tool_error"
        } else {
            "tool_ok"
        });
        s.rows.insert(id, r);
    }
}

/// A failed API request that Claude Code retried or gave up on.
fn api_error_row(harness: &str, v: &Value, s: &mut FileState) {
    let (Some(uuid), Some(at)) = (v["uuid"].as_str(), timestamp(v)) else {
        return;
    };
    let error = &v["error"];
    let outcome = if error["connection"].is_object() || error["isNetworkDown"] == true {
        "connection_error"
    } else if !error["rateLimits"].is_null() || error["status"] == 429 {
        "rate_limit"
    } else {
        "api_error"
    };
    let id = format!("local:claude:api-error:{uuid}");
    let session = v["sessionId"].as_str().unwrap_or("");
    let mut r = row(&id, harness, session, &s.model, at, "outcome");
    r["outcome"] = json!(outcome);
    if let Some(code) = error["connection"]["code"]
        .as_str()
        .or(error["status"].as_str())
    {
        r["code"] = json!(code);
    } else if let Some(status) = error["status"].as_u64() {
        r["code"] = json!(status.to_string());
    }
    s.rows.insert(id, r);
}

fn parse_claude(request: &RunRequest, value: &Value) -> Vec<RunEvent> {
    let mut events = Vec::new();
    if let Some(id) = value.get("session_id").and_then(Value::as_str) {
        let mut event = RunEvent::new(request, "session", None);
        event.resume_id = Some(id.to_owned());
        events.push(event);
    }
    if value["type"] == "result" {
        if let Some(models) = value
            .get("modelUsage")
            .and_then(Value::as_object)
            .filter(|models| !models.is_empty())
        {
            for (model, counts) in models {
                if let Some(mut event) = token_event(request, counts, &TOKENS_CAMEL, true, true) {
                    event.model = Some(model.clone());
                    event.resume_id = value["session_id"]
                        .as_str()
                        .map(str::to_owned)
                        .or_else(|| request.resume_id.clone());
                    events.push(event);
                }
            }
        } else if let Some(mut event) =
            token_event(request, &value["usage"], &TOKENS_SNAKE, false, false)
        {
            event.resume_id = value["session_id"].as_str().map(str::to_owned);
            events.push(event);
        }
    }
    match value.get("type").and_then(Value::as_str).unwrap_or("") {
        "rate_limit_event" => {
            let info = value.get("rate_limit_info").unwrap_or(value);
            record_limits(info);
            let mut usage = serde_json::Map::new();
            for key in [
                "status",
                "resetsAt",
                "resets_at",
                "rateLimitType",
                "rate_limit_type",
            ] {
                if let Some(item) = info.get(key) {
                    if item.is_string() || item.is_number() {
                        usage.insert(key.to_owned(), item.clone());
                    }
                }
            }
            if !usage.is_empty() {
                let mut event = RunEvent::new(request, "usage", None);
                event.usage = Some(Value::Object(usage));
                events.push(event);
            }
        }
        "assistant" => {
            if let Some(blocks) = value["message"]["content"].as_array() {
                for block in blocks {
                    match block.get("type").and_then(Value::as_str).unwrap_or("") {
                        "text" => {
                            if let Some(text) = block.get("text").and_then(Value::as_str) {
                                events.push(RunEvent::new(request, "text", Some(text.into())));
                            }
                        }
                        "tool_use" => events.push(RunEvent::new(
                            request,
                            "activity",
                            block.get("name").and_then(Value::as_str).map(str::to_owned),
                        )),
                        _ => {}
                    }
                }
            }
        }
        "result" if value["is_error"].as_bool() == Some(true) => {
            events.push(RunEvent::new(
                request,
                "error",
                value["result"].as_str().map(str::to_owned).or_else(|| {
                    value["errors"].as_array().map(|errors| {
                        errors
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                }),
            ));
        }
        _ => {}
    }
    for event in &mut events {
        if event.kind != "usage" {
            if let Some(model) = value["message"]["model"].as_str() {
                event.model = Some(model.into());
            }
        }
    }
    events
}

/// Model aliases the installed Claude Code advertises in `claude --help`
/// (its `--model` text names the current aliases). No CLI, no models.
async fn claude_models() -> Vec<HarnessModel> {
    let Some(binary) = find_binary("claude") else {
        return vec![];
    };
    let output = timeout(
        Duration::from_secs(8),
        Command::new(&binary)
            .arg("--help")
            .env("PATH", crate::platform::child_path(&binary))
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let help = match output {
        Ok(Ok(output)) => String::from_utf8_lossy(&output.stdout).into_owned(),
        _ => String::new(),
    };
    // Only what the installed CLI documents; models from settings and history
    // are added elsewhere.
    claude_aliases(&help)
        .into_iter()
        .map(|id| {
            let mut label = id.clone();
            if let Some(first) = label.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            HarnessModel {
                label: format!("{label} (latest)"),
                id,
                source: "agent",
            }
        })
        .collect()
}

/// Environment variables Claude Code reads to pick or remap models.
const CLAUDE_MODEL_VARS: &[&str] = &[
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
];

/// Model IDs from Claude Code settings (`model`, `availableModels`, and the
/// model variables in its `env` block) and from the process environment.
/// Only these keys are read; other settings and secrets are ignored.
fn claude_configured_models(settings: &[Value], env: &[(String, String)]) -> Vec<String> {
    let mut found = Vec::new();
    let mut add = |value: &str| {
        let value = value.trim();
        if !value.is_empty()
            && value.len() <= 120
            && !found.iter().any(|known: &String| known == value)
        {
            found.push(value.to_owned());
        }
    };
    for file in settings {
        if let Some(model) = file["model"].as_str() {
            add(model);
        }
        for model in file["availableModels"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            add(model);
        }
        for name in CLAUDE_MODEL_VARS {
            if let Some(model) = file["env"][name].as_str() {
                add(model);
            }
        }
    }
    for (name, value) in env {
        if CLAUDE_MODEL_VARS.contains(&name.as_str()) {
            add(value);
        }
    }
    found
}

/// Quoted aliases from the `--model` option's description in `claude --help`.
fn claude_aliases(help: &str) -> Vec<String> {
    let Some(start) = help.find("--model ") else {
        return vec![];
    };
    let rest = &help[start + 8..];
    let end = rest.find("\n  -").unwrap_or(rest.len());
    let mut aliases: Vec<String> = Vec::new();
    for (index, part) in rest[..end].split('\'').enumerate() {
        let valid = index % 2 == 1
            && !part.is_empty()
            && part.len() <= 32
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.[]".contains(c));
        if valid && !aliases.iter().any(|alias| alias == part) {
            aliases.push(part.to_owned());
        }
    }
    aliases
}

async fn claude_auth() -> Result<Value, ()> {
    let binary = find_binary("claude").ok_or(())?;
    let output = timeout(
        Duration::from_secs(6),
        Command::new(binary)
            .args(["auth", "status", "--json"])
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?;
    if !output.status.success() || output.stdout.len() > 100_000 {
        return Err(());
    }
    serde_json::from_slice(&output.stdout).map_err(|_| ())
}

fn claude_identity(auth: &Value) -> Option<String> {
    for key in ["accountUuid", "accountId", "userId", "email"] {
        if let Some(value) = auth
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            return Some(format!("claude:{value}"));
        }
    }
    None
}

async fn claude_usage() -> ProviderUsageSnapshot {
    match claude_auth().await {
        Ok(auth) => {
            cache_identity("claude", claude_identity(&auth));
            if read_limits().is_none_or(|(at, _)| now().saturating_sub(at) > PROBE_AFTER) {
                probe_limits().await;
            }
            let report = read_limits();
            let windows = report
                .as_ref()
                .map(|(_, info)| limit_windows(info))
                .unwrap_or_default();
            let available = !windows.is_empty();
            ProviderUsageSnapshot { id: "claude", label: "Claude Code",
                account_label: auth.get("email").and_then(Value::as_str).map(str::to_owned),
                plan: auth.get("subscriptionType").or_else(|| auth.get("plan"))
                    .and_then(Value::as_str).map(str::to_owned),
                source: "cli",
                status: if available { "available" } else { "unavailable" },
                fetched_at: report.map(|(at, _)| at).or(Some(now())),
                windows,
                detail: Some(if available {
                    "Reported by Claude Code with each run. When it is older than 10 minutes, Noai sends one tiny Haiku request to refresh it."
                } else {
                    "Claude Code did not report its limits. This account may not have usage windows, or the CLI could not be reached."
                }.into()) }
        }
        Err(_) => {
            cache_identity("claude", None);
            unavailable(
                "claude",
                "Claude Code",
                "Claude CLI authentication status is unavailable.",
            )
        }
    }
}

/// Refresh the cached report when it is older than this, in seconds.
const PROBE_AFTER: u64 = 10 * 60;

fn limits_path() -> Option<PathBuf> {
    crate::platform::app_data_dir()
        .ok()
        .map(|dir| dir.join("claude-limits.json"))
}

/// Saves the latest `rate_limit_info` (status, utilization and reset times only)
/// so the app and the daemon share it.
fn record_limits(info: &Value) {
    if cfg!(test) || !info["unifiedWindows"].is_object() {
        return;
    }
    let Some(path) = limits_path() else { return };
    let mut windows = serde_json::Map::new();
    for (key, window) in info["unifiedWindows"].as_object().into_iter().flatten() {
        windows.insert(
            key.clone(),
            json!({"utilization":window["utilization"],"resetsAt":window["resetsAt"],"status":window["status"]}),
        );
    }
    let saved = json!({"at":now(),"info":{"status":info["status"],"unifiedWindows":windows}});
    let tmp = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    crate::platform::restrict_new_file(&mut options);
    let written = options
        .open(&tmp)
        .and_then(|mut file| file.write_all(saved.to_string().as_bytes()))
        .and_then(|_| std::fs::rename(&tmp, &path));
    if let Err(error) = written {
        eprintln!("Noai Claude limits: {error}");
    }
}

fn read_limits() -> Option<(u64, Value)> {
    let saved: Value = serde_json::from_slice(&std::fs::read(limits_path()?).ok()?).ok()?;
    Some((saved["at"].as_u64()?, saved["info"].clone()))
}

fn limit_windows(info: &Value) -> Vec<ProviderUsageWindow> {
    let mut windows: Vec<_> = info["unifiedWindows"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, window)| {
            let used = if window["status"] == "rejected" {
                100.0
            } else {
                window["utilization"].as_f64()? * 100.0
            };
            let label = match key.as_str() {
                "five_hour" => "5-hour limit".to_owned(),
                "seven_day" => "Weekly limit".to_owned(),
                other => match other.strip_prefix("seven_day_") {
                    Some(model) => format!("Weekly · {}", capitalize(model)),
                    None => capitalize(&other.replace('_', " ")),
                },
            };
            Some(ProviderUsageWindow {
                label,
                unit: None,
                used_percent: Some(used.clamp(0.0, 100.0)),
                remaining: None,
                limit: None,
                resets_at: window["resetsAt"].as_u64(),
            })
        })
        .collect();
    let rank = |label: &str| match label {
        "5-hour limit" => 0,
        "Weekly limit" => 1,
        _ => 2,
    };
    windows.sort_by(|a, b| {
        rank(&a.label)
            .cmp(&rank(&b.label))
            .then(a.label.cmp(&b.label))
    });
    windows
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// Claude Code reports limits only while it runs, so ask it something tiny:
/// Haiku, no tools, nothing saved to history.
async fn probe_limits() {
    static PROBING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let Ok(_guard) = PROBING.try_lock() else {
        return;
    };
    let Some(binary) = find_binary("claude") else {
        return;
    };
    let child = Command::new(binary)
        .args([
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            "haiku",
            "--tools",
            "",
            "--no-session-persistence",
        ])
        .current_dir(std::env::temp_dir())
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"Reply with OK.").await;
    }
    let Some(stdout) = child.stdout.take() else {
        return;
    };
    let read = async {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.contains("rate_limit_event") {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                record_limits(&value["rate_limit_info"]);
                return;
            }
        }
    };
    let _ = timeout(Duration::from_secs(60), read).await;
    let _ = child.kill().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_models_come_from_settings_and_env_only() {
        let settings = vec![
            json!({"model": "claude-opus-5-5", "env": {"ANTHROPIC_DEFAULT_HAIKU_MODEL": "my-proxy/haiku", "ANTHROPIC_API_KEY": "secret"}}),
            json!({"availableModels": ["sonnet", "claude-opus-5-5"]}),
        ];
        let env = vec![
            ("ANTHROPIC_MODEL".to_owned(), "bedrock/claude".to_owned()),
            ("HOME".to_owned(), "/h".to_owned()),
        ];
        assert_eq!(
            claude_configured_models(&settings, &env),
            [
                "claude-opus-5-5",
                "my-proxy/haiku",
                "sonnet",
                "bedrock/claude"
            ]
        );
        assert!(claude_configured_models(&[], &[]).is_empty());
    }

    #[test]
    fn no_aliases_means_no_models() {
        assert!(claude_aliases("Usage: claude [options]").is_empty());
    }

    #[test]
    fn limit_report_becomes_labelled_windows() {
        let info = json!({"status":"allowed","unifiedWindows":{
            "seven_day":{"utilization":0.27,"resetsAt":200,"status":"allowed"},
            "five_hour":{"utilization":0.09,"resetsAt":100,"status":"allowed"},
            "seven_day_opus":{"utilization":0.5,"resetsAt":300,"status":"rejected"}}});
        let windows = limit_windows(&info);
        let labels: Vec<_> = windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, ["5-hour limit", "Weekly limit", "Weekly · Opus"]);
        assert_eq!(windows[0].used_percent, Some(9.0));
        assert_eq!(windows[0].resets_at, Some(100));
        assert_eq!(windows[2].used_percent, Some(100.0));
        assert!(limit_windows(&json!({"status":"allowed"})).is_empty());
    }

    #[test]
    fn session_usage_counts_each_call_once_and_tracks_context() {
        let mut usage = SessionUsage::default();
        let mut line = json!({"type":"assistant","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":10,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200,"output_tokens":5}}});
        Claude.session_usage(&line, &mut usage);
        line["message"]["usage"]["output_tokens"] = json!(40);
        Claude.session_usage(&line, &mut usage);
        assert_eq!(
            usage.tokens(),
            Tokens {
                input: 10,
                cache_read: 1000,
                cache_write: 200,
                output: 40
            }
        );
        assert_eq!(usage.context_used, Some(1250));
        assert_eq!(usage.context_window, Some(200_000));
        let side = json!({"type":"assistant","isSidechain":true,"message":{"id":"m2","model":"x","usage":{"input_tokens":1,"output_tokens":1}}});
        Claude.session_usage(&side, &mut usage);
        assert_eq!(usage.context_used, Some(1250));
        assert_eq!(usage.tokens().total(), 1252);
    }

    #[test]
    fn subagent_transcripts_point_at_their_parent() {
        let child = Path::new("/p/proj/abc/subagents/agent-1.jsonl");
        assert_eq!(
            Claude.subagent_parent(child),
            Some(PathBuf::from("/p/proj/abc.jsonl"))
        );
        assert_eq!(Claude.subagent_parent(Path::new("/p/proj/abc.jsonl")), None);
    }

    #[test]
    fn tool_results_and_api_errors_become_outcomes() {
        let mut state = FileState::default();
        let results = json!({"type":"user","timestamp":"2026-11-19T10:00:00Z","sessionId":"s","message":{"content":[
            {"type":"tool_result","tool_use_id":"a","content":"ok"},
            {"type":"tool_result","tool_use_id":"b","is_error":true,"content":"failed"}]}});
        Claude.metrics_line(&results, &mut state);
        let offline = json!({"type":"system","subtype":"api_error","uuid":"u1","timestamp":"2026-11-19T10:01:00Z","sessionId":"s",
            "error":{"connection":{"code":"ENOTFOUND"},"isNetworkDown":true,"rateLimits":null}});
        Claude.metrics_line(&offline, &mut state);
        let server = json!({"type":"system","subtype":"api_error","uuid":"u2","timestamp":"2026-11-19T10:02:00Z","sessionId":"s",
            "error":{"status":529,"rateLimits":null}});
        Claude.metrics_line(&server, &mut state);
        let outcome = |id: &str| state.rows[id]["outcome"].clone();
        assert_eq!(outcome("local:claude:result:a"), "tool_ok");
        assert_eq!(outcome("local:claude:result:b"), "tool_error");
        assert_eq!(outcome("local:claude:api-error:u1"), "connection_error");
        assert_eq!(state.rows["local:claude:api-error:u1"]["code"], "ENOTFOUND");
        assert_eq!(outcome("local:claude:api-error:u2"), "api_error");
        assert_eq!(state.rows["local:claude:api-error:u2"]["code"], "529");
    }

    #[test]
    fn claude_aliases_come_from_the_model_option_only() {
        let help = "Options:\n  --model <model>   Model for the current session. Use an\n                    alias for the latest model (e.g.\n                    'fable', 'opus', or 'sonnet') or a\n                    model's full name.\n  --agent <agent>   Use 'review' agent\n";
        assert_eq!(claude_aliases(help), ["fable", "opus", "sonnet"]);
        assert!(claude_aliases("no options here").is_empty());
    }
}
