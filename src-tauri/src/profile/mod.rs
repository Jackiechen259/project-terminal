//! Terminal profile module: domain model + JSON repository.

pub mod model;
pub mod repository;

pub use model::{
    CondaActivationMode, CondaEnvironmentConfig, EnvironmentType, ShellType, TerminalProfile,
};
pub use repository::{
    default_powershell_profile, default_remote_profile, default_wsl_profile, ProfileCollection,
    ProfileRepository,
};
