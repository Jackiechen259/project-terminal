//! Terminal session: owns one PTY plus a reader thread that forwards output
//! bytes to an `OutputSink`. The sink is abstracted so the session is testable
//! without a Tauri runtime - the production path uses a Tauri Channel, tests
//! use an mpsc-backed sink.
//!
//! Phase 3 supports local shells only. SSH (`ssh.exe`) sessions arrive in
//! Phase 6. The session intentionally has no knowledge of profiles or
//! projects - the manager constructs it from resolved config.

use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;

use crate::error::{AppError, AppResult};

/// A chunk of bytes sent from the PTY reader to the frontend.
///
/// Serialized as `{ sessionId, data }` so the frontend can route output by
/// session id. `data` is base64-encoded bytes (terminal output is not
/// guaranteed to be valid UTF-8).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub session_id: String,
    pub data: String,
}

/// Abstract output sink. Production wires `tauri::ipc::Channel`; tests wire
/// an mpsc sender so the reader thread's bytes can be inspected without a
/// runtime.
pub trait OutputSink: Send + 'static {
    /// Send one chunk. Returns `false` when the sink is closed (frontend
    /// window closed) so the reader thread can stop.
    fn send_output(&self, output: TerminalOutput) -> bool;
}

impl OutputSink for Channel<TerminalOutput> {
    fn send_output(&self, output: TerminalOutput) -> bool {
        self.send(output).is_ok()
    }
}

/// What to spawn inside the PTY.
#[derive(Debug, Clone)]
pub struct SessionSpawn {
    pub session_id: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub rows: u16,
    pub cols: u16,
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

fn ready_output_contains_marker(output: &[u8], marker: &[u8]) -> bool {
    let mut normalized = Vec::with_capacity(output.len());
    let mut index = 0;
    while index < output.len() {
        if output[index] == 0x1b && output.get(index + 1) == Some(&b'[') {
            index += 2;
            while index < output.len() {
                let byte = output[index];
                index += 1;
                if (0x40..=0x7e).contains(&byte) {
                    break;
                }
            }
        } else {
            normalized.push(output[index]);
            index += 1;
        }
    }

    let mut framed = Vec::with_capacity(marker.len() + 2);
    framed.push(b'\n');
    framed.push(b'[');
    framed.extend_from_slice(marker);
    find_subslice(&normalized, &framed).is_some()
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

struct ReadyWatcher {
    marker: Option<Vec<u8>>,
    sender: Option<mpsc::Sender<()>>,
    pending: Vec<u8>,
}

impl ReadyWatcher {
    fn process(&mut self, bytes: &[u8]) -> Vec<u8> {
        let Some(marker) = self.marker.as_deref() else {
            return bytes.to_vec();
        };

        self.pending.extend_from_slice(bytes);
        if ready_output_contains_marker(&self.pending, marker) {
            let position = find_subslice(&self.pending, marker)
                .expect("framed marker must include the raw marker");
            let start = if position > 0 && self.pending[position - 1] == b'[' {
                position - 1
            } else {
                position
            };
            let mut end = position + marker.len();
            if self.pending.get(end) == Some(&b']') {
                end += 1;
            }
            let mut output = self.pending[..start].to_vec();
            output.extend_from_slice(&self.pending[end..]);
            if let Some(sender) = self.sender.take() {
                let _ = sender.send(());
            }
            self.marker = None;
            self.pending.clear();
            return output;
        }

        // Delay a bounded suffix so a marker split between PTY reads never
        // reaches xterm. Everything before that suffix is ordinary output.
        let keep = marker.len() + 1;
        if self.pending.len() > keep {
            return self.pending.drain(..self.pending.len() - keep).collect();
        }
        Vec::new()
    }
}

pub struct TerminalSession {
    pub session_id: String,
    inner: Arc<Mutex<SessionInner>>,
    ready_watcher: Arc<Mutex<ReadyWatcher>>,
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
    /// Spawn a local PTY, start a reader thread that forwards output to the
    /// sink, and return a handle the manager can store.
    pub fn spawn(spawn: SessionSpawn, sink: Box<dyn OutputSink>) -> AppResult<Self> {
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
            marker: None,
            sender: None,
            pending: Vec::new(),
        }));
        let session_id = spawn.session_id.clone();

