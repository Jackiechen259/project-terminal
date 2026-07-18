//! Project Tauri commands. CRUD over the project JSON repository.
//!
//! Per plan §12.1: `list_projects`, `create_project`, `update_project`,
//! `delete_project`, `validate_project`.
//!
//! Security: the frontend only submits project fields (name, type, local
//! path, ssh connection + remote path). The backend resolves ids, timestamps,
//! and validates that a local path exists before persisting. The frontend
//! never controls executable paths or shell arguments.
//!
//! Each `#[tauri::command]` is a thin wrapper over a pure inner function that
//! takes `&AppState`. The inner functions are unit-tested directly; the
//! Tauri wrappers exist only to unwrap the state and convert errors.

use std::path::Path;

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::commands::ListResponse;
use crate::error::{AppError, AppResult};
use crate::profile::{default_powershell_profile, default_remote_profile};
use crate::project::{LocalProjectConfig, Project, ProjectType, SshProjectConfig};
use crate::state::{new_id, AppState};

/// Payload for creating/updating a project. The frontend fills this in; the
/// backend fills id/timestamps on create.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(rename = "type")]
    pub project_type: ProjectType,

    #[serde(default)]
    pub local: Option<LocalProjectConfig>,
    #[serde(default)]
    pub ssh: Option<SshProjectConfig>,

    #[serde(default)]
    pub default_profile_id: Option<String>,
}

/// Validate a local path: must exist and be a directory.
fn validate_local_path(path: &str) -> AppResult<()> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(AppError::ProjectPathNotFound(path.to_string()));
    }
    if !p.is_dir() {
        return Err(AppError::ProjectPathNotFound(format!(
            "{path} is not a directory"
        )));
    }
    Ok(())
}

fn build_project_from_input(input: ProjectInput, id: String) -> AppResult<Project> {
    let now = Utc::now();
    let project = match input.project_type {
        ProjectType::Local => {
            let local = input.local.ok_or_else(|| {
                AppError::Configuration("Local project requires a local config".into())
            })?;
            validate_local_path(&local.path)?;
            Project {
                id,
                name: input.name,
                project_type: ProjectType::Local,
                local: Some(local),
                ssh: None,
                default_profile_id: input.default_profile_id,
                created_at: now,
                updated_at: now,
            }
        }
        ProjectType::Ssh => {
            let ssh = input.ssh.ok_or_else(|| {
                AppError::Configuration("SSH project requires an ssh config".into())
            })?;
            Project {
                id,
                name: input.name,
                project_type: ProjectType::Ssh,
                local: None,
                ssh: Some(ssh),
                default_profile_id: input.default_profile_id,
                created_at: now,
                updated_at: now,
            }
        }
    };
    Ok(project)
}

pub fn list_projects_inner(state: &AppState) -> AppResult<ListResponse<Project>> {
    Ok(ListResponse::new(state.projects.list()?))
}

pub fn validate_project_inner(input: ProjectInput) -> AppResult<()> {
    let project = build_project_from_input(input, "scratch".to_string())?;
    project.validate()
}

pub fn create_project_inner(state: &AppState, input: ProjectInput) -> AppResult<Project> {
    let id = new_id("project");
    let project = build_project_from_input(input, id)?;
    project.validate()?;
    state.projects.upsert(project.clone())?;

    // Every project gets an immediately usable, target-appropriate profile.
    let profile_id = new_id("profile");
    let profile = match project.project_type {
        ProjectType::Local => default_powershell_profile(profile_id, project.id.clone()),
        ProjectType::Ssh => default_remote_profile(profile_id, project.id.clone()),
    };
    state.profiles.upsert(profile)?;
    Ok(project)
}

pub fn update_project_inner(state: &AppState, input: ProjectInput) -> AppResult<Project> {
    let id = input
        .id
        .clone()
        .ok_or_else(|| AppError::Configuration("update_project requires an id".into()))?;
    let existing = state.projects.get(&id)?;
    let updated = Project {
        id: existing.id.clone(),
        name: input.name,
        project_type: input.project_type,
        local: input.local,
        ssh: input.ssh,
        default_profile_id: input.default_profile_id,
        created_at: existing.created_at,
        updated_at: Utc::now(),
    };
    updated.validate()?;
    state.projects.upsert(updated)
}

pub fn delete_project_inner(state: &AppState, id: &str) -> AppResult<()> {
    // §31.1: deleting a project removes its profiles. The frontend confirms
    // first if it has open terminals (those would be closed via
    // close_terminal commands before this is called).
    state.profiles.delete_all_for_project(id)?;
    state.projects.delete(id)?;
    Ok(())
}

