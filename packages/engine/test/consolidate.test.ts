import { describe, expect, test } from "bun:test";
import { CONSOLIDATE_SPREAD_MS, consolidateRunAt, duplicatePairs, SAME_ITEM_SIMILARITY, similarity } from "../src";

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

  test("daily consolidation jobs spread over the window, the same offset for a workspace every day", () => {
    const tick = new Date("2026-03-02T00:00:00Z");
    const offsets = Array.from({ length: 200 }, (_, i) => {
      const orgId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const at = consolidateRunAt(orgId, tick).getTime() - tick.getTime();
      expect(consolidateRunAt(orgId, new Date(tick.getTime() + 86_400_000)).getTime() - tick.getTime()).toBe(
        at + 86_400_000,
      );
      return at;
    });
    expect(Math.min(...offsets)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...offsets)).toBeLessThan(CONSOLIDATE_SPREAD_MS);
    expect(Math.min(...offsets)).toBeLessThan(CONSOLIDATE_SPREAD_MS / 10);
    expect(Math.max(...offsets)).toBeGreaterThan(CONSOLIDATE_SPREAD_MS * 0.9);
  });
});
