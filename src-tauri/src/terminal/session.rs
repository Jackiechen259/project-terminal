//! Terminal session: owns one PTY plus a reader thread, bounded scrollback,
//! and a broadcast event stream.
//!
//! Phase 3 supports local shells only. SSH (`ssh.exe`) sessions arrive in
//! Phase 6. The session intentionally has no knowledge of profiles or
//! projects - the manager constructs it from resolved config.

use std::collections::HashMap;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use bytes::Bytes;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{broadcast, watch};

use crate::error::{AppError, AppResult};

use super::scrollback::{OutputRingBuffer, ScrollbackSnapshot, DEFAULT_SCROLLBACK_BYTES};

/// A terminal lifecycle event sent to the frontend.
///
/// Output bytes are base64 encoded because terminal output is not guaranteed
/// to be valid UTF-8. Exit state travels over the same channel so the frontend
/// does not need to poll every live session.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub session_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub data: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<SessionStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

impl TerminalOutput {
    fn output(session_id: String, data: String) -> Self {
        Self {
            session_id,
            data,
            status: None,
            exit_code: None,
        }
    }

    fn status(session_id: String, status: SessionStatus, exit_code: Option<i32>) -> Self {
        Self {
            session_id,
            data: String::new(),
            status: Some(status),
            exit_code,
        }
    }
}

/// What to spawn inside the PTY.
#[derive(Debug, Clone)]
pub struct SessionSpawn {
    pub session_id: String,
    pub project_id: String,
    pub profile_id: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    /// When present, hold startup output until this readiness marker arrives.
    pub readiness_marker: Option<String>,
    pub rows: u16,
    pub cols: u16,
}

struct EventHub {
    sender: broadcast::Sender<TerminalOutput>,
    scrollback: OutputRingBuffer,
}

pub struct SessionSubscription {
    pub receiver: broadcast::Receiver<TerminalOutput>,
    pub snapshot: ScrollbackSnapshot,
    pub cancellation: watch::Receiver<bool>,
}

/// Lifecycle state of a session. Mirrors the frontend's TerminalStatus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionStatus {
    Starting,
    Running,
    Exited,
    Error,
}

struct SessionInner {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn std::io::Write + Send>,
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    exit_code: Option<i32>,
    status: SessionStatus,
    closing: bool,
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

impl ReadyWatcher {
    fn process(&mut self, bytes: &[u8]) -> Vec<u8> {
        let Some(marker) = self.marker.as_deref() else {
            return bytes.to_vec();
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
            return output;
        }

        // Keep every byte until the handshake completes. Shells echo the
        // injected command, and forwarding partial output would expose that
        // protocol text above the actual terminal prompt.
        Vec::new()
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
    pub created_at: chrono::DateTime<chrono::Utc>,
    inner: Arc<Mutex<SessionInner>>,
    ready_watcher: Arc<Mutex<ReadyWatcher>>,
    event_hub: Arc<Mutex<EventHub>>,
    attachments: Mutex<HashMap<String, watch::Sender<bool>>>,
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
    /// Spawn a PTY and start an always-on reader thread. Output is retained
    /// even when no frontend is attached.
    pub fn spawn(spawn: SessionSpawn) -> AppResult<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: spawn.rows,
                cols: spawn.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::PtyCreationFailed(e.to_string()))?;

        // Build the command from the resolved spawn config.
        let mut cmd = CommandBuilder::new(&spawn.program);
        cmd.args(&spawn.args);
        if let Some(cwd) = &spawn.cwd {
            cmd.cwd(cwd);
        }
        for (k, v) in &spawn.env {
            cmd.env(k, v);
        }
        // Always set TERM so shells render colors correctly.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
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
        let (event_tx, _) = broadcast::channel(1024);
        let event_hub = Arc::new(Mutex::new(EventHub {
            sender: event_tx,
            scrollback: OutputRingBuffer::new(DEFAULT_SCROLLBACK_BYTES),
        }));

