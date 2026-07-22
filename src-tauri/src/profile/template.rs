//! Reusable profile template. Unlike `TerminalProfile`, a template is not
//! bound to a project - it stores shell/environment/startup configuration
//! that can be applied to any project. When the user picks a template from
//! the quick-launch menu, the frontend creates a concrete `TerminalProfile`
//! by copying the template's fields into a new profile for the target project.

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::storage;

use super::model::{CondaEnvironmentConfig, EnvironmentType, ShellType};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileTemplate {
    pub id: String,
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

    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl ProfileTemplate {
    /// Validate: name must be non-empty.
    pub fn validate(&self) -> AppResult<()> {
        if self.name.trim().is_empty() {
            return Err(AppError::Configuration(
                "Template name must not be empty".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct TemplateCollection {
    #[serde(default)]
    pub templates: Vec<ProfileTemplate>,
}

pub struct TemplateRepository {
    path: PathBuf,
}

impl TemplateRepository {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn load(&self) -> AppResult<TemplateCollection> {
        storage::read_or_default(&self.path, TemplateCollection::default())
    }

    pub fn save(&self, collection: &TemplateCollection) -> AppResult<()> {
        storage::write_json(&self.path, collection)
    }

    pub fn list(&self) -> AppResult<Vec<ProfileTemplate>> {
        Ok(self.load()?.templates)
    }

    pub fn get(&self, id: &str) -> AppResult<ProfileTemplate> {
        self.load()?
            .templates
            .into_iter()
            .find(|t| t.id == id)
            .ok_or_else(|| AppError::TemplateNotFound(id.to_string()))
    }

    pub fn upsert(&self, template: ProfileTemplate) -> AppResult<ProfileTemplate> {
        template.validate()?;
        let mut collection = self.load()?;
        let existing_idx = collection.templates.iter().position(|t| t.id == template.id);
        match existing_idx {
            Some(idx) => collection.templates[idx] = template.clone(),
            None => collection.templates.push(template.clone()),
        }
        self.save(&collection)?;
        Ok(template)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut collection = self.load()?;
        let before = collection.templates.len();
        collection.templates.retain(|t| t.id != id);
        if collection.templates.len() == before {
            return Err(AppError::TemplateNotFound(id.to_string()));
        }
        self.save(&collection)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_template(id: &str) -> ProfileTemplate {
        ProfileTemplate {
            id: id.to_string(),
            name: "Test".to_string(),
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
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn upsert_inserts_and_updates() {
        let dir = tempfile::tempdir().unwrap();
        let repo = TemplateRepository::new(dir.path().join("templates.json"));

        let t1 = sample_template("tpl-1");
        repo.upsert(t1.clone()).unwrap();
        assert_eq!(repo.list().unwrap().len(), 1);

        let mut t2 = t1.clone();
        t2.name = "Updated".to_string();
        repo.upsert(t2).unwrap();
        assert_eq!(repo.list().unwrap().len(), 1);
        assert_eq!(repo.get("tpl-1").unwrap().name, "Updated");
    }

    #[test]
    fn delete_removes_template() {
        let dir = tempfile::tempdir().unwrap();
        let repo = TemplateRepository::new(dir.path().join("templates.json"));
        repo.upsert(sample_template("tpl-1")).unwrap();
        repo.delete("tpl-1").unwrap();
        assert!(repo.list().unwrap().is_empty());
    }

    #[test]
    fn delete_missing_errors() {
        let dir = tempfile::tempdir().unwrap();
        let repo = TemplateRepository::new(dir.path().join("templates.json"));
        assert!(repo.delete("nope").is_err());
    }

    #[test]
    fn empty_name_fails_validation() {
        let mut t = sample_template("tpl-1");
        t.name = "  ".to_string();
        assert!(repo_with(&t).is_err());
    }

    fn repo_with(t: &ProfileTemplate) -> AppResult<()> {
        let dir = tempfile::tempdir().unwrap();
        let repo = TemplateRepository::new(dir.path().join("templates.json"));
        repo.upsert(t.clone())?;
        Ok(())
    }
}
