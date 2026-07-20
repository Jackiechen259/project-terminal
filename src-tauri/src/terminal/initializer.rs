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

/// Build initialization commands for a POSIX remote shell. These commands
/// run after SSH authentication and `cd`, as part of the server-side shell
/// command. Failures are made visible but do not prevent the final interactive
/// shell from opening.
pub fn build_remote_initialization_commands(profile: &TerminalProfile) -> AppResult<Vec<String>> {
    if !matches!(
        profile.shell_type,
        ShellType::RemoteDefault
            | ShellType::RemoteBash
            | ShellType::RemoteZsh
            | ShellType::RemoteFish
            | ShellType::Custom
    ) {
        return Err(AppError::Configuration(
            "Remote initialization requires a remote shell profile".into(),
        ));
    }

    let mut commands = Vec::new();
    if let Some(vars) = &profile.environment_variables {
        for (name, value) in vars {
            if !is_posix_environment_name(name) {
                return Err(AppError::Configuration(format!(
                    "Invalid remote environment variable name: {name}"
                )));
            }
            commands.push(format!("export {name}={}", escape_bash_argument(value)));
        }
    }

    let activation = match profile.environment_type {
        EnvironmentType::None => None,
        EnvironmentType::Conda => Some(build_remote_conda_activation(profile)?),
        EnvironmentType::Venv => Some(build_remote_venv_activation(profile)),
        EnvironmentType::Poetry => Some(build_remote_poetry_activation(profile)),
        EnvironmentType::Uv => Some(build_remote_venv_activation(profile)),
        EnvironmentType::Custom => profile
            .activation_command
            .clone()
            .filter(|command| !command.trim().is_empty()),
    };
    if let Some(activation) = activation {
        commands.push(format!(
            "if ! ( {activation} ); then printf '%s\\n' 'Project Terminal: environment initialization failed; remote shell remains available' >&2; fi"
        ));
    }
    commands.extend(
        profile
            .startup_commands
            .iter()
            .filter(|command| !command.trim().is_empty())
            .cloned(),
    );
    Ok(commands)
}

fn is_posix_environment_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(first) if first == '_' || first.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn build_remote_conda_activation(profile: &TerminalProfile) -> AppResult<String> {
    let conda = profile.conda.as_ref().ok_or_else(|| {
        AppError::Configuration("Conda environment type requires conda config".into())
    })?;
    if !conda.auto_activate {
        return Ok(":".into());
    }
    if conda.activation_mode != CondaActivationMode::ShellHook {
        return Err(AppError::Configuration(
            "Remote Conda requires the shell-hook activation method; use Custom activation for another command".into(),
        ));
    }
    let root = conda
        .conda_root
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppError::Configuration(
                "Remote Conda shell-hook activation requires a remote condaRoot".into(),
            )
        })?;
    let target = conda
        .environment_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            conda
                .environment_path
                .as_deref()
                .filter(|value| !value.trim().is_empty())
        })
        .ok_or_else(|| {
            AppError::Configuration(
                "Remote Conda activation requires an environment name or path".into(),
            )
        })?;
    let hook = format!("{}/etc/profile.d/conda.sh", root.trim_end_matches('/'));
    Ok(format!(
        ". {} && conda activate {}",
        escape_bash_argument(&hook),
        escape_bash_argument(target)
    ))
}

fn build_remote_venv_activation(profile: &TerminalProfile) -> String {
    let path = profile
        .environment_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(".venv");
    let script = format!("{}/bin/activate", path.trim_end_matches('/'));
    format!(". {}", escape_bash_argument(&script))
}

fn build_remote_poetry_activation(profile: &TerminalProfile) -> String {
    if profile.environment_path.is_some() {
        return build_remote_venv_activation(profile);
    }
    "pt_poetry_env=\"$(poetry env info --path)\" && . \"$pt_poetry_env/bin/activate\"".into()
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
                ShellType::GitBash
                | ShellType::Wsl
                | ShellType::Bash
                | ShellType::Zsh
                | ShellType::Fish
                | ShellType::Sh => {
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
        ShellType::Bash | ShellType::Zsh | ShellType::Fish | ShellType::Sh => Ok(
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
        ShellType::Wsl | ShellType::Bash | ShellType::Zsh | ShellType::Fish | ShellType::Sh => {
            // Local POSIX shells (and WSL) use the venv's Unix activate script.
            // `path` may be relative to the project cwd.
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

    #[test]
    fn remote_conda_uses_remote_posix_paths_and_soft_failure_wrapper() {
        let mut profile = base_profile();
        profile.shell_type = ShellType::RemoteBash;
        profile.environment_type = EnvironmentType::Conda;
        profile.conda = Some(CondaEnvironmentConfig {
            conda_executable: None,
            conda_root: Some("/opt/miniconda3".into()),
            environment_name: Some("ml".into()),
            environment_path: None,
            activation_mode: CondaActivationMode::ShellHook,
            auto_activate: true,
        });
        let commands = build_remote_initialization_commands(&profile).unwrap();
        assert!(commands[0].contains("/opt/miniconda3/etc/profile.d/conda.sh"));
        assert!(commands[0].contains("conda activate ml"));
        assert!(commands[0].contains("remote shell remains available"));
    }

    #[test]
    fn remote_environment_variable_names_are_validated() {
        let mut profile = base_profile();
        profile.shell_type = ShellType::RemoteBash;
        profile.environment_variables = Some(std::collections::BTreeMap::from([(
            "BAD-NAME".into(),
            "x".into(),
        )]));
        assert!(build_remote_initialization_commands(&profile).is_err());
    }
}
