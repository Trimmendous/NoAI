mod adapters;
mod chat_windows;
mod control;
mod daemon;
mod digest;
mod engine;
mod harness;
mod ipc;
mod local_metrics;
mod local_sessions;
mod platform;
mod plugins;
mod projects;
mod providers;
mod runtime;
mod scheduled_tasks;
mod scheduler;
mod storage;
mod worktrees;

use tauri::Manager;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

pub fn run() {
    tauri::Builder::default()
        // Plugin pages and files: noaiplugin://localhost/<id>/<file>
        .register_uri_scheme_protocol("noaiplugin", |_context, request| {
            crate::plugins::respond(request.uri().path())
        })
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
            runtime::get_job_instructions,
            runtime::set_job_instructions,
            runtime::list_scheduled_tasks,
            runtime::create_scheduled_task,
            runtime::edit_scheduled_task,
            runtime::cancel_scheduled_task,
            runtime::pause_scheduled_task,
            runtime::resume_scheduled_task,
            runtime::retry_scheduled_task,
            runtime::open_web_link,
            runtime::get_automation,
            runtime::set_automation,
            runtime::list_changes,
            runtime::change_diff,
            runtime::review_change,
            runtime::list_plugins,
            runtime::set_plugin_enabled,
            runtime::create_example_plugin,
            runtime::delete_plugin,
            runtime::open_plugins_folder,
            chat_windows::open_chat_window,
            chat_windows::focus_chat_window,
            chat_windows::close_chat_window,
            runtime::get_wake_status,
            runtime::set_wake_for_jobs,
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
