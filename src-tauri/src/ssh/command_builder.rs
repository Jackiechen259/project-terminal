//! Safe OpenSSH argument construction.
//!
//! Arguments are always returned as an argv vector and are passed directly to
//! the process API. They are never joined into a shell command string.

use super::{SshAuthenticationType, SshConnection};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshCommand {
    pub args: Vec<String>,
}

/// Build the arguments used by a future interactive SSH terminal.
pub fn build_ssh_argv(connection: &SshConnection) -> SshCommand {
    build_ssh_argv_with_remote_command(connection, None)
}

/// Build an interactive SSH invocation, optionally with a server-side command
/// that prepares the remote shell before it becomes interactive.
pub fn build_ssh_argv_with_remote_command(
    connection: &SshConnection,
    remote_command: Option<String>,
) -> SshCommand {
    let mut args = common_args(connection);
    // Allocate a TTY for terminals, editors and password/key-passphrase
    // prompts. The executable itself is selected separately by client.rs.
    args.insert(0, "-tt".to_string());
    args.push(connection.host.clone());
    if let Some(remote_command) = remote_command {
        args.push(remote_command);
    }
    SshCommand { args }
}

/// Build a bounded, non-interactive connection check. It never accepts a
/// host key and never reads a password; failures are reported to the UI.
pub fn build_ssh_test_argv(connection: &SshConnection) -> SshCommand {
    let mut args = common_args(connection);
    args.extend([
        "-T".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "NumberOfPasswordPrompts=0".to_string(),
        connection.host.clone(),
        "exit".to_string(),
    ]);
    SshCommand { args }
}

fn common_args(connection: &SshConnection) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        connection.port.to_string(),
        "-o".to_string(),
        format!("ConnectTimeout={}", connection.connect_timeout_seconds),
        "-o".to_string(),
        format!(
            "ServerAliveInterval={}",
            connection.server_alive_interval_seconds
        ),
        "-o".to_string(),
        format!("ServerAliveCountMax={}", connection.server_alive_count_max),
        "-o".to_string(),
        // `ask` rejects changed keys and visibly asks the user before a
        // first key is saved. We never emit `no` or /dev/null settings.
        "StrictHostKeyChecking=ask".to_string(),
    ];

    if !connection.username.trim().is_empty()
        && connection.authentication_type != SshAuthenticationType::SystemConfig
    {
        args.extend(["-l".to_string(), connection.username.clone()]);
    }
    if let Some(identity_file) = &connection.identity_file {
        args.extend(["-i".to_string(), identity_file.clone()]);
    }
    if let Some(known_hosts_file) = &connection.known_hosts_file {
        args.extend([
            "-o".to_string(),
            format!("UserKnownHostsFile={known_hosts_file}"),
        ]);
    }
    if let Some(jump) = &connection.jump_host {
        let user_prefix = jump
            .username
            .as_deref()
            .filter(|username| !username.trim().is_empty())
            .map(|username| format!("{username}@"))
            .unwrap_or_default();
        args.extend([
            "-J".to_string(),
            format!("{user_prefix}{}:{}", jump.host, jump.port),
        ]);
    }

    match connection.authentication_type {
        SshAuthenticationType::Agent => args.extend([
            "-o".to_string(),
            "PreferredAuthentications=publickey".to_string(),
        ]),
        SshAuthenticationType::Key => {
            args.extend(["-o".to_string(), "IdentitiesOnly=yes".to_string()])
        }
        SshAuthenticationType::Password => args.extend([
            "-o".to_string(),
            "PreferredAuthentications=password,keyboard-interactive".to_string(),
        ]),
        SshAuthenticationType::KeyboardInteractive => args.extend([
            "-o".to_string(),
            "PreferredAuthentications=keyboard-interactive".to_string(),
        ]),
        SshAuthenticationType::SystemConfig => {}
    }

    args.extend(connection.extra_args.iter().cloned());
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::SshJumpHost;
    use chrono::Utc;

    fn sample() -> SshConnection {
        SshConnection {
            id: "ssh-1".into(),
            name: "Server".into(),
            host: "srv.example".into(),
            port: 2200,
            username: "dev".into(),
            authentication_type: SshAuthenticationType::Key,
            identity_file: Some("C:\\Keys\\id_ed25519".into()),
            use_ssh_agent: false,
            jump_host: Some(SshJumpHost {
                host: "jump.example".into(),
                port: 22,
                username: Some("gateway".into()),
            }),
            connect_timeout_seconds: 12,
            server_alive_interval_seconds: 30,
            server_alive_count_max: 3,
            strict_host_key_checking: true,
            known_hosts_file: Some("C:\\Keys\\known_hosts".into()),
            extra_args: vec!["-v".into()],
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn builds_interactive_argv_without_shell_joining() {
        let command = build_ssh_argv(&sample());
        assert_eq!(command.args[0], "-tt");
        assert!(command
            .args
            .windows(2)
            .any(|pair| pair == ["-i", "C:\\Keys\\id_ed25519"]));
        assert!(command
            .args
            .windows(2)
            .any(|pair| pair == ["-J", "gateway@jump.example:22"]));
        assert!(command
            .args
            .iter()
            .any(|arg| arg == "StrictHostKeyChecking=ask"));
        assert_eq!(command.args.last(), Some(&"srv.example".to_string()));
    }

    #[test]
    fn test_argv_is_noninteractive_and_keeps_host_key_checking() {
        let command = build_ssh_test_argv(&sample());
        assert!(command
            .args
            .windows(2)
            .any(|pair| pair == ["-o", "BatchMode=yes"]));
        assert!(command
            .args
            .iter()
            .any(|arg| arg == "StrictHostKeyChecking=ask"));
        assert_eq!(
            command.args[command.args.len() - 2..],
            ["srv.example", "exit"]
        );
    }
}
