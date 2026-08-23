//! SQLite repository for project-scoped terminal profiles.

use std::sync::Arc;

use chrono::Utc;
use rusqlite::{params, Row, Transaction};

use crate::database::{self, Database};
use crate::error::{AppError, AppResult};

use super::model::{EnvironmentType, ShellType, TerminalProfile};

/// Legacy JSON envelope retained for the one-time importer.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ProfileCollection {
    #[serde(default)]
    pub profiles: Vec<TerminalProfile>,
}

#[derive(Debug, Clone)]
struct ProfileRecord {
    id: String,
    project_id: String,
    name: String,
    shell_type: String,
    shell_executable: Option<String>,
    shell_args_json: Option<String>,
    environment_type: String,
    environment_name: Option<String>,
    environment_path: Option<String>,
    conda_json: Option<String>,
    activation_command: Option<String>,
    startup_commands_json: Option<String>,
    environment_variables_json: Option<String>,
    wsl_distribution: Option<String>,
    wsl_working_directory: Option<String>,
    remote_shell_command: Option<String>,
    force_utf8: Option<i64>,
    shell_integration: Option<i64>,
    color_scheme_id: Option<String>,
    accent_color: Option<String>,
    is_default: i64,
    show_in_context_menu: i64,
    created_at: String,
    updated_at: String,
}

pub struct ProfileRepository {
    db: Arc<Database>,
}

impl ProfileRepository {
    pub fn new(source: impl Into<database::DatabaseSource>) -> Self {
        Self {
            db: source.into().into_database(),
        }
    }

    pub fn database(&self) -> Arc<Database> {
        Arc::clone(&self.db)
    }

    /// Compatibility envelope for import code that still builds a complete
    /// collection before saving. Normal CRUD uses scoped SQL methods below.
    pub fn load(&self) -> AppResult<ProfileCollection> {
        Ok(ProfileCollection {
            profiles: self.list_all()?,
        })
    }

    pub fn save(&self, collection: &ProfileCollection) -> AppResult<()> {
        self.db.transaction(|transaction| {
            transaction
                .execute("DELETE FROM profiles", [])
                .map_err(|error| database::error::sqlite("replace profiles", error))?;
            for profile in &collection.profiles {
                profile.validate()?;
                Self::upsert_tx(transaction, profile)?;
            }
            Ok(())
        })
    }

