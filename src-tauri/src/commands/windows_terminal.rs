//! Import visible profiles from the local Windows Terminal settings files.
//!
//! Windows Terminal stores JSON-with-comments and accepts trailing commas, so
//! the input is normalised before deserialisation. Imported profiles remain
//! project-scoped and are de-duplicated against existing Project Terminal
//! profiles.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::profile::{EnvironmentType, ShellType, TerminalProfile};
use crate::project::ProjectType;
use crate::state::{new_id, AppState};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsTerminalImportResult {
    pub imported: Vec<TerminalProfile>,
    pub skipped_count: usize,
    pub source_files: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsTerminalSettings {
    #[serde(default)]
    default_profile: Option<String>,
    #[serde(default)]
    profiles: WindowsTerminalProfiles,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(untagged)]
enum WindowsTerminalProfiles {
    Modern {
        #[serde(default)]
        defaults: WindowsTerminalProfile,
        #[serde(default)]
        list: Vec<WindowsTerminalProfile>,
    },
    Legacy(Vec<WindowsTerminalProfile>),
    #[default]
    Missing,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsTerminalProfile {
    #[serde(default)]
    guid: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    commandline: Option<String>,
    #[serde(default)]
    starting_directory: Option<String>,
    #[serde(default)]
    hidden: Option<bool>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    environment: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug)]
struct ImportedProfileDraft {
    guid: Option<String>,
    name: String,
    shell_type: ShellType,
    shell_executable: Option<String>,
    shell_args: Vec<String>,
    environment_variables: Option<BTreeMap<String, String>>,
    wsl_distribution: Option<String>,
    wsl_working_directory: Option<String>,
}

impl WindowsTerminalProfiles {
    fn resolved(self) -> Vec<WindowsTerminalProfile> {
        match self {
            Self::Modern { defaults, list } => list
                .into_iter()
                .map(|profile| profile.with_defaults(&defaults))
                .collect(),
            Self::Legacy(list) => list,
            Self::Missing => Vec::new(),
        }
    }
}

impl WindowsTerminalProfile {
    fn with_defaults(mut self, defaults: &Self) -> Self {
        if self.commandline.is_none() {
            self.commandline.clone_from(&defaults.commandline);
        }
        if self.starting_directory.is_none() {
            self.starting_directory
                .clone_from(&defaults.starting_directory);
        }
        if self.source.is_none() {
            self.source.clone_from(&defaults.source);
        }
        if self.hidden.is_none() {
            self.hidden = defaults.hidden;
        }
        let mut environment = defaults.environment.clone();
        environment.extend(self.environment);
        self.environment = environment;
        self
    }
}

pub fn import_windows_terminal_profiles_inner(
    state: &AppState,
    project_id: &str,
) -> AppResult<WindowsTerminalImportResult> {
    let paths = windows_terminal_settings_paths()?;
    import_windows_terminal_profiles_from_paths_inner(state, project_id, &paths)
}

fn import_windows_terminal_profiles_from_paths_inner(
    state: &AppState,
    project_id: &str,
    paths: &[PathBuf],
) -> AppResult<WindowsTerminalImportResult> {
    let project = state.projects.get(project_id)?;
    require_local_project(&project)?;

    let existing_paths: Vec<&PathBuf> = paths.iter().filter(|path| path.is_file()).collect();
    if existing_paths.is_empty() {
        return Err(AppError::Configuration(
            "Windows Terminal settings were not found".into(),
        ));
    }

    let mut drafts = Vec::new();
    let mut skipped_count = 0;
    let mut source_files = Vec::new();
    let mut parse_errors = Vec::new();
    let mut default_guids = HashSet::new();

    for path in existing_paths {
        let source = path.to_string_lossy().into_owned();
        match read_windows_terminal_settings(path) {
            Ok(settings) => {
                if let Some(guid) = settings.default_profile {
                    default_guids.insert(normalize_guid(&guid));
                }
                for profile in settings.profiles.resolved() {
                    if profile.hidden.unwrap_or(false) {
                        skipped_count += 1;
                    } else if let Some(draft) = convert_profile(profile) {
                        drafts.push(draft);
                    } else {
                        skipped_count += 1;
                    }
                }
                source_files.push(source);
            }
            Err(error) => parse_errors.push(format!("{source}: {error}")),
        }
    }

    if source_files.is_empty() {
        return Err(AppError::Configuration(format!(
            "Could not read Windows Terminal settings: {}",
            parse_errors.join("; ")
        )));
    }

    state.with_config_write(|| {
        // Re-check under the configuration lock so a concurrent project
        // deletion cannot leave imported profiles orphaned.
        let project = state.projects.get(project_id)?;
        require_local_project(&project)?;
        let mut collection = state.profiles.load()?;
        let mut signatures: HashSet<String> = collection
            .profiles
            .iter()
            .filter(|profile| profile.project_id == project_id)
            .map(profile_signature)
            .collect();
        let project_has_profiles = !signatures.is_empty();
        let mut imported = Vec::new();
        let mut assigned_default = false;

        for draft in drafts {
            let now = Utc::now();
            let is_default = !project_has_profiles
                && !assigned_default
                && draft
                    .guid
                    .as_deref()
                    .map(normalize_guid)
                    .is_some_and(|guid| default_guids.contains(&guid));
            assigned_default |= is_default;
            let profile = TerminalProfile {
                id: new_id("profile"),
                project_id: project_id.to_string(),
                name: draft.name,
                shell_type: draft.shell_type,
                shell_executable: draft.shell_executable,
                shell_args: draft.shell_args,
                environment_type: EnvironmentType::None,
                environment_name: None,
                environment_path: None,
                conda: None,
                activation_command: None,
                startup_commands: Vec::new(),
                environment_variables: draft.environment_variables,
                wsl_distribution: draft.wsl_distribution,
                wsl_working_directory: draft.wsl_working_directory,
                remote_shell_command: None,
                is_default,
                show_in_context_menu: true,
                created_at: now,
                updated_at: now,
            };
            let signature = profile_signature(&profile);
            if !signatures.insert(signature) {
                skipped_count += 1;
                continue;
            }
            profile.validate()?;
            collection.profiles.push(profile.clone());
            imported.push(profile);
        }

        if !project_has_profiles && !assigned_default {
            if let Some(first_imported) = imported.first_mut() {
                first_imported.is_default = true;
                if let Some(saved) = collection
                    .profiles
                    .iter_mut()
                    .find(|profile| profile.id == first_imported.id)
                {
                    saved.is_default = true;
                }
            }
        }

        if !imported.is_empty() {
            state.profiles.save(&collection)?;
        }

        Ok(WindowsTerminalImportResult {
            imported,
            skipped_count,
            source_files,
        })
    })
}

fn require_local_project(project: &crate::project::Project) -> AppResult<()> {
    if project.project_type == ProjectType::Local {
        Ok(())
    } else {
        Err(AppError::Configuration(
            "Windows Terminal profiles can only be imported into a local project".into(),
        ))
    }
}

fn read_windows_terminal_settings(path: &Path) -> AppResult<WindowsTerminalSettings> {
    let contents = fs::read_to_string(path)?;
    let normalised = normalise_jsonc(contents.trim_start_matches('\u{feff}'));
    serde_json::from_str(&normalised).map_err(|error| {
        AppError::Configuration(format!("Invalid Windows Terminal settings JSON: {error}"))
    })
}

fn convert_profile(profile: WindowsTerminalProfile) -> Option<ImportedProfileDraft> {
    let name = profile.name?.trim().to_string();
    if name.is_empty() {
        return None;
    }

    let source = profile.source.unwrap_or_default();
    let source_lower = source.to_ascii_lowercase();
    let commandline = profile
        .commandline
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let (shell_type, shell_executable, mut shell_args) = if let Some(commandline) = commandline {
        let mut parts = split_windows_commandline(commandline);
        if parts.is_empty() {
            return None;
        }
        let executable = expand_percent_variables(&parts.remove(0));
        let executable_lower = executable.replace('/', "\\").to_ascii_lowercase();
        let file_name = executable_lower
            .rsplit('\\')
            .next()
            .unwrap_or(&executable_lower);
        let shell_type = match file_name {
            "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe" => ShellType::Powershell,
            "cmd" | "cmd.exe" => ShellType::Cmd,
            "wsl" | "wsl.exe" => ShellType::Wsl,
            "bash" | "bash.exe"
                if executable_lower.contains("\\git\\") || source_lower.contains("git") =>
            {
                ShellType::GitBash
            }
            _ => ShellType::Custom,
        };
        let explicit_executable = if shell_type == ShellType::Wsl {
            None
        } else {
            Some(executable)
        };
        (shell_type, explicit_executable, parts)
    } else if source_lower.contains("powershell") {
        (
            ShellType::Powershell,
            Some("pwsh.exe".to_string()),
            Vec::new(),
        )
    } else if source_lower.contains("wsl") {
        (ShellType::Wsl, None, Vec::new())
    } else {
        return None;
    };

    let mut wsl_distribution = None;
    let mut wsl_working_directory = None;
    if shell_type == ShellType::Wsl {
        let (remaining, distribution, directory) = extract_wsl_options(shell_args);
        shell_args = remaining;
        wsl_distribution =
            distribution.or_else(|| source_lower.contains("wsl").then(|| name.clone()));
        wsl_working_directory = directory.or_else(|| {
            profile
                .starting_directory
                .as_deref()
                .and_then(parse_wsl_starting_directory)
        });
    }

    let environment_variables = profile
        .environment
        .into_iter()
        .filter_map(|(key, value)| value.as_str().map(|value| (key, value.to_string())))
        .collect::<BTreeMap<_, _>>();

    Some(ImportedProfileDraft {
        guid: profile.guid,
        name,
        shell_type,
        shell_executable,
        shell_args,
        environment_variables: (!environment_variables.is_empty()).then_some(environment_variables),
        wsl_distribution,
        wsl_working_directory,
    })
}

fn extract_wsl_options(args: Vec<String>) -> (Vec<String>, Option<String>, Option<String>) {
    let mut remaining = Vec::new();
    let mut distribution = None;
    let mut directory = None;
    let mut index = 0;
    while index < args.len() {
        let argument = &args[index];
        if matches!(argument.as_str(), "-d" | "--distribution") && index + 1 < args.len() {
            distribution = Some(args[index + 1].clone());
            index += 2;
        } else if argument == "--cd" && index + 1 < args.len() {
            directory = Some(args[index + 1].clone());
            index += 2;
        } else {
            remaining.push(argument.clone());
            index += 1;
        }
    }
    (remaining, distribution, directory)
}

fn parse_wsl_starting_directory(value: &str) -> Option<String> {
    let normalised = value.replace('\\', "/");
    let without_prefix = normalised
        .strip_prefix("//wsl$/")
        .or_else(|| normalised.strip_prefix("//wsl.localhost/"))?;
    let (_, path) = without_prefix.split_once('/')?;
    Some(format!("/{}", path.trim_start_matches('/')))
}

fn profile_signature(profile: &TerminalProfile) -> String {
    format!(
        "{}\u{1f}{:?}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
        profile.name.trim().to_ascii_lowercase(),
        profile.shell_type,
        profile
            .shell_executable
            .as_deref()
            .unwrap_or_default()
            .replace('/', "\\")
            .to_ascii_lowercase(),
        profile.shell_args.join("\u{1e}"),
        profile.wsl_distribution.as_deref().unwrap_or_default(),
        profile.wsl_working_directory.as_deref().unwrap_or_default(),
        serde_json::to_string(&profile.environment_variables).unwrap_or_default(),
    )
}

fn normalize_guid(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('{')
        .trim_end_matches('}')
        .to_ascii_lowercase()
}

fn expand_percent_variables(value: &str) -> String {
    let mut result = String::new();
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        result.push_str(&rest[..start]);
        let after_start = &rest[start + 1..];
        let Some(end) = after_start.find('%') else {
            result.push_str(&rest[start..]);
            return result;
        };
        let key = &after_start[..end];
        match std::env::var(key) {
            Ok(replacement) => result.push_str(&replacement),
            Err(_) => {
                result.push('%');
                result.push_str(key);
                result.push('%');
            }
        }
        rest = &after_start[end + 1..];
    }
    result.push_str(rest);
    result
}

