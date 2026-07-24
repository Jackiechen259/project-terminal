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
use crate::project::ProjectType;
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
    #[serde(default = "default_true")]
    pub show_in_context_menu: bool,
}

fn default_true() -> bool {
    true
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
        show_in_context_menu: input.show_in_context_menu,
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
    state.with_config_write(|| {
        // Profile must belong to an existing project.
        state.projects.get(&input.project_id)?;
        let id = new_id("profile");
        let profile = build_profile_from_input(input, id)?;
        state.profiles.upsert(profile)
    })
}

pub fn update_terminal_profile_inner(
    state: &AppState,
    input: ProfileInput,
) -> AppResult<TerminalProfile> {
    state.with_config_write(|| {
        let id = input.id.clone().ok_or_else(|| {
            AppError::Configuration("update_terminal_profile requires an id".into())
        })?;
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
            show_in_context_menu: input.show_in_context_menu,
            created_at: existing.created_at,
            updated_at: Utc::now(),
        };
        state.profiles.upsert(updated)
    })
}

pub fn delete_terminal_profile_inner(state: &AppState, id: &str) -> AppResult<()> {
    state.with_config_write(|| state.profiles.delete(id))
}

pub fn duplicate_terminal_profile_inner(state: &AppState, id: &str) -> AppResult<TerminalProfile> {
    state.with_config_write(|| {
        let source = state.profiles.get(id)?;
        let now = Utc::now();
        let duplicate = TerminalProfile {
            id: new_id("profile"),
            project_id: source.project_id,
            name: format!("{} Copy", source.name),
            is_default: false,
            created_at: now,
            updated_at: now,
            ..source
        };
        state.profiles.upsert(duplicate)
    })
}

pub fn test_terminal_profile_inner(state: &AppState, id: &str) -> AppResult<String> {
    let profile = state.profiles.get(id)?;
    profile.validate()?;
    let project = state.projects.get(&profile.project_id)?;

    match project.project_type {
        ProjectType::Local => {
            let (executable, _) = crate::terminal::resolve_local_shell(&profile)?;
            validate_environment_path(&profile)?;
            Ok(format!("Profile is ready. Shell: {executable}"))
        }
        ProjectType::Wsl => {
            if !crate::terminal::detect_wsl_distributions()
                .iter()
                .any(|item| {
                    profile
                        .wsl_distribution
                        .as_deref()
                        .map(|name| name == item.name)
                        .unwrap_or(true)
                })
            {
                return Err(AppError::Configuration(
                    "The configured WSL distribution is not installed".into(),
                ));
            }
            Ok("Profile is ready for WSL".into())
        }
        ProjectType::Ssh => Ok("Profile configuration is valid for SSH".into()),
    }
}

fn validate_environment_path(profile: &TerminalProfile) -> AppResult<()> {
    if let Some(path) = profile
        .environment_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    {
        if !std::path::Path::new(path).exists() {
            return Err(AppError::Configuration(format!(
                "Environment path does not exist: {path}"
            )));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedPythonEnvironment {
    pub name: String,
    pub path: String,
    pub kind: String,
}

pub fn detect_python_environments_inner(
    state: &AppState,
    project_id: &str,
) -> AppResult<Vec<DetectedPythonEnvironment>> {
    let project = state.projects.get(project_id)?;
    let local = project.local.ok_or_else(|| {
        AppError::Configuration("Python environment detection requires a local project".into())
    })?;
    let root = std::path::Path::new(&local.path);
    let mut detected = Vec::new();

    for name in [".venv", "venv", "env"] {
        let path = root.join(name);
        let python = if cfg!(windows) {
            path.join("Scripts").join("python.exe")
        } else {
            path.join("bin").join("python")
        };
        if python.is_file() {
            detected.push(DetectedPythonEnvironment {
                name: name.into(),
                path: path.to_string_lossy().into_owned(),
                kind: "venv".into(),
            });
        }
    }

    Ok(detected)
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
pub fn duplicate_terminal_profile(
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<TerminalProfile> {
    duplicate_terminal_profile_inner(&state, &id)
}

#[tauri::command]
pub fn test_terminal_profile(state: tauri::State<'_, AppState>, id: String) -> AppResult<String> {
    test_terminal_profile_inner(&state, &id)
}

#[tauri::command]
pub fn detect_local_shells() -> Vec<crate::terminal::DetectedShell> {
    crate::terminal::detect_local_shells()
}

#[tauri::command]
pub fn detect_python_environments(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> AppResult<Vec<DetectedPythonEnvironment>> {
    detect_python_environments_inner(&state, &project_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{EnvironmentType, ProfileRepository, TemplateRepository};
    use crate::project::{LocalProjectConfig, Project, ProjectRepository, ProjectType};
    use crate::ssh::SshConnectionRepository;
    use std::fs;
    use std::path::PathBuf;
    fn test_state() -> AppState {
        let root = std::env::temp_dir().join(format!("pt-prof-cmd-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        AppState::from_repositories(
            ProjectRepository::new(root.join("projects.json")),
            ProfileRepository::new(root.join("profiles.json")),
            TemplateRepository::new(root.join("templates.json")),
            SshConnectionRepository::new(root.join("ssh.json")),
        )
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
            show_in_context_menu: true,
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
            wsl: None,
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
    fn duplicate_profile_copies_configuration_with_new_identity() {
        let state = test_state();
        seed_local_project(&state, "p1");
        let original = create_terminal_profile_inner(&state, sample_input("p1")).unwrap();
        let duplicate = duplicate_terminal_profile_inner(&state, &original.id).unwrap();
        assert_ne!(duplicate.id, original.id);
        assert_eq!(duplicate.project_id, original.project_id);
        assert_eq!(duplicate.name, "PowerShell Copy");
        assert!(!duplicate.is_default);
    }

    #[test]
    fn detects_project_venv() {
        let state = test_state();
        let root = seed_local_project(&state, "p1");
        let python = if cfg!(windows) {
            root.join(".venv").join("Scripts").join("python.exe")
        } else {
            root.join(".venv").join("bin").join("python")
        };
        fs::create_dir_all(python.parent().unwrap()).unwrap();
        fs::write(python, b"").unwrap();
        let environments = detect_python_environments_inner(&state, "p1").unwrap();
        assert_eq!(environments.len(), 1);
        assert_eq!(environments[0].name, ".venv");
    }
}
