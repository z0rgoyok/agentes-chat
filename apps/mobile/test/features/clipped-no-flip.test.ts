import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clippedHeight, LONG_MESSAGE } from "@agenteschat/client/lib/message-length";
import { INLINE_HEIGHT } from "../../src/features/blocks/logic";
import { keptHeightAfter, PAST_RULE } from "../../src/features/chat/kept-sizes";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

/** One layout of the words: folded when the kept height cuts them (`ClippedMessage`'s `shows`), or before a measure. */
function layout(kept: number, measures: { folded: number; whole: number }) {
  const folded = kept === 0 || clippedHeight(kept) !== null;
  const next = keptHeightAfter(kept, folded ? measures.folded : measures.whole, folded);
  return next ?? kept;
}

/**
 * A long paragraph in `ClippedMessage`, as React Native lays it out: a text reads no taller than the room its box
 * gives it, so under a cap it measures the cap. `past`: how far past the rule the cap before the first measure stands.
 * Gives the height the row draws at on each layout.
 */
function paragraphLayouts(whole: number, past: number, layouts = 6): number[] {
  let kept = 0;
  const drawn: number[] = [];
  for (let i = 0; i < layouts; i++) {
    const shows = clippedHeight(kept);
    const unmeasured = kept === 0;
    const room = shows ?? (unmeasured ? LONG_MESSAGE.over + past : Number.POSITIVE_INFINITY);
    const measured = Math.min(whole, room);
    drawn.push(measured);
    kept = keptHeightAfter(kept, measured, shows !== null || unmeasured) ?? kept;
  }
  return drawn;
}

/**
 * A live block with one long text part (`SpecBlock`): its parts' box has 20 points of padding, the text reads no taller
 * than the room left, cut at the card's height, capped a point past it before the first measure. Gives the heights the
 * block draws at.
 */
function blockLayouts(text: number, keep: (kept: number, measured: number, capped: boolean) => number, layouts = 8) {
  const PAD = 20;
  let kept = 0;
  const drawn: number[] = [];
  for (let i = 0; i < layouts; i++) {
    const tall = kept > INLINE_HEIGHT;
    const capped = tall || kept === 0;
    const room = tall ? INLINE_HEIGHT : kept === 0 ? INLINE_HEIGHT + PAST_RULE : Number.POSITIVE_INFINITY;
    const measured = Math.min(text, room - PAD) + PAD;
    drawn.push(tall ? INLINE_HEIGHT : measured);
    kept = keep(kept, measured, capped);
  }
  return drawn;
}

describe("a long message near the rule never flips between folded and whole", () => {
  test("measured just under the rule when folded and just over it whole, it stays folded", () => {
    // The fold changes the room around the words: just under the rule folded, just over it whole.
    const measures = { folded: LONG_MESSAGE.over - 5, whole: LONG_MESSAGE.over + 10 };
    let kept = 0;
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      kept = layout(kept, measures);
      seen.push(kept);
    }
    expect(seen.slice(1).every((h) => h === measures.whole)).toBe(true);
    expect(clippedHeight(kept)).not.toBeNull();
  });

  test("whole, a measure is the truth; folded, it only raises the height", () => {
    expect(keptHeightAfter(530, 515, true)).toBeNull();
    expect(keptHeightAfter(530, 560, true)).toBe(560);
    expect(keptHeightAfter(530, 515, false)).toBe(515);
    expect(keptHeightAfter(0, 400, true)).toBe(400);
    expect(keptHeightAfter(400, 400, false)).toBeNull();
    expect(keptHeightAfter(400, Number.NaN, false)).toBeNull();
  });

  test("the row keeps what the rule decides", () => {
    const clip = src("features/chat/ClippedMessage.tsx");
    expect(clip).toContain("const folded = shows !== null || unmeasured;");
    expect(clip).toContain("const next = keptHeightAfter(height, e.nativeEvent.layout.height, folded);");
  });
});

describe("a long paragraph is cut from its first measure, never drawn whole on the way", () => {
  test("under a cap a point past the rule, it reads over the rule and folds once", () => {
    const drawn = paragraphLayouts(LONG_MESSAGE.over * 2, PAST_RULE);
    expect(PAST_RULE).toBeGreaterThan(0);
    expect(Math.max(...drawn)).toBe(LONG_MESSAGE.over + PAST_RULE);
    expect(drawn.slice(1).every((h) => h === LONG_MESSAGE.shows)).toBe(true);
  });

  test("a cap exactly at the rule read 'not over it': the row drew whole for a layout before folding", () => {
    // Why the cap stands past the rule: the paragraph measured exactly the rule and showed whole next.
    expect(paragraphLayouts(LONG_MESSAGE.over * 2, 0)).toContain(LONG_MESSAGE.over * 2);
  });

  test("words that fit show whole from their first layout", () => {
    expect(new Set(paragraphLayouts(400, PAST_RULE))).toEqual(new Set([400]));
  });

  test("the message's cap stands past the rule", () => {
    expect(src("features/chat/ClippedMessage.tsx")).toContain(
      'unmeasured: { maxHeight: LONG_MESSAGE.over + PAST_RULE, overflow: "hidden" },',
    );
  });
});

describe("a live block with one long text never flips between cut and whole", () => {
  test("cut, a measure only raises what is kept: it stays cut", () => {
    const drawn = blockLayouts(900, (kept, measured, capped) => keptHeightAfter(kept, measured, capped) ?? kept);
    expect(drawn.slice(1).every((h) => h === INLINE_HEIGHT)).toBe(true);
  });

  test("kept as measured, it flipped on every layout", () => {
    const drawn = blockLayouts(900, (_kept, measured) => measured);
    expect(drawn.slice(2)).toContain(900 + 20);
    expect(drawn.slice(2)).toContain(INLINE_HEIGHT);
  });

  test("the block keeps what the rule decides, its cap past the card and no cap once opened", () => {
    const spec = src("features/blocks/SpecBlock.tsx");
    expect(spec).toContain("const capped = !screen && !open && (tall || height === 0);");
    expect(spec).toContain("<View style={capped ? (tall ? styles.cut : styles.unmeasured) : undefined}>");
    expect(spec).toContain(
      "const next = keptHeightAfter(height, Math.ceil(e.nativeEvent.layout.height), capped, INLINE_HEIGHT);",
    );
    expect(spec).toContain('cut: { height: INLINE_HEIGHT, overflow: "hidden" },');
    expect(spec).toContain('unmeasured: { maxHeight: INLINE_HEIGHT + PAST_RULE, overflow: "hidden" },');
  });
});

describe("a long text folded on a card offers the rest", () => {
  test("its fold stands past its rule, so a long paragraph reads long and gets Ver mais", () => {
    const folded = src("features/chat/FoldedBody.tsx");
    expect(folded).toContain("const long = height > FOLDED;");
    expect(folded).toContain('folded: { maxHeight: FOLDED + PAST_RULE, overflow: "hidden" },');
  });
});
