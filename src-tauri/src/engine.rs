use crate::adapters::{self, RunEvent, RunRequest};
use crate::{
    providers,
    scheduled_tasks::{
        CreateTaskInput, DigestInput, JobInstructions, ScheduledTasks, Task, TaskRun,
    },
    scheduler::{self, ResumeJob, Scheduler},
};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::oneshot,
};

struct ActiveRun {
    conversation_id: String,
    pid: Option<u32>,
    cancel: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct ActiveRuns(Mutex<HashMap<String, ActiveRun>>);

// Serializes final scheduled launch with cancellation. Never held across awaits.
#[derive(Default)]
pub struct LaunchGate(Mutex<()>);

pub enum EngineEvent {
    Run(RunEvent),
    ScheduledTask(Task),
}

pub struct Engine {
    pub scheduler: Scheduler,
    pub scheduled_tasks: ScheduledTasks,
    pub active_runs: ActiveRuns,
    pub launch_gate: LaunchGate,
    pub home: PathBuf,
    pub event_sink: Arc<dyn Fn(EngineEvent) + Send + Sync>,
}

impl Engine {
    pub fn open(
        app_data_dir: &std::path::Path,
        home: PathBuf,
        event_sink: Arc<dyn Fn(EngineEvent) + Send + Sync>,
    ) -> Result<Arc<Self>, String> {
        Ok(Arc::new(Self {
            scheduler: Scheduler::open_in_dir(app_data_dir)?,
            scheduled_tasks: ScheduledTasks::open_in_dir(app_data_dir)?,
            active_runs: ActiveRuns::default(),
            launch_gate: LaunchGate::default(),
            home,
            event_sink,
        }))
    }

    fn emit_run(&self, event: RunEvent) {
        (self.event_sink)(EngineEvent::Run(event));
    }

    fn emit_task(&self, task: Task) {
        (self.event_sink)(EngineEvent::ScheduledTask(task));
    }
}

impl ActiveRuns {
    pub fn snapshot(&self) -> Vec<serde_json::Value> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|(id, run)| serde_json::json!({"runId":id,"conversationId":run.conversation_id}))
            .collect()
    }

    pub fn cancel(&self, run_id: &str) -> bool {
        let mut runs = self.0.lock().unwrap();
        if let Some(run) = runs.get_mut(run_id) {
            if run.cancel.is_none() {
                return false;
            }
            kill_tree(run.pid);
            let _ = run.cancel.take().unwrap().send(());
            true
        } else {
            false
        }
    }

    pub fn cancel_all(&self) {
        for (_, run) in self.0.lock().unwrap().drain() {
            kill_tree(run.pid);
            if let Some(cancel) = run.cancel {
                let _ = cancel.send(());
            }
        }
    }
}

fn kill_tree(pid: Option<u32>) {
    let Some(pid) = pid else {
        return;
    };
    crate::platform::kill_process_tree(pid);
}

pub async fn start_run(engine: Arc<Engine>, mut request: RunRequest) -> Result<(), String> {
    request.project_path =
        crate::projects::ensure_project_path(Some(request.project_path.clone()), &engine.home)?;
    let mut cancel_rx = reserve_run(&engine, &request, None)?;
    let fingerprint = if request.auto_resume {
        tokio::select! {
            biased;
            _ = &mut cancel_rx => {
                engine.active_runs.0.lock().unwrap().remove(&request.run_id);
                engine.emit_run(RunEvent::new(&request, "done", Some("Cancelled".into())));
                return Ok(());
            }
            value = providers::refresh_account_fingerprint(&request.harness) => value,
        }
    } else {
        None
    };
    launch_reserved(engine, request, None, None, fingerprint, cancel_rx)
}

fn start_run_impl(
    engine: Arc<Engine>,
    request: RunRequest,
    resume_job_id: Option<String>,
    scheduled_run_id: Option<String>,
    start_fingerprint: Option<String>,
) -> Result<(), String> {
    let gate = &engine.launch_gate;
    let _guard = gate.0.lock().unwrap();
    if resume_job_id.as_deref().is_some_and(|id| {
        engine
            .scheduler
            .job(id)
            .is_none_or(|job| job.status != "running")
    }) {
        return Ok(());
    }
    if scheduled_run_id
        .as_deref()
        .is_some_and(|id| !engine.scheduled_tasks.launchable(id))
    {
        return Ok(());
    }
    if engine
        .scheduled_tasks
        .task_for_run(&request.run_id)
        .is_some()
        && !engine.scheduled_tasks.launchable(&request.run_id)
    {
        return Ok(());
    }
    let cancel_rx = reserve_run(&engine, &request, resume_job_id.as_deref())?;
    launch_reserved(
        engine.clone(),
        request,
        resume_job_id,
        scheduled_run_id,
        start_fingerprint,
        cancel_rx,
    )
}

fn reserve_run(
    engine: &Arc<Engine>,
    request: &RunRequest,
    resume_job_id: Option<&str>,
) -> Result<oneshot::Receiver<()>, String> {
    if resume_job_id.is_none()
        && engine.scheduler.jobs().iter().any(|job| {
            job.conversation_id == request.conversation_id
                && matches!(job.status.as_str(), "waiting" | "running")
        })
    {
        return Err(
            "This conversation has a scheduled run. Cancel it before starting another.".into(),
        );
    }
    let active = &engine.active_runs;
    let cancel_rx = {
        let mut runs = active.0.lock().unwrap();
        if runs.contains_key(&request.run_id) {
            return Err("This run is already active".into());
        }
        if runs
            .values()
            .any(|run| run.conversation_id == request.conversation_id)
        {
            return Err("This conversation already has an active run".into());
        }
        let (cancel_tx, cancel_rx) = oneshot::channel();
        runs.insert(
            request.run_id.clone(),
            ActiveRun {
                conversation_id: request.conversation_id.clone(),
                pid: None,
                cancel: Some(cancel_tx),
            },
        );
        cancel_rx
    };
    Ok(cancel_rx)
}

