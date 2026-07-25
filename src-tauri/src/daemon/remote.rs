use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Weak};
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
use tokio::task::JoinHandle;

use super::DaemonServer;
use crate::config_dirs::ConfigDirs;
use crate::error::{AppError, AppResult};

const DEFAULT_BIND: &str = "127.0.0.1:4097";
const LEASE_TTL: Duration = Duration::from_secs(30);
const REQUESTS_PER_MINUTE: usize = 180;
const WS_MESSAGES_PER_SECOND: usize = 60;

pub(super) struct RemoteGateway {
    token: String,
    bind: Mutex<SocketAddr>,
    url: Mutex<String>,
    transport_security: Mutex<&'static str>,
    allow_lan: Mutex<bool>,
    config_path: PathBuf,
    audit_path: PathBuf,
    enabled: Mutex<bool>,
    daemon: Mutex<Weak<DaemonServer>>,
    listener_handle: Mutex<Option<JoinHandle<()>>>,
}

impl RemoteGateway {
    pub(super) fn new(dirs: &ConfigDirs) -> Self {
        let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4()).replace('-', "");
        let config_path = dirs.remote_config_path();
        let config = read_remote_config(&config_path);
        let allow_lan = config.allow_lan;
        // The env var is a hard override for locked-down hosts; the persisted
        // config otherwise decides whether the gateway accepts connections.
        let env_disabled =
            std::env::var("PROJECT_TERMINAL_REMOTE_DISABLED").as_deref() == Ok("1");
        let enabled = !env_disabled && config.enabled;
        let (bind, transport_security) = compute_bind_and_security(allow_lan);
        let url = compute_advertise_url(bind);
        Self {
            token,
            bind: Mutex::new(bind),
            url: Mutex::new(url),
            transport_security: Mutex::new(transport_security),
            allow_lan: Mutex::new(allow_lan),
            config_path,
            audit_path: dirs.remote_audit_path(),
            enabled: Mutex::new(enabled),
            daemon: Mutex::new(Weak::new()),
            listener_handle: Mutex::new(None),
        }
    }

    /// Store a back-reference to the owning daemon so the listener can be
    /// restarted without re-spawning the process. Called once after the
    /// `Arc<DaemonServer>` is constructed.
    pub(super) fn attach(&self, daemon: Weak<DaemonServer>) {
        *self.daemon.lock() = daemon;
    }

    pub(super) fn info(&self) -> serde_json::Value {
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

    pub(super) fn start(&self) {
        if !*self.enabled.lock() || self.listener_handle.lock().is_some() {
            return;
        }
        self.spawn_listener();
    }

    /// Switch the gateway between loopback-only and LAN-wide bind without
    /// restarting the daemon. Existing WebSocket clients drop (the address
    /// changed) and must re-scan; terminal sessions are unaffected.
    pub(super) fn reconfigure(&self, allow_lan: bool) -> AppResult<()> {
        if !*self.enabled.lock() {
            return Err(AppError::Configuration(
                "Remote access is disabled by the host".into(),
            ));
        }
        // Persist so the choice survives a daemon restart.
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

    /// Turn the entire remote gateway on or off without restarting the daemon.
    /// When disabled the listener is stopped and no remote connections are
    /// accepted; when re-enabled the listener starts on the stored bind. The
    /// host env var (`PROJECT_TERMINAL_REMOTE_DISABLED=1`) is a hard override
    /// and cannot be cleared from the UI.
    pub(super) fn set_enabled(&self, enabled: bool) -> AppResult<()> {
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
        let daemon = match self.daemon.lock().upgrade() {
            Some(arc) => arc,
            None => return,
        };
        let bind = *self.bind.lock();
        let state = RemoteState {
            daemon,
            token: self.token.clone(),
            leases: Arc::new(Mutex::new(HashMap::new())),
            rate_limits: Arc::new(Mutex::new(HashMap::new())),
            audit_path: self.audit_path.clone(),
            audit_lock: Arc::new(Mutex::new(())),
        };
        let handle = tokio::spawn(async move {
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
        .route("/xterm.js", get(xterm_js))
        .route("/xterm.css", get(xterm_css))
        .route("/xterm-addon-fit.js", get(xterm_addon_fit_js))
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

async fn xterm_js() -> impl IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
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
        [(axum::http::header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
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
    let requested = std::env::var("PROJECT_TERMINAL_REMOTE_BIND")
        .unwrap_or_else(|_| default_bind.into());
    let mut bind = requested
        .parse::<SocketAddr>()
        .unwrap_or_else(|_| DEFAULT_BIND.parse().expect("valid default remote bind"));
    let tls_terminated =
        std::env::var("PROJECT_TERMINAL_TLS_TERMINATED").as_deref() == Ok("1");
    if !bind.ip().is_loopback()
        && !is_tailscale_ip(bind.ip())
        && !tls_terminated
        && !allow_lan
    {
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
    let advertise_ip = if bind.ip().is_unspecified() {
        detect_lan_ip().unwrap_or_else(|| bind.ip())
    } else {
        bind.ip()
    };
    format!("http://{advertise_ip}:{}", bind.port())
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
const XTERM_ADDON_FIT_JS: &str =
    include_str!(concat!(env!("OUT_DIR"), "/xterm-addon-fit.js"));

const MOBILE_PAGE: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
  <title>Project Terminal Remote</title>
  <link rel="stylesheet" href="/xterm.css">
  <style>
    :root{color-scheme:dark;--bg:#0c1017;--panel:#151b25;--border:#293142;--input:#101620;--fg:#e5e7eb;--muted:#93a4bd;--accent:#2563eb;--danger:#f87171;--ok:#34d399}
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    html,body{height:100%}body{margin:0;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:15px system-ui}
    header{display:flex;gap:.5rem;padding:.6rem;background:var(--panel);border-bottom:1px solid var(--border);align-items:center}
    header input{flex:1;min-width:0}header.collapsed .bar-row{display:none}
    input,select,button{min-height:44px;border:1px solid #364153;border-radius:8px;background:var(--input);color:inherit;padding:.5rem .6rem;font:inherit}
    button{font-weight:600;cursor:pointer;border-color:#3b475c}button.primary{background:var(--accent);border-color:var(--accent)}button:active{opacity:.7}
    #status{font-size:.8rem;color:var(--muted);padding:.35rem .75rem;display:flex;align-items:center;gap:.4rem;background:var(--panel);border-bottom:1px solid var(--border)}
    #status .dot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex:none}#status.connecting .dot{background:#fbbf24}#status.connected .dot{background:var(--ok)}#status.error .dot{background:var(--danger)}
    #term-wrap{flex:1;min-height:0;position:relative;background:#000;overflow:hidden}
    #term-wrap .xterm{height:100%;padding:6px}
    #term-wrap .xterm-viewport{background:#000!important}
    .bar-row{display:flex;gap:.5rem;padding:.5rem .6rem;background:var(--panel);border-bottom:1px solid var(--border);align-items:center}
    .bar-row select{flex:1;min-width:0}.bar-row label{display:flex;align-items:center;gap:.3rem;font-size:.85rem;color:var(--muted);white-space:nowrap}
    #take,#interrupt{flex:none;padding:.4rem .6rem;min-height:36px;font-size:.85rem}
    form{display:flex;gap:.5rem;padding:.5rem .6rem;background:var(--panel);border-top:1px solid var(--border)}
    form input{flex:1;min-width:0}form button{flex:none}
    .overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:.75rem;padding:2rem;text-align:center;background:rgba(12,16,23,.92);z-index:10}
    .overlay h2{margin:0;font-size:1.1rem}.overlay p{margin:0;color:var(--muted);font-size:.9rem;line-height:1.5}
    .overlay button{min-width:140px}
    .hidden{display:none!important}
    @media(max-width:560px){header,.bar-row,form{padding:.4rem .5rem}#term-wrap .xterm{padding:4px}}
  </style>
</head>
<body>
  <header>
    <input id="token" type="password" autocomplete="off" placeholder="Access token">
    <button id="connect" class="primary">Connect</button>
  </header>
  <div class="bar-row">
    <select id="sessions"></select>
    <label><input id="readonly" type="checkbox"> Read only</label>
    <button id="take">Take control</button>
    <button id="interrupt">Ctrl+C</button>
  </div>
  <div id="status"><span class="dot"></span><span id="status-text">Disconnected</span></div>
  <div id="term-wrap">
    <div id="terminal"></div>
    <div id="overlay" class="overlay">
      <h2 id="overlay-title">Connecting</h2>
      <p id="overlay-msg"></p>
      <button id="overlay-btn" class="primary hidden">Retry</button>
    </div>
  </div>
  <form id="inputForm">
    <input id="input" autocomplete="off" placeholder="Type a command and press Enter" enterkeyhint="send">
    <button class="primary">Send</button>
  </form>
  <script src="/xterm.js"></script>
  <script src="/xterm-addon-fit.js"></script>
  <script>
  const $=id=>document.getElementById(id);
  let ws,lease,client=crypto.randomUUID(),term,fit,hasLease=false,resizeTimer,pending=[];

  function decode(v){try{return new TextDecoder().decode(Uint8Array.from(atob(v),c=>c.charCodeAt(0)))}catch{return""}}
  function setStatus(text,cls){$("status-text").textContent=text;$("status").className=cls||""}
  function showOverlay(title,msg,btn){$("overlay-title").textContent=title;$("overlay-msg").textContent=msg||"";$("overlay-btn").classList.toggle("hidden",!btn);$("overlay").classList.remove("hidden")}
  function hideOverlay(){$("overlay").classList.add("hidden")}

  function initTerm(){
    if(term)return true;
    try{
      term=new Terminal({cursorBlink:true,cursorStyle:"bar",fontFamily:"ui-monospace,monospace",fontSize:13,allowProposedApi:true,convertEol:false,scrollback:3000});
      fit=new FitAddon.FitAddon();term.loadAddon(fit);term.open($("terminal"));fit.fit();
      term.onData(d=>{if(ws&&hasLease&&d)ws.send(JSON.stringify({type:"input",lease_id:lease,data:d}))});
      term.onResize(({cols,rows})=>{if(ws&&hasLease){clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>ws.send(JSON.stringify({type:"resize",cols,rows})),200)}});
      new ResizeObserver(()=>{try{fit.fit()}catch(e){}}).observe($("term-wrap"));
      window.addEventListener("resize",()=>{try{fit.fit()}catch(e){}});
      // Drain any output that arrived before the terminal was ready.
      for(const d of pending)term.write(d);pending=[];
      return true;
    }catch(e){
      term=null;fit=null;
      setStatus("Terminal rendering failed","error");
      showOverlay("Terminal rendering failed",(e&&e.message)||"xterm.js could not initialise. Try reloading the page.","Retry");
      return false;
    }
  }
  function disposeTerm(){if(term){term.dispose();term=null;fit=null}lease=null;hasLease=false;pending=[]}

  async function api(path,options={}){let token=$("token").value;return fetch(path,{...options,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",...(options.headers||{})}})}

  async function connect(){
    sessionStorage.token=$("token").value;
    setStatus("Connecting…","connecting");hideOverlay();
    try{
      let r=await api("/api/sessions");
      if(!r.ok){setStatus("Unauthorized","error");showOverlay("Unauthorized","The access token was rejected. Scan a fresh QR code from the desktop app.","Retry");return}
      let j=await r.json();
      $("sessions").innerHTML=(j.sessions||[]).map(s=>`<option value="${s.sessionId}">${s.projectId} · ${s.sessionId.slice(-8)}</option>`).join("");
      if(!$("sessions").value){setStatus("No active sessions","error");showOverlay("No active sessions","Open a terminal in the desktop app first, then tap Retry.","Retry");return}
      connectWs();
    }catch(e){
      setStatus("Connection failed","error");
      showOverlay("Connection failed",(e&&e.message)||"Could not reach the Session Host. Check the network and retry.","Retry");
    }
  }
  $("connect").onclick=connect;

  function connectWs(){
    if(ws)ws.close();disposeTerm();
    let id=$("sessions").value;if(!id)return;
    let q=new URLSearchParams({token:$("token").value,clientId:client,readOnly:$("readonly").checked});
    setStatus("Connecting…","connecting");
    ws=new WebSocket(`${location.protocol==="https:"?"wss":"ws"}://${location.host}/api/sessions/${id}/attach?${q}`);
    ws.onopen=()=>{
      let s=$("sessions").selectedOptions[0]?.textContent||"";
      setStatus(s?`Connected · ${s}`:"Connected","connected");hideOverlay();
      // Initialise the terminal AFTER the WS is open so a rendering failure
      // never blocks the connection status from updating.
      initTerm();
      setTimeout(()=>{try{fit&&fit.fit()}catch(e){}},50);
    };
    ws.onclose=()=>{setStatus("Disconnected","");lease=null;hasLease=false};
    ws.onerror=()=>{setStatus("Connection error","error")};
    ws.onmessage=e=>{
      let m;try{m=JSON.parse(e.data)}catch(err){return}
      if(m.type==="snapshot"){let d=decode(m.data);if(term)term.write(d);else pending.push(d)}
      else if(m.type==="output"&&m.event&&m.event.data){let d=decode(m.event.data);if(term)term.write(d);else pending.push(d)}
      else if(m.type==="lease"){lease=m.lease.leaseId;hasLease=true;$("input").disabled=false;$("take").disabled=true}
      else if(m.type==="released"||m.type==="lease_released"){lease=null;hasLease=false;$("input").disabled=true;$("take").disabled=false}
      else if(m.type==="error"){setStatus(m.message||"Error","error")}
    };
  }

  $("sessions").onchange=connectWs;
  $("take").onclick=()=>ws?.send(JSON.stringify({type:"acquire"}));
  $("interrupt").onclick=()=>{if(lease&&confirm("Send Ctrl+C?"))ws?.send(JSON.stringify({type:"interrupt",lease_id:lease,confirm:true}))};
  $("inputForm").onsubmit=e=>{e.preventDefault();let v=$("input").value;if(ws&&hasLease&&v){ws.send(JSON.stringify({type:"input",lease_id:lease,data:v+"\\r"}));$("input").value=""}};
  $("overlay-btn").onclick=()=>connect();

  (()=>{let t=new URLSearchParams(location.search).get("token");if(t){$("token").value=t;sessionStorage.token=t;history.replaceState(null,"",location.pathname)}else{$("token").value=sessionStorage.token||""}if($("token").value)connect();else showOverlay("Connect","Enter the access token shown in the desktop app, or scan its QR code.",null)})();
  </script>
</body></html>"#;

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
