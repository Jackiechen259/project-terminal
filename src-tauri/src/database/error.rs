//! Error conversion at the SQLite boundary.

use rusqlite::Error as SqliteError;

use crate::error::AppError;

/// Preserve a readable context while keeping SQLite internals out of the
/// frontend contract. The original error remains in the formatted message so
/// logs and diagnostics are still useful.
pub fn sqlite(context: &str, error: SqliteError) -> AppError {
    let detail = error.to_string();
    if matches!(error, SqliteError::SqliteFailure(ref code, _)
        if code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT
            || code.extended_code >= rusqlite::ffi::SQLITE_CONSTRAINT)
    {
        AppError::DatabaseConstraint(format!("{context}: {detail}"))
    } else {
        AppError::Database(format!("{context}: {detail}"))
    }
}

pub fn migration(context: &str, error: SqliteError) -> AppError {
    AppError::DatabaseMigration(format!("{context}: {error}"))
}
