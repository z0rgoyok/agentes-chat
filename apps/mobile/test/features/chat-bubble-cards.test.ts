import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

test("in bubbles, the cards under someone else's words are bubbles of that message", () => {
  const row = src("features/chat/MessageRow.tsx");
  expect(row).toContain("const bubblePart = bubbled ? { fill: otherFill, edge: bubbleEdge } : null;");
  expect(row).toContain("<RowParts top={partTop} part={bubblePart} head={bubbleHead}>");
  expect(row).toContain("<BubblePartContext.Provider value={part}>");
  // Three points under the bubble, as a run of bubbles; cards of a message with no words start where it does.
  expect(row).toContain("const BUBBLE_JOIN = 3;");
  expect(row).toContain("const partTop = bubbled && (body || media) ? BUBBLE_JOIN - rhythm.part : cardTop;");
  // Every card on the shared surface takes the bubble's fill and no shadow there.
  const parts = src("features/shared/parts.tsx");
  expect(parts).toMatch(/part\s*\?\s*\{ backgroundColor: part\.fill, \.\.\.part\.edge \}/);
  // The ones with their own frame: what it changed, and the work it handed; their corners are every message card's
  // (`useMessageCardCorners`, card-corners.test.ts).
  expect(src("features/chat/Receipts.tsx")).toContain(
    "? [styles.card, { backgroundColor: part.fill, borderWidth: 0 }, cardCorners, part.edge]",
  );
  // The work it handed is a quiet line under the bubble, its mark where the bubble's words start.
  expect(src("features/chat/WorkLine.tsx")).toContain("quietInBubble: { paddingLeft: 14 },");
  expect(src("features/shared/bubble-part.ts")).toContain(
    "export const BUBBLE_PART_CORNERS = corners(RADIUS.sm, RADIUS.xl, RADIUS.xl, RADIUS.sm);",
  );
});

test("a message that is only a request is a bubble of its own: its name at the top, its time at the end", () => {
  const row = src("features/chat/MessageRow.tsx");
  expect(row).toContain("[approvalId, question, secret].filter(Boolean).length === 1;");
  expect(row).toContain("const bubbleHead = askAlone ? { who: who(true), time: when.time(m.createdAt) } : null;");
  expect(row).toContain("{nameLine && !askAlone ? who(false) : null}");
  const asks = src("features/chat/asks.tsx");
  expect(asks).toContain("{bubbleHead ? <View style={styles.bubbleHead}>{bubbleHead.who}</View> : null}");
  expect(asks).toContain("{bubbleHead.time}");
  // A bubble has no sky across its top, and the preview fades into the bubble's own fill.
  expect(asks).toContain(
    '{part ? null : <Sky color={sky} depth={0.55} fade={0.15} surface="raised" style={styles.sky} />}',
  );
  expect(asks).toContain("colors={[withOpacity(fill, 0), fill]}");
});