fn launch_reserved(
    engine: Arc<Engine>,
    request: RunRequest,
    resume_job_id: Option<String>,
    scheduled_run_id: Option<String>,
    start_fingerprint: Option<String>,
    cancel_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let child = {
        let active = &engine.active_runs;
        let mut runs = active.0.lock().unwrap();
        let Some(run) = runs.get_mut(&request.run_id) else {
            return Ok(());
        };
        if run.cancel.is_none() {
            runs.remove(&request.run_id);
            drop(runs);
            let mut done = RunEvent::new(&request, "done", Some("Cancelled".into()));
            if let Some(id) = resume_job_id.as_deref() {
                engine.scheduler.append_event(id, &mut done)?;
            }
            engine.emit_run(done);
            return Ok(());
        }
        match adapters::spawn(&request) {
            Ok(child) => {
                run.pid = child.id();
                child
            }
            Err(error) => {
                runs.remove(&request.run_id);
                return Err(error);
            }
        }
    };

    let run_id = request.run_id.clone();
    tokio::spawn(async move {
        let actual_scheduled_id = scheduled_run_id.or_else(|| {
            engine
                .scheduled_tasks
                .task_for_run(&request.run_id)
                .map(|_| request.run_id.clone())
        });
        let outcome = execute(
            &engine,
            &request,
            child,
            cancel_rx,
            resume_job_id.as_deref(),
            actual_scheduled_id.as_deref(),
        )
        .await;
        let terminal = finish_run(
            &engine,
            &request,
            outcome,
            resume_job_id.as_deref(),
            start_fingerprint,
        )
        .await;
        if let Some(id) = actual_scheduled_id.as_deref() {
            let _ = engine.scheduled_tasks.append_event(id, &terminal);
            let status = if terminal.kind == "waiting" {
                "waiting"
            } else if terminal.kind == "done" {
                if terminal.text.as_deref() == Some("Cancelled") {
                    "cancelled"
                } else {
                    "completed"
                }
            } else {
                "needs_attention"
            };
            let automation = engine.scheduled_tasks.automation();
            if status == "waiting" {
                let _ = engine.scheduled_tasks.waiting(id);
                if automation.notify_problems {
                    if let Some(task) = engine.scheduled_tasks.task_for_run(id) {
                        crate::platform::notify(
                            &format!("Job waiting: {}", task.title),
                            "It hit a usage limit and will pick up again when the limit resets.",
                        );
                    }
                }
            } else {
                let changes = if status == "cancelled" {
                    None
                } else {
                    finish_worktree(&engine, id).await
                };
                if let Ok(Some(task)) = engine.scheduled_tasks.finish(
                    id,
                    status,
                    terminal.text.clone().unwrap_or_else(|| "Completed".into()),
                    scheduler::now_epoch(),
                ) {
                    notify_finished(
                        &automation,
                        &task,
                        status,
                        terminal.text.as_deref(),
                        changes.as_ref(),
                    );
                    engine.emit_task(task);
                }
            }
        }
        engine.active_runs.0.lock().unwrap().remove(&run_id);
        engine.emit_run(terminal);
    });
    Ok(())
}

pub fn get_digest(engine: Arc<Engine>) -> serde_json::Value {
    serde_json::json!({
        "task": engine.scheduled_tasks.digest(),
        "runs": engine.scheduled_tasks.digest_runs(30),
        "instructions": engine.scheduled_tasks.digest().and_then(|task| crate::digest::custom_instructions(&task.prompt).map(str::to_owned)),
    })
}

pub fn set_digest(engine: Arc<Engine>, input: DigestInput) -> Result<Task, String> {
    let folder = engine.home.join(".noai").join("digest");
    std::fs::create_dir_all(&folder)
        .map_err(|error| format!("Cannot create digest folder: {error}"))?;
    let project = folder.canonicalize().map_err(|error| error.to_string())?;
    let task = engine
        .scheduled_tasks
        .set_digest(input, project.to_string_lossy().into_owned())?;
    engine.emit_task(task.clone());
    Ok(task)
}

pub fn run_digest_now(engine: Arc<Engine>) -> Result<Task, String> {
    let task = engine.scheduled_tasks.run_digest_now()?;
    engine.emit_task(task.clone());
    let launcher = engine.clone();
    tokio::spawn(async move {
        run_scheduled_due(&launcher).await;
    });
    Ok(task)
}

pub fn get_resume_jobs(engine: Arc<Engine>) -> Vec<ResumeJob> {
    engine.scheduler.jobs()
}

pub fn get_job_instructions(engine: Arc<Engine>) -> JobInstructions {
    engine.scheduled_tasks.instructions()
}

pub fn set_job_instructions(
    engine: Arc<Engine>,
    input: JobInstructions,
) -> Result<JobInstructions, String> {
    engine.scheduled_tasks.set_instructions(input)
}

pub fn list_scheduled_tasks(engine: Arc<Engine>) -> Vec<Task> {
    engine.scheduled_tasks.list()
}

pub fn get_scheduled_task_runs(engine: Arc<Engine>, id: String) -> Result<Vec<TaskRun>, String> {
    engine.scheduled_tasks.runs(&id)
}

pub fn set_scheduled_task_auto_resume(
    engine: Arc<Engine>,
    id: String,
    enabled: bool,
) -> Result<Task, String> {
    let task = engine.scheduled_tasks.set_auto_resume(&id, enabled)?;
    engine.emit_task(task.clone());
    Ok(task)
}

pub fn pause_scheduled_task(engine: Arc<Engine>, id: String) -> Result<Task, String> {
    let _guard = engine.launch_gate.0.lock().unwrap();
    let task = engine.scheduled_tasks.pause(&id)?;
    engine.emit_task(task.clone());
    Ok(task)
}

pub fn resume_scheduled_task(engine: Arc<Engine>, id: String) -> Result<Task, String> {
    let task = engine.scheduled_tasks.resume(&id)?;
    engine.emit_task(task.clone());
    Ok(task)
}

