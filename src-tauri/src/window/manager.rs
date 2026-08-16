//! `WindowManager`: owns every workspace window of the process.
//!
//! Invariants:
//!
//! - A window's label IS its workspace id (`main` for the first window of the
//!   process, `workspace-{uuid}` afterwards), so the registry is a single map
//!   keyed by either name.
//! - PTYs are process-global (`TerminalManager`). Sessions carry the
//!   workspace id of the window that created them; closing one window never
//!   touches sessions owned by another.
//! - Closing a window never shuts the process down. With running sessions the
//!   frontend chooses between "keep running" (window closes, PTYs stay and can
//!   be reattached by reopening the workspace) and "stop them" (only this
//!   workspace's sessions close). Only the explicit quit path calls
//!   `TerminalManager::close_all`.
//! - Geometry and identity of every workspace survive process exit in
//!   `window-workspaces.json`, so windows can be restored on the next launch.
//! - Windows are created by this manager only; no frontend component ever
//!   calls `WebviewWindowBuilder` directly.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tauri::menu::{IsMenuItem, Menu, MenuItem, Submenu};
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::{AppError, AppResult};
use crate::state::new_id;
use crate::storage;
use crate::terminal::manager::TerminalManager;
use crate::terminal::session::SessionStatus;

/// Label/workspace id of the first window of the process. Kept for backward
/// compatibility with existing installs; every later window is a
/// `workspace-{uuid}` window.
pub const LEGACY_WORKSPACE_ID: &str = "main";

const DEFAULT_WINDOW_WIDTH: f64 = 1280.0;
const DEFAULT_WINDOW_HEIGHT: f64 = 800.0;
const MIN_WINDOW_WIDTH: f64 = 800.0;
const MIN_WINDOW_HEIGHT: f64 = 500.0;
/// Largest persisted window dimension we will restore. Anything larger is a
/// leftover from a different (or removed) monitor setup or a corrupt record.
/// tao's Windows backend runs unchecked i32 arithmetic on the requested size
/// while adjusting the window rect for decorations: a size near `u32::MAX`
/// panics in debug builds and wraps in release builds, so such values must
/// never reach the window builder.
const MAX_WINDOW_DIMENSION: f64 = 8192.0;
/// Offset applied to each fresh window so it does not cover its predecessor.
const CASCADE_OFFSET: i32 = 32;
const WINDOW_BACKGROUND: tauri::window::Color = tauri::window::Color(9, 9, 11, 255);
const DEFAULT_WINDOW_TITLE: &str = "Project Terminal";

const TRAY_MENU_ID_NEW_WINDOW: &str = "new-window";
const TRAY_MENU_ID_SHOW_ALL: &str = "show-all";
const TRAY_MENU_ID_HIDE_ALL: &str = "hide-all";
const TRAY_MENU_ID_QUIT: &str = "quit";
/// Menu item id prefix for per-workspace tray entries: `window:{workspaceId}`.
pub const TRAY_WINDOW_ID_PREFIX: &str = "window:";

/// A workspace window's identity and geometry, persisted across process
/// exits in `window-workspaces.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub project_id: Option<String>,
    /// Outer position in physical pixels. `None` until the window has been
    /// placed once.
    #[serde(default)]
    pub position: Option<(i32, i32)>,
    /// Outer size in physical pixels.
    #[serde(default)]
    pub size: Option<(u32, u32)>,
    #[serde(default)]
    pub maximized: bool,
    /// True once the window was closed (or the process exited): the workspace
    /// still exists on disk and in the tray list, but has no live window.
    #[serde(default)]
    pub detached: bool,
    /// Monotonic recency counter; the workspace with the highest rank is the
    /// most recently active one.
    pub rank: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFile {
    #[serde(default)]
    workspaces: Vec<WorkspaceRecord>,
    #[serde(default)]
    next_rank: u64,
}

impl Default for WorkspaceFile {
    fn default() -> Self {
        Self {
            workspaces: Vec::new(),
            next_rank: 1,
        }
    }
}

/// Public window listing returned to the frontend and used by the tray.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub workspace_id: String,
    pub label: String,
    pub project_id: Option<String>,
    pub title: String,
    pub detached: bool,
    pub visible: bool,
}

/// What the window close handler should do with a `CloseRequested`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowCloseDecision {
    /// Let the window close (approved close, quitting, or nothing running).
    Allow,
    /// Hold the window open and ask the frontend how to proceed.
    AskFrontend {
        workspace_id: String,
        running_count: usize,
    },
}

/// Options for creating a workspace window.
#[derive(Debug, Clone, Default)]
pub struct WindowOpenOptions {
    /// Reuse an existing workspace id (restoring a detached workspace). When
    /// `None` a brand-new workspace is created - or the legacy `main`
    /// workspace when no workspace exists yet.
    pub workspace_id: Option<String>,
    /// Open with this project selected (drives the window title).
    pub project_id: Option<String>,
    /// Show and focus the new window after creation.
    pub focus: bool,
}

/// What the startup window-restore pass ended up doing. Persisted-state
/// problems are recovered from, never fatal: only a completely unavailable
/// windowing runtime (WebView2 broken, Tauri runtime failure) may abort
/// startup, and that is surfaced as an error by `initialize_with_recovery`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowInitOutcome {
    /// The most recently active workspace was restored as the initial window.
    Restored,
    /// No persisted workspaces existed: a fresh initial window was created.
    Fresh,
    /// Persisted workspace state was invalid or could not be restored; the
    /// offending records were quarantined and a safe fallback window was
    /// created instead, so the application still starts.
    RecoveredFromInvalidState,
}

/// Whether the window manager has finished its startup pass. Window requests
/// (second-instance launches, tray clicks) that arrive while `Initializing`
/// are queued and served once the manager is ready.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupState {
    Initializing,
    Ready,
}

impl Default for StartupState {
    fn default() -> Self {
        Self::Initializing
    }
}

#[derive(Default)]
struct Inner {
    /// Workspace registry keyed by workspace id (== window label).
    workspaces: HashMap<String, WorkspaceRecord>,
    /// Labels whose close was explicitly approved by the backend (the
    /// frontend chose an action in the close dialog). One-shot: consumed by
    /// the next `CloseRequested`.
    approved_close: HashSet<String>,
    next_rank: u64,
    /// Where the next cascade-created window should go. `None` until the
    /// first fresh window anchors on an existing one.
    cascade_cursor: Option<(i32, i32)>,
    startup_state: StartupState,
    /// New-window requests that arrived before `startup_state` became
    /// `Ready`. Served by `complete_startup`.
    pending_window_requests: VecDeque<()>,
}

pub struct WindowManager {
    inner: Arc<RwLock<Inner>>,
    tray: Arc<Mutex<Option<TrayIcon>>>,
    workspace_file: PathBuf,
    /// Serializes window creation. WebView2's controller creation is not
    /// safe to run concurrently on one environment (two creations racing the
    /// environment's browser-process startup can stall one of them forever),
    /// and window creation can be triggered from several paths at once - the
    /// startup restore, the tray, the second-instance callback, and frontend
    /// commands (which React StrictMode can fire twice in dev).
    creation_lock: Arc<Mutex<()>>,
}

impl WindowManager {
    pub fn new(workspace_file: PathBuf) -> Self {
        Self {
            inner: Arc::new(RwLock::new(Inner {
                next_rank: 1,
                ..Default::default()
            })),
            tray: Arc::new(Mutex::new(None)),
            workspace_file,
            creation_lock: Arc::new(Mutex::new(())),
        }
    }

    /// Attach the tray icon so window changes can rebuild its menu.
    pub fn set_tray(&self, tray: TrayIcon) {
        *self.tray.lock() = Some(tray);
    }

