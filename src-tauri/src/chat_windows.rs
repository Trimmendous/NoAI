//! Chats torn off into their own windows. The main window stays the owner of
//! every chat: a chat window only shows one conversation and forwards what the
//! user does (send, stop, dock back) to the main window as events.
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

fn label(conversation_id: &str) -> Result<String, String> {
    let valid = !conversation_id.is_empty()
        && conversation_id.len() <= 64
        && conversation_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-');
    if valid {
        Ok(format!("chat-{conversation_id}"))
    } else {
        Err("Invalid conversation id".into())
    }
}

/// Opens (or brings forward) the window for one chat, near `x`,`y` when given.
#[tauri::command]
pub fn open_chat_window(
    app: AppHandle,
    conversation_id: String,
    title: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    let label = label(&conversation_id)?;
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        return window.set_focus().map_err(|error| error.to_string());
    }
    let title: String = title
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect();
    let mut builder = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("chat-window.html?id={conversation_id}").into()),
    )
    .title(if title.is_empty() {
        "Noai chat".to_owned()
    } else {
        title
    })
    .inner_size(560.0, 720.0)
    .min_inner_size(360.0, 420.0);
    if let (Some(x), Some(y)) = (x, y) {
        if x.is_finite() && y.is_finite() {
            builder = builder.position(x, y);
        }
    }
    let window = builder.build().map_err(|error| error.to_string())?;
    // Tell the main window when the chat window goes away, however it closed.
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = handle.emit_to("main", "noai:chat-window-closed", &conversation_id);
        }
    });
    Ok(())
}

#[tauri::command]
pub fn focus_chat_window(app: AppHandle, conversation_id: String) -> Result<bool, String> {
    let Some(window) = app.get_webview_window(&label(&conversation_id)?) else {
        return Ok(false);
    };
    let _ = window.unminimize();
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn close_chat_window(app: AppHandle, conversation_id: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label(&conversation_id)?) {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn window_labels_only_accept_plain_ids() {
        assert_eq!(super::label("1f2e-ab").unwrap(), "chat-1f2e-ab");
        assert!(super::label("../x").is_err());
        assert!(super::label("").is_err());
    }
}
