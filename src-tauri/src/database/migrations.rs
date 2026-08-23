//! Explicit, numbered SQLite schema migrations.

use chrono::Utc;
use rusqlite::{params, Connection};

use super::error;

pub const CURRENT_SCHEMA_VERSION: i64 = 1;

const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS ssh_connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT NOT NULL,
    authentication_type TEXT NOT NULL,
    password_saved INTEGER NOT NULL DEFAULT 0,
    identity_file TEXT,
    use_ssh_agent INTEGER NOT NULL DEFAULT 0,
    jump_host_json TEXT,
    connect_timeout_seconds INTEGER NOT NULL,
    server_alive_interval_seconds INTEGER NOT NULL,
    server_alive_count_max INTEGER NOT NULL,
    strict_host_key_checking INTEGER NOT NULL,
    known_hosts_file TEXT,
    extra_args_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    local_path TEXT,
    ssh_connection_id TEXT,
    ssh_remote_path TEXT,
    wsl_distribution TEXT,
    wsl_working_directory TEXT,
    default_profile_id TEXT,
    sidebar_sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (ssh_connection_id)
        REFERENCES ssh_connections(id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_projects_ssh_connection_id
    ON projects(ssh_connection_id);

CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    shell_type TEXT NOT NULL,
    shell_executable TEXT,
    shell_args_json TEXT,
    environment_type TEXT NOT NULL,
    environment_name TEXT,
    environment_path TEXT,
    conda_json TEXT,
    activation_command TEXT,
    startup_commands_json TEXT,
    environment_variables_json TEXT,
    wsl_distribution TEXT,
    wsl_working_directory TEXT,
    remote_shell_command TEXT,
    force_utf8 INTEGER,
    shell_integration INTEGER,
    color_scheme_id TEXT,
    accent_color TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    show_in_context_menu INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id)
        REFERENCES projects(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_profiles_project_id
    ON profiles(project_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_one_default_per_project
    ON profiles(project_id)
    WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS profile_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    shell_type TEXT NOT NULL,
    shell_executable TEXT,
    shell_args_json TEXT,
    environment_type TEXT NOT NULL,
    environment_name TEXT,
    environment_path TEXT,
    conda_json TEXT,
    activation_command TEXT,
    startup_commands_json TEXT,
    environment_variables_json TEXT,
    wsl_distribution TEXT,
    wsl_working_directory TEXT,
    remote_shell_command TEXT,
    force_utf8 INTEGER,
    shell_integration INTEGER,
    color_scheme_id TEXT,
    accent_color TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS color_schemes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    collapsed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_projects (
    collection_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (collection_id, project_id),
    FOREIGN KEY (collection_id)
        REFERENCES collections(id)
        ON DELETE CASCADE,
    FOREIGN KEY (project_id)
        REFERENCES projects(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_collection_projects_collection
    ON collection_projects(collection_id);

CREATE INDEX IF NOT EXISTS idx_collection_projects_project
    ON collection_projects(project_id);

CREATE TABLE IF NOT EXISTS memos (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    description TEXT,
    command TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (project_id)
        REFERENCES projects(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memos_project_id
    ON memos(project_id);

CREATE TABLE IF NOT EXISTS workspace_state (
    workspace_id TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

pub fn run(conn: &mut Connection) -> Result<(), crate::error::AppError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );",
    )
    .map_err(|error| error::migration("create schema_migrations", error))?;

    let current: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error::migration("read schema version", error))?;

    if current > CURRENT_SCHEMA_VERSION {
        return Err(crate::error::AppError::DatabaseMigration(format!(
            "database schema version {current} is newer than this application supports ({CURRENT_SCHEMA_VERSION})"
        )));
    }

    if current < 1 {
        let tx = conn
            .transaction()
            .map_err(|error| error::migration("begin schema migration 1", error))?;
        tx.execute_batch(SCHEMA_V1)
            .map_err(|error| error::migration("apply schema migration 1", error))?;
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
            params![1_i64, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error::migration("record schema migration 1", error))?;
        tx.commit()
            .map_err(|error| error::migration("commit schema migration 1", error))?;
    }

    Ok(())
}
