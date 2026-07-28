use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::Engine;
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tokio::sync::broadcast;

use crate::commands::terminal::{create_terminal_inner, CreateTerminalRequest, TerminalState};
use crate::config_dirs::ConfigDirs;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::terminal::TerminalManager;

const DEFAULT_BIND: &str = "127.0.0.1:4097";
const LEASE_TTL: Duration = Duration::from_secs(30);
const REQUESTS_PER_MINUTE: usize = 180;
const WS_MESSAGES_PER_SECOND: usize = 60;

pub(crate) struct RemoteGateway {
    token: String,
    manager: TerminalManager,
    app: AppState,
    terminal: TerminalState,
    bind: Mutex<SocketAddr>,
    url: Mutex<String>,
    transport_security: Mutex<&'static str>,
    allow_lan: Mutex<bool>,
    config_path: PathBuf,
    audit_path: PathBuf,
    enabled: Mutex<bool>,
    listener_handle: Mutex<Option<JoinHandle<()>>>,
}

impl RemoteGateway {
    pub(crate) fn new(dirs: &ConfigDirs, app: AppState, terminal: TerminalState) -> Self {
        let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4()).replace('-', "");
        let config_path = dirs.remote_config_path();
        let config = read_remote_config(&config_path);
        let allow_lan = config.allow_lan;
        // The env var is a hard override for locked-down hosts; the persisted
        // config otherwise decides whether the gateway accepts connections.
        let env_disabled = std::env::var("PROJECT_TERMINAL_REMOTE_DISABLED").as_deref() == Ok("1");
        let enabled = !env_disabled && config.enabled;
        let (bind, transport_security) = compute_bind_and_security(allow_lan);
        let url = compute_advertise_url(bind);
        Self {
            token,
            manager: terminal.manager.clone_handle(),
            app,
            terminal,
            bind: Mutex::new(bind),
            url: Mutex::new(url),
            transport_security: Mutex::new(transport_security),
            allow_lan: Mutex::new(allow_lan),
            config_path,
            audit_path: dirs.remote_audit_path(),
            enabled: Mutex::new(enabled),
            listener_handle: Mutex::new(None),
        }
    }

    pub(crate) fn info(&self) -> serde_json::Value {
        serde_json::json!({
            "enabled": *self.enabled.lock(),
            "bind": *self.bind.lock(),
            "url": self.url.lock().clone(),
            // Returned only over the local Named Pipe / Unix Socket. It is
            // intentionally never persisted or included in an audit record.
            "token": self.token,
            "transportSecurity": *self.transport_security.lock(),
            "allowLan": *self.allow_lan.lock(),
        })
    }

    pub(crate) fn start(&self) {
        if !*self.enabled.lock() {
            return;
        }
        let mut listener_handle = self.listener_handle.lock();
        if listener_handle
            .as_ref()
            .is_some_and(|handle| !handle.inner().is_finished())
        {
            return;
        }
        // A failed bind leaves a completed JoinHandle behind. Clear it here
        // so toggling the gateway or asking it to start again can recover.
        listener_handle.take();
        drop(listener_handle);
        self.spawn_listener();
    }

    /// Switch the gateway between loopback-only and LAN-wide bind without
    /// restarting the desktop process. Existing WebSocket clients drop (the address
    /// changed) and must re-scan; terminal sessions are unaffected.
    pub(crate) fn reconfigure(&self, allow_lan: bool) -> AppResult<()> {
        if !*self.enabled.lock() {
            return Err(AppError::Configuration(
                "Remote access is disabled by the host".into(),
            ));
        }
        // Persist so the choice survives an application restart.
        let mut config = read_remote_config(&self.config_path);
        config.allow_lan = allow_lan;
        write_remote_config(&self.config_path, &config)?;
        // Stop the current listener so the port frees for the new bind.
        if let Some(handle) = self.listener_handle.lock().take() {
            handle.abort();
        }
        let (bind, transport_security) = compute_bind_and_security(allow_lan);
        *self.bind.lock() = bind;
        *self.url.lock() = compute_advertise_url(bind);
        *self.transport_security.lock() = transport_security;
        *self.allow_lan.lock() = allow_lan;
        self.spawn_listener();
        Ok(())
    }

    /// Turn the entire remote gateway on or off without restarting the app.
    /// When disabled the listener is stopped and no remote connections are
    /// accepted; when re-enabled the listener starts on the stored bind. The
    /// host env var (`PROJECT_TERMINAL_REMOTE_DISABLED=1`) is a hard override
    /// and cannot be cleared from the UI.
    pub(crate) fn set_enabled(&self, enabled: bool) -> AppResult<()> {
        if std::env::var("PROJECT_TERMINAL_REMOTE_DISABLED").as_deref() == Ok("1") {
            return Err(AppError::Configuration(
                "Remote access is disabled by the host environment".into(),
            ));
        }
        let mut config = read_remote_config(&self.config_path);
        config.enabled = enabled;
        write_remote_config(&self.config_path, &config)?;
        *self.enabled.lock() = enabled;
        if enabled {
            self.start();
        } else if let Some(handle) = self.listener_handle.lock().take() {
            handle.abort();
        }
        Ok(())
    }

    fn spawn_listener(&self) {
        let bind = *self.bind.lock();
        let state = RemoteState {
            manager: self.manager.clone_handle(),
            app: self.app.clone(),
            terminal: self.terminal.clone(),
            token: self.token.clone(),
            leases: Arc::new(Mutex::new(HashMap::new())),
            rate_limits: Arc::new(Mutex::new(HashMap::new())),
            audit_path: self.audit_path.clone(),
            audit_lock: Arc::new(Mutex::new(())),
        };
        let handle = tauri::async_runtime::spawn(async move {
            let router = build_router(state);
            // Retry briefly: the previous listener's socket may still be
            // releasing when toggling between 0.0.0.0 and 127.0.0.1 binds.
            let listener = match bind_with_retry(bind).await {
                Ok(listener) => listener,
                Err(error) => {
                    tracing::error!("Could not bind remote gateway {bind}: {error}");
                    return;
                }
            };
            tracing::info!("Remote gateway listening on {bind}");
            if let Err(error) = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            {
                tracing::error!("Remote gateway failed: {error}");
            }
        });
        *self.listener_handle.lock() = Some(handle);
    }
}

