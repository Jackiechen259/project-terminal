//! SSH module: connection configuration, client discovery, and safe argv
//! construction. Interactive SSH sessions are intentionally added in Phase 6.

pub mod client;
pub mod command_builder;
pub mod model;
pub mod repository;

pub use client::{detect_ssh_client, resolve_ssh_keygen, SshClient};
pub use command_builder::{build_ssh_argv, build_ssh_test_argv, SshCommand};
pub use model::{SshAuthenticationType, SshConnection, SshJumpHost};
pub use repository::{new_ssh_connection, SshConnectionCollection, SshConnectionRepository};
