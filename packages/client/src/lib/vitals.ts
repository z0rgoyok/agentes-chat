import type { QueryClient } from "@tanstack/react-query";
import type { ApiClient } from "../api/client";
import type { ClientVitalsReport } from "../api/types";

/**
 * How fast an app runs where people use it, reported to its server (`POST /api/app/client-vitals`, summed up into the
 * operator's `GET /vitals` and the usage report, nobody's id): the cold start to its first screen and to its first
 * rows, how late the JavaScript thread ran, the heap, the reads after each return to the app, and the socket's
 * reconnects. Each app says what only it knows (`VitalsHost`): the phone its `AppState`, the web its page's visibility.
 */

/** How often the stall probe asks the JavaScript thread for a turn: how late each turn comes is the thread's lag. */
export const LAG_PROBE_MS = 250;
/** Lags kept between two reports, the newest. */
const LAGS_KEPT = 1200;
/**
 * A turn later than this is the computer asleep or the process suspended (some systems' clocks count through sleep),
 * not the thread busy: it counts no lag. It stays far under the longest lag the server takes (10 min).
 */
export const SUSPENDED_MS = 60_000;
/** The reads a return to the app counts: those asked within this long of it. */
export const RETURN_WINDOW_MS = 10_000;
/** The first report waits this long after the launch for the first rows, then goes without them. */
export const FIRST_ROWS_WAIT_MS = 15_000;

/** In use; in between (a phone's notification shade: no return); away (hidden, in the background). */
export type AppPresence = "front" | "between" | "away";

export interface VitalsHost {
  platform: ClientVitalsReport["platform"];
  /** Milliseconds on one steady clock. */
  now(): number;
  /** The app's start on that clock; null when this opening can't be timed (a page loaded while hidden). */
  startedAt(): number | null;
  heapBytes(): number | null | undefined;
  presence(): AppPresence;
  onPresence(listener: (presence: AppPresence) => void): () => void;
  /** What only this app measures, asked before each report: its keys replace the report's, `undefined` drops one. */
  own?(): Promise<Partial<ClientVitalsReport>>;
}

/** `values`' 95th percentile and worst, rounded; nothing for none. */
export function lagStats(values: readonly number[]): Pick<ClientVitalsReport, "jsLagP95Ms" | "jsLagMaxMs"> {
  if (values.length === 0) return {};
  const sorted = [...values].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] as number;
  return { jsLagP95Ms: Math.round(p95), jsLagMaxMs: Math.round(sorted[sorted.length - 1] as number) };
}

/** One app's measures: its marks, made where they happen, and `start`, which reports them for a place's API and cache. */
export function createVitals(host: VitalsHost) {
  const marks: { launched: boolean; coldStart: number | null; firstRows: number | null; reported: boolean } = {
    launched: false,
    coldStart: null,
    firstRows: null,
    // One cold start, however many places the app opens since.
    reported: false,
  };
  let lags: number[] = [];
  let reads = 0;
  let reconnects = 0;
  const sinceStart = (now: number) => {
    const start = host.startedAt();
    return start === null ? null : Math.round(now - start);
  };

  /** What every report carries: the lags since the last one, the heap now, the reconnects since the last one. */
  const shared = (): Omit<ClientVitalsReport, "platform"> => {
    const heap = host.heapBytes();
    const out = { ...lagStats(lags), ...(typeof heap === "number" && heap > 0 ? { heapBytes: Math.round(heap) } : {}) };
    lags = [];
    const counted = reconnects;
    reconnects = 0;
    return counted > 0 ? { ...out, reconnects: counted } : out;
  };

  /**
   * Starts measuring for this place's API and cache: the stall probe while the app is in front, the reads after each
   * return from the background, a first report once the app is in use, and one after each return. Returns the stop.
   */
  const start = (api: ApiClient, queryClient: QueryClient): (() => void) => {
    // An older server has no such route: its 404 is dropped like any other failure.
    const post = (report: Omit<ClientVitalsReport, "platform">) =>
      void api.system.reportVitals?.({ platform: host.platform, ...report }).catch(() => undefined);
    const send = (report: Omit<ClientVitalsReport, "platform">) => {
      if (!host.own) return post(report);
      void host
        .own()
        .catch(() => ({}))
        .then((own) => post({ ...report, ...own }));
    };
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
      let due = host.now() + LAG_PROBE_MS;
      probe = setInterval(() => {
        const now = host.now();
        if (now - due <= SUSPENDED_MS) {
          lags.push(Math.max(0, now - due));
          if (lags.length > LAGS_KEPT) lags.shift();
        }
        due = now + LAG_PROBE_MS;
      }, LAG_PROBE_MS);
    };
    probing(host.presence() === "front");

    // The first report: once the app is in use and its first rows are drawn, or a while after with what there is.
    const firstReport = () => {
      if (marks.reported) return;
      marks.reported = true;
      send({
        ...(marks.coldStart !== null ? { coldStartMs: marks.coldStart } : {}),
        ...(marks.firstRows !== null ? { firstRowsMs: marks.firstRows } : {}),
        ...shared(),
      });
    };
    // A page loaded hidden launches (paints) only once it shows: until then no timer goes round while it is away.
    let waiting = false;
    const waitForRows = () => {
      waiting = false;
      if (marks.reported || (!marks.launched && host.presence() === "away")) return;
      const waited = host.now() - (host.startedAt() ?? 0) > FIRST_ROWS_WAIT_MS;
      if (marks.launched && (marks.firstRows !== null || waited)) firstReport();
      else {
        waiting = true;
        later(waitForRows, 1000);
      }
    };
    waitForRows();

    let last: AppPresence = host.presence();
    const offPresence = host.onPresence((presence) => {
      probing(presence === "front");
      if (presence !== "away" && !waiting) waitForRows();
      if (presence === "front" && last === "away") {
        const before = reads;
        later(() => send({ getsPerReturn: reads - before, ...shared() }), RETURN_WINDOW_MS);
      }
      if (presence !== "between") last = presence;
    });

    return () => {
      offPresence();
      offReads();
      probing(false);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  };

  return {
    /** The app is in use: its launch screen left, or its first screen painted. */
    markLaunchedAt(now = host.now()) {
      if (marks.launched) return;
      marks.launched = true;
      marks.coldStart = sinceStart(now);
    },
    /** The first list with rows is on screen. */
    markFirstRows(now = host.now()) {
      marks.firstRows ??= sinceStart(now);
    },
    /** The realtime socket came back. */
    countReconnect() {
      reconnects++;
    },
    start,
  };
}
