use std::sync::Arc;

use rusqlite::{params, Row, Transaction};
use serde::{Deserialize, Serialize};

use crate::database::{self, Database};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemo {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub command: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing)]
    pub sort_order: i64,
}

impl ProjectMemo {
    pub(crate) fn validate(&self) -> AppResult<()> {
        if self.id.trim().is_empty() || self.project_id.trim().is_empty() {
            return Err(AppError::Configuration(
                "Memo id and project id must not be empty".into(),
            ));
        }
        if !matches!(self.kind.as_str(), "markdown" | "command") {
            return Err(AppError::Configuration(format!(
                "Unsupported memo kind: {}",
                self.kind
            )));
        }
        Ok(())
    }
}

pub struct MemoRepository {
    db: Arc<Database>,
}

impl MemoRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { db: database }
    }

    pub fn list_for_project(&self, project_id: &str) -> AppResult<Vec<ProjectMemo>> {
        self.db.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id, project_id, kind, title, content, description,
                            command, created_at, updated_at, sort_order
                     FROM memos
                     WHERE project_id = ?1
                     ORDER BY sort_order ASC, created_at ASC, id ASC",
                )
                .map_err(|error| database::error::sqlite("prepare memo list", error))?;
            let rows = statement
                .query_map(params![project_id], memo_from_row)
                .map_err(|error| database::error::sqlite("query memos", error))?;
            rows.map(|row| {
                row.map_err(|error| database::error::sqlite("read memo", error))?
                    .into_memo()
            })
            .collect()
        })
    }

    pub fn replace_for_project(&self, project_id: &str, memos: &[ProjectMemo]) -> AppResult<()> {
        if project_id.trim().is_empty() {
            return Err(AppError::Configuration(
                "Project id must not be empty".into(),
            ));
        }
        let mut ids = std::collections::HashSet::new();
        for memo in memos {
            memo.validate()?;
            if memo.project_id != project_id {
                return Err(AppError::Configuration(
                    "Memo project id does not match the requested project".into(),
                ));
            }
            if !ids.insert(memo.id.as_str()) {
                return Err(AppError::Configuration(format!(
                    "Duplicate memo id: {}",
                    memo.id
                )));
            }
        }
        self.db
            .transaction(|transaction| Self::replace_for_project_tx(transaction, project_id, memos))
    }

    pub(crate) fn replace_for_project_tx(
        transaction: &Transaction<'_>,
        project_id: &str,
        memos: &[ProjectMemo],
    ) -> AppResult<()> {
        let mut ids = std::collections::HashSet::new();
        for memo in memos {
            memo.validate()?;
            if memo.project_id != project_id {
                return Err(AppError::Configuration(
                    "Memo project id does not match the requested project".into(),
                ));
            }
            if !ids.insert(memo.id.as_str()) {
                return Err(AppError::Configuration(format!(
                    "Duplicate memo id: {}",
                    memo.id
                )));
            }
        }
        transaction
            .execute(
                "DELETE FROM memos WHERE project_id = ?1",
                params![project_id],
            )
            .map_err(|error| database::error::sqlite("replace project memos", error))?;
        for (sort_order, memo) in memos.iter().enumerate() {
            Self::upsert_tx(transaction, memo, sort_order as i64)?;
        }
        Ok(())
    }

    pub fn upsert(&self, memo: &ProjectMemo) -> AppResult<()> {
        memo.validate()?;
        self.db
            .transaction(|transaction| Self::upsert_tx(transaction, memo, memo.sort_order))
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        self.db.with_connection(|connection| {
            connection
                .execute("DELETE FROM memos WHERE id = ?1", params![id])
                .map_err(|error| database::error::sqlite("delete memo", error))?;
            Ok(())
        })
    }

    fn upsert_tx(
        transaction: &Transaction<'_>,
        memo: &ProjectMemo,
        sort_order: i64,
    ) -> AppResult<()> {
        transaction
            .execute(
                "INSERT INTO memos(
                    id, project_id, kind, title, content, description, command,
                    created_at, updated_at, sort_order
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                    project_id = excluded.project_id,
                    kind = excluded.kind,
                    title = excluded.title,
                    content = excluded.content,
                    description = excluded.description,
                    command = excluded.command,
                    updated_at = excluded.updated_at,
                    sort_order = excluded.sort_order",
                params![
                    memo.id,
                    memo.project_id,
                    memo.kind,
                    memo.title,
                    if memo.kind == "markdown" {
                        Some(memo.content.as_str())
                    } else {
                        None
                    },
                    if memo.kind == "command" {
                        Some(memo.description.as_str())
                    } else {
                        None
                    },
                    if memo.kind == "command" {
                        Some(memo.command.as_str())
                    } else {
                        None
                    },
                    memo.created_at,
                    memo.updated_at,
                    sort_order,
                ],
            )
            .map_err(|error| database::error::sqlite("upsert memo", error))?;
        Ok(())
    }
}

fn memo_from_row(row: &Row<'_>) -> rusqlite::Result<MemoRecord> {
    Ok(MemoRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        kind: row.get(2)?,
        title: row.get(3)?,
        content: row.get(4)?,
        description: row.get(5)?,
        command: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        sort_order: row.get(9)?,
    })
}

struct MemoRecord {
    id: String,
    project_id: String,
    kind: String,
    title: String,
    content: Option<String>,
    description: Option<String>,
    command: Option<String>,
    created_at: i64,
    updated_at: i64,
    sort_order: i64,
}

impl MemoRecord {
    fn into_memo(self) -> AppResult<ProjectMemo> {
        let memo = ProjectMemo {
            id: self.id,
            project_id: self.project_id,
            kind: self.kind,
            title: self.title,
            content: self.content.unwrap_or_default(),
            description: self.description.unwrap_or_default(),
            command: self.command.unwrap_or_default(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            sort_order: self.sort_order,
        };
        memo.validate()?;
        Ok(memo)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{LocalProjectConfig, Project, ProjectType};

    #[test]
    fn replaces_and_lists_project_memos() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("project-terminal.db")).unwrap();
        let project_repository = crate::project::ProjectRepository::new(Arc::clone(&database));
        project_repository
            .upsert(Project {
                id: "p1".into(),
                name: "Project".into(),
                project_type: ProjectType::Local,
                local: Some(LocalProjectConfig {
                    path: "D:\\P".into(),
                }),
                ssh: None,
                wsl: None,
                default_profile_id: None,
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
            })
            .unwrap();
        let repository = MemoRepository::new(database);
        repository
            .replace_for_project(
                "p1",
                &[ProjectMemo {
                    id: "m1".into(),
                    project_id: "p1".into(),
                    kind: "markdown".into(),
                    title: "Note".into(),
                    content: "Body".into(),
                    description: String::new(),
                    command: String::new(),
                    created_at: 1,
                    updated_at: 2,
                    sort_order: 0,
                }],
            )
            .unwrap();
        assert_eq!(
            repository.list_for_project("p1").unwrap()[0].content,
            "Body"
        );
    }
}