    pub fn list_for_project(&self, project_id: &str) -> AppResult<Vec<TerminalProfile>> {
        self.db.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id, project_id, name, shell_type, shell_executable,
                            shell_args_json, environment_type, environment_name,
                            environment_path, conda_json, activation_command,
                            startup_commands_json, environment_variables_json,
                            wsl_distribution, wsl_working_directory,
                            remote_shell_command, force_utf8, shell_integration,
                            color_scheme_id, accent_color, is_default,
                            show_in_context_menu, created_at, updated_at
                     FROM profiles
                     WHERE project_id = ?1
                     ORDER BY is_default DESC, created_at ASC, id ASC",
                )
                .map_err(|error| database::error::sqlite("prepare profile list", error))?;
            let rows = statement
                .query_map(params![project_id], profile_record_from_row)
                .map_err(|error| database::error::sqlite("query project profiles", error))?;
            rows.map(|row| {
                row.map_err(|error| database::error::sqlite("read profile row", error))?
                    .into_profile()
            })
            .collect()
        })
    }

    pub fn list_all(&self) -> AppResult<Vec<TerminalProfile>> {
        self.db.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id, project_id, name, shell_type, shell_executable,
                            shell_args_json, environment_type, environment_name,
                            environment_path, conda_json, activation_command,
                            startup_commands_json, environment_variables_json,
                            wsl_distribution, wsl_working_directory,
                            remote_shell_command, force_utf8, shell_integration,
                            color_scheme_id, accent_color, is_default,
                            show_in_context_menu, created_at, updated_at
                     FROM profiles
                     ORDER BY project_id ASC, is_default DESC, created_at ASC, id ASC",
                )
                .map_err(|error| database::error::sqlite("prepare all profile list", error))?;
            let rows = statement
                .query_map([], profile_record_from_row)
                .map_err(|error| database::error::sqlite("query profiles", error))?;
            rows.map(|row| {
                row.map_err(|error| database::error::sqlite("read profile row", error))?
                    .into_profile()
            })
            .collect()
        })
    }

    pub fn get(&self, id: &str) -> AppResult<TerminalProfile> {
        self.db.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id, project_id, name, shell_type, shell_executable,
                            shell_args_json, environment_type, environment_name,
                            environment_path, conda_json, activation_command,
                            startup_commands_json, environment_variables_json,
                            wsl_distribution, wsl_working_directory,
                            remote_shell_command, force_utf8, shell_integration,
                            color_scheme_id, accent_color, is_default,
                            show_in_context_menu, created_at, updated_at
                     FROM profiles WHERE id = ?1",
                    params![id],
                    profile_record_from_row,
                )
                .map_err(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => {
                        AppError::ProfileNotFound(id.to_owned())
                    }
                    error => database::error::sqlite("read profile", error),
                })?
                .into_profile()
        })
    }

    pub fn upsert(&self, profile: TerminalProfile) -> AppResult<TerminalProfile> {
        profile.validate()?;
        let result = profile.clone();
        self.db.transaction(|transaction| {
            Self::upsert_tx(transaction, &profile)?;
            Ok(())
        })?;
        Ok(result)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        self.db
            .transaction(|transaction| Self::delete_tx(transaction, id))
    }

    pub fn delete_all_for_project(&self, project_id: &str) -> AppResult<()> {
        self.db.with_connection(|connection| {
            connection
                .execute(
                    "DELETE FROM profiles WHERE project_id = ?1",
                    params![project_id],
                )
                .map_err(|error| database::error::sqlite("delete project profiles", error))?;
            Ok(())
        })
    }

    pub fn default_for_project(&self, project_id: &str) -> AppResult<TerminalProfile> {
        let profiles = self.list_for_project(project_id)?;
        profiles
            .iter()
            .find(|profile| profile.is_default)
            .cloned()
            .or_else(|| profiles.first().cloned())
            .ok_or_else(|| AppError::ProfileNotFound(format!("default for {project_id}")))
    }

    pub(crate) fn upsert_tx(
        transaction: &Transaction<'_>,
        profile: &TerminalProfile,
    ) -> AppResult<()> {
        if profile.is_default {
            transaction
                .execute(
                    "UPDATE profiles
                     SET is_default = 0
                     WHERE project_id = ?1 AND id <> ?2",
                    params![profile.project_id, profile.id],
                )
                .map_err(|error| {
                    database::error::sqlite("clear sibling default profiles", error)
                })?;
        }

        let shell_args_json = database::schema::json(&profile.shell_args, "profile.shell_args")?;
        let startup_commands_json =
            database::schema::json(&profile.startup_commands, "profile.startup_commands")?;
        let conda_json = database::schema::optional_json(profile.conda.as_ref(), "profile.conda")?;
        let environment_variables_json = database::schema::optional_json(
            profile.environment_variables.as_ref(),
            "profile.environment_variables",
        )?;

        transaction
            .execute(
                "INSERT INTO profiles(
                    id, project_id, name, shell_type, shell_executable,
                    shell_args_json, environment_type, environment_name,
                    environment_path, conda_json, activation_command,
                    startup_commands_json, environment_variables_json,
                    wsl_distribution, wsl_working_directory,
                    remote_shell_command, force_utf8, shell_integration,
                    color_scheme_id, accent_color, is_default,
                    show_in_context_menu, created_at, updated_at
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                    ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24
                 )
                 ON CONFLICT(id) DO UPDATE SET
                    project_id = excluded.project_id,
                    name = excluded.name,
                    shell_type = excluded.shell_type,
                    shell_executable = excluded.shell_executable,
                    shell_args_json = excluded.shell_args_json,
                    environment_type = excluded.environment_type,
                    environment_name = excluded.environment_name,
                    environment_path = excluded.environment_path,
                    conda_json = excluded.conda_json,
                    activation_command = excluded.activation_command,
                    startup_commands_json = excluded.startup_commands_json,
                    environment_variables_json = excluded.environment_variables_json,
                    wsl_distribution = excluded.wsl_distribution,
                    wsl_working_directory = excluded.wsl_working_directory,
                    remote_shell_command = excluded.remote_shell_command,
                    force_utf8 = excluded.force_utf8,
                    shell_integration = excluded.shell_integration,
                    color_scheme_id = excluded.color_scheme_id,
                    accent_color = excluded.accent_color,
                    is_default = excluded.is_default,
                    show_in_context_menu = excluded.show_in_context_menu,
                    updated_at = excluded.updated_at",
                params![
                    profile.id,
                    profile.project_id,
                    profile.name,
                    database::schema::text_enum(&profile.shell_type, "shell type")?,
                    profile.shell_executable,
                    shell_args_json,
                    database::schema::text_enum(&profile.environment_type, "environment type")?,
                    profile.environment_name,
                    profile.environment_path,
                    conda_json,
                    profile.activation_command,
                    startup_commands_json,
                    environment_variables_json,
                    profile.wsl_distribution,
                    profile.wsl_working_directory,
                    profile.remote_shell_command,
                    database::schema::optional_bool_i64(profile.force_utf8),
                    database::schema::optional_bool_i64(profile.shell_integration),
                    profile.color_scheme_id,
                    profile.accent_color,
                    database::schema::bool_i64(profile.is_default),
                    database::schema::bool_i64(profile.show_in_context_menu),
                    database::schema::timestamp(&profile.created_at),
                    database::schema::timestamp(&profile.updated_at),
                ],
            )
            .map_err(|error| database::error::sqlite("upsert profile", error))?;
        Ok(())
    }

    pub(crate) fn delete_tx(transaction: &Transaction<'_>, id: &str) -> AppResult<()> {
        let changed = transaction
            .execute("DELETE FROM profiles WHERE id = ?1", params![id])
            .map_err(|error| database::error::sqlite("delete profile", error))?;
        if changed == 0 {
            return Err(AppError::ProfileNotFound(id.to_owned()));
        }
        Ok(())
    }

    pub(crate) fn count_tx(transaction: &Transaction<'_>) -> AppResult<i64> {
        transaction
            .query_row("SELECT COUNT(*) FROM profiles", [], |row| row.get(0))
            .map_err(|error| database::error::sqlite("count profiles", error))
    }
}

