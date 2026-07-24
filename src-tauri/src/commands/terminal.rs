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
    resolve_local_shell, SessionInfo, SessionSpawn, TerminalManager, TerminalOutput,
};

use super::ListResponse;

const MIN_PARALLEL_TERMINAL_LAUNCHES: usize = 2;
const MAX_PARALLEL_TERMINAL_LAUNCHES: usize = 4;

fn default_terminal_launch_parallelism() -> usize {
    std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(MIN_PARALLEL_TERMINAL_LAUNCHES)
        .clamp(
            MIN_PARALLEL_TERMINAL_LAUNCHES,
            MAX_PARALLEL_TERMINAL_LAUNCHES,
        )
}

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
    #[serde(default)]
    pub scrollback_megabytes: Option<u8>,
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
    launch_gate: std::sync::Arc<tokio::sync::Semaphore>,
}

impl Default for TerminalState {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalState {
    pub fn new() -> Self {
        Self::with_launch_parallelism(default_terminal_launch_parallelism())
    }

    fn with_launch_parallelism(parallelism: usize) -> Self {
        debug_assert!(parallelism > 0);
        Self {
            manager: TerminalManager::new(),
            meta: parking_lot::Mutex::new(std::collections::HashMap::new()),
            launch_gate: std::sync::Arc::new(tokio::sync::Semaphore::new(parallelism.max(1))),
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
pub(crate) fn build_session_spawn(
    app: &AppState,
    request: &CreateTerminalRequest,
    session_id: &str,
) -> AppResult<(
    SessionSpawn,
    crate::project::ProjectType,
    crate::profile::TerminalProfile,
)> {
    let project = app.projects.get(&request.project_id)?;
    let profile = app.profiles.get(&request.profile_id)?;
    if profile.project_id != project.id {
        return Err(AppError::Configuration(format!(
            "Profile {} does not belong to project {}",
            profile.id, project.id
        )));
    }

    let (program, args, cwd) = match project.project_type {
        crate::project::ProjectType::Local => {
            let (program, args) = resolve_local_shell(&profile)?;
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
            (program, args, cwd)
        }
        crate::project::ProjectType::Wsl => {
            let wsl_project = project.wsl.as_ref().ok_or_else(|| {
                AppError::Configuration("WSL project is missing its wsl configuration".into())
            })?;
            // The project's distribution + working directory are the source of
            // truth; the default WSL profile we seed on project creation copies
            // them, but a user-edited profile may override either field. Fall
            // back to the project's values when the profile leaves them blank.
            let mut profile_with_wsl = profile.clone();
            if profile_with_wsl
                .wsl_distribution
                .as_deref()
                .map(str::trim)
                .map(str::is_empty)
                .unwrap_or(true)
            {
                profile_with_wsl.wsl_distribution = Some(wsl_project.distribution.clone());
            }
            if profile_with_wsl
                .wsl_working_directory
                .as_deref()
                .map(str::trim)
                .map(str::is_empty)
                .unwrap_or(true)
            {
                profile_with_wsl.wsl_working_directory = wsl_project
                    .working_directory
                    .clone()
                    .filter(|wd| !wd.trim().is_empty());
            }
            let (program, args) = resolve_local_shell(&profile_with_wsl)?;
            // Do NOT set a Windows cwd: the `--cd` argument already directs the
            // WSL shell to the right Linux path, and a Windows cwd would be
            // translated to a `/mnt/c/...` path inside WSL before `--cd` runs.
            (program, args, None)
        }
        crate::project::ProjectType::Ssh => {
            let ssh_project = project.ssh.as_ref().ok_or_else(|| {
                AppError::Configuration("SSH project is missing SSH configuration".into())
            })?;
            let connection = app.ssh.get(&ssh_project.connection_id)?;
            let client = crate::ssh::detect_ssh_client().ok_or(AppError::SshClientNotFound)?;
            let remote_command = remote_start_command(&profile, &ssh_project.remote_path)?;
            let command =
                crate::ssh::build_ssh_argv_with_remote_command(&connection, remote_command);
            (
                client.executable.to_string_lossy().into_owned(),
                command.args,
                None,
            )
        }
    };

    // Env vars from the profile, plus internal markers.
    let mut env: Vec<(String, String)> = Vec::new();
    if project.project_type == crate::project::ProjectType::Local {
        if let Some(vars) = &profile.environment_variables {
            for (k, v) in vars {
                env.push((k.clone(), v.clone()));
            }
        }
    }
    env.push(("PROJECT_TERMINAL_PROJECT_ID".into(), project.id.clone()));
    env.push(("PROJECT_TERMINAL_PROFILE_ID".into(), profile.id.clone()));
    env.push((
        "PROJECT_TERMINAL_READY".into(),
        format!("__PROJECT_TERMINAL_READY_{session_id}__"),
    ));

    let project_type = project.project_type;
    Ok((
        SessionSpawn {
            session_id: session_id.to_string(),
            project_id: project.id.clone(),
            profile_id: profile.id.clone(),
            program,
            args,
            cwd,
            env,
            // `wsl.exe` does not reliably round-trip an injected readiness
            // command through every Windows PTY implementation. Let WSL
            // stream its prompt directly instead of hiding all output while
            // waiting for a marker that may never arrive.
            readiness_marker: (project.project_type == crate::project::ProjectType::Local)
                .then(|| format!("__PROJECT_TERMINAL_READY_{session_id}__")),
            rows: request.rows.max(1),
            cols: request.cols.max(1),
            scrollback_bytes: usize::from(request.scrollback_megabytes.unwrap_or(4).clamp(1, 32))
                * 1024
                * 1024,
        },
        project_type,
        profile,
    ))
}

/// Escape a remote working-directory path for use inside `cd --`, preserving
/// a leading tilde unquoted so the remote shell expands it.
///
/// Returns `None` when the path is empty or `~`: SSH sessions already start
/// in `$HOME`, so no `cd` is needed. For `~/sub`, `~user/sub`, and bare
/// `~user`, the tilde prefix and the following slash are kept unquoted so
/// POSIX tilde expansion fires; only the remainder is POSIX-escaped.
fn escape_remote_cd_path(remote_path: &str) -> Option<String> {
    use crate::terminal::escaping::escape_remote_posix_argument;
    let trimmed = remote_path.trim();
    if trimmed.is_empty() || trimmed == "~" {
        return None;
    }
    if !trimmed.starts_with('~') {
        return Some(escape_remote_posix_argument(trimmed));
    }
    let after_tilde = &trimmed[1..];
    if after_tilde.is_empty() {
        return None; // bare "~", already handled above
    }
    // ~/rest — keep the slash unquoted so tilde expansion fires.
    if let Some(rest) = after_tilde.strip_prefix('/') {
        return Some(format!("~/{}", escape_remote_posix_argument(rest)));
    }
    // ~user or ~user/rest — split at the first slash.
    match after_tilde.find('/') {
        Some(slash_pos) => {
            let user = &after_tilde[..slash_pos];
            let rest = &after_tilde[slash_pos + 1..];
            Some(format!("~{}/{}", user, escape_remote_posix_argument(rest)))
        }
        None => {
            // ~user without a trailing slash. Usernames consist of safe
            // characters; the whole token is the tilde-expansion target.
            Some(trimmed.to_string())
        }
    }
}

/// Prepare the remote working directory inside the OpenSSH remote command.
/// The command is constructed only from saved profile/project fields and each
/// path is POSIX-escaped before it is interpreted by the remote shell.
fn remote_start_command(
    profile: &crate::profile::TerminalProfile,
    remote_path: &str,
) -> AppResult<Option<String>> {
    use crate::profile::ShellType;

    let cd_path = escape_remote_cd_path(remote_path);
    let initialization = crate::terminal::build_remote_initialization_commands(profile)?;
    let (shell, final_shell) = match profile.shell_type {
        ShellType::RemoteDefault => ("sh", "\"${SHELL:-sh}\" -l".to_string()),
        ShellType::RemoteBash => ("bash", "bash -l".to_string()),
        ShellType::RemoteZsh => ("zsh", "zsh -l".to_string()),
        ShellType::RemoteFish => ("fish", "fish -l".to_string()),
        ShellType::Custom => {
            let command = profile
                .remote_shell_command
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    AppError::Configuration(
                        "Custom remote shell requires remoteShellCommand".into(),
                    )
                })?;
            ("sh", command.to_string())
        }
        local => {
            return Err(AppError::Configuration(format!(
                "SSH project requires a remote shell profile, got {local:?}"
            )))
        }
    };
    let separator = if shell == "fish" { "; and " } else { "; " };
    let mut parts: Vec<String> = Vec::new();
    if let Some(path) = cd_path {
        parts.push(format!("cd -- {path}"));
    }
    parts.extend(initialization);
    parts.push(format!("exec {final_shell}"));
    let script = parts.join(separator);

    Ok(Some(format!(
        "{shell} -{} {}",
        if shell == "fish" { "ic" } else { "lc" },
        crate::terminal::escaping::escape_remote_posix_argument(&script)
    )))
}

fn wait_for_interactive_shell(
    manager: &TerminalManager,
    profile: &crate::profile::TerminalProfile,
    session_id: &str,
) -> AppResult<()> {
    let marker = format!("__PROJECT_TERMINAL_READY_{session_id}__");
    let command = match profile.shell_type {
        // Keep this command short. A long, generated command makes
        // PSReadLine repaint wrapped fragments into the terminal before the
        // handshake can filter them.
        crate::profile::ShellType::Powershell => {
            // Clear the bootstrap prompt after the marker is emitted. Some
            // PSReadLine versions paint that prompt before the PTY watcher is
            // armed; clearing here guarantees a new terminal opens with only
            // the final interactive prompt.
            shell_command_line(
                profile.shell_type,
                "echo \"[$env:PROJECT_TERMINAL_READY]\"; Clear-Host",
            )
        }
        crate::profile::ShellType::Cmd => {
            let encoded_marker = marker
                .chars()
                .map(|character| format!("^{character}"))
                .collect::<String>();
            format!("echo [{encoded_marker}]\r\n")
        }
        crate::profile::ShellType::GitBash
        | crate::profile::ShellType::Wsl
        | crate::profile::ShellType::Bash
        | crate::profile::ShellType::Zsh
        | crate::profile::ShellType::Fish
        | crate::profile::ShellType::Sh => {
            let encoded_marker = marker
                .bytes()
                .map(|byte| format!("\\x{byte:02x}"))
                .collect::<String>();
            format!("printf '[{encoded_marker}]\\n'\r\n")
        }
        // A custom executable has no declared command language. `echo` is
        // the conventional lowest-common-denominator probe; unlike known
        // shells, its command echo may remain visible.
        crate::profile::ShellType::Custom => format!("echo [{marker}]\r\n"),
        _ => {
            return Err(AppError::Configuration(format!(
                "Interactive-shell readiness is not supported for {:?}",
                profile.shell_type
            )))
        }
    };

    manager.wait_for_ready(
        session_id,
        &marker,
        &command,
        std::time::Duration::from_secs(10),
    )
    .map_err(|error| {
        if profile.shell_type != crate::profile::ShellType::Wsl {
            return error;
        }

        let AppError::EnvironmentInitializationFailed(message) = error else {
            return error;
        };

        let distribution = profile
            .wsl_distribution
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("<not configured>");
        let directory = profile
            .wsl_working_directory
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("<WSL home directory>");
        AppError::EnvironmentInitializationFailed(format!(
            "{message}. WSL distribution: `{distribution}`; working directory: `{directory}`. \
             Verify them with `wsl -d \"{distribution}\"` and use a Linux path such as `/home/user/project`."
        ))
    })
}

fn shell_command_line(shell_type: crate::profile::ShellType, command: &str) -> String {
    // Interactive PowerShell/PSReadLine treats CR as Enter and the following
    // LF as a separate AddLine input, which leaves the terminal at a `>>`
    // continuation prompt. Other supported shells accept the conventional
    // CRLF pair used by the existing protocol.
    let terminator = if shell_type == crate::profile::ShellType::Powershell {
        "\r"
    } else {
        "\r\n"
    };
    format!("{command}{terminator}")
}

fn normalize_initialization_script(shell_type: crate::profile::ShellType, script: &str) -> String {
    if shell_type != crate::profile::ShellType::Powershell {
        return script.to_string();
    }

    script.replace("\r\n", "\r").replace('\n', "\r")
}

fn execute_startup_commands(
    manager: &TerminalManager,
    profile: &crate::profile::TerminalProfile,
    session_id: &str,
) -> AppResult<()> {
    // Phase 3.6/3.7: Environment activation is evaluated and pushed first.
    // Plan §20.8 / §22: if activation generation fails, we MUST retain the
    // shell so the user can manually inspect or fix it.
    match crate::terminal::build_activation_script(profile) {
        Ok(activation) => {
            if !activation.is_empty() {
                let activation = normalize_initialization_script(profile.shell_type, &activation);
                if let Err(e) = manager.write(session_id, activation.as_bytes()) {
                    let _ = manager.close(session_id);
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
                    shell_command_line(
                        profile.shell_type,
                        &format!("Write-Host -ForegroundColor Red {escaped}"),
                    )
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
            let _ = manager.write(session_id, display_cmd.as_bytes());
        }
    }

    // Per plan §22 (Wait until interactive shell is available): portable-pty
    // buffers writes until the shell reads them. A true prompt-sync handshake
    // (waiting for the shell's PS1 or native ready marker) is a complex
    // feature that we defer out of MVP scope. We write the commands to the PTY
    // immediately, which works for fast-starting shells but races heavy
    // initializations.
    for cmd in &profile.startup_commands {
        let line = shell_command_line(profile.shell_type, cmd);
        if let Err(e) = manager.write(session_id, line.as_bytes()) {
            let _ = manager.close(session_id);
            return Err(e);
        }
    }
    Ok(())
}

/// Create and initialize a terminal on a blocking worker.
///
/// PTY allocation, process creation and the readiness handshake all block.
/// Keeping them together here prevents synchronous Tauri commands from
/// stalling the WebView event loop when several tabs are opened quickly.
fn launch_terminal(
    manager: &TerminalManager,
    spawn: SessionSpawn,
    project_type: crate::project::ProjectType,
    profile: &crate::profile::TerminalProfile,
) -> AppResult<String> {
    let id = manager.create(spawn)?;

    let initialization = match project_type {
        crate::project::ProjectType::Ssh => {
            // Authentication and first host-key confirmation are intentionally
            // handled inside the PTY by OpenSSH. Never inject input while those
            // prompts may be active.
            Ok(())
        }
        crate::project::ProjectType::Wsl => {
            // See `readiness_marker` above. The PTY buffers these writes until
            // the Linux shell accepts input, while leaving the prompt visible.
            execute_startup_commands(manager, profile, &id)
        }
        crate::project::ProjectType::Local => wait_for_interactive_shell(manager, profile, &id)
            .and_then(|()| execute_startup_commands(manager, profile, &id)),
    };

    if let Err(error) = initialization {
        let _ = manager.close(&id);
        return Err(error);
    }

    manager.mark_running(&id)?;
    Ok(id)
}

/// Run one terminal launch on Tokio's blocking worker pool.
///
/// The owned permit moves into the worker so cancellation of the frontend
/// invocation cannot release a slot while its PTY is still being initialized.
/// This provides real parallel startup while keeping rapid bursts bounded.
async fn run_terminal_launch<T, F>(terminal: &TerminalState, task: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    let permit = terminal
        .launch_gate
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| AppError::ShellStartFailed("Terminal launch queue closed".into()))?;

    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        task()
    })
    .await
    .map_err(|error| {
        AppError::ShellStartFailed(format!("Terminal launch worker failed: {error}"))
    })?
}

#[tauri::command]
pub async fn create_terminal(
    app: State<'_, AppState>,
    terminal: State<'_, TerminalState>,
    request: CreateTerminalRequest,
) -> AppResult<String> {
    create_terminal_inner(&app, &terminal, request).await
}

pub async fn create_terminal_inner(
    app: &AppState,
    terminal: &TerminalState,
    request: CreateTerminalRequest,
) -> AppResult<String> {
    let session_id = new_id("session");
    // Load the project and profile once for the whole launch. Previously the
    // same JSON files were read and parsed again for project-type detection,
    // readiness and startup-command injection.
    let (spawn, project_type, profile) = build_session_spawn(&app, &request, &session_id)?;
    let manager = terminal.manager.clone_handle();
    let id = run_terminal_launch(&terminal, move || {
        launch_terminal(&manager, spawn, project_type, &profile)
    })
    .await?;

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
pub async fn restart_terminal(
    app: State<'_, AppState>,
    terminal: State<'_, TerminalState>,
    session_id: String,
) -> AppResult<String> {
    restart_terminal_inner(&app, &terminal, &session_id).await
}

pub async fn restart_terminal_inner(
    app: &AppState,
    terminal: &TerminalState,
    session_id: &str,
) -> AppResult<String> {
    let (project_id, profile_id) = terminal
        .meta_for(session_id)
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    // Close the old session first so we kill its shell before starting a new
    // one with the same profile.
    terminal.manager.close(session_id)?;
    terminal.forget(session_id);

    let new_id = new_id("session");
    let request = CreateTerminalRequest {
        project_id: project_id.clone(),
        profile_id: profile_id.clone(),
        rows: 24,
        cols: 80,
        scrollback_megabytes: Some(4),
    };
    let (spawn, project_type, profile) = build_session_spawn(&app, &request, &new_id)?;
    let manager = terminal.manager.clone_handle();
    let id = run_terminal_launch(&terminal, move || {
        launch_terminal(&manager, spawn, project_type, &profile)
    })
    .await?;

    terminal.remember(&id, &project_id, &profile_id);
    Ok(id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAttachment {
    pub session: SessionInfo,
    /// Base64-encoded raw PTY bytes captured before the live subscription.
    pub scrollback: String,
    pub truncated: bool,
}

/// Attach one frontend client to an existing PTY without changing its
/// lifecycle. Scrollback is returned in the command response and later output
/// is delivered through the bounded broadcast receiver.
#[tauri::command]
pub fn session_attach(
    terminal: State<'_, TerminalState>,
    session_id: String,
    client_id: String,
    on_output: Channel<TerminalOutput>,
) -> AppResult<SessionAttachment> {
    use base64::Engine;
    use tokio::sync::broadcast::error::RecvError;

    let (info, subscription) = terminal.manager.attach(&session_id, client_id.clone())?;
    let scrollback = base64::engine::general_purpose::STANDARD.encode(subscription.snapshot.bytes);
    let attachment = SessionAttachment {
        session: info,
        scrollback,
        truncated: subscription.snapshot.truncated,
    };

    let manager = terminal.manager.clone_handle();
    tauri::async_runtime::spawn(async move {
        let mut receiver = subscription.receiver;
        let mut cancellation = subscription.cancellation;
        loop {
            tokio::select! {
                changed = cancellation.changed() => {
                    if changed.is_err() || *cancellation.borrow() {
                        break;
                    }
                }
                event = receiver.recv() => {
                    match event {
                        Ok(event) => {
                            if on_output.send(event).is_err() {
                                break;
                            }
                        }
                        Err(RecvError::Lagged(_)) => {
                            // The PTY reader and other clients must keep
                            // flowing. This client can detach/attach again to
                            // obtain the latest bounded scrollback snapshot.
                            continue;
                        }
                        Err(RecvError::Closed) => break,
                    }
                }
            }
        }
        let _ = manager.detach(&session_id, &client_id);
    });

    Ok(attachment)
}

#[tauri::command]
pub fn session_detach(
    terminal: State<'_, TerminalState>,
    session_id: String,
    client_id: String,
) -> AppResult<()> {
    terminal.manager.detach(&session_id, &client_id)
}

#[tauri::command]
pub fn session_list(terminal: State<'_, TerminalState>) -> ListResponse<SessionInfo> {
    ListResponse::new(terminal.manager.list())
}

#[tauri::command]
pub fn session_get(
    terminal: State<'_, TerminalState>,
    session_id: String,
) -> AppResult<SessionInfo> {
    terminal.manager.info(&session_id)
}

#[tauri::command]
pub fn detect_conda_installations() -> Vec<String> {
    crate::terminal::conda::detect_conda_installations()
}

#[tauri::command]
pub fn detect_wsl_distributions() -> Vec<crate::terminal::DetectedWslDistribution> {
    crate::terminal::detect_wsl_distributions()
}

#[tauri::command]
pub fn list_conda_environments(
    conda_executable: String,
) -> AppResult<Vec<crate::terminal::conda::DetectedCondaEnvironment>> {
    crate::terminal::conda::list_conda_environments(&conda_executable)
}

// keep ListResponse import live for downstream additions.
#[allow(dead_code)]
type _ListResponseMarker<T> = ListResponse<T>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::repository::default_powershell_profile;
    use crate::profile::{
        default_wsl_profile, EnvironmentType, ProfileRepository, ShellType, TemplateRepository,
    };
    use crate::project::{
        LocalProjectConfig, Project, ProjectRepository, ProjectType, WslProjectConfig,
    };
    use crate::ssh::SshConnectionRepository;
    use chrono::Utc;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn terminal_launch_parallelism_tracks_cpu_with_safe_bounds() {
        let parallelism = default_terminal_launch_parallelism();
        assert!(parallelism >= MIN_PARALLEL_TERMINAL_LAUNCHES);
        assert!(parallelism <= MAX_PARALLEL_TERMINAL_LAUNCHES);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn terminal_launch_workers_run_in_parallel_and_bound_bursts() {
        let terminal = TerminalState::with_launch_parallelism(2);
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));

        let task = || {
            let active = active.clone();
            let peak = peak.clone();
            move || {
                let now_active = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now_active, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(100));
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(())
            }
        };

        let (first, second, third) = tokio::join!(
            run_terminal_launch(&terminal, task()),
            run_terminal_launch(&terminal, task()),
            run_terminal_launch(&terminal, task()),
        );
        first.unwrap();
        second.unwrap();
        third.unwrap();

        assert_eq!(peak.load(Ordering::SeqCst), 2);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn powershell_injected_input_uses_a_single_carriage_return() {
        assert_eq!(
            shell_command_line(ShellType::Powershell, "echo ready"),
            "echo ready\r"
        );
        assert_eq!(
            shell_command_line(ShellType::Cmd, "echo ready"),
            "echo ready\r\n"
        );
        assert_eq!(
            normalize_initialization_script(ShellType::Powershell, "first\r\nsecond\r\n"),
            "first\rsecond\r"
        );
    }

    fn test_state() -> AppState {
        let root = std::env::temp_dir().join(format!("pt-term-cmd-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        AppState::from_repositories(
            ProjectRepository::new(root.join("projects.json")),
            ProfileRepository::new(root.join("profiles.json")),
            TemplateRepository::new(root.join("templates.json")),
            SshConnectionRepository::new(root.join("ssh.json")),
        )
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
            wsl: None,
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
            scrollback_megabytes: None,
        };
        let (spawn, _, _) = build_session_spawn(&app, &request, "session-1").unwrap();
        assert_eq!(spawn.cwd.as_deref(), Some(dir.to_str().unwrap()));
        assert!(spawn.program.ends_with("fake-shell.exe"));
        assert!(spawn
            .env
            .iter()
            .any(|(k, v)| k == "PROJECT_TERMINAL_PROJECT_ID" && v == "p1"));
        assert!(spawn.env.iter().any(|(k, v)| {
            k == "PROJECT_TERMINAL_READY" && v == "__PROJECT_TERMINAL_READY_session-1__"
        }));
    }

    #[test]
    fn build_session_spawn_clamps_scrollback_memory() {
        let app = test_state();
        let _dir = seed_project(&app, "p1");
        let mut profile = default_powershell_profile("profile-1".into(), "p1".into());
        profile.shell_executable = Some("cmd.exe".into());
        app.profiles.upsert(profile).unwrap();
        let request = CreateTerminalRequest {
            project_id: "p1".into(),
            profile_id: "profile-1".into(),
            rows: 24,
            cols: 80,
            scrollback_megabytes: Some(255),
        };

        let (spawn, _, _) = build_session_spawn(&app, &request, "session-1").unwrap();

        assert_eq!(spawn.scrollback_bytes, 32 * 1024 * 1024);
    }

    #[test]
    fn build_session_spawn_does_not_wait_for_a_wsl_readiness_marker() {
        let app = test_state();
        let project = Project {
            id: "wsl-project".into(),
            name: "Ubuntu".into(),
            project_type: ProjectType::Wsl,
            local: None,
            ssh: None,
            wsl: Some(WslProjectConfig {
                distribution: "Ubuntu".into(),
                working_directory: None,
            }),
            default_profile_id: Some("wsl-profile".into()),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        app.projects.upsert(project).unwrap();
        app.profiles
            .upsert(default_wsl_profile(
                "wsl-profile".into(),
                "wsl-project".into(),
                "Ubuntu".into(),
                None,
            ))
            .unwrap();

        let request = CreateTerminalRequest {
            project_id: "wsl-project".into(),
            profile_id: "wsl-profile".into(),
            rows: 24,
            cols: 80,
            scrollback_megabytes: None,
        };
        let (spawn, project_type, _) = build_session_spawn(&app, &request, "session-1").unwrap();

        assert_eq!(project_type, ProjectType::Wsl);
        assert_eq!(spawn.program, "wsl.exe");
        assert!(spawn.readiness_marker.is_none());
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
            scrollback_megabytes: None,
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
            wsl: None,
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
            scrollback_megabytes: None,
        };
        let err = build_session_spawn(&app, &request, "session-1").unwrap_err();
        assert!(matches!(err, AppError::ProjectPathNotFound(_)));
    }

    #[test]
    fn remote_start_command_enters_posix_remote_path_safely() {
        let mut profile = default_powershell_profile("profile-1".into(), "p1".into());
        profile.shell_type = ShellType::RemoteBash;
        let command = remote_start_command(&profile, "/srv/my project's").unwrap();
        let command = command.unwrap();
        assert!(command.starts_with("bash -lc "));
        assert!(command.contains("cd --"));
        assert!(command.contains("exec bash -l"));
        // The apostrophe is safely represented as the POSIX quote boundary,
        // not passed through as an unquoted shell character.
        assert!(command.contains("'\"'\"'"));
    }

    #[test]
    fn escape_remote_cd_path_skips_home_and_empty() {
        assert_eq!(escape_remote_cd_path("~"), None);
        assert_eq!(escape_remote_cd_path(""), None);
        assert_eq!(escape_remote_cd_path("  "), None);
        assert_eq!(escape_remote_cd_path(" ~ "), None);
    }

    #[test]
    fn escape_remote_cd_path_preserves_tilde_unquoted() {
        // ~/subpath — tilde and slash unquoted so the shell expands ~.
        assert_eq!(
            escape_remote_cd_path("~/projects"),
            Some("~/projects".into())
        );
        assert_eq!(
            escape_remote_cd_path("~/my project"),
            Some("~/'my project'".into())
        );
        // ~user/subpath — username and slash unquoted.
        assert_eq!(
            escape_remote_cd_path("~deploy/app"),
            Some("~deploy/app".into())
        );
        assert_eq!(
            escape_remote_cd_path("~deploy/my app"),
            Some("~deploy/'my app'".into())
        );
        // Bare ~user.
        assert_eq!(escape_remote_cd_path("~deploy"), Some("~deploy".into()));
        // Normal absolute path — fully escaped as before.
        assert_eq!(escape_remote_cd_path("/srv/app"), Some("/srv/app".into()));
        assert_eq!(
            escape_remote_cd_path("/srv/my app"),
            Some("'/srv/my app'".into())
        );
    }

    #[test]
    fn remote_start_command_skips_cd_for_tilde() {
        let mut profile = default_powershell_profile("profile-1".into(), "p1".into());
        profile.shell_type = ShellType::RemoteBash;
        // "~" means $HOME, where SSH already starts — no cd needed.
        let command = remote_start_command(&profile, "~").unwrap().unwrap();
        assert!(command.starts_with("bash -lc "));
        assert!(!command.contains("cd --"));
        assert!(command.contains("exec bash -l"));
    }

    #[test]
    fn remote_start_command_keeps_tilde_unquoted_in_cd() {
        let mut profile = default_powershell_profile("profile-1".into(), "p1".into());
        profile.shell_type = ShellType::RemoteBash;
        let command = remote_start_command(&profile, "~/projects/app")
            .unwrap()
            .unwrap();
        assert!(command.starts_with("bash -lc "));
        // The tilde must be unquoted for shell expansion.
        assert!(command.contains("cd -- ~/projects/app"));
        // The tilde must NOT be single-quoted (which caused the original bug
        // where `cd -- '~'` failed with "can't cd to ~").
        assert!(!command.contains("'~"));
    }

    #[test]
    fn ssh_rejects_a_local_shell_profile() {
        let profile = default_powershell_profile("profile-1".into(), "p1".into());
        assert!(remote_start_command(&profile, "/srv").is_err());
    }

    #[test]
    fn remote_start_command_runs_environment_before_startup_and_shell() {
        let mut profile = default_powershell_profile("profile-1".into(), "p1".into());
        profile.shell_type = ShellType::RemoteBash;
        profile.environment_type = EnvironmentType::Venv;
        profile.environment_path = Some(".venv".into());
        profile.startup_commands = vec!["python --version".into()];
        let command = remote_start_command(&profile, "/srv").unwrap().unwrap();
        let activate = command.find(".venv/bin/activate").unwrap();
        let startup = command.find("python --version").unwrap();
        let shell = command.find("exec bash -l").unwrap();
        assert!(activate < startup && startup < shell);
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
            scrollback_megabytes: None,
        };

        let terminal = TerminalState::new();
        let session_id = "test-session";
        let (mut spawn, _, profile) = build_session_spawn(&app, &request, session_id).unwrap();
        // This test exercises activation-error injection directly rather than
        // the readiness handshake used by the public create command.
        spawn.readiness_marker = None;

        let id = terminal.manager.create(spawn).unwrap();
        let (_, subscription) = terminal
            .manager
            .attach(&id, "activation-test".into())
            .unwrap();
        let mut rx = subscription.receiver;

        // The helper should write the error into the shell and NOT return an
        // error, keeping the session alive.
        execute_startup_commands(&terminal.manager, &profile, &id).unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let mut out = Vec::new();
        use base64::Engine;
        while std::time::Instant::now() < deadline {
            if let Ok(chunk) = rx.try_recv() {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(chunk.data)
                    .unwrap();
                out.extend_from_slice(&bytes);
                if out
                    .windows(27)
                    .any(|w| w == b"Environment activation failed")
                {
                    break;
                }
            } else {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        terminal.manager.close_all();

        let output_str = String::from_utf8_lossy(&out);
        assert!(
            output_str.contains("Environment activation failed"),
            "Got: {:?}",
            output_str
        );
        let _ = dir;
    }

    #[test]
    fn execute_startup_commands_sends_to_pty() {
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
            scrollback_megabytes: None,
        };

        let terminal = TerminalState::new();

        // We bypass the public create_terminal wrapper and drive the internal
        // pieces directly to observe the startup commands.
        let session_id = "test-session";
        let (mut spawn, _, profile) = build_session_spawn(&app, &request, session_id).unwrap();
        // This test intentionally bypasses the public readiness handshake.
        spawn.readiness_marker = None;

        let id = terminal.manager.create(spawn).unwrap();
        let (_, subscription) = terminal.manager.attach(&id, "startup-test".into()).unwrap();
        let mut rx = subscription.receiver;

        // Execute startup commands manually (replicating the wrapper).
        execute_startup_commands(&terminal.manager, &profile, &id).unwrap();

        // Read until we see our marker or time out.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let mut out = Vec::new();
        use base64::Engine;
        while std::time::Instant::now() < deadline {
            if let Ok(chunk) = rx.try_recv() {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(chunk.data)
                    .unwrap();
                out.extend_from_slice(&bytes);
                if out.windows(14).any(|w| w == b"PT_STARTUP_OK\r") {
                    break;
                }
            } else {
                std::thread::sleep(std::time::Duration::from_millis(10));
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
