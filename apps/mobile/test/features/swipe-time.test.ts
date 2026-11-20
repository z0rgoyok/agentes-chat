import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { giveWay, pullOf, rubberband, TIME_REVEAL, timeShown } from "../../src/features/chat/pull";
import { chatScreenSource } from "./chat-screen-source";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8");

describe("a pull to the left shows the times", () => {
  test("the conversation follows the finger one to one up to the times' column, then resists", () => {
    expect(pullOf(-30)).toBe(0);
    expect(pullOf(0)).toBe(0);
    expect(pullOf(40)).toBe(40);
    expect(pullOf(TIME_REVEAL)).toBe(TIME_REVEAL);
    const past = pullOf(TIME_REVEAL + 100);
    expect(past).toBeGreaterThan(TIME_REVEAL);
    expect(past).toBeLessThan(TIME_REVEAL + 100);
    expect(past).toBe(TIME_REVEAL + rubberband(100, TIME_REVEAL));
    // Further keeps going further, ever slower.
    expect(pullOf(TIME_REVEAL + 200)).toBeGreaterThan(past);
    expect(pullOf(TIME_REVEAL + 200) - past).toBeLessThan(past - TIME_REVEAL);
  });

  test("a time comes in from the edge with the pull and is all there at the column's width", () => {
    expect(timeShown(0)).toEqual({ opacity: 0, shift: TIME_REVEAL });
    expect(timeShown(TIME_REVEAL / 2)).toEqual({ opacity: 0.5, shift: TIME_REVEAL / 2 });
    expect(timeShown(TIME_REVEAL)).toEqual({ opacity: 1, shift: 0 });
    // Past it (the rubber band), it stays put; a spring's overshoot under 0 never shows it.
    expect(timeShown(TIME_REVEAL + 30)).toEqual({ opacity: 1, shift: 0 });
    expect(timeShown(-5)).toEqual({ opacity: 0, shift: TIME_REVEAL });
  });

  test("someone else's bubble stays put while the room at its right holds the pull; a wide one gives way for the rest", () => {
    // A short bubble: 200 of 320 taken, the times fit in the room left.
    expect(giveWay(TIME_REVEAL, 320, 200)).toBe(0);
    // As wide as it may be: it goes with the pull, point for point.
    expect(giveWay(TIME_REVEAL, 320, 320)).toBe(TIME_REVEAL);
    // In between: only what the room lacks.
    expect(giveWay(TIME_REVEAL, 320, 300)).toBe(TIME_REVEAL - 20);
    expect(giveWay(10, 320, 300)).toBe(0);
    // Not measured yet (or measured wrong): never less room than none.
    expect(giveWay(TIME_REVEAL, 0, 0)).toBe(TIME_REVEAL);
    expect(giveWay(TIME_REVEAL, 280, 300)).toBe(TIME_REVEAL);
    // Its bubbles end 44 sooner than mine (60 from the edge, mine 16): as wide as it may be, it moves only the rest,
    // to where mine stand.
    expect(giveWay(TIME_REVEAL, 320, 320, 44)).toBe(TIME_REVEAL - 44);
    expect(giveWay(40, 320, 320, 44)).toBe(0);
    const row = src("features/chat/MessageRow.tsx");
    expect(row).toContain("const giveWay = useGiveWay(ROW_BODY_INSET.bubbles.right - BUBBLES_EDGE);");
    expect(row).toContain('me: { paddingLeft: 64, paddingRight: BUBBLES_EDGE, alignItems: "flex-end" },');
  });

  test("bubbles hold no time and no mark: the pull shows them, beside every bubble", () => {
    const row = src("features/chat/MessageRow.tsx");
    expect(row).not.toContain("styles.stamp");
    expect(row).not.toContain("bubbleLine");
    // Mine slides over with the pull; its time and what became of it come in at the edge.
    expect(row).toContain("<SwipeSlide on={bubbled} style={styles.meSlide}>");
    expect(row).toContain("<ReceiptMark message={m} mine receipt={receipt} seenBy={seenBy} />\n        </SwipeTime>");
    // Someone else's has its time there too, and gives way, face and body together, only when too wide.
    expect(row).toMatch(/\{inBubble \|\| compact \? \(\s+<SwipeTime>/);
    expect(row).toContain("<View onLayout={inBubble ? giveWay.onArea : undefined}>");
    expect(row).toContain("onLayout={giveWay.onBubble}");
    expect(row).toContain(
      "<Animated.View style={[styles.body, { gap: rhythm.part }, inBubble && giveWay.style, compact && slide]}>",
    );
    expect(row).toMatch(/styles\.avslot,[\s\S]{0,120}inBubble && giveWay\.style,/);
    // The hook runs before my rows' branch: the same hooks every time.
    expect(row.indexOf("const giveWay = useGiveWay();")).toBeLessThan(row.indexOf("if (onRight) {"));
  });

  test("the pull takes only a leftward drag, and lets go with a spring at the finger's speed", () => {
    const swipe = src("features/chat/swipe-time.tsx");
    expect(swipe).toContain("activeOffsetX: [-20, 1e6],");
    // Right (a reply's swipe) or up and down (the scroll) first: it steps aside.
    expect(swipe).toContain("failOffsetX: [-1e6, 8],");
    expect(swipe).toContain("failOffsetY: [-8, 8],");
    expect(swipe).toContain("withSpring(0, { duration: 400, dampingRatio: 0.9, velocity: -e.velocityX })");
    // Reduce Motion: a short ease, no spring.
    expect(swipe).toContain("withTiming(0, { duration: 150, easing: EASE_OUT })");
    // The times take no touch.
    expect(swipe).toContain('<Animated.View pointerEvents="none" style={[styles.time, shown]}>');
    // On where messages hold no time (bubbles, compact), over the whole list.
    const chat = chatScreenSource();
    expect(chat).toContain("const timePan = useSwipeTimePan(timePull, timesOnPull(rowLook.style), stillRows);");
    expect(chat).toContain("<SwipeTimeFrame pull={timePull} gesture={timePan}>");
    // One rubber band for both sideways pulls.
    expect(src("features/chat/SwipeReply.tsx")).toContain('import { rubberband } from "./pull";');
  });
});
