//! How this computer draws the app's windows: for the site (`renderer` and `system` in `window.__agentesDesktop`,
//! which calm its styles on the CPU and tag its error reports) and for the person to copy (Preferências ›
//! Atualizações, `app_info`). Anonymous facts only: never a host name, a user or a path.
//!
//! On Linux the person chooses it (Compatibility mode in Preferences › General, on unless turned off): on, WebKitGTK
//! draws without the graphics card (`WEBKIT_DISABLE_DMABUF_RENDERER`); off, with it. The choice is read before
//! anything starts (`choose`), since WebKitGTK reads that variable once. An opening with the graphics card whose page
//! arrived from its server and never painted turns it back on for the next one, so a black window is never more than
//! one opening away from a window. Without painting anything, `--compatibility-mode` turns it on too (and reopens an
//! app already running). A server older than the site's `page_ready` never clears the opening's marker: with the
//! switch off, every other opening there falls back.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Manager};

const DMABUF_VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
/// Set beside `DMABUF_VAR` when the app set it: a reopened app inherits both, and its own value is not the person's.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const APP_SET_VAR: &str = "AGENTES_DESKTOP_DMABUF_BY_APP";
/// The Compatibility mode switch, in the app's config folder: "off", or anything else (none at all too) for on.
const COMPAT_FILE: &str = "compatibility-mode";
/// Turns Compatibility mode on from a terminal, for a window too black to reach Preferences.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const COMPAT_ARG: &str = "--compatibility-mode";
/// Set once `COMPAT_ARG` was taken: a reopened app keeps its arguments, and must not undo a later switch off.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const ARG_TAKEN_VAR: &str = "AGENTES_DESKTOP_COMPAT_ARG_TAKEN";
/// The opening's marker (cover.rs `PENDING_FILE`) on the graphics card until its page arrives from its server, then
/// `GPU_LOADED`: only that one falls back when it never painted.
pub const GPU_LOADING: &str = "gpu-loading";
pub const GPU_LOADED: &str = "gpu";

/// Why this opening draws the way it does.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Why {
    /// Compatibility mode, on or off.
    Chosen,
    /// The last opening, with the graphics card, never painted.
    Fallback,
    /// The person's own `WEBKIT_DISABLE_DMABUF_RENDERER`.
    Variable,
}

impl Why {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    fn as_str(self) -> &'static str {
        match self {
            Why::Chosen => "chosen",
            Why::Fallback => "fallback",
            Why::Variable => "own variable",
        }
    }
}

static WHY: OnceLock<Why> = OnceLock::new();
/// The fallback is said once, by the first Preferences that asks (`compat_get`).
static FELL_BACK_UNSAID: AtomicBool = AtomicBool::new(false);

fn why() -> Why {
    WHY.get().copied().unwrap_or(Why::Chosen)
}

/// This opening fell back to drawing without the graphics card (`choose`).
pub fn fell_back() -> bool {
    why() == Why::Fallback
}

/// The switch's state from its file's text: only "off" is off. On by default, since WebKitGTK's DMA-BUF renderer leaves
/// the window blank with NVIDIA's driver, in virtual machines and in many AppImage setups.
fn compat_on(text: Option<&str>) -> bool {
    text.map(str::trim) != Some("off")
}

/// How this opening draws (true: without the graphics card), and why. `own`: the person's own variable, which always
/// wins. `last_unpainted`: what the last opening that never painted wrote in its marker (`marker`): only one whose
/// page arrived on the graphics card counts, never one that was offline, found its server down or quit first.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn decide(own: Option<&str>, compat: bool, last_unpainted: Option<&str>) -> (bool, Why) {
    match own {
        Some(value) => (value != "0", Why::Variable),
        None if compat => (true, Why::Chosen),
        None if last_unpainted.map(str::trim) == Some(GPU_LOADED) => (true, Why::Fallback),
        None => (false, Why::Chosen),
    }
}

/// The opening's marker as it starts (cover.rs `opening`): "cpu", or `GPU_LOADING`; empty outside Linux.
pub fn marker() -> &'static str {
    if !cfg!(target_os = "linux") {
        ""
    } else if renderer() == "cpu" {
        "cpu"
    } else {
        GPU_LOADING
    }
}

/// The app's config folder as Tauri names it (`app_config_dir`), before Tauri is up.
#[cfg(target_os = "linux")]
fn config_dir() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
    Some(base.join(IDENTIFIER))
}

/// tauri.conf.json's `identifier`, the config folder's name.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const IDENTIFIER: &str = "chat.agentes.desktop";