        // Reader thread: scans for the one-shot ready marker, removes that
        // protocol line, and forwards every other byte sequence to xterm.
        let ch_for_reader = sink;
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
                        if !output.is_empty()
                            && !ch_for_reader.send_output(TerminalOutput {
                                session_id: sid_for_reader.clone(),
                                data: encode_bytes(&output),
                            })
                        {
                            // Sink closed (frontend window closed). Stop
                            // reading - the manager will tear the session
                            // down separately.
                            break;
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
        let mut child_for_wait = child;
        thread::spawn(move || match child_for_wait.wait() {
            Ok(status) => {
                let code: i32 = status.exit_code().try_into().unwrap_or(0);
                let mut guard = inner_for_wait.lock();
                guard.exit_code = Some(code);
                guard.status = SessionStatus::Exited;
            }
            Err(_) => {
                let mut guard = inner_for_wait.lock();
                guard.status = SessionStatus::Error;
            }
        });

        Ok(Self {
            session_id,
            inner,
            ready_watcher,
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
            watcher.marker = Some(marker.as_bytes().to_vec());
            watcher.sender = Some(sender);
            watcher.pending.clear();
        }

        if let Err(error) = self.write(command.as_bytes()) {
            let mut watcher = self.ready_watcher.lock();
            watcher.marker = None;
            watcher.sender = None;
            watcher.pending.clear();
            return Err(error);
        }

        receiver.recv_timeout(timeout).map_err(|_| {
            let mut watcher = self.ready_watcher.lock();
            watcher.marker = None;
            watcher.sender = None;
            watcher.pending.clear();
            AppError::EnvironmentInitializationFailed(
                "Timed out waiting for the interactive shell".into(),
            )
        })
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

    #[allow(dead_code)]
    pub fn exit_code(&self) -> Option<i32> {
        self.inner.lock().exit_code
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

    /// Test sink that forwards TerminalOutput chunks to an mpsc receiver so
    /// tests can inspect bytes without a Tauri runtime.
    struct MpscSink(mpsc::Sender<TerminalOutput>);
    impl OutputSink for MpscSink {
        fn send_output(&self, output: TerminalOutput) -> bool {
            self.0.send(output).is_ok()
        }
    }

    /// Decode base64 back to bytes for assertions.
    fn decode(b64: &str) -> Vec<u8> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap_or_default()
    }

    /// Collect all output chunks delivered before the deadline, concatenated.
    fn drain_output(rx: &mpsc::Receiver<TerminalOutput>, deadline: Instant) -> Vec<u8> {
        let mut out = Vec::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(chunk) => out.extend_from_slice(&decode(&chunk.data)),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !out.is_empty() {
                        // Got something; if we time out again the shell is
                        // idle. Keep going until the deadline so subsequent
                        // writes can be observed.
                        continue;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        out
    }

    fn make_session(
        program: &str,
        args: &[&str],
    ) -> (TerminalSession, mpsc::Receiver<TerminalOutput>) {
        let (tx, rx) = mpsc::channel::<TerminalOutput>();
        let session = TerminalSession::spawn(
            SessionSpawn {
                session_id: "test-session".to_string(),
                program: program.to_string(),
                args: args.iter().map(|s| s.to_string()).collect(),
                cwd: None,
                env: vec![],
                rows: 24,
                cols: 80,
            },
            Box::new(MpscSink(tx)),
        )
        .expect("spawn session");
        session.mark_running();
        (session, rx)
    }

    #[test]
    fn spawn_cmd_write_command_and_read_output() {
        // §37 Phase 3 acceptance: input/output normal. Spawn cmd.exe, write
        // `echo PT_TEST_OK`, read the echo back through the reader thread.
        let (session, rx) = make_session("cmd.exe", &["/Q"]);
        // Drain the initial prompt.
        let _ = drain_output(&rx, Instant::now() + Duration::from_millis(500));

        session.write(b"echo PT_TEST_OK\r\n").expect("write");
        let output = drain_output(&rx, Instant::now() + Duration::from_secs(3));

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
    fn ctrl_c_interrupts_long_running_command() {
        // §37 Phase 3 acceptance: Ctrl+C normal. Start `ping 127.0.0.1 -t`
        // (infinite), then send Ctrl+C (\x03) and verify the session is
        // still alive (status Running) - we should be back at the prompt,
        // not exited.
        let (session, rx) = make_session("cmd.exe", &["/Q"]);
        let _ = drain_output(&rx, Instant::now() + Duration::from_millis(500));

        session.write(b"ping 127.0.0.1 -t\r\n").expect("write ping");
        // Give it time to start pinging.
        std::thread::sleep(Duration::from_millis(400));
        // Send Ctrl+C.
        session.write(b"\x03").expect("write ctrl+c");
        let output = drain_output(&rx, Instant::now() + Duration::from_secs(2));

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
    fn encode_bytes_handles_empty_and_padded_lengths() {
        assert_eq!(encode_bytes(b""), "");
        assert_eq!(encode_bytes(b"A"), "QQ==");
        assert_eq!(encode_bytes(b"AB"), "QUI=");
        assert_eq!(encode_bytes(b"ABC"), "QUJD");
        assert_eq!(encode_bytes(&[0x00, 0xFF, 0x80, 0x7F]), "AP+Afw==");
    }

    #[test]
    fn ready_marker_requires_a_standalone_output_line() {
        let marker = b"__PROJECT_TERMINAL_READY_test__";
        let mut output = b"PS C:\\> Write-Output '[__PROJECT_TERMINAL_READY_test__]'\r\n".to_vec();
        assert!(!ready_output_contains_marker(&output, marker));

        output.extend_from_slice(b"\r\n[__PROJECT_TERMINAL_");
        assert!(!ready_output_contains_marker(&output, marker));

        output.extend_from_slice(b"READY_test__]\r\n");
        assert!(ready_output_contains_marker(&output, marker));
    }

    #[test]
    fn ready_watcher_preserves_framing_across_split_marker_output() {
        let marker = b"abcdef";
        let (sender, receiver) = mpsc::channel();
        let mut watcher = ReadyWatcher {
            marker: Some(marker.to_vec()),
            sender: Some(sender),
            pending: Vec::new(),
        };

        assert_eq!(watcher.process(b"xxxxxxxx\n[abcde"), b"xxxxxxxx");
        assert_eq!(watcher.process(b"f]\r\n"), b"\n\r\n");
        receiver
            .recv_timeout(Duration::from_millis(10))
            .expect("split marker not detected");
    }

    #[test]
    fn cmd_ready_handshake_filters_marker_and_marks_session_running() {
        let (tx, rx) = mpsc::channel::<TerminalOutput>();
        let session = TerminalSession::spawn(
            SessionSpawn {
                session_id: "ready-session".to_string(),
                program: "cmd.exe".to_string(),
                args: vec!["/Q".to_string()],
                cwd: None,
                env: vec![],
                rows: 24,
                cols: 80,
            },
            Box::new(MpscSink(tx)),
        )
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

        let output = drain_output(&rx, Instant::now() + Duration::from_millis(250));
        assert!(
            !output
                .windows(marker.len())
                .any(|window| window == marker.as_bytes()),
            "ready marker leaked into terminal output: {:?}",
            String::from_utf8_lossy(&output)
        );
        session.close();
    }
    #[test]
    fn powershell_ready_handshake_filters_marker_and_marks_session_running() {
        let (tx, rx) = mpsc::channel::<TerminalOutput>();
        let session = TerminalSession::spawn(
            SessionSpawn {
                session_id: "powershell-ready-session".to_string(),
                program: "powershell.exe".to_string(),
                args: vec!["-NoLogo".to_string()],
                cwd: None,
                env: vec![],
                rows: 24,
                cols: 80,
            },
            Box::new(MpscSink(tx)),
        )
        .expect("spawn PowerShell session");
        let marker = "__PROJECT_TERMINAL_READY_powershell__";
        let codepoints = marker
            .bytes()
            .map(|byte| byte.to_string())
            .collect::<Vec<_>>()
            .join(",");

        session
            .wait_for_ready(
                marker,
                &format!(
                    "& {{ $ptReady = [string]([char[]]({codepoints}) -join ''); Write-Output \"[$ptReady]\" }}\r\n"
                ),
                Duration::from_secs(5),
            )
            .expect("PowerShell becomes ready");
        session.mark_running();
        assert_eq!(session.status(), SessionStatus::Running);

        let output = drain_output(&rx, Instant::now() + Duration::from_millis(250));
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
