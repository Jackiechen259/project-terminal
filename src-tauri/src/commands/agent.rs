use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::agent::{
    AgentEvent, AgentEventKind, AgentProfile, AgentSession, AgentState, AgentStatus,
};
use crate::commands::terminal::{
    create_terminal_inner, restart_terminal_inner, CreateTerminalRequest, TerminalState,
};
use crate::commands::ListResponse;
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
pub fn list_agent_sessions(agents: State<'_, AgentState>) -> ListResponse<AgentSession> {
    ListResponse::new(agents.list_sessions())
}

#[tauri::command]
pub fn list_agent_events(
    agents: State<'_, AgentState>,
    agent_session_id: String,
) -> ListResponse<AgentEvent> {
    ListResponse::new(agents.list_events(&agent_session_id))
}

#[tauri::command]
pub async fn start_agent(
    app: State<'_, AppState>,
    terminal: State<'_, TerminalState>,
    agents: State<'_, AgentState>,
    agent_profile_id: String,
) -> AppResult<AgentSession> {
    let profile = agents.profiles.get(&agent_profile_id)?;
    let terminal_session_id = create_terminal_inner(
        &app,
        &terminal,
        CreateTerminalRequest {
            project_id: profile.project_id.clone(),
            profile_id: profile.terminal_profile_id.clone(),
            rows: 24,
            cols: 80,
            scrollback_megabytes: Some(8),
        },
    )
    .await?;
    let session = agents.register(&profile, terminal_session_id.clone(), &terminal.manager);
    if !profile.command.trim().is_empty() {
        terminal.manager.write(
            &terminal_session_id,
            format!("{}\r", profile.command).as_bytes(),
        )?;
    }
    Ok(session)
}

#[tauri::command]
pub fn stop_agent(
    terminal: State<'_, TerminalState>,
    agents: State<'_, AgentState>,
    agent_session_id: String,
) -> AppResult<AgentSession> {
    let session = agents
        .get_session(&agent_session_id)
        .ok_or_else(|| AppError::SessionNotFound(agent_session_id.clone()))?;
    terminal.manager.close(&session.terminal_session_id)?;
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
    terminal: State<'_, TerminalState>,
    agents: State<'_, AgentState>,
    agent_session_id: String,
) -> AppResult<AgentSession> {
    let session = agents
        .get_session(&agent_session_id)
        .ok_or_else(|| AppError::SessionNotFound(agent_session_id.clone()))?;
    let profile = agents.profiles.get(&session.agent_profile_id)?;
    let terminal_session_id =
        restart_terminal_inner(&app, &terminal, &session.terminal_session_id).await?;
    let updated = agents
        .update_terminal_and_monitor(
            &agent_session_id,
            terminal_session_id.clone(),
            profile.clone(),
            &terminal.manager,
        )
        .ok_or_else(|| AppError::SessionNotFound(agent_session_id.clone()))?;
    if !profile.command.trim().is_empty() {
        terminal.manager.write(
            &terminal_session_id,
            format!("{}\r", profile.command).as_bytes(),
        )?;
    }
    Ok(updated)
}

#[tauri::command]
pub fn respond_agent(
    terminal: State<'_, TerminalState>,
    agents: State<'_, AgentState>,
    agent_session_id: String,
    input: String,
) -> AppResult<AgentSession> {
    let session = agents
        .get_session(&agent_session_id)
        .ok_or_else(|| AppError::SessionNotFound(agent_session_id.clone()))?;
    terminal.manager.write(
        &session.terminal_session_id,
        format!("{input}\r").as_bytes(),
    )?;
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
pub fn interrupt_agent(
    terminal: State<'_, TerminalState>,
    agents: State<'_, AgentState>,
    agent_session_id: String,
) -> AppResult<()> {
    let session = agents
        .get_session(&agent_session_id)
        .ok_or_else(|| AppError::SessionNotFound(agent_session_id.clone()))?;
    terminal
        .manager
        .write(&session.terminal_session_id, b"\x03")?;
    agents.set_status(
        &agent_session_id,
        AgentStatus::Running,
        None,
        AgentEventKind::Interrupted,
        "Ctrl+C sent".into(),
    );
    Ok(())
}