    /// Load the persisted workspace registry and create the initial window,
    /// recovering from every failure that is not a hard windowing-runtime
    /// error.
    ///
    /// The initial window restores the most recently active workspace
    /// (geometry sanitized); every other workspace stays in the registry as
    /// detached and can be reopened from the tray. If the frontend's "restore
    /// windows from previous session" setting is enabled it calls
    /// `restore_previous_windows()` which reopens the rest.
    ///
    /// Recovery semantics: an unrestorable workspace record is quarantined
    /// (marked detached so it is not retried as the initial window) and a
    /// safe fallback window is created instead - bad persisted state must
    /// never keep the application from starting. Only when even the fallback
    /// window cannot be created (WebView2 unavailable, Tauri runtime
    /// failure) is an error returned, which the caller turns into a fatal
    /// startup error.
    pub fn initialize_with_recovery(&self, app: &AppHandle) -> AppResult<WindowInitOutcome> {
        let file = sanitize_workspace_records(self.load_workspaces());
        tracing::info!(count = file.workspaces.len(), "workspace registry loaded");
        {
            let mut inner = self.inner.write();
            inner.next_rank = file.next_rank.max(1);
            for record in file.workspaces {
                inner.workspaces.insert(record.id.clone(), record);
            }
        }

        let outcome = self.restore_initial_window(app)?;

        // Every record that did not get a live window during startup is
        // detached - its window closed in a previous session, or it could not
        // be restored. A stale `detached: false` would make the tray and the
        // restore logic believe the workspace is open.
        {
            let open: HashSet<String> = app.webview_windows().keys().cloned().collect();
            let mut inner = self.inner.write();
            for record in inner.workspaces.values_mut() {
                if !open.contains(&record.label) {
                    record.detached = true;
                }
            }
        }

        self.rebuild_tray_menu(app);
        self.save_workspaces();
        self.complete_startup(app);
        Ok(outcome)
    }

    /// Restore the most recently active workspace as the initial window.
    ///
    /// When restoration fails the offending record is quarantined and a safe
    /// fallback window is created instead - the application must still start
    /// even if the persisted registry is damaged.
    fn restore_initial_window(&self, app: &AppHandle) -> AppResult<WindowInitOutcome> {
        let id = select_initial_workspace(&self.inner.read());
        let Some(id) = id else {
            return self.create_fallback_window(app, false);
        };
        let Some(record) = self.inner.read().workspaces.get(&id).cloned() else {
            return self.create_fallback_window(app, false);
        };
        match self.create_window(
            app,
            WindowOpenOptions {
                workspace_id: Some(record.id.clone()),
                project_id: record.project_id.clone(),
                focus: true,
            },
        ) {
            Ok(workspace_id) => {
                tracing::info!(workspace = %workspace_id, "initial workspace window restored");
                Ok(WindowInitOutcome::Restored)
            }
            Err(error) => {
                tracing::warn!(
                    workspace = %record.id,
                    error = %error,
                    "failed to restore initial workspace; quarantining its record"
                );
                {
                    let mut inner = self.inner.write();
                    if let Some(record) = inner.workspaces.get_mut(&record.id) {
                        record.detached = true;
                    }
                }
                self.save_workspaces();
                self.create_fallback_window(app, true)
            }
        }
    }

    /// Create the safe fallback initial window: the legacy `main` workspace
    /// when it has no live window (default geometry, clamped onto a monitor),
    /// otherwise a fresh workspace. `recovered` marks whether the call
    /// recovers from a quarantine (`RecoveredFromInvalidState`) or is a clean
    /// start (`Fresh`).
    fn create_fallback_window(
        &self,
        app: &AppHandle,
        recovered: bool,
    ) -> AppResult<WindowInitOutcome> {
        let workspace_id = if app.get_webview_window(LEGACY_WORKSPACE_ID).is_none() {
            Some(LEGACY_WORKSPACE_ID.to_string())
        } else {
            None
        };
        match self.create_window(
            app,
            WindowOpenOptions {
                workspace_id,
                focus: true,
                ..Default::default()
            },
        ) {
            Ok(workspace_id) => {
                tracing::info!(workspace = %workspace_id, "fallback workspace window created");
                Ok(if recovered {
                    WindowInitOutcome::RecoveredFromInvalidState
                } else {
                    WindowInitOutcome::Fresh
                })
            }
            Err(error) => Err(AppError::Configuration(format!(
                "No window could be created during startup: {error}"
            ))),
        }
    }

    /// Mark the manager ready and serve window requests that arrived while
    /// startup was still running (for example a second-instance launch that
    /// was signalled before the event loop started).
    fn complete_startup(&self, app: &AppHandle) {
        let pending = {
            let mut inner = self.inner.write();
            inner.startup_state = StartupState::Ready;
            std::mem::take(&mut inner.pending_window_requests)
        };
        for _ in pending {
            tracing::info!("serving window request queued during startup");
            self.create_window(
                app,
                WindowOpenOptions {
                    focus: true,
                    ..Default::default()
                },
            )
            .map(|_| {
                tracing::info!("workspace window created from queued request");
            })
            .unwrap_or_else(|error| {
                tracing::warn!(error = %error, "queued window request failed");
            });
        }
    }

    /// Open a new workspace window. Before startup completes the request is
    /// queued and served by `complete_startup`; after that it is served
    /// immediately. Never panics and never fails startup - window-creation
    /// errors are logged.
    pub fn request_new_window(&self, app: &AppHandle) {
        if self.queue_window_request() {
            tracing::info!("window request queued until startup completes");
            return;
        }
        match self.create_window(
            app,
            WindowOpenOptions {
                focus: true,
                ..Default::default()
            },
        ) {
            Ok(workspace_id) => {
                tracing::info!(workspace = %workspace_id, "workspace window created from request")
            }
            Err(error) => tracing::warn!(error = %error, "window request failed"),
        }
    }

    /// `true` when the manager is still initializing and the request was
    /// queued; `false` when the caller should create the window directly.
    fn queue_window_request(&self) -> bool {
        let mut inner = self.inner.write();
        if inner.startup_state == StartupState::Initializing {
            inner.pending_window_requests.push_back(());
            true
        } else {
            false
        }
    }

    /// Test-only: mark the manager ready and report how many requests were
    /// queued during startup (without creating any windows).
    #[cfg(test)]
    fn complete_startup_for_test(&self) -> usize {
        let mut inner = self.inner.write();
        inner.startup_state = StartupState::Ready;
        let pending = std::mem::take(&mut inner.pending_window_requests);
        pending.len()
    }

