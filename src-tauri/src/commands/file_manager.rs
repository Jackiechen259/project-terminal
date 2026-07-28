//! Project-scoped file browsing and transfer commands.
//!
//! The frontend uses one API for local, WSL, and SSH projects. Local paths
//! are read directly, WSL files are listed through `wsl.exe` and copied
//! through the distribution's UNC share, and SSH transfers use the system
//! OpenSSH `ssh`/`scp` clients with the saved connection settings.

use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::commands::ssh::{apply_saved_password_environment, refresh_password_status};
use crate::error::{AppError, AppResult};
use crate::project::{Project, ProjectType};
use crate::ssh::{SshAuthenticationType, SshConnection};
use crate::state::AppState;

const FILE_ENTRY_LIMIT: usize = 2_000;
const LIST_TIMEOUT: Duration = Duration::from_secs(30);

/// Remote/WSL directory listing.
///
/// Two things keep this cheap on large directories: the loop stops at
/// `__ENTRY_LIMIT__` so the remote host neither enumerates nor transmits more
/// than the client will show, and sizes come from a single batched `wc -c`
/// instead of one fork per file. Sizes are separated from the entry list by a
/// lone `/`, which a glob can never produce as a filename.
///
/// `stat` is deliberately avoided: it is not POSIX and its flags differ
/// between GNU (`-c %s`) and BSD (`-f %z`), while this must run under `sh` on
/// arbitrary SSH hosts and WSL distributions.
const POSIX_LIST_SCRIPT_TEMPLATE: &str = r#"resolve_path() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${1#~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}
root=$(resolve_path "$1") || exit 40
target=$(resolve_path "$2") || exit 40
cd "$root" || exit 41
root=$PWD
cd "$target" || exit 42
current=$PWD
if [ "$root" != "/" ]; then
  case "$current" in
    "$root"|"$root"/*) ;;
    *) printf '%s\n' "Path is outside the project root" >&2; exit 43 ;;
  esac
fi
printf '%s\0%s\0' "$root" "$current"
count=0
set --
for file in .[!.]* ..?* *; do
  [ -e "$file" ] || [ -L "$file" ] || continue
  if [ -d "$file" ]; then
    kind=d
  else
    kind=f
    set -- "$@" "$file"
  fi
  printf '%s\0%s\0' "$file" "$kind"
  count=$((count + 1))
  if [ "$count" -ge __ENTRY_LIMIT__ ]; then
    break
  fi
done
printf '/\0'
if [ "$#" -gt 0 ]; then
  wc -c -- "$@" 2>/dev/null
fi
"#;

/// Marks the boundary between the entry list and the batched size output.
const POSIX_SIZE_SENTINEL: &[u8] = b"/";

fn posix_list_script() -> &'static str {
    static SCRIPT: OnceLock<String> = OnceLock::new();
    SCRIPT.get_or_init(|| {
        POSIX_LIST_SCRIPT_TEMPLATE.replace("__ENTRY_LIMIT__", &FILE_ENTRY_LIMIT.to_string())
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileListing {
    pub root_path: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_path: Option<String>,
    pub entries: Vec<ProjectFileEntry>,
}

pub fn list_project_files_inner(
    state: &AppState,
    project_id: &str,
    requested_path: Option<&str>,
) -> AppResult<ProjectFileListing> {
    let project = state.projects.get(project_id)?;
    match project.project_type {
        ProjectType::Local => list_local_files(&project, requested_path),
        ProjectType::Wsl => list_wsl_files(&project, requested_path),
        ProjectType::Ssh => list_ssh_files(state, &project, requested_path),
    }
}

pub fn upload_project_files_inner(
    state: &AppState,
    project_id: &str,
    destination_path: &str,
    source_paths: &[String],
) -> AppResult<()> {
    if source_paths.is_empty() {
        return Err(AppError::Configuration(
            "Choose at least one file to upload".into(),
        ));
    }
    let project = state.projects.get(project_id)?;
    match project.project_type {
        ProjectType::Local => {
            let destination = checked_local_directory(&project, destination_path)?;
            copy_sources_into(source_paths, &destination)
        }
        ProjectType::Wsl => {
            let wsl = project.wsl.as_ref().ok_or_else(|| {
                AppError::Configuration("WSL project is missing its configuration".into())
            })?;
            let listing = list_wsl_files(&project, Some(destination_path))?;
            validate_posix_project_path(&listing.root_path, destination_path)?;
            let destination = wsl_unc_path(&wsl.distribution, destination_path)?;
            copy_sources_into(source_paths, &destination)
        }
        ProjectType::Ssh => {
            let ssh = project.ssh.as_ref().ok_or_else(|| {
                AppError::Configuration("SSH project is missing its configuration".into())
            })?;
            let listing = list_ssh_files(state, &project, Some(destination_path))?;
            validate_posix_project_path(&listing.root_path, destination_path)?;
            let connection = refresh_password_status(state.ssh.get(&ssh.connection_id)?)?;
            run_ssh_upload(&connection, source_paths, destination_path)
        }
    }
}

pub fn download_project_file_inner(
    state: &AppState,
    project_id: &str,
    source_path: &str,
    destination_directory: &str,
    is_directory: bool,
) -> AppResult<()> {
    let destination = PathBuf::from(destination_directory);
    if !destination.is_dir() {
        return Err(AppError::Configuration(format!(
            "Download destination is not a directory: {}",
            destination.display()
        )));
    }
    let project = state.projects.get(project_id)?;
    match project.project_type {
        ProjectType::Local => {
            let source = checked_local_path(&project, source_path)?;
            copy_path_into(&source, &destination)
        }
        ProjectType::Wsl => {
            let wsl = project.wsl.as_ref().ok_or_else(|| {
                AppError::Configuration("WSL project is missing its configuration".into())
            })?;
            let listing = list_wsl_files(&project, None)?;
            validate_posix_project_path(&listing.root_path, source_path)?;
            let source = wsl_unc_path(&wsl.distribution, source_path)?;
            copy_path_into(&source, &destination)
        }
        ProjectType::Ssh => {
            let ssh = project.ssh.as_ref().ok_or_else(|| {
                AppError::Configuration("SSH project is missing its configuration".into())
            })?;
            let listing = list_ssh_files(state, &project, None)?;
            validate_posix_project_path(&listing.root_path, source_path)?;
            let connection = refresh_password_status(state.ssh.get(&ssh.connection_id)?)?;
            run_ssh_download(
                &connection,
                source_path,
                destination_directory,
                is_directory,
            )
        }
    }
}

fn list_local_files(
    project: &Project,
    requested_path: Option<&str>,
) -> AppResult<ProjectFileListing> {
    let local = project.local.as_ref().ok_or_else(|| {
        AppError::Configuration("Local project is missing its configuration".into())
    })?;
    let root = fs::canonicalize(&local.path)
        .map_err(|_| AppError::ProjectPathNotFound(local.path.clone()))?;
    let requested = requested_path
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| root.clone());
    let current = fs::canonicalize(&requested)?;
    if !current.starts_with(&root) || !current.is_dir() {
        return Err(AppError::Configuration(
            "The requested folder is outside the project root".into(),
        ));
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&current)?.take(FILE_ENTRY_LIMIT) {
        let entry = entry?;
        let metadata = entry.metadata()?;
        entries.push(ProjectFileEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_directory: metadata.is_dir(),
            size: metadata.is_file().then_some(metadata.len()),
        });
    }
    sort_entries(&mut entries);
    let parent_path = (current != root)
        .then(|| {
            current
                .parent()
                .map(|path| path.to_string_lossy().into_owned())
        })
        .flatten();
    Ok(ProjectFileListing {
        root_path: root.to_string_lossy().into_owned(),
        path: current.to_string_lossy().into_owned(),
        parent_path,
        entries,
    })
}

fn list_wsl_files(
    project: &Project,
    requested_path: Option<&str>,
) -> AppResult<ProjectFileListing> {
    let wsl = project.wsl.as_ref().ok_or_else(|| {
        AppError::Configuration("WSL project is missing its configuration".into())
    })?;
    let root = wsl.working_directory.as_deref().unwrap_or("~");
    let target = requested_path
        .filter(|path| !path.is_empty())
        .unwrap_or(root);
    let mut command = Command::new("wsl.exe");
    command.args([
        "-d",
        &wsl.distribution,
        "--",
        "sh",
        "-c",
        posix_list_script(),
        "sh",
        root,
        target,
    ]);
    let output = run_bounded(command, LIST_TIMEOUT)?;
    parse_posix_listing_output(output, "WSL")
}

fn list_ssh_files(
    state: &AppState,
    project: &Project,
    requested_path: Option<&str>,
) -> AppResult<ProjectFileListing> {
    let ssh = project.ssh.as_ref().ok_or_else(|| {
        AppError::Configuration("SSH project is missing its configuration".into())
    })?;
    let connection = refresh_password_status(state.ssh.get(&ssh.connection_id)?)?;
    let client = crate::ssh::detect_ssh_client().ok_or(AppError::SshClientNotFound)?;
    let target = requested_path
        .filter(|path| !path.is_empty())
        .unwrap_or(&ssh.remote_path);
    let remote_command = format!(
        "sh -c {} sh {} {}",
        shell_quote(posix_list_script()),
        shell_quote(&ssh.remote_path),
        shell_quote(target)
    );
    let ssh_command = crate::ssh::build_ssh_browse_argv(&connection, remote_command);
    let mut command = Command::new(client.executable);
    command.args(ssh_command.args);
    apply_saved_password_environment(&mut command, &connection)?;
    let output = run_bounded(command, LIST_TIMEOUT)?;
    parse_posix_listing_output(output, "SSH")
}

/// Parse the batched `wc -c` block into sizes keyed by filename.
///
/// Each line is `<padding><size> <name>`, and the name may contain spaces, so
/// it is everything after the first space. `wc` appends a `total` line only
/// when it was given more than one file; `expected` identifies that line by
/// count rather than by its name, so a file actually named `total` still
/// resolves correctly. A name containing a newline gets no size, which is no
/// worse than the previous per-file probe reporting zero.
fn parse_wc_sizes(block: &[u8], expected: usize) -> HashMap<String, u64> {
    let text = String::from_utf8_lossy(block);
    let mut lines: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    if lines.len() == expected + 1 {
        lines.pop();
    }

    let mut sizes = HashMap::with_capacity(lines.len());
    for line in lines {
        let trimmed = line.trim_start();
        let Some((size, name)) = trimmed.split_once(' ') else {
            continue;
        };
        if let Ok(size) = size.parse::<u64>() {
            sizes.insert(name.to_string(), size);
        }
    }
    sizes
}

fn parse_posix_listing_output(output: Output, transport: &str) -> AppResult<ProjectFileListing> {
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Configuration(if detail.is_empty() {
            format!("{transport} file listing exited with {}", output.status)
        } else {
            detail
        }));
    }
    let fields: Vec<&[u8]> = output.stdout.split(|byte| *byte == 0).collect();
    // Layout: root, current, (name, kind)*, "/", <batched `wc -c` output>.
    let sentinel = fields
        .iter()
        .skip(2)
        .position(|field| *field == POSIX_SIZE_SENTINEL)
        .map(|index| index + 2);
    let Some(sentinel) = sentinel.filter(|index| (index - 2) % 2 == 0) else {
        return Err(AppError::Configuration(format!(
            "{transport} returned an invalid file listing"
        )));
    };

    let root = String::from_utf8_lossy(fields[0]).into_owned();
    let current = String::from_utf8_lossy(fields[1]).into_owned();
    let mut entries = Vec::new();
    for chunk in fields[2..sentinel].chunks_exact(2) {
        let name = String::from_utf8_lossy(chunk[0]).into_owned();
        entries.push(ProjectFileEntry {
            path: join_posix_path(&current, &name),
            name,
            is_directory: chunk[1] == b"d",
            size: None,
        });
    }

    let regular_files = entries.iter().filter(|entry| !entry.is_directory).count();
    let sizes = parse_wc_sizes(
        fields.get(sentinel + 1).copied().unwrap_or_default(),
        regular_files,
    );
    for entry in entries.iter_mut().filter(|entry| !entry.is_directory) {
        entry.size = sizes.get(entry.name.as_str()).copied();
    }

    sort_entries(&mut entries);
    let parent_path = (current != root).then(|| posix_parent(&current));
    Ok(ProjectFileListing {
        root_path: root,
        path: current,
        parent_path,
        entries,
    })
}

fn checked_local_path(project: &Project, requested: &str) -> AppResult<PathBuf> {
    let local = project.local.as_ref().ok_or_else(|| {
        AppError::Configuration("Local project is missing its configuration".into())
    })?;
    let root = fs::canonicalize(&local.path)?;
    let path = fs::canonicalize(requested)?;
    if !path.starts_with(root) {
        return Err(AppError::Configuration(
            "The requested file is outside the project root".into(),
        ));
    }
    Ok(path)
}

fn checked_local_directory(project: &Project, requested: &str) -> AppResult<PathBuf> {
    let path = checked_local_path(project, requested)?;
    if !path.is_dir() {
        return Err(AppError::Configuration(
            "The upload destination is not a directory".into(),
        ));
    }
    Ok(path)
}

fn copy_sources_into(source_paths: &[String], destination: &Path) -> AppResult<()> {
    if !destination.is_dir() {
        return Err(AppError::Configuration(format!(
            "Upload destination is not a directory: {}",
            destination.display()
        )));
    }
    for source in source_paths {
        copy_path_into(Path::new(source), destination)?;
    }
    Ok(())
}

fn copy_path_into(source: &Path, destination_directory: &Path) -> AppResult<()> {
    if !source.exists() {
        return Err(AppError::ProjectPathNotFound(
            source.to_string_lossy().into_owned(),
        ));
    }
    let name = source.file_name().ok_or_else(|| {
        AppError::Configuration(format!("Cannot determine the name of {}", source.display()))
    })?;
    let destination = destination_directory.join(name);
    if source.is_dir() {
        copy_directory(source, &destination)
    } else {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, destination)?;
        Ok(())
    }
}

fn copy_directory(source: &Path, destination: &Path) -> AppResult<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else {
            fs::copy(source_path, destination_path)?;
        }
    }
    Ok(())
}

fn wsl_unc_path(distribution: &str, linux_path: &str) -> AppResult<PathBuf> {
    let distribution = distribution.trim();
    if distribution.is_empty()
        || distribution
            .chars()
            .any(|character| matches!(character, '\\' | '/' | ':'))
    {
        return Err(AppError::Configuration(
            "The WSL distribution name is invalid".into(),
        ));
    }
    let path = linux_path.trim();
    if !path.starts_with('/') || path.split('/').any(|segment| segment == "..") {
        return Err(AppError::Configuration(
            "WSL transfers require an absolute path inside the project".into(),
        ));
    }
    let mut result = PathBuf::from(format!(r"\\wsl.localhost\{}", distribution));
    for segment in path.split('/').filter(|segment| !segment.is_empty()) {
        result.push(segment);
    }
    Ok(result)
}

fn run_ssh_upload(
    connection: &SshConnection,
    source_paths: &[String],
    destination_path: &str,
) -> AppResult<()> {
    for path in source_paths {
        if !Path::new(path).exists() {
            return Err(AppError::ProjectPathNotFound(path.clone()));
        }
    }
    if let Some(rsync) = usable_rsync(connection) {
        if let Some(sources) = rsync_local_paths(&rsync, source_paths) {
            let mut args = rsync_common_args(connection);
            args.extend(sources);
            args.push(rsync_remote_spec(connection, destination_path));
            return run_rsync(connection, &rsync, args);
        }
    }
    run_scp_upload(connection, source_paths, destination_path)
}

fn run_ssh_download(
    connection: &SshConnection,
    source_path: &str,
    destination_directory: &str,
    is_directory: bool,
) -> AppResult<()> {
    if let Some(rsync) = usable_rsync(connection) {
        if let Some(destination) = rsync_local_path(&rsync, destination_directory) {
            let mut args = rsync_common_args(connection);
            args.push(rsync_remote_spec(connection, source_path));
            args.push(destination);
            return run_rsync(connection, &rsync, args);
        }
    }
    run_scp_download(connection, source_path, destination_directory, is_directory)
}

fn usable_rsync(connection: &SshConnection) -> Option<PathBuf> {
    let rsync = crate::ssh::detect_rsync()?;
    remote_has_rsync(connection).then_some(rsync)
}

/// Probe whether the remote host has rsync, caching the answer per target.
///
/// Without the cache every upload and download opens an extra SSH connection
/// just to run `command -v rsync`. Transport failures are not cached so a
/// transient network blip does not disable rsync for the session; a cached
/// `false` only costs speed, since scp is always a correct fallback.
fn remote_has_rsync(connection: &SshConnection) -> bool {
    static PROBED: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    let cache = PROBED.get_or_init(|| Mutex::new(HashMap::new()));
    // Editing a connection's target invalidates the entry naturally.
    let key = format!(
        "{}|{}|{}|{}",
        connection.id, connection.host, connection.port, connection.username
    );
    if let Some(known) = cache.lock().get(&key) {
        return *known;
    }

    let Some(client) = crate::ssh::detect_ssh_client() else {
        return false;
    };
    let probe =
        crate::ssh::build_ssh_browse_argv(connection, "command -v rsync >/dev/null 2>&1".into());
    let mut command = Command::new(client.executable);
    command.args(probe.args);
    if apply_saved_password_environment(&mut command, connection).is_err() {
        return false;
    }
    match run_bounded(command, Duration::from_secs(10)) {
        Ok(output) => {
            let available = output.status.success();
            cache.lock().insert(key, available);
            available
        }
        Err(_) => false,
    }
}

fn run_rsync(connection: &SshConnection, executable: &Path, args: Vec<String>) -> AppResult<()> {
    let mut command = Command::new(executable);
    command.args(args);
    apply_saved_password_environment(&mut command, connection)?;
    let output = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| AppError::SshConnectionFailed(error.to_string()))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(AppError::SshConnectionFailed(if detail.is_empty() {
            format!("rsync exited with {}", output.status)
        } else {
            detail
        }))
    }
}

fn rsync_common_args(connection: &SshConnection) -> Vec<String> {
    vec![
        "--archive".into(),
        "--partial".into(),
        "--protect-args".into(),
        "--rsh".into(),
        rsync_ssh_command(connection),
    ]
}

fn rsync_ssh_command(connection: &SshConnection) -> String {
    let mut args = vec![
        "ssh".to_string(),
        "-p".into(),
        connection.port.to_string(),
        "-o".into(),
        format!("ConnectTimeout={}", connection.connect_timeout_seconds),
        "-o".into(),
        format!(
            "ServerAliveInterval={}",
            connection.server_alive_interval_seconds
        ),
        "-o".into(),
        format!("ServerAliveCountMax={}", connection.server_alive_count_max),
        "-o".into(),
        "StrictHostKeyChecking=ask".into(),
    ];
    if let Some(identity_file) = &connection.identity_file {
        args.extend(["-i".into(), identity_file.replace('\\', "/")]);
    }
    if let Some(known_hosts_file) = &connection.known_hosts_file {
        args.extend([
            "-o".into(),
            format!("UserKnownHostsFile={}", known_hosts_file.replace('\\', "/")),
        ]);
    }
    if let Some(jump) = &connection.jump_host {
        let username = jump
            .username
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("{value}@"))
            .unwrap_or_default();
        args.extend([
            "-J".into(),
            format!("{username}{}:{}", jump.host, jump.port),
        ]);
    }
    match connection.authentication_type {
        SshAuthenticationType::Agent => {
            args.extend(["-o".into(), "PreferredAuthentications=publickey".into()])
        }
        SshAuthenticationType::Key => args.extend(["-o".into(), "IdentitiesOnly=yes".into()]),
        SshAuthenticationType::Password => args.extend([
            "-o".into(),
            "PreferredAuthentications=password,keyboard-interactive".into(),
        ]),
        SshAuthenticationType::KeyboardInteractive => args.extend([
            "-o".into(),
            "PreferredAuthentications=keyboard-interactive".into(),
        ]),
        SshAuthenticationType::SystemConfig => {}
    }
    args.extend(connection.extra_args.iter().cloned());
    args.iter()
        .map(|argument| shell_quote(argument))
        .collect::<Vec<_>>()
        .join(" ")
}

fn rsync_local_paths(executable: &Path, paths: &[String]) -> Option<Vec<String>> {
    paths
        .iter()
        .map(|path| rsync_local_path(executable, path))
        .collect()
}

fn rsync_local_path(executable: &Path, path: &str) -> Option<String> {
    if !cfg!(windows) {
        return Some(path.to_string());
    }
    let normalized = path.replace('\\', "/");
    let bytes = normalized.as_bytes();
    if bytes.len() >= 3 && bytes[1] == b':' && bytes[2] == b'/' {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let suffix = &normalized[3..];
        let executable = executable.to_string_lossy().to_ascii_lowercase();
        let prefix = if executable.contains("\\git\\") || executable.contains("\\msys") {
            format!("/{drive}")
        } else {
            format!("/cygdrive/{drive}")
        };
        return Some(if suffix.is_empty() {
            prefix
        } else {
            format!("{prefix}/{suffix}")
        });
    }
    // UNC path mappings differ across Windows rsync distributions. Falling
    // back to scp is safer than letting rsync interpret it as a remote spec.
    (!normalized.starts_with("//")).then_some(normalized)
}

fn rsync_remote_spec(connection: &SshConnection, path: &str) -> String {
    format!("{}:{}", ssh_remote_host(connection), path)
}

fn ssh_remote_host(connection: &SshConnection) -> String {
    if connection.authentication_type != SshAuthenticationType::SystemConfig
        && !connection.username.trim().is_empty()
    {
        format!("{}@{}", connection.username, connection.host)
    } else {
        connection.host.clone()
    }
}

fn run_scp_upload(
    connection: &SshConnection,
    source_paths: &[String],
    destination_path: &str,
) -> AppResult<()> {
    let recursive = source_paths.iter().any(|path| Path::new(path).is_dir());
    let mut args = scp_common_args(connection, recursive);
    args.extend(source_paths.iter().cloned());
    args.push(scp_remote_spec(connection, destination_path));
    run_scp(connection, args)
}

fn run_scp_download(
    connection: &SshConnection,
    source_path: &str,
    destination_directory: &str,
    is_directory: bool,
) -> AppResult<()> {
    let mut args = scp_common_args(connection, is_directory);
    args.push(scp_remote_spec(connection, source_path));
    args.push(destination_directory.to_string());
    run_scp(connection, args)
}

fn run_scp(connection: &SshConnection, args: Vec<String>) -> AppResult<()> {
    let client = crate::ssh::detect_ssh_client().ok_or(AppError::SshClientNotFound)?;
    let scp = crate::ssh::resolve_scp(&client)
        .ok_or_else(|| AppError::Configuration("The OpenSSH scp client was not found".into()))?;
    let mut command = Command::new(scp);
    command.args(args);
    apply_saved_password_environment(&mut command, connection)?;
    let output = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| AppError::SshConnectionFailed(error.to_string()))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(AppError::SshConnectionFailed(if detail.is_empty() {
            format!("scp exited with {}", output.status)
        } else {
            detail
        }))
    }
}

fn scp_common_args(connection: &SshConnection, recursive: bool) -> Vec<String> {
    let mut args = vec![
        "-P".into(),
        connection.port.to_string(),
        "-o".into(),
        format!("ConnectTimeout={}", connection.connect_timeout_seconds),
        "-o".into(),
        format!(
            "ServerAliveInterval={}",
            connection.server_alive_interval_seconds
        ),
        "-o".into(),
        format!("ServerAliveCountMax={}", connection.server_alive_count_max),
        "-o".into(),
        "StrictHostKeyChecking=ask".into(),
    ];
    if recursive {
        args.push("-r".into());
    }
    if let Some(identity_file) = &connection.identity_file {
        args.extend(["-i".into(), identity_file.clone()]);
    }
    if let Some(known_hosts_file) = &connection.known_hosts_file {
        args.extend([
            "-o".into(),
            format!("UserKnownHostsFile={known_hosts_file}"),
        ]);
    }
    if let Some(jump) = &connection.jump_host {
        let username = jump
            .username
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("{value}@"))
            .unwrap_or_default();
        args.extend([
            "-J".into(),
            format!("{username}{}:{}", jump.host, jump.port),
        ]);
    }
    match connection.authentication_type {
        SshAuthenticationType::Agent => {
            args.extend(["-o".into(), "PreferredAuthentications=publickey".into()])
        }
        SshAuthenticationType::Key => args.extend(["-o".into(), "IdentitiesOnly=yes".into()]),
        SshAuthenticationType::Password => args.extend([
            "-o".into(),
            "PreferredAuthentications=password,keyboard-interactive".into(),
        ]),
        SshAuthenticationType::KeyboardInteractive => args.extend([
            "-o".into(),
            "PreferredAuthentications=keyboard-interactive".into(),
        ]),
        SshAuthenticationType::SystemConfig => {}
    }
    args.extend(connection.extra_args.iter().cloned());
    args
}

fn scp_remote_spec(connection: &SshConnection, path: &str) -> String {
    format!("{}:{}", ssh_remote_host(connection), shell_quote(path))
}

fn run_bounded(mut command: Command, timeout: Duration) -> AppResult<Output> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(AppError::Io)?;
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output().map_err(AppError::Io);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::Configuration(format!(
                "File listing timed out after {} seconds",
                timeout.as_secs()
            )));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn join_posix_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", parent.trim_end_matches('/'))
    }
}

fn validate_posix_project_path(root: &str, path: &str) -> AppResult<()> {
    let root = root.trim_end_matches('/');
    let root = if root.is_empty() { "/" } else { root };
    let path = path.trim_end_matches('/');
    let path = if path.is_empty() { "/" } else { path };
    if !path.starts_with('/')
        || path.split('/').any(|segment| segment == "..")
        || (root != "/" && path != root && !path.starts_with(&format!("{root}/")))
    {
        return Err(AppError::Configuration(
            "The requested path is outside the project root".into(),
        ));
    }
    Ok(())
}

fn posix_parent(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some(("", _)) | None => "/".into(),
        Some((parent, _)) => parent.into(),
    }
}

fn sort_entries(entries: &mut [ProjectFileEntry]) {
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
}

#[tauri::command]
pub async fn list_project_files(
    state: tauri::State<'_, AppState>,
    project_id: String,
    path: Option<String>,
) -> AppResult<ProjectFileListing> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_project_files_inner(&state, &project_id, path.as_deref())
    })
    .await
    .map_err(|error| AppError::Configuration(format!("File worker failed: {error}")))?
}

#[tauri::command]
pub async fn upload_project_files(
    state: tauri::State<'_, AppState>,
    project_id: String,
    destination_path: String,
    source_paths: Vec<String>,
) -> AppResult<()> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        upload_project_files_inner(&state, &project_id, &destination_path, &source_paths)
    })
    .await
    .map_err(|error| AppError::Configuration(format!("Upload worker failed: {error}")))?
}

#[tauri::command]
pub async fn download_project_file(
    state: tauri::State<'_, AppState>,
    project_id: String,
    source_path: String,
    destination_directory: String,
    is_directory: bool,
) -> AppResult<()> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        download_project_file_inner(
            &state,
            &project_id,
            &source_path,
            &destination_directory,
            is_directory,
        )
    })
    .await
    .map_err(|error| AppError::Configuration(format!("Download worker failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{ProfileRepository, TemplateRepository};
    use crate::project::{LocalProjectConfig, ProjectRepository};
    use crate::ssh::SshConnectionRepository;
    use chrono::Utc;

    /// Build the script's stdout: NUL-terminated fields, then the `wc` block.
    fn posix_listing_stdout(fields: &[&str], sizes: &str) -> Vec<u8> {
        let mut stdout = Vec::new();
        for field in fields {
            stdout.extend_from_slice(field.as_bytes());
            stdout.push(0);
        }
        stdout.extend_from_slice(b"/\0");
        stdout.extend_from_slice(sizes.as_bytes());
        stdout
    }

    #[test]
    fn parses_and_sorts_posix_listing() {
        let output = Output {
            status: success_status(),
            stdout: posix_listing_stdout(
                &["/srv", "/srv/app", "z.txt", "f", "src", "d"],
                "      3 z.txt\n",
            ),
            stderr: Vec::new(),
        };
        let listing = parse_posix_listing_output(output, "test").unwrap();
        assert_eq!(listing.root_path, "/srv");
        assert_eq!(listing.parent_path.as_deref(), Some("/srv"));
        assert!(listing.entries[0].is_directory);
        assert_eq!(listing.entries[0].path, "/srv/app/src");
        assert_eq!(listing.entries[1].size, Some(3));
        assert_eq!(listing.entries[0].size, None);
    }

    #[test]
    fn posix_listing_matches_sizes_with_spaces_and_drops_the_total_line() {
        let output = Output {
            status: success_status(),
            stdout: posix_listing_stdout(
                &[
                    "/srv",
                    "/srv",
                    "name with spaces.txt",
                    "f",
                    "plain.txt",
                    "f",
                    "sub",
                    "d",
                ],
                "     11 name with spaces.txt\n      3 plain.txt\n     14 total\n",
            ),
            stderr: Vec::new(),
        };
        let listing = parse_posix_listing_output(output, "test").unwrap();
        let by_name = |name: &str| {
            listing
                .entries
                .iter()
                .find(|entry| entry.name == name)
                .unwrap()
                .size
        };
        assert_eq!(by_name("name with spaces.txt"), Some(11));
        assert_eq!(by_name("plain.txt"), Some(3));
        assert_eq!(by_name("sub"), None);
    }

    #[test]
    fn posix_listing_keeps_a_single_files_size_when_wc_prints_no_total() {
        let output = Output {
            status: success_status(),
            stdout: posix_listing_stdout(&["/srv", "/srv", "only.txt", "f"], "2 only.txt\n"),
            stderr: Vec::new(),
        };
        let listing = parse_posix_listing_output(output, "test").unwrap();
        assert_eq!(listing.entries[0].size, Some(2));
    }

    #[test]
    fn posix_listing_handles_a_directory_with_no_regular_files() {
        let output = Output {
            status: success_status(),
            stdout: posix_listing_stdout(&["/srv", "/srv", "a", "d", "b", "d"], ""),
            stderr: Vec::new(),
        };
        let listing = parse_posix_listing_output(output, "test").unwrap();
        assert_eq!(listing.entries.len(), 2);
        assert!(listing.entries.iter().all(|entry| entry.is_directory));
    }

    #[test]
    fn posix_listing_rejects_output_without_a_size_sentinel() {
        let mut stdout = Vec::new();
        for field in ["/srv", "/srv", "a", "f"] {
            stdout.extend_from_slice(field.as_bytes());
            stdout.push(0);
        }
        let output = Output {
            status: success_status(),
            stdout,
            stderr: Vec::new(),
        };
        assert!(parse_posix_listing_output(output, "test").is_err());
    }

    #[test]
    fn posix_list_script_bakes_in_the_entry_limit() {
        let script = posix_list_script();
        assert!(!script.contains("__ENTRY_LIMIT__"));
        assert!(script.contains(&format!("\"$count\" -ge {FILE_ENTRY_LIMIT}")));
        // Sizes must come from one batched call, not a fork per file.
        assert!(script.contains("wc -c -- \"$@\""));
    }

    #[test]
    fn quotes_shell_metacharacters_as_one_argument() {
        assert_eq!(shell_quote("/srv/a; b"), "'/srv/a; b'");
        assert_eq!(shell_quote("/srv/it's"), "'/srv/it'\"'\"'s'");
    }

    #[test]
    fn wsl_unc_rejects_relative_and_parent_paths() {
        assert!(wsl_unc_path("Ubuntu", "home/user").is_err());
        assert!(wsl_unc_path("Ubuntu", "/home/../etc").is_err());
        assert!(wsl_unc_path(r"..\Ubuntu", "/home/user").is_err());
        assert_eq!(
            wsl_unc_path("Ubuntu", "/home/user")
                .unwrap()
                .to_string_lossy(),
            r"\\wsl.localhost\Ubuntu\home\user"
        );
    }

    #[test]
    fn project_path_validation_stays_within_root() {
        assert!(validate_posix_project_path("/srv/app", "/srv/app/src").is_ok());
        assert!(validate_posix_project_path("/", "/etc").is_ok());
        assert!(validate_posix_project_path("/srv/app", "/srv/application").is_err());
        assert!(validate_posix_project_path("/srv/app", "/srv/app/../secret").is_err());
    }

    #[test]
    fn rsync_builds_a_quoted_ssh_transport_and_remote_spec() {
        let connection = sample_ssh_connection();
        let command = rsync_ssh_command(&connection);
        assert!(command.contains("'ssh' '-p' '2200'"));
        assert!(command.contains("'IdentitiesOnly=yes'"));
        assert!(command.contains("'C:/Keys/id key'"));
        assert_eq!(
            rsync_remote_spec(&connection, "/srv/app with spaces"),
            "dev@example.com:/srv/app with spaces"
        );
    }

    #[test]
    #[cfg(windows)]
    fn rsync_windows_paths_are_adapted_and_unc_paths_fall_back() {
        let cygwin = Path::new(r"C:\Tools\cwRsync\bin\rsync.exe");
        assert_eq!(
            rsync_local_path(cygwin, r"D:\Projects\demo").as_deref(),
            Some("/cygdrive/d/Projects/demo")
        );
        let msys = Path::new(r"C:\Program Files\Git\usr\bin\rsync.exe");
        assert_eq!(
            rsync_local_path(msys, r"D:\Projects\demo").as_deref(),
            Some("/d/Projects/demo")
        );
        assert!(rsync_local_path(cygwin, r"\\server\share\demo").is_none());
    }

    #[test]
    fn local_project_listing_and_transfer_stay_project_scoped() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config");
        let root = temp.path().join("project");
        let source_root = temp.path().join("source");
        let downloads = temp.path().join("downloads");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(&source_root).unwrap();
        fs::create_dir_all(&downloads).unwrap();
        fs::write(root.join("src").join("main.rs"), b"fn main() {}").unwrap();
        fs::write(source_root.join("notes.txt"), b"hello").unwrap();

        let state = AppState::from_repositories(
            ProjectRepository::new(config.join("projects.json")),
            ProfileRepository::new(config.join("profiles.json")),
            TemplateRepository::new(config.join("templates.json")),
            SshConnectionRepository::new(config.join("ssh.json")),
        );
        let project = Project {
            id: "local-files".into(),
            name: "Local files".into(),
            project_type: ProjectType::Local,
            local: Some(LocalProjectConfig {
                path: root.to_string_lossy().into_owned(),
            }),
            ssh: None,
            wsl: None,
            default_profile_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        state.projects.upsert(project).unwrap();

        let listing = list_project_files_inner(&state, "local-files", None).unwrap();
        assert_eq!(listing.entries[0].name, "src");
        assert!(listing.entries[0].is_directory);
        assert!(list_project_files_inner(
            &state,
            "local-files",
            Some(temp.path().to_string_lossy().as_ref())
        )
        .is_err());

        upload_project_files_inner(
            &state,
            "local-files",
            root.to_string_lossy().as_ref(),
            &[source_root.join("notes.txt").to_string_lossy().into_owned()],
        )
        .unwrap();
        assert_eq!(fs::read(root.join("notes.txt")).unwrap(), b"hello");

        download_project_file_inner(
            &state,
            "local-files",
            root.join("notes.txt").to_string_lossy().as_ref(),
            downloads.to_string_lossy().as_ref(),
            false,
        )
        .unwrap();
        assert_eq!(fs::read(downloads.join("notes.txt")).unwrap(), b"hello");
    }

    fn sample_ssh_connection() -> SshConnection {
        SshConnection {
            id: "ssh-rsync".into(),
            name: "rsync".into(),
            host: "example.com".into(),
            port: 2200,
            username: "dev".into(),
            authentication_type: SshAuthenticationType::Key,
            password_saved: false,
            identity_file: Some(r"C:\Keys\id key".into()),
            use_ssh_agent: false,
            jump_host: None,
            connect_timeout_seconds: 15,
            server_alive_interval_seconds: 30,
            server_alive_count_max: 3,
            strict_host_key_checking: true,
            known_hosts_file: None,
            extra_args: Vec::new(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[cfg(windows)]
    fn success_status() -> std::process::ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(0)
    }

    #[cfg(unix)]
    fn success_status() -> std::process::ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(0)
    }
}
