#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().skip(1).any(|arg| arg == "--daemon") {
        if let Err(error) = noai_lib::run_daemon() {
            eprintln!("Noai daemon: {error}");
            std::process::exit(1);
        }
    } else {
        noai_lib::run();
    }
}
