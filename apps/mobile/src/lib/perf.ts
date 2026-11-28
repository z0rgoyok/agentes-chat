import { type AppPresence, createVitals } from "@agenteschat/client/lib/vitals";
import { AppState, Platform } from "react-native";

/**
 * How fast this app runs where people use it (`@agenteschat/client/lib/vitals`): the cold start to the splash leaving
 * and to the first rows, how late the JavaScript thread ran, the heap, the reads after each return to the app, and the
 * socket's reconnects.
 */

type RnPerformance = {
  now(): number;
  rnStartupTiming?: { startTime?: number | null };
  memory?: { usedJSHeapSize?: number | null };
};
const perf = globalThis.performance as unknown as RnPerformance;

/** The app's start: the native one when React Native knows it, else this module's first run (early in the bundle). */
const loadedAt = perf.now();
function startedAt(): number {
  try {
    const native = perf.rnStartupTiming?.startTime;
    return typeof native === "number" && native > 0 && native <= loadedAt ? native : loadedAt;
  } catch {
    return loadedAt;
  }
}

/** The notification shade and the app switcher (`inactive`) are no return: only the background is. */
const presenceOf = (state: string | null | undefined): AppPresence =>
  state === "active" ? "front" : state === "background" ? "away" : "between";

const vitals = createVitals({
  platform: Platform.OS === "ios" ? "ios" : "android",
  now: () => perf.now(),
  startedAt,
  heapBytes: () => perf.memory?.usedJSHeapSize,
  presence: () => presenceOf(AppState.currentState),
  onPresence: (listener) => {
    const sub = AppState.addEventListener("change", (state) => listener(presenceOf(state)));
    return () => sub.remove();
  },
});

/** The launch splash left: the app is in use. */
export const markLaunchedAt = vitals.markLaunchedAt;
/** The first list with rows is on screen. */
export const markFirstRows = vitals.markFirstRows;
/** The realtime socket came back. */
export const countReconnect = vitals.countReconnect;
/** Starts measuring for this place's API and cache; returns the stop. */
export const startPerfReports = vitals.start;
