//! SSH module: domain model + JSON repository.
//!
//! Phase 2 only wires model + repository. Command builder, host-key
//! handling, and detector arrive in Phase 5.

pub mod model;
pub mod repository;

pub use model::{SshAuthenticationType, SshConnection, SshJumpHost};
pub use repository::{new_ssh_connection, SshConnectionCollection, SshConnectionRepository};
