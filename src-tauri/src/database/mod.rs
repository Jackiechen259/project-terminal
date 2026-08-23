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
