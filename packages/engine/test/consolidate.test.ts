import { describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { duplicatePairs, enqueueConsolidations, SAME_ITEM_SIMILARITY, similarity } from "../src";
import { dailySlot } from "../src/format";

describe("periodic consolidation", () => {
  test("duplicate pairs match the plain pairwise scan", async () => {
    const vocab = ["deploy", "tuesday", "invoice", "client", "report", "budget", "office", "review", "server", "plan"];
    let seed = 7;
    const pick = () => {
      seed = (seed * 48271) % 2147483647;
      return vocab[seed % vocab.length];
    };
    const texts = Array.from({ length: 200 }, (_, i) =>
      Array.from({ length: 2 + (i % 4) }, pick).join(i % 3 ? " " : ", "),
    );
    const items = texts.map((content, i) => ({ id: `n${i}`, content }));
    const archived = new Set<number>();
    const expected: [string, string][] = [];
    texts.forEach((keep, i) => {
      if (archived.has(i)) return;
      texts.forEach((dup, j) => {
        if (j <= i || archived.has(j) || similarity(keep, dup) < SAME_ITEM_SIMILARITY) return;
        expected.push([`n${i}`, `n${j}`]);
        archived.add(j);
      });
    });
    expect(expected.length).toBeGreaterThan(10);
    expect((await duplicatePairs(items)).map(([a, b]) => [a.id, b.id])).toEqual(expected);
  });

  test("a workspace with thousands of notes finds its duplicates without holding the event loop", async () => {
    const items = Array.from({ length: 1500 }, (_, i) => ({
      id: `n${i}`,
      content:
        i % 6 === 5 ? `NOTE ${i - 5} about topic t${i - 5} w${(i - 5) * 7}!` : `note ${i} about topic t${i} w${i * 7}`,
    }));
    // One loop turn per yield: a scan that never yields leaves this at 0.
    let turns = 0;
    let scanning = true;
    const count = () => {
      if (!scanning) return;
      turns++;
      setImmediate(count);
    };
    setImmediate(count);
    const pairs = await duplicatePairs(items);
    scanning = false;
    expect(pairs.map(([a, b]) => [a.id, b.id])).toEqual(
      items.filter((_, i) => i % 6 === 5).map((dup) => [`n${Number(dup.id.slice(1)) - 5}`, dup.id]),
    );
    expect(turns).toBeGreaterThan(100);
  });

  test("a workspace's daily slot is its own time of day, the next one from now, spread over the whole day", () => {
    const day = 86_400_000;
    const midnight = new Date("2026-03-02T00:00:00Z").getTime();
    const offsets = Array.from({ length: 200 }, (_, i) => {
      const orgId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const { at, day: date } = dailySlot(orgId, new Date(midnight));
      const offset = at.getTime() - midnight;
      expect(date).toBe(at.toISOString().slice(0, 10));
      // The same time every day; once it passed, tomorrow's.
      expect(dailySlot(orgId, new Date(midnight + day)).at.getTime()).toBe(at.getTime() + day);
      expect(dailySlot(orgId, at).at.getTime()).toBe(at.getTime());
      expect(dailySlot(orgId, new Date(at.getTime() + 1)).at.getTime()).toBe(at.getTime() + day);
      return offset;
    });
    expect(Math.min(...offsets)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...offsets)).toBeLessThan(day);
    expect(Math.min(...offsets)).toBeLessThan(day / 10);
    expect(Math.max(...offsets)).toBeGreaterThan(day * 0.9);
  });

  test("each workspace's next consolidation is queued at its slot, in batches, once per day whatever the ticks", async () => {
    const { db, close } = await createTestDatabase();
    try {
      const orgs = await db
        .insert(schema.organizations)
        .values(Array.from({ length: 501 }, (_, i) => ({ name: `Org ${i}` })))
        .returning({ id: schema.organizations.id });
      const now = new Date("2026-03-02T10:00:00Z");
      expect(await enqueueConsolidations(db, now)).toBe(501);
      // Another replica's tick, or the next hour's before any slot passed: nothing new.
      expect(await enqueueConsolidations(db, now)).toBe(0);
      const jobs = await db.select().from(schema.outbox).where(eq(schema.outbox.kind, "context.consolidate"));
      const org = orgs[0]?.id ?? "";
      const slot = dailySlot(org, now);
      expect(jobs.find((j) => j.orgId === org)).toMatchObject({
        dedupeKey: `context.consolidate:${org}:${slot.day}`,
        nextAttemptAt: slot.at,
      });
      // A day later every workspace's next slot is a new day's.
      expect(await enqueueConsolidations(db, new Date(now.getTime() + 86_400_000))).toBe(501);
    } finally {
      await close();
    }
  });
});
