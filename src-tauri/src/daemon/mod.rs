use std::path::PathBuf;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

use crate::config_dirs::ConfigDirs;
use crate::error::{AppError, AppResult};
use crate::storage;
use crate::terminal::{SessionSpawn, TerminalManager};

mod remote;
use remote::RemoteGateway;
#[cfg(windows)]
pub const DAEMON_ENDPOINT: &str = r"\\.\pipe\project-terminal";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonSpawnRequest {
    pub session_id: String,
    pub project_id: String,
    pub profile_id: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    pub rows: u16,
    pub cols: u16,
    pub scrollback_bytes: usize,
}

impl From<DaemonSpawnRequest> for SessionSpawn {
    fn from(value: DaemonSpawnRequest) -> Self {
        Self {
            session_id: value.session_id,
            project_id: value.project_id,
            profile_id: value.profile_id,
            program: value.program,
            args: value.args,
            cwd: value.cwd,
            env: value.env,
            readiness_marker: None,
            rows: value.rows,
            cols: value.cols,
            scrollback_bytes: value.scrollback_bytes,
        }
    }
}

impl From<SessionSpawn> for DaemonSpawnRequest {
    fn from(value: SessionSpawn) -> Self {
        Self {
            session_id: value.session_id,
            project_id: value.project_id,
            profile_id: value.profile_id,
            program: value.program,
            args: value.args,
            cwd: value.cwd,
            env: value.env,
            rows: value.rows,
            cols: value.cols,
            scrollback_bytes: value.scrollback_bytes,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DaemonRequest {
    Ping,
    ListSessions,
    Create {
        spawn: DaemonSpawnRequest,
    },
    Write {
        session_id: String,
        data: String,
    },
    Resize {
        session_id: String,
        rows: u16,
        cols: u16,
    },
    Close {
        session_id: String,
    },
    Snapshot {
        session_id: String,
    },
    RemoteInfo,
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonStateSnapshot {
    pid: u32,
    started_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    sessions: Vec<serde_json::Value>,
    #[serde(default)]
    recovered_as_failed: Vec<serde_json::Value>,
}

struct DaemonServer {
    manager: TerminalManager,
    state_path: PathBuf,
    started_at: DateTime<Utc>,
    recovered_as_failed: Vec<serde_json::Value>,
    shutdown: tokio::sync::Notify,
    remote: RemoteGateway,
}

impl DaemonServer {
    fn new(dirs: &ConfigDirs) -> Self {
        let state_path = dirs.daemon_state_path();
        let recovered_as_failed =
            storage::read_or_default::<serde_json::Value>(&state_path, serde_json::json!({}))
                .ok()
                .and_then(|value| {
                    value
                        .get("sessions")
                        .and_then(|value| value.as_array())
                        .cloned()
                })
                .unwrap_or_default()
                .into_iter()
                .map(|mut session| {
                    if let Some(object) = session.as_object_mut() {
                        object.insert("status".into(), serde_json::json!("error"));
                        object.insert(
                            "exitReason".into(),
                            serde_json::json!(
                        "Daemon restarted; the operating-system PTY was no longer attachable"
                    ),
                        );
                    }
                    session
                })
                .collect();
        Self {
            manager: TerminalManager::new(),
            state_path,
            started_at: Utc::now(),
            recovered_as_failed,
            shutdown: tokio::sync::Notify::new(),
            remote: RemoteGateway::new(dirs),
        }
    }

    fn persist(&self) -> AppResult<()> {
        let sessions = self
            .manager
            .list()
            .into_iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| AppError::Configuration(error.to_string()))?;
        storage::write_json(
            &self.state_path,
            &DaemonStateSnapshot {
                pid: std::process::id(),
                started_at: self.started_at,
                updated_at: Utc::now(),
                sessions,
                recovered_as_failed: self.recovered_as_failed.clone(),
            },
        )
    }

    fn handle(&self, request: DaemonRequest) -> DaemonResponse {
        let result: AppResult<serde_json::Value> = (|| match request {
            DaemonRequest::Ping => Ok(serde_json::json!({
                "pid": std::process::id(),
                "startedAt": self.started_at,
                "endpoint": endpoint_display(),
            })),
            DaemonRequest::ListSessions => Ok(serde_json::json!({
                "sessions": self.manager.list(),
                "recoveredAsFailed": self.recovered_as_failed,
            })),
            DaemonRequest::Create { spawn } => {
                let id = self.manager.create(spawn.into())?;
                self.manager.mark_running(&id)?;
                self.persist()?;
                Ok(serde_json::json!({ "sessionId": id }))
            }
            DaemonRequest::Write { session_id, data } => {
                self.manager.write(&session_id, data.as_bytes())?;
                Ok(serde_json::Value::Null)
            }
            DaemonRequest::Resize {
                session_id,
                rows,
                cols,
            } => {
                self.manager.resize(&session_id, rows, cols)?;
                Ok(serde_json::Value::Null)
            }
            DaemonRequest::Close { session_id } => {
                self.manager.close(&session_id)?;
                self.persist()?;
                Ok(serde_json::Value::Null)
            }
            DaemonRequest::Snapshot { session_id } => {
                use base64::Engine;
                let client_id = format!("snapshot-{}", uuid::Uuid::new_v4());
                let (session, subscription) =
                    self.manager.attach(&session_id, client_id.clone())?;
                let data =
                    base64::engine::general_purpose::STANDARD.encode(subscription.snapshot.bytes);
                let _ = self.manager.detach(&session_id, &client_id);
                Ok(serde_json::json!({
                    "session": session,
                    "scrollback": data,
                    "truncated": subscription.snapshot.truncated,
                }))
            }
            DaemonRequest::RemoteInfo => Ok(self.remote.info()),
            DaemonRequest::Shutdown => {
                self.manager.close_all();
                self.persist()?;
                self.shutdown.notify_waiters();
                Ok(serde_json::Value::Null)
            }
        })();
        match result {
            Ok(data) => DaemonResponse {
                ok: true,
                data: Some(data),
                error: None,
            },
            Err(error) => DaemonResponse {
                ok: false,
                data: None,
                error: Some(error.to_string()),
            },
        }
    }
}

pub fn run_daemon() -> AppResult<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(AppError::Io)?;
    runtime.block_on(run_daemon_async())
}

async fn run_daemon_async() -> AppResult<()> {
    let dirs = ConfigDirs::resolve()?;
    dirs.ensure_root()?;
    let server = Arc::new(DaemonServer::new(&dirs));

    #[cfg(windows)]
    {
        return run_windows_server(server).await;
    }
    #[cfg(unix)]
    {
        return run_unix_server(server, dirs.daemon_socket_path()).await;
    }
    #[cfg(not(any(windows, unix)))]
    {
        Err(AppError::Configuration(
            "The daemon transport is unsupported on this platform".into(),
        ))
    }
}

#[cfg(windows)]
async fn run_windows_server(server: Arc<DaemonServer>) -> AppResult<()> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let mut first = true;
    let mut checkpoint_started = false;
    loop {
        let mut options = ServerOptions::new();
        if first {
            options.first_pipe_instance(true);
        }
        let pipe = options.create(DAEMON_ENDPOINT).map_err(|error| {
            if first && error.kind() == std::io::ErrorKind::PermissionDenied {
                AppError::Configuration("Project Terminal daemon is already running".into())
            } else {
                AppError::Io(error)
            }
        })?;
        first = false;
        if !checkpoint_started {
            server.persist()?;
            spawn_state_checkpoint(server.clone());
            server.remote.start(server.clone());
            checkpoint_started = true;
        }
        tokio::select! {
            result = pipe.connect() => {
                result.map_err(AppError::Io)?;
                let state = server.clone();
                tokio::spawn(async move {
                    let _ = handle_connection(pipe, state).await;
                });
            }
            _ = server.shutdown.notified() => return Ok(()),
        }
    }
}

#[cfg(unix)]
async fn run_unix_server(server: Arc<DaemonServer>, path: PathBuf) -> AppResult<()> {
    use tokio::net::{UnixListener, UnixStream};

    if path.exists() {
        if UnixStream::connect(&path).await.is_ok() {
            return Err(AppError::Configuration(
                "Project Terminal daemon is already running".into(),
            ));
        }
        std::fs::remove_file(&path).map_err(AppError::Io)?;
    }
    let listener = UnixListener::bind(&path).map_err(AppError::Io)?;
    server.persist()?;
    spawn_state_checkpoint(server.clone());
    server.remote.start(server.clone());
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted.map_err(AppError::Io)?;
                let state = server.clone();
                tokio::spawn(async move {
                    let _ = handle_connection(stream, state).await;
                });
            }
            _ = server.shutdown.notified() => {
                let _ = std::fs::remove_file(&path);
                return Ok(());
            }
        }
    }
}

