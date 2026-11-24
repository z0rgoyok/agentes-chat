# agentes.chat (desktop app)

Tauri 2 app for macOS, Windows and Linux (ADR 0036). Rust in `src-tauri/` keeps to windows, the tray, the server list,
links, the children it runs (the runners and, for "Run agentes.chat on this computer", the server), notifications and
self-update; the app's own windows (the popover, Preferences, the welcome window, the cover) are the TypeScript in `src/`;
the main window loads the server's own pages.

CI runs the Rust tests on Linux (`cargo test` in `src-tauri`, with stand-ins for what the app bundles: see the
`test-desktop-rust` job in `.github/workflows/ci.yml`) and the TypeScript tests in `test/`. Code behind
`#[cfg(target_os = "macos")]` or Windows' is built only by the **Desktop** workflow (`.github/workflows/desktop.yml`,
run by hand), so check it locally (`cargo check` in `src-tauri`) before a pull request.

## When the app freezes

Measure before changing anything bigger than a small fix.

1. **Read `window.log`** (macOS `~/Library/Logs/chat.agentes.desktop/`, Windows `%LOCALAPPDATA%\chat.agentes.desktop\logs\`,
   Linux `~/.local/share/chat.agentes.desktop/logs/`; the cover's Copy details ends with it). The app writes there:
   - `main thread stalled 1840 ms (last: local_server_status)`: the main thread answered nothing for over a second.
     `last` is the app command or the window event it was last given. A stall that is still going after 5 s gets a
     `still stalled` line at once, so a main thread that never comes back leaves one too.
   - `panic on thread ...`: the release build aborts on a panic, and this line is all that is left of it.
   - `the web process of main ended ...`: the system ended the page's web process (memory, a crash); the window loads
     it again. Linux names the reason.
2. **Is it Rust or the web view?** During the freeze, `sample <pid> 5` (or Activity Monitor › Sample Process). The main
   thread in `local_server::status`, `std::fs`, `Command::output` or `place_lights` / `setFrame` is Rust; the main
   thread idle in `mach_msg` while the window is stuck is the web view. The release build is stripped: for Rust frames
   with names, run the **Desktop** workflow with `profiling` on (and `release` = none) and use that build on a test Mac.
   It keeps the symbols and turns the web inspector on.
3. **The web view**: Safari › Develop › the Mac › agentes.chat (the profiling build), Timelines with JavaScript and
   Events, Layout and Rendering, and Memory. Record 10 s of the symptom, then a 30-minute soak on a busy channel: long
   tasks over 50 ms and a growing heap or node count say which screen does it.
4. **Resizing and a hidden window**: Instruments' Time Profiler during a 5 s drag of a window edge, and the thread
   count before and during it (`ps -M <pid> | wc -l`). With the window closed for 10 minutes, the WebContent process's
   CPU in Activity Monitor should stay near zero.
5. **The server on this computer** (Run here): `curl -w '%{time_total}\n' -o /dev/null -s http://127.0.0.1:4310/api/health`
   every second during the freeze (its port is `PORT` in `~/.agentes/.env`). A jump from a few milliseconds to seconds
   is its event loop blocked, not the app.
6. **Windows**: WebView2's DevTools (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, then
   `chrome://inspect` in Edge) and Windows Performance Recorder's CPU sampling. **Linux**: `perf top -p <pid>`; `pixman`
   or `cairo` near the top means the page is painted in software (Compatibility mode, Preferences › General; the line
   in Preferences › Updates says how this computer draws).

Done when `window.log` shows no stall over a second for a week, the WebContent process's memory stays flat over 8 hours
with the window hidden, and no new freeze is reported.
