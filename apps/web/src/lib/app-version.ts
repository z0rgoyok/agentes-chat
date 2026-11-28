/**
 * A tab opened before a deploy keeps running the old app: it reads events the new server sends
 * with old code (another agent's answer shown as the agent's raw words), and crashes already fixed
 * keep coming from it. The page's own bundle (`/assets/index-<hash>.js`) is compared with the one
 * the server's index.html names now; once they differ the app is stale: the next page change loads
 * the new one, and so does the first safe moment (`reloadWhenSafe`).
 */
import { writesInFlight } from "@agenteschat/client";
import { lastInputAt, onSight, recordingVoice, type Sight, sight } from "@agenteschat/ui";
import { STORAGE_KEYS, sessionStore } from "./storage";

/** How often an open tab asks, besides on focus and after the realtime socket reconnects (a deploy). */
export const VERSION_CHECK_MS = 5 * 60_000;

/** The app's module script in a page's HTML, or null (a dev server, an unexpected page). */
export function entryOf(html: string): string | null {
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    if (!/type="module"/.test(tag)) continue;
    const src = /\bsrc="([^"]+)"/.exec(tag)?.[1];
    if (src?.includes("/assets/")) return src;
  }
  return null;
}

/** A `<meta name="…" content="…">`'s content in a page's HTML, or null. */
export function metaOf(html: string, name: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/g) ?? []) {
    if (tag.includes(`name="${name}"`)) return /\bcontent="([^"]*)"/.exec(tag)?.[1] ?? null;
  }
  return null;
}

/** This many new versions seen since the tab opened: it moves at the first short pause, not only when left alone. */
export const URGENT_BEHIND = 3;

export interface VersionWatch {
  check(): Promise<void>;
  readonly stale: boolean;
  /** New versions seen since this page loaded (each deploy restarts the socket, which asks). */
  readonly behind: number;
  /** Too many versions behind, or older than the oldest build the server's index.html still calls good. */
  readonly urgent: boolean;
}

