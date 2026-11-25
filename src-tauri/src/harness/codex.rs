//! OpenAI Codex CLI (`codex exec --json`).

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
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    time::timeout,
};

pub struct Codex;

const TOKENS: TokenKeys = TokenKeys {
    input: "input_tokens",
    output: "output_tokens",
    cache_read: "cached_input_tokens",
    cache_write: "cache_creation_input_tokens",
    input_includes_cache: false,
};

const PERMISSIONS: &[Permission] = &[
    Permission {
        id: JobPermissions::WorkspaceNetwork,
        label: "Project + network",
        description: "Edit files and run commands in the project, with network access. Codex’s sandbox stays enabled; actions outside its permissions are denied without prompting.",
    },
    Permission {
        id: JobPermissions::WorkspaceWrite,
        label: "Project only · offline",
        description: "Edit files and run commands in the project. Shell network access is disabled; actions outside the sandbox are denied without prompting.",
    },
    Permission {
        id: JobPermissions::ReadOnly,
        label: "Read only",
        description: "Inspect files without changing them. No interactive approval prompts.",
    },
    Permission {
        id: JobPermissions::ProviderDefault,
        label: "Existing CLI settings",
        description: "Keep Codex’s configured permissions. Codex exec normally defaults to read-only.",
    },
];

