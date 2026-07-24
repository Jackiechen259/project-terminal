use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
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
use tokio::sync::broadcast;

use super::DaemonServer;
use crate::config_dirs::ConfigDirs;

const DEFAULT_BIND: &str = "127.0.0.1:4097";
const LEASE_TTL: Duration = Duration::from_secs(30);
const REQUESTS_PER_MINUTE: usize = 180;
const WS_MESSAGES_PER_SECOND: usize = 60;

pub(super) struct RemoteGateway {
    token: String,
    bind: SocketAddr,
    enabled: bool,
    started: AtomicBool,
    audit_path: PathBuf,
}

impl RemoteGateway {
    pub(super) fn new(dirs: &ConfigDirs) -> Self {
        let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4()).replace('-', "");
        let requested =
            std::env::var("PROJECT_TERMINAL_REMOTE_BIND").unwrap_or_else(|_| DEFAULT_BIND.into());
        let mut bind = requested
            .parse::<SocketAddr>()
            .unwrap_or_else(|_| DEFAULT_BIND.parse().expect("valid default remote bind"));
        if !bind.ip().is_loopback()
            && !is_tailscale_ip(bind.ip())
            && std::env::var("PROJECT_TERMINAL_TLS_TERMINATED").as_deref() != Ok("1")
        {
            tracing::warn!(
                "Refusing insecure non-loopback remote bind {bind}; use a Tailscale address or set PROJECT_TERMINAL_TLS_TERMINATED=1 behind HTTPS"
            );
            bind = DEFAULT_BIND.parse().expect("valid default remote bind");
        }
        Self {
            token,
            bind,
            enabled: std::env::var("PROJECT_TERMINAL_REMOTE_DISABLED").as_deref() != Ok("1"),
            started: AtomicBool::new(false),
            audit_path: dirs.remote_audit_path(),
        }
    }

    pub(super) fn info(&self) -> serde_json::Value {
        serde_json::json!({
            "enabled": self.enabled,
            "bind": self.bind,
            "url": format!("http://{}", self.bind),
            // Returned only over the local Named Pipe / Unix Socket. It is
            // intentionally never persisted or included in an audit record.
            "token": self.token,
            "transportSecurity": if self.bind.ip().is_loopback() {
                "loopback"
            } else if is_tailscale_ip(self.bind.ip()) {
                "tailscale"
            } else {
                "tls-terminated"
            },
        })
    }

    pub(super) fn start(&self, daemon: Arc<DaemonServer>) {
        if !self.enabled || self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let bind = self.bind;
        let state = RemoteState {
            daemon,
            token: self.token.clone(),
            leases: Arc::new(Mutex::new(HashMap::new())),
            rate_limits: Arc::new(Mutex::new(HashMap::new())),
            audit_path: self.audit_path.clone(),
            audit_lock: Arc::new(Mutex::new(())),
        };
        tokio::spawn(async move {
            let router = build_router(state);
            match tokio::net::TcpListener::bind(bind).await {
                Ok(listener) => {
                    tracing::info!("Remote gateway listening on {bind}");
                    if let Err(error) = axum::serve(
                        listener,
                        router.into_make_service_with_connect_info::<SocketAddr>(),
                    )
                    .await
                    {
                        tracing::error!("Remote gateway failed: {error}");
                    }
                }
                Err(error) => tracing::error!("Could not bind remote gateway {bind}: {error}"),
            }
        });
    }
}