fn spawn_state_checkpoint(server: Arc<DaemonServer>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if let Err(error) = server.persist() {
                        tracing::warn!("Could not checkpoint Session Host state: {error}");
                    }
                }
                _ = server.shutdown.notified() => break,
            }
        }
    });
}

async fn handle_connection<S>(mut stream: S, server: Arc<DaemonServer>) -> AppResult<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut line = String::new();
    BufReader::new(&mut stream)
        .read_line(&mut line)
        .await
        .map_err(AppError::Io)?;
    let request = serde_json::from_str::<DaemonRequest>(&line)
        .map_err(|error| AppError::Configuration(format!("Invalid daemon request: {error}")))?;
    let response = server.handle(request);
    let mut payload = serde_json::to_vec(&response)
        .map_err(|error| AppError::Configuration(error.to_string()))?;
    payload.push(b'\n');
    stream.write_all(&payload).await.map_err(AppError::Io)?;
    stream.shutdown().await.map_err(AppError::Io)
}

pub async fn request(request: DaemonRequest) -> AppResult<DaemonResponse> {
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;
        let stream = ClientOptions::new()
            .open(DAEMON_ENDPOINT)
            .map_err(AppError::Io)?;
        return request_over_stream(stream, request).await;
    }
    #[cfg(unix)]
    {
        let dirs = ConfigDirs::resolve()?;
        let stream = tokio::net::UnixStream::connect(dirs.daemon_socket_path())
            .await
            .map_err(AppError::Io)?;
        return request_over_stream(stream, request).await;
    }
    #[cfg(not(any(windows, unix)))]
    Err(AppError::Configuration(
        "The daemon transport is unsupported on this platform".into(),
    ))
}

