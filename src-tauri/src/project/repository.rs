//! SQLite repository for projects.

use std::sync::Arc;

use chrono::Utc;
use rusqlite::{params, Row, Transaction};

use crate::database::{self, Database};
use crate::error::{AppError, AppResult};

use super::model::{LocalProjectConfig, Project, ProjectType, SshProjectConfig, WslProjectConfig};

/// Legacy JSON envelope retained for the one-time importer.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ProjectCollection {
    #[serde(default)]
    pub projects: Vec<Project>,
}

#[derive(Debug, Clone)]
struct ProjectRecord {
    id: String,
    name: String,
    project_type: String,
    local_path: Option<String>,
    ssh_connection_id: Option<String>,
    ssh_remote_path: Option<String>,
    wsl_distribution: Option<String>,
    wsl_working_directory: Option<String>,
    default_profile_id: Option<String>,
    created_at: String,
    updated_at: String,
}

/// SQLite-backed project repository. All repository instances for one
/// AppState share the same Database, which is what makes cross-entity
/// transactions possible.
pub struct ProjectRepository {
    db: Arc<Database>,
}

impl ProjectRepository {
    pub fn new(source: impl Into<database::DatabaseSource>) -> Self {
        Self {
            db: source.into().into_database(),
        }
    }

    pub fn database(&self) -> Arc<Database> {
        Arc::clone(&self.db)
    }

    pub fn list(&self) -> AppResult<Vec<Project>> {
        self.db.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id, name, type, local_path, ssh_connection_id,
                            ssh_remote_path, wsl_distribution,
                            wsl_working_directory, default_profile_id,
                            created_at, updated_at
                     FROM projects
                     ORDER BY sidebar_sort_order ASC, created_at ASC, id ASC",
                )
                .map_err(|error| database::error::sqlite("prepare project list", error))?;
            let rows = statement
                .query_map([], project_record_from_row)
                .map_err(|error| database::error::sqlite("query projects", error))?;
            rows.map(|row| {
                row.map_err(|error| database::error::sqlite("read project row", error))?
                    .into_project()
            })
            .collect()
        })
    }

    pub fn get(&self, id: &str) -> AppResult<Project> {
        self.db.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id, name, type, local_path, ssh_connection_id,
                            ssh_remote_path, wsl_distribution,
                            wsl_working_directory, default_profile_id,
                            created_at, updated_at
                     FROM projects
                     WHERE id = ?1",
                    params![id],
                    project_record_from_row,
                )
                .map_err(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => {
                        AppError::ProjectNotFound(id.to_owned())
                    }
                    error => database::error::sqlite("read project", error),
                })?
                .into_project()
        })
    }

    pub fn upsert(&self, project: Project) -> AppResult<Project> {
        project.validate()?;
        let result = project.clone();
        self.db.transaction(|transaction| {
            Self::upsert_tx(transaction, &project)?;
            Ok(())
        })?;
        Ok(result)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        self.db
            .transaction(|transaction| Self::delete_tx(transaction, id))
    }

    pub fn set_sidebar_sort_order(&self, id: &str, sort_order: i64) -> AppResult<()> {
        self.db.with_connection(|connection| {
            let changed = connection
                .execute(
                    "UPDATE projects SET sidebar_sort_order = ?1 WHERE id = ?2",
                    params![sort_order, id],
                )
                .map_err(|error| database::error::sqlite("update project sidebar order", error))?;
            if changed == 0 {
                return Err(AppError::ProjectNotFound(id.to_owned()));
            }
            Ok(())
        })
    }

    pub(crate) fn upsert_tx(transaction: &Transaction<'_>, project: &Project) -> AppResult<()> {
        let (
            local_path,
            ssh_connection_id,
            ssh_remote_path,
            wsl_distribution,
            wsl_working_directory,
        ) = match (
            &project.project_type,
            &project.local,
            &project.ssh,
            &project.wsl,
        ) {
            (ProjectType::Local, Some(local), _, _) => {
                (Some(local.path.clone()), None, None, None, None)
            }
            (ProjectType::Ssh, _, Some(ssh), _) => (
                None,
                Some(ssh.connection_id.clone()),
                Some(ssh.remote_path.clone()),
                None,
                None,
            ),
            (ProjectType::Wsl, _, _, Some(wsl)) => (
                None,
                None,
                None,
                Some(wsl.distribution.clone()),
                wsl.working_directory.clone(),
            ),
            _ => {
                return Err(AppError::Configuration(
                    "Project configuration does not match its type".into(),
                ))
            }
        };

        transaction
            .execute(
                "INSERT INTO projects(
                    id, name, type, local_path, ssh_connection_id,
                    ssh_remote_path, wsl_distribution, wsl_working_directory,
                    default_profile_id, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    type = excluded.type,
                    local_path = excluded.local_path,
                    ssh_connection_id = excluded.ssh_connection_id,
                    ssh_remote_path = excluded.ssh_remote_path,
                    wsl_distribution = excluded.wsl_distribution,
                    wsl_working_directory = excluded.wsl_working_directory,
                    default_profile_id = excluded.default_profile_id,
                    updated_at = excluded.updated_at",
                params![
                    project.id,
                    project.name,
                    database::schema::text_enum(&project.project_type, "project type")?,
                    local_path,
                    ssh_connection_id,
                    ssh_remote_path,
                    wsl_distribution,
                    wsl_working_directory,
                    project.default_profile_id,
                    database::schema::timestamp(&project.created_at),
                    database::schema::timestamp(&project.updated_at),
                ],
            )
            .map_err(|error| database::error::sqlite("upsert project", error))?;
        Ok(())
    }

    pub(crate) fn delete_tx(transaction: &Transaction<'_>, id: &str) -> AppResult<()> {
        let changed = transaction
            .execute("DELETE FROM projects WHERE id = ?1", params![id])
            .map_err(|error| database::error::sqlite("delete project", error))?;
        if changed == 0 {
            return Err(AppError::ProjectNotFound(id.to_owned()));
        }
        Ok(())
    }

    pub(crate) fn count_tx(transaction: &Transaction<'_>) -> AppResult<i64> {
        transaction
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .map_err(|error| database::error::sqlite("count projects", error))
    }
}

