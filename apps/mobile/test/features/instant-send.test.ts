import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const row = readFileSync(join(import.meta.dir, "../../src/features/chat/MessageRow.tsx"), "utf8");

describe("a message I send reads as sent at once", () => {
  test("its words are in ink while it goes, never greyed until the server answers", () => {
    expect(row).not.toContain('muted={m.local === "pending"');
    expect(row).toContain("muted={workOver}");
  });

  test("its time is there from the start, under my rows or behind the pull in bubbles, so nothing moves when the server's copy lands", () => {
    // In bubbles a pull to the left shows it (`SwipeTime`), a send in flight's too: never inside the bubble.
    expect(row).toMatch(/const swipeTime =\s+bubbled && m\.local !== "failed" \? \(\s+<SwipeTime>/);
    expect(row).toContain('{m.local !== "failed" && (run === "end" || run === "solo") && !bubbled ? (');
  });

  test('"Sending" only when the server is really slow; offline it still says when it will go', () => {
    expect(row).toContain("const SLOW_SEND_MS = 2000;");
    expect(row).toContain("const timer = setTimeout(() => setSlow(true), SLOW_SEND_MS);");
    expect(row).toContain("if (!offline && !slow) return null;");
  });
});
