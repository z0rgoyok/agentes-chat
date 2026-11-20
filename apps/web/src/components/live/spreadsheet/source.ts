/**
 * What the grid draws, from either place a spreadsheet comes from (ADR 0196, ADR 0198): a live document with its
 * engine (values computed on this device), or an uploaded workbook read by the server (values as the file saved
 * them). Both answer the same questions, so one grid draws both.
 */
import {
  type CellStyle,
  type CellValue,
  cellsMap,
  colIds,
  colWidths,
  DEFAULT_COL_WIDTH,
  DEFAULT_ROW_HEIGHT,
  type ErrorCode,
  errorText,
  formatValue,
  frozenOf,
  isError,
  readCell,
  readMerges,
  rowHeights,
  rowIds,
  type SheetData,
  type SheetEngine,
  type SheetLocale,
} from "@agenteschat/live/spreadsheet";
import type * as Y from "yjs";
import { Axis, type GridRange, inRange, MergeIndex } from "./model";

/** A cell as the grid draws it. */
export interface DrawCell {
  /** What it shows, formatted in the reader's language ("" for a cell with only a style). */
  text: string;
  kind: "number" | "text" | "bool" | "error" | "empty";
  style?: CellStyle;
  /** The color its number format asks for (`[Red]`). */
  color?: string;
  error?: { code: ErrorCode; circular?: boolean };
}

export interface GridSource {
  /** The sheet drawn (an id, or the workbook sheet's index as text). */
  readonly sheet: string;
  readonly rows: Axis;
  readonly cols: Axis;
  readonly frozen: { rows: number; cols: number };
  readonly merges: MergeIndex;
  /** A cell to draw, or null when there is nothing (no value, no style). */
  cell(r: number, c: number): DrawCell | null;
  /** Whether a cell holds a value (what text overflows over and ⌘ arrows stop at). */
  filled(r: number, c: number): boolean;
  /** What the cell's editor and the formula bar show. */
  input(r: number, c: number): string;
  /** The cell's computed value. */
  value(r: number, c: number): CellValue;
  /** Every non-empty value inside a range, with its number format (for the status line). */
  values(range: GridRange): Iterable<{ value: CellValue; nf?: string }>;
  /** The last row and column holding anything. */
  used(): { r: number; c: number } | null;
}

function axisOf(sizes: number[]) {
  return new Axis(sizes);
}

/** How a value reads in a cell: number, text, boolean or error, for where it sits and how it is drawn. */
function kindOf(value: CellValue): DrawCell["kind"] {
  if (value === null || value === "") return "empty";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "bool";
  if (isError(value)) return "error";
  return "text";
}

/**
 * A live document's sheet. Layout (rows, columns, sizes, merges, frozen panes) is read when made, so make a new one
 * after the document changed; cells are read when drawn and remembered until then.
 */
export class DocSource implements GridSource {
  readonly rows: Axis;
  readonly cols: Axis;
  readonly frozen: { rows: number; cols: number };
  readonly merges: MergeIndex;
  readonly rowIds: string[];
  readonly colIds: string[];
  private readonly cells: Y.Map<unknown> | null;
  private readonly memo = new Map<string, DrawCell | null>();
  private rowAt: Map<string, number> | null = null;
  private colAt: Map<string, number> | null = null;

  constructor(
    doc: Y.Doc,
    private readonly engine: SheetEngine,
    readonly sheet: string,
    private readonly locale: SheetLocale,
    /** The document's version it was read at (a new one after every change). */
    readonly version = 0,
  ) {
    this.rowIds = rowIds(doc, sheet);
    this.colIds = colIds(doc, sheet);
    this.rows = axisOf(rowHeights(doc, sheet));
    this.cols = axisOf(colWidths(doc, sheet));
    this.frozen = frozenOf(doc, sheet);
    this.merges = new MergeIndex(readMerges(doc, sheet));
    this.cells = cellsMap(doc, sheet) as Y.Map<unknown> | null;
  }

  /** A row's index by its id (-1 when gone). */
  rowIndex(id: string): number {
    this.rowAt ??= new Map(this.rowIds.map((v, i) => [v, i]));
    return this.rowAt.get(id) ?? -1;
  }

