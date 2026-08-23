use std::sync::Arc;

use rusqlite::{params, OptionalExtension, Transaction};

use crate::database::{self, Database};
use crate::error::{AppError, AppResult};

pub struct WorkspaceStateRepository {
    db: Arc<Database>,
}

impl WorkspaceStateRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { db: database }
    }

    pub fn load(&self, workspace_id: &str) -> AppResult<Option<serde_json::Value>> {
        validate_workspace_id(workspace_id)?;
        self.db.with_connection(|connection| {
            let value = connection
                .query_row(
                    "SELECT state_json FROM workspace_state WHERE workspace_id = ?1",
                    params![workspace_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| database::error::sqlite("read workspace state", error))?;
            value
                .map(|value| database::schema::parse_json(&value, "workspace state"))
                .transpose()
        })
    }

    pub fn save(&self, workspace_id: &str, state: &serde_json::Value) -> AppResult<()> {
        validate_workspace_id(workspace_id)?;
        let state_json = database::schema::json_value(state, "workspace state")?;
        self.db.with_connection(|connection| {
            connection
                .execute(
                    "INSERT INTO workspace_state(workspace_id, state_json, updated_at)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(workspace_id) DO UPDATE SET
                        state_json = excluded.state_json,
                        updated_at = excluded.updated_at",
                    params![
                        workspace_id,
                        state_json,
                        chrono::Utc::now().timestamp_millis()
                    ],
                )
                .map_err(|error| database::error::sqlite("write workspace state", error))?;
            Ok(())
        })
    }

    pub fn delete(&self, workspace_id: &str) -> AppResult<()> {
        validate_workspace_id(workspace_id)?;
        self.db.with_connection(|connection| {
            connection
                .execute(
                    "DELETE FROM workspace_state WHERE workspace_id = ?1",
                    params![workspace_id],
                )
                .map_err(|error| database::error::sqlite("delete workspace state", error))?;
            Ok(())
        })
    }

    pub(crate) fn save_tx(
        transaction: &Transaction<'_>,
        workspace_id: &str,
        state: &serde_json::Value,
    ) -> AppResult<()> {
        validate_workspace_id(workspace_id)?;
        let state_json = database::schema::json_value(state, "workspace state")?;
        transaction
            .execute(
                "INSERT INTO workspace_state(workspace_id, state_json, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(workspace_id) DO UPDATE SET
                    state_json = excluded.state_json,
                    updated_at = excluded.updated_at",
                params![
                    workspace_id,
                    state_json,
                    chrono::Utc::now().timestamp_millis()
                ],
            )
            .map_err(|error| database::error::sqlite("write workspace state", error))?;
        Ok(())
    }
}

fn validate_workspace_id(workspace_id: &str) -> AppResult<()> {
    if workspace_id.trim().is_empty() {
        return Err(AppError::Configuration(
            "Workspace id must not be empty".into(),
        ));
    }
    Ok(())
}
