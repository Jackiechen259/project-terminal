use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::agent::AgentProfile;
use crate::error::{AppError, AppResult};
use crate::storage;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentProfileCollection {
    profiles: Vec<AgentProfile>,
}

pub struct AgentProfileRepository {
    path: PathBuf,
}

impl AgentProfileRepository {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn list(&self) -> AppResult<Vec<AgentProfile>> {
        Ok(storage::read_or_default(&self.path, AgentProfileCollection::default())?.profiles)
    }

    pub fn get(&self, id: &str) -> AppResult<AgentProfile> {
        self.list()?
            .into_iter()
            .find(|profile| profile.id == id)
            .ok_or_else(|| AppError::Configuration(format!("Agent profile was not found: {id}")))
    }

    pub fn upsert(&self, profile: AgentProfile) -> AppResult<AgentProfile> {
        let mut collection =
            storage::read_or_default(&self.path, AgentProfileCollection::default())?;
        if let Some(existing) = collection
            .profiles
            .iter_mut()
            .find(|item| item.id == profile.id)
        {
            *existing = profile.clone();
        } else {
            collection.profiles.push(profile.clone());
        }
        storage::write_json(&self.path, &collection)?;
        Ok(profile)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut collection =
            storage::read_or_default(&self.path, AgentProfileCollection::default())?;
        let before = collection.profiles.len();
        collection.profiles.retain(|profile| profile.id != id);
        if before == collection.profiles.len() {
            return Err(AppError::Configuration(format!(
                "Agent profile was not found: {id}"
            )));
        }
        storage::write_json(&self.path, &collection)
    }
}
