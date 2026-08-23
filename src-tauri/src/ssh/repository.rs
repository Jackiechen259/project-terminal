//! SQLite repository for SSH connection metadata.
//!
//! The schema intentionally contains only password_saved metadata. Passwords
//! continue to live in the Windows Credential Manager through credential.rs.

use std::sync::Arc;

use chrono::Utc;
use rusqlite::{params, Row, Transaction};

use crate::database::{self, Database};
use crate::error::{AppError, AppResult};

use super::model::SshConnection;

/// Legacy JSON envelope retained for the one-time importer.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct SshConnectionCollection {
    #[serde(default)]
    pub connections: Vec<SshConnection>,
}

#[derive(Debug, Clone)]
struct SshRecord {
    id: String,
    name: String,
    host: String,
    port: i64,
    username: String,
    authentication_type: String,
    password_saved: i64,
    identity_file: Option<String>,
    use_ssh_agent: i64,
    jump_host_json: Option<String>,
    connect_timeout_seconds: i64,
    server_alive_interval_seconds: i64,
    server_alive_count_max: i64,
    strict_host_key_checking: i64,
    known_hosts_file: Option<String>,
    extra_args_json: Option<String>,
    created_at: String,
    updated_at: String,
}

pub struct SshConnectionRepository {
    db: Arc<Database>,
}

impl SshConnectionRepository {
    pub fn new(source: impl Into<database::DatabaseSource>) -> Self {
        Self {
            db: source.into().into_database(),
        }
    }

    pub fn database(&self) -> Arc<Database> {
        Arc::clone(&self.db)
    }

