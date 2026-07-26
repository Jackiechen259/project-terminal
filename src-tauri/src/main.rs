// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(exit_code) = project_terminal_lib::ssh_askpass_exit_code() {
        std::process::exit(exit_code);
    }
    project_terminal_lib::run();
}
