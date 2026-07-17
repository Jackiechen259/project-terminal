//! Application state shared across Tauri commands.
//!
//! Phase 1 keeps it empty; Phase 2+ adds repositories and the terminal
//! manager.

#[derive(Default)]
pub struct AppState;

impl AppState {
    pub fn new() -> Self {
        Self
    }
}
