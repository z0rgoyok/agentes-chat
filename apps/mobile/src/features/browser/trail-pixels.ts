import type { BrowserTrailKind } from "@agenteschat/client";
import { type AgentColorName, bodyTones, mixHex, type SkyPair } from "@agenteschat/ui/agent/engine";
import type { CellRun } from "../../computer/cells";

/**
 * The pixels of the band after an agent's run in its browser or on its desktop, the web's drawings
 * (`RunPixels.tsx` in `@agenteschat/ui`: `BrowserStrip`, `BrowserMark`) as cell lists a Skia canvas replays
 * (./TrailPixels.tsx). Same grid, tones and Bayer order as the web, so both apps draw the same picture. Pure
 * TypeScript: no React Native, no Skia, so it runs in `bun test`.
 */

export type { CellRun };

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x: number, y: number) => BAYER[((y & 3) << 2) | (x & 3)] ?? 0.5;

/** Points per cell of the step columns (the web's `CELL`). */
export const TRAIL_CELL = 2;
/** The strip's height in cells: 7 sits on one line of text. */
export const STRIP_ROWS = 7;
const COLUMN_W = 3;
const COLUMN_GAP = 1;

/** The cells grouped by color, in the order the colors first appear (also the agent's month, `month-pixels.ts`). */
export class CellGrid {
  private readonly byColor = new Map<string, number[]>();
  put(x: number, y: number, color: string) {
    let list = this.byColor.get(color);
    if (!list) {
      list = [];
      this.byColor.set(color, list);
    }
    list.push(x, y);
  }
  runs(): CellRun[] {
    return [...this.byColor].map(([color, cells]) => ({ color, cells }));
  }
}

/** Bayer between a column's tones, `h` cells up from `base` (the web's `column`). */
export function column(out: CellGrid, x0: number, w: number, h: number, base: number, pal: string[]) {
  const last = pal.length - 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const f = h <= 1 ? 0.5 : 1 - y / (h - 1);
      const s = f * last;
      const b = Math.floor(s);
      const idx = s - b > bayer(x0 + x, y) ? b + 1 : b;
      out.put(x0 + x, base - y, pal[Math.min(last, idx)] ?? pal[0] ?? "#888888");
    }
}

/** The surface the card sits on and the danger tone, as six-digit hex (the mixer reads six digits). */
export interface TrailTones {
  raised: string;
  danger: string;
}

function trailPalette(color: AgentColorName | SkyPair, tones: TrailTones): Record<BrowserTrailKind, string[]> {
  const t = bodyTones(color);
  const at = (i: number) => t[i] ?? "#888888";
  return {
    open: [at(0), at(1), at(2)],
    read: [at(1), at(2), at(3)],
    act: [at(2), at(3), at(4)],
    shot: [mixHex(at(3), tones.raised, 0.35), at(4)],
    failed: [tones.danger, tones.danger, mixHex(tones.danger, tones.raised, 0.45)],
  };
}

const HEIGHT: Record<BrowserTrailKind, number> = { open: 1, read: 0.7, act: 0.4, shot: 0, failed: 1 };
const rowsOf = (kind: BrowserTrailKind, rows: number) =>
  kind === "shot" ? 2 : Math.max(3, Math.round(HEIGHT[kind] * rows));

/** The strip's width in cells for that many steps. */
export const stripWidth = (steps: number) => Math.max(1, steps * (COLUMN_W + COLUMN_GAP) - COLUMN_GAP);

/** The steps in order, oldest left: an open the whole column, a read most of it, an action a stub, a print two cells. */
export function stripCells(kinds: BrowserTrailKind[], color: AgentColorName | SkyPair, tones: TrailTones): CellRun[] {
  const pal = trailPalette(color, tones);
  const out = new CellGrid();
  kinds.forEach((k, i) => {
    column(out, i * (COLUMN_W + COLUMN_GAP), COLUMN_W, rowsOf(k, STRIP_ROWS), STRIP_ROWS - 1, pal[k]);
  });
  return out.runs();
}

/** One step's column, marking its line in the list (3 × 7 cells). */
export const MARK_W = COLUMN_W;
export function markCells(kind: BrowserTrailKind, color: AgentColorName | SkyPair, tones: TrailTones): CellRun[] {
  const out = new CellGrid();
  column(out, 0, COLUMN_W, rowsOf(kind, STRIP_ROWS), STRIP_ROWS - 1, trailPalette(color, tones)[kind]);
  return out.runs();
}
