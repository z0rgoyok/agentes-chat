import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inBody } from "@agenteschat/ui/agent/engine";
import {
  DIVE,
  DIVE_TOTAL,
  diveBody,
  diveEyes,
  diveName,
  diveScale,
  LAUNCH,
  LOGO,
  launchesAtOnce,
  launchPose,
  launchSkyTones,
  SPRITES,
  spriteBlinks,
  spriteY,
  waitLine,
} from "../../src/features/launch/logic";

describe("launch splash", () => {
  test("starts on the native image: the body is 400 of its 512 px at 120 pt", () => {
    expect(LOGO).toBeCloseTo(93.75, 5);
  });

  test("one line only once it's late: why it waits", () => {
    expect(waitLine(false, true)).toBeNull();
    expect(waitLine(true, false)).toBe("slow");
    expect(waitLine(true, true)).toBe("offline");
  });

  test("the agent looks down at the sky, back up, smiles; closes its eyes offline; smiles leaving", () => {
    // Native frame: facing ahead, eyes open, like the launch image.
    expect(launchPose(0)).toEqual({ turn: [0, 0], blink: false });
    expect(launchPose(0.4).turn?.[1]).toBeGreaterThan(0.5);
    expect(launchPose(0.89).turn?.[1]).toBeLessThan(0);
    expect(launchPose(1.2).expression).toBe("happy");
    expect(launchPose(LAUNCH.lineAfter + 0.1, { offline: true }).expression).toBe("closed");
    expect(launchPose(1, { offline: true }).expression).not.toBe("closed");
    expect(launchPose(3, { offline: true, leaving: true }).expression).toBe("happy");
  });

  test("the sprites stay inside the sky as they rise, and wait while it is low", () => {
    for (const s of SPRITES) {
      expect(spriteY(s, 1, 0.1)).toBeNull();
      for (let t = 0; t < 30; t += 0.7) {
        const y = spriteY(s, t, LAUNCH.sky);
        expect(y).not.toBeNull();
        // From near the bottom up to a little under the sky's top (it starts at 1 - 0.5).
        expect(y as number).toBeLessThanOrEqual(0.95);
        expect(y as number).toBeGreaterThan(1 - LAUNCH.sky + 0.05);
      }
    }
    // They move up over time.
    const s = SPRITES[0];
    expect(spriteY(s, 0.5, LAUNCH.sky) as number).toBeLessThan(spriteY(s, 0, LAUNCH.sky) as number);
  });

  test("waiting on the person, the sprites rise only above the panel at the bottom", () => {
    const bottom = 0.6;
    for (const s of SPRITES)
      for (let t = 0; t < 30; t += 0.7) {
        const y = spriteY(s, t, LAUNCH.waitingSky, bottom);
        expect(y).not.toBeNull();
        expect(y as number).toBeLessThanOrEqual(bottom);
        expect(y as number).toBeGreaterThan(1 - LAUNCH.waitingSky + 0.05);
      }
    // No room between the sky's top and the panel: none.
    expect(spriteY(SPRITES[0], 1, LAUNCH.waitingSky, 0.48)).toBeNull();
  });

  test("a sprite blinks for a moment every 3.6 s", () => {
    const s = SPRITES[0];
    const blinks = Array.from({ length: 360 }, (_, i) => spriteBlinks(s, i / 100)).filter(Boolean).length;
    expect(blinks).toBeGreaterThan(5);
    expect(blinks).toBeLessThan(20);
  });

  test("ready within its first frames it leaves at once; later its rise plays the minimum", () => {
    expect(launchesAtOnce(0)).toBe(true);
    expect(launchesAtOnce(LAUNCH.quick * 1000)).toBe(true);
    expect(launchesAtOnce(LAUNCH.quick * 1000 + 1)).toBe(false);
    expect(LAUNCH.quick).toBeLessThan(LAUNCH.min);
    const splash = readFileSync(join(import.meta.dir, "../../src/features/launch/LaunchSplash.tsx"), "utf8");
    expect(splash).toContain("if (!played && !launchesAtOnce(Date.now() - startedAt)) return;");
    // Leaving, the agent holds its last pose: no frames of it on the JS thread while the app arrives under it.
    expect(splash).toContain("const now = useFrameTime(!reduced && !leaving, heldAt);");
  });

  test("leaving, the agent's body becomes a window that grows faster and faster until it holds any screen", () => {
    expect(diveScale(0)).toBe(1);
    // A breath in before the dive.
    expect(diveScale(DIVE.at)).toBeCloseTo(DIVE.shrink, 2);
    expect(diveScale(DIVE_TOTAL)).toBeCloseTo(DIVE.far, 5);
    // Ever faster: each step grows the window more than the one before.
    const grows = [0.16, 0.24, 0.32, 0.4].map((e) => diveScale(e + 0.04) / diveScale(e));
    for (let i = 1; i < grows.length; i++) expect(grows[i]).toBeGreaterThan(grows[i - 1] as number);
    // At its end the body holds every corner of the screen around where the agent stands: the largest phone, a
    // tablet either way up.
    const size = LOGO * DIVE.far;
    for (const [w, h] of [
      [440, 956],
      [1024, 1366],
      [1366, 1024],
    ] as const) {
      const left = w / 2 - size / 2;
      const top = h / 2 - LAUNCH.lift - size / 2;
      for (const [x, y] of [
        [0, 0],
        [w, 0],
        [0, h],
        [w, h],
      ] as const)
        expect({ w, h, x, y, inside: inBody((x - left) / size, (y - top) / size) }).toEqual({
          w,
          h,
          x,
          y,
          inside: true,
        });
    }
    // The body's fill lets go first (the app shows through it), the eyes a moment later, the name before the dive.
    expect(diveBody(DIVE.at)).toBe(1);
    expect(diveBody(DIVE.at + 0.1)).toBe(0);
    expect(diveEyes(DIVE.at + 0.1)).toBeGreaterThan(0.5);
    expect(diveEyes(DIVE_TOTAL)).toBe(0);
    expect(diveName(DIVE.nameOut)).toBe(0);
  });

  test("the dive runs on one clock on the UI thread, cut into the sky's canvas; the app is in view from its start", () => {
    const splash = readFileSync(join(import.meta.dir, "../../src/features/launch/LaunchSplash.tsx"), "utf8");
    expect(splash).toContain(
      "dive.value = withTiming(DIVE_TOTAL, { duration: DIVE_TOTAL * 1000, easing: Easing.linear }, end);",
    );
    expect(splash).toContain("<Group clip={opening} invertClip>");
    expect(splash).toContain("markRevealed();");
    // Reduced motion keeps the short fade.
    expect(splash).toContain("shown.value = withTiming(0, { duration: LAUNCH.reducedExit * 1000 }, end);");
    // Conversas arrives as the window grows, not once the splash is gone.
    const home = readFileSync(join(import.meta.dir, "../../src/features/chats/HomeEntrance.tsx"), "utf8");
    expect(home).toContain("const inView = useRevealed();");
  });

  test("the sky starts from the screen's own background", () => {
    expect(launchSkyTones("#ffffff", false)[0]).toBe("#ffffff");
    expect(launchSkyTones("#0f0f0e", true)[0]).toBe("#0f0f0e");
    expect(launchSkyTones("#ffffff", false).length).toBeLessThanOrEqual(8);
  });
});
