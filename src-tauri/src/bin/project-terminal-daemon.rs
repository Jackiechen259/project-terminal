fn main() {
    if let Err(error) = project_terminal_lib::daemon::run_daemon() {
        eprintln!("Project Terminal daemon failed: {error}");
        std::process::exit(1);
    }
}
