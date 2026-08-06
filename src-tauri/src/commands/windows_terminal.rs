//! Import visible profiles and colour schemes from the local Windows Terminal
//! settings files.
//!
//! Windows Terminal stores JSON-with-comments and accepts trailing commas, so
//! the input is normalised before deserialisation. The same drafts feed two
//! destinations: project-scoped `TerminalProfile`s, and project-independent
//! `ProfileTemplate`s.
//!
//! Importing is a two-step flow: a scan command lists what the settings files
//! offer, and the import command takes back the keys the user picked. The key
//! is the launch-configuration signature, which doubles as the de-duplication
//! key, so a stale selection can never import something twice.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::appearance::TerminalColorScheme;
use crate::error::{AppError, AppResult};
use crate::profile::{EnvironmentType, ProfileTemplate, ShellType, TemplateIcon, TerminalProfile};
use crate::project::ProjectType;
use crate::state::{new_id, AppState};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsTerminalImportResult {
    pub imported: Vec<TerminalProfile>,
    pub skipped_count: usize,
    pub source_files: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsTerminalTemplateImportResult {
    pub imported: Vec<ProfileTemplate>,
    pub skipped_count: usize,
    pub source_files: Vec<String>,
}

/// One selectable entry in the import picker.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsTerminalCandidate {
    /// Launch-configuration signature. Also the de-duplication key.
    pub key: String,
    pub name: String,
    pub shell_type: ShellType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_executable: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub shell_args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wsl_distribution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wsl_working_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_variables: Option<BTreeMap<String, String>>,
    /// This is the profile Windows Terminal opens by default.
    pub is_windows_terminal_default: bool,
    /// An entry with the same launch configuration is already present at the
    /// destination, so importing it would be a no-op.
    pub already_exists: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsTerminalScanResult {
    pub candidates: Vec<WindowsTerminalCandidate>,
    /// Entries the settings files contained but that cannot be offered:
    /// hidden profiles, unconvertible ones, and in-file duplicates.
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
    /// Colour schemes sit in the same file as the profiles, so importing them
    /// costs nothing beyond this field and the conversion below.
    #[serde(default)]
    schemes: Vec<WindowsTerminalScheme>,
}

/// A `schemes[]` entry.
///
/// Windows Terminal names the sixth ANSI colour `purple`; every other terminal
/// and xterm.js itself call it magenta. It has no `cursorAccent` and no
/// separate selection foreground.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsTerminalScheme {
    name: String,
    background: String,
    foreground: String,
    #[serde(default)]
    cursor_color: Option<String>,
    #[serde(default)]
    selection_background: Option<String>,
    black: String,
    red: String,
    green: String,
    yellow: String,
    blue: String,
    purple: String,
    cyan: String,
    white: String,
    bright_black: String,
    bright_red: String,
    bright_green: String,
    bright_yellow: String,
    bright_blue: String,
    bright_purple: String,
    bright_cyan: String,
    bright_white: String,
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

impl ImportedProfileDraft {
    fn signature(&self) -> String {
        configuration_signature(
            &self.name,
            self.shell_type,
            self.shell_executable.as_deref(),
            &self.shell_args,
            self.wsl_distribution.as_deref(),
            self.wsl_working_directory.as_deref(),
            self.environment_variables.as_ref(),
        )
    }

    fn is_windows_terminal_default(&self, default_guids: &HashSet<String>) -> bool {
        self.guid
            .as_deref()
            .map(normalize_guid)
            .is_some_and(|guid| default_guids.contains(&guid))
    }
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

/// Profiles read from every readable settings file, plus the counters both
/// import destinations report back to the frontend.
#[derive(Debug, Default)]
struct CollectedDrafts {
    drafts: Vec<ImportedProfileDraft>,
    skipped_count: usize,
    source_files: Vec<String>,
    default_guids: HashSet<String>,
}

fn collect_windows_terminal_drafts(paths: &[PathBuf]) -> AppResult<CollectedDrafts> {
    let existing_paths: Vec<&PathBuf> = paths.iter().filter(|path| path.is_file()).collect();
    if existing_paths.is_empty() {
        return Err(AppError::Configuration(
            "Windows Terminal settings were not found".into(),
        ));
    }

    let mut collected = CollectedDrafts::default();
    let mut parse_errors = Vec::new();

    for path in existing_paths {
        let source = path.to_string_lossy().into_owned();
        match read_windows_terminal_settings(path) {
            Ok(settings) => {
                if let Some(guid) = settings.default_profile {
                    collected.default_guids.insert(normalize_guid(&guid));
                }
                for profile in settings.profiles.resolved() {
                    if profile.hidden.unwrap_or(false) {
                        collected.skipped_count += 1;
                    } else if let Some(draft) = convert_profile(profile) {
                        collected.drafts.push(draft);
                    } else {
                        collected.skipped_count += 1;
                    }
                }
                collected.source_files.push(source);
            }
            Err(error) => parse_errors.push(format!("{source}: {error}")),
        }
    }

    if collected.source_files.is_empty() {
        return Err(AppError::Configuration(format!(
            "Could not read Windows Terminal settings: {}",
            parse_errors.join("; ")
        )));
    }

    Ok(collected)
}

/// Turn collected drafts into the picker list: de-duplicate within the scan,
/// and flag the entries the destination already holds.
fn build_scan_result(
    collected: CollectedDrafts,
    existing_signatures: &HashSet<String>,
) -> WindowsTerminalScanResult {
    let CollectedDrafts {
        drafts,
        mut skipped_count,
        source_files,
        default_guids,
    } = collected;

    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for draft in drafts {
        let key = draft.signature();
        if !seen.insert(key.clone()) {
            skipped_count += 1;
            continue;
        }
        candidates.push(WindowsTerminalCandidate {
            already_exists: existing_signatures.contains(&key),
            key,
            is_windows_terminal_default: draft.is_windows_terminal_default(&default_guids),
            name: draft.name,
            shell_type: draft.shell_type,
            shell_executable: draft.shell_executable,
            shell_args: draft.shell_args,
            wsl_distribution: draft.wsl_distribution,
            wsl_working_directory: draft.wsl_working_directory,
            environment_variables: draft.environment_variables,
        });
    }

    WindowsTerminalScanResult {
        candidates,
        skipped_count,
        source_files,
    }
}

pub fn scan_windows_terminal_profiles_inner(
    state: &AppState,
    project_id: &str,
) -> AppResult<WindowsTerminalScanResult> {
    let paths = windows_terminal_settings_paths()?;
    scan_windows_terminal_profiles_from_paths_inner(state, project_id, &paths)
}

fn scan_windows_terminal_profiles_from_paths_inner(
    state: &AppState,
    project_id: &str,
    paths: &[PathBuf],
) -> AppResult<WindowsTerminalScanResult> {
    let project = state.projects.get(project_id)?;
    require_local_project(&project)?;
    let collected = collect_windows_terminal_drafts(paths)?;
    let existing: HashSet<String> = state
        .profiles
        .load()?
        .profiles
        .iter()
        .filter(|profile| profile.project_id == project_id)
        .map(profile_signature)
        .collect();
    Ok(build_scan_result(collected, &existing))
}

pub fn scan_windows_terminal_templates_inner(
    state: &AppState,
) -> AppResult<WindowsTerminalScanResult> {
    let paths = windows_terminal_settings_paths()?;
    scan_windows_terminal_templates_from_paths_inner(state, &paths)
}

fn scan_windows_terminal_templates_from_paths_inner(
    state: &AppState,
    paths: &[PathBuf],
) -> AppResult<WindowsTerminalScanResult> {
    let collected = collect_windows_terminal_drafts(paths)?;
    let existing: HashSet<String> = state
        .templates
        .list()?
        .iter()
        .map(template_signature)
        .collect();
    Ok(build_scan_result(collected, &existing))
}

/// Keep only the drafts the user ticked in the picker. An unknown key simply
/// selects nothing, so a selection made against stale settings is harmless.
fn select_drafts(drafts: Vec<ImportedProfileDraft>, keys: &[String]) -> Vec<ImportedProfileDraft> {
    let selected: HashSet<&str> = keys.iter().map(String::as_str).collect();
    drafts
        .into_iter()
        .filter(|draft| selected.contains(draft.signature().as_str()))
        .collect()
}

pub fn import_windows_terminal_profiles_inner(
    state: &AppState,
    project_id: &str,
    keys: &[String],
) -> AppResult<WindowsTerminalImportResult> {
    let paths = windows_terminal_settings_paths()?;
    import_windows_terminal_profiles_from_paths_inner(state, project_id, keys, &paths)
}

fn import_windows_terminal_profiles_from_paths_inner(
    state: &AppState,
    project_id: &str,
    keys: &[String],
    paths: &[PathBuf],
) -> AppResult<WindowsTerminalImportResult> {
    let project = state.projects.get(project_id)?;
    require_local_project(&project)?;

    let CollectedDrafts {
        drafts,
        source_files,
        default_guids,
        ..
    } = collect_windows_terminal_drafts(paths)?;
    let drafts = select_drafts(drafts, keys);
    // Counts only selected entries the destination already held, so the
    // frontend can say how much of the selection was redundant.
    let mut skipped_count = 0;

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
                && draft.is_windows_terminal_default(&default_guids);
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
                force_utf8: None,
                shell_integration: None,
                color_scheme_id: None,
                accent_color: None,
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

pub fn import_windows_terminal_templates_inner(
    state: &AppState,
    keys: &[String],
) -> AppResult<WindowsTerminalTemplateImportResult> {
    let paths = windows_terminal_settings_paths()?;
    import_windows_terminal_templates_from_paths_inner(state, keys, &paths)
}

fn import_windows_terminal_templates_from_paths_inner(
    state: &AppState,
    keys: &[String],
    paths: &[PathBuf],
) -> AppResult<WindowsTerminalTemplateImportResult> {
    let CollectedDrafts {
        drafts,
        source_files,
        ..
    } = collect_windows_terminal_drafts(paths)?;
    let drafts = select_drafts(drafts, keys);
    let mut skipped_count = 0;

    state.with_config_write(|| {
        let mut collection = state.templates.load()?;
        let mut signatures: HashSet<String> =
            collection.templates.iter().map(template_signature).collect();
        let mut imported = Vec::new();

        for draft in drafts {
            let now = Utc::now();
            let template = ProfileTemplate {
                id: new_id("tpl"),
                name: draft.name,
                icon: TemplateIcon::Terminal,
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
                force_utf8: None,
                shell_integration: None,
                color_scheme_id: None,
                accent_color: None,
                created_at: now,
                updated_at: now,
            };
            if !signatures.insert(template_signature(&template)) {
                skipped_count += 1;
                continue;
            }
            template.validate()?;
            collection.templates.push(template.clone());
            imported.push(template);
        }

        if !imported.is_empty() {
            state.templates.save(&collection)?;
        }

        Ok(WindowsTerminalTemplateImportResult {
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

/// Shared de-duplication key. Two entries collide when they would launch the
/// same shell the same way, so re-running an import is a no-op.
fn configuration_signature(
    name: &str,
    shell_type: ShellType,
    shell_executable: Option<&str>,
    shell_args: &[String],
    wsl_distribution: Option<&str>,
    wsl_working_directory: Option<&str>,
    environment_variables: Option<&BTreeMap<String, String>>,
) -> String {
    format!(
        "{}\u{1f}{:?}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
        name.trim().to_ascii_lowercase(),
        shell_type,
        shell_executable
            .unwrap_or_default()
            .replace('/', "\\")
            .to_ascii_lowercase(),
        shell_args.join("\u{1e}"),
        wsl_distribution.unwrap_or_default(),
        wsl_working_directory.unwrap_or_default(),
        serde_json::to_string(&environment_variables).unwrap_or_default(),
    )
}

fn profile_signature(profile: &TerminalProfile) -> String {
    configuration_signature(
        &profile.name,
        profile.shell_type,
        profile.shell_executable.as_deref(),
        &profile.shell_args,
        profile.wsl_distribution.as_deref(),
        profile.wsl_working_directory.as_deref(),
        profile.environment_variables.as_ref(),
    )
}

fn template_signature(template: &ProfileTemplate) -> String {
    configuration_signature(
        &template.name,
        template.shell_type,
        template.shell_executable.as_deref(),
        &template.shell_args,
        template.wsl_distribution.as_deref(),
        template.wsl_working_directory.as_deref(),
        template.environment_variables.as_ref(),
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

pub(crate) fn normalise_jsonc(value: &str) -> String {
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

/// One colour scheme offered in the import picker.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsTerminalSchemeCandidate {
    /// The scheme's name, which is also its de-duplication key: Windows
    /// Terminal itself requires names to be unique within a settings file.
    pub key: String,
    pub name: String,
    pub background: String,
    pub foreground: String,
    /// The sixteen ANSI colours in order, for the picker's swatch strip.
    pub ansi: Vec<String>,
    pub already_exists: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsTerminalSchemeScanResult {
    pub candidates: Vec<WindowsTerminalSchemeCandidate>,
    /// Schemes the file contained but that cannot be offered: malformed
    /// colours, or a name already seen in an earlier file.
    pub skipped_count: usize,
    pub source_files: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsTerminalSchemeImportResult {
    pub imported: Vec<TerminalColorScheme>,
    pub skipped_count: usize,
    pub source_files: Vec<String>,
}

/// Turn a Windows Terminal scheme into ours, or reject it.
///
/// Rejection is per scheme and total: a palette with one unparseable colour is
/// dropped rather than half-imported, because a scheme missing a background is
/// unusable in a way the user cannot see until they select it.
fn convert_scheme(scheme: WindowsTerminalScheme) -> Option<TerminalColorScheme> {
    let name = scheme.name.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let now = Utc::now();
    let converted = TerminalColorScheme {
        id: new_id("scheme"),
        name,
        // Windows Terminal leaves the cursor to the terminal when unset. The
        // foreground is what every terminal falls back to.
        cursor: scheme
            .cursor_color
            .unwrap_or_else(|| scheme.foreground.clone()),
        cursor_accent: Some(scheme.background.clone()),
        background: scheme.background,
        foreground: scheme.foreground,
        selection_background: scheme.selection_background,
        black: scheme.black,
        red: scheme.red,
        green: scheme.green,
        yellow: scheme.yellow,
        blue: scheme.blue,
        magenta: scheme.purple,
        cyan: scheme.cyan,
        white: scheme.white,
        bright_black: scheme.bright_black,
        bright_red: scheme.bright_red,
        bright_green: scheme.bright_green,
        bright_yellow: scheme.bright_yellow,
        bright_blue: scheme.bright_blue,
        bright_magenta: scheme.bright_purple,
        bright_cyan: scheme.bright_cyan,
        bright_white: scheme.bright_white,
        created_at: now,
        updated_at: now,
    };
    converted.validate().ok().map(|()| converted)
}

/// Read every settings file we can find and convert the schemes in them.
///
/// Returns the schemes in file order, the count dropped, and which files were
/// actually read - a missing Windows Terminal install is not an error, it just
/// contributes nothing.
fn collect_windows_terminal_schemes(
    paths: &[PathBuf],
) -> AppResult<(Vec<TerminalColorScheme>, usize, Vec<String>)> {
    let mut schemes: Vec<TerminalColorScheme> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut skipped = 0usize;
    let mut sources = Vec::new();

    for path in paths {
        if !path.is_file() {
            continue;
        }
        let settings = read_windows_terminal_settings(path)?;
        sources.push(path.to_string_lossy().into_owned());
        for scheme in settings.schemes {
            match convert_scheme(scheme) {
                // A scheme of the same name in a later file (Preview after
                // Stable, say) is the same scheme.
                Some(converted) if seen.insert(converted.name.to_lowercase()) => {
                    schemes.push(converted);
                }
                _ => skipped += 1,
            }
        }
    }

    Ok((schemes, skipped, sources))
}

pub fn scan_windows_terminal_color_schemes_inner(
    state: &AppState,
    paths: &[PathBuf],
) -> AppResult<WindowsTerminalSchemeScanResult> {
    let (schemes, skipped_count, source_files) = collect_windows_terminal_schemes(paths)?;
    let existing: HashSet<String> = state
        .color_schemes
        .list()?
        .into_iter()
        .map(|scheme| scheme.name.to_lowercase())
        .collect();
    let candidates = schemes
        .into_iter()
        .map(|scheme| WindowsTerminalSchemeCandidate {
            key: scheme.name.clone(),
            already_exists: existing.contains(&scheme.name.to_lowercase()),
            ansi: vec![
                scheme.black.clone(),
                scheme.red.clone(),
                scheme.green.clone(),
                scheme.yellow.clone(),
                scheme.blue.clone(),
                scheme.magenta.clone(),
                scheme.cyan.clone(),
                scheme.white.clone(),
                scheme.bright_black.clone(),
                scheme.bright_red.clone(),
                scheme.bright_green.clone(),
                scheme.bright_yellow.clone(),
                scheme.bright_blue.clone(),
                scheme.bright_magenta.clone(),
                scheme.bright_cyan.clone(),
                scheme.bright_white.clone(),
            ],
            background: scheme.background.clone(),
            foreground: scheme.foreground.clone(),
            name: scheme.name,
        })
        .collect();
    Ok(WindowsTerminalSchemeScanResult {
        candidates,
        skipped_count,
        source_files,
    })
}

pub fn import_windows_terminal_color_schemes_inner(
    state: &AppState,
    paths: &[PathBuf],
    keys: &[String],
) -> AppResult<WindowsTerminalSchemeImportResult> {
    let (schemes, skipped_count, source_files) = collect_windows_terminal_schemes(paths)?;
    let selected: HashSet<&str> = keys.iter().map(String::as_str).collect();
    state.with_config_write(|| {
        let existing: HashSet<String> = state
            .color_schemes
            .list()?
            .into_iter()
            .map(|scheme| scheme.name.to_lowercase())
            .collect();
        let mut imported = Vec::new();
        for scheme in schemes {
            if !selected.contains(scheme.name.as_str())
                || existing.contains(&scheme.name.to_lowercase())
            {
                continue;
            }
            imported.push(state.color_schemes.upsert(scheme)?);
        }
        Ok(WindowsTerminalSchemeImportResult {
            imported,
            skipped_count,
            source_files: source_files.clone(),
        })
    })
}

#[tauri::command]
pub fn scan_windows_terminal_color_schemes(
    state: tauri::State<'_, AppState>,
) -> AppResult<WindowsTerminalSchemeScanResult> {
    let paths = windows_terminal_settings_paths()?;
    scan_windows_terminal_color_schemes_inner(&state, &paths)
}

#[tauri::command]
pub fn import_windows_terminal_color_schemes(
    state: tauri::State<'_, AppState>,
    keys: Vec<String>,
) -> AppResult<WindowsTerminalSchemeImportResult> {
    let paths = windows_terminal_settings_paths()?;
    import_windows_terminal_color_schemes_inner(&state, &paths, &keys)
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
pub fn scan_windows_terminal_profiles(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> AppResult<WindowsTerminalScanResult> {
    scan_windows_terminal_profiles_inner(&state, &project_id)
}

#[tauri::command]
pub fn scan_windows_terminal_templates(
    state: tauri::State<'_, AppState>,
) -> AppResult<WindowsTerminalScanResult> {
    scan_windows_terminal_templates_inner(&state)
}

#[tauri::command]
pub fn import_windows_terminal_profiles(
    state: tauri::State<'_, AppState>,
    project_id: String,
    keys: Vec<String>,
) -> AppResult<WindowsTerminalImportResult> {
    import_windows_terminal_profiles_inner(&state, &project_id, &keys)
}

#[tauri::command]
pub fn import_windows_terminal_templates(
    state: tauri::State<'_, AppState>,
    keys: Vec<String>,
) -> AppResult<WindowsTerminalTemplateImportResult> {
    import_windows_terminal_templates_inner(&state, &keys)
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

    /// A `schemes` array as Windows Terminal writes one, with a JSONC comment
    /// and a trailing comma so the shared normaliser is exercised too.
    fn scheme_settings_json() -> &'static str {
        r##"{
          // Windows Terminal writes comments into this file.
          "profiles": { "list": [] },
          "schemes": [
            {
              "name": "Campbell",
              "background": "#0C0C0C", "foreground": "#CCCCCC",
              "cursorColor": "#FFFFFF", "selectionBackground": "#3A3A3A",
              "black": "#0C0C0C", "red": "#C50F1F", "green": "#13A10E",
              "yellow": "#C19C00", "blue": "#0037DA", "purple": "#881798",
              "cyan": "#3A96DD", "white": "#CCCCCC",
              "brightBlack": "#767676", "brightRed": "#E74856",
              "brightGreen": "#16C60C", "brightYellow": "#F9F1A5",
              "brightBlue": "#3B78FF", "brightPurple": "#B4009E",
              "brightCyan": "#61D6D6", "brightWhite": "#F2F2F2",
            },
            {
              "name": "Broken",
              "background": "not-a-colour", "foreground": "#CCCCCC",
              "black": "#0C0C0C", "red": "#C50F1F", "green": "#13A10E",
              "yellow": "#C19C00", "blue": "#0037DA", "purple": "#881798",
              "cyan": "#3A96DD", "white": "#CCCCCC",
              "brightBlack": "#767676", "brightRed": "#E74856",
              "brightGreen": "#16C60C", "brightYellow": "#F9F1A5",
              "brightBlue": "#3B78FF", "brightPurple": "#B4009E",
              "brightCyan": "#61D6D6", "brightWhite": "#F2F2F2"
            },
          ],
        }"##
    }

    #[test]
    fn imports_colour_schemes_from_the_same_settings_file_as_profiles() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::from_repositories(
            ProjectRepository::new(root.path().join("projects.json")),
            ProfileRepository::new(root.path().join("profiles.json")),
            TemplateRepository::new(root.path().join("templates.json")),
            SshConnectionRepository::new(root.path().join("ssh.json")),
        );
        let settings_path = root.path().join("settings.json");
        fs::write(&settings_path, scheme_settings_json()).unwrap();
        let paths = std::slice::from_ref(&settings_path);

        let scan = scan_windows_terminal_color_schemes_inner(&state, paths).unwrap();
        assert_eq!(scan.candidates.len(), 1);
        assert_eq!(scan.candidates[0].name, "Campbell");
        assert!(!scan.candidates[0].already_exists);
        // A scheme with an unusable colour is dropped whole rather than
        // half-imported.
        assert_eq!(scan.skipped_count, 1);
        assert_eq!(scan.candidates[0].ansi.len(), 16);

        let keys = vec!["Campbell".to_string()];
        let result = import_windows_terminal_color_schemes_inner(&state, paths, &keys).unwrap();
        assert_eq!(result.imported.len(), 1);
        let imported = &result.imported[0];
        // Windows Terminal's `purple` is everyone else's magenta.
        assert_eq!(imported.magenta, "#881798");
        assert_eq!(imported.bright_magenta, "#B4009E");
        assert_eq!(imported.cursor, "#FFFFFF");

        // Importing again is a no-op, and the scan now says so.
        let rescan = scan_windows_terminal_color_schemes_inner(&state, paths).unwrap();
        assert!(rescan.candidates[0].already_exists);
        let again = import_windows_terminal_color_schemes_inner(&state, paths, &keys).unwrap();
        assert!(again.imported.is_empty());
        assert_eq!(state.color_schemes.list().unwrap().len(), 1);
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

        let scan = scan_windows_terminal_profiles_from_paths_inner(
            &state,
            "local",
            std::slice::from_ref(&settings_path),
        )
        .unwrap();
        assert_eq!(scan.candidates.len(), 1);
        assert!(scan.candidates[0].is_windows_terminal_default);
        assert!(!scan.candidates[0].already_exists);
        let keys: Vec<String> = scan.candidates.iter().map(|c| c.key.clone()).collect();

        let first = import_windows_terminal_profiles_from_paths_inner(
            &state,
            "local",
            &keys,
            std::slice::from_ref(&settings_path),
        )
        .unwrap();
        assert_eq!(first.imported.len(), 1);
        assert!(first.imported[0].is_default);

        let rescan = scan_windows_terminal_profiles_from_paths_inner(
            &state,
            "local",
            std::slice::from_ref(&settings_path),
        )
        .unwrap();
        assert!(rescan.candidates[0].already_exists);

        let second = import_windows_terminal_profiles_from_paths_inner(
            &state,
            "local",
            &keys,
            std::slice::from_ref(&settings_path),
        )
        .unwrap();
        assert!(second.imported.is_empty());
        assert_eq!(second.skipped_count, 1);
        assert_eq!(state.profiles.list_for_project("local").unwrap().len(), 1);
    }

    #[test]
    fn imports_only_the_selected_profiles() {
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
        fs::write(&settings_path, TWO_PROFILE_SETTINGS).unwrap();

        let scan = scan_windows_terminal_profiles_from_paths_inner(
            &state,
            "local",
            std::slice::from_ref(&settings_path),
        )
        .unwrap();
        assert_eq!(scan.candidates.len(), 2);
        let ubuntu = scan
            .candidates
            .iter()
            .find(|candidate| candidate.name == "Ubuntu")
            .unwrap();

        let imported = import_windows_terminal_profiles_from_paths_inner(
            &state,
            "local",
            std::slice::from_ref(&ubuntu.key),
            std::slice::from_ref(&settings_path),
        )
        .unwrap();
        assert_eq!(imported.imported.len(), 1);
        assert_eq!(imported.imported[0].name, "Ubuntu");
        assert_eq!(state.profiles.list_for_project("local").unwrap().len(), 1);
    }

    #[test]
    fn imports_selected_templates_without_a_project_and_skips_duplicates() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::from_repositories(
            ProjectRepository::new(root.path().join("projects.json")),
            ProfileRepository::new(root.path().join("profiles.json")),
            TemplateRepository::new(root.path().join("templates.json")),
            SshConnectionRepository::new(root.path().join("ssh.json")),
        );
        let settings_path = root.path().join("settings.json");
        fs::write(&settings_path, TWO_PROFILE_SETTINGS).unwrap();

        let scan = scan_windows_terminal_templates_from_paths_inner(
            &state,
            std::slice::from_ref(&settings_path),
        )
        .unwrap();
        assert_eq!(scan.candidates.len(), 2);
        assert!(scan.candidates.iter().all(|c| !c.already_exists));
        let keys: Vec<String> = scan.candidates.iter().map(|c| c.key.clone()).collect();

        let first = import_windows_terminal_templates_from_paths_inner(
            &state,
            &keys,
            std::slice::from_ref(&settings_path),
        )
        .unwrap();
        assert_eq!(first.imported.len(), 2);
        assert_eq!(first.imported[0].icon, TemplateIcon::Terminal);
        assert_eq!(first.imported[1].wsl_distribution.as_deref(), Some("Ubuntu"));

        let rescan = scan_windows_terminal_templates_from_paths_inner(
            &state,
            std::slice::from_ref(&settings_path),
        )
        .unwrap();
        assert!(rescan.candidates.iter().all(|c| c.already_exists));

        let second = import_windows_terminal_templates_from_paths_inner(
            &state,
            &keys,
            std::slice::from_ref(&settings_path),
        )
        .unwrap();
        assert!(second.imported.is_empty());
        assert_eq!(second.skipped_count, 2);
        assert_eq!(state.templates.list().unwrap().len(), 2);
    }

    #[test]
    fn importing_an_empty_selection_writes_nothing() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::from_repositories(
            ProjectRepository::new(root.path().join("projects.json")),
            ProfileRepository::new(root.path().join("profiles.json")),
            TemplateRepository::new(root.path().join("templates.json")),
            SshConnectionRepository::new(root.path().join("ssh.json")),
        );
        let settings_path = root.path().join("settings.json");
        fs::write(&settings_path, TWO_PROFILE_SETTINGS).unwrap();

        let result = import_windows_terminal_templates_from_paths_inner(
            &state,
            &[],
            std::slice::from_ref(&settings_path),
        )
        .unwrap();
        assert!(result.imported.is_empty());
        assert!(state.templates.list().unwrap().is_empty());
    }

    #[test]
    fn scan_collapses_identical_entries_into_one_candidate() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::from_repositories(
            ProjectRepository::new(root.path().join("projects.json")),
            ProfileRepository::new(root.path().join("profiles.json")),
            TemplateRepository::new(root.path().join("templates.json")),
            SshConnectionRepository::new(root.path().join("ssh.json")),
        );
        let settings_path = root.path().join("settings.json");
        fs::write(
            &settings_path,
            r#"{
              "profiles": { "list": [
                { "name": "PowerShell 7", "commandline": "pwsh.exe -NoLogo" },
                { "name": "PowerShell 7", "commandline": "pwsh.exe -NoLogo" }
              ] }
            }"#,
        )
        .unwrap();

        let scan = scan_windows_terminal_templates_from_paths_inner(
            &state,
            std::slice::from_ref(&settings_path),
        )
        .unwrap();
        assert_eq!(scan.candidates.len(), 1);
        assert_eq!(scan.skipped_count, 1);
    }

    const TWO_PROFILE_SETTINGS: &str = r#"{
      "profiles": { "list": [
        { "name": "PowerShell 7", "commandline": "pwsh.exe -NoLogo" },
        { "name": "Ubuntu", "commandline": "wsl.exe -d Ubuntu" }
      ] }
    }"#;
}
