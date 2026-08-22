use serde::{Deserialize, Serialize};

/// A selection endpoint in the Rust-owned terminal coordinate space.
/// `stable_row` remains addressable while live output scrolls the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSelectionPoint {
    pub stable_row: i64,
    pub column: u16,
}