pub fn create_scheduled_task(
    engine: Arc<Engine>,
    mut input: CreateTaskInput,
) -> Result<Task, String> {
    input.project_path =
        crate::projects::ensure_project_path(Some(input.project_path.clone()), &engine.home)?;
    let task = engine.scheduled_tasks.create(input)?;
    engine.emit_task(task.clone());
    if task
        .next_run_at
        .is_some_and(|at| at <= scheduler::now_epoch())
    {
        let app_for_launch = engine.clone();
        tokio::spawn(async move {
            run_scheduled_due(&app_for_launch).await;
        });
    }
    Ok(task)
}

pub fn edit_scheduled_task(
    engine: Arc<Engine>,
    id: String,
    input: CreateTaskInput,
    expected_last_run_id: Option<String>,
) -> Result<Task, String> {
    let task = engine
        .scheduled_tasks
        .edit(&id, input, expected_last_run_id)?;
    engine.emit_task(task.clone());
    Ok(task)
}

pub fn retry_scheduled_task(
    engine: Arc<Engine>,
    id: String,
    start_at: u64,
    expected_last_run_id: Option<String>,
) -> Result<Task, String> {
    let _guard = engine.launch_gate.0.lock().unwrap();
    if let Some(run_id) = &expected_last_run_id {
        if engine
            .active_runs
            .snapshot()
            .iter()
            .any(|run| run["runId"] == *run_id)
            || engine
                .scheduler
                .job(run_id)
                .is_some_and(|job| matches!(job.status.as_str(), "waiting" | "running"))
        {
            return Err(
                "This job still has active or waiting work; it cannot be retried in parallel"
                    .into(),
            );
        }
    }
    let task = engine
        .scheduled_tasks
        .retry(&id, start_at, expected_last_run_id)?;
    engine.emit_task(task.clone());
    Ok(task)
}

pub fn cancel_scheduled_task(engine: Arc<Engine>, id: String) -> Result<(), String> {
    let gate = &engine.launch_gate;
    let _guard = gate.0.lock().unwrap();
    let run_id = engine.scheduled_tasks.cancel(&id)?;
    if let Some(run_id) = run_id {
        if let Some(job) = engine.scheduler.job(&run_id) {
            if matches!(
                job.status.as_str(),
                "waiting" | "running" | "needs_attention"
            ) {
                let old = engine.scheduler.cancel(&run_id)?;
                if old.status != "running" {
                    let mut event = RunEvent {
                        run_id: old.run_id,
                        conversation_id: old.conversation_id,
                        kind: "done",
                        text: Some("Cancelled".into()),
                        resume_id: None,
                        retry_at: None,
                        event_id: None,
                        usage: None,
                        harness: None,
                        model: None,
                    };
                    engine.scheduler.append_event(&run_id, &mut event)?;
                    engine.emit_run(event);
                }
            }
        }
        engine.active_runs.cancel(&run_id);
    }
    if let Some(task) = engine
        .scheduled_tasks
        .list()
        .into_iter()
        .find(|task| task.id == id)
    {
        engine.emit_task(task);
    }
    Ok(())
}

pub fn cancel_resume_job(engine: Arc<Engine>, job_id: String) -> Result<(), String> {
    let gate = &engine.launch_gate;
    let _guard = gate.0.lock().unwrap();
    let scheduler = &engine.scheduler;
    let previous = scheduler.cancel(&job_id)?;
    if previous.status == "running" && engine.active_runs.cancel(&previous.run_id) {
        return Ok(());
    }
    let mut event = RunEvent {
        run_id: previous.run_id,
        conversation_id: previous.conversation_id,
        kind: "done",
        text: Some("Cancelled".into()),
        resume_id: None,
        retry_at: None,
        event_id: None,
        usage: None,
        harness: None,
        model: None,
    };
    scheduler.append_event(&job_id, &mut event)?;
    engine.emit_run(event);
    Ok(())
}

pub fn set_background_mode(engine: Arc<Engine>, enabled: bool) -> bool {
    let scheduler = &engine.scheduler;
    scheduler.set_background_mode(enabled);
    scheduler.background_mode()
}

pub fn cancel_run(engine: Arc<Engine>, run_id: String) -> Result<(), String> {
    if engine.active_runs.cancel(&run_id) {
        Ok(())
    } else {
        Err("Run is not active".into())
    }
}

// Apply at the stdin boundary so scheduled launches, manual retries, and timed
// resumes (including older saved jobs) all receive the same execution context.
// Keep the stored user prompt intact and ordinary interactive chats unchanged.
fn execution_prompt(prompt: &str, scheduled_run_id: Option<&str>) -> String {
    if scheduled_run_id.is_some() {
        format!(
            "{}\n\n--- Job instructions ---\n\n{}",
            include_str!("unattended-job.md").trim(),
            prompt
        )
    } else {
        prompt.to_owned()
    }
}