impl Harness for Codex {
    fn id(&self) -> &'static str {
        "codex"
    }
    fn label(&self) -> &'static str {
        "Codex"
    }
    fn permissions(&self) -> &'static [Permission] {
        PERMISSIONS
    }
    fn read_only(&self) -> JobPermissions {
        JobPermissions::ReadOnly
    }
    fn bypass_description(&self) -> &'static str {
        "Skip tool approvals and the Codex sandbox."
    }

    fn args(&self, request: &RunRequest) -> Vec<String> {
        let mut args = vec!["exec".to_owned()];
        if request.resume_id.is_some() {
            args.push("resume".into());
        }
        args.extend(["--json".into(), "--skip-git-repo-check".into()]);
        if request.dangerously_bypass_permissions {
            args.push("--dangerously-bypass-approvals-and-sandbox".into());
        } else if let Some(permissions) = request
            .permissions
            .filter(|mode| *mode != JobPermissions::ProviderDefault)
        {
            // Config overrides are supported by both exec and exec resume.
            let sandbox = if permissions == JobPermissions::ReadOnly {
                "read-only"
            } else {
                "workspace-write"
            };
            args.extend([
                "-c".into(),
                format!("sandbox_mode=\"{sandbox}\""),
                "-c".into(),
                "approval_policy=\"never\"".into(),
                "-c".into(),
                format!(
                    "sandbox_workspace_write.network_access={}",
                    permissions == JobPermissions::WorkspaceNetwork
                ),
            ]);
        }
        if let Some(model) = &request.model {
            args.extend(["--model".into(), model.clone()]);
        }
        if let Some(resume_id) = &request.resume_id {
            args.push(resume_id.clone());
        }
        args.push("-".into());
        args
    }

    fn parse(&self, request: &RunRequest, value: &Value) -> Vec<RunEvent> {
        parse_codex(request, value)
    }

    fn local_clock_resets(&self) -> bool {
        // Codex formats time-only reset messages in the host's local timezone.
        true
    }

    fn models(&self) -> BoxFuture<Vec<HarnessModel>> {
        Box::pin(async {
            let Ok(results) = codex_requests(vec![(
                "model/list",
                json!({"limit":100,"includeHidden":false}),
            )])
            .await
            else {
                return vec![];
            };
            results[0]["data"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|model| {
                    let id = model.get("model").or_else(|| model.get("id"))?.as_str()?;
                    Some(HarnessModel {
                        id: id.into(),
                        label: model["displayName"].as_str().unwrap_or(id).into(),
                        source: "agent",
                    })
                })
                .collect()
        })
    }

    fn configured_models(&self, home: &Path) -> Vec<String> {
        let path = config_dir(home, "CODEX_HOME", ".codex").join("config.toml");
        std::fs::read_to_string(path)
            .map(|text| codex_configured_models(&text))
            .unwrap_or_default()
    }

    fn usage(&self) -> BoxFuture<ProviderUsageSnapshot> {
        Box::pin(codex_usage())
    }

    fn identity(&self) -> BoxFuture<Option<String>> {
        Box::pin(async {
            codex_query()
                .await
                .ok()
                .and_then(|(account, limits)| codex_identity(&account, &limits))
        })
    }

    fn exhausted_reset(&self, now_epoch: u64) -> BoxFuture<Option<u64>> {
        Box::pin(async move {
            let (account, limits) = codex_query().await.ok()?;
            codex_snapshot(&account, &limits)
                .windows
                .iter()
                .filter(|window| window.used_percent.is_some_and(|used| used >= 100.0))
                .filter_map(|window| window.resets_at)
                .filter(|reset| *reset > now_epoch && *reset - now_epoch <= 8 * 24 * 3600)
                .max()
        })
    }

    fn history_roots(&self, home: &Path) -> Vec<HistoryRoot> {
        let root = config_dir(home, "CODEX_HOME", ".codex");
        vec![
            HistoryRoot {
                path: root.join("sessions"),
                archived: false,
            },
            HistoryRoot {
                path: root.join("archived_sessions"),
                archived: true,
            },
        ]
    }

    fn session_meta(&self, line: &Value) -> SessionMeta {
        let payload = &line["payload"];
        match line["type"].as_str() {
            Some("session_meta") => SessionMeta {
                session_id: payload["id"].as_str().map(str::to_owned),
                project_path: Some(payload["cwd"].as_str().unwrap_or("").to_owned()),
                model: None,
            },
            Some("turn_context") => SessionMeta {
                model: payload["model"].as_str().map(str::to_owned),
                ..SessionMeta::default()
            },
            _ => SessionMeta::default(),
        }
    }

    fn session_message(&self, line: &Value) -> Option<SessionMessage> {
        if line["type"] != "response_item" {
            return None;
        }
        let payload = &line["payload"];
        let (role, text) = match payload["type"].as_str()? {
            "message" => (
                payload["role"].as_str().unwrap_or("assistant"),
                content_text(&payload["content"]),
            ),
            "reasoning" => ("thinking", content_text(&payload["summary"])),
            "function_call" | "custom_tool_call" => (
                "tool",
                format!(
                    "{}\n{}",
                    payload["name"].as_str().unwrap_or("Tool"),
                    payload["arguments"]
                        .as_str()
                        .or(payload["input"].as_str())
                        .unwrap_or("")
                ),
            ),
            "function_call_output" | "custom_tool_call_output" => {
                ("tool", content_text(&payload["output"]))
            }
            _ => return None,
        };
        Some(SessionMessage {
            role: role.into(),
            text,
            activities: Vec::new(),
        })
    }

    fn session_usage(&self, v: &Value, usage: &mut SessionUsage) {
        let info = &v["payload"]["info"];
        if v["type"] != "event_msg" || v["payload"]["type"] != "token_count" || !info.is_object() {
            return;
        }
        let total = &info["total_token_usage"];
        if total.is_object() {
            // Codex reports running totals; input includes cached input.
            let input = count(total, "input_tokens");
            let cached = count(total, "cached_input_tokens").min(input);
            usage.calls.insert(
                "total".into(),
                Tokens {
                    input: input - cached,
                    cache_read: cached,
                    cache_write: 0,
                    output: count(total, "output_tokens"),
                },
            );
        }
        let last = &info["last_token_usage"];
        if last.is_object() {
            let used = last["total_tokens"]
                .as_u64()
                .unwrap_or_else(|| count(last, "input_tokens") + count(last, "output_tokens"));
            usage.context_used = Some(used);
        }
        if let Some(window) = info["model_context_window"].as_u64() {
            usage.context_window = Some(window);
        }
    }

    fn metrics_line(&self, v: &Value, s: &mut FileState) {
        let harness = self.id();
        let p = &v["payload"];
        match v["type"].as_str().unwrap_or("") {
            "session_meta" => {
                if let Some(id) = p["id"].as_str() {
                    s.session = id.into();
                }
                // A thread Codex started for a subagent says so in its source.
                let spawned = &p["source"]["subagent"];
                if !spawned.is_null() {
                    s.subagent = Some(
                        p["agent_role"]
                            .as_str()
                            .or_else(|| spawned["thread_spawn"]["agent_role"].as_str())
                            .or_else(|| spawned.as_str())
                            .unwrap_or("subagent")
                            .to_string(),
                    );
                }
                return;
            }
            "turn_context" => {
                if let Some(model) = p["model"].as_str() {
                    s.model = model.into();
                }
                return;
            }
            _ => {}
        }
        let Some(at) = timestamp(v) else { return };
        if p["type"] == "token_count" {
            let totals = &p["info"]["total_token_usage"];
            if !totals.is_object() {
                return;
            }
            let current = [
                count(totals, "input_tokens"),
                count(totals, "output_tokens"),
                count(totals, "cached_input_tokens"),
            ];
            let delta = std::array::from_fn::<_, 3, _>(|i| {
                if current[i] >= s.totals[i] {
                    current[i] - s.totals[i]
                } else {
                    current[i]
                }
            });
            s.totals = current;
            if delta[0] == 0 && delta[1] == 0 {
                return;
            }
            let id = format!(
                "local:codex:{}:{}:{}:{}",
                s.session, v["timestamp"], current[0], current[1]
            );
            let mut r = row(&id, harness, &s.session, &s.model, at, "usage");
            r["usage"] = json!({"kind":"tokens","scope":"turn","inputTokens":delta[0],"outputTokens":delta[1],"cacheReadTokens":delta[2]});
            s.rows.insert(id, r);
        } else if v["type"] == "response_item"
            && matches!(
                p["type"].as_str(),
                Some("function_call_output" | "custom_tool_call_output")
            )
        {
            if let Some(call) = p["call_id"].as_str() {
                let failed = tool_failed(&p["output"]);
                if let Some(launch) = s
                    .rows
                    .get_mut(&format!("local:codex:{}:subagent:{call}", s.session))
                {
                    launch["status"] = json!(if failed { "failed" } else { "background" });
                }
                let id = format!("local:codex:{}:result:{call}", s.session);
                let mut r = row(&id, harness, &s.session, &s.model, at, "outcome");
                r["outcome"] = json!(if tool_failed(&p["output"]) {
                    "tool_error"
                } else {
                    "tool_ok"
                });
                s.rows.insert(id, r);
            }
        } else if v["type"] == "event_msg"
            && matches!(p["type"].as_str(), Some("error" | "stream_error"))
        {
            let message = p["message"].as_str().unwrap_or("").to_lowercase();
            let outcome = if p["type"] == "stream_error"
                || [
                    "stream disconnected",
                    "connection",
                    "network",
                    "timed out",
                    "timeout",
                    "dns",
                ]
                .iter()
                .any(|word| message.contains(word))
            {
                "connection_error"
            } else if ["rate limit", "usage limit", "429", "quota"]
                .iter()
                .any(|word| message.contains(word))
            {
                "rate_limit"
            } else {
                "api_error"
            };
            let id = format!(
                "local:codex:{}:error:{}:{}",
                s.session,
                v["timestamp"],
                s.rows.len()
            );
            let mut r = row(&id, harness, &s.session, &s.model, at, "outcome");
            r["outcome"] = json!(outcome);
            s.rows.insert(id, r);
        } else if v["type"] == "response_item"
            && matches!(
                p["type"].as_str(),
                Some("function_call" | "custom_tool_call")
            )
        {
            if let Some(call) = p["call_id"].as_str() {
                let id = format!("local:codex:{}:tool:{call}", s.session);
                let mut r = row(&id, harness, &s.session, &s.model, at, "activity");
                r["tool"] = p["name"].clone();
                if p["name"] == "spawn_agent" {
                    let input: Value = p["arguments"]
                        .as_str()
                        .and_then(|text| serde_json::from_str(text).ok())
                        .unwrap_or_default();
                    let id = format!("local:codex:{}:subagent:{call}", s.session);
                    let mut launch = row(&id, harness, &s.session, &s.model, at, "subagent");
                    launch["subagentType"] = json!(input["agent_type"]
                        .as_str()
                        .or_else(|| input["role"].as_str())
                        .unwrap_or("subagent"));
                    s.rows.insert(id, launch);
                }
                s.rows.insert(id, r);
            }
        }
    }
}

