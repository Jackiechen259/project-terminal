//! User-authored appearance data.
//!
//! Built-in colour schemes live in the frontend, because they are code rather
//! than data. What lands here is what the user brought with them - schemes
//! imported from Windows Terminal or from a file - which belongs alongside
//! `profiles.json` so a backup of the config directory captures it.

pub mod color_scheme;

pub use color_scheme::{ColorSchemeRepository, TerminalColorScheme};
