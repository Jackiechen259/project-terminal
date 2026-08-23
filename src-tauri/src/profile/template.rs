//! SQLite repository for reusable, project-independent profile templates.

use std::sync::Arc;

use chrono::Utc;
use rusqlite::{params, Row, Transaction};

use crate::database::{self, Database};
use crate::error::{AppError, AppResult};

use super::model::{CondaEnvironmentConfig, EnvironmentType, ShellType};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TemplateIcon {
    #[default]
    LayoutTemplate,
    Terminal,
    Code,
    Bot,
    Sparkles,
    Box,
    Database,
    Server,
    Cloud,
    Rocket,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileTemplate {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: TemplateIcon,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force_utf8: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_integration: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_scheme_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent_color: Option<String>,
    pub created_at: chrono::DateTime<Utc>,
    pub updated_at: chrono::DateTime<Utc>,
}

impl ProfileTemplate {
    pub fn validate(&self) -> AppResult<()> {
        if self.name.trim().is_empty() {
            return Err(AppError::Configuration(
                "Template name must not be empty".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct TemplateCollection {
    #[serde(default)]
    pub templates: Vec<ProfileTemplate>,
}

#[derive(Debug)]
struct TemplateRecord {
    id: String,
    name: String,
    icon: String,
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
    created_at: String,
    updated_at: String,
}

pub struct TemplateRepository {
    db: Arc<Database>,
}

impl TemplateRepository {
    pub fn new(source: impl Into<database::DatabaseSource>) -> Self {
        Self {
            db: source.into().into_database(),
        }
    }

    pub fn database(&self) -> Arc<Database> {
        Arc::clone(&self.db)
    }

    /// Compatibility envelope for Windows Terminal import code.
    pub fn load(&self) -> AppResult<TemplateCollection> {
        Ok(TemplateCollection {
            templates: self.list()?,
        })
    }

    pub fn save(&self, collection: &TemplateCollection) -> AppResult<()> {
        self.db.transaction(|transaction| {
            transaction
                .execute("DELETE FROM profile_templates", [])
                .map_err(|error| database::error::sqlite("replace templates", error))?;
            for template in &collection.templates {
                template.validate()?;
                Self::upsert_tx(transaction, template)?;
            }
            Ok(())
        })
    }

    pub fn list(&self) -> AppResult<Vec<ProfileTemplate>> {
        self.db.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id, name, icon, shell_type, shell_executable,
                            shell_args_json, environment_type, environment_name,
                            environment_path, conda_json, activation_command,
                            startup_commands_json, environment_variables_json,
                            wsl_distribution, wsl_working_directory,
                            remote_shell_command, force_utf8, shell_integration,
                            color_scheme_id, accent_color, created_at, updated_at
                     FROM profile_templates
                     ORDER BY name COLLATE NOCASE ASC, id ASC",
                )
                .map_err(|error| database::error::sqlite("prepare template list", error))?;
            let rows = statement
                .query_map([], template_record_from_row)
                .map_err(|error| database::error::sqlite("query templates", error))?;
            rows.map(|row| {
                row.map_err(|error| database::error::sqlite("read template row", error))?
                    .into_template()
            })
            .collect()
        })
    }

    pub fn get(&self, id: &str) -> AppResult<ProfileTemplate> {
        self.db.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT id, name, icon, shell_type, shell_executable,
                            shell_args_json, environment_type, environment_name,
                            environment_path, conda_json, activation_command,
                            startup_commands_json, environment_variables_json,
                            wsl_distribution, wsl_working_directory,
                            remote_shell_command, force_utf8, shell_integration,
                            color_scheme_id, accent_color, created_at, updated_at
                     FROM profile_templates WHERE id = ?1",
                    params![id],
                    template_record_from_row,
                )
                .map_err(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => {
                        AppError::TemplateNotFound(id.to_owned())
                    }
                    error => database::error::sqlite("read template", error),
                })?
                .into_template()
        })
    }

    pub fn upsert(&self, template: ProfileTemplate) -> AppResult<ProfileTemplate> {
        template.validate()?;
        let result = template.clone();
        self.db.transaction(|transaction| {
            Self::upsert_tx(transaction, &template)?;
            Ok(())
        })?;
        Ok(result)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        self.db.transaction(|transaction| {
            let changed = transaction
                .execute("DELETE FROM profile_templates WHERE id = ?1", params![id])
                .map_err(|error| database::error::sqlite("delete template", error))?;
            if changed == 0 {
                return Err(AppError::TemplateNotFound(id.to_owned()));
            }
            Ok(())
        })
    }

    pub(crate) fn upsert_tx(
        transaction: &Transaction<'_>,
        template: &ProfileTemplate,
    ) -> AppResult<()> {
        let shell_args_json = database::schema::json(&template.shell_args, "template.shell_args")?;
        let startup_commands_json =
            database::schema::json(&template.startup_commands, "template.startup_commands")?;
        let conda_json =
            database::schema::optional_json(template.conda.as_ref(), "template.conda")?;
        let environment_variables_json = database::schema::optional_json(
            template.environment_variables.as_ref(),
            "template.environment_variables",
        )?;
        transaction
            .execute(
                "INSERT INTO profile_templates(
                    id, name, icon, shell_type, shell_executable, shell_args_json,
                    environment_type, environment_name, environment_path,
                    conda_json, activation_command, startup_commands_json,
                    environment_variables_json, wsl_distribution,
                    wsl_working_directory, remote_shell_command, force_utf8,
                    shell_integration, color_scheme_id, accent_color,
                    created_at, updated_at
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                    ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22
                 )
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    icon = excluded.icon,
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
                    updated_at = excluded.updated_at",
                params![
                    template.id,
                    template.name,
                    database::schema::text_enum(&template.icon, "template icon")?,
                    database::schema::text_enum(&template.shell_type, "template shell type")?,
                    template.shell_executable,
                    shell_args_json,
                    database::schema::text_enum(
                        &template.environment_type,
                        "template environment type",
                    )?,
                    template.environment_name,
                    template.environment_path,
                    conda_json,
                    template.activation_command,
                    startup_commands_json,
                    environment_variables_json,
                    template.wsl_distribution,
                    template.wsl_working_directory,
                    template.remote_shell_command,
                    database::schema::optional_bool_i64(template.force_utf8),
                    database::schema::optional_bool_i64(template.shell_integration),
                    template.color_scheme_id,
                    template.accent_color,
                    database::schema::timestamp(&template.created_at),
                    database::schema::timestamp(&template.updated_at),
                ],
            )
            .map_err(|error| database::error::sqlite("upsert template", error))?;
        Ok(())
    }

    pub(crate) fn count_tx(transaction: &Transaction<'_>) -> AppResult<i64> {
        transaction
            .query_row("SELECT COUNT(*) FROM profile_templates", [], |row| {
                row.get(0)
            })
            .map_err(|error| database::error::sqlite("count templates", error))
    }
}