async fn execute(
    engine: &Arc<Engine>,
    request: &RunRequest,
    mut child: tokio::process::Child,
    cancel_rx: oneshot::Receiver<()>,
    resume_job_id: Option<&str>,
    scheduled_run_id: Option<&str>,
) -> ExecutionOutcome {
    let mut cancel_rx = cancel_rx;
    // Keep the computer from sleeping until this agent process exits.
    let _awake = crate::platform::keep_awake(child.id().unwrap_or_default());
    let Some(mut stdin) = child.stdin.take() else {
        kill_tree(child.id());
        let _ = child.wait().await;
        return ExecutionOutcome::terminal(RunEvent::new(
            request,
            "error",
            Some("CLI stdin unavailable".into()),
        ));
    };
    let prompt = execution_prompt(&request.prompt, scheduled_run_id);
    let write_result = tokio::select! {
        _ = &mut cancel_rx => {
            kill_tree(child.id());
            let _ = child.wait().await;
            return ExecutionOutcome::terminal(RunEvent::new(request, "done", Some("Cancelled".into())));
        }
        result = stdin.write_all(prompt.as_bytes()) => result,
    };
    if let Err(error) = write_result {
        kill_tree(child.id());
        let _ = child.wait().await;
        return ExecutionOutcome::terminal(RunEvent::new(
            request,
            "error",
            Some(format!("Cannot send prompt: {error}")),
        ));
    }
    drop(stdin);

    let Some(stdout) = child.stdout.take() else {
        kill_tree(child.id());
        let _ = child.wait().await;
        return ExecutionOutcome::terminal(RunEvent::new(
            request,
            "error",
            Some("CLI stdout unavailable".into()),
        ));
    };
    let Some(stderr) = child.stderr.take() else {
        kill_tree(child.id());
        let _ = child.wait().await;
        return ExecutionOutcome::terminal(RunEvent::new(
            request,
            "error",
            Some("CLI stderr unavailable".into()),
        ));
    };

    let output_app = engine.clone();
    let output_request = request.clone();
    let output_job_id = resume_job_id.map(str::to_owned);
    let output_scheduled_id = scheduled_run_id.map(str::to_owned);
    let output = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut summary = StreamSummary::default();
        let mut sessions = HashSet::new();
        while let Ok(Some(line)) = lines.next_line().await {
            for mut event in adapters::parse_line(&output_request, &line) {
                if event.kind == "session"
                    && !event
                        .resume_id
                        .as_ref()
                        .is_some_and(|id| sessions.insert(id.clone()))
                {
                    continue;
                }
                if event.kind == "error" {
                    if summary.parsed_error.is_none() {
                        summary.parsed_error =
                            Some(event.text.unwrap_or_else(|| "CLI reported an error".into()));
                    }
                } else {
                    if event.kind == "session" {
                        summary.resume_id = event.resume_id.clone();
                    }
                    if event.kind == "usage" {
                        if let Some(usage) = &event.usage {
                            if let Some(retry) = adapters::classify_structured_quota(
                                &output_request.harness,
                                usage,
                                scheduler::now_epoch(),
                            ) {
                                if summary
                                    .structured_retry
                                    .as_ref()
                                    .is_none_or(|old| retry.0 > old.0)
                                {
                                    summary.structured_retry = Some(retry);
                                }
                            }
                        }
                    }
                    if matches!(event.kind, "text" | "activity") {
                        summary.activity_seen = true;
                    }
                    if let Some(id) = &output_job_id {
                        if let Err(error) = output_app.scheduler.append_event(id, &mut event) {
                            summary.journal_error = Some(error);
                        }
                    } else {
                        summary.next_event_id += 1;
                        event.event_id = Some(summary.next_event_id);
                    }
                    if let Some(id) = &output_scheduled_id {
                        if let Err(error) = output_app.scheduled_tasks.append_event(id, &event) {
                            summary.journal_error = Some(error);
                        }
                    }
                    summary.events.push(event.clone());
                    output_app.emit_run(event);
                }
            }
        }
        summary
    });
    let notice_request = request.clone();
    let errors = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut last_error = String::new();
        let mut notices: Vec<String> = Vec::new();
        let harness = crate::harness::get(&notice_request.harness);
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                last_error = line.chars().take(1000).collect();
                if let Some(notice) =
                    harness.and_then(|agent| agent.stderr_notice(&notice_request, &line))
                {
                    if !notices.contains(&notice) {
                        notices.push(notice);
                    }
                }
            }
        }
        (last_error, notices)
    });

    let (cancelled, exit_result) = tokio::select! {
        _ = cancel_rx => {
            kill_tree(child.id());
            (true, child.wait().await)
        }
        result = child.wait() => (false, result)
    };
    let mut summary = output.await.unwrap_or_default();
    let (stderr, notices) = errors.await.unwrap_or_default();
    // Warnings the CLI printed on stderr, shown with the run even when it succeeds.
    for text in notices {
        let mut event = RunEvent::new(request, "notice", Some(text));
        if let Some(id) = resume_job_id {
            let _ = engine.scheduler.append_event(id, &mut event);
        } else {
            summary.next_event_id += 1;
            event.event_id = Some(summary.next_event_id);
        }
        if let Some(id) = scheduled_run_id {
            let _ = engine.scheduled_tasks.append_event(id, &event);
        }
        summary.events.push(event.clone());
        engine.emit_run(event);
    }
    let terminal = if let Some(error) = &summary.journal_error {
        RunEvent::new(
            request,
            "error",
            Some(format!("Cannot save run output: {error}")),
        )
    } else {
        terminal_event(
            request,
            cancelled,
            exit_result,
            summary.parsed_error.clone(),
            stderr,
        )
    };
    ExecutionOutcome {
        terminal,
        resume_id: summary.resume_id,
        activity_seen: summary.activity_seen,
        events: summary.events,
        structured_retry: summary.structured_retry,
    }
}

#[derive(Default)]
struct StreamSummary {
    parsed_error: Option<String>,
    journal_error: Option<String>,
    resume_id: Option<String>,
    activity_seen: bool,
    events: Vec<RunEvent>,
    next_event_id: u64,
    structured_retry: Option<(u64, String)>,
}

struct ExecutionOutcome {
    terminal: RunEvent,
    resume_id: Option<String>,
    activity_seen: bool,
    events: Vec<RunEvent>,
    structured_retry: Option<(u64, String)>,
}

impl ExecutionOutcome {
    fn terminal(terminal: RunEvent) -> Self {
        Self {
            terminal,
            resume_id: None,
            activity_seen: false,
            events: Vec::new(),
            structured_retry: None,
        }
    }
}

