//! Google Gemini CLI (`gemini -p "" --output-format stream-json`).
//!
//! The prompt goes to stdin; `-p ""` only switches the CLI to headless mode.
//! Replies stream as small `delta` chunks, which are joined here into whole
//! paragraphs, so Gemini output reads like every other agent's.

use super::{
    token_event, BoxFuture, Harness, HistoryRoot, Permission, SessionMessage, SessionMeta,
    SessionUsage, TokenKeys, Tokens,
};
use crate::adapters::{find_binary, JobPermissions, RunEvent, RunRequest};
use crate::local_metrics::{count, row, timestamp, FileState};
use crate::providers::{unavailable, HarnessModel, ProviderUsageSnapshot};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, process::Stdio, sync::Mutex, time::Duration};
use tokio::{process::Command, time::timeout};

pub struct Gemini;

/// Reply text streamed so far, per run, until a tool call or the result ends it.
static REPLIES: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

/// `result.stats.models.<model>`: `input_tokens` already includes `cached`.
const TOKENS: TokenKeys = TokenKeys {
    input: "input_tokens",
    output: "output_tokens",
    cache_read: "cached",
    cache_write: "cache_write",
    input_includes_cache: false,
};

const PERMISSIONS: &[Permission] = &[
    Permission {
        id: JobPermissions::WorkspaceWrite,
        label: "Edit files, no commands",
        description: "Read and edit files in the project (Gemini’s auto_edit mode). Shell commands and other tools that need approval are unavailable, since nobody is there to approve them. This is not an operating-system sandbox.",
    },
    Permission {
        id: JobPermissions::ReadOnly,
        label: "Read only",
        description: "Read and search files without changing them (Gemini’s plan mode).",
    },
    Permission {
        id: JobPermissions::ProviderDefault,
        label: "Existing CLI settings",
        description: "Use the rules in Gemini CLI’s settings and policies. Anything they don’t allow outright is unavailable, since nobody is there to approve it.",
    },
];

