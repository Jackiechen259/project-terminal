//! Terminal Tauri commands.
//!
//! Per plan Â§12.3: `create_terminal`, `write_terminal`, `resize_terminal`,
//! `close_terminal`, `restart_terminal`.
//!
//! Per plan Â§12 (security): the frontend only submits `projectId` and
//! `profileId` (plus dimensions). The backend resolves the project, profile,
//! shell executable, cwd, env vars, and activation commands. The frontend
//! never controls the executable path or arguments directly.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State};

use crate::error::{AppError, AppResult};
use crate::state::{new_id, AppState};
use crate::terminal::{resolve_local_shell, SessionInfo, SessionSpawn, TerminalManager};
use crate::terminal_engine::{
    RenderFrame, TerminalControlEvent, TerminalKeyEvent, TerminalMouseEvent, TerminalSelectionPoint,
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
    /// Authoritative wezterm-term visible history. Optional for compatibility
    /// with remote callers that only provide the raw attach-history budget.
    #[serde(default)]
    pub scrollback_lines: Option<u32>,
}

/// Which workspace/window owns a terminal session.
///
/// The backend derives this from the calling webview's label - the frontend
/// never submits a window id of its own choosing, so a session can never be
/// claimed by a window it did not come from. `None` fields mean the session
/// was created outside any window (for example by the remote gateway).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionOwnership {
    pub workspace_id: Option<String>,
    pub window_id: Option<String>,
}

impl SessionOwnership {
    /// Resolve the owning workspace from the webview that invoked a command.
    /// With the single-window architecture this is always `main`.
    pub fn from_webview(app: &tauri::AppHandle, webview_label: &str) -> Self {
        let windows = app.try_state::<crate::window::WindowManager>();
        match windows.and_then(|manager| manager.workspace_id_for_window(webview_label)) {
            Some(workspace_id) => Self {
                workspace_id: Some(workspace_id.clone()),
                window_id: Some(workspace_id),
            },
            None => Self::default(),
        }
    }
}

/// Per-session state we keep alongside the manager so restart can rebuild
/// the spawn config from the original profile without re-querying.
struct SessionMeta {
    project_id: String,
    profile_id: String,
    /// The grid the session was last resized to.
    ///
    /// Restart has to reproduce it. Spawning at 80x24 and waiting for the
    /// frontend's first resize is not just a flicker: the readiness handshake
    /// and the profile's startup commands run in between, and a long generated
    /// command wrapped at 80 columns is exactly what makes PSReadLine repaint
    /// fragments into the terminal.
    rows: u16,
    cols: u16,
    /// Attach-history budget the session was created with.
    scrollback_megabytes: Option<u8>,
    /// Visible history rows used by the Rust terminal model.
    scrollback_lines: Option<u32>,
}

pub struct TerminalState {
    pub manager: TerminalManager,
    meta: std::sync::Arc<parking_lot::Mutex<std::collections::HashMap<String, SessionMeta>>>,
    launch_gate: std::sync::Arc<tokio::sync::Semaphore>,
}

impl Clone for TerminalState {
    fn clone(&self) -> Self {
        Self {
            manager: self.manager.clone_handle(),
            meta: self.meta.clone(),
            launch_gate: self.launch_gate.clone(),
        }
    }
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
            meta: std::sync::Arc::new(parking_lot::Mutex::new(std::collections::HashMap::new())),
            launch_gate: std::sync::Arc::new(tokio::sync::Semaphore::new(parallelism.max(1))),
        }
    }

    fn remember(&self, session_id: &str, request: &CreateTerminalRequest) {
        self.meta.lock().insert(
            session_id.to_string(),
            SessionMeta {
                project_id: request.project_id.clone(),
                profile_id: request.profile_id.clone(),
                rows: request.rows.max(1),
                cols: request.cols.max(1),
                scrollback_megabytes: request.scrollback_megabytes,
                scrollback_lines: request.scrollback_lines,
            },
        );
    }

    /// Record the grid a live session was resized to, so a later restart can
    /// spawn straight into it.
    fn remember_size(&self, session_id: &str, rows: u16, cols: u16) {
        if let Some(meta) = self.meta.lock().get_mut(session_id) {
            meta.rows = rows.max(1);
            meta.cols = cols.max(1);
        }
    }

    fn forget(&self, session_id: &str) {
        self.meta.lock().remove(session_id);
    }

    /// Close every live terminal belonging to a project and discard restart
    /// metadata. Project deletion uses this as one backend-owned operation so
    /// callers cannot leave sessions detached from their persisted project.
    pub(crate) fn close_project_sessions(&self, project_id: &str) {
        let session_ids = self
            .manager
            .list()
            .into_iter()
            .filter(|session| session.project_id == project_id)
            .map(|session| session.session_id)
            .collect::<Vec<_>>();
        for session_id in session_ids {
            let _ = self.manager.close(&session_id);
            self.forget(&session_id);
        }
    }

    /// Live sessions owned by one workspace. Used when a window is reopened
    /// so its frontend can reattach instead of starting fresh shells.
    pub(crate) fn list_workspace_sessions(&self, workspace_id: &str) -> Vec<SessionInfo> {
        self.manager
            .list()
            .into_iter()
            .filter(|session| session.workspace_id.as_deref() == Some(workspace_id))
            .collect()
    }

    /// Close every session owned by one workspace and discard their restart
    /// metadata. Windows from other workspaces are never touched - this is the
    /// "Stop terminals in this window" path, not a global shutdown.
    pub(crate) fn close_workspace_sessions(&self, workspace_id: &str) -> usize {
        let session_ids = self
            .manager
            .list()
            .into_iter()
            .filter(|session| session.workspace_id.as_deref() == Some(workspace_id))
            .map(|session| session.session_id)
            .collect::<Vec<_>>();
        for session_id in &session_ids {
            let _ = self.manager.close(session_id);
            self.forget(session_id);
        }
        session_ids.len()
    }

    #[allow(dead_code)]
    /// The create request that would reproduce a session as it stands now.
    fn meta_for(&self, session_id: &str) -> Option<CreateTerminalRequest> {
        self.meta
            .lock()
            .get(session_id)
            .map(|m| CreateTerminalRequest {
                project_id: m.project_id.clone(),
                profile_id: m.profile_id.clone(),
                rows: m.rows,
                cols: m.cols,
                scrollback_megabytes: m.scrollback_megabytes,
                scrollback_lines: m.scrollback_lines,
            })
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

    let mut ssh_environment = Vec::new();
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
            let mut connection = app.ssh.get(&ssh_project.connection_id)?;
            connection.password_saved = crate::ssh::credential::password_exists(&connection.id)?;
            if connection.password_saved {
                ssh_environment = crate::ssh::credential::askpass_environment(&connection.id)?;
            }
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

    // Env vars from the profile, plus internal markers. TERM goes first so a
    // profile that pins its own value overrides the resolved one.
    let mut env: Vec<(String, String)> = Vec::new();
    env.extend(crate::terminal::resolve_term_env(
        project.project_type,
        profile.shell_type,
    ));
    if profile.shell_type == crate::profile::ShellType::GitBash {
        env.extend(crate::terminal::git_bash_login_environment(&program));
    }
    if let Some(vars) = &profile.environment_variables {
        for (k, v) in vars {
            env.push((k.clone(), v.clone()));
        }
    }
    if let Some(path) = shell_integration_script_path(&profile)? {
        env.push((
            crate::terminal::shell_integration::SCRIPT_PATH_ENV.to_string(),
            path,
        ));
    }
    if let Some(wslenv) = wslenv_for_session(project.project_type, &env) {
        env.push(("WSLENV".into(), wslenv));
    }
    env.push(("PROJECT_TERMINAL_PROJECT_ID".into(), project.id.clone()));
    env.push(("PROJECT_TERMINAL_PROFILE_ID".into(), profile.id.clone()));
    env.push((
        "PROJECT_TERMINAL_READY".into(),
        format!("__PROJECT_TERMINAL_READY_{session_id}__"),
    ));
    env.extend(ssh_environment);

    let project_type = project.project_type;
    Ok((
        SessionSpawn {
            session_id: session_id.to_string(),
            project_id: project.id.clone(),
            profile_id: profile.id.clone(),
            // Ownership is attached by the caller (`create_terminal_inner` /
            // `restart_terminal_inner`) from the calling webview - it is never
            // part of the frontend request.
            workspace_id: None,
            window_id: None,
            program,
            args,
            cwd,
            env,
            env_remove: crate::terminal::resolve_term_env_remove(
                project.project_type,
                profile.shell_type,
            ),
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
            scrollback_lines: request.scrollback_lines.map(|lines| lines as usize),
        },
        project_type,
        profile,
    ))
}

