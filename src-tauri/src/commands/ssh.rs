//! SSH Connection Tauri commands. CRUD over the SSH connection repository.
//!
//! Per plan §12.5: `list_ssh_connections`, `create_ssh_connection`,
//! `update_ssh_connection`, `delete_ssh_connection`,
//! `validate_ssh_connection`, `test_ssh_connection`, `detect_ssh_client`,
//! `read_ssh_host_fingerprint`.
//!
//! Phase 5 implements `test_ssh_connection`, `detect_ssh_client`, and
//! `read_ssh_host_fingerprint`. For now those return an explicit
//! "not implemented" error.

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::commands::ListResponse;
use crate::error::{AppError, AppResult};
use crate::ssh::SshConnection;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub authentication_type: crate::ssh::SshAuthenticationType,
    #[serde(default)]
    pub identity_file: Option<String>,
    #[serde(default)]
    pub use_ssh_agent: bool,
    #[serde(default)]
    pub jump_host: Option<crate::ssh::SshJumpHost>,
    #[serde(default = "default_connect_timeout")]
    pub connect_timeout_seconds: u32,
    #[serde(default = "default_keepalive_interval")]
    pub server_alive_interval_seconds: u32,
    #[serde(default = "default_keepalive_max")]
    pub server_alive_count_max: u32,
    #[serde(default = "default_strict_host_key")]
    pub strict_host_key_checking: bool,
    #[serde(default)]
    pub known_hosts_file: Option<String>,
    #[serde(default)]
    pub extra_args: Vec<String>,
}

fn default_connect_timeout() -> u32 {
    15
}
fn default_keepalive_interval() -> u32 {
    30
}
fn default_keepalive_max() -> u32 {
    3
}
fn default_strict_host_key() -> bool {
    true
}

fn build_connection_from_input(input: SshConnectionInput, id: String) -> AppResult<SshConnection> {
    let now = Utc::now();
    Ok(SshConnection {
        id,
        name: input.name,
        host: input.host,
        port: input.port,
        username: input.username,
        authentication_type: input.authentication_type,
        identity_file: input.identity_file,
        use_ssh_agent: input.use_ssh_agent,
        jump_host: input.jump_host,
        connect_timeout_seconds: input.connect_timeout_seconds,
        server_alive_interval_seconds: input.server_alive_interval_seconds,
        server_alive_count_max: input.server_alive_count_max,
        strict_host_key_checking: input.strict_host_key_checking,
        known_hosts_file: input.known_hosts_file,
        extra_args: input.extra_args,
        created_at: now,
        updated_at: now,
    })
}

