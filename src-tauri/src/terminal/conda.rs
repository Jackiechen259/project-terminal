//! Conda environment detection and listing.
//!
//! Plan §20.2/§20.3: Detect conda installations in common paths when not in PATH.
//! List environments by executing `conda env list --json` and parsing the output.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedCondaEnvironment {
    pub name: Option<String>,
    pub path: String,
    pub is_active: bool,
    pub is_base: bool,
}

/// Look for Conda executables in common locations.
///
/// Prioritizes the existing `CONDA_EXE` env var, then PATH, then well-known
/// install directories. On Windows those are under `%USERPROFILE%` /
/// `%LOCALAPPDATA%` / `C:\\ProgramData`; on Linux/macOS under `$HOME`.
/// Returns an empty vec on hosts with no Conda installed - the frontend treats
/// this as "no Conda found" rather than an error.
pub fn detect_conda_installations() -> Vec<String> {
    let mut found = Vec::new();

    // 1. CONDA_EXE
    if let Some(conda) = std::env::var_os("CONDA_EXE") {
        let p = std::path::Path::new(&conda);
        if p.is_file() {
            found.push(p.to_string_lossy().into_owned());
        }
    }

    // 2. PATH
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for ext in windows_extensions() {
                let candidate = dir.join(format!("conda{ext}"));
                if candidate.is_file() {
                    let s = candidate.to_string_lossy().into_owned();
                    if !found.contains(&s) {
                        found.push(s);
                    }
                }
            }
        }
    }

    // 3. Common install directories.
    for root in common_conda_roots() {
        for relative in conda_relative_bin_paths() {
            let candidate = root.join(relative);
            if candidate.is_file() {
                let s = candidate.to_string_lossy().into_owned();
                if !found.contains(&s) {
                    found.push(s);
                }
            }
        }
    }

    found
}

/// Windows uses `conda.exe` and `conda.bat`; other platforms use the bare
/// `conda` executable.
fn windows_extensions() -> &'static [&'static str] {
    if cfg!(windows) {
        &[".exe", ".bat"]
    } else {
        &[""]
    }
}

/// Per-platform install roots for Conda. Windows checks `%USERPROFILE%`,
/// `%LOCALAPPDATA%`, and `C:\\ProgramData`; Linux/macOS check `$HOME`.
fn common_conda_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let subdirs = ["anaconda3", "miniconda3", "miniforge3"];
    if cfg!(windows) {
        if let Some(up) = std::env::var_os("USERPROFILE") {
            let p = std::path::Path::new(&up);
            roots.extend(subdirs.iter().map(|name| p.join(name)));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let p = std::path::Path::new(&local);
            roots.extend(["anaconda3", "miniconda3"].iter().map(|name| p.join(name)));
        }
        roots.push(PathBuf::from("C:\\ProgramData\\anaconda3"));
        roots.push(PathBuf::from("C:\\ProgramData\\miniconda3"));
    } else if let Some(home) = std::env::var_os("HOME") {
        let p = std::path::Path::new(&home);
        roots.extend(subdirs.iter().map(|name| p.join(name)));
    }
    roots
}

/// Inside a Conda install, the executable lives under `Scripts/conda.exe`
/// (Windows) or `bin/conda` (POSIX). `condabin/conda.bat` is Windows-only and
/// is checked in addition on that platform.
fn conda_relative_bin_paths() -> Vec<std::path::PathBuf> {
    if cfg!(windows) {
        vec![
            std::path::PathBuf::from("Scripts").join("conda.exe"),
            std::path::PathBuf::from("condabin").join("conda.bat"),
        ]
    } else {
        vec![std::path::PathBuf::from("bin").join("conda")]
    }
}

/// Execute `conda env list --json` and parse the environments.
pub fn list_conda_environments(conda_executable: &str) -> AppResult<Vec<DetectedCondaEnvironment>> {
    let output = std::process::Command::new(conda_executable)
        .arg("env")
        .arg("list")
        .arg("--json")
        .output()
        .map_err(|e| {
            AppError::EnvironmentInitializationFailed(format!(
                "Failed to execute {conda_executable}: {e}"
            ))
        })?;

    if !output.status.success() {
        let err_str = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::EnvironmentInitializationFailed(format!(
            "Conda returned an error: {err_str}"
        )));
    }

    parse_conda_env_list(&output.stdout)
}

#[derive(Deserialize)]
struct CondaEnvListJson {
    envs: Vec<String>,
}

/// Pure function to parse the JSON output of `conda env list --json`.
pub fn parse_conda_env_list(json_bytes: &[u8]) -> AppResult<Vec<DetectedCondaEnvironment>> {
    let parsed: CondaEnvListJson = serde_json::from_slice(json_bytes).map_err(|e| {
        AppError::EnvironmentInitializationFailed(format!("Failed to parse conda JSON output: {e}"))
    })?;

    let mut result = Vec::new();
    for env_path in parsed.envs {
        let p = std::path::Path::new(&env_path);
        let parent = p.parent().map(|p| p.to_string_lossy().into_owned());
        let file_name = p.file_name().map(|s| s.to_string_lossy().into_owned());

        let is_base = parent
            .as_ref()
            .map(|s| !s.ends_with("envs"))
            .unwrap_or(true);
        let name = if is_base {
            Some("base".to_string())
        } else {
            file_name
        };

        result.push(DetectedCondaEnvironment {
            name,
            path: env_path,
            is_active: false,
            is_base,
        });
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_conda_env_list_parses_json_output() {
        let raw_json = br#"{
            "envs": [
                "C:\\Users\\User\\miniconda3",
                "C:\\Users\\User\\miniconda3\\envs\\smolvla",
                "D:\\Projects\\.conda"
            ]
        }"#;

        let envs = parse_conda_env_list(raw_json).unwrap();
        assert_eq!(envs.len(), 3);

        // Base environment
        assert_eq!(envs[0].name.as_deref(), Some("base"));
        assert!(envs[0].is_base);
        assert_eq!(envs[0].path, "C:\\Users\\User\\miniconda3");

        // Standard named environment
        assert_eq!(envs[1].name.as_deref(), Some("smolvla"));
        assert!(!envs[1].is_base);
        assert_eq!(envs[1].path, "C:\\Users\\User\\miniconda3\\envs\\smolvla");

        // Prefix environment (outside of `envs` folder, treated as a base)
        assert_eq!(envs[2].name.as_deref(), Some("base"));
        assert!(envs[2].is_base);
        assert_eq!(envs[2].path, "D:\\Projects\\.conda");
    }

    #[test]
    fn parse_conda_env_list_rejects_invalid_json() {
        let raw_json = b"invalid";
        let err = parse_conda_env_list(raw_json).unwrap_err();
        assert!(matches!(err, AppError::EnvironmentInitializationFailed(_)));
    }
}
