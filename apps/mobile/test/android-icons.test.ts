import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ICONS } from "../src/ui/icons.data";
import { MATERIAL_VIEWBOX, materialPathOf, materialTabPathOf } from "../src/ui/icons.material";
import { MATERIAL_PATHS } from "../src/ui/icons.material.data";
import { MATERIAL_NAMES, TAB_MATERIAL } from "../src/ui/icons.material.names";
import { tabGlyphSvg } from "../src/ui/tabGlyphs";

const src = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");

describe("Google's symbols on Android", () => {
  test("every icon has Google's symbol, or says it keeps ours (the same ones that keep ours on iOS)", () => {
    expect(Object.keys(MATERIAL_NAMES).sort()).toEqual(Object.keys(ICONS).sort());
    const ours = Object.entries(MATERIAL_NAMES)
      .filter(([, symbol]) => symbol === null)
      .map(([name]) => name)
      .sort();
    expect(ours).toEqual(["agent", "computerLinux", "computerMac", "computerWindows", "sticker", "wait"]);
  });

  test("Android's own conventions: the vertical dots, the back arrow, Android's share", () => {
    expect(MATERIAL_NAMES.more).toBe("more_vert");
    expect(MATERIAL_NAMES.back).toBe("arrow_back");
    expect(MATERIAL_NAMES.share).toBe("share");
  });

  test("every symbol named has its outline and filled shapes, and only those named are carried", () => {
    const named = new Set(
      [...Object.values(MATERIAL_NAMES), ...Object.values(TAB_MATERIAL)].filter((n): n is string => n !== null),
    );
    expect(new Set(Object.keys(MATERIAL_PATHS))).toEqual(named);
    for (const { line, fill } of Object.values(MATERIAL_PATHS)) {
      expect(line).toMatch(/^[Mm][-\d.]/);
      expect(fill).toMatch(/^[Mm][-\d.]/);
    }
    expect(materialPathOf("home")).toBe(MATERIAL_PATHS.home?.line ?? "");
    expect(materialPathOf("home", true)).toBe(MATERIAL_PATHS.home?.fill ?? "");
    expect(materialPathOf("agent")).toBeNull();
  });

  test("the iPhone's bundle carries none of the paths", () => {
    const ios = src("src/ui/icons.material.ios.ts");
    expect(ios).not.toContain("icons.material.data");
    expect(ios).toContain("export function materialPathOf(");
    expect(ios).toContain("export function materialTabPathOf(");
  });

  test("Icon draws them on Android, filled where asked; ours where Google has none", () => {
    const icon = src("src/ui/Icon.tsx");
    expect(icon).toContain("const material = ANDROID ? materialPathOf(name, filled) : null;");
    expect(icon).toContain("<Svg width={size} height={size} viewBox={MATERIAL_VIEWBOX} accessible={false}>");
    expect(icon).toContain("<Path d={material} fill={tint} />");
    expect(MATERIAL_VIEWBOX).toBe("0 -960 960 960");
  });

  test("the tabs: Google's on Android, filled when selected; Agentes keeps our agent", () => {
    const outline = tabGlyphSvg("chats", false, "#000", true);
    const filled = tabGlyphSvg("chats", true, "#000", true);
    expect(outline).toContain(`viewBox="${MATERIAL_VIEWBOX}"`);
    expect(outline).toContain(materialTabPathOf("chats", false) ?? "missing");
    expect(filled).toContain(materialTabPathOf("chats", true) ?? "missing");
    expect(tabGlyphSvg("agents", true, "#000", true)).toBe(tabGlyphSvg("agents", true, "#000"));
    // iOS (no `material`) keeps the glyphs it had.
    expect(tabGlyphSvg("chats", false, "#000")).toContain('viewBox="0 0 24 24"');
    expect(src("src/ui/tabIcons.ts")).toContain('tabGlyphSvg(parsed.glyph, parsed.selected, "#000000", MATERIAL)');
  });

  test("Google's license travels with the paths", () => {
    expect(src("src/ui/icons.material.data.ts")).toContain("licensed under the Apache License, Version 2.0");
    expect(src("src/ui/LICENSE.material-symbols")).toContain("Apache License");
    expect(readFileSync(join(import.meta.dir, "../../../NOTICE"), "utf8")).toContain("Material Symbols");
  });
});
