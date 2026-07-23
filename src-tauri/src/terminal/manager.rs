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

use super::session::{SessionSpawn, TerminalSession};

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
    pub fn create(
        &self,
        spawn: SessionSpawn,
        sink: Box<dyn super::session::OutputSink>,
    ) -> AppResult<String> {
        let session = TerminalSession::spawn(spawn.clone(), sink)?;
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
}
