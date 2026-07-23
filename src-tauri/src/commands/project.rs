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
use crate::profile::{default_local_profile, default_remote_profile, default_wsl_profile};
use crate::project::{
    LocalProjectConfig, Project, ProjectType, SshProjectConfig, WslProjectConfig,
};
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
    pub wsl: Option<WslProjectConfig>,

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
                wsl: None,
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
                wsl: None,
                default_profile_id: input.default_profile_id,
                created_at: now,
                updated_at: now,
            }
        }
        ProjectType::Wsl => {
            let wsl = input.wsl.ok_or_else(|| {
                AppError::Configuration("WSL project requires a wsl config".into())
            })?;
            // Normalize the working directory: empty strings become None so
            // the serialized JSON stays consistent and `resolve_local_shell`
            // does not push a `--cd ""` argument.
            let working_directory = wsl
                .working_directory
                .map(|wd| wd.trim().to_string())
                .filter(|wd| !wd.is_empty());
            Project {
                id,
                name: input.name,
                project_type: ProjectType::Wsl,
                local: None,
                ssh: None,
                wsl: Some(WslProjectConfig {
                    distribution: wsl.distribution,
                    working_directory,
                }),
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
    state.with_config_write(|| {
        let id = new_id("project");
        let project = build_project_from_input(input, id)?;
        project.validate()?;
        state.projects.upsert(project.clone())?;

        // Every project gets an immediately usable, target-appropriate profile.
        let profile_id = new_id("profile");
        let profile = match project.project_type {
            ProjectType::Local => default_local_profile(profile_id, project.id.clone()),
            ProjectType::Ssh => default_remote_profile(profile_id, project.id.clone()),
            ProjectType::Wsl => {
                let wsl = project.wsl.clone().ok_or_else(|| {
                    AppError::Configuration("WSL project requires a wsl config".into())
                })?;
                default_wsl_profile(
                    profile_id,
                    project.id.clone(),
                    wsl.distribution,
                    wsl.working_directory,
                )
            }
        };
        if let Err(profile_error) = state.profiles.upsert(profile) {
            if let Err(rollback_error) = state.projects.delete(&project.id) {
                return Err(AppError::Configuration(format!(
                    "Failed to create the default profile ({profile_error}); \
                     project rollback also failed ({rollback_error})"
                )));
            }
            return Err(profile_error);
        }
        Ok(project)
    })
}

pub fn update_project_inner(state: &AppState, input: ProjectInput) -> AppResult<Project> {
    state.with_config_write(|| {
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
            wsl: input.wsl,
            default_profile_id: input.default_profile_id,
            created_at: existing.created_at,
            updated_at: Utc::now(),
        };
        updated.validate()?;
        state.projects.upsert(updated)
    })
}

pub fn delete_project_inner(state: &AppState, id: &str) -> AppResult<()> {
    // §31.1: deleting a project removes its profiles. The frontend confirms
    // first if it has open terminals (those would be closed via
    // close_terminal commands before this is called).
    state.with_config_write(|| {
        state.projects.get(id)?;
        let profiles = state.profiles.list_for_project(id)?;
        state.profiles.delete_all_for_project(id)?;
        if let Err(project_error) = state.projects.delete(id) {
            let mut rollback_errors = Vec::new();
            for profile in profiles {
                if let Err(error) = state.profiles.upsert(profile) {
                    rollback_errors.push(error.to_string());
                }
            }
            if !rollback_errors.is_empty() {
                return Err(AppError::Configuration(format!(
                    "Failed to delete project ({project_error}); profile rollback also failed: {}",
                    rollback_errors.join("; ")
                )));
            }
            return Err(project_error);
        }
        Ok(())
    })
}