/// Whether a recorded tool output reports a non-zero exit code.
fn tool_failed(output: &Value) -> bool {
    let text = output.as_str().unwrap_or("");
    if let Ok(parsed) = serde_json::from_str::<Value>(text) {
        if let Some(code) = parsed["metadata"]["exit_code"].as_i64() {
            return code != 0;
        }
    }
    let code = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("Exit code: "))
        .or_else(|| {
            text.lines()
                .find_map(|line| line.trim().strip_prefix("Process exited with code "))
        });
    code.and_then(|code| code.trim().parse::<i64>().ok())
        .is_some_and(|code| code != 0)
}

fn parse_codex(request: &RunRequest, value: &Value) -> Vec<RunEvent> {
    match value.get("type").and_then(Value::as_str).unwrap_or("") {
        "thread.started" => value
            .get("thread_id")
            .and_then(Value::as_str)
            .map(|id| {
                let mut event = RunEvent::new(request, "session", None);
                event.resume_id = Some(id.to_owned());
                vec![event]
            })
            .unwrap_or_default(),
        "turn.completed" => token_event(request, &value["usage"], &TOKENS, true, false)
            .into_iter()
            .collect(),
        "item.completed" => {
            let item = &value["item"];
            match item.get("type").and_then(Value::as_str).unwrap_or("") {
                "agent_message" => item
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|text| vec![RunEvent::new(request, "text", Some(text.into()))])
                    .unwrap_or_default(),
                "command_execution" | "file_change" | "mcp_tool_call" | "web_search" => {
                    vec![RunEvent::new(
                        request,
                        "activity",
                        item.get("type").and_then(Value::as_str).map(str::to_owned),
                    )]
                    .into_iter()
                    .map(|mut event| {
                        event.usage = Some(
                            serde_json::json!({"toolId":item.get("id"),"toolStatus":"completed"}),
                        );
                        event
                    })
                    .collect()
                }
                _ => Vec::new(),
            }
        }
        "turn.failed" | "error" => vec![RunEvent::new(
            request,
            "error",
            value["error"]["message"]
                .as_str()
                .or_else(|| value["message"].as_str())
                .map(str::to_owned)
                .or_else(|| Some("Codex run failed".into())),
        )],
        _ => Vec::new(),
    }
}

