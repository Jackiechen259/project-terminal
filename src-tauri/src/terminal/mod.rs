//! Terminal module: PTY sessions, manager, shell escaping.
//!
//! Phase 3 supports local PowerShell/CMD/custom-shell sessions. SSH
//! (`ssh.exe`) sessions arrive in Phase 6; environment initialization
//! (Conda/venv/Poetry/uv) arrives in Phase 3.6/3.7.

pub mod conda;
pub mod escaping;
pub mod initializer;
pub mod manager;
pub mod scrollback;
pub mod session;
pub mod wsl;

use std::sync::OnceLock;

use crate::error::{AppError, AppResult};
#[cfg(test)]
use crate::profile::EnvironmentType;
use crate::profile::{ShellType, TerminalProfile};
use crate::project::ProjectType;
pub use initializer::{build_activation_script, build_remote_initialization_commands};
pub use manager::{SessionInfo, TerminalManager};
use serde::Serialize;
pub use session::{SessionSpawn, TerminalEvent, TerminalEventPayload, TerminalOutput};
pub use wsl::{detect_wsl_distributions, DetectedWslDistribution};

/// Terminal type for shells that may consult terminfo, directly or on a host
/// reached through them.
pub const TERM_PORTABLE: &str = "xterm-256color";

/// Terminal type that additionally advertises inline-image support.
pub const TERM_SIXEL: &str = "xterm-sixel";

/// A compiled `xterm-sixel` terminfo entry - `xterm-256color` under a name that
/// advertises Sixel - in the inline form ncurses accepts through `TERMINFO`.
///
/// Regenerate with ncurses' own tools:
///
/// ```text
/// printf 'xterm-sixel|xterm-256color with sixel graphics,\n\tuse=xterm-256color,\n' > sixel.ti
/// tic -x -o out sixel.ti
/// infocmp -Q1 -q -A out xterm-sixel | grep -v '^#' | tr -d '\n\t '
/// ```
///
/// The description it resolves to comes from the ncurses terminfo database,
/// distributed under the X11-style ncurses license.
const TERMINFO_SIXEL_ENTRY: &str = include_str!("xterm-sixel.terminfo.hex");

/// The inline terminfo entry that makes [`TERM_SIXEL`] resolvable.
pub fn terminfo_sixel_entry() -> &'static str {
    TERMINFO_SIXEL_ENTRY.trim()
}

/// Pick the `TERM` announced to the child process.
///
/// CLI tools decide whether they may emit inline images from this string alone
/// - Codex, for one, only enables its image output when `TERM` contains
/// `sixel`. The terminal renders Sixel, so saying so is what makes those
/// features work.
///
/// The catch is that `xterm-sixel` is not in any stock terminfo database. It is
/// therefore only announced where [`resolve_term_env`] can hand the entry along
/// with it: locally, to PowerShell and CMD. Git Bash, WSL and anything reached
/// over SSH hand `TERM` to a host we cannot teach the name to and keep
/// [`TERM_PORTABLE`], where an unknown type would break `vim`, `less` and
/// friends.
pub fn resolve_term(project_type: ProjectType, shell_type: ShellType) -> &'static str {
    if project_type != ProjectType::Local {
        return TERM_PORTABLE;
    }
    match shell_type {
        ShellType::Powershell | ShellType::Cmd => TERM_SIXEL,
        _ => TERM_PORTABLE,
    }
}

/// `TERM` plus, when the announced type is not in any terminfo database, the
/// entry that defines it.
///
/// PowerShell and CMD do not consult terminfo themselves, but the tools run
/// from them do: Git for Windows ships an ncurses-linked `less`, so an
/// unresolvable `TERM` turns `git branch` into `'xterm-sixel': unknown terminal
/// type.`. ncurses (6.3 and newer) reads a compiled entry straight out of
/// `TERMINFO`, which lets us define the name for every tool in the session
/// without touching the machine's terminfo database. Lookups for any other
/// `TERM` fall through to that database as usual.
pub fn resolve_term_env(project_type: ProjectType, shell_type: ShellType) -> Vec<(String, String)> {
    let term = resolve_term(project_type, shell_type);
    let mut env = vec![("TERM".to_string(), term.to_string())];
    if term == TERM_SIXEL {
        // Overrides an inherited TERMINFO; a profile variable takes it back.
        env.push(("TERMINFO".to_string(), terminfo_sixel_entry().to_string()));
    }
    env
}

