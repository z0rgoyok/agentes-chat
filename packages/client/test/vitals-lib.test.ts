import { afterEach, expect, jest, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { ApiClient, ClientVitalsReport } from "../src";
import {
  type AppPresence,
  createVitals,
  FIRST_ROWS_WAIT_MS,
  LAG_PROBE_MS,
  lagStats,
  RETURN_WINDOW_MS,
  SUSPENDED_MS,
  type VitalsHost,
} from "../src/lib/vitals";

afterEach(() => {
  jest.useRealTimers();
});

/** An app whose clock, presence and heap the test moves. */
function fakeHost(over: Partial<VitalsHost> = {}) {
  const listeners = new Set<(p: AppPresence) => void>();
  const state = { now: 0, presence: "front" as AppPresence, heap: 52_000_000 as number | undefined };
  const host: VitalsHost = {
    platform: "web",
    now: () => state.now,
    startedAt: () => 0,
    heapBytes: () => state.heap,
    presence: () => state.presence,
    onPresence: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...over,
  };
  const to = (presence: AppPresence) => {
    state.presence = presence;
    for (const l of [...listeners]) l(presence);
  };
  /** Time passes: the clock and the timers. */
  const pass = (ms: number) => {
    state.now += ms;
    jest.advanceTimersByTime(ms);
  };
  return { host, state, to, pass, listeners };
}

/** Promise hops for what goes after `own` answered. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const sink = () => {
  const sent: ClientVitalsReport[] = [];
  const api = { system: { reportVitals: async (r: ClientVitalsReport) => void sent.push(r) } } as unknown as ApiClient;
  return { sent, api };
};

test("the JavaScript thread's lag: its 95th percentile and its worst, rounded", () => {
  expect(lagStats([])).toEqual({});
  const lags = [...Array.from({ length: 19 }, (_, i) => i), 480.4];
  expect(lagStats(lags)).toEqual({ jsLagP95Ms: 480, jsLagMaxMs: 480 });
  expect(lagStats([...Array.from({ length: 99 }, () => 2.2), 900])).toEqual({ jsLagP95Ms: 2, jsLagMaxMs: 900 });
});

test("a cold start reports once the app is in use with its rows; each return from the background, its reads", async () => {
  jest.useFakeTimers();
  const { host, to, pass, listeners } = fakeHost({ platform: "ios" });
  const { sent, api } = sink();
  const vitals = createVitals(host);
  const qc = new QueryClient();
  const stop = vitals.start(api, qc);
  pass(3000);
  // Still on the splash: nothing yet.
  expect(sent).toEqual([]);
  vitals.markLaunchedAt();
  vitals.markFirstRows();
  pass(1000);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ platform: "ios", coldStartMs: 3000, firstRowsMs: 3000, heapBytes: 52_000_000 });
  expect(sent[0]?.jsLagP95Ms).toBeNumber();

  // In between (a phone's notification shade) is no return; away is: the reads asked within its window are counted.
  to("between");
  to("front");
  to("away");
  await qc.fetchQuery({ queryKey: ["before"], queryFn: async () => 0 });
  to("front");
  vitals.countReconnect();
  for (const key of ["channels", "dms", "threads"]) await qc.fetchQuery({ queryKey: [key], queryFn: async () => 1 });
  pass(RETURN_WINDOW_MS);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ platform: "ios", getsPerReturn: 3, reconnects: 1 });
  expect(sent[1]?.coldStartMs).toBeUndefined();
  stop();
  expect(listeners.size).toBe(0);
  to("away");
  to("front");
  pass(RETURN_WINDOW_MS);
  expect(sent).toHaveLength(2);
});

test("the stall probe runs only in front: a late turn is the thread's lag, a hidden stretch none", () => {
  jest.useFakeTimers();
  const { host, state, to, pass } = fakeHost();
  const { sent, api } = sink();
  const vitals = createVitals(host);
  vitals.markLaunchedAt();
  const stop = vitals.start(api, new QueryClient());
  // One turn came 400 ms late: the timer fired on time, the clock says the thread was busy.
  pass(LAG_PROBE_MS);
  state.now += 400;
  pass(LAG_PROBE_MS);
  to("away");
  // Hidden for a minute: a browser holds its timers back there, which is no lag of the app's.
  state.now += 60_000;
  pass(FIRST_ROWS_WAIT_MS);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ jsLagMaxMs: 400 });
  stop();
});

test("a turn far later than any stall is the computer asleep: no lag of the thread's, and the report still goes", () => {
  jest.useFakeTimers();
  const { host, state, pass } = fakeHost();
  const { sent, api } = sink();
  const vitals = createVitals(host);
  vitals.markLaunchedAt();
  const stop = vitals.start(api, new QueryClient());
  pass(LAG_PROBE_MS);
  state.now += 400;
  pass(LAG_PROBE_MS);
  // Asleep for an hour with the app in front: its clock counted the hour, its timers didn't run.
  state.now += 60 * SUSPENDED_MS;
  for (let i = 0; i < 4; i++) pass(LAG_PROBE_MS);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ jsLagMaxMs: 400 });
  stop();
});

test("a page loaded hidden keeps no timer going while away; once it shows and paints, its first report goes", () => {
  jest.useFakeTimers();
  const { host, state, to, pass } = fakeHost({ startedAt: () => null });
  state.presence = "away";
  const { sent, api } = sink();
  const vitals = createVitals(host);
  const stop = vitals.start(api, new QueryClient());
  pass(10 * 60_000);
  expect(jest.getTimerCount()).toBe(0);
  to("front");
  vitals.markLaunchedAt();
  pass(1000);
  expect(sent).toHaveLength(1);
  stop();
});

test("an opening that can't be timed still reports, without its cold start; no heap, none sent", () => {
  jest.useFakeTimers();
  const { host, state, pass } = fakeHost({ startedAt: () => null });
  state.heap = undefined;
  const { sent, api } = sink();
  const vitals = createVitals(host);
  const stop = vitals.start(api, new QueryClient());
  vitals.markLaunchedAt();
  pass(FIRST_ROWS_WAIT_MS + 1000);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.coldStartMs).toBeUndefined();
  expect(sent[0]?.heapBytes).toBeUndefined();
  stop();
});

test("what only the app measures goes with each report and replaces the report's own", async () => {
  jest.useFakeTimers();
  let asked = 0;
  const { host, to, pass } = fakeHost({
    platform: "macos",
    own: async () => {
      asked++;
      // The desktop app's own opening, once; its web view's memory each time.
      return { coldStartMs: asked === 1 ? 4100 : undefined, webviewBytes: 300_000_000 };
    },
  });
  const { sent, api } = sink();
  const vitals = createVitals(host);
  const stop = vitals.start(api, new QueryClient());
  pass(1200);
  vitals.markLaunchedAt();
  pass(FIRST_ROWS_WAIT_MS);
  await settle();
  expect(sent).toEqual([expect.objectContaining({ platform: "macos", coldStartMs: 4100, webviewBytes: 300_000_000 })]);
  to("away");
  to("front");
  pass(RETURN_WINDOW_MS);
  await settle();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ webviewBytes: 300_000_000, getsPerReturn: 0 });
  expect(sent[1]?.coldStartMs).toBeUndefined();
  stop();
});

test("an app with no opening to tell drops the page's own: `undefined` from the app never lets it through", async () => {
  jest.useFakeTimers();
  const { host, pass } = fakeHost({
    platform: "windows",
    own: async () => ({ coldStartMs: undefined, webviewBytes: 1 }),
  });
  const { sent, api } = sink();
  const vitals = createVitals(host);
  const stop = vitals.start(api, new QueryClient());
  pass(1200);
  vitals.markLaunchedAt();
  vitals.markFirstRows();
  pass(1000);
  await settle();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ platform: "windows", firstRowsMs: 1200, webviewBytes: 1 });
  expect(sent[0]?.coldStartMs).toBeUndefined();
  stop();
});
