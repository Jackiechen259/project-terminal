//! Commands for the user's imported terminal colour schemes.
//!
//! Built-in schemes are not served from here. They are code that ships with
//! the frontend, and routing them through IPC would add a round trip to the
//! path that decides what the first terminal looks like.

use std::collections::HashSet;
use std::path::PathBuf;

use chrono::Utc;
use serde::Deserialize;

use crate::appearance::TerminalColorScheme;
use crate::commands::ListResponse;
use crate::error::{AppError, AppResult};
use crate::state::{new_id, AppState};

#[tauri::command]
pub fn list_color_schemes(
    state: tauri::State<'_, AppState>,
) -> AppResult<ListResponse<TerminalColorScheme>> {
    Ok(ListResponse::new(state.color_schemes.list()?))
}

#[tauri::command]
pub fn delete_color_scheme(state: tauri::State<'_, AppState>, id: String) -> AppResult<()> {
    state.with_config_write(|| state.color_schemes.delete(&id))
}

/// The shapes a scheme file people share actually comes in.
///
/// Untagged, so one command accepts all three: a bare scheme object, a bare
/// array of them, or a whole Windows Terminal `settings.json` that happens to
/// contain a `schemes` key. Asking the user which kind of file they have would
/// be asking them to open it and find out.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ColorSchemeFile {
    Wrapped { schemes: Vec<ImportedScheme> },
    List(Vec<ImportedScheme>),
    Single(Box<ImportedScheme>),
}

/// A scheme as written by Windows Terminal, or by us.
///
/// Both spellings of the sixth ANSI colour are accepted: Windows Terminal
/// calls it `purple`, and everything else calls it magenta.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportedScheme {
    name: String,
    background: String,
    foreground: String,
    #[serde(default)]
    cursor_color: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    selection_background: Option<String>,
    black: String,
    red: String,
    green: String,
    yellow: String,
    blue: String,
    #[serde(default)]
    purple: Option<String>,
    #[serde(default)]
    magenta: Option<String>,
    cyan: String,
    white: String,
    bright_black: String,
    bright_red: String,
    bright_green: String,
    bright_yellow: String,
    bright_blue: String,
    #[serde(default)]
    bright_purple: Option<String>,
    #[serde(default)]
    bright_magenta: Option<String>,
    bright_cyan: String,
    bright_white: String,
}

impl ImportedScheme {
    fn convert(self) -> AppResult<TerminalColorScheme> {
        let magenta = self.magenta.or(self.purple).ok_or_else(|| {
            AppError::Configuration(format!(
                "Color scheme {} is missing its magenta (purple) color",
                self.name
            ))
        })?;
        let bright_magenta = self.bright_magenta.or(self.bright_purple).ok_or_else(|| {
            AppError::Configuration(format!(
                "Color scheme {} is missing its bright magenta (purple) color",
                self.name
            ))
        })?;
        let now = Utc::now();
        let scheme = TerminalColorScheme {
            id: new_id("scheme"),
            name: self.name.trim().to_string(),
            cursor: self
                .cursor
                .or(self.cursor_color)
                .unwrap_or_else(|| self.foreground.clone()),
            cursor_accent: Some(self.background.clone()),
            selection_background: self.selection_background,
            background: self.background,
            foreground: self.foreground,
            black: self.black,
            red: self.red,
            green: self.green,
            yellow: self.yellow,
            blue: self.blue,
            magenta,
            cyan: self.cyan,
            white: self.white,
            bright_black: self.bright_black,
            bright_red: self.bright_red,
            bright_green: self.bright_green,
            bright_yellow: self.bright_yellow,
            bright_blue: self.bright_blue,
            bright_magenta,
            bright_cyan: self.bright_cyan,
            bright_white: self.bright_white,
            created_at: now,
            updated_at: now,
        };
        scheme.validate()?;
        Ok(scheme)
    }
}

