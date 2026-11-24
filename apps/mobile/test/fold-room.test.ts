import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeWindowFold,
  besideFold,
  FOLD_GAP,
  foldRoom,
  insetPastFold,
  NO_FOLD,
  padPastFold,
  sameWindowFold,
  sidesPastFold,
  TOAST_SIDE,
  toastInsets,
  windowFoldOf,
} from "../src/ui/fold-room";

const ROOT = join(import.meta.dir, "..");
const src = (file: string) => readFileSync(join(ROOT, file), "utf8");

/** The inner display folded like a book: a window 960 wide, the curve 40 wide in its middle. */
const WIDTH = 960;
const FOLD = { x: 460, width: 40 };
const report = (fold: { x: number; width: number }, active: boolean) => ({ ...fold, y: 0, height: 700, active });

describe("the window's fold (ADR 0212)", () => {
  test("a report's fold in the window's points: none, there but inactive (opened flat), or active", () => {
    expect(NO_FOLD).toEqual({ fold: null, active: false, hasFold: false });
    expect(windowFoldOf(null)).toBe(NO_FOLD);
    expect(windowFoldOf(undefined)).toBe(NO_FOLD);
    // Opened flat the region is reported inactive and without width: the device has a fold all the same.
    expect(windowFoldOf(report({ x: 480, width: 0 }, false))).toEqual({
      fold: { x: 480, width: 0 },
      active: false,
      hasFold: true,
    });
    expect(windowFoldOf(report(FOLD, true))).toEqual({ fold: FOLD, active: true, hasFold: true });
  });

  test("only an active fold moves anything", () => {
    expect(activeWindowFold(NO_FOLD)).toBeNull();
    expect(activeWindowFold({ fold: FOLD, active: false, hasFold: true })).toBeNull();
    expect(activeWindowFold({ fold: FOLD, active: true, hasFold: true })).toBe(FOLD);
  });

  test("a report that changed only the size class reads as the same fold, anything else does not", () => {
    const folded = windowFoldOf(report(FOLD, true));
    expect(sameWindowFold(folded, windowFoldOf(report(FOLD, true)))).toBe(true);
    expect(sameWindowFold(NO_FOLD, windowFoldOf(null))).toBe(true);
    expect(sameWindowFold(folded, windowFoldOf(report(FOLD, false)))).toBe(false);
    expect(sameWindowFold(folded, windowFoldOf(report({ x: 461, width: 40 }, true)))).toBe(false);
    expect(sameWindowFold(folded, windowFoldOf(report({ x: 460, width: 38 }, true)))).toBe(false);
    expect(sameWindowFold(folded, NO_FOLD)).toBe(false);
    expect(sameWindowFold(NO_FOLD, windowFoldOf(report({ x: 0, width: 0 }, false)))).toBe(false);
  });
});

describe("the room past the fold (ADR 0212)", () => {
  test("folded like a book, the trailing side: from the fold's end to the window's", () => {
    expect(foldRoom(WIDTH, FOLD)).toEqual({ left: 500, right: 0, side: "trailing" });
    // Two sides equal to the point, whatever their fractions: the trailing one.
    expect(foldRoom(WIDTH, { x: 459.5, width: 41 })).toEqual({ left: 500.5, right: 0, side: "trailing" });
    expect(foldRoom(WIDTH, { x: 459.75, width: 40.25 })).toEqual({ left: 500, right: 0, side: "trailing" });
  });

  test("a fold off the window's middle: the wider side", () => {
    expect(foldRoom(WIDTH, { x: 700, width: 40 })).toEqual({ left: 0, right: 260, side: "leading" });
    expect(foldRoom(WIDTH, { x: 200, width: 40 })).toEqual({ left: 240, right: 0, side: "trailing" });
  });

  test("no fold dividing the window, none at an edge or past it: nothing moves", () => {
    const outside = [null, { x: 0, width: 40 }, { x: -40, width: 40 }, { x: 920, width: 40 }, { x: 1200, width: 40 }];
    for (const fold of outside) expect(foldRoom(WIDTH, fold)).toBeNull();
  });
});

