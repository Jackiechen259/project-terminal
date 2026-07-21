//! Discovery of the system OpenSSH tools.
//!
//! We deliberately prefer the Windows OpenSSH client over Git's bundled copy:
//! it integrates with the Windows ssh-agent and follows the user's normal SSH
//! configuration. No executable path is persisted here.

use std::env;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshClient {
    pub executable: PathBuf,
}

pub fn detect_ssh_client() -> Option<SshClient> {
    let executable_name = if cfg!(windows) { "ssh.exe" } else { "ssh" };

    find_on_path(executable_name)
        .or_else(|| windows_openssh_candidate(executable_name))
        .or_else(|| git_openssh_candidate(executable_name))
        .map(|executable| SshClient { executable })
}

pub fn resolve_ssh_keygen(client: &SshClient) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "ssh-keygen.exe"
    } else {
        "ssh-keygen"
    };
    client
        .executable
        .parent()
        .map(|directory| directory.join(name))
        .filter(|path| path.is_file())
        .or_else(|| find_on_path(name))
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|directory| directory.join(name))
            .find(|candidate| candidate.is_file())
    })
}

fn windows_openssh_candidate(name: &str) -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    env::var_os("WINDIR")
        .map(PathBuf::from)
        .map(|windir| windir.join("System32").join("OpenSSH").join(name))
        .filter(|candidate| candidate.is_file())
}

fn git_openssh_candidate(name: &str) -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let candidates = [
        env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .map(|root| root.join("Git").join("usr").join("bin").join(name)),
        env::var_os("ProgramFiles(x86)")
            .map(PathBuf::from)
            .map(|root| root.join("Git").join("usr").join("bin").join(name)),
    ];
    candidates.into_iter().flatten().find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_never_returns_a_non_file() {
        if let Some(client) = detect_ssh_client() {
            assert!(client.executable.is_file());
        }
    }
}