#[derive(Clone)]
struct RemoteState {
    daemon: Arc<DaemonServer>,
    token: String,
    leases: Arc<Mutex<HashMap<String, LeaseRecord>>>,
    rate_limits: Arc<Mutex<HashMap<IpAddr, VecDeque<Instant>>>>,
    audit_path: PathBuf,
    audit_lock: Arc<Mutex<()>>,
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
        .route("/api/projects", get(list_projects))
        .route("/api/sessions", get(list_sessions))
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

async fn list_projects(
    State(state): State<RemoteState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Response {
    if let Err(response) = authorize(&state, peer, &headers, query.token.as_deref(), "projects") {
        return response;
    }
    let dirs = match ConfigDirs::resolve() {
        Ok(dirs) => dirs,
        Err(error) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    };
    let value = std::fs::read(dirs.projects_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .unwrap_or_else(|| serde_json::json!({ "projects": [] }));
    Json(value).into_response()
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
    Json(serde_json::json!({ "sessions": state.daemon.manager.list() })).into_response()
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
    match state.daemon.manager.info(&session_id) {
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
    if state.daemon.manager.info(&session_id).is_err() {
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
    match state
        .daemon
        .manager
        .write(&session_id, request.data.as_bytes())
    {
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
        .daemon
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
        |state, id| state.daemon.manager.write(id, b"\x03"),
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
        |state, id| {
            state.daemon.manager.close(id)?;
            state.daemon.persist()
        },
    )
}

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
    if state.daemon.manager.info(&session_id).is_err() {
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
    let Ok((session, subscription)) = state
        .daemon
        .manager
        .attach(&session_id, attachment_id.clone())
    else {
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
    let _ = state.daemon.manager.detach(&session_id, &attachment_id);
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
            let ok = state
                .daemon
                .manager
                .write(session_id, data.as_bytes())
                .is_ok();
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
            let ok = state.daemon.manager.resize(session_id, rows, cols).is_ok();
            serde_json::json!({ "type": "ack", "action": "resize", "ok": ok })
        }
        WsClientMessage::Interrupt { lease_id, confirm } => {
            if !confirm || validate_lease(state, session_id, client_id, &lease_id, true).is_err() {
                return serde_json::json!({ "type": "error", "message": "Confirmation and a control lease are required" });
            }
            let ok = state.daemon.manager.write(session_id, b"\x03").is_ok();
            audit(state, peer, client_id, session_id, "ws.interrupt", ok);
            serde_json::json!({ "type": "ack", "action": "interrupt", "ok": ok })
        }
    }
}

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

const MOBILE_PAGE: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>Project Terminal Remote</title>
  <style>
    :root{color-scheme:dark;font:15px system-ui;background:#0c1017;color:#e5e7eb}
    *{box-sizing:border-box}body{margin:0;min-height:100dvh;display:flex;flex-direction:column}
    header,form,.bar{display:flex;gap:.5rem;padding:.75rem;background:#151b25;border-bottom:1px solid #293142}
    input,select,button{min-height:44px;border:1px solid #364153;border-radius:8px;background:#101620;color:inherit;padding:.6rem}
    input,select{flex:1;min-width:0}button{font-weight:600}button.primary{background:#2563eb}
    #terminal{flex:1;margin:0;padding:1rem;overflow:auto;white-space:pre-wrap;word-break:break-all;font:13px/1.35 ui-monospace,monospace}
    #status{font-size:.8rem;color:#93a4bd;padding:.4rem .75rem}.hidden{display:none}
    @media(max-width:560px){header,.bar,form{padding:.5rem}#terminal{padding:.65rem;font-size:12px}}
  </style>
</head>
<body>
  <header><input id="token" type="password" autocomplete="off" placeholder="Access token"><button id="connect" class="primary">Connect</button></header>
  <div class="bar"><select id="sessions"></select><label><input id="readonly" type="checkbox"> Read only</label><button id="take">Take control</button><button id="interrupt">Ctrl+C</button></div>
  <div id="status">Disconnected</div><pre id="terminal"></pre>
  <form id="inputForm"><input id="input" autocomplete="off" placeholder="Command or reply"><button class="primary">Send</button></form>
<script>
const $=id=>document.getElementById(id);let ws,lease,client=crypto.randomUUID();
function decode(v){try{return new TextDecoder().decode(Uint8Array.from(atob(v),c=>c.charCodeAt(0)))}catch{return""}}
async function api(path,options={}){let token=$("token").value;return fetch(path,{...options,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",...(options.headers||{})}})}
$("connect").onclick=async()=>{sessionStorage.token=$("token").value;let r=await api("/api/sessions");if(!r.ok){$("status").textContent="Unauthorized";return}let j=await r.json();$("sessions").innerHTML=j.sessions.map(s=>`<option value="${s.sessionId}">${s.projectId} · ${s.sessionId.slice(-8)}</option>`).join("");connectWs()}
function connectWs(){if(ws)ws.close();let id=$("sessions").value;if(!id)return;let q=new URLSearchParams({token:$("token").value,clientId:client,readOnly:$("readonly").checked});ws=new WebSocket(`${location.protocol==="https:"?"wss":"ws"}://${location.host}/api/sessions/${id}/attach?${q}`);ws.onopen=()=>$("status").textContent="Connected";ws.onclose=()=>{$("status").textContent="Disconnected";lease=null};ws.onmessage=e=>{let m=JSON.parse(e.data);if(m.type==="snapshot")$("terminal").textContent=decode(m.data);if(m.type==="output"&&m.event.data)$("terminal").textContent+=decode(m.event.data);if(m.type==="lease")lease=m.lease.leaseId;if(m.type==="error")$("status").textContent=m.message;$("terminal").scrollTop=$("terminal").scrollHeight}}
$("sessions").onchange=connectWs;$("take").onclick=()=>ws?.send(JSON.stringify({type:"acquire"}));$("interrupt").onclick=()=>{if(lease&&confirm("Send Ctrl+C?"))ws?.send(JSON.stringify({type:"interrupt",lease_id:lease,confirm:true}))}
$("inputForm").onsubmit=e=>{e.preventDefault();let v=$("input").value;if(ws&&lease&&v){ws.send(JSON.stringify({type:"input",lease_id:lease,data:v+"\\r"}));$("input").value=""}}
$("token").value=sessionStorage.token||"";
</script></body></html>"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

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
        let daemon = Arc::new(DaemonServer::new(&dirs));
        let state = RemoteState {
            daemon,
            token: "secret".into(),
            leases: Arc::new(Mutex::new(HashMap::new())),
            rate_limits: Arc::new(Mutex::new(HashMap::new())),
            audit_path: dirs.remote_audit_path(),
            audit_lock: Arc::new(Mutex::new(())),
        };
        let first = acquire_control(&state, "session-1", "phone-a").unwrap();
        assert!(acquire_control(&state, "session-1", "phone-b").is_err());
        release_control(&state, "session-1", "phone-a", Some(&first.lease_id));
        assert!(acquire_control(&state, "session-1", "phone-b").is_ok());
    }
}
