import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

/**
 * The main window loads each server's own web app, so a newer desktop app meets the web apps of older servers. What
 * any server's web app has ever asked of the app (its commands and `this_mac`'s requests) is written below, and
 * the app must still take every one: an older server can't be updated by shipping the app. Entries are only ever
 * added; the first test adds what the web app asks now.
 */
const EVER_ASKED = {
  /** The app's own commands (`allow-<command>` in capabilities/main.json, and servers.rs for other servers). */
  commands: ["this_mac", "context_menu", "page_ready"],
  /** The title bar's `data-tauri-drag-region` and the notification plugin's stand-in for `Notification`. */
  plugins: [
    "core:window:allow-start-dragging",
    "core:window:allow-internal-toggle-maximize",
    "notification:allow-is-permission-granted",
  ],
  thisMac: [
    "status",
    "connect",
    "reconnect",
    "prefs",
    "requests",
    "privacy",
    "appIcon",
    "badge",
    "orgs",
    "notify",
    "signIn",
    "servers",
    "files",
    "workspaces",
    "openWorkspace",
    "vitals",
    "addWorkspace",
    "openServer",
  ],
  prefsTabs: ["folders", "tools", "updates", "servers"],
  privacyPanes: ["microphone", "network"],
};

const ROOT = join(import.meta.dir, "../../..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const strings = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[1] ?? "");

const WEB = [...new Glob("apps/web/src/**/*.{ts,tsx}").scanSync(ROOT)].filter((f) => !/\.test\.tsx?$/.test(f));
const bridge = read("apps/web/src/lib/desktop.ts");
const main = JSON.parse(read("apps/desktop/src-tauri/capabilities/main.json")) as { permissions: string[] };
const servers = read("apps/desktop/src-tauri/src/servers.rs");
const mainWindow = read("apps/desktop/src-tauri/src/main_window.rs");
const lib = read("apps/desktop/src-tauri/src/lib.rs");
const build = read("apps/desktop/src-tauri/build.rs");
const answer = read("apps/desktop/src/control/this-mac.ts");
const rustFn = (name: string) => new RegExp(`fn ${name}\\([\\s\\S]*?\\n\\}\\n`).exec(mainWindow)?.[0] ?? "";
const rustList = (name: string) =>
  strings(new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`).exec(mainWindow)?.[1] ?? "", /"(\w+)"/g);

describe("an older server's web app still finds every app command it asks for", () => {
  test("what the web app asks now is on the list", () => {
    const commands = WEB.flatMap((f) => strings(read(f), /\binvoke\("(\w+)"/g));
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.filter((c) => !EVER_ASKED.commands.includes(c))).toEqual([]);
    const kinds = strings(bridge, /\bkind: "(\w+)"/g);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.filter((k) => !EVER_ASKED.thisMac.includes(k))).toEqual([]);
    const tabs = strings(/export type PrefsTab = ([^;]+);/.exec(bridge)?.[1] ?? "", /"(\w+)"/g);
    expect(tabs.length).toBeGreaterThan(0);
    expect(tabs.filter((t) => !EVER_ASKED.prefsTabs.includes(t))).toEqual([]);
    const panes = strings(bridge, /\bpane: "(\w+)"/g);
    expect(panes.filter((p) => !EVER_ASKED.privacyPanes.includes(p))).toEqual([]);
  });

  test("each command is the app's, registered and allowed on every server's pages", () => {
    const allowed = strings(
      /const MAIN_PERMISSIONS: &\[&str\] = &\[([^\]]*)\]/.exec(servers)?.[1] ?? "",
      /"([\w:-]+)"/g,
    );
    for (const command of EVER_ASKED.commands) {
      const permission = `allow-${command.replaceAll("_", "-")}`;
      expect({ command, main: main.permissions.includes(permission), others: allowed.includes(permission) }).toEqual({
        command,
        main: true,
        others: true,
      });
      expect({
        command,
        built: build.includes(`"${command}"`),
        handled: new RegExp(`::${command},`).test(lib),
      }).toEqual({ command, built: true, handled: true });
    }
    for (const plugin of EVER_ASKED.plugins)
      expect({ plugin, main: main.permissions.includes(plugin) }).toEqual({ plugin, main: true });
  });

  test("each of this_mac's requests passes Rust's check and someone answers it", () => {
    const checked = strings(rustFn("checked"), /Some\("(\w+)"\) =>/g);
    // What Rust answers itself, before it hands the rest to the popover (`answerThisMac`).
    const rust = strings(/pub async fn this_mac\([\s\S]*?\n\}\n/.exec(mainWindow)?.[0] ?? "", /Some\("(\w+)"\) =>/g);
    // The popover's: every kind of `ThisMacRequest`, which `answerThisMac` answers through to its last, `connect`.
    const popover = strings(/export type ThisMacRequest =([\s\S]*?);\n/.exec(answer)?.[1] ?? "", /kind: "(\w+)"/g);
    for (const kind of EVER_ASKED.thisMac)
      expect({
        kind,
        checked: checked.includes(kind),
        answered: rust.includes(kind) || popover.includes(kind),
      }).toEqual({
        kind,
        checked: true,
        answered: true,
      });
    expect(EVER_ASKED.prefsTabs.filter((t) => !rustList("PREF_TABS").includes(t))).toEqual([]);
    expect(EVER_ASKED.privacyPanes.filter((p) => !rustList("PRIVACY_PANES").includes(p))).toEqual([]);
    const tsTabs = strings(/export type PrefsTab = ([^;]+);/.exec(answer)?.[1] ?? "", /"(\w+)"/g);
    expect(EVER_ASKED.prefsTabs.filter((t) => !tsTabs.includes(t))).toEqual([]);
  });
});
