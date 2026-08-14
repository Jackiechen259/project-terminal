//! Multi-window support: the `WindowManager` owns every workspace window.
//!
//! One Project Terminal process hosts any number of workspace windows. Each
//! window has a unique label which is also its workspace id (`main` for the
//! first window created by the process, `workspace-{uuid}` afterwards), and
//! owns an independent frontend workspace state (tabs, splits, sidebar).
//! PTYs stay process-global in `TerminalManager`; sessions carry the
//! workspace id of the window that created them.
//!
//! Closing a window never shuts down the process: with running terminals the
//! frontend is asked whether to keep them running (window closes, sessions
//! stay reattachable) or stop them; without running terminals the window
//! closes directly. Only the tray's "Quit and Stop All Sessions" (or the
//! equivalent frontend action) triggers the global shutdown path.

pub mod commands;
pub mod manager;

pub use manager::{WindowCloseDecision, WindowInfo, WindowManager, WindowOpenOptions};