fn project_record_from_row(row: &Row<'_>) -> rusqlite::Result<ProjectRecord> {
    Ok(ProjectRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        project_type: row.get(2)?,
        local_path: row.get(3)?,
        ssh_connection_id: row.get(4)?,
        ssh_remote_path: row.get(5)?,
        wsl_distribution: row.get(6)?,
        wsl_working_directory: row.get(7)?,
        default_profile_id: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

impl ProjectRecord {
    fn into_project(self) -> AppResult<Project> {
        let project_type = database::schema::parse_text_enum(&self.project_type, "project type")?;
        let local = match project_type {
            ProjectType::Local => Some(LocalProjectConfig {
                path: self.local_path.ok_or_else(|| {
                    AppError::Database("local project is missing local_path".into())
                })?,
            }),
            _ => None,
        };
        let ssh = match project_type {
            ProjectType::Ssh => Some(SshProjectConfig {
                connection_id: self.ssh_connection_id.ok_or_else(|| {
                    AppError::Database("SSH project is missing ssh_connection_id".into())
                })?,
                remote_path: self.ssh_remote_path.ok_or_else(|| {
                    AppError::Database("SSH project is missing ssh_remote_path".into())
                })?,
            }),
            _ => None,
        };
        let wsl = match project_type {
            ProjectType::Wsl => Some(WslProjectConfig {
                distribution: self.wsl_distribution.ok_or_else(|| {
                    AppError::Database("WSL project is missing wsl_distribution".into())
                })?,
                working_directory: self.wsl_working_directory,
            }),
            _ => None,
        };
        Ok(Project {
            id: self.id,
            name: self.name,
            project_type,
            local,
            ssh,
            wsl,
            default_profile_id: self.default_profile_id,
            created_at: database::schema::parse_timestamp(&self.created_at, "project.created_at")?,
            updated_at: database::schema::parse_timestamp(&self.updated_at, "project.updated_at")?,
        })
    }
}

#[cfg(test)]
/// Build a new local project with a fresh id and timestamps.
pub fn new_local_project(id: String, name: String, path: String) -> Project {
    let now = Utc::now();
    Project {
        id,
        name,
        project_type: ProjectType::Local,
        local: Some(LocalProjectConfig { path }),
        ssh: None,
        wsl: None,
        default_profile_id: None,
        created_at: now,
        updated_at: now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository() -> ProjectRepository {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("project-terminal.db");
        ProjectRepository::new(Database::open(path).unwrap())
    }

    #[test]
    fn upsert_then_get_round_trips() {
        let repo = repository();
        let project = new_local_project("p1".into(), "Demo".into(), "D:\\Demo".into());
        repo.upsert(project.clone()).unwrap();
        assert_eq!(repo.get("p1").unwrap().name, "Demo");
        assert_eq!(repo.list().unwrap(), vec![project]);
    }

    #[test]
    fn delete_removes_project() {
        let repo = repository();
        repo.upsert(new_local_project(
            "p1".into(),
            "Demo".into(),
            "D:\\Demo".into(),
        ))
        .unwrap();
        repo.delete("p1").unwrap();
        assert!(matches!(repo.get("p1"), Err(AppError::ProjectNotFound(_))));
    }

    #[test]
    fn invalid_project_is_rejected_before_sql() {
        let repo = repository();
        let mut project = new_local_project("p1".into(), "Demo".into(), "D:\\Demo".into());
        project.name.clear();
        assert!(repo.upsert(project).is_err());
        assert!(repo.list().unwrap().is_empty());
    }
}
