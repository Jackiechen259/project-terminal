use wezterm_term::color::ColorPalette;
use wezterm_term::config::NewlineCanon;
use wezterm_term::{TerminalConfiguration, UnicodeVersion};

/// Default visible scrollback matches the existing Project Terminal setting.
pub const DEFAULT_SCROLLBACK_LINES: usize = 10_000;
const MIN_SCROLLBACK_LINES: usize = 1_000;
const MAX_SCROLLBACK_LINES: usize = 100_000;

/// Clamp a user-provided visible scrollback setting before it reaches
/// wezterm-term. The frontend already enforces the same range, but keeping
/// the invariant at the engine boundary also protects remote callers and
/// restart metadata.
pub fn normalize_scrollback_lines(lines: usize) -> usize {
    lines.clamp(MIN_SCROLLBACK_LINES, MAX_SCROLLBACK_LINES)
}

/// Convert the existing byte-budget setting into the line budget understood
/// by wezterm-term. A line is estimated conservatively so the migration does
/// not silently discard the user's configured history.
pub fn scrollback_lines_for_bytes(max_bytes: usize, cols: u16) -> usize {
    let estimated_bytes_per_line = usize::from(cols.max(1)).saturating_mul(4);
    normalize_scrollback_lines(max_bytes / estimated_bytes_per_line)
}

/// Configuration passed to each `wezterm_term::Terminal` instance.
///
/// This is intentionally an application type rather than a direct dependency
/// on the settings store.  The backend can construct it for local, WSL, SSH,
/// and remote sessions without coupling the terminal core to React state.
#[derive(Debug, Clone)]
pub struct WeztermTerminalConfig {
    pub palette: ColorPalette,
    pub scrollback_lines: usize,
    pub canonicalize_pasted_newlines: NewlineCanon,
    pub enable_kitty_graphics: bool,
    pub enable_kitty_keyboard: bool,
    pub unicode_version: UnicodeVersion,
    pub normalize_output_to_unicode_nfc: bool,
}

impl Default for WeztermTerminalConfig {
    fn default() -> Self {
        Self {
            palette: ColorPalette::default(),
            scrollback_lines: DEFAULT_SCROLLBACK_LINES,
            canonicalize_pasted_newlines: NewlineCanon::default(),
            enable_kitty_graphics: false,
            enable_kitty_keyboard: false,
            unicode_version: UnicodeVersion {
                version: 9,
                ambiguous_are_wide: false,
                cell_widths: None,
            },
            normalize_output_to_unicode_nfc: false,
        }
    }
}

impl TerminalConfiguration for WeztermTerminalConfig {
    fn scrollback_size(&self) -> usize {
        self.scrollback_lines
    }

    fn color_palette(&self) -> ColorPalette {
        self.palette.clone()
    }

    fn canonicalize_pasted_newlines(&self) -> NewlineCanon {
        self.canonicalize_pasted_newlines
    }

    fn enable_kitty_graphics(&self) -> bool {
        self.enable_kitty_graphics
    }

    fn enable_kitty_keyboard(&self) -> bool {
        self.enable_kitty_keyboard
    }

    fn unicode_version(&self) -> UnicodeVersion {
        self.unicode_version.clone()
    }

    fn normalize_output_to_unicode_nfc(&self) -> bool {
        self.normalize_output_to_unicode_nfc
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_existing_byte_budget_to_a_bounded_line_budget() {
        assert_eq!(scrollback_lines_for_bytes(4 * 1024 * 1024, 80), 13_107);
        assert_eq!(scrollback_lines_for_bytes(1, 80), MIN_SCROLLBACK_LINES);
        assert_eq!(
            scrollback_lines_for_bytes(usize::MAX, 1),
            MAX_SCROLLBACK_LINES
        );
    }

    #[test]
    fn normalizes_explicit_visible_scrollback_without_changing_raw_budget() {
        assert_eq!(normalize_scrollback_lines(1), MIN_SCROLLBACK_LINES);
        assert_eq!(normalize_scrollback_lines(25_000), 25_000);
        assert_eq!(normalize_scrollback_lines(usize::MAX), MAX_SCROLLBACK_LINES);
    }
}