        // Reader thread: scans for the one-shot ready marker, removes that
        // protocol line, retains every other byte sequence, and broadcasts it.
        // A missing or slow subscriber never blocks this loop.
        let hub_for_reader = Arc::clone(&event_hub);
        let sid_for_reader = session_id.clone();
        let watcher_for_reader = ready_watcher.clone();
        thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let output = watcher_for_reader.lock().process(&buf[..n]);
                        if !output.is_empty() {
                            let mut hub = hub_for_reader.lock();
                            hub.scrollback.push(Bytes::copy_from_slice(&output));
                            let _ = hub.sender.send(TerminalOutput::output(
                                sid_for_reader.clone(),
                                encode_bytes(&output),
                            ));
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        continue;
                    }
                    Err(_) => break,
                }
            }
        });

        let inner = Arc::new(Mutex::new(SessionInner {
            master,
            writer,
            killer: Some(killer),
            exit_code: None,
            status: SessionStatus::Starting,
            closing: false,
        }));

        // Wait thread: block on the child so we can capture the exit code and
        // flip status.
        let inner_for_wait = inner.clone();
        let watcher_for_wait = ready_watcher.clone();
        let hub_for_wait = Arc::clone(&event_hub);
        let sid_for_wait = session_id.clone();
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
                    let _ = hub_for_wait.lock().sender.send(TerminalOutput::status(
                        sid_for_wait,
                        SessionStatus::Exited,
                        Some(code),
                    ));
                }
            }
            Err(_) => {
                let mut guard = inner_for_wait.lock();
                guard.status = SessionStatus::Error;
                let closing = guard.closing;
                drop(guard);
                if !closing {
                    watcher_for_wait.lock().process_exited(None);
                    let _ = hub_for_wait.lock().sender.send(TerminalOutput::status(
                        sid_for_wait,
                        SessionStatus::Error,
                        None,
                    ));
                }
            }
        });

        Ok(Self {
            session_id,
            project_id: spawn.project_id,
            profile_id: spawn.profile_id,
            created_at: chrono::Utc::now(),
            inner,
            ready_watcher,
            event_hub,
            attachments: Mutex::new(HashMap::new()),
        })
    }

    /// Write user input bytes to the PTY. The bytes are forwarded as-is -
    /// we never parse or log input.
    pub fn write(&self, data: &[u8]) -> AppResult<()> {
        let mut guard = self.inner.lock();
        guard.writer.write_all(data).map_err(AppError::Io)?;
        guard.writer.flush().map_err(AppError::Io)?;
        Ok(())
    }

    /// Wait for a shell-generated marker line before injecting initialization
    /// commands. The marker output is consumed by the reader and never sent
    /// to xterm.
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
    pub fn resize(&self, rows: u16, cols: u16) -> AppResult<()> {
        let rows = rows.max(1);
        let cols = cols.max(1);
        let guard = self.inner.lock();
        guard
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::PtyCreationFailed(format!("resize: {e}")))?;
        Ok(())
    }

    pub fn status(&self) -> SessionStatus {
        self.inner.lock().status
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.inner.lock().exit_code
    }

    /// Atomically subscribe before taking the scrollback snapshot. The reader
    /// uses the same hub lock, so bytes can be in exactly one of the snapshot
    /// or subsequent events, never lost between them.
    pub fn attach(&self, client_id: String) -> SessionSubscription {
        let (receiver, snapshot) = {
            let hub = self.event_hub.lock();
            (hub.sender.subscribe(), hub.scrollback.snapshot())
        };
        let (cancel_tx, cancel_rx) = watch::channel(false);
        if let Some(previous) = self.attachments.lock().insert(client_id, cancel_tx) {
            let _ = previous.send(true);
        }
        SessionSubscription {
            receiver,
            snapshot,
            cancellation: cancel_rx,
        }
    }

    pub fn detach(&self, client_id: &str) {
        if let Some(cancellation) = self.attachments.lock().remove(client_id) {
            let _ = cancellation.send(true);
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
        for (_, cancellation) in self.attachments.lock().drain() {
            let _ = cancellation.send(true);
        }
    }
}

