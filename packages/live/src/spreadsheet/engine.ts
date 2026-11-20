/**
 * The spreadsheet engine (ADR 0196 §2): every app, the server and the agents' tools compute a live spreadsheet's
 * values with it, since values are never stored. It evaluates lazily and remembers what it computed, with what each
 * formula read (cells, ranges, other sheets), so a change recomputes only what depends on it: an edited cell drops
 * its dependents, a row or column inserted, deleted or moved drops its sheet and the sheets that read it, and a
 * sheet added, removed or renamed drops everything. Changes are taken in before any observer of the document runs,
 * so the grid on screen never reads a stale value, and listeners hear which cells to redraw once the transaction
 * ends.
 *
 * Cycles are found while evaluating: every cell on one shows `#REF!` with "circular" in its tip, whatever order
 * devices happened to compute it in. A chain of formulas deeper than `MAX_DEPTH` is computed in stages instead of
 * on one deep stack, so a 50,000-row running total works on the phone as on the server. Each formula has a step
 * budget (`#CALC!` past it); RAND is seeded per cell from the document; TODAY and NOW read the clock the app gives,
 * refreshed by `tick`.
 */
import * as Y from "yjs";
import { formatValue, NUMBER_FORMATS } from "./format";
import { parseStored, toDisplay } from "./formula";
import { cellResult, evaluate } from "./formula/evaluate";
import {
  type Axis,
  axisOf,
  colsArray,
  forgetChanged,
  rowsArray,
  sheetIdByName,
  sheetsOf,
  txVersion,
} from "./formula/grid";
import {
  type ArrValue,
  BudgetExceeded,
  CIRCULAR,
  type Env,
  ERR,
  type EvalHost,
  isErr,
  makeArr,
  type RefValue,
  VOLATILE_TIME,
} from "./formula/runtime";
import { FormulaError } from "./formula/types";
import { valueInput } from "./input";
import { type SheetLocale, sheetLocale } from "./locale";
import type { CellValue, ErrorCode } from "./values";

/** How deep formulas reading formulas go on one stack before the rest is computed in a later stage. */
export const MAX_DEPTH = 100;
/** Rows per block of a column's remembered values (large ranges read whole blocks). */
const BLOCK = 256;
/** Rows and columns per bucket of the index that finds the ranges a changed cell falls in. */
const BUCKET_ROWS = 512;
const BUCKET_COLS = 32;
/** Past this many changed cells on a sheet, ranges are checked against all of them at once. */
const SWEEP_AT = 256;

export interface SheetChange {
  sheetId: string;
  /** Everything on the sheet may have changed. */
  all?: boolean;
  /** Cells (`rowId:colId`) whose value or look may have changed. */
  cells?: Set<string>;
}

export interface SheetEngineOptions {
  /** The clock TODAY and NOW read (read again on `tick`). */
  now?: () => Date;
  /**
   * The language formulas compute text in (`=1,5&""`, TEXT's codes, VALUE): the person's own in the apps, so what
   * they type in their language works. English when not given.
   */
  locale?: string | SheetLocale;
}

interface RawCell {
  v?: number | string | boolean;
  f?: string;
  nf?: string;
}

/** A formula's computed value and what it read, kept until something it read changes. */
interface FState {
  sheet: string;
  key: string;
  value: CellValue;
  f: string;
  /** Cells read one by one, as sheet and key pairs. */
  cells: string[];
  ranges: RangeEntry[];
  /** Other sheets it resolved references on. */
  sheets: string[];
  volatile: number;
}

interface Frame {
  gk: string;
  cells: string[];
  ranges: RangeEntry[];
  sheets: string[];
  sheet: string;
}

interface RangeEntry {
  id: string;
  sheet: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  readers: Set<FState>;
  buckets: number[];
  /** Times read; from the second read on its values are kept (`cache`) until anything in it changes. */
  reads: number;
  cache: ArrValue | null;
}

interface SheetCalc {
  memo: Map<string, FState>;
  /** Formulas reading each cell (one, or a set). */
  readers: Map<string, FState | Set<FState>>;
  ranges: Map<string, RangeEntry>;
  buckets: Map<number, Set<RangeEntry>>;
  /** Remembered values by column, then block of rows. */
  blocks: Map<number, Map<number, CellValue[]>>;
}

interface SheetInfo {
  rows: Axis;
  cols: Axis;
  cells: Y.Map<unknown> | null;
}

const NO_AXIS: Axis = { ids: [], pos: new Map() };

interface PendingCell {
  gk: string;
  sheet: string;
  rowId: string;
  colId: string;
  key: string;
  f: string;
}

/** Thrown when evaluation goes deeper than `MAX_DEPTH`: the cell is computed first, then the evaluation retried. */
class Deeper extends Error {
  constructor(
    readonly cell: PendingCell,
    readonly chain: string[],
  ) {
    super("Deeper");
  }
}

