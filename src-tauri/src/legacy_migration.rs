//! One-time import of the pre-SQLite JSON configuration.
//!
//! The importer is deliberately separate from the normal JSON storage helper:
//! legacy files are read without renaming or deleting them, copied to a
//! timestamped backup directory, and only then imported in one SQLite
//! transaction. A metadata marker makes a successful import idempotent.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::Transaction;
use serde::de::DeserializeOwned;

use crate::appearance::{ColorSchemeRepository, TerminalColorScheme};
use crate::config_dirs::ConfigDirs;
use crate::database::{self, Database};
use crate::error::{AppError, AppResult};
use crate::profile::{ProfileRepository, ProfileTemplate, TerminalProfile};
use crate::project::{Project, ProjectRepository};
use crate::ssh::{SshConnection, SshConnectionRepository};

const MIGRATION_MARKER: &str = "legacy_backend_migrated";

#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
struct LegacyProjectCollection {
    #[serde(default)]
    projects: Vec<Project>,
}

#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
struct LegacyProfileCollection {
    #[serde(default)]
    profiles: Vec<TerminalProfile>,
}

#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
struct LegacyTemplateCollection {
    #[serde(default)]
    templates: Vec<ProfileTemplate>,
}

#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
struct LegacySshCollection {
    #[serde(default)]
    connections: Vec<SshConnection>,
}

#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
struct LegacyColorSchemeCollection {
    #[serde(default)]
    schemes: Vec<TerminalColorScheme>,
}

#[derive(Debug, Default)]
struct LegacyData {
    projects: Vec<Project>,
    profiles: Vec<TerminalProfile>,
    templates: Vec<ProfileTemplate>,
    ssh_connections: Vec<SshConnection>,
    color_schemes: Vec<TerminalColorScheme>,
    paths: Vec<PathBuf>,
}

impl LegacyData {
    fn load(dirs: &ConfigDirs) -> AppResult<Self> {
        let (projects, project_path) =
            read_optional::<LegacyProjectCollection>(&dirs.projects_path())?;
        let (profiles, profile_path) =
            read_optional::<LegacyProfileCollection>(&dirs.profiles_path())?;
        let (templates, template_path) =
            read_optional::<LegacyTemplateCollection>(&dirs.templates_path())?;
        let (ssh_connections, ssh_path) =
            read_optional::<LegacySshCollection>(&dirs.ssh_connections_path())?;
        let (color_schemes, color_path) =
            read_optional::<LegacyColorSchemeCollection>(&dirs.color_schemes_path())?;

        Ok(Self {
            projects: projects.map(|value| value.projects).unwrap_or_default(),
            profiles: profiles.map(|value| value.profiles).unwrap_or_default(),
            templates: templates.map(|value| value.templates).unwrap_or_default(),
            ssh_connections: ssh_connections
                .map(|value| value.connections)
                .unwrap_or_default(),
            color_schemes: color_schemes.map(|value| value.schemes).unwrap_or_default(),
            paths: [
                project_path,
                profile_path,
                template_path,
                ssh_path,
                color_path,
            ]
            .into_iter()
            .flatten()
            .collect(),
        })
    }

    fn validate(&self) -> AppResult<()> {
        validate_unique_ids(
            "projects",
            self.projects.iter().map(|project| project.id.as_str()),
        )?;
        validate_unique_ids(
            "profiles",
            self.profiles.iter().map(|profile| profile.id.as_str()),
        )?;
        validate_unique_ids(
            "profile templates",
            self.templates.iter().map(|template| template.id.as_str()),
        )?;
        validate_unique_ids(
            "SSH connections",
            self.ssh_connections
                .iter()
                .map(|connection| connection.id.as_str()),
        )?;
        validate_unique_ids(
            "color schemes",
            self.color_schemes.iter().map(|scheme| scheme.id.as_str()),
        )?;
        Ok(())
    }
}

