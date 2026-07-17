//! SSH connection JSON repository.

use std::path::PathBuf;

use chrono::Utc;

use crate::error::{AppError, AppResult};
use crate::storage;

use super::model::SshConnection;

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct SshConnectionCollection {
    #[serde(default)]
    pub connections: Vec<SshConnection>,
}

pub struct SshConnectionRepository {
    path: PathBuf,
}

impl SshConnectionRepository {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn load(&self) -> AppResult<SshConnectionCollection> {
        storage::read_or_default(&self.path, SshConnectionCollection::default())
    }

    pub fn save(&self, collection: &SshConnectionCollection) -> AppResult<()> {
        storage::write_json(&self.path, collection)
    }

    pub fn list(&self) -> AppResult<Vec<SshConnection>> {
        Ok(self.load()?.connections)
    }

    pub fn get(&self, id: &str) -> AppResult<SshConnection> {
        self.load()?
            .connections
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| AppError::SshConnectionNotFound(id.to_string()))
    }

    pub fn upsert(&self, conn: SshConnection) -> AppResult<SshConnection> {
        conn.validate()?;
        let mut collection = self.load()?;
        if let Some(existing) = collection.connections.iter_mut().find(|c| c.id == conn.id) {
            *existing = conn.clone();
        } else {
            collection.connections.push(conn.clone());
        }
        self.save(&collection)?;
        Ok(conn)
    }

    /// Delete the connection. `in_use_by` returns the first project id that
    /// still references it; callers (commands) decide whether to block.
    pub fn delete(&self, id: &str, referencing_project_ids: &[String]) -> AppResult<()> {
        if let Some(project_id) = referencing_project_ids.first() {
            return Err(AppError::SshConnectionInUse(project_id.clone()));
        }
        let mut collection = self.load()?;
        let before = collection.connections.len();
        collection.connections.retain(|c| c.id != id);
        if collection.connections.len() == before {
            return Err(AppError::SshConnectionNotFound(id.to_string()));
        }
        self.save(&collection)
    }
}

/// Construct a new SSH connection with sensible defaults and fresh timestamps.
#[allow(clippy::too_many_arguments)]
pub fn new_ssh_connection(
    id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
) -> SshConnection {
    let now = Utc::now();
    SshConnection {
        id,
        name,
        host,
        port,
        username,
        authentication_type: super::model::SshAuthenticationType::Agent,
        identity_file: None,
        use_ssh_agent: true,
        jump_host: None,
        connect_timeout_seconds: 15,
        server_alive_interval_seconds: 30,
        server_alive_count_max: 3,
        strict_host_key_checking: true,
        known_hosts_file: None,
        extra_args: vec![],
        created_at: now,
        updated_at: now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tempdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pt-ssh-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_returns_empty_list() {
        let repo = SshConnectionRepository::new(tempdir().join("missing.json"));
        assert!(repo.list().unwrap().is_empty());
    }

    #[test]
    fn upsert_and_get_round_trip() {
        let repo = SshConnectionRepository::new(tempdir().join("ssh.json"));
        let conn = new_ssh_connection(
            "c1".into(),
            "Katana".into(),
            "katana.example.com".into(),
            22,
            "user".into(),
        );
        repo.upsert(conn).unwrap();
        assert!(repo.get("c1").is_ok());
    }

    #[test]
    fn delete_blocked_when_referenced_by_project() {
        let repo = SshConnectionRepository::new(tempdir().join("ssh.json"));
        repo.upsert(new_ssh_connection(
            "c1".into(),
            "Katana".into(),
            "katana.example.com".into(),
            22,
            "user".into(),
        ))
        .unwrap();
        let err = repo.delete("c1", &["project-1".to_string()]).unwrap_err();
        assert!(matches!(err, AppError::SshConnectionInUse(_)));
        // Connection should still exist after a blocked delete.
        assert!(repo.get("c1").is_ok());
    }

    #[test]
    fn delete_succeeds_when_no_references() {
        let repo = SshConnectionRepository::new(tempdir().join("ssh.json"));
        repo.upsert(new_ssh_connection(
            "c1".into(),
            "Katana".into(),
            "katana.example.com".into(),
            22,
            "user".into(),
        ))
        .unwrap();
        repo.delete("c1", &[]).unwrap();
        assert!(repo.get("c1").is_err());
    }
}
