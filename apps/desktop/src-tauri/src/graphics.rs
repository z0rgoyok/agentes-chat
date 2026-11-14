//! How this computer draws the app's windows: for the site (`renderer` and `system` in `window.__agentesDesktop`,
//! which calm its styles on the CPU and tag its error reports) and for the person to copy (Preferências ›
//! Atualizações, `app_info`). Anonymous facts only: never a host name, a user or a path.

use serde::Serialize;

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
    /// "AppImage", or "package" (a deb, or anything else that put the app on this computer).
    pub bundle: &'static str,
}

impl System {
    /// The line people copy: "Ubuntu 26.04 LTS · wayland (GNOME) · WebKitGTK 2.50.4 · Intel (i915) · CPU · AppImage".
    pub fn line(&self) -> String {
        let webkit = format!("WebKitGTK {}", self.webkit);
        let renderer = self.renderer.to_uppercase();
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
            bundle: "AppImage",
        };
        assert_eq!(
            system.line(),
            "Ubuntu 26.04 LTS · wayland (GNOME) · WebKitGTK 2.50.4 · Intel (i915) · CPU · AppImage"
        );
        assert_eq!(distro_of("ID=arch\n"), "");
        assert_eq!(session_of("", "Hyprland"), "Hyprland");
        assert_eq!(session_of("", ""), "");
        assert_eq!(gpu_of("0x1af4", ""), "0x1af4");
        assert_eq!(gpu_of("", "virtio-pci"), "virtio-pci");
        let blank = System { distro: String::new(), gpu: String::new(), ..system };
        assert_eq!(blank.line(), "wayland (GNOME) · WebKitGTK 2.50.4 · CPU · AppImage");
    }
}
