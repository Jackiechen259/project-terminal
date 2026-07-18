//! Environment initialization commands for PTY sessions.
//!
//! Phase 3.6/3.7 covers Conda, venv, Poetry, uv, and custom initializations.
//! The manager resolves the profile's environment type and returns a script
//! or command sequence that the session executor injects immediately after
//! spawning but before user startup commands.

use crate::error::{AppError, AppResult};
use crate::profile::{
    CondaActivationMode, CondaEnvironmentConfig, EnvironmentType, ShellType, TerminalProfile,
};
use crate::terminal::escaping::{
    escape_bash_argument, escape_cmd_argument, escape_powershell_argument,
};

/// Returns a string (often containing newlines) that activates the requested
/// environment within the specified shell.
///
/// If no environment is requested, returns an empty string.
pub fn build_activation_script(profile: &TerminalProfile) -> AppResult<String> {
    match profile.environment_type {
        EnvironmentType::None => Ok(String::new()),
        EnvironmentType::Conda => {
            let conda = profile.conda.as_ref().ok_or_else(|| {
                AppError::Configuration("Conda environment type requires conda config".into())
            })?;
            if !conda.auto_activate {
                return Ok(String::new());
            }
            build_conda_activation(profile.shell_type, conda)
        }
        EnvironmentType::Venv => build_venv_activation(profile),
        EnvironmentType::Custom => {
            if let Some(cmd) = &profile.activation_command {
                Ok(format!("{cmd}\r\n"))
            } else {
                Ok(String::new())
            }
        }
        EnvironmentType::Poetry => build_poetry_activation(profile),
        EnvironmentType::Uv => build_uv_activation(profile),
    }
}

fn escape_cmd_activation_argument(input: &str) -> AppResult<String> {
    // CMD expands `%VAR%` before caret escapes are applied. Delayed expansion
    // likewise treats `!VAR!` specially. There is no reliable literal form for
    // either sequence when injecting a command into an interactive CMD
    // session, so reject those saved values instead of silently activating a
    // different path or environment.
    if input.contains(['%', '!', '\r', '\n']) {
        return Err(AppError::Configuration(
            "CMD expansion syntax is not supported in activation paths or names".into(),
        ));
    }
    Ok(escape_cmd_argument(input))
}

fn build_conda_activation(shell: ShellType, config: &CondaEnvironmentConfig) -> AppResult<String> {
    let target = match (&config.environment_name, &config.environment_path) {
        (Some(name), _) if !name.trim().is_empty() => name.as_str(),
        (_, Some(path)) if !path.trim().is_empty() => path.as_str(),
        _ => {
            return Err(AppError::Configuration(
                "Conda activation requires an environment name or path".into(),
            ))
        }
    };

    match config.activation_mode {
        CondaActivationMode::ShellHook => {
            let root = config.conda_root.as_deref().unwrap_or("");
            if root.trim().is_empty() {
                return Err(AppError::Configuration(
                    "Shell-hook activation requires condaRoot".into(),
                ));
            }
            match shell {
                ShellType::Powershell => {
                    let hook = format!("{root}\\shell\\condabin\\conda-hook.ps1");
                    let escaped_hook = escape_powershell_argument(&hook);
                    let escaped_target = escape_powershell_argument(target);
                    Ok(format!(
                        "& {escaped_hook}\r\nconda activate {escaped_target}\r\n"
                    ))
                }
                ShellType::GitBash | ShellType::Wsl => {
                    // Requires the root to be mapped correctly (e.g. /c/ or /mnt/c/).
                    // For now we assume the frontend sends the valid mapped path.
                    let hook = format!("{root}/etc/profile.d/conda.sh");
                    let escaped_hook = escape_bash_argument(&hook);
                    let escaped_target = escape_bash_argument(target);
                    Ok(format!(
                        "source {escaped_hook}\r\nconda activate {escaped_target}\r\n"
                    ))
                }
                _ => Err(AppError::Configuration(format!(
                    "Shell-hook activation not supported for {:?}",
                    shell
                ))),
            }
        }
        CondaActivationMode::CondaBat => match shell {
            ShellType::Cmd => {
                let root = config.conda_root.as_deref().unwrap_or("");
                if root.trim().is_empty() {
                    return Err(AppError::Configuration(
                        "Conda-bat activation requires condaRoot".into(),
                    ));
                }
                let bat = format!("{root}\\condabin\\conda.bat");
                let escaped_bat = escape_cmd_activation_argument(&bat)?;
                let escaped_target = escape_cmd_activation_argument(target)?;
                Ok(format!("call {escaped_bat} activate {escaped_target}\r\n"))
            }
            _ => Err(AppError::Configuration(format!(
                "Conda-bat activation is only valid for CMD, got {:?}",
                shell
            ))),
        },
        CondaActivationMode::ManualCommand => {
            // Unused for MVP auto-activation, frontend passes Custom type instead.
            Ok(String::new())
        }
    }
}