/// Import legacy backend JSON into the already-open database.
pub(crate) fn migrate(database: &Database, dirs: &ConfigDirs) -> AppResult<()> {
    if database.metadata_get(MIGRATION_MARKER)?.is_some() {
        tracing::debug!("legacy backend migration already completed");
        return Ok(());
    }

    let legacy = LegacyData::load(dirs)?;
    if legacy.paths.is_empty() {
        database.metadata_set(MIGRATION_MARKER, &Utc::now().to_rfc3339())?;
        tracing::info!("no legacy backend JSON found; marked SQLite migration complete");
        return Ok(());
    }

    legacy.validate()?;
    let backup_dir = create_backup(dirs, &legacy.paths)?;
    tracing::info!(
        backup = %backup_dir.display(),
        projects = legacy.projects.len(),
        profiles = legacy.profiles.len(),
        templates = legacy.templates.len(),
        ssh_connections = legacy.ssh_connections.len(),
        color_schemes = legacy.color_schemes.len(),
        "importing legacy backend JSON into SQLite"
    );

    database
        .transaction(|transaction| {
            for connection in &legacy.ssh_connections {
                connection.validate()?;
                SshConnectionRepository::upsert_tx(transaction, connection)?;
            }
            for project in &legacy.projects {
                project.validate()?;
                ProjectRepository::upsert_tx(transaction, project)?;
            }
            for profile in &legacy.profiles {
                profile.validate()?;
                ProfileRepository::upsert_tx(transaction, profile)?;
            }
            for template in &legacy.templates {
                template.validate()?;
                crate::profile::template::TemplateRepository::upsert_tx(transaction, template)?;
            }
            for scheme in &legacy.color_schemes {
                scheme.validate()?;
                ColorSchemeRepository::upsert_tx(transaction, scheme)?;
            }

            verify_collection(
                transaction,
                "ssh_connections",
                &legacy
                    .ssh_connections
                    .iter()
                    .map(|connection| connection.id.as_str())
                    .collect::<Vec<_>>(),
            )?;
            verify_collection(
                transaction,
                "projects",
                &legacy
                    .projects
                    .iter()
                    .map(|project| project.id.as_str())
                    .collect::<Vec<_>>(),
            )?;
            verify_collection(
                transaction,
                "profiles",
                &legacy
                    .profiles
                    .iter()
                    .map(|profile| profile.id.as_str())
                    .collect::<Vec<_>>(),
            )?;
            verify_collection(
                transaction,
                "profile_templates",
                &legacy
                    .templates
                    .iter()
                    .map(|template| template.id.as_str())
                    .collect::<Vec<_>>(),
            )?;
            verify_collection(
                transaction,
                "color_schemes",
                &legacy
                    .color_schemes
                    .iter()
                    .map(|scheme| scheme.id.as_str())
                    .collect::<Vec<_>>(),
            )?;

            let foreign_keys = Database::foreign_key_check_tx(transaction)?;
            if !foreign_keys.is_empty() {
                return Err(AppError::LegacyMigration(format!(
                    "foreign key validation failed: {}",
                    foreign_keys.join(", ")
                )));
            }
            Database::metadata_set_tx(transaction, MIGRATION_MARKER, &Utc::now().to_rfc3339())?;
            Ok(())
        })
        .map_err(|error| match error {
            AppError::LegacyMigration(_) => error,
            other => AppError::LegacyMigration(other.to_string()),
        })?;

    tracing::info!("legacy backend migration completed successfully");
    Ok(())
}

fn read_optional<T: DeserializeOwned>(path: &Path) -> AppResult<(Option<T>, Option<PathBuf>)> {
    if !path.exists() {
        return Ok((None, None));
    }
    let bytes = fs::read(path).map_err(|error| {
        AppError::LegacyMigration(format!("could not read {}: {error}", path.display()))
    })?;
    let value = serde_json::from_slice(&bytes).map_err(|error| {
        AppError::LegacyMigration(format!("could not parse {}: {error}", path.display()))
    })?;
    Ok((Some(value), Some(path.to_path_buf())))
}

fn validate_unique_ids<'a>(kind: &str, ids: impl IntoIterator<Item = &'a str>) -> AppResult<()> {
    let mut seen = HashSet::new();
    for id in ids {
        if !seen.insert(id) {
            return Err(AppError::LegacyMigration(format!(
                "duplicate {kind} id in legacy JSON: {id}"
            )));
        }
    }
    Ok(())
}

