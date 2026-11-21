//! Headless runtime entry point. This path never initializes Tauri or GTK.
use crate::{control, engine, platform};
use std::sync::Arc;

pub fn run() -> Result<(), String> {
    let home = platform::home_dir()?;
    let dir = platform::app_data_dir()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(async move {
        let events = Arc::new(control::Events::default());
        let engine = engine::Engine::open(&dir, home.clone(), events.sink())?;
        events.restore(&dir)?;
        crate::local_metrics::start(dir.clone(), home);
        control::start(
            engine.clone(),
            events,
            &dir,
            tokio::runtime::Handle::current(),
        )?;
        engine::start_scheduler(engine.clone());
        #[cfg(unix)]
        {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .map_err(|e| e.to_string())?;
            tokio::select! { _ = terminate.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
        }
        #[cfg(not(unix))]
        tokio::signal::ctrl_c().await.map_err(|e| e.to_string())?;
        engine.active_runs.cancel_all();
        Ok(())
    })
}
