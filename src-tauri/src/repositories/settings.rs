use std::sync::Arc;

use chrono::Utc;
use rusqlite::{params, Transaction};
use serde::{de::DeserializeOwned, Serialize};

use crate::database::{self, Database};
use crate::error::{AppError, AppResult};

pub struct SettingsRepository {
    db: Arc<Database>,
}

impl SettingsRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { db: database }
    }

    pub fn get_value(&self, key: &str) -> AppResult<Option<serde_json::Value>> {
        self.db.with_connection(|connection| {
            let raw = connection
                .query_row(
                    "SELECT value_json FROM settings WHERE key = ?1",
                    params![key],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| database::error::sqlite("read setting", error))?;
            raw.map(|value| database::schema::parse_json(&value, "setting"))
                .transpose()
        })
    }

    pub fn get<T: DeserializeOwned>(&self, key: &str) -> AppResult<Option<T>> {
        self.get_value(key)?
            .map(|value| {
                serde_json::from_value(value)
                    .map_err(|error| AppError::Database(format!("decode setting {key}: {error}")))
            })
            .transpose()
    }

    pub fn set_value(&self, key: &str, value: &serde_json::Value) -> AppResult<()> {
        self.db
            .transaction(|transaction| Self::set_value_tx(transaction, key, value))
    }

    pub fn set<T: Serialize>(&self, key: &str, value: &T) -> AppResult<()> {
        let value = serde_json::to_value(value)
            .map_err(|error| AppError::Database(format!("encode setting {key}: {error}")))?;
        self.set_value(key, &value)
    }

    pub(crate) fn set_value_tx(
        transaction: &Transaction<'_>,
        key: &str,
        value: &serde_json::Value,
    ) -> AppResult<()> {
        if key.trim().is_empty() {
            return Err(AppError::Configuration(
                "Setting key must not be empty".into(),
            ));
        }
        let value_json = database::schema::json_value(value, "setting")?;
        transaction
            .execute(
                "INSERT INTO settings(key, value_json, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json,
                    updated_at = excluded.updated_at",
                params![key, value_json, Utc::now().to_rfc3339()],
            )
            .map_err(|error| database::error::sqlite("write setting", error))?;
        Ok(())
    }

    pub fn delete(&self, key: &str) -> AppResult<()> {
        self.db.with_connection(|connection| {
            connection
                .execute("DELETE FROM settings WHERE key = ?1", params![key])
                .map_err(|error| database::error::sqlite("delete setting", error))?;
            Ok(())
        })
    }
}

use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_json_values() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(directory.path().join("project-terminal.db")).unwrap();
        let repository = SettingsRepository::new(database);
        repository
            .set("general-settings", &serde_json::json!({"theme":"dark"}))
            .unwrap();
        let value: serde_json::Value = repository.get("general-settings").unwrap().unwrap();
        assert_eq!(value["theme"], "dark");
    }
}