/// Write this profile's shell-integration script to disk and return its path.
///
/// A file rather than typed input: the scripts define multi-line functions,
/// and typing one at an interactive prompt makes PSReadLine repaint wrapped
/// fragments into the terminal. The shell sources it with a single short line
/// that the readiness handshake then swallows.
///
/// Returns `None` when the profile has not opted in, or when the shell has no
/// prompt hook to attach to.
fn shell_integration_script_path(
    profile: &crate::profile::TerminalProfile,
) -> AppResult<Option<String>> {
    use std::io::Write;

    if profile.shell_integration != Some(true) {
        return Ok(None);
    }
    let Some(script) = crate::terminal::shell_integration::integration_script(profile.shell_type)
    else {
        return Ok(None);
    };

    // Kept out of the session directory and named per profile so repeated
    // launches reuse one file rather than filling the temp directory.
    let path = std::env::temp_dir().join(format!("project-terminal-si-{}", profile.id));
    let mut file = std::fs::File::create(&path)?;
    file.write_all(script.as_bytes())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Decide which of the variables we are about to set should follow a
/// `wsl.exe` child into its distribution.
///
/// Two cases need it, and neither works without `WSLENV`:
///
/// - A WSL project's shell is `wsl.exe`, so a profile's environment variables
///   never reach the user's shell at all without being named here.
/// - A local PowerShell session announces `TERM=xterm-sixel` together with the
///   compiled entry that defines it. Typing `wsl` in that tab carries `TERM`
///   across on its own; carrying `TERMINFO` too is what stops the Linux side
///   failing with `'xterm-sixel': unknown terminal type`.
///
/// Internal markers are deliberately left out - nothing inside the
/// distribution reads them.
fn wslenv_for_session(
    project_type: crate::project::ProjectType,
    env: &[(String, String)],
) -> Option<String> {
    use crate::project::ProjectType;

    if !matches!(project_type, ProjectType::Local | ProjectType::Wsl) {
        return None;
    }
    let names: Vec<&str> = env
        .iter()
        .map(|(name, _)| name.as_str())
        .filter(|name| !name.starts_with("PROJECT_TERMINAL"))
        .filter(|name| !name.eq_ignore_ascii_case("WSLENV"))
        .collect();
    crate::terminal::wsl::merge_wslenv(std::env::var("WSLENV").ok().as_deref(), names)
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
    // ~/rest â€” keep the slash unquoted so tilde expansion fires.
    if let Some(rest) = after_tilde.strip_prefix('/') {
        return Some(format!("~/{}", escape_remote_posix_argument(rest)));
    }
    // ~user or ~user/rest â€” split at the first slash.
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

/// The command whose output proves the shell is interactive.
///
/// Pure, so what the shell is actually told can be asserted without a PTY.
fn readiness_command(
    profile: &crate::profile::TerminalProfile,
    session_id: &str,
) -> AppResult<String> {
    let marker = format!("__PROJECT_TERMINAL_READY_{session_id}__");
    // Configuring the encoding rides along with the handshake rather than
    // running after it. Both are typed into the PTY and both echo, and the
    // readiness watcher discards every byte up to the marker's own line - so
    // anything folded in here is invisible, and anything sent afterwards is
    // not. Sent afterwards, this appeared at the top of every new terminal.
    let utf8 = utf8_preamble_for(profile);
    let command = match profile.shell_type {
        crate::profile::ShellType::Powershell => {
            // Clear the bootstrap prompt after the marker is emitted. Some
            // PSReadLine versions paint that prompt before the PTY watcher is
            // armed; clearing here guarantees a new terminal opens with only
            // the final interactive prompt.
            //
            // Length is not a constraint the way it looks: PSReadLine does
            // repaint wrapped fragments, but they arrive before the marker
            // and the watcher drops them with everything else.
            let mut parts = Vec::new();
            parts.extend(utf8);
            parts.push("echo \"[$env:PROJECT_TERMINAL_READY]\"");
            parts.push("Clear-Host");
            shell_command_line(profile.shell_type, &parts.join("; "))
        }
        crate::profile::ShellType::Cmd => {
            let encoded_marker = marker
                .chars()
                .map(|character| format!("^{character}"))
                .collect::<String>();
            // `^`-escaping keeps the raw marker out of the command echo, so
            // the watcher matches the output rather than the echo.
            let echo = format!("echo [{encoded_marker}]");
            match utf8 {
                Some(preamble) => format!("{preamble} & {echo}\r\n"),
                None => format!("{echo}\r\n"),
            }
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
    Ok(command)
}

fn wait_for_interactive_shell(
    manager: &TerminalManager,
    profile: &crate::profile::TerminalProfile,
    session_id: &str,
) -> AppResult<()> {
    let marker = format!("__PROJECT_TERMINAL_READY_{session_id}__");
    let command = readiness_command(profile, session_id)?;

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

/// The command that configures this profile's shell for UTF-8 output, if it
/// wants one.
///
/// Folded into the readiness handshake by [`wait_for_interactive_shell`]
/// rather than written after it, so its echo is discarded along with the rest
/// of the handshake. It also has to precede environment activation: a
/// `conda activate` banner printed before the encoding is set is mojibake
/// nobody can explain afterwards.
fn utf8_preamble_for(profile: &crate::profile::TerminalProfile) -> Option<&'static str> {
    let wanted = profile
        .force_utf8
        .unwrap_or_else(|| crate::terminal::forces_utf8_by_default(profile.shell_type));
    wanted
        .then(|| crate::terminal::utf8_preamble(profile.shell_type))
        .flatten()
}

/// Source the shell-integration script, if the profile asked for it.
///
/// Runs after the shell is interactive, which is what makes the wrapping work:
/// the user's `$PROFILE`, `.bashrc` or `config.fish` has already installed
/// starship or oh-my-posh, so these hooks wrap that prompt rather than being
/// wrapped by it.
fn apply_shell_integration(
    manager: &TerminalManager,
    profile: &crate::profile::TerminalProfile,
    session_id: &str,
) {
    if profile.shell_integration != Some(true) {
        return;
    }
    let Some(command) = crate::terminal::shell_integration::source_command(profile.shell_type)
    else {
        return;
    };
    // A shell that cannot source it still works; it just does not report.
    let _ = manager.write(
        session_id,
        shell_command_line(profile.shell_type, command).as_bytes(),
    );
}

fn execute_startup_commands(
    manager: &TerminalManager,
    profile: &crate::profile::TerminalProfile,
    session_id: &str,
) -> AppResult<()> {
    apply_shell_integration(manager, profile, session_id);

    // Phase 3.6/3.7: Environment activation is evaluated and pushed first.
    // Plan Â§20.8 / Â§22: if activation generation fails, we MUST retain the
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

    // Per plan Â§22 (Wait until interactive shell is available): portable-pty
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
    app: tauri::AppHandle,
    terminal: State<'_, TerminalState>,
    webview: tauri::Webview,
    request: CreateTerminalRequest,
) -> AppResult<String> {
    let ownership = SessionOwnership::from_webview(&app, webview.label());
    let app_state = app.state::<AppState>();
    create_terminal_inner(&app_state, &terminal, request, ownership).await
}

pub async fn create_terminal_inner(
    app: &AppState,
    terminal: &TerminalState,
    request: CreateTerminalRequest,
    ownership: SessionOwnership,
) -> AppResult<String> {
    let session_id = new_id("session");
    // Load the project and profile once for the whole launch. Previously the
    // same JSON files were read and parsed again for project-type detection,
    // readiness and startup-command injection.
    let (mut spawn, project_type, profile) = build_session_spawn(app, &request, &session_id)?;
    spawn.workspace_id = ownership.workspace_id.clone();
    spawn.window_id = ownership.window_id.clone();
    let manager = terminal.manager.clone_handle();
    let id = run_terminal_launch(terminal, move || {
        launch_terminal(&manager, spawn, project_type, &profile)
    })
    .await?;

    terminal.remember(&id, &request);
    Ok(id)
}

#[tauri::command]
pub fn write_terminal(
    terminal: State<'_, TerminalState>,
    session_id: String,
    data: String,
) -> AppResult<()> {
    // This command remains for raw command execution initiated by the UI
    // (for example memo automation). Terminal key/text input uses the
    // semantic model-owned commands below.
    terminal.manager.write(&session_id, data.as_bytes())
}

/// Semantic key path for the wezterm renderer. The backend, not the browser,
/// applies application-cursor, kitty/CSI-u, and modifier encoding.
#[tauri::command]
pub fn terminal_key_down(
    terminal: State<'_, TerminalState>,
    session_id: String,
    event: TerminalKeyEvent,
) -> AppResult<()> {
    terminal.manager.key_down(&session_id, &event)
}

/// Semantic printable/composition input for the wezterm renderer. The
/// renderer sends text, not pre-encoded escape sequences; wezterm-term owns
/// the keyboard output path and the PTY writer remains in Rust.
#[tauri::command]
pub fn terminal_text_input(
    terminal: State<'_, TerminalState>,
    session_id: String,
    text: String,
) -> AppResult<()> {
    terminal.manager.text_input(&session_id, &text)
}

#[tauri::command]
pub fn terminal_mouse_event(
    terminal: State<'_, TerminalState>,
    session_id: String,
    event: TerminalMouseEvent,
) -> AppResult<()> {
    terminal.manager.mouse_event(&session_id, &event)
}

#[tauri::command]
pub fn terminal_paste(
    terminal: State<'_, TerminalState>,
    session_id: String,
    text: String,
) -> AppResult<()> {
    terminal.manager.send_paste(&session_id, &text)
}

#[tauri::command]
pub fn terminal_bracketed_paste_enabled(
    terminal: State<'_, TerminalState>,
    session_id: String,
) -> AppResult<bool> {
    terminal.manager.bracketed_paste_enabled(&session_id)
}

#[tauri::command]
pub fn terminal_search(
    terminal: State<'_, TerminalState>,
    session_id: String,
    query: crate::terminal_engine::TerminalSearchQuery,
) -> AppResult<Vec<crate::terminal_engine::TerminalSearchMatch>> {
    terminal.manager.search(&session_id, &query)
}

/// Extract selected text from the Rust-owned model. The frontend sends only
/// stable coordinates; it does not need to retain all scrollback rows just to
/// support copy after a viewport move.
#[tauri::command]
pub fn terminal_selection_text(
    terminal: State<'_, TerminalState>,
    session_id: String,
    anchor: TerminalSelectionPoint,
    focus: TerminalSelectionPoint,
) -> AppResult<String> {
    terminal
        .manager
        .selection_text(&session_id, &anchor, &focus)
}

#[tauri::command]
pub fn terminal_set_viewport(
    terminal: State<'_, TerminalState>,
    session_id: String,
    stable_row: i64,
) -> AppResult<()> {
    terminal.manager.set_viewport_top(&session_id, stable_row)
}

#[tauri::command]
pub fn resize_terminal(
    terminal: State<'_, TerminalState>,
    session_id: String,
    rows: u16,
    cols: u16,
    // Grid size in pixels. Travels in the same `TIOCGWINSZ` structure as rows
    // and columns; image tools read it to size their output. Optional, and `0`
    // is the conventional "unknown" - the remote gateway never measures one.
    pixel_width: Option<u16>,
    pixel_height: Option<u16>,
) -> AppResult<()> {
    let pixel_width = pixel_width.unwrap_or(0);
    let pixel_height = pixel_height.unwrap_or(0);
    terminal
        .manager
        .resize(&session_id, rows, cols, pixel_width, pixel_height)?;
    terminal.remember_size(&session_id, rows, cols);
    Ok(())
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
    app: tauri::AppHandle,
    terminal: State<'_, TerminalState>,
    webview: tauri::Webview,
    session_id: String,
) -> AppResult<String> {
    let ownership = SessionOwnership::from_webview(&app, webview.label());
    let app_state = app.state::<AppState>();
    restart_terminal_inner(&app_state, &terminal, &session_id, ownership).await
}

pub async fn restart_terminal_inner(
    app: &AppState,
    terminal: &TerminalState,
    session_id: &str,
    ownership: SessionOwnership,
) -> AppResult<String> {
    // Reuse the grid and history budget the session was actually running with,
    // not a fixed 80x24 the frontend has to correct afterwards.
    let request = terminal
        .meta_for(session_id)
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
    // Close the old session first so we kill its shell before starting a new
    // one with the same profile.
    terminal.manager.close(session_id)?;
    terminal.forget(session_id);

    let new_id = new_id("session");
    let (mut spawn, project_type, profile) = build_session_spawn(app, &request, &new_id)?;
    spawn.workspace_id = ownership.workspace_id.clone();
    spawn.window_id = ownership.window_id.clone();
    let manager = terminal.manager.clone_handle();
    let id = run_terminal_launch(terminal, move || {
        launch_terminal(&manager, spawn, project_type, &profile)
    })
    .await?;

    terminal.remember(&id, &request);
    Ok(id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSessionAttachment {
    pub session: SessionInfo,
}

/// Typed render/control transport for the Rust-owned terminal engine.
///
/// This command never replays raw PTY bytes to the frontend. The initial full
/// frame and all subsequent dirty-row frames come from the session's persistent
/// wezterm-term model.
#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum DesktopRenderFrame {
    Frame {
        frame: RenderFrame,
    },
    Control {
        event: TerminalControlEvent,
    },
    Status {
        status: crate::terminal::session::SessionStatus,
        exit_code: Option<i32>,
    },
    Lagged,
}

impl DesktopRenderFrame {
    fn into_body(self) -> Option<InvokeResponseBody> {
        serde_json::to_string(&self)
            .ok()
            .map(InvokeResponseBody::Json)
    }
}

/// Attach a custom renderer without attaching to the raw PTY output stream.
/// The PTY and wezterm-term model continue when this renderer detaches.
#[tauri::command]
pub fn session_attach_render(
    terminal: State<'_, TerminalState>,
    session_id: String,
    client_id: String,
    on_frame: Channel<InvokeResponseBody>,
) -> AppResult<RenderSessionAttachment> {
    use tokio::sync::broadcast::error::RecvError;

    let (info, subscription, mut status_receiver) = terminal
        .manager
        .attach_renderer(&session_id, client_id.clone())?;
    let session = terminal.manager.get(&session_id)?;
    let manager = terminal.manager.clone_handle();

    tauri::async_runtime::spawn(async move {
        let mut frames = subscription.frames;
        let mut controls = subscription.controls;
        let mut cancellation = subscription.cancellation;
        loop {
            tokio::select! {
                changed = cancellation.changed() => {
                    if changed.is_err() || *cancellation.borrow() {
                        break;
                    }
                }
                frame = frames.recv() => {
                    let body = match frame {
                        Ok(frame) => DesktopRenderFrame::Frame { frame: (*frame).clone() }.into_body(),
                        Err(RecvError::Lagged(_)) => {
                            session.request_render_snapshot();
                            DesktopRenderFrame::Lagged.into_body()
                        }
                        Err(RecvError::Closed) => break,
                    };
                    if let Some(body) = body {
                        if on_frame.send(body).is_err() {
                            break;
                        }
                    }
                }
                event = controls.recv() => {
                    let body = match event {
                        Ok(event) => DesktopRenderFrame::Control { event: (*event).clone() }.into_body(),
                        Err(RecvError::Lagged(_)) => {
                            session.request_render_snapshot();
                            DesktopRenderFrame::Lagged.into_body()
                        }
                        Err(RecvError::Closed) => break,
                    };
                    if let Some(body) = body {
                        if on_frame.send(body).is_err() {
                            break;
                        }
                    }
                }
                event = status_receiver.recv() => {
                    let body = match event {
                        Ok(event) => DesktopRenderFrame::Status {
                            status: event.status,
                            exit_code: event.exit_code,
                        }.into_body(),
                        Err(RecvError::Lagged(_)) => DesktopRenderFrame::Lagged.into_body(),
                        Err(RecvError::Closed) => break,
                    };
                    if let Some(body) = body {
                        if on_frame.send(body).is_err() {
                            break;
                        }
                    }
                }
            }
        }
        let _ = manager.detach(&session_id, &client_id);
    });

    Ok(RenderSessionAttachment { session: info })
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

/// Live sessions owned by the workspace of the calling window.
///
/// A reopened window uses this to reattach to the sessions it kept running
/// instead of spawning fresh shells. Ownership is derived from the calling
/// webview, never trusted from the payload.
#[tauri::command]
pub fn list_workspace_sessions(
    app: tauri::AppHandle,
    terminal: State<'_, TerminalState>,
    webview: tauri::Webview,
) -> ListResponse<SessionInfo> {
    let ownership = SessionOwnership::from_webview(&app, webview.label());
    match ownership.workspace_id {
        Some(workspace_id) => ListResponse::new(terminal.list_workspace_sessions(&workspace_id)),
        // A webview that is not registered as a workspace window (should not
        // happen in practice) owns nothing.
        None => ListResponse::new(Vec::new()),
    }
}

/// Close every session owned by the calling window's workspace.
///
/// With the single-window architecture that is every desktop session; remote
/// gateway sessions (which have no owning workspace) are never touched.
#[tauri::command]
pub fn close_workspace_sessions(
    app: tauri::AppHandle,
    terminal: State<'_, TerminalState>,
    webview: tauri::Webview,
) -> AppResult<u32> {
    let ownership = SessionOwnership::from_webview(&app, webview.label());
    let Some(workspace_id) = ownership.workspace_id else {
        return Ok(0);
    };
    Ok(terminal.close_workspace_sessions(&workspace_id) as u32)
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
    fn desktop_control_frames_use_the_camel_case_keys_the_frontend_reads() {
        assert_eq!(
            serde_json::to_string(&DesktopRenderFrame::Control {
                event: TerminalControlEvent::Bell,
            })
            .unwrap(),
            r#"{"type":"control","event":{"type":"bell"}}"#
        );
    }

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

    #[test]
    fn close_project_sessions_only_closes_the_target_project() {
        fn spawn(session_id: &str, project_id: &str) -> SessionSpawn {
            SessionSpawn {
                session_id: session_id.into(),
                project_id: project_id.into(),
                profile_id: format!("profile-{project_id}"),
                workspace_id: Some(project_id.into()),
                window_id: Some(project_id.into()),
                program: if cfg!(windows) {
                    "cmd.exe".into()
                } else {
                    "/bin/sh".into()
                },
                args: if cfg!(windows) {
                    vec!["/Q".into()]
                } else {
                    Vec::new()
                },
                cwd: None,
                env: Vec::new(),
                env_remove: Vec::new(),
                readiness_marker: None,
                rows: 24,
                cols: 80,
                scrollback_bytes: 1024,
                scrollback_lines: None,
            }
        }

        let terminal = TerminalState::new();
        terminal.manager.create(spawn("session-p1", "p1")).unwrap();
        terminal.manager.create(spawn("session-p2", "p2")).unwrap();
        terminal.remember("session-p1", &create_request("p1", "profile-p1"));
        terminal.remember("session-p2", &create_request("p2", "profile-p2"));

        terminal.close_project_sessions("p1");

        assert!(terminal.manager.get("session-p1").is_err());
        assert!(terminal.meta_for("session-p1").is_none());
        assert!(terminal.manager.get("session-p2").is_ok());
        let remaining = terminal.meta_for("session-p2").expect("meta for p2");
        assert_eq!(remaining.project_id, "p2");
        assert_eq!(remaining.profile_id, "profile-p2");
        terminal.manager.close_all();
    }

    #[test]
    fn closing_one_workspace_sessions_leaves_other_workspaces_untouched() {
        fn spawn(session_id: &str, project_id: &str, workspace: &str) -> SessionSpawn {
            SessionSpawn {
                session_id: session_id.into(),
                project_id: project_id.into(),
                profile_id: format!("profile-{project_id}"),
                workspace_id: Some(workspace.into()),
                window_id: Some(workspace.into()),
                program: if cfg!(windows) {
                    "cmd.exe".into()
                } else {
                    "/bin/sh".into()
                },
                args: if cfg!(windows) {
                    vec!["/Q".into()]
                } else {
                    Vec::new()
                },
                cwd: None,
                env: Vec::new(),
                env_remove: Vec::new(),
                readiness_marker: None,
                rows: 24,
                cols: 80,
                scrollback_bytes: 1024,
                scrollback_lines: None,
            }
        }

        let terminal = TerminalState::new();
        // Two sessions in workspace A (same project twice - allowed), one in B,
        // one with no owner at all (remote gateway).
        terminal.manager.create(spawn("a1", "p1", "ws-a")).unwrap();
        terminal.manager.create(spawn("a2", "p1", "ws-a")).unwrap();
        terminal.manager.create(spawn("b1", "p2", "ws-b")).unwrap();
        let mut remote_spawn = spawn("remote-1", "p3", "ws-x");
        remote_spawn.workspace_id = None;
        remote_spawn.window_id = None;
        terminal.manager.create(remote_spawn).unwrap();
        terminal.remember("a1", &create_request("p1", "profile-p1"));
        terminal.remember("a2", &create_request("p1", "profile-p1"));
        terminal.remember("b1", &create_request("p2", "profile-p2"));

        // Listing is scoped to the workspace (registry order, so compare
        // sorted).
        let listed = terminal.list_workspace_sessions("ws-a");
        let mut ids = listed
            .iter()
            .map(|s| s.session_id.as_str())
            .collect::<Vec<_>>();
        ids.sort();
        assert_eq!(ids, vec!["a1", "a2"]);
        assert!(listed
            .iter()
            .all(|s| s.workspace_id.as_deref() == Some("ws-a")));

        // Closing workspace A stops exactly A's sessions.
        let closed = terminal.close_workspace_sessions("ws-a");
        assert_eq!(closed, 2);
        assert!(terminal.manager.get("a1").is_err());
        assert!(terminal.manager.get("a2").is_err());
        assert!(terminal.manager.get("b1").is_ok());
        assert!(terminal.manager.get("remote-1").is_ok());
        // Restart metadata was discarded for A only.
        assert!(terminal.meta_for("a1").is_none());
        assert!(terminal.meta_for("b1").is_some());
        terminal.manager.close_all();
    }

    fn create_request(project_id: &str, profile_id: &str) -> CreateTerminalRequest {
        CreateTerminalRequest {
            project_id: project_id.into(),
            profile_id: profile_id.into(),
            rows: 24,
            cols: 80,
            scrollback_megabytes: None,
            scrollback_lines: None,
        }
    }

    #[test]
    fn the_utf8_preamble_rides_the_handshake_so_it_never_shows() {
        // Written after the handshake it echoed at the top of every new
        // terminal. The readiness watcher discards every byte up to the
        // marker's own line, so folding it in is what makes it invisible.
        let powershell = default_powershell_profile("p".into(), "proj".into());
        let preamble = utf8_preamble_for(&powershell).expect("PowerShell preamble");
        assert!(preamble.contains("OutputEncoding"));

        let command = readiness_command(&powershell, "session-1").unwrap();
        assert!(command.starts_with(preamble), "{command}");
        // Still ahead of the marker, which is what the watcher keys on.
        assert!(
            command.find(preamble).unwrap() < command.find("PROJECT_TERMINAL_READY").unwrap(),
            "{command}"
        );
        // And the raw marker never appears in the echoed command itself, or
        // the watcher would match the echo instead of the output.
        assert!(!command.contains("__PROJECT_TERMINAL_READY_session-1__"));
    }

    #[test]
    fn a_profile_that_declines_utf8_gets_the_bare_handshake() {
        let mut powershell = default_powershell_profile("p".into(), "proj".into());
        powershell.force_utf8 = Some(false);
        assert_eq!(utf8_preamble_for(&powershell), None);

        let command = readiness_command(&powershell, "session-1").unwrap();
        assert!(command.starts_with("echo"), "{command}");
        assert!(!command.contains("OutputEncoding"));
    }

    #[test]
    fn cmd_opts_in_to_chcp_and_keeps_it_inside_the_handshake() {
        // `chcp 65001` breaks `more` and OEM batch scripts, so it is off
        // unless asked for - and when asked for it must not echo either.
        let mut cmd = crate::profile::TerminalProfile {
            shell_type: ShellType::Cmd,
            ..default_powershell_profile("p".into(), "proj".into())
        };
        assert_eq!(utf8_preamble_for(&cmd), None);

        cmd.force_utf8 = Some(true);
        let command = readiness_command(&cmd, "session-1").unwrap();
        assert!(command.starts_with("chcp 65001>nul & echo "), "{command}");
        assert!(!command.contains("__PROJECT_TERMINAL_READY_session-1__"));
    }

    #[test]
    fn a_restart_reproduces_the_grid_the_session_was_running_at() {
        // Spawning at 80x24 and waiting for the frontend to correct it puts
        // the readiness handshake and the profile's startup commands through
        // an 80-column PSReadLine, which repaints wrapped fragments into the
        // terminal.
        let terminal = TerminalState::new();
        terminal.remember("session-1", &create_request("p1", "profile-1"));

        terminal.remember_size("session-1", 50, 160);

        let request = terminal.meta_for("session-1").expect("meta");
        assert_eq!((request.rows, request.cols), (50, 160));
        assert_eq!(request.project_id, "p1");
        assert_eq!(request.profile_id, "profile-1");
    }

    #[test]
    fn a_restart_keeps_the_scrollback_budget_the_session_was_created_with() {
        let terminal = TerminalState::new();
        terminal.remember(
            "session-1",
            &CreateTerminalRequest {
                scrollback_megabytes: Some(16),
                scrollback_lines: Some(2_500),
                ..create_request("p1", "profile-1")
            },
        );

        assert_eq!(
            terminal.meta_for("session-1").unwrap().scrollback_megabytes,
            Some(16)
        );
        assert_eq!(
            terminal.meta_for("session-1").unwrap().scrollback_lines,
            Some(2_500)
        );
    }

    #[test]
    fn build_session_spawn_keeps_model_rows_separate_from_raw_history_bytes() {
        let app = test_state();
        seed_project(&app, "p1");
        app.profiles
            .upsert(default_powershell_profile("profile-1".into(), "p1".into()))
            .unwrap();

        let request = CreateTerminalRequest {
            scrollback_megabytes: Some(2),
            scrollback_lines: Some(25_000),
            ..create_request("p1", "profile-1")
        };
        let (spawn, _, _) = build_session_spawn(&app, &request, "session-1").unwrap();

        assert_eq!(spawn.scrollback_bytes, 2 * 1024 * 1024);
        assert_eq!(spawn.scrollback_lines, Some(25_000));
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
            scrollback_lines: None,
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
    fn build_session_spawn_lets_a_profile_override_the_resolved_term() {
        let app = test_state();
        let _dir = seed_project(&app, "p1");
        let mut profile = default_powershell_profile("profile-1".into(), "p1".into());
        profile.shell_executable = Some("cmd.exe".into());
        app.profiles.upsert(profile.clone()).unwrap();
        let request = CreateTerminalRequest {
            project_id: "p1".into(),
            profile_id: "profile-1".into(),
            rows: 24,
            cols: 80,
            scrollback_megabytes: None,
            scrollback_lines: None,
        };

        // A PowerShell profile advertises inline-image support by default.
        let (spawn, _, _) = build_session_spawn(&app, &request, "session-1").unwrap();
        let term = |spawn: &crate::terminal::SessionSpawn| {
            // Later entries win in the PTY, so the effective value is the last.
            spawn
                .env
                .iter()
                .rfind(|(k, _)| k == "TERM")
                .map(|(_, v)| v.clone())
                .unwrap()
        };
        assert_eq!(term(&spawn), crate::terminal::TERM_SIXEL);
        // The name it announces is defined for the session, so terminfo
        // consumers started from the shell can still resolve it.
        assert!(spawn
            .env
            .iter()
            .any(|(k, v)| k == "TERMINFO" && v == crate::terminal::terminfo_sixel_entry()));

        // ...and an explicit profile variable takes it back.
        profile.environment_variables = Some(
            [("TERM".to_string(), "xterm-256color".to_string())]
                .into_iter()
                .collect(),
        );
        app.profiles.upsert(profile).unwrap();
        let (spawn, _, _) = build_session_spawn(&app, &request, "session-2").unwrap();
        assert_eq!(term(&spawn), "xterm-256color");
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
            scrollback_lines: None,
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
            scrollback_lines: None,
        };
        let (spawn, project_type, _) = build_session_spawn(&app, &request, "session-1").unwrap();

        assert_eq!(project_type, ProjectType::Wsl);
        assert_eq!(spawn.program, "wsl.exe");
        assert!(spawn.readiness_marker.is_none());
    }

    /// Insert a WSL project whose profile carries `vars`, and build its spawn.
    fn wsl_spawn_with_environment(vars: &[(&str, &str)]) -> crate::terminal::SessionSpawn {
        let app = test_state();
        app.projects
            .upsert(Project {
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
            })
            .unwrap();
        let mut profile = default_wsl_profile(
            "wsl-profile".into(),
            "wsl-project".into(),
            "Ubuntu".into(),
            None,
        );
        profile.environment_variables = Some(
            vars.iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        );
        app.profiles.upsert(profile).unwrap();

        let request = CreateTerminalRequest {
            project_id: "wsl-project".into(),
            profile_id: "wsl-profile".into(),
            rows: 24,
            cols: 80,
            scrollback_megabytes: None,
            scrollback_lines: None,
        };
        build_session_spawn(&app, &request, "session-1").unwrap().0
    }

    #[test]
    fn wsl_profile_environment_variables_reach_the_distribution() {
        let spawn = wsl_spawn_with_environment(&[("FOO", "bar")]);

        // Setting the variable is only half of it: `wsl.exe` forwards nothing
        // that `WSLENV` does not name.
        assert!(spawn.env.iter().any(|(k, v)| k == "FOO" && v == "bar"));
        let wslenv = spawn
            .env
            .iter()
            .find(|(k, _)| k == "WSLENV")
            .map(|(_, v)| v.as_str())
            .expect("WSLENV should be set for a WSL session");
        assert!(
            wslenv.split(':').any(|entry| entry == "FOO"),
            "WSLENV {wslenv} should carry FOO"
        );
        // Internal markers are of no use inside the distribution.
        assert!(!wslenv.contains("PROJECT_TERMINAL"));
    }

    #[test]
    fn local_sixel_session_carries_its_terminfo_entry_into_wsl() {
        let app = test_state();
        let _dir = seed_project(&app, "p1");
        app.profiles
            .upsert(default_powershell_profile("profile-1".into(), "p1".into()))
            .unwrap();

        let request = CreateTerminalRequest {
            project_id: "p1".into(),
            profile_id: "profile-1".into(),
            rows: 24,
            cols: 80,
            scrollback_megabytes: None,
            scrollback_lines: None,
        };
        let (spawn, _, _) = build_session_spawn(&app, &request, "session-1").unwrap();

        // Typing `wsl` in a PowerShell tab hands `TERM=xterm-sixel` to a host
        // that has never heard of it. Forwarding the entry that defines it is
        // what keeps `less` and `vim` alive over there.
        let wslenv = spawn
            .env
            .iter()
            .find(|(k, _)| k == "WSLENV")
            .map(|(_, v)| v.as_str())
            .expect("WSLENV should be set for a local session");
        let entries: Vec<&str> = wslenv.split(':').collect();
        assert!(
            entries.contains(&"TERM"),
            "WSLENV {wslenv} should carry TERM"
        );
        assert!(
            entries.contains(&"TERMINFO"),
            "WSLENV {wslenv} should carry TERMINFO"
        );
    }

    #[test]
    fn ssh_profile_environment_variables_travel_in_the_remote_command() {
        // Variables set on the local `ssh.exe` process do not cross the wire -
        // OpenSSH forwards only what `SendEnv` names, and Windows OpenSSH
        // ships no `SendEnv`. The remote command is the route that works.
        let mut profile = crate::profile::TerminalProfile {
            shell_type: ShellType::RemoteBash,
            ..default_powershell_profile("p".into(), "proj".into())
        };
        profile.environment_variables = Some(
            [("FOO".to_string(), "it's quoted".to_string())]
                .into_iter()
                .collect(),
        );

        let command = remote_start_command(&profile, "/srv/app")
            .unwrap()
            .expect("remote command");

        assert!(command.contains("export FOO="), "{command}");
        assert!(command.contains("cd --"), "{command}");
    }

    #[test]
    fn remote_fish_profiles_get_fish_syntax() {
        let mut profile = crate::profile::TerminalProfile {
            shell_type: ShellType::RemoteFish,
            ..default_powershell_profile("p".into(), "proj".into())
        };
        profile.environment_variables = Some(
            [("FOO".to_string(), "bar".to_string())]
                .into_iter()
                .collect(),
        );

        let command = remote_start_command(&profile, "/srv/app")
            .unwrap()
            .expect("remote command");

        // `export` is not a fish builtin; emitting it produced a syntax error
        // before the user's shell ever opened.
        assert!(command.contains("set -gx FOO"), "{command}");
        assert!(!command.contains("export FOO"), "{command}");
    }

    #[test]
    fn ssh_askpass_environment_wins_over_a_colliding_profile_variable() {
        // `askpass_environment` is appended last precisely so a profile cannot
        // redirect the password prompt. `CommandBuilder` is last-write-wins.
        let app = test_state();
        let _dir = seed_project(&app, "p1");
        let mut profile = default_powershell_profile("profile-1".into(), "p1".into());
        profile.environment_variables = Some(
            [("SSH_ASKPASS".to_string(), "hijacked".to_string())]
                .into_iter()
                .collect(),
        );
        app.profiles.upsert(profile).unwrap();

        let request = CreateTerminalRequest {
            project_id: "p1".into(),
            profile_id: "profile-1".into(),
            rows: 24,
            cols: 80,
            scrollback_megabytes: None,
            scrollback_lines: None,
        };
        let (spawn, _, _) = build_session_spawn(&app, &request, "session-1").unwrap();

        let last_askpass = spawn.env.iter().rfind(|(k, _)| k == "SSH_ASKPASS");
        // No SSH connection here, so the profile value is the only one; the
        // ordering guarantee is what the assertion below pins.
        assert_eq!(
            last_askpass.map(|(_, v)| v.as_str()),
            Some("hijacked"),
            "profile variables must be present before the askpass block"
        );
        let askpass_index = spawn
            .env
            .iter()
            .position(|(k, _)| k == "SSH_ASKPASS")
            .unwrap();
        let marker_index = spawn
            .env
            .iter()
            .position(|(k, _)| k == "PROJECT_TERMINAL_READY")
            .unwrap();
        assert!(askpass_index < marker_index);
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
            scrollback_lines: None,
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
            scrollback_lines: None,
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
        // ~/subpath â€” tilde and slash unquoted so the shell expands ~.
        assert_eq!(
            escape_remote_cd_path("~/projects"),
            Some("~/projects".into())
        );
        assert_eq!(
            escape_remote_cd_path("~/my project"),
            Some("~/'my project'".into())
        );
        // ~user/subpath â€” username and slash unquoted.
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
        // Normal absolute path â€” fully escaped as before.
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
        // "~" means $HOME, where SSH already starts â€” no cd needed.
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
            scrollback_lines: None,
        };

        let terminal = TerminalState::new();
        let session_id = "test-session";
        let (mut spawn, _, profile) = build_session_spawn(&app, &request, session_id).unwrap();
        // This test exercises activation-error injection directly rather than
        // the readiness handshake used by the public create command.
        spawn.readiness_marker = None;

        let id = terminal.manager.create(spawn).unwrap();

        // The helper should write the error into the shell and NOT return an
        // error, keeping the session alive.
        execute_startup_commands(&terminal.manager, &profile, &id).unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let query = crate::terminal_engine::TerminalSearchQuery {
            query: "Environment activation failed".into(),
            case_sensitive: true,
            direction: crate::terminal_engine::TerminalSearchDirection::Forward,
            start: None,
        };
        let mut found = false;
        while std::time::Instant::now() < deadline {
            if !terminal.manager.search(&id, &query).unwrap().is_empty() {
                found = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        terminal.manager.close_all();

        assert!(found, "model did not contain the activation error");
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
            scrollback_lines: None,
        };

        let terminal = TerminalState::new();

        // We bypass the public create_terminal wrapper and drive the internal
        // pieces directly to observe the startup commands.
        let session_id = "test-session";
        let (mut spawn, _, profile) = build_session_spawn(&app, &request, session_id).unwrap();
        // This test intentionally bypasses the public readiness handshake.
        spawn.readiness_marker = None;

        let id = terminal.manager.create(spawn).unwrap();

        // Execute startup commands manually (replicating the wrapper).
        execute_startup_commands(&terminal.manager, &profile, &id).unwrap();

        // Read until we see our marker or time out.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let query = crate::terminal_engine::TerminalSearchQuery {
            query: "PT_STARTUP_OK".into(),
            case_sensitive: true,
            direction: crate::terminal_engine::TerminalSearchDirection::Forward,
            start: None,
        };
        let mut found = false;
        while std::time::Instant::now() < deadline {
            if !terminal.manager.search(&id, &query).unwrap().is_empty() {
                found = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        terminal.manager.close_all();

        assert!(found, "expected startup command output in the model");
        let _ = dir;
    }
}

#[cfg(test)]
mod handshake_probe {
    use super::*;
    use crate::profile::repository::default_powershell_profile;

    /// Spawn a real PowerShell through the same path a session uses and
    /// assert the encoding command never reaches the terminal.
    #[test]
    fn a_real_powershell_session_shows_no_encoding_command() {
        if !cfg!(windows) {
            return;
        }
        let manager = TerminalManager::new();
        let mut profile = default_powershell_profile("p".into(), "proj".into());
        // The managed test environment can put a non-interactive PowerShell
        // shim ahead of the system shell on PATH. Exercise the real inbox
        // Windows PowerShell here so a PATH change cannot turn this probe into
        // a ten-second orphaned child-process timeout.
        profile.shell_executable = Some("powershell.exe".into());
        let (program, args) = crate::terminal::resolve_local_shell(&profile).unwrap();
        let session_id = "handshake-probe";
        let marker = format!("__PROJECT_TERMINAL_READY_{session_id}__");
        manager
            .create(crate::terminal::SessionSpawn {
                session_id: session_id.into(),
                project_id: "proj".into(),
                profile_id: "p".into(),
                workspace_id: None,
                window_id: None,
                program,
                args,
                cwd: None,
                env: vec![("PROJECT_TERMINAL_READY".into(), marker.clone())],
                env_remove: Vec::new(),
                readiness_marker: Some(marker.clone()),
                rows: 24,
                cols: 80,
                scrollback_bytes: 1024 * 1024,
                scrollback_lines: None,
            })
            .unwrap();

        let visible_now = |query: &str| {
            std::thread::sleep(std::time::Duration::from_millis(1200));
            !manager
                .search(
                    session_id,
                    &crate::terminal_engine::TerminalSearchQuery {
                        query: query.into(),
                        case_sensitive: true,
                        direction: crate::terminal_engine::TerminalSearchDirection::Forward,
                        start: None,
                    },
                )
                .unwrap()
                .is_empty()
        };

        if let Err(error) = wait_for_interactive_shell(&manager, &profile, session_id) {
            manager.close_all();
            panic!("{error}");
        }
        let after_handshake_has_encoding = visible_now("OutputEncoding");
        let after_handshake_has_marker = visible_now(&marker);

        // What the fix is worth: sending the same command a moment later -
        // which is what `execute_startup_commands` used to do - puts it on
        // screen. Asserting both directions stops this passing for the
        // trivial reason that PowerShell echoed nothing at all.
        let preamble = utf8_preamble_for(&profile).unwrap();
        manager
            .write(
                session_id,
                shell_command_line(profile.shell_type, preamble).as_bytes(),
            )
            .unwrap();
        let after_startup_commands_has_encoding = visible_now("OutputEncoding");
        manager.close_all();

        assert!(
            !after_handshake_has_encoding,
            "the encoding command reached the model during the handshake"
        );
        assert!(
            !after_handshake_has_marker,
            "the readiness marker reached the model"
        );
        assert!(
            after_startup_commands_has_encoding,
            "sent after the handshake the encoding command should be visible, \
             so this test is actually measuring the handshake"
        );
    }
}