async fn rpc(
    stdin: &mut tokio::process::ChildStdin,
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, ()> {
    let request = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    stdin
        .write_all(request.to_string().as_bytes())
        .await
        .map_err(|_| ())?;
    stdin.write_all(b"\n").await.map_err(|_| ())?;
    stdin.flush().await.map_err(|_| ())?;
    for _ in 0..100 {
        let line = lines.next_line().await.map_err(|_| ())?.ok_or(())?;
        if line.len() > 1_000_000 {
            return Err(());
        }
        let value: Value = serde_json::from_str(&line).map_err(|_| ())?;
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        return value.get("result").cloned().ok_or(());
    }
    Err(())
}

async fn codex_query() -> Result<(Value, Value), ()> {
    let values = codex_requests(vec![
        ("account/read", json!({"refreshToken":false})),
        ("account/rateLimits/read", json!({})),
    ])
    .await?;
    Ok((values[0].clone(), values[1].clone()))
}

async fn codex_requests(requests: Vec<(&str, Value)>) -> Result<Vec<Value>, ()> {
    let binary = find_binary("codex").ok_or(())?;
    timeout(Duration::from_secs(12), async {
        let mut child = Command::new(binary)
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| ())?;
        let mut stdin = child.stdin.take().ok_or(())?;
        let stdout = child.stdout.take().ok_or(())?;
        let mut lines = BufReader::new(stdout).lines();
        rpc(
            &mut stdin,
            &mut lines,
            1,
            "initialize",
            json!({
                "clientInfo":{"name":"noai","title":"Noai","version":"0.1.0"},
                "capabilities":{}
            }),
        )
        .await?;
        stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"initialized\",\"params\":{}}\n")
            .await
            .map_err(|_| ())?;
        let mut results = Vec::new();
        for (index, (method, params)) in requests.into_iter().enumerate() {
            results.push(rpc(&mut stdin, &mut lines, index as u64 + 2, method, params).await?);
        }
        let _ = child.kill().await;
        Ok(results)
    })
    .await
    .map_err(|_| ())?
}

fn codex_identity(account: &Value, limits: &Value) -> Option<String> {
    if let Some(id) = limits
        .get("accountId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        return Some(format!("codex:{id}"));
    }
    let account = account.get("account")?;
    let email = account
        .get("email")
        .and_then(Value::as_str)
        .filter(|email| !email.is_empty())?;
    Some(format!("codex:{email}"))
}

