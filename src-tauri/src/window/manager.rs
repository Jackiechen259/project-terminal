//! `WindowManager`: owns the process's single desktop window (`main`).
//!
//! Project Terminal is a single-process, single-main-window application.
//! Invariants:
//!
//! - The only desktop window label is `main` (`MAIN_WINDOW_LABEL`). The
//!   window is created exactly once per process, by this manager, during
//!   startup. Projects, terminal tabs, split panes, memos, and file views are
//!   multiplexed inside that window.
//! - A second application launch never creates another window: the
//!   single-instance callback calls `focus_main_window`, which restores and
//!   focuses the existing `main` window.
//! - PTYs are process-global (`TerminalManager`). Sessions carry the
//!   workspace id of the window that created them (`main`).
//! - Closing the window never shuts the process down and never destroys the
//!   window: the close path hides it to the tray so PTYs and WebView state
//!   keep running. Only the explicit quit path calls
//!   `TerminalManager::close_all` and exits the process.
//! - Geometry and active project survive process exit in
//!   `window-workspaces.json` and are restored on the next launch. Legacy
//!   multi-window files (several `workspace-{uuid}` records) are collapsed to
//!   the single `main` record during load: the most recently active record
//!   wins and contributes its geometry and project.
//! - Windows are created by this manager only; no frontend component ever
//!   calls `WebviewWindowBuilder` directly.

use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::menu::{IsMenuItem, Menu, MenuItem};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::{AppError, AppResult};
use crate::storage;
use crate::terminal::manager::TerminalManager;
use crate::terminal::session::SessionStatus;

/// Label of the process's single desktop window. It is also the workspace id
/// every desktop session is created under.
pub const MAIN_WINDOW_LABEL: &str = "main";

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
const WINDOW_BACKGROUND: tauri::window::Color = tauri::window::Color(9, 9, 11, 255);
const DEFAULT_WINDOW_TITLE: &str = "Project Terminal";

const TRAY_MENU_ID_SHOW: &str = "show";
const TRAY_MENU_ID_HIDE: &str = "hide";
const TRAY_MENU_ID_QUIT: &str = "quit";

/// The single main window's identity and geometry, persisted across process
/// exits in `window-workspaces.json`.
///
/// `id`/`label` are always `main` in files written by this version. The
/// `workspaces` array shape is kept so files written by older multi-window
/// versions still parse; the load path collapses them to one record.
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
    /// Recency counter. Only meaningful for legacy multi-window files, where
    /// the migration picks the record with the highest rank. Always `1` in
    /// single-window files.
    #[serde(default)]
    pub rank: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFile {
    #[serde(default)]
    workspaces: Vec<WorkspaceRecord>,
    /// Legacy counter, kept so old files parse. Unused by the single-window
    /// format.
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

/// What the window close handler should do with a `CloseRequested`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowCloseDecision {
    /// Not a window owned by this manager (defensive; no such window can
    /// normally exist): let the close proceed.
    Allow,
    /// The main window has no running sessions: hide it to the tray.
    HideToTray,
    /// The main window still has running sessions: hold the window open and
    /// ask the frontend to choose between hiding (terminals keep running) and
    /// quitting.
    AskFrontend {
        workspace_id: String,
        running_count: usize,
    },
}

/// What the startup window-restore pass ended up doing. Persisted-state
/// problems are recovered from, never fatal: only a completely unavailable
/// windowing runtime (WebView2 broken, Tauri runtime failure) may abort
/// startup, and that is surfaced as an error by `initialize_with_recovery`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowInitOutcome {
    /// The persisted main-window state was restored as the initial window.
    Restored,
    /// No persisted state existed: a fresh main window was created.
    Fresh,
    /// Persisted state could not be restored; a safe fallback window was
    /// created instead, so the application still starts.
    RecoveredFromInvalidState,
}

/// Whether the window manager has finished its startup pass. Focus requests
/// (second-instance launches, tray clicks) that arrive while `Initializing`
/// are queued and served once the manager is ready.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum StartupState {
    #[default]
    Initializing,
    Ready,
}

#[derive(Default)]
struct Inner {
    /// The single main-window record. `None` only before startup completes.
    record: Option<WorkspaceRecord>,
    /// Workspace id a legacy multi-window registry was collapsed from, if
    /// any. Exposed to the frontend so it can run a one-time layout
    /// migration. `None` in the steady state.
    migrated_from: Option<String>,
    startup_state: StartupState,
    /// Focus requests that arrived before `startup_state` became `Ready`.
    /// Served by `complete_startup`.
    pending_focus_requests: VecDeque<()>,
}

