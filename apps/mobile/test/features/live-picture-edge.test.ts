import { describe, expect, test } from "bun:test";

const read = (path: string) => Bun.file(new URL(`../../src/${path}`, import.meta.url).pathname).text();
/** A `StyleSheet.create` entry's declarations, as written. */
const style = (source: string, name: string) => source.match(new RegExp(`\\n  ${name}: \\{([^}]*)\\}`))?.[1] ?? "";
const HAIRLINE = "borderWidth: StyleSheet.hairlineWidth";
/** `a` comes before `b` in the source, both present. */
const before = (source: string, a: string, b: string) => {
  const i = source.indexOf(a);
  const j = source.indexOf(b, i + 1);
  return i >= 0 && j > i;
};

describe("the live picture's edge on the phone", () => {
  test("one kit piece draws the hairline over the picture's own edge, at the clipping box's radius", async () => {
    const [edge, kit] = await Promise.all([read("ui/PictureEdge.tsx"), read("ui/index.ts")]);
    expect(kit).toContain('export { PictureEdge } from "./PictureEdge";');
    expect(edge).toContain('pointerEvents="none"');
    expect(edge).toContain("StyleSheet.absoluteFill");
    expect(style(edge, "edge")).toContain(HAIRLINE);
    // The line is translucent: it lies on the box's fill, so a white picture under it doesn't wash it out.
    expect(before(edge, "{ borderColor: colors.sunken }", "{ borderColor: colors.line }")).toBe(true);
  });

  test("a cover that fills the picture's box is clipped by it: no corners of its own to show the screen past", async () => {
    const cover = await read("features/computer/Cover.tsx");
    expect(style(cover, "cover")).not.toContain("borderRadius");
    expect(style(cover, "stage")).toContain("borderRadius: 20");
    expect(cover).toContain("fill ? StyleSheet.absoluteFill : styles.stage,");
  });

  test("the open card's page and the help peek: the picture fills the box, the line lies over its edge", async () => {
    const [card, handoff, parts] = await Promise.all([
      read("features/browser/BrowserCard.tsx"),
      read("features/browser/HandoffCard.tsx"),
      read("features/browser/parts.tsx"),
    ]);
    // The conversation's page has no thumbnail any more: it is always in view, in the agent's frame, which clips it.
    expect(card).not.toContain("styles.thumb");
    expect(style(card, "framePage")).not.toContain("borderWidth");
    expect(style(card, "framePage")).not.toContain("borderRadius");
    expect(style(card, "page")).not.toContain("borderWidth");
    expect(card).not.toMatch(/styles\.page,\s*\{ borderColor/);
    expect(card).toContain("edge={styles.page.borderRadius}");
    expect(style(handoff, "peek")).not.toContain("borderWidth");
    expect(style(handoff, "peek")).toContain("borderRadius: 12");
    expect(handoff).toContain("<View style={[styles.peek, { backgroundColor: c.sunken }]}>");
    expect(handoff).toContain("edge={styles.peek.borderRadius}");
    // The picture's own view draws it: over the picture, under the agent's pointer and the touch hint.
    const LINE = "{edge === undefined ? null : <PictureEdge radius={edge} />}";
    expect(parts).toContain(LINE);
    expect(before(parts, "source={{ uri: browserFrameDataUrl(frame)", LINE)).toBe(true);
    expect(before(parts, LINE, "<AgentPointer {...cursor}")).toBe(true);
  });

  test("the card's whole screen: the picture fills the box at the screen's ratio, the line over it", async () => {
    const [watch, card] = await Promise.all([
      read("features/computer/ScreenWatch.tsx"),
      read("features/browser/BrowserCard.tsx"),
    ]);
    expect(style(watch, "box")).not.toContain("borderWidth");
    expect(watch).not.toContain("borderColor");
    expect(watch).not.toContain("EDGE");
    // The room the screen scales to is the box itself: no line in its layout takes from it.
    expect(watch).toContain("const { width, height } = e.nativeEvent.layout;");
    expect(style(watch, "frame")).toContain('backgroundColor: "#101010"');
    expect(watch).toContain("<PictureEdge radius={radius} />");
    expect(before(watch, "<ScreenPage", "<PictureEdge radius={radius} />")).toBe(true);
    expect(before(watch, "<PictureEdge radius={radius} />", "<DesktopAgentPointer")).toBe(true);
    expect(watch).toContain("{ backgroundColor: c.sunken, borderRadius: radius }");
    // In the conversation's frame the inner box rounds and clips it: the screen has no corners of its own.
    expect(card).toContain("radius={0}");
    expect(style(card, "screenRoom")).not.toContain("borderRadius");
  });

  test("the computer's own view: the line while the screen is the rounded box, under the pointer and the covers", async () => {
    const screen = await read("features/computer/AgentScreen.tsx");
    const LINE = "{inControl || wide ? null : <PictureEdge radius={styles.box.borderRadius} />}";
    expect(screen).toContain(LINE);
    expect(style(screen, "box")).toContain("borderRadius: 20");
    expect(style(screen, "boxWide")).toContain("borderRadius: 0");
    expect(before(screen, "<ScreenPage", LINE)).toBe(true);
    expect(before(screen, LINE, "<DesktopAgentPointer")).toBe(true);
  });
});
