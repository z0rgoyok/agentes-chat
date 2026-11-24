import { describe, expect, test } from "bun:test";
import { BUBBLE_CAP_SLACK, bubbleCapAfter } from "../../src/features/chat/bubble-cap";

const PAD = 16;

describe("a bubble no taller than what it holds", () => {
  test("a bubble as tall as its content gets no cap", () => {
    expect(bubbleCapAfter(null, 1724, 1708, PAD)).toBeNull();
    // Rounding to the screen's pixels is no reason to cap.
    expect(bubbleCapAfter(null, 1725.33, 1708, PAD)).toBeNull();
  });

  test("a bubble laid out thousands of points taller than its words is capped just over them", () => {
    expect(bubbleCapAfter(null, 12459, 1708, PAD)).toBe(1708 + PAD + BUBBLE_CAP_SLACK);
  });

  test("capped, the same measure keeps the cap: no render loop", () => {
    const cap = bubbleCapAfter(null, 12459, 1708, PAD);
    expect(bubbleCapAfter(cap, cap ?? 0, 1708, PAD)).toBe(cap);
  });

  test("content that reaches its cap may need more room: the cap goes and it is measured again", () => {
    const cap = 1708 + PAD + BUBBLE_CAP_SLACK;
    expect(bubbleCapAfter(cap, cap, 1708 + BUBBLE_CAP_SLACK, PAD)).toBeNull();
    expect(bubbleCapAfter(cap, cap, 2400, PAD)).toBeNull();
  });

  test("content that shrank pulls the cap down with it", () => {
    const cap = 1708 + PAD + BUBBLE_CAP_SLACK;
    expect(bubbleCapAfter(cap, cap, 1000, PAD)).toBe(1000 + PAD + BUBBLE_CAP_SLACK);
  });

  test("before both are measured nothing changes", () => {
    expect(bubbleCapAfter(null, 0, 1708, PAD)).toBeNull();
    expect(bubbleCapAfter(null, 12459, 0, PAD)).toBeNull();
    expect(bubbleCapAfter(500, 0, 0, PAD)).toBe(500);
  });
});
