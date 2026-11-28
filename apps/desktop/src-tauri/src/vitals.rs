//! What the app measures of itself on this computer: how long it took from its start to the site's first screen
//! painted, the memory of the processes behind the main window's web view, and the system's version and size. The site
//! sends the first two with its own speed report (`this_mac` `vitals`, main_window.rs), and the app's problem reports
//! carry all of them (`problem_report_facts`).
//!
//! The web view's memory is best effort, and absent when it can't be told. macOS: the main window's web content process
//! (WebKit runs it as an XPC service, not a child of the app), its footprint as Activity Monitor shows it. Windows:
//! WebView2's browser process and everything under it (renderers, GPU, utilities), their private bytes; every web view
//! of the app shares them. Linux: WebKitGTK's web processes under the app, their anonymous resident memory; each web
//! view of the app has its own (the popover's and Preferences' too).
//!
//! The bench (bench.rs) measures the whole app instead (`tree`): its own process, and every process working for it
//! with their memory counted the same way and their CPU time.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;

/// The process's start: the top of `run`.
static STARTED: OnceLock<Instant> = OnceLock::new();
/// The main window opened with the app: a start at login opens it whenever the person asks, which is no opening.
static WINDOW_AT_LAUNCH: AtomicBool = AtomicBool::new(false);
/// From the app's start to the site's first screen painted, when the window opened with the app.
static OPENING_MS: OnceLock<u64> = OnceLock::new();
/// The site was told the opening: once, since a reload of the page is no opening of the app.
static OPENING_TOLD: AtomicBool = AtomicBool::new(false);

pub fn started() {
    STARTED.get_or_init(Instant::now);
}

/// How long ago the process started (the top of `run`).
pub fn since_start() -> Option<Duration> {
    STARTED.get().map(Instant::elapsed)
}

/// The main window opens now, as the app starts.
pub fn window_at_launch() {
    WINDOW_AT_LAUNCH.store(true, Ordering::Relaxed);
}

/// The site itself painted its first screen (`page_ready` with `site`): the first time, the opening ends.
pub fn painted() {
    if !WINDOW_AT_LAUNCH.load(Ordering::Relaxed) {
        return;
    }
    if let Some(start) = STARTED.get() {
        OPENING_MS.get_or_init(|| u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX));
    }
}

/// What the site sends with its speed report: the opening once, the web view's memory each time.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SiteVitals {
    #[serde(skip_serializing_if = "Option::is_none")]
    cold_start_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    webview_bytes: Option<u64>,
}

/// The opening, the first time the site asks once it ended.
fn tell_opening() -> Option<u64> {
    OPENING_MS.get().copied().filter(|_| !OPENING_TOLD.swap(true, Ordering::Relaxed))
}

/// Off the main thread: the web view's memory is asked of it on macOS.
pub fn for_site(app: &AppHandle) -> SiteVitals {
    SiteVitals { cold_start_ms: tell_opening(), webview_bytes: system::webview_bytes(app) }
}

/// What the app's own problem reports (the cover's, Preferences' Activity) add about this computer, as measured; the
/// page rounds them as the report says them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportFacts {
    /// macOS's version (`15.1`), Windows' build (`10.0.19045`), Linux's kernel (`6.8.0-45-generic`).
    os_version: Option<String>,
    cpus: Option<usize>,
    memory_bytes: Option<u64>,
    webview_bytes: Option<u64>,
    /// This opening's, when the window opened with the app and the site painted.
    opening_ms: Option<u64>,
}

/// Async: it reads the system's files and asks the web view, off the main thread.
#[tauri::command]
pub async fn problem_report_facts(app: AppHandle, webview: tauri::Webview) -> Result<ReportFacts, String> {
    crate::local_server::app_window(&webview, &["main-cover", "prefs"])?;
    tauri::async_runtime::spawn_blocking(move || ReportFacts {
        os_version: system::os_version(),
        cpus: std::thread::available_parallelism().ok().map(|n| n.get()),
        memory_bytes: system::memory_bytes(),
        webview_bytes: system::webview_bytes(&app),
        opening_ms: OPENING_MS.get().copied(),
    })
    .await
    .map_err(|e| e.to_string())
}

