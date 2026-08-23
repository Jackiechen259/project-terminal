//! SQLite connection ownership and transaction helpers.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::{params, Connection, Transaction};

use crate::error::{AppError, AppResult};

use super::{error, migrations};

pub struct Database {
    path: PathBuf,
    connection: Mutex<Connection>,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> AppResult<Arc<Self>> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(AppError::Io)?;
        }

        let mut connection = Connection::open(&path)
            .map_err(|error| super::error::sqlite("open SQLite database", error))?;
        configure(&mut connection)?;
        migrations::run(&mut connection)?;

        tracing::info!(database = %path.display(), schema_version = migrations::CURRENT_SCHEMA_VERSION, "SQLite persistence ready");
        Ok(Arc::new(Self {
            path,
            connection: Mutex::new(connection),
        }))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn with_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        let connection = self.connection.lock();
        operation(&connection)
    }

    pub fn transaction<T>(
        &self,
        operation: impl FnOnce(&Transaction<'_>) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction()
            .map_err(|error| super::error::sqlite("begin transaction", error))?;
        match operation(&transaction) {
            Ok(value) => {
                transaction
                    .commit()
                    .map_err(|error| super::error::sqlite("commit transaction", error))?;
                Ok(value)
            }
            Err(error) => {
                // Dropping a transaction rolls it back. Explicit rollback is
                // best effort because the original domain error is more
                // useful to the caller than a secondary rollback failure.
                let _ = transaction.rollback();
                Err(error)
            }
        }
    }

    pub fn metadata_get(&self, key: &str) -> AppResult<Option<String>> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT value FROM app_metadata WHERE key = ?1",
                    params![key],
                    |row| row.get(0),
                )
                .map(Some)
                .or_else(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    error => Err(super::error::sqlite("read app metadata", error)),
                })
        })
    }

    pub fn metadata_set(&self, key: &str, value: &str) -> AppResult<()> {
        self.with_connection(|connection| {
            connection
                .execute(
                    "INSERT INTO app_metadata(key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![key, value],
                )
                .map_err(|error| super::error::sqlite("write app metadata", error))?;
            Ok(())
        })
    }

    pub fn metadata_set_tx(transaction: &Transaction<'_>, key: &str, value: &str) -> AppResult<()> {
        transaction
            .execute(
                "INSERT INTO app_metadata(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(|error| super::error::sqlite("write app metadata", error))?;
        Ok(())
    }

    pub fn foreign_key_check(&self) -> AppResult<Vec<String>> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare("PRAGMA foreign_key_check")
                .map_err(|error| super::error::sqlite("prepare foreign key check", error))?;
            let rows = statement
                .query_map([], |row| {
                    let table: String = row.get(0)?;
                    let rowid: i64 = row.get(1)?;
                    let parent: String = row.get(2)?;
                    Ok(format!("{table}:{rowid}->{parent}"))
                })
                .map_err(|error| super::error::sqlite("run foreign key check", error))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| super::error::sqlite("read foreign key check", error))
        })
    }
}

fn configure(connection: &mut Connection) -> AppResult<()> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA journal_mode = WAL;",
        )
        .map_err(|error| error::sqlite("configure SQLite pragmas", error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_with_schema_and_safe_pragmas() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("project-terminal.db")).unwrap();
        let version: i64 = database
            .with_connection(|connection| {
                connection
                    .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                        row.get(0)
                    })
                    .map_err(|error| error::sqlite("read schema version in test", error))
            })
            .unwrap();
        assert_eq!(version, migrations::CURRENT_SCHEMA_VERSION);

        let foreign_keys: i64 = database
            .with_connection(|connection| {
                connection
                    .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
                    .map_err(|error| error::sqlite("read foreign_keys in test", error))
            })
            .unwrap();
        assert_eq!(foreign_keys, 1);

        let journal_mode: String = database
            .with_connection(|connection| {
                connection
                    .query_row("PRAGMA journal_mode", [], |row| row.get(0))
                    .map_err(|error| error::sqlite("read journal_mode in test", error))
            })
            .unwrap();
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
    }

    #[test]
    fn migrations_are_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("project-terminal.db");
        let first = Database::open(&path).unwrap();
        drop(first);
        let second = Database::open(&path).unwrap();
        let count: i64 = second
            .with_connection(|connection| {
                connection
                    .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                        row.get(0)
                    })
                    .map_err(|error| error::sqlite("count migrations in test", error))
            })
            .unwrap();
        assert_eq!(count, 1);
    }
}
