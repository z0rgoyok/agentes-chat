import { afterEach, expect, jest, mock, test } from "bun:test";
import type { ApiClient, ClientVitalsReport } from "@agenteschat/client";
import { QueryClient } from "@tanstack/react-query";

type Listener = (state: string) => void;
const app = { state: "active", listeners: new Set<Listener>() };
const to = (state: string) => {
  app.state = state;
  for (const l of [...app.listeners]) l(state);
};
mock.module("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    get currentState() {
      return app.state;
    },
    addEventListener: (_event: "change", listener: Listener) => {
      app.listeners.add(listener);
      return { remove: () => app.listeners.delete(listener) };
    },
  },
}));

const { countReconnect, lagStats, markFirstRows, markLaunchedAt, RETURN_WINDOW_MS, startPerfReports } = await import(
  "../src/lib/perf"
);

afterEach(() => {
  jest.useRealTimers();
  app.state = "active";
  app.listeners.clear();
});

test("the JavaScript thread's lag: its 95th percentile and its worst, rounded", () => {
  expect(lagStats([])).toEqual({});
  const lags = [...Array.from({ length: 19 }, (_, i) => i), 480.4];
  expect(lagStats(lags)).toEqual({ jsLagP95Ms: 480, jsLagMaxMs: 480 });
  expect(lagStats([...Array.from({ length: 99 }, () => 2.2), 900])).toEqual({ jsLagP95Ms: 2, jsLagMaxMs: 900 });
});

test("a cold start reports once the app is in use with its rows; each return from the background, its reads", async () => {
  jest.useFakeTimers();
  const sent: ClientVitalsReport[] = [];
  const api = { system: { reportVitals: async (r: ClientVitalsReport) => void sent.push(r) } } as unknown as ApiClient;
  const qc = new QueryClient();
  const stop = startPerfReports(api, qc);
  jest.advanceTimersByTime(3000);
  // Still on the splash: nothing yet.
  expect(sent).toEqual([]);
  markLaunchedAt();
  markFirstRows();
  jest.advanceTimersByTime(1000);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ platform: "ios" });
  expect(sent[0]?.coldStartMs).toBeNumber();
  expect(sent[0]?.firstRowsMs).toBeNumber();

  // The notification shade is no return; the background is: the reads asked within its window are counted.
  to("inactive");
  to("active");
  to("background");
  await qc.fetchQuery({ queryKey: ["before"], queryFn: async () => 0 });
  to("active");
  countReconnect();
  for (const key of ["channels", "dms", "threads"]) await qc.fetchQuery({ queryKey: [key], queryFn: async () => 1 });
  jest.advanceTimersByTime(RETURN_WINDOW_MS);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({ platform: "ios", getsPerReturn: 3, reconnects: 1 });
  stop();
  to("background");
  to("active");
  jest.advanceTimersByTime(RETURN_WINDOW_MS);
  expect(sent).toHaveLength(2);
});