describe("what keeps clear of the fold (ADR 0212)", () => {
  const trailing = { left: 500, right: 0, side: "trailing" as const };
  const leading = { left: 0, right: 260, side: "leading" as const };

  test("a centered control moves beside the fold, at the fold's edge of its side, the least that clears it", () => {
    expect(FOLD_GAP).toBe(12);
    expect(besideFold(trailing)).toEqual({ left: 500, right: 0, alignItems: "flex-start", paddingLeft: 12 });
    expect(besideFold(leading)).toEqual({ left: 0, right: 260, alignItems: "flex-end", paddingRight: 12 });
  });

  test("a bar across the screen keeps its controls to the side past the fold, its own sides kept inside it", () => {
    expect(padPastFold(trailing, 16)).toEqual({ paddingLeft: 516, paddingRight: 16 });
    expect(padPastFold(leading, 16)).toEqual({ paddingLeft: 16, paddingRight: 276 });
    expect(insetPastFold(trailing, 16)).toEqual({ left: 516, right: 16 });
    expect(insetPastFold(leading, 0)).toEqual({ left: 0, right: 260 });
  });

  test("the safe area's side insets and the fold's room: the larger on each side", () => {
    const insets = { left: 0, right: 0 };
    expect(sidesPastFold(insets, null)).toBe(insets);
    expect(sidesPastFold({ left: 47, right: 47 }, trailing)).toEqual({ left: 500, right: 47 });
    expect(sidesPastFold({ left: 47, right: 300 }, leading)).toEqual({ left: 47, right: 300 });
  });
});

describe("a toast and the fold (ADR 0212)", () => {
  test("no fold: 12 from each side of the window, the toast centered between them", () => {
    expect(TOAST_SIDE).toBe(12);
    expect(toastInsets(WIDTH, null)).toEqual({ left: 12, right: 12 });
    expect(toastInsets(390, null)).toEqual({ left: 12, right: 12 });
  });

  test("folded like a book: in the middle of the trailing half, never wider than it", () => {
    const sides = toastInsets(WIDTH, FOLD);
    expect(sides).toEqual({ left: 512, right: 12 });
    // The layer's middle is the half's ((500 + 960) / 2), and it is the half less its sides wide at most.
    expect((sides.left + WIDTH - sides.right) / 2).toBe(730);
    expect(WIDTH - sides.left - sides.right).toBe(436);
  });

  test("a fold at an edge or past it leaves the toast where it was; one off the middle sends it to the wider side", () => {
    expect(toastInsets(WIDTH, { x: 0, width: 40 })).toEqual({ left: 12, right: 12 });
    expect(toastInsets(WIDTH, { x: 960, width: 40 })).toEqual({ left: 12, right: 12 });
    expect(toastInsets(WIDTH, { x: 700, width: 40 })).toEqual({ left: 12, right: 272 });
  });
});

