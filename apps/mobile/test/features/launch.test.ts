import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bayerAt } from "@agenteschat/ui/sky/math";
import {
  burstCells,
  burstDrift,
  EXIT,
  EXIT_TOTAL,
  GATHER_FRAMES,
  gatherFrame,
  gatherPose,
  LAUNCH,
  LOGO,
  launchesAtOnce,
  launchPose,
  launchSkyTones,
  nameUnderRing,
  OPENING_END,
  OPENING_FPS,
  OPENING_FRAMES,
  openingFrame,
  panelOut,
  ringCell,
  ringRadius,
  ringTones,
  SPRITES,
  spriteBlinks,
  spriteY,
  waitLine,
} from "../../src/features/launch/logic";

const source = (path: string) => readFileSync(join(import.meta.dir, "../..", path), "utf8");

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

  test("ready within its first frames it leaves at once; later its opening plays the minimum", () => {
    expect(launchesAtOnce(0)).toBe(true);
    expect(launchesAtOnce(LAUNCH.quick * 1000)).toBe(true);
    expect(launchesAtOnce(LAUNCH.quick * 1000 + 1)).toBe(false);
    expect(LAUNCH.quick).toBeLessThan(LAUNCH.min);
    // The shortest launch leaves once the sky is nearly up and the name is in, not later.
    expect(LAUNCH.min).toBe(0.6);
    expect(LAUNCH.nameAt + LAUNCH.nameIn).toBeLessThanOrEqual(LAUNCH.min);
    expect(source("src/features/launch/LaunchSplash.tsx")).toContain(
      "if (!played && !launchesAtOnce(Date.now() - startedAt)) return;",
    );
  });

  test("the agent's opening is drawn ahead and shown by the UI thread; past it, it idles drawn as it goes", () => {
    expect(OPENING_FRAMES).toBe(Math.round(OPENING_END * OPENING_FPS) + 1);
    // The frame for each moment, never past what is drawn so far; none past the opening.
    expect(openingFrame(0, 1)).toBe(0);
    expect(openingFrame(0.5, 4)).toBe(3);
    expect(openingFrame(0.5, OPENING_FRAMES)).toBe(15);
    expect(openingFrame(OPENING_END, OPENING_FRAMES)).toBe(-1);
    const splash = source("src/features/launch/LaunchSplash.tsx");
    expect(splash).toContain("list.push(agentPicture(launchPose(list.length / OPENING_FPS)));");
    expect(splash).toContain("const i = openingFrame(clock.value / 1000, list.length);");
    // No frames of it on the JS thread during the opening (the app loads there), nor while it leaves.
    expect(splash).toContain("const now = useFrameTime(!reduced && idling && !leaving, heldAt);");
  });

  test("leaving, the agent gathers itself: faces front from where it was, smiles and squashes", () => {
    const held = launchPose(0.4);
    const last = gatherPose(held, GATHER_FRAMES - 1);
    expect(last.turn).toEqual([0, 0]);
    expect(last.expression).toBe("happy");
    expect(last.squash).toBeCloseTo(EXIT.squash, 5);
    expect(gatherPose(held, 0).turn?.[1]).toBeGreaterThan(0);
    expect(gatherFrame(0)).toBe(0);
    expect(gatherFrame(EXIT.gather)).toBe(GATHER_FRAMES - 1);
    expect(EXIT_TOTAL).toBeCloseTo(EXIT.gather + EXIT.wave, 5);
  });

  test("the ring starts just outside the agent and ends past every corner of any screen", () => {
    expect(ringRadius(0, 400, 390, 844)).toBe(0);
    expect(ringRadius(EXIT.gather, 400, 390, 844)).toBeCloseTo(LOGO * 0.55, 5);
    for (const [w, h] of [
      [390, 844],
      [440, 956],
      [1024, 1366],
      [1366, 1024],
    ] as const) {
      const cy = h / 2 - LAUNCH.lift;
      const r = ringRadius(EXIT_TOTAL, cy, w, h);
      // Its band's inner edge (where only the app shows) is past the farthest corner.
      expect(r - EXIT.band).toBeGreaterThan(Math.hypot(w / 2, Math.max(cy, h - cy)));
    }
    // Always growing.
    const rs = [0.1, 0.2, 0.3, 0.4, 0.5].map((e) => ringRadius(e, 400, 390, 844));
    for (let i = 1; i < rs.length; i++) expect(rs[i]).toBeGreaterThan(rs[i - 1] as number);
  });

  test("on the ring: the splash outside, the sky's tones on the band, the app dithering in on its inner half", () => {
    expect(ringCell(120, 100, 0.5)).toBe("splash");
    // Mid-band: the brightest tone.
    expect(ringCell(100 - EXIT.band / 2, 100, 0.5)).toBe(3);
    // Past the band: the app.
    expect(ringCell(10, 100, 0.5)).toBe("app");
    expect(ringCell(100 - EXIT.band, 100, 0.99)).toBe("app");
    // The inner half lets more of the app through the deeper it is.
    const through = (k: number) =>
      Array.from({ length: 16 }, (_, i) => ringCell(100 - k * EXIT.band, 100, bayerAt(i % 4, i >> 2))).filter(
        (c) => c === "app",
      ).length;
    expect(through(0.4)).toBe(0);
    expect(through(0.6)).toBeLessThan(through(0.9));
    expect(ringTones("#ffffff", false)[0]).toBe("#ffffff");
    expect(ringTones("#0f0f0e", true, true)[0]).toBe("#0f0f0e");
  });

  test("the agent comes apart into its own pixels, all gone early in the wave", () => {
    const cells = burstCells();
    expect(cells.length).toBeGreaterThan(300);
    for (const c of cells) {
      expect(Math.abs(c.dx)).toBeLessThan(LOGO / 2);
      expect(Math.abs(c.dy)).toBeLessThan(LOGO / 2);
      expect(c.gone).toBeLessThanOrEqual(EXIT.burst);
      expect(burstDrift(c, 0)).toBe(1);
      expect(burstDrift(c, EXIT.burst + 0.01)).toBeNull();
    }
  });

  test("the name goes under the band as it passes; the panel at the bottom goes as the agent gathers", () => {
    expect(nameUnderRing(0)).toBe(1);
    expect(nameUnderRing(LOGO * 0.55)).toBe(1);
    expect(nameUnderRing(400)).toBe(0);
    expect(panelOut(0)).toBe(1);
    expect(panelOut(0.12)).toBe(0);
  });

  test("the exit runs on one clock on the UI thread, the ring cutting the sky's canvas; the app in view from its start", () => {
    const splash = source("src/features/launch/LaunchSplash.tsx");
    expect(splash).toContain(
      "exit.value = withTiming(EXIT_TOTAL, { duration: EXIT_TOTAL * 1000, easing: Easing.linear }, end);",
    );
    expect(splash).toContain('<Fill blendMode="dstOut">');
    expect(splash).toContain("<Group layer={ring !== null}>");
    expect(splash).toContain("markRevealed();");
    // Reduced motion (or no shader) keeps the short fade.
    expect(splash).toContain("shown.value = withTiming(0, { duration: LAUNCH.reducedExit * 1000 }, end);");
    // The app settles from a little larger under the ring, around the whole navigator.
    expect(source("app/_layout.tsx")).toContain("style={[{ flex: 1 }, settleStyle]}");
    // Conversas is in place under the splash: nothing arrives over the ring; the right hand still wakes once in view.
    expect(source("src/features/chats/ChatsScreen.tsx")).not.toContain("<Arrive");
    expect(source("src/features/chats/HomeEntrance.tsx")).toContain("const inView = useRevealed();");
  });

  test("the sky starts from the screen's own background", () => {
    expect(launchSkyTones("#ffffff", false)[0]).toBe("#ffffff");
    expect(launchSkyTones("#0f0f0e", true)[0]).toBe("#0f0f0e");
    expect(launchSkyTones("#ffffff", false).length).toBeLessThanOrEqual(8);
  });
});
