import { expect, test } from "bun:test";
import { catalogModelOf, isKnownModel } from "../src/catalog";

/*
 * `catalogModelOf` cuts a closing `[…]` by index instead of `/\[[^\]]*\]$/`, which backtracks on a long run of `[`
 * (the name may come from a computer). The cut must be the pattern's on every name.
 */

/** What the pattern did. */
const byPattern = (model: string) => {
  const base = model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
  return base && isKnownModel(base) ? base : null;
};

test("a closing [...] is cut as the pattern cut it, on every short mix of brackets", () => {
  const letters = ["[", "]", "x"];
  const suffixes = [""];
  for (let length = 1; length <= 6; length++) {
    for (const s of suffixes.filter((x) => x.length === length - 1)) for (const c of letters) suffixes.push(s + c);
  }
  for (const prefix of ["claude-opus-5-5", "gemini-4-neon", "claude-opus-5-5-20261001", ""]) {
    for (const suffix of suffixes) {
      const model = prefix + suffix;
      expect([model, catalogModelOf(model)]).toEqual([model, byPattern(model)]);
    }
  }
  expect(catalogModelOf("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
  expect(catalogModelOf(null)).toBeNull();
});

test("a long run of [ is read at once", () => {
  const started = performance.now();
  expect(catalogModelOf(`[${"[".repeat(100_000)}`)).toBeNull();
  expect(catalogModelOf(`claude-opus-5-5${"[".repeat(100_000)}]`)).toBe("claude-opus-5-5");
  expect(performance.now() - started).toBeLessThan(500);
});