/// Open a saved project's working directory in Windows Explorer.
///
/// Local projects open their Windows path directly. WSL projects open the
/// matching `\\wsl.localhost\<distro>\<linux path>` folder so the user can
/// browse the Linux filesystem from Windows. The frontend submits only a
/// project id; the persisted path is revalidated here, so this is not a
/// general-purpose process execution endpoint.
pub fn open_project_in_explorer_inner(state: &AppState, id: &str) -> AppResult<()> {
    let project = state.projects.get(id)?;
    let target = match project.project_type {
        ProjectType::Local => project
            .local
            .as_ref()
            .map(|local| local.path.clone())
            .ok_or_else(|| {
                AppError::Configuration("Local project is missing its path configuration".into())
            })?,
        ProjectType::Wsl => {
            let wsl = project.wsl.as_ref().ok_or_else(|| {
                AppError::Configuration("WSL project is missing its wsl configuration".into())
            })?;
            wsl_explorer_path(&wsl.distribution, wsl.working_directory.as_deref())
        }
        ProjectType::Ssh => {
            return Err(AppError::Configuration(
                "SSH projects cannot be opened in File Explorer".into(),
            ));
        }
    };
    match project.project_type {
        ProjectType::Local => validate_local_path(&target)?,
        // WSL paths are not checked on the Windows side: the `\\wsl.localhost`
        // share only materializes while WSL is running, and a missing folder
        // surfaces as an Explorer error that the user can act on.
        _ => {}
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(&target)
            .spawn()
            .map_err(AppError::Io)?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Err(AppError::Configuration(
            "Opening File Explorer is only supported on Windows".into(),
        ))
    }
}

/// Translate a WSL distribution + Linux path into the Windows UNC path that
/// Explorer accepts: `\\wsl.localhost\<distro>\<path>`. `\\wsl$` is the
/// legacy alias; `\\wsl.localhost` is preferred on Windows 11+.
fn wsl_explorer_path(distribution: &str, working_directory: Option<&str>) -> String {
    let distro = distribution.trim().trim_matches('\\');
    let path = working_directory
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| p.trim_start_matches('/').replace('/', "\\"))
        .unwrap_or_default();
    if path.is_empty() {
        format!("\\\\wsl.localhost\\{distro}")
    } else {
        format!("\\\\wsl.localhost\\{distro}\\{path}")
    }
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

