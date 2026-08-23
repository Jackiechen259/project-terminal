//! SQLite persistence foundation.
//!
//! The application owns one SQLite connection per process. Repositories use
//! this module for short, synchronous reads and explicit transactions; the
//! frontend still keeps its reactive state in Zustand.

mod connection;
pub mod error;
mod migrations;
pub mod schema;

pub use connection::Database;
pub use migrations::CURRENT_SCHEMA_VERSION;

use std::path::PathBuf;
use std::sync::Arc;

/// Constructor input used by repositories. Path-based construction is kept
/// for isolated legacy unit fixtures; production AppState always injects the
/// single shared database connection.
pub enum DatabaseSource {
    Shared(Arc<Database>),
    Path(PathBuf),
}

impl From<Arc<Database>> for DatabaseSource {
    fn from(database: Arc<Database>) -> Self {
        Self::Shared(database)
    }
}

impl From<PathBuf> for DatabaseSource {
    fn from(path: PathBuf) -> Self {
        Self::Path(path)
    }
}

impl DatabaseSource {
    pub fn into_database(self) -> Arc<Database> {
        match self {
            Self::Shared(database) => database,
            Self::Path(path) => {
                Database::open(path).expect("repository test database should be openable")
            }
        }
    }
}
