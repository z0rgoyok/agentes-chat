import { afterEach, expect, jest, test } from "bun:test";
import type { ApiClient, ClientVitalsReport } from "@agenteschat/client";
import { RETURN_WINDOW_MS } from "@agenteschat/client/lib/vitals";
import { QueryClient } from "@tanstack/react-query";
import { app, resetAppState, to } from "./app-state";

const { countReconnect, markFirstRows, markLaunchedAt, startPerfReports } = await import("../src/lib/perf");

afterEach(() => {
  jest.useRealTimers();
  resetAppState();
});

test("the phone reports as its system; the notification shade is no return to the app, the background is", async () => {
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
  expect(app.listeners.size).toBe(0);
});
