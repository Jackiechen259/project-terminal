//! Terminal manager: holds all live sessions keyed by session id.
//!
//! Phase 3 wires local shells. The manager is process-wide state shared via
//! Tauri's `manage()`. Closing a session kills the child process so it does
//! not leak when the user closes the tab or quits the app.
//!
//! The sessions map lives behind an `Arc<Mutex<...>>` so the exit handler
//! can hold a `clone_handle()` to the SAME map the managed state sees.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::error::{AppError, AppResult};

use super::session::{SessionSpawn, SessionStatus, SessionSubscription, TerminalSession};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub project_id: String,
    pub profile_id: String,
    pub status: SessionStatus,
    pub exit_code: Option<i32>,
    pub created_at: chrono::DateTime<chrono::Utc>,
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
        }
    }
}

pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
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
        self.sessions.lock().insert(id.clone(), Arc::new(session));
        Ok(id)
    }

    pub fn get(&self, session_id: &str) -> AppResult<Arc<TerminalSession>> {
        self.sessions
            .lock()
            .get(session_id)
            .cloned()
            .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> AppResult<()> {
        let session = self.get(session_id)?;
        session.write(data)
    }

    pub fn attach(
        &self,
        session_id: &str,
        client_id: String,
    ) -> AppResult<(SessionInfo, SessionSubscription)> {
        let session = self.get(session_id)?;
        let subscription = session.attach(client_id);
        // Read state after subscribing so an exit that races attach is
        // represented either in this snapshot or in the event receiver.
        let info = SessionInfo::from(session.as_ref());
        Ok((info, subscription))
    }

    pub fn detach(&self, session_id: &str, client_id: &str) -> AppResult<()> {
        self.get(session_id)?.detach(client_id);
        Ok(())
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.sessions
            .lock()
            .values()
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

    pub fn resize(&self, session_id: &str, rows: u16, cols: u16) -> AppResult<()> {
        let session = self.get(session_id)?;
        session.resize(rows, cols)
    }

    /// Close a session and remove it from the map. Idempotent - closing an
    /// unknown session id is a no-op rather than an error, so the frontend
    /// can always call it on tab teardown.
    pub fn close(&self, session_id: &str) -> AppResult<()> {
        let session = self.sessions.lock().remove(session_id);
        if let Some(s) = session {
            s.close();
        }
        Ok(())
    }

    /// Close all sessions. Called on app exit so no PowerShell/SSH child
    /// processes leak.
    pub fn close_all(&self) {
        let sessions: Vec<Arc<TerminalSession>> =
            self.sessions.lock().drain().map(|(_, v)| v).collect();
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
            program: "cmd.exe".into(),
            args: vec!["/Q".into()],
            cwd: None,
            env: vec![],
            readiness_marker: None,
            rows: 24,
            cols: 80,
        }
    }

    fn wait_for_text(
        receiver: &mut tokio::sync::broadcast::Receiver<super::super::session::TerminalOutput>,
        expected: &[u8],
    ) {
        use base64::Engine;

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut output = Vec::new();
        while Instant::now() < deadline {
            match receiver.try_recv() {
                Ok(event) => {
                    output.extend(
                        base64::engine::general_purpose::STANDARD
                            .decode(event.data)
                            .unwrap_or_default(),
                    );
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
        assert!(mgr.resize("nope", 24, 80).is_err());
    }

    #[test]
    fn clone_handle_shares_session_map() {
        // The exit handler's clone_handle must see the SAME underlying map
        // as the original - verified by Arc pointer equality on the shared
        // sessions Mutex.
        let mgr = TerminalManager::new();
        let cloned = mgr.clone_handle();
        assert!(Arc::ptr_eq(&mgr.sessions, &cloned.sessions));
    }

    #[test]
    fn detach_keeps_shell_running_and_other_subscriber_receives_output() {
        let manager = TerminalManager::new();
        let id = manager.create(cmd_spawn("shared-session")).unwrap();
        manager.mark_running(&id).unwrap();
        let (_, first) = manager.attach(&id, "first".into()).unwrap();
        let (_, second) = manager.attach(&id, "second".into()).unwrap();
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
            let (_, attachment) = manager.attach(&id, "history-client".into()).unwrap();
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
}
