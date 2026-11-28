//! The app measuring itself for its bench (apps/desktop/scripts/bench.ts, run by the Desktop bench workflow), only
//! with `AGENTES_BENCH_OUT=<file>` in its environment: never a setting, and nothing here runs without it. The main
//! window then opens on `AGENTES_BENCH_URL` (a page of the server open now), and the app writes to that file when each
//! step of its opening came, from the top of `run`: its setup done, the main window built, the site's first screen
//! painted (`page_ready`), the cover gone. Once the page settled it measures the whole app (vitals.rs `tree`) at the
//! start and end of an idle stretch with the window shown, hides the window as closing it does, does the same after a
//! while hidden, writes the file and quits.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, Url};

/// From the site's first screen to the first sample: what the page loads once it painted (the list's pictures, the
/// realtime connection) is in by then.
const SETTLE: Duration = Duration::from_secs(20);
/// Each idle stretch, shown and hidden: the CPU time used over it is the idle CPU.
const IDLE: Duration = Duration::from_secs(30);
/// Hidden this long before the hidden stretch starts.
const HIDDEN: Duration = Duration::from_secs(30);
/// An opening that never reaches the site's first screen ends here, written as it got.
const DEADLINE: Duration = Duration::from_secs(180);
/// The one-time sign-in on the way to the bench's page: its screen ends no opening.
const SIGN_IN: &str = "/desktop/handover";

struct Bench {
    out: PathBuf,
    url: Option<Url>,
    record: Mutex<Record>,
}

/// What the file says. Times are milliseconds from the top of `run`.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Record {
    version: String,
    /// The top of `run`, in milliseconds since 1970: the bench adds how long the system took to start the process.
    started_at_ms: u64,
    setup_ms: Option<u64>,
    window_ms: Option<u64>,
    page_ready_ms: Option<u64>,
    cover_gone_ms: Option<u64>,
    /// Every screen the site said it painted: its page's path, and when.
    paints: Vec<(String, u64)>,
    /// The whole app at the start and the end of the idle stretch shown, then of the one hidden.
    shown: Vec<Sample>,
    hidden: Vec<Sample>,
    error: Option<String>,
}

#[derive(Serialize)]
struct Sample {
    ms: u64,
    #[serde(flatten)]
    tree: crate::vitals::Tree,
}

static BENCH: OnceLock<Option<Bench>> = OnceLock::new();
static FINISHED: AtomicBool = AtomicBool::new(false);

fn bench() -> Option<&'static Bench> {
    BENCH
        .get_or_init(|| {
            let out = std::env::var_os("AGENTES_BENCH_OUT").filter(|v| !v.is_empty())?;
            let url = std::env::var("AGENTES_BENCH_URL").ok().and_then(|u| u.parse().ok());
            Some(Bench { out: out.into(), url, record: Mutex::default() })
        })
        .as_ref()
}

fn record(bench: &Bench) -> MutexGuard<'_, Record> {
    bench.record.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    crate::vitals::since_start().map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// The page the main window opens on: the bench's, when it runs.
pub fn url() -> Option<Url> {
    bench()?.url.clone()
}

/// The app's setup is done: an opening that never paints ends at the deadline.
pub fn setup_done(app: &AppHandle) {
    let Some(bench) = bench() else { return };
    {
        let mut record = record(bench);
        record.setup_ms = Some(now_ms());
        record.version = app.package_info().version.to_string();
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(DEADLINE);
        {
            let mut record = record(bench);
            if record.page_ready_ms.is_some() {
                return;
            }
            record.error = Some(format!("the site never painted within {} s", DEADLINE.as_secs()));
        }
        finish(&app);
    });
}

pub fn window_built() {
    if let Some(bench) = bench() {
        record(bench).window_ms.get_or_insert(now_ms());
    }
}