#[tauri::command]
pub fn open_project_in_explorer(state: tauri::State<'_, AppState>, id: String) -> AppResult<()> {
    open_project_in_explorer_inner(&state, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{ProfileRepository, TemplateRepository};
    use crate::project::ProjectRepository;
    use crate::ssh::SshConnectionRepository;
    use std::fs;
    use std::path::PathBuf;
    fn test_state() -> AppState {
        let root = std::env::temp_dir().join(format!("pt-cmd-{}", uuid::Uuid::new_v4()));
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

    fn local_input(name: &str, path: &str) -> ProjectInput {
        ProjectInput {
            id: None,
            name: name.into(),
            project_type: ProjectType::Local,
            local: Some(LocalProjectConfig { path: path.into() }),
            ssh: None,
            wsl: None,
            default_profile_id: None,
        }
    }

    fn wsl_input(name: &str, distribution: &str, working_directory: Option<&str>) -> ProjectInput {
        ProjectInput {
            id: None,
            name: name.into(),
            project_type: ProjectType::Wsl,
            local: None,
            ssh: None,
            wsl: Some(WslProjectConfig {
                distribution: distribution.into(),
                working_directory: working_directory.map(str::to_string),
            }),
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
    fn concurrent_project_creates_do_not_lose_updates() {
        let state = test_state();
        let dir = temp_local_dir();
        let handles: Vec<_> = (0..8)
            .map(|index| {
                let state = state.clone();
                let dir = dir.clone();
                std::thread::spawn(move || {
                    create_project_inner(
                        &state,
                        local_input(&format!("Project {index}"), dir.to_str().unwrap()),
                    )
                    .unwrap();
                })
            })
            .collect();

        for handle in handles {
            handle.join().unwrap();
        }

        let projects = state.projects.list().unwrap();
        let profiles = state.profiles.list_all().unwrap();
        assert_eq!(projects.len(), 8);
        assert_eq!(profiles.len(), 8);
    }

    #[test]
    fn create_project_rolls_back_when_default_profile_cannot_be_saved() {
        let root = std::env::temp_dir().join(format!("pt-cmd-rollback-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let invalid_profile_path = root.join("profiles-as-directory");
        fs::create_dir_all(&invalid_profile_path).unwrap();
        let state = AppState::from_repositories(
            ProjectRepository::new(root.join("projects.json")),
            ProfileRepository::new(invalid_profile_path),
            TemplateRepository::new(root.join("templates.json")),
            SshConnectionRepository::new(root.join("ssh.json")),
        );
        let dir = temp_local_dir();

        let result = create_project_inner(&state, local_input("Demo", dir.to_str().unwrap()));

        assert!(result.is_err());
        assert!(state.projects.list().unwrap().is_empty());
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
            wsl: None,
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
            wsl: None,
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

    #[test]
    fn create_wsl_project_seeds_a_wsl_profile_with_distribution() {
        let state = test_state();
        let input = wsl_input("Ubuntu project", "Ubuntu", Some("/home/user/proj"));
        let project = create_project_inner(&state, input).unwrap();
        assert_eq!(project.project_type, ProjectType::Wsl);
        let wsl = project.wsl.unwrap();
        assert_eq!(wsl.distribution, "Ubuntu");
        assert_eq!(wsl.working_directory.as_deref(), Some("/home/user/proj"));

        let profiles = state.profiles.list_for_project(&project.id).unwrap();
        assert_eq!(profiles.len(), 1);
        let profile = &profiles[0];
        assert!(profile.is_default);
        assert_eq!(profile.shell_type, crate::profile::ShellType::Wsl);
        assert_eq!(profile.wsl_distribution.as_deref(), Some("Ubuntu"));
        assert_eq!(
            profile.wsl_working_directory.as_deref(),
            Some("/home/user/proj")
        );
    }

    #[test]
    fn create_wsl_project_normalizes_blank_working_directory() {
        let state = test_state();
        let input = wsl_input("Blank wd", "Ubuntu", Some("   "));
        let project = create_project_inner(&state, input).unwrap();
        let wsl = project.wsl.unwrap();
        assert_eq!(wsl.distribution, "Ubuntu");
        assert!(wsl.working_directory.is_none());

        let profile = state
            .profiles
            .list_for_project(&project.id)
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        assert!(profile.wsl_working_directory.is_none());
    }

    #[test]
    fn create_wsl_project_requires_distribution() {
        let state = test_state();
        let input = wsl_input("Bad", "  ", None);
        let err = create_project_inner(&state, input).unwrap_err();
        assert!(matches!(err, AppError::Configuration(_)));
    }

    #[test]
    fn explorer_rejects_ssh_projects() {
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
            wsl: None,
            default_profile_id: None,
        };
        let project = create_project_inner(&state, input).unwrap();
        assert!(open_project_in_explorer_inner(&state, &project.id).is_err());
    }

    #[test]
    fn wsl_explorer_path_translates_linux_path_to_unc() {
        assert_eq!(
            wsl_explorer_path("Ubuntu", Some("/home/user/proj")),
            "\\\\wsl.localhost\\Ubuntu\\home\\user\\proj"
        );
        assert_eq!(
            wsl_explorer_path("Debian", None),
            "\\\\wsl.localhost\\Debian"
        );
        // Empty working directory falls back to the distro root.
        assert_eq!(
            wsl_explorer_path("Ubuntu", Some("")),
            "\\\\wsl.localhost\\Ubuntu"
        );
        // Leading slashes are stripped so we don't double up backslashes.
        assert_eq!(
            wsl_explorer_path("Ubuntu", Some("/srv/app")),
            "\\\\wsl.localhost\\Ubuntu\\srv\\app"
        );
    }
}
