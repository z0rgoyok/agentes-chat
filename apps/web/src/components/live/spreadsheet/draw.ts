/**
 * Draws a spreadsheet's visible window on a canvas (ADR 0196): cells with their fills, borders, text (overflowing
 * into empty neighbors, clipped or wrapped), gridlines a device pixel wide, frozen panes, the headers, and on top the
 * selection, other people's and agents' ranges, a formula's references while it is typed, and the fill handle. Only
 * what is on screen is read and drawn, so a sheet of 100,000 cells scrolls as fast as an empty one.
 */
import { colName } from "@agenteschat/live/spreadsheet";
import {
  type Axis,
  type CellPos,
  type GridRange,
  HEADER_H,
  HEADER_W,
  rangeBox,
  screenX,
  screenY,
  type Viewport,
  visibleSpan,
  type Whole,
} from "./model";
import type { DrawCell, GridSource } from "./source";

/** The colors and font the grid draws with, read from the page's tokens (they follow the theme). */
export interface GridTheme {
  dark: boolean;
  /** Cells. */
  cell: string;
  /** Headers. */
  header: string;
  line: string;
  lineStrong: string;
  ink: string;
  muted: string;
  danger: string;
  /** The person's own selection fill. */
  selFill: string;
  /** A selected row's or column's header. */
  headerSel: string;
  font: string;
}

/** A range drawn in someone's color: another person's or an agent's selection, a formula's reference. */
export interface RangeMark {
  range: GridRange;
  color: string;
  /** A soft fill of the same color (0–1): an agent's cells while it writes, a reference while typed. */
  wash?: number;
  /** Border width in CSS px (2 by default). */
  width?: number;
  /** A dashed outline (the cells just copied). */
  dashed?: boolean;
  /** Fading out since `from` (`performance.now()`) over `ms`: an agent's range after it moved on. */
  fade?: { from: number; ms: number };
}

/** A mark's strength at `now` (1 at rest, falling to 0 while it fades). */
export function markStrength(mark: RangeMark, now: number): number {
  if (!mark.fade) return 1;
  return Math.max(0, 1 - (now - mark.fade.from) / Math.max(1, mark.fade.ms));
}

export interface GridFrame {
  source: GridSource;
  view: Viewport;
  dpr: number;
  theme: GridTheme;
  selection: { range: GridRange; active: CellPos; whole?: Whole } | null;
  /** Draws the fill handle at the selection's corner. */
  fillHandle: boolean;
  /** Where the fill handle is being dragged to. */
  fillTo: GridRange | null;
  marks: readonly RangeMark[];
  /** The cell under the editor: its text is the editor's. */
  editing: CellPos | null;
  /** The frame's time, for marks fading out. */
  now?: number;
}

export const CELL_PAD_X = 6;
export const CELL_PAD_Y = 4;
export const FILL_HANDLE = 7;
const DEFAULT_PX = 13;
const HEADER_FONT_PX = 12;
/** How far a row looks left and right for text that overflows into the visible window. */
const OVERFLOW_SCAN = 32;

type Ctx = CanvasRenderingContext2D;

// ── Colors ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `#rgb`, `#rrggbb` or `rgb(a)(…)` to its channels (0–255) and alpha; null when unreadable. */
export function parseColor(text: string): [number, number, number, number] | null {
  const s = text.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1] as string;
    const full = h.length === 3 ? [...h].map((x) => x + x).join("") : h;
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
      1,
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (rgb) {
    const a = rgb[4];
    const alpha = a === undefined ? 1 : a.endsWith("%") ? Number.parseFloat(a) / 100 : Number.parseFloat(a);
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha];
  }
  return null;
}