async fn finish_run(
    engine: &Arc<Engine>,
    request: &RunRequest,
    outcome: ExecutionOutcome,
    resume_job_id: Option<&str>,
    start_fingerprint: Option<String>,
) -> RunEvent {
    let scheduler = &engine.scheduler;
    let mut terminal = outcome.terminal;
    if resume_job_id.is_some_and(|id| {
        scheduler
            .job(id)
            .is_some_and(|job| job.status == "cancelled")
    }) {
        terminal = RunEvent::new(request, "done", Some("Cancelled".into()));
    }
    if terminal.kind == "error" && request.auto_resume {
        let text_quota = terminal.text.as_deref().and_then(|message| {
            adapters::classify_timed_quota(&request.harness, message, scheduler::now_epoch())
        });
        let timed_quota = match (text_quota, outcome.structured_retry) {
            (Some(text), Some(structured)) => Some(if structured.0 > text.0 {
                structured
            } else {
                text
            }),
            (Some(text), None) => Some(text),
            (None, structured) => structured,
        };
        if let Some((reset_at, reason)) = timed_quota {
            let retry_at = scheduler::after_reset(reset_at);
            if let Some(fingerprint) = start_fingerprint {
                let resume_id = outcome.resume_id.or_else(|| request.resume_id.clone());
                if resume_id.is_some() || !outcome.activity_seen {
                    match scheduler.waiting(scheduler::WaitingInput {
                        request,
                        resume_id: resume_id.clone(),
                        activity_seen: outcome.activity_seen,
                        fingerprint,
                        reason: reason.clone(),
                        retry_at,
                        initial_events: &outcome.events,
                    }) {
                        Ok(job) => {
                            let mut waiting = RunEvent::new(request, "waiting", Some(reason));
                            waiting.retry_at = job.retry_at;
                            waiting.resume_id = resume_id;
                            if let Err(error) = scheduler.append_event(&job.id, &mut waiting) {
                                let _ = scheduler.finish(
                                    &job.id,
                                    "needs_attention",
                                    format!("Cannot save waiting event: {error}"),
                                );
                                terminal = RunEvent::new(
                                    request,
                                    "error",
                                    Some(format!("Cannot save automatic resume: {error}")),
                                );
                            } else {
                                return waiting;
                            }
                        }
                        Err(error) => {
                            terminal = RunEvent::new(
                                request,
                                "error",
                                Some(format!("Automatic resume needs attention: {error}")),
                            );
                        }
                    }
                } else {
                    terminal = RunEvent::new(request, "error", Some("Timed limit detected, but this run has activity and no native session to resume safely".into()));
                }
            } else {
                terminal = RunEvent::new(request, "error", Some("Timed limit detected, but account identity could not be verified for automatic resume".into()));
            }
        }
    }
    if let Some(id) = resume_job_id {
        let (status, reason) = if terminal.kind == "done" {
            if terminal.text.as_deref() == Some("Cancelled") {
                ("cancelled", "Cancelled".to_string())
            } else {
                ("completed", "Completed".to_string())
            }
        } else {
            (
                "needs_attention",
                terminal.text.clone().unwrap_or_else(|| "Run failed".into()),
            )
        };
        if let Err(error) = scheduler.finish(id, status, reason) {
            terminal = RunEvent::new(
                request,
                "error",
                Some(format!("Cannot update resume journal: {error}")),
            );
        }
        if let Err(error) = scheduler.append_event(id, &mut terminal) {
            terminal = RunEvent::new(
                request,
                "error",
                Some(format!("Cannot save terminal event: {error}")),
            );
        }
    }
    terminal
}

/// The next moment any job is due: a scheduled run or a rate-limit retry.
fn next_due(engine: &Engine) -> Option<u64> {
    let retries = engine
        .scheduler
        .jobs()
        .into_iter()
        .filter(|job| job.status == "waiting")
        .filter_map(|job| job.retry_at);
    engine
        .scheduled_tasks
        .next_due()
        .into_iter()
        .chain(retries)
        .min()
}

/// When to ask the OS to wake the computer: a minute before the next job.
/// Nothing when wake-ups are off or the job is only a few minutes away (the
/// computer is awake now, and a run in progress keeps it awake).
fn wake_target(next_due: Option<u64>, now: u64, enabled: bool) -> Option<u64> {
    next_due
        .filter(|due| enabled && *due > now + 180)
        .map(|due| due - 60)
}

/// After a wake-up the computer must not doze off again before the job
/// starts, so while waking is on it is held awake for the last few minutes
/// before anything is due. A job every few minutes keeps it awake throughout.
fn hold_until_due(next_due: Option<u64>, now: u64, enabled: bool) -> bool {
    enabled && next_due.is_some_and(|due| due <= now + 180)
}

/// Keeps the OS wake-up pointed at the next job. Whether wake-ups are allowed
/// is rechecked each minute, so turning it on in Settings applies quickly.
#[derive(Default)]
struct WakePlan {
    enabled: bool,
    checked_at: u64,
    current: Option<u64>,
    failed: bool,
    /// Held from shortly before a job until it starts (the run then holds its own).
    hold: Option<crate::platform::KeepAwake>,
}

impl WakePlan {
    async fn update(&mut self, engine: &Engine, now: u64) {
        if now >= self.checked_at + 60 {
            self.checked_at = now;
            self.enabled = tokio::task::spawn_blocking(crate::platform::wake_enabled)
                .await
                .unwrap_or(false);
        }
        let due = next_due(engine);
        if hold_until_due(due, now, self.enabled) {
            if self.hold.is_none() {
                self.hold = crate::platform::keep_awake(std::process::id());
            }
        } else {
            self.hold = None;
        }
        let target = wake_target(due, now, self.enabled);
        if target == self.current || (!self.enabled && self.current.is_none()) {
            return;
        }
        match tokio::task::spawn_blocking(move || crate::platform::set_wake(target)).await {
            Ok(Ok(())) => {
                self.current = target;
                self.failed = false;
            }
            Ok(Err(error)) if !self.failed => {
                self.failed = true;
                eprintln!("Noai: could not schedule a wake-up: {error}");
            }
            _ => {}
        }
    }
}