/// Before any thread starts (main.rs): sets or clears the variable WebKitGTK draws by, as decided.
#[cfg(target_os = "linux")]
pub fn choose() {
    let dir = config_dir();
    let read = |name: &str| dir.as_ref().and_then(|d| std::fs::read_to_string(d.join(name)).ok());
    let own = match std::env::var_os(APP_SET_VAR) {
        Some(_) => None,
        None => std::env::var(DMABUF_VAR).ok(),
    };
    let asked = std::env::var_os(ARG_TAKEN_VAR).is_none() && std::env::args().any(|a| a == COMPAT_ARG);
    if asked {
        if let Some(dir) = &dir {
            let _ = write_compat(dir, true);
        }
        std::env::set_var(ARG_TAKEN_VAR, "1");
    }
    let last = read(crate::cover::PENDING_FILE);
    let compat = asked || compat_on(read(COMPAT_FILE).as_deref());
    let (cpu, why) = decide(own.as_deref(), compat, last.as_deref());
    if why != Why::Variable {
        if cpu {
            std::env::set_var(DMABUF_VAR, "1");
            std::env::set_var(APP_SET_VAR, "1");
        } else {
            std::env::remove_var(DMABUF_VAR);
            std::env::remove_var(APP_SET_VAR);
        }
    }
    let _ = WHY.set(why);
}

#[cfg(not(target_os = "linux"))]
pub fn choose() {}

/// Once the app is up, never in a second launch on its way to the running one: an opening that fell back keeps
/// Compatibility mode on, and Preferences says so once. True when it did; a switch that couldn't be written back on
/// is not claimed to be.
pub fn fall_back(app: &AppHandle) -> bool {
    let written = fell_back()
        && app
            .path()
            .app_config_dir()
            .is_ok_and(|dir| write_compat(&dir, true).is_ok());
    if written {
        FELL_BACK_UNSAID.store(true, Ordering::Relaxed);
    }
    written
}

fn write_compat(dir: &Path, on: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(COMPAT_FILE), if on { "on" } else { "off" })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Compat {
    on: bool,
    /// This opening fell back, not said yet: true for the first ask only.
    fell_back: bool,
    /// `WEBKIT_DISABLE_DMABUF_RENDERER` was there when the app started (the person's, or one an older version of the
    /// app set and passed on as it reopened): it decides, `on` says what it does, and the switch can't change it.
    own: bool,
}

/// Preferences › General: Compatibility mode as it will be at the next opening.
#[tauri::command]
pub fn compat_get(app: AppHandle) -> Compat {
    let fell_back = FELL_BACK_UNSAID.swap(false, Ordering::Relaxed);
    if why() == Why::Variable {
        let on = std::env::var(DMABUF_VAR).is_ok_and(|v| v != "0");
        return Compat { on, fell_back, own: true };
    }
    let text = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join(COMPAT_FILE)).ok());
    Compat { on: compat_on(text.as_deref()), fell_back, own: false }
}

/// Preferences › General: Compatibility mode for the next opening (WebKitGTK reads it only when the app starts).
#[tauri::command]
pub fn compat_set(app: AppHandle, on: bool) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    write_compat(&dir, on).map_err(|e| e.to_string())
}

/// The line people copy (Preferences › Updates, the cover's Copy details) on every system: the app's version and
/// the system's, and on Linux how it draws. "agentes.chat 0.8.9 · macOS 15.1".
pub fn details_line(version: &str, os: &str, system_version: Option<&str>, linux: Option<&System>) -> String {
    let name = match os {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    let system = match system_version {
        Some(v) if !v.is_empty() => format!("{name} {v}"),
        _ => name.to_owned(),
    };
    let mut line = format!("agentes.chat {version} · {system}");
    if let Some(linux) = linux.map(System::line).filter(|l| !l.is_empty()) {
        line.push_str(" · ");
        line.push_str(&linux);
    }
    line
}

/// This app's details line, as `details_line` says it.
pub fn details(app: &AppHandle) -> String {
    details_line(
        &app.package_info().version.to_string(),
        std::env::consts::OS,
        crate::prepare::system_version().as_deref(),
        system().as_ref(),
    )
}

/// "cpu" when WebKitGTK paints every frame in software, "gpu" otherwise.
#[cfg(target_os = "linux")]
pub fn renderer() -> &'static str {
    let var = |name: &str| std::env::var(name).ok();
    renderer_for(
        var("WEBKIT_DISABLE_DMABUF_RENDERER").as_deref(),
        var("WEBKIT_DISABLE_COMPOSITING_MODE").as_deref(),
        webkit_version(),
    )
}

#[cfg(not(target_os = "linux"))]
pub fn renderer() -> &'static str {
    "gpu"
}

