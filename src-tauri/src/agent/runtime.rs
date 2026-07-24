use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine;
use chrono::Utc;
use parking_lot::Mutex;
use serde::Deserialize;

use crate::agent::{
    AgentEvent, AgentEventKind, AgentProfile, AgentProfileRepository, AgentSession, AgentStatus,
    TokenUsage,
};
use crate::config_dirs::ConfigDirs;
use crate::daemon::{self, DaemonRequest};
use crate::error::AppResult;
use crate::state::new_id;
use crate::terminal::TerminalOutput;

const MAX_EVENTS_PER_AGENT: usize = 2_000;

pub struct AgentState {
    pub profiles: AgentProfileRepository,
    sessions: Arc<Mutex<HashMap<String, AgentSession>>>,
    events: Arc<Mutex<HashMap<String, Vec<AgentEvent>>>>,
}

impl AgentState {
    pub fn init() -> AppResult<Self> {
        let dirs = ConfigDirs::resolve()?;
        dirs.ensure_root()?;
        Ok(Self::new(AgentProfileRepository::new(
            dirs.agent_profiles_path(),
        )))
    }

    pub fn new(profiles: AgentProfileRepository) -> Self {
        Self {
            profiles,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            events: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn list_sessions(&self) -> Vec<AgentSession> {
        self.sessions.lock().values().cloned().collect()
    }

    pub fn get_session(&self, id: &str) -> Option<AgentSession> {
        self.sessions.lock().get(id).cloned()
    }

    pub fn list_events(&self, id: &str) -> Vec<AgentEvent> {
        self.events.lock().get(id).cloned().unwrap_or_default()
    }

    pub fn register_daemon(
        &self,
        profile: &AgentProfile,
        terminal_session_id: String,
    ) -> AgentSession {
        let now = Utc::now();
        let session = AgentSession {
            id: format!("agent-session-{terminal_session_id}"),
            agent_profile_id: profile.id.clone(),
            project_id: profile.project_id.clone(),
            terminal_session_id,
            status: AgentStatus::Running,
            token_usage: TokenUsage::default(),
            exit_reason: None,
            started_at: now,
            updated_at: now,
        };
        self.sessions
            .lock()
            .insert(session.id.clone(), session.clone());
        push_event(
            &self.events,
            &session.id,
            AgentEventKind::Started,
            "Agent started in Session Host".into(),
            None,
        );
        self.monitor_daemon(profile.clone(), session.clone());
        session
    }

    pub async fn sync_daemon_sessions(&self) {
        let Ok(response) = daemon::request(DaemonRequest::ListSessions).await else {
            return;
        };
        let Some(data) = response.data else {
            return;
        };
        let mut remote_values = data
            .get("sessions")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        remote_values.extend(
            data.get("recoveredAsFailed")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        let Ok(remote_sessions) = serde_json::from_value::<Vec<crate::terminal::SessionInfo>>(
            serde_json::Value::Array(remote_values),
        ) else {
            return;
        };
        for remote in remote_sessions {
            let Some(profile_id) = remote.profile_id.strip_prefix("agent:") else {
                continue;
            };
            if self
                .sessions
                .lock()
                .values()
                .any(|session| session.terminal_session_id == remote.session_id)
            {
                continue;
            }
            let Ok(profile) = self.profiles.get(profile_id) else {
                continue;
            };
            let session = self.register_daemon(&profile, remote.session_id);
            if !matches!(
                remote.status,
                crate::terminal::session::SessionStatus::Running
                    | crate::terminal::session::SessionStatus::Starting
            ) {
                self.set_status(
                    &session.id,
                    if remote.exit_code == Some(0) {
                        AgentStatus::Completed
                    } else {
                        AgentStatus::Failed
                    },
                    remote
                        .exit_code
                        .map(|code| format!("Exited with code {code}")),
                    AgentEventKind::Status,
                    "Recovered Agent state from Session Host".into(),
                );
            }
        }
    }

    pub fn update_daemon_session(
        &self,
        session_id: &str,
        terminal_session_id: String,
        profile: AgentProfile,
    ) -> Option<AgentSession> {
        let updated = {
            let mut sessions = self.sessions.lock();
            let session = sessions.get_mut(session_id)?;
            session.terminal_session_id = terminal_session_id;
            session.status = AgentStatus::Running;
            session.exit_reason = None;
            session.updated_at = Utc::now();
            session.clone()
        };
        push_event(
            &self.events,
            session_id,
            AgentEventKind::Started,
            "Agent restarted in Session Host".into(),
            None,
        );
        self.monitor_daemon(profile, updated.clone());
        Some(updated)
    }

    pub fn set_status(
        &self,
        id: &str,
        status: AgentStatus,
        reason: Option<String>,
        kind: AgentEventKind,
        message: String,
    ) -> Option<AgentSession> {
        let updated = {
            let mut sessions = self.sessions.lock();
            let session = sessions.get_mut(id)?;
            session.status = status;
            session.exit_reason = reason;
            session.updated_at = Utc::now();
            session.clone()
        };
        push_event(&self.events, id, kind, message, None);
        Some(updated)
    }

    fn monitor_daemon(&self, profile: AgentProfile, session: AgentSession) {
        let sessions = self.sessions.clone();
        let events = self.events.clone();
        tauri::async_runtime::spawn(async move {
            let mut previous = Vec::new();
            loop {
                let response = match daemon::request(DaemonRequest::Snapshot {
                    session_id: session.terminal_session_id.clone(),
                })
                .await
                {
                    Ok(response) if response.ok => response,
                    _ => break,
                };
                let Some(data) = response.data else {
                    break;
                };
                let encoded = data
                    .get("scrollback")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .unwrap_or_default();
                let delta = if bytes.starts_with(&previous) {
                    bytes[previous.len()..].to_vec()
                } else {
                    bytes.clone()
                };
                previous = bytes;
                if !delta.is_empty() {
                    process_output(
                        &profile,
                        &session.id,
                        &sessions,
                        &events,
                        TerminalOutput {
                            session_id: session.terminal_session_id.clone(),
                            data: base64::engine::general_purpose::STANDARD.encode(delta),
                            status: None,
                            exit_code: None,
                        },
                    );
                }
                let remote_status = data
                    .get("session")
                    .and_then(|remote| remote.get("status"))
                    .and_then(serde_json::Value::as_str);
                if matches!(remote_status, Some("exited" | "error")) {
                    let exit_code = data
                        .get("session")
                        .and_then(|remote| remote.get("exitCode"))
                        .and_then(serde_json::Value::as_i64)
                        .map(|code| code as i32);
                    process_output(
                        &profile,
                        &session.id,
                        &sessions,
                        &events,
                        TerminalOutput {
                            session_id: session.terminal_session_id.clone(),
                            data: String::new(),
                            status: Some(if remote_status == Some("error") {
                                crate::terminal::session::SessionStatus::Error
                            } else {
                                crate::terminal::session::SessionStatus::Exited
                            }),
                            exit_code,
                        },
                    );
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        });
    }
}

fn process_output(
    profile: &AgentProfile,
    agent_session_id: &str,
    sessions: &Arc<Mutex<HashMap<String, AgentSession>>>,
    events: &Arc<Mutex<HashMap<String, Vec<AgentEvent>>>>,
    output: TerminalOutput,
) {
    let is_current_terminal = sessions
        .lock()
        .get(agent_session_id)
        .map(|session| session.terminal_session_id == output.session_id)
        .unwrap_or(false);
    if !is_current_terminal {
        return;
    }
    if let Some(status) = output.status {
        let (agent_status, kind, reason) = match status {
            crate::terminal::session::SessionStatus::Exited if output.exit_code == Some(0) => (
                AgentStatus::Completed,
                AgentEventKind::Completed,
                "Agent completed".to_string(),
            ),
            crate::terminal::session::SessionStatus::Exited => (
                AgentStatus::Failed,
                AgentEventKind::Failed,
                format!("Agent exited with code {}", output.exit_code.unwrap_or(-1)),
            ),
            crate::terminal::session::SessionStatus::Error => (
                AgentStatus::Failed,
                AgentEventKind::Failed,
                "Agent terminal failed".to_string(),
            ),
            _ => return,
        };
        update_status(
            sessions,
            agent_session_id,
            agent_status,
            Some(reason.clone()),
        );
        push_event(events, agent_session_id, kind, reason, None);
        return;
    }

    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(output.data) else {
        return;
    };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        if let Some(structured) = line.strip_prefix("PT_AGENT_EVENT:") {
            if let Ok(event) = serde_json::from_str::<StructuredAgentEvent>(structured.trim()) {
                apply_structured_event(agent_session_id, sessions, events, event);
                continue;
            }
        }
        let lower = line.to_lowercase();
        let approval = profile
            .approval_patterns
            .iter()
            .any(|pattern| lower.contains(&pattern.to_lowercase()))
            || lower.contains("approval required")
            || lower.contains("allow this command");
        let waiting = profile
            .waiting_patterns
            .iter()
            .any(|pattern| lower.contains(&pattern.to_lowercase()))
            || lower.contains("waiting for input");
        if approval {
            update_status(sessions, agent_session_id, AgentStatus::Approval, None);
            push_event(
                events,
                agent_session_id,
                AgentEventKind::Approval,
                line.into(),
                None,
            );
        } else if waiting {
            update_status(sessions, agent_session_id, AgentStatus::Waiting, None);
            push_event(
                events,
                agent_session_id,
                AgentEventKind::Waiting,
                line.into(),
                None,
            );
        } else {
            push_event(
                events,
                agent_session_id,
                AgentEventKind::Output,
                line.into(),
                None,
            );
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StructuredAgentEvent {
    status: Option<AgentStatus>,
    message: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

fn apply_structured_event(
    id: &str,
    sessions: &Arc<Mutex<HashMap<String, AgentSession>>>,
    events: &Arc<Mutex<HashMap<String, Vec<AgentEvent>>>>,
    event: StructuredAgentEvent,
) {
    let usage = TokenUsage {
        input_tokens: event.input_tokens.unwrap_or(0),
        output_tokens: event.output_tokens.unwrap_or(0),
        total_tokens: event
            .total_tokens
            .unwrap_or_else(|| event.input_tokens.unwrap_or(0) + event.output_tokens.unwrap_or(0)),
    };
    if let Some(session) = sessions.lock().get_mut(id) {
        if let Some(status) = event.status {
            session.status = status;
        }
        if usage.total_tokens > 0 {
            session.token_usage = usage.clone();
        }
        session.updated_at = Utc::now();
    }
    let status = event.status.unwrap_or(AgentStatus::Running);
    let kind = match status {
        AgentStatus::Waiting => AgentEventKind::Waiting,
        AgentStatus::Approval => AgentEventKind::Approval,
        AgentStatus::Completed => AgentEventKind::Completed,
        AgentStatus::Failed => AgentEventKind::Failed,
        _ => AgentEventKind::Status,
    };
    push_event(
        events,
        id,
        kind,
        event.message.unwrap_or_else(|| format!("{status:?}")),
        (usage.total_tokens > 0).then_some(usage),
    );
}

fn update_status(
    sessions: &Arc<Mutex<HashMap<String, AgentSession>>>,
    id: &str,
    status: AgentStatus,
    reason: Option<String>,
) {
    if let Some(session) = sessions.lock().get_mut(id) {
        session.status = status;
        session.exit_reason = reason;
        session.updated_at = Utc::now();
    }
}

fn push_event(
    events: &Arc<Mutex<HashMap<String, Vec<AgentEvent>>>>,
    session_id: &str,
    kind: AgentEventKind,
    message: String,
    token_usage: Option<TokenUsage>,
) {
    let mut all = events.lock();
    let session_events = all.entry(session_id.into()).or_default();
    session_events.push(AgentEvent {
        id: new_id("agent-event"),
        agent_session_id: session_id.into(),
        kind,
        message,
        timestamp: Utc::now(),
        token_usage,
    });
    if session_events.len() > MAX_EVENTS_PER_AGENT {
        session_events.drain(..session_events.len() - MAX_EVENTS_PER_AGENT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> AgentSession {
        let now = Utc::now();
        AgentSession {
            id: "agent-1".into(),
            agent_profile_id: "profile-1".into(),
            project_id: "project-1".into(),
            terminal_session_id: "terminal-1".into(),
            status: AgentStatus::Running,
            token_usage: TokenUsage::default(),
            exit_reason: None,
            started_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn structured_event_updates_status_and_token_usage() {
        let sessions = Arc::new(Mutex::new(HashMap::from([("agent-1".into(), session())])));
        let events = Arc::new(Mutex::new(HashMap::new()));
        apply_structured_event(
            "agent-1",
            &sessions,
            &events,
            StructuredAgentEvent {
                status: Some(AgentStatus::Approval),
                message: Some("Approve tool call".into()),
                input_tokens: Some(10),
                output_tokens: Some(5),
                total_tokens: None,
            },
        );

        let updated = sessions.lock().get("agent-1").unwrap().clone();
        assert_eq!(updated.status, AgentStatus::Approval);
        assert_eq!(updated.token_usage.total_tokens, 15);
        assert_eq!(events.lock()["agent-1"][0].kind, AgentEventKind::Approval);
    }

    #[test]
    fn event_log_is_bounded() {
        let events = Arc::new(Mutex::new(HashMap::new()));
        for index in 0..(MAX_EVENTS_PER_AGENT + 5) {
            push_event(
                &events,
                "agent-1",
                AgentEventKind::Output,
                index.to_string(),
                None,
            );
        }
        assert_eq!(events.lock()["agent-1"].len(), MAX_EVENTS_PER_AGENT);
    }
}
