import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { activeFold, foldInside, LIST_MAX, LIST_MIN, LIST_SHARE, paneFrames, WIDE_MIN } from "../src/ui/two-pane";

const ROOT = join(import.meta.dir, "..");
const src = (file: string) => readFileSync(join(ROOT, file), "utf8");
const MODULE = "modules/duo-layout";

/** The body of a Swift method, from its signature to the brace that closes it at the class's indentation. */
const swiftBody = (source: string, signature: string) => {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n  }\n", start));
};

describe("two panes on a wide window (ADR 0212)", () => {
  test("two panes from 600 points; the list takes 40% of the width, from 300 to 380", () => {
    expect([WIDE_MIN, LIST_MIN, LIST_MAX, LIST_SHARE]).toEqual([600, 300, 380, 0.4]);
  });

  test("with no fold: the list's share, the hairline, then the detail takes the rest", () => {
    // 40% of 600 is 240: the list's narrowest.
    expect(paneFrames(600, null)).toEqual({ list: { x: 0, width: 300 }, gap: 1, detail: { x: 301, width: 299 } });
    // 40% of 850 is 340, between the two.
    expect(paneFrames(850, null)).toEqual({ list: { x: 0, width: 340 }, gap: 1, detail: { x: 341, width: 509 } });
    // To the point: 40% of 801 is 320.4.
    expect(paneFrames(801, null).list.width).toBe(320);
    // 40% of 1200 is 480: the list's widest.
    expect(paneFrames(1200, null)).toEqual({ list: { x: 0, width: 380 }, gap: 1, detail: { x: 381, width: 819 } });
  });

  test("a fold inside the row: the list ends where it starts, the detail starts where it ends", () => {
    expect(paneFrames(960, { x: 460, width: 40 })).toEqual({
      list: { x: 0, width: 460 },
      gap: 40,
      detail: { x: 500, width: 460 },
    });
    // A row that doesn't start at the screen's edge sees the fold off its middle, in its own points.
    expect(paneFrames(800, { x: 300.5, width: 40 })).toEqual({
      list: { x: 0, width: 300.5 },
      gap: 40,
      detail: { x: 340.5, width: 459.5 },
    });
  });

  test("a fold at an edge of the row or outside it divides nothing: the list's share again", () => {
    const plain = paneFrames(960, null);
    const outside = [
      { x: 0, width: 40 },
      { x: -40, width: 40 },
      { x: 920, width: 40 },
      { x: 960, width: 40 },
      { x: 1200, width: 40 },
    ];
    for (const fold of outside) {
      expect(foldInside(960, fold)).toBe(false);
      expect(paneFrames(960, fold)).toEqual(plain);
    }
    expect(foldInside(960, { x: 460, width: 40 })).toBe(true);
    expect(foldInside(960, null)).toBe(false);
  });

  test("no width is ever negative, and the list is never wider than the row", () => {
    for (const width of [-10, 0, 120, 299, 300, 301, 600]) {
      const { list, gap, detail } = paneFrames(width, null);
      expect([list.width, gap, detail.width].every((w) => w >= 0)).toBe(true);
      expect(list.width).toBeLessThanOrEqual(Math.max(0, width));
    }
    expect(paneFrames(0, null)).toEqual({ list: { x: 0, width: 0 }, gap: 1, detail: { x: 1, width: 0 } });
    expect(paneFrames(120, null)).toEqual({ list: { x: 0, width: 120 }, gap: 1, detail: { x: 121, width: 0 } });
  });

  test("only an active fold moves the panes: opened flat it is reported, inactive", () => {
    expect(activeFold(null)).toBeNull();
    expect(activeFold(undefined)).toBeNull();
    expect(activeFold({ x: 460, y: 0, width: 40, height: 700, active: false })).toBeNull();
    expect(activeFold({ x: 460, y: 0, width: 40, height: 700, active: true })).toEqual({ x: 460, width: 40 });
  });
});