fn codex_window(label: String, value: &Value) -> Option<ProviderUsageWindow> {
    let percent = value.get("usedPercent").and_then(Value::as_f64)?;
    if !(0.0..=100.0).contains(&percent) {
        return None;
    }
    // Codex reports each window's length; name the window after it when it does.
    let window_seconds = value
        .get("windowDurationMins")
        .and_then(Value::as_u64)
        .filter(|minutes| *minutes > 0)
        .map(|minutes| minutes * 60);
    let label = match window_seconds {
        Some(seconds) if label == "Primary" || label == "Secondary" => {
            crate::providers::window_label(seconds)
        }
        Some(seconds) => match label.rsplit_once(" · ") {
            Some((name, "primary" | "secondary")) => {
                format!("{name} · {}", crate::providers::window_label(seconds))
            }
            _ => label,
        },
        None => label,
    };
    Some(ProviderUsageWindow {
        window_seconds,
        expired: false,
        label,
        unit: None,
        used_percent: Some(percent),
        remaining: None,
        limit: None,
        resets_at: value.get("resetsAt").and_then(Value::as_u64),
    })
}

fn codex_snapshot(account: &Value, limits: &Value) -> ProviderUsageSnapshot {
    let identity = codex_identity(account, limits);
    cache_identity("codex", identity);
    let account_value = account.get("account").unwrap_or(&Value::Null);
    let account_label = account_value
        .get("email")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut plan = account_value
        .get("planType")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut windows = Vec::new();
    let buckets = limits.get("rateLimitsByLimitId").and_then(Value::as_object);
    if let Some(buckets) = buckets.filter(|buckets| !buckets.is_empty()) {
        for (name, bucket) in buckets {
            if plan.is_none() {
                plan = bucket
                    .get("planType")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            if let Some(window) = codex_window(format!("{name} · primary"), &bucket["primary"]) {
                windows.push(window);
            }
            if let Some(window) = codex_window(format!("{name} · secondary"), &bucket["secondary"])
            {
                windows.push(window);
            }
        }
    } else {
        let bucket = &limits["rateLimits"];
        if plan.is_none() {
            plan = bucket
                .get("planType")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        if let Some(window) = codex_window("Primary".into(), &bucket["primary"]) {
            windows.push(window);
        }
        if let Some(window) = codex_window("Secondary".into(), &bucket["secondary"]) {
            windows.push(window);
        }
    }
    ProviderUsageSnapshot {
        id: "codex",
        label: "Codex",
        account_label,
        plan,
        source: "provider",
        status: if windows.is_empty() {
            "unavailable"
        } else {
            "available"
        },
        fetched_at: Some(now()),
        windows,
        detail: if limits["ordinaryUsageAllowed"] == false {
            Some("Included usage is currently unavailable for this account.".into())
        } else {
            None
        },
        setup: None,
    }
}

async fn codex_usage() -> ProviderUsageSnapshot {
    match codex_query().await {
        Ok((account, limits)) => codex_snapshot(&account, &limits),
        Err(_) => {
            cache_identity("codex", None);
            unavailable(
                "codex",
                "Codex",
                "Sign in to Codex or update its CLI to read account limits.",
            )
        }
    }
}

/// `model = "..."` from Codex's config.toml, at the top level and in every
/// profile, so custom and provider-specific models show up. Only `model` keys
/// are read.
fn codex_configured_models(toml: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for line in toml.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("model") else {
            continue;
        };
        let Some(value) = rest.trim_start().strip_prefix('=') else {
            continue;
        };
        let value = value.trim();
        let value = value.split(" #").next().unwrap_or(value).trim();
        let Some(id) = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
        else {
            continue;
        };
        if !id.is_empty() && id.len() <= 120 && !found.iter().any(|known| known == id) {
            found.push(id.to_owned());
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_models_read_model_keys_only() {
        let toml = "model = \"gpt-5-codex\"\nmodel_provider = \"azure\"\nmodel_reasoning_effort = \"high\"\n[profiles.local]\nmodel = 'llama3.1:70b' # ollama\n[profiles.fast]\nmodel = \"gpt-5-codex\"\n";
        assert_eq!(
            codex_configured_models(toml),
            ["gpt-5-codex", "llama3.1:70b"]
        );
    }

    #[test]
    fn codex_session_usage_uses_running_totals_and_reported_window() {
        let mut usage = SessionUsage::default();
        let line = json!({"type":"event_msg","payload":{"type":"token_count","info":{
            "total_token_usage":{"input_tokens":5000,"cached_input_tokens":3000,"output_tokens":400},
            "last_token_usage":{"input_tokens":2000,"output_tokens":100,"total_tokens":2100},
            "model_context_window":272000}}});
        Codex.session_usage(&line, &mut usage);
        Codex.session_usage(&line, &mut usage);
        assert_eq!(
            usage.tokens(),
            Tokens {
                input: 2000,
                cache_read: 3000,
                cache_write: 0,
                output: 400
            }
        );
        assert_eq!(
            (usage.context_used, usage.context_window),
            (Some(2100), Some(272000))
        );
    }

    #[test]
    fn codex_tool_exit_codes_and_errors_become_outcomes() {
        assert!(tool_failed(&json!("Exit code: 1\nWall time: 0.2 seconds")));
        assert!(!tool_failed(&json!("Exit code: 0\nOutput:")));
        assert!(tool_failed(&json!(
            "{\"output\":\"x\",\"metadata\":{\"exit_code\":2}}"
        )));
        assert!(!tool_failed(&json!("Success. Updated files")));
        let mut state = FileState::default();
        state.session = "s".into();
        let at = "2026-11-19T10:00:00Z";
        Codex.metrics_line(&json!({"type":"response_item","timestamp":at,"payload":{"type":"function_call_output","call_id":"c1","output":"Exit code: 127"}}), &mut state);
        Codex.metrics_line(&json!({"type":"event_msg","timestamp":at,"payload":{"type":"stream_error","message":"Reconnecting... 1/5"}}), &mut state);
        Codex.metrics_line(&json!({"type":"event_msg","timestamp":at,"payload":{"type":"error","message":"You've hit your usage limit."}}), &mut state);
        let outcomes: Vec<_> = state
            .rows
            .values()
            .map(|r| r["outcome"].as_str().unwrap().to_owned())
            .collect();
        assert!(outcomes.contains(&"tool_error".into()));
        assert!(outcomes.contains(&"connection_error".into()));
        assert!(outcomes.contains(&"rate_limit".into()));
    }
    use crate::providers::account_fingerprint;

    #[test]
    fn codex_maps_both_limit_windows_and_identity() {
        let account =
            json!({"account":{"type":"chatgpt","email":"person@example.com","planType":"plus"}});
        let limits = json!({"accountId":"account-1","ordinaryUsageAllowed":true,"rateLimits":{
            "primary":{"usedPercent":55,"resetsAt":2000},"secondary":{"usedPercent":12,"resetsAt":3000}}});
        let snapshot = codex_snapshot(&account, &limits);
        assert_eq!(snapshot.status, "available");
        assert_eq!(snapshot.plan.as_deref(), Some("plus"));
        assert_eq!(snapshot.windows.len(), 2);
        assert_eq!(snapshot.windows[0].resets_at, Some(2000));
        assert_eq!(
            account_fingerprint("codex").as_deref(),
            Some("codex:account-1")
        );
    }
}

#[cfg(test)]
mod window_tests {
    use super::*;

    #[test]
    fn codex_windows_use_the_reported_length() {
        let window = codex_window(
            "Primary".into(),
            &serde_json::json!({"usedPercent": 40, "windowDurationMins": 300, "resetsAt": 5}),
        )
        .unwrap();
        assert_eq!(
            (window.label.as_str(), window.window_seconds),
            ("5-hour limit", Some(18_000))
        );
        let weekly = codex_window(
            "GPT-5 · secondary".into(),
            &serde_json::json!({"usedPercent": 10, "windowDurationMins": 10080}),
        )
        .unwrap();
        assert_eq!(weekly.label, "GPT-5 · Weekly limit");
        let unknown =
            codex_window("Primary".into(), &serde_json::json!({"usedPercent": 10})).unwrap();
        assert_eq!(
            (unknown.label.as_str(), unknown.window_seconds),
            ("Primary", None)
        );
    }
}
