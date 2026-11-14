//! The app icon the person picked on this computer (ADR 0179), from the site's Settings › Account › This device
//! (`this_mac` `appIcon`): the Dock's icon on macOS and the windows' (the taskbar's) on Windows and Linux, while
//! the app runs. The bundle keeps the default one, so Finder, Launchpad and the Dock of a closed app show that:
//! changing the bundle would break its signature. Kept in `app-icon.json` (the app's config folder) and shown again
//! at launch and whenever a window is made. The ids are the site's (packages/client `app-icons.ts`); the images come
//! from packages/ui/scripts/app-icons.mjs. The pick can also be one of a workspace's agents: the site draws it (it
//! has the agent engine) and sends both pictures, kept beside the choice, so the Dock shows it on every server.

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// One icon: its id, the Dock's image (macOS's shape and shadow) and the windows' (a rounded square).
#[derive(Debug, PartialEq)]
pub struct Icon {
    pub id: &'static str,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    dock: &'static [u8],
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    window: &'static [u8],
}

macro_rules! icon {
    ($id:literal) => {
        Icon {
            id: $id,
            dock: include_bytes!(concat!("../icons/app/", $id, ".png")),
            window: include_bytes!(concat!("../icons/app/", $id, "-tile.png")),
        }
    };
}

/// In the site's order; the first is the bundle's own.
pub const ICONS: &[Icon] = &[icon!("night"), icon!("moon"), icon!("sky"), icon!("peekNight"), icon!("peekSky")];

pub fn find(id: &str) -> Option<&'static Icon> {
    ICONS.iter().find(|icon| icon.id == id)
}

/// The choice and an agent's two pictures, in the app's config folder.
const CHOICE: &str = "app-icon.json";
const AGENT_DOCK: &str = "app-icon-agent.png";
const AGENT_WINDOW: &str = "app-icon-agent-window.png";
/// A picture the site drew is a PNG of at most this many bytes (the Dock's is 512 px).
const MAX_PICTURE: usize = 1 << 20;

fn folder(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
}

