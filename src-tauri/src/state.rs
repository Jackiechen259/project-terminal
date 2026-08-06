//! Application state shared across Tauri commands.

use std::sync::Arc;

use parking_lot::Mutex;

use crate::appearance::ColorSchemeRepository;
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
    pub color_schemes: Arc<ColorSchemeRepository>,
    config_write_lock: Arc<Mutex<()>>,
}

impl AppState {
    /// Resolve config dirs, ensure the directory exists, and wire
    /// repositories against the resolved file paths. Callers MUST surface any
    /// error structurally - never panic.
    pub fn init() -> AppResult<(Self, ConfigDirs)> {
        let dirs = ConfigDirs::resolve()?;
        dirs.ensure_root()?;
        let state = Self::from_repositories(
            ProjectRepository::new(dirs.projects_path()),
            ProfileRepository::new(dirs.profiles_path()),
            TemplateRepository::new(dirs.templates_path()),
            SshConnectionRepository::new(dirs.ssh_connections_path()),
        )
        .with_color_schemes(ColorSchemeRepository::new(dirs.color_schemes_path()));
        Ok((state, dirs))
    }

    pub(crate) fn from_repositories(
        projects: ProjectRepository,
        profiles: ProfileRepository,
        templates: TemplateRepository,
        ssh: SshConnectionRepository,
    ) -> Self {
        // Colour schemes default to a file beside the others. They are given
        // separately rather than as a fifth argument because most callers -
        // every test helper - have no interest in them, and threading an
        // unused path through all of them would obscure the ones that do.
        let color_schemes = ColorSchemeRepository::new(
            projects.path().with_file_name("color-schemes.json"),
        );
        Self {
            projects: Arc::new(projects),
            profiles: Arc::new(profiles),
            templates: Arc::new(templates),
            ssh: Arc::new(ssh),
            color_schemes: Arc::new(color_schemes),
            config_write_lock: Arc::new(Mutex::new(())),
        }
    }

    fn with_color_schemes(mut self, repository: ColorSchemeRepository) -> Self {
        self.color_schemes = Arc::new(repository);
        self
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