/// A process as the system lists it, and on Linux the memory its listing says it holds (None: it couldn't be read).
#[cfg_attr(target_os = "macos", allow(dead_code))]
#[derive(Debug)]
struct Proc {
    pid: u32,
    ppid: u32,
    name: String,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    bytes: Option<u64>,
    /// When it started, on Windows (100-nanosecond units since 1601); None when it can't be asked, and on Linux,
    /// which gives an orphan to init, so a parent's id there is never one that ended.
    started: Option<u64>,
}

/// What `value_of` says (memory, CPU time; asked of those alone) of each process `picked` finds under `root`, at any
/// depth, with everything under it, summed; None when there is none, or none could be read.
// ponytail: each step scans the whole list (a few hundred processes); a map of children if it ever runs hot.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn tree_sum(
    procs: &[Proc],
    root: u32,
    picked: impl Fn(&str) -> bool,
    value_of: impl Fn(&Proc) -> Option<u64>,
) -> Option<u64> {
    let mut total: Option<u64> = None;
    // A parent's id that came back on a new process can't loop the walk, nor count a process twice.
    let mut seen = HashSet::from([root]);
    // Windows keeps an orphan's parent id as it was and gives that id to new processes: one that started before the
    // process now holding its parent's id is another's orphan, never that process's child (Process Explorer's rule).
    let older = |child: &Proc, parent: Option<u64>| matches!((child.started, parent), (Some(c), Some(p)) if c < p);
    let started = procs.iter().find(|p| p.pid == root).and_then(|p| p.started);
    let mut stack = vec![(root, started, false)];
    while let Some((pid, started, inside)) = stack.pop() {
        for child in procs.iter().filter(|p| p.ppid == pid && !older(p, started)) {
            if !seen.insert(child.pid) {
                continue;
            }
            let counted = inside || picked(&child.name);
            if counted {
                if let Some(value) = value_of(child) {
                    total = Some(total.unwrap_or(0).saturating_add(value));
                }
            }
            stack.push((child.pid, child.started, counted));
        }
    }
    total
}

/// Some of the app's processes, measured now: their memory (counted as `webview_bytes` counts it on each system) and
/// the CPU time each used since it started.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub bytes: Option<u64>,
    pub cpu_ms: Option<u64>,
    pub processes: u64,
}

/// The app's own process, and the processes working for it: on Windows and Linux every process under it (WebView2's,
/// WebKitGTK's), on macOS WebKit's processes the system counts against it (its web content, GPU and network
/// processes: XPC services, never its children).
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct Tree {
    pub app: Usage,
    pub webview: Usage,
}

/// The whole app, measured now (the bench's samples). Off the main thread: it reads every process's numbers.
pub fn tree() -> Tree {
    system::tree()
}

/// Every process under `root`, at any depth: their memory (`bytes_of`), CPU time (`cpu_ms_of`) and how many there are.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn under(
    procs: &[Proc],
    root: u32,
    bytes_of: impl Fn(&Proc) -> Option<u64>,
    cpu_ms_of: impl Fn(&Proc) -> Option<u64>,
) -> Usage {
    let any = |_: &str| true;
    Usage {
        bytes: tree_sum(procs, root, any, bytes_of),
        cpu_ms: tree_sum(procs, root, any, cpu_ms_of),
        processes: tree_sum(procs, root, any, |_| Some(1)).unwrap_or(0),
    }
}

