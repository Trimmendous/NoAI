mod adapters;
mod control;
mod daemon;
mod digest;
mod engine;
mod harness;
mod ipc;
mod local_metrics;
mod local_sessions;
mod platform;
mod projects;
mod providers;
mod runtime;
mod scheduled_tasks;
mod scheduler;
mod storage;

use tauri::Manager;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            ipc::ensure_started(app.handle()).map_err(std::io::Error::other)?;
            let show = MenuItem::with_id(app, "show", "Show Noai", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Noai", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Noai")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime::runtime_status,
            runtime::load_workspace,
            runtime::save_workspace,
            runtime::choose_project,
            projects::ensure_project,
            runtime::start_run,
            runtime::cancel_run,
            runtime::get_resume_jobs,
            runtime::cancel_resume_job,
            runtime::set_background_mode,
            runtime::connect_events,
            runtime::get_active_runs,
            runtime::get_activity_metrics,
            local_sessions::list_local_sessions,
            local_sessions::get_local_session,
            runtime::list_scheduled_tasks,
            runtime::create_scheduled_task,
            runtime::edit_scheduled_task,
            runtime::cancel_scheduled_task,
            runtime::pause_scheduled_task,
            runtime::resume_scheduled_task,
            runtime::retry_scheduled_task,
            runtime::open_web_link,
            runtime::get_digest,
            runtime::set_digest,
            runtime::run_digest_now,
            runtime::get_scheduled_task_runs,
            runtime::set_scheduled_task_auto_resume,
            providers::get_provider_usage,
            providers::get_harness_models,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Noai")
        .run(|_, _| {});
}

pub fn run_daemon() -> Result<(), String> {
    daemon::run()
}
