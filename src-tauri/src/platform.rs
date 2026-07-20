//! Host platform capabilities.
//!
//! The frontend uses this to decide which project types and shells to offer:
//! on Linux there is no `wsl.exe`, so the WSL project type and shell are
//! hidden; on Windows the POSIX local shells are hidden because PowerShell,
//! CMD, Git Bash, and WSL cover the common cases. The capability list is the
//! single source of truth - components MUST NOT hardcode platform checks.
//!
//! Saved profiles remain loadable on every platform: the `ShellType` and
//! `ProjectType` enums still deserialize every variant. The capability list
//! only controls what the UI offers and what the default profile picks.

use serde::Serialize;

use crate::profile::ShellType;
use crate::project::ProjectType;

/// Host operating system category. The frontend stores this opaquely; only
/// the boolean capability fields drive behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostOs {
    Windows,
    Linux,
    Macos,
    /// Any other unix-like system we have not been taught about. Treat it like
    /// Linux for capability purposes (POSIX shells, no WSL).
    Other,
}

impl HostOs {
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Other
        }
    }

    pub fn is_windows(self) -> bool {
        self == Self::Windows
    }
}

/// Serializable capability snapshot consumed by the frontend. Field names are
/// camelCase to match the TypeScript `PlatformInfo` type.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: HostOs,
    pub wsl_supported: bool,
    pub available_project_types: Vec<ProjectType>,
    pub available_local_shells: Vec<ShellType>,
    pub default_local_shell: ShellType,
}

impl PlatformInfo {
    pub fn current() -> Self {
        let os = HostOs::current();
        let wsl_supported = os.is_windows();
        let available_project_types = if wsl_supported {
            vec![ProjectType::Local, ProjectType::Wsl, ProjectType::Ssh]
        } else {
            vec![ProjectType::Local, ProjectType::Ssh]
        };
        let available_local_shells = if os.is_windows() {
            vec![
                ShellType::Powershell,
                ShellType::Cmd,
                ShellType::GitBash,
                ShellType::Wsl,
                ShellType::Custom,
            ]
        } else {
            vec![
                ShellType::Bash,
                ShellType::Zsh,
                ShellType::Fish,
                ShellType::Sh,
                ShellType::Custom,
            ]
        };
        let default_local_shell = if os.is_windows() {
            ShellType::Powershell
        } else {
            ShellType::Bash
        };
        Self {
            os,
            wsl_supported,
            available_project_types,
            available_local_shells,
            default_local_shell,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_supported_only_on_windows() {
        let info = PlatformInfo::current();
        assert_eq!(info.wsl_supported, cfg!(target_os = "windows"));
    }

    #[test]
    fn windows_offers_windows_shells() {
        if !cfg!(target_os = "windows") {
            return;
        }
        let info = PlatformInfo::current();
        assert!(info.available_local_shells.contains(&ShellType::Powershell));
        assert!(info.available_local_shells.contains(&ShellType::Wsl));
        assert!(!info.available_local_shells.contains(&ShellType::Bash));
        assert!(info.available_project_types.contains(&ProjectType::Wsl));
        assert_eq!(info.default_local_shell, ShellType::Powershell);
    }

    #[test]
    fn non_windows_hides_wsl_and_powershell() {
        if cfg!(target_os = "windows") {
            return;
        }
        let info = PlatformInfo::current();
        assert!(!info.available_local_shells.contains(&ShellType::Wsl));
        assert!(!info.available_local_shells.contains(&ShellType::Powershell));
        assert!(info.available_local_shells.contains(&ShellType::Bash));
        assert!(!info.available_project_types.contains(&ProjectType::Wsl));
        assert_eq!(info.default_local_shell, ShellType::Bash);
    }
}