/// A Linux process's CPU time, user and system, from its `/proc/<pid>/stat` with the kernel's clock ticks per second.
/// Its name, in parentheses, may hold spaces and parentheses itself: the fields are counted after the last `)`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn stat_cpu_ms(text: &str, ticks_per_second: u64) -> Option<u64> {
    if ticks_per_second == 0 {
        return None;
    }
    let mut fields = text.get(text.rfind(')')? + 1..)?.split_whitespace().skip(11);
    let user: u64 = fields.next()?.parse().ok()?;
    let system: u64 = fields.next()?.parse().ok()?;
    Some((user + system) * 1000 / ticks_per_second)
}

/// WebKitGTK's web process as Linux names it: a process's name is cut to 15 characters (`WebKitWebProcess`).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const WEBKIT_WEB_PROCESS: &str = "WebKitWebProces";

/// A process from its `/proc/<pid>/status`: its name, its parent, and its anonymous resident memory (its own pages,
/// never the libraries it shares), or its whole resident memory on a kernel that doesn't say (before 4.5).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn status_of(pid: u32, text: &str) -> Option<Proc> {
    let field = |key: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix(':'))
            .map(str::trim)
    };
    let kb = |key: &str| {
        let value = field(key)?.strip_suffix("kB")?.trim().parse::<u64>().ok()?;
        Some(value * 1024)
    };
    Some(Proc {
        pid,
        ppid: field("PPid")?.parse().ok()?,
        name: field("Name")?.to_owned(),
        bytes: kb("RssAnon").or_else(|| kb("VmRSS")),
        started: None,
    })
}

/// The machine's memory from `/proc/meminfo` (`MemTotal`), in bytes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn meminfo_total(text: &str) -> Option<u64> {
    let line = text.lines().find_map(|l| l.strip_prefix("MemTotal:"))?;
    let kb = line.trim().strip_suffix("kB")?.trim().parse::<u64>().ok()?;
    Some(kb * 1024)
}

#[cfg(target_os = "macos")]
mod system {
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::{AppHandle, Manager};

    /// How long the asking thread waits for the main thread (it answers at once; this is for a web view going away).
    const WAIT: Duration = Duration::from_secs(2);

    pub fn os_version() -> Option<String> {
        crate::prepare::system_version()
    }

    pub fn memory_bytes() -> Option<u64> {
        let mut bytes: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        // SAFETY: a NUL-terminated name, a u64 with its length, and no new value.
        let err = unsafe {
            libc::sysctlbyname(
                c"hw.memsize".as_ptr(),
                (&mut bytes as *mut u64).cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        (err == 0 && bytes > 0).then_some(bytes)
    }

    /// The main window's web content process: only its web view knows which it is (`_webProcessIdentifier`, WebKit's
    /// own property, asked only of a web view that answers to it), and its footprint is what Activity Monitor shows.
    pub fn webview_bytes(app: &AppHandle) -> Option<u64> {
        let page = app.get_webview(crate::main_window::LABEL)?;
        let (tx, rx) = mpsc::channel();
        page.with_webview(move |view| {
            // SAFETY: on the main thread (`with_webview`), `view.inner()` is the live WKWebView, and the property is
            // read only once the web view says it answers to it.
            let pid: i32 = unsafe {
                let web_view = view.inner() as *mut AnyObject;
                let answers: bool = msg_send![web_view, respondsToSelector: sel!(_webProcessIdentifier)];
                if answers {
                    msg_send![web_view, _webProcessIdentifier]
                } else {
                    0
                }
            };
            let _ = tx.send(pid);
        })
        .ok()?;
        let pid = rx.recv_timeout(WAIT).ok().filter(|&pid| pid > 0)?;
        rusage(pid).map(|info| info.ri_phys_footprint).filter(|&bytes| bytes > 0)
    }

    fn rusage(pid: libc::pid_t) -> Option<libc::rusage_info_v2> {
        // SAFETY: plain numbers; all zeros is a valid value of it.
        let mut info: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
        // SAFETY: a pid, the flavor that matches the buffer, and the buffer itself, written by the call alone.
        let err = unsafe {
            libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, (&mut info as *mut libc::rusage_info_v2).cast())
        };
        (err == 0).then_some(info)
    }

    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }

