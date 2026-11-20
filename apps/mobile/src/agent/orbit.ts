import { type AgentColorName, bodyTones, mixHex } from "@agenteschat/ui/agent/engine";

/** The 3×3 ring the orbit walks, clockwise from the top-left. */
export const RING: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [2, 0],
  [2, 1],
  [2, 2],
  [1, 2],
  [0, 2],
  [0, 1],
];

/** One step of the orbit's walk, and its whole round (one step per ring cell). */
export const ORBIT_STEP_MS = 110;
export const ORBIT_ROUND_MS = ORBIT_STEP_MS * RING.length;

/** Which ring cell leads at time `ms` (one step every 110 ms; 0 when still). */
export const orbitHead = (ms: number, still = false) => (still ? 0 : Math.floor(ms / ORBIT_STEP_MS) % RING.length);

/** The orbit's tones over `surface`: the head and the two cells trailing it, and the rest of the ring, faint. */
export function orbitTones(color: AgentColorName, surface: string): { lead: [string, string, string]; faint: string } {
  const tn = bodyTones(color);
  const faint = mixHex(tn[tn.length - 1] ?? "#999999", surface, 0.55);
  return { lead: [tn[0] ?? faint, tn[1] ?? faint, tn[2] ?? faint], faint };
}

/** Each ring cell's color and opacity for a head position, in the agent's body tones over `surface`. */
export function orbitCells(color: AgentColorName, surface: string, head: number) {
  const { lead, faint } = orbitTones(color, surface);
  return RING.map(([x, y], k) => {
    const age = (head - k + RING.length) % RING.length;
    return { x, y, color: age <= 2 ? lead[age] : faint, opacity: age <= 2 ? 1 : 0.5 };
  });
}

/**
 * One cell's round as keyframes (offsets as fractions of the round), held between them (`step-end`): it leads, then
 * trails twice, then rests faint until the head comes round again. Every cell plays the same round, each a step behind
 * the one before it (`orbitDelay`).
 */
export function orbitRound(lead: readonly [string, string, string], faint: string) {
  const step = 1 / RING.length;
  return {
    0: { backgroundColor: lead[0], opacity: 1 },
    [step]: { backgroundColor: lead[1], opacity: 1 },
    [2 * step]: { backgroundColor: lead[2], opacity: 1 },
    [3 * step]: { backgroundColor: faint, opacity: 0.5 },
    1: { backgroundColor: faint, opacity: 0.5 },
  };
}

/**
 * Where ring cell `k` starts in its round (a negative delay, ms) for an orbit that starts turning at `now` (ms): the
 * head is where `orbitHead(now)` puts it, so orbits started at different moments turn in step, as on one clock.
 */
export const orbitDelay = (k: number, now: number) =>
  -((now % ORBIT_ROUND_MS) + ((RING.length - k) % RING.length) * ORBIT_STEP_MS);

/** The neutral orbit's ink opacities by age (head, trail, trail, rest): "enviando", "lê na próxima pausa". */
export const INK_ALPHAS = [1, 0.62, 0.38, 0.16] as const;

/** Each ring cell's ink opacity for a head position (the neutral orbit, no agent color). */
export const inkOrbitCells = (head: number) =>
  RING.map(([x, y], k) => {
    const age = Math.min(3, (head - k + RING.length) % RING.length);
    return { x, y, opacity: INK_ALPHAS[age] ?? 0.16 };
  });

/** The neutral orbit's round for one cell, as `orbitRound` (its ink stays, its opacity walks). */
export function inkOrbitRound() {
  const step = 1 / RING.length;
  return {
    0: { opacity: INK_ALPHAS[0] },
    [step]: { opacity: INK_ALPHAS[1] },
    [2 * step]: { opacity: INK_ALPHAS[2] },
    [3 * step]: { opacity: INK_ALPHAS[3] },
    1: { opacity: INK_ALPHAS[3] },
  };
}

/** The stop square's breath: 1 → 0.6 → 1 every 1.6 s. */
export const BREATH_MS = 1600;

/** The stop square's opacity at `ms` (solid when still). */
export const stopBreath = (ms: number, still = false) =>
  still ? 1 : 0.8 + 0.2 * Math.cos((2 * Math.PI * (ms % BREATH_MS)) / BREATH_MS);

/**
 * The breath as keyframes, each half on a sine's ease (cubic-bezier(0.37, 0, 0.63, 1), within a hair of
 * `stopBreath`'s cosine).
 */
export const breathRound = () => ({ 0: { opacity: 1 }, 0.5: { opacity: 0.6 }, 1: { opacity: 1 } });

/** Where a breath starting at `now` (ms) begins in its round, so every stop square breathes in step. */
export const breathDelay = (now: number) => -(now % BREATH_MS);
