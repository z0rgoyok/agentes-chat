import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BREATH_MS,
  breathDelay,
  breathRound,
  inkOrbitCells,
  inkOrbitRound,
  ORBIT_ROUND_MS,
  ORBIT_STEP_MS,
  orbitCells,
  orbitDelay,
  orbitHead,
  orbitRound,
  orbitTones,
  RING,
  stopBreath,
} from "../src/agent/orbit";

const src = (file: string) => readFileSync(join(import.meta.dir, "../src", file), "utf8");

/** A cell's age at `ms` into its round: its keyframes hold from one offset to the next (`step-end`). */
const ageAt = (ms: number) => Math.floor((((ms % ORBIT_ROUND_MS) + ORBIT_ROUND_MS) % ORBIT_ROUND_MS) / ORBIT_STEP_MS);

/** The keyframe a round holds at `fraction` of it: the last one at or before it. */
function heldAt<T>(round: Record<string, T>, fraction: number): T {
  const offset = Math.max(
    ...Object.keys(round)
      .map(Number)
      .filter((o) => o <= fraction),
  );
  return round[String(offset)] as T;
}

describe("the orbits turn on the UI thread, as they did on the shared clock", () => {
  test("each cell starts its round where the shared clock's head puts it, so every orbit turns in step", () => {
    for (const now of [0, 55, 110, 879, 880, 12_345, 1_700_000_000_123])
      for (let k = 0; k < RING.length; k++) {
        const age = (orbitHead(now) - k + RING.length) % RING.length;
        expect({ now, k, age: ageAt(-orbitDelay(k, now)) }).toEqual({ now, k, age });
        // A step later, a step older.
        expect(ageAt(-orbitDelay(k, now) + ORBIT_STEP_MS)).toBe((age + 1) % RING.length);
        // Always partway through its round: a negative delay, never a wait before it turns.
        expect(orbitDelay(k, now)).toBeLessThanOrEqual(0);
      }
  });

  test("a cell's round holds the old frames' colors by age: the head, two trailing, the rest faint", () => {
    const { lead, faint } = orbitTones("sky", "#ffffff");
    const round = orbitRound(lead, faint) as Record<string, { backgroundColor: string; opacity: number }>;
    for (let age = 0; age < RING.length; age++) {
      // Cell 0 is `age` steps behind the head when the head is on cell `age`.
      const cell = orbitCells("sky", "#ffffff", age)[0];
      const frame = heldAt(round, age / RING.length);
      expect({ age, color: frame.backgroundColor, opacity: frame.opacity }).toEqual({
        age,
        color: cell?.color ?? "",
        opacity: cell?.opacity ?? 0,
      });
    }
  });

  test("the neutral orbit: the same round, its opacity by age", () => {
    const round = inkOrbitRound() as Record<string, { opacity: number }>;
    for (let age = 0; age < RING.length; age++)
      expect(heldAt(round, age / RING.length).opacity).toBe(inkOrbitCells(age)[0]?.opacity ?? -1);
  });

  test("the stop square breathes from where the shared clock's breath was, 1 → 0.6 → 1", () => {
    for (const now of [0, 400, 800, 1599, 123_456]) expect(-breathDelay(now)).toBe(now % BREATH_MS);
    expect(breathRound()).toEqual({ 0: { opacity: 1 }, 0.5: { opacity: 0.6 }, 1: { opacity: 1 } });
    expect(stopBreath(0)).toBeCloseTo(1);
    expect(stopBreath(BREATH_MS / 2)).toBeCloseTo(0.6);
  });

  test("no frame of theirs on the JS thread: held where they are off screen, still with reduced motion", () => {
    const orbit = src("agent/PixelOrbit.tsx");
    const marks = src("agent/PixelMarks.tsx");
    for (const file of [orbit, marks]) {
      expect(file).not.toContain("useFrameTime");
      expect(file).toContain("useLivePaused()");
      expect(file).toContain("loopStyle(");
    }
    expect(orbit).toContain("const turning = !reduced && !still;");
    expect(marks).toContain("const turning = !reduced;");
    expect(marks).toContain("const breathing = !reduced && moving;");
    expect(src("agent/loop.ts")).toContain('animationPlayState: paused ? "paused" : "running"');
  });
});