/// Import every scheme in a file the user picked.
///
/// The path comes from the system file dialog, so it is the user's own
/// choice rather than anything a page or a terminal produced.
#[tauri::command]
pub fn import_color_schemes_from_file(
    state: tauri::State<'_, AppState>,
    path: String,
) -> AppResult<ListResponse<TerminalColorScheme>> {
    let contents = std::fs::read_to_string(PathBuf::from(&path))?;
    // Windows Terminal writes JSON with comments and trailing commas, and a
    // scheme file copied out of one usually keeps them.
    let normalised = super::windows_terminal::normalise_jsonc(
        contents.trim_start_matches('\u{feff}'),
    );
    let parsed: ColorSchemeFile = serde_json::from_str(&normalised)
        .map_err(|error| AppError::Configuration(format!("Invalid color scheme file: {error}")))?;
    let incoming = match parsed {
        ColorSchemeFile::Wrapped { schemes } => schemes,
        ColorSchemeFile::List(schemes) => schemes,
        ColorSchemeFile::Single(scheme) => vec![*scheme],
    };
    if incoming.is_empty() {
        return Err(AppError::Configuration(
            "That file contains no color schemes".into(),
        ));
    }

    state.with_config_write(|| {
        let mut existing: HashSet<String> = state
            .color_schemes
            .list()?
            .into_iter()
            .map(|scheme| scheme.name.to_lowercase())
            .collect();
        let mut imported = Vec::new();
        for scheme in incoming {
            let converted = scheme.convert()?;
            if !existing.insert(converted.name.to_lowercase()) {
                continue;
            }
            imported.push(state.color_schemes.upsert(converted)?);
        }
        Ok(ListResponse::new(imported))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scheme_json(name: &str, magenta_key: &str) -> String {
        let bright_magenta_key = if magenta_key == "purple" {
            "brightPurple"
        } else {
            "brightMagenta"
        };
        format!(
            r##"{{
              "name": "{name}",
              "background": "#0c0c0c", "foreground": "#cccccc",
              "cursorColor": "#ffffff", "selectionBackground": "#3a3a3a",
              "black": "#0c0c0c", "red": "#c50f1f", "green": "#13a10e",
              "yellow": "#c19c00", "blue": "#0037da", "{magenta_key}": "#881798",
              "cyan": "#3a96dd", "white": "#cccccc",
              "brightBlack": "#767676", "brightRed": "#e74856",
              "brightGreen": "#16c60c", "brightYellow": "#f9f1a5",
              "brightBlue": "#3b78ff", "{bright_magenta_key}": "#b4009e",
              "brightCyan": "#61d6d6", "brightWhite": "#f2f2f2"
            }}"##
        )
    }

    fn parse(json: &str) -> ColorSchemeFile {
        serde_json::from_str(json).expect("scheme file should parse")
    }

    #[test]
    fn accepts_windows_terminals_purple_and_everyone_elses_magenta() {
        for key in ["purple", "magenta"] {
            let ColorSchemeFile::Single(scheme) = parse(&scheme_json("Campbell", key)) else {
                panic!("a bare object should parse as a single scheme");
            };
            let converted = scheme.convert().unwrap();
            assert_eq!(converted.magenta, "#881798");
            assert_eq!(converted.bright_magenta, "#b4009e");
        }
    }

    #[test]
    fn accepts_a_bare_list_and_a_whole_settings_file() {
        let one = scheme_json("Campbell", "purple");
        let two = scheme_json("Vintage", "purple");

        let list = parse(&format!("[{one},{two}]"));
        assert!(matches!(list, ColorSchemeFile::List(schemes) if schemes.len() == 2));

        let wrapped = parse(&format!(
            r##"{{ "profiles": {{ "list": [] }}, "schemes": [{one}] }}"##
        ));
        assert!(matches!(wrapped, ColorSchemeFile::Wrapped { schemes } if schemes.len() == 1));
    }

    #[test]
    fn a_malformed_colour_fails_the_import_rather_than_landing_half_applied() {
        let json = scheme_json("Campbell", "purple").replace("#13a10e", "green");
        let ColorSchemeFile::Single(scheme) = parse(&json) else {
            panic!("expected a single scheme");
        };
        let error = scheme.convert().unwrap_err().to_string();
        assert!(error.contains("green"), "{error}");
    }

    #[test]
    fn defaults_the_cursor_to_the_foreground_when_the_scheme_omits_it() {
        // Windows Terminal leaves an unset cursor colour to the terminal.
        let json =
            scheme_json("Campbell", "purple").replace(r##""cursorColor": "#ffffff","##, "");
        let ColorSchemeFile::Single(scheme) = parse(&json) else {
            panic!("expected a single scheme");
        };
        let converted = scheme.convert().unwrap();
        assert_eq!(converted.cursor, converted.foreground);
        assert_eq!(converted.cursor_accent.as_deref(), Some("#0c0c0c"));
    }
}
