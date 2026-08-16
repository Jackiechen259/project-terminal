//! Tauri commands for the single main window.

use tauri::{AppHandle, Manager};

use crate::error::AppResult;
use crate::window::WindowManager;

/// Identity of the calling window's workspace. The frontend reads this once
/// at boot. With the single-window architecture the workspace id is always
/// `main`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub window_label: String,
    pub workspace_id: String,
    pub project_id: Option<String>,
    /// Id of the legacy multi-window workspace this install was migrated
    /// from, when the migration ran. Lets the frontend run a one-time
    /// per-workspace layout migration; `None` in the steady state.
    pub migrated_from_workspace_id: Option<String>,
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
        migrated_from_workspace_id: manager.migrated_from_workspace_id(),
    }
}

/// Tell the backend which project this window has selected, so the window
/// title stays accurate and the project survives restarts.
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
