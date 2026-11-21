//! Daily digest: builds the prompt for the built-in digest job from the last
//! 24 hours of job runs and local agent usage. The agent receives the data in
//! its prompt and only writes prose; it never needs tools or file access.
use crate::scheduled_tasks::{ScheduledTasks, Task, TaskRun};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

const WINDOW: u64 = 86_400;
const MAX_RUNS_PER_JOB: usize = 12;
const MAX_JOBS: usize = 60;
const MAX_PROMPT_DATA: usize = 90_000;

/// Stored as the digest task's prompt when the user has not written their own.
pub const DEFAULT_PROMPT: &str = "Summarize the last 24 hours of Noai jobs and agent usage.";
const MAX_SESSIONS: usize = 40;

/// Always applied, whether the user wrote instructions or not.
const RULES: &str = r#"You are writing the Noai daily digest from the JSON data below. It covers the last 24 hours of the user's scheduled coding-agent jobs, their coding-agent sessions on this computer, and their agent usage.

Rules:
- Use only the data provided. Never invent work, runs, numbers, causes, links or outcomes. If something is not in the data, say it is not reported.
- Do not run tools, read files or change anything. Reply with the digest only, in Markdown.
- Name jobs and sessions by their title. Use the local times given.
- Links: link a session only with its `link` value, as [title](link). Link a web address only if it appears word for word in the data. Never make up a link."#;

/// The default digest, used when the user leaves the instructions blank.
const DEFAULT_FORMAT: &str = r#"Write it for someone who is not a programmer. Keep it short, friendly and plain. When a technical word is unavoidable, explain it in a few words.

Format:
# Daily digest — <date>
One or two plain sentences: the overall picture of the day.

## Needs your attention
Failed, stuck or waiting jobs, and anything the agent said it could not finish. For each: what it is, what went wrong in plain words (quote the key error briefly), and the smallest next step. Write "Nothing needs your attention." if empty.

## What got done
Group all the work (jobs and sessions) into two to six categories by what it was about, for example "Bug fixes", "Testing", "New features", "Docs", "Research" or "Upkeep". Choose names that fit the data and use the project folder names to help. For each category:
### <Category name>
- One or two sentences explaining in everyday language what was done and why it matters.
- The jobs and sessions behind it as a short list, each linked with its `link` when it has one, plus whether it finished, failed or is still going.
- Web links (pull requests, issues, docs) that appear in the data for this work, if any.

## Usage
Two or three sentences in plain words: how much was used, by which agent and model, and which tools were used most. Mention anything unusual.

## Suggestions
Three to five concrete next steps grounded in the data, most useful first (for example retry a failed job, split a job that keeps running out of time, or check a session that ended with an error).

If there was no activity at all, say so in one short, friendly paragraph instead of the sections above."#;

/// The user's own instructions, or `None` for the default digest.
pub fn custom_instructions(prompt: &str) -> Option<&str> {
    let prompt = prompt.trim();
    (!prompt.is_empty() && prompt != DEFAULT_PROMPT).then_some(prompt)
}

fn instructions(prompt: &str) -> String {
    match custom_instructions(prompt) {
        Some(custom) => format!("{RULES}\n\nThe user asked for this digest:\n\"\"\"\n{custom}\n\"\"\"\nFollow their request, within the rules above."),
        None => format!("{RULES}\n\n{DEFAULT_FORMAT}"),
    }
}

/// Percent-encodes everything except unreserved characters. The app's
/// `#session=` route decodes it with `decodeURIComponent`, and nothing in the
/// result can break out of a Markdown `( )` link.
fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn folder_name(path: &str) -> &str {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
}

/// Agent sessions on this computer (inside or outside Noai) touched in the window.
fn session_summary(sessions: &[Value], since: u64) -> Vec<Value> {
    let mut recent: Vec<&Value> = sessions
        .iter()
        .filter(|session| session["updatedAt"].as_u64().is_some_and(|at| at >= since))
        // The digest's own runs are not work worth reporting.
        .filter(|session| {
            !session["projectPath"]
                .as_str()
                .unwrap_or("")
                .contains(".noai/digest")
        })
        .collect();
    recent.sort_by_key(|session| std::cmp::Reverse(session["updatedAt"].as_u64().unwrap_or(0)));
    recent
        .into_iter()
        .take(MAX_SESSIONS)
        .map(|session| {
            let project = session["projectPath"].as_str().unwrap_or("");
            let id = session["id"].as_str().unwrap_or("");
            json!({
                "title": truncate(session["title"].as_str().unwrap_or("Untitled session"), 120),
                "agent": session["harness"],
                "model": session["model"].as_str().filter(|model| !model.is_empty()).unwrap_or("not reported"),
                "project": if project.is_empty() { "not recorded" } else { folder_name(project) },
                "lastActive": session["updatedAt"].as_u64().map(local_time),
                "messages": session["messageCount"],
                "tokens": session["tokens"],
                "subagents": session["subagents"]["count"],
                "link": format!("#session={}", encode_component(id)),
            })
        })
        .collect()
}

