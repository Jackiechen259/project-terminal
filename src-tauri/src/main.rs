// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|argument| argument == "--session-host") {
        if let Err(error) = project_terminal_lib::daemon::run_daemon() {
            eprintln!("Project Terminal Session Host failed: {error}");
            std::process::exit(1);
        }
    } else {
        project_terminal_lib::run();
    }
}
