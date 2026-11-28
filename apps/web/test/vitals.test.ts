import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { webVitalsHost } from "@/lib/vitals";

/**
 * The web's side of the speed reports (the shared part is tested in packages/client): which platform a page reports
 * as, when its opening can be timed, and what the desktop app adds to each report.
 */

const win = () => window as { __agentesDesktop?: unknown; __TAURI_INTERNALS__?: unknown };
let state: DocumentVisibilityState = "visible";
/** The page shows or hides, as the browser says it. */
const showing = (next: DocumentVisibilityState) => {
  state = next;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
};

afterEach(() => {
  delete win().__agentesDesktop;
  delete win().__TAURI_INTERNALS__;
  // Back to the browser's own (on its prototype).
  delete (document as { visibilityState?: unknown }).visibilityState;
});

/** The desktop app on `platform`, answering `vitals` with `told` (or refusing it, as an app from before does). */
function inTheApp(platform: string, told: Record<string, unknown> | "refuse") {
  const asked: unknown[] = [];
  win().__agentesDesktop = { version: "0.8.18", platform };
  win().__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: { request: { kind: string } }) => {
      asked.push(cmd === "this_mac" ? args.request : cmd);
      if (told === "refuse") throw "unknown request";
      return told;
    },
  };
  return asked;
}

describe("the web's speed reports", () => {
  test("a browser reports as the web, its opening timed from the navigation while it shows", () => {
    showing("visible");
    const host = webVitalsHost();
    expect(host.platform).toBe("web");
    expect(host.own).toBeUndefined();
    expect(host.startedAt()).toBe(0);
    expect(host.presence()).toBe("front");
    const seen: string[] = [];
    const off = host.onPresence((p) => seen.push(p));
    showing("hidden");
    showing("visible");
    off();
    showing("hidden");
    expect(seen).toEqual(["away", "front"]);
    // Hidden on the way to its first screen: that opening says nothing of the app.
    expect(host.startedAt()).toBeNull();
  });

  test("a page opened in a background tab has no opening to time", () => {
    showing("hidden");
    expect(webVitalsHost().startedAt()).toBeNull();
  });

  test("the desktop app reports as its system, with its own opening and its web view's memory", async () => {
    const asked = inTheApp("windows", { coldStartMs: 5400, webviewBytes: 412_000_000 });
    const host = webVitalsHost();
    expect(host.platform).toBe("windows");
    expect(await host.own?.()).toEqual({ coldStartMs: 5400, webviewBytes: 412_000_000 });
    expect(asked).toEqual([{ kind: "vitals" }]);

    // A Mac said nothing of its platform before Windows and Linux.
    inTheApp("mac", { webviewBytes: 190_000_000 });
    expect(webVitalsHost().platform).toBe("macos");
    inTheApp("linux", {});
    expect(webVitalsHost().platform).toBe("linux");
  });

  test("never the page's own opening in the app: an app from before, or one past what the server takes, sends none", async () => {
    // The key itself, `undefined`: it replaces the page's own opening in the report (`toStrictEqual`, never `{}`).
    inTheApp("mac", "refuse");
    expect(await webVitalsHost().own?.()).toStrictEqual({ coldStartMs: undefined });
    inTheApp("linux", { coldStartMs: 900_000, webviewBytes: 260_000_000 });
    expect(await webVitalsHost().own?.()).toStrictEqual({ coldStartMs: undefined, webviewBytes: 260_000_000 });
  });

  test("the desktop app's window without focus is in between, as one hidden to the tray whose page stays visible", () => {
    inTheApp("windows", {});
    showing("visible");
    let focused = true;
    const hasFocus = spyOn(document, "hasFocus").mockImplementation(() => focused);
    try {
      const host = webVitalsHost();
      expect(host.presence()).toBe("front");
      const seen: string[] = [];
      const off = host.onPresence((p) => seen.push(p));
      focused = false;
      window.dispatchEvent(new Event("blur"));
      focused = true;
      window.dispatchEvent(new Event("focus"));
      showing("hidden");
      off();
      expect(seen).toEqual(["between", "front", "away"]);

      // A browser's tab is in front while it shows, focused or not.
      delete win().__agentesDesktop;
      focused = false;
      showing("visible");
      expect(webVitalsHost().presence()).toBe("front");
    } finally {
      hasFocus.mockRestore();
    }
  });
});