fn local_time(epoch: u64) -> String {
    chrono::DateTime::from_timestamp(epoch as i64, 0)
        .map(|utc| {
            utc.with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M %Z")
                .to_string()
        })
        .unwrap_or_else(|| epoch.to_string())
}

fn truncate(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let kept: String = text.chars().take(max).collect();
    format!("{kept}…")
}

/// Sums every numeric token field (inputTokens, outputTokens, cacheReadTokens…).
fn add_usage(totals: &mut Map<String, Value>, usage: &Value) {
    let Some(fields) = usage.as_object() else {
        return;
    };
    for (key, value) in fields {
        if let Some(number) = value.as_u64() {
            let current = totals.get(key).and_then(Value::as_u64).unwrap_or(0);
            totals.insert(key.clone(), json!(current + number));
        }
    }
}

fn run_summary(run: &TaskRun) -> Value {
    let mut tokens = Map::new();
    let mut tools = 0;
    let mut waits = 0;
    let mut last_error = None;
    let mut last_text = None;
    for event in &run.events {
        match event.kind.as_str() {
            "usage" => {
                if let Some(usage) = &event.usage {
                    add_usage(&mut tokens, usage);
                }
            }
            "activity" => tools += 1,
            "waiting" => waits += 1,
            "error" => last_error = event.text.as_deref(),
            "text" => last_text = event.text.as_deref(),
            _ => {}
        }
    }
    json!({
        "started": local_time(run.started_at),
        "finished": run.finished_at.map(local_time),
        "durationMinutes": run.finished_at.map(|end| (end.saturating_sub(run.started_at) as f64 / 60.0 * 10.0).round() / 10.0),
        "status": run.status,
        "result": run.result.as_deref().map(|text| truncate(text, 300)),
        "tokens": tokens,
        "toolEvents": tools,
        "usageLimitWaits": waits,
        "lastError": last_error.map(|text| truncate(text, 400)),
        "finalMessageExcerpt": last_text.map(|text| truncate(text, 600)),
    })
}

fn job_summary(task: &Task, runs: &[&TaskRun]) -> Value {
    let succeeded = runs.iter().filter(|run| run.status == "completed").count();
    let failed = runs
        .iter()
        .filter(|run| matches!(run.status.as_str(), "failed" | "needs_attention" | "paused"))
        .count();
    let recent: Vec<Value> = runs
        .iter()
        .rev()
        .take(MAX_RUNS_PER_JOB)
        .map(|run| run_summary(run))
        .collect();
    json!({
        "title": task.title,
        "whatItDoes": truncate(&task.prompt, 300),
        "project": folder_name(&task.project_path),
        "agent": task.harness,
        "model": task.model.as_deref().unwrap_or("agent default"),
        "currentStatus": task.status,
        "repeatsEveryMinutes": task.interval_seconds.map(|seconds| seconds / 60),
        "nextRun": task.next_run_at.map(local_time),
        "runsInWindow": runs.len(),
        "succeeded": succeeded,
        "failed": failed,
        "runs": recent,
    })
}