pub struct WindowManager {
    inner: Arc<RwLock<Inner>>,
    workspace_file: PathBuf,
}

impl WindowManager {
    pub fn new(workspace_file: PathBuf) -> Self {
        Self {
            inner: Arc::new(RwLock::new(Inner::default())),
            workspace_file,
        }
    }

    /// Load the persisted registry, collapse any legacy multi-window state to
    /// the single `main` record, create the main window, and serve focus
    /// requests that arrived during startup.
    ///
    /// Recovery semantics: unrestorable persisted state is quarantined and a
    /// safe fallback window is created instead - bad persisted state must
    /// never keep the application from starting. Only when even the fallback
    /// window cannot be created (WebView2 unavailable, Tauri runtime failure)
    /// is an error returned, which the caller turns into a fatal startup
    /// error.
    pub fn initialize_with_recovery(&self, app: &AppHandle) -> AppResult<WindowInitOutcome> {
        let (record, migrated_from) = migrate_to_single_main(self.load_workspaces());
        tracing::info!(
            migrated_from = migrated_from.as_deref().unwrap_or("(none)"),
            "window registry loaded and collapsed to the single main window"
        );
        {
            let mut inner = self.inner.write();
            inner.record = record;
            inner.migrated_from = migrated_from;
        }

        let outcome = self.restore_initial_window(app)?;
        self.save_workspaces();
        self.complete_startup(app);
        Ok(outcome)
    }