describe("the fold in the app (ADR 0212)", () => {
  test("DuoProvider's root view gives the window's fold, kept when a report changed only the size class", () => {
    const pane = src("src/ui/TwoPane.tsx");
    expect(pane).toContain("const FoldContext = createContext<WindowFold>(NO_FOLD);");
    expect(pane).toContain("export function useWindowFold(): WindowFold {\n  return useContext(FoldContext);\n}");
    expect(pane).toContain("setWide(event.nativeEvent.wide);");
    expect(pane).toContain("const next = windowFoldOf(event.nativeEvent.fold);");
    expect(pane).toContain("setWindowFold((was) => (sameWindowFold(was, next) ? was : next));");
    expect(pane).toContain("<FoldContext.Provider value={windowFold}>{children}</FoldContext.Provider>");
    // With no module there is no view and no report: the context stays `NO_FOLD`.
    expect(pane).toContain("const [windowFold, setWindowFold] = useState<WindowFold>(NO_FOLD);");
  });

  test("a control floating over a screen moves only for an active fold, and never inside two panes", () => {
    const pane = src("src/ui/TwoPane.tsx");
    expect(pane).toContain("const pane = usePane();");
    expect(pane).toContain("const inTwoPane = useContext(InTwoPaneContext);");
    expect(pane).toContain("const fold = pane || inTwoPane ? null : activeWindowFold(windowFold);");
    expect(pane).toContain("return useMemo(() => foldRoom(width, fold), [width, fold]);");
    // TwoPane marks its row, panes and all, whatever wraps their screens.
    expect(pane).toContain("return <InTwoPaneContext.Provider value>{row}</InTwoPaneContext.Provider>;");
    const kit = src("src/ui/index.ts");
    expect(kit).toContain('export { DuoProvider, TwoPane, useFoldRoom, useWide, useWindowFold } from "./TwoPane";');
    for (const name of ["besideFold", "insetPastFold", "padPastFold", "sidesPastFold"]) expect(kit).toContain(name);
  });

  test("the toast's layer takes its sides from the window's active fold, the motion unchanged", () => {
    const toast = src("src/ui/Toast.tsx");
    expect(toast).toContain("const sides = toastInsets(width, activeWindowFold(useWindowFold()));");
    expect(toast).toMatch(
      /style=\{\[styles\.layer, \{ top: insets\.top \+ 6, left: sides\.left, right: sides\.right \}\]\}/,
    );
    expect(toast).toContain('layer: { position: "absolute", alignItems: "center" },');
    // It still drops from the top and leaves the way it came: only its sides moved.
    expect(toast).toContain("transform: [{ translateY: y.get() }]");
  });

  test("what floats over a whole screen keeps clear of the fold, each the least it can", () => {
    const uses: [string, string[]][] = [
      // What comes and goes: the middle of the half past the fold.
      [
        "src/features/island/NoticeIsland.tsx",
        ["const room = camera ? null : foldRoom;", "room && { left: room.left, right: room.right }"],
      ],
      ["src/features/chat/DatePill.tsx", ["room && { left: room.left, right: room.right }"]],
      ["src/features/chat/ChannelWelcome.tsx", ["room && insetPastFold(room, 16)"]],
      // A control centered on the screen: beside the fold.
      ["src/features/live-files/slides/Island.tsx", ["room && besideFold(room)"]],
      ["src/features/computer/EdgeDock.tsx", ["room && besideFold(room)"]],
      [
        "src/features/live-files/canvas/CanvasScreen.tsx",
        [
          "const beside = foldSide ? besideFold(foldSide) : null;",
          "[styles.dockAt, { bottom: lineRoom }, beside]",
          "[styles.dockAt, { bottom: lineRoom + DOCK_H + 8 }, beside]",
        ],
      ],
      // A bar across the screen: its controls to the side past the fold.
      ["src/features/live-files/talk/TalkLine.tsx", ["!bare && foldSide && padPastFold(foldSide, SCREEN_X)"]],
      ["src/features/files/ImageViewer.tsx", ["foldSide ? padPastFold(foldSide, 0) : {}"]],
      [
        "src/features/live-files/slides/ShowScreen.tsx",
        [
          "const bottomSides = sidesPastFold(insets, useFoldRoom());",
          "paddingLeft: bottomSides.left + 12",
          "paddingRight: bottomSides.right + 12",
        ],
      ],
      ["src/features/wiki/WikiBulk.tsx", ["foldSide && padPastFold(foldSide, 16)"]],
      ["src/features/wiki/WikiScreen.tsx", ["foldSide && padPastFold(foldSide, 16)"]],
      ["src/features/wiki/WikiMap.tsx", ["foldSide && insetPastFold(foldSide, 0)"]],
      ["src/features/dashboards/WidgetScreen.tsx", ["foldSide && padPastFold(foldSide, 12)"]],
      ["src/features/ai/AgentAiScreen.tsx", ["foldSide && insetPastFold(foldSide, SCREEN_X)"]],
      [
        "src/features/chat/screen/ChatDock.tsx",
        [
          '<View pointerEvents="box-none" style={room && padPastFold(room, 0)}>',
          "room && padPastFold(room, DOCK_SIDE)",
        ],
      ],
    ];
    for (const [file, snippets] of uses) {
      const source = src(file);
      expect(source).toContain("useFoldRoom()");
      for (const snippet of snippets) expect(source).toContain(snippet);
    }
  });

  test("the conversation's picker keeps its rest padding on the UI thread, the fold's room around it", () => {
    const dock = src("src/features/chat/screen/ChatDock.tsx");
    const wrap = dock.indexOf('<View pointerEvents="box-none" style={room && padPastFold(room, 0)}>');
    expect(dock.indexOf("<Animated.View style={[styles.float, floatRest]}", wrap)).toBeGreaterThan(wrap);
    // The box's background stays across the screen: it fills the box whatever its padding.
    expect(dock).toContain('<View pointerEvents="none" style={StyleSheet.absoluteFill}>');
  });
});
