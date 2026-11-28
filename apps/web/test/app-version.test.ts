import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import {
  createVersionWatch,
  entryOf,
  holdReload,
  metaOf,
  reloadForNewVersion,
  reloadFresh,
  reloadIfStale,
  reloadingForNewVersion,
  reloadWhenSafe,
  reloadWouldCut,
  resetVersionReload,
  safeToReload,
  startVersionWatch,
  URGENT_BEHIND,
  URGENT_PAUSE_MS,
  watchTyping,
} from "../src/lib/app-version";
import { STORAGE_KEYS } from "../src/lib/storage";

const page = (entry: string, oldestGood = "") =>
  `<!doctype html><html><head><meta name="agentes-oldest-good" content="${oldestGood}" /><script>var t = 1;</script><script type="module" crossorigin src="${entry}"></script></head></html>`;

describe("app version", () => {
  test("finds the app's module script in index.html", () => {
    expect(entryOf(page("/assets/index-abc.js"))).toBe("/assets/index-abc.js");
    expect(entryOf('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
    expect(entryOf("<html></html>")).toBeNull();
  });

  test("a new bundle on the server makes the tab stale, once", async () => {
    let html = page("/assets/index-abc.js");
    let staleCalls = 0;
    const watch = createVersionWatch({
      loaded: "/assets/index-abc.js",
      fetchHtml: async () => html,
      onStale: () => staleCalls++,
    });
    await watch.check();
    expect(watch.stale).toBe(false);
    html = page("/assets/index-def.js");
    await watch.check();
    await watch.check();
    expect(watch.stale).toBe(true);
    expect(staleCalls).toBe(1);
  });

  test("a failed fetch or an unknown page bundle never marks it stale", async () => {
    const failing = createVersionWatch({
      loaded: "/assets/index-abc.js",
      fetchHtml: async () => {
        throw new Error("offline");
      },
      onStale: () => {},
    });
    await failing.check();
    expect(failing.stale).toBe(false);
    const dev = createVersionWatch({ loaded: null, fetchHtml: async () => page("/assets/x.js"), onStale: () => {} });
    await dev.check();
    expect(dev.stale).toBe(false);
  });
});

describe("a page's file from before a deploy (vite:preloadError)", () => {
  afterEach(() => {
    // The app's watch is the module's: a stale one left here would reload the next file's error screens.
    startVersionWatch(createVersionWatch({ loaded: null, fetchHtml: async () => "", onStale: () => {} }));
    resetVersionReload();
    sessionStorage.clear();
  });

  test("reloads into the new version at most once a minute, and says it is reloading", () => {
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    try {
      expect(reloadingForNewVersion()).toBe(false);
      expect(reloadForNewVersion(1_000_000)).toBe(true);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(reloadingForNewVersion()).toBe(true);
      expect(sessionStorage.getItem(STORAGE_KEYS.versionReload)).toBe("1000000");
      // The new page, its file missing again within the minute: a crash, not a deploy.
      resetVersionReload();
      expect(reloadForNewVersion(1_059_999)).toBe(false);
      expect(reloadingForNewVersion()).toBe(false);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(reloadForNewVersion(1_060_000)).toBe(true);
      expect(reload).toHaveBeenCalledTimes(2);
    } finally {
      reload.mockRestore();
    }
  });

  test("a page still here a moment after asking to reload stayed (it asked before leaving): reports and the error screen come back", () => {
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    const later: (() => void)[] = [];
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void) => {
      later.push(run);
      return 0;
    }) as unknown as typeof setTimeout);
    try {
      expect(reloadForNewVersion(1_000_000)).toBe(true);
      expect(reloadingForNewVersion()).toBe(true);
      for (const run of later.splice(0)) run();
      expect(reloadingForNewVersion()).toBe(false);
    } finally {
      timers.mockRestore();
      reload.mockRestore();
    }
  });

  test("a crash in a tab a deploy left behind reloads into the new version; one in the current version stays", async () => {
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    let html = page("/assets/index-abc.js");
    startVersionWatch(
      createVersionWatch({ loaded: "/assets/index-abc.js", fetchHtml: async () => html, onStale: () => {} }),
    );
    try {
      expect(await reloadIfStale()).toBe(false);
      expect(reload).not.toHaveBeenCalled();
      html = page("/assets/index-def.js");
      expect(await reloadIfStale()).toBe(true);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(reloadingForNewVersion()).toBe(true);
    } finally {
      reload.mockRestore();
    }
  });

  test("never reloads where this tab's storage keeps nothing: it would reload forever", () => {
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    const real = globalThis.sessionStorage;
    globalThis.sessionStorage = { getItem: () => null, setItem: () => {} } as unknown as Storage;
    try {
      expect(reloadForNewVersion(1_000_000)).toBe(false);
      expect(reload).not.toHaveBeenCalled();
      expect(reloadingForNewVersion()).toBe(false);
    } finally {
      globalThis.sessionStorage = real;
      reload.mockRestore();
    }
  });
});

