//! Application state shared across Tauri commands.

use std::sync::Arc;

use parking_lot::Mutex;

use crate::appearance::ColorSchemeRepository;
use crate::config_dirs::ConfigDirs;
use crate::database::Database;
use crate::error::AppResult;
use crate::profile::{ProfileRepository, TemplateRepository};
use crate::project::ProjectRepository;
use crate::repositories::{
    MemoRepository, ProjectCollectionsRepository, SettingsRepository, WorkspaceStateRepository,
};
use crate::ssh::SshConnectionRepository;

/// Holds the SQLite repositories and serializes every read-modify-write
/// configuration mutation so related command operations have one application
/// lock in addition to SQLite's transaction boundary.
#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Database>,
    pub projects: Arc<ProjectRepository>,
    pub profiles: Arc<ProfileRepository>,
    pub templates: Arc<TemplateRepository>,
    pub ssh: Arc<SshConnectionRepository>,
    pub color_schemes: Arc<ColorSchemeRepository>,
    pub settings: Arc<SettingsRepository>,
    pub collections: Arc<ProjectCollectionsRepository>,
    pub memos: Arc<MemoRepository>,
    pub workspace_state: Arc<WorkspaceStateRepository>,
    config_write_lock: Arc<Mutex<()>>,
}

impl AppState {
    /// Resolve config dirs, ensure the directory exists, open SQLite, and wire
    /// all repositories to the shared database. Callers MUST surface any
    /// error structurally - never panic.
    pub fn init() -> AppResult<(Self, ConfigDirs)> {
        let dirs = ConfigDirs::resolve()?;
        dirs.ensure_root()?;
        let database = Database::open(dirs.database_path())?;
        crate::legacy_migration::migrate(&database, &dirs)?;
        let state = Self::from_database(database);
        Ok((state, dirs))
    }

    pub(crate) fn from_database(database: Arc<Database>) -> Self {
        Self {
            db: Arc::clone(&database),
            projects: Arc::new(ProjectRepository::new(Arc::clone(&database))),
            profiles: Arc::new(ProfileRepository::new(Arc::clone(&database))),
            templates: Arc::new(TemplateRepository::new(Arc::clone(&database))),
            ssh: Arc::new(SshConnectionRepository::new(Arc::clone(&database))),
            color_schemes: Arc::new(ColorSchemeRepository::new(Arc::clone(&database))),
            settings: Arc::new(SettingsRepository::new(Arc::clone(&database))),
            collections: Arc::new(ProjectCollectionsRepository::new(Arc::clone(&database))),
            memos: Arc::new(MemoRepository::new(Arc::clone(&database))),
            workspace_state: Arc::new(WorkspaceStateRepository::new(database)),
            config_write_lock: Arc::new(Mutex::new(())),
        }
    }

    pub(crate) fn from_repositories(
        projects: ProjectRepository,
        _profiles: ProfileRepository,
        _templates: TemplateRepository,
        _ssh: SshConnectionRepository,
    ) -> Self {
        // Keep older unit-test fixtures source-compatible while enforcing the
        // production invariant that every repository in an AppState shares one
        // SQLite connection. The project repository is the anchor because
        // existing fixtures already pass it first.
        let database = projects.database();
        Self::from_database(database)
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