fn create_backup(dirs: &ConfigDirs, paths: &[PathBuf]) -> AppResult<PathBuf> {
    fs::create_dir_all(dirs.backups_dir()).map_err(AppError::Io)?;
    let stamp = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    for suffix in 0..1000_u32 {
        let name = if suffix == 0 {
            format!("legacy-before-sqlite-{stamp}")
        } else {
            format!("legacy-before-sqlite-{stamp}-{suffix}")
        };
        let candidate = dirs.backups_dir().join(name);
        match fs::create_dir(&candidate) {
            Ok(()) => {
                for path in paths {
                    let file_name = path.file_name().ok_or_else(|| {
                        AppError::LegacyMigration(format!(
                            "legacy path has no file name: {}",
                            path.display()
                        ))
                    })?;
                    fs::copy(path, candidate.join(file_name)).map_err(|error| {
                        AppError::LegacyMigration(format!(
                            "could not back up {}: {error}",
                            path.display()
                        ))
                    })?;
                }
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(AppError::Io(error)),
        }
    }
    Err(AppError::LegacyMigration(
        "could not allocate a unique legacy backup directory".into(),
    ))
}

fn verify_collection(transaction: &Transaction<'_>, table: &str, ids: &[&str]) -> AppResult<()> {
    for id in ids {
        let exists: i64 = transaction
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?1)"),
                [id],
                |row| row.get(0),
            )
            .map_err(|error| database::error::sqlite("verify legacy import", error))?;
        if exists != 1 {
            return Err(AppError::LegacyMigration(format!(
                "import verification could not find {table} row {id}"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_dirs::ConfigDirs;
    use crate::profile::default_local_profile;
    use crate::project::{LocalProjectConfig, ProjectType};

    fn fixture() -> (tempfile::TempDir, ConfigDirs, Project, TerminalProfile) {
        let root = tempfile::tempdir().unwrap();
        let dirs = ConfigDirs::from_root(root.path().join("ProjectTerminal"));
        dirs.ensure_root().unwrap();
        let now = Utc::now();
        let project = Project {
            id: "project-1".into(),
            name: "Legacy project".into(),
            project_type: ProjectType::Local,
            local: Some(LocalProjectConfig {
                path: "D:\\Legacy".into(),
            }),
            ssh: None,
            wsl: None,
            default_profile_id: Some("profile-1".into()),
            created_at: now,
            updated_at: now,
        };
        let profile = default_local_profile("profile-1".into(), project.id.clone());
        (root, dirs, project, profile)
    }

    #[test]
    fn imports_json_to_sqlite_with_backup_and_keeps_originals() {
        let (_root, dirs, project, profile) = fixture();
        fs::write(
            dirs.projects_path(),
            serde_json::to_vec(&LegacyProjectCollection {
                projects: vec![project.clone()],
            })
            .unwrap(),
        )
        .unwrap();
        fs::write(
            dirs.profiles_path(),
            serde_json::to_vec(&LegacyProfileCollection {
                profiles: vec![profile],
            })
            .unwrap(),
        )
        .unwrap();

        let database = Database::open(dirs.database_path()).unwrap();
        migrate(&database, &dirs).unwrap();

        assert!(dirs.projects_path().exists());
        assert!(dirs.profiles_path().exists());
        assert!(database.metadata_get(MIGRATION_MARKER).unwrap().is_some());
        assert_eq!(
            database
                .with_connection(|connection| {
                    connection
                        .query_row("SELECT COUNT(*) FROM projects", [], |row| {
                            row.get::<_, i64>(0)
                        })
                        .map_err(|error| database::error::sqlite("count migrated projects", error))
                })
                .unwrap(),
            1
        );

        let backups: Vec<_> = fs::read_dir(dirs.backups_dir())
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(backups.len(), 1);
        assert!(backups[0].path().join("projects.json").exists());
        assert!(backups[0].path().join("profiles.json").exists());
    }

    #[test]
    fn successful_import_is_idempotent() {
        let (_root, dirs, project, _profile) = fixture();
        fs::write(
            dirs.projects_path(),
            serde_json::to_vec(&LegacyProjectCollection {
                projects: vec![project],
            })
            .unwrap(),
        )
        .unwrap();
        let database = Database::open(dirs.database_path()).unwrap();
        migrate(&database, &dirs).unwrap();
        fs::write(dirs.projects_path(), b"{\"projects\":[]}").unwrap();
        migrate(&database, &dirs).unwrap();

        assert_eq!(
            database
                .with_connection(|connection| {
                    connection
                        .query_row("SELECT COUNT(*) FROM projects", [], |row| {
                            row.get::<_, i64>(0)
                        })
                        .map_err(|error| {
                            database::error::sqlite("count idempotent projects", error)
                        })
                })
                .unwrap(),
            1
        );
        assert_eq!(
            fs::read_dir(dirs.backups_dir())
                .unwrap()
                .filter_map(Result::ok)
                .count(),
            1
        );
    }

    #[test]
    fn corrupt_legacy_json_is_preserved_and_not_marked_migrated() {
        let (_root, dirs, _project, _profile) = fixture();
        fs::write(dirs.projects_path(), b"not json").unwrap();
        let database = Database::open(dirs.database_path()).unwrap();
        assert!(matches!(
            migrate(&database, &dirs),
            Err(AppError::LegacyMigration(_))
        ));
        assert!(dirs.projects_path().exists());
        assert!(database.metadata_get(MIGRATION_MARKER).unwrap().is_none());
    }
}