const SEP = "\u0001";

function gkOf(sheet: string, key: string): string {
  return `${sheet}${SEP}${key}`;
}

function readRaw(raw: unknown): RawCell | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || raw instanceof Uint8Array) return undefined;
  const r = raw as Record<string, unknown>;
  const out: RawCell = {};
  const v = r.v;
  if (typeof v === "number" ? Number.isFinite(v) : typeof v === "string" || typeof v === "boolean") {
    out.v = v as number | string | boolean;
  }
  if (typeof r.f === "string" && r.f.length > 0) out.f = r.f;
  const s = r.s;
  if (typeof s === "object" && s !== null && typeof (s as { nf?: unknown }).nf === "string") {
    out.nf = (s as { nf: string }).nf;
  }
  return out;
}

/** A stable number in [0, 1) from text (cyrb53), for RAND. */
function unitHash(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)) / 2 ** 53;
}

const DATE_FNS = new Set(["TODAY", "DATE", "DATEVALUE", "EDATE", "EOMONTH", "WORKDAY", "WORKDAY.INTL"]);
const SAME_FORMAT_FNS = new Set([
  "SUM",
  "MIN",
  "MAX",
  "AVERAGE",
  "MEDIAN",
  "ROUND",
  "ROUNDUP",
  "ROUNDDOWN",
  "ABS",
  "SUMIF",
  "SUMIFS",
  "AVERAGEIF",
  "AVERAGEIFS",
  "MINIFS",
  "MAXIFS",
  "LARGE",
  "SMALL",
]);

export class SheetEngine {
  private readonly doc: Y.Doc;
  private readonly clock: () => Date;
  private nowValue: Date;
  private calc: SheetLocale;
  private readonly sheets = new Map<string, SheetCalc>();
  /** Formulas on one sheet reading other sheets: sheet read → readers. */
  private readonly sheetReaders = new Map<string, Set<FState>>();
  private readonly volatile = new Set<FState>();
  private readonly listeners = new Set<(change: SheetChange) => void>();
  private report = new Map<string, SheetChange>();
  private readonly stack: Frame[] = [];
  private readonly inProgress = new Set<string>();
  private readonly pendingIndex = new Map<string, number>();
  private pending: { cell: PendingCell; chain: string[] }[] = [];
  private readonly cyclic = new Set<string>();
  /** Values computed while a transaction is open, kept only for that state of it. */
  private transient: Map<string, CellValue> | null = null;
  private transientTx: Y.Transaction | null = null;
  private transientVersion = -1;
  private destroyed = false;
  private computedCount = 0;
  private readonly sheetsMap: Y.Map<Y.Map<unknown>>;
  private readonly meta: Y.Map<unknown>;
  private readonly infos = new Map<string, SheetInfo | null>();
  private readonly host: EvalHost;
  private readonly onBefore = (tr: Y.Transaction) => this.takeIn(tr);
  private readonly onAfter = () => this.flush();

  constructor(doc: Y.Doc, opts?: SheetEngineOptions) {
    this.doc = doc;
    this.sheetsMap = sheetsOf(doc);
    this.meta = doc.getMap("meta");
    this.clock = opts?.now ?? (() => new Date());
    this.nowValue = this.clock();
    const locale = opts?.locale ?? "en-US";
    this.calc = typeof locale === "string" ? sheetLocale(locale) : locale;
    this.host = this.makeHost();
    doc.on("beforeObserverCalls", this.onBefore);
    doc.on("afterTransaction", this.onAfter);
  }

  // Reading values ------------------------------------------------------------------------------------------------

  /** A cell's value: its formula computed, or what it holds; null when empty. */
  value(sheetId: string, rowId: string, colId: string): CellValue {
    this.prepare();
    return this.valueOf(sheetId, rowId, colId);
  }

  valueAt(sheetId: string, row: number, col: number): CellValue {
    const rowId = this.rowIdAt(sheetId, row);
    const colId = this.colIdAt(sheetId, col);
    return rowId === undefined || colId === undefined ? null : this.value(sheetId, rowId, colId);
  }

  /** A cell's text as shown, per its number format (a formula without one takes its inputs' look: dates, money). */
  display(sheetId: string, rowId: string, colId: string, locale: SheetLocale): string {
    const v = this.value(sheetId, rowId, colId);
    if (v === null) return "";
    const raw = this.raw(sheetId, `${rowId}:${colId}`);
    const nf = raw?.nf ?? (raw?.f !== undefined ? this.inferFormat(sheetId, raw.f, locale, 0) : undefined);
    return formatValue(v, nf, locale).text;
  }