pub fn start_scheduler(engine: Arc<Engine>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(10));
        let mut wake = WakePlan::default();
        loop {
            interval.tick().await;
            let now = scheduler::now_epoch();
            wake.update(&engine, now).await;
            run_scheduled_due(&engine).await;
            let claims = match engine.scheduler.claim_due(now) {
                Ok(claims) => claims,
                Err(error) => {
                    eprintln!("Noai scheduler: {error}");
                    continue;
                }
            };
            for job in engine
                .scheduler
                .jobs()
                .into_iter()
                .filter(|job| job.status == "needs_attention" && job.updated_at == now)
            {
                let mut event = RunEvent::new(
                    &RunRequest {
                        run_id: job.run_id.clone(),
                        conversation_id: job.conversation_id.clone(),
                        harness: job.harness.clone(),
                        model: job.model.clone(),
                        project_path: job.project_path.clone(),
                        prompt: String::new(),
                        resume_id: None,
                        auto_resume: true,
                        dangerously_bypass_permissions: job.dangerously_bypass_permissions,
                        permissions: job.permissions,
                    },
                    "error",
                    Some(job.reason.clone()),
                );
                if engine.scheduler.append_event(&job.id, &mut event).is_ok() {
                    engine.emit_run(event);
                }
            }
            for claim in claims {
                let id = claim.job.id.clone();
                if engine
                    .scheduler
                    .job(&id)
                    .is_none_or(|job| job.status != "running")
                {
                    continue;
                }
                let current_fingerprint =
                    providers::refresh_account_fingerprint(&claim.request.harness).await;
                if engine
                    .scheduler
                    .job(&id)
                    .is_none_or(|job| job.status != "running")
                {
                    continue;
                }
                if current_fingerprint.as_deref() != Some(&claim.account_fingerprint) {
                    let reason =
                        "Account identity changed or could not be verified; review before resuming"
                            .to_string();
                    let _ = engine
                        .scheduler
                        .finish(&id, "needs_attention", reason.clone());
                    let mut event = RunEvent::new(&claim.request, "error", Some(reason));
                    if engine.scheduler.append_event(&id, &mut event).is_ok() {
                        engine.emit_run(event);
                    }
                    continue;
                }
                if engine
                    .scheduler
                    .job(&id)
                    .is_none_or(|job| job.status != "running")
                {
                    continue;
                }
                let latest_reset = providers::refresh_timed_limit_reset(
                    &claim.request.harness,
                    scheduler::now_epoch(),
                )
                .await;
                if engine
                    .scheduler
                    .job(&id)
                    .is_none_or(|job| job.status != "running")
                {
                    continue;
                }
                if let Some(reset_at) = latest_reset {
                    let retry_at = scheduler::after_reset(reset_at);
                    let reason = "Provider reports a later explicit usage reset".to_string();
                    match engine.scheduler.defer_claim(&id, retry_at, reason.clone()) {
                        Ok(job) => {
                            let mut waiting =
                                RunEvent::new(&claim.request, "waiting", Some(reason));
                            waiting.retry_at = job.retry_at;
                            waiting.resume_id = claim.request.resume_id.clone();
                            if engine.scheduler.append_event(&id, &mut waiting).is_ok() {
                                engine.emit_run(waiting);
                            }
                        }
                        Err(error) => {
                            let _ = engine
                                .scheduler
                                .finish(&id, "needs_attention", error.clone());
                            let mut event = RunEvent::new(&claim.request, "error", Some(error));
                            if engine.scheduler.append_event(&id, &mut event).is_ok() {
                                engine.emit_run(event);
                            }
                        }
                    }
                    continue;
                }
                let mut resumed = RunEvent::new(&claim.request, "resumed", None);
                if let Err(error) = engine.scheduler.append_event(&id, &mut resumed) {
                    let _ = engine.scheduler.finish(&id, "needs_attention", error);
                    continue;
                }
                engine.emit_run(resumed);
                if let Err(error) = start_run_impl(
                    engine.clone(),
                    claim.request.clone(),
                    Some(id.clone()),
                    None,
                    current_fingerprint,
                ) {
                    let _ = engine
                        .scheduler
                        .finish(&id, "needs_attention", error.clone());
                    let mut event = RunEvent::new(&claim.request, "error", Some(error));
                    if engine.scheduler.append_event(&id, &mut event).is_ok() {
                        engine.emit_run(event);
                    }
                } else if engine
                    .scheduler
                    .job(&id)
                    .is_some_and(|job| job.status == "cancelled")
                {
                    engine.active_runs.cancel(&claim.request.run_id);
                }
            }
        }
    });
}

/// A usage window over the budget line.
struct BudgetHold {
    label: String,
    used: f64,
    resets_at: Option<u64>,
}

/// Usage snapshots are reused for two minutes so a batch of due jobs asks once.
static USAGE_CACHE: Mutex<Option<(u64, Vec<providers::ProviderUsageSnapshot>)>> = Mutex::new(None);

async fn budget_hold(harness: &str, stop_at: f64) -> Option<BudgetHold> {
    let now = scheduler::now_epoch();
    let cached = USAGE_CACHE
        .lock()
        .unwrap()
        .clone()
        .filter(|(at, _)| now.saturating_sub(*at) < 120);
    let snapshots = match cached {
        Some((_, snapshots)) => snapshots,
        None => {
            let fresh = providers::get_provider_usage().await;
            *USAGE_CACHE.lock().unwrap() = Some((now, fresh.clone()));
            fresh
        }
    };
    let snapshot = snapshots
        .into_iter()
        .find(|snapshot| snapshot.id == harness)?;
    // Every limit over the line must reset before the job may start: wait for the last.
    snapshot
        .windows
        .into_iter()
        .filter(|window| window.used_percent.is_some_and(|used| used >= stop_at))
        .map(|window| BudgetHold {
            label: window.label,
            used: window.used_percent.unwrap_or(100.0),
            resets_at: window.resets_at,
        })
        .max_by_key(|hold| hold.resets_at.unwrap_or(u64::MAX))
}

