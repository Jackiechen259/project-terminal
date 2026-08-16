//! Single-window support: the `WindowManager` owns the process's only
//! desktop window.
//!
//! Project Terminal is a single-process, single-main-window application. The
//! only desktop window label is `main`. Projects, terminal tabs, split panes,
//! memos, and file views are multiplexed inside that window. A second
//! application launch never creates another window - it restores and focuses
//! the existing main window. Only the explicit Quit path terminates the
//! desktop process and all PTYs.
//!
//! PTYs stay process-global in `TerminalManager`; sessions carry the
//! workspace id of the window that created them (`main`).
//!
//! Closing the window never shuts the process down and never destroys the
//! window: the close path hides it to the tray (with running terminals the
//! frontend is asked whether to keep them running while hidden, or quit).
//! Only the tray's "Quit and Stop All Sessions" (or the equivalent frontend
//! action) triggers the global shutdown path.

pub mod commands;
pub mod manager;

pub use manager::{WindowCloseDecision, WindowInitOutcome, WindowManager};