async fn request_over_stream<S>(mut stream: S, request: DaemonRequest) -> AppResult<DaemonResponse>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut payload =
        serde_json::to_vec(&request).map_err(|error| AppError::Configuration(error.to_string()))?;
    payload.push(b'\n');
    stream.write_all(&payload).await.map_err(AppError::Io)?;
    let mut line = String::new();
    BufReader::new(&mut stream)
        .read_line(&mut line)
        .await
        .map_err(AppError::Io)?;
    serde_json::from_str(&line)
        .map_err(|error| AppError::Configuration(format!("Invalid daemon response: {error}")))
}

pub fn endpoint_display() -> String {
    #[cfg(windows)]
    {
        DAEMON_ENDPOINT.into()
    }
    #[cfg(unix)]
    {
        ConfigDirs::resolve()
            .map(|dirs| dirs.daemon_socket_path().to_string_lossy().into_owned())
            .unwrap_or_else(|_| "project-terminal.sock".into())
    }
    #[cfg(not(any(windows, unix)))]
    {
        "unsupported".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_round_trip_is_tagged_and_stable() {
        let json = serde_json::to_string(&DaemonRequest::Resize {
            session_id: "s1".into(),
            rows: 40,
            cols: 120,
        })
        .unwrap();
        assert!(json.contains("\"type\":\"resize\""));
        let parsed: DaemonRequest = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, DaemonRequest::Resize { rows: 40, .. }));
    }
}
