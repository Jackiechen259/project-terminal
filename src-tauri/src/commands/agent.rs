use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::agent::{
    AgentEvent, AgentEventKind, AgentProfile, AgentSession, AgentState, AgentStatus,
};
use crate::commands::terminal::{build_session_spawn, CreateTerminalRequest};
use crate::commands::ListResponse;
use crate::daemon::{DaemonRequest, DaemonSpawnRequest};
use crate::error::{AppError, AppResult};
use crate::state::{new_id, AppState};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub project_id: String,
    pub terminal_profile_id: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub waiting_patterns: Vec<String>,
    #[serde(default)]
    pub approval_patterns: Vec<String>,
}

fn validate_profile_input(app: &AppState, input: &AgentProfileInput) -> AppResult<()> {
    if input.name.trim().is_empty() {
        return Err(AppError::Configuration(
            "Agent profile name must not be empty".into(),
        ));
    }
    app.projects.get(&input.project_id)?;
    let terminal_profile = app.profiles.get(&input.terminal_profile_id)?;
    if terminal_profile.project_id != input.project_id {
        return Err(AppError::Configuration(
            "Agent terminal profile must belong to its project".into(),
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn list_agent_profiles(agents: State<'_, AgentState>) -> AppResult<ListResponse<AgentProfile>> {
    Ok(ListResponse::new(agents.profiles.list()?))
}

#[tauri::command]
pub fn create_agent_profile(
    app: State<'_, AppState>,
    agents: State<'_, AgentState>,
    input: AgentProfileInput,
) -> AppResult<AgentProfile> {
    validate_profile_input(&app, &input)?;
    let now = Utc::now();
    agents.profiles.upsert(AgentProfile {
        id: new_id("agent-profile"),
        name: input.name,
        project_id: input.project_id,
        terminal_profile_id: input.terminal_profile_id,
        command: input.command,
        waiting_patterns: input.waiting_patterns,
        approval_patterns: input.approval_patterns,
        created_at: now,
        updated_at: now,
    })
}

#[tauri::command]
pub fn update_agent_profile(
    app: State<'_, AppState>,
    agents: State<'_, AgentState>,
    input: AgentProfileInput,
) -> AppResult<AgentProfile> {
    validate_profile_input(&app, &input)?;
    let id = input
        .id
        .as_deref()
        .ok_or_else(|| AppError::Configuration("Agent profile id is required".into()))?;
    let existing = agents.profiles.get(id)?;
    agents.profiles.upsert(AgentProfile {
        id: existing.id,
        name: input.name,
        project_id: input.project_id,
        terminal_profile_id: input.terminal_profile_id,
        command: input.command,
        waiting_patterns: input.waiting_patterns,
        approval_patterns: input.approval_patterns,
        created_at: existing.created_at,
        updated_at: Utc::now(),
    })
}

#[tauri::command]
pub fn delete_agent_profile(agents: State<'_, AgentState>, id: String) -> AppResult<()> {
    agents.profiles.delete(&id)
}

#[tauri::command]
pub async fn list_agent_sessions(
    agents: State<'_, AgentState>,
) -> AppResult<ListResponse<AgentSession>> {
    agents.sync_daemon_sessions().await;
    Ok(ListResponse::new(agents.list_sessions()))
}

#[tauri::command]
pub fn list_agent_events(
    agents: State<'_, AgentState>,
    agent_session_id: String,
) -> ListResponse<AgentEvent> {
    ListResponse::new(agents.list_events(&agent_session_id))
}

async fn ensure_host() -> AppResult<()> {
    let status = crate::commands::daemon::ensure_running().await;
    if status.connected {
        Ok(())
    } else {
        Err(AppError::Configuration(
            status
                .error
                .unwrap_or_else(|| "Session Host is unavailable".into()),
        ))
    }
}

async fn spawn_agent_terminal(
    app: &AppState,
    profile: &AgentProfile,
) -> AppResult<(String, crate::profile::TerminalProfile)> {
    let terminal_session_id = new_id("session");
    let request = CreateTerminalRequest {
        project_id: profile.project_id.clone(),
        profile_id: profile.terminal_profile_id.clone(),
        rows: 24,
        cols: 80,
        scrollback_megabytes: Some(8),
    };
    let (mut spawn, _, terminal_profile) =
        build_session_spawn(app, &request, &terminal_session_id)?;
    // The daemon persists this marker, allowing a fresh UI process to recover
    // the owning Agent Profile and reattach its status monitor.
    spawn.profile_id = format!("agent:{}", profile.id);
    let response = crate::daemon::request(DaemonRequest::Create {
        spawn: DaemonSpawnRequest::from(spawn),
    })
    .await?;
    if !response.ok {
        return Err(AppError::ShellStartFailed(
            response
                .error
                .unwrap_or_else(|| "Daemon launch failed".into()),
        ));
    }
    Ok((terminal_session_id, terminal_profile))
}

fn initialization_input(
    terminal_profile: &crate::profile::TerminalProfile,
    agent_profile: &AgentProfile,
) -> AppResult<String> {
    let mut input = crate::terminal::build_activation_script(terminal_profile)?;
    for command in &terminal_profile.startup_commands {
        input.push_str(command);
        input.push('\r');
    }
    if !agent_profile.command.trim().is_empty() {
        input.push_str(agent_profile.command.trim());
        input.push('\r');
    }
    Ok(input)
}

async fn host_request(request: DaemonRequest) -> AppResult<()> {
    let response = crate::daemon::request(request).await?;
    if response.ok {
        Ok(())
    } else {
        Err(AppError::Configuration(
            response
                .error
                .unwrap_or_else(|| "Session Host request failed".into()),
        ))
    }
}

async fn initialize_agent(
    terminal_session_id: &str,
    terminal_profile: &crate::profile::TerminalProfile,
    agent_profile: &AgentProfile,
) -> AppResult<()> {
    // Let the interactive shell reach its first prompt. The daemon owns the
    // PTY, so the UI may exit immediately after this request without killing
    // the Agent.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let data = initialization_input(terminal_profile, agent_profile)?;
    if data.is_empty() {
        return Ok(());
    }
    host_request(DaemonRequest::Write {
        session_id: terminal_session_id.into(),
        data,
    })
    .await
}

#[tauri::command]
pub async fn start_agent(
    app: State<'_, AppState>,
    agents: State<'_, AgentState>,
    agent_profile_id: String,
) -> AppResult<AgentSession> {
    ensure_host().await?;
    let profile = agents.profiles.get(&agent_profile_id)?;
    let (terminal_session_id, terminal_profile) = spawn_agent_terminal(&app, &profile).await?;
    let session = agents.register_daemon(&profile, terminal_session_id.clone());
    initialize_agent(&terminal_session_id, &terminal_profile, &profile).await?;
    Ok(session)
}

#[tauri::command]
pub async fn stop_agent(
    agents: State<'_, AgentState>,
    agent_session_id: String,
) -> AppResult<AgentSession> {
    let session = agents
        .get_session(&agent_session_id)
        .ok_or_else(|| AppError::SessionNotFound(agent_session_id.clone()))?;
    host_request(DaemonRequest::Close {
        session_id: session.terminal_session_id,
    })
    .await?;
    agents
        .set_status(
            &agent_session_id,
            AgentStatus::Stopped,
            Some("Stopped by user".into()),
            AgentEventKind::Stopped,
            "Agent stopped".into(),
        )
        .ok_or_else(|| AppError::SessionNotFound(agent_session_id))
}

#[tauri::command]
pub async fn restart_agent(
    app: State<'_, AppState>,
    agents: State<'_, AgentState>,
    agent_session_id: String,
) -> AppResult<AgentSession> {
    ensure_host().await?;
    let session = agents
        .get_session(&agent_session_id)
        .ok_or_else(|| AppError::SessionNotFound(agent_session_id.clone()))?;
    let profile = agents.profiles.get(&session.agent_profile_id)?;
    host_request(DaemonRequest::Close {
        session_id: session.terminal_session_id,
    })
    .await?;
    let (terminal_session_id, terminal_profile) = spawn_agent_terminal(&app, &profile).await?;
    let updated = agents
        .update_daemon_session(
            &agent_session_id,
            terminal_session_id.clone(),
            profile.clone(),
        )
        .ok_or_else(|| AppError::SessionNotFound(agent_session_id))?;
    initialize_agent(&terminal_session_id, &terminal_profile, &profile).await?;
    Ok(updated)
}

#[tauri::command]
pub async fn respond_agent(
    agents: State<'_, AgentState>,
    agent_session_id: String,
    input: String,
) -> AppResult<AgentSession> {
    let session = agents
        .get_session(&agent_session_id)
        .ok_or_else(|| AppError::SessionNotFound(agent_session_id.clone()))?;
    host_request(DaemonRequest::Write {
        session_id: session.terminal_session_id,
        data: format!("{input}\r"),
    })
    .await?;
    agents
        .set_status(
            &agent_session_id,
            AgentStatus::Running,
            None,
            AgentEventKind::Input,
            "User replied to agent".into(),
        )
        .ok_or_else(|| AppError::SessionNotFound(agent_session_id))
}

#[tauri::command]
pub async fn interrupt_agent(
    agents: State<'_, AgentState>,
    agent_session_id: String,
) -> AppResult<()> {
    let session = agents
        .get_session(&agent_session_id)
        .ok_or_else(|| AppError::SessionNotFound(agent_session_id.clone()))?;
    host_request(DaemonRequest::Write {
        session_id: session.terminal_session_id,
        data: "\u{3}".into(),
    })
    .await?;
    agents.set_status(
        &agent_session_id,
        AgentStatus::Running,
        None,
        AgentEventKind::Interrupted,
        "Ctrl+C sent".into(),
    );
    Ok(())
}
