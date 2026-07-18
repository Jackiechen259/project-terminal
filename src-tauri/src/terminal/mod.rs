//! Terminal module: PTY sessions, manager, shell escaping.
//!
//! Phase 3 supports local PowerShell/CMD/custom-shell sessions. SSH
//! (`ssh.exe`) sessions arrive in Phase 6; environment initialization
//! (Conda/venv/Poetry/uv) arrives in Phase 3.6/3.7.

pub mod conda;
pub mod escaping;
pub mod initializer;
pub mod manager;
pub mod session;

pub use initializer::build_activation_script;
pub use manager::TerminalManager;
pub use session::{SessionSpawn, SessionStatus, TerminalOutput, TerminalSession};

use crate::error::{AppError, AppResult};
use crate::profile::{EnvironmentType, ShellType, TerminalProfile};

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

/// True when the profile's environment is anything other than `none`.
pub fn profile_needs_environment(profile: &TerminalProfile) -> bool {
    profile.environment_type != EnvironmentType::None
}

fn find_powershell() -> AppResult<(String, bool)> {
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
    fn profile_needs_environment_distinguishes_none() {
        let mut p = local_profile(ShellType::Powershell);
        assert!(!profile_needs_environment(&p));
        p.environment_type = EnvironmentType::Conda;
        assert!(profile_needs_environment(&p));
    }
}
