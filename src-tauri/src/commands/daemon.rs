use serde::Serialize;

use crate::daemon::{self, DaemonRequest};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    pub connected: bool,
    pub endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub async fn status() -> DaemonStatus {
    match daemon::request(DaemonRequest::Ping).await {
        Ok(response) if response.ok => DaemonStatus {
            connected: true,
            endpoint: daemon::endpoint_display(),
            details: response.data,
            error: None,
        },
        Ok(response) => DaemonStatus {
            connected: false,
            endpoint: daemon::endpoint_display(),
            details: None,
            error: response.error,
        },
        Err(error) => DaemonStatus {
            connected: false,
            endpoint: daemon::endpoint_display(),
            details: None,
            error: Some(error.to_string()),
        },
    }
}

pub async fn ensure_running() -> DaemonStatus {
    let current = status().await;
    if current.connected {
        return current;
    }
    if let Err(error) = spawn_daemon_process() {
        return DaemonStatus {
            error: Some(error),
            ..current
        };
    }
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let next = status().await;
        if next.connected {
            return next;
        }
    }
    status().await
}

fn spawn_daemon_process() -> Result<(), String> {
    let executable = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .with_file_name(if cfg!(windows) {
            "project-terminal-daemon.exe"
        } else {
            "project-terminal-daemon"
        });
    let (program, use_embedded_mode) = if executable.is_file() {
        (executable, false)
    } else {
        (
            std::env::current_exe().map_err(|error| error.to_string())?,
            true,
        )
    };
    let mut command = std::process::Command::new(program);
    if use_embedded_mode {
        command.arg("--session-host");
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn daemon_status() -> DaemonStatus {
    status().await
}

#[tauri::command]
pub async fn reconnect_daemon() -> DaemonStatus {
    ensure_running().await
}

#[tauri::command]
pub async fn daemon_list_sessions() -> Result<serde_json::Value, String> {
    let response = daemon::request(DaemonRequest::ListSessions)
        .await
        .map_err(|error| error.to_string())?;
    if response.ok {
        Ok(response.data.unwrap_or(serde_json::Value::Null))
    } else {
        Err(response
            .error
            .unwrap_or_else(|| "Session Host request failed".into()))
    }
}