/// Local Codex/Claude usage (including sessions started outside Noai).
fn usage_summary(records: &[Value], since: u64) -> Value {
    let mut by_model: BTreeMap<(String, String), Map<String, Value>> = BTreeMap::new();
    let mut tools: BTreeMap<String, u64> = BTreeMap::new();
    for record in records {
        if record["at"].as_u64().is_none_or(|at| at < since) {
            continue;
        }
        let harness = record["harness"].as_str().unwrap_or("unknown").to_owned();
        match record["type"].as_str() {
            Some("usage") => {
                let model = record["model"]
                    .as_str()
                    .filter(|model| !model.is_empty())
                    .unwrap_or("not reported")
                    .to_owned();
                add_usage(
                    by_model.entry((harness, model)).or_default(),
                    &record["usage"],
                );
            }
            Some("activity") => {
                let tool = record["tool"].as_str().unwrap_or("tool");
                let name = tool.split_whitespace().next().unwrap_or(tool);
                *tools.entry(truncate(name, 40)).or_default() += 1;
            }
            _ => {}
        }
    }
    let mut top_tools: Vec<(String, u64)> = tools.into_iter().collect();
    top_tools.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    json!({
        "tokensByAgentAndModel": by_model
            .into_iter()
            .map(|((agent, model), tokens)| json!({"agent": agent, "model": model, "tokens": tokens}))
            .collect::<Vec<_>>(),
        "topTools": top_tools
            .into_iter()
            .take(10)
            .map(|(tool, count)| json!({"tool": tool, "count": count}))
            .collect::<Vec<_>>(),
    })
}

pub fn snapshot(
    tasks: &[Task],
    runs: &[TaskRun],
    usage_records: &[Value],
    sessions: &[Value],
    now: u64,
) -> Value {
    let since = now.saturating_sub(WINDOW);
    let mut jobs = Vec::new();
    let mut attention = Vec::new();
    for task in tasks.iter().take(MAX_JOBS) {
        let task_runs: Vec<&TaskRun> = runs.iter().filter(|run| run.task_id == task.id).collect();
        let flagged = matches!(task.status.as_str(), "needs_attention" | "failed");
        if flagged {
            attention.push(json!({
                "title": task.title,
                "status": task.status,
                "lastResult": task.last_result.as_deref().map(|text| truncate(text, 400)),
            }));
        }
        if !task_runs.is_empty() || flagged || task.status == "running" {
            jobs.push(job_summary(task, &task_runs));
        }
    }
    let scheduled_next: Vec<Value> = tasks
        .iter()
        .filter(|task| task.status == "scheduled")
        .filter_map(|task| {
            Some(json!({"title": task.title, "nextRun": local_time(task.next_run_at?)}))
        })
        .take(20)
        .collect();
    json!({
        "window": {"from": local_time(since), "to": local_time(now)},
        "jobsWithActivity": jobs,
        "jobsNeedingAttention": attention,
        "upcoming": scheduled_next,
        "sessions": session_summary(sessions, since),
        "localAgentUsage": usage_summary(usage_records, since),
    })
}

pub fn compose(tasks: &ScheduledTasks, prompt: &str, home: &std::path::Path, now: u64) -> String {
    let (tasks, runs) = tasks.activity_since(now.saturating_sub(WINDOW));
    let merged = crate::local_metrics::merge(Vec::new());
    let records = merged["records"].as_array().cloned().unwrap_or_default();
    let sessions = crate::local_sessions::list(home.to_path_buf())
        .ok()
        .and_then(|data| data["sessions"].as_array().cloned())
        .unwrap_or_default();
    let data = snapshot(&tasks, &runs, &records, &sessions, now);
    let mut text = serde_json::to_string_pretty(&data).unwrap_or_else(|_| "{}".into());
    if text.len() > MAX_PROMPT_DATA {
        text = serde_json::to_string(&data).unwrap_or_default();
        text.truncate(text.floor_char_boundary_compat(MAX_PROMPT_DATA));
        text.push_str("\n…(data truncated)");
    }
    format!("{}\n\nData:\n```json\n{text}\n```", instructions(prompt))
}

trait FloorCharBoundary {
    fn floor_char_boundary_compat(&self, index: usize) -> usize;
}

