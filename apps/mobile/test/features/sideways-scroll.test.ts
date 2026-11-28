import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("a message's sideways scrollers never grow downward", () => {
  test("a table's scroller and its unseen copy, and a code card's, take no height they aren't given", () => {
    // React Native's scroll view takes `flexGrow: 1`: inside a message it grew into the row's height on every layout,
    // an empty block under the words that never ended.
    const spans = src("features/chat/MessageSpans.tsx");
    expect(spans).toContain("sideways: { flexGrow: 0 },");
    expect(spans).toMatch(
      /<ScrollView horizontal scrollEnabled=\{false\} showsHorizontalScrollIndicator=\{false\} style=\{styles\.sideways\}>/,
    );
    // In a message (not the full screen's, which fills it), the table's own scroller.
    expect(spans).toMatch(/<TableScroller\s+horizontal\s+style=\{full \? styles\.fill : styles\.sideways\}/);
    const code = src("features/chat/CodeCard.tsx");
    expect(code).toContain("sideways: { flexGrow: 0 },");
    expect(code).toMatch(
      /<ScrollView\s+horizontal\s+showsHorizontalScrollIndicator=\{false\}\s+style=\{styles\.sideways\}\s+contentContainerStyle=\{styles\.body\}/,
    );
  });
});