    extern "C" {
        fn mach_timebase_info(info: *mut Timebase) -> libc::c_int;
    }

    /// A process's footprint and CPU time. Its CPU time comes in the machine's own ticks (on Apple silicon not
    /// nanoseconds: 125/3 of one each).
    fn usage(pids: &[libc::pid_t]) -> super::Usage {
        let mut tick = Timebase { numer: 1, denom: 1 };
        // SAFETY: the struct the call fills.
        if unsafe { mach_timebase_info(&mut tick) } != 0 || tick.denom == 0 {
            tick = Timebase { numer: 1, denom: 1 };
        }
        let mut usage = super::Usage::default();
        for info in pids.iter().filter_map(|&pid| rusage(pid)) {
            let ticks = u128::from(info.ri_user_time) + u128::from(info.ri_system_time);
            let ms = u64::try_from(ticks * u128::from(tick.numer) / u128::from(tick.denom) / 1_000_000).unwrap_or(u64::MAX);
            usage.bytes = Some(usage.bytes.unwrap_or(0).saturating_add(info.ri_phys_footprint));
            usage.cpu_ms = Some(usage.cpu_ms.unwrap_or(0).saturating_add(ms));
            usage.processes += 1;
        }
        usage
    }

    /// The processes the system counts against `app` (as Activity Monitor groups them), the app aside: WebKit's,
    /// which launchd starts for it. Only an app opened as apps are (Finder, the Dock, `open`) is counted for itself:
    /// started from a shell, it and its WebKit processes are counted against the shell's terminal, and this finds
    /// none. The call that says it isn't public, so it is looked up as the app runs: without it, none either.
    fn working_for(app: libc::pid_t) -> Vec<libc::pid_t> {
        type Responsible = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;
        // SAFETY: a NUL-terminated name, looked up among the images the process already loaded.
        let found = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_get_pid_responsible_for_pid".as_ptr()) };
        if found.is_null() {
            return Vec::new();
        }
        // SAFETY: libSystem's function of that name takes a pid and returns one.
        let responsible: Responsible = unsafe { std::mem::transmute::<*mut libc::c_void, Responsible>(found) };
        // SAFETY: no buffer: the count alone.
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        let Ok(count) = usize::try_from(count) else { return Vec::new() };
        // Room for processes started between the two calls.
        let mut pids: Vec<libc::pid_t> = vec![0; count + 64];
        let bytes = libc::c_int::try_from(std::mem::size_of_val(pids.as_slice())).unwrap_or(0);
        // SAFETY: a buffer of that many bytes, written by the call alone.
        let listed = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        pids.truncate(usize::try_from(listed).unwrap_or(0));
        // SAFETY: a plain pid; one that ended meanwhile is answered with no process.
        pids.retain(|&pid| pid > 0 && pid != app && unsafe { responsible(pid) } == app);
        pids
    }

