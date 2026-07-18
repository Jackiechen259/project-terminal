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
    resolve_local_shell, SessionSpawn, TerminalManager, TerminalOutput,
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
    if project.project_type != crate::project::ProjectType::Local {
        return Err(AppError::Configuration(format!(
            "Terminal creation for non-local projects is not implemented until Phase 6 (got {:?})",
            project.project_type
        )));
    }
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
    env.push((
        "PROJECT_TERMINAL_PROJECT_ID".into(),
        project.id.clone(),
    ));
    env.push((
        "PROJECT_TERMINAL_PROFILE_ID".into(),
        profile.id.clone(),
    ));

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

fn execute_startup_commands(
    app: &AppState,
    terminal: &TerminalState,
    profile_id: &str,
    session_id: &str,
) -> AppResult<()> {
    let profile = app.profiles.get(profile_id)?;
    
    // Phase 3.6/3.7: Environment activation is evaluated and pushed first.
    // Plan §20.8 / §22: if activation generation fails, we MUST retain the
    // shell so the user can manually inspect or fix it.
    match crate::terminal::build_activation_script(&profile) {
        Ok(activation) => {
            if !activation.is_empty() {
                if let Err(e) = terminal.manager.write(session_id, activation.as_bytes()) {
                    let _ = terminal.manager.close(session_id);
                    return Err(e);
                }
            }
        }
        Err(e) => {
            // Write a shell-safe echo command so the error displays visibly
            // but is not parsed as a malformed bare text command by the shell.
            let err_msg = format!("Environment activation failed: {e}");
            let display_cmd = match profile.shell_type {
                crate::profile::ShellType::Powershell => {
                    let escaped = crate::terminal::escaping::escape_powershell_argument(&err_msg);
                    format!("Write-Host -ForegroundColor Red {escaped}\r\n")
                }
                crate::profile::ShellType::Cmd => {
                    let escaped = crate::terminal::escaping::escape_cmd_argument(&err_msg);
                    format!("echo {escaped}\r\n")
                }
                _ => {
                    let escaped = crate::terminal::escaping::escape_bash_argument(&err_msg);
                    format!("echo {escaped}\r\n")
                }
            };
            let _ = terminal.manager.write(session_id, display_cmd.as_bytes());
        }
    }

    // Per plan §22 (Wait until interactive shell is available): portable-pty
    // buffers writes until the shell reads them. A true prompt-sync handshake
    // (waiting for the shell's PS1 or native ready marker) is a complex
    // feature that we defer out of MVP scope. We write the commands to the PTY
    // immediately, which works for fast-starting shells but races heavy
    // initializations.
    for cmd in &profile.startup_commands {
        let mut line = String::new();
        line.push_str(cmd);
        line.push_str("\r\n");
        if let Err(e) = terminal.manager.write(session_id, line.as_bytes()) {
            let _ = terminal.manager.close(session_id);
            return Err(e);
        }
    }
    Ok(())
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

    if let Err(e) = execute_startup_commands(&app, &terminal, &request.profile_id, &id) {
        return Err(e);
    }

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
pub fn close_terminal(
    terminal: State<'_, TerminalState>,
    session_id: String,
) -> AppResult<()> {
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

    if let Err(e) = execute_startup_commands(&app, &terminal, &profile_id, &id) {
        return Err(e);
    }

    terminal.remember(&id, &project_id, &profile_id);
    Ok(id)
}

#[tauri::command]
pub fn detect_conda_installations() -> Vec<String> {
    crate::terminal::conda::detect_conda_installations()
}

#[tauri::command]
pub fn list_conda_environments(conda_executable: String) -> AppResult<Vec<crate::terminal::conda::DetectedCondaEnvironment>> {
    crate::terminal::conda::list_conda_environments(&conda_executable)
}

// keep ListResponse import live for downstream additions.
#[allow(dead_code)]
type _ListResponseMarker<T> = ListResponse<T>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_dirs::ConfigDirs;
    use crate::profile::{default_powershell_profile, EnvironmentType, ProfileRepository, ShellType};
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

    #[test]
    fn build_session_spawn_rejects_ssh_projects() {
        let app = test_state();
        let project = Project {
            id: "p1".into(),
            name: "Remote".into(),
            project_type: ProjectType::Ssh,
            local: None,
            ssh: Some(crate::project::SshProjectConfig {
                connection_id: "conn-1".into(),
                remote_path: "/srv".into(),
            }),
            default_profile_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        app.projects.upsert(project).unwrap();

        let request = CreateTerminalRequest {
            project_id: "p1".into(),
            profile_id: "profile-1".into(),
            rows: 24,
            cols: 80,
        };
        let err = build_session_spawn(&app, &request, "session-1").unwrap_err();
        assert!(matches!(
            err,
            AppError::Configuration(msg) if msg.contains("non-local")
        ));
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

    #[test]
    fn create_terminal_retains_shell_on_activation_error() {
        use std::sync::mpsc;
        let app = test_state();
        let dir = seed_project(&app, "p1");

        let mut profile = default_powershell_profile("profile-1".into(), "p1".into());
        profile.shell_type = ShellType::Cmd;
        profile.shell_executable = Some("cmd.exe".into());
        profile.shell_args = vec!["/Q".into()];
        // Intentionally misconfigure conda to cause an activation script error
        profile.environment_type = EnvironmentType::Conda;
        profile.conda = Some(crate::profile::CondaEnvironmentConfig {
            conda_executable: None,
            conda_root: None,
            environment_name: Some("test-env".into()),
            environment_path: None,
            activation_mode: crate::profile::CondaActivationMode::CondaBat,
            auto_activate: true,
        }); // CondaBat requires conda_root
        app.profiles.upsert(profile).unwrap();

        let request = CreateTerminalRequest {
            project_id: "p1".into(),
            profile_id: "profile-1".into(),
            rows: 24,
            cols: 80,
        };

        let terminal = TerminalState::new();
        let session_id = "test-session";
        let spawn = build_session_spawn(&app, &request, session_id).unwrap();

        struct MpscSink(mpsc::Sender<TerminalOutput>);
        impl crate::terminal::session::OutputSink for MpscSink {
            fn send_output(&self, output: TerminalOutput) -> bool {
                self.0.send(output).is_ok()
            }
        }
        let (tx, rx) = mpsc::channel();
        let id = terminal.manager.create(spawn, Box::new(MpscSink(tx))).unwrap();

        // The helper should write the error into the shell and NOT return an
        // error, keeping the session alive.
        execute_startup_commands(&app, &terminal, &request.profile_id, &id).unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let mut out = Vec::new();
        use base64::Engine;
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(std::time::Duration::from_millis(50)) {
                Ok(chunk) => {
                    let bytes =
                        base64::engine::general_purpose::STANDARD.decode(chunk.data).unwrap();
                    out.extend_from_slice(&bytes);
                    if out.windows(27).any(|w| w == b"Environment activation failed") {
                        break; 
                    }
                }
                Err(_) => {}
            }
        }
        terminal.manager.close_all();
        
        let output_str = String::from_utf8_lossy(&out);
        assert!(output_str.contains("Environment activation failed"), "Got: {:?}", output_str);
        let _ = dir;
    }

    #[test]
    fn execute_startup_commands_sends_to_pty() {
        use std::sync::mpsc;
        let app = test_state();
        let dir = seed_project(&app, "p1");

        let mut profile = default_powershell_profile("profile-1".into(), "p1".into());
        // Use cmd.exe with /Q to minimize prompt noise and verify the echo.
        profile.shell_type = ShellType::Cmd;
        profile.shell_executable = Some("cmd.exe".into());
        profile.shell_args = vec!["/Q".into()];
        profile.startup_commands = vec!["echo PT_STARTUP_OK".into()];
        app.profiles.upsert(profile).unwrap();

        let request = CreateTerminalRequest {
            project_id: "p1".into(),
            profile_id: "profile-1".into(),
            rows: 24,
            cols: 80,
        };

        let terminal = TerminalState::new();

        // We bypass the public create_terminal wrapper (which requires Channel)
        // and drive the internal pieces directly to observe the startup commands.
        let session_id = "test-session";
        let spawn = build_session_spawn(&app, &request, session_id).unwrap();

        struct MpscSink(mpsc::Sender<TerminalOutput>);
        impl crate::terminal::session::OutputSink for MpscSink {
            fn send_output(&self, output: TerminalOutput) -> bool {
                self.0.send(output).is_ok()
            }
        }
        let (tx, rx) = mpsc::channel();
        let id = terminal
            .manager
            .create(spawn, Box::new(MpscSink(tx)))
            .unwrap();

        // Execute startup commands manually (replicating the wrapper).
        execute_startup_commands(&app, &terminal, &request.profile_id, &id).unwrap();

        // Read until we see our marker or time out.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let mut out = Vec::new();
        use base64::Engine;
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(std::time::Duration::from_millis(50)) {
                Ok(chunk) => {
                    let bytes =
                        base64::engine::general_purpose::STANDARD.decode(chunk.data).unwrap();
                    out.extend_from_slice(&bytes);
                    if out.windows(14).any(|w| w == b"PT_STARTUP_OK\r") {
                        break;
                    }
                }
                Err(_) => {}
            }
        }

        terminal.manager.close_all();

        let output_str = String::from_utf8_lossy(&out);
        assert!(
            output_str.contains("PT_STARTUP_OK"),
            "expected startup command output, got: {:?}",
            output_str
        );
        let _ = dir;
    }
}
