import { afterEach, expect, test } from "bun:test";
import { claimSweep, onceOnDatabase, recordProcessVitals, workerLive } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const HOUR = 3600_000;

test("a one-off runs once per database: never again once done, again after a failure or when it had nothing to do", async () => {
  const fx = await setup();
  f = fx;
  let runs = 0;
  const backfill = async () => {
    runs++;
  };
  expect(await onceOnDatabase(fx.db, "backfill", backfill)).toBe(true);
  expect(await onceOnDatabase(fx.db, "backfill", backfill)).toBe(false);
  expect(runs).toBe(1);

  const failing = onceOnDatabase(fx.db, "flaky", async () => {
    throw new Error("the database was away");
  });
  await expect(failing).rejects.toThrow("the database was away");
  expect(await onceOnDatabase(fx.db, "flaky", backfill)).toBe(true);

  // Contacts aren't synced on this server yet: nothing done, so a later start that has them does it.
  expect(await onceOnDatabase(fx.db, "contacts", async () => false)).toBe(false);
  expect(await onceOnDatabase(fx.db, "contacts", backfill)).toBe(true);
  expect(runs).toBe(3);
});

test("a sweep's turn goes to one process at a time, and comes back once its gap passed", async () => {
  const fx = await setup();
  f = fx;
  const now = new Date("2026-03-01T12:00:00Z");
  const at = (ms: number) => new Date(now.getTime() + ms);
  const turns = await Promise.all([1, 2, 3].map(() => claimSweep(fx.db, "daily", 23 * HOUR, now)));
  expect(turns.filter(Boolean)).toHaveLength(1);
  expect(await claimSweep(fx.db, "daily", 23 * HOUR, at(22 * HOUR))).toBe(false);
  expect(await claimSweep(fx.db, "other", 23 * HOUR, at(22 * HOUR))).toBe(true);
  expect(await claimSweep(fx.db, "daily", 23 * HOUR, at(23 * HOUR + 1))).toBe(true);
  expect(await claimSweep(fx.db, "daily", 23 * HOUR, at(24 * HOUR))).toBe(false);
});

test("a worker is live while it writes its vitals; an app process, or a worker silent for minutes, isn't one", async () => {
  const fx = await setup();
  f = fx;
  const now = new Date("2026-03-01T12:00:00Z");
  const vitals = (role: string, seenAt: Date) => ({
    id: crypto.randomUUID(),
    role,
    version: "test",
    startedAt: new Date(now.getTime() - HOUR),
    seenAt,
    rssBytes: 1,
    heapUsedBytes: 1,
    heapTotalBytes: 2,
  });
  expect(await workerLive(fx.db, now)).toBe(false);
  await recordProcessVitals(fx.db, vitals("all", now), now);
  await recordProcessVitals(fx.db, vitals("worker", new Date(now.getTime() - 10 * 60_000)), now);
  expect(await workerLive(fx.db, now)).toBe(false);
  await recordProcessVitals(fx.db, vitals("worker", new Date(now.getTime() - 60_000)), now);
  expect(await workerLive(fx.db, now)).toBe(true);
});
