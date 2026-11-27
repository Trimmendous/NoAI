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
    /// Work on a separate git worktree and wait for review (git projects only).
    #[serde(default)]
    pub worktree: bool,
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
    /// Each run works on its own git worktree; changes wait in Changes.
    #[serde(default)]
    pub worktree: bool,
}

impl Task {
    fn schedule_next_occurrence(&mut self, scheduled_at: u64, at: u64, interval: u64) {
        // Skip missed occurrences while keeping the original cadence.
        let missed = at.saturating_sub(scheduled_at) / interval;
        self.next_run_at = Some(
            scheduled_at.saturating_add(missed.saturating_add(1).saturating_mul(interval)),
        );
        self.status = "scheduled".into();
    }
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
    /// What the user wants the digest to cover. Blank means the default digest.
    #[serde(default)]
    pub instructions: Option<String>,
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
    /// The run's git worktree, when the job uses one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<crate::worktrees::Worktree>,
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
    #[serde(default)]
    instructions: JobInstructions,
    #[serde(default)]
    automation: AutomationSettings,
}

/// Notifications and the usage budget, used by the background service.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationSettings {
    #[serde(default = "default_true")]
    pub notify_finished: bool,
    #[serde(default = "default_true")]
    pub notify_problems: bool,
    #[serde(default = "default_true")]
    pub notify_limits: bool,
    /// Percent of each usage limit kept for you: a job only starts while every
    /// limit of its agent is below 100 minus this. `None` means no budget.
    #[serde(default)]
    pub reserve_percent: Option<u8>,
}

impl Default for AutomationSettings {
    fn default() -> Self {
        Self {
            notify_finished: true,
            notify_problems: true,
            notify_limits: true,
            reserve_percent: None,
        }
    }
}

/// The user's standing instructions, added to every run of every job of
/// that kind (the digest has its own). Each run saves the full prompt it was sent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInstructions {
    #[serde(default)]
    pub recurring: String,
    #[serde(default)]
    pub one_time: String,
    /// Recurring jobs keep a SUMMARY.md log: a table with one row per run,
    /// then a short section per run. On unless turned off.
    #[serde(default = "default_true")]
    pub summary_log: bool,
}

impl Default for JobInstructions {
    fn default() -> Self {
        Self {
            recurring: String::new(),
            one_time: String::new(),
            summary_log: true,
        }
    }
}

const MAX_INSTRUCTIONS: usize = 4000;

/// The SUMMARY.md log instructions for run number `run` of a recurring job.
fn summary_log(task: &Task, run: usize, date: &str) -> String {
    include_str!("summary-log.md")
        .trim()
        .replace("{run}", &run.to_string())
        .replace("{date}", date)
        .replace("{title}", task.title.trim())
}

fn with_instructions(
    instructions: &JobInstructions,
    task: &Task,
    run: usize,
    date: &str,
) -> String {
    let prompt = with_standing(instructions, task);
    if task.interval_seconds.is_some() && instructions.summary_log {
        format!(
            "{prompt}

--- Summary log ---

{}",
            summary_log(task, run, date)
        )
    } else {
        prompt
    }
}

