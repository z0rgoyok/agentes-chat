import type { ApiClient, ClientVitalsReport } from "@agenteschat/client";
import type { QueryClient } from "@tanstack/react-query";
import { AppState, type AppStateStatus, Platform } from "react-native";

/**
 * How fast this app runs where people use it, reported to its server (`POST /api/app/client-vitals`, summed up into
 * the operator's `GET /vitals`, nobody's id): the cold start to the splash leaving and to the first rows, how late the
 * JavaScript thread ran, the heap, the reads after each return to the app, and the socket's reconnects.
 */

/** How often the stall probe asks the JavaScript thread for a turn: how late each turn comes is the thread's lag. */
export const LAG_PROBE_MS = 250;
/** Lags kept between two reports, the newest. */
const LAGS_KEPT = 1200;
/** The reads a return to the app counts: those asked within this long of it. */
export const RETURN_WINDOW_MS = 10_000;
/** The first report waits this long after the launch for the first rows, then goes without them. */
export const FIRST_ROWS_WAIT_MS = 15_000;

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

const marks: { launched: number | null; firstRows: number | null; reported: boolean } = {
  launched: null,
  firstRows: null,
  // One cold start, however many places the app opens since.
  reported: false,
};
let lags: number[] = [];
let reads = 0;
let reconnects = 0;

/** The launch splash left: the app is in use. */
export function markLaunchedAt(now = perf.now()) {
  marks.launched ??= Math.round(now - startedAt());
}

/** The first list with rows is on screen. */
export function markFirstRows(now = perf.now()) {
  marks.firstRows ??= Math.round(now - startedAt());
}

/** The realtime socket came back. */
export const countReconnect = () => {
  reconnects++;
};

/** `values`' 95th percentile and worst, rounded; nothing for none. */
export function lagStats(values: readonly number[]): Pick<ClientVitalsReport, "jsLagP95Ms" | "jsLagMaxMs"> {
  if (values.length === 0) return {};
  const sorted = [...values].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] as number;
  return { jsLagP95Ms: Math.round(p95), jsLagMaxMs: Math.round(sorted[sorted.length - 1] as number) };
}

/** What every report carries: the lags since the last one, the heap now, the reconnects since the last one. */
function shared(): Omit<ClientVitalsReport, "platform"> {
  const heap = perf.memory?.usedJSHeapSize;
  const out = { ...lagStats(lags), ...(typeof heap === "number" && heap > 0 ? { heapBytes: Math.round(heap) } : {}) };
  lags = [];
  const counted = reconnects;
  reconnects = 0;
  return counted > 0 ? { ...out, reconnects: counted } : out;
}

/**
 * Starts measuring for this place's API and cache: the stall probe while the app is in front, the reads after each
 * return from the background, a first report once the app is in use, and one after each return. Returns the stop.
 */
export function startPerfReports(api: ApiClient, queryClient: QueryClient): () => void {
  const platform: ClientVitalsReport["platform"] = Platform.OS === "ios" ? "ios" : "android";
  // An older server has no such route: its 404 is dropped like any other failure.
  const send = (report: Omit<ClientVitalsReport, "platform">) =>
    void api.system.reportVitals?.({ platform, ...report }).catch(() => undefined);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  // A query's fetch is a read: the screens' GETs.
  const offReads = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "fetch") reads++;
  });

  let probe: ReturnType<typeof setInterval> | null = null;
  const probing = (on: boolean) => {
    if (on === (probe !== null)) return;
    if (!on) {
      if (probe) clearInterval(probe);
      probe = null;
      return;
    }
    let due = perf.now() + LAG_PROBE_MS;
    probe = setInterval(() => {
      const now = perf.now();
      lags.push(Math.max(0, now - due));
      if (lags.length > LAGS_KEPT) lags.shift();
      due = now + LAG_PROBE_MS;
    }, LAG_PROBE_MS);
  };
  probing(AppState.currentState === "active");

  // The first report: once the app is in use and its first rows are drawn, or a while after with what there is.
  const firstReport = () => {
    if (marks.reported) return;
    marks.reported = true;
    send({
      coldStartMs: marks.launched ?? undefined,
      ...(marks.firstRows !== null ? { firstRowsMs: marks.firstRows } : {}),
      ...shared(),
    });
  };
  const waitForRows = () => {
    if (marks.reported) return;
    const launched = marks.launched !== null;
    if (launched && (marks.firstRows !== null || perf.now() - startedAt() > FIRST_ROWS_WAIT_MS)) firstReport();
    else later(waitForRows, 1000);
  };
  waitForRows();

  let last = AppState.currentState as AppStateStatus;
  const sub = AppState.addEventListener("change", (state) => {
    probing(state === "active");
    if (state === "active" && last === "background") {
      const before = reads;
      later(() => send({ getsPerReturn: reads - before, ...shared() }), RETURN_WINDOW_MS);
    }
    if (state === "active" || state === "background") last = state;
  });

  return () => {
    sub.remove();
    offReads();
    probing(false);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
