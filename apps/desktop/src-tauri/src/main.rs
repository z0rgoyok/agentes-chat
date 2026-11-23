// No console window on Windows release builds (later); macOS ignores it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agentes_desktop_lib::run();
}
