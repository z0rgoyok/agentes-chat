import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP_TEXT_SCALE,
  CHROME_MAX_SCALE,
  capsMiddle,
  countBadge,
  initialText,
  leadBox,
  readingMiddle,
  scaleMetrics,
  type TypeStyle,
  typeScale,
  typeStyle,
  weights,
} from "../src/ui/type-scale";

const STYLES: TypeStyle[] = [
  "largeTitle",
  "title1",
  "title2",
  "title3",
  "headline",
  "body",
  "callout",
  "subhead",
  "footnote",
  "caption",
  "caption2",
];

describe("native type scale", () => {
  test("iOS follows the HIG text styles at the default Dynamic Type size", () => {
    const ios = typeScale("ios");
    const sizes = Object.fromEntries(STYLES.map((s) => [s, [ios[s].fontSize, ios[s].lineHeight]]));
    expect(sizes).toEqual({
      largeTitle: [34, 41],
      title1: [28, 34],
      title2: [22, 28],
      title3: [20, 25],
      headline: [17, 22],
      body: [17, 22],
      callout: [16, 21],
      subhead: [15, 20],
      footnote: [13, 18],
      caption: [12, 16],
      caption2: [11, 13],
    });
    expect(ios.headline.fontWeight).toBe(weights.semibold);
    expect(ios.body.fontWeight).toBe(weights.regular);
  });

  test("Android follows Material 3: body 16/24, title medium", () => {
    const android = typeScale("android");
    expect(android.body).toEqual({ fontSize: 16, lineHeight: 24, fontWeight: weights.regular });
    expect(android.subhead).toEqual({ fontSize: 14, lineHeight: 20, fontWeight: weights.regular });
    expect(android.headline.fontWeight).toBe(weights.medium);
  });

  test("every style leaves room for its glyphs and steps down in size", () => {
    for (const os of ["ios", "android"] as const) {
      const scale = typeScale(os);
      for (const s of STYLES) expect(scale[s].lineHeight).toBeGreaterThanOrEqual(scale[s].fontSize);
      const order: TypeStyle[] = [
        "largeTitle",
        "title1",
        "title2",
        "title3",
        "body",
        "callout",
        "subhead",
        "caption",
        "caption2",
      ];
      for (let i = 1; i < order.length; i++)
        expect(scale[order[i] as TypeStyle].fontSize).toBeLessThanOrEqual(scale[order[i - 1] as TypeStyle].fontSize);
    }
  });

  test("a weight override keeps the size (labels: footnote semibold)", () => {
    expect(typeStyle("ios", "footnote", weights.semibold)).toEqual({
      fontSize: 13,
      lineHeight: 18,
      fontWeight: weights.semibold,
    });
    expect(typeStyle("ios", "footnote")).toBe(typeScale("ios").footnote);
  });

  test("dense chrome grows, but less than body text", () => {
    expect(CHROME_MAX_SCALE).toBeGreaterThan(1);
    expect(CHROME_MAX_SCALE).toBeLessThanOrEqual(1.5);
  });
});

test("an icon beside text centers a hair under the line's middle, where the small letters are", () => {
  // The list preview (15.5/21): 10.5 is the line's middle; the eye reads the letters ~1.2 pt lower.
  expect(readingMiddle(15.5, 21)).toBeCloseTo(11.74, 2);
  expect(readingMiddle(17, 22)).toBeGreaterThan(11);
  expect(readingMiddle(17, 22)).toBeLessThan(13);
});

test("a line's lead, an icon or a maker's mark in its place, centers on the first line where the eye reads it", () => {
  // The computer setup sheet's lines (small: 15/20 on iOS), with a 16 pt icon or the 14 pt Claude mark.
  const line = { height: 20, middle: readingMiddle(15, 20) };
  for (const size of [14, 16]) {
    const box = leadBox(line, size);
    expect(box.paddingTop + size / 2).toBeCloseTo(line.middle, 6);
    expect(box.height).toBe(20);
  }
  // Taller than the line: from its top, the box as tall as the lead.
  expect(leadBox(line, 28)).toEqual({ paddingTop: 0, height: 28 });
});

