//! Terminal Profile Tauri commands. CRUD over the profile JSON repository.
//!
//! Per plan §12.2: `list_terminal_profiles`, `create_terminal_profile`,
//! `update_terminal_profile`, `delete_terminal_profile`,
//! `validate_terminal_profile`, `test_terminal_profile`.
//!
//! `test_terminal_profile` arrives in Phase 3.6/3.7 (Conda / environment
//! detection); for now it returns an explicit "not implemented" error.

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::commands::ListResponse;
use crate::error::{AppError, AppResult};
use crate::profile::{ShellType, TerminalProfile};
use crate::state::{new_id, AppState};

/// Payload for creating/updating a terminal profile. The frontend fills this
/// in; the backend resolves id/timestamps on create.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    #[serde(default)]
    pub id: Option<String>,
    pub project_id: String,
    pub name: String,

    pub shell_type: ShellType,
    #[serde(default)]
    pub shell_executable: Option<String>,
    #[serde(default)]
    pub shell_args: Vec<String>,

    pub environment_type: crate::profile::EnvironmentType,

    #[serde(default)]
    pub environment_name: Option<String>,
    #[serde(default)]
    pub environment_path: Option<String>,

    #[serde(default)]
    pub conda: Option<crate::profile::CondaEnvironmentConfig>,

    #[serde(default)]
    pub activation_command: Option<String>,
    #[serde(default)]
    pub startup_commands: Vec<String>,

    #[serde(default)]
    pub environment_variables: Option<std::collections::BTreeMap<String, String>>,

    #[serde(default)]
    pub wsl_distribution: Option<String>,
    #[serde(default)]
    pub wsl_working_directory: Option<String>,

    #[serde(default)]
    pub remote_shell_command: Option<String>,

    #[serde(default)]
    pub is_default: bool,
}

fn build_profile_from_input(input: ProfileInput, id: String) -> AppResult<TerminalProfile> {
    let now = Utc::now();
    let profile = TerminalProfile {
        id,
        project_id: input.project_id,
        name: input.name,
        shell_type: input.shell_type,
        shell_executable: input.shell_executable,
        shell_args: input.shell_args,
        environment_type: input.environment_type,
        environment_name: input.environment_name,
        environment_path: input.environment_path,
        conda: input.conda,
        activation_command: input.activation_command,
        startup_commands: input.startup_commands,
        environment_variables: input.environment_variables,
        wsl_distribution: input.wsl_distribution,
        wsl_working_directory: input.wsl_working_directory,
        remote_shell_command: input.remote_shell_command,
        is_default: input.is_default,
        created_at: now,
        updated_at: now,
    };
    Ok(profile)
}

pub fn list_terminal_profiles_inner(
    state: &AppState,
    project_id: &str,
) -> AppResult<ListResponse<TerminalProfile>> {
    Ok(ListResponse::new(
        state.profiles.list_for_project(project_id)?,
    ))
}

pub fn validate_terminal_profile_inner(input: ProfileInput) -> AppResult<()> {
    let profile = build_profile_from_input(input, "scratch".to_string())?;
    profile.validate()
}

pub fn create_terminal_profile_inner(
    state: &AppState,
    input: ProfileInput,
) -> AppResult<TerminalProfile> {
    // Profile must belong to an existing project.
    state.projects.get(&input.project_id)?;
    let id = new_id("profile");
    let profile = build_profile_from_input(input, id)?;
    state.profiles.upsert(profile)
}

pub fn update_terminal_profile_inner(
    state: &AppState,
    input: ProfileInput,
) -> AppResult<TerminalProfile> {
    let id = input
        .id
        .clone()
        .ok_or_else(|| AppError::Configuration("update_terminal_profile requires an id".into()))?;
    let existing = state.profiles.get(&id)?;
    let updated = TerminalProfile {
        id: existing.id.clone(),
        project_id: input.project_id,
        name: input.name,
        shell_type: input.shell_type,
        shell_executable: input.shell_executable,
        shell_args: input.shell_args,
        environment_type: input.environment_type,
        environment_name: input.environment_name,
        environment_path: input.environment_path,
        conda: input.conda,
        activation_command: input.activation_command,
        startup_commands: input.startup_commands,
        environment_variables: input.environment_variables,
        wsl_distribution: input.wsl_distribution,
        wsl_working_directory: input.wsl_working_directory,
        remote_shell_command: input.remote_shell_command,
        is_default: input.is_default,
        created_at: existing.created_at,
        updated_at: Utc::now(),
    };
    state.profiles.upsert(updated)
}

pub fn delete_terminal_profile_inner(state: &AppState, id: &str) -> AppResult<()> {
    state.profiles.delete(id)
}

