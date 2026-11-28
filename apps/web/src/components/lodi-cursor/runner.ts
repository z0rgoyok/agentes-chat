import { glideMs } from "@agenteschat/client";
import { agentGradient, mix, pixelBurst, pixelVeil, prefersReducedMotion, SKY_TONES } from "@agenteschat/ui";
import { type RefObject, useEffect } from "react";
import { arrivals, DRAW, drawDelay } from "./arrivals";

export interface Point {
  x: number;
  y: number;
}

/** One move of the cursor: where to, a press when it gets there, or placed there at once. */
export interface CursorStep extends Point {
  presses?: number;
  instant?: boolean;
}

/** What the script drives: the cursor `LodiCursor` draws. */
export interface CursorHandle {
  step(step: CursorStep): void;
}

/** A row Lodi's cursor shows landing, and where it is in the sidebar. */
export interface ArrivingRow {
  el: HTMLElement;
  kind: "channel" | "agent";
  /** What the cursor types into a channel's row. */
  name: string;
}

/**
 * The script's beats (ms). About 6.5 s for 3 channels and 3 agents: one press per section, typing that speeds up after
 * the first channel. A bigger team stops at the cap and the rest land at once.
 */
export const RUN = {
  settleMs: 700,
  waitRowsMs: 4000,
  pressMs: 320,
  typeMs: 70,
  typeFastMs: 38,
  rowPauseMs: 160,
  dropMs: 420,
  gatherMs: 500,
  capMs: 8000,
  /** The drawer's slide (`--dur-panel`) before its dropped rows draw in. */
  drawerMs: 240,
  /** A row's room opening (`--dur-fast`) before the veil sweeps off it. */
  roomMs: 140,
} as const;

/** How long the cursor takes between two points of the window, on the product's own pace (`glideMs`). */
export const travelMs = (a: Point, b: Point) =>
  glideMs(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, globalThis.innerWidth ?? 1));

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const centre = (el: Element): Point | null => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
};

/** Where a row's words begin: the cursor types there. */
const labelAt = (row: HTMLElement): Point | null => {
  const label = row.querySelector(".sidebar__item-label") ?? row;
  const r = label.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { x: r.left + 6, y: r.top + r.height / 2 } : null;
};

/** The colors a row's veil sweeps off in: the agent's own, a channel the sky's. */
export function rowTones(row: ArrivingRow): string[] {
  const face = row.kind === "agent" ? row.el.querySelector<HTMLElement>(".ac-avatar") : null;
  if (!face) return [SKY_TONES[2], SKY_TONES[3], SKY_TONES[4]].filter((c): c is string => Boolean(c));
  const css = getComputedStyle(face);
  const [skyTop, skyBottom] = agentGradient("sky");
  const top = css.getPropertyValue("--av-top").trim() || skyTop;
  const bottom = css.getPropertyValue("--av-bottom").trim() || skyBottom;
  return [bottom, mix(bottom, top, 0.5), top];
}

function burstFrom(row: ArrivingRow) {
  const face = row.el.querySelector<HTMLElement>(".ac-avatar");
  const at = face && centre(face);
  if (!at) return;
  const tones = rowTones(row);
  pixelBurst(at, [...tones, "#ffffff"], tones[0] ?? "#ffffff");
}

/** Hidden until the cursor (or the fallback) brings it: its words, or its face and name. */
export function holdRows(rows: ArrivingRow[]) {
  for (const r of rows) {
    r.el.dataset.lodi = "pending";
    r.el.dataset.drawn = "";
  }
}

/** Everything in place now: what the cursor hadn't brought yet lands at once (Pular, Esc, the cap). */
export function revealRows(rows: ArrivingRow[]) {
  for (const r of rows) {
    delete r.el.dataset.lodi;
    r.el.querySelector(".lodi-typing")?.remove();
  }
}

/** One row drawn in: the veil sweeps off it and an agent's face bursts. */
async function drawRow(row: ArrivingRow) {
  delete row.el.dataset.lodi;
  await pixelVeil(row.el, rowTones(row), DRAW.rowMs);
  if (row.kind === "agent") burstFrom(row);
}

/** The fallback, rows that draw themselves, one after another (`drawDelay`). */
export async function drawIn(rows: ArrivingRow[], signal: AbortSignal) {
  holdRows(rows);
  const started = Date.now();
  await Promise.all(
    rows.map(async (row, i) => {
      await wait(drawDelay(i, rows.length) - (Date.now() - started), signal);
      if (signal.aborted) return revealRows([row]);
      await drawRow(row);
    }),
  );
  revealRows(rows);
}

