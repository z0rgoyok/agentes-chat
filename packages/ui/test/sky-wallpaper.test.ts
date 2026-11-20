import { describe, expect, test } from "bun:test";
import { contrastRatio } from "../src/sky/math";
import {
  crowdAgents,
  crowdTones,
  DRAWING_ICONS,
  drawingsColors,
  WALLPAPER_PAGE,
  wallpaperFill,
  wallpaperGrid,
  wallpaperSkyField,
  wallpaperSkyIndex,
  wallpaperSkyTones,
  wallpaperStrength,
} from "../src/sky/wallpaper";

describe("the sky behind a conversation", () => {
  test("strong behind the bar, almost the page behind the words, a horizon behind the composer", () => {
    for (const dark of [false, true]) {
      expect(wallpaperSkyField(0.05, 0.02, dark)).toBeGreaterThan(2);
      expect(wallpaperSkyField(0.05, 0.6, dark)).toBeLessThan(0.5);
      expect(wallpaperSkyField(0.5, 0.98, dark)).toBeGreaterThan(1.2);
    }
  });

  test("its tones start at the page and its pixels stay inside them", () => {
    for (const dark of [false, true]) {
      const tones = wallpaperSkyTones("green", dark);
      expect(tones[0]).toBe(WALLPAPER_PAGE[dark ? "dark" : "light"]);
      for (let y = 0; y < 60; y += 3)
        for (let x = 0; x < 40; x += 3) {
          const i = wallpaperSkyIndex(x, y, 40, 60, dark, tones.length);
          expect(i).toBeGreaterThanOrEqual(0);
          expect(i).toBeLessThan(tones.length);
        }
    }
  });
});

describe("drawings and agents", () => {
  test("every cell holds one drawing, and no row repeats one next to it", () => {
    const cells = wallpaperGrid(390, 844, 50, DRAWING_ICONS.length);
    expect(cells.length).toBeGreaterThan(100);
    const rows = new Map<number, typeof cells>();
    for (const c of cells) rows.set(c.row, [...(rows.get(c.row) ?? []), c]);
    for (const row of rows.values())
      for (let i = 1; i < row.length; i++) expect(row[i]?.index).not.toBe(row[i - 1]?.index);
  });

  test("tone on tone: the drawings barely stand off their page", () => {
    for (const dark of [false, true])
      for (const color of ["paper", "sky", "rose"] as const) {
        const { bg, ink } = drawingsColors(color, dark);
        expect(contrastRatio(bg, ink)).toBeLessThan(1.6);
      }
  });

  test("the agents are faint, each its own color", () => {
    const agents = crowdAgents(390, 844, 64, 26);
    expect(new Set(agents.map((a) => a.color)).size).toBeGreaterThan(4);
    for (const dark of [false, true]) {
      const { body } = crowdTones("violet", dark);
      expect(contrastRatio(body, WALLPAPER_PAGE[dark ? "dark" : "light"])).toBeLessThan(1.3);
    }
  });
});

test("a flat color and the strength over a look with no bubbles", () => {
  expect(wallpaperFill("sand", false)).toBe("#f4ecde");
  expect(wallpaperFill("teal", true)).not.toBe(WALLPAPER_PAGE.dark);
  expect(wallpaperStrength(true)).toBe(1);
  expect(wallpaperStrength(false)).toBe(0.5);
});
