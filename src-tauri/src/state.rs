//! Application state shared across Tauri commands.

use std::sync::Arc;

use crate::error::AppResult;
use crate::profile::{ProfileRepository, TemplateRepository};
use crate::project::ProjectRepository;
use crate::ssh::SshConnectionRepository;
use crate::config_dirs::ConfigDirs;

/// Holds the configuration directories and repositories. Repositories are
/// cheap to construct (they just hold paths) so they are recreated per command
/// call to avoid holding a lock across awaits.
#[derive(Clone)]
pub struct AppState {
    pub projects: Arc<ProjectRepository>,
    pub profiles: Arc<ProfileRepository>,
    pub templates: Arc<TemplateRepository>,
    pub ssh: Arc<SshConnectionRepository>,
}

impl AppState {
    /// Resolve config dirs, ensure the directory exists, and wire
    /// repositories against the resolved file paths. Callers MUST surface any
    /// error structurally - never panic.
    pub fn init() -> AppResult<Self> {
        let dirs = ConfigDirs::resolve()?;
        dirs.ensure_root()?;
        Ok(Self {
            projects: Arc::new(ProjectRepository::new(dirs.projects_path())),
            profiles: Arc::new(ProfileRepository::new(dirs.profiles_path())),
            templates: Arc::new(TemplateRepository::new(dirs.templates_path())),
            ssh: Arc::new(SshConnectionRepository::new(dirs.ssh_connections_path())),
        })
    }
}

/// Helper: produce a `String` id with the given prefix + a UUIDv4.
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}
