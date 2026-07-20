//! Project module: domain model + JSON repository.

pub mod model;
pub mod repository;

pub use model::{LocalProjectConfig, Project, ProjectType, SshProjectConfig, WslProjectConfig};
pub use repository::{new_local_project, new_wsl_project, ProjectCollection, ProjectRepository};