pub fn test_terminal_profile_inner(_state: &AppState, _id: &str) -> AppResult<String> {
    // Phase 3.6/3.7 will implement conda/venv test execution. Until then we
    // return an explicit Configuration error so the frontend can distinguish
    // "not implemented yet" from a real test failure.
    Err(AppError::Configuration(
        "test_terminal_profile is not implemented until Phase 3.6".into(),
    ))
}

#[tauri::command]
pub fn list_terminal_profiles(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> AppResult<ListResponse<TerminalProfile>> {
    list_terminal_profiles_inner(&state, &project_id)
}

#[tauri::command]
pub fn validate_terminal_profile(input: ProfileInput) -> AppResult<()> {
    validate_terminal_profile_inner(input)
}

#[tauri::command]
pub fn create_terminal_profile(
    state: tauri::State<'_, AppState>,
    input: ProfileInput,
) -> AppResult<TerminalProfile> {
    create_terminal_profile_inner(&state, input)
}

#[tauri::command]
pub fn update_terminal_profile(
    state: tauri::State<'_, AppState>,
    input: ProfileInput,
) -> AppResult<TerminalProfile> {
    update_terminal_profile_inner(&state, input)
}

#[tauri::command]
pub fn delete_terminal_profile(state: tauri::State<'_, AppState>, id: String) -> AppResult<()> {
    delete_terminal_profile_inner(&state, &id)
}

#[tauri::command]
pub fn test_terminal_profile(state: tauri::State<'_, AppState>, id: String) -> AppResult<String> {
    test_terminal_profile_inner(&state, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_dirs::ConfigDirs;
    use crate::profile::{EnvironmentType, ProfileRepository};
    use crate::project::{LocalProjectConfig, Project, ProjectRepository, ProjectType};
    use crate::ssh::SshConnectionRepository;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn test_state() -> AppState {
        let root = std::env::temp_dir().join(format!("pt-prof-cmd-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let dirs = ConfigDirs::from_root(root.clone());
        AppState {
            dirs: Arc::new(dirs),
            projects: Arc::new(ProjectRepository::new(root.join("projects.json"))),
            profiles: Arc::new(ProfileRepository::new(root.join("profiles.json"))),
            ssh: Arc::new(SshConnectionRepository::new(root.join("ssh.json"))),
        }
    }

    fn temp_local_dir() -> PathBuf {
        let p = std::env::temp_dir().join(format!("pt-projdir-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn sample_input(project_id: &str) -> ProfileInput {
        ProfileInput {
            id: None,
            project_id: project_id.into(),
            name: "PowerShell".into(),
            shell_type: ShellType::Powershell,
            shell_executable: None,
            shell_args: vec![],
            environment_type: EnvironmentType::None,
            environment_name: None,
            environment_path: None,
            conda: None,
            activation_command: None,
            startup_commands: vec![],
            environment_variables: None,
            wsl_distribution: None,
            wsl_working_directory: None,
            remote_shell_command: None,
            is_default: false,
        }
    }

    fn seed_local_project(state: &AppState, id: &str) -> PathBuf {
        let dir = temp_local_dir();
        let project = Project {
            id: id.into(),
            name: "Demo".into(),
            project_type: ProjectType::Local,
            local: Some(LocalProjectConfig {
                path: dir.to_string_lossy().into_owned(),
            }),
            ssh: None,
            default_profile_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        state.projects.upsert(project).unwrap();
        dir
    }

    #[test]
    fn create_terminal_profile_requires_existing_project() {
        let state = test_state();
        let input = sample_input("no-such-project");
        let result = create_terminal_profile_inner(&state, input);
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AppError::ProjectNotFound(_)));
    }

    #[test]
    fn create_terminal_profile_for_existing_project_succeeds() {
        let state = test_state();
        seed_local_project(&state, "p1");
        let input = sample_input("p1");
        let profile = create_terminal_profile_inner(&state, input).unwrap();
        assert_eq!(profile.project_id, "p1");
        assert_eq!(profile.shell_type, ShellType::Powershell);
    }

    #[test]
    fn list_terminal_profiles_returns_only_for_project() {
        let state = test_state();
        seed_local_project(&state, "p1");
        let mut input = sample_input("p1");
        input.name = "P1 Profile".into();
        create_terminal_profile_inner(&state, input).unwrap();

        let response = list_terminal_profiles_inner(&state, "p1").unwrap();
        assert_eq!(response.items.len(), 1);
        let response = list_terminal_profiles_inner(&state, "p2").unwrap();
        assert!(response.items.is_empty());
    }

    #[test]
    fn test_terminal_profile_returns_configuration_error() {
        let state = test_state();
        let result = test_terminal_profile_inner(&state, "x");
        assert!(result.is_err());
    }
}