describe("the native module (ADR 0212)", () => {
  test("a local Expo module for iOS alone, one view sending one event; Android has none", () => {
    expect(JSON.parse(src(`${MODULE}/expo-module.config.json`))).toEqual({
      platforms: ["apple"],
      apple: { modules: ["DuoLayoutModule"] },
    });
    expect(existsSync(join(ROOT, MODULE, "android"))).toBe(false);
    const podspec = src(`${MODULE}/ios/DuoLayout.podspec`);
    expect(podspec).toContain("s.name           = 'DuoLayout'");
    expect(podspec).toContain("s.license        = 'AGPL-3.0-only'");
    expect(podspec).toContain("s.dependency 'ExpoModulesCore'");
    const module = src(`${MODULE}/ios/DuoLayoutModule.swift`);
    expect(module).toContain("public class DuoLayoutModule: Module {");
    expect(module).toContain('Name("DuoLayout")');
    expect(module).toMatch(/View\(DuoRegionsView\.self\) \{\s*Events\("onRegions"\)\s*\}/);
  });

  test("the view reads the fold with iOS 27.1's reserved regions in updateConstraints, behind both guards", () => {
    const view = src(`${MODULE}/ios/DuoRegionsView.swift`);
    expect(view).toContain("final class DuoRegionsView: ExpoView {");
    expect(view).toContain("let onRegions = EventDispatcher()");
    // A view with no constraints of its own: without this, UIKit may never run its `updateConstraints()`.
    expect(view).toContain("override class var requiresConstraintBasedLayout: Bool {\n    true\n  }");
    // UIKit tracks the regions read in `updateConstraints()` and runs it again when they change; the read comes first.
    const update = swiftBody(view, "override func updateConstraints() {");
    expect(update).toContain("fold: readFold()");
    expect(update.indexOf("send(")).toBeLessThan(update.indexOf("super.updateConstraints()"));
    // The iOS 27.1 call only with Xcode 27's Swift (Xcode 26.4 to 26.6 have Swift 6.3) and only on iOS 27.1.
    const read = swiftBody(view, "private func readFold() -> Fold? {");
    const guards = ["#if compiler(>=6.4)", "if #available(iOS 27.1, *) {"].map((line) => read.indexOf(line));
    const call = read.indexOf("reservedRegions(kind: .division, options: .includeInactive)");
    expect(guards.every((at) => at > -1 && at < call)).toBe(true);
    expect(read.indexOf("#endif")).toBeGreaterThan(call);
    // The first division region taller than wide (folded like a book) that crosses the view, active or not.
    expect(read).toContain("candidate.frame.height > candidate.frame.width && crosses(candidate.frame)");
    expect(read).toContain("return Fold(frame: region.frame, active: region.isActive)");
  });

  test("the view reports the size class, read again on trait, size and window changes; only what changed", () => {
    const view = src(`${MODULE}/ios/DuoRegionsView.swift`);
    expect(view).toContain("isUserInteractionEnabled = false");
    expect(view).toContain("send(Regions(wide: traitCollection.horizontalSizeClass == .regular, fold: readFold()))");
    expect(view).toContain(
      "registerForTraitChanges([UITraitHorizontalSizeClass.self], action: #selector(UIView.setNeedsUpdateConstraints))",
    );
    expect(swiftBody(view, "override func didMoveToWindow() {")).toContain("setNeedsUpdateConstraints()");
    const layout = swiftBody(view, "override func layoutSubviews() {");
    expect(layout).toContain("guard bounds.size != readSize else { return }");
    expect(layout).toContain("setNeedsUpdateConstraints()");
    const send = swiftBody(view, "private func send(_ regions: Regions) {");
    expect(send).toContain("guard regions != sent else { return }");
    // The payload is `DuoRegions`: `fold` null when no region crosses the view.
    expect(send).toContain('onRegions(["wide": regions.wide, "fold": fold])');
    expect(send).toContain("var fold: Any = NSNull()");
    for (const key of ["x", "y", "width", "height", "active"]) expect(send).toContain(`"${key}": `);
    expect(src("src/ui/two-pane.ts")).toContain(
      "fold: { x: number; y: number; width: number; height: number; active: boolean } | null;",
    );
  });
});