#[tauri::command]
pub fn list_projects(state: tauri::State<'_, AppState>) -> AppResult<ListResponse<Project>> {
    list_projects_inner(&state)
}

#[tauri::command]
pub fn validate_project(input: ProjectInput) -> AppResult<()> {
    validate_project_inner(input)
}

#[tauri::command]
pub fn create_project(
    state: tauri::State<'_, AppState>,
    input: ProjectInput,
) -> AppResult<Project> {
    create_project_inner(&state, input)
}

#[tauri::command]
pub fn update_project(
    state: tauri::State<'_, AppState>,
    input: ProjectInput,
) -> AppResult<Project> {
    update_project_inner(&state, input)
}

#[tauri::command]
pub fn delete_project(state: tauri::State<'_, AppState>, id: String) -> AppResult<()> {
    delete_project_inner(&state, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_dirs::ConfigDirs;
    use crate::profile::ProfileRepository;
    use crate::project::ProjectRepository;
    use crate::ssh::SshConnectionRepository;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn test_state() -> AppState {
        let root = std::env::temp_dir().join(format!("pt-cmd-{}", uuid::Uuid::new_v4()));
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

    fn local_input(name: &str, path: &str) -> ProjectInput {
        ProjectInput {
            id: None,
            name: name.into(),
            project_type: ProjectType::Local,
            local: Some(LocalProjectConfig { path: path.into() }),
            ssh: None,
            default_profile_id: None,
        }
    }

    #[test]
    fn create_local_project_persists_and_seeds_default_profile() {
        let state = test_state();
        let dir = temp_local_dir();
        let project =
            create_project_inner(&state, local_input("Demo", dir.to_str().unwrap())).unwrap();
        assert_eq!(project.name, "Demo");
        assert!(state.projects.get(&project.id).is_ok());
        let profiles = state.profiles.list_for_project(&project.id).unwrap();
        assert_eq!(profiles.len(), 1);
        assert!(profiles[0].is_default);
    }

    #[test]
    fn create_local_project_rejects_missing_path() {
        let state = test_state();
        let result =
            create_project_inner(&state, local_input("Demo", "D:\\does\\not\\exist\\here"));
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(err, AppError::ProjectPathNotFound(_)));
    }

    #[test]
    fn update_project_replaces_fields() {
        let state = test_state();
        let dir1 = temp_local_dir();
        let dir2 = temp_local_dir();
        let created =
            create_project_inner(&state, local_input("A", dir1.to_str().unwrap())).unwrap();
        let update_input = ProjectInput {
            id: Some(created.id.clone()),
            name: "B".into(),
            project_type: ProjectType::Local,
            local: Some(LocalProjectConfig {
                path: dir2.to_string_lossy().into_owned(),
            }),
            ssh: None,
            default_profile_id: None,
        };
        let updated = update_project_inner(&state, update_input).unwrap();
        assert_eq!(updated.name, "B");
        assert_eq!(updated.created_at, created.created_at);
    }

    #[test]
    fn delete_project_removes_profiles_too() {
        let state = test_state();
        let dir = temp_local_dir();
        let project =
            create_project_inner(&state, local_input("Demo", dir.to_str().unwrap())).unwrap();
        assert!(!state
            .profiles
            .list_for_project(&project.id)
            .unwrap()
            .is_empty());
        delete_project_inner(&state, &project.id).unwrap();
        assert!(state.projects.get(&project.id).is_err());
        assert!(state
            .profiles
            .list_for_project(&project.id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn validate_project_accepts_existing_local_path() {
        let dir = temp_local_dir();
        let input = local_input("Demo", dir.to_str().unwrap());
        validate_project_inner(input).unwrap();
    }

    #[test]
    fn validate_project_rejects_missing_path() {
        let input = local_input("Demo", "D:\\no\\such\\dir");
        assert!(validate_project_inner(input).is_err());
    }

    #[test]
    fn create_ssh_project_seeds_a_remote_profile() {
        let state = test_state();
        let input = ProjectInput {
            id: None,
            name: "SSH".into(),
            project_type: ProjectType::Ssh,
            local: None,
            ssh: Some(SshProjectConfig {
                connection_id: "c1".into(),
                remote_path: "/srv".into(),
            }),
            default_profile_id: None,
        };
        let project = create_project_inner(&state, input).unwrap();
        assert_eq!(project.project_type, ProjectType::Ssh);
        let profiles = state.profiles.list_for_project(&project.id).unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(
            profiles[0].shell_type,
            crate::profile::ShellType::RemoteDefault
        );
    }
}
