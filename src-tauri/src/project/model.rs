//! Project domain model. Mirrors the frontend `Project` type.
//!
//! Serialization contract: all structs use `#[serde(rename_all = "camelCase")]`
//! so the on-disk JSON matches the TypeScript `Project` shape exactly. The
//! `ProjectType` enum stays `kebab-case` because the frontend uses
//! `"local" | "ssh"` string literals.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectType {
    Local,
    Ssh,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProjectConfig {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProjectConfig {
    pub connection_id: String,
    pub remote_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub project_type: ProjectType,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub local: Option<LocalProjectConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SshProjectConfig>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_profile_id: Option<String>,

    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Project {
    /// Validate the project's required fields. Returns the project unchanged on
    /// success so callers can chain.
    pub fn validate(&self) -> Result<(), crate::error::AppError> {
        if self.name.trim().is_empty() {
            return Err(crate::error::AppError::Configuration(
                "Project name must not be empty".to_string(),
            ));
        }
        match self.project_type {
            ProjectType::Local => {
                let local = self.local.as_ref().ok_or_else(|| {
                    crate::error::AppError::Configuration(
                        "Local project is missing its local config".to_string(),
                    )
                })?;
                if local.path.trim().is_empty() {
                    return Err(crate::error::AppError::Configuration(
                        "Local project path must not be empty".to_string(),
                    ));
                }
            }
            ProjectType::Ssh => {
                let ssh = self.ssh.as_ref().ok_or_else(|| {
                    crate::error::AppError::Configuration(
                        "SSH project is missing its ssh config".to_string(),
                    )
                })?;
                if ssh.connection_id.trim().is_empty() {
                    return Err(crate::error::AppError::Configuration(
                        "SSH project must reference a connection".to_string(),
                    ));
                }
                if ssh.remote_path.trim().is_empty() {
                    return Err(crate::error::AppError::Configuration(
                        "SSH project remote path must not be empty".to_string(),
                    ));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc_now() -> DateTime<Utc> {
        Utc::now()
    }

    #[test]
    fn local_project_serializes_with_camel_case_and_type_field() {
        let project = Project {
            id: "p1".into(),
            name: "Demo".into(),
            project_type: ProjectType::Local,
            local: Some(LocalProjectConfig {
                path: "D:\\Demo".into(),
            }),
            ssh: None,
            default_profile_id: None,
            created_at: utc_now(),
            updated_at: utc_now(),
        };
        let json = serde_json::to_string(&project).unwrap();
        assert!(json.contains("\"type\":\"local\""));
        assert!(json.contains("\"name\":\"Demo\""));
        assert!(json.contains("\"createdAt\""));
        assert!(json.contains("\"updatedAt\""));
        assert!(!json.contains("ssh"));
        assert!(!json.contains("defaultProfileId"));
    }

    #[test]
    fn ssh_project_serializes_camel_case_fields() {
        let project = Project {
            id: "p2".into(),
            name: "Server".into(),
            project_type: ProjectType::Ssh,
            local: None,
            ssh: Some(SshProjectConfig {
                connection_id: "conn-1".into(),
                remote_path: "/home/user/proj".into(),
            }),
            default_profile_id: None,
            created_at: utc_now(),
            updated_at: utc_now(),
        };
        let json = serde_json::to_string(&project).unwrap();
        assert!(json.contains("\"type\":\"ssh\""));
        assert!(json.contains("\"connectionId\":\"conn-1\""));
        assert!(json.contains("\"remotePath\":\"/home/user/proj\""));
        assert!(json.contains("\"createdAt\""));
        assert!(!json.contains("local"));
    }

    #[test]
    fn default_profile_id_serializes_when_present() {
        let project = Project {
            id: "p3".into(),
            name: "With default".into(),
            project_type: ProjectType::Local,
            local: Some(LocalProjectConfig {
                path: "D:\\Demo".into(),
            }),
            ssh: None,
            default_profile_id: Some("profile-1".into()),
            created_at: utc_now(),
            updated_at: utc_now(),
        };
        let json = serde_json::to_string(&project).unwrap();
        assert!(json.contains("\"defaultProfileId\":\"profile-1\""));
    }

    #[test]
    fn local_project_validates_nonempty_name_and_path() {
        let mut project = Project {
            id: "p".into(),
            name: "Demo".into(),
            project_type: ProjectType::Local,
            local: Some(LocalProjectConfig {
                path: "D:\\Demo".into(),
            }),
            ssh: None,
            default_profile_id: None,
            created_at: utc_now(),
            updated_at: utc_now(),
        };
        assert!(project.validate().is_ok());

        project.name = "  ".into();
        assert!(project.validate().is_err());

        project.name = "Demo".into();
        project.local = Some(LocalProjectConfig { path: "".into() });
        assert!(project.validate().is_err());
    }

    #[test]
    fn ssh_project_validates_connection_and_remote_path() {
        let mut project = Project {
            id: "p".into(),
            name: "Server".into(),
            project_type: ProjectType::Ssh,
            local: None,
            ssh: Some(SshProjectConfig {
                connection_id: "c1".into(),
                remote_path: "/srv".into(),
            }),
            default_profile_id: None,
            created_at: utc_now(),
            updated_at: utc_now(),
        };
        assert!(project.validate().is_ok());

        project.ssh = Some(SshProjectConfig {
            connection_id: "".into(),
            remote_path: "/srv".into(),
        });
        assert!(project.validate().is_err());

        project.ssh = Some(SshProjectConfig {
            connection_id: "c1".into(),
            remote_path: "".into(),
        });
        assert!(project.validate().is_err());
    }

    #[test]
    fn empty_local_config_is_rejected() {
        let project = Project {
            id: "p".into(),
            name: "Demo".into(),
            project_type: ProjectType::Local,
            local: None,
            ssh: None,
            default_profile_id: None,
            created_at: utc_now(),
            updated_at: utc_now(),
        };
        assert!(project.validate().is_err());
    }

    #[test]
    fn json_round_trip_preserves_camel_case_contract() {
        // This test pins the JSON contract that the frontend depends on.
        let project = Project {
            id: "p3".into(),
            name: "Roundtrip".into(),
            project_type: ProjectType::Ssh,
            local: None,
            ssh: Some(SshProjectConfig {
                connection_id: "c".into(),
                remote_path: "/x".into(),
            }),
            default_profile_id: Some("profile-1".into()),
            created_at: utc_now(),
            updated_at: utc_now(),
        };
        let json = serde_json::to_string(&project).unwrap();
        let parsed: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, project.id);
        assert_eq!(parsed.project_type, ProjectType::Ssh);
        assert_eq!(parsed.ssh.unwrap().connection_id, "c");
        assert_eq!(parsed.default_profile_id, Some("profile-1".into()));
    }

    #[test]
    fn frontend_shape_json_deserializes() {
        // Construct the JSON exactly as the TypeScript frontend would write it.
        let json = r#"{
            "id": "p-frontend",
            "name": "Frontend Project",
            "type": "local",
            "local": { "path": "D:\\Projects\\Demo" },
            "defaultProfileId": "profile-1",
            "createdAt": "2026-07-18T00:00:00Z",
            "updatedAt": "2026-07-18T00:00:00Z"
        }"#;
        let parsed: Project = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.id, "p-frontend");
        assert_eq!(parsed.project_type, ProjectType::Local);
        assert_eq!(parsed.local.unwrap().path, "D:\\Projects\\Demo");
        assert_eq!(parsed.default_profile_id, Some("profile-1".into()));
    }
}
