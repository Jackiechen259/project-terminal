//! Application entrypoint. Wires the Tauri builder, plugins, state, and
//! command registrations.
//!
//! Failure handling: this module never panics to bypass a Rust error. If
//! application state cannot initialize, we log the structured error, show a
//! native error dialog so the user sees what went wrong, and exit with a
//! non-zero code. The Tauri runtime itself surfaces `run()` errors through
//! the same dialog path.

mod commands;
mod config_dirs;
mod error;
mod profile;
mod project;
mod ssh;
mod state;
mod storage;
mod terminal;

use commands::terminal::TerminalState;
use state::AppState;

const APP_ERROR_TITLE: &str = "Project Terminal - startup failed";

/// Show a native message box on Windows so the user sees the failure even
/// when no console is attached. On other platforms we fall back to stderr.
#[cfg(windows)]
fn show_fatal_error(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    eprintln!("{APP_ERROR_TITLE}: {message}");

    let title: Vec<u16> = APP_ERROR_TITLE
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let body: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(windows))]
fn show_fatal_error(message: &str) {
    eprintln!("{APP_ERROR_TITLE}: {message}");
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("info,project_terminal_lib=debug")
            }),
        )
        .init();

    let state = match AppState::init() {
        Ok(s) => s,
        Err(e) => {
            let message = format!("Failed to initialize application state: {e}");
            tracing::error!("{message}");
            show_fatal_error(&message);
            std::process::exit(1);
        }
    };

    let terminal_state = TerminalState::new();

    // Build the app. The RunEvent handler closes all PTY child processes on
    // ExitRequested so no PowerShell / SSH / etc. children leak.
    let result = {
        let manager = terminal_state.manager.clone_handle();
        tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .manage(state)
            .manage(terminal_state)
            .invoke_handler(tauri::generate_handler![
                // Project CRUD (plan §12.1)
                commands::project::list_projects,
                commands::project::validate_project,
                commands::project::create_project,
                commands::project::update_project,
                commands::project::delete_project,
                // Profile CRUD (plan §12.2)
                commands::profile::list_terminal_profiles,
                commands::profile::validate_terminal_profile,
                commands::profile::create_terminal_profile,
                commands::profile::update_terminal_profile,
                commands::profile::delete_terminal_profile,
                commands::profile::test_terminal_profile,
                // SSH Connection CRUD (plan §12.5)
                commands::ssh::list_ssh_connections,
                commands::ssh::validate_ssh_connection,
                commands::ssh::create_ssh_connection,
                commands::ssh::update_ssh_connection,
                commands::ssh::delete_ssh_connection,
                commands::ssh::test_ssh_connection,
                commands::ssh::detect_ssh_client,
                commands::ssh::read_ssh_host_fingerprint,
                // Terminal (plan §12.3)
                commands::terminal::create_terminal,
                commands::terminal::write_terminal,
                commands::terminal::resize_terminal,
                commands::terminal::terminal_session_status,
                commands::terminal::close_terminal,
                commands::terminal::restart_terminal,
                // Environment detection (plan §12.4)
                commands::terminal::detect_conda_installations,
                commands::terminal::list_conda_environments,
            ])
            .on_window_event(move |_window, event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    // App is closing - kill all child processes so no
                    // PowerShell/SSH/etc. leak in Task Manager (§36.20).
                    manager.close_all();
                }
            })
            .run(tauri::generate_context!())
    };

    if let Err(e) = result {
        let message = format!("Tauri runtime exited with an error: {e}");
        tracing::error!("{message}");
        show_fatal_error(&message);
        std::process::exit(1);
    }
}