export function createVersionWatch(options: {
  /** The bundle this page runs (null: unknown, never stale). */
  loaded: string | null;
  /** When this page's bundle was built (`agentes-build` in its index.html; null: unknown, never known bad). */
  built?: string | null;
  fetchHtml: () => Promise<string>;
  /** Once, when a new version is first seen. */
  onStale: () => void;
}): VersionWatch {
  let stale = false;
  let behind = 0;
  let bad = false;
  let seen: string | null = null;
  let inFlight: Promise<void> | null = null;
  const built = Date.parse(options.built ?? "");
  return {
    get stale() {
      return stale;
    },
    get behind() {
      return behind;
    },
    get urgent() {
      return bad || behind >= URGENT_BEHIND;
    },
    check() {
      if (!options.loaded) return Promise.resolve();
      inFlight ??= options
        .fetchHtml()
        .then((html) => {
          const current = entryOf(html);
          if (!current || current === options.loaded) return;
          if (current !== seen) {
            seen = current;
            behind++;
          }
          // A build with a fix every open tab must get names the oldest one still good (`agentes-oldest-good`).
          if (Date.parse(metaOf(html, "agentes-oldest-good") ?? "") > built) bad = true;
          if (stale) return;
          stale = true;
          options.onStale();
        })
        // Offline or a deploy in progress: the next check asks again.
        .catch(() => undefined)
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

/** This page's bundle, as index.html named it. */
export function loadedEntry(doc: Document = document): string | null {
  return doc.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src") ?? null;
}

/** When this page's bundle was built, as its index.html says. */
export function loadedBuild(doc: Document = document): string | null {
  return doc.querySelector<HTMLMetaElement>('meta[name="agentes-build"]')?.content ?? null;
}

/** The server's index.html now (revalidated: never the browser's cached copy). */
export async function fetchIndexHtml(): Promise<string> {
  const res = await fetch("/index.html", { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) throw new Error(`index.html: ${res.status}`);
  return res.text();
}

let current: VersionWatch | null = null;

/** The app's watch (main.tsx); `checkAppVersion` asks it from anywhere (the realtime reconnect). */
export function startVersionWatch(watch: VersionWatch) {
  current = watch;
  return watch;
}

export const checkAppVersion = () => current?.check() ?? Promise.resolve();

/** A page's file missing again within this long is a crash, not a deploy. */
const VERSION_RELOAD_MS = 60_000;
let reloading = false;
let stayed: ReturnType<typeof setTimeout> | undefined;
const reloadWatchers = new Set<() => void>();
const setReloading = (now: boolean) => {
  reloading = now;
  for (const watcher of reloadWatchers) watcher();
};

/** True once the app is reloading into a new version: nothing is reported, and the error screen is the boot sky. */
export const reloadingForNewVersion = () => reloading;

/** Calls `watcher` when `reloadingForNewVersion()` changes (`useSyncExternalStore`); returns the unsubscribe. */
export function onVersionReload(watcher: () => void) {
  reloadWatchers.add(watcher);
  return () => void reloadWatchers.delete(watcher);
}

/**
 * A page's code or styles from before a deploy are gone from the server (Vite's `vite:preloadError`): the app
 * reloads into the new version, at most once a minute. True when it reloads.
 */
export function reloadForNewVersion(now = Date.now()): boolean {
  if (now - Number(sessionStore.get(STORAGE_KEYS.versionReload)) < VERSION_RELOAD_MS) return false;
  sessionStore.set(STORAGE_KEYS.versionReload, String(now));
  // Storage that keeps nothing would reload forever.
  if (sessionStore.get(STORAGE_KEYS.versionReload) !== String(now)) return false;
  setReloading(true);
  window.location.reload();
  // Still here a moment later: the reload didn't happen (the person stayed when a page asked before leaving).
  stayed = setTimeout(resetVersionReload, 3000);
  return true;
}

/**
 * A crash in a tab a deploy left behind is most likely its old code meeting the new server's data (a sidebar tool it
 * has no page for): it reloads into the new version, at most once a minute, instead of staying on the error screen.
 * True when it reloads.
 */
export async function reloadIfStale(): Promise<boolean> {
  await checkAppVersion();
  return current?.stale === true && reloadForNewVersion();
}

/** Not reloading: the page stayed, or a test starts. */
export function resetVersionReload() {
  clearTimeout(stayed);
  setReloading(false);
}

/**
 * Loads the newest version past every copy the browser keeps: this address is fetched again from the server first,
 * which replaces the cached page the reload then opens. The service worker (sw.js) has no fetch handler: nothing of
 * it stands between the page and the server.
 */
export async function reloadFresh() {
  try {
    await fetch(window.location.href, { cache: "reload", credentials: "same-origin" });
  } catch {
    // Offline: the reload says so itself.
  }
  window.location.reload();
}

let holds = 0;

/** Something a reload would cut (control of a computer, an import's copy) holds the tab on its version. Returns the release. */
export function holdReload(): () => void {
  holds++;
  let held = true;
  return () => {
    if (held) holds--;
    held = false;
  };
}

const TEXT_FIELD =
  'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="number"], input[type="password"], [contenteditable]:not([contenteditable="false"])';
/** What opens over the page; one left open (a flow halfway, a dialog read) holds the tab. */
const OPEN_DIALOG = '[role="dialog"], [role="alertdialog"], dialog[open]';
const typed = new Set<Element>();

/** Follows the fields the person types in (main.tsx), for `reloadWouldCut`. Returns the stop. */
export function watchTyping(doc: Document = document) {
  const typing = (e: Event) => {
    if (e.target instanceof Element && e.target.matches(TEXT_FIELD)) typed.add(e.target);
  };
  doc.addEventListener("input", typing, true);
  return () => {
    doc.removeEventListener("input", typing, true);
    typed.clear();
  };
}

const textOf = (field: Element) =>
  field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value : (field.textContent ?? "");

/**
 * A reload now would lose something: text the person typed and hasn't sent or cleared (a composer, a dialog's
 * field), an open dialog, a write on its way (a message, an upload), a voice note being recorded, or a hold.
 */
export function reloadWouldCut(doc: Document = document): boolean {
  if (holds > 0 || writesInFlight() > 0 || recordingVoice()) return true;
  for (const layer of doc.querySelectorAll(OPEN_DIALOG)) if (layer.checkVisibility?.() !== false) return true;
  for (const field of typed) {
    if (!field.isConnected) typed.delete(field);
    else if (textOf(field).trim()) return true;
  }
  return false;
}

/** The short pause an urgent move waits for: no key, click, touch, scroll or pointer move for this long. */
export const URGENT_PAUSE_MS = 15_000;

/**
 * A stale tab moves when nothing would be lost, and nobody is using it: out of sight, or no input for a while
 * (`sight`'s idle). An urgent one (`VersionWatch.urgent`) moves at the first short pause too.
 */
export function safeToReload(state: { sight: Sight; pausedMs: number; urgent: boolean; cuts: boolean }): boolean {
  if (state.cuts) return false;
  return state.sight !== "present" || (state.urgent && state.pausedMs >= URGENT_PAUSE_MS);
}

/** How often a stale tab looks for its safe moment, besides each change of who is looking. */
const SAFE_CHECK_MS = 5_000;

/**
 * Once stale, the tab moves to the new version at its first safe moment (`safeToReload`), on the address it is on
 * (the router keeps each page's scroll); until then the notice stays its way. Returns the stop.
 */
export function reloadWhenSafe(watch: VersionWatch, now = () => Date.now()) {
  const attempt = () => {
    const state = { sight: sight(), pausedMs: now() - lastInputAt(), urgent: watch.urgent, cuts: reloadWouldCut() };
    if (watch.stale && safeToReload(state)) reloadForNewVersion(now());
  };
  const timer = setInterval(attempt, SAFE_CHECK_MS);
  const off = onSight(attempt);
  attempt();
  return () => {
    clearInterval(timer);
    off();
  };
}
