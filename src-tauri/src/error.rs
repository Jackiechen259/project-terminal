//! Top-level error type. Implements the plan's AppError variants and converts
//! to a structured, serializable frontend error `{ code, message }`.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Project was not found: {0}")]
    ProjectNotFound(String),

    #[error("Project path does not exist: {0}")]
    ProjectPathNotFound(String),

    #[allow(dead_code)]
    #[error("Remote project path is invalid: {0}")]
    RemotePathInvalid(String),

    #[error("Terminal profile was not found: {0}")]
    ProfileNotFound(String),

    #[error("Shell executable was not found: {0}")]
    ShellNotFound(String),

    #[error("SSH client was not found")]
    SshClientNotFound,

    #[error("SSH connection was not found: {0}")]
    SshConnectionNotFound(String),

    #[error("SSH connection is referenced by project {0}")]
    SshConnectionInUse(String),

    #[error("SSH host key verification failed: {0}")]
    SshHostKeyFailed(String),

    #[allow(dead_code)]
    #[error("SSH authentication failed: {0}")]
    SshAuthenticationFailed(String),

    #[error("SSH connection failed: {0}")]
    SshConnectionFailed(String),

    #[error("Terminal session was not found: {0}")]
    SessionNotFound(String),

    #[error("Failed to create PTY: {0}")]
    PtyCreationFailed(String),

    #[error("Failed to start shell: {0}")]
    ShellStartFailed(String),

    #[error("Environment initialization failed: {0}")]
    EnvironmentInitializationFailed(String),

    #[error("Configuration error: {0}")]
    Configuration(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

impl AppError {
    /// Stable error code. The frontend switches on this to render
    /// context-specific UI (path picker re-open, host-key confirmation,
    /// reconnect button, etc.). MUST stay stable across releases.
    pub fn code(&self) -> &'static str {
        match self {
            AppError::ProjectNotFound(_) => "project_not_found",
            AppError::ProjectPathNotFound(_) => "project_path_not_found",
            AppError::RemotePathInvalid(_) => "remote_path_invalid",
            AppError::ProfileNotFound(_) => "profile_not_found",
            AppError::ShellNotFound(_) => "shell_not_found",
            AppError::SshClientNotFound => "ssh_client_not_found",
            AppError::SshConnectionNotFound(_) => "ssh_connection_not_found",
            AppError::SshConnectionInUse(_) => "ssh_connection_in_use",
            AppError::SshHostKeyFailed(_) => "ssh_host_key_failed",
            AppError::SshAuthenticationFailed(_) => "ssh_authentication_failed",
            AppError::SshConnectionFailed(_) => "ssh_connection_failed",
            AppError::SessionNotFound(_) => "session_not_found",
            AppError::PtyCreationFailed(_) => "pty_creation_failed",
            AppError::ShellStartFailed(_) => "shell_start_failed",
            AppError::EnvironmentInitializationFailed(_) => "environment_init_failed",
            AppError::Configuration(_) => "configuration",
            AppError::Io(_) => "io",
        }
    }
}

/// Structured frontend error payload. Serialized as a JSON object so the
/// frontend can reliably switch on `code` rather than parsing message text.
#[derive(Debug, Serialize)]
pub struct FrontendError {
    pub code: &'static str,
    pub message: String,
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        FrontendError {
            code: self.code(),
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_code_message_object() {
        let err = AppError::ProjectPathNotFound("D:\\Missing".into());
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("\"code\":\"project_path_not_found\""));
        assert!(json.contains("\"message\":\"Project path does not exist: D:\\\\Missing\""));
    }

    #[test]
    fn each_variant_has_stable_code() {
        let cases: Vec<(AppError, &'static str)> = vec![
            (AppError::ProjectNotFound("p".into()), "project_not_found"),
            (
                AppError::ProjectPathNotFound("p".into()),
                "project_path_not_found",
            ),
            (
                AppError::RemotePathInvalid("p".into()),
                "remote_path_invalid",
            ),
            (AppError::ProfileNotFound("p".into()), "profile_not_found"),
            (AppError::ShellNotFound("p".into()), "shell_not_found"),
            (AppError::SshClientNotFound, "ssh_client_not_found"),
            (
                AppError::SshConnectionNotFound("c".into()),
                "ssh_connection_not_found",
            ),
            (
                AppError::SshConnectionInUse("p".into()),
                "ssh_connection_in_use",
            ),
            (
                AppError::SshHostKeyFailed("h".into()),
                "ssh_host_key_failed",
            ),
            (
                AppError::SshAuthenticationFailed("h".into()),
                "ssh_authentication_failed",
            ),
            (
                AppError::SshConnectionFailed("h".into()),
                "ssh_connection_failed",
            ),
            (AppError::SessionNotFound("s".into()), "session_not_found"),
            (
                AppError::PtyCreationFailed("e".into()),
                "pty_creation_failed",
            ),
            (AppError::ShellStartFailed("e".into()), "shell_start_failed"),
            (
                AppError::EnvironmentInitializationFailed("e".into()),
                "environment_init_failed",
            ),
            (AppError::Configuration("e".into()), "configuration"),
            (
                AppError::Io(std::io::Error::new(std::io::ErrorKind::Other, "x")),
                "io",
            ),
        ];
        for (err, expected_code) in cases {
            assert_eq!(err.code(), expected_code, "mismatch for {err:?}");
        }
    }
}