struct RemoteState {
    manager: TerminalManager,
    app: AppState,
    terminal: TerminalState,
    token: String,
    leases: Arc<Mutex<HashMap<String, LeaseRecord>>>,
    rate_limits: Arc<Mutex<HashMap<IpAddr, VecDeque<Instant>>>>,
    audit_path: PathBuf,
    audit_lock: Arc<Mutex<()>>,
}

impl Clone for RemoteState {
    fn clone(&self) -> Self {
        Self {
            manager: self.manager.clone_handle(),
            app: self.app.clone(),
            terminal: self.terminal.clone(),
            token: self.token.clone(),
            leases: self.leases.clone(),
            rate_limits: self.rate_limits.clone(),
            audit_path: self.audit_path.clone(),
            audit_lock: self.audit_lock.clone(),
        }
    }
}

#[derive(Clone)]
struct LeaseRecord {
    lease_id: String,
    client_id: String,
    expires_at: Instant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaseResponse {
    lease_id: String,
    client_id: String,
    expires_in_seconds: u64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AuthQuery {
    token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionRequest {
    project_id: String,
    client_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachQuery {
    token: Option<String>,
    client_id: String,
    #[serde(default)]
    read_only: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseRequest {
    client_id: String,
    #[serde(default)]
    read_only: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseAction {
    client_id: String,
    lease_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputRequest {
    client_id: String,
    lease_id: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizeRequest {
    client_id: String,
    lease_id: String,
    rows: u16,
    cols: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SensitiveRequest {
    client_id: String,
    lease_id: String,
    confirm: bool,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WsClientMessage {
    Acquire,
    Renew {
        lease_id: String,
    },
    Release {
        lease_id: String,
    },
    Input {
        lease_id: String,
        data: String,
    },
    Resize {
        lease_id: String,
        rows: u16,
        cols: u16,
    },
    Interrupt {
        lease_id: String,
        confirm: bool,
    },
}

fn build_router(state: RemoteState) -> Router {
    Router::new()
        .route("/", get(mobile_page))
        .route("/xterm.js", get(xterm_js))
        .route("/xterm.css", get(xterm_css))
        .route("/xterm-addon-fit.js", get(xterm_addon_fit_js))
        .route("/api/projects", get(list_projects))
        .route("/api/sessions", get(list_sessions).post(create_session))
        .route("/api/sessions/{id}", get(get_session))
        .route("/api/sessions/{id}/attach", get(attach_session))
        .route("/api/sessions/{id}/lease", post(acquire_lease))
        .route(
            "/api/sessions/{id}/lease",
            delete(release_lease).patch(renew_lease),
        )
        .route("/api/sessions/{id}/input", post(input_session))
        .route("/api/sessions/{id}/resize", post(resize_session))
        .route("/api/sessions/{id}/interrupt", post(interrupt_session))
        .route("/api/sessions/{id}/close", post(close_session))
        .with_state(state)
}

async fn mobile_page() -> Html<&'static str> {
    Html(MOBILE_PAGE)
}

async fn xterm_js() -> impl IntoResponse {
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/javascript; charset=utf-8",
        )],
        XTERM_JS,
    )
}

async fn xterm_css() -> impl IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "text/css; charset=utf-8")],
        XTERM_CSS,
    )
}

async fn xterm_addon_fit_js() -> impl IntoResponse {
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/javascript; charset=utf-8",
        )],
        XTERM_ADDON_FIT_JS,
    )
}