impl Harness for Gemini {
    fn id(&self) -> &'static str {
        "gemini"
    }
    fn label(&self) -> &'static str {
        "Gemini CLI"
    }
    fn permissions(&self) -> &'static [Permission] {
        PERMISSIONS
    }
    fn read_only(&self) -> JobPermissions {
        JobPermissions::ReadOnly
    }
    fn bypass_description(&self) -> &'static str {
        "Approve every Gemini CLI tool call automatically (YOLO mode)."
    }

    fn args(&self, request: &RunRequest) -> Vec<String> {
        let mode = if request.dangerously_bypass_permissions {
            "yolo"
        } else {
            match request.permissions {
                Some(JobPermissions::ReadOnly) => "plan",
                Some(JobPermissions::WorkspaceWrite) => "auto_edit",
                _ => "default",
            }
        };
        // Headless runs refuse untrusted folders; Noai's job folders are chosen by the user.
        let mut args: Vec<String> = [
            "-p",
            "",
            "--output-format",
            "stream-json",
            "--skip-trust",
            "--approval-mode",
            mode,
        ]
        .map(str::to_owned)
        .into();
        if let Some(resume_id) = &request.resume_id {
            args.extend(["--resume".into(), resume_id.clone()]);
        }
        if let Some(model) = &request.model {
            args.extend(["--model".into(), model.clone()]);
        }
        args
    }

    fn parse(&self, request: &RunRequest, value: &Value) -> Vec<RunEvent> {
        parse_gemini(request, value)
    }

    fn models(&self) -> BoxFuture<Vec<HarnessModel>> {
        Box::pin(gemini_models())
    }

    fn configured_models(&self, home: &Path) -> Vec<String> {
        let settings = std::fs::read_to_string(home.join(".gemini/settings.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());
        let mut models = Vec::new();
        if let Some(settings) = settings {
            // `model.name` in current settings, a bare `model` string in older ones.
            if let Some(name) = settings["model"]["name"]
                .as_str()
                .or(settings["model"].as_str())
            {
                models.push(name.to_owned());
            }
        }
        if let Ok(name) = std::env::var("GEMINI_MODEL") {
            models.push(name);
        }
        models.retain(|model| !model.trim().is_empty());
        models.dedup();
        models
    }

    fn usage(&self) -> BoxFuture<ProviderUsageSnapshot> {
        let snapshot = unavailable(
            self.id(),
            self.label(),
            "Gemini CLI doesn't report account usage or limits to Noai.",
        );
        Box::pin(async move { snapshot })
    }

    fn identity(&self) -> BoxFuture<Option<String>> {
        Box::pin(async { None })
    }

    fn history_roots(&self, home: &Path) -> Vec<HistoryRoot> {
        // ~/.gemini/tmp/<project>/chats/session-*.jsonl
        vec![HistoryRoot {
            path: home.join(".gemini").join("tmp"),
            archived: false,
        }]
    }

    fn session_meta(&self, line: &Value) -> SessionMeta {
        SessionMeta {
            session_id: line
                .get("projectHash")
                .and(line["sessionId"].as_str())
                .map(str::to_owned),
            project_path: (line["type"] == "user")
                .then(|| workspace_dir(&user_text(line)))
                .flatten(),
            model: (line["type"] == "gemini")
                .then(|| line["model"].as_str().map(str::to_owned))
                .flatten(),
        }
    }

    fn session_message(&self, line: &Value) -> Option<SessionMessage> {
        match line["type"].as_str()? {
            "user" => Some(SessionMessage {
                role: "user".into(),
                text: user_text(line),
                activities: Vec::new(),
            }),
            "gemini" if finished(line) => {
                let mut activities: Vec<Value> = line["thoughts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|thought| {
                        let text = [&thought["subject"], &thought["description"]]
                            .iter()
                            .filter_map(|part| part.as_str())
                            .filter(|part| !part.is_empty())
                            .collect::<Vec<_>>()
                            .join("\n");
                        (!text.is_empty()).then(|| json!({"kind":"thinking","text":text}))
                    })
                    .collect();
                for call in line["toolCalls"].as_array().into_iter().flatten() {
                    let name = call["name"].as_str().unwrap_or("Tool");
                    activities
                        .push(json!({"kind":"tool","text":format!("{name}\n{}", call["args"])}));
                }
                Some(SessionMessage {
                    role: "assistant".into(),
                    text: line["content"].as_str().unwrap_or("").to_owned(),
                    activities,
                })
            }
            _ => None,
        }
    }

    fn session_usage(&self, line: &Value, usage: &mut SessionUsage) {
        let (Some(id), Some(call)) = (line["id"].as_str(), call_tokens(line)) else {
            return;
        };
        // A reply is rewritten as its tool calls finish; count each call once.
        let call = usage
            .calls
            .get(id)
            .map_or(call, |previous| previous.max(call));
        usage.calls.insert(id.to_owned(), call);
    }

    fn metrics_line(&self, v: &Value, s: &mut FileState) {
        let harness = self.id();
        if v.get("projectHash").is_some() {
            if let Some(session) = v["sessionId"].as_str() {
                s.session = session.into();
            }
            return;
        }
        let (Some(message), Some(at)) = (v["id"].as_str(), timestamp(v)) else {
            return;
        };
        if v["type"] != "gemini" {
            return;
        }
        let session = s.session.clone();
        if let Some(model) = v["model"].as_str() {
            s.model = model.into();
        }
        let model = s.model.clone();
        if let Some(call) = call_tokens(v) {
            let id = format!("local:gemini:{message}");
            let mut r = row(&id, harness, &session, &model, at, "usage");
            r["usage"] = json!({"kind":"tokens","scope":"turn","inputTokens":call.input + call.cache_read,"outputTokens":call.output,"cacheReadTokens":call.cache_read});
            s.rows.insert(id, r);
        }
        for call in v["toolCalls"].as_array().into_iter().flatten() {
            let Some(tool) = call["id"].as_str() else {
                continue;
            };
            let id = format!("local:gemini:tool:{tool}");
            let mut r = row(&id, harness, &session, &model, at, "activity");
            r["tool"] = call["name"].clone();
            s.rows.insert(id, r);
            let outcome = match call["status"].as_str() {
                Some("success") => "tool_ok",
                Some("error") => "tool_error",
                _ => continue,
            };
            let id = format!("local:gemini:result:{tool}");
            let mut r = row(&id, harness, &session, &model, at, "outcome");
            r["outcome"] = json!(outcome);
            s.rows.insert(id, r);
        }
    }
}

fn parse_gemini(request: &RunRequest, value: &Value) -> Vec<RunEvent> {
    let mut events = Vec::new();
    let mut replies = REPLIES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut flush = |events: &mut Vec<RunEvent>| {
        if let Some(text) = replies.remove(&request.run_id) {
            if !text.trim().is_empty() {
                events.push(RunEvent::new(request, "text", Some(text)));
            }
        }
    };
    match value["type"].as_str().unwrap_or("") {
        "init" => {
            // A run can start over after a timed wait; drop anything left from before.
            replies.remove(&request.run_id);
            if let Some(id) = value["session_id"].as_str() {
                let mut event = RunEvent::new(request, "session", None);
                event.resume_id = Some(id.to_owned());
                events.push(event);
            }
        }
        "message" if value["role"] == "assistant" => {
            if let Some(text) = value["content"].as_str() {
                if value["delta"] == true {
                    replies
                        .entry(request.run_id.clone())
                        .or_default()
                        .push_str(text);
                } else {
                    flush(&mut events);
                    events.push(RunEvent::new(request, "text", Some(text.to_owned())));
                }
            }
        }
        "tool_use" => {
            flush(&mut events);
            events.push(RunEvent::new(
                request,
                "activity",
                value["tool_name"].as_str().map(str::to_owned),
            ));
        }
        "result" => {
            flush(&mut events);
            for (model, counts) in value["stats"]["models"].as_object().into_iter().flatten() {
                if let Some(mut event) = token_event(request, counts, &TOKENS, false, true) {
                    event.model = Some(model.clone());
                    events.push(event);
                }
            }
            if value["status"] != "success" {
                events.push(RunEvent::new(
                    request,
                    "error",
                    Some(
                        value["error"]["message"]
                            .as_str()
                            .unwrap_or("Gemini CLI reported an error.")
                            .to_owned(),
                    ),
                ));
            }
        }
        _ => {}
    }
    events
}

