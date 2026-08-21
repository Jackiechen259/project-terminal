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
pub mod terminal_engine;
mod window;

use commands::terminal::TerminalState;
use state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use window::{WindowCloseDecision, WindowManager};

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
    tracing::info!("app startup beginning");
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
    tracing::info!("terminal manager initialized");
    // Remote and desktop clients share the same manager, making the desktop
    // process the single owner of every live PTY.
    let remote_gateway =
        remote::RemoteGateway::new(&remote_dirs, state.clone(), terminal_state.clone());
    // The process's single desktop window is owned by the window manager.
    // Closing (hiding) the window never shuts the process down; only the
    // explicit quit path does.
    let window_manager = WindowManager::new(remote_dirs.window_workspaces_path());

    // Build the app. The RunEvent handler closes all PTY child processes on
    // ExitRequested so no PowerShell / SSH / etc. children leak.
    let result = {
        tauri::Builder::default()
            // Registered before everything else: a second `Project Terminal`
            // launch must never start a second process, a second
            // TerminalManager, or a second tray. Instead the existing process
            // restores and focuses its single `main` window. The focus
            // request is queued while the window manager is still
            // initializing and served once it is ready.
            .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
                tracing::info!(
                    "second launch detected ({}); focusing existing main window",
                    argv.join(" ")
                );
                app.state::<WindowManager>().focus_main_window(app);
            }))
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .manage(state)
            .manage(terminal_state)
            .manage(remote_gateway)
            .manage(window_manager)
            .manage(AppLifecycleState::default())
            .setup(|app| {
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

                // Single-window tray: Show / Hide / Quit. No window list -
                // there is exactly one window. The icon is registered with
                // the runtime and stays alive without a stored handle.
                let tray_icon = app.default_window_icon().cloned();
                let mut tray_builder = TrayIconBuilder::with_id("project-terminal")
                    .show_menu_on_left_click(false)
                    .tooltip("Project Terminal")
                    .menu(&WindowManager::build_tray_menu(app.handle())?);
                if let Some(icon) = tray_icon {
                    tray_builder = tray_builder.icon(icon);
                }
                tray_builder
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => {
                            app.state::<WindowManager>().focus_main_window(app);
                        }
                        "hide" => {
                            app.state::<WindowManager>().hide_main_window(app);
                        }
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
                            tray.app_handle()
                                .state::<WindowManager>()
                                .focus_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
                // Create the single `main` window (restoring persisted
                // geometry, or the most recently active legacy workspace) and
                // serve any focus requests that arrived during startup.
                // Window-restore failures are recovered from inside the
                // manager: bad persisted state only falls back to a safe
                // fresh window. Only a completely unavailable windowing
                // runtime reaches this error.
                let outcome: window::WindowInitOutcome = app
                    .state::<WindowManager>()
                    .initialize_with_recovery(app.handle())?;
                tracing::info!(?outcome, "main window ready");
                app.state::<remote::RemoteGateway>().start();
                tracing::info!("application startup complete");
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
                // Single main window identity and title
                window::commands::workspace_info,
                window::commands::set_window_project,
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
                commands::terminal::session_attach_render,
                commands::terminal::session_detach,
                commands::terminal::session_list,
                commands::terminal::session_get,
                commands::terminal::list_workspace_sessions,
                commands::terminal::close_workspace_sessions,
                commands::terminal::write_terminal,
                commands::terminal::write_terminal_binary,
                commands::terminal::terminal_key_down,
                commands::terminal::terminal_mouse_event,
                commands::terminal::terminal_paste,
                commands::terminal::terminal_bracketed_paste_enabled,
                commands::terminal::terminal_search,
                commands::terminal::terminal_set_viewport,
                commands::terminal::resize_terminal,
                commands::terminal::close_terminal,
                commands::terminal::restart_terminal,
                // Environment detection (plan §12.4)
                commands::terminal::detect_conda_installations,
                commands::terminal::list_conda_environments,
                commands::terminal::detect_wsl_distributions,
            ])
            .on_window_event(move |window, event| {
                use tauri::WindowEvent;
                let app = window.app_handle();
                match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        let lifecycle = app.state::<AppLifecycleState>();
                        // The explicit quit path closes every window; nothing
                        // here may prevent that.
                        if lifecycle.quitting.load(Ordering::SeqCst) {
                            return;
                        }
                        let windows = app.state::<WindowManager>();
                        let terminal = app.state::<TerminalState>();
                        // Single-window lifecycle: the `main` window is never
                        // destroyed by a close request. Without running
                        // terminals it hides to the tray; with running
                        // terminals the frontend is asked whether to keep
                        // them running while hidden, or quit.
                        match windows.on_close_requested(&terminal.manager, window.label()) {
                            WindowCloseDecision::Allow => {}
                            WindowCloseDecision::HideToTray => {
                                api.prevent_close();
                                let _ = window.hide();
                            }
                            WindowCloseDecision::AskFrontend {
                                workspace_id,
                                running_count,
                            } => {
                                api.prevent_close();
                                let _ = window.emit(
                                    "window://close-request",
                                    CloseRequestPayload {
                                        workspace_id,
                                        running_count,
                                    },
                                );
                            }
                        }
                    }
                    WindowEvent::Destroyed => {
                        let windows = app.state::<WindowManager>();
                        windows.on_window_destroyed(window.label());
                    }
                    WindowEvent::Moved(position) => {
                        let windows = app.state::<WindowManager>();
                        windows.record_position(window.label(), position.x, position.y);
                    }
                    WindowEvent::Resized(size) => {
                        let windows = app.state::<WindowManager>();
                        let maximized = window.is_maximized().unwrap_or(false);
                        windows.record_resized(window.label(), size.width, size.height, maximized);
                    }
                    _ => {}
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

/// Payload of the `window://close-request` event sent when the main window's
/// close was held because it still has running sessions.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseRequestPayload {
    workspace_id: String,
    running_count: usize,
}

/// The one and only global shutdown path. Everything else - hiding a window,
/// closing a tab - stops only what it owns.
fn quit_application(app: &tauri::AppHandle) {
    app.state::<AppLifecycleState>()
        .quitting
        .store(true, Ordering::SeqCst);
    // Persist the main window's geometry and project, then stop every PTY
    // (desktop and remote alike) before exiting - no orphan child processes
    // may survive.
    app.state::<WindowManager>().save_workspaces();
    app.state::<TerminalState>().manager.close_all();
    app.exit(0);
}

#[tauri::command]
fn exit_application(app: tauri::AppHandle) {
    quit_application(&app);
}