  /** What the cell editor shows: the formula in the person's language, or the value as they would type it. */
  input(sheetId: string, rowId: string, colId: string, locale: SheetLocale): string {
    this.prepare();
    const raw = this.raw(sheetId, `${rowId}:${colId}`);
    if (!raw) return "";
    if (raw.f !== undefined) return toDisplay(raw.f, { doc: this.doc, sheetId, locale });
    return valueInput(raw.v, raw.nf, locale);
  }

  /** The error a cell shows, if any, and whether it comes from a circular reference. */
  errorInfo(sheetId: string, rowId: string, colId: string): { code: ErrorCode; circular?: boolean } | null {
    const v = this.value(sheetId, rowId, colId);
    if (!isErr(v)) return null;
    return v === CIRCULAR ? { code: v.error, circular: true } : { code: v.error };
  }

  /** How many formulas this engine has computed so far (each recomputation counts), for tests and diagnostics. */
  computations(): number {
    return this.computedCount;
  }

  /** Hears which cells to redraw after each change to the document (and after `tick`). */
  onChange(listener: (changed: SheetChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reads the clock again: formulas with TODAY recompute when the date changed, those with NOW always. */
  tick(): void {
    if (this.destroyed) return;
    const before = this.nowValue;
    const now = this.clock();
    this.nowValue = now;
    const dayChanged =
      before.getFullYear() !== now.getFullYear() ||
      before.getMonth() !== now.getMonth() ||
      before.getDate() !== now.getDate();
    const timeChanged = Math.floor(before.getTime() / 1000) !== Math.floor(now.getTime() / 1000);
    if (!dayChanged && !timeChanged) return;
    const hit = [...this.volatile].filter((s) => dayChanged || s.volatile >= VOLATILE_TIME);
    if (hit.length === 0) return;
    const work: [string, string][] = [];
    for (const s of hit) this.dropState(s, work);
    this.propagate(work);
    this.flush();
  }

  /** The language formulas compute text in; changing it recomputes everything. */
  setLocale(locale: string | SheetLocale): void {
    const next = typeof locale === "string" ? sheetLocale(locale) : locale;
    if (next.tag === this.calc.tag) return;
    this.calc = next;
    this.dropAll();
    this.flush();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.doc.off("beforeObserverCalls", this.onBefore);
    this.doc.off("afterTransaction", this.onAfter);
    this.listeners.clear();
    this.sheets.clear();
    this.sheetReaders.clear();
    this.volatile.clear();
    this.report.clear();
  }

  // Positions -----------------------------------------------------------------------------------------------------

  rowIndex(sheetId: string, rowId: string): number {
    this.prepare();
    return this.rows(sheetId).pos.get(rowId) ?? -1;
  }

  colIndex(sheetId: string, colId: string): number {
    this.prepare();
    return this.cols(sheetId).pos.get(colId) ?? -1;
  }

  rowIdAt(sheetId: string, i: number): string | undefined {
    this.prepare();
    return this.rows(sheetId).ids[i];
  }

  colIdAt(sheetId: string, i: number): string | undefined {
    this.prepare();
    return this.cols(sheetId).ids[i];
  }

  size(sheetId: string): { rows: number; cols: number } {
    this.prepare();
    return { rows: this.rows(sheetId).ids.length, cols: this.cols(sheetId).ids.length };
  }

  // Document access ------------------------------------------------------------------------------------------------

  /**
   * A sheet's map, rows, columns and cells, kept between transactions (every transaction's end drops them, so a
   * reader never sees a stale order) and read afresh while a transaction that changed the document is open.
   */
  private info(sheetId: string): SheetInfo | null {
    const lasting = this.transient === null;
    if (lasting) {
      const hit = this.infos.get(sheetId);
      if (hit !== undefined) return hit;
    }
    const map = this.sheetsMap.get(sheetId);
    let out: SheetInfo | null = null;
    if (map instanceof Y.Map) {
      const cells = map.get("cells");
      out = {
        rows: axisOf(rowsArray(map)),
        cols: axisOf(colsArray(map)),
        cells: cells instanceof Y.Map ? cells : null,
      };
    }
    if (lasting) this.infos.set(sheetId, out);
    return out;
  }

  private rows(sheetId: string): Axis {
    return this.info(sheetId)?.rows ?? NO_AXIS;
  }

  private cols(sheetId: string): Axis {
    return this.info(sheetId)?.cols ?? NO_AXIS;
  }

  private raw(sheetId: string, key: string): RawCell | undefined {
    return readRaw(this.info(sheetId)?.cells?.get(key));
  }

  private calcOf(sheetId: string): SheetCalc {
    let s = this.sheets.get(sheetId);
    if (!s) {
      s = { memo: new Map(), readers: new Map(), ranges: new Map(), buckets: new Map(), blocks: new Map() };
      this.sheets.set(sheetId, s);
    }
    return s;
  }

  // Evaluation -----------------------------------------------------------------------------------------------------

  /** Picks where computed values go: the lasting memory, or one for an open transaction that changed the document. */
  private prepare(): void {
    const tr = this.doc._transaction;
    if (!tr || tr.changed.size === 0) {
      this.transient = null;
      this.transientTx = null;
      return;
    }
    const version = txVersion(this.doc, tr);
    if (this.transient && this.transientTx === tr && this.transientVersion === version) return;
    this.transient = new Map();
    this.transientTx = tr;
    this.transientVersion = version;
  }

  private valueOf(sheet: string, rowId: string, colId: string, known?: string): CellValue {
    const key = known ?? `${rowId}:${colId}`;
    if (this.transient === null) {
      const memo = this.sheets.get(sheet)?.memo.get(key);
      if (memo) return memo.value;
    }
    const raw = this.info(sheet)?.cells?.get(key) as { v?: unknown; f?: unknown } | undefined;
    if (typeof raw !== "object" || raw === null) return null;
    const f = raw.f;
    if (typeof f === "string" && f.length > 0) {
      const cell: PendingCell = { gk: gkOf(sheet, key), sheet, rowId, colId, key, f };
      return this.stack.length > 0 ? this.compute(cell) : this.top(cell);
    }
    const v = raw.v;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    return typeof v === "string" || typeof v === "boolean" ? v : null;
  }

  private remembered(cell: PendingCell): CellValue | undefined {
    if (this.transient) return this.transient.get(cell.gk);
    const s = this.sheets.get(cell.sheet)?.memo.get(cell.key);
    if (s && s.f === cell.f) return s.value;
    return undefined;
  }

  /** A top-level read: computes in stages when the formulas it needs go deeper than one stack should. */
  private top(cell: PendingCell): CellValue {
    const hit = this.remembered(cell);
    if (hit !== undefined) return hit;
    try {
      return this.compute(cell);
    } catch (e) {
      if (!(e instanceof Deeper)) throw e;
      this.pending = [
        { cell, chain: e.chain },
        { cell: e.cell, chain: [] },
      ];
      this.pendingIndex.set(cell.gk, 0);
      this.pendingIndex.set(e.cell.gk, 1);
    } finally {
      if (this.pending.length === 0) this.cyclic.clear();
    }
    try {
      while (this.pending.length > 0) {
        const p = this.pending[this.pending.length - 1] as { cell: PendingCell; chain: string[] };
        try {
          this.compute(p.cell);
          this.pending.pop();
          this.pendingIndex.delete(p.cell.gk);
        } catch (e) {
          if (!(e instanceof Deeper)) throw e;
          p.chain = e.chain;
          this.pending.push({ cell: e.cell, chain: [] });
          this.pendingIndex.set(e.cell.gk, this.pending.length - 1);
        }
      }
    } finally {
      this.pending = [];
      this.pendingIndex.clear();
      this.cyclic.clear();
    }
    return this.remembered(cell) ?? ERR["#CALC!"];
  }

  private markStackFrom(index: number): void {
    for (let i = Math.max(0, index); i < this.stack.length; i++) this.cyclic.add((this.stack[i] as Frame).gk);
  }

  private compute(cell: PendingCell): CellValue {
    const hit = this.remembered(cell);
    if (hit !== undefined) return hit;
    if (this.inProgress.has(cell.gk)) {
      let i = this.stack.length - 1;
      while (i >= 0 && (this.stack[i] as Frame).gk !== cell.gk) i--;
      this.markStackFrom(i);
      return CIRCULAR;
    }
    const waiting = this.pendingIndex.get(cell.gk);
    if (waiting !== undefined && waiting < this.pending.length - 1) {
      for (let k = waiting; k < this.pending.length - 1; k++) {
        for (const gk of (this.pending[k] as { chain: string[] }).chain) this.cyclic.add(gk);
      }
      this.markStackFrom(0);
      return CIRCULAR;
    }
    if (this.stack.length >= MAX_DEPTH) {
      throw new Deeper(
        cell,
        this.stack.map((f) => f.gk),
      );
    }
    const info = this.info(cell.sheet);
    const row = info?.rows.pos.get(cell.rowId) ?? -1;
    const col = info?.cols.pos.get(cell.colId) ?? -1;
    const frame: Frame = { gk: cell.gk, cells: [], ranges: [], sheets: [], sheet: cell.sheet };
    this.computedCount++;
    this.stack.push(frame);
    this.inProgress.add(cell.gk);
    let value: CellValue;
    let volatile = 0;
    try {
      const env: Env = {
        host: this.host,
        sheet: cell.sheet,
        row,
        col,
        rowId: cell.rowId,
        colId: cell.colId,
        steps: 0,
        rand: 0,
        volatile: 0,
        calc: this.calc,
        evaluate,
      };
      try {
        value = cellResult(evaluate(parseStored(cell.f), env), env);
      } catch (e) {
        if (e instanceof Deeper) throw e;
        // Past the budget, or the JavaScript stack in spite of the stages: too much work. A stored formula that
        // doesn't parse (a hostile client's) reads as an unknown name; anything else is the engine's own fault, and
        // one cell shows it instead of the whole sheet failing.
        if (e instanceof BudgetExceeded || e instanceof RangeError) value = ERR["#CALC!"];
        else if (e instanceof FormulaError) value = ERR["#NAME?"];
        else value = ERR["#VALUE!"];
      }
      volatile = env.volatile;
    } finally {
      this.stack.pop();
      this.inProgress.delete(cell.gk);
    }
    if (this.cyclic.has(cell.gk)) {
      this.cyclic.delete(cell.gk);
      value = CIRCULAR;
    }
    this.remember(cell, value, frame, volatile);
    return value;
  }

  private remember(cell: PendingCell, value: CellValue, frame: Frame, volatile: number): void {
    if (this.transient) {
      this.transient.set(cell.gk, value);
      return;
    }
    const calc = this.calcOf(cell.sheet);
    const old = calc.memo.get(cell.key);
    if (old) this.unlink(old);
    const state: FState = {
      sheet: cell.sheet,
      key: cell.key,
      value,
      f: cell.f,
      cells: frame.cells,
      ranges: frame.ranges,
      sheets: frame.sheets,
      volatile,
    };
    calc.memo.set(cell.key, state);
    for (let i = 0; i < state.cells.length; i += 2) {
      const readers = this.calcOf(state.cells[i] as string).readers;
      const key = state.cells[i + 1] as string;
      const had = readers.get(key);
      if (had === undefined) readers.set(key, state);
      else if (had instanceof Set) had.add(state);
      else if (had !== state) readers.set(key, new Set([had, state]));
    }
    for (const r of state.ranges) r.readers.add(state);
    for (const s of state.sheets) {
      let set = this.sheetReaders.get(s);
      if (!set) {
        set = new Set();
        this.sheetReaders.set(s, set);
      }
      set.add(state);
    }
    if (volatile > 0) this.volatile.add(state);
  }

  /** Removes a formula's links to what it read. */
  private unlink(state: FState): void {
    for (let i = 0; i < state.cells.length; i += 2) {
      const readers = this.sheets.get(state.cells[i] as string)?.readers;
      if (!readers) continue;
      const key = state.cells[i + 1] as string;
      const had = readers.get(key);
      if (had === state) readers.delete(key);
      else if (had instanceof Set) {
        had.delete(state);
        if (had.size === 0) readers.delete(key);
      }
    }
    for (const r of state.ranges) {
      r.readers.delete(state);
      if (r.readers.size === 0) this.dropRange(r);
    }
    for (const s of state.sheets) this.sheetReaders.get(s)?.delete(state);
    this.volatile.delete(state);
  }

  private dropRange(r: RangeEntry): void {
    const calc = this.sheets.get(r.sheet);
    if (!calc || calc.ranges.get(r.id) !== r) return;
    calc.ranges.delete(r.id);
    for (const b of r.buckets) {
      const set = calc.buckets.get(b);
      if (!set) continue;
      set.delete(r);
      if (set.size === 0) calc.buckets.delete(b);
    }
  }

  private rangeEntry(ref: RefValue): RangeEntry {
    const calc = this.calcOf(ref.sheet);
    const id = `${ref.r1},${ref.c1},${ref.r2},${ref.c2}`;
    let r = calc.ranges.get(id);
    if (r) return r;
    r = {
      id,
      sheet: ref.sheet,
      r1: ref.r1,
      c1: ref.c1,
      r2: ref.r2,
      c2: ref.c2,
      readers: new Set(),
      buckets: [],
      reads: 0,
      cache: null,
    };
    for (let br = Math.floor(ref.r1 / BUCKET_ROWS); br <= Math.floor(ref.r2 / BUCKET_ROWS); br++) {
      for (let bc = Math.floor(ref.c1 / BUCKET_COLS); bc <= Math.floor(ref.c2 / BUCKET_COLS); bc++) {
        const b = br * 1024 + bc;
        r.buckets.push(b);
        let set = calc.buckets.get(b);
        if (!set) {
          set = new Set();
          calc.buckets.set(b, set);
        }
        set.add(r);
      }
    }
    calc.ranges.set(id, r);
    return r;
  }

  /** A cell's value by position, for formulas; empty past the grid's end. */
  private read(sheet: string, row: number, col: number): CellValue {
    const info = this.info(sheet);
    const rowId = info?.rows.ids[row];
    const colId = info?.cols.ids[col];
    if (rowId === undefined || colId === undefined) return null;
    return this.valueOf(sheet, rowId, colId);
  }

  /** A block of a column's values, remembered until one of its cells changes. */
  private block(sheet: string, col: number, b: number): CellValue[] {
    const calc = this.calcOf(sheet);
    let byCol = calc.blocks.get(col);
    const hit = byCol?.get(b);
    if (hit) return hit;
    const start = b * BLOCK;
    const end = Math.min(start + BLOCK, this.rows(sheet).ids.length);
    const out = new Array<CellValue>(Math.max(0, end - start));
    for (let r = start; r < end; r++) out[r - start] = this.read(sheet, r, col);
    if (!byCol) {
      byCol = new Map();
      calc.blocks.set(col, byCol);
    }
    byCol.set(b, out);
    return out;
  }

  private readRange(ref: RefValue): ArrValue {
    const rows = ref.r2 - ref.r1 + 1;
    const cols = ref.c2 - ref.c1 + 1;
    const out = new Array<CellValue>(rows * cols);
    const lasting = this.transient === null;
    const size = this.rows(ref.sheet).ids.length;
    for (let c = ref.c1; c <= ref.c2; c++) {
      const x = c - ref.c1;
      let r = ref.r1;
      while (r <= ref.r2) {
        const b = Math.floor(r / BLOCK);
        const blockStart = b * BLOCK;
        const blockEnd = blockStart + BLOCK - 1;
        if (lasting && r === blockStart && blockEnd <= ref.r2 && blockEnd < size) {
          const values = this.block(ref.sheet, c, b);
          for (let i = 0; i < values.length; i++) out[(r + i - ref.r1) * cols + x] = values[i] as CellValue;
          r = blockEnd + 1;
          continue;
        }
        const stop = Math.min(ref.r2, blockEnd);
        for (; r <= stop; r++) out[(r - ref.r1) * cols + x] = this.read(ref.sheet, r, c);
      }
    }
    return makeArr(rows, cols, out);
  }

  private makeHost(): EvalHost {
    const frame = () => this.stack[this.stack.length - 1];
    const noteSheet = (sheet: string) => {
      const f = frame();
      if (f && sheet !== f.sheet && !f.sheets.includes(sheet)) f.sheets.push(sheet);
    };
    return {
      cell: (sheet, row, col) => {
        const info = this.info(sheet);
        const rowId = info?.rows.ids[row];
        const colId = info?.cols.ids[col];
        if (rowId === undefined || colId === undefined) {
          noteSheet(sheet);
          return null;
        }
        const key = `${rowId}:${colId}`;
        const f = frame();
        if (f && this.transient === null) f.cells.push(sheet, key);
        return this.valueOf(sheet, rowId, colId, key);
      },
      range: (ref) => {
        if (this.transient !== null) return this.readRange(ref);
        const entry = this.rangeEntry(ref);
        frame()?.ranges.push(entry);
        if (entry.cache) return entry.cache;
        const values = this.readRange(ref);
        entry.reads++;
        // Kept only while the entry is still the sheet's (a change inside drops it).
        if (entry.reads >= 2 && this.sheets.get(ref.sheet)?.ranges.get(entry.id) === entry) entry.cache = values;
        return values;
      },
      rowPos: (sheet, rowId) => this.info(sheet)?.rows.pos.get(rowId) ?? -1,
      colPos: (sheet, colId) => this.info(sheet)?.cols.pos.get(colId) ?? -1,
      size: (sheet) => {
        noteSheet(sheet);
        const info = this.info(sheet);
        return info ? { rows: info.rows.ids.length, cols: info.cols.ids.length } : null;
      },
      sheetByName: (name) => sheetIdByName(this.doc, name),
      formula: (sheet, row, col) => {
        const info = this.info(sheet);
        const rowId = info?.rows.ids[row];
        const colId = info?.cols.ids[col];
        if (rowId === undefined || colId === undefined) return undefined;
        const key = `${rowId}:${colId}`;
        const f = frame();
        if (f && this.transient === null) f.cells.push(sheet, key);
        return readRaw(info?.cells?.get(key))?.f;
      },
      now: () => this.nowValue,
      random: (env, n) => {
        const seed = this.meta.get("seed");
        return unitHash(`${typeof seed === "string" ? seed : ""}|${env.sheet}|${env.rowId}|${env.colId}|${n}`);
      },
    };
  }

  // Formats --------------------------------------------------------------------------------------------------------

  /**
   * The look a formula's result takes when its cell has no number format, as Excel gives one when the formula is
   * entered: dates from date functions, the format of the cell it shows or adds up (money, percent, dates).
   */
  private inferFormat(sheet: string, f: string, locale: SheetLocale, depth: number): string | undefined {
    if (depth > 3) return undefined;
    let ast: ReturnType<typeof parseStored>;
    try {
      ast = parseStored(f);
    } catch {
      return undefined;
    }
    const fromNode = (node: typeof ast): string | undefined => {
      switch (node.t) {
        case "paren":
          return fromNode(node.a);
        case "un":
          return node.op === "%" ? undefined : fromNode(node.a);
        case "call": {
          if (DATE_FNS.has(node.fn)) return NUMBER_FORMATS.date(locale);
          if (node.fn === "NOW") return NUMBER_FORMATS.datetime(locale);
          if (node.fn === "TIME" || node.fn === "TIMEVALUE") return NUMBER_FORMATS.time(locale);
          if (node.fn === "IF") return node.args[1] ? fromNode(node.args[1]) : undefined;
          if (node.fn === "IFERROR" || node.fn === "IFNA") return node.args[0] ? fromNode(node.args[0]) : undefined;
          if (SAME_FORMAT_FNS.has(node.fn)) {
            const arg = node.fn.endsWith("IFS")
              ? node.args[0]
              : node.fn.endsWith("IF")
                ? (node.args[2] ?? node.args[0])
                : node.args[0];
            return arg ? fromNode(arg) : undefined;
          }
          return undefined;
        }
        case "ref":
        case "range": {
          const ref = node.t === "ref" ? node.ref : node.from;
          if (ref.row === null || ref.col === null) return undefined;
          const target = ref.sheet ?? sheet;
          const raw = this.raw(target, `${ref.row}:${ref.col}`);
          if (!raw) return undefined;
          return raw.nf ?? (raw.f !== undefined ? this.inferFormat(target, raw.f, locale, depth + 1) : undefined);
        }
        case "bin": {
          if (node.op !== "+" && node.op !== "-") return undefined;
          const a = fromNode(node.a);
          if (node.op === "-" && a !== undefined && /[dy]/i.test(a) && fromNode(node.b) === a) return undefined;
          return a ?? (node.op === "+" ? fromNode(node.b) : undefined);
        }
        default:
          return undefined;
      }
    };
    return fromNode(ast);
  }

  // Changes --------------------------------------------------------------------------------------------------------

  private note(sheetId: string, key?: string): void {
    let r = this.report.get(sheetId);
    if (!r) {
      r = { sheetId };
      this.report.set(sheetId, r);
    }
    if (key === undefined) {
      r.all = true;
      delete r.cells;
      return;
    }
    if (r.all) return;
    if (!r.cells) r.cells = new Set();
    r.cells.add(key);
  }

  private flush(): void {
    if (this.report.size === 0) return;
    const report = this.report;
    this.report = new Map();
    for (const change of report.values()) {
      for (const listener of [...this.listeners]) {
        try {
          listener(change);
        } catch (e) {
          queueMicrotask(() => {
            throw e;
          });
        }
      }
    }
  }

  /** Takes in a finished transaction's changes, before any observer runs. */
  private takeIn(tr: Y.Transaction): void {
    if (this.destroyed) return;
    this.transient = null;
    this.transientTx = null;
    this.infos.clear();
    try {
      forgetChanged(tr);
      this.apply(tr);
    } catch {
      this.dropAll();
    }
  }

  private apply(tr: Y.Transaction): void {
    const sheetsMap = this.sheetsMap;
    const meta = this.meta;
    let all = false;
    const structural = new Set<string>();
    const cells = new Map<string, Set<string>>();
    for (const [type, keys] of tr.changed) {
      const changed: unknown = type;
      if (changed === sheetsMap || changed === meta) {
        all = true;
        break;
      }
      const item = type._item;
      if (!item || item.deleted) continue;
      const parent = item.parent;
      if (parent === sheetsMap) {
        const sheetId = item.parentSub;
        if (sheetId === null) continue;
        for (const key of keys) {
          if (key === "name") all = true;
          else if (key === "rows" || key === "cols" || key === "cells") structural.add(sheetId);
        }
        continue;
      }
      if (parent instanceof Y.Map && parent._item && !parent._item.deleted && parent._item.parent === sheetsMap) {
        const sheetId = parent._item.parentSub;
        if (sheetId === null) continue;
        if (item.parentSub === "cells") {
          let set = cells.get(sheetId);
          if (!set) {
            set = new Set();
            cells.set(sheetId, set);
          }
          for (const key of keys) if (key !== null) set.add(key);
        } else if (item.parentSub === "rows" || item.parentSub === "cols") structural.add(sheetId);
      }
    }
    if (all) {
      this.dropAll();
      return;
    }
    const work: [string, string][] = [];
    for (const sheetId of structural) this.dropSheet(sheetId, work);
    for (const [sheetId, keys] of cells) {
      if (structural.has(sheetId)) continue;
      this.dropCells(sheetId, keys, work);
    }
    this.propagate(work);
  }

  private dropAll(): void {
    const ids = new Set<string>([...this.sheets.keys(), ...this.sheetsMap.keys()]);
    this.infos.clear();
    this.sheets.clear();
    this.sheetReaders.clear();
    this.volatile.clear();
    for (const id of ids) this.note(id);
  }

  private dropState(state: FState, work: [string, string][]): void {
    const calc = this.sheets.get(state.sheet);
    if (!calc || calc.memo.get(state.key) !== state) return;
    calc.memo.delete(state.key);
    this.unlink(state);
    work.push([state.sheet, state.key]);
  }

  private dropSheet(sheetId: string, work: [string, string][]): void {
    const calc = this.sheets.get(sheetId);
    this.note(sheetId);
    if (calc) {
      for (const r of [...calc.ranges.values()]) for (const s of [...r.readers]) this.dropState(s, work);
      for (const s of [...calc.memo.values()]) this.dropState(s, work);
      calc.blocks.clear();
      calc.ranges.clear();
      calc.buckets.clear();
    }
    const readers = this.sheetReaders.get(sheetId);
    if (readers) for (const s of [...readers]) this.dropState(s, work);
  }

  private dropCells(sheetId: string, keys: Set<string>, work: [string, string][]): void {
    const calc = this.sheets.get(sheetId);
    const changed: [string, string][] = [];
    for (const key of keys) {
      this.note(sheetId, key);
      const state = calc?.memo.get(key);
      if (state) {
        const raw = this.raw(sheetId, key);
        // Only the look changed: the value and whoever reads it stay.
        if (raw?.f === state.f) continue;
        calc?.memo.delete(key);
        this.unlink(state);
      }
      changed.push([sheetId, key]);
    }
    if (!calc) return;
    if (changed.length > SWEEP_AT) {
      this.sweep(sheetId, changed, work);
      for (const [s, key] of changed) this.dropReaders(s, key, work, false);
    } else {
      for (const [s, key] of changed) this.dropReaders(s, key, work, true);
    }
  }

  /** Many changed cells at once: each range is checked once against all of them. */
  private sweep(sheetId: string, changed: readonly [string, string][], work: [string, string][]): void {
    const calc = this.sheets.get(sheetId);
    if (!calc) return;
    const rows = this.rows(sheetId).pos;
    const cols = this.cols(sheetId).pos;
    const byCol = new Map<number, number[]>();
    for (const [, key] of changed) {
      const colon = key.indexOf(":");
      const r = rows.get(key.slice(0, colon));
      const c = cols.get(key.slice(colon + 1));
      if (r === undefined || c === undefined) continue;
      this.forgetBlock(calc, r, c);
      let list = byCol.get(c);
      if (!list) {
        list = [];
        byCol.set(c, list);
      }
      list.push(r);
    }
    for (const list of byCol.values()) list.sort((a, b) => a - b);
    for (const range of [...calc.ranges.values()]) {
      let hit = false;
      for (let c = range.c1; c <= range.c2 && !hit; c++) {
        const list = byCol.get(c);
        if (!list) continue;
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((list[mid] as number) < range.r1) lo = mid + 1;
          else hi = mid;
        }
        if (lo < list.length && (list[lo] as number) <= range.r2) hit = true;
      }
      if (!hit) continue;
      for (const s of [...range.readers]) this.dropState(s, work);
      this.dropRange(range);
    }
  }

  private forgetBlock(calc: SheetCalc, row: number, col: number): void {
    const byCol = calc.blocks.get(col);
    if (!byCol) return;
    byCol.delete(Math.floor(row / BLOCK));
    if (byCol.size === 0) calc.blocks.delete(col);
  }

  /** Drops the formulas that read a changed cell, directly or through a range (with `ranges`). */
  private dropReaders(sheetId: string, key: string, work: [string, string][], ranges: boolean): void {
    const calc = this.sheets.get(sheetId);
    if (!calc) return;
    const readers = calc.readers.get(key);
    if (readers instanceof Set) for (const s of [...readers]) this.dropState(s, work);
    else if (readers) this.dropState(readers, work);
    const colon = key.indexOf(":");
    const r = this.rows(sheetId).pos.get(key.slice(0, colon));
    const c = this.cols(sheetId).pos.get(key.slice(colon + 1));
    if (r === undefined || c === undefined) return;
    this.forgetBlock(calc, r, c);
    if (!ranges) return;
    const bucket = calc.buckets.get(Math.floor(r / BUCKET_ROWS) * 1024 + Math.floor(c / BUCKET_COLS));
    if (!bucket) return;
    for (const range of [...bucket]) {
      if (r < range.r1 || r > range.r2 || c < range.c1 || c > range.c2) continue;
      for (const s of [...range.readers]) this.dropState(s, work);
      this.dropRange(range);
    }
  }

  /** Follows dropped formulas to the formulas that read them, and so on. */
  private propagate(work: [string, string][]): void {
    while (work.length > 0) {
      const [sheetId, key] = work.pop() as [string, string];
      this.note(sheetId, key);
      this.dropReaders(sheetId, key, work, true);
    }
  }
}
