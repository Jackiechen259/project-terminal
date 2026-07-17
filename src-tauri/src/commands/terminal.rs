//! Terminal Tauri commands.
//!
//! Per plan §12.3: `create_terminal`, `write_terminal`, `resize_terminal`,
//! `close_terminal`, `restart_terminal`.
//!
//! Per plan §12 (security): the frontend only submits `projectId` and
//! `profileId` (plus dimensions). The backend resolves the project, profile,
//! shell executable, cwd, env vars, and activation commands. The frontend
//! never controls the executable path or arguments directly.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::{new_id, AppState};
use crate::terminal::{
    profile_needs_environment, resolve_local_shell, SessionSpawn, TerminalManager, TerminalOutput,
};

use super::ListResponse;

/// Create-terminal request payload from the frontend. The frontend never
/// sends executable paths, cwd, or shell arguments - only ids and
/// dimensions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalRequest {
    pub project_id: String,
    pub profile_id: String,
    pub rows: u16,
    pub cols: u16,
}

/// Per-session state we keep alongside the manager so restart can rebuild
/// the spawn config from the original profile without re-querying.
struct SessionMeta {
    project_id: String,
    profile_id: String,
}

pub struct TerminalState {
    pub manager: TerminalManager,
    meta: parking_lot::Mutex<std::collections::HashMap<String, SessionMeta>>,
}

impl Default for TerminalState {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalState {
    pub fn new() -> Self {
        Self {
            manager: TerminalManager::new(),
            meta: parking_lot::Mutex::new(std::collections::HashMap::new()),
        }
    }

    fn remember(&self, session_id: &str, project_id: &str, profile_id: &str) {
        self.meta.lock().insert(
            session_id.to_string(),
            SessionMeta {
                project_id: project_id.to_string(),
                profile_id: profile_id.to_string(),
            },
        );
    }

    fn forget(&self, session_id: &str) {
        self.meta.lock().remove(session_id);
    }

