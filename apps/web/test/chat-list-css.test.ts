import { expect, test } from "bun:test";
import { builtCss, declarations, rules } from "./built-css";

test("what ships never lets the chat list shrink what it holds", async () => {
  const css = await builtCss("src/styles.css", "src/components/threads/threads.css");
  // The conversation scrolls a column taller than its box. Its rows and the thread context keep their own heights.
  expect(declarations(css, ".channel__messages > *")).toContainEqual(["flex-shrink", "0"]);
  // No rule gives a row or the context block a flex of its own (`flex` sets flex-shrink too).
  const flexed = rules(css)
    .filter((r) => r.declarations.some(([p]) => p === "flex" || p === "flex-shrink"))
    .flatMap((r) => r.selectors.filter((s) => /\.(ac-msg(--[\w-]+)?|thread-context)(?![\w-])[^ >+~]*$/.test(s)));
  expect(flexed).toEqual([]);
});

test("the shipped conversation CSS keeps offscreen message rows laid out", async () => {
  const css = await builtCss("src/styles.css");
  // A change to an offscreen row with deferred layout can crash Chromium's accessibility tree.
  const deferred = rules(css)
    .filter((r) => r.declarations.some(([p, v]) => p === "content-visibility" && v === "auto"))
    .flatMap((r) => r.selectors.filter((s) => /\.channel__messages\b|\.ac-msg\b/.test(s)));
  expect(deferred).toEqual([]);
});