/// Terminfo variables that must not survive from the app's own environment
/// into a session that does not want them.
///
/// `CommandBuilder` snapshots this process' environment, so launching the app
/// from one of its own sixel-capable PowerShell tabs leaves `TERMINFO` set to
/// an inline `hex:` entry. A Git Bash or WSL session started afterwards
/// announces `TERM=xterm-256color` but inherits that value, and an ncurses
/// older than 6.3 - which is what Git for Windows shipped for years - does not
/// understand the inline form and reads it as a directory path. The result is
/// the same `unknown terminal type` failure the inline entry exists to
/// prevent, arriving by a different route.
pub fn resolve_term_env_remove(
    project_type: ProjectType,
    shell_type: ShellType,
) -> Vec<String> {
    if resolve_term(project_type, shell_type) == TERM_SIXEL {
        // This session sets its own TERMINFO; nothing to strip.
        return Vec::new();
    }
    vec!["TERMINFO".to_string(), "TERMINFO_DIRS".to_string()]
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedShell {
    pub shell_type: ShellType,
    pub name: String,
    pub executable: String,
}

/// Discover shells that can be selected without requiring a manually entered
/// executable. The list is host-specific and contains only verified paths.
pub fn detect_local_shells() -> Vec<DetectedShell> {
    let mut shells = Vec::new();

    if let Ok((executable, _)) = find_powershell() {
        shells.push(DetectedShell {
            shell_type: ShellType::Powershell,
            name: "PowerShell".into(),
            executable,
        });
    }

    #[cfg(windows)]
    if let Some(executable) = which("cmd.exe") {
        shells.push(DetectedShell {
            shell_type: ShellType::Cmd,
            name: "Command Prompt".into(),
            executable,
        });
    }

    if let Ok(executable) = find_git_bash() {
        shells.push(DetectedShell {
            shell_type: ShellType::GitBash,
            name: "Git Bash".into(),
            executable,
        });
    }

    for (shell_type, name, executable_name) in [
        (ShellType::Bash, "Bash", "bash"),
        (ShellType::Zsh, "Zsh", "zsh"),
        (ShellType::Fish, "Fish", "fish"),
        (ShellType::Sh, "POSIX sh", "sh"),
    ] {
        if let Some(executable) = which(executable_name) {
            shells.push(DetectedShell {
                shell_type,
                name: name.into(),
                executable,
            });
        }
    }

    shells
}

/// Resolve the shell executable + args for a local profile.
///
/// Per plan §22 step 5: "Resolve Shell or SSH Client". For Phase 3 we only
/// resolve local shells. SSH clients are resolved in Phase 5.
pub fn resolve_local_shell(profile: &TerminalProfile) -> AppResult<(String, Vec<String>)> {
    // Remote shell types have no local executable.
    if matches!(
        profile.shell_type,
        ShellType::RemoteDefault
            | ShellType::RemoteBash
            | ShellType::RemoteZsh
            | ShellType::RemoteFish
    ) {
        return Err(AppError::ShellNotFound(format!(
            "{:?} is a remote shell type - use the SSH path",
            profile.shell_type
        )));
    }

    // Explicit executable wins.
    if let Some(exe) = profile
        .shell_executable
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        return Ok((exe.clone(), profile.shell_args.clone()));
    }

    match profile.shell_type {
        ShellType::Powershell => {
            // Prefer pwsh.exe (PowerShell 7+) when available, fall back to
            // Windows PowerShell.
            let (exe, no_logo) = find_powershell()?;
            let mut args = profile.shell_args.clone();
            if no_logo && !args.iter().any(|a| a == "-NoLogo") {
                args.push("-NoLogo".into());
            }
            Ok((exe, args))
        }
        ShellType::Cmd => Ok(("cmd.exe".to_string(), profile.shell_args.clone())),
        ShellType::GitBash => {
            // Git Bash ships as bash.exe inside the Git install. We try the
            // common install path; if not found, surface a clear error.
            find_git_bash().map(|p| (p, profile.shell_args.clone()))
        }
        ShellType::Wsl => {
            // `wsl.exe` is on PATH on Windows. Persisted WSL fields become
            // structured arguments; append shell_args last so a user-selected
            // command runs inside the selected distribution and directory.
            let mut args = Vec::new();
            if let Some(distribution) = profile
                .wsl_distribution
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                args.push("--distribution".into());
                args.push(distribution.into());
            }
            if let Some(directory) = profile
                .wsl_working_directory
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                args.push("--cd".into());
                args.push(directory.into());
            }
            args.extend(profile.shell_args.clone());
            Ok(("wsl.exe".to_string(), args))
        }
        ShellType::Bash | ShellType::Zsh | ShellType::Fish | ShellType::Sh => {
            // POSIX shells available on Linux/macOS hosts (and on Windows only
            // when explicitly installed). Resolve through PATH so a user-owned
            // shell wins over a system one.
            let name = match profile.shell_type {
                ShellType::Bash => "bash",
                ShellType::Zsh => "zsh",
                ShellType::Fish => "fish",
                ShellType::Sh => "sh",
                // Unreachable: covered by the match arm above.
                _ => unreachable!("posix shell arm reached for non-posix type"),
            };
            let exe = which(name)
                .ok_or_else(|| AppError::ShellNotFound(format!("{name} was not found on PATH")))?;
            // Interactive login shells source the user's profile so PATH and
            // prompt match a normal terminal launched from the desktop.
            let mut args = Vec::new();
            args.push("-l".into());
            args.extend(profile.shell_args.clone());
            Ok((exe, args))
        }
        ShellType::Custom => Err(AppError::ShellNotFound(
            "custom shell requires shellExecutable to be set".into(),
        )),
        // Unreachable: covered by the remote-type guard above.
        _ => Err(AppError::ShellNotFound(format!(
            "Unsupported local shell type: {:?}",
            profile.shell_type
        ))),
    }
}

