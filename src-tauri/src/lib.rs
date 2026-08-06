//! Application entrypoint. Wires the Tauri builder, plugins, state, and
//! command registrations.
//!
//! Failure handling: this module never panics to bypass a Rust error. If
//! application state cannot initialize, we log the structured error, show a
//! native error dialog so the user sees what went wrong, and exit with a
//! non-zero code. The Tauri runtime itself surfaces `run()` errors through
//! the same dialog path.

mod appearance;
mod commands;
mod config_dirs;
pub mod error;
mod platform;
mod profile;
mod project;
mod remote;
mod ssh;
mod state;
mod storage;
pub mod terminal;

use commands::terminal::TerminalState;
use state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

/// Used by the executable's lightweight SSH_ASKPASS entrypoint before Tauri
/// is initialized.
pub fn ssh_askpass_exit_code() -> Option<i32> {
    ssh::credential::askpass_exit_code()
}

const APP_ERROR_TITLE: &str = "Project Terminal - startup failed";

#[derive(Default)]
struct AppLifecycleState {
    quitting: AtomicBool,
}

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

    let (state, remote_dirs) = match AppState::init() {
        Ok(initialized) => initialized,
        Err(e) => {
            let message = format!("Failed to initialize application state: {e}");
            tracing::error!("{message}");
            show_fatal_error(&message);
            std::process::exit(1);
        }
    };

    let terminal_state = TerminalState::new();
    // Remote and desktop clients share the same manager, making the desktop
    // process the single owner of every live PTY.
    let remote_gateway =
        remote::RemoteGateway::new(&remote_dirs, state.clone(), terminal_state.clone());

    // Build the app. The RunEvent handler closes all PTY child processes on
    // ExitRequested so no PowerShell / SSH / etc. children leak.
    let result = {
        let manager = terminal_state.manager.clone_handle();
        tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .manage(state)
            .manage(terminal_state)
            .manage(remote_gateway)
            .manage(AppLifecycleState::default())
            .setup(|app| {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

                let show =
                    MenuItem::with_id(app, "show", "Show Project Terminal", true, None::<&str>)?;
                let quit = MenuItem::with_id(
                    app,
                    "quit",
                    "Quit and stop all sessions",
                    true,
                    None::<&str>,
                )?;
                let menu = Menu::with_items(app, &[&show, &quit])?;
                let mut tray = TrayIconBuilder::with_id("project-terminal")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .tooltip("Project Terminal");
                if let Some(icon) = app.default_window_icon().cloned() {
                    tray = tray.icon(icon);
                }
                tray.on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "quit" => quit_application(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
                app.state::<remote::RemoteGateway>().start();
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                // Platform capabilities (host OS + available project types/shells)
                commands::platform::get_platform_info,
                // Clipboard (native read avoids a WebView paste permission prompt)
                commands::clipboard::read_clipboard_text,
                // Opening terminal links (scheme-validated; never the WebView)
                commands::opener::open_external_url,
                // Terminal colour schemes
                commands::appearance::list_color_schemes,
                commands::appearance::delete_color_scheme,
                commands::appearance::import_color_schemes_from_file,
                commands::windows_terminal::scan_windows_terminal_color_schemes,
                commands::windows_terminal::import_windows_terminal_color_schemes,
                // Remote access gateway (shares the desktop terminal manager)
                commands::remote::remote_access_info,
                commands::remote::set_remote_lan_access,
                commands::remote::set_remote_enabled,
                exit_application,
                // Project CRUD (plan §12.1)
                commands::project::list_projects,
                commands::project::validate_project,
                commands::project::create_project,
                commands::project::update_project,
                commands::project::delete_project,
                commands::project::delete_project_workspace,
                commands::project::open_project_in_explorer,
                // Project-scoped local / WSL / SSH file browsing and transfer
                commands::file_manager::list_project_files,
                commands::file_manager::upload_project_files,
                commands::file_manager::download_project_file,
                // Profile CRUD (plan §12.2)
                commands::profile::list_terminal_profiles,
                commands::profile::validate_terminal_profile,
                commands::profile::create_terminal_profile,
                commands::profile::update_terminal_profile,
                commands::profile::delete_terminal_profile,
                commands::profile::duplicate_terminal_profile,
                commands::profile::test_terminal_profile,
                commands::profile::detect_local_shells,
                commands::profile::detect_python_environments,
                commands::windows_terminal::scan_windows_terminal_profiles,
                commands::windows_terminal::import_windows_terminal_profiles,
                // Profile templates (global reusable presets)
                commands::profile_template::list_profile_templates,
                commands::profile_template::create_profile_template,
                commands::profile_template::update_profile_template,
                commands::profile_template::delete_profile_template,
                commands::profile_template::create_profile_from_template,
                commands::windows_terminal::scan_windows_terminal_templates,
                commands::windows_terminal::import_windows_terminal_templates,
                // SSH Connection CRUD (plan §12.5)
                commands::ssh::list_ssh_connections,
                commands::ssh::validate_ssh_connection,
                commands::ssh::create_ssh_connection,
                commands::ssh::update_ssh_connection,
                commands::ssh::delete_ssh_connection,
                commands::ssh::test_ssh_connection,
                commands::ssh::list_remote_directories,
                commands::ssh::detect_ssh_client,
                commands::ssh::read_ssh_host_fingerprint,
                // Terminal (plan §12.3)
                commands::terminal::create_terminal,
                commands::terminal::session_attach,
                commands::terminal::session_detach,
                commands::terminal::session_list,
                commands::terminal::session_get,
                commands::terminal::write_terminal,
                commands::terminal::write_terminal_binary,
                commands::terminal::resize_terminal,
                commands::terminal::close_terminal,
                commands::terminal::restart_terminal,
                // Environment detection (plan §12.4)
                commands::terminal::detect_conda_installations,
                commands::terminal::list_conda_environments,
                commands::terminal::detect_wsl_distributions,
            ])
            .on_window_event(move |_window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let lifecycle = _window.app_handle().state::<AppLifecycleState>();
                    if lifecycle.quitting.load(Ordering::SeqCst) {
                        manager.close_all();
                    } else {
                        api.prevent_close();
                        let _ = _window.hide();
                    }
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

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn quit_application(app: &tauri::AppHandle) {
    app.state::<AppLifecycleState>()
        .quitting
        .store(true, Ordering::SeqCst);
    app.state::<TerminalState>().manager.close_all();
    app.exit(0);
}

#[tauri::command]
fn exit_application(app: tauri::AppHandle) {
    quit_application(&app);
}
