//! Tauri commands for window/workspace management.

use tauri::{AppHandle, Manager};

use crate::commands::terminal::TerminalState;
use crate::error::AppResult;
use crate::window::{WindowInfo, WindowManager, WindowOpenOptions};

/// Create a new workspace window and return its workspace id.
///
/// `project_id` optionally opens the new window with a project selected
/// ("Open in New Window").
#[tauri::command]
pub fn new_window(app: AppHandle, project_id: Option<String>) -> AppResult<String> {
    app.state::<WindowManager>().create_window(
        &app,
        WindowOpenOptions {
            project_id,
            focus: true,
            ..Default::default()
        },
    )
}

/// Close a workspace window.
///
/// `keep_sessions == false` first stops every session owned by that workspace
/// (never any other workspace's sessions); `true` leaves them running so the
/// workspace can be reopened and reattached later.
#[tauri::command]
pub fn close_window(app: AppHandle, workspace_id: String, keep_sessions: bool) -> AppResult<()> {
    if !keep_sessions {
        app.state::<TerminalState>()
            .close_workspace_sessions(&workspace_id);
    }
    app.state::<WindowManager>()
        .close_window(&app, &workspace_id)
}

/// Show/focus an open workspace window, or reopen a detached one.
#[tauri::command]
pub fn show_window(app: AppHandle, workspace_id: String) -> AppResult<()> {
    app.state::<WindowManager>()
        .show_window(&app, &workspace_id)
}

/// Show every open window.
#[tauri::command]
pub fn show_all_windows(app: AppHandle) {
    app.state::<WindowManager>().show_all(&app);
}

/// Hide every open window. Sessions keep running.
#[tauri::command]
pub fn hide_all_windows(app: AppHandle) {
    app.state::<WindowManager>().hide_all(&app);
}

/// All known workspaces (open and detached), most recently active first.
#[tauri::command]
pub fn list_windows(app: AppHandle) -> Vec<WindowInfo> {
    app.state::<WindowManager>().list_windows(&app)
}

/// Identity of the calling window's workspace. The frontend reads this once
/// at boot to load the right workspace state.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub window_label: String,
    pub workspace_id: String,
    pub project_id: Option<String>,
}

#[tauri::command]
pub fn workspace_info(app: AppHandle, webview: tauri::Webview) -> WorkspaceInfo {
    let label = webview.label().to_string();
    let manager = app.state::<WindowManager>();
    let workspace_id = manager
        .workspace_id_for_window(&label)
        .unwrap_or_else(|| label.clone());
    let project_id = manager.project_id_for_window(&label);
    WorkspaceInfo {
        window_label: label,
        workspace_id,
        project_id,
    }
}

/// Tell the backend which project this window has selected, so the window
/// title and the tray's window list stay accurate.
#[tauri::command]
pub fn set_window_project(
    app: AppHandle,
    webview: tauri::Webview,
    project_id: Option<String>,
) -> AppResult<()> {
    let label = webview.label().to_string();
    app.state::<WindowManager>()
        .set_window_project(&app, &label, project_id)
}

/// Reopen every workspace that has no live window (previous-session restore).
/// Returns the number of windows created.
#[tauri::command]
pub fn restore_previous_windows(app: AppHandle) -> AppResult<usize> {
    app.state::<WindowManager>().restore_previous_windows(&app)
}