/** Types the row's name over its label (the row is real underneath), a letter at a time. */
async function typeInto(row: ArrivingRow, perChar: number, signal: AbortSignal) {
  const label = row.el.querySelector<HTMLElement>(".sidebar__item-label");
  if (!label) return drawRow(row);
  const typing = document.createElement("span");
  typing.className = "lodi-typing";
  typing.setAttribute("aria-hidden", "true");
  label.append(typing);
  for (let i = 1; i <= row.name.length && !signal.aborted; i++) {
    typing.textContent = row.name.slice(0, i);
    await wait(perChar, signal);
  }
  typing.remove();
  delete row.el.dataset.lodi;
}

/**
 * Lodi's cursor shows the team land: from `start` to the channels' +, a press, then each channel typed into its row;
 * the agents' +, a press, each agent dropped in with its veil and burst; then back. Aborted (Pular, Esc), and past the
 * cap, whatever is left lands at once.
 */
export async function playLodi(
  cursor: CursorHandle,
  start: Point,
  parts: { add: HTMLElement | null; rows: ArrivingRow[] }[],
  signal: AbortSignal,
) {
  const all = parts.flatMap((p) => p.rows);
  holdRows(all);
  const began = Date.now();
  let at = start;
  const go = async (to: Point, presses = 0) => {
    cursor.step({ ...to, presses });
    await wait(travelMs(at, to) + (presses ? RUN.pressMs : 0), signal);
    at = to;
  };
  let typed = 0;
  for (const part of parts) {
    if (part.rows.length === 0) continue;
    const plus = part.add && centre(part.add);
    if (plus && !signal.aborted) {
      part.add?.setAttribute("data-hover", "");
      await go(plus, 1);
      part.add?.removeAttribute("data-hover");
    }
    for (const row of part.rows) {
      if (signal.aborted || Date.now() - began > RUN.capMs) break;
      const to = labelAt(row.el);
      if (!to) {
        // Gone or out of sight: it lands by itself.
        await drawRow(row);
        continue;
      }
      await go(to);
      if (row.kind === "channel") {
        await typeInto(row, typed === 0 ? RUN.typeMs : RUN.typeFastMs, signal);
        typed++;
      } else {
        await drawRow(row);
        await wait(RUN.dropMs - DRAW.rowMs, signal);
      }
      await wait(RUN.rowPauseMs, signal);
    }
  }
  revealRows(all);
  if (!signal.aborted) await go(start);
}

/** The rows of `ids` in the sidebar (`data-channel-row`, `data-agent-row`), those there now, in order. */
export function findRows(nav: ParentNode, kind: ArrivingRow["kind"], ids: string[]): ArrivingRow[] {
  return ids.flatMap((id) => {
    const el = nav.querySelector<HTMLElement>(`[data-${kind}-row="${CSS.escape(id)}"]`);
    if (!el) return [];
    const name = el.querySelector(".sidebar__item-label")?.textContent?.trim() ?? "";
    return [{ el, kind, name }];
  });
}

/** Rows the person can see now: in the open sidebar, not under a dialog, not scrolled away. */
export function inSight(nav: Element | null, rows: ArrivingRow[]): boolean {
  if (!nav || rows.length === 0) return false;
  if (nav.closest('[data-rail="true"]') || document.querySelector('.ac-dialog[data-state="open"], .thread-panel')) {
    return false;
  }
  const view = (nav.querySelector(".sidebar__scroll") ?? nav).getBoundingClientRect();
  return rows.every((r) => {
    const b = r.el.getBoundingClientRect();
    return b.height > 0 && b.top >= view.top && b.bottom <= view.bottom;
  });
}

/**
 * Everyone else's sidebar, a channel's members column, and rows no cursor shows: each row that arrives draws itself in
 * once its room opened, at
 * its own `--arrive-delay`. Runs after every render of the sidebar, and a row draws once.
 */
export function useRowsDrawIn(nav: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = nav.current;
    if (!root || prefersReducedMotion()) return;
    for (const el of root.querySelectorAll<HTMLElement>("[data-arriving]:not([data-drawn])")) {
      // A sidebar row says what it is; a members column's agent row says so on its own (`data-arriving-agent`).
      const agentId = el.dataset.agentRow ?? el.dataset.arrivingAgent;
      const id = el.dataset.channelRow ?? agentId ?? "";
      if (arrivals.owns(id)) continue;
      el.dataset.drawn = "";
      const delay = Number.parseInt(el.style.getPropertyValue("--arrive-delay"), 10) || 0;
      const row: ArrivingRow = { el, kind: agentId ? "agent" : "channel", name: "" };
      setTimeout(() => void drawRow(row), delay + RUN.roomMs);
    }
  });
}
