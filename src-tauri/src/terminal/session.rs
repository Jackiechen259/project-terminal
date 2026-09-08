//! Terminal session: owns one PTY plus a reader thread, bounded scrollback,
//! and a Rust-owned render/control stream.
//!
//! The session intentionally has no knowledge of profiles or projects - the
//! manager constructs it from resolved local, WSL, or SSH configuration.

use std::collections::HashMap;
use std::io::Write;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{broadcast, watch};

use crate::error::{AppError, AppResult};
use crate::terminal_engine::{
    TerminalEngine, TerminalKeyEvent, TerminalMouseEvent, WeztermTerminalConfig,
    WeztermTerminalEngine,
};

use super::frame_scheduler::{TerminalFrameHub, TerminalFrameSubscription};
use super::pty_pump::spawn_pty_pump;

/// What to spawn inside the PTY.
#[derive(Debug, Clone)]
pub struct SessionSpawn {
    pub session_id: String,
    pub project_id: String,
    pub profile_id: String,
    /// The workspace window that requested this session. `None` for sessions
    /// created outside any window (for example the remote gateway).
    pub workspace_id: Option<String>,
    /// The window label the session belongs to (== `workspace_id` for desktop
    /// windows). `None` for sessions created outside any window.
    pub window_id: Option<String>,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    /// Variables to strip from the inherited environment before `env` is
    /// applied. Setting one to the empty string is not equivalent: a shell or
    /// library reading it sees a value, just a nonsensical one.
    pub env_remove: Vec<String>,
    /// When present, hold startup output until this readiness marker arrives.
    pub readiness_marker: Option<String>,
    pub rows: u16,
    pub cols: u16,
    /// Grid size in pixels. Image protocols and CSI 14/16 t queries read
    /// these; `0` means unknown.
    pub pixel_width: u16,
    pub pixel_height: u16,
    /// Legacy-compatible memory budget used only to derive a model row bound
    /// when `scrollback_lines` is absent. No raw PTY history is retained.
    pub scrollback_bytes: usize,
    /// Explicit visible scrollback rows from the desktop settings. `None`
    /// uses the byte-budget-to-row fallback in the terminal engine.
    pub scrollback_lines: Option<usize>,
}

/// Lifecycle state of a session. Mirrors the frontend's TerminalStatus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionStatus {
    Starting,
    Running,
    Exited,
    Error,
}

/// Lifecycle-only event stream for typed renderer attachments.
#[derive(Debug, Clone, Copy)]
pub struct TerminalStatusEvent {
    pub status: SessionStatus,
    pub exit_code: Option<i32>,
}

struct RendererAttachment {
    cancel: watch::Sender<bool>,
    paused: watch::Sender<bool>,
    is_paused: bool,
}

struct SessionInner {
    master: Box<dyn MasterPty + Send>,
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    exit_code: Option<i32>,
    status: SessionStatus,
    closing: bool,
}

/// Adapter used by wezterm-term for terminal-generated responses.  The
/// explicit input path and the model's response path share one serialized PTY
/// writer without sharing the terminal/session locks.
struct SharedPtyWriter {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl Write for SharedPtyWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.writer.lock().write(bytes)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.writer.lock().flush()
    }
}

fn find_ready_marker(output: &[u8], marker: &[u8]) -> Option<usize> {
    // Known shells receive an encoded command that does not contain the raw
    // marker. Match the raw marker in their output instead of relying on it
    // being immediately adjacent to a newline: PSReadLine may insert SGR and
    // cursor-control sequences around the output line.
    find_subslice(output, marker)
}

#[cfg(test)]
fn ready_output_contains_marker(output: &[u8], marker: &[u8]) -> bool {
    find_ready_marker(output, marker).is_some()
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

struct ReadyWatcher {
    marker: Option<Vec<u8>>,
    sender: Option<mpsc::Sender<Result<(), String>>>,
    pending: Vec<u8>,
    /// Stored so a process that exits before `wait_for_ready` starts can
    /// still surface its failure immediately instead of forcing a timeout.
    exit_error: Option<String>,
}

/// Outcome of feeding a PTY read through the readiness handshake filter.
///
/// The handshake is over within the first few reads of a session's life, so
/// the steady state must not copy the buffer just to hand it back.
#[derive(Debug, PartialEq, Eq)]
enum Processed {
    /// No handshake in flight: forward the read buffer untouched.
    PassThrough,
    /// Handshake bytes were removed; forward only what remains.
    Filtered(Vec<u8>),
}

impl ReadyWatcher {
    fn process(&mut self, bytes: &[u8]) -> Processed {
        let Some(marker) = self.marker.as_deref() else {
            return Processed::PassThrough;
        };

        self.pending.extend_from_slice(bytes);
        if let Some(marker_start) = find_ready_marker(&self.pending, marker) {
            let marker_end = marker_start + marker.len();

            // The shell echoes the readiness command before printing its
            // marker. It is internal protocol traffic, not terminal output;
            // discard it together with the marker's entire output line.
            let output_start = self.pending[marker_end..]
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|offset| marker_end + offset + 1)
                .unwrap_or(self.pending.len());
            let output = self.pending[output_start..].to_vec();

            if let Some(sender) = self.sender.take() {
                let _ = sender.send(Ok(()));
            }
            self.marker = None;
            self.pending.clear();
            return Processed::Filtered(output);
        }

        // Keep every byte until the handshake completes. Shells echo the
        // injected command, and forwarding partial output would expose that
        // protocol text above the actual terminal prompt.
        Processed::Filtered(Vec::new())
    }

    fn process_exited(&mut self, exit_code: Option<i32>) {
        // Once the readiness marker has been seen, a later shell exit is a
        // normal terminal lifecycle event rather than an initialization
        // failure.
        if self.marker.is_none() {
            return;
        }

        let code = exit_code
            .map(|code| format!(" with exit code {code}"))
            .unwrap_or_default();
        let mut message = format!("The shell process exited{code} before it became interactive");

        // WSL writes useful errors (unknown distro, invalid --cd path) to the
        // PTY. Those bytes are normally held back while waiting for the
        // marker, so include a compact copy in the returned error.
        let diagnostic = String::from_utf8_lossy(&self.pending)
            .replace('\0', "")
            .trim()
            .to_string();
        if !diagnostic.is_empty() {
            const MAX_DIAGNOSTIC_CHARS: usize = 600;
            let diagnostic: String = diagnostic.chars().take(MAX_DIAGNOSTIC_CHARS).collect();
            message.push_str(": ");
            message.push_str(&diagnostic);
        }

        self.exit_error = Some(message.clone());
        self.marker = None;
        self.pending.clear();
        if let Some(sender) = self.sender.take() {
            let _ = sender.send(Err(message));
        }
    }
}