    #[allow(dead_code)]
    fn meta_for(&self, session_id: &str) -> Option<(String, String)> {
        self.meta
            .lock()
            .get(session_id)
            .map(|m| (m.project_id.clone(), m.profile_id.clone()))
    }
}

/// Build a SessionSpawn from a saved project + profile. This is the only
/// place that resolves cwd, executable, args, and env - the frontend never
/// sees these.
fn build_session_spawn(
    app: &AppState,
    request: &CreateTerminalRequest,
    session_id: &str,
) -> AppResult<SessionSpawn> {
    let project = app.projects.get(&request.project_id)?;
    let profile = app.profiles.get(&request.profile_id)?;
    if profile.project_id != project.id {
        return Err(AppError::Configuration(format!(
            "Profile {} does not belong to project {}",
            profile.id, project.id
        )));
    }

    let (program, args) = resolve_local_shell(&profile)?;

    // cwd: local project path. SSH remote cwd arrives in Phase 6.
    let cwd = match &project.local {
        Some(local) => {
            let path = Path::new(&local.path);
            if !path.is_dir() {
                return Err(AppError::ProjectPathNotFound(local.path.clone()));
            }
            Some(local.path.clone())
        }
        None => None,
    };

    // Env vars from the profile, plus internal markers.
    let mut env: Vec<(String, String)> = Vec::new();
    if let Some(vars) = &profile.environment_variables {
        for (k, v) in vars {
            env.push((k.clone(), v.clone()));
        }
    }
    env.push(("PROJECT_TERMINAL_PROJECT_ID".into(), project.id.clone()));
    env.push(("PROJECT_TERMINAL_PROFILE_ID".into(), profile.id.clone()));

    // Environment initialization (Conda/venv/Poetry/uv) arrives in Phase
    // 3.6/3.7. For Phase 3, a non-`none` environment type surfaces a clear
    // error so the frontend does not silently start a session without the
    // requested activation.
    if profile_needs_environment(&profile) {
        return Err(AppError::EnvironmentInitializationFailed(format!(
            "Environment type {:?} is not supported until Phase 3.6/3.7",
            profile.environment_type
        )));
    }

    // Startup commands arrive in Phase 3.5; for Phase 3 we accept the profile
    // but do not yet execute startup_commands.
    Ok(SessionSpawn {
        session_id: session_id.to_string(),
        program,
        args,
        cwd,
        env,
        rows: request.rows.max(1),
        cols: request.cols.max(1),
    })
}

#[tauri::command]
pub fn create_terminal(
    app: State<'_, AppState>,
    terminal: State<'_, TerminalState>,
    on_output: Channel<TerminalOutput>,
    request: CreateTerminalRequest,
) -> AppResult<String> {
    let session_id = new_id("session");
    let spawn = build_session_spawn(&app, &request, &session_id)?;
    let id = terminal.manager.create(spawn, Box::new(on_output))?;
    terminal.remember(&id, &request.project_id, &request.profile_id);
    Ok(id)
}

#[tauri::command]
pub fn write_terminal(
    terminal: State<'_, TerminalState>,
    session_id: String,
    data: String,
) -> AppResult<()> {
    // The frontend sends a UTF-8 string (xterm.js `onData`). We forward the
    // raw bytes into the PTY. We do NOT parse, log, or interpret the input.
    terminal.manager.write(&session_id, data.as_bytes())
}

#[tauri::command]
pub fn resize_terminal(
    terminal: State<'_, TerminalState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> AppResult<()> {
    terminal.manager.resize(&session_id, rows, cols)
}

#[tauri::command]
pub fn close_terminal(terminal: State<'_, TerminalState>, session_id: String) -> AppResult<()> {
    terminal.manager.close(&session_id)?;
    terminal.forget(&session_id);
    Ok(())
}

/// Restart closes the existing session and spawns a fresh one with the same
/// profile. The frontend swaps the channel - we return the new session id.
#[tauri::command]
pub fn restart_terminal(
    app: State<'_, AppState>,
    terminal: State<'_, TerminalState>,
    on_output: Channel<TerminalOutput>,
    session_id: String,
) -> AppResult<String> {
    let (project_id, profile_id) = terminal
        .meta_for(&session_id)
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    // Close the old session first so we kill its shell before starting a new
    // one with the same profile.
    terminal.manager.close(&session_id)?;
    terminal.forget(&session_id);

    let new_id = new_id("session");
    let request = CreateTerminalRequest {
        project_id: project_id.clone(),
        profile_id: profile_id.clone(),
        rows: 24,
        cols: 80,
    };
    let spawn = build_session_spawn(&app, &request, &new_id)?;
    let id = terminal.manager.create(spawn, Box::new(on_output))?;
    terminal.remember(&id, &project_id, &profile_id);
    Ok(id)
}

// keep ListResponse import live for downstream additions.
#[allow(dead_code)]
type _ListResponseMarker<T> = ListResponse<T>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_dirs::ConfigDirs;
    use crate::profile::{
        default_powershell_profile, EnvironmentType, ProfileRepository, ShellType,
    };
    use crate::project::{LocalProjectConfig, Project, ProjectRepository, ProjectType};
    use crate::ssh::SshConnectionRepository;
    use chrono::Utc;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn test_state() -> AppState {
        let root = std::env::temp_dir().join(format!("pt-term-cmd-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let dirs = ConfigDirs::from_root(root.clone());
        AppState {
            dirs: Arc::new(dirs),
            projects: Arc::new(ProjectRepository::new(root.join("projects.json"))),
            profiles: Arc::new(ProfileRepository::new(root.join("profiles.json"))),
            ssh: Arc::new(SshConnectionRepository::new(root.join("ssh.json"))),
        }
    }

    fn seed_project(app: &AppState, id: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pt-term-proj-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
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
        app.projects.upsert(project).unwrap();
        dir
    }

    #[test]
    fn build_session_spawn_resolves_powershell_and_cwd() {
        let app = test_state();
        let dir = seed_project(&app, "p1");
        let mut profile = default_powershell_profile("profile-1".into(), "p1".into());
        // Use explicit executable so the test does not depend on pwsh being
        // installed.
        profile.shell_executable = Some(
            std::env::temp_dir()
                .join("fake-shell.exe")
                .to_string_lossy()
                .into_owned(),
        );
        app.profiles.upsert(profile).unwrap();

        let request = CreateTerminalRequest {
            project_id: "p1".into(),
            profile_id: "profile-1".into(),
            rows: 24,
            cols: 80,
        };
        let spawn = build_session_spawn(&app, &request, "session-1").unwrap();
        assert_eq!(spawn.cwd.as_deref(), Some(dir.to_str().unwrap()));
        assert!(spawn.program.ends_with("fake-shell.exe"));
        assert!(spawn
            .env
            .iter()
            .any(|(k, v)| k == "PROJECT_TERMINAL_PROJECT_ID" && v == "p1"));
    }

    #[test]
    fn build_session_spawn_rejects_profile_from_other_project() {
        let app = test_state();
        seed_project(&app, "p1");
        let profile = default_powershell_profile("profile-1".into(), "p2".into());
        app.profiles.upsert(profile).unwrap();

        let request = CreateTerminalRequest {
            project_id: "p1".into(),
            profile_id: "profile-1".into(),
            rows: 24,
            cols: 80,
        };
        let err = build_session_spawn(&app, &request, "session-1").unwrap_err();
        assert!(matches!(err, AppError::Configuration(_)));
    }

    #[test]
    fn build_session_spawn_rejects_environment_until_phase_3_6() {
        let app = test_state();
        let dir = seed_project(&app, "p1");
        let mut profile = default_powershell_profile("profile-1".into(), "p1".into());
        profile.shell_executable = Some(
            std::env::temp_dir()
                .join("fake-shell.exe")
                .to_string_lossy()
                .into_owned(),
        );
        profile.environment_type = EnvironmentType::Conda;
        app.profiles.upsert(profile).unwrap();

        let request = CreateTerminalRequest {
            project_id: "p1".into(),
            profile_id: "profile-1".into(),
            rows: 24,
            cols: 80,
        };
        let err = build_session_spawn(&app, &request, "session-1").unwrap_err();
        // The session spawn must fail loudly so we never silently start a
        // session without the requested environment.
        assert!(matches!(err, AppError::EnvironmentInitializationFailed(_)));
        let _ = dir;
    }

    #[test]
    fn build_session_spawn_rejects_missing_local_path_directory() {
        let app = test_state();
        // Insert a project whose path does not exist on disk.
        let project = Project {
            id: "p1".into(),
            name: "Demo".into(),
            project_type: ProjectType::Local,
            local: Some(LocalProjectConfig {
                path: "D:\\does\\not\\exist\\here".into(),
            }),
            ssh: None,
            default_profile_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        app.projects.upsert(project).unwrap();
        let mut profile = default_powershell_profile("profile-1".into(), "p1".into());
        profile.shell_executable = Some("fake.exe".into());
        app.profiles.upsert(profile).unwrap();

        let request = CreateTerminalRequest {
            project_id: "p1".into(),
            profile_id: "profile-1".into(),
            rows: 24,
            cols: 80,
        };
        let err = build_session_spawn(&app, &request, "session-1").unwrap_err();
        assert!(matches!(err, AppError::ProjectPathNotFound(_)));
    }

    // Test that the public resolver surfaces an explicit error for custom
    // shells without an executable - covers the "no executable" guard path.
    #[test]
    fn custom_shell_without_executable_surfaces_shell_not_found() {
        use crate::terminal::resolve_local_shell;
        let mut p = default_powershell_profile("p".into(), "proj".into());
        p.shell_type = ShellType::Custom;
        p.shell_executable = None;
        let err = resolve_local_shell(&p).unwrap_err();
        assert!(matches!(err, AppError::ShellNotFound(_)));
    }
}
