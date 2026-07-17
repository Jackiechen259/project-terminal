//! Tauri command modules. Phase 2 wires project, profile, and ssh
//! repository CRUD commands; Phase 3+ adds terminal commands.

pub mod profile;
pub mod project;
pub mod ssh;

use serde::Serialize;

/// Generic serializable payload wrapper used by commands that return a list.
/// Tauri can serialize `Vec<T>` directly, but this is convenient for adding
/// metadata later (counts, cursors, etc.).
#[allow(dead_code)]
#[derive(Debug, Serialize)]
pub struct ListResponse<T: Serialize> {
    pub items: Vec<T>,
}

impl<T: Serialize> ListResponse<T> {
    pub fn new(items: Vec<T>) -> Self {
        Self { items }
    }
}