pub struct TerminalSession {
    pub session_id: String,
    pub project_id: String,
    pub profile_id: String,
    pub workspace_id: Option<String>,
    pub window_id: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    inner: Arc<Mutex<SessionInner>>,
    /// Owned here rather than on `SessionInner` so a write (the hottest,
    /// most frequent operation on a session) never contends the same lock
    /// `resize()` holds across a blocking ConPTY syscall.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    ready_watcher: Arc<Mutex<ReadyWatcher>>,
    status_sender: broadcast::Sender<TerminalStatusEvent>,
    terminal_engine: Arc<Mutex<WeztermTerminalEngine>>,
    frame_hub: Arc<TerminalFrameHub>,
    attachments: Mutex<HashMap<String, RendererAttachment>>,
    /// Serializes the ConPTY resize with the model resize across concurrent
    /// callers. Never held together with `terminal_engine` or `inner` across
    /// the blocking ConPTY syscall - see `resize()`.
    resize_serial: Mutex<()>,
}

impl std::fmt::Debug for TerminalSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TerminalSession")
            .field("session_id", &self.session_id)
            .field("status", &self.inner.lock().status)
            .finish()
    }
}

impl TerminalSession {
    /// Spawn a PTY and start an always-on reader thread. The reader always
    /// feeds the Rust terminal model, even when no renderer is attached.
    pub fn spawn(spawn: SessionSpawn) -> AppResult<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: spawn.rows,
                cols: spawn.cols,
                pixel_width: spawn.pixel_width,
                pixel_height: spawn.pixel_height,
            })
            .map_err(|e| AppError::PtyCreationFailed(e.to_string()))?;

        // Build the command from the resolved spawn config.
        let mut cmd = CommandBuilder::new(&spawn.program);
        cmd.args(&spawn.args);
        if let Some(cwd) = &spawn.cwd {
            cmd.cwd(cwd);
        }
        // Always set TERM so shells render colors correctly. These go in before
        // the caller's variables so a profile-level override still wins - and
        // so does the TERM the caller resolved for this shell type.
        cmd.env("TERM", super::TERM_PORTABLE);
        cmd.env("COLORTERM", "truecolor");
        // `CommandBuilder::new` snapshots this process' environment, so a
        // TERM_PROGRAM inherited from whatever terminal launched the app would
        // follow the child around and misidentify it. That is not cosmetic:
        // capability detection commonly treats TERM_PROGRAM as authoritative
        // and stops looking at TERM once it is present.
        //
        // Identify ourselves rather than leaving it unset. A tool that special-
        // cases known terminals sees a name it does not recognise and takes its
        // generic path, which is correct; leaving the variable absent tells it
        // nothing at all. Never impersonate a name we do not implement.
        cmd.env("TERM_PROGRAM", "ProjectTerminal");
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        for key in &spawn.env_remove {
            cmd.env_remove(key);
        }
        for (k, v) in &spawn.env {
            cmd.env(k, v);
        }
        cmd.env("PROJECT_TERMINAL", "1");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::ShellStartFailed(e.to_string()))?;
        let killer = child.clone_killer();

        // Clone a reader off the master BEFORE moving master into the inner
        // state. portable-pty's MasterPty is not Sync, so we never share the
        // master itself across threads - only this cloned reader.
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::PtyCreationFailed(format!("try_clone_reader: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::PtyCreationFailed(format!("take_writer: {e}")))?;
        let shared_writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(writer));
        let mut terminal_engine = WeztermTerminalEngine::new(
            wezterm_term::TerminalSize {
                rows: spawn.rows as usize,
                cols: spawn.cols as usize,
                pixel_width: spawn.pixel_width as usize,
                pixel_height: spawn.pixel_height as usize,
                dpi: 96,
            },
            WeztermTerminalConfig {
                scrollback_lines: spawn
                    .scrollback_lines
                    .map(crate::terminal_engine::normalize_scrollback_lines)
                    .unwrap_or_else(|| {
                        crate::terminal_engine::scrollback_lines_for_bytes(
                            spawn.scrollback_bytes,
                            spawn.cols,
                        )
                    }),
                ..WeztermTerminalConfig::default()
            },
            Box::new(SharedPtyWriter {
                writer: Arc::clone(&shared_writer),
            }),
        );
        terminal_engine
            .terminal_mut()
            .set_clipboard(&crate::commands::clipboard::Osc52Clipboard::shared());
        let terminal_engine = Arc::new(Mutex::new(terminal_engine));
        let frame_hub = TerminalFrameHub::new(Arc::clone(&terminal_engine));
        let master: Box<dyn MasterPty + Send> = pair.master;
        // Drop the slave - we never spawn another process on this PTY.
        drop(pair.slave);

        let ready_watcher = Arc::new(Mutex::new(ReadyWatcher {
            marker: spawn
                .readiness_marker
                .as_ref()
                .map(|marker| marker.as_bytes().to_vec()),
            sender: None,
            pending: Vec::new(),
            exit_error: None,
        }));
        let session_id = spawn.session_id.clone();
        let (status_sender, _) = broadcast::channel(16);

        // Reader/parser pump: a dedicated OS-read thread coalesces PTY bytes
        // into bursts (see `pty_pump`), and each burst is fed to the
        // terminal model under a single lock acquisition - never once per
        // raw `read`. The handshake filter still scans for the one-shot
        // ready marker and removes that protocol line; every other byte goes
        // straight into the authoritative terminal model. No raw PTY history
        // or frontend output stream is maintained here. No extra "quiet
        // point" delay is added on the frame-scheduler side: the coalesced
        // burst boundary already is the quiet point, and the scheduler's own
        // 16ms cadence is enough on top of it.
        let engine_for_reader = Arc::clone(&terminal_engine);
        let frame_hub_for_reader = Arc::clone(&frame_hub);
        let watcher_for_reader = ready_watcher.clone();
        spawn_pty_pump(
            &session_id,
            reader,
            move |burst: &[u8]| match watcher_for_reader.lock().process(burst) {
                Processed::PassThrough => {
                    engine_for_reader.lock().feed(burst);
                    frame_hub_for_reader.notify();
                }
                Processed::Filtered(output) if !output.is_empty() => {
                    engine_for_reader.lock().feed(&output);
                    frame_hub_for_reader.notify();
                }
                Processed::Filtered(_) => {}
            },
        );

        let inner = Arc::new(Mutex::new(SessionInner {
            master,
            killer: Some(killer),
            exit_code: None,
            status: SessionStatus::Starting,
            closing: false,
        }));

        // Wait thread: block on the child so we can capture the exit code and
        // flip status.
        let inner_for_wait = inner.clone();
        let watcher_for_wait = ready_watcher.clone();
        let status_for_wait = status_sender.clone();
        let mut child_for_wait = child;
        thread::spawn(move || match child_for_wait.wait() {
            Ok(status) => {
                let code: i32 = status.exit_code().try_into().unwrap_or(0);
                let mut guard = inner_for_wait.lock();
                guard.exit_code = Some(code);
                guard.status = SessionStatus::Exited;
                let closing = guard.closing;
                drop(guard);
                if !closing {
                    watcher_for_wait.lock().process_exited(Some(code));
                    let _ = status_for_wait.send(TerminalStatusEvent {
                        status: SessionStatus::Exited,
                        exit_code: Some(code),
                    });
                }
            }
            Err(_) => {
                let mut guard = inner_for_wait.lock();
                guard.status = SessionStatus::Error;
                let closing = guard.closing;
                drop(guard);
                if !closing {
                    watcher_for_wait.lock().process_exited(None);
                    let _ = status_for_wait.send(TerminalStatusEvent {
                        status: SessionStatus::Error,
                        exit_code: None,
                    });
                }
            }
        });

        Ok(Self {
            session_id,
            project_id: spawn.project_id,
            profile_id: spawn.profile_id,
            workspace_id: spawn.workspace_id,
            window_id: spawn.window_id,
            created_at: chrono::Utc::now(),
            inner,
            writer: shared_writer,
            ready_watcher,
            status_sender,
            terminal_engine,
            frame_hub,
            attachments: Mutex::new(HashMap::new()),
            resize_serial: Mutex::new(()),
        })
    }

    /// Write user input bytes to the PTY. The bytes are forwarded as-is -
    /// we never parse or log input.
    pub fn write(&self, data: &[u8]) -> AppResult<()> {
        let mut writer = self.writer.lock();
        writer.write_all(data).map_err(AppError::Io)?;
        writer.flush().map_err(AppError::Io)?;
        Ok(())
    }

    pub fn key_down(&self, event: &TerminalKeyEvent) -> AppResult<()> {
        self.terminal_engine
            .lock()
            .key_down(event)
            .map_err(AppError::TerminalInputFailed)
    }

    pub fn text_input(&self, text: &str) -> AppResult<()> {
        self.terminal_engine
            .lock()
            .text_input(text)
            .map_err(AppError::TerminalInputFailed)
    }

    pub fn mouse_event(&self, event: &TerminalMouseEvent) -> AppResult<()> {
        self.terminal_engine
            .lock()
            .mouse_event(event)
            .map_err(AppError::TerminalInputFailed)
    }

    pub fn focus_changed(&self, focused: bool) {
        self.terminal_engine.lock().focus_changed(focused);
    }

    pub fn send_paste(&self, text: &str) -> AppResult<()> {
        self.terminal_engine
            .lock()
            .send_paste(text)
            .map_err(AppError::TerminalInputFailed)
    }

    pub fn bracketed_paste_enabled(&self) -> bool {
        self.terminal_engine.lock().bracketed_paste_enabled()
    }

    pub fn search(
        &self,
        query: &crate::terminal_engine::TerminalSearchQuery,
    ) -> Vec<crate::terminal_engine::TerminalSearchMatch> {
        self.terminal_engine.lock().search(query)
    }

    pub fn selection_text(
        &self,
        anchor: &crate::terminal_engine::TerminalSelectionPoint,
        focus: &crate::terminal_engine::TerminalSelectionPoint,
    ) -> String {
        self.terminal_engine.lock().selection_text(anchor, focus)
    }

    pub fn set_viewport_top(&self, stable_row: i64) {
        self.terminal_engine.lock().set_viewport_top(stable_row);
        self.frame_hub.notify();
    }

    /// Wait for a shell-generated marker line before injecting initialization
    /// commands. The marker output is consumed by the reader and never sent
    /// to the terminal model.
    pub fn wait_for_ready(&self, marker: &str, command: &str, timeout: Duration) -> AppResult<()> {
        let (sender, receiver) = mpsc::channel();
        {
            let mut watcher = self.ready_watcher.lock();
            if let Some(error) = watcher.exit_error.take() {
                return Err(AppError::EnvironmentInitializationFailed(error));
            }
            if watcher.marker.is_none() {
                watcher.marker = Some(marker.as_bytes().to_vec());
            }
            watcher.sender = Some(sender);
        }

        if let Err(error) = self.write(command.as_bytes()) {
            let mut watcher = self.ready_watcher.lock();
            watcher.marker = None;
            watcher.sender = None;
            watcher.pending.clear();
            return Err(error);
        }

        match receiver.recv_timeout(timeout) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(AppError::EnvironmentInitializationFailed(error)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let mut watcher = self.ready_watcher.lock();
                watcher.marker = None;
                watcher.sender = None;
                watcher.pending.clear();
                Err(AppError::EnvironmentInitializationFailed(
                    "Timed out waiting for the interactive shell".into(),
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(AppError::EnvironmentInitializationFailed(
                    "The interactive-shell readiness channel closed unexpectedly".into(),
                ))
            }
        }
    }

    pub fn mark_running(&self) {
        let mut guard = self.inner.lock();
        if guard.status == SessionStatus::Starting {
            guard.status = SessionStatus::Running;
        }
    }

    /// Resize the PTY. Clamps rows/cols to a sensible minimum.
    /// Resize the pty.
    ///
    /// `pixel_width`/`pixel_height` describe the grid in pixels and travel in
    /// the same `TIOCGWINSZ` structure as rows and columns. Image tools read
    /// them to size their output; `0` is the conventional "unknown".
    pub fn resize(
        &self,
        rows: u16,
        cols: u16,
        pixel_width: u16,
        pixel_height: u16,
    ) -> AppResult<()> {
        let rows = rows.max(1);
        let cols = cols.max(1);
        let requested_size = wezterm_term::TerminalSize {
            rows: rows as usize,
            cols: cols as usize,
            pixel_width: pixel_width as usize,
            pixel_height: pixel_height as usize,
            dpi: 96,
        };

        // Serialize the ConPTY resize with the model resize so concurrent
        // callers cannot interleave the two operations out of order. This
        // guard is held for the whole call, but - unlike before - never
        // together with `terminal_engine` across the blocking ConPTY syscall
        // below: the reader thread and every keystroke command take that
        // same engine lock, and a slow ConPTY resize (known to stall while
        // the console host repaints) must not block them.
        let _resize_guard = self.resize_serial.lock();

        if self.terminal_engine.lock().terminal().get_size() == requested_size {
            return Ok(());
        }

        self.inner
            .lock()
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width,
                pixel_height,
            })
            .map_err(|e| AppError::PtyCreationFailed(format!("resize: {e}")))?;

        self.terminal_engine.lock().resize(requested_size);
        self.frame_hub.notify();
        Ok(())
    }

    /// Attach a renderer without changing the PTY/session lifecycle. The
    /// first scheduled frame is always a full visible snapshot; subsequent
    /// frames contain only rows changed since the previous extraction.
    ///
    /// The status receiver is subscribed without taking a raw scrollback
    /// snapshot. Render clients reconstruct from the authoritative model and
    /// therefore never need to copy the legacy byte ring on attach.
    pub fn attach_renderer(
        &self,
        client_id: String,
    ) -> (
        TerminalFrameSubscription,
        broadcast::Receiver<TerminalStatusEvent>,
    ) {
        let mut subscription = self.frame_hub.subscribe();
        let status_receiver = self.status_sender.subscribe();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (paused_tx, paused_rx) = watch::channel(false);
        if let Some(previous) = self.attachments.lock().insert(
            client_id,
            RendererAttachment {
                cancel: cancel_tx,
                paused: paused_tx,
                is_paused: false,
            },
        ) {
            if !previous.is_paused {
                self.frame_hub.pause_frame_delivery();
            }
            let _ = previous.cancel.send(true);
        }
        subscription.cancellation = cancel_rx;
        subscription.paused = paused_rx;
        self.terminal_engine.lock().request_full_snapshot();
        self.frame_hub.notify();
        (subscription, status_receiver)
    }

    pub fn set_renderer_paused(&self, client_id: &str, paused: bool) -> AppResult<()> {
        let mut attachments = self.attachments.lock();
        let Some(attachment) = attachments.get_mut(client_id) else {
            return Err(AppError::Configuration(format!(
                "Renderer attachment was not found: {client_id}"
            )));
        };
        if attachment.is_paused == paused {
            return Ok(());
        }
        attachment.is_paused = paused;
        let _ = attachment.paused.send(paused);
        drop(attachments);
        if paused {
            self.frame_hub.pause_frame_delivery();
        } else {
            self.frame_hub.resume_frame_delivery();
            self.terminal_engine.lock().request_full_snapshot();
            self.frame_hub.notify();
        }
        Ok(())
    }

    /// Number of renderer frame subscribers currently attached to this
    /// session. This is intentionally diagnostic-only; PTY/model lifetime is
    /// independent from this count.
    pub fn renderer_count(&self) -> usize {
        self.frame_hub.renderer_count()
    }

    pub fn request_render_snapshot(&self) {
        self.terminal_engine.lock().request_full_snapshot();
        self.frame_hub.notify();
    }

    pub fn status(&self) -> SessionStatus {
        self.inner.lock().status
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.inner.lock().exit_code
    }

    pub fn detach(&self, client_id: &str) {
        if let Some(attachment) = self.attachments.lock().remove(client_id) {
            if !attachment.is_paused {
                self.frame_hub.pause_frame_delivery();
            }
            let _ = attachment.cancel.send(true);
        }
    }

    /// Close the session. Sends a kill to the child so it does not leak when
    /// the user closes the tab or quits the app.
    pub fn close(&self) {
        let mut guard = self.inner.lock();
        if guard.closing {
            return;
        }
        guard.closing = true;
        if let Some(killer) = guard.killer.as_mut() {
            let _ = killer.kill();
        }
        guard.status = SessionStatus::Exited;
        drop(guard);
        self.frame_hub.shutdown();
        for (_, attachment) in self.attachments.lock().drain() {
            if !attachment.is_paused {
                self.frame_hub.pause_frame_delivery();
            }
            let _ = attachment.cancel.send(true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    const TEST_SCROLLBACK_BYTES: usize = 4 * 1024 * 1024;

    fn make_session(program: &str, args: &[&str]) -> TerminalSession {
        let session = TerminalSession::spawn(SessionSpawn {
            session_id: "test-session".to_string(),
            project_id: "test-project".to_string(),
            profile_id: "test-profile".to_string(),
            workspace_id: None,
            window_id: None,
            program: program.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: None,
            env: vec![],
            env_remove: Vec::new(),
            readiness_marker: None,
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
            scrollback_bytes: TEST_SCROLLBACK_BYTES,
            scrollback_lines: None,
        })
        .expect("spawn session");
        session.mark_running();
        session
    }

    fn wait_for_model_text(session: &TerminalSession, query: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        let query = crate::terminal_engine::TerminalSearchQuery {
            query: query.into(),
            case_sensitive: true,
            direction: crate::terminal_engine::TerminalSearchDirection::Forward,
            start: None,
        };
        while Instant::now() < deadline {
            if !session.search(&query).is_empty() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    fn model_contains(session: &TerminalSession, query: &str) -> bool {
        let query = crate::terminal_engine::TerminalSearchQuery {
            query: query.into(),
            case_sensitive: true,
            direction: crate::terminal_engine::TerminalSearchDirection::Forward,
            start: None,
        };
        !session.search(&query).is_empty()
    }

    #[test]
    fn spawn_cmd_write_command_and_read_output() {
        // Â§37 Phase 3 acceptance: input/output normal. Spawn cmd.exe, write
        // `echo PT_TEST_OK`, read the echo back through the reader thread.
        let session = make_session("cmd.exe", &["/Q"]);

        session.write(b"echo PT_TEST_OK\r\n").expect("write");
        assert!(wait_for_model_text(&session, "PT_TEST_OK"));
        session.close();
    }

    #[test]
    fn process_exit_is_pushed_through_the_renderer_status_channel() {
        let session = make_session("cmd.exe", &["/C", "exit", "7"]);
        let (_subscription, mut status) = session.attach_renderer("status-client".into());
        let deadline = Instant::now() + Duration::from_secs(3);
        let event = loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "timed out waiting for exit status");
            match status.try_recv() {
                Ok(event) => break event,
                Err(broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(broadcast::error::TryRecvError::Lagged(_)) => {
                    panic!("renderer status channel unexpectedly lagged")
                }
                Err(broadcast::error::TryRecvError::Closed) => {
                    panic!("renderer status channel closed")
                }
            }
        };

        assert_eq!(event.status, SessionStatus::Exited);
        assert_eq!(event.exit_code, Some(7));
        session.close();
    }

    #[test]
    fn renderer_attachment_receives_model_frames_from_a_live_cmd_session() {
        let session = TerminalSession::spawn(SessionSpawn {
            session_id: "render-session".to_string(),
            project_id: "test-project".to_string(),
            profile_id: "test-profile".to_string(),
            workspace_id: None,
            window_id: None,
            program: "cmd.exe".to_string(),
            args: vec!["/Q".to_string()],
            cwd: None,
            env: vec![],
            env_remove: Vec::new(),
            readiness_marker: None,
            rows: 8,
            cols: 40,
            pixel_width: 0,
            pixel_height: 0,
            scrollback_bytes: TEST_SCROLLBACK_BYTES,
            scrollback_lines: None,
        })
        .expect("spawn session");
        let (mut subscription, _status) = session.attach_renderer("render-client".into());
        session.mark_running();

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut saw_full_snapshot = false;
        while Instant::now() < deadline {
            match subscription.frames.try_recv() {
                Ok(frame) => {
                    subscription.note_consumed();
                    if frame.full_snapshot {
                        saw_full_snapshot = true;
                        break;
                    }
                }
                Err(broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(broadcast::error::TryRecvError::Lagged(_)) => {
                    session.request_render_snapshot();
                }
                Err(broadcast::error::TryRecvError::Closed) => break,
            }
        }
        assert!(
            saw_full_snapshot,
            "renderer never received its initial frame"
        );

        session
            .send_paste("echo PT_RENDER_OK\r\n")
            .expect("send semantic paste");

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut saw_marker = false;
        while Instant::now() < deadline {
            match subscription.frames.try_recv() {
                Ok(frame) => {
                    subscription.note_consumed();
                    saw_marker |= frame.dirty_rows.iter().any(|row| {
                        let text = row
                            .cells
                            .iter()
                            .map(|cell| cell.text.as_str())
                            .collect::<String>();
                        text.contains("PT_RENDER_OK")
                    });
                    if saw_marker {
                        break;
                    }
                }
                Err(broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(broadcast::error::TryRecvError::Lagged(_)) => {
                    session.request_render_snapshot();
                }
                Err(broadcast::error::TryRecvError::Closed) => break,
            }
        }

        assert!(saw_marker, "renderer never received command output");
        let matches = session.search(&crate::terminal_engine::TerminalSearchQuery {
            query: "PT_RENDER_OK".into(),
            case_sensitive: true,
            direction: crate::terminal_engine::TerminalSearchDirection::Forward,
            start: None,
        });
        assert!(!matches.is_empty(), "model search missed command output");
        session.close();
    }

    #[test]
    fn renderer_status_subscription_skips_raw_output_and_reports_process_exit() {
        let session = TerminalSession::spawn(SessionSpawn {
            session_id: "render-status-session".to_string(),
            project_id: "test-project".to_string(),
            profile_id: "test-profile".to_string(),
            workspace_id: None,
            window_id: None,
            program: "cmd.exe".to_string(),
            args: vec!["/Q".to_string()],
            cwd: None,
            env: vec![],
            env_remove: Vec::new(),
            readiness_marker: None,
            rows: 8,
            cols: 40,
            pixel_width: 0,
            pixel_height: 0,
            scrollback_bytes: TEST_SCROLLBACK_BYTES,
            scrollback_lines: None,
        })
        .expect("spawn session");
        let (_subscription, mut status) = session.attach_renderer("status-client".into());
        session.mark_running();
        session.send_paste("exit 7\r\n").expect("send exit command");

        let deadline = Instant::now() + Duration::from_secs(3);
        let event = loop {
            assert!(Instant::now() < deadline, "timed out waiting for status");
            match status.try_recv() {
                Ok(event) => break event,
                Err(broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(broadcast::error::TryRecvError::Lagged(_)) => {
                    panic!("status-only renderer channel unexpectedly lagged")
                }
                Err(broadcast::error::TryRecvError::Closed) => {
                    panic!("status-only renderer channel closed")
                }
            }
        };

        assert_eq!(event.status, SessionStatus::Exited);
        assert_eq!(event.exit_code, Some(7));
        session.close();
    }

    #[test]
    fn detaching_renderer_keeps_the_rust_model_live_without_a_frame_subscriber() {
        let session = TerminalSession::spawn(SessionSpawn {
            session_id: "background-render-session".to_string(),
            project_id: "test-project".to_string(),
            profile_id: "test-profile".to_string(),
            workspace_id: None,
            window_id: None,
            program: "cmd.exe".to_string(),
            args: vec!["/Q".to_string()],
            cwd: None,
            env: vec![],
            env_remove: Vec::new(),
            readiness_marker: None,
            rows: 8,
            cols: 40,
            pixel_width: 0,
            pixel_height: 0,
            scrollback_bytes: TEST_SCROLLBACK_BYTES,
            scrollback_lines: None,
        })
        .expect("spawn session");
        session.mark_running();
        let (subscription, status) = session.attach_renderer("background-client".into());
        drop(subscription);
        drop(status);
        session.detach("background-client");
        assert_eq!(session.frame_hub.renderer_count(), 0);

        session
            .send_paste("echo PT_BACKGROUND_OK\r\n")
            .expect("send background paste");

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut matches = Vec::new();
        while Instant::now() < deadline {
            matches = session.search(&crate::terminal_engine::TerminalSearchQuery {
                query: "PT_BACKGROUND_OK".into(),
                case_sensitive: true,
                direction: crate::terminal_engine::TerminalSearchDirection::Forward,
                start: None,
            });
            if !matches.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        assert!(
            !matches.is_empty(),
            "background model stopped parsing output"
        );
        assert_eq!(session.status(), SessionStatus::Running);
        session.close();
    }

    #[test]
    fn ctrl_c_interrupts_long_running_command() {
        // Â§37 Phase 3 acceptance: Ctrl+C normal. Start `ping 127.0.0.1 -t`
        // (infinite), then send Ctrl+C (\x03) and verify the session is
        // still alive (status Running) - we should be back at the prompt,
        // not exited.
        let session = make_session("cmd.exe", &["/Q"]);

        session.write(b"ping 127.0.0.1 -t\r\n").expect("write ping");
        assert!(wait_for_model_text(&session, "Ping"), "ping did not start");
        // Send Ctrl+C.
        session
            .key_down(&TerminalKeyEvent {
                key: "c".into(),
                code: Some("KeyC".into()),
                location: 0,
                num_lock: false,
                shift: false,
                alt: false,
                ctrl: true,
                meta: false,
            })
            .expect("send ctrl+c through terminal input encoding");
        // Session should still be running (not exited) - Ctrl+C interrupts
        // the foreground command, not the shell.
        assert_eq!(
            session.status(),
            SessionStatus::Running,
            "session should survive Ctrl+C"
        );
        session.close();
    }

    #[test]
    fn resize_does_not_error() {
        // Â§37 Phase 3 acceptance: resize normal.
        let session = make_session("cmd.exe", &["/Q"]);
        // Resize up then down; both must succeed.
        session.resize(30, 120, 960, 660).expect("resize up");
        session.resize(30, 120, 960, 660).expect("duplicate resize");
        session.resize(10, 40, 320, 220).expect("resize down");
        let size = session.terminal_engine.lock().terminal().get_size();
        assert_eq!(size.rows, 10);
        assert_eq!(size.cols, 40);
        assert_eq!(session.status(), SessionStatus::Running);
        session.close();
    }

    #[test]
    fn close_marks_session_exited() {
        let session = make_session("cmd.exe", &["/Q"]);
        session.close();
        // close() sets status to Exited synchronously.
        assert_eq!(session.status(), SessionStatus::Exited);
    }

    #[test]
    fn close_is_idempotent() {
        let session = make_session("cmd.exe", &["/Q"]);
        session.close();
        session.close();
        assert_eq!(session.status(), SessionStatus::Exited);
    }

    #[test]
    fn ready_marker_survives_terminal_styling_around_output() {
        let marker = b"__PROJECT_TERMINAL_READY_test__";
        let output = b"\x1b[38;5;9m[__PROJECT_TERMINAL_READY_test__]\x1b[m\r\n";
        assert!(ready_output_contains_marker(output, marker));
    }

    #[test]
    fn ready_watcher_discards_protocol_output_across_split_marker() {
        let marker = b"abcdef";
        let (sender, receiver) = mpsc::channel();
        let mut watcher = ReadyWatcher {
            marker: Some(marker.to_vec()),
            sender: Some(sender),
            pending: Vec::new(),
            exit_error: None,
        };

        assert_eq!(
            watcher.process(b"echo [$env:PROJECT_TERMINAL_READY]\r\n\r\n[abcde"),
            Processed::Filtered(Vec::new())
        );
        assert_eq!(
            watcher.process(b"f]\r\nPS C:\\> "),
            Processed::Filtered(b"PS C:\\> ".to_vec())
        );
        let _ = receiver
            .recv_timeout(Duration::from_millis(10))
            .expect("split marker not detected");
    }

    #[test]
    fn ready_watcher_passes_output_through_once_the_handshake_is_done() {
        let mut watcher = ReadyWatcher {
            marker: None,
            sender: None,
            pending: Vec::new(),
            exit_error: None,
        };

        assert_eq!(watcher.process(b"regular output"), Processed::PassThrough);
    }

    #[test]
    fn ready_watcher_reports_early_process_exit_with_buffered_diagnostics() {
        let (sender, receiver) = mpsc::channel();
        let mut watcher = ReadyWatcher {
            marker: Some(b"__READY__".to_vec()),
            sender: Some(sender),
            pending: b"WSL: invalid working directory".to_vec(),
            exit_error: None,
        };

        watcher.process_exited(Some(1));

        let error = receiver
            .recv_timeout(Duration::from_millis(10))
            .expect("early exit was not reported")
            .expect_err("early exit must report an error");
        assert!(error.contains("exit code 1"));
        assert!(error.contains("invalid working directory"));
        assert_eq!(watcher.exit_error.as_deref(), Some(error.as_str()));
    }

    #[test]
    fn cmd_ready_handshake_filters_marker_and_marks_session_running() {
        let session = TerminalSession::spawn(SessionSpawn {
            session_id: "ready-session".to_string(),
            project_id: "test-project".to_string(),
            profile_id: "test-profile".to_string(),
            workspace_id: None,
            window_id: None,
            program: "cmd.exe".to_string(),
            args: vec!["/Q".to_string()],
            cwd: None,
            env: vec![],
            env_remove: Vec::new(),
            readiness_marker: None,
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
            scrollback_bytes: TEST_SCROLLBACK_BYTES,
            scrollback_lines: None,
        })
        .expect("spawn session");
        let marker = "__PROJECT_TERMINAL_READY_test__";
        let encoded_marker = marker
            .chars()
            .map(|character| format!("^{character}"))
            .collect::<String>();

        session
            .wait_for_ready(
                marker,
                &format!("echo [{encoded_marker}]\r\n"),
                Duration::from_secs(3),
            )
            .expect("shell becomes ready");
        session.mark_running();
        assert_eq!(session.status(), SessionStatus::Running);

        assert!(
            !model_contains(&session, marker),
            "ready marker leaked into terminal model"
        );
        assert!(
            !model_contains(&session, "$env:PROJECT_TERMINAL_READY"),
            "readiness command leaked into terminal model"
        );
        session.close();
    }

    #[test]
    fn powershell_ready_handshake_filters_marker_and_marks_session_running() {
        let session = TerminalSession::spawn(SessionSpawn {
            session_id: "powershell-ready-session".to_string(),
            project_id: "test-project".to_string(),
            profile_id: "test-profile".to_string(),
            workspace_id: None,
            window_id: None,
            program: "powershell.exe".to_string(),
            args: vec!["-NoLogo".to_string()],
            cwd: None,
            env: vec![(
                "PROJECT_TERMINAL_READY".to_string(),
                "__PROJECT_TERMINAL_READY_powershell__".to_string(),
            )],
            env_remove: Vec::new(),
            readiness_marker: None,
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
            scrollback_bytes: TEST_SCROLLBACK_BYTES,
            scrollback_lines: None,
        })
        .expect("spawn PowerShell session");
        let marker = "__PROJECT_TERMINAL_READY_powershell__";
        session
            .wait_for_ready(
                marker,
                "echo \"[$env:PROJECT_TERMINAL_READY]\"; Clear-Host\r",
                Duration::from_secs(5),
            )
            .expect("PowerShell becomes ready");
        session.mark_running();
        assert_eq!(session.status(), SessionStatus::Running);

        std::thread::sleep(Duration::from_millis(250));
        assert!(
            !model_contains(&session, ">>"),
            "PowerShell entered a continuation prompt"
        );
        assert!(
            !model_contains(&session, marker),
            "ready marker leaked into terminal model"
        );
        session.close();
    }

    /// ConPTY's CreateProcessW does no PATH search, so resolve node.exe here.
    /// `where.exe` is used rather than walking `PATH` because this test can be
    /// launched from a shell whose `PATH` is not in native Windows form.
    fn resolve_node_exe() -> String {
        let output = std::process::Command::new("where.exe")
            .arg("node.exe")
            .output()
            .expect("run where.exe");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let first = stdout
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .expect("node.exe not found by where.exe");
        first.to_string()
    }

    /// Diagnostic: trace the cursor position of every render frame produced by
    /// a REAL ConPTY session running an Ink-style TUI (hide cursor, repaint a
    /// status area, park the cursor on the input cell, show cursor).
    ///
    /// The invariant a user perceives as "the cursor does not jump" is: every
    /// frame whose cursor is VISIBLE must have it on the parked input cell.
    /// Any other visible position is a mid-repaint sample leaking to the
    /// renderer, which is exactly the reported symptom.
    fn trace_ink_style_cursor(wrap_in_dec2026: bool) -> Vec<(u16, i32, bool, usize)> {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("ink_tui.js");
        // Row 3 / column 13 in 1-based VT terms == row 2 / column 12 0-based.
        let body = if wrap_in_dec2026 {
            r#"const F=['-','+','*','x'];let i=0;
const t=setInterval(()=>{let o='\x1b[?2026h\x1b[?25l\x1b[H';
o+=F[i%4]+' working...\x1b[K\r\n';o+='status line\x1b[K\r\n';o+='> typed text\x1b[K';
o+='\x1b[3;13H\x1b[?25h\x1b[?2026l';process.stdout.write(o);
if(++i>80){clearInterval(t);process.stdout.write('\r\n__TRACE_DONE__\r\n');}},12);"#
        } else {
            r#"const F=['-','+','*','x'];let i=0;
const t=setInterval(()=>{let o='\x1b[?25l\x1b[H';
o+=F[i%4]+' working...\x1b[K\r\n';o+='status line\x1b[K\r\n';o+='> typed text\x1b[K';
o+='\x1b[3;13H\x1b[?25h';process.stdout.write(o);
if(++i>80){clearInterval(t);process.stdout.write('\r\n__TRACE_DONE__\r\n');}},12);"#
        };
        std::fs::write(&script, body).expect("write script");

        let session = TerminalSession::spawn(SessionSpawn {
            session_id: "cursor-trace".to_string(),
            project_id: "test-project".to_string(),
            profile_id: "test-profile".to_string(),
            workspace_id: None,
            window_id: None,
            program: resolve_node_exe(),
            args: vec![script.to_string_lossy().to_string()],
            cwd: None,
            env: vec![],
            env_remove: Vec::new(),
            readiness_marker: None,
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
            scrollback_bytes: TEST_SCROLLBACK_BYTES,
            scrollback_lines: None,
        })
        .expect("spawn node session");
        let (mut subscription, _status) = session.attach_renderer("trace-client".into());
        session.mark_running();

        let mut trace = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(12);
        while Instant::now() < deadline {
            match subscription.frames.try_recv() {
                Ok(frame) => {
                    subscription.note_consumed();
                    trace.push((
                        frame.cursor.column,
                        frame.cursor.row,
                        matches!(
                            frame.cursor.visibility,
                            crate::terminal_engine::CursorVisibility::Visible
                        ),
                        frame.dirty_rows.len(),
                    ));
                }
                Err(broadcast::error::TryRecvError::Empty) => {
                    if model_contains(&session, "__TRACE_DONE__") {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(broadcast::error::TryRecvError::Lagged(_)) => {
                    session.request_render_snapshot();
                }
                Err(broadcast::error::TryRecvError::Closed) => break,
            }
        }
        session.close();
        trace
    }

    fn report_trace(label: &str, trace: &[(u16, i32, bool, usize)]) -> usize {
        let visible: Vec<_> = trace.iter().filter(|entry| entry.2).collect();
        let stray: Vec<_> = visible
            .iter()
            .filter(|entry| !(entry.0 == 12 && entry.1 == 2))
            .collect();
        println!("=== {label} ===");
        println!(
            "frames={} visible={} stray={}",
            trace.len(),
            visible.len(),
            stray.len()
        );
        let mut histogram: std::collections::BTreeMap<(u16, i32), usize> =
            std::collections::BTreeMap::new();
        for entry in &visible {
            *histogram.entry((entry.0, entry.1)).or_default() += 1;
        }
        for ((column, row), count) in histogram {
            let tag = if column == 12 && row == 2 {
                "parked"
            } else {
                "STRAY"
            };
            println!("  col={column:<3} row={row:<3} count={count:<4} {tag}");
        }
        println!(
            "  first 40 frames: {:?}",
            trace.iter().take(40).collect::<Vec<_>>()
        );
        stray.len()
    }

    /// End-to-end guard over a real ConPTY session: an Ink-style TUI that
    /// repaints without DECSET 2026 must never expose a mid-repaint cursor.
    /// The only frame allowed to sit elsewhere is the initial snapshot taken
    /// before the app has painted anything.
    #[test]
    fn an_ink_style_repaint_never_exposes_a_mid_repaint_cursor() {
        let trace = trace_ink_style_cursor(false);
        assert!(!trace.is_empty(), "no frames captured");
        let stray = report_trace("no DEC 2026 (Ink-style)", &trace);
        assert!(
            stray <= 1,
            "cursor left the parked input cell in {stray} frames"
        );
        let parked = trace
            .iter()
            .filter(|entry| entry.2 && entry.0 == 12 && entry.1 == 2)
            .count();
        assert!(parked > 5, "expected a steady parked cursor, saw {parked}");
    }

    #[test]
    #[ignore = "diagnostic; run with cargo test -- --ignored --nocapture"]
    fn trace_cursor_jitter_with_synchronized_output() {
        let trace = trace_ink_style_cursor(true);
        assert!(!trace.is_empty(), "no frames captured");
        let stray = report_trace("with DEC 2026", &trace);
        println!("stray-visible-cursor frames: {stray}");
    }

    /// Diagnostic: a TUI that streams scrolling output while keeping an input
    /// cursor parked on the last row - the Claude-Code-CLI shape. Records the
    /// cursor together with the viewport so an incoherent
    /// (cursor.row, viewport_top) pair is visible.
    #[test]
    #[ignore = "diagnostic; run with cargo test -- --ignored --nocapture"]
    fn trace_cursor_while_output_scrolls() {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("scroll_tui.js");
        std::fs::write(
            &script,
            r#"let i=0;
const t=setInterval(()=>{let o='\x1b[?25l';
o+='output line '+i+'\x1b[K\r\n';o+='> typed text\x1b[K';
o+='\r\x1b[12C\x1b[?25h';process.stdout.write(o);
if(++i>60){clearInterval(t);process.stdout.write('\r\n__TRACE_DONE__\r\n');}},12);"#,
        )
        .expect("write script");

        let session = TerminalSession::spawn(SessionSpawn {
            session_id: "scroll-trace".to_string(),
            project_id: "test-project".to_string(),
            profile_id: "test-profile".to_string(),
            workspace_id: None,
            window_id: None,
            program: resolve_node_exe(),
            args: vec![script.to_string_lossy().to_string()],
            cwd: None,
            env: vec![],
            env_remove: Vec::new(),
            readiness_marker: None,
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
            scrollback_bytes: TEST_SCROLLBACK_BYTES,
            scrollback_lines: None,
        })
        .expect("spawn node session");
        let (mut subscription, _status) = session.attach_renderer("scroll-client".into());
        session.mark_running();

        let mut rows = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(12);
        while Instant::now() < deadline {
            match subscription.frames.try_recv() {
                Ok(frame) => {
                    subscription.note_consumed();
                    rows.push((
                        frame.cursor.column,
                        frame.cursor.row,
                        frame.viewport_top,
                        frame.viewport_bottom,
                        matches!(
                            frame.cursor.visibility,
                            crate::terminal_engine::CursorVisibility::Visible
                        ),
                        frame.dirty_rows.len(),
                        frame.full_snapshot,
                    ));
                }
                Err(broadcast::error::TryRecvError::Empty) => {
                    if model_contains(&session, "__TRACE_DONE__") {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(broadcast::error::TryRecvError::Lagged(_)) => {
                    session.request_render_snapshot();
                }
                Err(broadcast::error::TryRecvError::Closed) => break,
            }
        }
        session.close();

        println!("=== scrolling output, cursor parked at column 12 ===");
        println!("frames={}", rows.len());
        let mut stray = 0;
        for (index, entry) in rows.iter().enumerate() {
            let (column, row, top, bottom, visible, dirty, full) = *entry;
            let bad = visible && column != 12;
            if bad {
                stray += 1;
            }
            if index < 30 || bad {
                println!(
                    "  #{index:<3} col={column:<3} row={row:<3} top={top:<5} bottom={bottom:<5} vis={visible} dirty={dirty:<3} full={full} {}",
                    if bad { "STRAY" } else { "" }
                );
            }
        }
        println!("stray-column frames: {stray}");
    }

    /// Diagnostic: type into a real PowerShell/PSReadLine prompt one key at a
    /// time and trace where the cursor lands per frame. This is the literal
    /// "the input cursor jumps around while typing" report.
    /// End-to-end guard for the reported symptom: typing at a real shell
    /// prompt must not make the cursor blink out. PSReadLine brackets each
    /// redraw with DECTCEM off/on and ConPTY splits that across reads, so
    /// without the hide grace window every keystroke published a hidden-cursor
    /// frame and the cursor strobed as the user typed.
    #[test]
    fn typing_at_a_shell_prompt_never_publishes_a_hidden_cursor() {
        let session = TerminalSession::spawn(SessionSpawn {
            session_id: "typing-trace".to_string(),
            project_id: "test-project".to_string(),
            profile_id: "test-profile".to_string(),
            workspace_id: None,
            window_id: None,
            program: "powershell.exe".to_string(),
            args: vec!["-NoLogo".to_string(), "-NoProfile".to_string()],
            cwd: None,
            env: vec![],
            env_remove: Vec::new(),
            readiness_marker: None,
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
            scrollback_bytes: TEST_SCROLLBACK_BYTES,
            scrollback_lines: None,
        })
        .expect("spawn powershell");
        let (mut subscription, _status) = session.attach_renderer("typing-client".into());
        session.mark_running();
        std::thread::sleep(Duration::from_millis(1500));
        while subscription.frames.try_recv().is_ok() {
            subscription.note_consumed();
        }

        let mut rows = Vec::new();
        for byte in b"Write-Output HELLO" {
            session.write(&[*byte]).expect("write key");
            let settle = Instant::now() + Duration::from_millis(120);
            while Instant::now() < settle {
                match subscription.frames.try_recv() {
                    Ok(frame) => {
                        subscription.note_consumed();
                        rows.push((
                            *byte as char,
                            frame.cursor.column,
                            frame.cursor.row,
                            matches!(
                                frame.cursor.visibility,
                                crate::terminal_engine::CursorVisibility::Visible
                            ),
                            frame.dirty_rows.len(),
                        ));
                    }
                    Err(broadcast::error::TryRecvError::Empty) => {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
        }
        session.close();

        println!("=== typing at a PowerShell prompt ===");
        println!("frames={}", rows.len());
        let mut previous_column: Option<u16> = None;
        let mut regressions = 0;
        for (index, entry) in rows.iter().enumerate() {
            let (key, column, row, visible, dirty) = *entry;
            let regressed = visible && previous_column.is_some_and(|previous| column < previous);
            if regressed {
                regressions += 1;
            }
            if visible {
                previous_column = Some(column);
            }
            println!(
                "  #{index:<3} key='{key}' col={column:<3} row={row:<3} vis={visible} dirty={dirty:<3} {}",
                if regressed { "REGRESSED" } else { "" }
            );
        }
        println!("column regressions while typing: {regressions}");

        assert!(!rows.is_empty(), "no frames captured while typing");
        assert_eq!(
            regressions, 0,
            "the cursor moved backwards while typing forwards"
        );
        let hidden = rows.iter().filter(|entry| !entry.3).count();
        assert_eq!(
            hidden, 0,
            "{hidden} frames hid the cursor mid-keystroke, which reads as a \
             strobing cursor while typing"
        );
    }
}
