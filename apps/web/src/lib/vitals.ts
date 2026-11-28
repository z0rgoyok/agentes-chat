import type { ApiClient } from "@agenteschat/client";
import { type AppPresence, createVitals, type VitalsHost } from "@agenteschat/client/lib/vitals";
import type { QueryClient } from "@tanstack/react-query";
import { type DesktopVitals, desktopPlatform, pageReady, thisMac } from "./desktop";

/**
 * How fast the app runs in this browser, or in the desktop app (`@agenteschat/client/lib/vitals`): from the page's
 * navigation to its first screen painted, how late its JavaScript ran, the heap where the browser says it (Chromium and
 * WebView2; WebKit doesn't), the reads after each return to the tab, and the socket's reconnects. In the desktop app it
 * reports as the app's system, its opening is the app's own (from the app's start to that first screen) and the memory
 * of its web view goes with each report.
 */

/** The server refuses a report with a longer one (apps/server `client-vitals.ts`). */
const OPENING_MAX_MS = 600_000;
const DESKTOP_PLATFORMS = { mac: "macos", windows: "windows", linux: "linux" } as const;

/** This page's side of the measures, read from the window as it is now. */
export function webVitalsHost(): VitalsHost {
  const desktop = desktopPlatform();
  // A desktop window hidden to the tray or minimised can keep its page visible (WebView2 is never told, as `sight`
  // says, packages/ui/src/sight.ts): there a window without focus is in between, no stall probe and no return counted.
  const presence = (): AppPresence =>
    document.visibilityState === "hidden" ? "away" : !desktop || document.hasFocus() ? "front" : "between";
  // A page loaded hidden (a tab opened in the background) paints only once it shows: that opening isn't timed.
  let timed = document.visibilityState !== "hidden";
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") timed = false;
  });
  return {
    platform: desktop ? DESKTOP_PLATFORMS[desktop] : "web",
    now: () => performance.now(),
    // `performance.now()` counts from the navigation's start.
    startedAt: () => (timed ? 0 : null),
    heapBytes: () => (performance as { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize,
    presence,
    onPresence: (listener) => {
      const changed = () => listener(presence());
      document.addEventListener("visibilitychange", changed);
      window.addEventListener("focus", changed);
      window.addEventListener("blur", changed);
      return () => {
        document.removeEventListener("visibilitychange", changed);
        window.removeEventListener("focus", changed);
        window.removeEventListener("blur", changed);
      };
    },
    ...(desktop && {
      own: async () => {
        // An older app refuses: no opening then, never the page's own (a reload, another server's page).
        const told: DesktopVitals = await thisMac.vitals().catch(() => ({}));
        const opening = told.coldStartMs;
        return {
          coldStartMs: typeof opening === "number" && opening <= OPENING_MAX_MS ? opening : undefined,
          ...(typeof told.webviewBytes === "number" ? { webviewBytes: told.webviewBytes } : {}),
        };
      },
    }),
  };
}

/** This page's, made at the boot (`startVitals`): nothing touches the page before. */
let vitals: ReturnType<typeof createVitals> | null = null;

/** The page's reports to its server, from the boot on; returns the stop. */
export function startVitals(api: ApiClient, queryClient: QueryClient) {
  vitals ??= createVitals(webVitalsHost());
  return vitals.start(api, queryClient);
}

/** The realtime socket came back. */
export const countReconnect = () => vitals?.countReconnect();

/**
 * The first screen is on the glass (two frames after it rendered: a first screen's mount effect): the opening ends,
 * and in the desktop app the cover over its window goes (`pageReady`).
 */
export function firstScreenPainted() {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      vitals?.markLaunchedAt();
      pageReady();
    }),
  );
}
