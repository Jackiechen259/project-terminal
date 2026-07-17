//! Project module: domain model + JSON repository.

pub mod model;
pub mod repository;

pub use model::{LocalProjectConfig, Project, ProjectType, SshProjectConfig};
pub use repository::{new_local_project, ProjectCollection, ProjectRepository};
