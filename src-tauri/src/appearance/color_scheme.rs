//! Imported terminal colour schemes.

use chrono::{DateTime, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::database::{self, Database};
use crate::error::{AppError, AppResult};
use std::sync::Arc;

/// A complete terminal palette.
///
/// Every colour is required and every colour is `#rrggbb`. A partial scheme is
/// rejected at the door rather than merged over a default: a missing
/// `background` silently inheriting black is how a palette ends up unreadable
/// in a way the user cannot diagnose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalColorScheme {
    pub id: String,
    pub name: String,
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_accent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_background: Option<String>,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Is this an opaque `#rrggbb` colour?
///
/// Deliberately narrow. Windows Terminal writes exactly this form, and
/// accepting shorthand or `rgb()` would push normalisation onto every reader.
pub fn is_hex_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

impl TerminalColorScheme {
    /// Every colour in the scheme, paired with the field it came from.
    fn colors(&self) -> Vec<(&'static str, &str)> {
        let mut colors = vec![
            ("background", self.background.as_str()),
            ("foreground", self.foreground.as_str()),
            ("cursor", self.cursor.as_str()),
            ("black", self.black.as_str()),
            ("red", self.red.as_str()),
            ("green", self.green.as_str()),
            ("yellow", self.yellow.as_str()),
            ("blue", self.blue.as_str()),
            ("magenta", self.magenta.as_str()),
            ("cyan", self.cyan.as_str()),
            ("white", self.white.as_str()),
            ("brightBlack", self.bright_black.as_str()),
            ("brightRed", self.bright_red.as_str()),
            ("brightGreen", self.bright_green.as_str()),
            ("brightYellow", self.bright_yellow.as_str()),
            ("brightBlue", self.bright_blue.as_str()),
            ("brightMagenta", self.bright_magenta.as_str()),
            ("brightCyan", self.bright_cyan.as_str()),
            ("brightWhite", self.bright_white.as_str()),
        ];
        if let Some(value) = &self.cursor_accent {
            colors.push(("cursorAccent", value));
        }
        if let Some(value) = &self.selection_background {
            colors.push(("selectionBackground", value));
        }
        colors
    }

    pub fn validate(&self) -> AppResult<()> {
        if self.id.trim().is_empty() {
            return Err(AppError::Configuration(
                "Color scheme requires an id".into(),
            ));
        }
        if self.name.trim().is_empty() {
            return Err(AppError::Configuration(
                "Color scheme requires a name".into(),
            ));
        }
        for (field, value) in self.colors() {
            if !is_hex_color(value) {
                return Err(AppError::Configuration(format!(
                    "Color scheme {} has an invalid {field}: {value}",
                    self.name
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorSchemeCollection {
    #[serde(default)]
    pub schemes: Vec<TerminalColorScheme>,
}

/// Imported schemes persisted in SQLite. Built-in schemes remain code-defined
/// in the frontend.
pub struct ColorSchemeRepository {
    db: Arc<Database>,
}

impl ColorSchemeRepository {
    pub fn new(source: impl Into<database::DatabaseSource>) -> Self {
        Self {
            db: source.into().into_database(),
        }
    }

    pub fn database(&self) -> Arc<Database> {
        Arc::clone(&self.db)
    }

    pub fn load(&self) -> AppResult<ColorSchemeCollection> {
        Ok(ColorSchemeCollection {
            schemes: self.list()?,
        })
    }

    pub fn list(&self) -> AppResult<Vec<TerminalColorScheme>> {
        self.db.with_connection(|connection| {
            let mut statement = connection
                .prepare("SELECT data_json FROM color_schemes ORDER BY name COLLATE NOCASE, id")
                .map_err(|error| database::error::sqlite("prepare color scheme list", error))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| database::error::sqlite("query color schemes", error))?;
            rows.map(|row| {
                let data =
                    row.map_err(|error| database::error::sqlite("read color scheme row", error))?;
                database::schema::parse_json(&data, "color scheme")
            })
            .collect()
        })
    }

    pub fn upsert(&self, scheme: TerminalColorScheme) -> AppResult<TerminalColorScheme> {
        scheme.validate()?;
        let data_json = database::schema::json(&scheme, "color scheme")?;
        self.db.with_connection(|connection| {
            connection
                .execute(
                    "INSERT INTO color_schemes(
                        id, name, data_json, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        data_json = excluded.data_json,
                        updated_at = excluded.updated_at",
                    params![
                        scheme.id,
                        scheme.name,
                        data_json,
                        database::schema::timestamp(&scheme.created_at),
                        database::schema::timestamp(&scheme.updated_at),
                    ],
                )
                .map_err(|error| database::error::sqlite("upsert color scheme", error))?;
            Ok(())
        })?;
        Ok(scheme)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        self.db.with_connection(|connection| {
            let changed = connection
                .execute("DELETE FROM color_schemes WHERE id = ?1", params![id])
                .map_err(|error| database::error::sqlite("delete color scheme", error))?;
            if changed == 0 {
                return Err(AppError::Configuration(format!(
                    "Color scheme was not found: {id}"
                )));
            }
            Ok(())
        })
    }

    pub(crate) fn count(&self) -> AppResult<i64> {
        self.db.with_connection(|connection| {
            connection
                .query_row("SELECT COUNT(*) FROM color_schemes", [], |row| row.get(0))
                .map_err(|error| database::error::sqlite("count color schemes", error))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn sample(id: &str) -> TerminalColorScheme {
        let now = Utc::now();
        let c = "#123456".to_string();
        TerminalColorScheme {
            id: id.to_string(),
            name: format!("Scheme {id}"),
            background: c.clone(),
            foreground: c.clone(),
            cursor: c.clone(),
            cursor_accent: None,
            selection_background: None,
            black: c.clone(),
            red: c.clone(),
            green: c.clone(),
            yellow: c.clone(),
            blue: c.clone(),
            magenta: c.clone(),
            cyan: c.clone(),
            white: c.clone(),
            bright_black: c.clone(),
            bright_red: c.clone(),
            bright_green: c.clone(),
            bright_yellow: c.clone(),
            bright_blue: c.clone(),
            bright_magenta: c.clone(),
            bright_cyan: c.clone(),
            bright_white: c,
            created_at: now,
            updated_at: now,
        }
    }

    fn repository() -> ColorSchemeRepository {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("project-terminal.db");
        ColorSchemeRepository::new(Database::open(path).unwrap())
    }

    #[test]
    fn accepts_only_opaque_six_digit_hex() {
        assert!(is_hex_color("#0c0c0c"));
        assert!(is_hex_color("#FFFFFF"));
        // Shorthand, alpha and functional notation are all things Windows
        // Terminal never writes, so rejecting them keeps every reader simple.
        assert!(!is_hex_color("#fff"));
        assert!(!is_hex_color("#0c0c0cff"));
        assert!(!is_hex_color("rgb(1,2,3)"));
        assert!(!is_hex_color("0c0c0c"));
        assert!(!is_hex_color("#0c0c0g"));
    }

    #[test]
    fn a_malformed_colour_rejects_the_whole_scheme() {
        // Merging a partial scheme over a default is how a palette ends up
        // black on black with nothing to point at.
        let mut scheme = sample("s1");
        scheme.green = "not a colour".into();
        let error = scheme.validate().unwrap_err().to_string();
        assert!(error.contains("green"), "{error}");
    }

    #[test]
    fn round_trips_through_the_repository() {
        let repository = repository();
        let scheme = sample("s1");
        repository.upsert(scheme.clone()).unwrap();

        assert_eq!(repository.list().unwrap(), vec![scheme.clone()]);

        let mut renamed = scheme.clone();
        renamed.name = "Renamed".into();
        repository.upsert(renamed.clone()).unwrap();
        assert_eq!(repository.list().unwrap(), vec![renamed]);

        repository.delete("s1").unwrap();
        assert!(repository.list().unwrap().is_empty());
        assert!(repository.delete("s1").is_err());
    }

    #[test]
    fn an_invalid_scheme_never_reaches_disk() {
        let repository = repository();
        let mut scheme = sample("s1");
        scheme.background = "#xyz".into();
        assert!(repository.upsert(scheme).is_err());
        assert!(repository.list().unwrap().is_empty());
    }
}