fn profile_record_from_row(row: &Row<'_>) -> rusqlite::Result<ProfileRecord> {
    Ok(ProfileRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        shell_type: row.get(3)?,
        shell_executable: row.get(4)?,
        shell_args_json: row.get(5)?,
        environment_type: row.get(6)?,
        environment_name: row.get(7)?,
        environment_path: row.get(8)?,
        conda_json: row.get(9)?,
        activation_command: row.get(10)?,
        startup_commands_json: row.get(11)?,
        environment_variables_json: row.get(12)?,
        wsl_distribution: row.get(13)?,
        wsl_working_directory: row.get(14)?,
        remote_shell_command: row.get(15)?,
        force_utf8: row.get(16)?,
        shell_integration: row.get(17)?,
        color_scheme_id: row.get(18)?,
        accent_color: row.get(19)?,
        is_default: row.get(20)?,
        show_in_context_menu: row.get(21)?,
        created_at: row.get(22)?,
        updated_at: row.get(23)?,
    })
}

impl ProfileRecord {
    fn into_profile(self) -> AppResult<TerminalProfile> {
        Ok(TerminalProfile {
            id: self.id,
            project_id: self.project_id,
            name: self.name,
            shell_type: database::schema::parse_text_enum(&self.shell_type, "shell type")?,
            shell_executable: self.shell_executable,
            shell_args: self
                .shell_args_json
                .map(|value| database::schema::parse_json(&value, "profile.shell_args"))
                .transpose()?
                .unwrap_or_default(),
            environment_type: database::schema::parse_text_enum(
                &self.environment_type,
                "environment type",
            )?,
            environment_name: self.environment_name,
            environment_path: self.environment_path,
            conda: self
                .conda_json
                .map(|value| database::schema::parse_json(&value, "profile.conda"))
                .transpose()?,
            activation_command: self.activation_command,
            startup_commands: self
                .startup_commands_json
                .map(|value| database::schema::parse_json(&value, "profile.startup_commands"))
                .transpose()?
                .unwrap_or_default(),
            environment_variables: self
                .environment_variables_json
                .map(|value| database::schema::parse_json(&value, "profile.environment_variables"))
                .transpose()?,
            wsl_distribution: self.wsl_distribution,
            wsl_working_directory: self.wsl_working_directory,
            remote_shell_command: self.remote_shell_command,
            force_utf8: database::schema::optional_bool_from_i64(self.force_utf8, "force_utf8")?,
            shell_integration: database::schema::optional_bool_from_i64(
                self.shell_integration,
                "shell_integration",
            )?,
            color_scheme_id: self.color_scheme_id,
            accent_color: self.accent_color,
            is_default: database::schema::bool_from_i64(self.is_default, "is_default")?,
            show_in_context_menu: database::schema::bool_from_i64(
                self.show_in_context_menu,
                "show_in_context_menu",
            )?,
            created_at: database::schema::parse_timestamp(&self.created_at, "profile.created_at")?,
            updated_at: database::schema::parse_timestamp(&self.updated_at, "profile.updated_at")?,
        })
    }
}