fn with_standing(instructions: &JobInstructions, task: &Task) -> String {
    let global = if task.interval_seconds.is_some() {
        &instructions.recurring
    } else {
        &instructions.one_time
    };
    if global.trim().is_empty() {
        task.prompt.clone()
    } else {
        format!(
            "Standing instructions for all my {} jobs:\n{}\n\nThis job:\n{}",
            if task.interval_seconds.is_some() {
                "recurring"
            } else {
                "one-time"
            },
            global.trim(),
            task.prompt
        )
    }
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
            let Some(interval) = task.interval_seconds.filter(|interval| *interval > 0) else {
                continue;
            };
            if is_digest(task)
                || !matches!(task.status.as_str(), "failed" | "needs_attention")
                || task.next_run_at.is_some()
                || task.pending_resume_id.is_some()
            {
                continue;
            }
            // Older versions stopped recurring jobs on a terminal failure.
            // Interrupted runs have a separate review message on the job.
            if let Some(run) = journal.runs.iter().find(|run| {
                task.last_run_id.as_ref() == Some(&run.run_id)
                    && run.status == task.status
                    && run.finished_at.is_some()
                    && run.result.is_some()
                    && run.result == task.last_result
            }) {
                let scheduled_at = if run.scheduled_at == 0 {
                    run.started_at
                } else {
                    run.scheduled_at
                };
                task.schedule_next_occurrence(scheduled_at, now(), interval);
                changed = true;
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
            worktree: input.worktree,
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
            if matches!(previous.status.as_str(), "cancelled" | "completed") {
                return Err(
                    "This job has ended. Use Run again to start a new one with these settings."
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
            // Waiting jobs take the new start time. A running job keeps going
            // with its old settings and the changes apply from the next run;
            // a job that stopped keeps its state until Retry. If a run started
            // and ended while the form was open, the edited start time is stale.
            let restarted = previous.last_run_id != expected_last_run_id;
            let next_run_at = match previous.status.as_str() {
                "scheduled" | "paused" if !restarted => replacement.next_run_at,
                _ => previous.next_run_at,
            };
            let updated = Task {
                id: previous.id,
                created_at: previous.created_at,
                last_run_id: previous.last_run_id,
                last_result: previous.last_result,
                status: previous.status,
                pending_resume_id: previous.pending_resume_id,
                next_run_at,
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

    /// Stops a scheduled job from starting until it is resumed. A run already
    /// in progress is not interrupted; cancel it instead.
    pub fn pause(&self, id: &str) -> Result<Task, String> {
        self.update(|journal| {
            let task = journal
                .tasks
                .iter_mut()
                .find(|task| task.id == id && !is_digest(task))
                .ok_or_else(|| "Scheduled task not found".to_string())?;
            if task.status != "scheduled" {
                return Err("Only a job that is waiting for its next run can be paused. Cancel a running job instead.".into());
            }
            task.status = "paused".into();
            Ok(task.clone())
        })
    }

    /// Puts a paused job back on its schedule. A recurring job skips the
    /// occurrences it missed while paused; a one-time job that is overdue runs now.
    pub fn resume(&self, id: &str) -> Result<Task, String> {
        self.update(|journal| {
            let task = journal
                .tasks
                .iter_mut()
                .find(|task| task.id == id && !is_digest(task))
                .ok_or_else(|| "Scheduled task not found".to_string())?;
            if task.status != "paused" {
                return Err("This job is not paused.".into());
            }
            let current = now();
            let mut due = task.next_run_at.unwrap_or(current).max(task.created_at);
            match task.interval_seconds.filter(|interval| *interval > 0) {
                Some(interval) if due < current => {
                    due += (current - due).div_ceil(interval) * interval
                }
                _ => due = due.max(current),
            }
            task.next_run_at = Some(due);
            task.status = "scheduled".into();
            Ok(task.clone())
        })
    }

    /// The earliest time a job (the digest included) is due to start.
    pub fn next_due(&self) -> Option<u64> {
        self.journal
            .lock()
            .unwrap()
            .tasks
            .iter()
            .filter(|task| task.status == "scheduled")
            .filter_map(|task| task.next_run_at)
            .min()
    }

    pub fn automation(&self) -> AutomationSettings {
        self.journal.lock().unwrap().automation.clone()
    }

    pub fn set_automation(
        &self,
        mut input: AutomationSettings,
    ) -> Result<AutomationSettings, String> {
        input.reserve_percent = input.reserve_percent.map(|value| value.clamp(5, 95));
        self.update(|journal| {
            journal.automation = input.clone();
            Ok(input)
        })
    }

    /// Records (or updates) a run's worktree.
    pub fn set_run_worktree(
        &self,
        run_id: &str,
        tree: crate::worktrees::Worktree,
    ) -> Result<(), String> {
        self.update(|journal| {
            let run = journal
                .runs
                .iter_mut()
                .find(|run| run.run_id == run_id)
                .ok_or("Scheduled run not found")?;
            run.worktree = Some(tree);
            Ok(())
        })
    }

    /// A run's worktree and its job's title.
    pub fn run_worktree(&self, run_id: &str) -> Option<(String, crate::worktrees::Worktree)> {
        let journal = self.journal.lock().unwrap();
        let run = journal.runs.iter().find(|run| run.run_id == run_id)?;
        let title = journal
            .tasks
            .iter()
            .find(|task| task.id == run.task_id)
            .map(|task| task.title.clone())
            .unwrap_or_default();
        Some((title, run.worktree.clone()?))
    }

    /// The worktree a resumed run should continue in: its job's latest one still in use.
    pub fn resumable_worktree(&self, task_id: &str) -> Option<crate::worktrees::Worktree> {
        let journal = self.journal.lock().unwrap();
        journal
            .runs
            .iter()
            .rev()
            .filter(|run| run.task_id == task_id)
            .filter_map(|run| run.worktree.clone())
            .find(|tree| tree.review == "running" || tree.review == "pending")
    }

    /// Runs whose changes wait for review (and recently handled ones), newest first.
    pub fn changes(&self) -> Vec<serde_json::Value> {
        let journal = self.journal.lock().unwrap();
        journal
            .runs
            .iter()
            .rev()
            .filter(|run| run.worktree.as_ref().is_some_and(|tree| tree.review != "none"))
            .take(200)
            .map(|run| {
                let task = journal.tasks.iter().find(|task| task.id == run.task_id);
                serde_json::json!({
                    "runId": run.run_id, "taskId": run.task_id, "title": task.map(|task| task.title.clone()).unwrap_or_default(),
                    "harness": run.harness.clone().or_else(|| task.map(|task| task.harness.clone())), "status": run.status,
                    "startedAt": run.started_at, "finishedAt": run.finished_at, "worktree": run.worktree,
                })
            })
            .collect()
    }

    /// Takes back a claimed run that hasn't started (the usage budget held it):
    /// the job goes back on the schedule at `until` and says why.
    pub fn defer(&self, run_id: &str, until: u64, reason: &str) -> Result<Option<Task>, String> {
        self.update(|journal| {
            let Some(index) = journal.runs.iter().position(|run| run.run_id == run_id) else {
                return Ok(None);
            };
            let run = journal.runs.remove(index);
            let Some(task) = journal.tasks.iter_mut().find(|task| task.id == run.task_id) else {
                return Ok(None);
            };
            if task.status != "running" || task.last_run_id.as_deref() != Some(run_id) {
                return Ok(None);
            }
            task.status = "scheduled".into();
            task.next_run_at = Some(until.max(now()));
            task.last_run_id = journal
                .runs
                .iter()
                .rev()
                .find(|other| other.task_id == task.id)
                .map(|other| other.run_id.clone());
            task.last_result = Some(reason.to_owned());
            Ok(Some(task.clone()))
        })
    }

    /// Puts an agent's jobs that its Go / Wait / Stop light held (their last
    /// result starts with one of `prefixes`) back on the schedule now.
    pub fn release_held(
        &self,
        harness: &str,
        prefixes: &[&str],
        now_epoch: u64,
    ) -> Result<Vec<Task>, String> {
        self.update(|journal| {
            let mut released = Vec::new();
            for task in &mut journal.tasks {
                let held = task.status == "scheduled"
                    && task.harness == harness
                    && task.last_result.as_deref().is_some_and(|result| {
                        prefixes.iter().any(|prefix| result.starts_with(prefix))
                    });
                if held && task.next_run_at.is_some_and(|at| at > now_epoch) {
                    task.next_run_at = Some(now_epoch);
                    released.push(task.clone());
                }
            }
            Ok(released)
        })
    }

    pub fn instructions(&self) -> JobInstructions {
        self.journal.lock().unwrap().instructions.clone()
    }

    pub fn set_instructions(&self, input: JobInstructions) -> Result<JobInstructions, String> {
        let clean = JobInstructions {
            recurring: input.recurring.trim().to_owned(),
            one_time: input.one_time.trim().to_owned(),
            summary_log: input.summary_log,
        };
        if clean.recurring.chars().count() > MAX_INSTRUCTIONS
            || clean.one_time.chars().count() > MAX_INSTRUCTIONS
        {
            return Err(format!(
                "Instructions must be {MAX_INSTRUCTIONS} characters or fewer"
            ));
        }
        self.update(|journal| {
            journal.instructions = clean.clone();
            Ok(clean)
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
        self.journal
            .lock()
            .unwrap()
            .tasks
            .iter()
            .find(|task| is_digest(task))
            .cloned()
    }

    /// Most recent digest runs, newest first.
    pub fn digest_runs(&self, limit: usize) -> Vec<TaskRun> {
        let journal = self.journal.lock().unwrap();
        let Some(id) = journal
            .tasks
            .iter()
            .find(|task| is_digest(task))
            .map(|task| &task.id)
        else {
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
        let tasks: Vec<Task> = journal
            .tasks
            .iter()
            .filter(|task| !is_digest(task))
            .cloned()
            .collect();
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
        let prompt = match input.instructions.as_deref().map(str::trim) {
            Some(text) if text.chars().count() > 4000 => {
                return Err("Keep the digest instructions under 4,000 characters".into())
            }
            Some(text) if !text.is_empty() => text.to_owned(),
            _ => crate::digest::DEFAULT_PROMPT.to_owned(),
        };
        self.update(|journal| {
            let existing = journal.tasks.iter_mut().find(|task| is_digest(task));
            let Some(task) = existing else {
                if !input.enabled {
                    return Err("The daily digest is not set up".into());
                }
                let task = Task {
                    id: unique_id("digest"),
                    title: "Daily digest".into(),
                    prompt,
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
                    worktree: false,
                };
                journal.tasks.push(task.clone());
                return Ok(task);
            };
            task.harness = input.harness;
            task.model = model;
            task.prompt = prompt;
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
            let instructions = journal.instructions.clone();
            // Runs are numbered per job, as the Jobs page shows them.
            let mut run_counts: std::collections::HashMap<String, usize> = Default::default();
            for run in &journal.runs {
                *run_counts.entry(run.task_id.clone()).or_default() += 1;
            }
            let date = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
            for task in &mut journal.tasks {
                if task.status != "scheduled" || task.next_run_at.is_none_or(|due| due > at) {
                    continue;
                }
                let scheduled_at = task.next_run_at.unwrap_or(at);
                let run_id = unique_id("scheduled-run");
                let conversation_id = unique_id("scheduled-conversation");
                let resume_id = task.pending_resume_id.take();
                let base = if is_digest(task) { task.prompt.clone() } else { with_instructions(&instructions, task, run_counts.get(&task.id).copied().unwrap_or(0) + 1, &date) };
                let prompt = if resume_id.is_some() {
                    format!("Continue this interrupted job. Inspect what is already completed, preserve existing work, and do not repeat completed actions. Original job instructions:\n\n{base}")
                } else { base };
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
                    worktree: None,
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
            if !matches!(run.status.as_str(), "running" | "waiting") {
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
            if task.status == "cancelled" || task.last_run_id.as_deref() != Some(run_id) {
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
            if let Some(interval) = task.interval_seconds.filter(|interval| {
                *interval > 0 && matches!(status, "completed" | "failed" | "needs_attention")
            }) {
                task.schedule_next_occurrence(scheduled_at, at, interval);
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
    fn edit_applies_to_running_and_paused_jobs() {
        let dir = std::env::temp_dir().join(unique_id("noai-edit-test"));
        fs::create_dir_all(&dir).unwrap();
        let store = ScheduledTasks::open_in_dir(&dir).unwrap();
        let input = |prompt: &str, interval: u64| CreateTaskInput {
            title: "Job".into(),
            prompt: prompt.into(),
            harness: "claude".into(),
            model: None,
            project_path: dir.to_string_lossy().into_owned(),
            start_at: now() + 600,
            interval_seconds: Some(interval),
            auto_resume: false,
            dangerously_bypass_permissions: false,
            permissions: None,
            worktree: false,
        };
        let task = store.create(input("old", 3600)).unwrap();
        store.pause(&task.id).unwrap();
        let edited = store
            .edit(
                &task.id,
                CreateTaskInput {
                    model: Some("m2".into()),
                    ..input("new", 7200)
                },
                None,
            )
            .unwrap();
        assert_eq!(
            (
                edited.status.as_str(),
                edited.prompt.as_str(),
                edited.interval_seconds,
                edited.model.as_deref()
            ),
            ("paused", "new", Some(7200), Some("m2"))
        );
        store.resume(&task.id).unwrap();
        let claimed = store.claim_due(now() + 7200).unwrap();
        assert!(claimed[0].1.prompt.starts_with("new\n\n--- Summary log ---"));
        let run_id = claimed[0].0.last_run_id.clone();
        let edited = store
            .edit(&task.id, input("newer", 60), run_id.clone())
            .unwrap();
        assert_eq!(
            (edited.status.as_str(), edited.next_run_at),
            ("running", None)
        );
        let finished = store
            .finish(run_id.as_deref().unwrap(), "completed", "ok".into(), now())
            .unwrap()
            .unwrap();
        assert_eq!(
            (finished.prompt.as_str(), finished.interval_seconds),
            ("newer", Some(60))
        );
        store.cancel(&task.id).unwrap();
        assert!(store.edit(&task.id, input("x", 60), run_id).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn standing_instructions_apply_by_job_kind() {
        let dir = std::env::temp_dir().join(unique_id("noai-instructions-test"));
        fs::create_dir_all(&dir).unwrap();
        let store = ScheduledTasks::open_in_dir(&dir).unwrap();
        let input = |interval: Option<u64>| CreateTaskInput {
            title: "Job".into(),
            prompt: "Do the thing".into(),
            harness: "claude".into(),
            model: None,
            project_path: dir.to_string_lossy().into_owned(),
            start_at: now(),
            interval_seconds: interval,
            auto_resume: false,
            dangerously_bypass_permissions: false,
            permissions: None,
            worktree: false,
        };
        store.create(input(Some(3600))).unwrap();
        store.create(input(None)).unwrap();
        store
            .set_instructions(JobInstructions {
                recurring: " Be brief. ".into(),
                one_time: String::new(),
                summary_log: true,
            })
            .unwrap();
        assert!(store
            .set_instructions(JobInstructions {
                recurring: "x".repeat(4001),
                one_time: String::new(),
                summary_log: true,
            })
            .is_err());
        let claims = store.claim_due(now() + 1).unwrap();
        let prompt = |recurring: bool| {
            claims
                .iter()
                .find(|(task, _)| task.interval_seconds.is_some() == recurring)
                .unwrap()
                .1
                .prompt
                .clone()
        };
        // Recurring: standing instructions, the job, then the SUMMARY.md log for run #1.
        let recurring = prompt(true);
        assert!(
            recurring.contains("Be brief.")
                && recurring.contains("This job:\nDo the thing\n\n--- Summary log ---")
        );
        assert!(
            recurring.contains("SUMMARY.md")
                && recurring.contains("run #1 of the job")
                && recurring.contains("# Job")
                && !recurring.contains("{run}")
        );
        assert_eq!(prompt(false), "Do the thing");
        drop(store);
        assert_eq!(
            ScheduledTasks::open_in_dir(&dir)
                .unwrap()
                .instructions()
                .recurring,
            "Be brief."
        );
        // Older saved settings have no switch: the log is on.
        let old: JobInstructions =
            serde_json::from_str(r#"{"recurring":"x","oneTime":""}"#).unwrap();
        assert!(old.summary_log);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn pause_and_resume_skip_missed_occurrences() {
        let dir = std::env::temp_dir().join(unique_id("noai-pause-test"));
        let store = ScheduledTasks::open_in_dir(&dir).unwrap();
        let task = store
            .create(CreateTaskInput {
                title: "Every minute".into(),
                prompt: "p".into(),
                harness: "codex".into(),
                model: None,
                project_path: "/tmp".into(),
                start_at: now() + 600,
                interval_seconds: Some(60),
                auto_resume: true,
                dangerously_bypass_permissions: false,
                permissions: None,
                worktree: false,
            })
            .unwrap();
        let paused = store.pause(&task.id).unwrap();
        assert_eq!(paused.status, "paused");
        assert!(store.claim_due(now() + 10_000).unwrap().is_empty());
        assert!(store.pause(&task.id).is_err());
        store
            .update(|journal| {
                journal.tasks[0].next_run_at = Some(now() - 150);
                Ok(())
            })
            .unwrap();
        let before = now();
        let resumed = store.resume(&task.id).unwrap();
        assert_eq!(resumed.status, "scheduled");
        let due = resumed.next_run_at.unwrap();
        assert!(due >= before && due <= now() + 60);
        assert!(store.resume(&task.id).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

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
            instructions: None,
        };
        let task = store.set_digest(input(true), "/tmp".into()).unwrap();
        assert_eq!(task.next_run_at, Some(anchor));
        assert_eq!(
            task.permissions,
            Some(crate::adapters::JobPermissions::ProviderDefault)
        );
        assert!(store.list().iter().filter(|task| is_digest(task)).count() == 1);

        // Run now, then fail: the next run is still the configured daily time.
        store.run_digest_now().unwrap();
        let (claimed, request) = store.claim_due(now() + 1).unwrap().remove(0);
        assert!(is_digest(&claimed));
        assert!(
            store.run_digest_now().is_err(),
            "no second digest while one runs"
        );
        let after = store
            .finish(&request.run_id, "failed", "boom".into(), now() + 5)
            .unwrap()
            .unwrap();
        assert_eq!(after.status, "scheduled");
        assert_eq!(after.next_run_at, Some(anchor));

        // After the anchored run, it moves exactly one day later.
        let request = store.claim_due(anchor).unwrap().remove(0).1;
        let after = store
            .finish(&request.run_id, "completed", "ok".into(), anchor + 60)
            .unwrap()
            .unwrap();
        assert_eq!(after.next_run_at, Some(anchor + DAY));
        assert_eq!(store.digest_runs(10).len(), 2);

        let off = store.set_digest(input(false), "/tmp".into()).unwrap();
        assert_eq!((off.status.as_str(), off.next_run_at), ("disabled", None));
        assert!(store.claim_due(anchor + 2 * DAY).unwrap().is_empty());
        assert!(store.run_digest_now().is_err());
        assert!(
            store.activity_since(0).0.is_empty(),
            "digest never reports on itself"
        );
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
            worktree: false,
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
        assert!(request.prompt.starts_with("New instructions"));
        // A running job can be edited; the change applies from the next run.
        let running = store.edit(&task.id, changes.clone(), None).unwrap();
        assert_eq!(
            (running.status.as_str(), running.next_run_at),
            ("running", None)
        );
        store.waiting(&request.run_id).unwrap();
        assert_eq!(
            store
                .edit(&task.id, changes.clone(), Some(request.run_id.clone()))
                .unwrap()
                .status,
            "running"
        );
        store
            .finish(
                &request.run_id,
                "completed",
                "Done".into(),
                changes.start_at + 1,
            )
            .unwrap();
        // A stale editor's start time doesn't move the occurrence the finished run scheduled.
        let scheduled = store.list()[0].next_run_at;
        assert_eq!(
            store
                .edit(&task.id, changes.clone(), None)
                .unwrap()
                .next_run_at,
            scheduled
        );
        let updated = store
            .edit(&task.id, original.clone(), Some(request.run_id.clone()))
            .unwrap();
        assert_eq!(
            updated.last_run_id.as_deref(),
            Some(request.run_id.as_str())
        );
        let history = store.runs(&task.id).unwrap();
        assert!(history[0].prompt.as_deref().unwrap().starts_with("New instructions"));
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
                worktree: false,
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
    fn recurring_failure_keeps_the_next_occurrence_and_recovers_legacy_schedule() {
        let dir = std::env::temp_dir().join(unique_id("noai-scheduled-test"));
        let store = ScheduledTasks::open_in_dir(&dir).unwrap();
        let input: CreateTaskInput = serde_json::from_value(serde_json::json!({
            "title": "Recurring job", "prompt": "Check", "harness": "codex",
            "projectPath": "/tmp", "startAt": now() + 600, "intervalSeconds": 60
        }))
        .unwrap();
        let task = store.create(input.clone()).unwrap();
        let due = task.next_run_at.unwrap();
        let request = store.claim_due(due).unwrap().remove(0).1;
        let mut session = RunEvent::new(&request, "session", None);
        session.resume_id = Some("old-provider-session".into());
        store.append_event(&request.run_id, &session).unwrap();
        let failed = store
            .finish(
                &request.run_id,
                "needs_attention",
                "Connection failed".into(),
                due + 121,
            )
            .unwrap()
            .unwrap();
        assert_eq!(failed.status, "scheduled");
        assert_eq!(failed.next_run_at, Some(due + 180));
        assert!(store.claim_due(due + 179).unwrap().is_empty());
        let next = store.claim_due(due + 180).unwrap().remove(0).1;
        assert!(next.resume_id.is_none());
        assert_ne!(next.run_id, request.run_id);
        assert!(store
            .finish(&request.run_id, "completed", "Late result".into(), due + 181)
            .unwrap()
            .is_none());
        let runs = store.runs(&task.id).unwrap();
        assert_eq!(runs[0].result.as_deref(), Some("Connection failed"));
        assert_eq!(runs[1].status, "running");
        store.cancel(&task.id).unwrap();

        let legacy = store.create(input.clone()).unwrap();
        let interrupted = store.create(input).unwrap();
        let request = store.claim_due(due).unwrap().remove(0).1;
        store
            .finish(&request.run_id, "failed", "Connection failed".into(), due + 1)
            .unwrap();
        store
            .update(|journal| {
                let task = journal
                    .tasks
                    .iter_mut()
                    .find(|task| task.id == legacy.id)
                    .unwrap();
                task.status = "failed".into();
                task.next_run_at = None;
                Ok(())
            })
            .unwrap();
        drop(store);

        let reopened = ScheduledTasks::open_in_dir(&dir).unwrap();
        let tasks = reopened.list();
        assert_eq!(tasks[0].status, "cancelled");
        assert_eq!(tasks[1].status, "scheduled");
        assert_eq!(tasks[1].next_run_at, Some(due + 60));
        assert_eq!(reopened.runs(&legacy.id).unwrap()[0].status, "failed");
        assert_eq!(tasks[2].id, interrupted.id);
        assert_eq!(tasks[2].status, "needs_attention");
        assert_eq!(tasks[2].next_run_at, None);
        drop(reopened);
        let reopened = ScheduledTasks::open_in_dir(&dir).unwrap();
        assert_eq!(reopened.list()[2].status, "needs_attention");
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
                worktree: false,
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
            worktree: false,
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
                worktree: false,
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
                worktree: false,
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
