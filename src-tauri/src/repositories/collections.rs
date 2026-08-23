use std::collections::HashSet;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};

use crate::database::{self, Database};
use crate::error::{AppError, AppResult};

const UNGROUPED_PROJECTS_SETTING: &str = "collections.ungroupedProjectIds";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCollection {
    pub id: String,
    pub name: String,
    pub project_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSnapshot {
    pub collections: Vec<ProjectCollection>,
    pub collapsed: std::collections::HashMap<String, bool>,
    pub ungrouped_project_ids: Vec<String>,
}

pub struct ProjectCollectionsRepository {
    db: Arc<Database>,
}

impl ProjectCollectionsRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { db: database }
    }

    pub fn load(&self) -> AppResult<CollectionSnapshot> {
        self.db
            .with_connection(|connection| load_snapshot(connection))
    }

    pub fn save(&self, snapshot: &CollectionSnapshot) -> AppResult<()> {
        validate_snapshot(snapshot)?;
        self.db
            .transaction(|transaction| Self::save_tx(transaction, snapshot))
    }

    pub(crate) fn save_tx(
        transaction: &Transaction<'_>,
        snapshot: &CollectionSnapshot,
    ) -> AppResult<()> {
        validate_snapshot(snapshot)?;
        transaction
            .execute("DELETE FROM collection_projects", [])
            .map_err(|error| database::error::sqlite("replace collection memberships", error))?;
        transaction
            .execute("DELETE FROM collections", [])
            .map_err(|error| database::error::sqlite("replace collections", error))?;

        for (sort_order, collection) in snapshot.collections.iter().enumerate() {
            let created_at = parse_timestamp(&collection.created_at, "collection.createdAt")?;
            let updated_at = parse_timestamp(&collection.updated_at, "collection.updatedAt")?;
            transaction
                .execute(
                    "INSERT INTO collections(
                        id, name, sort_order, collapsed, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        collection.id,
                        collection.name,
                        sort_order as i64,
                        database::schema::bool_i64(
                            snapshot
                                .collapsed
                                .get(&collection.id)
                                .copied()
                                .unwrap_or(false)
                        ),
                        created_at,
                        updated_at,
                    ],
                )
                .map_err(|error| database::error::sqlite("write collection", error))?;

            for (project_order, project_id) in collection.project_ids.iter().enumerate() {
                transaction
                    .execute(
                        "INSERT INTO collection_projects(
                            collection_id, project_id, sort_order
                         ) VALUES (?1, ?2, ?3)",
                        params![collection.id, project_id, project_order as i64],
                    )
                    .map_err(|error| {
                        database::error::sqlite("write collection membership", error)
                    })?;
            }
        }

        let ungrouped = serde_json::to_value(&snapshot.ungrouped_project_ids)
            .map_err(|error| AppError::Database(format!("encode ungrouped projects: {error}")))?;
        crate::repositories::SettingsRepository::set_value_tx(
            transaction,
            UNGROUPED_PROJECTS_SETTING,
            &ungrouped,
        )?;
        Ok(())
    }
}

fn load_snapshot(connection: &Connection) -> AppResult<CollectionSnapshot> {
    let mut statement = connection
        .prepare(
            "SELECT id, name, collapsed, created_at, updated_at
             FROM collections
             ORDER BY sort_order ASC, id ASC",
        )
        .map_err(|error| database::error::sqlite("prepare collection list", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|error| database::error::sqlite("query collections", error))?;
    let raw_collections: Vec<_> = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| database::error::sqlite("read collections", error))?;
    drop(statement);

    let mut collections = Vec::with_capacity(raw_collections.len());
    let mut collapsed = std::collections::HashMap::new();
    for (id, name, collapsed_value, created_at, updated_at) in raw_collections {
        let mut members = connection
            .prepare(
                "SELECT project_id FROM collection_projects
                 WHERE collection_id = ?1
                 ORDER BY sort_order ASC, project_id ASC",
            )
            .map_err(|error| database::error::sqlite("prepare collection memberships", error))?;
        let project_ids = members
            .query_map(params![id], |row| row.get::<_, String>(0))
            .map_err(|error| database::error::sqlite("query collection memberships", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| database::error::sqlite("read collection memberships", error))?;
        collections.push(ProjectCollection {
            id: id.clone(),
            name,
            project_ids,
            created_at,
            updated_at,
        });
        collapsed.insert(
            id,
            database::schema::bool_from_i64(collapsed_value, "collection.collapsed")?,
        );
    }

    let ungrouped_project_ids = connection
        .query_row(
            "SELECT value_json FROM settings WHERE key = ?1",
            params![UNGROUPED_PROJECTS_SETTING],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| database::error::sqlite("read ungrouped projects", error))?
        .map(|value| database::schema::parse_json(&value, "ungrouped projects"))
        .transpose()?
        .unwrap_or_default();

    Ok(CollectionSnapshot {
        collections,
        collapsed,
        ungrouped_project_ids,
    })
}

fn parse_timestamp(value: &str, field: &str) -> AppResult<String> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc).to_rfc3339())
        .map_err(|error| AppError::Configuration(format!("invalid {field} timestamp: {error}")))
}

fn validate_snapshot(snapshot: &CollectionSnapshot) -> AppResult<()> {
    let mut collection_ids = HashSet::new();
    let mut project_ids = HashSet::new();
    for collection in &snapshot.collections {
        if collection.id.trim().is_empty() || collection.name.trim().is_empty() {
            return Err(AppError::Configuration(
                "Collection id and name must not be empty".into(),
            ));
        }
        if !collection_ids.insert(collection.id.as_str()) {
            return Err(AppError::Configuration(format!(
                "Duplicate collection id: {}",
                collection.id
            )));
        }
        for project_id in &collection.project_ids {
            if !project_ids.insert(project_id.as_str()) {
                return Err(AppError::Configuration(format!(
                    "Project appears in more than one collection: {project_id}"
                )));
            }
        }
    }
    let mut ungrouped = HashSet::new();
    for project_id in &snapshot.ungrouped_project_ids {
        if !ungrouped.insert(project_id.as_str()) {
            return Err(AppError::Configuration(format!(
                "Duplicate ungrouped project id: {project_id}"
            )));
        }
        if project_ids.contains(project_id.as_str()) {
            return Err(AppError::Configuration(format!(
                "Project cannot be both grouped and ungrouped: {project_id}"
            )));
        }
    }
    Ok(())
}

use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_database_loads_empty_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("project-terminal.db")).unwrap();
        let repository = ProjectCollectionsRepository::new(database);
        let snapshot = repository.load().unwrap();
        assert!(snapshot.collections.is_empty());
        assert!(snapshot.collapsed.is_empty());
    }
}
