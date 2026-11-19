//! Anthropic Claude Code CLI (`claude --print --output-format stream-json`).

use super::{
    config_dir, content_text, token_event, BoxFuture, Harness, HistoryRoot, Permission,
    SessionMessage, SessionMeta, TokenKeys,
};
use crate::adapters::{find_binary, JobPermissions, RunEvent, RunRequest};
use crate::local_metrics::{count, row, timestamp, FileState};
use crate::providers::{cache_identity, now, unavailable, HarnessModel, ProviderUsageSnapshot};
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{process::Command, time::timeout};

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

    fn usage(&self) -> BoxFuture<ProviderUsageSnapshot> {
        Box::pin(claude_usage())
    }

    fn identity(&self) -> BoxFuture<Option<String>> {
        Box::pin(async { claude_auth().await.ok().and_then(|auth| claude_identity(&auth)) })
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
                    Some("tool_use" | "tool_result") => activities
                        .push(json!({"kind":"tool","text":content_text(&json!([block]))})),
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

    fn metrics_line(&self, v: &Value, s: &mut FileState) {
        let harness = self.id();
        if v["type"] != "assistant" {
            return;
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
        } else if let Some(mut event) = token_event(request, &value["usage"], &TOKENS_SNAKE, false, false) {
            event.resume_id = value["session_id"].as_str().map(str::to_owned);
            events.push(event);
        }
    }
    match value.get("type").and_then(Value::as_str).unwrap_or("") {
        "rate_limit_event" => {
            let info = value.get("rate_limit_info").unwrap_or(value);
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
    let mut aliases = claude_aliases(&help);
    if aliases.is_empty() {
        aliases = ["opus", "sonnet", "haiku"].map(String::from).to_vec();
    }
    aliases
        .into_iter()
        .map(|id| {
            let mut label = id.clone();
            if let Some(first) = label.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            HarnessModel {
                label: format!("{label} (latest)"),
                id,
            }
        })
        .collect()
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
            ProviderUsageSnapshot { id: "claude", label: "Claude Code",
                account_label: auth.get("email").and_then(Value::as_str).map(str::to_owned),
                plan: auth.get("subscriptionType").or_else(|| auth.get("plan"))
                    .and_then(Value::as_str).map(str::to_owned),
                source: "cli", status: "unavailable", fetched_at: Some(now()), windows: vec![],
                detail: Some("Claude CLI reports sign-in status but does not expose current subscription usage here.".into()) }
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


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_aliases_come_from_the_model_option_only() {
        let help = "Options:\n  --model <model>   Model for the current session. Use an\n                    alias for the latest model (e.g.\n                    'fable', 'opus', or 'sonnet') or a\n                    model's full name.\n  --agent <agent>   Use 'review' agent\n";
        assert_eq!(claude_aliases(help), ["fable", "opus", "sonnet"]);
        assert!(claude_aliases("no options here").is_empty());
    }
}
