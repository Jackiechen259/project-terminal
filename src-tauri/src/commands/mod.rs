//! Tauri command modules.

pub mod agent;
pub mod clipboard;
pub mod daemon;
pub mod platform;
pub mod profile;
pub mod profile_template;
pub mod project;
pub mod ssh;
pub mod terminal;
use serde::Serialize;

/// Generic serializable payload wrapper used by commands that return a list.
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