  colIndex(id: string): number {
    this.colAt ??= new Map(this.colIds.map((v, i) => [v, i]));
    return this.colAt.get(id) ?? -1;
  }

  private key(r: number, c: number): string | null {
    const row = this.rowIds[r];
    const col = this.colIds[c];
    return row === undefined || col === undefined ? null : `${row}:${col}`;
  }

  cell(r: number, c: number): DrawCell | null {
    const key = this.key(r, c);
    if (key === null) return null;
    const known = this.memo.get(key);
    if (known !== undefined) return known;
    const drawn = this.read(r, c, key);
    this.memo.set(key, drawn);
    return drawn;
  }

  private read(r: number, c: number, key: string): DrawCell | null {
    const raw = this.cells?.get(key);
    if (raw === undefined) return null;
    const data = readCell(raw);
    if (!data) return null;
    const rowId = this.rowIds[r] as string;
    const colId = this.colIds[c] as string;
    const value = data.f !== undefined || data.v !== undefined ? this.engine.value(this.sheet, rowId, colId) : null;
    const kind = kindOf(value);
    const style = data.s;
    if (kind === "empty") return style ? { text: "", kind, style } : null;
    const out: DrawCell = { text: "", kind };
    if (style) out.style = style;
    if (style?.nf) {
      const formatted = formatValue(value, style.nf, this.locale);
      out.text = formatted.text;
      if (formatted.color) out.color = formatted.color;
    } else {
      out.text = this.engine.display(this.sheet, rowId, colId, this.locale);
    }
    if (kind === "error") {
      const info = this.engine.errorInfo(this.sheet, rowId, colId);
      if (info) out.error = info.circular ? { code: info.code, circular: true } : { code: info.code };
    }
    return out;
  }

  filled(r: number, c: number): boolean {
    const drawn = this.cell(r, c);
    return drawn !== null && drawn.kind !== "empty";
  }

  input(r: number, c: number): string {
    const rowId = this.rowIds[r];
    const colId = this.colIds[c];
    if (rowId === undefined || colId === undefined) return "";
    return this.engine.input(this.sheet, rowId, colId, this.locale);
  }

  value(r: number, c: number): CellValue {
    const rowId = this.rowIds[r];
    const colId = this.colIds[c];
    if (rowId === undefined || colId === undefined) return null;
    return this.engine.value(this.sheet, rowId, colId);
  }

  *values(range: GridRange): Iterable<{ value: CellValue; nf?: string }> {
    const cells = this.cells;
    if (!cells) return;
    const area = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
    if (area <= cells.size) {
      for (let r = range.r1; r <= range.r2; r++) {
        for (let c = range.c1; c <= range.c2; c++) {
          const key = this.key(r, c);
          if (key === null || !cells.has(key)) continue;
          yield this.valueAt(r, c, key);
        }
      }
      return;
    }
    // A big selection (whole columns): only the cells the sheet holds.
    for (const key of cells.keys()) {
      const colon = key.indexOf(":");
      const r = this.rowIndex(key.slice(0, colon));
      const c = this.colIndex(key.slice(colon + 1));
      if (r < 0 || c < 0 || !inRange(range, r, c)) continue;
      yield this.valueAt(r, c, key);
    }
  }

  private valueAt(r: number, c: number, key: string): { value: CellValue; nf?: string } {
    const nf = readCell(this.cells?.get(key))?.s?.nf;
    const value = this.value(r, c);
    return nf ? { value, nf } : { value };
  }

  used(): { r: number; c: number } | null {
    const cells = this.cells;
    if (!cells || cells.size === 0) return null;
    let r = -1;
    let c = -1;
    for (const [key, raw] of cells.entries()) {
      const data = readCell(raw);
      if (!data || (data.v === undefined && data.f === undefined)) continue;
      const colon = key.indexOf(":");
      const ri = this.rowIndex(key.slice(0, colon));
      const ci = this.colIndex(key.slice(colon + 1));
      if (ri < 0 || ci < 0) continue;
      if (ri > r) r = ri;
      if (ci > c) c = ci;
    }
    return r < 0 ? null : { r, c };
  }
}

