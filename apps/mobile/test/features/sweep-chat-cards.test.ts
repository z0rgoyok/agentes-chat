import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// No renderer for the phone's components in these tests: what only the source can say is read from it.
const src = (file: string) => readFileSync(join(import.meta.dir, "../../src/features", file), "utf8");
/** A function's body, from its name to the next top-level function. */
const fn = (text: string, name: string) => {
  const start = text.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\nfunction ", start + 1);
  return text.slice(start, end < 0 ? undefined : end);
};
/** A style's one-line body. */
const style = (text: string, name: string) => text.match(new RegExp(`\\n  ${name}: \\{([^}]*)\\}`))?.[1] ?? "";

describe("the request card's motion", () => {
  const asks = src("chat/asks.tsx");

  test("its height never animates: the list sizes the row, what changes fades in where it stands", () => {
    expect(asks).not.toContain("LinearTransition");
    expect(asks).not.toMatch(/\blayout=\{/);
    // What the card holds when it mounts again just shows; what opens or ends later fades.
    expect(asks).toContain("<LayoutAnimationConfig skipEntering>");
    expect(asks).toContain("entering={reduced ? undefined : PART_IN}");
  });

  test("in a conversation no card or pill fades in on its own (rows mount again as they scroll back)", () => {
    const entrance = fn(asks, "useEntrance");
    expect(entrance).toContain("const inConversation = useAskStore() !== null;");
    expect(entrance).toContain("return reduced || inConversation ? undefined : entering;");
    expect(fn(asks, "AskCard")).toContain("const entering = useEntrance(CARD_IN);");
    expect(fn(asks, "AskNote")).toContain("const entering = useEntrance(CARD_IN);");
    expect(fn(asks, "AskDone")).toContain("const entering = useEntrance(PILL_IN);");
    expect(fn(asks, "AskWaiting")).toContain("const entering = useEntrance(PILL_IN);");
  });

  test("the line above the composer: its words reach 44 points in the 28-point pill", () => {
    expect(asks).toContain("const BAR_SLOP = { top: 8, bottom: 8 };");
    expect(asks.match(/hitSlop=\{BAR_SLOP\}/g)).toHaveLength(2);
  });
});

describe("the tools block", () => {
  const tools = src("chat/ToolCalls.tsx");

  test("a logo joins from 0.9 with no bounce, the new words rise a few points, both quick", () => {
    expect(tools).not.toContain("ZoomIn");
    expect(tools).not.toContain("springify");
    expect(tools).not.toContain("FadeInDown");
    expect(tools).toContain("initialValues: { opacity: 0, transform: [{ scale: 0.9 }] },");
    expect(tools).toContain("initialValues: { opacity: 0, transform: [{ translateY: 6 }] },");
    expect(tools).toContain("entering={moving ? LOGO_IN : undefined}");
    expect(tools).toContain("entering={moving ? HEAD_IN : undefined}");
  });

  test("the running call's words breathe on the UI thread, held off screen: no render per frame", () => {
    expect(tools).not.toContain("useFrameTime");
    const breathing = fn(tools, "Breathing");
    expect(breathing).toContain("loopStyle(BREATH, BREATH_MS, SINE, breathDelay(startedAt), paused)");
    expect(breathing).toContain("const breathing = on && !reduced;");
  });

  test("a call's row is a finger's 44 and lights a beat late, so a scroll never flashes it", () => {
    expect(style(tools, "why")).toContain("marginTop: 6 - (TOUCH - LOGO) / 2");
    expect(tools).toContain("minHeight: TOUCH,");
    expect(tools).toContain("paddingVertical: (TOUCH - LOGO) / 2,");
    expect(tools.match(/unstable_pressDelay=\{ROW_PRESS_DELAY\}/g)).toHaveLength(2);
  });
});

describe("code and charts in a message", () => {
  test("copy that the system refuses says so; the small toggles reach 44 points; Ver as N linhas is a 44 row", () => {
    const code = src("chat/CodeCard.tsx");
    const copy = fn(code, "CopyButton");
    expect(copy).toMatch(/if \(!ok\) \{\s*toast\(\{ title: t\("mobile\.app\.failed"\), icon: "x" \}\);/);
    expect(code).toContain("hitSlop={RAW_SLOP}");
    expect(code).toContain("const RAW_SLOP = { top: 8, bottom: 8, left: 4, right: 4 };");
    expect(code).toContain("hitSlop={(TOUCH - TOOL_H) / 2}");
    expect(code).toContain("moreIn: { minHeight: TOUCH },");
  });

  test("a bar grows by its clip on the canvas (no width laid out per frame), on the theme's ease-out", () => {
    const chart = src("chat/ChartCard.tsx");
    expect(chart).not.toContain("useAnimatedStyle");
    expect(chart).not.toContain("Easing.out(");
    expect(chart).toContain("const EASE = motion.easeOut;");
    const bar = fn(chart, "Bar");
    expect(bar).toContain(
      "Skia.RRectXY(Skia.XYWHRect(0, 0, Math.max(0, grown.value), height), BAR_RADIUS, BAR_RADIUS)",
    );
    expect(bar).toContain("<Group clip={clip}>");
  });
});

describe("the kit's press, not one of its own", () => {
  test("a question's choices and a thread's link ease down with the kit's press", () => {
    const cards = src("chat/cards.tsx");
    const question = fn(cards, "QuestionCard");
    expect(question).not.toContain("optPressed");
    expect(question.match(/<PressScale/g)?.length).toBeGreaterThanOrEqual(2);
    expect(question).toContain("contentStyle={styles.opt}");
    // The press gives the one haptic: the answer adds none.
    expect(question).not.toContain("tapHaptic()");
    const link = fn(cards, "ThreadLink");
    expect(link).toContain("<PressScale");
    expect(link).toContain("fill={false}");
    expect(link).toContain("hitSlop={{ top: (TOUCH - THREAD_LINK) / 2, bottom: (TOUCH - THREAD_LINK) / 2 }}");
  });

  test("a task's card and a handed task's chip: the kit's press, the cards' padding, a 44 chip whose words shrink", () => {
    const work = src("chat/issue-work.tsx");
    expect(work).not.toContain("Pressable");
    expect(work).not.toMatch(/\n {2}pressed: \{/);
    expect(style(work, "card")).toContain("padding: CARD_PAD");
    expect(work).toContain("minHeight: TOUCH,");
    // A content-sized chip collapses a `flex: 1` title to nothing.
    expect(work).toContain("style={[styles.fit, styles.bold]}");
    expect(style(work, "fit")).toContain("flexShrink: 1, minWidth: 0");
  });
});

describe("the agent's browser steps in a message", () => {
  test("a site that won't open from the steps says so", () => {
    expect(src("browser/TrailCard.tsx")).toContain(
      'void Linking.openURL(href).catch(() => toast({ title: t("mobile.app.failed"), icon: "x" }))',
    );
  });
});

describe("a channel's card from its #name", () => {
  test("its name and Open show at once; what the card adds comes in when it loads, never a spinner", () => {
    const ref = src("chat/ChannelRefText.tsx");
    expect(ref).not.toContain("ActivityIndicator");
    const sheet = fn(ref, "ChannelCardSheet");
    expect(sheet).toContain("title={`#${name}`}");
    expect(sheet).toContain('<Button variant="secondary" wide label={t("channelRefs.open")} onPress={openIt} />');
  });
});
