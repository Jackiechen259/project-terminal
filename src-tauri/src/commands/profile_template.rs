//! Profile template Tauri commands. CRUD over the template JSON repository.
//! Templates are project-independent; the frontend creates a concrete
//! `TerminalProfile` from a template when the user quick-launches it.

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::commands::ListResponse;
use crate::error::AppResult;
use crate::profile::model::{CondaEnvironmentConfig, EnvironmentType, ShellType};
use crate::profile::{ProfileTemplate, TemplateIcon, TerminalProfile};
use crate::state::{new_id, AppState};

/// Payload for creating/updating a profile template. The backend resolves
/// id/timestamps on create.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub icon: TemplateIcon,

    pub shell_type: ShellType,
    #[serde(default)]
    pub shell_executable: Option<String>,
    #[serde(default)]
    pub shell_args: Vec<String>,

    pub environment_type: EnvironmentType,

    #[serde(default)]
    pub environment_name: Option<String>,
    #[serde(default)]
    pub environment_path: Option<String>,

    #[serde(default)]
    pub conda: Option<CondaEnvironmentConfig>,

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
}

fn build_template_from_input(input: TemplateInput, id: String) -> AppResult<ProfileTemplate> {
    let now = Utc::now();
    let template = ProfileTemplate {
        id,
        name: input.name,
        icon: input.icon,
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
        created_at: now,
        updated_at: now,
    };
    template.validate()?;
    Ok(template)
}

pub fn list_profile_templates_inner(state: &AppState) -> AppResult<ListResponse<ProfileTemplate>> {
    Ok(ListResponse::new(state.templates.list()?))
}

pub fn create_profile_template_inner(
    state: &AppState,
    input: TemplateInput,
) -> AppResult<ProfileTemplate> {
    let id = new_id("tpl");
    let template = build_template_from_input(input, id)?;
    state.templates.upsert(template)
}

pub fn update_profile_template_inner(
    state: &AppState,
    input: TemplateInput,
) -> AppResult<ProfileTemplate> {
    let id = input
        .id
        .ok_or_else(|| crate::error::AppError::Configuration("Template id is required".into()))?;
    let existing = state.templates.get(&id)?;
    let now = Utc::now();
    let template = ProfileTemplate {
        id: id.clone(),
        name: input.name,
        icon: input.icon,
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
        created_at: existing.created_at,
        updated_at: now,
    };
    state.templates.upsert(template)
}

pub fn delete_profile_template_inner(state: &AppState, id: &str) -> AppResult<()> {
    state.templates.delete(id)
}

#[tauri::command]
pub fn list_profile_templates(
    state: tauri::State<'_, AppState>,
) -> AppResult<ListResponse<ProfileTemplate>> {
    list_profile_templates_inner(&state)
}

#[tauri::command]
pub fn create_profile_template(
    state: tauri::State<'_, AppState>,
    input: TemplateInput,
) -> AppResult<ProfileTemplate> {
    create_profile_template_inner(&state, input)
}

#[tauri::command]
pub fn update_profile_template(
    state: tauri::State<'_, AppState>,
    input: TemplateInput,
) -> AppResult<ProfileTemplate> {
    update_profile_template_inner(&state, input)
}

#[tauri::command]
pub fn delete_profile_template(state: tauri::State<'_, AppState>, id: String) -> AppResult<()> {
    delete_profile_template_inner(&state, &id)
}

/// project. Copies every configurable field; assigns a new id and timestamps.
pub fn create_profile_from_template_inner(
    state: &AppState,
    template_id: &str,
    project_id: &str,
    name: &str,
) -> AppResult<TerminalProfile> {
    let template = state.templates.get(template_id)?;
    let now = Utc::now();
    let profile = TerminalProfile {
        id: new_id("profile"),
        project_id: project_id.to_string(),
        name: name.to_string(),
        shell_type: template.shell_type,
        shell_executable: template.shell_executable,
        shell_args: template.shell_args,
        environment_type: template.environment_type,
        environment_name: template.environment_name,
        environment_path: template.environment_path,
        conda: template.conda,
        activation_command: template.activation_command,
        startup_commands: template.startup_commands,
        environment_variables: template.environment_variables,
        wsl_distribution: template.wsl_distribution,
        wsl_working_directory: template.wsl_working_directory,
        remote_shell_command: template.remote_shell_command,
        is_default: false,
        show_in_context_menu: true,
        created_at: now,
        updated_at: now,
    };
    state.profiles.upsert(profile)
}

#[tauri::command]
pub fn create_profile_from_template(
    state: tauri::State<'_, AppState>,
    template_id: String,
    project_id: String,
    name: String,
) -> AppResult<TerminalProfile> {
    create_profile_from_template_inner(&state, &template_id, &project_id, &name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use crate::config_dirs::ConfigDirs;

    fn test_state() -> AppState {
        let dir = tempfile::tempdir().unwrap();
        let dirs = ConfigDirs::from_root(dir.path().to_path_buf());
        AppState {
            projects: Arc::new(crate::project::ProjectRepository::new(dirs.projects_path())),
            profiles: Arc::new(crate::profile::ProfileRepository::new(dirs.profiles_path())),
            templates: Arc::new(crate::profile::TemplateRepository::new(dirs.templates_path())),
            ssh: Arc::new(crate::ssh::SshConnectionRepository::new(
                dirs.ssh_connections_path(),
            )),
        }
    }

    use std::sync::Arc;

    fn sample_input(name: &str) -> TemplateInput {
        TemplateInput {
            id: None,
            name: name.to_string(),
            icon: TemplateIcon::LayoutTemplate,
            shell_type: ShellType::Powershell,
            shell_executable: None,
            shell_args: vec![],
            environment_type: EnvironmentType::None,
            environment_name: None,
            environment_path: None,
            conda: None,
            activation_command: None,
            startup_commands: vec!["codex".to_string()],
            environment_variables: None,
            wsl_distribution: None,
            wsl_working_directory: None,
            remote_shell_command: None,
        }
    }

    #[test]
    fn create_and_list_template() {
        let state = test_state();
        let created = create_profile_template_inner(&state, sample_input("Codex")).unwrap();
        assert_eq!(created.name, "Codex");
        let list = list_profile_templates_inner(&state).unwrap();
        assert_eq!(list.items.len(), 1);
    }

    #[test]
    fn update_template() {
        let state = test_state();
        let created = create_profile_template_inner(&state, sample_input("Codex")).unwrap();
        let mut input = sample_input("Updated");
        input.id = Some(created.id.clone());
        input.icon = TemplateIcon::Rocket;
        let updated = update_profile_template_inner(&state, input).unwrap();
        assert_eq!(updated.name, "Updated");
        assert_eq!(updated.icon, TemplateIcon::Rocket);
    }

    #[test]
    fn delete_template() {
        let state = test_state();
        let created = create_profile_template_inner(&state, sample_input("Codex")).unwrap();
        delete_profile_template_inner(&state, &created.id).unwrap();
        assert!(list_profile_templates_inner(&state).unwrap().items.is_empty());
    }

    #[test]
    fn create_profile_from_template_copies_fields() {
        let state = test_state();
        let template = create_profile_template_inner(&state, sample_input("Codex")).unwrap();
        let profile = create_profile_from_template_inner(
            &state,
            &template.id,
            "proj-1",
            "Codex",
        )
        .unwrap();
        assert_eq!(profile.project_id, "proj-1");
        assert_eq!(profile.startup_commands, vec!["codex".to_string()]);
        assert!(!profile.is_default);
    }
}