/// WebKitGTK reads these variables as on for any value but "0". From 2.44 on, without the DMA-BUF renderer there
/// is no other accelerated one left, so it paints on the CPU.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn renderer_for(dmabuf_off: Option<&str>, compositing_off: Option<&str>, webkit: (u32, u32, u32)) -> &'static str {
    let on = |v: Option<&str>| v.is_some_and(|v| v != "0");
    if on(compositing_off) || (on(dmabuf_off) && (webkit.0, webkit.1) >= (2, 44)) {
        "cpu"
    } else {
        "gpu"
    }
}

/// The WebKitGTK the app runs on (webkit2gtk-rs wraps no version call: the C ones return the library's own
/// constants, from any thread).
#[cfg(target_os = "linux")]
fn webkit_version() -> (u32, u32, u32) {
    // SAFETY: plain getters with no arguments and no state.
    unsafe {
        (
            webkit2gtk::ffi::webkit_get_major_version(),
            webkit2gtk::ffi::webkit_get_minor_version(),
            webkit2gtk::ffi::webkit_get_micro_version(),
        )
    }
}

/// What a Linux computer says about how it draws.
#[derive(Serialize)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub struct System {
    pub distro: String,
    /// "wayland (GNOME)", "x11 (KDE)".
    pub session: String,
    pub webkit: String,
    /// Each graphics card by maker, with its kernel driver: "Intel (i915)", "AMD (amdgpu) + NVIDIA (nvidia)".
    pub gpu: String,
    pub renderer: &'static str,
    /// Why it draws that way: "chosen", "fallback" or "own variable".
    pub renderer_why: &'static str,
    /// "AppImage", or "package" (a deb, or anything else that put the app on this computer).
    pub bundle: &'static str,
}

impl System {
    /// "Ubuntu 26.04 LTS · wayland (GNOME) · WebKitGTK 2.50.4 · Intel (i915) · CPU (chosen) · AppImage".
    pub fn line(&self) -> String {
        let webkit = format!("WebKitGTK {}", self.webkit);
        let renderer = format!("{} ({})", self.renderer.to_uppercase(), self.renderer_why);
        [
            self.distro.as_str(),
            self.session.as_str(),
            webkit.as_str(),
            self.gpu.as_str(),
            renderer.as_str(),
            self.bundle,
        ]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
    }
}

#[cfg(target_os = "linux")]
pub fn system() -> Option<System> {
    let var = |name: &str| std::env::var(name).unwrap_or_default();
    let (major, minor, micro) = webkit_version();
    Some(System {
        distro: std::fs::read_to_string("/etc/os-release").map(|t| distro_of(&t)).unwrap_or_default(),
        session: session_of(&var("XDG_SESSION_TYPE"), &var("XDG_CURRENT_DESKTOP")),
        webkit: format!("{major}.{minor}.{micro}"),
        gpu: gpus(),
        renderer: renderer(),
        renderer_why: why().as_str(),
        bundle: if std::env::var_os("APPIMAGE").is_some() { "AppImage" } else { "package" },
    })
}