#[cfg(test)]
pub fn default_powershell_profile(id: String, project_id: String) -> TerminalProfile {
    let now = Utc::now();
    TerminalProfile {
        id,
        project_id,
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
        created_at: now,
        updated_at: now,
    }
}

pub fn default_local_profile(id: String, project_id: String) -> TerminalProfile {
    let shell = crate::platform::PlatformInfo::current().default_local_shell;
    let name = match shell {
        ShellType::Powershell => "PowerShell",
        ShellType::Bash => "Bash",
        ShellType::Zsh => "Zsh",
        ShellType::Fish => "Fish",
        ShellType::Sh => "sh",
        ShellType::Cmd => "Command Prompt",
        ShellType::GitBash => "Git Bash",
        ShellType::Wsl => "WSL",
        _ => "Shell",
    };
    let now = Utc::now();
    TerminalProfile {
        id,
        project_id,
        name: name.into(),
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
        color_scheme_id: None,
        accent_color: None,
        is_default: true,
        show_in_context_menu: true,
        created_at: now,
        updated_at: now,
    }
}

pub fn default_remote_profile(id: String, project_id: String) -> TerminalProfile {
    let now = Utc::now();
    TerminalProfile {
        id,
        project_id,
        name: "Remote shell".into(),
        shell_type: ShellType::RemoteDefault,
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
        created_at: now,
        updated_at: now,
    }
}

pub fn default_wsl_profile(
    id: String,
    project_id: String,
    distribution: String,
    working_directory: Option<String>,
) -> TerminalProfile {
    let now = Utc::now();
    TerminalProfile {
        id,
        project_id,
        name: "WSL".into(),
        shell_type: ShellType::Wsl,
        shell_executable: None,
        shell_args: vec![],
        environment_type: EnvironmentType::None,
        environment_name: None,
        environment_path: None,
        conda: None,
        activation_command: None,
        startup_commands: vec![],
        environment_variables: None,
        wsl_distribution: Some(distribution),
        wsl_working_directory: working_directory
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty()),
        remote_shell_command: None,
        force_utf8: None,
        shell_integration: None,
        color_scheme_id: None,
        accent_color: None,
        is_default: true,
        show_in_context_menu: true,
        created_at: now,
        updated_at: now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{LocalProjectConfig, Project, ProjectType};

    fn fixture() -> (ProfileRepository, String) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("project-terminal.db");
        let db = Database::open(path).unwrap();
        let project_id = "project-1".to_owned();
        let project = Project {
            id: project_id.clone(),
            name: "Project".into(),
            project_type: ProjectType::Local,
            local: Some(LocalProjectConfig {
                path: "D:\\Project".into(),
            }),
            ssh: None,
            wsl: None,
            default_profile_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        crate::project::ProjectRepository::new(Arc::clone(&db))
            .upsert(project)
            .unwrap();
        (ProfileRepository::new(db), project_id)
    }

    fn profile(id: &str, project_id: &str, is_default: bool) -> TerminalProfile {
        let now = Utc::now();
        TerminalProfile {
            id: id.into(),
            project_id: project_id.into(),
            name: id.into(),
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
            is_default,
            show_in_context_menu: true,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn profiles_are_isolated_and_default_is_transactional() {
        let (repo, project_id) = fixture();
        repo.upsert(profile("p1", &project_id, true)).unwrap();
        repo.upsert(profile("p2", &project_id, true)).unwrap();
        let profiles = repo.list_for_project(&project_id).unwrap();
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles.iter().filter(|p| p.is_default).count(), 1);
        assert!(profiles.iter().any(|p| p.id == "p2" && p.is_default));
    }

    #[test]
    fn delete_all_for_project_works() {
        let (repo, project_id) = fixture();
        repo.upsert(profile("p1", &project_id, true)).unwrap();
        repo.delete_all_for_project(&project_id).unwrap();
        assert!(repo.list_for_project(&project_id).unwrap().is_empty());
    }
}