/// What `app-icon.json` keeps: one of the app's icons, or an agent (who it is; its pictures are beside it).
#[derive(Debug, PartialEq)]
enum Saved {
    Icon(&'static Icon),
    Agent(Value),
}

/// The choice in `app-icon.json`'s text, when it is one of ours or a well-formed agent.
fn parse(bytes: &[u8]) -> Option<Saved> {
    let saved: Value = serde_json::from_slice(bytes).ok()?;
    if let Some(agent) = saved.get("agent") {
        return about(agent).map(Saved::Agent);
    }
    find(saved.get("icon")?.as_str()?).map(Saved::Icon)
}

/// An agent as the site describes it, checked and with nothing else: its workspace's id and its own (ids as the
/// site writes them), its name (80 characters at most) and its look (color, eyes and accessory, short words).
pub fn about(agent: &Value) -> Option<Value> {
    let id = |key: &str| {
        agent.get(key)?.as_str().filter(|s| {
            !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
    };
    let name = agent.get("name")?.as_str().map(str::trim).filter(|s| !s.is_empty() && s.chars().count() <= 80)?;
    let look = agent.get("look")?.as_object()?;
    let mut parts = serde_json::Map::new();
    for key in ["color", "eyes", "accessory"] {
        if let Some(part) = look.get(key).and_then(Value::as_str).filter(|s| {
            s.len() <= 32 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '#' || c == '-' || c == '_')
        }) {
            parts.insert(key.into(), part.into());
        }
    }
    Some(json!({ "orgId": id("orgId")?, "id": id("id")?, "name": name, "look": parts }))
}

/// A picture the site drew, from its base64: a PNG, at most `MAX_PICTURE` bytes.
pub fn picture(base64: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    if base64.len() > MAX_PICTURE * 4 / 3 + 4 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64).ok()?;
    (bytes.len() <= MAX_PICTURE && bytes.starts_with(b"\x89PNG\r\n\x1a\n")).then_some(bytes)
}

/// What is shown: one of the app's icons, or an agent with the pictures the site drew.
enum Picked {
    Icon(&'static Icon),
    Agent {
        about: Value,
        #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
        dock: Vec<u8>,
        #[cfg_attr(target_os = "macos", allow(dead_code))]
        window: Vec<u8>,
    },
}

/// The icon picked on this computer (the bundle's own until someone picks, or when an agent's pictures are gone).
fn current(app: &AppHandle) -> Picked {
    let Some(dir) = folder(app) else { return Picked::Icon(&ICONS[0]) };
    match std::fs::read(dir.join(CHOICE)).ok().and_then(|bytes| parse(&bytes)) {
        Some(Saved::Icon(icon)) => Picked::Icon(icon),
        Some(Saved::Agent(about)) => {
            let read = |name: &str| std::fs::read(dir.join(name)).ok().filter(|b| b.starts_with(b"\x89PNG"));
            match (read(AGENT_DOCK), read(AGENT_WINDOW)) {
                (Some(dock), Some(window)) => Picked::Agent { about, dock, window },
                _ => Picked::Icon(&ICONS[0]),
            }
        }
        None => Picked::Icon(&ICONS[0]),
    }
}

/// What the site is told this computer keeps: `{ icon }` or `{ agent }`.
pub fn kept(app: &AppHandle) -> Value {
    match current(app) {
        Picked::Icon(icon) => json!({ "icon": icon.id }),
        Picked::Agent { about, .. } => json!({ "agent": about }),
    }
}

fn keep(app: &AppHandle, files: &[(&str, &[u8])]) -> Result<(), String> {
    let dir = folder(app).ok_or("no config folder")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (name, bytes) in files {
        std::fs::write(dir.join(name), bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Keeps one of the app's icons and shows it.
pub fn set(app: &AppHandle, id: &str) -> Result<(), String> {
    find(id).ok_or("unknown icon")?;
    keep(app, &[(CHOICE, json!({ "icon": id }).to_string().as_bytes())])?;
    show(app);
    Ok(())
}

/// Keeps an agent (`about` as `about` checked it) with its two pictures, and shows it. The pictures first, so the
/// choice never names pictures that aren't there.
pub fn set_agent(app: &AppHandle, about: Value, dock: &[u8], window: &[u8]) -> Result<(), String> {
    keep(app, &[(AGENT_DOCK, dock), (AGENT_WINDOW, window)])?;
    keep(app, &[(CHOICE, json!({ "agent": about }).to_string().as_bytes())])?;
    show(app);
    Ok(())
}

/// Shows the kept icon: at launch, after a pick and when a window is made (on Windows and Linux a new window
/// starts with the bundle's).
pub fn show(app: &AppHandle) {
    apply(app, current(app));
}

#[cfg(target_os = "macos")]
fn apply(app: &AppHandle, picked: Picked) {
    dock_image(
        app,
        match picked {
            Picked::Icon(icon) if icon.id == ICONS[0].id => None,
            Picked::Icon(icon) => Some(icon.dock.to_vec()),
            Picked::Agent { dock, .. } => Some(dock),
        },
    );
}

#[cfg(not(target_os = "macos"))]
fn apply(app: &AppHandle, picked: Picked) {
    let bytes = match picked {
        Picked::Icon(icon) => icon.window.to_vec(),
        Picked::Agent { window, .. } => window,
    };
    if let Ok(image) = tauri::image::Image::from_bytes(&bytes) {
        for window in app.webview_windows().values() {
            let _ = window.set_icon(image.clone());
        }
    }
}

/// The Dock's icon while the app runs; `None` gives the bundle's back.
#[cfg(target_os = "macos")]
fn dock_image(app: &AppHandle, png: Option<Vec<u8>>) {
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    let _ = app.run_on_main_thread(move || {
        // SAFETY: AppKit on the main thread; the data and the image are owned here (`Retained`) and the
        // application keeps its own reference to the image it is given.
        unsafe {
            let image: Option<Retained<AnyObject>> = match png {
                Some(bytes) => {
                    let data: Option<Retained<AnyObject>> = msg_send![
                        class!(NSData),
                        dataWithBytes: bytes.as_ptr().cast::<std::ffi::c_void>(),
                        length: bytes.len()
                    ];
                    let Some(data) = data else { return };
                    let blank: Allocated<AnyObject> = msg_send![class!(NSImage), alloc];
                    let made: Option<Retained<AnyObject>> = msg_send![blank, initWithData: &*data];
                    if made.is_none() {
                        return;
                    }
                    made
                }
                None => None,
            };
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            if ns_app.is_null() {
                return;
            }
            let arg: *const AnyObject = image.as_deref().map_or(std::ptr::null(), |i| i as *const AnyObject);
            let _: () = msg_send![ns_app, setApplicationIconImage: arg];
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_our_ids() {
        assert_eq!(parse(br#"{"icon":"moon"}"#), Some(Saved::Icon(find("moon").unwrap())));
        assert!(parse(br#"{"icon":"../etc/passwd"}"#).is_none());
        assert!(parse(br#"{"icon":7}"#).is_none());
        assert!(parse(b"not json").is_none());
    }

    #[test]
    fn keeps_an_agent_with_nothing_but_who_it_is() {
        let agent = json!({
            "orgId": "o-1", "id": "a_2", "name": " Dev ", "secret": "x",
            "look": { "color": "violet", "eyes": "wide", "accessory": "headphones", "other": "y" },
        });
        let want = json!({
            "orgId": "o-1", "id": "a_2", "name": "Dev",
            "look": { "color": "violet", "eyes": "wide", "accessory": "headphones" },
        });
        assert_eq!(about(&agent), Some(want.clone()));
        assert_eq!(parse(json!({ "agent": agent }).to_string().as_bytes()), Some(Saved::Agent(want)));
        // A custom color is a hex; anything else in a look is dropped, and bad ids or names refuse the agent.
        assert_eq!(about(&json!({ "orgId": "o", "id": "a", "name": "A", "look": { "color": "#a1b2c3", "eyes": "<b>" } })),
            Some(json!({ "orgId": "o", "id": "a", "name": "A", "look": { "color": "#a1b2c3" } })));
        assert!(about(&json!({ "orgId": "../o", "id": "a", "name": "A", "look": {} })).is_none());
        assert!(about(&json!({ "orgId": "o", "id": "a", "name": " ", "look": {} })).is_none());
        assert!(about(&json!({ "orgId": "o", "id": "a", "name": "A".repeat(81), "look": {} })).is_none());
        assert!(about(&json!({ "orgId": "o", "id": "a", "name": "A" })).is_none());
    }

    #[test]
    fn takes_only_png_pictures_of_a_bounded_size() {
        use base64::Engine;
        let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        let png = [b"\x89PNG\r\n\x1a\n".as_slice(), &[0u8; 16][..]].concat();
        assert_eq!(picture(&b64(&png)), Some(png.clone()));
        assert!(picture(&b64(b"GIF89a")).is_none());
        assert!(picture("not base64!").is_none());
        let huge = [png.as_slice(), &vec![0u8; MAX_PICTURE][..]].concat();
        assert!(picture(&b64(&huge)).is_none());
    }

    #[test]
    fn every_icon_has_both_images() {
        for icon in ICONS {
            assert!(icon.dock.starts_with(b"\x89PNG"), "{}", icon.id);
            assert!(icon.window.starts_with(b"\x89PNG"), "{}", icon.id);
        }
    }
}