    pub fn list(&self) -> AppResult<Vec<SshConnection>> {
        self.db.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id, name, host, port, username, authentication_type,
                            password_saved, identity_file, use_ssh_agent,
                            jump_host_json, connect_timeout_seconds,
                            server_alive_interval_seconds, server_alive_count_max,
                            strict_host_key_checking, known_hosts_file,
                            extra_args_json, created_at, updated_at
                     FROM ssh_connections
                     ORDER BY name COLLATE NOCASE ASC, id ASC",
                )
                .map_err(|error| database::error::sqlite("prepare SSH list", error))?;
            let rows = statement
                .query_map([], ssh_record_from_row)
                .map_err(|error| database::error::sqlite("query SSH connections", error))?;
            rows.map(|row| {
                row.map_err(|error| database::error::sqlite("read SSH row", error))?
                    .into_connection()
            })
            .collect()
        })
    }

    pub fn get(&self, id: &str) -> AppResult<SshConnection> {
        self.db.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id, name, host, port, username, authentication_type,
                            password_saved, identity_file, use_ssh_agent,
                            jump_host_json, connect_timeout_seconds,
                            server_alive_interval_seconds, server_alive_count_max,
                            strict_host_key_checking, known_hosts_file,
                            extra_args_json, created_at, updated_at
                     FROM ssh_connections WHERE id = ?1",
                    params![id],
                    ssh_record_from_row,
                )
                .map_err(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => {
                        AppError::SshConnectionNotFound(id.to_owned())
                    }
                    error => database::error::sqlite("read SSH connection", error),
                })?
                .into_connection()
        })
    }

    pub fn upsert(&self, connection: SshConnection) -> AppResult<SshConnection> {
        connection.validate()?;
        let result = connection.clone();
        self.db.transaction(|transaction| {
            Self::upsert_tx(transaction, &connection)?;
            Ok(())
        })?;
        Ok(result)
    }

    pub fn delete(&self, id: &str, referencing_project_ids: &[String]) -> AppResult<()> {
        if let Some(project_id) = referencing_project_ids.first() {
            return Err(AppError::SshConnectionInUse(project_id.clone()));
        }
        self.db.transaction(|transaction| {
            let changed = transaction
                .execute("DELETE FROM ssh_connections WHERE id = ?1", params![id])
                .map_err(|error| database::error::sqlite("delete SSH connection", error))?;
            if changed == 0 {
                return Err(AppError::SshConnectionNotFound(id.to_owned()));
            }
            Ok(())
        })
    }

    pub(crate) fn upsert_tx(
        transaction: &Transaction<'_>,
        connection: &SshConnection,
    ) -> AppResult<()> {
        let jump_host_json =
            database::schema::optional_json(connection.jump_host.as_ref(), "SSH jump_host")?;
        let extra_args_json = database::schema::json(&connection.extra_args, "SSH extra_args")?;
        transaction
            .execute(
                "INSERT INTO ssh_connections(
                    id, name, host, port, username, authentication_type,
                    password_saved, identity_file, use_ssh_agent, jump_host_json,
                    connect_timeout_seconds, server_alive_interval_seconds,
                    server_alive_count_max, strict_host_key_checking,
                    known_hosts_file, extra_args_json, created_at, updated_at
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                    ?13, ?14, ?15, ?16, ?17, ?18
                 )
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    host = excluded.host,
                    port = excluded.port,
                    username = excluded.username,
                    authentication_type = excluded.authentication_type,
                    password_saved = excluded.password_saved,
                    identity_file = excluded.identity_file,
                    use_ssh_agent = excluded.use_ssh_agent,
                    jump_host_json = excluded.jump_host_json,
                    connect_timeout_seconds = excluded.connect_timeout_seconds,
                    server_alive_interval_seconds = excluded.server_alive_interval_seconds,
                    server_alive_count_max = excluded.server_alive_count_max,
                    strict_host_key_checking = excluded.strict_host_key_checking,
                    known_hosts_file = excluded.known_hosts_file,
                    extra_args_json = excluded.extra_args_json,
                    updated_at = excluded.updated_at",
                params![
                    connection.id,
                    connection.name,
                    connection.host,
                    i64::from(connection.port),
                    connection.username,
                    database::schema::text_enum(
                        &connection.authentication_type,
                        "SSH authentication type",
                    )?,
                    database::schema::bool_i64(connection.password_saved),
                    connection.identity_file,
                    database::schema::bool_i64(connection.use_ssh_agent),
                    jump_host_json,
                    i64::from(connection.connect_timeout_seconds),
                    i64::from(connection.server_alive_interval_seconds),
                    i64::from(connection.server_alive_count_max),
                    database::schema::bool_i64(connection.strict_host_key_checking),
                    connection.known_hosts_file,
                    extra_args_json,
                    database::schema::timestamp(&connection.created_at),
                    database::schema::timestamp(&connection.updated_at),
                ],
            )
            .map_err(|error| database::error::sqlite("upsert SSH connection", error))?;
        Ok(())
    }

    pub(crate) fn count_tx(transaction: &Transaction<'_>) -> AppResult<i64> {
        transaction
            .query_row("SELECT COUNT(*) FROM ssh_connections", [], |row| row.get(0))
            .map_err(|error| database::error::sqlite("count SSH connections", error))
    }
}