test("a mark beside words (an orbit, the waiting mark) centres on the capitals, the line's middle, not lower", () => {
  // The work line (small: 15/20) with its 12 pt orbit: on the capitals it starts 4 pt down; where the eye reads the
  // small letters it sat 1.2 pt lower, and the words read higher than it.
  const line = { height: 20, middle: capsMiddle(20) };
  const box = leadBox(line, 12);
  expect(box.paddingTop + 12 / 2).toBe(10);
  expect(box).toEqual({ paddingTop: 4, height: 20 });
  expect(readingMiddle(15, 20) - capsMiddle(20)).toBeCloseTo(1.2, 6);
  // A task's state under a task's screen's head (footnote 13/18) with its 16 pt mark box.
  expect(leadBox({ height: 18, middle: capsMiddle(18) }, 16)).toEqual({ paddingTop: 1, height: 18 });
  // Every orbit led by a `LineIcon` is a mark, whatever wraps it inside (a step's cross-fade), and a `Note`'s own mark
  // (the work under way) too.
  const src = (f: string) => readFileSync(join(import.meta.dir, "../src", f), "utf8");
  expect(src("ui/LineIcon.tsx")).toContain("leadBox(mark ? { ...line, middle: capsMiddle(line.height) } : line, size)");
  const unmarked = /<LineIcon(?![^>]*\bmark\b)[^>]*[^/]>((?:(?!<\/LineIcon>)[\s\S])*)<\/LineIcon>/g;
  for (const f of [
    "features/chat/ConsultationScreen.tsx",
    "features/chat/WorkLine.tsx",
    "features/auth/AskWaiting.tsx",
    "features/auth/AuthFlow.tsx",
    "features/issues/IssueScreen.tsx",
    "features/task-manager/parts.tsx",
    "features/missions/MissionScreen.tsx",
    "features/computer/Cover.tsx",
  ])
    for (const [, inside] of src(f).matchAll(unmarked)) expect(inside).not.toMatch(/<(PixelOrbit|TaskMark|WaitMark)\b/);
  expect(src("features/ai/parts.tsx")).toContain('<LineIcon variant="small" size={15} mark>');
  // An event's own mark (the waiting square, the stop square) is a pixel mark; the cover's orbit leads its words'
  // first line, where a long name wraps them.
  expect(src("ui/EventPill.tsx")).toMatch(/<LineIcon size=\{MARK\} variant="small" mark>\s*\{mark\}/);
  expect(src("features/computer/Cover.tsx")).toMatch(/<LineIcon variant="subhead" size=\{16\} mark>\s*<PixelOrbit/);
  expect(src("features/computer/Cover.tsx")).toContain('row: { flexDirection: "row", alignItems: "flex-start"');
});

describe("count badge", () => {
  test("the number's line is the pill's height, centred both ways, Android's font padding off, even sides", () => {
    for (const size of [10, 12, 14]) {
      const { box, text } = countBadge(size);
      expect(text.lineHeight).toBe(box.minHeight);
      expect(box.minWidth).toBe(box.minHeight);
      expect([box.alignItems, box.justifyContent, text.textAlign, text.textAlignVertical]).toEqual([
        "center",
        "center",
        "center",
        "center",
      ]);
      expect(text.includeFontPadding).toBe(false);
      expect(box).not.toHaveProperty("paddingLeft");
      expect(box).not.toHaveProperty("paddingTop");
    }
  });

  test("a face's initial is one line the tile's height, centred both ways, as a count sits in its pill", () => {
    for (const size of [24, 32, 40]) {
      const text = initialText(size);
      expect(text).toEqual({
        fontSize: size * 0.42,
        lineHeight: size,
        includeFontPadding: false,
        textAlign: "center",
        textAlignVertical: "center",
      });
    }
    // A tile whose letter keeps its own size (a maker without a mark, a voter) is centred the same way.
    expect(initialText(30, 13)).toMatchObject({ fontSize: 13, lineHeight: 30, includeFontPadding: false });
  });

  test("every tile with an initial on the phone draws it that way", () => {
    const src = (path: string) => readFileSync(join(import.meta.dir, "../src", path), "utf8");
    expect(src("agent/PersonAvatar.tsx")).toContain("...initialText(size)");
    expect(src("ui/ProviderLogo.tsx")).toContain("...initialText(box, INITIAL_SIZE[size])");
    // A vote's voters are their faces (the photo, else PersonAvatar's initial), never a letter of the poll's own.
    const poll = src("features/blocks/PollCard.tsx");
    expect(poll).toContain('<Face who={{ type: "person", id: v }} size={20} />');
    expect(poll).not.toContain(".slice(0, 1)");
  });
});

describe("the person's text size, for the whole app", () => {
  test("each step is about 2 points on the 17 body, the default unchanged", () => {
    const body = typeScale("ios").body;
    const sizes = (["xs", "sm", "md", "lg", "xl"] as const).map(
      (step) => scaleMetrics(body.fontSize, body.lineHeight, APP_TEXT_SCALE[step]).fontSize,
    );
    expect(sizes).toEqual([13, 15, 17, 19, 21]);
    expect(scaleMetrics(15, 20, APP_TEXT_SCALE.md)).toEqual({ fontSize: 15, lineHeight: 20 });
  });

  test("a style keeps its own line ratio, in whole points", () => {
    expect(scaleMetrics(17, 22, APP_TEXT_SCALE.lg)).toEqual({ fontSize: 19, lineHeight: 25 });
    expect(scaleMetrics(13, 18, APP_TEXT_SCALE.xl)).toEqual({ fontSize: 16, lineHeight: 22 });
  });

  test("Text grows its variant, never a size set on purpose, and a cap bounds both together", () => {
    const src = (path: string) => readFileSync(join(import.meta.dir, "../src", path), "utf8");
    const text = src("ui/Text.tsx");
    expect(text).toContain("const fixed = own?.fontSize != null || (cap != null && cap > 0 && cap <= 1);");
    expect(text).toContain("Math.max(1, cap / k)");
    expect(src("providers/AppProviders.tsx")).toContain("<TextScaleProvider size={textSizeOf(org?.chatPrefs)}>");
  });
});