describe("an old tab moves to the new version at a safe moment", () => {
  let stopTyping = () => {};
  afterEach(() => {
    stopTyping();
    document.body.innerHTML = "";
    startVersionWatch(createVersionWatch({ loaded: null, fetchHtml: async () => "", onStale: () => {} }));
    resetVersionReload();
    sessionStorage.clear();
  });

  test("counts the versions it missed, and a build older than the server's oldest good one is urgent", async () => {
    expect(metaOf(page("/assets/a.js", "2026-11-27T00:00:00Z"), "agentes-oldest-good")).toBe("2026-11-27T00:00:00Z");
    let html = page("/assets/index-abc.js");
    const watch = createVersionWatch({
      loaded: "/assets/index-abc.js",
      built: "2026-11-26T10:00:00Z",
      fetchHtml: async () => html,
      onStale: () => {},
    });
    for (let n = 1; n < URGENT_BEHIND; n++) {
      html = page(`/assets/index-${n}.js`);
      await watch.check();
      await watch.check();
    }
    expect(watch.behind).toBe(URGENT_BEHIND - 1);
    expect(watch.urgent).toBe(false);
    html = page("/assets/index-next.js", "2026-11-26T09:00:00Z");
    await watch.check();
    expect(watch.urgent).toBe(true);

    const bad = createVersionWatch({
      loaded: "/assets/index-abc.js",
      built: "2026-11-26T10:00:00Z",
      fetchHtml: async () => page("/assets/index-def.js", "2026-11-27T00:00:00Z"),
      onStale: () => {},
    });
    await bad.check();
    expect(bad.behind).toBe(1);
    expect(bad.urgent).toBe(true);
  });

  test("safe: nothing would be lost and nobody is using it; urgent also at a short pause", () => {
    const calm = { pausedMs: 0, urgent: false, cuts: false };
    expect(safeToReload({ ...calm, sight: "hidden" })).toBe(true);
    expect(safeToReload({ ...calm, sight: "idle" })).toBe(true);
    expect(safeToReload({ ...calm, sight: "present" })).toBe(false);
    expect(safeToReload({ ...calm, sight: "present", pausedMs: URGENT_PAUSE_MS })).toBe(false);
    expect(safeToReload({ ...calm, sight: "present", urgent: true, pausedMs: URGENT_PAUSE_MS - 1 })).toBe(false);
    expect(safeToReload({ ...calm, sight: "present", urgent: true, pausedMs: URGENT_PAUSE_MS })).toBe(true);
    expect(safeToReload({ ...calm, sight: "hidden", urgent: true, cuts: true })).toBe(false);
  });

  test("typed and unsent text, an open dialog or a hold would be cut", () => {
    stopTyping = watchTyping();
    expect(reloadWouldCut()).toBe(false);
    document.body.innerHTML = '<textarea id="composer"></textarea><div id="rich" contenteditable="true"></div>';
    const composer = document.getElementById("composer") as HTMLTextAreaElement;
    composer.value = "half a message";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    expect(reloadWouldCut()).toBe(true);
    // Sent: the box is empty again.
    composer.value = "";
    expect(reloadWouldCut()).toBe(false);
    const rich = document.getElementById("rich") as HTMLElement;
    rich.textContent = "notes";
    rich.dispatchEvent(new Event("input", { bubbles: true }));
    expect(reloadWouldCut()).toBe(true);
    rich.remove();
    expect(reloadWouldCut()).toBe(false);

    document.body.insertAdjacentHTML("beforeend", '<div role="dialog"></div>');
    expect(reloadWouldCut()).toBe(true);
    document.body.innerHTML = "";

    const release = holdReload();
    expect(reloadWouldCut()).toBe(true);
    release();
    release();
    expect(reloadWouldCut()).toBe(false);
  });

  test("a stale, urgent tab left alone reloads by itself; one with unsent text keeps the notice", async () => {
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    stopTyping = watchTyping();
    const watch = createVersionWatch({
      loaded: "/assets/index-abc.js",
      built: "2026-11-26T10:00:00Z",
      fetchHtml: async () => page("/assets/index-def.js", "2026-11-27T00:00:00Z"),
      onStale: () => {},
    });
    const later = () => Date.now() + 60 * 60_000;
    let stop = reloadWhenSafe(watch, later);
    try {
      // Not stale yet: nothing moves.
      expect(reload).not.toHaveBeenCalled();
      stop();
      await watch.check();
      document.body.innerHTML = '<input type="text" id="field" />';
      const field = document.getElementById("field") as HTMLInputElement;
      field.value = "draft";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      stop = reloadWhenSafe(watch, later);
      expect(reload).not.toHaveBeenCalled();
      stop();
      field.value = "";
      stop = reloadWhenSafe(watch, later);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(reloadingForNewVersion()).toBe(true);
    } finally {
      stop();
      reload.mockRestore();
    }
  });

  test("the crash screen's reload asks the server for the page again before reloading", async () => {
    const order: string[] = [];
    const fetched = spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init?: RequestInit) => {
      order.push(`fetch:${init?.cache}`);
      return new Response("");
    }) as unknown as typeof fetch);
    const reload = spyOn(window.location, "reload").mockImplementation(() => {
      order.push("reload");
    });
    try {
      await reloadFresh();
      expect(order).toEqual(["fetch:reload", "reload"]);
    } finally {
      fetched.mockRestore();
      reload.mockRestore();
    }
  });
});
