import { expect, test } from "bun:test";
import { inPhase, phaseTeller } from "../src/brains/phase";

const told = () => {
  const out: (string | null)[] = [];
  return { out, tell: phaseTeller((p) => out.push(p), { afterMs: 30, minMs: 40 }) };
};

test("a quick step says nothing: the bar keeps its line", async () => {
  const { out, tell } = told();
  await inPhase({ phase: tell }, "code", Bun.sleep(5));
  await Bun.sleep(80);
  expect(out).toEqual([]);
});

test("a long step goes out once it ran a while, and its end stays off until the line showed long enough", async () => {
  const { out, tell } = told();
  const done = inPhase({ phase: tell }, "code", Bun.sleep(45));
  await Bun.sleep(35);
  expect(out).toEqual(["code"]);
  await done;
  // Over at ~45 ms, shown at ~30: its end waits until ~70.
  expect(out).toEqual(["code"]);
  await Bun.sleep(40);
  expect(out).toEqual(["code", null]);
});

test("a step's end goes out even when its work failed, and the failure stays the caller's", async () => {
  const { out, tell } = told();
  await expect(
    inPhase(
      { phase: tell },
      "code",
      Bun.sleep(40).then(() => Promise.reject(new Error("offline"))),
    ),
  ).rejects.toThrow("offline");
  await Bun.sleep(60);
  expect(out).toEqual(["code", null]);
});

test("no way to tell (an older engine's io): the work runs the same", async () => {
  expect(await inPhase({}, "code", Promise.resolve(7))).toBe(7);
});

test("the same step again while its end is held keeps the line, and its own end still goes out", async () => {
  const { out, tell } = told();
  await inPhase({ phase: tell }, "code", Bun.sleep(35));
  // Ended at ~35 ms, its end held until ~70: the next turn's update starts at once and is quick.
  await inPhase({ phase: tell }, "code", Promise.resolve());
  await Bun.sleep(80);
  expect(out).toEqual(["code", null]);
});
