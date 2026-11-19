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

const INSTRUCTIONS: &str = r#"Write the Noai daily digest for the user from the JSON data below. It covers the last 24 hours of their scheduled coding-agent jobs and their local agent usage.

Rules:
- Use only the data provided. Never invent runs, numbers, causes or outcomes. If something is not in the data, say it is not reported.
- Do not run tools, read files or change anything. Reply with the digest only.
- Be concise and specific. Name jobs by title. Use the local times given.

Format (Markdown):
# Daily digest — <date>
One or two sentences: the overall picture.

## Needs attention
Failed, stuck, waiting-on-usage-limit or needs-attention jobs. For each: job title, what happened (quote the key error briefly), and the smallest next step. Write "Nothing needs attention." if empty.

## Jobs
A table: Job | Agent/model | Runs | Succeeded | Failed | Tokens (in/out) | Notes. Notes should flag runs that finished but said they could not complete the work, unusually long runs, or repeated identical errors.

## Usage
Token totals by agent and model, and the most used tools. Note anything unusual.

## Insights
Two to four short, concrete observations or suggestions grounded in the data (for example a recurring job that keeps failing, a job producing no useful output, or heavy token use by one job). Skip this section if there is too little data.

If there was no activity at all, say so in one short paragraph instead of the sections above.
"#;

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
                add_usage(by_model.entry((harness, model)).or_default(), &record["usage"]);
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

pub fn snapshot(tasks: &[Task], runs: &[TaskRun], usage_records: &[Value], now: u64) -> Value {
    let since = now.saturating_sub(WINDOW);
    let mut jobs = Vec::new();
    let mut attention = Vec::new();
    for task in tasks.iter().take(MAX_JOBS) {
        let task_runs: Vec<&TaskRun> = runs.iter().filter(|run| run.task_id == task.id).collect();
        let flagged = matches!(task.status.as_str(), "needs_attention" | "failed" | "paused");
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
        .filter_map(|task| Some(json!({"title": task.title, "nextRun": local_time(task.next_run_at?)})))
        .take(20)
        .collect();
    json!({
        "window": {"from": local_time(since), "to": local_time(now)},
        "jobsWithActivity": jobs,
        "jobsNeedingAttention": attention,
        "upcoming": scheduled_next,
        "localAgentUsage": usage_summary(usage_records, since),
    })
}

pub fn compose(tasks: &ScheduledTasks, now: u64) -> String {
    let (tasks, runs) = tasks.activity_since(now.saturating_sub(WINDOW));
    let merged = crate::local_metrics::merge(Vec::new());
    let records = merged["records"].as_array().cloned().unwrap_or_default();
    let data = snapshot(&tasks, &runs, &records, now);
    let mut text = serde_json::to_string_pretty(&data).unwrap_or_else(|_| "{}".into());
    if text.len() > MAX_PROMPT_DATA {
        text = serde_json::to_string(&data).unwrap_or_default();
        text.truncate(text.floor_char_boundary_compat(MAX_PROMPT_DATA));
        text.push_str("\n…(data truncated)");
    }
    format!("{INSTRUCTIONS}\nData:\n```json\n{text}\n```")
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
        let tasks = vec![task("a", "Nightly tests", "scheduled"), task("b", "Docs", "needs_attention")];
        let runs = vec![
            run("a", "completed", now - 3600, vec![
                event("usage", None, Some(json!({"inputTokens": 100, "outputTokens": 20, "kind": "tokens"}))),
                event("usage", None, Some(json!({"inputTokens": 50, "outputTokens": 5}))),
                event("activity", Some("Bash"), None),
                event("text", Some("All tests pass"), None),
            ]),
            run("b", "needs_attention", now - 7200, vec![event("error", Some("auth expired"), None)]),
        ];
        let usage = vec![
            json!({"at": now - 10, "harness": "claude", "model": "opus", "type": "usage", "usage": {"inputTokens": 7}}),
            json!({"at": now - 2 * WINDOW, "harness": "claude", "model": "opus", "type": "usage", "usage": {"inputTokens": 999}}),
            json!({"at": now - 10, "harness": "claude", "type": "activity", "tool": "Read file.rs"}),
        ];
        let data = snapshot(&tasks, &runs, &usage, now);
        let jobs = data["jobsWithActivity"].as_array().unwrap();
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0]["runs"][0]["tokens"]["inputTokens"], 150);
        assert_eq!(jobs[0]["runs"][0]["toolEvents"], 1);
        assert_eq!(jobs[0]["runs"][0]["finalMessageExcerpt"], "All tests pass");
        assert_eq!(jobs[1]["runs"][0]["lastError"], "auth expired");
        assert_eq!(data["jobsNeedingAttention"][0]["title"], "Docs");
        let usage = &data["localAgentUsage"];
        assert_eq!(usage["tokensByAgentAndModel"][0]["tokens"]["inputTokens"], 7);
        assert_eq!(usage["topTools"][0]["tool"], "Read");
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
