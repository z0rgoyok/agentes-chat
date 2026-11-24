import { afterAll, beforeAll, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { insertMessage, liveProcesses, recordProcessVitals, runClaimWaits } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
beforeAll(async () => {
  f = await setup();
});
afterAll(async () => {
  await f.close();
});

const now = new Date("2026-03-01T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

async function run(createdAt: Date, startedAt: Date | null, background = false) {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "hi",
  });
  await f.db.insert(schema.agentRuns).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
    trigger: "mention",
    hop: 1,
    status: startedAt ? "done" : "queued",
    background,
    createdAt,
    startedAt,
  });
}

test("run claims count each claimed run's wait and each waiting run's wait so far; older ones are left out", async () => {
  expect(await runClaimWaits(f.db, now)).toMatchObject({ runs: 0, queued: 0, p95Ms: null, oldestQueuedMs: null });
  // Claimed in the window: waited 1 s and 3 s.
  await run(ago(61_000), ago(60_000));
  await run(ago(63_000), ago(60_000));
  // Still waiting, for 10 minutes now: a stall shows before anything is claimed.
  await run(ago(600_000), null);
  // Claimed before the window, and a run left waiting since yesterday: neither is today's load.
  await run(ago(3_600_000), ago(3_000_000));
  await run(ago(86_400_000), null);
  // A routine's background run waits behind people's by design: not a stall.
  await run(ago(1_800_000), null, true);
  const claims = await runClaimWaits(f.db, now);
  expect(claims).toMatchObject({ windowSeconds: 300, runs: 3, queued: 1, p50Ms: 3000, oldestQueuedMs: 600_000 });
  expect(claims.p95Ms).toBeGreaterThan(500_000);
});

test("each process keeps one row, updated in place; a process silent a day is pruned, one silent minutes isn't listed", async () => {
  const vitals = (id: string, seenAt: Date, rssBytes: number) => ({
    id,
    role: "all",
    version: "test",
    startedAt: ago(3_600_000),
    seenAt,
    rssBytes,
    heapUsedBytes: 1,
    heapTotalBytes: 2,
  });
  const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await recordProcessVitals(f.db, vitals(a, ago(2 * 86_400_000), 1), ago(2 * 86_400_000));
  await recordProcessVitals(f.db, vitals(b, ago(10 * 60_000), 1), now);
  await recordProcessVitals(f.db, vitals(c, ago(60_000), 1), now);
  await recordProcessVitals(f.db, vitals(c, now, 5_000_000_000), now);
  const rows = await f.db.select({ id: schema.serverProcesses.id }).from(schema.serverProcesses);
  expect(rows.map((r) => r.id).sort()).toEqual([b, c].sort());
  const live = await liveProcesses(f.db, now);
  expect(live.map((p) => [p.id, p.rssBytes])).toEqual([[c, 5_000_000_000]]);
});
