//! Imported terminal colour schemes.

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::storage;

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
    value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|c| c.is_ascii_hexdigit())
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

/// Imported schemes on disk. Mirrors `TemplateRepository`.
pub struct ColorSchemeRepository {
    store: storage::CachedJsonFile<ColorSchemeCollection>,
}

impl ColorSchemeRepository {
    pub fn new(path: PathBuf) -> Self {
        Self {
            store: storage::CachedJsonFile::new(path),
        }
    }

    pub fn load(&self) -> AppResult<ColorSchemeCollection> {
        self.store.load(ColorSchemeCollection::default)
    }

    pub fn list(&self) -> AppResult<Vec<TerminalColorScheme>> {
        Ok(self.load()?.schemes)
    }

    pub fn upsert(&self, scheme: TerminalColorScheme) -> AppResult<TerminalColorScheme> {
        scheme.validate()?;
        let mut collection = self.load()?;
        match collection.schemes.iter().position(|s| s.id == scheme.id) {
            Some(index) => collection.schemes[index] = scheme.clone(),
            None => collection.schemes.push(scheme.clone()),
        }
        self.store.save(&collection)?;
        Ok(scheme)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut collection = self.load()?;
        let before = collection.schemes.len();
        collection.schemes.retain(|s| s.id != id);
        if collection.schemes.len() == before {
            return Err(AppError::Configuration(format!(
                "Color scheme was not found: {id}"
            )));
        }
        self.store.save(&collection)
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
        let root = std::env::temp_dir().join(format!("pt-scheme-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        ColorSchemeRepository::new(root.join("color-schemes.json"))
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
