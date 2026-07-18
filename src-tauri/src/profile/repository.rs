//! Terminal profile JSON repository. Profiles belong to projects.

use std::path::PathBuf;

use chrono::Utc;

use crate::error::{AppError, AppResult};
use crate::storage;

use super::model::{EnvironmentType, ShellType, TerminalProfile};

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct ProfileCollection {
    #[serde(default)]
    pub profiles: Vec<TerminalProfile>,
}

pub struct ProfileRepository {
    path: PathBuf,
}

impl ProfileRepository {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn load(&self) -> AppResult<ProfileCollection> {
        storage::read_or_default(&self.path, ProfileCollection::default())
    }

    pub fn save(&self, collection: &ProfileCollection) -> AppResult<()> {
        storage::write_json(&self.path, collection)
    }

    pub fn list_for_project(&self, project_id: &str) -> AppResult<Vec<TerminalProfile>> {
        Ok(self
            .load()?
            .profiles
            .into_iter()
            .filter(|p| p.project_id == project_id)
            .collect())
    }

    pub fn list_all(&self) -> AppResult<Vec<TerminalProfile>> {
        Ok(self.load()?.profiles)
    }

    pub fn get(&self, id: &str) -> AppResult<TerminalProfile> {
        self.load()?
            .profiles
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| AppError::ProfileNotFound(id.to_string()))
    }

    pub fn upsert(&self, profile: TerminalProfile) -> AppResult<TerminalProfile> {
        profile.validate()?;
        let mut collection = self.load()?;
        let existing_idx = collection.profiles.iter().position(|p| p.id == profile.id);
        // Enforce single default-per-project: if this profile is becoming the
        // default, clear is_default on siblings of the same project.
        if profile.is_default {
            for sibling in collection.profiles.iter_mut() {
                if sibling.project_id == profile.project_id && sibling.id != profile.id {
                    sibling.is_default = false;
                }
            }
        }
        match existing_idx {
            Some(idx) => collection.profiles[idx] = profile.clone(),
            None => collection.profiles.push(profile.clone()),
        }
        self.save(&collection)?;
        Ok(profile)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut collection = self.load()?;
        let before = collection.profiles.len();
        collection.profiles.retain(|p| p.id != id);
        if collection.profiles.len() == before {
            return Err(AppError::ProfileNotFound(id.to_string()));
        }
        self.save(&collection)
    }

    /// Delete all profiles for a project (used when removing a project).
    pub fn delete_all_for_project(&self, project_id: &str) -> AppResult<()> {
        let mut collection = self.load()?;
        collection.profiles.retain(|p| p.project_id != project_id);
        self.save(&collection)
    }

    /// Return the default profile for a project, falling back to the first
    /// profile if none is marked default. Errors if the project has no
    /// profiles - callers may treat that as "create a default".
    pub fn default_for_project(&self, project_id: &str) -> AppResult<TerminalProfile> {
        let profiles = self.list_for_project(project_id)?;
        profiles
            .into_iter()
            .find(|p| p.is_default)
            .or_else(|| {
                self.load()
                    .ok()
                    .and_then(|c| c.profiles.into_iter().find(|p| p.project_id == project_id))
            })
            .ok_or_else(|| AppError::ProfileNotFound(format!("default for {project_id}")))
    }
}

/// Build a default PowerShell profile for a project. Phase 3.5 uses this to
/// seed a new project with a working profile.
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
        is_default: true,
        created_at: now,
        updated_at: now,
    }
}

/// Default profile for an SSH project. Its shell runs on the remote host, not
/// on the Windows machine that launches `ssh.exe`.
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
        is_default: true,
        created_at: now,
        updated_at: now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tempdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pt-prof-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn prof(id: &str, project: &str, default: bool) -> TerminalProfile {
        TerminalProfile {
            id: id.into(),
            project_id: project.into(),
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
            is_default: default,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn missing_file_returns_empty_list() {
        let repo = ProfileRepository::new(tempdir().join("missing.json"));
        assert!(repo.list_all().unwrap().is_empty());
    }

    #[test]
    fn list_for_project_isolates_profiles() {
        let repo = ProfileRepository::new(tempdir().join("prof.json"));
        repo.upsert(prof("p1a", "proj-a", true)).unwrap();
        repo.upsert(prof("p1b", "proj-a", false)).unwrap();
        repo.upsert(prof("p2a", "proj-b", true)).unwrap();
        let a = repo.list_for_project("proj-a").unwrap();
        assert_eq!(a.len(), 2);
        let b = repo.list_for_project("proj-b").unwrap();
        assert_eq!(b.len(), 1);
    }

    #[test]
    fn upsert_default_clears_other_defaults_in_project() {
        let repo = ProfileRepository::new(tempdir().join("prof.json"));
        repo.upsert(prof("p1a", "proj-a", true)).unwrap();
        repo.upsert(prof("p1b", "proj-a", true)).unwrap();
        let profiles = repo.list_for_project("proj-a").unwrap();
        let defaults = profiles.iter().filter(|p| p.is_default).count();
        assert_eq!(defaults, 1);
        // p1b should be the default now
        assert!(profiles.iter().find(|p| p.id == "p1b").unwrap().is_default);
    }

    #[test]
    fn delete_all_for_project_clears_its_profiles() {
        let repo = ProfileRepository::new(tempdir().join("prof.json"));
        repo.upsert(prof("p1a", "proj-a", true)).unwrap();
        repo.upsert(prof("p1b", "proj-a", false)).unwrap();
        repo.upsert(prof("p2a", "proj-b", true)).unwrap();
        repo.delete_all_for_project("proj-a").unwrap();
        assert!(repo.list_for_project("proj-a").unwrap().is_empty());
        assert_eq!(repo.list_for_project("proj-b").unwrap().len(), 1);
    }

    #[test]
    fn default_for_project_prefers_marked_default() {
        let repo = ProfileRepository::new(tempdir().join("prof.json"));
        repo.upsert(prof("p1a", "proj-a", false)).unwrap();
        repo.upsert(prof("p1b", "proj-a", true)).unwrap();
        let def = repo.default_for_project("proj-a").unwrap();
        assert_eq!(def.id, "p1b");
    }

    #[test]
    fn delete_unknown_id_errors() {
        let repo = ProfileRepository::new(tempdir().join("prof.json"));
        assert!(repo.delete("nope").is_err());
    }
}
