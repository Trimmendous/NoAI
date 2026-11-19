use crate::adapters::{RunEvent, RunRequest};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn unique_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{prefix}-{}-{nanos}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskInput {
    pub title: String,
    pub prompt: String,
    pub harness: String,
    pub model: Option<String>,
    pub project_path: String,
    pub start_at: u64,
    pub interval_seconds: Option<u64>,
    #[serde(default)]
    pub auto_resume: bool,
    #[serde(default)]
    pub dangerously_bypass_permissions: bool,
    #[serde(default)]
    pub permissions: Option<crate::adapters::JobPermissions>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub harness: String,
    pub model: Option<String>,
    pub project_path: String,
    pub next_run_at: Option<u64>,
    pub interval_seconds: Option<u64>,
    pub status: String,
    pub last_run_id: Option<String>,
    pub last_result: Option<String>,
    pub auto_resume: bool,
    #[serde(default)]
    pub dangerously_bypass_permissions: bool,
    #[serde(default)]
    pub permissions: Option<crate::adapters::JobPermissions>,
    pub created_at: u64,
    #[serde(default)]
    pub pending_resume_id: Option<String>,
    /// `Some("digest")` for the built-in daily digest; `None` for user jobs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Digest only: the configured daily time. Later occurrences are this plus
    /// whole days, so "Run now" never shifts the schedule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestInput {
    pub enabled: bool,
    pub harness: String,
    pub model: Option<String>,
    /// Next local occurrence of the chosen time of day, computed by the client.
    pub start_at: u64,
    #[serde(default = "default_true")]
    pub auto_resume: bool,
}

fn default_true() -> bool {
    true
}

pub const DIGEST_KIND: &str = "digest";
const DAY: u64 = 86_400;

fn is_digest(task: &Task) -> bool {
    task.kind.as_deref() == Some(DIGEST_KIND)
}

