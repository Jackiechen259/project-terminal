//! Terminal manager: holds all live sessions keyed by session id.
//!
//! Phase 3 wires local shells. The manager is process-wide state shared via
//! Tauri's `manage()`. Closing a session kills the child process so it does
//! not leak when the user closes the tab or quits the app.
//!
//! The sessions map lives behind an `Arc<RwLock<...>>` so independent
//! lookups can proceed concurrently while the exit handler's `clone_handle()`
//! still sees the SAME map as the managed state.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::RwLock;

use crate::error::{AppError, AppResult};

use super::frame_scheduler::TerminalFrameSubscription;
use super::scrollback::ScrollbackSnapshotFormat;
use super::session::{
    SessionSpawn, SessionStatus, SessionSubscription, TerminalSession, TerminalStatusEvent,
};
use crate::terminal_engine::{TerminalKeyEvent, TerminalMouseEvent};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub project_id: String,
    pub profile_id: String,
    pub status: SessionStatus,
    pub exit_code: Option<i32>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// The workspace that owns this session. `None` for sessions created
    /// outside any window (for example the remote gateway).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// The window label that owns this session (== `workspace_id` for desktop
    /// windows). `None` for sessions created outside any window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
}

impl From<&TerminalSession> for SessionInfo {
    fn from(session: &TerminalSession) -> Self {
        Self {
            session_id: session.session_id.clone(),
            project_id: session.project_id.clone(),
            profile_id: session.profile_id.clone(),
            status: session.status(),
            exit_code: session.exit_code(),
            created_at: session.created_at,
            workspace_id: session.workspace_id.clone(),
            window_id: session.window_id.clone(),
        }
    }
}

