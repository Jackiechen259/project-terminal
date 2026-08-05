//! Terminal profile domain model. Mirrors the frontend `TerminalProfile`
//! type. All structs use `#[serde(rename_all = "camelCase")]`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShellType {
    Powershell,
    Cmd,
    GitBash,
    Wsl,
    /// Local POSIX shells. Offered on Linux/macOS hosts; on Windows they are
    /// hidden from the shell picker but still deserialize from saved profiles
    /// so a profile created on one platform remains loadable on another.
    Bash,
    Zsh,
    Fish,
    Sh,
    RemoteDefault,
    RemoteBash,
    RemoteZsh,
    RemoteFish,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EnvironmentType {
    None,
    Conda,
    Venv,
    Poetry,
    Uv,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CondaActivationMode {
    ShellHook,
    CondaBat,
    ManualCommand,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CondaEnvironmentConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conda_executable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conda_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_path: Option<String>,
    pub activation_mode: CondaActivationMode,
    pub auto_activate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfile {
    pub id: String,
    pub project_id: String,

    pub name: String,

    pub shell_type: ShellType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_executable: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shell_args: Vec<String>,

    pub environment_type: EnvironmentType,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_path: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub conda: Option<CondaEnvironmentConfig>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub activation_command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub startup_commands: Vec<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment_variables: Option<std::collections::BTreeMap<String, String>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub wsl_distribution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wsl_working_directory: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_shell_command: Option<String>,

    /// Whether to configure the shell for UTF-8 output at startup.
    ///
    /// `None` takes the per-shell default from
    /// [`crate::terminal::forces_utf8_by_default`]. Present as an override
    /// because the right answer is not the same for every shell: Windows
    /// PowerShell 5.1 defaults `$OutputEncoding` to ASCII and mangles
    /// non-ASCII the moment output is piped to a native executable, while
    /// `chcp 65001` in CMD breaks `more`, some `for /f` loops, and any batch
    /// script that prints through the OEM code page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force_utf8: Option<bool>,

    /// Whether to inject the shell-integration hooks (OSC 7 and OSC 133).
    ///
    /// Off unless asked for. The hooks wrap the user's prompt, and a prompt
    /// people have spent time on is not something to modify by default -
    /// Windows Terminal ships its script and lets users install it for the
    /// same reason. `None` means off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_integration: Option<bool>,

    /// Terminal colour scheme id for this profile, overriding the global
    /// selection.
    ///
    /// The point is not decoration. A terminal organised by project, where the
    /// SSH-to-production profile is unmistakably red and local development is
    /// calm blue, is a safety mechanism - the same reasoning behind the
    /// PS1-turns-red-on-prod convention people hand-roll badly.
    ///
    /// Colour only, deliberately. Per-profile typography would make a split
    /// with two profiles in it look broken.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_scheme_id: Option<String>,

    /// Accent for this profile's tab and focused-pane ring. `#rrggbb`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent_color: Option<String>,


    pub is_default: bool,
    #[serde(default = "default_true")]
    pub show_in_context_menu: bool,

    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

fn default_true() -> bool {
    true
}

impl TerminalProfile {
    /// Validate required fields. Name and project_id must be non-empty.
    pub fn validate(&self) -> Result<(), crate::error::AppError> {
        if self.id.trim().is_empty() {
            return Err(crate::error::AppError::Configuration(
                "Profile id must not be empty".to_string(),
            ));
        }
        if self.project_id.trim().is_empty() {
            return Err(crate::error::AppError::Configuration(
                "Profile must reference a project".to_string(),
            ));
        }
        if self.name.trim().is_empty() {
            return Err(crate::error::AppError::Configuration(
                "Profile name must not be empty".to_string(),
            ));
        }
        // The accent reaches a CSS custom property. Validating the shape here
        // means no consumer has to sanitize it.
        if let Some(accent) = &self.accent_color {
            if !crate::appearance::color_scheme::is_hex_color(accent) {
                return Err(crate::error::AppError::Configuration(format!(
                    "Profile accent color must be #rrggbb, got {accent}"
                )));
            }
        }
        // Conda config requires at least a name or a path, when present.
        if let Some(conda) = &self.conda {
            let has_name = conda
                .environment_name
                .as_ref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            let has_path = conda
                .environment_path
                .as_ref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            if !has_name && !has_path {
                return Err(crate::error::AppError::Configuration(
                    "Conda config must specify environmentName or environmentPath".into(),
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        Utc::now()
    }

    fn sample_profile() -> TerminalProfile {
        TerminalProfile {
            id: "profile-1".into(),
            project_id: "p1".into(),
            name: "PowerShell".into(),
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
            force_utf8: None,
            shell_integration: None,
            color_scheme_id: None,
            accent_color: None,
            is_default: true,
            show_in_context_menu: true,
            created_at: now(),
            updated_at: now(),
        }
    }

    #[test]
    fn serializes_camel_case_kebab_enums() {
        let json = serde_json::to_string(&sample_profile()).unwrap();
        assert!(json.contains("\"shellType\":\"powershell\""));
        assert!(json.contains("\"environmentType\":\"none\""));
        assert!(json.contains("\"isDefault\":true"));
        assert!(json.contains("\"showInContextMenu\":true"));
        assert!(json.contains("\"projectId\":\"p1\""));
        // skipped optional fields
        assert!(!json.contains("conda"));
        assert!(!json.contains("startupCommands"));
        assert!(!json.contains("shellArgs"));
    }

    #[test]
    fn frontend_shape_json_deserializes() {
        let json = r#"{
            "id": "profile-frontend",
            "projectId": "p-fe",
            "name": "Conda",
            "shellType": "powershell",
            "environmentType": "conda",
            "conda": {
                "condaRoot": "D:\\program\\anaconda",
                "environmentName": "smolvla",
                "activationMode": "shell-hook",
                "autoActivate": true
            },
            "environmentVariables": { "PYTHONUTF8": "1" },
            "isDefault": false,
            "createdAt": "2026-07-18T00:00:00Z",
            "updatedAt": "2026-07-18T00:00:00Z"
        }"#;
        let parsed: TerminalProfile = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.project_id, "p-fe");
        assert_eq!(parsed.shell_type, ShellType::Powershell);
        assert_eq!(parsed.environment_type, EnvironmentType::Conda);
        assert!(parsed.show_in_context_menu);
        let conda = parsed.conda.unwrap();
        assert_eq!(conda.activation_mode, CondaActivationMode::ShellHook);
        assert_eq!(conda.environment_name.as_deref(), Some("smolvla"));
        assert_eq!(
            parsed.environment_variables.unwrap().get("PYTHONUTF8"),
            Some(&"1".to_string())
        );
    }

    #[test]
    fn validate_rejects_an_accent_that_is_not_a_hex_colour() {
        // It reaches a CSS custom property, so validating the shape here
        // keeps every consumer from having to sanitize it.
        let mut p = sample_profile();
        p.accent_color = Some("red; background: url(x)".into());
        assert!(p.validate().is_err());
        p.accent_color = Some("#ff8800".into());
        p.validate().unwrap();
        p.accent_color = None;
        p.validate().unwrap();
    }

    #[test]
    fn a_profile_saved_before_appearance_existed_still_loads() {
        // `serde(default)` plus `skip_serializing_if` is what keeps existing
        // profiles.json files readable without a migration.
        let json = serde_json::to_value(sample_profile()).unwrap();
        assert!(json.get("colorSchemeId").is_none());
        assert!(json.get("accentColor").is_none());

        let mut without = json.clone();
        without.as_object_mut().unwrap().remove("shellIntegration");
        let parsed: TerminalProfile = serde_json::from_value(without).unwrap();
        assert_eq!(parsed.color_scheme_id, None);
        assert_eq!(parsed.accent_color, None);
    }

    #[test]
    fn validate_rejects_missing_project_id() {
        let mut p = sample_profile();
        p.project_id = "".into();
        assert!(p.validate().is_err());
    }

    #[test]
    fn validate_rejects_conda_without_name_or_path() {
        let mut p = sample_profile();
        p.environment_type = EnvironmentType::Conda;
        p.conda = Some(CondaEnvironmentConfig {
            conda_executable: None,
            conda_root: None,
            environment_name: None,
            environment_path: None,
            activation_mode: CondaActivationMode::ShellHook,
            auto_activate: true,
        });
        assert!(p.validate().is_err());
        p.conda = Some(CondaEnvironmentConfig {
            environment_name: Some("smolvla".into()),
            environment_path: None,
            ..p.conda.unwrap()
        });
        assert!(p.validate().is_ok());
    }

    #[test]
    fn round_trip_preserves_all_fields() {
        let mut p = sample_profile();
        p.shell_executable = Some("pwsh.exe".into());
        p.shell_args = vec!["-NoLogo".into()];
        p.startup_commands = vec!["echo hi".into()];
        let json = serde_json::to_string(&p).unwrap();
        let parsed: TerminalProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.shell_args, vec!["-NoLogo".to_string()]);
        assert_eq!(parsed.startup_commands, vec!["echo hi".to_string()]);
    }
}