/// Points the run at its own worktree (a resumed run continues in the last one).
/// Not a git repository, or no commits yet: the run works in the folder as before.
async fn prepare_worktree(engine: &Arc<Engine>, task: &Task, request: &mut RunRequest) {
    let reuse = request
        .resume_id
        .is_some()
        .then(|| engine.scheduled_tasks.resumable_worktree(&task.id))
        .flatten()
        .filter(|tree| std::path::Path::new(&tree.workdir).exists());
    let tree = match reuse {
        Some(mut tree) => {
            tree.review = "running".into();
            Ok(tree)
        }
        None => {
            let project = std::path::PathBuf::from(&task.project_path);
            let under =
                crate::platform::app_data_dir().map(|dir| dir.join("worktrees").join(&task.id));
            let (title, run_id, at) = (
                task.title.clone(),
                request.run_id.clone(),
                scheduler::now_epoch(),
            );
            tokio::task::spawn_blocking(move || {
                crate::worktrees::create(&project, &under?, &title, &run_id, at)
            })
            .await
            .unwrap_or_else(|error| Err(error.to_string()))
        }
    };
    match tree {
        Ok(tree) => {
            request.project_path = tree.workdir.clone();
            let note = format!("Working on branch {} in a separate copy. Your folder isn't touched; review the changes in Changes.", tree.branch);
            let _ = engine
                .scheduled_tasks
                .set_run_worktree(&request.run_id, tree);
            let _ = engine.scheduled_tasks.append_event(
                &request.run_id,
                &RunEvent::new(request, "notice", Some(note)),
            );
        }
        Err(error) => {
            let note = format!("Working directly in your folder: {error}.");
            let _ = engine.scheduled_tasks.append_event(
                &request.run_id,
                &RunEvent::new(request, "notice", Some(note)),
            );
        }
    }
}

/// Commits a finished run's worktree and records what changed.
async fn finish_worktree(engine: &Arc<Engine>, run_id: &str) -> Option<crate::worktrees::Worktree> {
    let (title, mut tree) = engine
        .scheduled_tasks
        .run_worktree(run_id)
        .filter(|(_, tree)| tree.review == "running")?;
    let tree = tokio::task::spawn_blocking(move || {
        crate::worktrees::finish(&mut tree, &format!("Noai job: {title}"));
        tree
    })
    .await
    .ok()?;
    let _ = engine
        .scheduled_tasks
        .set_run_worktree(run_id, tree.clone());
    Some(tree)
}

fn notify_finished(
    automation: &crate::scheduled_tasks::AutomationSettings,
    task: &Task,
    status: &str,
    text: Option<&str>,
    changes: Option<&crate::worktrees::Worktree>,
) {
    let digest = task.kind.as_deref() == Some(crate::scheduled_tasks::DIGEST_KIND);
    match status {
        "completed" if automation.notify_finished => {
            let body = match changes {
                Some(tree) if tree.review == "pending" => format!(
                    "{} file{} changed. Review them in Changes.",
                    tree.files,
                    if tree.files == 1 { "" } else { "s" }
                ),
                Some(_) => "Finished without changing any files.".to_owned(),
                None if digest => "Your morning report is ready.".to_owned(),
                None => "Finished.".to_owned(),
            };
            crate::platform::notify(
                if digest {
                    "Daily digest ready"
                } else {
                    &task.title
                },
                &body,
            );
        }
        "needs_attention" | "failed" if automation.notify_problems => {
            crate::platform::notify(
                &format!("Job needs you: {}", task.title),
                text.unwrap_or("The run stopped with an error."),
            );
        }
        _ => {}
    }
}

// ---- Automation settings and Changes, for the app ------------------------------

pub fn get_automation(engine: Arc<Engine>) -> crate::scheduled_tasks::AutomationSettings {
    engine.scheduled_tasks.automation()
}

pub fn set_automation(
    engine: Arc<Engine>,
    input: crate::scheduled_tasks::AutomationSettings,
) -> Result<crate::scheduled_tasks::AutomationSettings, String> {
    engine.scheduled_tasks.set_automation(input)
}

pub fn list_changes(engine: Arc<Engine>) -> Vec<serde_json::Value> {
    engine.scheduled_tasks.changes()
}

pub fn change_diff(engine: Arc<Engine>, run_id: String) -> Result<String, String> {
    let (_, tree) = engine
        .scheduled_tasks
        .run_worktree(&run_id)
        .ok_or("No changes for that run")?;
    crate::worktrees::diff(&tree)
}

/// Merge, publish (push and open a pull request) or discard a run's changes.
pub fn review_change(
    engine: Arc<Engine>,
    run_id: String,
    action: String,
) -> Result<serde_json::Value, String> {
    let (title, mut tree) = engine
        .scheduled_tasks
        .run_worktree(&run_id)
        .ok_or("No changes for that run")?;
    if tree.review != "pending" && !(action == "discard" && tree.review == "published") {
        return Err("These changes were already handled.".into());
    }
    let url = match action.as_str() {
        "merge" => crate::worktrees::merge(&mut tree, &title).map(|_| None)?,
        "publish" => Some(crate::worktrees::publish(&mut tree)?),
        "discard" => {
            crate::worktrees::discard(&mut tree);
            None
        }
        _ => return Err("Unknown action".into()),
    };
    engine
        .scheduled_tasks
        .set_run_worktree(&run_id, tree.clone())?;
    if let Some(task) = engine.scheduled_tasks.task_for_run(&run_id) {
        engine.emit_task(task);
    }
    Ok(serde_json::json!({ "worktree": tree, "url": url }))
}

async fn run_scheduled_due(engine: &Arc<Engine>) {
    let claims = match engine.scheduled_tasks.claim_due(scheduler::now_epoch()) {
        Ok(claims) => claims,
        Err(error) => {
            eprintln!("Noai scheduled tasks: {error}");
            return;
        }
    };
    for (task, mut request) in claims {
        if task.kind.as_deref() == Some(crate::scheduled_tasks::DIGEST_KIND)
            && request.resume_id.is_none()
        {
            // Built from live data at launch, so a delayed digest is never stale.
            request.prompt = crate::digest::compose(
                &engine.scheduled_tasks,
                &task.prompt,
                &engine.home,
                scheduler::now_epoch(),
            );
        }
        // Usage budget: hold the job until its agent's limits leave you your share.
        let automation = engine.scheduled_tasks.automation();
        if let Some(reserve) = automation.reserve_percent {
            let stop_at = f64::from(100 - reserve);
            if let Some(hold) = budget_hold(&request.harness, stop_at).await {
                let until = hold
                    .resets_at
                    .unwrap_or_else(|| scheduler::now_epoch() + 1800)
                    + 60;
                let reason = format!(
                    "Held by your usage budget: {} is {}% used, and jobs stop at {}%. It starts after the limit resets.",
                    hold.label,
                    hold.used.round(),
                    stop_at
                );
                if let Ok(Some(updated)) =
                    engine
                        .scheduled_tasks
                        .defer(&request.run_id, until, &reason)
                {
                    if automation.notify_limits {
                        crate::platform::notify(&format!("Job held: {}", task.title), &reason);
                    }
                    engine.emit_task(updated);
                }
                continue;
            }
        }
        engine.emit_task(task.clone());
        // A separate git worktree for the run, so it never touches your working copy.
        if task.worktree && task.kind.is_none() {
            prepare_worktree(engine, &task, &mut request).await;
        }
        let fingerprint = if request.auto_resume {
            providers::refresh_account_fingerprint(&request.harness).await
        } else {
            None
        };
        if !engine.scheduled_tasks.launchable(&request.run_id) {
            continue;
        }
        if let Err(error) = start_run_impl(
            engine.clone(),
            request.clone(),
            None,
            Some(request.run_id.clone()),
            fingerprint,
        ) {
            if let Ok(Some(updated)) = engine.scheduled_tasks.finish(
                &request.run_id,
                "needs_attention",
                error,
                scheduler::now_epoch(),
            ) {
                engine.emit_task(updated);
            }
        }
    }
}