/// The site painted a screen (`page_ready`): the first one past the sign-in ends the opening, and the measuring
/// starts. Asked of the main window on the main thread, only while the bench runs.
pub fn painted(app: &AppHandle, page: &tauri::Webview) {
    let Some(bench) = bench() else { return };
    let path = page.url().map(|u| u.path().to_owned()).unwrap_or_default();
    let ms = now_ms();
    let first = {
        let mut record = record(bench);
        let first = path != SIGN_IN && record.page_ready_ms.is_none();
        if first {
            record.page_ready_ms = Some(ms);
        }
        record.paints.push((path, ms));
        first
    };
    if first {
        let app = app.clone();
        std::thread::spawn(move || measure(&app, bench));
    }
}

/// The cover stepped aside from the site's screen that ended the opening: the last time before the measuring starts,
/// since a cover that came back over the painted site (a whole page loading again) is gone only then.
pub fn cover_gone() {
    let Some(bench) = bench() else { return };
    let mut record = record(bench);
    let now = now_ms();
    let settle = u64::try_from(SETTLE.as_millis()).unwrap_or(u64::MAX);
    if record.page_ready_ms.is_some_and(|ready| now < ready.saturating_add(settle)) {
        record.cover_gone_ms = Some(now);
    }
}

fn measure(app: &AppHandle, bench: &Bench) {
    let sample = || Sample { ms: now_ms(), tree: crate::vitals::tree() };
    std::thread::sleep(SETTLE);
    let mut shown = vec![sample()];
    std::thread::sleep(IDLE);
    shown.push(sample());
    if let Some(window) = app.get_window(crate::main_window::LABEL) {
        let _ = window.hide();
    }
    std::thread::sleep(HIDDEN);
    let mut hidden = vec![sample()];
    std::thread::sleep(IDLE);
    hidden.push(sample());
    {
        let mut record = record(bench);
        record.shown = shown;
        record.hidden = hidden;
    }
    finish(app);
}

/// Once: the file is written, and the app quits as it does by hand.
fn finish(app: &AppHandle) {
    let Some(bench) = bench() else { return };
    if FINISHED.swap(true, Ordering::SeqCst) {
        return;
    }
    let text = {
        let mut record = record(bench);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
        record.started_at_ms = u64::try_from(now).unwrap_or(0).saturating_sub(now_ms());
        serde_json::to_string_pretty(&*record)
    };
    let written = text.map_err(|e| e.to_string()).and_then(|t| std::fs::write(&bench.out, t).map_err(|e| e.to_string()));
    if let Err(e) = written {
        eprintln!("agentes.chat bench: couldn't write {}: {e}", bench.out.display());
    }
    crate::begin_quit(app.clone());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vitals::{Tree, Usage};

    #[test]
    fn the_file_says_what_the_bench_script_reads() {
        let usage = |bytes, cpu_ms, processes| Usage { bytes: Some(bytes), cpu_ms: Some(cpu_ms), processes };
        let sample = Sample { ms: 30_000, tree: Tree { app: usage(80, 900, 1), webview: usage(300, 2_100, 4) } };
        let record = Record {
            version: "0.9.0".into(),
            started_at_ms: 1_700_000_000_000,
            setup_ms: Some(150),
            page_ready_ms: Some(2_400),
            paints: vec![(SIGN_IN.into(), 1_100), ("/org/o/c/c".into(), 2_400)],
            shown: vec![sample],
            ..Record::default()
        };
        let json: serde_json::Value = serde_json::to_value(&record).unwrap();
        assert_eq!(json["startedAtMs"], 1_700_000_000_000_u64);
        assert_eq!((json["setupMs"].as_u64(), json["windowMs"].as_u64()), (Some(150), None));
        assert_eq!((json["pageReadyMs"].as_u64(), json["coverGoneMs"].as_u64()), (Some(2_400), None));
        assert_eq!(json["paints"][0], serde_json::json!([SIGN_IN, 1_100]));
        assert_eq!(
            json["shown"][0],
            serde_json::json!({
                "ms": 30_000,
                "app": { "bytes": 80, "cpuMs": 900, "processes": 1 },
                "webview": { "bytes": 300, "cpuMs": 2_100, "processes": 4 },
            })
        );
        assert_eq!(json["hidden"], serde_json::json!([]));
        assert!(json["error"].is_null());
    }
}