    pub fn tree() -> super::Tree {
        let app = std::process::id() as libc::pid_t;
        super::Tree { app: usage(&[app]), webview: usage(&working_for(app)) }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod system {
    use super::{meminfo_total, stat_cpu_ms, status_of, tree_sum, under, Proc, WEBKIT_WEB_PROCESS};
    use tauri::AppHandle;

    pub fn os_version() -> Option<String> {
        let release = std::fs::read_to_string("/proc/sys/kernel/osrelease").ok()?;
        let release = release.trim();
        (!release.is_empty()).then(|| release.to_owned())
    }

    pub fn memory_bytes() -> Option<u64> {
        meminfo_total(&std::fs::read_to_string("/proc/meminfo").ok()?)
    }

    fn processes() -> Option<Vec<Proc>> {
        let procs = std::fs::read_dir("/proc")
            .ok()?
            .flatten()
            .filter_map(|entry| {
                let pid = entry.file_name().to_str()?.parse().ok()?;
                status_of(pid, &std::fs::read_to_string(entry.path().join("status")).ok()?)
            })
            .collect();
        Some(procs)
    }

    pub fn webview_bytes(_app: &AppHandle) -> Option<u64> {
        tree_sum(&processes()?, std::process::id(), |name| name.starts_with(WEBKIT_WEB_PROCESS), |p| p.bytes)
    }

    pub fn tree() -> super::Tree {
        let me = std::process::id();
        let procs = processes().unwrap_or_default();
        // SAFETY: a plain query of a constant.
        let hz = u64::try_from(unsafe { libc::sysconf(libc::_SC_CLK_TCK) }).unwrap_or(0);
        let cpu_ms = |pid: u32| stat_cpu_ms(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?, hz);
        let bytes = procs.iter().find(|p| p.pid == me).and_then(|p| p.bytes);
        super::Tree {
            app: super::Usage { bytes, cpu_ms: cpu_ms(me), processes: 1 },
            webview: under(&procs, me, |p| p.bytes, |p| cpu_ms(p.pid)),
        }
    }
}

#[cfg(target_os = "windows")]
mod system {
    use super::{tree_sum, under, Proc};
    use std::ffi::c_void;
    use tauri::AppHandle;

    /// WebView2's processes: its browser process, a child of the app, and its renderers, GPU and utilities under it.
    const WEBVIEW2: &str = "msedgewebview2.exe";
    const TH32CS_SNAPPROCESS: u32 = 0x2;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const PROCESS_VM_READ: u32 = 0x0010;

    #[repr(C)]
    struct ProcessEntry32W {
        size: u32,
        usage: u32,
        process_id: u32,
        default_heap_id: usize,
        module_id: u32,
        threads: u32,
        parent_process_id: u32,
        priority_base: i32,
        flags: u32,
        exe_file: [u16; 260],
    }

    #[repr(C)]
    struct ProcessMemoryCountersEx {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
        private_usage: usize,
    }

    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }

    #[repr(C)]
    struct OsVersionInfoW {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform_id: u32,
        csd_version: [u16; 128],
    }

    /// A time in 100-nanosecond units, in two halves.
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    impl FileTime {
        fn ticks(&self) -> u64 {
            (u64::from(self.high) << 32) | u64::from(self.low)
        }
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> *mut c_void;
        fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> *mut c_void;
        fn K32GetProcessMemoryInfo(process: *mut c_void, counters: *mut ProcessMemoryCountersEx, cb: u32) -> i32;
        fn GetProcessTimes(
            process: *mut c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn GlobalMemoryStatusEx(status: *mut MemoryStatusEx) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    #[link(name = "ntdll")]
    extern "system" {
        /// The system's own version: `GetVersionEx` answers what the app's manifest asks it to.
        fn RtlGetVersion(info: *mut OsVersionInfoW) -> i32;
    }

    /// Windows' build as `ver` says it: `10.0.19045` (Windows 10 22H2), `10.0.26100` (Windows 11 24H2).
    pub fn os_version() -> Option<String> {
        // SAFETY: plain numbers; all zeros is a valid value of it.
        let mut info: OsVersionInfoW = unsafe { std::mem::zeroed() };
        info.size = std::mem::size_of::<OsVersionInfoW>() as u32;
        // SAFETY: the struct the call fills, its size set as it requires.
        let status = unsafe { RtlGetVersion(&mut info) };
        (status == 0 && info.major > 0).then(|| format!("{}.{}.{}", info.major, info.minor, info.build))
    }

    pub fn memory_bytes() -> Option<u64> {
        // SAFETY: plain numbers; all zeros is a valid value of it.
        let mut status: MemoryStatusEx = unsafe { std::mem::zeroed() };
        status.length = std::mem::size_of::<MemoryStatusEx>() as u32;
        // SAFETY: the struct the call fills, its length set as it requires.
        let ok = unsafe { GlobalMemoryStatusEx(&mut status) } != 0;
        (ok && status.total_phys > 0).then_some(status.total_phys)
    }

    /// A process's private bytes (what it alone holds, as Process Explorer counts them), when it lets the app ask.
    fn private_bytes(process_id: u32) -> Option<u64> {
        // Some of WebView2's sandboxed processes refuse the right to read their memory: their counters still come.
        let access = [PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, PROCESS_QUERY_LIMITED_INFORMATION];
        access.iter().find_map(|&rights| {
            // SAFETY: a process opened for its counters alone, read into a struct of the size given, closed once.
            unsafe {
                let process = OpenProcess(rights, 0, process_id);
                if process.is_null() {
                    return None;
                }
                let mut counters: ProcessMemoryCountersEx = std::mem::zeroed();
                counters.cb = std::mem::size_of::<ProcessMemoryCountersEx>() as u32;
                let ok = K32GetProcessMemoryInfo(process, &mut counters, counters.cb) != 0;
                CloseHandle(process);
                ok.then_some(counters.private_usage as u64)
            }
        })
    }

    /// When a process started and its CPU time in ms, kernel and user, when it lets the app ask.
    fn times(process_id: u32) -> Option<(u64, u64)> {
        // SAFETY: a process opened for its times alone, read into the structs given, closed once.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
            if process.is_null() {
                return None;
            }
            let mut stamps: [FileTime; 4] = Default::default();
            let [created, ended, kernel, user] = &mut stamps;
            let ok = GetProcessTimes(process, created, ended, kernel, user) != 0;
            CloseHandle(process);
            ok.then(|| (created.ticks(), (kernel.ticks() + user.ticks()) / 10_000))
        }
    }

    fn cpu_ms(process_id: u32) -> Option<u64> {
        times(process_id).map(|(_, cpu_ms)| cpu_ms)
    }

    pub fn tree() -> super::Tree {
        let me = std::process::id();
        let procs = processes().unwrap_or_default();
        super::Tree {
            app: super::Usage { bytes: private_bytes(me), cpu_ms: cpu_ms(me), processes: 1 },
            webview: under(&procs, me, |p| private_bytes(p.pid), |p| cpu_ms(p.pid)),
        }
    }

    pub fn webview_bytes(_app: &AppHandle) -> Option<u64> {
        // Only the processes under the app are asked their memory, never another app's WebView2.
        let webview2 = |name: &str| name.eq_ignore_ascii_case(WEBVIEW2);
        tree_sum(&processes()?, std::process::id(), webview2, |p| private_bytes(p.pid))
    }

    fn processes() -> Option<Vec<Proc>> {
        let mut procs = Vec::new();
        // SAFETY: a snapshot of the processes, walked with an entry of the size it requires, closed once.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot.is_null() || snapshot as isize == -1 {
                return None;
            }
            let mut entry: ProcessEntry32W = std::mem::zeroed();
            entry.size = std::mem::size_of::<ProcessEntry32W>() as u32;
            let mut more = Process32FirstW(snapshot, &mut entry) != 0;
            while more {
                let len = entry.exe_file.iter().position(|&c| c == 0).unwrap_or(entry.exe_file.len());
                let name = String::from_utf16_lossy(&entry.exe_file[..len]);
                let started = times(entry.process_id).map(|(started, _)| started);
                procs.push(Proc { pid: entry.process_id, ppid: entry.parent_process_id, name, bytes: None, started });
                more = Process32NextW(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
        }
        Some(procs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, ppid: u32, name: &str, mb: u64) -> Proc {
        Proc { pid, ppid, name: name.into(), bytes: Some(mb << 20), started: None }
    }

    #[test]
    fn the_web_views_tree_is_summed_whole_and_nothing_else_of_the_app() {
        let app = 100;
        let procs = [
            process(1, 0, "launchd", 9),
            process(app, 1, "agentes", 80),
            // WebView2's browser process and its renderers, GPU and utilities.
            process(200, app, "msedgewebview2.exe", 60),
            process(201, 200, "msedgewebview2.exe", 210),
            process(202, 200, "msedgewebview2.exe", 90),
            process(203, 202, "msedgewebview2.exe", 5),
            // The server here and an agent's browser: the app's children, never its web view.
            process(300, app, "bun.exe", 400),
            process(301, 300, "chrome.exe", 700),
            // Another app's WebView2.
            process(400, 1, "msedgewebview2.exe", 1000),
        ];
        let webview2 = |name: &str| name.eq_ignore_ascii_case("MSEdgeWebView2.exe");
        let asked = std::cell::RefCell::new(Vec::new());
        let bytes_of = |p: &Proc| {
            asked.borrow_mut().push(p.pid);
            p.bytes
        };
        assert_eq!(tree_sum(&procs, app, webview2, bytes_of), Some((60 + 210 + 90 + 5) << 20));
        // Only the app's own web view's processes are asked: never the app's other children, nor another app's.
        asked.borrow_mut().sort_unstable();
        assert_eq!(*asked.borrow(), [200, 201, 202, 203]);
        assert_eq!(tree_sum(&procs, 300, webview2, |p| p.bytes), None, "none under it");
        assert_eq!(tree_sum(&procs, 999, webview2, |p| p.bytes), None, "an app that isn't there");
    }

    #[test]
    fn one_found_deeper_counts_too_unreadable_ones_count_nothing_and_a_loop_ends() {
        let procs = [
            // A sandbox's launcher between the app and WebKit's process.
            process(10, 1, "bwrap", 1),
            process(11, 10, "WebKitWebProces", 150),
            Proc { pid: 12, ppid: 1, name: "WebKitWebProces".into(), bytes: None, started: None },
            // Two processes each naming the other its parent.
            process(20, 21, "WebKitWebProces", 7),
            process(21, 20, "x", 1),
        ];
        let webkit = |name: &str| name.starts_with(WEBKIT_WEB_PROCESS);
        assert_eq!(tree_sum(&procs, 1, webkit, |p| p.bytes), Some(150 << 20));
        assert_eq!(tree_sum(&procs, 21, webkit, |p| p.bytes), Some(7 << 20));
        let unreadable = [Proc { pid: 12, ppid: 1, name: "WebKitWebProces".into(), bytes: None, started: None }];
        assert_eq!(tree_sum(&unreadable, 1, webkit, |p| p.bytes), None);
    }

    #[test]
    fn the_whole_app_is_everything_under_it_whatever_its_name() {
        let app = 100;
        let procs = [
            process(app, 1, "agentes-chat", 80),
            process(10, app, "bwrap", 1),
            process(11, 10, "WebKitWebProces", 150),
            process(12, app, "WebKitNetworkPr", 20),
            Proc { pid: 13, ppid: app, name: "WebKitWebProces".into(), bytes: None, started: None },
            process(400, 1, "WebKitWebProces", 900),
        ];
        let cpu_ms = |p: &Proc| Some(u64::from(p.pid));
        let usage = under(&procs, app, |p| p.bytes, cpu_ms);
        assert_eq!(usage, Usage { bytes: Some((1 + 150 + 20) << 20), cpu_ms: Some(10 + 11 + 12 + 13), processes: 4 });
        assert_eq!(under(&procs, 999, |p| p.bytes, cpu_ms), Usage::default(), "an app that isn't there");
    }

    #[test]
    fn an_orphan_whose_parents_id_came_back_on_the_app_isnt_the_apps() {
        let at = |mut p: Proc, started: u64| {
            p.started = Some(started);
            p
        };
        let app = 100;
        let procs = [
            at(process(app, 1, "agentes-chat", 80), 5_000),
            at(process(10, app, "msedgewebview2.exe", 60), 5_000),
            at(process(11, 10, "msedgewebview2.exe", 200), 6_000),
            // Started before the app: their parent was an older process with the app's id.
            at(process(20, app, "worker.exe", 900), 1_000),
            at(process(21, 20, "worker.exe", 900), 1_200),
            // Started before the web view's process now holding its parent's id.
            at(process(30, 10, "helper.exe", 700), 4_000),
            // One that couldn't be asked counts.
            process(40, app, "msedgewebview2.exe", 5),
        ];
        let usage = under(&procs, app, |p| p.bytes, |_| Some(1));
        assert_eq!(usage, Usage { bytes: Some((60 + 200 + 5) << 20), cpu_ms: Some(3), processes: 3 });
    }

    #[test]
    fn this_process_measures_itself() {
        let busy: u64 = (0..2_000_000u64).map(std::hint::black_box).sum();
        assert!(busy > 0);
        let app = tree().app;
        assert_eq!(app.processes, 1);
        assert!(app.bytes.is_some_and(|b| b > 1 << 20), "its own memory: {app:?}");
        assert!(app.cpu_ms.is_some(), "its own CPU time: {app:?}");
    }

    #[test]
    fn a_linux_processs_cpu_time_from_its_stat_file() {
        // Its name may hold spaces and parentheses: utime 1500 and stime 500 ticks, at 100 a second.
        let stat = "4242 (Web (Content) x) S 4100 4242 4100 0 -1 4194560 1200 0 3 0 1500 500 0 0 20 0 9 0 812 0 0";
        assert_eq!(stat_cpu_ms(stat, 100), Some(20_000));
        assert_eq!(stat_cpu_ms(stat, 250), Some(8_000));
        assert_eq!(stat_cpu_ms(stat, 0), None);
        assert_eq!(stat_cpu_ms("4242 (cut) S 1 2 3", 100), None);
        assert_eq!(stat_cpu_ms("no name here", 100), None);
    }

    #[test]
    fn a_linux_process_from_its_status_file() {
        let status = "Name:\tWebKitWebProces\nUmask:\t0022\nState:\tS (sleeping)\nPid:\t4242\nPPid:\t4100\n\
                      VmRSS:\t  312340 kB\nRssAnon:\t  201000 kB\nRssFile:\t  101340 kB\n";
        let p = status_of(4242, status).expect("a process");
        assert_eq!((p.pid, p.ppid, p.name.as_str(), p.bytes), (4242, 4100, "WebKitWebProces", Some(201_000 * 1024)));
        // A kernel before 4.5 says no RssAnon: the whole resident memory.
        let old = status_of(7, "Name:\tWebKitWebProces\nPPid:\t1\nVmRSS:\t  1000 kB\n").expect("a process");
        assert_eq!(old.bytes, Some(1000 * 1024));
        // A kernel thread has no memory of its own; a file cut short has no parent.
        assert_eq!(status_of(2, "Name:\tkthreadd\nPPid:\t0\n").and_then(|p| p.bytes), None);
        assert!(status_of(3, "Name:\tbash\n").is_none());
    }

    #[test]
    fn the_machines_memory_from_meminfo() {
        let meminfo = "MemTotal:       16303428 kB\nMemFree:         1234567 kB\nMemAvailable:    9876543 kB\n";
        assert_eq!(meminfo_total(meminfo), Some(16_303_428 * 1024));
        assert_eq!(meminfo_total("MemFree: 1 kB\n"), None);
    }

    #[test]
    fn the_opening_is_told_to_the_site_once() {
        assert_eq!(tell_opening(), None, "not ended yet: told later");
        let _ = OPENING_MS.set(4100);
        assert_eq!(tell_opening(), Some(4100));
        assert_eq!(tell_opening(), None, "a reload of the page is no opening of the app");
    }
}
