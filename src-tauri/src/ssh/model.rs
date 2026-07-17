//! SSH connection domain model. Mirrors the frontend `SshConnection` type.
//!
//! All structs use `#[serde(rename_all = "camelCase")]` to match the
//! TypeScript shape exactly.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SshAuthenticationType {
    Agent,
    Key,
    Password,
    KeyboardInteractive,
    SystemConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshJumpHost {
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnection {
    pub id: String,
    pub name: String,

    pub host: String,
    pub port: u16,
    pub username: String,

    pub authentication_type: SshAuthenticationType,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    pub use_ssh_agent: bool,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump_host: Option<SshJumpHost>,

    pub connect_timeout_seconds: u32,
    pub server_alive_interval_seconds: u32,
    pub server_alive_count_max: u32,

    pub strict_host_key_checking: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_hosts_file: Option<String>,

    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub extra_args: Vec<String>,

    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl SshConnection {
    /// Validate required fields. Host must be non-empty, port in 1..=65535,
    /// username non-empty. For `Key` auth, identity file must be set.
    /// `strict_host_key_checking` may not be silently disabled - but it CAN
    /// be turned off if the user explicitly sets it. Validation does not
    /// override the user's choice.
    pub fn validate(&self) -> Result<(), crate::error::AppError> {
        if self.name.trim().is_empty() {
            return Err(crate::error::AppError::Configuration(
                "SSH connection name must not be empty".to_string(),
            ));
        }
        if self.host.trim().is_empty() {
            return Err(crate::error::AppError::Configuration(
                "SSH host must not be empty".to_string(),
            ));
        }
        if self.port == 0 {
            return Err(crate::error::AppError::Configuration(
                "SSH port must be in 1..=65535".to_string(),
            ));
        }
        if self.username.trim().is_empty() {
            return Err(crate::error::AppError::Configuration(
                "SSH username must not be empty".to_string(),
            ));
        }
        if self.authentication_type == SshAuthenticationType::Key {
            let key = self
                .identity_file
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    crate::error::AppError::Configuration(
                        "Key authentication requires an identity file path".to_string(),
                    )
                })?;
            // §7: the key file MUST exist on disk before we persist the
            // connection. We do not read its contents.
            if !std::path::Path::new(key).is_file() {
                return Err(crate::error::AppError::Configuration(format!(
                    "Identity file does not exist: {key}"
                )));
            }
        }
        if let Some(jump) = &self.jump_host {
            if jump.host.trim().is_empty() {
                return Err(crate::error::AppError::Configuration(
                    "Jump host must not have an empty host".to_string(),
                ));
            }
            if jump.port == 0 {
                return Err(crate::error::AppError::Configuration(
                    "Jump host port must be in 1..=65535".to_string(),
                ));
            }
        }
        validate_extra_args(&self.extra_args)?;
        Ok(())
    }
}

