//! Resolve the application's config directory.
//!
//! Per plan §2.4: `%APPDATA%\ProjectTerminal\`. We never hardcode usernames
//! and never write to the install directory.

use std::path::PathBuf;

use crate::error::{AppError, AppResult};

/// Application config directory, e.g. `%APPDATA%\ProjectTerminal`.
#[derive(Debug, Clone)]
pub struct ConfigDirs {
    root: PathBuf,
}

impl ConfigDirs {
    /// Resolve the config directory using `dirs::config_dir`. On Windows this
    /// returns `%APPDATA%`. Fails explicitly if the platform returns None -
    /// callers must surface a readable error, not silently fall back.
    pub fn resolve() -> AppResult<Self> {
        let base = dirs::config_dir().ok_or_else(|| {
            AppError::Configuration(
                "Could not determine the user config directory for this platform".to_string(),
            )
        })?;
        let root = base.join("ProjectTerminal");
        Ok(Self { root })
    }

    /// Constructor for tests that want an explicit root.
    #[cfg(test)]
    pub fn from_root(root: PathBuf) -> Self {
        Self { root }
    }

    #[cfg(test)]
    pub fn root(&self) -> &std::path::Path {
        &self.root
    }

    pub fn ensure_root(&self) -> AppResult<()> {
        std::fs::create_dir_all(&self.root).map_err(AppError::Io)?;
        Ok(())
    }

    pub fn projects_path(&self) -> PathBuf {
        self.root.join("projects.json")
    }
    pub fn profiles_path(&self) -> PathBuf {
        self.root.join("profiles.json")
    }
    pub fn ssh_connections_path(&self) -> PathBuf {
        self.root.join("ssh-connections.json")
    }
    #[cfg(test)]
    pub fn settings_path(&self) -> PathBuf {
        self.root.join("settings.json")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_returns_existing_or_appdata_path() {
        // We do not assert a specific prefix (CI runs on Linux too) - the real
        // requirement is that resolve() returns a path that ends in
        // `ProjectTerminal`.
        let dirs = ConfigDirs::resolve().expect("config dir should resolve");
        assert!(dirs.root().to_string_lossy().ends_with("ProjectTerminal"));
    }

    #[test]
    fn ensure_root_creates_directory() {
        let tmp = std::env::temp_dir().join(format!("pt-cfg-{}", uuid::Uuid::new_v4()));
        let dirs = ConfigDirs::from_root(tmp.join("ProjectTerminal"));
        dirs.ensure_root().unwrap();
        assert!(dirs.root().exists());
    }

    #[test]
    fn paths_use_expected_filenames() {
        let dirs = ConfigDirs::from_root(std::path::PathBuf::from("/tmp/pt-test"));
        assert!(dirs
            .projects_path()
            .to_string_lossy()
            .ends_with("projects.json"));
        assert!(dirs
            .profiles_path()
            .to_string_lossy()
            .ends_with("profiles.json"));
        assert!(dirs
            .ssh_connections_path()
            .to_string_lossy()
            .ends_with("ssh-connections.json"));
        assert!(dirs
            .settings_path()
            .to_string_lossy()
            .ends_with("settings.json"));
    }
}