#[cfg(not(target_os = "linux"))]
pub fn system() -> Option<System> {
    None
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn distro_of(os_release: &str) -> String {
    os_release
        .lines()
        .find_map(|l| l.strip_prefix("PRETTY_NAME="))
        .map(|v| v.trim().trim_matches('"').to_owned())
        .unwrap_or_default()
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn session_of(kind: &str, desktop: &str) -> String {
    match (kind.is_empty(), desktop.is_empty()) {
        (false, false) => format!("{kind} ({desktop})"),
        (false, true) => kind.to_owned(),
        (true, false) => desktop.to_owned(),
        (true, true) => String::new(),
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn gpu_of(vendor: &str, driver: &str) -> String {
    let maker = match vendor.trim() {
        "0x8086" => "Intel",
        "0x1002" => "AMD",
        "0x10de" => "NVIDIA",
        other => other,
    };
    match (maker.is_empty(), driver.is_empty()) {
        (false, false) => format!("{maker} ({driver})"),
        (false, true) => maker.to_owned(),
        _ => driver.to_owned(),
    }
}

/// The graphics cards the kernel shows (`/sys/class/drm/cardN`, never its connectors `cardN-HDMI-A-1`).
#[cfg(target_os = "linux")]
fn gpus() -> String {
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else { return String::new() };
    let mut cards: Vec<(String, String)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let n = name.strip_prefix("card")?;
            (!n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())).then(|| {
                let device = e.path().join("device");
                let vendor = std::fs::read_to_string(device.join("vendor")).unwrap_or_default();
                let driver = std::fs::read_link(device.join("driver"))
                    .ok()
                    .and_then(|p| p.file_name().map(|f| f.to_string_lossy().into_owned()))
                    .unwrap_or_default();
                (name, gpu_of(&vendor, &driver))
            })
        })
        .collect();
    cards.sort();
    cards.into_iter().map(|(_, gpu)| gpu).filter(|g| !g.is_empty()).collect::<Vec<_>>().join(" + ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_renderer_webkitgtk_ends_up_with() {
        // The app's own default on Linux, on today's WebKitGTK.
        assert_eq!(renderer_for(Some("1"), None, (2, 50, 4)), "cpu");
        // The person's own "=0" turns the DMA-BUF renderer back on.
        assert_eq!(renderer_for(Some("0"), None, (2, 50, 4)), "gpu");
        assert_eq!(renderer_for(None, None, (2, 50, 4)), "gpu");
        // Before 2.44 the older accelerated path was still there.
        assert_eq!(renderer_for(Some("1"), None, (2, 42, 5)), "gpu");
        assert_eq!(renderer_for(None, Some("1"), (2, 40, 0)), "cpu");
        assert_eq!(renderer_for(Some("0"), Some("0"), (2, 50, 4)), "gpu");
    }

    #[test]
    fn the_line_people_copy() {
        let os_release = "NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 26.04 LTS\"\nID=ubuntu\n";
        let system = System {
            distro: distro_of(os_release),
            session: session_of("wayland", "GNOME"),
            webkit: "2.50.4".into(),
            gpu: gpu_of("0x8086\n", "i915"),
            renderer: "cpu",
            renderer_why: "chosen",
            bundle: "AppImage",
        };
        assert_eq!(
            system.line(),
            "Ubuntu 26.04 LTS · wayland (GNOME) · WebKitGTK 2.50.4 · Intel (i915) · CPU (chosen) · AppImage"
        );
        assert_eq!(distro_of("ID=arch\n"), "");
        assert_eq!(session_of("", "Hyprland"), "Hyprland");
        assert_eq!(session_of("", ""), "");
        assert_eq!(gpu_of("0x1af4", ""), "0x1af4");
        assert_eq!(gpu_of("", "virtio-pci"), "virtio-pci");
        let blank = System { distro: String::new(), gpu: String::new(), ..system };
        assert_eq!(blank.line(), "wayland (GNOME) · WebKitGTK 2.50.4 · CPU (chosen) · AppImage");
        assert_eq!(
            details_line("0.8.9", "linux", None, Some(&blank)),
            "agentes.chat 0.8.9 · Linux · wayland (GNOME) · WebKitGTK 2.50.4 · CPU (chosen) · AppImage"
        );
        assert_eq!(details_line("0.8.9", "macos", Some("15.1"), None), "agentes.chat 0.8.9 · macOS 15.1");
        assert_eq!(details_line("0.8.9", "windows", None, None), "agentes.chat 0.8.9 · Windows");
    }

    #[test]
    fn how_an_opening_draws_and_why() {
        // The person's own variable wins over everything, "0" included.
        assert_eq!(decide(Some("1"), false, Some("gpu")), (true, Why::Variable));
        assert_eq!(decide(Some("0"), true, None), (false, Why::Variable));
        // Compatibility mode on: without the graphics card, as before the switch existed.
        assert_eq!(decide(None, true, None), (true, Why::Chosen));
        assert_eq!(decide(None, true, Some("gpu")), (true, Why::Chosen));
        // Off: with the graphics card...
        assert_eq!(decide(None, false, None), (false, Why::Chosen));
        assert_eq!(decide(None, false, Some("cpu")), (false, Why::Chosen));
        // ...unless the last opening with it never painted.
        assert_eq!(decide(None, false, Some("gpu")), (true, Why::Fallback));
        // A marker from before the mode was written in it says nothing.
        assert_eq!(decide(None, false, Some("")), (false, Why::Chosen));
        // Nor an opening whose page never arrived from its server (offline, the server down, quit first).
        assert_eq!(decide(None, false, Some(GPU_LOADING)), (false, Why::Chosen));
    }

    #[test]
    fn the_switch_is_on_unless_its_file_says_off() {
        assert!(compat_on(None));
        assert!(compat_on(Some("")));
        assert!(compat_on(Some("on")));
        assert!(compat_on(Some("\u{0}garbled")));
        assert!(!compat_on(Some("off")));
        assert!(!compat_on(Some("off\n")));
    }

    #[test]
    fn the_switch_lives_where_tauri_keeps_the_app_config() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], IDENTIFIER);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_details_line_names_no_home_folder_or_host() {
        let line = details_line("0.8.9", "linux", None, system().as_ref());
        let home = std::env::var("HOME").unwrap_or_default();
        if home.len() > 1 {
            assert!(!line.contains(&home), "{line}");
        }
        let host = std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default();
        let host = host.trim();
        if host.len() > 3 {
            assert!(!line.contains(host), "{line}");
        }
    }
}