#[cfg(test)]
/// True when the profile's environment is anything other than `none`.
pub fn profile_needs_environment(profile: &TerminalProfile) -> bool {
    profile.environment_type != EnvironmentType::None
}

/// Resolved once per process: `which` walks every PATH directory against every
/// PATHEXT entry, which is hundreds of filesystem probes, and this runs on
/// every terminal launch that does not pin a shell executable. A PowerShell
/// installed mid-session is picked up after a restart.
fn find_powershell() -> AppResult<(String, bool)> {
    static POWERSHELL: OnceLock<Option<(String, bool)>> = OnceLock::new();
    POWERSHELL
        .get_or_init(|| find_powershell_uncached().ok())
        .clone()
        .ok_or_else(|| {
            AppError::ShellNotFound(
                "PowerShell was not found on PATH or in the standard install locations".into(),
            )
        })
}

fn find_powershell_uncached() -> AppResult<(String, bool)> {
    // 1. pwsh.exe on PATH (PowerShell 7+)
    if let Some(p) = which("pwsh.exe") {
        return Ok((p, true));
    }
    // 2. Windows PowerShell via the well-known install path.
    if let Some(progfiles) = std::env::var_os("ProgramFiles") {
        let candidate = std::path::Path::new(&progfiles)
            .join("PowerShell")
            .join("7")
            .join("pwsh.exe");
        if candidate.is_file() {
            return Ok((candidate.to_string_lossy().into_owned(), true));
        }
    }
    // 3. System Windows PowerShell.
    if let Some(windir) = std::env::var_os("WINDIR") {
        let candidate = std::path::Path::new(&windir)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if candidate.is_file() {
            return Ok((candidate.to_string_lossy().into_owned(), true));
        }
    }
    Err(AppError::ShellNotFound(
        "PowerShell was not found on PATH or in the standard install locations".into(),
    ))
}