/// The CLI's own model list (`gemini models -o json`). No CLI, no models.
async fn gemini_models() -> Vec<HarnessModel> {
    let Some(binary) = find_binary("gemini") else {
        return vec![];
    };
    let output = timeout(
        Duration::from_secs(15),
        Command::new(&binary)
            .args(["models", "--output-format", "json"])
            .env("PATH", crate::platform::child_path(&binary))
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let Ok(Ok(output)) = output else {
        return vec![];
    };
    models_from_json(&String::from_utf8_lossy(&output.stdout))
}

fn models_from_json(text: &str) -> Vec<HarnessModel> {
    // Startup notices can precede the JSON array.
    let Some(start) = text.find('[') else {
        return vec![];
    };
    let Ok(Value::Array(models)) = serde_json::from_str::<Value>(&text[start..]) else {
        return vec![];
    };
    models
        .iter()
        .filter_map(|model| {
            let id = model["id"].as_str().or(model["modelId"].as_str())?;
            Some(HarnessModel {
                id: id.into(),
                label: model["displayName"].as_str().unwrap_or(id).into(),
                source: "agent",
            })
        })
        .collect()
}

/// A reply line that won't be rewritten: it has text, or all its tool calls ended.
fn finished(line: &Value) -> bool {
    let calls = line["toolCalls"].as_array();
    let has_text = line["content"]
        .as_str()
        .is_some_and(|text| !text.is_empty());
    match calls {
        Some(calls) if !calls.is_empty() => calls.iter().all(|call| {
            matches!(
                call["status"].as_str(),
                Some("success" | "error" | "cancelled")
            )
        }),
        _ => has_text,
    }
}

fn user_text(line: &Value) -> String {
    line["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| block["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// The project folder from the CLI's opening `<session_context>` message.
fn workspace_dir(text: &str) -> Option<String> {
    let after = text.split("**Workspace Directories:**").nth(1)?;
    let line = after.lines().map(str::trim).find(|line| !line.is_empty())?;
    let path = line.strip_prefix("- ")?.trim();
    (!path.is_empty()).then(|| path.to_owned())
}

/// One transcript reply's tokens. `input` there includes cached tokens, and
/// thinking tokens are billed as output.
fn call_tokens(line: &Value) -> Option<Tokens> {
    if line["type"] != "gemini" {
        return None;
    }
    let tokens = line.get("tokens").filter(|tokens| tokens.is_object())?;
    let cached = count(tokens, "cached");
    Some(Tokens {
        input: count(tokens, "input").saturating_sub(cached),
        cache_read: cached,
        cache_write: 0,
        output: count(tokens, "output") + count(tokens, "thoughts"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(run: &str) -> RunRequest {
        RunRequest {
            run_id: run.into(),
            conversation_id: "c".into(),
            harness: "gemini".into(),
            model: None,
            project_path: "/p".into(),
            prompt: "hi".into(),
            resume_id: None,
            auto_resume: false,
            dangerously_bypass_permissions: false,
            permissions: None,
        }
    }

    #[test]
    fn args_map_permissions_resume_and_model() {
        let mut r = request("args");
        let mode = |r: &RunRequest| {
            let args = Gemini.args(r);
            let at = args
                .iter()
                .position(|arg| arg == "--approval-mode")
                .unwrap();
            args[at + 1].clone()
        };
        assert_eq!(mode(&r), "default");
        r.permissions = Some(JobPermissions::ReadOnly);
        assert_eq!(mode(&r), "plan");
        r.permissions = Some(JobPermissions::WorkspaceWrite);
        assert_eq!(mode(&r), "auto_edit");
        r.dangerously_bypass_permissions = true;
        assert_eq!(mode(&r), "yolo");
        r.resume_id = Some("s1".into());
        r.model = Some("gemini-x".into());
        let args = Gemini.args(&r);
        assert_eq!(&args[..2], ["-p", ""]);
        assert!(args.windows(2).any(|pair| pair == ["--resume", "s1"]));
        assert!(args.windows(2).any(|pair| pair == ["--model", "gemini-x"]));
    }

    #[test]
    fn streamed_deltas_become_whole_paragraphs() {
        let r = request("deltas");
        let lines = [
            json!({"type":"init","session_id":"s1","model":"m"}),
            json!({"type":"message","role":"user","content":"hi"}),
            json!({"type":"message","role":"assistant","content":"I will ","delta":true}),
            json!({"type":"message","role":"assistant","content":"read it.","delta":true}),
            json!({"type":"tool_use","tool_name":"read_file","tool_id":"t1","parameters":{}}),
            json!({"type":"tool_result","tool_id":"t1","status":"success"}),
            json!({"type":"message","role":"assistant","content":"Done","delta":true}),
            json!({"type":"result","status":"success","stats":{"models":{"m":{"input_tokens":100,"output_tokens":5,"cached":40,"input":60}}}}),
        ];
        let events: Vec<RunEvent> = lines
            .iter()
            .flat_map(|line| Gemini.parse(&r, line))
            .collect();
        let kinds: Vec<_> = events.iter().map(|event| event.kind).collect();
        assert_eq!(kinds, ["session", "text", "activity", "text", "usage"]);
        assert_eq!(events[0].resume_id.as_deref(), Some("s1"));
        assert_eq!(events[1].text.as_deref(), Some("I will read it."));
        assert_eq!(events[2].text.as_deref(), Some("read_file"));
        assert_eq!(events[3].text.as_deref(), Some("Done"));
        let usage = events[4].usage.as_ref().unwrap();
        assert_eq!(usage["inputTokens"], 100);
        assert_eq!(usage["cacheReadTokens"], 40);
        assert_eq!(usage["outputTokens"], 5);
        assert_eq!(events[4].model.as_deref(), Some("m"));
        assert!(REPLIES.lock().unwrap().get("deltas").is_none());
    }

    #[test]
    fn failed_results_report_the_cli_error() {
        let r = request("error");
        let events = Gemini.parse(
            &r,
            &json!({"type":"result","status":"error","error":{"type":"Error","message":"[API Error: quota]"},"stats":{"models":{}}}),
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "error");
        assert_eq!(events[0].text.as_deref(), Some("[API Error: quota]"));
    }

    #[test]
    fn model_list_skips_leading_notices() {
        let models = models_from_json(
            "Loaded cached credentials.\n[{\"id\":\"auto\",\"displayName\":\"Auto\"},{\"modelId\":\"gemini-x\"}]",
        );
        let ids: Vec<_> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, ["auto", "gemini-x"]);
        assert_eq!(models[0].label, "Auto");
        assert!(models_from_json("not json").is_empty());
    }

    #[test]
    fn transcripts_count_each_rewritten_reply_once() {
        let header = json!({"sessionId":"s1","projectHash":"h","kind":"main"});
        let context = json!({"id":"u0","timestamp":"2026-01-01T00:00:00Z","type":"user","content":[{"text":"<session_context>\n- **Workspace Directories:**\n  - /work/app\n- **Directory Structure:**\n"}]});
        let tokens = json!({"input":100,"output":10,"cached":30,"thoughts":5,"tool":0,"total":115});
        let pending = json!({"id":"g1","timestamp":"2026-01-01T00:00:01Z","type":"gemini","content":"","model":"m","tokens":tokens,"toolCalls":[{"id":"t1","name":"read_file","args":{},"status":"scheduled"}]});
        let mut done = pending.clone();
        done["toolCalls"][0]["status"] = json!("success");

        assert_eq!(
            Gemini.session_meta(&header).session_id.as_deref(),
            Some("s1")
        );
        assert_eq!(
            Gemini.session_meta(&context).project_path.as_deref(),
            Some("/work/app")
        );
        assert!(Gemini.session_message(&pending).is_none());
        let message = Gemini.session_message(&done).unwrap();
        assert_eq!(message.role, "assistant");
        assert_eq!(message.activities.len(), 1);

        let mut usage = SessionUsage::default();
        for line in [&pending, &done] {
            Gemini.session_usage(line, &mut usage);
        }
        assert_eq!(
            usage.tokens(),
            Tokens {
                input: 70,
                cache_read: 30,
                cache_write: 0,
                output: 15
            }
        );

        let mut state = FileState::default();
        for line in [&header, &context, &pending, &done] {
            Gemini.metrics_line(line, &mut state);
        }
        let usage_row = &state.rows["local:gemini:g1"];
        assert_eq!(usage_row["sessionId"], "s1");
        assert_eq!(usage_row["usage"]["inputTokens"], 100);
        assert_eq!(usage_row["usage"]["outputTokens"], 15);
        assert_eq!(state.rows["local:gemini:result:t1"]["outcome"], "tool_ok");
        assert_eq!(state.rows.len(), 3);
    }
}
