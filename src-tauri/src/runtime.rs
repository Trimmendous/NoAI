//! Tauri commands. The native daemon owns runs and journals; this desktop only
//! forwards commands and relays events into the webview.
use crate::{
    adapters::{self, RunRequest, RuntimeStatus},
    ipc,
    scheduled_tasks::{CreateTaskInput, Task, TaskRun},
    scheduler::ResumeJob,
};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;

static EVENT_RELAY_STARTED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn runtime_status() -> Result<RuntimeStatus, String> {
    tokio::task::spawn_blocking(adapters::status)
        .await
        .map_err(|error| format!("Cannot inspect installed CLIs: {error}"))
}

#[tauri::command]
pub fn load_workspace(app: AppHandle) -> Result<Option<Value>, String> {
    crate::storage::load(&app)
}

#[tauri::command]
pub fn save_workspace(app: AppHandle, workspace: Value) -> Result<(), String> {
    crate::storage::save(&app, workspace)
}

#[tauri::command]
pub async fn choose_project() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .pick_folder()
            .and_then(|path| path.canonicalize().ok())
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("Project picker failed: {error}"))
}

#[tauri::command]
pub async fn start_run(app: AppHandle, request: RunRequest) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        ipc::request(&app, json!({"command":"start_run", "request":request}))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn cancel_run(app: AppHandle, run_id: String) -> Result<(), String> {
    ipc::request(&app, json!({"command":"cancel_run", "run_id":run_id}))
}

#[tauri::command]
pub fn get_resume_jobs(app: AppHandle) -> Result<Vec<ResumeJob>, String> {
    ipc::request(&app, json!({"command":"resume_jobs"}))
}

#[tauri::command]
pub fn list_scheduled_tasks(app: AppHandle) -> Result<Vec<Task>, String> {
    ipc::request(&app, json!({"command":"list"}))
}

#[tauri::command]
pub fn get_scheduled_task_runs(app: AppHandle, id: String) -> Result<Vec<TaskRun>, String> {
    ipc::request(&app, json!({"command":"runs", "id":id}))
}

#[tauri::command]
pub fn set_scheduled_task_auto_resume(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<Task, String> {
    ipc::request(
        &app,
        json!({"command":"update_auto_resume", "id":id, "enabled":enabled}),
    )
}

#[tauri::command]
pub fn create_scheduled_task(app: AppHandle, input: CreateTaskInput) -> Result<Task, String> {
    ipc::request(&app, json!({"command":"create", "input":input}))
}

#[tauri::command]
pub fn edit_scheduled_task(
    app: AppHandle,
    id: String,
    input: CreateTaskInput,
    expected_last_run_id: Option<String>,
) -> Result<Task, String> {
    ipc::request(
        &app,
        json!({"command":"edit", "id":id, "input":input, "expected_last_run_id":expected_last_run_id}),
    )
}

#[tauri::command]
pub fn get_digest(app: AppHandle) -> Result<Value, String> {
    ipc::request(&app, json!({"command":"get_digest"}))
}

#[tauri::command]
pub fn set_digest(app: AppHandle, input: crate::scheduled_tasks::DigestInput) -> Result<Task, String> {
    ipc::request(&app, json!({"command":"set_digest", "input":input}))
}

#[tauri::command]
pub fn run_digest_now(app: AppHandle) -> Result<Task, String> {
    ipc::request(&app, json!({"command":"run_digest_now"}))
}

#[tauri::command]
pub fn retry_scheduled_task(
    app: AppHandle,
    id: String,
    start_at: u64,
    expected_last_run_id: Option<String>,
) -> Result<Task, String> {
    ipc::request(
        &app,
        json!({"command":"retry_task", "id":id, "start_at":start_at, "expected_last_run_id":expected_last_run_id}),
    )
}

#[tauri::command]
pub fn cancel_scheduled_task(app: AppHandle, id: String) -> Result<(), String> {
    ipc::request(&app, json!({"command":"cancel", "id":id}))
}

#[tauri::command]
pub fn cancel_resume_job(app: AppHandle, job_id: String) -> Result<(), String> {
    ipc::request(
        &app,
        json!({"command":"cancel_resume_job", "job_id":job_id}),
    )
}

#[tauri::command]
pub fn set_background_mode(app: AppHandle, enabled: bool) -> Result<bool, String> {
    ipc::request(
        &app,
        json!({"command":"set_background_mode", "enabled":enabled}),
    )
}

#[tauri::command]
pub fn connect_events(app: AppHandle) -> Result<(), String> {
    ipc::replay_events();
    if !EVENT_RELAY_STARTED.swap(true, Ordering::SeqCst) {
        ipc::start_event_relay(app);
    }
    Ok(())
}

#[tauri::command]
pub fn get_active_runs(app: AppHandle) -> Result<Vec<Value>, String> {
    ipc::request(&app, json!({"command":"active_runs"}))
}

#[tauri::command]
pub fn get_activity_metrics(app: AppHandle) -> Result<Value, String> {
    ipc::request(&app, json!({"command":"metrics"}))
}
