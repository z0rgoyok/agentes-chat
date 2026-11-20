import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const UI = join(import.meta.dir, "../src/ui");
const ui = (file: string) => readFileSync(join(UI, file), "utf8");

test("motion has one source: the theme's easings, and its springs in Apple's two parameters", () => {
  const theme = ui("theme.tsx");
  expect(theme).toContain("easeOut: Easing.bezier(0.23, 1, 0.32, 1),");
  expect(theme).toContain("easeInOut: Easing.bezier(0.77, 0, 0.175, 1),");
  expect(theme).toContain("settle: { duration: 400, dampingRatio: 1 },");
  expect(theme).toContain("snap: { duration: 400, dampingRatio: 0.8 },");
  expect(theme).toContain("sheet: { duration: 300, dampingRatio: 0.8 },");
  // The press spring nobody used is gone; the notice island's pop stays.
  expect(theme).not.toContain("press: { damping");
  expect(theme).toContain("pop: { damping: 13, stiffness: 260, mass: 0.7 },");
});

test("the kit keeps no copy of the curve (the composer is drawn elsewhere)", () => {
  const kit = readdirSync(UI).filter((f) => /\.tsx?$/.test(f) && f !== "Composer.tsx" && f !== "theme.tsx");
  const copies = kit.filter((f) => ui(f).includes("Easing.bezier(0.23, 1, 0.32, 1)"));
  expect(copies).toEqual([]);
  expect(ui("PressScale.tsx")).toContain("export const PRESS_IN = { duration: 120, easing: motion.easeOut };");
  expect(ui("Toggle.tsx")).toContain("const SWITCH = { duration: 160, easing: motion.easeOut };");
});

test("the kit's search field and token build their animations once, never while rendering", () => {
  for (const file of ["SearchField.tsx", "Token.tsx"])
    expect({ file, inRender: /(entering|exiting|layout)=\{[^}]*\.duration\(/.test(ui(file)) }).toEqual({
      file,
      inRender: false,
    });
  const search = ui("SearchField.tsx");
  expect(search).toContain("const FIELD_MOVE = LinearTransition.duration(motion.panel).easing(motion.easeInOut);");
  expect(search).toContain("layout={reducedMotion ? undefined : FIELD_MOVE}");
  expect(ui("Token.tsx")).toContain("const TOKEN_IN = FadeIn.duration(motion.fast).easing(motion.easeOut);");
  // The hold button's fill lets go and drains on the theme's durations.
  expect(ui("HoldButton.tsx")).toContain("const LET_GO = { duration: motion.base, easing: motion.easeOut };");
});