fn build_poetry_activation(profile: &TerminalProfile) -> AppResult<String> {
    if profile.environment_path.is_some() {
        return build_venv_activation(profile);
    }

    // `poetry env info --path` resolves the managed virtual environment
    // without creating or synchronizing it. Each shell activates the resolved
    // path in-place; `poetry shell` would create a nested shell and race later
    // startup commands.
    match profile.shell_type {
        ShellType::Powershell => Ok(
            "$ptPoetryEnv = poetry env info --path\r\n\
             if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($ptPoetryEnv)) { Write-Error 'Could not resolve the Poetry environment path' } else { & \"$ptPoetryEnv\\Scripts\\Activate.ps1\" }\r\n"
                .into(),
        ),
        ShellType::Cmd => Ok(
            "for /f \"delims=\" %P in ('poetry env info --path') do call \"%P\\Scripts\\activate.bat\"\r\n"
                .into(),
        ),
        ShellType::GitBash => Ok(
            "pt_poetry_env=\"$(poetry env info --path)\" && source \"$(cygpath -u \"$pt_poetry_env\")/Scripts/activate\"\r\n"
                .into(),
        ),
        ShellType::Wsl => Ok(
            "pt_poetry_env=\"$(poetry env info --path)\" && source \"$pt_poetry_env/bin/activate\"\r\n"
                .into(),
        ),
        _ => Err(AppError::Configuration(format!(
            "Poetry activation not supported for {:?}",
            profile.shell_type
        ))),
    }
}

fn build_uv_activation(profile: &TerminalProfile) -> AppResult<String> {
    // uv environments are standard venvs, typically in `.venv`.
    // We can just reuse the venv logic.
    build_venv_activation(profile)
}