describe("the panes in the app (ADR 0212)", () => {
  test("the native view loads only on iOS and only in a build that has it", () => {
    const pane = src("src/ui/TwoPane.tsx");
    expect(pane).toContain('Platform.OS === "ios" && requireOptionalNativeModule("DuoLayout") !== null');
    expect(pane).toContain('? requireNativeView<RegionsViewProps>("DuoLayout")');
    expect(pane).toContain(": null;");
    // Untouchable and filling its parent, in the provider and in each TwoPane; nothing where there is no view.
    const view =
      '{RegionsView ? <RegionsView pointerEvents="none" style={StyleSheet.absoluteFill} onRegions={onRegions} /> : null}';
    expect(pane.split(view)).toHaveLength(3);
  });

  test("useWide takes the system's size class, and the window's width before it reports or without it", () => {
    const pane = src("src/ui/TwoPane.tsx");
    expect(pane).toContain("return wide ?? width >= WIDE_MIN;");
    // The provider's view reports the size class and the window's fold together (fold-room.test.ts has the fold).
    expect(pane).toMatch(
      /const onRegions = useCallback\(\(event: RegionsEvent\) => \{\s*setWide\(event\.nativeEvent\.wide\);/,
    );
  });

  test("TwoPane lays the panes out by paneFrames in its own measured width, with its own fold", () => {
    const pane = src("src/ui/TwoPane.tsx");
    expect(pane).toContain("const frames = paneFrames(width, fold);");
    expect(pane).toContain("setMeasured(event.nativeEvent.layout.width)");
    expect(pane).toContain("const next = activeFold(event.nativeEvent.fold);");
    expect(pane).toContain("<View style={[styles.pane, { width: frames.list.width }]}>{list}</View>");
    expect(pane).toContain("{ width: frames.gap },");
    // The hairline in the theme's separator color, unless the fold's gap stands between the panes.
    expect(pane).toContain("foldInside(width, fold) ? null : [styles.divider, { borderLeftColor: colors.separator }],");
    expect(pane).toContain("divider: { borderLeftWidth: StyleSheet.hairlineWidth },");
    // Both panes clip and fill the row's height.
    expect(pane).toContain('row: { flex: 1, flexDirection: "row", overflow: "hidden" },');
    expect(pane).toContain('pane: { overflow: "hidden" },');
  });

  test("DuoProvider is mounted once, at the root of AppProviders, and the kit exports the panes", () => {
    const providers = src("src/providers/AppProviders.tsx");
    expect(providers).toContain('import { DuoProvider } from "@/ui/TwoPane";');
    expect(providers).toMatch(
      /<GestureHandlerRootView style=\{\{ flex: 1 \}\} \{\.\.\.hintTouches\}>\s*\{\/\*[^}]*\*\/\}\s*<DuoProvider>\s*<SafeAreaProvider>/,
    );
    expect(providers).toMatch(/<\/SafeAreaProvider>\s*<\/DuoProvider>\s*<\/GestureHandlerRootView>/);
    const mounts: string[] = [];
    for (const dir of ["app", "src"]) {
      for (const file of readdirSync(join(ROOT, dir), { recursive: true }) as string[]) {
        if (/\.tsx?$/.test(file) && src(join(dir, file)).includes("<DuoProvider>")) mounts.push(join(dir, file));
      }
    }
    expect(mounts).toEqual(["src/providers/AppProviders.tsx"]);
    expect(src("src/ui/index.ts")).toContain(
      'export { DuoProvider, TwoPane, useFoldRoom, useWide, useWindowFold } from "./TwoPane";',
    );
  });
});
