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
pub mod shell_integration;
pub mod session;
pub mod wsl;

use std::path::PathBuf;
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

/// Should this shell be configured for UTF-8 output unless told otherwise?
///
/// Only where it is both needed and safe:
///
/// - **PowerShell**: yes. 5.1 defaults `[Console]::OutputEncoding` to the OEM
///   code page and `$OutputEncoding` to ASCII, so piping to a native
///   executable mangles anything non-ASCII. Setting the .NET properties is
///   safe, and pwsh 7 - which already does this - is unaffected by setting it
///   again.
/// - **CMD**: no. The only lever is `chcp 65001`, which genuinely breaks
///   `more`, some `for /f` loops and OEM-code-page batch scripts. Available
///   per profile for users who want it.
/// - **Git Bash**: no. It is started as a login shell, so `/etc/profile`
///   configures the locale properly; forcing one on top would paper over a
///   defect rather than fix it.
/// - **WSL and SSH**: no, and this one is a trap. A Windows-side variable does
///   not cross into either, and forcing a locale the far side has not
///   generated makes every command print `setlocale: cannot change locale`.
pub fn forces_utf8_by_default(shell_type: ShellType) -> bool {
    matches!(shell_type, ShellType::Powershell)
}

/// The command that configures a shell for UTF-8 output, if it has one.
///
/// Returned as a single line: it is typed into the PTY, and a multi-line
/// command makes PSReadLine repaint wrapped fragments into the terminal.
pub fn utf8_preamble(shell_type: ShellType) -> Option<&'static str> {
    match shell_type {
        // Both properties matter and they are different things.
        // `[Console]::OutputEncoding` is how .NET decodes what native programs
        // write; `$OutputEncoding` is how PowerShell encodes what it pipes to
        // them. `UTF8Encoding::new($false)` is UTF-8 without a BOM - the BOM
        // would otherwise appear at the head of every redirected file.
        ShellType::Powershell => Some(
            "$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
        ),
        ShellType::Cmd => Some("chcp 65001>nul"),
        _ => None,
    }
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
/// Per plan Â§22 step 5: "Resolve Shell or SSH Client". For Phase 3 we only
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
            let executable = find_git_bash()?;
            // Start it the way `git-bash.exe` does. `-i` because the readiness
            // handshake and startup commands are typed into it.
            let mut args = vec!["--login".to_string(), "-i".to_string()];
            args.extend(profile.shell_args.clone());
            Ok((executable, args))
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

/// Derive a Git installation root from a `git.exe` found on PATH.
///
/// Git for Windows lays out its `git.exe` in one of two places, and both are
/// a fixed distance from the install root:
///
/// - `<root>\cmd\git.exe`
/// - `<root>\mingw64\bin\git.exe` (also `mingw32`)
///
/// Going through PATH covers scoop, chocolatey and winget layouts for free,
/// none of which put Git under `Program Files`.
pub(crate) fn git_root_from_git_exe(git_exe: &std::path::Path) -> Option<PathBuf> {
    let parent = git_exe.parent()?;
    match parent.file_name()?.to_string_lossy().to_ascii_lowercase().as_str() {
        "cmd" => Some(parent.parent()?.to_path_buf()),
        "bin" => {
            let grandparent = parent.parent()?;
            let name = grandparent.file_name()?.to_string_lossy().to_ascii_lowercase();
            // `<root>\mingw64\bin` and `<root>\bin` are both real layouts.
            if name.starts_with("mingw") {
                Some(grandparent.parent()?.to_path_buf())
            } else {
                Some(grandparent.to_path_buf())
            }
        }
        _ => None,
    }
}

/// Candidate Git installation roots, best first.
fn git_install_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut push = |root: PathBuf| {
        if !roots.contains(&root) {
            roots.push(root);
        }
    };

    // A Git already on PATH is the one the user works with.
    if let Some(git) = which("git.exe").or_else(|| which("git")) {
        if let Some(root) = git_root_from_git_exe(std::path::Path::new(&git)) {
            push(root);
        }
    }
    if let Some(root) = std::env::var_os("GIT_INSTALL_ROOT") {
        push(PathBuf::from(root));
    }
    for variable in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(dir) = std::env::var_os(variable) {
            push(std::path::Path::new(&dir).join("Git"));
        }
    }
    // The default location for a non-administrator install, which the old
    // Program Files-only search missed entirely.
    if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
        push(std::path::Path::new(&dir).join("Programs").join("Git"));
    }
    roots
}

/// Where Git Bash lives, and how `git-bash.exe` itself starts it.
///
/// `usr\bin\bash.exe` is what the shipped launcher runs; `bin\bash.exe` is a
/// wrapper that skips the MSYS environment setup. Starting the wrapper without
/// `--login` leaves `/etc/profile` unsourced, so `PATH` is missing
/// `/mingw64/bin` and `/usr/bin`, `MSYSTEM` is unset and no locale is
/// configured - the shell works, but `awk`, `perl` and `openssl` behave
/// differently from a real Git Bash, and UTF-8 output arrives mangled.
fn find_git_bash() -> AppResult<String> {
    for root in git_install_roots() {
        for relative in [["usr", "bin", "bash.exe"], ["bin", "bash.exe", ""]] {
            let mut candidate = root.clone();
            for segment in relative.iter().filter(|s| !s.is_empty()) {
                candidate = candidate.join(segment);
            }
            if candidate.is_file() {
                return Ok(candidate.to_string_lossy().into_owned());
            }
        }
    }
    Err(AppError::ShellNotFound(
        "Git Bash was not found. Install Git for Windows, or set the shell executable on this profile.".into(),
    ))
}