    /// Create a workspace window and register it. Returns the workspace id.
    ///
    /// Serialized by `creation_lock`: WebView2's controller creation is not
    /// safe to run concurrently on one environment, and creation can be
    /// requested from several paths at once (startup restore, tray,
    /// second-instance callback, frontend commands - which React StrictMode
    /// can fire twice in dev).
    pub fn create_window(&self, app: &AppHandle, opts: WindowOpenOptions) -> AppResult<String> {
        let _creation_guard = self.creation_lock.lock();
        let (workspace_id, label) = {
            let inner = self.inner.read();
            let id = select_workspace_id(&inner, opts.workspace_id.as_deref());
            (id.clone(), id)
        };

        // A window with this label is already open (for example a window
        // created before the manager registered it): adopt it into the
        // registry, then show it instead of creating a duplicate. Without the
        // adoption the window would own no workspace - PTY ownership, close
        // handling, tray listing and geometry persistence would all miss it.
        if let Some(window) = app.get_webview_window(&label) {
            self.adopt_existing_window(&window, &workspace_id, opts.project_id.as_deref());
            self.show_window(app, &workspace_id)?;
            return Ok(workspace_id);
        }

        // Geometry: the saved record wins, sanitized; a fresh window cascades
        // from the most recently active open window and clamps to a monitor
        // work area. Persisted values are never trusted verbatim: tao's
        // Windows backend performs unchecked i32 arithmetic on the requested
        // position and size, so extreme saved values (removed monitors,
        // minimized-window sentinel coordinates, corrupt records) would panic
        // - or worse, wrap - during window creation.
        let saved = self.inner.read().workspaces.get(&workspace_id).cloned();
        let (width, height) = sanitize_window_size(saved.as_ref().and_then(|record| record.size));
        let position = match saved.as_ref().and_then(|record| record.position) {
            Some((x, y)) => {
                let (x, y) = sanitize_window_position(app, (x, y), (width, height));
                Some((x as f64, y as f64))
            }
            None => {
                let mut inner = self.inner.write();
                let next = if let Some(cursor) = inner.cascade_cursor {
                    clamp_to_work_area(
                        work_area_of(app, cursor.0, cursor.1),
                        (cursor.0 + CASCADE_OFFSET, cursor.1 + CASCADE_OFFSET),
                        (width as i32, height as i32),
                    )
                } else if let Some((x, y)) = self.cascade_anchor(app, &inner) {
                    clamp_to_work_area(
                        work_area_of(app, x, y),
                        (x + CASCADE_OFFSET, y + CASCADE_OFFSET),
                        (width as i32, height as i32),
                    )
                } else {
                    (0, 0)
                };
                inner.cascade_cursor = Some(next);
                Some((next.0 as f64, next.1 as f64))
            }
        };
        let maximized = saved
            .as_ref()
            .map(|record| record.maximized)
            .unwrap_or(false);

        let project_id = opts
            .project_id
            .or_else(|| self.project_id_for_window(&workspace_id));

        let mut builder =
            WebviewWindowBuilder::new(app, label.clone(), WebviewUrl::App("index.html".into()))
                .title(DEFAULT_WINDOW_TITLE)
                .inner_size(width, height)
                .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
                .decorations(false)
                .background_color(WINDOW_BACKGROUND);
        if let Some((x, y)) = position {
            builder = builder.position(x, y);
        }
        tracing::debug!(
            workspace = %workspace_id,
            width,
            height,
            ?position,
            maximized,
            "building workspace window"
        );
        let window = builder
            .build()
            .map_err(|e| AppError::Configuration(format!("Failed to create window: {e}")))?;

        // Only now register the window: a failed build must not leave a
        // phantom record behind (a phantom would make the next launch believe
        // the workspace is open and skip restoring it).
        let rank = {
            let mut inner = self.inner.write();
            let rank = inner.next_rank;
            inner.next_rank = inner.next_rank.saturating_add(1);
            inner.workspaces.insert(
                workspace_id.clone(),
                WorkspaceRecord {
                    id: workspace_id.clone(),
                    label: label.clone(),
                    project_id: project_id.clone(),
                    position: position.map(|(x, y)| (x as i32, y as i32)),
                    size: Some((width as u32, height as u32)),
                    maximized,
                    detached: false,
                    rank,
                },
            );
            rank
        };
        let _ = rank;

        if maximized {
            let _ = window.maximize();
        }
        if opts.focus {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }

        if let Err(error) = self.update_window_title(app, &workspace_id) {
            tracing::warn!(workspace = %workspace_id, error = %error, "failed to update window title");
        }
        self.rebuild_tray_menu(app);
        self.save_workspaces();
        tracing::info!(workspace = %workspace_id, "workspace window created");
        Ok(workspace_id)
    }

    /// Make sure an already-existing Tauri window is part of the workspace
    /// registry.
    ///
    /// Every window of the process is expected to be created by this manager;
    /// the adoption covers windows that exist before the manager ran (the
    /// legacy config-declared `main` window) so the invariant "window label
    /// == registered workspace id" holds from the start. Without it,
    /// `workspace_info`, `SessionOwnership::from_webview`, `set_window_project`
    /// and close handling would silently miss the window.
    fn adopt_existing_window(
        &self,
        window: &tauri::WebviewWindow,
        workspace_id: &str,
        project_id: Option<&str>,
    ) {
        let mut inner = self.inner.write();
        let existing = inner.workspaces.get(workspace_id).cloned();
        let rank = inner.next_rank;
        inner.next_rank = rank.saturating_add(1);
        let project_id = project_id.map(str::to_string).or_else(|| {
            existing
                .as_ref()
                .and_then(|record| record.project_id.clone())
        });
        inner.workspaces.insert(
            workspace_id.to_string(),
            WorkspaceRecord {
                id: workspace_id.to_string(),
                label: workspace_id.to_string(),
                project_id,
                position: window.outer_position().ok().map(|p| (p.x, p.y)),
                size: window.outer_size().ok().map(|s| (s.width, s.height)),
                maximized: window.is_maximized().unwrap_or(false),
                detached: false,
                rank,
            },
        );
        drop(inner);
        tracing::info!(workspace = %workspace_id, "adopted existing window into workspace registry");
    }

    /// Where a fresh window should cascade from: the outer position of the
    /// most recently active open window.
    fn cascade_anchor(&self, app: &AppHandle, inner: &Inner) -> Option<(i32, i32)> {
        let anchor = inner
            .workspaces
            .values()
            .filter(|record| !record.detached)
            .max_by_key(|record| record.rank)?;
        let window = app.get_webview_window(&anchor.label)?;
        let position = window.outer_position().ok()?;
        Some((position.x, position.y))
    }

