import { describe, expect, test } from "bun:test";
import { rgbOf } from "@agenteschat/ui/agent/engine";
import { WALLPAPER_GLINTS, wallpaperGlintTone, wallpaperSkyTones } from "@agenteschat/ui/sky/wallpaper";
import {
  AUTO_BANDS,
  dragFocus,
  PHOTO_MAX_SIDE,
  photoCover,
  photoOverflow,
  shrunkSize,
  skyPixels,
  wallpaperHrefs,
  wallpaperKey,
  wallpaperTargetOf,
} from "../../src/features/chat/wallpaper-logic";
import { chatScreenSource } from "./chat-screen-source";

const read = (rel: string) => Bun.file(new URL(`../../src/features/${rel}`, import.meta.url).pathname).text();
const pixel = (bytes: Uint8Array, w: number, x: number, y: number) => {
  const o = (y * w + x) * 4;
  return [bytes[o], bytes[o + 1], bytes[o + 2]];
};

describe("a conversation's background on the phone", () => {
  test("the sky is opaque pixels in its own tones, top strong and the middle almost the page", () => {
    const w = 40;
    const h = 90;
    const bytes = skyPixels(["green"], w, h, false, false);
    expect(bytes.length).toBe(w * h * 4);
    const tones = wallpaperSkyTones("green", false).map((c) => rgbOf(c).join(","));
    for (let i = 3; i < bytes.length; i += 4) expect(bytes[i]).toBe(255);
    const spots = [
      [0, 0],
      [20, 45],
      [39, 89],
    ] as const;
    for (const [x, y] of spots) expect(tones).toContain(pixel(bytes, w, x, y).join(","));
    // The page itself (tone 0) somewhere in the middle, where the words are.
    const middle = Array.from({ length: w }, (_, x) => pixel(bytes, w, x, Math.round(h * 0.6)).join(","));
    expect(middle).toContain(tones[0]);
  });

  test("on a tile no glints or stars; on a screen the glints are crosses in their tone", () => {
    const w = 120;
    const h = 260;
    const plain = skyPixels(["sky"], w, h, true, false);
    const detailed = skyPixels(["sky"], w, h, true, true);
    expect(plain).not.toEqual(detailed);
    const glint = rgbOf(wallpaperSkyTones("sky", true)[wallpaperGlintTone(true)] ?? "").join(",");
    const [u, v] = WALLPAPER_GLINTS[0] ?? [0, 0];
    expect(pixel(detailed, w, Math.round(u * w), Math.round(v * h)).join(",")).toBe(glint);
  });

  test("auto with no one conversation's color: a band of each, side by side", () => {
    const w = 30;
    const h = 30;
    const bytes = skyPixels(AUTO_BANDS, w, h, false, false);
    const at = (x: number) => pixel(bytes, w, x, 0).join(",");
    const top = (hue: (typeof AUTO_BANDS)[number]) => wallpaperSkyTones(hue, false).map((c) => rgbOf(c).join(","));
    expect(top(AUTO_BANDS[0] ?? "green")).toContain(at(0));
    expect(top(AUTO_BANDS[2] ?? "rose")).toContain(at(w - 1));
  });

  test("a photo covers the box and keeps its point of interest on it", () => {
    // A landscape photo on a phone: it runs past the sides only.
    const over = photoOverflow(2000, 1000, 400, 800);
    expect(over.height).toBe(800);
    expect(over.width).toBe(1600);
    expect(over.x).toBe(1200);
    expect(over.y).toBe(0);
    expect(photoCover(2000, 1000, 400, 800, 0, 0.5).x).toBe(0);
    expect(photoCover(2000, 1000, 400, 800, 1, 0.5).x).toBe(-1200);
    expect(photoCover(2000, 1000, 400, 800, 0.5, 0.5).x).toBe(-600);
    // Out of range or not a number: the photo stays in the box.
    expect(photoCover(2000, 1000, 400, 800, 3, 0.5).x).toBe(-1200);
    expect(photoCover(2000, 1000, 400, 800, Number.NaN, 0.5).x).toBe(-600);
  });

  test("a drag moves the point of interest against the finger, never past the photo's edges", () => {
    expect(dragFocus(0.5, -120, 1200)).toBeCloseTo(0.6);
    expect(dragFocus(0.5, 120, 1200)).toBeCloseTo(0.4);
    expect(dragFocus(0.9, -1000, 1200)).toBe(1);
    expect(dragFocus(0.1, 1000, 1200)).toBe(0);
    // A side that fits exactly doesn't move.
    expect(dragFocus(0.5, 300, 0)).toBe(0.5);
  });

  test("a picked photo is sent at most PHOTO_MAX_SIDE on its long side, never made bigger", () => {
    expect(shrunkSize(4032, 3024)).toEqual({ width: PHOTO_MAX_SIDE, height: 1080 });
    expect(shrunkSize(3024, 4032)).toEqual({ width: 1080, height: PHOTO_MAX_SIDE });
    expect(shrunkSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  test("Background for every conversation or for one, by its params", () => {
    expect(wallpaperTargetOf({})).toEqual({ all: true });
    expect(wallpaperTargetOf({ channelId: "c1" })).toEqual({ channelId: "c1" });
    expect(wallpaperHrefs.choose({ all: true })).toBe("/me/chat-wallpaper");
    expect(wallpaperHrefs.choose({ channelId: "a b" })).toBe("/me/chat-wallpaper?channelId=a%20b");
  });

  test("the same choice paints the same thing; a moved photo paints another", () => {
    expect(wallpaperKey({ kind: "sky", color: "auto" })).toBe(wallpaperKey({ kind: "sky", color: "auto" }));
    expect(wallpaperKey({ kind: "agents" })).not.toBe(wallpaperKey({ kind: "none" }));
    const photo = {
      kind: "photo",
      url: "/api/app/wallpapers/u/0123456789abcdef.jpg",
      dim: 0.45,
      x: 0.5,
      y: 0.5,
    } as const;
    expect(wallpaperKey(photo)).not.toBe(wallpaperKey({ ...photo, x: 0.2 }));
  });

  test("the conversation paints its background behind everything, and fades under the bar into it", async () => {
    const chat = chatScreenSource();
    expect(chat).toContain("<ChatWallpaper");
    expect(chat).toContain("<WallpaperBand");
    expect(chat).toContain("useConversationLook(convoDm, dmAgentColor, channelId)");
    const row = await read("chat/MessageRow.tsx");
    // Someone else's bubble is lifted off a background, and every bubble takes the ring of the cards' shadow as an
    // outline (no masked shadow layers to draw on every frame of a scroll).
    expect(row).toContain("const otherFill = lifted ? lift : c.bubble;");
    expect(row).toContain("const bubbleEdge = lifted ? liftedEdge(scheme) : null;");
    expect(row).not.toContain("boxShadow");
    // The edge is the cards' own (`cardEdge`), the one the grouped lists carry too.
    const look = await read("chat/look.ts");
    expect(look).toContain("return cardEdge(scheme);");
    const palette = await Bun.file(new URL("../../src/ui/palette.ts", import.meta.url).pathname).text();
    expect(palette).toContain("appShadows(scheme).e1.find((l) => l.blur === 0 && l.spread > 0)");
    expect(palette).toContain('{ outlineWidth: ring.spread, outlineColor: ring.color, outlineStyle: "solid" }');
  });
});
