//! Small conversion helpers shared by SQLite repositories.

use chrono::{DateTime, Utc};
use rusqlite::types::ValueRef;
use serde::{de::DeserializeOwned, Serialize};

use crate::error::AppError;

pub fn json<T: Serialize>(value: &T, field: &str) -> Result<String, AppError> {
    serde_json::to_string(value)
        .map_err(|error| AppError::Database(format!("failed to encode {field} as JSON: {error}")))
}

pub fn json_value(value: &serde_json::Value, field: &str) -> Result<String, AppError> {
    serde_json::to_string(value)
        .map_err(|error| AppError::Database(format!("failed to encode {field} as JSON: {error}")))
}

pub fn parse_json<T: DeserializeOwned>(value: &str, field: &str) -> Result<T, AppError> {
    serde_json::from_str(value)
        .map_err(|error| AppError::Database(format!("failed to decode {field} JSON: {error}")))
}

pub fn optional_json<T: Serialize>(
    value: Option<&T>,
    field: &str,
) -> Result<Option<String>, AppError> {
    value.map(|value| json(value, field)).transpose()
}

pub fn parse_timestamp(value: &str, field: &str) -> Result<DateTime<Utc>, AppError> {
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .map_err(|error| AppError::Database(format!("invalid {field} timestamp {value}: {error}")))
}

pub fn timestamp(value: &DateTime<Utc>) -> String {
    value.to_rfc3339()
}

pub fn bool_i64(value: bool) -> i64 {
    i64::from(value)
}

pub fn optional_bool_i64(value: Option<bool>) -> Option<i64> {
    value.map(bool_i64)
}

pub fn bool_from_i64(value: i64, field: &str) -> Result<bool, AppError> {
    match value {
        0 => Ok(false),
        1 => Ok(true),
        other => Err(AppError::Database(format!(
            "invalid boolean value {other} in {field}"
        ))),
    }
}

pub fn optional_bool_from_i64(value: Option<i64>, field: &str) -> Result<Option<bool>, AppError> {
    value.map(|value| bool_from_i64(value, field)).transpose()
}

pub fn text_enum<T: Serialize>(value: &T, field: &str) -> Result<String, AppError> {
    let value = serde_json::to_value(value)
        .map_err(|error| AppError::Database(format!("failed to encode {field} enum: {error}")))?;
    value
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| AppError::Database(format!("{field} enum did not serialize to a string")))
}

pub fn parse_text_enum<T: DeserializeOwned>(value: &str, field: &str) -> Result<T, AppError> {
    serde_json::from_value(serde_json::Value::String(value.to_owned()))
        .map_err(|error| AppError::Database(format!("invalid {field} enum {value}: {error}")))
}

/// Read an optional SQL TEXT value without allocating an intermediate owned
/// value in every repository row mapper.
pub fn optional_text(value: ValueRef<'_>) -> Result<Option<String>, AppError> {
    match value {
        ValueRef::Null => Ok(None),
        ValueRef::Text(value) => String::from_utf8(value.to_vec())
            .map(Some)
            .map_err(|error| {
                AppError::Database(format!("invalid UTF-8 text in database: {error}"))
            }),
        _ => Err(AppError::Database(
            "expected a TEXT or NULL database value".into(),
        )),
    }
}