fn split_windows_commandline(value: &str) -> Vec<String> {
    let mut arguments = Vec::new();
    let mut current = String::new();
    let mut chars = value.chars().peekable();
    let mut quoted = false;

    while let Some(character) = chars.next() {
        match character {
            '"' => quoted = !quoted,
            '\\' if chars.peek() == Some(&'"') => {
                chars.next();
                current.push('"');
            }
            character if character.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    arguments.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(character),
        }
    }
    if !current.is_empty() {
        arguments.push(current);
    }
    arguments
}

fn normalise_jsonc(value: &str) -> String {
    let characters: Vec<char> = value.chars().collect();
    let mut without_comments = String::with_capacity(value.len());
    let mut index = 0;
    let mut in_string = false;
    let mut escaped = false;

    while index < characters.len() {
        let character = characters[index];
        if in_string {
            without_comments.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }

        if character == '"' {
            in_string = true;
            without_comments.push(character);
            index += 1;
        } else if character == '/' && characters.get(index + 1) == Some(&'/') {
            index += 2;
            while index < characters.len() && characters[index] != '\n' {
                index += 1;
            }
        } else if character == '/' && characters.get(index + 1) == Some(&'*') {
            index += 2;
            while index + 1 < characters.len()
                && !(characters[index] == '*' && characters[index + 1] == '/')
            {
                if characters[index] == '\n' {
                    without_comments.push('\n');
                }
                index += 1;
            }
            index = (index + 2).min(characters.len());
        } else {
            without_comments.push(character);
            index += 1;
        }
    }

    let characters: Vec<char> = without_comments.chars().collect();
    let mut result = String::with_capacity(without_comments.len());
    let mut index = 0;
    let mut in_string = false;
    let mut escaped = false;
    while index < characters.len() {
        let character = characters[index];
        if in_string {
            result.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
        } else if character == '"' {
            in_string = true;
            result.push(character);
        } else if character == ',' {
            let next = characters[index + 1..]
                .iter()
                .find(|next| !next.is_whitespace());
            if !matches!(next, Some('}') | Some(']')) {
                result.push(character);
            }
        } else {
            result.push(character);
        }
        index += 1;
    }
    result
}