/// Per-plan §7/§33: `extra_args` is a power-user escape hatch, but it MUST
/// NOT be used to silently override host-key security policy. We reject
/// empty items and any `-o Key=Value` (or `-oKey=Value`, or `-o Key Value`)
/// that touches StrictHostKeyChecking, UserKnownHostsFile, or ProxyCommand.
/// The UI exposes those as first-class fields with their own risk warnings.
fn validate_extra_args(args: &[String]) -> Result<(), crate::error::AppError> {
    for arg in args {
        if arg.trim().is_empty() {
            return Err(crate::error::AppError::Configuration(
                "extraArgs contains an empty item".to_string(),
            ));
        }
    }
    // Walk the arg list by index so we can consume the value of a bare `-o`
    // in the next argv slot. SSH accepts three spellings:
    //   `-o Key=Value`  (value in the next argv slot)
    //   `-oKey=Value`   (value glued to the flag)
    //   `-o Key Value`  (legacy two-slot form - we still flag the key)
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].trim();
        let opt_value: Option<&str> =
            if let Some(glued) = arg.strip_prefix("-o").or_else(|| arg.strip_prefix("-O")) {
                // `-oKey=Value` or `-o Key` (consume next slot for the key).
                if glued.is_empty() {
                    // Value is the next argv slot.
                    Some(args.get(i + 1).map(|s| s.as_str()).unwrap_or(""))
                } else {
                    Some(glued)
                }
            } else {
                None
            };
        if let Some(value) = opt_value {
            let key = value
                .split(|c: char| c == '=' || c.is_whitespace())
                .next()
                .unwrap_or("");
            let normalized = key.to_ascii_lowercase();
            if matches!(
                normalized.as_str(),
                "stricthostkeychecking" | "userknownhostsfile" | "proxycommand"
            ) {
                return Err(crate::error::AppError::Configuration(format!(
                    "extraArgs may not override `{key}`; configure it through the dedicated field instead"
                )));
            }
            if arg
                .strip_prefix("-o")
                .map(|s| s.is_empty())
                .unwrap_or(false)
                || arg
                    .strip_prefix("-O")
                    .map(|s| s.is_empty())
                    .unwrap_or(false)
            {
                // Consumed the next argv slot as the option value.
                i += 2;
                continue;
            }
        }
        i += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        Utc::now()
    }

    fn sample() -> SshConnection {
        SshConnection {
            id: "c1".into(),
            name: "Katana".into(),
            host: "katana.example.com".into(),
            port: 22,
            username: "user".into(),
            authentication_type: SshAuthenticationType::Agent,
            identity_file: None,
            use_ssh_agent: true,
            jump_host: None,
            connect_timeout_seconds: 15,
            server_alive_interval_seconds: 30,
            server_alive_count_max: 3,
            strict_host_key_checking: true,
            known_hosts_file: None,
            extra_args: vec![],
            created_at: now(),
            updated_at: now(),
        }
    }

    #[test]
    fn serializes_camel_case_with_kebab_auth_type() {
        let json = serde_json::to_string(&sample()).unwrap();
        assert!(json.contains("\"authenticationType\":\"agent\""));
        assert!(json.contains("\"connectTimeoutSeconds\":15"));
        assert!(json.contains("\"serverAliveIntervalSeconds\":30"));
        assert!(json.contains("\"strictHostKeyChecking\":true"));
        assert!(json.contains("\"useSshAgent\":true"));
        // skipped empty fields
        assert!(!json.contains("identityFile"));
        assert!(!json.contains("jumpHost"));
        assert!(!json.contains("knownHostsFile"));
        assert!(!json.contains("extraArgs"));
    }

    #[test]
    fn round_trip_preserves_all_fields() {
        let conn = SshConnection {
            authentication_type: SshAuthenticationType::Key,
            identity_file: Some("C:\\keys\\id_ed25519".into()),
            jump_host: Some(SshJumpHost {
                host: "gw.example.com".into(),
                port: 22,
                username: Some("gwuser".into()),
            }),
            extra_args: vec!["-v".into()],
            ..sample()
        };
        let json = serde_json::to_string(&conn).unwrap();
        let parsed: SshConnection = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.authentication_type, SshAuthenticationType::Key);
        assert_eq!(
            parsed.identity_file.as_deref(),
            Some("C:\\keys\\id_ed25519")
        );
        let jump = parsed.jump_host.unwrap();
        assert_eq!(jump.host, "gw.example.com");
        assert_eq!(jump.username.as_deref(), Some("gwuser"));
        assert_eq!(parsed.extra_args, vec!["-v".to_string()]);
    }

    #[test]
    fn frontend_shape_json_deserializes() {
        let json = r#"{
            "id": "c-fe",
            "name": "Frontend",
            "host": "h.example.com",
            "port": 2222,
            "username": "u",
            "authenticationType": "key",
            "identityFile": "C:\\keys\\id_ed25519",
            "useSshAgent": false,
            "connectTimeoutSeconds": 15,
            "serverAliveIntervalSeconds": 30,
            "serverAliveCountMax": 3,
            "strictHostKeyChecking": true,
            "createdAt": "2026-07-18T00:00:00Z",
            "updatedAt": "2026-07-18T00:00:00Z"
        }"#;
        let parsed: SshConnection = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.host, "h.example.com");
        assert_eq!(parsed.port, 2222);
        assert_eq!(parsed.authentication_type, SshAuthenticationType::Key);
        assert_eq!(
            parsed.identity_file.as_deref(),
            Some("C:\\keys\\id_ed25519")
        );
    }

    #[test]
    fn key_auth_requires_identity_file_path() {
        let mut conn = sample();
        conn.authentication_type = SshAuthenticationType::Key;
        // No identity_file at all -> error.
        conn.identity_file = None;
        assert!(conn.validate().is_err());

        // Empty/whitespace path -> error.
        conn.identity_file = Some("   ".into());
        assert!(conn.validate().is_err());

        // Path to a non-existent file -> error (§7: key file MUST exist).
        conn.identity_file = Some("C:\\does\\not\\exist\\id_ed25519".into());
        assert!(conn.validate().is_err());
    }

    #[test]
    fn key_auth_validates_when_file_exists() {
        // Create a real key-shaped file on disk. We never read its contents.
        let tmp = std::env::temp_dir().join(format!("pt-key-{}", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, b"fake-key-content").unwrap();

        let mut conn = sample();
        conn.authentication_type = SshAuthenticationType::Key;
        conn.identity_file = Some(tmp.to_string_lossy().into_owned());
        conn.validate().unwrap();

        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn empty_host_and_username_rejected() {
        let mut conn = sample();
        conn.host = "".into();
        assert!(conn.validate().is_err());
        conn.host = "h".into();
        conn.username = "  ".into();
        assert!(conn.validate().is_err());
    }

    #[test]
    fn jump_host_port_zero_rejected() {
        let mut conn = sample();
        conn.jump_host = Some(SshJumpHost {
            host: "gw".into(),
            port: 0,
            username: None,
        });
        assert!(conn.validate().is_err());
    }
}

#[cfg(test)]
mod extra_args_tests {
    use super::*;

    fn conn_with_args(args: Vec<&str>) -> SshConnection {
        let c = SshConnection {
            id: "c".into(),
            name: "C".into(),
            host: "h".into(),
            port: 22,
            username: "u".into(),
            authentication_type: SshAuthenticationType::Agent,
            identity_file: None,
            use_ssh_agent: true,
            jump_host: None,
            connect_timeout_seconds: 15,
            server_alive_interval_seconds: 30,
            server_alive_count_max: 3,
            strict_host_key_checking: true,
            known_hosts_file: None,
            extra_args: args.into_iter().map(String::from).collect(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        c.validate().expect("valid baseline");
        c
    }
    #[test]
    fn empty_extra_arg_rejected() {
        let mut c = conn_with_args(vec!["-v"]);
        c.extra_args = vec!["".into()];
        assert!(c.validate().is_err());
    }

    #[test]
    fn bare_o_with_next_slot_overrides_host_key_rejected() {
        // `-o` `StrictHostKeyChecking=no` (two-slot form)
        let mut c = conn_with_args(vec![]);
        c.extra_args = vec!["-o".into(), "StrictHostKeyChecking=no".into()];
        assert!(c.validate().is_err());
    }

    #[test]
    fn bare_o_with_next_slot_overrides_user_known_hosts_rejected() {
        let mut c = conn_with_args(vec![]);
        c.extra_args = vec!["-o".into(), "UserKnownHostsFile=/dev/null".into()];
        assert!(c.validate().is_err());
    }

    #[test]
    fn glued_o_overrides_host_key_rejected() {
        let mut c = conn_with_args(vec![]);
        c.extra_args = vec!["-oStrictHostKeyChecking=no".into()];
        assert!(c.validate().is_err());
    }

    #[test]
    fn glued_o_overrides_proxy_command_rejected() {
        let mut c = conn_with_args(vec![]);
        c.extra_args = vec!["-oProxyCommand=nc host 22".into()];
        assert!(c.validate().is_err());
    }

    #[test]
    fn harmless_extra_args_accepted() {
        let mut c = conn_with_args(vec![]);
        c.extra_args = vec!["-v".into(), "-oServerAliveInterval=10".into()];
        assert!(c.validate().is_ok());
    }

    #[test]
    fn bare_o_followed_by_harmless_option_consumes_two_slots() {
        // `-o ServerAliveInterval=10 -v` -> the `-o` slot is consumed as the
        // value, so the subsequent `-v` is read as a normal arg, not as the
        // `-o` value.
        let mut c = conn_with_args(vec![]);
        c.extra_args = vec!["-o".into(), "ServerAliveInterval=10".into(), "-v".into()];
        assert!(c.validate().is_ok());
    }
}