    /// Restore the persisted main-window record as the initial window.
    ///
    /// When restoration fails the persisted record is kept (so the next
    /// launch retries it) but a safe default-geometry window is created
    /// instead - the application must still start even if the persisted state
    /// is damaged.
    fn restore_initial_window(&self, app: &AppHandle) -> AppResult<WindowInitOutcome> {
        let record = self.inner.read().record.clone();
        let Some(record) = record else {
            return self.create_fallback_window(app, false);
        };
        match self.create_main_window(app, Some(&record)) {
            Ok(()) => {
                tracing::info!("initial main window restored");
                Ok(WindowInitOutcome::Restored)
            }
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    "failed to restore main window from persisted state; using default geometry"
                );
                self.create_fallback_window(app, true)
            }
        }
    }

    /// Create the safe fallback initial window with default geometry.
    /// `recovered` marks whether the call recovers from a quarantine
    /// (`RecoveredFromInvalidState`) or is a clean start (`Fresh`).
    fn create_fallback_window(
        &self,
        app: &AppHandle,
        recovered: bool,
    ) -> AppResult<WindowInitOutcome> {
        match self.create_main_window(app, None) {
            Ok(()) => {
                tracing::info!("main window created with default geometry");
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

    /// Mark the manager ready and serve focus requests that arrived while
    /// startup was still running (for example a second-instance launch that
    /// was signalled before the event loop started).
    fn complete_startup(&self, app: &AppHandle) {
        let pending = {
            let mut inner = self.inner.write();
            inner.startup_state = StartupState::Ready;
            std::mem::take(&mut inner.pending_focus_requests)
        };
        for _ in pending {
            tracing::info!("serving focus request queued during startup");
            self.focus_main_window(app);
        }
    }

    /// Restore and focus the existing `main` window. This is the entire
    /// second-launch / tray-click behavior: never a second window.
    ///
    /// Requests that arrive before startup completes are queued and served by
    /// `complete_startup`. Never panics and never fails startup - errors are
    /// logged. If no `main` window is alive (defensive; it normally is hidden,
    /// never destroyed) it is recreated from the saved record.
    pub fn focus_main_window(&self, app: &AppHandle) {
        if self.queue_focus_request() {
            tracing::info!("focus request queued until startup completes");
            return;
        }
        if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            tracing::info!("focusing existing main window");
            return;
        }
        let record = self.inner.read().record.clone();
        if let Err(error) = self.create_main_window(app, record.as_ref()) {
            tracing::warn!(error = %error, "failed to recreate main window");
        }
    }

    /// Hide the main window to the tray. Sessions keep running.
    pub fn hide_main_window(&self, app: &AppHandle) {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
            let _ = window.hide();
            tracing::info!("main window hidden to tray");
        }
    }

    /// `true` when the manager is still initializing and the request was
    /// queued; `false` when the caller should focus the window directly.
    fn queue_focus_request(&self) -> bool {
        let mut inner = self.inner.write();
        if inner.startup_state == StartupState::Initializing {
            inner.pending_focus_requests.push_back(());
            true
        } else {
            false
        }
    }

    /// Test-only: mark the manager ready and report how many requests were
    /// queued during startup (without touching any window).
    #[cfg(test)]
    fn complete_startup_for_test(&self) -> usize {
        let mut inner = self.inner.write();
        inner.startup_state = StartupState::Ready;
        let pending = std::mem::take(&mut inner.pending_focus_requests);
        pending.len()
    }

    /// Create the process's single main window (label `main`), or adopt one
    /// that already exists. `saved` supplies persisted geometry/project;
    /// `None` means defaults. Never creates a second window: when a `main`
    /// window already exists it is adopted and focused instead.
    ///
    /// Geometry is sanitized before it reaches the builder: tao's Windows
    /// backend performs unchecked i32 arithmetic on the requested position
    /// and size, so extreme persisted values (removed monitors,
    /// minimized-window sentinel coordinates, corrupt records) would panic -
    /// or worse, wrap - during window creation.
    fn create_main_window(
        &self,
        app: &AppHandle,
        saved: Option<&WorkspaceRecord>,
    ) -> AppResult<()> {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
            tracing::info!("main window already exists; adopting it");
            self.adopt_existing_window(&window);
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            return Ok(());
        }

        let (width, height) = sanitize_window_size(saved.and_then(|record| record.size));
        let position = match saved.and_then(|record| record.position) {
            Some((x, y)) => {
                let (x, y) = sanitize_window_position(app, (x, y), (width, height));
                Some((x as f64, y as f64))
            }
            None => None,
        };
        let maximized = saved.map(|record| record.maximized).unwrap_or(false);
        let project_id = saved.and_then(|record| record.project_id.clone());

        let mut builder = WebviewWindowBuilder::new(
            app,
            MAIN_WINDOW_LABEL.to_string(),
            WebviewUrl::App("index.html".into()),
        )
        .title(DEFAULT_WINDOW_TITLE)
        .inner_size(width, height)
        .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        .decorations(false)
        .background_color(WINDOW_BACKGROUND);
        if let Some((x, y)) = position {
            builder = builder.position(x, y);
        }
        tracing::debug!(width, height, ?position, maximized, "building main window");
        let window = builder
            .build()
            .map_err(|e| AppError::Configuration(format!("Failed to create window: {e}")))?;

        // Only now register the record: a failed build must not leave a
        // phantom record behind.
        {
            let mut inner = self.inner.write();
            inner.record = Some(WorkspaceRecord {
                id: MAIN_WINDOW_LABEL.to_string(),
                label: MAIN_WINDOW_LABEL.to_string(),
                project_id,
                position: position.map(|(x, y)| (x as i32, y as i32)),
                size: Some((width as u32, height as u32)),
                maximized,
                rank: 1,
            });
        }

        if maximized {
            let _ = window.maximize();
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();

        if let Err(error) = self.update_window_title(app) {
            tracing::warn!(error = %error, "failed to update window title");
        }
        self.save_workspaces();
        tracing::info!("main window created");
        Ok(())
    }

    /// Make sure an already-existing `main` window is part of the registry.
    ///
    /// Defensive: every window of the process is expected to be created by
    /// this manager. Without the adoption, `workspace_info`,
    /// `SessionOwnership::from_webview`, `set_window_project` and close
    /// handling would silently miss the window.
    fn adopt_existing_window(&self, window: &tauri::WebviewWindow) {
        let mut inner = self.inner.write();
        let project_id = inner
            .record
            .as_ref()
            .and_then(|record| record.project_id.clone());
        inner.record = Some(WorkspaceRecord {
            id: MAIN_WINDOW_LABEL.to_string(),
            label: MAIN_WINDOW_LABEL.to_string(),
            project_id,
            position: window.outer_position().ok().map(|p| (p.x, p.y)),
            size: window.outer_size().ok().map(|s| (s.width, s.height)),
            maximized: window.is_maximized().unwrap_or(false),
            rank: 1,
        });
        drop(inner);
        tracing::info!("adopted existing main window into the registry");
    }

    /// Decide what a `CloseRequested` should do for the given window label.
    ///
    /// The main window is never destroyed by a close request: with no running
    /// sessions it hides to the tray; with running sessions the frontend is
    /// asked to choose between hiding (terminals keep running) and quitting.
    /// Unknown labels (defensive; no other window can exist) close outright.
    pub fn on_close_requested(
        &self,
        terminal: &TerminalManager,
        label: &str,
    ) -> WindowCloseDecision {
        let registered = match self.inner.read().record.as_ref() {
            Some(record) => record.label == label,
            None => false,
        };
        if !registered {
            return WindowCloseDecision::Allow;
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
            WindowCloseDecision::HideToTray
        }
    }

    /// React to the main window being destroyed (only happens during the
    /// explicit quit path): persist the registry so the next launch restores
    /// it.
    pub fn on_window_destroyed(&self, label: &str) {
        if label != MAIN_WINDOW_LABEL {
            return;
        }
        self.save_workspaces();
    }

    /// Track window moves so they survive restarts.
    pub fn record_position(&self, label: &str, x: i32, y: i32) {
        if label != MAIN_WINDOW_LABEL {
            return;
        }
        let mut inner = self.inner.write();
        if let Some(record) = inner.record.as_mut() {
            record.position = Some((x, y));
        }
    }

    /// Track window resizes and maximized state.
    pub fn record_resized(&self, label: &str, width: u32, height: u32, maximized: bool) {
        if label != MAIN_WINDOW_LABEL {
            return;
        }
        let mut inner = self.inner.write();
        if let Some(record) = inner.record.as_mut() {
            record.size = Some((width, height));
            record.maximized = maximized;
        }
    }

    /// The workspace id owning a window label (== `main` for the registered
    /// main window).
    pub fn workspace_id_for_window(&self, label: &str) -> Option<String> {
        let inner = self.inner.read();
        let record = inner.record.as_ref()?;
        if record.label != label {
            return None;
        }
        Some(record.id.clone())
    }

    /// The project the main window currently has selected, if any.
    pub fn project_id_for_window(&self, label: &str) -> Option<String> {
        let inner = self.inner.read();
        let record = inner.record.as_ref()?;
        if record.label != label {
            return None;
        }
        record.project_id.clone()
    }

    /// Workspace id a legacy multi-window registry was collapsed from, if
    /// any. Lets the frontend run a one-time layout migration.
    pub fn migrated_from_workspace_id(&self) -> Option<String> {
        self.inner.read().migrated_from.clone()
    }

    /// Record which project the main window has selected and update its
    /// title. Called by the frontend whenever the active project changes.
    pub fn set_window_project(
        &self,
        app: &AppHandle,
        workspace_id: &str,
        project_id: Option<String>,
    ) -> AppResult<()> {
        {
            let mut inner = self.inner.write();
            let Some(record) = inner.record.as_mut() else {
                return Ok(());
            };
            if record.label != workspace_id {
                return Ok(());
            }
            record.project_id = project_id;
        }
        self.update_window_title(app)?;
        self.save_workspaces();
        Ok(())
    }

    /// Recompute and apply the main window's title.
    pub fn update_window_title(&self, app: &AppHandle) -> AppResult<()> {
        let (title, label) = {
            let inner = self.inner.read();
            let Some(record) = inner.record.as_ref() else {
                return Ok(());
            };
            let name = project_name(app, record.project_id.as_deref());
            (compute_window_title(name.as_deref()), record.label.clone())
        };
        if let Some(window) = app.get_webview_window(&label) {
            window
                .set_title(&title)
                .map_err(|e| AppError::Configuration(format!("Failed to set window title: {e}")))?;
        }
        Ok(())
    }

    /// Persist the registry to `window-workspaces.json`. Failures are logged,
    /// never fatal: worst case the next launch starts with default geometry.
    pub fn save_workspaces(&self) {
        let file = {
            let inner = self.inner.read();
            WorkspaceFile {
                workspaces: inner.record.iter().cloned().collect(),
                next_rank: 1,
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

    /// The static tray menu: Show / Hide / Quit. No window list - there is
    /// exactly one window.
    pub fn build_tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
        let show = MenuItem::with_id(
            app,
            TRAY_MENU_ID_SHOW,
            "Show Project Terminal",
            true,
            None::<&str>,
        )?;
        let hide = MenuItem::with_id(
            app,
            TRAY_MENU_ID_HIDE,
            "Hide Project Terminal",
            true,
            None::<&str>,
        )?;
        let quit = MenuItem::with_id(
            app,
            TRAY_MENU_ID_QUIT,
            "Quit and Stop All Sessions",
            true,
            None::<&str>,
        )?;
        let items: [&dyn IsMenuItem<tauri::Wry>; 3] = [&show, &hide, &quit];
        Menu::with_items(app, &items)
    }
}

/// Whether a string is usable as a workspace id / Tauri window label.
///
/// Labels also flow into IPC event names and frontend storage keys, so
/// anything beyond ASCII alphanumerics and `-_.` is rejected. Persisted
/// records with invalid ids are dropped at load.
fn is_valid_workspace_label(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Collapse a persisted (possibly multi-window, legacy) registry into the
/// single main-window record.
///
/// The record with the highest `rank` (most recently active) wins and
/// contributes its geometry and project; its identity is rewritten to `main`.
/// Invalid or duplicate records are dropped. Returns the migrated record and
/// - when the winner was not already `main` - its original workspace id (so
///   the frontend can run a one-time per-workspace layout migration).
fn migrate_to_single_main(file: WorkspaceFile) -> (Option<WorkspaceRecord>, Option<String>) {
    let mut seen: HashSet<String> = HashSet::new();
    let mut best: Option<WorkspaceRecord> = None;
    for record in file.workspaces {
        if !is_valid_workspace_label(&record.id) {
            tracing::warn!(workspace = %record.id, "dropping workspace record with invalid id");
            continue;
        }
        if !seen.insert(record.id.clone()) {
            tracing::warn!(workspace = %record.id, "dropping duplicate workspace record");
            continue;
        }
        let better = match &best {
            None => true,
            Some(current) => record.rank > current.rank,
        };
        if better {
            best = Some(record);
        }
    }
    let Some(mut record) = best else {
        return (None, None);
    };
    let migrated_from = if record.id != MAIN_WINDOW_LABEL {
        Some(record.id.clone())
    } else {
        None
    };
    if migrated_from.is_some() {
        tracing::info!(
            workspace = %record.id,
            "migrating legacy workspace into the single main window"
        );
    }
    record.id = MAIN_WINDOW_LABEL.to_string();
    record.label = MAIN_WINDOW_LABEL.to_string();
    record.rank = 1;
    (Some(record), migrated_from)
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

/// The taskbar title for the single main window: `Project Terminal`, or
/// `Project Terminal — {project}` while a project is selected.
fn compute_window_title(project_name: Option<&str>) -> String {
    match project_name {
        Some(name) => format!("Project Terminal — {name}"),
        None => DEFAULT_WINDOW_TITLE.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(
        id: &str,
        project: Option<&str>,
        position: Option<(i32, i32)>,
        size: Option<(u32, u32)>,
        maximized: bool,
        rank: u64,
    ) -> WorkspaceRecord {
        WorkspaceRecord {
            id: id.to_string(),
            label: id.to_string(),
            project_id: project.map(|p| p.to_string()),
            position,
            size,
            maximized,
            rank,
        }
    }

    fn file_with(records: Vec<WorkspaceRecord>) -> WorkspaceFile {
        WorkspaceFile {
            workspaces: records,
            next_rank: 1,
        }
    }

    #[test]
    fn migration_picks_the_most_recently_active_workspace() {
        // Legacy multi-window file: `main` is older than workspace-b, which is
        // older than workspace-a. The most recently active record wins and
        // becomes the single `main` record, geometry and project included.
        let file = file_with(vec![
            record("main", Some("p-main"), None, None, false, 5),
            record(
                "workspace-old-b",
                Some("p-b"),
                Some((100, 132)),
                Some((1280, 800)),
                true,
                9,
            ),
            record(
                "workspace-old-a",
                Some("p-a"),
                Some((240, 260)),
                Some((1920, 1080)),
                false,
                10,
            ),
        ]);
        let (migrated, from) = migrate_to_single_main(file);
        assert_eq!(from.as_deref(), Some("workspace-old-a"));
        let record = migrated.expect("a record must be migrated");
        assert_eq!(record.id, MAIN_WINDOW_LABEL);
        assert_eq!(record.label, MAIN_WINDOW_LABEL);
        assert_eq!(record.project_id.as_deref(), Some("p-a"));
        assert_eq!(record.position, Some((240, 260)));
        assert_eq!(record.size, Some((1920, 1080)));
        assert!(!record.maximized);
    }

    #[test]
    fn migration_keeps_a_single_main_record_untouched() {
        let file = file_with(vec![record(
            "main",
            Some("p1"),
            Some((10, 20)),
            Some((1400, 900)),
            true,
            3,
        )]);
        let (migrated, from) = migrate_to_single_main(file);
        assert_eq!(from, None);
        let record = migrated.expect("a record must be migrated");
        assert_eq!(record.id, MAIN_WINDOW_LABEL);
        assert_eq!(record.project_id.as_deref(), Some("p1"));
        assert_eq!(record.position, Some((10, 20)));
        assert!(record.maximized);
    }

    #[test]
    fn migration_of_an_empty_file_yields_no_record() {
        let (migrated, from) = migrate_to_single_main(file_with(Vec::new()));
        assert!(migrated.is_none());
        assert!(from.is_none());
    }

    #[test]
    fn migration_drops_invalid_and_duplicate_records() {
        let file = file_with(vec![
            record("", None, None, None, false, 1),
            record("main:evil", None, None, None, false, 2),
            // Duplicate ids: the first occurrence wins, the later one is
            // dropped regardless of rank.
            record("main", Some("p1"), None, None, false, 3),
            record("main", Some("p2"), None, None, false, 4),
        ]);
        let (migrated, from) = migrate_to_single_main(file);
        assert_eq!(from, None);
        let record = migrated.expect("the valid record must win");
        assert_eq!(record.project_id.as_deref(), Some("p1"));
    }

    #[test]
    fn migration_wins_by_rank_not_by_position_in_file() {
        // The max-rank record appears first in the file; a lower-rank record
        // after it must not override it.
        let file = file_with(vec![
            record("workspace-x", Some("p-x"), None, None, false, 10),
            record("workspace-y", Some("p-y"), None, None, false, 2),
            record("workspace-z", Some("p-z"), None, None, false, 4),
        ]);
        let (migrated, from) = migrate_to_single_main(file);
        assert_eq!(from.as_deref(), Some("workspace-x"));
        assert_eq!(migrated.unwrap().project_id.as_deref(), Some("p-x"));
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
    fn compute_title_reflects_the_selected_project() {
        assert_eq!(compute_window_title(None), "Project Terminal");
        assert_eq!(
            compute_window_title(Some("opi-platform")),
            "Project Terminal — opi-platform"
        );
    }

    #[test]
    fn workspace_file_round_trips_with_camel_case_keys() {
        let file = WorkspaceFile {
            next_rank: 1,
            workspaces: vec![record(
                "main",
                Some("project-1"),
                Some((100, 132)),
                Some((1280, 800)),
                true,
                1,
            )],
        };
        let json = serde_json::to_string(&file).unwrap();
        assert!(json.contains("\"projectId\":\"project-1\""), "{json}");
        assert!(json.contains("\"position\":[100,132]"), "{json}");
        assert!(json.contains("\"maximized\":true"), "{json}");
        let decoded: WorkspaceFile = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.workspaces.len(), 1);
        assert_eq!(decoded.workspaces[0].id, "main");
        assert_eq!(decoded.workspaces[0].size, Some((1280, 800)));
    }

    #[test]
    fn legacy_file_fields_are_ignored_when_missing() {
        // A file written by the single-window version must parse, and so must
        // a file from the multi-window version (extra `detached`/`nextRank`
        // fields are ignored).
        let decoded: WorkspaceFile = serde_json::from_str(r#"{"workspaces":[]}"#).unwrap();
        assert!(decoded.workspaces.is_empty());

        let legacy = serde_json::from_str::<WorkspaceFile>(
            r#"{"workspaces":[{"id":"main","label":"main","detached":false,"rank":3}],"nextRank":9}"#,
        )
        .unwrap();
        assert_eq!(legacy.workspaces.len(), 1);
        assert_eq!(legacy.next_rank, 9);
        assert_eq!(legacy.workspaces[0].id, "main");
    }

    #[test]
    fn focus_requests_queue_until_startup_is_ready() {
        let manager = WindowManager::new(PathBuf::from("unused.json"));
        // A brand-new manager is still Initializing: requests are queued.
        assert!(manager.queue_focus_request());
        assert!(manager.queue_focus_request());
        assert_eq!(manager.inner.read().pending_focus_requests.len(), 2);

        // Once ready, requests are served immediately instead of queuing.
        manager.inner.write().startup_state = StartupState::Ready;
        assert!(!manager.queue_focus_request());
        assert_eq!(manager.inner.read().pending_focus_requests.len(), 2);

        // complete_startup drains the queue exactly once.
        assert_eq!(manager.complete_startup_for_test(), 2);
        assert_eq!(manager.inner.read().pending_focus_requests.len(), 0);
        assert!(!manager.queue_focus_request());
    }

    #[test]
    fn close_decision_asks_only_when_the_main_window_has_running_sessions() {
        use crate::commands::terminal::TerminalState;
        use crate::terminal::SessionSpawn;

        fn spawn(session_id: &str, workspace: Option<&str>) -> SessionSpawn {
            SessionSpawn {
                session_id: session_id.into(),
                project_id: "project-1".into(),
                profile_id: "profile-1".into(),
                workspace_id: workspace.map(|w| w.into()),
                window_id: workspace.map(|w| w.into()),
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
            }
        }

        let terminal = TerminalState::new();
        // main: one running session; a remote (ownerless) session must never
        // count against the main window.
        terminal
            .manager
            .create(spawn("main-running", Some("main")))
            .unwrap();
        let mut remote = spawn("remote-1", None);
        remote.workspace_id = None;
        remote.window_id = None;
        terminal.manager.create(remote).unwrap();

        let manager = WindowManager::new(PathBuf::from("unused.json"));
        manager.inner.write().record = Some(record("main", None, None, None, false, 1));

        assert_eq!(
            manager.on_close_requested(&terminal.manager, "main"),
            WindowCloseDecision::AskFrontend {
                workspace_id: "main".into(),
                running_count: 1,
            }
        );

        // With everything stopped the main window hides to the tray instead
        // of being destroyed.
        terminal.manager.close_all();
        assert_eq!(
            manager.on_close_requested(&terminal.manager, "main"),
            WindowCloseDecision::HideToTray
        );

        // Unknown windows (defensive; none can exist) close outright.
        assert_eq!(
            manager.on_close_requested(&terminal.manager, "unknown"),
            WindowCloseDecision::Allow
        );
        terminal.manager.close_all();
    }

    #[test]
    fn record_helpers_only_touch_the_main_window() {
        let manager = WindowManager::new(PathBuf::from("unused.json"));
        manager.inner.write().record = Some(record("main", Some("p1"), None, None, false, 1));

        // Geometry tracking for a foreign label is ignored.
        manager.record_position("workspace-stray", 5, 5);
        manager.record_resized("workspace-stray", 100, 100, true);
        assert_eq!(manager.inner.read().record.as_ref().unwrap().position, None);

        manager.record_position(MAIN_WINDOW_LABEL, 40, 50);
        manager.record_resized(MAIN_WINDOW_LABEL, 1600, 900, true);
        let record = manager.inner.read().record.clone().unwrap();
        assert_eq!(record.position, Some((40, 50)));
        assert_eq!(record.size, Some((1600, 900)));
        assert!(record.maximized);

        // Lookups for foreign labels return None.
        assert_eq!(manager.workspace_id_for_window("workspace-stray"), None);
        assert_eq!(manager.project_id_for_window("workspace-stray"), None);
        assert_eq!(
            manager
                .workspace_id_for_window(MAIN_WINDOW_LABEL)
                .as_deref(),
            Some("main")
        );
        assert_eq!(
            manager.project_id_for_window(MAIN_WINDOW_LABEL).as_deref(),
            Some("p1")
        );
    }

    #[test]
    fn migrated_from_is_reported_to_the_frontend() {
        let manager = WindowManager::new(PathBuf::from("unused.json"));
        assert_eq!(manager.migrated_from_workspace_id(), None);
        manager.inner.write().migrated_from = Some("workspace-legacy".into());
        assert_eq!(
            manager.migrated_from_workspace_id().as_deref(),
            Some("workspace-legacy")
        );
    }

    #[test]
    fn explicit_quit_closes_every_session() {
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
        terminal.manager.create(spawn("a-1", "main")).unwrap();
        terminal.manager.create(spawn("a-2", "main")).unwrap();
        assert_eq!(terminal.manager.list().len(), 2);

        terminal.manager.close_all();
        assert!(terminal.manager.list().is_empty());
    }
}