impl FloorCharBoundary for String {
    fn floor_char_boundary_compat(&self, index: usize) -> usize {
        let mut index = index.min(self.len());
        while !self.is_char_boundary(index) {
            index -= 1;
        }
        index
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduled_tasks::StoredEvent;

    fn task(id: &str, title: &str, status: &str) -> Task {
        serde_json::from_value(json!({
            "id": id, "title": title, "prompt": "p", "harness": "codex", "model": null,
            "projectPath": "/tmp", "nextRunAt": null, "intervalSeconds": 3600, "status": status,
            "lastRunId": null, "lastResult": "boom", "autoResume": true, "createdAt": 1
        }))
        .unwrap()
    }

    fn run(task_id: &str, status: &str, started: u64, events: Vec<StoredEvent>) -> TaskRun {
        serde_json::from_value(json!({
            "runId": format!("{task_id}-{started}"), "taskId": task_id, "conversationId": "c",
            "status": status, "startedAt": started, "finishedAt": started + 120,
            "result": status, "events": events
        }))
        .unwrap()
    }

    fn event(kind: &str, text: Option<&str>, usage: Option<Value>) -> StoredEvent {
        serde_json::from_value(json!({
            "eventId": 1, "type": kind, "text": text, "resumeId": null, "retryAt": null,
            "usage": usage, "at": 1
        }))
        .unwrap()
    }

    #[test]
    fn snapshot_reports_runs_failures_and_usage() {
        let now = 1_000_000;
        let tasks = vec![
            task("a", "Nightly tests", "scheduled"),
            task("b", "Docs", "needs_attention"),
        ];
        let runs = vec![
            run(
                "a",
                "completed",
                now - 3600,
                vec![
                    event(
                        "usage",
                        None,
                        Some(json!({"inputTokens": 100, "outputTokens": 20, "kind": "tokens"})),
                    ),
                    event(
                        "usage",
                        None,
                        Some(json!({"inputTokens": 50, "outputTokens": 5})),
                    ),
                    event("activity", Some("Bash"), None),
                    event("text", Some("All tests pass"), None),
                ],
            ),
            run(
                "b",
                "needs_attention",
                now - 7200,
                vec![event("error", Some("auth expired"), None)],
            ),
        ];
        let usage = vec![
            json!({"at": now - 10, "harness": "claude", "model": "opus", "type": "usage", "usage": {"inputTokens": 7}}),
            json!({"at": now - 2 * WINDOW, "harness": "claude", "model": "opus", "type": "usage", "usage": {"inputTokens": 999}}),
            json!({"at": now - 10, "harness": "claude", "type": "activity", "tool": "Read file.rs"}),
        ];
        let sessions = vec![
            json!({"id": "/h/.claude/projects/a b.jsonl", "title": "Fix login", "harness": "claude", "projectPath": "/code/web", "updatedAt": now - 60, "messageCount": 4}),
            json!({"id": "/x", "title": "Old", "harness": "codex", "projectPath": "/code/web", "updatedAt": now - 2 * WINDOW}),
            json!({"id": "/d", "title": "Digest", "harness": "codex", "projectPath": "/h/.noai/digest", "updatedAt": now - 60}),
        ];
        let data = snapshot(&tasks, &runs, &usage, &sessions, now);
        let jobs = data["jobsWithActivity"].as_array().unwrap();
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0]["runs"][0]["tokens"]["inputTokens"], 150);
        assert_eq!(jobs[0]["runs"][0]["toolEvents"], 1);
        assert_eq!(jobs[0]["runs"][0]["finalMessageExcerpt"], "All tests pass");
        assert_eq!(jobs[1]["runs"][0]["lastError"], "auth expired");
        assert_eq!(data["jobsNeedingAttention"][0]["title"], "Docs");
        let usage = &data["localAgentUsage"];
        assert_eq!(
            usage["tokensByAgentAndModel"][0]["tokens"]["inputTokens"],
            7
        );
        assert_eq!(usage["topTools"][0]["tool"], "Read");
        let sessions = data["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0]["project"], "web");
        assert_eq!(
            sessions[0]["link"],
            "#session=%2Fh%2F.claude%2Fprojects%2Fa%20b.jsonl"
        );
    }

    #[test]
    fn blank_or_legacy_prompt_uses_the_default_digest() {
        assert!(custom_instructions("").is_none());
        assert!(custom_instructions(DEFAULT_PROMPT).is_none());
        assert_eq!(
            custom_instructions("  Only list failures  "),
            Some("Only list failures")
        );
        assert!(instructions("").contains("## What got done"));
        let custom = instructions("Only list failures");
        assert!(
            custom.contains("Only list failures")
                && custom.contains("Never invent")
                && !custom.contains("## What got done")
        );
    }

    #[test]
    fn truncation_respects_character_boundaries() {
        assert_eq!(truncate("héllo wörld", 4), "héll…");
        let mut text = "é".repeat(10);
        let cut = text.floor_char_boundary_compat(5);
        text.truncate(cut);
        assert_eq!(text, "éé");
    }
}