/// Find projects that reference a connection id.
fn projects_referencing_connection(state: &AppState, connection_id: &str) -> Vec<String> {
    state
        .projects
        .list()
        .map(|projects| {
            projects
                .into_iter()
                .filter_map(|p| match &p.ssh {
                    Some(ssh) if ssh.connection_id == connection_id => Some(p.id),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn list_ssh_connections_inner(state: &AppState) -> AppResult<ListResponse<SshConnection>> {
    Ok(ListResponse::new(state.ssh.list()?))
}

pub fn validate_ssh_connection_inner(input: SshConnectionInput) -> AppResult<()> {
    let conn = build_connection_from_input(input, "scratch".to_string())?;
    conn.validate()
}

pub fn create_ssh_connection_inner(
    state: &AppState,
    input: SshConnectionInput,
) -> AppResult<SshConnection> {
    let id = crate::state::new_id("ssh");
    let conn = build_connection_from_input(input, id)?;
    state.ssh.upsert(conn)
}

pub fn update_ssh_connection_inner(
    state: &AppState,
    input: SshConnectionInput,
) -> AppResult<SshConnection> {
    let id = input
        .id
        .clone()
        .ok_or_else(|| AppError::Configuration("update_ssh_connection requires an id".into()))?;
    let existing = state.ssh.get(&id)?;
    let updated = SshConnection {
        id: existing.id.clone(),
        name: input.name,
        host: input.host,
        port: input.port,
        username: input.username,
        authentication_type: input.authentication_type,
        identity_file: input.identity_file,
        use_ssh_agent: input.use_ssh_agent,
        jump_host: input.jump_host,
        connect_timeout_seconds: input.connect_timeout_seconds,
        server_alive_interval_seconds: input.server_alive_interval_seconds,
        server_alive_count_max: input.server_alive_count_max,
        strict_host_key_checking: input.strict_host_key_checking,
        known_hosts_file: input.known_hosts_file,
        extra_args: input.extra_args,
        created_at: existing.created_at,
        updated_at: Utc::now(),
    };
    state.ssh.upsert(updated)
}

pub fn delete_ssh_connection_inner(state: &AppState, id: &str) -> AppResult<()> {
    // §31.2: if any project still references this connection, block delete
    // and surface the referencing project id.
    let references = projects_referencing_connection(state, id);
    state.ssh.delete(id, &references)
}

pub fn test_ssh_connection_inner(_state: &AppState, _id: &str) -> AppResult<String> {
    Err(AppError::Configuration(
        "test_ssh_connection is not implemented until Phase 5".into(),
    ))
}

pub fn detect_ssh_client_inner() -> AppResult<Option<String>> {
    // Phase 5 will return the path to a detected ssh.exe. For now, return None
    // so the frontend can render the right "not detected yet" UI.
    Ok(None)
}

pub fn read_ssh_host_fingerprint_inner(_state: &AppState, _id: &str) -> AppResult<String> {
    Err(AppError::Configuration(
        "read_ssh_host_fingerprint is not implemented until Phase 5".into(),
    ))
}

#[tauri::command]
pub fn list_ssh_connections(
    state: tauri::State<'_, AppState>,
) -> AppResult<ListResponse<SshConnection>> {
    list_ssh_connections_inner(&state)
}

#[tauri::command]
pub fn validate_ssh_connection(input: SshConnectionInput) -> AppResult<()> {
    validate_ssh_connection_inner(input)
}

#[tauri::command]
pub fn create_ssh_connection(
    state: tauri::State<'_, AppState>,
    input: SshConnectionInput,
) -> AppResult<SshConnection> {
    create_ssh_connection_inner(&state, input)
}

#[tauri::command]
pub fn update_ssh_connection(
    state: tauri::State<'_, AppState>,
    input: SshConnectionInput,
) -> AppResult<SshConnection> {
    update_ssh_connection_inner(&state, input)
}

#[tauri::command]
pub fn delete_ssh_connection(state: tauri::State<'_, AppState>, id: String) -> AppResult<()> {
    delete_ssh_connection_inner(&state, &id)
}

#[tauri::command]
pub fn test_ssh_connection(state: tauri::State<'_, AppState>, id: String) -> AppResult<String> {
    test_ssh_connection_inner(&state, &id)
}

#[tauri::command]
pub fn detect_ssh_client() -> AppResult<Option<String>> {
    detect_ssh_client_inner()
}

#[tauri::command]
pub fn read_ssh_host_fingerprint(
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<String> {
    read_ssh_host_fingerprint_inner(&state, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_dirs::ConfigDirs;
    use crate::profile::ProfileRepository;
    use crate::project::{Project, ProjectRepository, ProjectType, SshProjectConfig};
    use crate::ssh::SshConnectionRepository;
    use std::fs;
    use std::sync::Arc;

    fn test_state() -> AppState {
        let root = std::env::temp_dir().join(format!("pt-ssh-cmd-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let dirs = ConfigDirs::from_root(root.clone());
        AppState {
            dirs: Arc::new(dirs),
            projects: Arc::new(ProjectRepository::new(root.join("projects.json"))),
            profiles: Arc::new(ProfileRepository::new(root.join("profiles.json"))),
            ssh: Arc::new(SshConnectionRepository::new(root.join("ssh.json"))),
        }
    }

    fn sample_input() -> SshConnectionInput {
        SshConnectionInput {
            id: None,
            name: "Katana".into(),
            host: "katana.example.com".into(),
            port: 22,
            username: "user".into(),
            authentication_type: crate::ssh::SshAuthenticationType::Agent,
            identity_file: None,
            use_ssh_agent: true,
            jump_host: None,
            connect_timeout_seconds: 15,
            server_alive_interval_seconds: 30,
            server_alive_count_max: 3,
            strict_host_key_checking: true,
            known_hosts_file: None,
            extra_args: vec![],
        }
    }

    #[test]
    fn create_ssh_connection_round_trips() {
        let state = test_state();
        let conn = create_ssh_connection_inner(&state, sample_input()).unwrap();
        assert_eq!(conn.host, "katana.example.com");
        assert!(state.ssh.get(&conn.id).is_ok());
    }

    #[test]
    fn delete_ssh_connection_blocked_when_referenced() {
        let state = test_state();
        let conn = create_ssh_connection_inner(&state, sample_input()).unwrap();
        let project = Project {
            id: "p1".into(),
            name: "Katana".into(),
            project_type: ProjectType::Ssh,
            local: None,
            ssh: Some(SshProjectConfig {
                connection_id: conn.id.clone(),
                remote_path: "/srv".into(),
            }),
            default_profile_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        state.projects.upsert(project).unwrap();

        let err = delete_ssh_connection_inner(&state, &conn.id).unwrap_err();
        assert!(matches!(err, AppError::SshConnectionInUse(_)));
    }

    #[test]
    fn delete_ssh_connection_succeeds_when_unreferenced() {
        let state = test_state();
        let conn = create_ssh_connection_inner(&state, sample_input()).unwrap();
        delete_ssh_connection_inner(&state, &conn.id).unwrap();
        assert!(state.ssh.get(&conn.id).is_err());
    }

    #[test]
    fn update_ssh_connection_preserves_created_at() {
        let state = test_state();
        let created = create_ssh_connection_inner(&state, sample_input()).unwrap();
        let mut input = sample_input();
        input.id = Some(created.id.clone());
        input.name = "Renamed".into();
        let updated = update_ssh_connection_inner(&state, input).unwrap();
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.created_at, created.created_at);
    }

    #[test]
    fn validate_ssh_connection_rejects_empty_host() {
        let mut input = sample_input();
        input.host = "".into();
        assert!(validate_ssh_connection_inner(input).is_err());
    }

    #[test]
    fn test_and_fingerprint_return_configuration_error() {
        let state = test_state();
        assert!(test_ssh_connection_inner(&state, "x").is_err());
        assert!(read_ssh_host_fingerprint_inner(&state, "x").is_err());
    }

    #[test]
    fn detect_ssh_client_returns_none() {
        assert!(detect_ssh_client_inner().unwrap().is_none());
    }
}