fn terminal_event(
    request: &RunRequest,
    cancelled: bool,
    exit_result: std::io::Result<std::process::ExitStatus>,
    parsed_error: Option<String>,
    stderr: String,
) -> RunEvent {
    if cancelled {
        RunEvent::new(request, "done", Some("Cancelled".into()))
    } else if let Some(message) = parsed_error {
        RunEvent::new(request, "error", Some(message))
    } else {
        let failed = !matches!(&exit_result, Ok(status) if status.success());
        if failed {
            let message = if stderr.is_empty() {
                match exit_result {
                    Ok(status) => format!("CLI exited with status {status}"),
                    Err(error) => format!("CLI failed: {error}"),
                }
            } else {
                stderr
            };
            RunEvent::new(request, "error", Some(message))
        } else {
            RunEvent::new(request, "done", None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wakes_a_minute_before_jobs_that_are_far_enough_away() {
        assert_eq!(wake_target(Some(10_000), 1_000, true), Some(9_940));
        assert_eq!(wake_target(Some(1_100), 1_000, true), None);
        assert_eq!(wake_target(Some(10_000), 1_000, false), None);
        assert_eq!(wake_target(None, 1_000, true), None);
    }

    #[test]
    fn stays_awake_from_the_wake_up_until_the_job_starts() {
        // Woken 60s early: held until the job is claimed.
        assert!(hold_until_due(Some(1_060), 1_000, true));
        // Far away: free to sleep, the next wake-up is set instead.
        assert!(!hold_until_due(Some(5_000), 1_000, true));
        // Waking off: Noai doesn't hold the computer between runs.
        assert!(!hold_until_due(Some(1_060), 1_000, false));
    }

    #[test]
    fn scheduled_execution_adds_context_without_changing_job_instructions() {
        let job = "Write the report. Stop after 10 sources.\nDo not publish it.";
        let sent = execution_prompt(job, Some("scheduled-run"));
        assert!(sent.starts_with("You are executing an unattended scheduled job"));
        assert!(sent.ends_with(job));
        assert_eq!(execution_prompt(job, None), job);
    }

    #[test]
    fn scheduled_resume_gets_context_even_when_prompt_is_replaced() {
        for continuation in [
            "Continue this interrupted job. Original job instructions: Write the report.",
            "Continue the request interrupted by a usage limit.",
        ] {
            let sent = execution_prompt(continuation, Some("scheduled-run"));
            assert!(sent.contains("no human is available"));
            assert!(sent.contains("without repeating completed side effects"));
            assert!(sent.ends_with(continuation));
            assert_eq!(execution_prompt(continuation, None), continuation);
        }
    }

    fn request() -> RunRequest {
        RunRequest {
            run_id: "run".into(),
            conversation_id: "conversation".into(),
            harness: "codex".into(),
            model: None,
            project_path: "/tmp".into(),
            prompt: "hello".into(),
            resume_id: None,
            auto_resume: true,
            dangerously_bypass_permissions: false,
            permissions: None,
        }
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_kills_owned_process_group() {
        use std::os::unix::process::CommandExt;
        let mut child = std::process::Command::new("sleep")
            .arg("10")
            .process_group(0)
            .spawn()
            .unwrap();
        let (cancel, receiver) = oneshot::channel();
        let mut runs = HashMap::new();
        runs.insert(
            "run".into(),
            ActiveRun {
                conversation_id: "conversation".into(),
                pid: Some(child.id()),
                cancel: Some(cancel),
            },
        );
        let active = ActiveRuns(Mutex::new(runs));
        assert!(active.cancel("run"));
        assert!(receiver.blocking_recv().is_ok());
        assert!(!child.wait().unwrap().success());
        assert!(!active.cancel("run"));
    }

    #[test]
    fn pending_run_can_be_cancelled_before_a_process_exists() {
        let (cancel, receiver) = oneshot::channel();
        let mut runs = HashMap::new();
        runs.insert(
            "run".into(),
            ActiveRun {
                conversation_id: "conversation".into(),
                pid: None,
                cancel: Some(cancel),
            },
        );
        let active = ActiveRuns(Mutex::new(runs));
        assert!(active.cancel("run"));
        assert!(receiver.blocking_recv().is_ok());
        assert!(!active.cancel("run"));
    }

    #[cfg(unix)]
    #[test]
    fn failure_uses_cli_error_and_cancel_is_terminal_done() {
        let status = std::process::Command::new("false").status().unwrap();
        let failed = terminal_event(
            &request(),
            false,
            Ok(status),
            Some("approval denied".into()),
            String::new(),
        );
        assert_eq!(failed.kind, "error");
        assert_eq!(failed.text.as_deref(), Some("approval denied"));
        let cancelled = terminal_event(&request(), true, Ok(status), None, String::new());
        assert_eq!(cancelled.kind, "done");
        assert_eq!(cancelled.text.as_deref(), Some("Cancelled"));
    }
}