fn template_record_from_row(row: &Row<'_>) -> rusqlite::Result<TemplateRecord> {
    Ok(TemplateRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        icon: row.get(2)?,
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
        created_at: row.get(20)?,
        updated_at: row.get(21)?,
    })
}

impl TemplateRecord {
    fn into_template(self) -> AppResult<ProfileTemplate> {
        Ok(ProfileTemplate {
            id: self.id,
            name: self.name,
            icon: database::schema::parse_text_enum(&self.icon, "template icon")?,
            shell_type: database::schema::parse_text_enum(&self.shell_type, "template shell type")?,
            shell_executable: self.shell_executable,
            shell_args: self
                .shell_args_json
                .map(|value| database::schema::parse_json(&value, "template.shell_args"))
                .transpose()?
                .unwrap_or_default(),
            environment_type: database::schema::parse_text_enum(
                &self.environment_type,
                "template environment type",
            )?,
            environment_name: self.environment_name,
            environment_path: self.environment_path,
            conda: self
                .conda_json
                .map(|value| database::schema::parse_json(&value, "template.conda"))
                .transpose()?,
            activation_command: self.activation_command,
            startup_commands: self
                .startup_commands_json
                .map(|value| database::schema::parse_json(&value, "template.startup_commands"))
                .transpose()?
                .unwrap_or_default(),
            environment_variables: self
                .environment_variables_json
                .map(|value| database::schema::parse_json(&value, "template.environment_variables"))
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
            created_at: database::schema::parse_timestamp(&self.created_at, "template.created_at")?,
            updated_at: database::schema::parse_timestamp(&self.updated_at, "template.updated_at")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository() -> TemplateRepository {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("project-terminal.db");
        TemplateRepository::new(Database::open(path).unwrap())
    }

    #[test]
    fn templates_round_trip() {
        let repo = repository();
        let now = Utc::now();
        let template = ProfileTemplate {
            id: "tpl-1".into(),
            name: "PowerShell".into(),
            icon: TemplateIcon::Rocket,
            shell_type: ShellType::Powershell,
            shell_executable: None,
            shell_args: vec!["-NoLogo".into()],
            environment_type: EnvironmentType::None,
            environment_name: None,
            environment_path: None,
            conda: None,
            activation_command: None,
            startup_commands: vec!["echo hi".into()],
            environment_variables: None,
            wsl_distribution: None,
            wsl_working_directory: None,
            remote_shell_command: None,
            force_utf8: Some(true),
            shell_integration: Some(false),
            color_scheme_id: None,
            accent_color: None,
            created_at: now,
            updated_at: now,
        };
        repo.upsert(template.clone()).unwrap();
        assert_eq!(repo.get("tpl-1").unwrap().icon, TemplateIcon::Rocket);
        assert_eq!(repo.list().unwrap(), vec![template]);
    }
}