fn find_git_bash() -> AppResult<String> {
    // 1. C:\Program Files\Git\bin\bash.exe
    if let Some(progfiles) = std::env::var_os("ProgramFiles") {
        let candidate = std::path::Path::new(&progfiles)
            .join("Git")
            .join("bin")
            .join("bash.exe");
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    // 2. C:\Program Files (x86)\Git\bin\bash.exe
    if let Some(progfiles) = std::env::var_os("ProgramFiles(x86)") {
        let candidate = std::path::Path::new(&progfiles)
            .join("Git")
            .join("bin")
            .join("bash.exe");
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    Err(AppError::ShellNotFound(
        "Git Bash was not found in the standard Git install locations".into(),
    ))
}

/// Look up an executable on PATH using the PATHEXT-extended Windows behavior.
fn which(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct.to_string_lossy().into_owned());
        }
        if let Some(pathext) = std::env::var_os("PATHEXT") {
            for ext in std::env::split_paths(&pathext) {
                let ext_str = ext.to_string_lossy();
                let candidate = dir.join(format!("{name}{ext_str}"));
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn local_profile(shell: ShellType) -> TerminalProfile {
        TerminalProfile {
            id: "p".into(),
            project_id: "proj".into(),
            name: "test".into(),
            shell_type: shell,
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
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn explicit_executable_wins() {
        let mut p = local_profile(ShellType::Powershell);
        p.shell_executable = Some("C:\\shells\\myshell.exe".into());
        p.shell_args = vec!["-arg1".into()];
        let (exe, args) = resolve_local_shell(&p).unwrap();
        assert_eq!(exe, "C:\\shells\\myshell.exe");
        assert_eq!(args, vec!["-arg1".to_string()]);
    }

    #[test]
    fn remote_shell_type_rejected_for_local_path() {
        let p = local_profile(ShellType::RemoteBash);
        let err = resolve_local_shell(&p).unwrap_err();
        assert!(matches!(err, AppError::ShellNotFound(_)));
    }

    #[test]
    fn custom_shell_without_executable_errors() {
        let p = local_profile(ShellType::Custom);
        assert!(matches!(
            resolve_local_shell(&p).unwrap_err(),
            AppError::ShellNotFound(_)
        ));
    }

    #[test]
    fn cmd_resolves_to_cmd_exe() {
        let p = local_profile(ShellType::Cmd);
        let (exe, _) = resolve_local_shell(&p).unwrap();
        assert_eq!(exe, "cmd.exe");
    }

    #[test]
    fn wsl_resolves_to_wsl_exe() {
        let p = local_profile(ShellType::Wsl);
        let (exe, _) = resolve_local_shell(&p).unwrap();
        assert_eq!(exe, "wsl.exe");
    }

    #[test]
    fn wsl_uses_saved_distribution_and_working_directory() {
        let mut p = local_profile(ShellType::Wsl);
        p.shell_args = vec!["--exec".into(), "bash".into()];
        p.wsl_distribution = Some("Ubuntu-24.04".into());
        p.wsl_working_directory = Some("/home/user/project".into());

        let (exe, args) = resolve_local_shell(&p).unwrap();

        assert_eq!(exe, "wsl.exe");
        assert_eq!(
            args,
            vec![
                "--distribution",
                "Ubuntu-24.04",
                "--cd",
                "/home/user/project",
                "--exec",
                "bash",
            ]
        );
    }

    #[test]
    fn term_advertises_sixel_only_for_terminfo_free_local_shells() {
        for shell in [ShellType::Powershell, ShellType::Cmd] {
            assert_eq!(resolve_term(ProjectType::Local, shell), TERM_SIXEL);
        }
        for shell in [
            ShellType::GitBash,
            ShellType::Wsl,
            ShellType::Bash,
            ShellType::Zsh,
            ShellType::Fish,
            ShellType::Sh,
            ShellType::RemoteDefault,
            ShellType::RemoteBash,
            ShellType::Custom,
        ] {
            assert_eq!(resolve_term(ProjectType::Local, shell), TERM_PORTABLE);
        }
    }

    #[test]
    fn sixel_term_is_announced_together_with_the_entry_that_defines_it() {
        let terminfo = |env: &[(String, String)]| {
            env.iter()
                .find(|(k, _)| k == "TERMINFO")
                .map(|(_, v)| v.clone())
        };

        for shell in [ShellType::Powershell, ShellType::Cmd] {
            let env = resolve_term_env(ProjectType::Local, shell);
            assert_eq!(env[0], ("TERM".to_string(), TERM_SIXEL.to_string()));
            assert_eq!(terminfo(&env).as_deref(), Some(terminfo_sixel_entry()));
        }

        // Nothing to teach anyone about `xterm-256color`.
        for (project_type, shell) in [
            (ProjectType::Local, ShellType::GitBash),
            (ProjectType::Ssh, ShellType::Powershell),
            (ProjectType::Wsl, ShellType::Powershell),
        ] {
            let env = resolve_term_env(project_type, shell);
            assert_eq!(env[0], ("TERM".to_string(), TERM_PORTABLE.to_string()));
            assert_eq!(terminfo(&env), None);
        }
    }

    #[test]
    fn an_inherited_terminfo_does_not_follow_a_portable_term() {
        // Launching the app from one of its own sixel PowerShell tabs leaves
        // an inline `hex:` TERMINFO in this process' environment. A Git Bash
        // session announces `xterm-256color`, so that value describes the
        // wrong terminal - and an ncurses older than 6.3 reads the inline form
        // as a directory path and fails to resolve anything at all.
        for (project_type, shell) in [
            (ProjectType::Local, ShellType::GitBash),
            (ProjectType::Local, ShellType::Wsl),
            (ProjectType::Ssh, ShellType::RemoteBash),
            (ProjectType::Wsl, ShellType::Wsl),
        ] {
            let removed = resolve_term_env_remove(project_type, shell);
            assert!(
                removed.iter().any(|name| name == "TERMINFO"),
                "{project_type:?}/{shell:?} should strip TERMINFO"
            );
            assert!(removed.iter().any(|name| name == "TERMINFO_DIRS"));
        }

        // A sixel session sets its own; stripping it would undo the fix.
        for shell in [ShellType::Powershell, ShellType::Cmd] {
            assert!(resolve_term_env_remove(ProjectType::Local, shell).is_empty());
        }
    }

    #[test]
    fn terminfo_entry_is_a_compiled_description_named_xterm_sixel() {
        let entry = terminfo_sixel_entry();
        let hex = entry
            .strip_prefix("hex:")
            .expect("ncurses only reads an inline entry tagged hex: or b64:");
        assert_eq!(hex.len() % 2, 0, "hex encodes whole bytes");
        let bytes: Vec<u8> = hex
            .as_bytes()
            .chunks(2)
            .map(|pair| {
                let digits = std::str::from_utf8(pair).expect("hex is ASCII");
                u8::from_str_radix(digits, 16).expect("entry is hex encoded")
            })
            .collect();
        // Header: magic, then the size of the null-terminated name section.
        let magic = u16::from_le_bytes([bytes[0], bytes[1]]);
        assert!(
            magic == 0o432 || magic == 0o1036,
            "unexpected terminfo magic {magic:o}"
        );
        let names_len = u16::from_le_bytes([bytes[2], bytes[3]]) as usize;
        let names = std::str::from_utf8(&bytes[12..12 + names_len - 1]).expect("names are ASCII");
        assert!(
            names.split('|').any(|name| name == TERM_SIXEL),
            "ncurses rejects an inline entry whose names do not include TERM: {names}"
        );
    }

    #[test]
    fn term_stays_portable_for_projects_reached_through_another_host() {
        // The shell type is irrelevant here: `ssh` and `wsl.exe` hand TERM to a
        // host whose terminfo database has never heard of `xterm-sixel`.
        for project_type in [ProjectType::Ssh, ProjectType::Wsl] {
            assert_eq!(
                resolve_term(project_type, ShellType::Powershell),
                TERM_PORTABLE
            );
        }
    }

    #[test]
    fn profile_needs_environment_distinguishes_none() {
        let mut p = local_profile(ShellType::Powershell);
        assert!(!profile_needs_environment(&p));
        p.environment_type = EnvironmentType::Conda;
        assert!(profile_needs_environment(&p));
    }
}
