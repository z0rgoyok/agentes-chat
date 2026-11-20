import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TITLE_GONE, titleSnap } from "../src/ui/title-snap";

const src = (path: string) => readFileSync(join(import.meta.dir, "../src", path), "utf8");

describe("large titles settle", () => {
  test("a scroll that stops with the title half faded goes on to the nearer of whole and gone", () => {
    expect(TITLE_GONE).toBe(40);
    expect(titleSnap(10, 500)).toBe(0);
    expect(titleSnap(19, 500)).toBe(0);
    expect(titleSnap(21, 500)).toBe(TITLE_GONE);
    expect(titleSnap(39, 500)).toBe(TITLE_GONE);
    // At rest, gone, past it, or pulled down: it stays.
    for (const at of [0, 0.4, 39.6, 40, 120, -30]) expect({ at, to: titleSnap(at, 500) }).toEqual({ at, to: null });
    // A list too short to fold the title away rests where it ends.
    expect(titleSnap(25, 30)).toBeNull();
  });

  test("the tabs' and the pushed screens' large titles share the head, the fade and the settling", () => {
    const head = src("ui/LargeTitleHead.tsx");
    expect(head).toContain("const to = titleSnap(contentOffset.y + rest, end);");
    expect(head).toContain("if (to !== null) ref.current?.scrollTo({ y: to - rest, animated: true });");
    // A release that won't glide settles at once; one that glides settles when it stops.
    expect(head).toContain("if (target && Math.abs(target.y - e.nativeEvent.contentOffset.y) < 1) settle(e);");
    expect(head).toContain("return { y, onScroll, ref, onScrollEndDrag, onMomentumScrollEnd: settle };");
    for (const file of ["ui/LargeTitleScreen.tsx", "features/shared/PushedLargeTitle.tsx"]) {
      const screen = src(file);
      for (const piece of [
        "useLargeTitleScroll(",
        "{ snap: !collapsed }",
        "<LargeTitleHead y=",
        "ref={scroll.ref}",
        "onScrollEndDrag={scroll.onScrollEndDrag}",
        "onMomentumScrollEnd={scroll.onMomentumScrollEnd}",
      ])
        expect({ file, piece, there: screen.includes(piece) }).toEqual({ file, piece, there: true });
      // No numbers of their own, and not the scroll view's snapToOffsets (it stops a fling at its last offset).
      expect({ file, own: /const (TITLE_GONE|BAR_TITLE_FROM|BAR_TITLE_TO) =/.test(screen) }).toEqual({
        file,
        own: false,
      });
      expect({ file, native: screen.includes("snapToOffsets") }).toEqual({ file, native: false });
    }
  });

  test("on iOS the tab roots take the system's large title, set up as the pushed screens'; art behind keeps it drawn", () => {
    const tabs = src("ui/LargeTitleScreen.tsx");
    expect(tabs).toContain(
      "return IOS && !props.drawnTitle ? <SystemTitleScreen {...props} /> : <DrawnTitleScreen {...props} />;",
    );
    const system = tabs.slice(tabs.indexOf("function SystemTitleScreen("), tabs.indexOf("function DrawnTitleScreen("));
    // The system's bar over the tab stacks' clear one (under it the large title stayed expanded over the list).
    expect(system).toContain("const bar = useScrollUnderPushedOptions();");
    expect(system).toMatch(/\.\.\.actionOptions,\s*\.\.\.bar,/);
    expect(system).toContain("headerLargeTitleEnabled: !collapsed,");
    // The scroll view is the screen's first view, insets left to the system; the system's wheel on a pull.
    expect(system).toMatch(
      /<LivePause paused=\{!focused\}>\s*<ScrollView\s+contentInsetAdjustmentBehavior="automatic"/,
    );
    expect(system).not.toContain("<View style={[styles.screen");
    expect(system).toContain("<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />");
    expect(system).not.toContain("PullOrbit");
    // Drawn: the orbit in place of the hidden wheel.
    const drawn = tabs.slice(tabs.indexOf("function DrawnTitleScreen("));
    expect(drawn).toContain("tintColor={PULL_TINT}");
    expect(drawn).toContain("<PullOrbit refreshing={pull.refreshing} />");
    // Only Conversas, its sky behind the bar, draws it; every tab root hands its pull over.
    expect(src("features/chats/ChatsScreen.tsx")).toContain("      drawnTitle\n");
    for (const file of [
      "features/chats/ChatsScreen.tsx",
      "features/agents/AgentsScreen.tsx",
      "features/activity/ActivityScreen.tsx",
      "features/chats/ThreadsScreen.tsx",
    ]) {
      const screen = src(file);
      expect({ file, pull: screen.includes("pull={pull}"), orbit: screen.includes("PullOrbit") }).toEqual({
        file,
        pull: true,
        orbit: false,
      });
    }
    for (const file of ["features/agents/AgentsScreen.tsx", "features/activity/ActivityScreen.tsx"])
      expect({ file, drawn: src(file).includes("drawnTitle") }).toEqual({ file, drawn: false });
  });

  test("the title's coming and going is built once, on the theme's motion, never while rendering", () => {
    const head = src("ui/LargeTitleHead.tsx");
    expect(head).toContain("const TITLE_IN = FadeIn.duration(motion.base).easing(motion.easeOut);");
    expect(head).toContain("const TITLE_OUT = FadeOutUp.duration(motion.fast).easing(motion.easeOut);");
    for (const file of ["ui/LargeTitleScreen.tsx", "ui/LargeTitleHead.tsx", "features/shared/PushedLargeTitle.tsx"])
      expect({ file, inRender: /(entering|exiting|layout)=\{[^}]*\.duration\(/.test(src(file)) }).toEqual({
        file,
        inRender: false,
      });
  });
});
