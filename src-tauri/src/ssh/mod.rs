//! SSH module: connection configuration, client discovery, and safe argv
//! construction. Interactive SSH sessions are intentionally added in Phase 6.

pub mod client;
pub mod command_builder;
pub mod model;
pub mod repository;

pub use client::{detect_ssh_client, resolve_ssh_keygen};
pub use command_builder::{
    build_ssh_argv_with_remote_command, build_ssh_browse_argv, build_ssh_test_argv,
};
pub use model::{SshAuthenticationType, SshConnection, SshJumpHost};
pub use repository::SshConnectionRepository;
