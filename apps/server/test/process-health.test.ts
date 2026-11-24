import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logger";
import { createOperatorApp } from "../src/operator/app";
import { HEAP_SNAPSHOTS_KEPT, watchProcessHealth } from "../src/process-health";
import { takeRouteTimes } from "../src/route-times";
import { createTestServer, type TestServer } from "./harness";

const TOKEN = "operator-test-token-".padEnd(48, "x");
const MB = 1024 * 1024;

let t: TestServer;
beforeAll(async () => {
  t = await createTestServer({ env: { OPERATOR_API_TOKEN: TOKEN } });
});
afterAll(async () => {
  await t.close();
});

test("a process writes its vitals for GET /vitals, and one heap snapshot once its heap passes the mark", async () => {
  let heapUsed = 100 * MB;
  const written: string[] = [];
  const umasks: number[] = [];
  const health = watchProcessHealth(
    {
      db: t.db,
      log: createLogger("error"),
      role: "worker",
      version: "test",
      eventLoopLag: () => ({ p50Ms: 1, p99Ms: 12.5, maxMs: 40, at: new Date().toISOString() }),
      clientVitals: () => ({ ios: { reports: 3, coldStartMs: { n: 3, p50: 1200, p95: 2100, max: 2100 } } }),
      heapSnapshotMb: 200,
      heapSnapshotDir: "/data/heap",
      memoryUsage: () => ({ rss: 300 * MB, heapUsed, heapTotal: 400 * MB, external: 0, arrayBuffers: 0 }),
      writeSnapshot: (path) => {
        written.push(path);
        umasks.push(process.umask());
        return path;
      },
      routeTimes: () => [{ route: "GET /api/app/me", count: 3, p95Ms: 40, maxMs: 41, totalMs: 90 }],
    },
    60_000,
  );
  try {
    await health.tick();
    expect(written).toEqual([]);
    heapUsed = 250 * MB;
    await health.tick();
    await health.tick();
    expect(written).toHaveLength(1);
    expect(written[0]).toStartWith("/data/heap/heap-worker-");
    // Written readable by the server's user alone; the umask is the process's own again after.
    expect(umasks).toEqual([0o077]);
    expect(process.umask()).not.toBe(0o077);

    const app = createOperatorApp({ db: t.db, config: t.config, version: "test", log: createLogger("error") }, TOKEN);
    const res = await app.request("/api/operator/v1/vitals", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const vitals = (await res.json()) as {
      processes: Record<string, unknown>[];
      runClaims: Record<string, unknown>;
    };
    expect(vitals.processes.find((p) => p.id === health.id)).toMatchObject({
      role: "worker",
      rssBytes: 300 * MB,
      heapUsedBytes: 250 * MB,
      eventLoopP99Ms: 12.5,
      heapSnapshot: { file: written[0]?.slice("/data/heap/".length) },
      routes: [{ route: "GET /api/app/me", count: 3, p95Ms: 40, maxMs: 41, totalMs: 90 }],
      // What the apps that reported to it over the minute measured.
      clientVitals: { ios: { reports: 3, coldStartMs: { n: 3, p50: 1200, p95: 2100, max: 2100 } } },
    });
    expect(vitals.runClaims).toMatchObject({ windowSeconds: 300, queued: 0 });
  } finally {
    health.stop();
  }
});

test("no snapshot while the folder already holds HEAP_SNAPSHOTS_KEPT: restarts of a leaking process don't fill the disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heap-kept-"));
  for (let i = 0; i < HEAP_SNAPSHOTS_KEPT; i++) writeFileSync(join(dir, `heap-all-${i}.heapsnapshot`), "{}");
  const written: string[] = [];
  const health = watchProcessHealth(
    {
      db: t.db,
      log: createLogger("error"),
      role: "all",
      version: "test",
      eventLoopLag: () => null,
      heapSnapshotMb: 200,
      heapSnapshotDir: dir,
      memoryUsage: () => ({ rss: 300 * MB, heapUsed: 250 * MB, heapTotal: 400 * MB, external: 0, arrayBuffers: 0 }),
      writeSnapshot: (path) => {
        written.push(path);
        return path;
      },
    },
    60_000,
  );
  try {
    await health.tick();
    expect(written).toEqual([]);
  } finally {
    health.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each API route's requests are timed by the route they matched, and taken once a tick", async () => {
  takeRouteTimes();
  for (let i = 0; i < 3; i++) await t.app.request("/api/app/me");
  await t.app.request("/api/health");
  const taken = takeRouteTimes();
  expect(taken.find((r) => r.route === "GET /api/app/me")).toMatchObject({ count: 3 });
  expect(taken.find((r) => r.route === "GET /api/health")).toMatchObject({ count: 1 });
  expect(taken.every((r) => r.p95Ms <= r.maxMs && r.maxMs <= r.totalMs)).toBe(true);
  // Taken: the next tick starts afresh.
  expect(takeRouteTimes()).toEqual([]);
});
