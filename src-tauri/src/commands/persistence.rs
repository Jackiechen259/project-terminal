//! Commands for frontend-owned durable state.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::commands::ListResponse;
use crate::database::{self, Database};
use crate::error::AppResult;
use crate::repositories::{
    CollectionSnapshot, MemoRepository, ProjectCollectionsRepository, ProjectMemo,
    SettingsRepository, WorkspaceStateRepository,
};
use crate::state::AppState;

const GENERAL_SETTINGS_KEY: &str = "general-settings";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendPersistencePayload {
    pub general_settings: Option<Value>,
    pub collections: Option<CollectionSnapshot>,
    #[serde(default)]
    pub project_memos: HashMap<String, Vec<ProjectMemo>>,
    #[serde(default)]
    pub workspace_states: HashMap<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendPersistenceMigrationResult {
    pub general_settings: bool,
    pub collections: bool,
    pub project_memos: bool,
    pub workspaces: Vec<String>,
}

#[tauri::command]
pub fn get_general_settings(state: State<'_, AppState>) -> AppResult<Option<Value>> {
    state.settings.get_value(GENERAL_SETTINGS_KEY)
}

#[tauri::command]
pub fn save_general_settings(state: State<'_, AppState>, value: Value) -> AppResult<()> {
    state.with_config_write(|| state.settings.set_value(GENERAL_SETTINGS_KEY, &value))
}

#[tauri::command]
pub fn load_collections(state: State<'_, AppState>) -> AppResult<CollectionSnapshot> {
    state.collections.load()
}

#[tauri::command]
pub fn save_collections(state: State<'_, AppState>, snapshot: CollectionSnapshot) -> AppResult<()> {
    state.with_config_write(|| state.collections.save(&snapshot))
}

#[tauri::command]
pub fn list_project_memos(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<ListResponse<ProjectMemo>> {
    Ok(ListResponse::new(
        state.memos.list_for_project(&project_id)?,
    ))
}

#[tauri::command]
pub fn save_project_memos(
    state: State<'_, AppState>,
    project_id: String,
    memos: Vec<ProjectMemo>,
) -> AppResult<()> {
    state.with_config_write(|| state.memos.replace_for_project(&project_id, &memos))
}

#[tauri::command]
pub fn delete_project_memo(state: State<'_, AppState>, memo_id: String) -> AppResult<()> {
    state.with_config_write(|| state.memos.delete(&memo_id))
}

#[tauri::command]
pub fn load_workspace_state(
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<Option<Value>> {
    state.workspace_state.load(&workspace_id)
}

#[tauri::command]
pub fn save_workspace_state(
    state: State<'_, AppState>,
    workspace_id: String,
    value: Value,
) -> AppResult<()> {
    state.with_config_write(|| state.workspace_state.save(&workspace_id, &value))
}

/// Import browser-only Zustand snapshots in one transaction. Invalid or
/// stale project references are filtered at the database boundary; the
/// frontend removes its source keys only after this command succeeds.
#[tauri::command]
pub fn migrate_frontend_persistence(
    state: State<'_, AppState>,
    payload: FrontendPersistencePayload,
) -> AppResult<FrontendPersistenceMigrationResult> {
    state.with_config_write(|| {
        state.db.transaction(|transaction| {
            let mut result = FrontendPersistenceMigrationResult::default();

            if let Some(settings) = payload.general_settings.as_ref() {
                result.general_settings = true;
                let existing: Option<String> = transaction
                    .query_row(
                        "SELECT value_json FROM settings WHERE key = ?1",
                        [GENERAL_SETTINGS_KEY],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| database::error::sqlite("check general settings", error))?;
                if existing.is_none() {
                    SettingsRepository::set_value_tx(transaction, GENERAL_SETTINGS_KEY, settings)?;
                }
            }

            if let Some(snapshot) = payload.collections.as_ref() {
                result.collections = true;
                let collection_count: i64 = transaction
                    .query_row("SELECT COUNT(*) FROM collections", [], |row| row.get(0))
                    .map_err(|error| database::error::sqlite("check collections", error))?;
                if collection_count == 0 {
                    let normalized = filter_collections(transaction, snapshot)?;
                    ProjectCollectionsRepository::save_tx(transaction, &normalized)?;
                }
            }

            for (project_id, memos) in &payload.project_memos {
                result.project_memos = true;
                let project_exists: i64 = transaction
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
                        [project_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| database::error::sqlite("check memo project", error))?;
                if project_exists == 0 {
                    continue;
                }
                let existing_memos: i64 = transaction
                    .query_row(
                        "SELECT COUNT(*) FROM memos WHERE project_id = ?1",
                        [project_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| database::error::sqlite("check project memos", error))?;
                if existing_memos == 0 {
                    MemoRepository::replace_for_project_tx(transaction, project_id, memos)?;
                }
            }

            for (workspace_id, workspace_state) in &payload.workspace_states {
                let exists: i64 = transaction
                    .query_row(
                        "SELECT EXISTS(
                            SELECT 1 FROM workspace_state WHERE workspace_id = ?1
                         )",
                        [workspace_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| database::error::sqlite("check workspace state", error))?;
                if exists == 0 {
                    WorkspaceStateRepository::save_tx(transaction, workspace_id, workspace_state)?;
                }
                result.workspaces.push(workspace_id.clone());
            }

            let foreign_keys = Database::foreign_key_check_tx(transaction)?;
            if !foreign_keys.is_empty() {
                return Err(crate::error::AppError::FrontendPersistenceMigration(
                    foreign_keys.join(", "),
                ));
            }
            Ok(result)
        })
    })
}

fn filter_collections(
    transaction: &rusqlite::Transaction<'_>,
    snapshot: &CollectionSnapshot,
) -> AppResult<CollectionSnapshot> {
    let mut normalized = snapshot.clone();
    for collection in &mut normalized.collections {
        collection.project_ids = collection
            .project_ids
            .iter()
            .filter_map(|project_id| {
                let exists: rusqlite::Result<i64> = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
                    [project_id],
                    |row| row.get(0),
                );
                match exists {
                    Ok(1) => Some(Ok(project_id.clone())),
                    Ok(_) => None,
                    Err(error) => Some(Err(database::error::sqlite(
                        "filter collection project",
                        error,
                    ))),
                }
            })
            .collect::<AppResult<Vec<_>>>()?;
    }
    normalized.ungrouped_project_ids = normalized
        .ungrouped_project_ids
        .iter()
        .filter_map(|project_id| {
            let exists: rusqlite::Result<i64> = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
                [project_id],
                |row| row.get(0),
            );
            match exists {
                Ok(1) => Some(Ok(project_id.clone())),
                Ok(_) => None,
                Err(error) => Some(Err(database::error::sqlite(
                    "filter ungrouped project",
                    error,
                ))),
            }
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(normalized)
}

use rusqlite::OptionalExtension;
