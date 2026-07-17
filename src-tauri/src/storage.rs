//! Persistent JSON file store with atomic writes and corruption handling.
//!
//! Conventions (per plan §30):
//! - Writes use `tempfile::NamedTempFile::persist`, which on Windows performs
//!   `MoveFileExW(... MOVEFILE_REPLACE_EXISTING)` - an atomic replace that
//!   succeeds even when the target already exists. Plain `fs::rename` on
//!   Windows fails if the destination exists, so it is not safe for repeated
//!   saves.
//! - Corrupt files are NOT overwritten; they are backed up with a timestamp
//!   suffix and a readable error is returned.
//! - Missing files are treated as empty collections (not an error).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::de::DeserializeOwned;
use serde::Serialize;
use tempfile::NamedTempFile;

use crate::error::{AppError, AppResult};

/// Read a JSON file and deserialize into `T`. Returns `default` when the file
/// does not exist. Corrupt files are backed up before returning an error.
pub fn read_or_default<T: DeserializeOwned + Serialize>(path: &Path, default: T) -> AppResult<T> {
    if !path.exists() {
        return Ok(default);
    }
    let bytes = fs::read(path).map_err(AppError::Io)?;
    match serde_json::from_slice::<T>(&bytes) {
        Ok(v) => Ok(v),
        Err(parse_err) => {
            // Back up the corrupt file with a timestamp suffix, then surface
            // a readable error. The original is never overwritten.
            let backup = backup_path(path);
            let _ = fs::rename(path, &backup);
            Err(AppError::Configuration(format!(
                "Configuration file {:?} is corrupt and could not be parsed: {}. A backup was saved at {:?}.",
                path, parse_err, backup
            )))
        }
    }
}

/// Atomically serialize `value` to `path`.
///
/// Writes a `NamedTempFile` in the same directory as `path`, flushes it, then
/// calls `persist` which performs an atomic replace on Windows
/// (`MOVEFILE_REPLACE_EXISTING`) and `renameat2`/`rename` on Unix. The original
/// file is preserved when any step fails.
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(AppError::Io)?;
    }
    let payload = serde_json::to_vec_pretty(value)
        .map_err(|e| AppError::Configuration(format!("Failed to serialize JSON: {e}")))?;

    // Create the temp file in the same directory so `persist` stays an
    // intra-directory rename (atomic on all platforms).
    let mut tmp = NamedTempFile::new_in(
        path.parent()
            .map(|p| {
                if p.as_os_str().is_empty() {
                    Path::new(".")
                } else {
                    p
                }
            })
            .unwrap_or_else(|| Path::new(".")),
    )
    .map_err(AppError::Io)?;
    tmp.write_all(&payload).map_err(AppError::Io)?;
    tmp.as_file().sync_all().map_err(AppError::Io)?;

    tmp.persist(path).map_err(|e| {
        // `PersistError` carries the temp file back so we can drop it cleanly;
        // the inner io::Error is what the caller needs.
        AppError::Io(e.error)
    })?;
    Ok(())
}

fn backup_path(path: &Path) -> PathBuf {
    let ts = Utc::now().format("%Y%m%d-%H%M%S");
    let mut buf = path.to_path_buf();
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".to_string());
    let ext = path
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "json".to_string());
    buf.set_file_name(format!("{stem}.corrupt.{ts}.{ext}"));
    buf
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::fs;

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Item {
        id: String,
        name: String,
    }

    #[derive(Debug, Serialize, Deserialize, PartialEq, Default)]
    struct Items {
        items: Vec<Item>,
    }

    fn tempdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pt-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_returns_default() {
        let path = tempdir().join("missing.json");
        let loaded = read_or_default::<Items>(&path, Items::default()).unwrap();
        assert!(loaded.items.is_empty());
    }

    #[test]
    fn write_then_read_round_trips() {
        let path = tempdir().join("items.json");
        let data = Items {
            items: vec![Item {
                id: "1".into(),
                name: "alpha".into(),
            }],
        };
        write_json(&path, &data).unwrap();
        let loaded = read_or_default::<Items>(&path, Items::default()).unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn write_twice_yields_second_value() {
        // Regression for Windows fs::rename failure on existing target.
        // `write_json` must atomically replace, not error, when `path` exists.
        let path = tempdir().join("overwrite.json");
        let first = Items {
            items: vec![Item {
                id: "1".into(),
                name: "first".into(),
            }],
        };
        let second = Items {
            items: vec![Item {
                id: "2".into(),
                name: "second".into(),
            }],
        };
        write_json(&path, &first).unwrap();
        write_json(&path, &second).unwrap();
        let loaded = read_or_default::<Items>(&path, Items::default()).unwrap();
        assert_eq!(loaded, second);
    }

    #[test]
    fn corrupt_file_backs_up_and_errors() {
        let dir = tempdir();
        let path = dir.join("corrupt.json");
        fs::write(&path, b"{ this is not valid json ").unwrap();
        let result = read_or_default::<Items>(&path, Items::default());
        assert!(result.is_err());
        // Original should be moved aside; the corrupt backup should exist.
        assert!(!path.exists());
        let backups: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("corrupt.corrupt.")
            })
            .collect();
        assert_eq!(backups.len(), 1);
    }

    #[test]
    fn write_creates_parent_directories() {
        let dir = tempdir();
        let path = dir.join("nested").join("deep").join("items.json");
        let data = Items::default();
        write_json(&path, &data).unwrap();
        assert!(path.exists());
    }
}