/// Arguments and environment that make a Git Bash session behave like the one
/// `git-bash.exe` opens.
///
/// `CHERE_INVOKING` is not optional. Without it `--login` sources
/// `/etc/profile`, which `cd`s to `$HOME` - and the project working directory,
/// the entire point of opening the terminal, is lost.
pub(crate) fn git_bash_login_environment(executable: &str) -> Vec<(String, String)> {
    let mut env = vec![("CHERE_INVOKING".to_string(), "1".to_string())];
    // MSYSTEM selects which of the MSYS2 subsystem trees `/etc/profile` puts
    // on PATH. Git for Windows 64-bit uses MINGW64.
    let msystem = if executable.to_ascii_lowercase().contains("mingw32") {
        "MINGW32"
    } else {
        "MINGW64"
    };
    env.push(("MSYSTEM".to_string(), msystem.to_string()));
    env
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
            force_utf8: None,
            shell_integration: None,
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
    fn derives_a_git_install_root_from_git_on_path() {
        use std::path::Path;
        // Covers the two layouts Git for Windows ships, which between them
        // account for the scoop, chocolatey and winget installs the old
        // Program Files-only search never found.
        assert_eq!(
            git_root_from_git_exe(Path::new(r"C:\Tools\Git\cmd\git.exe")),
            Some(PathBuf::from(r"C:\Tools\Git"))
        );
        assert_eq!(
            git_root_from_git_exe(Path::new(r"C:\Tools\Git\mingw64\bin\git.exe")),
            Some(PathBuf::from(r"C:\Tools\Git"))
        );
        assert_eq!(
            git_root_from_git_exe(Path::new(r"C:\Tools\Git\mingw32\bin\git.exe")),
            Some(PathBuf::from(r"C:\Tools\Git"))
        );
        assert_eq!(
            git_root_from_git_exe(Path::new(r"C:\Tools\Git\bin\git.exe")),
            Some(PathBuf::from(r"C:\Tools\Git"))
        );
        // Not a layout we recognise: better to fall through to the well-known
        // directories than to invent a root.
        assert_eq!(git_root_from_git_exe(Path::new(r"C:\git.exe")), None);
    }

    #[test]
    fn git_bash_starts_the_way_its_own_launcher_does() {
        let profile = local_profile(ShellType::GitBash);
        // Resolution needs Git installed, so only assert the arguments when it
        // is - the environment below is what matters and is pure.
        if let Ok((executable, args)) = resolve_local_shell(&profile) {
            assert_eq!(&args[..2], &["--login".to_string(), "-i".to_string()]);
            assert!(executable.to_ascii_lowercase().ends_with("bash.exe"));
        }

        let env = git_bash_login_environment(r"C:\Program Files\Git\usr\bin\bash.exe");
        // Without CHERE_INVOKING, `--login` sources /etc/profile, which cds to
        // $HOME - and the project directory, the entire point of opening the
        // terminal, is gone.
        assert!(env.contains(&("CHERE_INVOKING".into(), "1".into())));
        assert!(env.contains(&("MSYSTEM".into(), "MINGW64".into())));
        assert!(git_bash_login_environment(r"C:\Git\mingw32\bin\bash.exe")
            .contains(&("MSYSTEM".into(), "MINGW32".into())));
    }

    #[test]
    fn forces_utf8_only_where_it_is_both_needed_and_safe() {
        // PowerShell 5.1 defaults $OutputEncoding to ASCII, so anything
        // non-ASCII piped to a native executable is mangled.
        assert!(forces_utf8_by_default(ShellType::Powershell));
        // `chcp 65001` breaks `more`, some `for /f` loops and OEM-code-page
        // batch scripts, so CMD is opt-in.
        assert!(!forces_utf8_by_default(ShellType::Cmd));
        // Git Bash is started as a login shell and configures its own locale.
        assert!(!forces_utf8_by_default(ShellType::GitBash));
        // The trap: a Windows-side locale does not cross into either, and
        // forcing one the far side has not generated makes every command
        // print `setlocale: cannot change locale`.
        assert!(!forces_utf8_by_default(ShellType::Wsl));
        assert!(!forces_utf8_by_default(ShellType::RemoteBash));

        // The preamble is typed into the PTY, so it has to be one line: a
        // multi-line command makes PSReadLine repaint wrapped fragments.
        for shell in [ShellType::Powershell, ShellType::Cmd] {
            let preamble = utf8_preamble(shell).expect("preamble");
            assert!(!preamble.contains('\n'), "{shell:?}: {preamble}");
        }
        assert_eq!(utf8_preamble(ShellType::Wsl), None);
        assert_eq!(utf8_preamble(ShellType::GitBash), None);
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