async fn list_projects(
    State(state): State<RemoteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Response {
    if let Err(response) = authorize(&state, peer, &headers, query.token.as_deref(), "projects") {
        return response;
    }
    match state.app.projects.list() {
        Ok(projects) => Json(serde_json::json!({ "projects": projects })).into_response(),
        Err(error) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    }
}

async fn list_sessions(
    State(state): State<RemoteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Response {
    if let Err(response) = authorize(&state, peer, &headers, query.token.as_deref(), "sessions") {
        return response;
    }
    Json(serde_json::json!({ "sessions": state.manager.list() })).into_response()
}

async fn create_session(
    State(state): State<RemoteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<CreateSessionRequest>,
) -> Response {
    if let Err(response) = authorize(
        &state,
        peer,
        &headers,
        query.token.as_deref(),
        "session.create",
    ) {
        return response;
    }
    if request.client_id.trim().is_empty() || request.client_id.len() > 128 {
        return api_error(StatusCode::BAD_REQUEST, "Invalid client id");
    }

    let project = match state.app.projects.get(&request.project_id) {
        Ok(project) => project,
        Err(_) => return api_error(StatusCode::NOT_FOUND, "Project not found"),
    };
    let profile = match project
        .default_profile_id
        .as_deref()
        .map(|profile_id| state.app.profiles.get(profile_id))
        .transpose()
    {
        Ok(Some(profile)) if profile.project_id == project.id => profile,
        Ok(Some(_)) | Ok(None) => match state.app.profiles.list_for_project(&project.id) {
            Ok(profiles) => match profiles
                .iter()
                .find(|profile| profile.is_default)
                .cloned()
                .or_else(|| profiles.into_iter().next())
            {
                Some(profile) => profile,
                None => return api_error(StatusCode::BAD_REQUEST, "Project has no profiles"),
            },
            Err(error) => return api_error(StatusCode::BAD_REQUEST, &error.to_string()),
        },
        Err(error) => return api_error(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    let create_request = CreateTerminalRequest {
        project_id: project.id.clone(),
        profile_id: profile.id,
        rows: 24,
        cols: 80,
        scrollback_megabytes: Some(4),
    };

    match create_terminal_inner(&state.app, &state.terminal, create_request).await {
        Ok(session_id) => {
            audit(
                &state,
                peer,
                &request.client_id,
                &session_id,
                "session.create",
                true,
            );
            (
                StatusCode::CREATED,
                Json(serde_json::json!({ "sessionId": session_id })),
            )
                .into_response()
        }
        Err(error) => {
            audit(
                &state,
                peer,
                &request.client_id,
                &project.id,
                "session.create",
                false,
            );
            api_error(StatusCode::BAD_REQUEST, &error.to_string())
        }
    }
}

async fn get_session(
    State(state): State<RemoteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Response {
    if let Err(response) = authorize(&state, peer, &headers, query.token.as_deref(), "session") {
        return response;
    }
    match state.manager.info(&session_id) {
        Ok(session) => Json(session).into_response(),
        Err(_) => api_error(StatusCode::NOT_FOUND, "Session not found"),
    }
}

async fn acquire_lease(
    State(state): State<RemoteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<LeaseRequest>,
) -> Response {
    if let Err(response) = authorize(
        &state,
        peer,
        &headers,
        query.token.as_deref(),
        "lease.acquire",
    ) {
        return response;
    }
    if state.manager.info(&session_id).is_err() {
        return api_error(StatusCode::NOT_FOUND, "Session not found");
    }
    if request.read_only {
        audit(
            &state,
            peer,
            &request.client_id,
            &session_id,
            "read_only.attach",
            true,
        );
        return Json(serde_json::json!({ "mode": "read-only" })).into_response();
    }
    match acquire_control(&state, &session_id, &request.client_id) {
        Ok(lease) => {
            audit(
                &state,
                peer,
                &request.client_id,
                &session_id,
                "lease.acquire",
                true,
            );
            Json(lease).into_response()
        }
        Err(response) => {
            audit(
                &state,
                peer,
                &request.client_id,
                &session_id,
                "lease.acquire",
                false,
            );
            response
        }
    }
}

async fn renew_lease(
    State(state): State<RemoteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<LeaseAction>,
) -> Response {
    if let Err(response) = authorize(
        &state,
        peer,
        &headers,
        query.token.as_deref(),
        "lease.renew",
    ) {
        return response;
    }
    match validate_lease(
        &state,
        &session_id,
        &request.client_id,
        &request.lease_id,
        true,
    ) {
        Ok(lease) => Json(lease).into_response(),
        Err(response) => response,
    }
}

async fn release_lease(
    State(state): State<RemoteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<LeaseAction>,
) -> Response {
    if let Err(response) = authorize(
        &state,
        peer,
        &headers,
        query.token.as_deref(),
        "lease.release",
    ) {
        return response;
    }
    release_control(
        &state,
        &session_id,
        &request.client_id,
        Some(&request.lease_id),
    );
    audit(
        &state,
        peer,
        &request.client_id,
        &session_id,
        "lease.release",
        true,
    );
    StatusCode::NO_CONTENT.into_response()
}

async fn input_session(
    State(state): State<RemoteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<InputRequest>,
) -> Response {
    if let Err(response) = authorize(&state, peer, &headers, query.token.as_deref(), "input") {
        return response;
    }
    if let Err(response) = validate_lease(
        &state,
        &session_id,
        &request.client_id,
        &request.lease_id,
        true,
    ) {
        return response;
    }
    match state.manager.write(&session_id, request.data.as_bytes()) {
        Ok(()) => {
            audit(&state, peer, &request.client_id, &session_id, "input", true);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => {
            audit(
                &state,
                peer,
                &request.client_id,
                &session_id,
                "input",
                false,
            );
            api_error(StatusCode::NOT_FOUND, &error.to_string())
        }
    }
}

async fn resize_session(
    State(state): State<RemoteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<ResizeRequest>,
) -> Response {
    if let Err(response) = authorize(&state, peer, &headers, query.token.as_deref(), "resize") {
        return response;
    }
    if let Err(response) = validate_lease(
        &state,
        &session_id,
        &request.client_id,
        &request.lease_id,
        true,
    ) {
        return response;
    }
    match state
        .manager
        .resize(&session_id, request.rows, request.cols)
    {
        Ok(()) => {
            audit(
                &state,
                peer,
                &request.client_id,
                &session_id,
                "resize",
                true,
            );
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => {
            audit(
                &state,
                peer,
                &request.client_id,
                &session_id,
                "resize",
                false,
            );
            api_error(StatusCode::NOT_FOUND, &error.to_string())
        }
    }
}

async fn interrupt_session(
    State(state): State<RemoteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<SensitiveRequest>,
) -> Response {
    sensitive_action(
        state,
        peer,
        session_id,
        headers,
        query,
        request,
        "interrupt",
        |state, id| state.manager.write(id, b"\x03"),
    )
}

async fn close_session(
    State(state): State<RemoteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<SensitiveRequest>,
) -> Response {
    sensitive_action(
        state,
        peer,
        session_id,
        headers,
        query,
        request,
        "close",
        |state, id| state.manager.close(id),
    )
}

#[allow(clippy::too_many_arguments)]
fn sensitive_action(
    state: RemoteState,
    peer: SocketAddr,
    session_id: String,
    headers: HeaderMap,
    query: AuthQuery,
    request: SensitiveRequest,
    action: &str,
    operation: impl FnOnce(&RemoteState, &str) -> crate::error::AppResult<()>,
) -> Response {
    if let Err(response) = authorize(&state, peer, &headers, query.token.as_deref(), action) {
        return response;
    }
    if !request.confirm {
        return api_error(
            StatusCode::PRECONDITION_REQUIRED,
            "Sensitive action requires confirm=true",
        );
    }
    if let Err(response) = validate_lease(
        &state,
        &session_id,
        &request.client_id,
        &request.lease_id,
        true,
    ) {
        return response;
    }
    let result = operation(&state, &session_id);
    audit(
        &state,
        peer,
        &request.client_id,
        &session_id,
        action,
        result.is_ok(),
    );
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => api_error(StatusCode::NOT_FOUND, &error.to_string()),
    }
}

async fn attach_session(
    ws: WebSocketUpgrade,
    State(state): State<RemoteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<AttachQuery>,
) -> Response {
    if let Err(response) = authorize(
        &state,
        peer,
        &headers,
        query.token.as_deref(),
        "websocket.attach",
    ) {
        return response;
    }
    if state.manager.info(&session_id).is_err() {
        return api_error(StatusCode::NOT_FOUND, "Session not found");
    }
    ws.on_upgrade(move |socket| websocket_loop(socket, state, peer, session_id, query))
        .into_response()
}

async fn websocket_loop(
    socket: WebSocket,
    state: RemoteState,
    peer: SocketAddr,
    session_id: String,
    query: AttachQuery,
) {
    let attachment_id = format!("remote-{}", uuid::Uuid::new_v4());
    let Ok((session, subscription)) = state.manager.attach(
        &session_id,
        attachment_id.clone(),
        crate::terminal::scrollback::ScrollbackSnapshotFormat::Flat,
    ) else {
        return;
    };
    audit(
        &state,
        peer,
        &query.client_id,
        &session_id,
        if query.read_only {
            "ws.read_only"
        } else {
            "ws.attach"
        },
        true,
    );
    let snapshot = base64::engine::general_purpose::STANDARD.encode(subscription.snapshot.bytes);
    let (mut sender, mut receiver) = socket.split();
    if send_ws_json(
        &mut sender,
        &serde_json::json!({
            "type": "snapshot",
            "session": session,
            "data": snapshot,
            "truncated": subscription.snapshot.truncated,
            "readOnly": query.read_only,
        }),
    )
    .await
    .is_err()
    {
        return;
    }
    let mut output = subscription.receiver;
    let mut message_times = VecDeque::new();
    loop {
        tokio::select! {
            remote_output = output.recv() => {
                match remote_output {
                    Ok(event) => {
                        // Base64 happens here rather than on the broadcast bus,
                        // so a desktop-only session never pays for it.
                        let event = crate::terminal::TerminalOutput::from_event(&event);
                        if send_ws_json(&mut sender, &serde_json::json!({
                            "type": "output",
                            "event": event,
                        })).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = receiver.next() => {
                let Some(Ok(message)) = incoming else { break };
                if !allow_ws_message(&mut message_times) {
                    let _ = send_ws_json(&mut sender, &serde_json::json!({
                        "type": "error", "message": "WebSocket rate limit exceeded"
                    })).await;
                    continue;
                }
                if let Message::Text(text) = message {
                    let Ok(message) = serde_json::from_str::<WsClientMessage>(&text) else {
                        continue;
                    };
                    let response = handle_ws_message(
                        &state,
                        peer,
                        &session_id,
                        &query.client_id,
                        query.read_only,
                        message,
                    );
                    if send_ws_json(&mut sender, &response).await.is_err() {
                        break;
                    }
                }
            }
        }
    }
    let _ = state.manager.detach(&session_id, &attachment_id);
    release_control(&state, &session_id, &query.client_id, None);
    audit(
        &state,
        peer,
        &query.client_id,
        &session_id,
        "ws.detach",
        true,
    );
}

fn handle_ws_message(
    state: &RemoteState,
    peer: SocketAddr,
    session_id: &str,
    client_id: &str,
    read_only: bool,
    message: WsClientMessage,
) -> serde_json::Value {
    if read_only {
        return serde_json::json!({ "type": "error", "message": "Client is read-only" });
    }
    match message {
        WsClientMessage::Acquire => match acquire_control(state, session_id, client_id) {
            Ok(lease) => serde_json::json!({ "type": "lease", "lease": lease }),
            Err(_) => {
                serde_json::json!({ "type": "error", "message": "Control is held by another client" })
            }
        },
        WsClientMessage::Renew { lease_id } => {
            match validate_lease(state, session_id, client_id, &lease_id, true) {
                Ok(lease) => serde_json::json!({ "type": "lease", "lease": lease }),
                Err(_) => serde_json::json!({ "type": "error", "message": "Lease expired" }),
            }
        }
        WsClientMessage::Release { lease_id } => {
            release_control(state, session_id, client_id, Some(&lease_id));
            serde_json::json!({ "type": "released" })
        }
        WsClientMessage::Input { lease_id, data } => {
            if validate_lease(state, session_id, client_id, &lease_id, true).is_err() {
                return serde_json::json!({ "type": "error", "message": "A control lease is required" });
            }
            let ok = state.manager.write(session_id, data.as_bytes()).is_ok();
            serde_json::json!({ "type": "ack", "action": "input", "ok": ok })
        }
        WsClientMessage::Resize {
            lease_id,
            rows,
            cols,
        } => {
            if validate_lease(state, session_id, client_id, &lease_id, true).is_err() {
                return serde_json::json!({ "type": "error", "message": "A control lease is required" });
            }
            let ok = state.manager.resize(session_id, rows, cols).is_ok();
            serde_json::json!({ "type": "ack", "action": "resize", "ok": ok })
        }
        WsClientMessage::Interrupt { lease_id, confirm } => {
            if !confirm || validate_lease(state, session_id, client_id, &lease_id, true).is_err() {
                return serde_json::json!({ "type": "error", "message": "Confirmation and a control lease are required" });
            }
            let ok = state.manager.write(session_id, b"\x03").is_ok();
            audit(state, peer, client_id, session_id, "ws.interrupt", ok);
            serde_json::json!({ "type": "ack", "action": "interrupt", "ok": ok })
        }
    }
}

// Axum handlers return the framework Response directly on authorization
// failure; boxing it would only add allocation and unboxing at every caller.
#[allow(clippy::result_large_err)]
fn authorize(
    state: &RemoteState,
    peer: SocketAddr,
    headers: &HeaderMap,
    query_token: Option<&str>,
    action: &str,
) -> Result<(), Response> {
    if !allow_request(state, peer.ip()) {
        audit(state, peer, "-", "-", action, false);
        return Err(api_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Rate limit exceeded",
        ));
    }
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let supplied = bearer.or(query_token).unwrap_or_default();
    if !constant_time_eq(supplied.as_bytes(), state.token.as_bytes()) {
        audit(state, peer, "-", "-", action, false);
        return Err(api_error(StatusCode::UNAUTHORIZED, "Unauthorized"));
    }
    Ok(())
}

#[allow(clippy::result_large_err)]
fn acquire_control(
    state: &RemoteState,
    session_id: &str,
    client_id: &str,
) -> Result<LeaseResponse, Response> {
    let mut leases = state.leases.lock();
    if let Some(existing) = leases.get(session_id) {
        if existing.expires_at > Instant::now() && existing.client_id != client_id {
            return Err(api_error(
                StatusCode::CONFLICT,
                "Control is held by another client",
            ));
        }
    }
    let lease = LeaseRecord {
        lease_id: uuid::Uuid::new_v4().to_string(),
        client_id: client_id.into(),
        expires_at: Instant::now() + LEASE_TTL,
    };
    let response = lease_response(&lease);
    leases.insert(session_id.into(), lease);
    Ok(response)
}

#[allow(clippy::result_large_err)]
fn validate_lease(
    state: &RemoteState,
    session_id: &str,
    client_id: &str,
    lease_id: &str,
    renew: bool,
) -> Result<LeaseResponse, Response> {
    let mut leases = state.leases.lock();
    let Some(lease) = leases.get_mut(session_id) else {
        return Err(api_error(StatusCode::LOCKED, "A control lease is required"));
    };
    if lease.expires_at <= Instant::now()
        || lease.client_id != client_id
        || lease.lease_id != lease_id
    {
        leases.remove(session_id);
        return Err(api_error(StatusCode::LOCKED, "Control lease expired"));
    }
    if renew {
        lease.expires_at = Instant::now() + LEASE_TTL;
    }
    Ok(lease_response(lease))
}

fn release_control(state: &RemoteState, session_id: &str, client_id: &str, lease_id: Option<&str>) {
    let mut leases = state.leases.lock();
    let remove = leases
        .get(session_id)
        .map(|lease| {
            lease.client_id == client_id
                && lease_id
                    .map(|lease_id| lease.lease_id == lease_id)
                    .unwrap_or(true)
        })
        .unwrap_or(false);
    if remove {
        leases.remove(session_id);
    }
}

fn lease_response(lease: &LeaseRecord) -> LeaseResponse {
    LeaseResponse {
        lease_id: lease.lease_id.clone(),
        client_id: lease.client_id.clone(),
        expires_in_seconds: lease
            .expires_at
            .saturating_duration_since(Instant::now())
            .as_secs(),
    }
}

fn allow_request(state: &RemoteState, ip: IpAddr) -> bool {
    let now = Instant::now();
    let mut limits = state.rate_limits.lock();
    let times = limits.entry(ip).or_default();
    while times
        .front()
        .is_some_and(|time| now.duration_since(*time) >= Duration::from_secs(60))
    {
        times.pop_front();
    }
    if times.len() >= REQUESTS_PER_MINUTE {
        return false;
    }
    times.push_back(now);
    true
}

fn allow_ws_message(times: &mut VecDeque<Instant>) -> bool {
    let now = Instant::now();
    while times
        .front()
        .is_some_and(|time| now.duration_since(*time) >= Duration::from_secs(1))
    {
        times.pop_front();
    }
    if times.len() >= WS_MESSAGES_PER_SECOND {
        return false;
    }
    times.push_back(now);
    true
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

fn audit(
    state: &RemoteState,
    peer: SocketAddr,
    client_id: &str,
    session_id: &str,
    action: &str,
    success: bool,
) {
    let entry = serde_json::json!({
        "timestamp": Utc::now(),
        "remoteAddress": peer.ip(),
        "clientId": client_id,
        "sessionId": session_id,
        "action": action,
        "success": success,
    });
    let _guard = state.audit_lock.lock();
    if let Some(parent) = state.audit_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&state.audit_path)
    {
        let _ = writeln!(file, "{entry}");
    }
}

async fn send_ws_json<S>(sender: &mut S, value: &serde_json::Value) -> Result<(), axum::Error>
where
    S: futures_util::Sink<Message, Error = axum::Error> + Unpin,
{
    sender.send(Message::Text(value.to_string().into())).await
}

/// Persisted remote-access preference, written by the Settings UI toggle.
/// `enabled` defaults to `true` so existing installations keep the gateway on
/// until the user explicitly turns it off; the env var
/// `PROJECT_TERMINAL_REMOTE_DISABLED=1` is a hard override that always wins.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RemoteConfig {
    #[serde(default = "default_remote_enabled")]
    enabled: bool,
    #[serde(default)]
    allow_lan: bool,
}

fn default_remote_enabled() -> bool {
    true
}

impl Default for RemoteConfig {
    fn default() -> Self {
        RemoteConfig {
            enabled: true,
            allow_lan: false,
        }
    }
}

fn read_remote_config(path: &std::path::Path) -> RemoteConfig {
    crate::storage::read_or_default(path, RemoteConfig::default()).unwrap_or_default()
}

fn write_remote_config(path: &std::path::Path, config: &RemoteConfig) -> AppResult<()> {
    crate::storage::write_json(path, config)
}

/// Resolve the bind address and transport-security label for the given mode.
/// `REMOTE_BIND` (if set) forces a specific address and overrides the
/// mode-driven default; the security gate still refuses an insecure address
/// that no flag authorizes.
fn compute_bind_and_security(allow_lan: bool) -> (SocketAddr, &'static str) {
    let default_bind = if allow_lan {
        "0.0.0.0:4097"
    } else {
        DEFAULT_BIND
    };
    let requested =
        std::env::var("PROJECT_TERMINAL_REMOTE_BIND").unwrap_or_else(|_| default_bind.into());
    let mut bind = requested
        .parse::<SocketAddr>()
        .unwrap_or_else(|_| DEFAULT_BIND.parse().expect("valid default remote bind"));
    let tls_terminated = std::env::var("PROJECT_TERMINAL_TLS_TERMINATED").as_deref() == Ok("1");
    if !bind.ip().is_loopback() && !is_tailscale_ip(bind.ip()) && !tls_terminated && !allow_lan {
        tracing::warn!(
            "Refusing insecure non-loopback remote bind {bind}; use a Tailscale address, set PROJECT_TERMINAL_TLS_TERMINATED=1 behind HTTPS, or enable LAN access in Settings"
        );
        bind = DEFAULT_BIND.parse().expect("valid default remote bind");
    }
    let transport_security = if bind.ip().is_loopback() {
        "loopback"
    } else if is_tailscale_ip(bind.ip()) {
        "tailscale"
    } else if allow_lan {
        "lan"
    } else {
        "tls-terminated"
    };
    (bind, transport_security)
}

fn compute_advertise_url(bind: SocketAddr) -> String {
    if let Ok(url) = std::env::var("PROJECT_TERMINAL_REMOTE_URL") {
        let url = url.trim().trim_end_matches('/');
        if url.starts_with("http://") || url.starts_with("https://") {
            return url.to_string();
        }
        tracing::warn!("Ignoring PROJECT_TERMINAL_REMOTE_URL because it is not an http(s) URL");
    }
    let advertise_ip = if bind.ip().is_unspecified() {
        detect_lan_ip().unwrap_or_else(|| bind.ip())
    } else {
        bind.ip()
    };
    let host = match advertise_ip {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    };
    // The gateway listener itself remains HTTP even when TLS is terminated by
    // a reverse proxy. Set PROJECT_TERMINAL_REMOTE_URL to advertise the
    // proxy's external HTTPS URL instead of this direct listener address.
    format!("http://{host}:{}", bind.port())
}

/// Bind with a short retry so a rapid 0.0.0.0 <-> 127.0.0.1 toggle does not
/// race the previous socket releasing the port.
async fn bind_with_retry(bind: SocketAddr) -> std::io::Result<tokio::net::TcpListener> {
    let mut last_err = None;
    for _ in 0..5 {
        match tokio::net::TcpListener::bind(bind).await {
            Ok(listener) => return Ok(listener),
            Err(error) => {
                last_err = Some(error);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
    Err(last_err.expect("bind_with_retry attempts at least once"))
}

/// Best-effort detection of this host's primary outbound IP. Opens a UDP
/// socket "connected" to a public address; the kernel resolves the route and
/// reports the source IP it would use, without sending any packet. Returns
/// `None` when there is no usable route (e.g. fully offline).
fn detect_lan_ip() -> Option<IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket.local_addr().ok().map(|addr| addr.ip())
}

fn api_error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

fn is_tailscale_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            octets[0] == 100 && (64..=127).contains(&octets[1])
        }
        IpAddr::V6(_) => false,
    }
}

const XTERM_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/xterm.js"));
const XTERM_CSS: &str = include_str!(concat!(env!("OUT_DIR"), "/xterm.css"));
const XTERM_ADDON_FIT_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/xterm-addon-fit.js"));

const MOBILE_PAGE: &str = include_str!("remote_page.html");

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{default_local_profile, ProfileRepository, ShellType, TemplateRepository};
    use crate::project::{LocalProjectConfig, Project, ProjectRepository, ProjectType};
    use crate::ssh::SshConnectionRepository;
    use crate::terminal::SessionSpawn;
    use std::net::Ipv4Addr;

    fn test_app_state(dirs: &ConfigDirs) -> AppState {
        AppState::from_repositories(
            ProjectRepository::new(dirs.projects_path()),
            ProfileRepository::new(dirs.profiles_path()),
            TemplateRepository::new(dirs.templates_path()),
            SshConnectionRepository::new(dirs.ssh_connections_path()),
        )
    }

    fn test_remote_state(dirs: &ConfigDirs) -> RemoteState {
        let terminal = TerminalState::new();
        RemoteState {
            manager: terminal.manager.clone_handle(),
            app: test_app_state(dirs),
            terminal,
            token: "secret".into(),
            leases: Arc::new(Mutex::new(HashMap::new())),
            rate_limits: Arc::new(Mutex::new(HashMap::new())),
            audit_path: dirs.remote_audit_path(),
            audit_lock: Arc::new(Mutex::new(())),
        }
    }

    #[test]
    fn token_comparison_and_tailscale_detection_are_strict() {
        assert!(constant_time_eq(b"secret", b"secret"));
        assert!(!constant_time_eq(b"secret", b"secreu"));
        assert!(!constant_time_eq(b"short", b"longer"));
        assert!(is_tailscale_ip(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))));
        assert!(is_tailscale_ip(IpAddr::V4(Ipv4Addr::new(100, 127, 1, 1))));
        assert!(!is_tailscale_ip(IpAddr::V4(Ipv4Addr::new(100, 128, 0, 1))));
    }

    #[test]
    fn websocket_rate_limit_is_bounded() {
        let mut times = VecDeque::new();
        for _ in 0..WS_MESSAGES_PER_SECOND {
            assert!(allow_ws_message(&mut times));
        }
        assert!(!allow_ws_message(&mut times));
    }

    #[test]
    fn control_lease_is_exclusive_and_releasable() {
        let dirs = ConfigDirs::from_root(
            std::env::temp_dir().join(format!("pt-remote-{}", uuid::Uuid::new_v4())),
        );
        let state = test_remote_state(&dirs);
        let first = acquire_control(&state, "session-1", "phone-a").unwrap();
        assert!(acquire_control(&state, "session-1", "phone-b").is_err());
        release_control(&state, "session-1", "phone-a", Some(&first.lease_id));
        assert!(acquire_control(&state, "session-1", "phone-b").is_ok());
    }

    #[test]
    fn lease_renewal_keeps_the_same_control_identity() {
        let dirs = ConfigDirs::from_root(
            std::env::temp_dir().join(format!("pt-remote-{}", uuid::Uuid::new_v4())),
        );
        let state = test_remote_state(&dirs);
        let first = acquire_control(&state, "session-1", "phone-a").unwrap();
        let renewed =
            validate_lease(&state, "session-1", "phone-a", &first.lease_id, true).unwrap();

        assert_eq!(renewed.lease_id, first.lease_id);
        assert_eq!(renewed.client_id, "phone-a");
        assert!(renewed.expires_in_seconds > 0);
    }

    #[test]
    fn mobile_page_includes_resilient_control_protocol() {
        assert!(MOBILE_PAGE.contains("CONTROL_RENEW_MS"));
        assert!(MOBILE_PAGE.contains(r#"type: "resize", lease_id: leaseId"#));
        assert!(MOBILE_PAGE.contains("crypto.randomUUID"));
        assert!(MOBILE_PAGE.contains("crypto.getRandomValues"));
        assert!(MOBILE_PAGE.contains(r#"type: "release", lease_id: leaseId"#));
        assert!(MOBILE_PAGE.contains(r#"if (!isReadOnly()) send({ type: "acquire" });"#));
        assert!(MOBILE_PAGE.contains(r#"method: "POST""#));
        assert!(MOBILE_PAGE.contains(r#"id="newTerminal""#));
        assert!(!MOBILE_PAGE.contains(r#"id="takeControl""#));
        assert!(!MOBILE_PAGE.contains(r#"id="inputForm""#));
    }

    #[tokio::test]
    async fn authenticated_mobile_client_can_create_a_project_terminal() {
        let root = std::env::temp_dir().join(format!("pt-remote-create-{}", uuid::Uuid::new_v4()));
        let dirs = ConfigDirs::from_root(root.clone());
        dirs.ensure_root().unwrap();
        let app = test_app_state(&dirs);
        let project_id = "project-mobile".to_string();
        let profile_id = "profile-mobile".to_string();
        let now = Utc::now();
        app.projects
            .upsert(Project {
                id: project_id.clone(),
                name: "Mobile project".into(),
                project_type: ProjectType::Local,
                local: Some(LocalProjectConfig {
                    path: root.to_string_lossy().into_owned(),
                }),
                ssh: None,
                wsl: None,
                default_profile_id: Some(profile_id.clone()),
                created_at: now,
                updated_at: now,
            })
            .unwrap();
        // Use the platform's lightweight system shell explicitly. The host
        // default may be PowerShell, whose startup time becomes nondeterministic
        // when the full PTY-heavy test suite runs in parallel.
        let mut profile = default_local_profile(profile_id, project_id.clone());
        if cfg!(windows) {
            profile.shell_type = ShellType::Cmd;
            profile.shell_executable = Some("cmd.exe".into());
        } else {
            profile.shell_type = ShellType::Sh;
            profile.shell_executable = Some("/bin/sh".into());
        }
        app.profiles.upsert(profile).unwrap();
        let terminal = TerminalState::new();
        let state = RemoteState {
            manager: terminal.manager.clone_handle(),
            app,
            terminal: terminal.clone(),
            token: "secret".into(),
            leases: Arc::new(Mutex::new(HashMap::new())),
            rate_limits: Arc::new(Mutex::new(HashMap::new())),
            audit_path: dirs.remote_audit_path(),
            audit_lock: Arc::new(Mutex::new(())),
        };

        let response = create_session(
            State(state),
            ConnectInfo("127.0.0.1:4100".parse().unwrap()),
            HeaderMap::new(),
            Query(AuthQuery {
                token: Some("secret".into()),
            }),
            Json(CreateSessionRequest {
                project_id: project_id.clone(),
                client_id: "phone-test".into(),
            }),
        )
        .await;

        assert_eq!(response.status(), StatusCode::CREATED);
        let sessions = terminal.manager.list();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].project_id, project_id);
        terminal.manager.close_all();
    }

    #[test]
    fn gateway_reads_sessions_from_the_desktop_manager() {
        let dirs = ConfigDirs::from_root(
            std::env::temp_dir().join(format!("pt-remote-{}", uuid::Uuid::new_v4())),
        );
        let terminal = TerminalState::new();
        let desktop_manager = terminal.manager.clone_handle();
        let gateway = RemoteGateway::new(&dirs, test_app_state(&dirs), terminal);
        let session_id = format!("remote-visible-{}", uuid::Uuid::new_v4());
        let created = desktop_manager
            .create(SessionSpawn {
                session_id: session_id.clone(),
                project_id: "project-visible".into(),
                profile_id: "profile-visible".into(),
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
                readiness_marker: None,
                rows: 24,
                cols: 80,
                scrollback_bytes: 64 * 1024,
            })
            .unwrap();

        assert_eq!(created, session_id);
        let sessions = gateway.manager.list();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, session_id);
        assert_eq!(sessions[0].project_id, "project-visible");

        desktop_manager.close_all();
    }
}