/** WCAG relative luminance of a color (0 black, 1 white); 1 when unreadable. */
export function luminance(color: string): number {
  const c = parseColor(color);
  if (!c) return 1;
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** `a` mixed with `b`: `share` of `a`. */
export function mix(a: string, b: string, share: number): string {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) return a;
  const ch = (i: number) => Math.round((x[i] as number) * share + (y[i] as number) * (1 - share));
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

/** A color with an alpha. */
export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color);
  if (!c) return color;
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.max(0, Math.min(1, alpha * c[3]))})`;
}

/** A cell's fill as drawn: as chosen in the light theme, softened toward the page in the dark one so it doesn't glare. */
export function fillOf(bg: string, theme: GridTheme): string {
  return theme.dark ? mix(bg, theme.cell, 0.55) : bg;
}

/**
 * A cell's text color: the one it was given, unless it would vanish on what is behind it (black text on the dark
 * theme's cells); automatic text picks dark or light by its fill.
 */
export function textColorOf(cell: DrawCell, theme: GridTheme): string {
  if (cell.kind === "error") return theme.danger;
  const bg = cell.style?.bg ? fillOf(cell.style.bg, theme) : theme.cell;
  const chosen = cell.color ?? cell.style?.fc;
  const back = luminance(bg);
  if (chosen) {
    const fore = luminance(chosen);
    const contrast = (Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05);
    if (contrast >= 1.6) return chosen;
  }
  if (!cell.style?.bg) return theme.ink;
  // Automatic text on a fill: whichever of the dark and the light ink stands out more on it, so a light fill softened
  // by the dark theme never carries light text.
  const contrastOn = (ink: string) => {
    const fore = luminance(ink);
    return (Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05);
  };
  return contrastOn("#151514") >= contrastOn("#f4f4f1") ? "#151514" : "#f4f4f1";
}

// ── Text ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const widths = new Map<string, number>();
const metrics = new Map<string, { ascent: number; descent: number }>();

/** Measures taken before the app's font loaded were of a stand-in: they go once it has. */
export function forgetMeasures(): void {
  widths.clear();
  metrics.clear();
}

/** The canvas font for a cell's style. */
export function fontOf(cell: DrawCell | null, family: string): { font: string; px: number } {
  const pt = cell?.style?.fs;
  const px = pt ? Math.round(pt * 1.3 * 10) / 10 : DEFAULT_PX;
  const weight = cell?.style?.b ? 600 : 400;
  return { font: `${cell?.style?.i ? "italic " : ""}${weight} ${px}px ${family}`, px };
}

export function measure(ctx: Ctx, font: string, text: string): number {
  const key = `${font}\u0000${text}`;
  const known = widths.get(key);
  if (known !== undefined) return known;
  if (widths.size > 50_000) widths.clear();
  ctx.font = font;
  const w = ctx.measureText(text).width;
  widths.set(key, w);
  return w;
}

function fontMetrics(ctx: Ctx, font: string, px: number): { ascent: number; descent: number } {
  // Measured on the regular face of the size, whatever the weight or slant: every cell of a row then shares one
  // baseline, even while a bold face is still loading and a stand-in would measure differently.
  const regular = `400 ${px}px ${font.slice(font.indexOf("px ") + 3)}`;
  const known = metrics.get(regular);
  if (known) return known;
  ctx.font = regular;
  const m = ctx.measureText("Hg");
  const ascent = m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent : px * 0.72;
  const descent = m.actualBoundingBoxDescent > 0 ? m.actualBoundingBoxDescent : px * 0.22;
  const out = { ascent, descent };
  metrics.set(regular, out);
  return out;
}

/** Text broken into lines that fit `width` (at line breaks, then between words, a long word wherever it must). */
export function wrapLines(ctx: Ctx, font: string, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/(\s+)/);
    let line = "";
    for (const word of words) {
      const next = line + word;
      if (line === "" || measure(ctx, font, next) <= width) {
        line = next;
        continue;
      }
      out.push(line.trimEnd());
      line = word.trimStart();
      // A single word wider than the cell breaks wherever it must.
      while (line.length > 1 && measure(ctx, font, line) > width) {
        let cut = line.length - 1;
        while (cut > 1 && measure(ctx, font, line.slice(0, cut)) > width) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
}

/** Where a cell's text sits across: what it set, else numbers right, text left, booleans and errors centered. */
export function alignOf(cell: DrawCell): "l" | "c" | "r" {
  if (cell.style?.ha) return cell.style.ha;
  if (cell.kind === "number") return "r";
  if (cell.kind === "bool" || cell.kind === "error") return "c";
  return "l";
}

// ── Panes ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Pane {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  rows: [number, number];
  cols: [number, number];
  /** The rows and columns this pane may show (frozen ones, or the rest). */
  rowDomain: [number, number];
  colDomain: [number, number];
}

/** The four panes (frozen corner, frozen rows, frozen columns, the scrolled body), those with something to show. */
export function panesOf(rows: Axis, cols: Axis, view: Viewport): Pane[] {
  const fr = Math.min(view.frozenRows, rows.count);
  const fc = Math.min(view.frozenCols, cols.count);
  const fw = cols.start(fc);
  const fh = rows.start(fr);
  const bodyW = Math.max(0, view.width - HEADER_W - fw);
  const bodyH = Math.max(0, view.height - HEADER_H - fh);
  const rowSets: { y0: number; y1: number; span: [number, number]; domain: [number, number] }[] = [];
  if (fr > 0) {
    rowSets.push({
      y0: HEADER_H,
      y1: Math.min(view.height, HEADER_H + fh),
      span: [0, fr - 1],
      domain: [0, fr - 1],
    });
  }
  if (fr < rows.count && bodyH > 0) {
    rowSets.push({
      y0: HEADER_H + fh,
      y1: view.height,
      span: visibleSpan(rows, fr, view.scrollY, bodyH),
      domain: [fr, rows.count - 1],
    });
  }
  const colSets: { x0: number; x1: number; span: [number, number]; domain: [number, number] }[] = [];
  if (fc > 0) {
    colSets.push({
      x0: HEADER_W,
      x1: Math.min(view.width, HEADER_W + fw),
      span: [0, fc - 1],
      domain: [0, fc - 1],
    });
  }
  if (fc < cols.count && bodyW > 0) {
    colSets.push({
      x0: HEADER_W + fw,
      x1: view.width,
      span: visibleSpan(cols, fc, view.scrollX, bodyW),
      domain: [fc, cols.count - 1],
    });
  }
  const panes: Pane[] = [];
  for (const rs of rowSets) {
    for (const cs of colSets) {
      if (rs.span[1] < rs.span[0] || cs.span[1] < cs.span[0]) continue;
      panes.push({
        x0: cs.x0,
        y0: rs.y0,
        x1: cs.x1,
        y1: rs.y1,
        rows: rs.span,
        cols: cs.span,
        rowDomain: rs.domain,
        colDomain: cs.domain,
      });
    }
  }
  return panes;
}

/** A range's part in a pane, with which of its edges are the range's own (a range crossing the frozen line isn't closed there). */
function partIn(range: GridRange, pane: Pane) {
  const r1 = Math.max(range.r1, pane.rowDomain[0]);
  const r2 = Math.min(range.r2, pane.rowDomain[1]);
  const c1 = Math.max(range.c1, pane.colDomain[0]);
  const c2 = Math.min(range.c2, pane.colDomain[1]);
  if (r1 > r2 || c1 > c2) return null;
  return {
    part: { r1, c1, r2, c2 },
    top: r1 === range.r1,
    bottom: r2 === range.r2,
    left: c1 === range.c1,
    right: c2 === range.c2,
  };
}

// ── Drawing ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A position rounded to the device's pixel grid, so 1 px lines stay one pixel wide. */
const snap = (v: number, dpr: number) => Math.round(v * dpr) / dpr;

export function drawGrid(ctx: Ctx, frame: GridFrame): void {
  const { view, dpr, theme, source } = frame;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.cell;
  ctx.fillRect(0, 0, view.width, view.height);
  const panes = panesOf(source.rows, source.cols, view);
  for (const pane of panes) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x0, pane.y0, pane.x1 - pane.x0, pane.y1 - pane.y0);
    ctx.clip();
    drawCells(ctx, frame, pane);
    drawMarks(ctx, frame, pane);
    ctx.restore();
  }
  drawHeaders(ctx, frame);
  drawFrozenLines(ctx, frame);
}

interface Placed {
  r: number;
  c: number;
  cell: DrawCell;
  /** The box the text lays out in (a merge's whole box). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** How far the text may reach (its overflow), and whether it must be clipped to it. */
  left: number;
  right: number;
  clip: boolean;
  text: string;
}

function drawCells(ctx: Ctx, frame: GridFrame, pane: Pane): void {
  const { source, view, theme } = frame;
  const { rows, cols, merges } = source;
  const [rA, rB] = pane.rows;
  const [cA, cB] = pane.cols;
  const x = (c: number) => screenX(cols, c, view);
  const y = (r: number) => screenY(rows, r, view);
  const placed: Placed[] = [];
  /** Column boundaries (after column c) hidden in a row because text runs across them. */
  const openAfter = new Map<number, Set<number>>();
  const mergesDrawn = new Set<GridRange>();

  // Fills, and where each text goes.
  for (let r = rA; r <= rB; r++) {
    const top = y(r);
    const height = rows.size(r);
    for (let c = cA; c <= cB; c++) {
      const merge = merges.at(r, c);
      if (merge) {
        if (mergesDrawn.has(merge)) continue;
        mergesDrawn.add(merge);
        const box = rangeBox(merge, rows, cols, view);
        const head = source.cell(merge.r1, merge.c1);
        ctx.fillStyle = head?.style?.bg ? fillOf(head.style.bg, theme) : theme.cell;
        ctx.fillRect(box.x, box.y, box.w, box.h);
        if (head?.text && !isEditing(frame, merge.r1, merge.c1)) {
          placed.push({
            r: merge.r1,
            c: merge.c1,
            cell: head,
            ...box,
            left: box.x,
            right: box.x + box.w,
            clip: true,
            text: head.text,
          });
        }
        continue;
      }
      const cell = source.cell(r, c);
      if (!cell) continue;
      const left = x(c);
      const width = cols.size(c);
      if (cell.style?.bg) {
        ctx.fillStyle = fillOf(cell.style.bg, theme);
        ctx.fillRect(left, top, width, height);
      }
    }
    placeRow(ctx, frame, pane, r, placed, openAfter);
  }

  drawGridlines(ctx, frame, pane, openAfter);
  drawBorders(ctx, frame, pane);
  for (const p of placed) drawText(ctx, frame, p);
}

function isEditing(frame: GridFrame, r: number, c: number): boolean {
  return frame.editing !== null && frame.editing.r === r && frame.editing.c === c;
}

/** Lays out one row's texts: how far each overflows into empty neighbors, and which gridlines that hides. */
function placeRow(
  ctx: Ctx,
  frame: GridFrame,
  pane: Pane,
  r: number,
  placed: Placed[],
  openAfter: Map<number, Set<number>>,
): void {
  const { source, view } = frame;
  const { rows, cols, merges } = source;
  const [cA, cB] = pane.cols;
  const lo = Math.max(pane.colDomain[0], cA - OVERFLOW_SCAN);
  const hi = Math.min(pane.colDomain[1], cB + OVERFLOW_SCAN);
  const top = screenY(rows, r, view);
  const height = rows.size(r);
  const free = (c: number) => c >= lo && c <= hi && !merges.at(r, c) && !source.filled(r, c);
  for (let c = lo; c <= hi; c++) {
    if (merges.at(r, c)) continue;
    const cell = source.cell(r, c);
    if (!cell?.text || isEditing(frame, r, c)) continue;
    const left = screenX(cols, c, view);
    const width = cols.size(c);
    const { font } = fontOf(cell, frame.theme.font);
    const align = alignOf(cell);
    const avail = width - 2 * CELL_PAD_X;
    let text = cell.text;
    let from = c;
    let to = c;
    let clip = false;
    if (cell.style?.w) {
      clip = true;
    } else {
      const w = measure(ctx, font, text);
      if (w > avail) {
        if (cell.kind === "number") {
          // A number that doesn't fit is never cut: hashes say so, as in Excel.
          const hash = measure(ctx, font, "#");
          text = "#".repeat(Math.max(1, Math.floor(avail / Math.max(1, hash))));
        } else if (cell.kind === "text") {
          let room = width;
          const need = w + 2 * CELL_PAD_X;
          if (align === "l") {
            while (room < need && free(to + 1)) room += cols.size(++to);
          } else if (align === "r") {
            while (room < need && free(from - 1)) room += cols.size(--from);
          } else {
            while (room < need && (free(to + 1) || free(from - 1))) {
              if (free(to + 1)) room += cols.size(++to);
              if (room < need && free(from - 1)) room += cols.size(--from);
            }
          }
          clip = room < need;
        } else {
          clip = true;
        }
      }
    }
    // Only what reaches the visible window is drawn.
    if (to < cA || from > cB) continue;
    if (from !== to) {
      let open = openAfter.get(r);
      if (!open) {
        open = new Set();
        openAfter.set(r, open);
      }
      for (let k = from; k < to; k++) open.add(k);
    }
    const spanLeft = screenX(cols, from, view);
    const spanRight = screenX(cols, to, view) + cols.size(to);
    placed.push({ r, c, cell, x: left, y: top, w: width, h: height, left: spanLeft, right: spanRight, clip, text });
  }
}

function drawGridlines(ctx: Ctx, frame: GridFrame, pane: Pane, openAfter: Map<number, Set<number>>): void {
  const { source, view, theme, dpr } = frame;
  const { rows, cols, merges } = source;
  const [rA, rB] = pane.rows;
  const [cA, cB] = pane.cols;
  const px = 1 / dpr;
  ctx.fillStyle = theme.line;
  for (let r = rA; r <= rB; r++) {
    const top = screenY(rows, r, view);
    const bottom = snap(top + rows.size(r), dpr) - px;
    const open = openAfter.get(r);
    for (let c = cA; c <= cB; c++) {
      const left = screenX(cols, c, view);
      const right = snap(left + cols.size(c), dpr) - px;
      const merge = merges.at(r, c);
      // The line under the cell, unless a merge goes on below it.
      if (!merge || merge.r2 === r) ctx.fillRect(snap(left, dpr), bottom, right - snap(left, dpr) + px, px);
      // The line after it, unless text or a merge runs across it.
      if (open?.has(c)) continue;
      if (merge && merge.c2 !== c) continue;
      ctx.fillRect(right, snap(top, dpr), px, bottom - snap(top, dpr) + px);
    }
  }
}

function drawBorders(ctx: Ctx, frame: GridFrame, pane: Pane): void {
  const { source, view, theme, dpr } = frame;
  const { rows, cols, merges } = source;
  const [rA, rB] = pane.rows;
  const [cA, cB] = pane.cols;
  for (let r = rA; r <= rB; r++) {
    for (let c = cA; c <= cB; c++) {
      const cell = source.cell(r, c);
      const bd = cell?.style?.bd;
      if (!bd) continue;
      const merge = merges.at(r, c);
      const box = merge
        ? rangeBox(merge, rows, cols, view)
        : { x: screenX(cols, c, view), y: screenY(rows, r, view), w: cols.size(c), h: rows.size(r) };
      const side = (s: { w: number; c?: string } | undefined, draw: (w: number) => void) => {
        if (!s) return;
        // A border colored black stays visible on the dark theme's cells.
        ctx.fillStyle = s.c && (!theme.dark || luminance(s.c) > 0.05) ? s.c : theme.ink;
        draw(s.w === 3 ? 3 : s.w === 2 ? 2 : 1);
      };
      const x0 = snap(box.x, dpr);
      const y0 = snap(box.y, dpr);
      const x1 = snap(box.x + box.w, dpr);
      const y1 = snap(box.y + box.h, dpr);
      side(bd.t, (w) => ctx.fillRect(x0 - w / 2, y0 - w / 2, x1 - x0 + w, w));
      side(bd.b, (w) => ctx.fillRect(x0 - w / 2, y1 - w / 2, x1 - x0 + w, w));
      side(bd.l, (w) => ctx.fillRect(x0 - w / 2, y0 - w / 2, w, y1 - y0 + w));
      side(bd.r, (w) => ctx.fillRect(x1 - w / 2, y0 - w / 2, w, y1 - y0 + w));
    }
  }
}

function drawText(ctx: Ctx, frame: GridFrame, p: Placed): void {
  const { theme } = frame;
  const { font, px } = fontOf(p.cell, theme.font);
  const { ascent, descent } = fontMetrics(ctx, font, px);
  const align = alignOf(p.cell);
  const valign = p.cell.style?.va ?? "b";
  ctx.font = font;
  ctx.fillStyle = textColorOf(p.cell, theme);
  ctx.textBaseline = "alphabetic";
  const lineH = Math.round(px * 1.25);
  const lines = p.cell.style?.w ? wrapLines(ctx, font, p.text, Math.max(8, p.w - 2 * CELL_PAD_X)) : [p.text];
  const blockH = (lines.length - 1) * lineH + ascent + descent;
  const firstBase =
    valign === "t"
      ? p.y + CELL_PAD_Y + ascent
      : valign === "m"
        ? p.y + (p.h - blockH) / 2 + ascent
        : p.y + p.h - CELL_PAD_Y - descent - (lines.length - 1) * lineH;
  if (p.clip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(p.left, p.y, p.right - p.left, p.h);
    ctx.clip();
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const w = measure(ctx, font, line);
    const tx = align === "l" ? p.x + CELL_PAD_X : align === "r" ? p.x + p.w - CELL_PAD_X - w : p.x + (p.w - w) / 2;
    const base = Math.round(firstBase + i * lineH);
    ctx.fillText(line, tx, base);
    if (p.cell.style?.u) ctx.fillRect(tx, base + Math.max(1, Math.round(px * 0.12)), w, Math.max(1, px / 13));
    if (p.cell.style?.x) ctx.fillRect(tx, Math.round(base - px * 0.3), w, Math.max(1, px / 13));
  }
  if (p.clip) ctx.restore();
}

/** The selection, people's and agents' ranges, references and the fill handle, inside one pane. */
function drawMarks(ctx: Ctx, frame: GridFrame, pane: Pane): void {
  const { source, view, theme, dpr } = frame;
  const { rows, cols } = source;
  const box = (range: GridRange) => rangeBox(range, rows, cols, view);
  const outline = (
    b: { x: number; y: number; w: number; h: number },
    edges: { top: boolean; bottom: boolean; left: boolean; right: boolean },
    width: number,
    inset: boolean,
  ) => {
    const o = inset ? 0 : width / 2;
    const x0 = snap(b.x, dpr) - o;
    const y0 = snap(b.y, dpr) - o;
    const x1 = snap(b.x + b.w, dpr) + o;
    const y1 = snap(b.y + b.h, dpr) + o;
    if (edges.top) ctx.fillRect(x0, y0, x1 - x0, width);
    if (edges.bottom) ctx.fillRect(x0, y1 - width, x1 - x0, width);
    if (edges.left) ctx.fillRect(x0, y0, width, y1 - y0);
    if (edges.right) ctx.fillRect(x1 - width, y0, width, y1 - y0);
  };

  for (const mark of frame.marks) {
    const at = partIn(mark.range, pane);
    if (!at) continue;
    const strength = markStrength(mark, frame.now ?? 0);
    if (strength <= 0) continue;
    const b = box(at.part);
    if (mark.wash && mark.wash > 0) {
      ctx.fillStyle = withAlpha(mark.color, mark.wash * strength);
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
    if (mark.fade) continue;
    if (mark.dashed) {
      ctx.save();
      ctx.strokeStyle = mark.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(snap(b.x, dpr) + 1, snap(b.y, dpr) + 1, b.w - 2, b.h - 2);
      ctx.restore();
      continue;
    }
    ctx.fillStyle = mark.color;
    outline(b, at, mark.width ?? 2, false);
  }

  if (frame.fillTo) {
    const at = partIn(frame.fillTo, pane);
    if (at) {
      ctx.save();
      ctx.strokeStyle = theme.ink;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      const b = box(at.part);
      ctx.strokeRect(snap(b.x, dpr) + 0.5, snap(b.y, dpr) + 0.5, b.w - 1, b.h - 1);
      ctx.restore();
    }
  }

  const sel = frame.selection;
  if (!sel) return;
  const merge = source.merges.at(sel.active.r, sel.active.c);
  const activeRange = merge ?? { r1: sel.active.r, c1: sel.active.c, r2: sel.active.r, c2: sel.active.c };
  const act = partIn(activeRange, pane);
  const at = partIn(sel.range, pane);
  const single =
    sel.range.r1 === activeRange.r1 &&
    sel.range.c1 === activeRange.c1 &&
    sel.range.r2 === activeRange.r2 &&
    sel.range.c2 === activeRange.c2;
  if (at && !single) {
    // The range's tint goes around the active cell, which stays clear as in other spreadsheets.
    const b = box(at.part);
    ctx.fillStyle = theme.selFill;
    if (act) {
      const a = box(act.part);
      const right = b.x + b.w;
      const bottom = b.y + b.h;
      ctx.fillRect(b.x, b.y, b.w, Math.max(0, a.y - b.y));
      ctx.fillRect(b.x, a.y + a.h, b.w, Math.max(0, bottom - a.y - a.h));
      ctx.fillRect(b.x, a.y, Math.max(0, a.x - b.x), a.h);
      ctx.fillRect(a.x + a.w, a.y, Math.max(0, right - a.x - a.w), a.h);
    } else {
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
    ctx.fillStyle = theme.ink;
    outline(b, at, 1, false);
  }
  // The active cell: a 2 px ink border inside it.
  if (act) {
    ctx.fillStyle = theme.ink;
    outline(box(act.part), act, 2, true);
  }
  if (frame.fillHandle) {
    const corner = partIn({ r1: sel.range.r2, c1: sel.range.c2, r2: sel.range.r2, c2: sel.range.c2 }, pane);
    if (corner) {
      const b = box(sel.range);
      const cx = snap(b.x + b.w, dpr);
      const cy = snap(b.y + b.h, dpr);
      const half = FILL_HANDLE / 2;
      ctx.fillStyle = theme.cell;
      ctx.fillRect(cx - half - 1, cy - half - 1, FILL_HANDLE + 2, FILL_HANDLE + 2);
      ctx.fillStyle = theme.ink;
      ctx.fillRect(cx - half, cy - half, FILL_HANDLE, FILL_HANDLE);
    }
  }
}

/** The fill handle's box on screen (for hit tests), or null when it isn't shown. */
export function fillHandleBox(range: GridRange, rows: Axis, cols: Axis, view: Viewport, dpr: number) {
  const b = rangeBox(range, rows, cols, view);
  const cx = snap(b.x + b.w, dpr);
  const cy = snap(b.y + b.h, dpr);
  return { x: cx - FILL_HANDLE / 2 - 2, y: cy - FILL_HANDLE / 2 - 2, w: FILL_HANDLE + 4, h: FILL_HANDLE + 4 };
}

function drawHeaders(ctx: Ctx, frame: GridFrame): void {
  const { source, view, theme, dpr } = frame;
  const { rows, cols } = source;
  const px = 1 / dpr;
  const sel = frame.selection?.range ?? null;
  const whole = frame.selection?.whole;
  const fc = Math.min(view.frozenCols, cols.count);
  const fr = Math.min(view.frozenRows, rows.count);
  const fw = cols.start(fc);
  const fh = rows.start(fr);
  const font = `${HEADER_FONT_PX}px ${theme.font}`;
  const bold = `600 ${HEADER_FONT_PX}px ${theme.font}`;
  ctx.textBaseline = "middle";

  // Column letters.
  ctx.fillStyle = theme.header;
  ctx.fillRect(HEADER_W, 0, view.width - HEADER_W, HEADER_H);
  const colSpans: [number, number, number, number][] = [];
  if (fc > 0) colSpans.push([0, fc - 1, HEADER_W, HEADER_W + fw]);
  if (fc < cols.count) {
    const [a, b] = visibleSpan(cols, fc, view.scrollX, Math.max(0, view.width - HEADER_W - fw));
    if (b >= a) colSpans.push([a, b, HEADER_W + fw, view.width]);
  }
  for (const [a, b, x0, x1] of colSpans) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0, HEADER_H);
    ctx.clip();
    for (let c = a; c <= b; c++) {
      const left = screenX(cols, c, view);
      const w = cols.size(c);
      const chosen = sel !== null && c >= sel.c1 && c <= sel.c2;
      const full = chosen && (whole === "cols" || whole === "all");
      if (chosen) {
        ctx.fillStyle = theme.headerSel;
        ctx.fillRect(left, 0, w, HEADER_H);
        // A whole column: the same calm fill, a 2 px ink edge along the cells.
        if (full) {
          ctx.fillStyle = theme.ink;
          ctx.fillRect(left, HEADER_H - 2, w, 2);
        }
      }
      ctx.fillStyle = chosen ? theme.ink : theme.muted;
      ctx.font = chosen ? bold : font;
      ctx.textAlign = "center";
      if (w > 8) ctx.fillText(colName(c), left + w / 2, HEADER_H / 2 + 0.5);
      ctx.fillStyle = theme.line;
      ctx.fillRect(snap(left + w, dpr) - px, 0, px, HEADER_H);
    }
    ctx.restore();
  }

  // Row numbers.
  ctx.fillStyle = theme.header;
  ctx.fillRect(0, HEADER_H, HEADER_W, view.height - HEADER_H);
  const rowSpans: [number, number, number, number][] = [];
  if (fr > 0) rowSpans.push([0, fr - 1, HEADER_H, HEADER_H + fh]);
  if (fr < rows.count) {
    const [a, b] = visibleSpan(rows, fr, view.scrollY, Math.max(0, view.height - HEADER_H - fh));
    if (b >= a) rowSpans.push([a, b, HEADER_H + fh, view.height]);
  }
  for (const [a, b, y0, y1] of rowSpans) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y0, HEADER_W, y1 - y0);
    ctx.clip();
    for (let r = a; r <= b; r++) {
      const top = screenY(rows, r, view);
      const h = rows.size(r);
      const chosen = sel !== null && r >= sel.r1 && r <= sel.r2;
      const full = chosen && (whole === "rows" || whole === "all");
      if (chosen) {
        ctx.fillStyle = theme.headerSel;
        ctx.fillRect(0, top, HEADER_W, h);
        if (full) {
          ctx.fillStyle = theme.ink;
          ctx.fillRect(HEADER_W - 2, top, 2, h);
        }
      }
      ctx.fillStyle = chosen ? theme.ink : theme.muted;
      ctx.font = chosen ? bold : font;
      ctx.textAlign = "center";
      if (h > 8) ctx.fillText(String(r + 1), HEADER_W / 2, top + h / 2 + 0.5);
      ctx.fillStyle = theme.line;
      ctx.fillRect(0, snap(top + h, dpr) - px, HEADER_W, px);
    }
    ctx.restore();
  }

  // The corner (selects everything), and the headers' edges.
  ctx.fillStyle = theme.header;
  ctx.fillRect(0, 0, HEADER_W, HEADER_H);
  if (whole === "all") {
    ctx.fillStyle = theme.headerSel;
    ctx.fillRect(0, 0, HEADER_W, HEADER_H);
  }
  ctx.fillStyle = theme.line;
  ctx.fillRect(0, snap(HEADER_H, dpr) - px, view.width, px);
  ctx.fillRect(snap(HEADER_W, dpr) - px, 0, px, view.height);
  ctx.textAlign = "start";
}

function drawFrozenLines(ctx: Ctx, frame: GridFrame): void {
  const { source, view, theme, dpr } = frame;
  const fc = Math.min(view.frozenCols, source.cols.count);
  const fr = Math.min(view.frozenRows, source.rows.count);
  ctx.fillStyle = theme.lineStrong;
  if (fc > 0) ctx.fillRect(snap(HEADER_W + source.cols.start(fc), dpr) - 1, 0, 2, view.height);
  if (fr > 0) ctx.fillRect(0, snap(HEADER_H + source.rows.start(fr), dpr) - 1, view.width, 2);
}