/**
 * An uploaded workbook's sheet (ADR 0198), read-only: each cell shows the text the file saved for it (`t`), else its
 * value in its number format; formulas are shown as the file wrote them, in English.
 */
export class WorkbookSource implements GridSource {
  readonly rows: Axis;
  readonly cols: Axis;
  readonly frozen: { rows: number; cols: number };
  readonly merges: MergeIndex;
  private readonly byKey = new Map<string, SheetData["cells"][number]>();
  private readonly memo = new Map<string, DrawCell | null>();

  constructor(
    private readonly data: SheetData,
    readonly sheet: string,
    private readonly locale: SheetLocale,
  ) {
    const rows = Math.max(1, data.rows);
    const cols = Math.max(1, data.cols);
    this.rows = axisOf(Array.from({ length: rows }, (_, i) => data.rowHeights?.[i] ?? DEFAULT_ROW_HEIGHT));
    this.cols = axisOf(Array.from({ length: cols }, (_, i) => data.colWidths?.[i] ?? DEFAULT_COL_WIDTH));
    this.frozen = {
      rows: Math.min(rows, Math.max(0, data.frozen?.rows ?? 0)),
      cols: Math.min(cols, Math.max(0, data.frozen?.cols ?? 0)),
    };
    this.merges = new MergeIndex(
      (data.merges ?? []).map((m) => ({
        r1: Math.min(m.r1, m.r2),
        c1: Math.min(m.c1, m.c2),
        r2: Math.max(m.r1, m.r2),
        c2: Math.max(m.c1, m.c2),
      })),
    );
    for (const cell of data.cells) this.byKey.set(`${cell.r}:${cell.c}`, cell);
  }

  private valueOf(cell: SheetData["cells"][number] | undefined): CellValue {
    if (!cell) return null;
    if (cell.e) return { error: cell.e };
    return cell.v ?? null;
  }

  cell(r: number, c: number): DrawCell | null {
    const key = `${r}:${c}`;
    const known = this.memo.get(key);
    if (known !== undefined) return known;
    const raw = this.byKey.get(key);
    let drawn: DrawCell | null = null;
    if (raw) {
      const value = this.valueOf(raw);
      const kind = kindOf(value);
      if (kind === "empty") {
        // A formula the file saved no value for still shows what the file says it shows.
        if (raw.t) drawn = { text: raw.t, kind: "text", ...(raw.s ? { style: raw.s } : {}) };
        else drawn = raw.s ? { text: "", kind, style: raw.s } : null;
      } else {
        // Values are shown in the reader's language and the cell's format, the file's own text only as a fallback.
        const formatted = kind === "error" ? null : formatValue(value, raw.s?.nf, this.locale);
        drawn = {
          text: raw.e ? errorText(raw.e, this.locale) : formatted?.text || raw.t || "",
          kind,
        };
        if (raw.s) drawn.style = raw.s;
        if (formatted?.color) drawn.color = formatted.color;
        if (raw.e) drawn.error = { code: raw.e };
      }
    }
    this.memo.set(key, drawn);
    return drawn;
  }

  filled(r: number, c: number): boolean {
    const drawn = this.cell(r, c);
    return drawn !== null && drawn.kind !== "empty";
  }

  input(r: number, c: number): string {
    const raw = this.byKey.get(`${r}:${c}`);
    if (!raw) return "";
    if (raw.f) return `=${raw.f}`;
    return this.cell(r, c)?.text ?? "";
  }

  value(r: number, c: number): CellValue {
    return this.valueOf(this.byKey.get(`${r}:${c}`));
  }

  *values(range: GridRange): Iterable<{ value: CellValue; nf?: string }> {
    for (const cell of this.data.cells) {
      if (!inRange(range, cell.r, cell.c)) continue;
      const value = this.valueOf(cell);
      yield cell.s?.nf ? { value, nf: cell.s.nf } : { value };
    }
  }

  used(): { r: number; c: number } | null {
    let r = -1;
    let c = -1;
    for (const cell of this.data.cells) {
      if (cell.v === undefined && cell.f === undefined && !cell.e) continue;
      if (cell.r > r) r = cell.r;
      if (cell.c > c) c = cell.c;
    }
    return r < 0 ? null : { r, c };
  }
}
