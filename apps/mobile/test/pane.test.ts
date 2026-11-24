import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { panePillRoom } from "../src/features/chat/pill-room";
import {
  PANE_BAR_GAP,
  PANE_BAR_HEIGHT,
  PANE_BAR_SIDE,
  PANE_BUTTON,
  PANE_CAPSULE_PAD,
  paneCapsuleWidth,
  paneTitleRoom,
} from "../src/ui/pane-bar";

const src = (path: string) => readFileSync(join(import.meta.dir, "../src", path), "utf8");
/** A function's text, from its signature to the next top-level declaration. */
const body = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  return source.slice(from, source.indexOf(end, from + start.length));
};

describe("a pane's bar (ADR 0212)", () => {
  test("the conversation's 44-point pill fits it; our 40-point buttons sit in a 44-point capsule", () => {
    expect([PANE_BAR_HEIGHT, PANE_BAR_SIDE, PANE_BAR_GAP, PANE_BUTTON, PANE_CAPSULE_PAD]).toEqual([52, 16, 8, 40, 2]);
    expect(paneCapsuleWidth(0, 0)).toBe(0);
    expect(paneCapsuleWidth(1, 0)).toBe(44);
    expect(paneCapsuleWidth(3, 0)).toBe(124);
    // A count beside a mark (an agent's tasks) is first in the capsule, as wide as it measures.
    expect(paneCapsuleWidth(2, 57)).toBe(141);
    expect(paneCapsuleWidth(0, 30)).toBe(34);
  });

  test("the title is centred on the pane, clear of the wider end on both sides, never below zero", () => {
    expect(paneTitleRoom(500, 0)).toBe(452);
    expect(paneTitleRoom(500, 44)).toBe(364);
    expect(paneTitleRoom(100, 60)).toBe(0);
  });

  test("the conversation's pill in a pane: centred, with no back button, clear of its capsule on both sides", () => {
    // "…" alone, the computer and "…", and those with the agent's tasks counted first.
    expect(panePillRoom(480, 0, 0)).toBe(344);
    expect(panePillRoom(480, 1, 0)).toBe(264);
    expect(panePillRoom(480, 1, 57)).toBe(150);
    // A narrow pane with everything in the bar: never below its face and a few letters.
    expect(panePillRoom(360, 1, 57)).toBe(96);
    const pill = src("features/chat/HeaderPill.tsx");
    expect(pill).toContain("const pane = usePane();");
    expect(pill).toMatch(/const room = pane\s*\?\s*panePillRoom\(pane\.width, extraActions, leadRoom\)/);
  });
});

