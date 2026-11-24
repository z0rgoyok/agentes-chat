//! The app's own log of what went wrong in it, `window.log` in the app's log folder (the cover's Copy details ends
//! with it): the cover's steps to bring a stuck page back, a panic (the release build aborts on one, so this line is
//! all that is left of it), a main thread that stopped answering for more than a second, with what it was last asked
//! to do, and a web view's process that ended.

use std::io::Write;
use std::path::Path;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

pub const FILE: &str = "window.log";
/// Past this size the log starts over, the last one kept beside it.
const MAX_BYTES: u64 = 512 * 1024;
const OLD_FILE: &str = "window.old.log";
/// A main thread that takes longer than this to answer is logged.
const STALL: Duration = Duration::from_secs(1);
/// A stall still going after this is logged at once, so a main thread that never answers again leaves its line too.
const STUCK: Duration = Duration::from_secs(5);

/// What the main thread was last asked to do: an app command, or a window's event.
static LAST: Mutex<String> = Mutex::new(String::new());

/// One line in the log.
pub fn note(app: &AppHandle, what: &str) {
    if let Ok(dir) = app.path().app_log_dir() {
        write_line(&dir, &app.package_info().version.to_string(), what);
    }
}

fn write_line(dir: &Path, version: &str, what: &str) {
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join(FILE);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&path, dir.join(OLD_FILE));
    }
    let at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default();
    let what = what.replace(['\n', '\r'], " ");
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{at} {version} {what}");
    }
}

/// Records what the main thread is about to do, for the stall line.
pub fn mark(what: &str) {
    if let Ok(mut last) = LAST.lock() {
        last.clear();
        last.push_str(what);
    }
}

fn last() -> String {
    LAST.lock().map(|l| l.clone()).unwrap_or_default()
}

/// Every app command marked before it runs (`mark`).
pub fn marked<F>(commands: F) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static
where
    F: Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static,
{
    move |invoke| {
        mark(invoke.message.command());
        commands(invoke)
    }
}

/// Panics are logged, and the main thread is watched from here on.
pub fn start(app: &AppHandle) {
    if let Ok(dir) = app.path().app_log_dir() {
        let version = app.package_info().version.to_string();
        let before = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
            write_line(&dir, &version, &format!("panic on thread {thread}: {info}"));
            before(info);
        }));
    }
    let app = app.clone();
    std::thread::spawn(move || watch(&app));
}

/// Asks the main thread for an empty turn every second and logs every answer that took longer than `STALL`.
fn watch(app: &AppHandle) {
    loop {
        let slept = Instant::now();
        std::thread::sleep(STALL);
        // Woken this late, the whole app was paused (the computer slept, App Nap): not the main thread's doing.
        if slept.elapsed() > STALL * 2 {
            continue;
        }
        let (tx, rx) = mpsc::channel::<()>();
        let asked = Instant::now();
        if app
            .run_on_main_thread(move || {
                let _ = tx.send(());
            })
            .is_err()
        {
            return;
        }
        if rx.recv_timeout(STALL).is_ok() {
            continue;
        }
        let doing = last();
        let answered = match rx.recv_timeout(STUCK - STALL) {
            Ok(()) => true,
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                note(app, &stall_line(asked.elapsed(), &doing, false));
                rx.recv().is_ok()
            }
        };
        if answered {
            note(app, &stall_line(asked.elapsed(), &doing, true));
        }
    }
}

/// "main thread stalled 1840 ms (last: local_server_status)", or "... still stalled after 5000 ms ..." while it lasts.
fn stall_line(took: Duration, last: &str, answered: bool) -> String {
    let last = if last.is_empty() { "nothing marked" } else { last };
    let ms = took.as_millis();
    if answered {
        format!("main thread stalled {ms} ms (last: {last})")
    } else {
        format!("main thread still stalled after {ms} ms (last: {last})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_starts_over_past_its_size() {
        let dir = std::env::temp_dir().join(format!("agentes-health-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_line(&dir, "0.9.0", "first\nsecond");
        let text = std::fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(text.ends_with(" 0.9.0 first second\n"), "one line: {text}");
        std::fs::write(dir.join(FILE), vec![b'x'; MAX_BYTES as usize + 1]).unwrap();
        write_line(&dir, "0.9.0", "after");
        assert!(std::fs::read_to_string(dir.join(FILE)).unwrap().ends_with(" 0.9.0 after\n"));
        assert_eq!(std::fs::metadata(dir.join(OLD_FILE)).unwrap().len(), MAX_BYTES + 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stall_lines() {
        assert_eq!(
            stall_line(Duration::from_millis(1840), "local_server_status", true),
            "main thread stalled 1840 ms (last: local_server_status)"
        );
        assert_eq!(
            stall_line(Duration::from_secs(5), "", false),
            "main thread still stalled after 5000 ms (last: nothing marked)"
        );
    }
}
