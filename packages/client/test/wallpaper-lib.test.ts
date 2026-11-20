import { describe, expect, test } from "bun:test";
import {
  NO_WALLPAPER,
  resolveWallpaper,
  sameWallpaper,
  WALLPAPER_FAMILIES,
  wallpaperFor,
  wallpaperName,
  wallpaperOf,
} from "../src/lib/wallpaper";

const PHOTO = "/api/app/wallpapers/u1/0123456789abcdef.jpg";
/** The key and its params, so the words checked are the ones asked for. */
const say = (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key);

describe("wallpaperOf", () => {
  test("keeps the kinds and colors it knows and drops the rest", () => {
    expect(wallpaperOf({ kind: "sky", color: "auto" })).toEqual({ kind: "sky", color: "auto" });
    expect(wallpaperOf({ kind: "drawings", color: "paper" })).toEqual({ kind: "drawings", color: "paper" });
    expect(wallpaperOf({ kind: "agents", extra: 1 })).toEqual({ kind: "agents" });
    expect(wallpaperOf({ kind: "color", color: "auto" })).toBeUndefined();
    expect(wallpaperOf({ kind: "sky", color: "#ff0000" })).toBeUndefined();
    expect(wallpaperOf({ kind: "stripes" })).toBeUndefined();
    expect(wallpaperOf(null)).toBeUndefined();
  });

  test("a photo is one of the server's addresses, its dim capped and its point inside the picture", () => {
    expect(wallpaperOf({ kind: "photo", url: PHOTO, dim: 2, x: -1, y: 0.25 })).toEqual({
      kind: "photo",
      url: PHOTO,
      dim: 0.8,
      x: 0,
      y: 0.25,
    });
    expect(
      wallpaperOf({ kind: "photo", url: "https://elsewhere.example/a.jpg", dim: 0.4, x: 0.5, y: 0.5 }),
    ).toBeUndefined();
  });
});

describe("wallpaperFor", () => {
  test("a conversation's own wins; else the one behind every conversation; else none", () => {
    expect(wallpaperFor(undefined, "c1")).toEqual(NO_WALLPAPER);
    const prefs = { wallpaper: { kind: "agents" as const }, wallpapers: { c1: { kind: "none" as const } } };
    expect(wallpaperFor(prefs, "c1")).toEqual({ kind: "none" });
    expect(wallpaperFor(prefs, "c2")).toEqual({ kind: "agents" });
    expect(wallpaperFor(prefs, null)).toEqual({ kind: "agents" });
  });

  test("auto takes the conversation's color, the workspace's sky without one", () => {
    expect(resolveWallpaper({ kind: "sky", color: "auto" }, "rose")).toEqual({ kind: "sky", color: "rose" });
    expect(resolveWallpaper({ kind: "drawings", color: "auto" }, null)).toEqual({ kind: "drawings", color: "sky" });
    expect(resolveWallpaper({ kind: "color", color: "sand" }, "rose")).toEqual({ kind: "color", color: "sand" });
  });
});

describe("the picker", () => {
  test("three families of eight; the agents open the drawings; no tile twice", () => {
    expect(WALLPAPER_FAMILIES.sky).toHaveLength(8);
    expect(WALLPAPER_FAMILIES.drawings).toHaveLength(8);
    expect(WALLPAPER_FAMILIES.color).toHaveLength(8);
    expect(WALLPAPER_FAMILIES.drawings[0]).toEqual({ kind: "agents" });
    const all = [...WALLPAPER_FAMILIES.sky, ...WALLPAPER_FAMILIES.drawings, ...WALLPAPER_FAMILIES.color];
    for (const [i, w] of all.entries()) expect(all.findIndex((o) => sameWallpaper(o, w))).toBe(i);
  });

  test("a photo is the same choice wherever its point is", () => {
    const a = { kind: "photo" as const, url: PHOTO, dim: 0.2, x: 0.1, y: 0.1 };
    expect(sameWallpaper(a, { ...a, x: 0.9 })).toBe(true);
    expect(sameWallpaper(a, { kind: "agents" })).toBe(false);
  });

  test("names: auto says whose color it takes where it is chosen", () => {
    const base = "settings.account.chat.wallpaper";
    expect(wallpaperName(say, { kind: "sky", color: "auto" }, null)).toBe(`${base}.name.skyAuto`);
    expect(wallpaperName(say, { kind: "sky", color: "auto" }, true)).toBe(`${base}.name.skyAgent`);
    expect(wallpaperName(say, { kind: "drawings", color: "auto" }, false)).toBe(`${base}.name.drawingsWorkspace`);
    expect(wallpaperName(say, { kind: "color", color: "sand" }, null)).toBe(
      `${base}.name.color {"color":"${base}.neutral.sand"}`,
    );
    expect(wallpaperName(say, { kind: "sky", color: "rose" }, null)).toBe(
      `${base}.name.sky {"color":"look.colors.rose"}`,
    );
    expect(wallpaperName(say, NO_WALLPAPER, null)).toBe(`${base}.none`);
  });
});
