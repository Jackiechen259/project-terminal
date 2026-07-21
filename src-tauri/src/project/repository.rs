//! Project JSON repository backed by atomic file writes.

use std::path::PathBuf;

#[cfg(test)]
use chrono::Utc;

use crate::error::{AppError, AppResult};
use crate::storage;

use super::model::Project;
#[cfg(test)]
use super::model::ProjectType;

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct ProjectCollection {
    #[serde(default)]
    pub projects: Vec<Project>,
}

/// File-backed store for projects.
pub struct ProjectRepository {
    path: PathBuf,
}

impl ProjectRepository {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn load(&self) -> AppResult<ProjectCollection> {
        storage::read_or_default(&self.path, ProjectCollection::default())
    }

    pub fn save(&self, collection: &ProjectCollection) -> AppResult<()> {
        storage::write_json(&self.path, collection)
    }

    pub fn list(&self) -> AppResult<Vec<Project>> {
        Ok(self.load()?.projects)
    }

    pub fn get(&self, id: &str) -> AppResult<Project> {
        self.load()?
            .projects
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| AppError::ProjectNotFound(id.to_string()))
    }

    pub fn upsert(&self, project: Project) -> AppResult<Project> {
        project.validate()?;
        let mut collection = self.load()?;
        if let Some(existing) = collection.projects.iter_mut().find(|p| p.id == project.id) {
            *existing = project.clone();
        } else {
            collection.projects.push(project.clone());
        }
        self.save(&collection)?;
        Ok(project)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut collection = self.load()?;
        let before = collection.projects.len();
        collection.projects.retain(|p| p.id != id);
        if collection.projects.len() == before {
            return Err(AppError::ProjectNotFound(id.to_string()));
        }
        self.save(&collection)
    }
}

#[cfg(test)]
/// Build a new local project with a fresh id and timestamps. The caller is
/// expected to have already validated `path` exists (see commands/project.rs).
pub fn new_local_project(id: String, name: String, path: String) -> Project {
    let now = Utc::now();
    Project {
        id,
        name,
        project_type: ProjectType::Local,
        local: Some(super::model::LocalProjectConfig { path }),
        ssh: None,
        wsl: None,
        default_profile_id: None,
        created_at: now,
        updated_at: now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tempdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pt-proj-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_returns_empty_list() {
        let repo = ProjectRepository::new(tempdir().join("missing.json"));
        assert!(repo.list().unwrap().is_empty());
    }

    #[test]
    fn upsert_then_get_round_trips() {
        let repo = ProjectRepository::new(tempdir().join("projects.json"));
        let p = new_local_project("p1".into(), "Demo".into(), "D:\\Demo".into());
        repo.upsert(p.clone()).unwrap();
        let fetched = repo.get("p1").unwrap();
        assert_eq!(fetched.id, "p1");
        assert_eq!(fetched.name, "Demo");
    }

    #[test]
    fn upsert_replaces_existing_by_id() {
        let repo = ProjectRepository::new(tempdir().join("projects.json"));
        let mut p = new_local_project("p1".into(), "Demo".into(), "D:\\Demo".into());
        repo.upsert(p.clone()).unwrap();
        p.name = "Updated".into();
        repo.upsert(p).unwrap();
        assert_eq!(repo.list().unwrap().len(), 1);
        assert_eq!(repo.get("p1").unwrap().name, "Updated");
    }

    #[test]
    fn delete_removes_project() {
        let repo = ProjectRepository::new(tempdir().join("projects.json"));
        repo.upsert(new_local_project(
            "p1".into(),
            "Demo".into(),
            "D:\\Demo".into(),
        ))
        .unwrap();
        repo.delete("p1").unwrap();
        assert!(repo.get("p1").is_err());
    }

    #[test]
    fn delete_unknown_id_errors() {
        let repo = ProjectRepository::new(tempdir().join("projects.json"));
        assert!(repo.delete("nope").is_err());
    }

    #[test]
    fn upsert_invalid_project_errors() {
        let repo = ProjectRepository::new(tempdir().join("projects.json"));
        let mut p = new_local_project("p1".into(), "Demo".into(), "D:\\Demo".into());
        p.name = "  ".into();
        assert!(repo.upsert(p).is_err());
    }
}