fn ssh_record_from_row(row: &Row<'_>) -> rusqlite::Result<SshRecord> {
    Ok(SshRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        host: row.get(2)?,
        port: row.get(3)?,
        username: row.get(4)?,
        authentication_type: row.get(5)?,
        password_saved: row.get(6)?,
        identity_file: row.get(7)?,
        use_ssh_agent: row.get(8)?,
        jump_host_json: row.get(9)?,
        connect_timeout_seconds: row.get(10)?,
        server_alive_interval_seconds: row.get(11)?,
        server_alive_count_max: row.get(12)?,
        strict_host_key_checking: row.get(13)?,
        known_hosts_file: row.get(14)?,
        extra_args_json: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

impl SshRecord {
    fn into_connection(self) -> AppResult<SshConnection> {
        Ok(SshConnection {
            id: self.id,
            name: self.name,
            host: self.host,
            port: u16::try_from(self.port)
                .map_err(|_| AppError::Database("SSH port is outside u16 range".into()))?,
            username: self.username,
            authentication_type: database::schema::parse_text_enum(
                &self.authentication_type,
                "SSH authentication type",
            )?,
            password_saved: database::schema::bool_from_i64(self.password_saved, "password_saved")?,
            identity_file: self.identity_file,
            use_ssh_agent: database::schema::bool_from_i64(self.use_ssh_agent, "use_ssh_agent")?,
            jump_host: self
                .jump_host_json
                .map(|value| database::schema::parse_json(&value, "SSH jump_host"))
                .transpose()?,
            connect_timeout_seconds: u32::try_from(self.connect_timeout_seconds)
                .map_err(|_| AppError::Database("invalid SSH connect timeout".into()))?,
            server_alive_interval_seconds: u32::try_from(self.server_alive_interval_seconds)
                .map_err(|_| AppError::Database("invalid SSH keepalive interval".into()))?,
            server_alive_count_max: u32::try_from(self.server_alive_count_max)
                .map_err(|_| AppError::Database("invalid SSH keepalive count".into()))?,
            strict_host_key_checking: database::schema::bool_from_i64(
                self.strict_host_key_checking,
                "strict_host_key_checking",
            )?,
            known_hosts_file: self.known_hosts_file,
            extra_args: self
                .extra_args_json
                .map(|value| database::schema::parse_json(&value, "SSH extra_args"))
                .transpose()?
                .unwrap_or_default(),
            created_at: database::schema::parse_timestamp(&self.created_at, "SSH.created_at")?,
            updated_at: database::schema::parse_timestamp(&self.updated_at, "SSH.updated_at")?,
        })
    }
}

#[cfg(test)]
pub fn new_ssh_connection(
    id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
) -> SshConnection {
    let now = Utc::now();
    SshConnection {
        id,
        name,
        host,
        port,
        username,
        authentication_type: super::model::SshAuthenticationType::Agent,
        password_saved: false,
        identity_file: None,
        use_ssh_agent: true,
        jump_host: None,
        connect_timeout_seconds: 15,
        server_alive_interval_seconds: 30,
        server_alive_count_max: 3,
        strict_host_key_checking: true,
        known_hosts_file: None,
        extra_args: vec![],
        created_at: now,
        updated_at: now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{Project, ProjectType, SshProjectConfig};

    fn fixture() -> (SshConnectionRepository, Arc<Database>) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("project-terminal.db");
        let db = Database::open(path).unwrap();
        (SshConnectionRepository::new(Arc::clone(&db)), db)
    }

    #[test]
    fn metadata_round_trips_without_a_password_column() {
        let (repo, db) = fixture();
        let connection = new_ssh_connection(
            "c1".into(),
            "Katana".into(),
            "katana.example.com".into(),
            22,
            "user".into(),
        );
        repo.upsert(connection.clone()).unwrap();
        assert_eq!(repo.get("c1").unwrap(), connection);
        let columns: Vec<String> = db
            .with_connection(|connection| {
                let mut statement = connection
                    .prepare("PRAGMA table_info(ssh_connections)")
                    .map_err(|error| database::error::sqlite("inspect SSH schema", error))?;
                let rows = statement
                    .query_map([], |row| row.get(1))
                    .map_err(|error| database::error::sqlite("read SSH schema", error))?;
                rows.collect::<Result<Vec<String>, _>>()
                    .map_err(|error| database::error::sqlite("collect SSH schema", error))
            })
            .unwrap();
        assert!(!columns
            .iter()
            .any(|column| { matches!(column.as_str(), "password" | "secret" | "credential") }));
    }

    #[test]
    fn referenced_connections_are_blocked() {
        let (repo, db) = fixture();
        let connection = new_ssh_connection(
            "c1".into(),
            "Katana".into(),
            "katana.example.com".into(),
            22,
            "user".into(),
        );
        repo.upsert(connection).unwrap();
        ProjectRepositoryForTest::insert(
            &db,
            Project {
                id: "p1".into(),
                name: "Remote".into(),
                project_type: ProjectType::Ssh,
                local: None,
                ssh: Some(SshProjectConfig {
                    connection_id: "c1".into(),
                    remote_path: "/srv".into(),
                }),
                wsl: None,
                default_profile_id: None,
                created_at: Utc::now(),
                updated_at: Utc::now(),
            },
        );
        let error = repo.delete("c1", &["p1".into()]).unwrap_err();
        assert!(matches!(error, AppError::SshConnectionInUse(_)));
    }

    struct ProjectRepositoryForTest;
    impl ProjectRepositoryForTest {
        fn insert(db: &Arc<Database>, project: Project) {
            crate::project::ProjectRepository::new(Arc::clone(db))
                .upsert(project)
                .unwrap();
        }
    }
}