describe("a screen in a pane (ADR 0212)", () => {
  const pane = src("ui/pane.tsx");

  test("the pane tells the screen its bar's height and its width, and mounts it once it knows the width", () => {
    expect(pane).toContain("const barHeight = top + PANE_BAR_HEIGHT;");
    expect(pane).toContain("<HeaderHeightContext.Provider value={barHeight}>");
    expect(pane).toContain("(width > 0 ? { width, below, bar } : null)");
    expect(pane).toMatch(/\{value \? \(\s*<PaneContext\.Provider value=\{value\}>/);
    // What the screen sizes by the window's width it sizes by the pane's inside one.
    expect(body(pane, "export function useContentWidth()", "\n}\n")).toContain("return pane ? pane.width : width;");
    expect(src("features/chat/look.ts")).toContain("const width = useContentWidth();");
  });

  test("its own safe area where a tab bar floats over its foot, and how far that foot stands above the window's", () => {
    expect(pane).toContain(
      "{ownInsets ? <SafeAreaProvider style={styles.fill}>{children}</SafeAreaProvider> : children}",
    );
    expect(pane).toContain("setBelow(Math.max(0, Math.round(windowHeight - (y + height))))");
    // The keyboard rises from the window's edge: the conversation's composer rides it that much less.
    const chat = src("features/chat/ChatScreen.tsx");
    expect(chat).toContain("const lift = Math.max(0, bottomPad - KEYBOARD_GAP) + (pane?.below ?? 0);");
    // Its gesture area keeps the dock's own room above the keys.
    expect(src("features/chat/screen/parts.tsx")).toContain("offset={Math.round(Math.max(0, height - lift + below))}");
  });

  test("the bar the screen sets is drawn by the pane, clear over the screen or above it, its empty parts untouchable", () => {
    const host = body(pane, "function PaneBarHost(", "\n}\n");
    expect(host).toContain("useSyncExternalStore(bar.subscribe, bar.get, bar.get)");
    expect(host).toContain("if (!state || state.over !== over) return null;");
    expect(pane).toMatch(
      /<PaneBarHost bar=\{bar\} top=\{top\} width=\{width\} over=\{false\} \/>\s*<View style=\{styles\.fill\}>/,
    );
    expect(pane).toContain("<PaneBarHost bar={bar} top={top} width={width} over />");
    const bar = body(pane, "function PaneBar(", "\n}\n");
    expect(bar.match(/pointerEvents="box-none"/g)?.length).toBe(3);
    // No back button: the list it was opened from stands beside it.
    expect(bar).not.toContain('icon="back"');
    // Its title centred on the pane, clear of the wider end.
    expect(bar).toContain(
      "const room = paneTitleRoom(width, Math.max(hasStart ? ends.start : 0, hasEnd ? ends.end : 0));",
    );
  });

  test("the bar's buttons are our icon buttons in one capsule on every platform, presses reaching the latest handler", () => {
    const buttons = body(pane, "function PaneButtons(", "\n}\n");
    expect(buttons).toContain(
      "<IconButton key={b.key} icon={b.icon} label={b.label} disabled={b.disabled} onPress={b.onPress} />",
    );
    expect(buttons).toContain("{lead ? <HeaderSlot slot={lead} /> : null}");
    const header = body(pane, "export function usePaneHeader(", "\n}\n");
    expect(header).toContain("onPress: () => latest.current.actions?.[i]?.onPress()");
    // The bar changes only when what it shows does; the screen's own views redraw in their slots.
    expect(header).toContain("const titleSlot = useHeaderSlot(titleView);");
    expect(header).toContain("}, [plain, titleSlot, leftSlot, rightSlot, leadSlot]);");
    // A screen leaving takes its bar away, never one the next screen already set.
    expect(header).toContain("return () => bar.clear(state);");
    expect(body(pane, "clear(was) {", "},")).toContain("if (bar !== was) return;");
  });

  test("PushedHeader draws the same title, line and buttons in a pane: clear over a cover or a conversation", () => {
    const parts = src("features/shared/parts.tsx");
    const header = body(parts, "function PaneHeader({", "/** `PushedHeader` as the navigator's bar");
    expect(header).toMatch(
      /usePaneHeader\(\{\s*title,\s*subtitle,\s*subtitleColor,\s*right,\s*lead,\s*actions,\s*word: action,/,
    );
    expect(header).toContain("over: plate,");
    expect(header).toContain("tone: grouped ? colors.grouped : colors.bg,");
    // The conversation's bar is a clear plate over it: in a pane it floats over the conversation as it does today.
    expect(src("features/chat/screen/ChatHeader.tsx")).toMatch(
      /<PushedHeader\s+title=\{pill \?\? title\}\s+plate\s+solid=\{false\}/,
    );
  });

  test("a tab's root in a pane draws its large title, and its bar (mark, title fading in, buttons) is the pane's", () => {
    const screen = src("ui/LargeTitleScreen.tsx");
    expect(screen).toContain("const props = usePane() ? { ...own, drawnTitle: true } : own;");
    expect(screen).toContain(
      "return IOS && !props.drawnTitle ? <SystemTitleScreen {...props} /> : <DrawnTitleScreen {...props} />;",
    );
    const drawn = screen.slice(screen.indexOf("function DrawnTitleScreen("));
    expect(drawn).toContain("usePaneHeader({ title: paneTitle, left, leftActions, actions, over: true });");
    expect(drawn).toContain("{pane ? null : <Stack.Screen options={options} />}");
  });

  test("a conversation in a pane settles at once: nothing slides in", () => {
    const opening = src("features/chat/screen/opening.ts");
    expect(opening).toContain("const inPane = usePane() !== null;");
    expect(opening).toContain("const now = peeking || inPane;");
  });
});