pub struct TerminalManager {
    sessions: Arc<RwLock<HashMap<String, Arc<TerminalSession>>>>,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }
    /// Clone the shared sessions handle. Used by the exit handler so it sees
    /// the SAME session map as the managed state - not a copy.
    pub fn clone_handle(&self) -> TerminalManager {
        Self {
            sessions: self.sessions.clone(),
        }
    }

    /// Spawn a session and register it. Returns the session id.
    pub fn create(&self, spawn: SessionSpawn) -> AppResult<String> {
        let session = TerminalSession::spawn(spawn.clone())?;
        let id = spawn.session_id.clone();
        self.sessions.write().insert(id.clone(), Arc::new(session));
        Ok(id)
    }

    pub fn get(&self, session_id: &str) -> AppResult<Arc<TerminalSession>> {
        self.sessions
            .read()
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> AppResult<()> {
        let session = self.get(session_id)?;
        session.write(data)
    }

    pub fn key_down(&self, session_id: &str, event: &TerminalKeyEvent) -> AppResult<()> {
        self.get(session_id)?.key_down(event)
    }

    pub fn text_input(&self, session_id: &str, text: &str) -> AppResult<()> {
        self.get(session_id)?.text_input(text)
    }

    pub fn mouse_event(&self, session_id: &str, event: &TerminalMouseEvent) -> AppResult<()> {
        self.get(session_id)?.mouse_event(event)
    }

    pub fn send_paste(&self, session_id: &str, text: &str) -> AppResult<()> {
        self.get(session_id)?.send_paste(text)
    }

    pub fn bracketed_paste_enabled(&self, session_id: &str) -> AppResult<bool> {
        Ok(self.get(session_id)?.bracketed_paste_enabled())
    }

    pub fn search(
        &self,
        session_id: &str,
        query: &crate::terminal_engine::TerminalSearchQuery,
    ) -> AppResult<Vec<crate::terminal_engine::TerminalSearchMatch>> {
        Ok(self.get(session_id)?.search(query))
    }

    pub fn selection_text(
        &self,
        session_id: &str,
        anchor: &crate::terminal_engine::TerminalSelectionPoint,
        focus: &crate::terminal_engine::TerminalSelectionPoint,
    ) -> AppResult<String> {
        Ok(self.get(session_id)?.selection_text(anchor, focus))
    }

    pub fn set_viewport_top(&self, session_id: &str, stable_row: i64) -> AppResult<()> {
        self.get(session_id)?.set_viewport_top(stable_row);
        Ok(())
    }

    pub fn attach(
        &self,
        session_id: &str,
        client_id: String,
        snapshot_format: ScrollbackSnapshotFormat,
    ) -> AppResult<(SessionInfo, SessionSubscription)> {
        let session = self.get(session_id)?;
        let subscription = session.attach(client_id, snapshot_format);
        // Read state after subscribing so an exit that races attach is
        // represented either in this snapshot or in the event receiver.
        let info = SessionInfo::from(session.as_ref());
        Ok((info, subscription))
    }

    pub fn attach_renderer(
        &self,
        session_id: &str,
        client_id: String,
    ) -> AppResult<(
        SessionInfo,
        TerminalFrameSubscription,
        tokio::sync::broadcast::Receiver<TerminalStatusEvent>,
    )> {
        let session = self.get(session_id)?;
        let (subscription, status_receiver) = session.attach_renderer(client_id);
        let info = SessionInfo::from(session.as_ref());
        Ok((info, subscription, status_receiver))
    }

    pub fn renderer_count(&self, session_id: &str) -> AppResult<usize> {
        Ok(self.get(session_id)?.renderer_count())
    }

    pub fn detach(&self, session_id: &str, client_id: &str) -> AppResult<()> {
        self.get(session_id)?.detach(client_id);
        Ok(())
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        // Do not hold the registry lock while reading individual session
        // state. A slow PTY write or resize in one session must not block
        // lookups and lifecycle operations for every other session.
        let sessions = self.sessions.read().values().cloned().collect::<Vec<_>>();
        sessions
            .iter()
            .map(|session| SessionInfo::from(session.as_ref()))
            .collect()
    }

    pub fn info(&self, session_id: &str) -> AppResult<SessionInfo> {
        let session = self.get(session_id)?;
        Ok(SessionInfo::from(session.as_ref()))
    }

    pub fn wait_for_ready(
        &self,
        session_id: &str,
        marker: &str,
        command: &str,
        timeout: std::time::Duration,
    ) -> AppResult<()> {
        self.get(session_id)?
            .wait_for_ready(marker, command, timeout)
    }

    pub fn mark_running(&self, session_id: &str) -> AppResult<()> {
        self.get(session_id)?.mark_running();
        Ok(())
    }

    pub fn resize(
        &self,
        session_id: &str,
        rows: u16,
        cols: u16,
        pixel_width: u16,
        pixel_height: u16,
    ) -> AppResult<()> {
        let session = self.get(session_id)?;
        session.resize(rows, cols, pixel_width, pixel_height)
    }

    /// Close a session and remove it from the map. Idempotent - closing an
    /// unknown session id is a no-op rather than an error, so the frontend
    /// can always call it on tab teardown.
    pub fn close(&self, session_id: &str) -> AppResult<()> {
        let session = self.sessions.write().remove(session_id);
        if let Some(s) = session {
            s.close();
        }
        Ok(())
    }

    /// Close all sessions. Called on app exit so no PowerShell/SSH child
    /// processes leak.
    pub fn close_all(&self) {
        let sessions: Vec<Arc<TerminalSession>> =
            self.sessions.write().drain().map(|(_, v)| v).collect();
        for s in sessions {
            s.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn cmd_spawn(id: &str) -> SessionSpawn {
        SessionSpawn {
            session_id: id.into(),
            project_id: "project-1".into(),
            profile_id: "profile-1".into(),
            workspace_id: Some("ws-1".into()),
            window_id: Some("ws-1".into()),
            program: "cmd.exe".into(),
            args: vec!["/Q".into()],
            cwd: None,
            env: vec![],
            env_remove: Vec::new(),
            readiness_marker: None,
            rows: 24,
            cols: 80,
            scrollback_bytes: 4 * 1024 * 1024,
            scrollback_lines: None,
        }
    }

    fn wait_for_text(
        receiver: &mut tokio::sync::broadcast::Receiver<super::super::session::TerminalEvent>,
        expected: &[u8],
    ) {
        use super::super::session::TerminalEventPayload;

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut output = Vec::new();
        while Instant::now() < deadline {
            match receiver.try_recv() {
                Ok(event) => {
                    if let TerminalEventPayload::Output(bytes) = event.payload {
                        output.extend_from_slice(&bytes);
                    }
                    if output.windows(expected.len()).any(|part| part == expected) {
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("terminal event stream failed: {error}"),
            }
        }
        panic!(
            "timed out waiting for {:?}; got {:?}",
            String::from_utf8_lossy(expected),
            String::from_utf8_lossy(&output)
        );
    }

    #[test]
    fn close_unknown_session_is_noop() {
        let mgr = TerminalManager::new();
        mgr.close("does-not-exist").unwrap();
    }

    #[test]
    fn get_unknown_session_errors() {
        let mgr = TerminalManager::new();
        assert!(matches!(
            mgr.get("nope").unwrap_err(),
            AppError::SessionNotFound(_)
        ));
    }

    #[test]
    fn resize_unknown_session_errors() {
        let mgr = TerminalManager::new();
        assert!(mgr.resize("nope", 24, 80, 0, 0).is_err());
    }

    #[test]
    fn clone_handle_shares_session_map() {
        // The exit handler's clone_handle must see the SAME underlying map
        // as the original - verified by Arc pointer equality on the registry.
        let mgr = TerminalManager::new();
        let cloned = mgr.clone_handle();
        assert!(Arc::ptr_eq(&mgr.sessions, &cloned.sessions));
    }

    #[test]
    fn session_registry_allows_concurrent_readers() {
        let manager = TerminalManager::new();
        let first_reader = manager.sessions.read();
        assert!(
            manager.sessions.try_read().is_some(),
            "one session lookup should not serialize unrelated readers"
        );
        drop(first_reader);
    }

    #[test]
    fn detach_keeps_shell_running_and_other_subscriber_receives_output() {
        let manager = TerminalManager::new();
        let id = manager.create(cmd_spawn("shared-session")).unwrap();
        manager.mark_running(&id).unwrap();
        let (_, first) = manager
            .attach(&id, "first".into(), ScrollbackSnapshotFormat::Replay)
            .unwrap();
        let (_, second) = manager
            .attach(&id, "second".into(), ScrollbackSnapshotFormat::Replay)
            .unwrap();
        let mut first_receiver = first.receiver;
        let mut second_receiver = second.receiver;

        manager.write(&id, b"echo BOTH_CLIENTS\r\n").unwrap();
        wait_for_text(&mut first_receiver, b"BOTH_CLIENTS");
        wait_for_text(&mut second_receiver, b"BOTH_CLIENTS");

        manager.detach(&id, "first").unwrap();
        assert!(
            *first.cancellation.borrow(),
            "detached subscription was not cancelled"
        );
        manager.write(&id, b"echo SECOND_STILL_LIVE\r\n").unwrap();
        wait_for_text(&mut second_receiver, b"SECOND_STILL_LIVE");
        assert_eq!(manager.info(&id).unwrap().status, SessionStatus::Running);

        manager.close(&id).unwrap();
        assert!(manager.get(&id).is_err());
    }

    #[test]
    fn attach_recovers_scrollback_written_without_subscribers() {
        let manager = TerminalManager::new();
        let id = manager.create(cmd_spawn("scrollback-session")).unwrap();
        manager.mark_running(&id).unwrap();
        manager.write(&id, b"echo RECOVERED_HISTORY\r\n").unwrap();

        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let (_, attachment) = manager
                .attach(&id, "history-client".into(), ScrollbackSnapshotFormat::Flat)
                .unwrap();
            let history = String::from_utf8_lossy(&attachment.snapshot.bytes).into_owned();
            if history.contains("RECOVERED_HISTORY") {
                break;
            }
            manager.detach(&id, "history-client").unwrap();
            assert!(Instant::now() < deadline, "scrollback was not updated");
            std::thread::sleep(Duration::from_millis(20));
        }

        let listed = manager.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, id);
        assert_eq!(listed[0].project_id, "project-1");
        manager.close_all();
    }

    #[test]
    #[ignore = "Windows multi-session stress probe; run with --ignored --nocapture"]
    fn ten_sessions_keep_background_models_live_with_one_active_renderer() {
        use crate::terminal_engine::{TerminalSearchDirection, TerminalSearchQuery};

        let manager = TerminalManager::new();
        let started = Instant::now();
        let ids = (0..10)
            .map(|index| {
                let id = format!("multi-session-{index}");
                manager.create(cmd_spawn(&id)).expect("spawn session");
                manager.mark_running(&id).expect("mark running");
                id
            })
            .collect::<Vec<_>>();

        let (_, mut active_frames, _active_status) = manager
            .attach_renderer(&ids[0], "active-renderer".into())
            .expect("attach active renderer");
        assert_eq!(manager.renderer_count(&ids[0]).unwrap(), 1);
        for id in &ids[1..] {
            assert_eq!(manager.renderer_count(id).unwrap(), 0);
        }

        for (index, id) in ids.iter().enumerate() {
            manager
                .write(id, format!("echo PT_MULTI_{index}\r\n").as_bytes())
                .expect("write session output");
        }

        let query = |id: &str| {
            manager.search(
                id,
                &TerminalSearchQuery {
                    query: format!(
                        "PT_MULTI_{}",
                        ids.iter().position(|value| value == id).unwrap()
                    ),
                    case_sensitive: true,
                    direction: TerminalSearchDirection::Forward,
                    start: None,
                },
            )
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut all_models_ready = false;
        let mut active_frame_ready = false;
        while Instant::now() < deadline {
            all_models_ready = ids.iter().all(|id| !query(id).unwrap().is_empty());
            while let Ok(frame) = active_frames.frames.try_recv() {
                active_frame_ready |= frame.full_snapshot
                    || frame.dirty_rows.iter().any(|row| {
                        row.cells
                            .iter()
                            .any(|cell| cell.text.contains("PT_MULTI_0"))
                    });
            }
            if all_models_ready && active_frame_ready {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }

        assert!(
            all_models_ready,
            "all ten terminal models did not parse output"
        );
        assert!(
            active_frame_ready,
            "the active renderer did not receive a model frame"
        );
        assert!(
            ids.iter()
                .all(|id| manager.info(id).unwrap().status == SessionStatus::Running),
            "a background session stopped while parsing output"
        );
        println!(
            "terminal_multi_session_benchmark sessions=10 active_renderers=1 background_renderers=9 elapsed_ms={}",
            started.elapsed().as_millis(),
        );
        manager.close_all();
    }
}