/// First `anchor + k days` strictly after `at`.
fn next_daily(anchor: u64, at: u64) -> u64 {
    if anchor > at {
        return anchor;
    }
    anchor + ((at - anchor) / DAY + 1) * DAY
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub harness: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    pub run_id: String,
    pub task_id: String,
    pub conversation_id: String,
    pub status: String,
    pub started_at: u64,
    #[serde(default)]
    pub scheduled_at: u64,
    pub finished_at: Option<u64>,
    pub result: Option<String>,
    #[serde(default)]
    pub dangerously_bypass_permissions: bool,
    #[serde(default)]
    pub permissions: Option<crate::adapters::JobPermissions>,
    pub events: Vec<StoredEvent>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEvent {
    #[serde(default)]
    pub model: Option<String>,
    pub event_id: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub text: Option<String>,
    pub resume_id: Option<String>,
    pub retry_at: Option<u64>,
    pub usage: Option<serde_json::Value>,
    pub at: u64,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Journal {
    tasks: Vec<Task>,
    runs: Vec<TaskRun>,
}

pub struct ScheduledTasks {
    path: PathBuf,
    journal: Mutex<Journal>,
}

impl ScheduledTasks {
    pub fn open_in_dir(dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        let path = dir.join("scheduled-tasks.json");
        let mut journal = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Journal>(&bytes)
                .map_err(|error| format!("Cannot parse scheduled tasks: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Journal::default(),
            Err(error) => return Err(format!("Cannot read scheduled tasks: {error}")),
        };
        let mut changed = false;
        for run in &mut journal.runs {
            if run.status == "running" {
                run.status = "needs_attention".into();
                run.result =
                    Some("Noai closed during this run. Review its output before retrying.".into());
                run.finished_at = Some(now());
                changed = true;
            }
        }
        for task in &mut journal.tasks {
            if task.status == "running" {
                let waiting = task.last_run_id.as_deref().is_some_and(|id| {
                    journal
                        .runs
                        .iter()
                        .any(|run| run.run_id == id && run.status == "waiting")
                });
                if !waiting {
                    task.status = "needs_attention".into();
                    task.last_result =
                        Some("Noai closed during this run. Review before scheduling again.".into());
                    changed = true;
                }
            }
        }
        if changed {
            save(&path, &journal)?;
        }
        Ok(Self {
            path,
            journal: Mutex::new(journal),
        })
    }

    fn update<T>(&self, edit: impl FnOnce(&mut Journal) -> Result<T, String>) -> Result<T, String> {
        let mut current = self.journal.lock().unwrap();
        let mut candidate = current.clone();
        let result = edit(&mut candidate)?;
        save(&self.path, &candidate)?;
        *current = candidate;
        Ok(result)
    }

    pub fn list(&self) -> Vec<Task> {
        self.journal.lock().unwrap().tasks.clone()
    }

    pub fn task_for_run(&self, run_id: &str) -> Option<Task> {
        let journal = self.journal.lock().unwrap();
        let task_id = journal
            .runs
            .iter()
            .find(|run| run.run_id == run_id)?
            .task_id
            .as_str();
        journal
            .tasks
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
    }

    pub fn launchable(&self, run_id: &str) -> bool {
        self.task_for_run(run_id).is_some_and(|task| {
            task.status == "running" && task.last_run_id.as_deref() == Some(run_id)
        })
    }

    pub fn runs(&self, id: &str) -> Result<Vec<TaskRun>, String> {
        let journal = self.journal.lock().unwrap();
        if !journal.tasks.iter().any(|task| task.id == id) {
            return Err("Scheduled task not found".into());
        }
        Ok(journal
            .runs
            .iter()
            .filter(|run| run.task_id == id)
            .cloned()
            .collect())
    }

    fn prepare(mut input: CreateTaskInput) -> Result<Task, String> {
        let title = input.title.trim();
        let prompt = input.prompt.trim();
        if title.is_empty() || title.len() > 200 {
            return Err("Title must be 1–200 characters".into());
        }
        if prompt.is_empty() {
            return Err("Prompt is required".into());
        }
        if crate::harness::get(&input.harness).is_none() {
            return Err("Unsupported harness".into());
        }
        if input.interval_seconds.is_some_and(|seconds| seconds < 60) {
            return Err("Minimum interval is 60 seconds".into());
        }
        let project = PathBuf::from(&input.project_path)
            .canonicalize()
            .map_err(|error| format!("Project folder is unavailable: {error}"))?;
        if !project.is_dir() {
            return Err("Project path must be a folder".into());
        }
        let permissions = input
            .permissions
            .unwrap_or_else(|| crate::adapters::JobPermissions::for_harness(&input.harness));
        permissions.validate(&input.harness)?;
        input.permissions = Some(permissions);
        let task = Task {
            id: unique_id("task"),
            title: title.into(),
            prompt: prompt.into(),
            harness: input.harness,
            model: input.model.filter(|value| !value.trim().is_empty()),
            project_path: project.to_string_lossy().into_owned(),
            next_run_at: Some(input.start_at.max(now())),
            interval_seconds: input.interval_seconds,
            status: "scheduled".into(),
            last_run_id: None,
            last_result: None,
            auto_resume: input.auto_resume,
            dangerously_bypass_permissions: input.dangerously_bypass_permissions,
            permissions: input.permissions,
            created_at: now(),
            pending_resume_id: None,
            kind: None,
            anchor_at: None,
        };
        Ok(task)
    }

    pub fn create(&self, input: CreateTaskInput) -> Result<Task, String> {
        let task = Self::prepare(input)?;
        self.update(|journal| {
            journal.tasks.push(task.clone());
            Ok(task)
        })
    }

    pub fn edit(
        &self,
        id: &str,
        input: CreateTaskInput,
        expected_last_run_id: Option<String>,
    ) -> Result<Task, String> {
        let replacement = Self::prepare(input)?;
        self.update(|journal| {
            let index = journal
                .tasks
                .iter()
                .position(|task| task.id == id)
                .ok_or("Scheduled task not found")?;
            let previous = journal.tasks[index].clone();
            if previous.status != "scheduled" || previous.last_run_id != expected_last_run_id {
                return Err(
                    "This job has already started or changed. Refresh before editing its next run."
                        .into(),
                );
            }
            // Preserve original run context, including journals written before snapshots existed.
            for run in journal.runs.iter_mut().filter(|run| run.task_id == id) {
                run.prompt.get_or_insert(previous.prompt.clone());
                run.project_path
                    .get_or_insert(previous.project_path.clone());
                if run.harness.is_none() && run.model.is_none() {
                    run.model = previous.model.clone();
                }
                run.harness.get_or_insert(previous.harness.clone());
            }
            if is_digest(&previous) {
                return Err("Change the daily digest from the Digest tab.".into());
            }
            let updated = Task {
                id: previous.id,
                created_at: previous.created_at,
                last_run_id: previous.last_run_id,
                last_result: previous.last_result,
                ..replacement
            };
            journal.tasks[index] = updated.clone();
            Ok(updated)
        })
    }

    pub fn retry(
        &self,
        id: &str,
        start_at: u64,
        expected_last_run_id: Option<String>,
    ) -> Result<Task, String> {
        self.update(|journal| {
            let task = journal.tasks.iter_mut().find(|task| task.id == id).ok_or("Scheduled task not found")?;
            if !matches!(task.status.as_str(), "needs_attention" | "paused" | "failed" | "cancelled")
                || task.last_run_id != expected_last_run_id {
                return Err("Job changed or is already scheduled, running, or successful. Refresh before retrying.".into());
            }
            let run = journal.runs.iter().find(|run| Some(&run.run_id) == task.last_run_id.as_ref());
            let mut due = start_at.max(now().saturating_add(60));
            if let Some(run) = run {
                let harness = run.harness.as_deref().unwrap_or(&task.harness);
                if let Some(error) = run.events.iter().rev().find(|event| event.kind == "error") {
                    if let Some((reset, _)) = crate::adapters::classify_timed_quota(harness, error.text.as_deref().unwrap_or(""), error.at) {
                        due = due.max(crate::scheduler::after_reset(reset));
                    }
                }
                if let Some(retry) = run.events.iter().filter_map(|event| event.retry_at).max() { due = due.max(retry); }
                task.pending_resume_id = run.events.iter().rev().find_map(|event| event.resume_id.clone());
            } else { task.pending_resume_id = None; }
            task.next_run_at = Some(due);
            task.status = "scheduled".into();
            // Retain last run/result and all its events as an immutable attempt history.
            Ok(task.clone())
        })
    }

    pub fn cancel(&self, id: &str) -> Result<Option<String>, String> {
        self.update(|journal| {
            let task = journal
                .tasks
                .iter_mut()
                .find(|task| task.id == id)
                .ok_or_else(|| "Scheduled task not found".to_string())?;
            if task.status == "cancelled" {
                return Ok(None);
            }
            let run_id = if matches!(task.status.as_str(), "running" | "needs_attention") {
                task.last_run_id.clone()
            } else {
                None
            };
            task.status = "cancelled".into();
            task.next_run_at = None;
            task.last_result = Some("Cancelled".into());
            if let Some(id) = &run_id {
                if let Some(run) = journal.runs.iter_mut().find(|run| &run.run_id == id) {
                    run.status = "cancelled".into();
                    run.result = Some("Cancelled".into());
                    run.finished_at = Some(now());
                }
            }
            Ok(run_id)
        })
    }

    pub fn set_auto_resume(&self, id: &str, enabled: bool) -> Result<Task, String> {
        self.update(|journal| {
            let task = journal
                .tasks
                .iter_mut()
                .find(|task| task.id == id)
                .ok_or_else(|| "Scheduled task not found".to_string())?;
            if task.status == "cancelled" {
                return Err("Cancelled task cannot be changed".into());
            }
            task.auto_resume = enabled;
            Ok(task.clone())
        })
    }

    pub fn digest(&self) -> Option<Task> {
        self.journal.lock().unwrap().tasks.iter().find(|task| is_digest(task)).cloned()
    }

    /// Most recent digest runs, newest first.
    pub fn digest_runs(&self, limit: usize) -> Vec<TaskRun> {
        let journal = self.journal.lock().unwrap();
        let Some(id) = journal.tasks.iter().find(|task| is_digest(task)).map(|task| &task.id) else {
            return Vec::new();
        };
        journal
            .runs
            .iter()
            .rev()
            .filter(|run| &run.task_id == id)
            .take(limit)
            .cloned()
            .collect()
    }

    /// User jobs and their runs that started or finished at or after `since`.
    /// The digest's own runs are excluded so it never reports on itself.
    pub fn activity_since(&self, since: u64) -> (Vec<Task>, Vec<TaskRun>) {
        let journal = self.journal.lock().unwrap();
        let tasks: Vec<Task> = journal.tasks.iter().filter(|task| !is_digest(task)).cloned().collect();
        let runs = journal
            .runs
            .iter()
            .filter(|run| tasks.iter().any(|task| task.id == run.task_id))
            .filter(|run| run.started_at >= since || run.finished_at.is_some_and(|at| at >= since))
            .cloned()
            .collect();
        (tasks, runs)
    }

    pub fn set_digest(&self, input: DigestInput, project_path: String) -> Result<Task, String> {
        if crate::harness::get(&input.harness).is_none() {
            return Err("Unsupported harness".into());
        }
        if input.enabled && input.start_at == 0 {
            return Err("Choose a time for the digest".into());
        }
        // Read-only: the digest only summarizes data embedded in its prompt.
        let permissions = crate::harness::require(&input.harness)?.read_only();
        let model = input.model.filter(|value| !value.trim().is_empty());
        self.update(|journal| {
            let existing = journal.tasks.iter_mut().find(|task| is_digest(task));
            let Some(task) = existing else {
                if !input.enabled {
                    return Err("The daily digest is not set up".into());
                }
                let task = Task {
                    id: unique_id("digest"),
                    title: "Daily digest".into(),
                    prompt: "Summarize the last 24 hours of Noai jobs and agent usage.".into(),
                    harness: input.harness,
                    model,
                    project_path,
                    next_run_at: Some(input.start_at),
                    interval_seconds: Some(DAY),
                    status: "scheduled".into(),
                    last_run_id: None,
                    last_result: None,
                    auto_resume: input.auto_resume,
                    dangerously_bypass_permissions: false,
                    permissions: Some(permissions),
                    created_at: now(),
                    pending_resume_id: None,
                    kind: Some(DIGEST_KIND.into()),
                    anchor_at: Some(input.start_at),
                };
                journal.tasks.push(task.clone());
                return Ok(task);
            };
            task.harness = input.harness;
            task.model = model;
            task.permissions = Some(permissions);
            task.auto_resume = input.auto_resume;
            task.project_path = project_path;
            if input.enabled {
                task.anchor_at = Some(input.start_at);
                task.interval_seconds = Some(DAY);
                // A digest being written now keeps running; it reschedules on finish.
                if task.status != "running" {
                    task.status = "scheduled".into();
                    task.next_run_at = Some(input.start_at);
                }
            } else {
                task.status = "disabled".into();
                task.next_run_at = None;
                task.pending_resume_id = None;
            }
            Ok(task.clone())
        })
    }

    /// Queue an immediate digest without moving the daily schedule.
    pub fn run_digest_now(&self) -> Result<Task, String> {
        self.update(|journal| {
            let task = journal
                .tasks
                .iter_mut()
                .find(|task| is_digest(task))
                .ok_or("Turn on the daily digest first")?;
            match task.status.as_str() {
                "running" => Err("A digest is already being written".into()),
                "disabled" => Err("Turn on the daily digest first".into()),
                _ => {
                    task.status = "scheduled".into();
                    task.next_run_at = Some(now());
                    Ok(task.clone())
                }
            }
        })
    }

    pub fn claim_due(&self, at: u64) -> Result<Vec<(Task, RunRequest)>, String> {
        if !self
            .journal
            .lock()
            .unwrap()
            .tasks
            .iter()
            .any(|task| task.status == "scheduled" && task.next_run_at.is_some_and(|due| due <= at))
        {
            return Ok(Vec::new());
        }
        self.update(|journal| {
            let mut claims = Vec::new();
            for task in &mut journal.tasks {
                if task.status != "scheduled" || task.next_run_at.is_none_or(|due| due > at) {
                    continue;
                }
                let scheduled_at = task.next_run_at.unwrap_or(at);
                let run_id = unique_id("scheduled-run");
                let conversation_id = unique_id("scheduled-conversation");
                let resume_id = task.pending_resume_id.take();
                let prompt = if resume_id.is_some() {
                    format!("Continue this interrupted job. Inspect what is already completed, preserve existing work, and do not repeat completed actions. Original job instructions:\n\n{}", task.prompt)
                } else { task.prompt.clone() };
                let request = RunRequest {
                    run_id: run_id.clone(),
                    conversation_id: conversation_id.clone(),
                    harness: task.harness.clone(),
                    model: task.model.clone(),
                    project_path: task.project_path.clone(),
                    prompt,
                    resume_id,
                    auto_resume: task.auto_resume,
                    dangerously_bypass_permissions: task.dangerously_bypass_permissions,
                    permissions: task.permissions,
                };
                task.status = "running".into();
                task.last_run_id = Some(run_id.clone());
                task.last_result = None;
                task.next_run_at = None;
                journal.runs.push(TaskRun {
                    prompt: Some(request.prompt.clone()),
                    project_path: Some(task.project_path.clone()),
                    harness: Some(task.harness.clone()),
                    model: task.model.clone(),
                    run_id,
                    task_id: task.id.clone(),
                    conversation_id,
                    status: "running".into(),
                    started_at: at,
                    scheduled_at,
                    finished_at: None,
                    result: None,
                    dangerously_bypass_permissions: task.dangerously_bypass_permissions,
                    permissions: task.permissions,
                    events: Vec::new(),
                });
                claims.push((task.clone(), request));
            }
            Ok(claims)
        })
    }

    pub fn append_event(&self, run_id: &str, event: &RunEvent) -> Result<(), String> {
        self.update(|journal| {
            let run = journal
                .runs
                .iter_mut()
                .find(|run| run.run_id == run_id)
                .ok_or_else(|| "Scheduled run not found".to_string())?;
            run.events.push(StoredEvent {
                model: event.model.clone().filter(|model| !model.is_empty()),
                event_id: run.events.last().map_or(1, |old| old.event_id + 1),
                kind: event.kind.into(),
                text: event.text.clone(),
                resume_id: event.resume_id.clone(),
                retry_at: event.retry_at,
                usage: event.usage.clone(),
                at: now(),
            });
            Ok(())
        })
    }

    pub fn waiting(&self, run_id: &str) -> Result<(), String> {
        self.update(|journal| {
            let run = journal
                .runs
                .iter_mut()
                .find(|run| run.run_id == run_id)
                .ok_or_else(|| "Scheduled run not found".to_string())?;
            if run.status == "running" {
                run.status = "waiting".into();
            }
            Ok(())
        })
    }

    pub fn finish(
        &self,
        run_id: &str,
        status: &str,
        result: String,
        at: u64,
    ) -> Result<Option<Task>, String> {
        self.update(|journal| {
            let run = journal
                .runs
                .iter_mut()
                .find(|run| run.run_id == run_id)
                .ok_or_else(|| "Scheduled run not found".to_string())?;
            if run.status == "cancelled" || run.status == "completed" {
                return Ok(None);
            }
            run.status = status.into();
            run.result = Some(result.clone());
            run.finished_at = Some(at);
            let scheduled_at = run.scheduled_at;
            let task = journal
                .tasks
                .iter_mut()
                .find(|task| task.id == run.task_id)
                .ok_or_else(|| "Scheduled task not found".to_string())?;
            if task.status == "cancelled" {
                return Ok(None);
            }
            task.last_result = Some(result);
            if is_digest(task) {
                // A digest failure must not stop tomorrow's digest.
                if task.status != "disabled" {
                    let anchor = task.anchor_at.unwrap_or(scheduled_at);
                    task.next_run_at = Some(next_daily(anchor, at));
                    task.status = "scheduled".into();
                }
                return Ok(Some(task.clone()));
            }
            if let Some(interval) = task.interval_seconds.filter(|_| status == "completed") {
                // Skip missed occurrences; never launch a catch-up burst.
                let elapsed = at.saturating_sub(scheduled_at);
                let missed = elapsed / interval;
                task.next_run_at = Some(
                    scheduled_at.saturating_add(missed.saturating_add(1).saturating_mul(interval)),
                );
                task.status = "scheduled".into();
            } else {
                task.next_run_at = None;
                task.status = status.into();
            }
            Ok(Some(task.clone()))
        })
    }
}

fn save(path: &Path, journal: &Journal) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(journal).map_err(|error| error.to_string())?;
    let temp = path.with_extension(format!("{}.tmp", unique_id("write")));
    let result = (|| -> std::io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        crate::platform::restrict_new_file(&mut options);
        let mut file = options.open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        crate::platform::sync_parent_dir(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|error| format!("Cannot save scheduled tasks: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_keeps_its_daily_time_survives_failure_and_stays_off() {
        let dir = std::env::temp_dir().join(unique_id("noai-digest-test"));
        let store = ScheduledTasks::open_in_dir(&dir).unwrap();
        let anchor = now() + 3_600;
        let input = |enabled| DigestInput {
            enabled,
            harness: "claude".into(),
            model: Some("sonnet".into()),
            start_at: anchor,
            auto_resume: true,
        };
        let task = store.set_digest(input(true), "/tmp".into()).unwrap();
        assert_eq!(task.next_run_at, Some(anchor));
        assert_eq!(task.permissions, Some(crate::adapters::JobPermissions::ProviderDefault));
        assert!(store.list().iter().filter(|task| is_digest(task)).count() == 1);

        // Run now, then fail: the next run is still the configured daily time.
        store.run_digest_now().unwrap();
        let (claimed, request) = store.claim_due(now() + 1).unwrap().remove(0);
        assert!(is_digest(&claimed));
        assert!(store.run_digest_now().is_err(), "no second digest while one runs");
        let after = store.finish(&request.run_id, "failed", "boom".into(), now() + 5).unwrap().unwrap();
        assert_eq!(after.status, "scheduled");
        assert_eq!(after.next_run_at, Some(anchor));

        // After the anchored run, it moves exactly one day later.
        let request = store.claim_due(anchor).unwrap().remove(0).1;
        let after = store.finish(&request.run_id, "completed", "ok".into(), anchor + 60).unwrap().unwrap();
        assert_eq!(after.next_run_at, Some(anchor + DAY));
        assert_eq!(store.digest_runs(10).len(), 2);

        let off = store.set_digest(input(false), "/tmp".into()).unwrap();
        assert_eq!((off.status.as_str(), off.next_run_at), ("disabled", None));
        assert!(store.claim_due(anchor + 2 * DAY).unwrap().is_empty());
        assert!(store.run_digest_now().is_err());
        assert!(store.activity_since(0).0.is_empty(), "digest never reports on itself");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn manual_retry_preserves_history_continues_session_and_honors_reset() {
        let dir = std::env::temp_dir().join(unique_id("noai-retry-test"));
        let store = ScheduledTasks::open_in_dir(&dir).unwrap();
        let input: CreateTaskInput = serde_json::from_value(serde_json::json!({
            "title":"Retry", "prompt":"Implement changes", "harness":"codex", "projectPath":"/tmp",
            "startAt":now(), "autoResume":true, "permissions":"workspace-network"
        }))
        .unwrap();
        let task = store.create(input).unwrap();
        let request = store.claim_due(now() + 1).unwrap().remove(0).1;
        let mut session = RunEvent::new(&request, "session", None);
        session.resume_id = Some("original-provider-session".into());
        store.append_event(&request.run_id, &session).unwrap();
        store
            .append_event(
                &request.run_id,
                &RunEvent::new(
                    &request,
                    "error",
                    Some("Usage limit reached. Try again in 1h".into()),
                ),
            )
            .unwrap();
        store
            .finish(
                &request.run_id,
                "needs_attention",
                "Timed limit".into(),
                now(),
            )
            .unwrap();
        let original = serde_json::to_value(&store.runs(&task.id).unwrap()[0]).unwrap();
        assert!(store.retry(&task.id, now() + 60, None).is_err());
        let queued = store
            .retry(&task.id, now() + 60, Some(request.run_id.clone()))
            .unwrap();
        assert_eq!(
            queued.pending_resume_id.as_deref(),
            Some("original-provider-session")
        );
        let error_at = original["events"][1]["at"].as_u64().unwrap();
        assert_eq!(queued.next_run_at, Some(error_at + 3600 + 60));
        assert!(store
            .retry(&task.id, now() + 60, Some(request.run_id.clone()))
            .is_err());
        assert_eq!(
            serde_json::to_value(&store.runs(&task.id).unwrap()[0]).unwrap(),
            original
        );
        drop(store);
        let store = ScheduledTasks::open_in_dir(&dir).unwrap();
        let resumed = store
            .claim_due(queued.next_run_at.unwrap())
            .unwrap()
            .remove(0)
            .1;
        assert_eq!(
            resumed.resume_id.as_deref(),
            Some("original-provider-session")
        );
        assert_eq!(resumed.permissions, request.permissions);
        assert_ne!(resumed.run_id, request.run_id);
        assert!(resumed.prompt.contains("do not repeat completed actions"));
        assert_eq!(
            serde_json::to_value(&store.runs(&task.id).unwrap()[0]).unwrap(),
            original
        );
        assert!(store.list()[0].pending_resume_id.is_none());
        store
            .finish(&resumed.run_id, "completed", "Done".into(), now())
            .unwrap();
        assert!(store
            .retry(&task.id, now() + 60, Some(resumed.run_id))
            .is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn edits_only_unclaimed_occurrences_and_preserves_history() {
        let dir = std::env::temp_dir().join(unique_id("noai-edit-test"));
        let store = ScheduledTasks::open_in_dir(&dir).unwrap();
        let original = CreateTaskInput {
            title: "Original".into(),
            prompt: "Old instructions".into(),
            harness: "codex".into(),
            model: None,
            project_path: "/tmp".into(),
            start_at: now() + 3600,
            interval_seconds: Some(3600),
            auto_resume: true,
            dangerously_bypass_permissions: false,
            permissions: None,
        };
        let task = store.create(original.clone()).unwrap();
        assert_eq!(
            task.permissions,
            Some(crate::adapters::JobPermissions::WorkspaceNetwork)
        );
        let mut changes = original.clone();
        changes.title = "Updated".into();
        changes.prompt = "New instructions".into();
        changes.harness = "claude".into();
        changes.model = Some("test-model".into());
        changes.start_at = now() + 7200;
        changes.interval_seconds = Some(90);
        changes.auto_resume = false;
        let edited = store.edit(&task.id, changes.clone(), None).unwrap();
        assert_eq!(edited.id, task.id);
        assert_eq!(edited.created_at, task.created_at);
        assert_eq!(edited.title, "Updated");
        assert_eq!(edited.next_run_at, Some(changes.start_at));
        assert_eq!(edited.interval_seconds, Some(90));
        assert!(!edited.auto_resume);
        let mut invalid = changes.clone();
        invalid.interval_seconds = Some(30);
        assert!(store.edit(&task.id, invalid, None).is_err());
        assert_eq!(store.list()[0].interval_seconds, Some(90));
        let claims = store.claim_due(changes.start_at).unwrap();
        let request = &claims[0].1;
        assert_eq!(request.harness, "claude");
        assert_eq!(
            request.permissions,
            Some(crate::adapters::JobPermissions::AutoReview)
        );
        assert_eq!(
            store.runs(&task.id).unwrap()[0].permissions,
            request.permissions
        );
        assert_eq!(request.model.as_deref(), Some("test-model"));
        assert_eq!(request.prompt, "New instructions");
        assert!(store.edit(&task.id, original.clone(), None).is_err());
        store.waiting(&request.run_id).unwrap();
        assert!(store
            .edit(&task.id, original.clone(), Some(request.run_id.clone()))
            .is_err());
        store
            .finish(
                &request.run_id,
                "completed",
                "Done".into(),
                changes.start_at + 1,
            )
            .unwrap();
        // A stale editor cannot silently change a later occurrence after its run completed.
        assert!(store.edit(&task.id, original.clone(), None).is_err());
        let updated = store
            .edit(&task.id, original.clone(), Some(request.run_id.clone()))
            .unwrap();
        assert_eq!(
            updated.last_run_id.as_deref(),
            Some(request.run_id.as_str())
        );
        let history = store.runs(&task.id).unwrap();
        assert_eq!(history[0].prompt.as_deref(), Some("New instructions"));
        assert_eq!(history[0].harness.as_deref(), Some("claude"));
        assert_eq!(history[0].model.as_deref(), Some("test-model"));
        drop(store);
        let reopened = ScheduledTasks::open_in_dir(&dir).unwrap();
        assert_eq!(reopened.list()[0].title, "Original");
        reopened.cancel(&task.id).unwrap();
        assert!(reopened
            .edit(&task.id, original.clone(), Some(request.run_id.clone()))
            .is_err());
        let once = reopened
            .create(CreateTaskInput {
                interval_seconds: None,
                ..original.clone()
            })
            .unwrap();
        assert!(reopened
            .edit(
                &once.id,
                CreateTaskInput {
                    interval_seconds: None,
                    ..original.clone()
                },
                None
            )
            .is_ok());
        let run = reopened.claim_due(now() + 3600).unwrap().pop().unwrap().1;
        reopened
            .finish(&run.run_id, "completed", "Done".into(), now() + 3601)
            .unwrap();
        assert!(reopened.edit(&once.id, original, Some(run.run_id)).is_err());
        drop(reopened);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn old_schedule_defaults_to_normal_permissions() {
        let input: CreateTaskInput = serde_json::from_value(serde_json::json!({
            "title": "Old task", "prompt": "Check", "harness": "codex",
            "model": null, "projectPath": "/tmp", "startAt": 1,
            "intervalSeconds": null, "autoResume": false
        }))
        .unwrap();
        assert!(!input.dangerously_bypass_permissions);
        let dir = std::env::temp_dir().join(unique_id("noai-scheduled-test"));
        let store = ScheduledTasks::open_in_dir(&dir).unwrap();
        let task = store.create(input).unwrap();
        let mut old_task = serde_json::to_value(&task).unwrap();
        old_task
            .as_object_mut()
            .unwrap()
            .remove("dangerouslyBypassPermissions");
        old_task.as_object_mut().unwrap().remove("permissions");
        let decoded: Task = serde_json::from_value(old_task).unwrap();
        assert_eq!(decoded.permissions, None);
        assert!(!decoded.dangerously_bypass_permissions);
        drop(store);
        let mut old_journal = serde_json::from_slice::<serde_json::Value>(
            &fs::read(dir.join("scheduled-tasks.json")).unwrap(),
        )
        .unwrap();
        old_journal["tasks"][0]
            .as_object_mut()
            .unwrap()
            .remove("dangerouslyBypassPermissions");
        old_journal["tasks"][0]
            .as_object_mut()
            .unwrap()
            .remove("permissions");
        fs::write(
            dir.join("scheduled-tasks.json"),
            serde_json::to_vec(&old_journal).unwrap(),
        )
        .unwrap();
        let reopened = ScheduledTasks::open_in_dir(&dir).unwrap();
        assert!(!reopened.list()[0].dangerously_bypass_permissions);
        assert_eq!(reopened.list()[0].permissions, None);
        drop(reopened);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn recurring_task_persists_history_and_skips_missed_occurrences() {
        let dir = std::env::temp_dir().join(unique_id("noai-scheduled-test"));
        let store = ScheduledTasks::open_in_dir(&dir).unwrap();
        let task = store
            .create(CreateTaskInput {
                title: "Daily check".into(),
                prompt: "Check".into(),
                harness: "codex".into(),
                model: None,
                project_path: "/tmp".into(),
                start_at: now(),
                interval_seconds: Some(60),
                auto_resume: false,
                dangerously_bypass_permissions: true,
                permissions: None,
            })
            .unwrap();
        let at = now();
        let claims = store.claim_due(at).unwrap();
        assert_eq!(claims.len(), 1);
        assert!(store.claim_due(at + 1000).unwrap().is_empty());
        let (_, request) = &claims[0];
        assert!(request.dangerously_bypass_permissions);
        assert!(claims[0].0.dangerously_bypass_permissions);
        assert!(store.runs(&task.id).unwrap()[0].dangerously_bypass_permissions);
        let run = &store.runs(&task.id).unwrap()[0];
        assert_eq!(run.harness.as_deref(), Some("codex"));
        let mut legacy = serde_json::to_value(run).unwrap();
        legacy.as_object_mut().unwrap().remove("harness");
        legacy.as_object_mut().unwrap().remove("model");
        assert!(serde_json::from_value::<TaskRun>(legacy)
            .unwrap()
            .harness
            .is_none());
        let mut usage = RunEvent::new(request, "usage", None);
        usage.model = Some("observed-model".into());
        store.append_event(&request.run_id, &usage).unwrap();
        assert_eq!(
            store.runs(&task.id).unwrap()[0].events[0].model.as_deref(),
            Some("observed-model")
        );
        store
            .append_event(
                &request.run_id,
                &RunEvent::new(request, "text", Some("ok".into())),
            )
            .unwrap();
        let updated = store
            .finish(&request.run_id, "completed", "Completed".into(), at + 1000)
            .unwrap()
            .unwrap();
        let next = updated.next_run_at.unwrap();
        assert!(next > at + 1000 && next <= at + 1060);
        assert_eq!(
            (next - store.runs(&task.id).unwrap()[0].scheduled_at) % 60,
            0
        );
        assert_eq!(
            store.runs(&task.id).unwrap()[0].events[1].text.as_deref(),
            Some("ok")
        );
        drop(store);
        let reopened = ScheduledTasks::open_in_dir(&dir).unwrap();
        assert_eq!(reopened.list()[0].next_run_at, Some(next));
        assert!(reopened.list()[0].dangerously_bypass_permissions);
        assert_eq!(reopened.runs(&task.id).unwrap().len(), 1);
        drop(reopened);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn restart_does_not_replay_uncertain_run() {
        let dir = std::env::temp_dir().join(unique_id("noai-scheduled-test"));
        let store = ScheduledTasks::open_in_dir(&dir).unwrap();
        let task = store
            .create(CreateTaskInput {
                title: "One".into(),
                prompt: "Check".into(),
                harness: "codex".into(),
                model: None,
                project_path: "/tmp".into(),
                start_at: now(),
                interval_seconds: None,
                auto_resume: false,
                dangerously_bypass_permissions: false,
                permissions: None,
            })
            .unwrap();
        store.claim_due(now()).unwrap();
        drop(store);
        let reopened = ScheduledTasks::open_in_dir(&dir).unwrap();
        assert_eq!(reopened.list()[0].status, "needs_attention");
        assert_eq!(
            reopened.runs(&task.id).unwrap()[0].status,
            "needs_attention"
        );
        assert!(reopened.claim_due(now() + 100).unwrap().is_empty());
        drop(reopened);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn cancel_prevents_future_claims_and_rejects_short_interval() {
        let dir = std::env::temp_dir().join(unique_id("noai-scheduled-test"));
        let store = ScheduledTasks::open_in_dir(&dir).unwrap();
        let input = CreateTaskInput {
            title: "Check".into(),
            prompt: "Check".into(),
            harness: "codex".into(),
            model: None,
            project_path: "/tmp".into(),
            start_at: now() + 30,
            interval_seconds: Some(59),
            auto_resume: false,
            dangerously_bypass_permissions: false,
            permissions: None,
        };
        assert!(store.create(input).is_err());
        let task = store
            .create(CreateTaskInput {
                title: "Check".into(),
                prompt: "Check".into(),
                harness: "codex".into(),
                model: None,
                project_path: "/tmp".into(),
                start_at: now() + 30,
                interval_seconds: Some(60),
                auto_resume: false,
                dangerously_bypass_permissions: false,
                permissions: None,
            })
            .unwrap();
        store.cancel(&task.id).unwrap();
        assert!(store.claim_due(now() + 1000).unwrap().is_empty());
        drop(store);
        let reopened = ScheduledTasks::open_in_dir(&dir).unwrap();
        assert_eq!(reopened.list()[0].status, "cancelled");
        drop(reopened);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn waiting_quota_run_survives_restart_and_cancel_keeps_run_link() {
        let dir = std::env::temp_dir().join(unique_id("noai-scheduled-test"));
        let store = ScheduledTasks::open_in_dir(&dir).unwrap();
        let task = store
            .create(CreateTaskInput {
                title: "Check".into(),
                prompt: "Check".into(),
                harness: "codex".into(),
                model: None,
                project_path: "/tmp".into(),
                start_at: now(),
                interval_seconds: Some(60),
                auto_resume: true,
                dangerously_bypass_permissions: false,
                permissions: None,
            })
            .unwrap();
        let claims = store.claim_due(now()).unwrap();
        let run_id = claims[0].1.run_id.clone();
        store.waiting(&run_id).unwrap();
        drop(store);
        let reopened = ScheduledTasks::open_in_dir(&dir).unwrap();
        assert_eq!(reopened.list()[0].status, "running");
        assert_eq!(
            reopened.cancel(&task.id).unwrap().as_deref(),
            Some(run_id.as_str())
        );
        assert!(!reopened.launchable(&run_id));
        drop(reopened);
        fs::remove_dir_all(dir).unwrap();
    }
}
