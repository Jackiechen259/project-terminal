//! Rust-owned terminal emulation.
//!
//! This module is deliberately independent from the PTY/session and UI
//! modules.  `wezterm-term` owns the VT parser, screen buffers, scrollback,
//! cursor state, cell attributes, hyperlinks, and terminal modes.  The
//! adapter exposes only a small, application-owned protocol to the rest of
//! Project Terminal so that the renderer can be replaced without changing
//! PTY or terminal-model code.

mod config;
mod input;
mod render_frame;
mod search;
mod wezterm_engine;

pub use config::{
    normalize_scrollback_lines, scrollback_lines_for_bytes, WeztermTerminalConfig,
    DEFAULT_SCROLLBACK_LINES,
};
pub use input::{
    TerminalKeyEvent, TerminalMouseButton, TerminalMouseEvent, TerminalMouseEventKind,
};
pub use render_frame::{
    CellIntensity, CellUnderline, CursorShape, CursorState, CursorVisibility, ImageCellFrame,
    RenderCell, RenderColor, RenderFrame, RenderRow, TerminalControlEvent,
};
pub use search::{
    TerminalSearchDirection, TerminalSearchMatch, TerminalSearchPosition, TerminalSearchQuery,
};
pub use wezterm_engine::WeztermTerminalEngine;

use wezterm_term::TerminalSize;

/// A terminal engine is a stateful VT emulator.  It does not own a PTY and it
/// never knows whether its output will be rendered by Canvas2D, WebGL, a
/// remote client, or a test harness.
pub trait TerminalEngine: Send {
    /// Feed bytes read from the PTY into the terminal parser.
    fn feed(&mut self, data: &[u8]);

    /// Update the terminal model's dimensions.  The PTY resize is performed
    /// by the session layer, in a separate operation with the same coalesced
    /// dimensions.
    fn resize(&mut self, size: TerminalSize);

    /// Force the next render extraction to contain the complete visible
    /// viewport.  Attach/resume uses this after a renderer has been detached.
    fn request_full_snapshot(&mut self);

    /// Extract at most one model update.  Dirty rows are selected using
    /// wezterm-term's sequence tracking; repeated calls without new state
    /// return `None`.
    fn take_render_frame(&mut self) -> Option<RenderFrame>;

    /// Move the renderer-owned viewport through stable scrollback rows. The
    /// terminal cursor and PTY continue to use the live screen; scrolling is
    /// a presentation request, not terminal input.
    fn set_viewport_top(&mut self, stable_row: i64);

    /// Drain control-plane changes such as title, cwd, and bell without
    /// mixing them into cell data.
    fn drain_control_events(&mut self) -> Vec<TerminalControlEvent>;

    /// Encode a semantic key according to the model's active keyboard modes
    /// and send it to the PTY writer.
    fn key_down(&mut self, event: &TerminalKeyEvent) -> Result<(), String>;

    /// Encode printable text through the model's keyboard path. This keeps
    /// IME/composition text out of the browser's raw PTY writer while leaving
    /// the event itself free of browser-specific escape sequences.
    fn text_input(&mut self, text: &str) -> Result<(), String>;

    /// Encode a mouse event after the model has interpreted its current
    /// mouse-reporting mode.
    fn mouse_event(&mut self, event: &TerminalMouseEvent) -> Result<(), String>;

    /// Send clipboard text using the model's bracketed-paste and newline
    /// canonicalization state.
    fn send_paste(&mut self, text: &str) -> Result<(), String>;

    fn bracketed_paste_enabled(&self) -> bool;

    /// Search the authoritative terminal model, including its Rust-owned
    /// scrollback. Results are returned in the requested traversal order.
    fn search(&self, query: &TerminalSearchQuery) -> Vec<TerminalSearchMatch>;
}
