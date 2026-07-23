//! Application state shared across Tauri commands.

use std::sync::Arc;

use parking_lot::Mutex;

use crate::config_dirs::ConfigDirs;
use crate::error::AppResult;
use crate::profile::{ProfileRepository, TemplateRepository};
use crate::project::ProjectRepository;
use crate::ssh::SshConnectionRepository;

/// Holds the configuration repositories and serializes every read-modify-write
/// mutation. The repositories are file-backed, so allowing two commands to
/// mutate them concurrently could otherwise lose one command's update.
#[derive(Clone)]
pub struct AppState {
    pub projects: Arc<ProjectRepository>,
    pub profiles: Arc<ProfileRepository>,
    pub templates: Arc<TemplateRepository>,
    pub ssh: Arc<SshConnectionRepository>,
    config_write_lock: Arc<Mutex<()>>,
}

impl AppState {
    /// Resolve config dirs, ensure the directory exists, and wire
    /// repositories against the resolved file paths. Callers MUST surface any
    /// error structurally - never panic.
    pub fn init() -> AppResult<Self> {
        let dirs = ConfigDirs::resolve()?;
        dirs.ensure_root()?;
        Ok(Self::from_repositories(
            ProjectRepository::new(dirs.projects_path()),
            ProfileRepository::new(dirs.profiles_path()),
            TemplateRepository::new(dirs.templates_path()),
            SshConnectionRepository::new(dirs.ssh_connections_path()),
        ))
    }

    pub(crate) fn from_repositories(
        projects: ProjectRepository,
        profiles: ProfileRepository,
        templates: TemplateRepository,
        ssh: SshConnectionRepository,
    ) -> Self {
        Self {
            projects: Arc::new(projects),
            profiles: Arc::new(profiles),
            templates: Arc::new(templates),
            ssh: Arc::new(ssh),
            config_write_lock: Arc::new(Mutex::new(())),
        }
    }

    /// Serialize a complete configuration mutation, including validation reads
    /// and related writes to more than one repository.
    pub fn with_config_write<T>(&self, operation: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
        let _guard = self.config_write_lock.lock();
        operation()
    }
}

/// Helper: produce a `String` id with the given prefix + a UUIDv4.
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}
