//! Project module: domain model + JSON repository.

pub mod model;
pub mod repository;

pub use model::{LocalProjectConfig, Project, ProjectType, SshProjectConfig, WslProjectConfig};
pub use repository::ProjectRepository;
