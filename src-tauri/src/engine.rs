use crate::adapters::{self, RunEvent, RunRequest};
use crate::{
    providers,
    scheduled_tasks::{CreateTaskInput, ScheduledTasks, Task, TaskRun},
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
    #[cfg(unix)]
    // SAFETY: each CLI is started as a fresh process-group leader above.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
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
            if status == "waiting" {
                let _ = engine.scheduled_tasks.waiting(id);
            } else if let Ok(Some(task)) = engine.scheduled_tasks.finish(
                id,
                status,
                terminal.text.clone().unwrap_or_else(|| "Completed".into()),
                scheduler::now_epoch(),
            ) {
                engine.emit_task(task);
            }
        }
        engine.active_runs.0.lock().unwrap().remove(&run_id);
        engine.emit_run(terminal);
    });
    Ok(())
}

pub fn get_resume_jobs(engine: Arc<Engine>) -> Vec<ResumeJob> {
    engine.scheduler.jobs()
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
    let errors = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut last_error = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                last_error = line.chars().take(1000).collect();
            }
        }
        last_error
    });

    let (cancelled, exit_result) = tokio::select! {
        _ = cancel_rx => {
            kill_tree(child.id());
            (true, child.wait().await)
        }
        result = child.wait() => (false, result)
    };
    let summary = output.await.unwrap_or_default();
    let stderr = errors.await.unwrap_or_default();
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

pub fn start_scheduler(engine: Arc<Engine>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(10));
        loop {
            interval.tick().await;
            let now = scheduler::now_epoch();
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

async fn run_scheduled_due(engine: &Arc<Engine>) {
    let claims = match engine.scheduled_tasks.claim_due(scheduler::now_epoch()) {
        Ok(claims) => claims,
        Err(error) => {
            eprintln!("Noai scheduled tasks: {error}");
            return;
        }
    };
    for (task, request) in claims {
        engine.emit_task(task);
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
