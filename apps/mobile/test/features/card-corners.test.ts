import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUBBLE_PART_CORNERS, MESSAGE_CARD_CORNERS } from "../../src/features/shared/bubble-part";
import { corners, insetCorners, RADIUS } from "../../src/ui/radius";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

test("the phone's corner scale is the design system's", () => {
  const tokens = readFileSync(join(import.meta.dir, "../../../../packages/ui/src/styles/tokens.css"), "utf8");
  const web = (name: string) => Number(tokens.match(new RegExp(`--radius-${name}: (\\d+)px;`))?.[1]);
  for (const [name, value] of Object.entries(RADIUS)) expect([name, value]).toEqual([name, web(name)]);
});

test("a shape names its four corners: a corner named earlier never wins over it", () => {
  // React Native draws a corner's own radius over `borderRadius`: a card whose base named its corners (14) kept them
  // under a later `borderRadius: 18`, and stood under the bubble with smaller corners than it.
  for (const shape of [MESSAGE_CARD_CORNERS, BUBBLE_PART_CORNERS]) {
    expect(Object.keys(shape).sort()).toEqual([
      "borderBottomLeftRadius",
      "borderBottomRightRadius",
      "borderTopLeftRadius",
      "borderTopRightRadius",
    ]);
    expect("borderRadius" in shape).toBe(false);
  }
  // The bubbles' 18 and the cards' cut corner; in bubbles the top left joins what is above, as a run's bubbles do.
  expect(MESSAGE_CARD_CORNERS).toEqual(corners(18, 18, 18, 6));
  expect(BUBBLE_PART_CORNERS).toEqual(corners(6, 18, 18, 6));
  // The bubble itself and its runs read the same scale.
  expect(src("features/chat/look.ts")).toMatch(/bubble: \{[^}]*borderRadius: RADIUS\.xl,/);
  expect(src("features/chat/MessageRow.tsx")).toContain("const BUBBLE_CUT = RADIUS.sm;");
  expect(src("features/chat/MessageRow.tsx")).toContain(
    "mid: { borderTopLeftRadius: RADIUS.sm, borderBottomLeftRadius: RADIUS.sm },",
  );
  // What sits inside one, concentric, never quite square.
  expect(insetCorners(BUBBLE_PART_CORNERS, 5)).toEqual(corners(1, 13, 13, 1));
});

test("every card in a message takes the message card's corners, last over its own", () => {
  const look = src("features/chat/look.ts");
  expect(look).toContain("return part ? BUBBLE_PART_CORNERS : inBody ? MESSAGE_CARD_CORNERS : null;");
  const cards = [
    "features/chat/Receipts.tsx",
    "features/chat/asks.tsx",
    "features/chat/ToolCalls.tsx",
    "features/chat/TeamChecks.tsx",
    "features/chat/ReachLines.tsx",
    "features/chat/FeedbackOffer.tsx",
    "features/chat/ChatMedia.tsx",
    "features/chat/issue-work.tsx",
    "features/right-hand/TeamWeekCard.tsx",
    "features/browser/TrailCard.tsx",
    "features/browser/HandoffCard.tsx",
    "features/files/MessageFiles.tsx",
    "features/files/ImageStack.tsx",
    "features/blocks/PollCard.tsx",
    "features/blocks/ChoicesCard.tsx",
    "features/blocks/LiveBlock.tsx",
    "features/live-files/LiveFileCard.tsx",
    "features/missions/cards.tsx",
  ];
  for (const file of cards) {
    const text = src(file);
    // Its own corners, or the one frame that carries them (`useMessageCardFrame`, chat-bubble-cards.test.ts).
    const shaped =
      text.includes("const cardCorners = useMessageCardCorners();") || text.includes(" = useMessageCardFrame();");
    expect([file, shaped]).toEqual([file, true]);
    // Never the bubble's corners by hand: the hook says which.
    expect([file, text.includes("BUBBLE_PART_CORNERS")]).toEqual([file, false]);
  }
  // The work line under a reply is no card: a quiet line under the bubble, as the conversation's working line.
  expect(src("features/chat/WorkLine.tsx")).toContain(
    "<View style={[styles.quiet, part ? styles.quietInBubble : null, cardTop]}",
  );
});
