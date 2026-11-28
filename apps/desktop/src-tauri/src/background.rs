//! Closing the main window doesn't quit: the window goes and the app keeps running (the runners, the server here,
//! the site's notifications), reached again from the menu bar icon on a Mac (its popover's Open), the tray icon on
//! Windows (a click opens the window, its menu has Open and Quit) and Linux (its menu), or a second launch. Quit
//! (⌘Q, the menus' Quit) still quits. On a Mac the Dock icon goes while none of the app's windows shows, and the
//! menu bar icon shows instead. On Linux without a tray (GNOME without an AppIndicator extension) closing quits:
//! nothing would lead back to the app. The first close says so once, in a notification.

use std::path::Path;
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::main_window;

/// The windows that bring the Dock icon back: the popover and the notch are panels.
pub const APP_WINDOWS: &[&str] = &[main_window::LABEL, "welcome", "prefs"];

/// The popover's say on the menu bar icon (`tray_visible`): shown, and whether the person turned it off.
#[cfg(target_os = "macos")]
static ICON_WANTED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static ICON_OFF: AtomicBool = AtomicBool::new(false);

/// The marker in the app's config folder: the first close's notice was shown.
const NOTICE_FILE: &str = "closed-notice";

/// A Mac's Dock icon: while one of the app's windows shows, or while the person turned the menu bar icon off (the
/// Dock is then the way back).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn in_dock(window_shown: bool, icon_off: bool) -> bool {
    window_shown || icon_off
}

/// A Mac's menu bar icon: as the popover says, and always while no window shows, unless the person turned it off.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn icon_shown(wanted: bool, icon_off: bool, window_shown: bool) -> bool {
    wanted || (!window_shown && !icon_off)
}

/// The popover's choice for the menu bar icon (tray.rs `tray_visible`).
pub fn set_icon(app: &AppHandle, wanted: bool, off: bool) {
    #[cfg(target_os = "macos")]
    {
        ICON_WANTED.store(wanted, Relaxed);
        ICON_OFF.store(off, Relaxed);
        apply(app, any_shown(app, None));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, wanted, off);
}

/// One of the app's windows is about to show: on a Mac it is back in the Dock first, so the window comes in front
/// with the app's menu bar.
pub fn showing(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    apply(app, true);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// One of the app's windows went (`gone`: one destroyed, which may still be listed): on a Mac the app leaves the
/// Dock when none is left.
pub fn settle(app: &AppHandle, gone: Option<&str>) {
    #[cfg(target_os = "macos")]
    apply(app, any_shown(app, gone));
    #[cfg(not(target_os = "macos"))]
    let _ = (app, gone);
}

#[cfg(target_os = "macos")]
fn any_shown(app: &AppHandle, gone: Option<&str>) -> bool {
    APP_WINDOWS
        .iter()
        .filter(|label| Some(**label) != gone)
        .any(|label| app.get_window(label).is_some_and(|w| w.is_visible().unwrap_or(false)))
}

#[cfg(target_os = "macos")]
fn apply(app: &AppHandle, window_shown: bool) {
    let off = ICON_OFF.load(Relaxed);
    let policy =
        if in_dock(window_shown, off) { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory };
    let _ = app.set_activation_policy(policy);
    crate::tray::set_mac_visible(app, icon_shown(ICON_WANTED.load(Relaxed), off, window_shown));
}

/// The main window was closed (its button, ⌘W, Alt+F4) and is hidden now.
pub fn closed(app: &AppHandle) {
    settle(app, None);
    #[cfg(target_os = "linux")]
    {
        let app = app.clone();
        std::thread::spawn(move || {
            if tray_watched() {
                notice_once(&app);
            } else {
                crate::begin_quit(app);
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
    notice_once(app);
}

/// Whether a tray shows the app's icon: libayatana-appindicator's icon is a StatusNotifierItem, drawn only while
/// something owns the watcher's name on the session bus (KDE, Xfce, Cinnamon, Ubuntu's GNOME, GNOME with the
/// AppIndicator extension).
// ponytail: an XEmbed-only tray (i3bar) is taken for none and closing quits there; check `_NET_SYSTEM_TRAY_S0` if
// people on one ask.
#[cfg(target_os = "linux")]
fn tray_watched() -> bool {
    zbus::block_on(async {
        let bus = zbus::Connection::session().await?;
        let dbus = zbus::fdo::DBusProxy::new(&bus).await?;
        dbus.name_has_owner("org.kde.StatusNotifierWatcher".try_into()?).await
    })
    .unwrap_or(false)
}

/// The first close ever: a notification says where the app went, in the app's language (the popover's labels).
fn notice_once(app: &AppHandle) {
    // The person turned the menu bar icon off: the Dock stays, nothing changed to say.
    #[cfg(target_os = "macos")]
    if ICON_OFF.load(Relaxed) {
        return;
    }
    let body_key = if cfg!(target_os = "macos") { "backgroundBodyMac" } else { "backgroundBodyTray" };
    let labels = crate::menus::labels(app);
    let (Some(title), Some(body)) = (labels.get("backgroundTitle"), labels.get(body_key)) else {
        return;
    };
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    if first_time(&dir) {
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

/// True once per folder: it leaves the marker as it says so.
fn first_time(dir: &Path) -> bool {
    let _ = std::fs::create_dir_all(dir);
    std::fs::OpenOptions::new().write(true).create_new(true).open(dir.join(NOTICE_FILE)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_the_background_the_app_keeps_a_way_back() {
        for (wanted, off) in [(false, false), (true, false), (false, true)] {
            assert!(in_dock(false, off) || icon_shown(wanted, off, false), "wanted {wanted}, off {off}");
        }
        // The usual case: out of the Dock, in the menu bar.
        assert!(!in_dock(false, false));
        assert!(icon_shown(false, false, false));
        // The menu bar icon turned off: the Dock stays.
        assert!(in_dock(false, true));
        assert!(!icon_shown(false, true, false));
    }

    #[test]
    fn with_a_window_shown_the_dock_and_the_popovers_choice() {
        assert!(in_dock(true, false));
        assert!(!icon_shown(false, false, true));
        assert!(icon_shown(true, false, true));
    }

    #[test]
    fn the_notice_shows_once() {
        let dir = std::env::temp_dir().join(format!("agentes-notice-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(first_time(&dir));
        assert!(!first_time(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