    /// Show/focus an open workspace window, or reopen a detached workspace
    /// (restoring its geometry) when it is not open.
    pub fn show_window(&self, app: &AppHandle, workspace_id: &str) -> AppResult<()> {
        if let Some(window) = app.get_webview_window(workspace_id) {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            self.mark_active(workspace_id);
            return Ok(());
        }
        self.create_window(
            app,
            WindowOpenOptions {
                workspace_id: Some(workspace_id.to_string()),
                focus: true,
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Show every open window and focus the most recently active one.
    pub fn show_all(&self, app: &AppHandle) {
        for window in app.webview_windows().values() {
            let _ = window.show();
            let _ = window.unminimize();
        }
        self.focus_last_active(app);
    }

    /// Hide every open window. Sessions keep running.
    pub fn hide_all(&self, app: &AppHandle) {
        for window in app.webview_windows().values() {
            let _ = window.hide();
        }
    }

    /// Tray left-click behavior: focus the most recently active open window;
    /// when no window is open, restore the most recently used workspace; when
    /// there is nothing to restore, create a fresh one.
    pub fn focus_last_active(&self, app: &AppHandle) {
        let (best, detached) = {
            let inner = self.inner.read();
            let open = inner
                .workspaces
                .values()
                .filter(|record| !record.detached)
                .max_by_key(|record| record.rank);
            match open {
                Some(record) => (Some(record.clone()), false),
                None => (
                    inner
                        .workspaces
                        .values()
                        .max_by_key(|record| record.rank)
                        .cloned(),
                    true,
                ),
            }
        };
        match best {
            Some(record) => {
                if detached {
                    let _ = self.create_window(
                        app,
                        WindowOpenOptions {
                            workspace_id: Some(record.id),
                            focus: true,
                            ..Default::default()
                        },
                    );
                } else if let Some(window) = app.get_webview_window(&record.label) {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            None => {
                let _ = self.create_window(app, WindowOpenOptions::default());
            }
        }
    }

    /// Close a workspace window.
    ///
    /// `keep_sessions` was already honored by the caller (sessions are stopped
    /// there when requested); this method only handles the window. The close
    /// is approved so the `CloseRequested` handler lets it through.
    pub fn close_window(&self, app: &AppHandle, workspace_id: &str) -> AppResult<()> {
        self.approve_close(workspace_id);
        {
            let mut inner = self.inner.write();
            if let Some(record) = inner.workspaces.get_mut(workspace_id) {
                record.detached = true;
            }
        }
        if let Some(window) = app.get_webview_window(workspace_id) {
            if let Err(error) = window.close() {
                self.inner.write().approved_close.remove(workspace_id);
                return Err(AppError::Configuration(format!(
                    "Failed to close window: {error}"
                )));
            }
        }
        Ok(())
    }

    /// Decide what a `CloseRequested` should do for the given window label.
    ///
    /// Approved closes and windows without running sessions close outright;
    /// a window whose workspace still has live sessions is held open and the
    /// frontend is asked how to proceed.
    pub fn on_close_requested(
        &self,
        terminal: &TerminalManager,
        label: &str,
    ) -> WindowCloseDecision {
        {
            let mut inner = self.inner.write();
            if inner.approved_close.remove(label) {
                return WindowCloseDecision::Allow;
            }
            if !inner.workspaces.contains_key(label) {
                return WindowCloseDecision::Allow;
            }
        }
        let running_count = terminal
            .list()
            .into_iter()
            .filter(|session| {
                session.workspace_id.as_deref() == Some(label)
                    && matches!(
                        session.status,
                        SessionStatus::Starting | SessionStatus::Running
                    )
            })
            .count();
        if running_count > 0 {
            WindowCloseDecision::AskFrontend {
                workspace_id: label.to_string(),
                running_count,
            }
        } else {
            WindowCloseDecision::Allow
        }
    }

    /// React to a window being destroyed: mark its workspace detached and
    /// persist the registry so the workspace stays reopenable.
    pub fn on_window_destroyed(&self, app: &AppHandle, label: &str) {
        {
            let mut inner = self.inner.write();
            inner.approved_close.remove(label);
            inner.cascade_cursor = None;
            if let Some(record) = inner.workspaces.get_mut(label) {
                record.detached = true;
            }
        }
        self.rebuild_tray_menu(app);
        self.save_workspaces();
    }

    /// Track window moves so fresh windows cascade from the new position.
    pub fn record_position(&self, label: &str, x: i32, y: i32) {
        let mut inner = self.inner.write();
        if let Some(record) = inner.workspaces.get_mut(label) {
            record.position = Some((x, y));
        }
        // The next fresh window should anchor on this moved position, not the
        // pre-move cascade cursor.
        inner.cascade_cursor = None;
    }

    /// Track window resizes and maximized state.
    pub fn record_resized(&self, label: &str, width: u32, height: u32, maximized: bool) {
        let mut inner = self.inner.write();
        if let Some(record) = inner.workspaces.get_mut(label) {
            record.size = Some((width, height));
            record.maximized = maximized;
        }
    }

    /// Bump a workspace's recency rank (it became the active window).
    pub fn mark_active(&self, workspace_id: &str) {
        let mut inner = self.inner.write();
        let rank = inner.next_rank;
        inner.next_rank = rank.saturating_add(1);
        if let Some(record) = inner.workspaces.get_mut(workspace_id) {
            record.rank = rank;
        }
    }

    /// Mark a window's next close as approved (used by the close dialog flow
    /// and by tests). Consumed by the next `CloseRequested`.
    pub fn approve_close(&self, label: &str) {
        self.inner.write().approved_close.insert(label.to_string());
    }

    /// Reopen every workspace that has no live window. Returns how many
    /// windows were created. Called by the frontend when the "restore windows
    /// from previous session" setting is enabled. A single workspace that
    /// fails to reopen is logged and skipped, never fatal for the pass or the
    /// application.
    pub fn restore_previous_windows(&self, app: &AppHandle) -> AppResult<usize> {
        let open: HashSet<String> = app.webview_windows().keys().cloned().collect();
        let ids: Vec<String> = self
            .inner
            .read()
            .workspaces
            .values()
            .filter(|record| !open.contains(&record.label))
            .map(|record| record.id.clone())
            .collect();
        let mut created = 0;
        for id in ids {
            match self.create_window(
                app,
                WindowOpenOptions {
                    workspace_id: Some(id.clone()),
                    focus: false,
                    ..Default::default()
                },
            ) {
                Ok(_) => created += 1,
                Err(error) => {
                    // A single workspace failing to reopen must not fail the
                    // whole restore pass, but it must never be silent either.
                    tracing::warn!(
                        workspace = %id,
                        error = %error,
                        "failed to restore workspace window"
                    );
                }
            }
        }
        if created > 0 {
            self.focus_last_active(app);
        }
        Ok(created)
    }

    /// The workspace id owning a window label (== the label for every
    /// registered window).
    pub fn workspace_id_for_window(&self, label: &str) -> Option<String> {
        self.inner
            .read()
            .workspaces
            .get(label)
            .map(|record| record.id.clone())
    }

    /// The project a workspace currently has selected, if any.
    pub fn project_id_for_window(&self, label: &str) -> Option<String> {
        self.inner
            .read()
            .workspaces
            .get(label)
            .and_then(|record| record.project_id.clone())
    }

    /// Record which project a workspace has selected, update the window title
    /// (including the `(2)` disambiguator for duplicate projects) and refresh
    /// the tray list. Called by the frontend whenever the active project
    /// changes.
    pub fn set_window_project(
        &self,
        app: &AppHandle,
        workspace_id: &str,
        project_id: Option<String>,
    ) -> AppResult<()> {
        {
            let mut inner = self.inner.write();
            let Some(record) = inner.workspaces.get_mut(workspace_id) else {
                return Ok(());
            };
            record.project_id = project_id;
        }
        self.update_window_title(app, workspace_id)?;
        self.rebuild_tray_menu(app);
        self.save_workspaces();
        Ok(())
    }

    /// All known workspaces, most recently active first, for the tray and the
    /// frontend's window list.
    pub fn list_windows(&self, app: &AppHandle) -> Vec<WindowInfo> {
        let open: HashSet<String> = app.webview_windows().keys().cloned().collect();
        let inner = self.inner.read();
        let mut records: Vec<&WorkspaceRecord> = inner.workspaces.values().collect();
        records.sort_by_key(|record| std::cmp::Reverse(record.rank));
        records
            .into_iter()
            .map(|record| {
                let name = project_name(app, record.project_id.as_deref());
                WindowInfo {
                    workspace_id: record.id.clone(),
                    label: record.label.clone(),
                    project_id: record.project_id.clone(),
                    title: compute_window_title(name.as_deref(), title_ordinal(&inner, record)),
                    detached: record.detached,
                    visible: open.contains(&record.label) && !record.detached,
                }
            })
            .collect()
    }

    /// Recompute and apply a workspace window's title.
    pub fn update_window_title(&self, app: &AppHandle, workspace_id: &str) -> AppResult<()> {
        let (title, label) = {
            let inner = self.inner.read();
            let Some(record) = inner.workspaces.get(workspace_id) else {
                return Ok(());
            };
            let name = project_name(app, record.project_id.as_deref());
            (
                compute_window_title(name.as_deref(), title_ordinal(&inner, record)),
                record.label.clone(),
            )
        };
        if let Some(window) = app.get_webview_window(&label) {
            window
                .set_title(&title)
                .map_err(|e| AppError::Configuration(format!("Failed to set window title: {e}")))?;
        }
        Ok(())
    }

    /// Persist the registry to `window-workspaces.json`. Failures are logged,
    /// never fatal: worst case the next launch starts with the initial window
    /// only.
    pub fn save_workspaces(&self) {
        let file = {
            let inner = self.inner.read();
            WorkspaceFile {
                workspaces: inner.workspaces.values().cloned().collect(),
                next_rank: inner.next_rank,
            }
        };
        if let Err(error) = storage::write_json(&self.workspace_file, &file) {
            tracing::warn!("Failed to save window workspaces: {error}");
        }
    }

    fn load_workspaces(&self) -> WorkspaceFile {
        storage::read_or_default(&self.workspace_file, WorkspaceFile::default()).unwrap_or_else(
            |error| {
                tracing::warn!("Failed to load window workspaces: {error}");
                WorkspaceFile::default()
            },
        )
    }

    /// Rebuild the tray menu so it reflects the current window set. Called on
    /// every window create/destroy and project change.
    fn rebuild_tray_menu(&self, app: &AppHandle) {
        let Some(tray) = self.tray.lock().clone() else {
            return;
        };
        let menu = match self.build_tray_menu(app) {
            Ok(menu) => menu,
            Err(error) => {
                tracing::warn!("Failed to build tray menu: {error}");
                return;
            }
        };
        if let Err(error) = tray.set_menu(Some(menu)) {
            tracing::warn!("Failed to update tray menu: {error}");
        }
    }

    fn build_tray_menu(&self, app: &AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
        let new_window = MenuItem::with_id(
            app,
            TRAY_MENU_ID_NEW_WINDOW,
            "New Window",
            true,
            None::<&str>,
        )?;
        let show_all = MenuItem::with_id(
            app,
            TRAY_MENU_ID_SHOW_ALL,
            "Show All Windows",
            true,
            None::<&str>,
        )?;
        let hide_all =
            MenuItem::with_id(app, TRAY_MENU_ID_HIDE_ALL, "Hide All", true, None::<&str>)?;
        let quit = MenuItem::with_id(
            app,
            TRAY_MENU_ID_QUIT,
            "Quit and Stop All Sessions",
            true,
            None::<&str>,
        )?;

        let inner = self.inner.read();
        let mut records: Vec<&WorkspaceRecord> = inner.workspaces.values().collect();
        records.sort_by_key(|record| std::cmp::Reverse(record.rank));
        let mut window_items: Vec<MenuItem<tauri::Wry>> = Vec::new();
        for (index, record) in records.into_iter().enumerate() {
            let name = project_name(app, record.project_id.as_deref())
                .unwrap_or_else(|| format!("Workspace {}", index + 1));
            let label = if record.detached {
                format!("{name} (restore)")
            } else {
                name
            };
            window_items.push(MenuItem::with_id(
                app,
                format!("{TRAY_WINDOW_ID_PREFIX}{}", record.id),
                label,
                true,
                None::<&str>,
            )?);
        }
        drop(inner);

        let windows_submenu = Submenu::with_items(
            app,
            "Windows",
            true,
            &window_items
                .iter()
                .map(|item| item as &dyn IsMenuItem<tauri::Wry>)
                .collect::<Vec<_>>(),
        )?;
        let items: [&dyn IsMenuItem<tauri::Wry>; 5] =
            [&new_window, &show_all, &windows_submenu, &hide_all, &quit];
        Menu::with_items(app, &items)
    }
}

/// Whether a string is usable as a workspace id / Tauri window label.
///
/// Labels also flow into IPC event names and frontend storage keys, so
/// anything beyond ASCII alphanumerics and `-_.` is rejected. Persisted
/// records with invalid ids are dropped at load; invalid requested ids fall
/// back to a fresh id.
fn is_valid_workspace_label(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Choose the workspace id for a new window: an explicitly requested id wins;
/// the very first window of the process uses the legacy `main` id; everything
/// after that gets a unique `workspace-{uuid}`.
fn select_workspace_id(inner: &Inner, requested: Option<&str>) -> String {
    if let Some(id) = requested {
        if is_valid_workspace_label(id) {
            return id.to_string();
        }
        tracing::warn!(workspace = %id, "rejecting invalid workspace id request");
    }
    if inner.workspaces.is_empty() {
        LEGACY_WORKSPACE_ID.to_string()
    } else {
        new_id("workspace")
    }
}

/// Validate a persisted workspace registry before it enters the live map.
///
/// Invalid ids, duplicates, and mismatched labels are the difference between
/// "skip the bad record" and "fail to start": records with invalid ids are
/// dropped, labels are normalized to their id (the registry invariant is
/// `label == id`), and `next_rank` is bumped past the highest rank so future
/// windows keep strict ordering.
fn sanitize_workspace_records(file: WorkspaceFile) -> WorkspaceFile {
    let mut seen: HashSet<String> = HashSet::new();
    let mut workspaces = Vec::with_capacity(file.workspaces.len());
    let mut max_rank = 0u64;
    for record in file.workspaces {
        if !is_valid_workspace_label(&record.id) {
            tracing::warn!(workspace = %record.id, "dropping workspace record with invalid id");
            continue;
        }
        if !seen.insert(record.id.clone()) {
            tracing::warn!(workspace = %record.id, "dropping duplicate workspace record");
            continue;
        }
        if record.label != record.id {
            tracing::warn!(workspace = %record.id, "normalizing workspace label to its id");
        }
        max_rank = max_rank.max(record.rank);
        workspaces.push(WorkspaceRecord {
            label: record.id.clone(),
            ..record
        });
    }
    WorkspaceFile {
        workspaces,
        next_rank: file.next_rank.max(max_rank.saturating_add(1)).max(1),
    }
}

/// The workspace the initial window should restore: the most recently active
/// record, or `None` for a fresh start.
fn select_initial_workspace(inner: &Inner) -> Option<String> {
    inner
        .workspaces
        .values()
        .max_by_key(|record| record.rank)
        .map(|record| record.id.clone())
}

/// Validate a persisted window size. Zero, sub-minimum and absurdly large
/// sizes are replaced by the defaults. tao's Windows backend runs unchecked
/// i32 arithmetic on the requested size while adjusting the window rect for
/// decorations, so a size near `u32::MAX` panics in debug builds and wraps in
/// release builds; such values must never reach the window builder.
fn sanitize_window_size(saved: Option<(u32, u32)>) -> (f64, f64) {
    match saved {
        Some((w, h))
            if (w as f64) >= MIN_WINDOW_WIDTH
                && (h as f64) >= MIN_WINDOW_HEIGHT
                && (w as f64) <= MAX_WINDOW_DIMENSION
                && (h as f64) <= MAX_WINDOW_DIMENSION =>
        {
            (w as f64, h as f64)
        }
        Some((w, h)) => {
            tracing::warn!(
                width = w,
                height = h,
                "invalid persisted window size; using default size"
            );
            (DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT)
        }
        None => (DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT),
    }
}

/// Validate a persisted window position: clamp it into the work area of the
/// monitor that contains it, falling back to the primary monitor when the
/// saved position is off-screen (removed monitor, minimized-window sentinel
/// coordinates such as `(-32000, -32000)`, or a corrupt record).
///
/// The clamp also protects tao's Windows backend, which adds the frame
/// thickness to the requested x coordinate while picking the target monitor
/// and panics on overflow for positions near `i32::MAX`.
fn sanitize_window_position(app: &AppHandle, saved: (i32, i32), size: (f64, f64)) -> (i32, i32) {
    let clamped = clamp_to_work_area(
        work_area_of(app, saved.0, saved.1),
        saved,
        (size.0 as i32, size.1 as i32),
    );
    if clamped != saved {
        tracing::warn!(
            x = saved.0,
            y = saved.1,
            "clamped off-screen persisted window position"
        );
    }
    clamped
}

/// Clamp a desired window position into a monitor work area so the window
/// title bar stays reachable. `work_area` is `(x, y, width, height)`.
///
/// Windows larger than the work area clamp to its origin corner instead of
/// panicking (`i32::clamp` requires `min <= max`).
fn clamp_to_work_area(
    work_area: Option<(i32, i32, u32, u32)>,
    desired: (i32, i32),
    size: (i32, i32),
) -> (i32, i32) {
    let Some((wx, wy, width, height)) = work_area else {
        return desired;
    };
    let max_x = wx + width as i32 - size.0.max(0);
    let max_y = wy + height as i32 - size.1.max(0);
    (desired.0.min(max_x).max(wx), desired.1.min(max_y).max(wy))
}

/// The work area of the monitor containing `(x, y)`, falling back to the
/// primary monitor.
fn work_area_of(app: &AppHandle, x: i32, y: i32) -> Option<(i32, i32, u32, u32)> {
    let monitor = app
        .monitor_from_point(x as f64, y as f64)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let area = monitor.work_area();
    Some((
        area.position.x,
        area.position.y,
        area.size.width,
        area.size.height,
    ))
}

/// Resolve a project id to its display name through the shared project
/// repository. Unknown/deleted projects produce `None`.
fn project_name(app: &AppHandle, project_id: Option<&str>) -> Option<String> {
    let project_id = project_id?;
    let state = app.try_state::<crate::state::AppState>()?;
    state
        .projects
        .get(project_id)
        .ok()
        .map(|project| project.name)
        .filter(|name| !name.trim().is_empty())
}

/// Ordinal of a window among the open windows showing the same project,
/// ordered by label so it is deterministic. `0` means "no suffix needed".
fn title_ordinal(inner: &Inner, record: &WorkspaceRecord) -> usize {
    let mut labels: Vec<&String> = inner
        .workspaces
        .values()
        .filter(|candidate| {
            !candidate.detached
                && candidate.project_id.is_some()
                && candidate.project_id == record.project_id
        })
        .map(|candidate| &candidate.label)
        .collect();
    labels.sort();
    labels
        .iter()
        .position(|label| *label == &record.label)
        .unwrap_or(0)
}

/// The taskbar title for a workspace window: `Project Terminal`, or
/// `Project Terminal — {project}` with a `(2)` disambiguator when several
/// windows show the same project.
fn compute_window_title(project_name: Option<&str>, ordinal: usize) -> String {
    let Some(name) = project_name else {
        return DEFAULT_WINDOW_TITLE.to_string();
    };
    if ordinal == 0 {
        format!("Project Terminal — {name}")
    } else {
        format!("Project Terminal — {name} ({})", ordinal + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inner_with(records: &[(&str, Option<&str>, bool, u64)]) -> Inner {
        let mut inner = Inner::default();
        inner.next_rank = 100;
        for (id, project, detached, rank) in records {
            inner.workspaces.insert(
                id.to_string(),
                WorkspaceRecord {
                    id: id.to_string(),
                    label: id.to_string(),
                    project_id: project.map(|p| p.to_string()),
                    position: None,
                    size: None,
                    maximized: false,
                    detached: *detached,
                    rank: *rank,
                },
            );
        }
        inner
    }

    #[test]
    fn first_window_uses_legacy_id_then_unique_workspace_uuids() {
        let empty = Inner::default();
        assert_eq!(select_workspace_id(&empty, None), LEGACY_WORKSPACE_ID);
        assert_eq!(select_workspace_id(&empty, Some("")), LEGACY_WORKSPACE_ID);

        let populated = inner_with(&[("main", None, true, 1)]);
        let first = select_workspace_id(&populated, None);
        let second = select_workspace_id(&populated, None);
        assert!(first.starts_with("workspace-"));
        assert_ne!(
            first, second,
            "two fresh windows must not share a workspace id"
        );

        assert_eq!(
            select_workspace_id(&populated, Some("workspace-x")),
            "workspace-x"
        );
    }

    #[test]
    fn cascade_clamps_into_the_monitor_work_area() {
        // Work area 1920x1080 at (0, 0); a 1280x800 window cascading past the
        // right edge must clamp to (640, 280).
        assert_eq!(
            clamp_to_work_area(Some((0, 0, 1920, 1080)), (1500, 500), (1280, 800)),
            (640, 280)
        );
        // Cascading below the bottom edge clamps up.
        assert_eq!(
            clamp_to_work_area(Some((0, 0, 1920, 1080)), (100, 900), (1280, 800)),
            (100, 280)
        );
        // A tiny window smaller than the work area clamps to the edges. The
        // monitor sits at (-100,-100); x=500 is already inside, y=500 clamps
        // up to the bottom edge.
        assert_eq!(
            clamp_to_work_area(Some((-100, -100, 800, 600)), (500, 500), (100, 100)),
            (500, 400)
        );
        // A window larger than the work area sits at its origin corner rather
        // than being placed half off-screen.
        assert_eq!(
            clamp_to_work_area(Some((0, 0, 1920, 1080)), (100, 100), (2000, 1200)),
            (0, 0)
        );
        // Without a monitor the desired position is returned untouched.
        assert_eq!(
            clamp_to_work_area(None, (1500, 500), (1280, 800)),
            (1500, 500)
        );
    }

    #[test]
    fn titles_disambiguate_duplicate_projects() {
        assert_eq!(compute_window_title(None, 0), "Project Terminal");
        assert_eq!(
            compute_window_title(Some("opi-platform"), 0),
            "Project Terminal — opi-platform"
        );
        assert_eq!(
            compute_window_title(Some("opi-platform"), 1),
            "Project Terminal — opi-platform (2)"
        );
        assert_eq!(
            compute_window_title(Some("opi-platform"), 2),
            "Project Terminal — opi-platform (3)"
        );
    }

    #[test]
    fn title_ordinal_counts_open_windows_with_the_same_project() {
        let inner = inner_with(&[
            ("main", Some("p1"), false, 1),
            ("workspace-1", Some("p1"), false, 2),
            ("workspace-2", Some("p1"), true, 3), // detached: not in the taskbar
            ("workspace-3", Some("p2"), false, 4),
        ]);
        let main = inner.workspaces.get("main").unwrap();
        let other = inner.workspaces.get("workspace-1").unwrap();
        // "main" sorts first: it keeps the plain title.
        assert_eq!(title_ordinal(&inner, main), 0);
        assert_eq!(title_ordinal(&inner, other), 1);
        assert_eq!(
            compute_window_title(Some("p1"), title_ordinal(&inner, main)),
            "Project Terminal — p1"
        );
        assert_eq!(
            compute_window_title(Some("p1"), title_ordinal(&inner, other)),
            "Project Terminal — p1 (2)"
        );
    }

    #[test]
    fn workspace_file_round_trips_with_camel_case_keys() {
        let file = WorkspaceFile {
            next_rank: 7,
            workspaces: vec![WorkspaceRecord {
                id: "workspace-abc".into(),
                label: "workspace-abc".into(),
                project_id: Some("project-1".into()),
                position: Some((100, 132)),
                size: Some((1280, 800)),
                maximized: true,
                detached: false,
                rank: 6,
            }],
        };
        let json = serde_json::to_string(&file).unwrap();
        assert!(json.contains("\"nextRank\":7"), "{json}");
        assert!(json.contains("\"projectId\":\"project-1\""), "{json}");
        assert!(json.contains("\"position\":[100,132]"), "{json}");
        assert!(json.contains("\"maximized\":true"), "{json}");
        let decoded: WorkspaceFile = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.next_rank, 7);
        assert_eq!(decoded.workspaces.len(), 1);
        assert_eq!(decoded.workspaces[0].id, "workspace-abc");
        assert_eq!(decoded.workspaces[0].size, Some((1280, 800)));
    }

    #[test]
    fn workspaces_file_defaults_for_missing_fields() {
        let decoded: WorkspaceFile = serde_json::from_str(r#"{"workspaces":[]}"#).unwrap();
        assert_eq!(decoded.next_rank, 0);
        assert!(decoded.workspaces.is_empty());
    }

    #[test]
    fn close_decision_asks_only_for_windows_with_running_sessions() {
        use crate::commands::terminal::TerminalState;
        use crate::terminal::SessionSpawn;

        fn spawn(session_id: &str, workspace: &str, exited: bool) -> SessionSpawn {
            SessionSpawn {
                session_id: session_id.into(),
                project_id: "project-1".into(),
                profile_id: "profile-1".into(),
                workspace_id: Some(workspace.into()),
                window_id: Some(workspace.into()),
                program: if cfg!(windows) {
                    "cmd.exe".into()
                } else {
                    "/bin/sh".into()
                },
                args: if cfg!(windows) {
                    vec![if exited { "/C".into() } else { "/Q".into() }]
                } else {
                    Vec::new()
                },
                cwd: None,
                env: Vec::new(),
                env_remove: Vec::new(),
                readiness_marker: None,
                rows: 24,
                cols: 80,
                scrollback_bytes: 1024,
            }
        }

        let terminal = TerminalState::new();
        // workspace-a: one running session and one exited; workspace-b: one
        // running session; a remote (ownerless) session.
        terminal
            .manager
            .create(spawn("a-running", "workspace-a", false))
            .unwrap();
        terminal
            .manager
            .create(spawn("a-exited", "workspace-a", true))
            .unwrap();
        terminal
            .manager
            .create(spawn("b-running", "workspace-b", false))
            .unwrap();
        let mut remote = spawn("remote-1", "workspace-x", false);
        remote.workspace_id = None;
        remote.window_id = None;
        terminal.manager.create(remote).unwrap();

        let manager = WindowManager::new(PathBuf::from("unused.json"));
        {
            let mut inner = manager.inner.write();
            inner.workspaces.insert(
                "workspace-a".into(),
                WorkspaceRecord {
                    id: "workspace-a".into(),
                    label: "workspace-a".into(),
                    project_id: None,
                    position: None,
                    size: None,
                    maximized: false,
                    detached: false,
                    rank: 1,
                },
            );
            inner.workspaces.insert(
                "workspace-b".into(),
                WorkspaceRecord {
                    id: "workspace-b".into(),
                    label: "workspace-b".into(),
                    project_id: None,
                    position: None,
                    size: None,
                    maximized: false,
                    detached: false,
                    rank: 2,
                },
            );
        }

        assert_eq!(
            manager.on_close_requested(&terminal.manager, "workspace-a"),
            WindowCloseDecision::AskFrontend {
                workspace_id: "workspace-a".into(),
                running_count: 1,
            }
        );
        assert_eq!(
            manager.on_close_requested(&terminal.manager, "workspace-b"),
            WindowCloseDecision::AskFrontend {
                workspace_id: "workspace-b".into(),
                running_count: 1,
            }
        );
        // An approved close goes straight through.
        manager.approve_close("workspace-a");
        assert_eq!(
            manager.on_close_requested(&terminal.manager, "workspace-a"),
            WindowCloseDecision::Allow
        );
        // Unknown windows close without asking.
        assert_eq!(
            manager.on_close_requested(&terminal.manager, "unknown"),
            WindowCloseDecision::Allow
        );
        terminal.manager.close_all();
    }

    #[test]
    fn approve_close_is_one_shot() {
        use crate::commands::terminal::TerminalState;
        use crate::terminal::SessionSpawn;

        let manager = WindowManager::new(PathBuf::from("unused.json"));
        {
            let mut inner = manager.inner.write();
            inner.workspaces.insert(
                "workspace-a".into(),
                WorkspaceRecord {
                    id: "workspace-a".into(),
                    label: "workspace-a".into(),
                    project_id: None,
                    position: None,
                    size: None,
                    maximized: false,
                    detached: false,
                    rank: 1,
                },
            );
        }
        let terminal = TerminalState::new();
        terminal
            .manager
            .create(SessionSpawn {
                session_id: "running-1".into(),
                project_id: "project-1".into(),
                profile_id: "profile-1".into(),
                workspace_id: Some("workspace-a".into()),
                window_id: Some("workspace-a".into()),
                program: if cfg!(windows) {
                    "cmd.exe".into()
                } else {
                    "/bin/sh".into()
                },
                args: if cfg!(windows) {
                    vec!["/Q".into()]
                } else {
                    Vec::new()
                },
                cwd: None,
                env: Vec::new(),
                env_remove: Vec::new(),
                readiness_marker: None,
                rows: 24,
                cols: 80,
                scrollback_bytes: 1024,
            })
            .unwrap();
        manager.approve_close("workspace-a");
        assert_eq!(
            manager.on_close_requested(&terminal.manager, "workspace-a"),
            WindowCloseDecision::Allow
        );
        // The approval is consumed: with a running session still attached, a
        // second close must ask the frontend again.
        assert_eq!(
            manager.on_close_requested(&terminal.manager, "workspace-a"),
            WindowCloseDecision::AskFrontend {
                workspace_id: "workspace-a".into(),
                running_count: 1,
            }
        );
        terminal.manager.close_all();
    }

    #[test]
    fn second_launch_style_creation_picks_a_fresh_workspace_id() {
        // Simulates the single-instance callback: the registry already has
        // windows, no workspace id is requested, so a unique id is chosen.
        let inner = inner_with(&[("main", None, false, 1)]);
        let id = select_workspace_id(&inner, None);
        assert!(id.starts_with("workspace-"));
        assert_ne!(id, "main");
    }

    #[test]
    fn select_workspace_id_rejects_invalid_requested_ids() {
        let empty = Inner::default();
        // An invalid requested id must never reach the window builder: it
        // falls back to the normal id selection instead.
        for bad in [
            "",
            "main:evil",
            "has space",
            "naughty\u{0}label",
            &"x".repeat(65),
        ] {
            assert_eq!(select_workspace_id(&empty, Some(bad)), LEGACY_WORKSPACE_ID);
        }
        let populated = inner_with(&[("main", None, true, 1)]);
        for bad in ["", "main:evil", "has space"] {
            let id = select_workspace_id(&populated, Some(bad));
            assert!(id.starts_with("workspace-"), "got {id:?}");
        }
        assert_eq!(
            select_workspace_id(&populated, Some("workspace-valid_1.x")),
            "workspace-valid_1.x"
        );
    }

    #[test]
    fn initial_workspace_is_the_most_recently_active_record() {
        let inner = inner_with(&[
            ("main", None, true, 1),
            ("workspace-a", None, false, 5),
            ("workspace-b", None, true, 9),
        ]);
        assert_eq!(
            select_initial_workspace(&inner).as_deref(),
            Some("workspace-b")
        );

        assert_eq!(select_initial_workspace(&Inner::default()), None);
    }

    #[test]
    fn sanitize_records_drops_invalid_and_duplicate_ids() {
        let file = WorkspaceFile {
            next_rank: 10,
            workspaces: vec![
                WorkspaceRecord {
                    id: "".into(),
                    label: "".into(),
                    project_id: None,
                    position: None,
                    size: None,
                    maximized: false,
                    detached: false,
                    rank: 1,
                },
                WorkspaceRecord {
                    id: "main:evil".into(),
                    label: "main:evil".into(),
                    project_id: None,
                    position: None,
                    size: None,
                    maximized: false,
                    detached: false,
                    rank: 2,
                },
                WorkspaceRecord {
                    id: "main".into(),
                    label: "main".into(),
                    project_id: Some("p1".into()),
                    position: None,
                    size: None,
                    maximized: false,
                    detached: false,
                    rank: 3,
                },
                // Duplicate id: later records are dropped (keep-first).
                WorkspaceRecord {
                    id: "main".into(),
                    label: "main".into(),
                    project_id: Some("p2".into()),
                    position: None,
                    size: None,
                    maximized: false,
                    detached: false,
                    rank: 4,
                },
            ],
        };
        let sanitized = sanitize_workspace_records(file);
        assert_eq!(sanitized.workspaces.len(), 1);
        assert_eq!(sanitized.workspaces[0].id, "main");
        assert_eq!(sanitized.workspaces[0].project_id.as_deref(), Some("p1"));
    }

    #[test]
    fn sanitize_records_normalizes_labels_and_fixes_next_rank() {
        let file = WorkspaceFile {
            next_rank: 0,
            workspaces: vec![WorkspaceRecord {
                id: "workspace-abc".into(),
                label: "some-other-label".into(),
                project_id: None,
                position: None,
                size: None,
                maximized: false,
                detached: false,
                rank: 41,
            }],
        };
        let sanitized = sanitize_workspace_records(file);
        assert_eq!(sanitized.workspaces[0].label, "workspace-abc");
        // next_rank must stay strictly above the highest rank, even when the
        // persisted counter was zero or behind.
        assert_eq!(sanitized.next_rank, 42);
    }

    #[test]
    fn sanitize_size_rejects_zero_tiny_and_absurd_sizes() {
        // Zero / sub-minimum sizes would create an unusable (invisible)
        // window.
        assert_eq!(sanitize_window_size(Some((0, 0))), (1280.0, 800.0));
        assert_eq!(sanitize_window_size(Some((100, 100))), (1280.0, 800.0));
        assert_eq!(sanitize_window_size(Some((799, 500))), (1280.0, 800.0));
        assert_eq!(sanitize_window_size(Some((800, 499))), (1280.0, 800.0));
        // Sizes near u32::MAX would panic tao's Windows backend
        // (unchecked i32 arithmetic while adjusting the window rect).
        assert_eq!(
            sanitize_window_size(Some((u32::MAX, u32::MAX))),
            (1280.0, 800.0)
        );
        assert_eq!(
            sanitize_window_size(Some((2_000_000, 2_000_000))),
            (1280.0, 800.0)
        );
        // Sane sizes - including large multi-monitor ones - survive.
        assert_eq!(sanitize_window_size(Some((2246, 1487))), (2246.0, 1487.0));
        assert_eq!(sanitize_window_size(Some((3846, 4096))), (3846.0, 4096.0));
        assert_eq!(sanitize_window_size(None), (1280.0, 800.0));
    }

    #[test]
    fn clamp_handles_offscreen_and_extreme_positions_without_overflow() {
        // Minimized-window sentinel coordinates.
        assert_eq!(
            clamp_to_work_area(Some((0, 0, 1920, 1080)), (-32000, -32000), (1280, 800)),
            (0, 0)
        );
        // Positions near i32::MAX: tao adds the frame thickness to the
        // requested x while picking the target monitor, so the clamp must
        // bring them back before the window builder ever sees them.
        assert_eq!(
            clamp_to_work_area(Some((0, 0, 1920, 1080)), (i32::MAX, i32::MAX), (1280, 800),),
            (640, 280)
        );
        assert_eq!(
            clamp_to_work_area(Some((0, 0, 1920, 1080)), (i32::MIN, i32::MIN), (1280, 800),),
            (0, 0)
        );
        // A monitor removed since the position was saved.
        assert_eq!(
            clamp_to_work_area(Some((0, 0, 3072, 1920)), (3147, -1715), (2246, 1487)),
            (826, 0)
        );
        // No monitor info: position passes through untouched.
        assert_eq!(
            clamp_to_work_area(None, (1500, 500), (1280, 800)),
            (1500, 500)
        );
    }

    #[test]
    fn window_requests_queue_until_startup_is_ready() {
        let manager = WindowManager::new(PathBuf::from("unused.json"));
        // A brand-new manager is still Initializing: requests are queued.
        assert!(manager.queue_window_request());
        assert!(manager.queue_window_request());
        assert_eq!(manager.inner.read().pending_window_requests.len(), 2);

        // Once ready, requests are served immediately instead of queuing.
        manager.inner.write().startup_state = StartupState::Ready;
        assert!(!manager.queue_window_request());
        assert_eq!(manager.inner.read().pending_window_requests.len(), 2);

        // complete_startup drains the queue exactly once.
        assert_eq!(manager.complete_startup_for_test(), 2);
        assert_eq!(manager.inner.read().pending_window_requests.len(), 0);
        assert!(!manager.queue_window_request());
    }

    #[test]
    fn closing_one_workspace_never_touches_anothers_sessions() {
        use crate::commands::terminal::TerminalState;
        use crate::terminal::SessionSpawn;

        let terminal = TerminalState::new();
        let spawn = |id: &str, workspace: &str| SessionSpawn {
            session_id: id.into(),
            project_id: "project-1".into(),
            profile_id: "profile-1".into(),
            workspace_id: Some(workspace.into()),
            window_id: Some(workspace.into()),
            program: if cfg!(windows) {
                "cmd.exe".into()
            } else {
                "/bin/sh".into()
            },
            args: if cfg!(windows) {
                vec!["/Q".into()]
            } else {
                Vec::new()
            },
            cwd: None,
            env: Vec::new(),
            env_remove: Vec::new(),
            readiness_marker: None,
            rows: 24,
            cols: 80,
            scrollback_bytes: 1024,
        };
        terminal
            .manager
            .create(spawn("a-1", "workspace-a"))
            .unwrap();
        terminal
            .manager
            .create(spawn("a-2", "workspace-a"))
            .unwrap();
        terminal
            .manager
            .create(spawn("b-1", "workspace-b"))
            .unwrap();
        terminal.manager.create(spawn("remote", "none")).unwrap();

        // "Stop terminals in this window": exactly workspace-a's sessions die.
        let stopped = terminal.close_workspace_sessions("workspace-a");
        assert_eq!(stopped, 2);
        let remaining: Vec<String> = terminal
            .manager
            .list()
            .into_iter()
            .map(|info| info.session_id)
            .collect();
        assert!(remaining.contains(&"b-1".to_string()), "{remaining:?}");
        assert!(remaining.contains(&"remote".to_string()), "{remaining:?}");
        assert!(!remaining.contains(&"a-1".to_string()));
        assert!(!remaining.contains(&"a-2".to_string()));
        terminal.manager.close_all();
    }

    #[test]
    fn explicit_quit_closes_every_session_of_every_workspace() {
        use crate::commands::terminal::TerminalState;
        use crate::terminal::SessionSpawn;

        let terminal = TerminalState::new();
        let spawn = |id: &str, workspace: &str| SessionSpawn {
            session_id: id.into(),
            project_id: "project-1".into(),
            profile_id: "profile-1".into(),
            workspace_id: Some(workspace.into()),
            window_id: Some(workspace.into()),
            program: if cfg!(windows) {
                "cmd.exe".into()
            } else {
                "/bin/sh".into()
            },
            args: if cfg!(windows) {
                vec!["/Q".into()]
            } else {
                Vec::new()
            },
            cwd: None,
            env: Vec::new(),
            env_remove: Vec::new(),
            readiness_marker: None,
            rows: 24,
            cols: 80,
            scrollback_bytes: 1024,
        };
        terminal
            .manager
            .create(spawn("a-1", "workspace-a"))
            .unwrap();
        terminal
            .manager
            .create(spawn("b-1", "workspace-b"))
            .unwrap();
        terminal
            .manager
            .create(spawn("b-2", "workspace-b"))
            .unwrap();
        assert_eq!(terminal.manager.list().len(), 3);

        terminal.manager.close_all();
        assert!(terminal.manager.list().is_empty());
    }
}