fn windows_terminal_settings_paths() -> AppResult<Vec<PathBuf>> {
    if !cfg!(windows) {
        return Err(AppError::Configuration(
            "Windows Terminal import is only available on Windows".into(),
        ));
    }
    let local_app_data = std::env::var_os("LOCALAPPDATA").ok_or_else(|| {
        AppError::Configuration("The LOCALAPPDATA directory is unavailable".into())
    })?;
    let root = PathBuf::from(local_app_data);
    Ok([
        root.join("Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json"),
        root.join(
            "Packages/Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe/LocalState/settings.json",
        ),
        root.join(
            "Packages/Microsoft.WindowsTerminalCanary_8wekyb3d8bbwe/LocalState/settings.json",
        ),
        root.join("Microsoft/Windows Terminal/settings.json"),
    ]
    .into_iter()
    .collect())
}

#[tauri::command]
pub fn import_windows_terminal_profiles(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> AppResult<WindowsTerminalImportResult> {
    import_windows_terminal_profiles_inner(&state, &project_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{ProfileRepository, TemplateRepository};
    use crate::project::{LocalProjectConfig, Project, ProjectRepository};
    use crate::ssh::SshConnectionRepository;

    #[test]
    fn accepts_comments_urls_and_trailing_commas() {
        let input = r#"{
          // A comment
          "profiles": {
            "list": [{
              "name": "Docs",
              "commandline": "cmd.exe /k echo https://example.com",
            },],
          },
        }"#;
        let settings: WindowsTerminalSettings =
            serde_json::from_str(&normalise_jsonc(input)).unwrap();
        let profiles = settings.profiles.resolved();
        assert_eq!(profiles.len(), 1);
        assert_eq!(
            profiles[0].commandline.as_deref(),
            Some("cmd.exe /k echo https://example.com")
        );
    }

    #[test]
    fn converts_powershell_command_and_environment() {
        let profile = WindowsTerminalProfile {
            name: Some("PowerShell 7".into()),
            commandline: Some(r#""C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo"#.into()),
            environment: BTreeMap::from([(
                "PYTHONUTF8".into(),
                serde_json::Value::String("1".into()),
            )]),
            ..Default::default()
        };
        let converted = convert_profile(profile).unwrap();
        assert_eq!(converted.shell_type, ShellType::Powershell);
        assert_eq!(
            converted.shell_executable.as_deref(),
            Some(r"C:\Program Files\PowerShell\7\pwsh.exe")
        );
        assert_eq!(converted.shell_args, vec!["-NoLogo"]);
        assert_eq!(
            converted
                .environment_variables
                .unwrap()
                .get("PYTHONUTF8")
                .map(String::as_str),
            Some("1")
        );
    }

    #[test]
    fn converts_wsl_options_to_structured_fields() {
        let profile = WindowsTerminalProfile {
            name: Some("Ubuntu".into()),
            commandline: Some("wsl.exe --distribution Ubuntu --cd /srv bash".into()),
            ..Default::default()
        };
        let converted = convert_profile(profile).unwrap();
        assert_eq!(converted.shell_type, ShellType::Wsl);
        assert_eq!(converted.wsl_distribution.as_deref(), Some("Ubuntu"));
        assert_eq!(converted.wsl_working_directory.as_deref(), Some("/srv"));
        assert_eq!(converted.shell_args, vec!["bash"]);
        assert!(converted.shell_executable.is_none());
    }

    #[test]
    fn inherits_relevant_profile_defaults() {
        let profiles = WindowsTerminalProfiles::Modern {
            defaults: WindowsTerminalProfile {
                commandline: Some("cmd.exe /k".into()),
                environment: BTreeMap::from([(
                    "COMMON".into(),
                    serde_json::Value::String("yes".into()),
                )]),
                ..Default::default()
            },
            list: vec![WindowsTerminalProfile {
                name: Some("Inherited".into()),
                ..Default::default()
            }],
        }
        .resolved();
        assert_eq!(profiles[0].commandline.as_deref(), Some("cmd.exe /k"));
        assert_eq!(
            profiles[0].environment.get("COMMON"),
            Some(&serde_json::Value::String("yes".into()))
        );
    }

    #[test]
    fn imports_once_and_skips_the_same_profile_next_time() {
        let root = tempfile::tempdir().unwrap();
        let project_path = root.path().join("project");
        fs::create_dir_all(&project_path).unwrap();
        let state = AppState::from_repositories(
            ProjectRepository::new(root.path().join("projects.json")),
            ProfileRepository::new(root.path().join("profiles.json")),
            TemplateRepository::new(root.path().join("templates.json")),
            SshConnectionRepository::new(root.path().join("ssh.json")),
        );
        let now = Utc::now();
        state
            .projects
            .upsert(Project {
                id: "local".into(),
                name: "Local".into(),
                project_type: ProjectType::Local,
                local: Some(LocalProjectConfig {
                    path: project_path.to_string_lossy().into_owned(),
                }),
                ssh: None,
                wsl: None,
                default_profile_id: None,
                created_at: now,
                updated_at: now,
            })
            .unwrap();
        let settings_path = root.path().join("settings.json");
        fs::write(
            &settings_path,
            r#"{
              "defaultProfile": "{abc}",
              "profiles": { "list": [{
                "guid": "{abc}",
                "name": "PowerShell 7",
                "commandline": "pwsh.exe -NoLogo"
              }] }
            }"#,
        )
        .unwrap();

        let first = import_windows_terminal_profiles_from_paths_inner(
            &state,
            "local",
            std::slice::from_ref(&settings_path),
        )
        .unwrap();
        assert_eq!(first.imported.len(), 1);
        assert!(first.imported[0].is_default);

        let second = import_windows_terminal_profiles_from_paths_inner(
            &state,
            "local",
            std::slice::from_ref(&settings_path),
        )
        .unwrap();
        assert!(second.imported.is_empty());
        assert_eq!(second.skipped_count, 1);
        assert_eq!(state.profiles.list_for_project("local").unwrap().len(), 1);
    }
}