fn build_venv_activation(profile: &TerminalProfile) -> AppResult<String> {
    let path = profile.environment_path.as_deref().unwrap_or(".venv");
    match profile.shell_type {
        ShellType::Powershell => {
            let script = format!("{path}\\Scripts\\Activate.ps1");
            let escaped = escape_powershell_argument(&script);
            Ok(format!("& {escaped}\r\n"))
        }
        ShellType::Cmd => {
            let script = format!("{path}\\Scripts\\activate.bat");
            let escaped = escape_cmd_activation_argument(&script)?;
            Ok(format!("{escaped}\r\n"))
        }
        ShellType::GitBash => {
            let path_fwd = path.replace('\\', "/");
            let script = format!("{path_fwd}/Scripts/activate");
            let escaped = escape_bash_argument(&script);
            Ok(format!("source {escaped}\r\n"))
        }
        ShellType::Wsl => {
            let path_fwd = path.replace('\\', "/");
            let script = format!("{path_fwd}/bin/activate");
            let escaped = escape_bash_argument(&script);
            Ok(format!("source {escaped}\r\n"))
        }
        _ => Err(AppError::Configuration(format!(
            "Venv activation not supported for {:?}",
            profile.shell_type
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn base_profile() -> TerminalProfile {
        TerminalProfile {
            id: "p".into(),
            project_id: "p1".into(),
            name: "test".into(),
            shell_type: ShellType::Powershell,
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
    fn none_returns_empty() {
        assert_eq!(build_activation_script(&base_profile()).unwrap(), "");
    }

    #[test]
    fn conda_powershell_shell_hook() {
        let mut p = base_profile();
        p.environment_type = EnvironmentType::Conda;
        p.conda = Some(CondaEnvironmentConfig {
            conda_executable: None,
            conda_root: Some("D:\\conda".into()),
            environment_name: Some("test-env".into()),
            environment_path: None,
            activation_mode: CondaActivationMode::ShellHook,
            auto_activate: true,
        });
        let script = build_activation_script(&p).unwrap();
        assert_eq!(
            script,
            "& D:\\conda\\shell\\condabin\\conda-hook.ps1\r\nconda activate test-env\r\n"
        );
    }

    #[test]
    fn conda_cmd_rejects_expansion_syntax_in_saved_configuration() {
        for environment_name in ["%PATH%", "!PATH!"] {
            let mut p = base_profile();
            p.shell_type = ShellType::Cmd;
            p.environment_type = EnvironmentType::Conda;
            p.conda = Some(CondaEnvironmentConfig {
                conda_executable: None,
                conda_root: Some("C:\\conda".into()),
                environment_name: Some(environment_name.into()),
                environment_path: None,
                activation_mode: CondaActivationMode::CondaBat,
                auto_activate: true,
            });

            let error = build_activation_script(&p).unwrap_err();

            assert!(matches!(
                error,
                AppError::Configuration(message) if message.contains("CMD expansion")
            ));
        }
    }

    #[test]
    fn conda_cmd_conda_bat() {
        let mut p = base_profile();
        p.shell_type = ShellType::Cmd;
        p.environment_type = EnvironmentType::Conda;
        p.conda = Some(CondaEnvironmentConfig {
            conda_executable: None,
            conda_root: Some("C:\\conda".into()),
            environment_name: Some("test-env".into()),
            environment_path: None,
            activation_mode: CondaActivationMode::CondaBat,
            auto_activate: true,
        });
        let script = build_activation_script(&p).unwrap();
        assert_eq!(
            script,
            "call \"C:\\conda\\condabin\\conda.bat\" activate test-env\r\n"
        );
    }

    #[test]
    fn venv_powershell() {
        let mut p = base_profile();
        p.environment_type = EnvironmentType::Venv;
        p.environment_path = Some(".myvenv".into());
        let script = build_activation_script(&p).unwrap();
        assert_eq!(script, "& .myvenv\\Scripts\\Activate.ps1\r\n");
    }

    #[test]
    fn venv_cmd() {
        let mut p = base_profile();
        p.shell_type = ShellType::Cmd;
        p.environment_type = EnvironmentType::Venv;
        let script = build_activation_script(&p).unwrap();
        assert_eq!(script, "\".venv\\Scripts\\activate.bat\"\r\n");
    }

    #[test]
    fn poetry_powershell_resolves_venv_path_and_activates_it() {
        let mut p = base_profile();
        p.environment_type = EnvironmentType::Poetry;

        let script = build_activation_script(&p).unwrap();

        assert_eq!(
            script,
            "$ptPoetryEnv = poetry env info --path\r\n\
             if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($ptPoetryEnv)) { Write-Error 'Could not resolve the Poetry environment path' } else { & \"$ptPoetryEnv\\Scripts\\Activate.ps1\" }\r\n"
        );
    }

    #[test]
    fn venv_git_bash_uses_windows_scripts_activation() {
        let mut p = base_profile();
        p.shell_type = ShellType::GitBash;
        p.environment_type = EnvironmentType::Venv;

        assert_eq!(
            build_activation_script(&p).unwrap(),
            "source .venv/Scripts/activate\r\n"
        );
    }

    #[test]
    fn poetry_git_bash_normalizes_windows_venv_path() {
        let mut p = base_profile();
        p.shell_type = ShellType::GitBash;
        p.environment_type = EnvironmentType::Poetry;

        assert_eq!(
            build_activation_script(&p).unwrap(),
            "pt_poetry_env=\"$(poetry env info --path)\" && source \"$(cygpath -u \"$pt_poetry_env\")/Scripts/activate\"\r\n"
        );
    }

    #[test]
    fn venv_wsl_uses_linux_bin_activation() {
        let mut p = base_profile();
        p.shell_type = ShellType::Wsl;
        p.environment_type = EnvironmentType::Venv;

        assert_eq!(
            build_activation_script(&p).unwrap(),
            "source .venv/bin/activate\r\n"
        );
    }
}
