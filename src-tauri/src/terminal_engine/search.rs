use serde::{Deserialize, Serialize};

/// Search is expressed in stable terminal coordinates so a result remains
/// addressable while the live screen continues to scroll.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSearchPosition {
    pub stable_row: i64,
    pub column: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TerminalSearchDirection {
    #[default]
    Forward,
    Backward,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSearchQuery {
    pub query: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub direction: TerminalSearchDirection,
    #[serde(default)]
    pub start: Option<TerminalSearchPosition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSearchMatch {
    pub stable_row: i64,
    pub start_column: u16,
    pub end_column: u16,
}
