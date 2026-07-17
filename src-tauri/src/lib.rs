//! Application entrypoint. Wires the Tauri builder, plugins, state, and
//! (in later phases) command registrations.

mod error;
mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("info,project_terminal_lib=debug")
            }),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .run(tauri::generate_context!())
        .expect("error while running Project Terminal");
}