fn encode_bytes(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// Decode base64 back to bytes for assertions.
    fn decode(b64: &str) -> Vec<u8> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap_or_default()
    }

    /// Collect all output chunks delivered before the deadline, concatenated.
    fn drain_output(rx: &mut broadcast::Receiver<TerminalOutput>, deadline: Instant) -> Vec<u8> {
        let mut out = Vec::new();
        while Instant::now() < deadline {
            match rx.try_recv() {
                Ok(chunk) => out.extend_from_slice(&decode(&chunk.data)),
                Err(broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(broadcast::error::TryRecvError::Closed) => break,
                Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
            }
        }
        out
    }

    fn make_session(
        program: &str,
        args: &[&str],
    ) -> (TerminalSession, broadcast::Receiver<TerminalOutput>) {
        let session = TerminalSession::spawn(SessionSpawn {
            session_id: "test-session".to_string(),
            project_id: "test-project".to_string(),
            profile_id: "test-profile".to_string(),
            program: program.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: None,
            env: vec![],
            readiness_marker: None,
            rows: 24,
            cols: 80,
        })
        .expect("spawn session");
        let rx = session.attach("test-client".into()).receiver;
        session.mark_running();
        (session, rx)
    }

    #[test]
    fn spawn_cmd_write_command_and_read_output() {
        // §37 Phase 3 acceptance: input/output normal. Spawn cmd.exe, write
        // `echo PT_TEST_OK`, read the echo back through the reader thread.
        let (session, mut rx) = make_session("cmd.exe", &["/Q"]);
        // Drain the initial prompt.
        let _ = drain_output(&mut rx, Instant::now() + Duration::from_millis(500));

        session.write(b"echo PT_TEST_OK\r\n").expect("write");
        let output = drain_output(&mut rx, Instant::now() + Duration::from_secs(3));

        assert!(
            output
                .windows(b"PT_TEST_OK".len())
                .any(|w| w == b"PT_TEST_OK"),
            "expected PT_TEST_OK in output, got: {:?}",
            String::from_utf8_lossy(&output)
        );
        session.close();
    }

    #[test]
    fn process_exit_is_pushed_through_the_output_channel() {
        let (_session, mut rx) = make_session("cmd.exe", &["/C", "exit", "7"]);
        let deadline = Instant::now() + Duration::from_secs(3);
        let status = loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "timed out waiting for exit status");
            match rx.try_recv() {
                Ok(event) if event.status.is_some() => break event,
                Ok(_) | Err(broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("receive terminal event: {error}"),
            }
        };

        assert_eq!(status.status, Some(SessionStatus::Exited));
        assert_eq!(status.exit_code, Some(7));
        assert!(status.data.is_empty());
    }

    #[test]
    fn ctrl_c_interrupts_long_running_command() {
        // §37 Phase 3 acceptance: Ctrl+C normal. Start `ping 127.0.0.1 -t`
        // (infinite), then send Ctrl+C (\x03) and verify the session is
        // still alive (status Running) - we should be back at the prompt,
        // not exited.
        let (session, mut rx) = make_session("cmd.exe", &["/Q"]);
        let _ = drain_output(&mut rx, Instant::now() + Duration::from_millis(500));

        session.write(b"ping 127.0.0.1 -t\r\n").expect("write ping");
        // Give it time to start pinging.
        std::thread::sleep(Duration::from_millis(400));
        // Send Ctrl+C.
        session.write(b"\x03").expect("write ctrl+c");
        let output = drain_output(&mut rx, Instant::now() + Duration::from_secs(2));

        assert!(
            !output.is_empty(),
            "expected output after Ctrl+C, got nothing"
        );
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
        // §37 Phase 3 acceptance: resize normal.
        let (session, _rx) = make_session("cmd.exe", &["/Q"]);
        // Resize up then down; both must succeed.
        session.resize(30, 120).expect("resize up");
        session.resize(10, 40).expect("resize down");
        assert_eq!(session.status(), SessionStatus::Running);
        session.close();
    }

    #[test]
    fn close_marks_session_exited() {
        let (session, _rx) = make_session("cmd.exe", &["/Q"]);
        session.close();
        // close() sets status to Exited synchronously.
        assert_eq!(session.status(), SessionStatus::Exited);
    }

    #[test]
    fn close_is_idempotent() {
        let (session, _rx) = make_session("cmd.exe", &["/Q"]);
        session.close();
        session.close();
        assert_eq!(session.status(), SessionStatus::Exited);
    }

    #[test]
    fn encode_bytes_handles_empty_and_padded_lengths() {
        assert_eq!(encode_bytes(b""), "");
        assert_eq!(encode_bytes(b"A"), "QQ==");
        assert_eq!(encode_bytes(b"AB"), "QUI=");
        assert_eq!(encode_bytes(b"ABC"), "QUJD");
        assert_eq!(encode_bytes(&[0x00, 0xFF, 0x80, 0x7F]), "AP+Afw==");
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

        assert!(watcher
            .process(b"echo [$env:PROJECT_TERMINAL_READY]\r\n\r\n[abcde")
            .is_empty());
        assert_eq!(watcher.process(b"f]\r\nPS C:\\> "), b"PS C:\\> ");
        let _ = receiver
            .recv_timeout(Duration::from_millis(10))
            .expect("split marker not detected");
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
            program: "cmd.exe".to_string(),
            args: vec!["/Q".to_string()],
            cwd: None,
            env: vec![],
            readiness_marker: None,
            rows: 24,
            cols: 80,
        })
        .expect("spawn session");
        let mut rx = session.attach("ready-client".into()).receiver;
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

        let output = drain_output(&mut rx, Instant::now() + Duration::from_millis(250));
        assert!(
            !output
                .windows(marker.len())
                .any(|window| window == marker.as_bytes()),
            "ready marker leaked into terminal output: {:?}",
            String::from_utf8_lossy(&output)
        );
        assert!(
            !String::from_utf8_lossy(&output).contains("$env:PROJECT_TERMINAL_READY"),
            "readiness command leaked into terminal output: {:?}",
            String::from_utf8_lossy(&output)
        );
        session.close();
    }
    #[test]
    fn powershell_ready_handshake_filters_marker_and_marks_session_running() {
        let session = TerminalSession::spawn(SessionSpawn {
            session_id: "powershell-ready-session".to_string(),
            project_id: "test-project".to_string(),
            profile_id: "test-profile".to_string(),
            program: "powershell.exe".to_string(),
            args: vec!["-NoLogo".to_string()],
            cwd: None,
            env: vec![(
                "PROJECT_TERMINAL_READY".to_string(),
                "__PROJECT_TERMINAL_READY_powershell__".to_string(),
            )],
            readiness_marker: None,
            rows: 24,
            cols: 80,
        })
        .expect("spawn PowerShell session");
        let mut rx = session.attach("powershell-ready-client".into()).receiver;
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

        let output = drain_output(&mut rx, Instant::now() + Duration::from_millis(250));
        assert!(
            !output.windows(4).any(|window| window == b"\r\n>>"),
            "PowerShell entered a continuation prompt: {:?}",
            String::from_utf8_lossy(&output)
        );
        assert!(
            !output
                .windows(marker.len())
                .any(|window| window == marker.as_bytes()),
            "ready marker leaked into terminal output: {:?}",
            String::from_utf8_lossy(&output)
        );
        session.close();
    }
}
