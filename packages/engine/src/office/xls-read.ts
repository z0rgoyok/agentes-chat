import {
  type CellStyle,
  isDateFormat,
  MAX_A1_COLS,
  MAX_A1_ROWS,
  type SheetData,
  type WorkbookData,
} from "@agenteschat/live";
import { CompoundFile } from "./cfb";
import { indexedColor } from "./colors";
import { stripFunctionPrefixes } from "./formulas";
import { isOfficeError, OFFICE_LIMITS, officeEncrypted, officeTooLarge, officeUnreadable } from "./limits";
import { readOds } from "./ods-read";
import { isCompoundFile, isZipFile } from "./package";
import { BIFF_ERRORS, type FormulaContext, FUNCTION_NAME_MARK, formulaText } from "./xls-formula";
import { BUILTIN_NUMBER_FORMATS, ptToPx, widthToPx } from "./xlsx-read";

/**
 * Legacy Excel workbooks (`.xls`, Excel 97 to 2003, BIFF8) read into `WorkbookData` (ADR 0198) by the server's own
 * code, as `.xlsx` is: the `Workbook` stream out of the compound file (`cfb.ts`), then its records. Every visible
 * worksheet comes through with its values (shared strings, numbers, booleans, errors, dates), formulas written back as
 * A1 text where every token is known (`xls-formula.ts`; otherwise the value Excel last calculated, which is always
 * stored too), styles (fonts, solid fills, borders, alignment, wrapping, number formats), the file's own palette,
 * merged cells, column widths, row heights, frozen panes and tab colors. Older formats (Excel 95 and before) and files
 * locked with a password are refused with what they are; charts, pictures and macros stay in the download.
 */

const R = {
  BOF: 0x0809,
  EOF: 0x000a,
  CONTINUE: 0x003c,
  FILEPASS: 0x002f,
  DATEMODE: 0x0022,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  FORMAT: 0x041e,
  FONT: 0x0031,
  XF: 0x00e0,
  PALETTE: 0x0092,
  SUPBOOK: 0x01ae,
  EXTERNNAME: 0x0023,
  EXTERNSHEET: 0x0017,
  NAME: 0x0018,
  ROW: 0x0208,
  COLINFO: 0x007d,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  RSTRING: 0x00d6,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  BOOLERR: 0x0205,
  FORMULA: 0x0006,
  STRING: 0x0207,
  SHRFMLA: 0x04bc,
  ARRAY: 0x0221,
  BLANK: 0x0201,
  MULBLANK: 0x00be,
  MERGEDCELLS: 0x00e5,
  WINDOW2: 0x023e,
  PANE: 0x0041,
  SHEETEXT: 0x0862,
} as const;

/** The workbook globals' and a worksheet's substream types (`BOF.dt`), and BIFF8's version. */
const GLOBALS = 0x0005;
const WORKSHEET = 0x0010;
const BIFF8 = 0x0600;

/** A column's width when a workbook doesn't give one (`WorkbookData` keeps only the others). */
const DEFAULT_COL_PX = 100;
/** Days between the 1904 date system's day 0 and the 1900 system's. */
const DATE_1904_OFFSET = 1462;

const damaged = () => officeUnreadable("it is damaged");
const tooOld = () => officeUnreadable("it was saved by an Excel older than 97; save it as .xlsx and send it again");

/** One record, its `CONTINUE` records joined on, with where each of them started. */
interface Rec {
  type: number;
  data: Uint8Array;
  breaks: number[];
}

/** The records of a stream from `from` on, `CONTINUE`s joined to the record they continue. */
class Records {
  private pos: number;
  private readonly view: DataView;

  constructor(
    private readonly stream: Uint8Array,
    from: number,
  ) {
    this.view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    this.pos = from;
  }

  private header(at: number): { type: number; size: number } | null {
    if (at + 4 > this.stream.byteLength) return null;
    const type = this.view.getUint16(at, true);
    const size = this.view.getUint16(at + 2, true);
    if (at + 4 + size > this.stream.byteLength) throw damaged();
    return { type, size };
  }

  next(): Rec | null {
    const head = this.header(this.pos);
    if (!head) return null;
    const parts = [this.stream.subarray(this.pos + 4, this.pos + 4 + head.size)];
    this.pos += 4 + head.size;
    const breaks: number[] = [];
    let length = head.size;
    for (let more = this.header(this.pos); more && more.type === R.CONTINUE; more = this.header(this.pos)) {
      breaks.push(length);
      parts.push(this.stream.subarray(this.pos + 4, this.pos + 4 + more.size));
      length += more.size;
      this.pos += 4 + more.size;
    }
    if (parts.length === 1) return { type: head.type, data: parts[0] as Uint8Array, breaks };
    const data = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
      data.set(part, at);
      at += part.byteLength;
    }
    return { type: head.type, data, breaks };
  }
}

const UTF16 = new TextDecoder("utf-16le");

/** A record's fields, read in order; a string's characters take a new width at each `CONTINUE` they cross. */
class Fields {
  pos = 0;
  private next = 0;
  private readonly view: DataView;

  constructor(
    private readonly data: Uint8Array,
    private readonly breaks: readonly number[] = [],
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get left(): number {
    return this.data.byteLength - this.pos;
  }
  private need(n: number) {
    if (this.pos + n > this.data.byteLength) throw damaged();
  }
  u8() {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }
  u16() {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16() {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32() {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64() {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  skip(n: number) {
    this.need(n);
    this.pos += n;
  }

  /** `cch` characters, one byte each (Latin-1) or two (UTF-16); at a `CONTINUE` a new option byte says which. */
  chars(cch: number, high: boolean): string {
    let out = "";
    let left = cch;
    let wide = high;
    while (left > 0) {
      while (this.next < this.breaks.length && (this.breaks[this.next] as number) < this.pos) this.next++;
      if (this.next < this.breaks.length && this.breaks[this.next] === this.pos) {
        wide = (this.u8() & 1) === 1;
        this.next++;
      }
      const end = this.next < this.breaks.length ? (this.breaks[this.next] as number) : this.data.byteLength;
      const width = wide ? 2 : 1;
      const n = Math.min(left, Math.floor((end - this.pos) / width));
      if (n <= 0) throw damaged();
      const part = this.data.subarray(this.pos, this.pos + n * width);
      if (wide) out += UTF16.decode(part);
      else for (let i = 0; i < part.byteLength; i += 8192) out += String.fromCharCode(...part.subarray(i, i + 8192));
      this.pos += n * width;
      left -= n;
    }
    return out;
  }

  /** An `XLUnicodeString`: a 16-bit length, an option byte, the characters. */
  unicodeString(): string {
    const cch = this.u16();
    return this.chars(cch, (this.u8() & 1) === 1);
  }

  /** A `ShortXLUnicodeString`: an 8-bit length, an option byte, the characters. */
  shortString(): string {
    const cch = this.u8();
    return this.chars(cch, (this.u8() & 1) === 1);
  }

  /** A shared string (`XLUnicodeRichExtendedString`): its formatting runs and phonetic data are skipped. */
  richString(): string {
    const cch = this.u16();
    const flags = this.u8();
    const runs = flags & 0x08 ? this.u16() : 0;
    const ext = flags & 0x04 ? this.i32() : 0;
    const text = this.chars(cch, (flags & 1) === 1);
    this.skip(runs * 4);
    if (ext > 0) this.skip(ext);
    return text;
  }
}

interface Font {
  height: number;
  italic: boolean;
  strike: boolean;
  color: number;
  bold: boolean;
  underline: boolean;
}

interface Xf {
  font: number;
  format: number;
  alc: number;
  alcV: number;
  wrap: boolean;
  /** Line styles and their colors: left, right, top, bottom. */
  lines: [number, number, number, number];
  colors: [number, number, number, number];
  fill: number;
  fore: number;
}

interface Supbook {
  kind: "self" | "addin" | "other";
  names: string[];
}

interface BoundSheet {
  name: string;
  at: number;
  hidden: boolean;
  worksheet: boolean;
}

/** The workbook globals: everything the sheets' records point into. */
class Globals {
  date1904 = false;
  readonly sheets: BoundSheet[] = [];
  readonly strings: string[] = [];
  readonly formats = new Map<number, string>();
  readonly fonts: Font[] = [];
  readonly xfs: Xf[] = [];
  /** The file's own palette: indexes 8 on, `#rrggbb`. */
  readonly palette: string[] = [];
  readonly supbooks: Supbook[] = [];
  readonly externSheets: { book: number; first: number; last: number }[] = [];
  readonly names: (string | null)[] = [];
  private readonly made = new Map<number, CellStyle | undefined>();

  /** A palette color; null for the automatic and system colors (64 and up). */
  color(icv: number): string | null {
    if (icv >= 64) return null;
    return indexedColor(icv, this.palette);
  }

  private font(index: number): Font | undefined {
    // The font table has no number 4: the fifth record is font 5.
    return this.fonts[index < 4 ? index : index - 1];
  }

  /** The style of a cell format index, or undefined when it looks like the workbook's default. */
  style(index: number): CellStyle | undefined {
    if (this.made.has(index)) return this.made.get(index);
    const style = this.build(index);
    this.made.set(index, style);
    return style;
  }

  private build(index: number): CellStyle | undefined {
    const xf = this.xfs[index];
    if (!xf) return undefined;
    const s: CellStyle = {};
    const base = this.fonts[0];
    const font = this.font(xf.font);
    if (font) {
      if (font.bold) s.b = 1;
      if (font.italic) s.i = 1;
      if (font.underline) s.u = 1;
      if (font.strike) s.x = 1;
      const color = this.color(font.color);
      if (color && color !== ((base ? this.color(base.color) : null) ?? "#000000")) s.fc = color;
      const size = font.height / 20;
      if (size !== (base ? base.height / 20 : 10) && size > 0 && size <= 409) s.fs = size;
    }
    // A solid fill is pattern 1, in the cell's foreground color.
    if (xf.fill === 1) {
      const bg = this.color(xf.fore);
      if (bg) s.bg = bg;
    }
    const border: NonNullable<CellStyle["bd"]> = {};
    (["l", "r", "t", "b"] as const).forEach((side, i) => {
      const line = xf.lines[i] as number;
      if (line === 0) return;
      // Thick and double are heavy; the medium ones (plain, dashed, dash-dot, dash-dot-dot, slanted) medium.
      const w = line === 5 || line === 6 ? 3 : [2, 8, 10, 12, 13].includes(line) ? 2 : 1;
      const c = this.color(xf.colors[i] as number);
      border[side] = c ? { w, c } : { w };
    });
    if (Object.keys(border).length > 0) s.bd = border;
    if (xf.alc === 1 || xf.alc === 5 || xf.alc === 7) s.ha = "l";
    else if (xf.alc === 2 || xf.alc === 6) s.ha = "c";
    else if (xf.alc === 3) s.ha = "r";
    // Bottom is every cell's default: only the others are said.
    if (xf.alcV === 0) s.va = "t";
    else if (xf.alcV === 1 || xf.alcV === 3 || xf.alcV === 4) s.va = "m";
    if (xf.wrap) s.w = 1;
    const code = this.formats.get(xf.format) ?? BUILTIN_NUMBER_FORMATS[xf.format];
    if (code && code.toLowerCase() !== "general") s.nf = code.slice(0, 255);
    return Object.keys(s).length > 0 ? s : undefined;
  }

  formulaContext(): FormulaContext {
    return {
      sheets: this.sheets.map((s) => s.name),
      names: this.names,
      externSheets: this.externSheets.map((x) =>
        this.supbooks[x.book]?.kind === "self" && x.first >= 0 && x.last >= 0 ? { first: x.first, last: x.last } : null,
      ),
      externNames: (ixti, index) => {
        const xti = this.externSheets[ixti];
        const book = xti ? this.supbooks[xti.book] : undefined;
        if (!book) return null;
        if (book.kind === "self") return this.names[index - 1] ?? null;
        const name = book.names[index - 1];
        // An add-in's function (an Analysis ToolPak one in an Excel 2003 file, as EOMONTH): called by its name.
        return book.kind === "addin" && name ? `${FUNCTION_NAME_MARK}${name}` : null;
      },
    };
  }
}

const BUILTIN_NAME = 0x20;
const FUNCTION_DEFINED_NAME = 0x02;

/** Reads the workbook globals substream, which starts the stream. */
function readGlobals(stream: Uint8Array): Globals {
  const g = new Globals();
  const records = new Records(stream, 0);
  const first = records.next();
  if (!first || first.type !== R.BOF) throw officeUnreadable("it is not a spreadsheet");
  const bof = new Fields(first.data);
  if (bof.u16() !== BIFF8) throw tooOld();
  if (bof.u16() !== GLOBALS) throw damaged();
  for (let rec = records.next(); rec && rec.type !== R.EOF; rec = records.next()) {
    const f = new Fields(rec.data, rec.breaks);
    switch (rec.type) {
      case R.FILEPASS:
        throw officeEncrypted();
      case R.DATEMODE:
        g.date1904 = f.u16() === 1;
        break;
      case R.BOUNDSHEET: {
        const at = f.u32();
        const state = f.u8() & 0x03;
        const type = f.u8();
        g.sheets.push({ name: f.shortString(), at, hidden: state !== 0, worksheet: type === 0 });
        break;
      }
      case R.SST: {
        f.u32();
        const unique = f.u32();
        for (let i = 0; i < unique && f.left > 0; i++) g.strings.push(f.richString());
        break;
      }
      case R.FORMAT: {
        const id = f.u16();
        g.formats.set(id, f.unicodeString());
        break;
      }
      case R.FONT: {
        const height = f.u16();
        const flags = f.u16();
        const color = f.u16();
        const weight = f.u16();
        f.u16();
        const underline = f.u8();
        g.fonts.push({
          height,
          italic: (flags & 0x02) !== 0,
          strike: (flags & 0x08) !== 0,
          color,
          bold: weight >= 700,
          underline: underline !== 0,
        });
        break;
      }
      case R.XF: {
        const font = f.u16();
        const format = f.u16();
        f.u16();
        const align = f.u8();
        f.u8();
        f.u16();
        const lines = f.u32();
        const more = f.u32();
        const colors = f.u16();
        g.xfs.push({
          font,
          format,
          alc: align & 0x07,
          alcV: (align >> 4) & 0x07,
          wrap: (align & 0x08) !== 0,
          lines: [lines & 0x0f, (lines >> 4) & 0x0f, (lines >> 8) & 0x0f, (lines >> 12) & 0x0f],
          colors: [(lines >> 16) & 0x7f, (lines >> 23) & 0x7f, more & 0x7f, (more >> 7) & 0x7f],
          fill: (more >>> 26) & 0x3f,
          fore: colors & 0x7f,
        });
        break;
      }
      case R.PALETTE: {
        const count = f.u16();
        for (let i = 0; i < count && f.left >= 4; i++) {
          const rgb = [f.u8(), f.u8(), f.u8()];
          f.u8();
          g.palette[8 + i] = `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
        }
        break;
      }
      case R.SUPBOOK: {
        f.u16();
        const marker = f.u16();
        g.supbooks.push({ kind: marker === 0x0401 ? "self" : marker === 0x3a01 ? "addin" : "other", names: [] });
        break;
      }
      case R.EXTERNNAME: {
        const book = g.supbooks[g.supbooks.length - 1];
        if (!book) break;
        f.skip(6);
        book.names.push(f.shortString());
        break;
      }
      case R.EXTERNSHEET: {
        const count = f.u16();
        for (let i = 0; i < count && f.left >= 6; i++)
          g.externSheets.push({ book: f.u16(), first: f.i16(), last: f.i16() });
        break;
      }
      case R.NAME: {
        const flags = f.u16();
        f.u8();
        const cch = f.u8();
        f.skip(10);
        const name = flags & BUILTIN_NAME ? null : f.chars(cch, (f.u8() & 1) === 1);
        // Only a function's name (a future function's "_xlfn.IFERROR") is written into a formula: a formula that uses
        // a defined name as a value keeps the value Excel calculated.
        g.names.push(name && flags & FUNCTION_DEFINED_NAME ? `${FUNCTION_NAME_MARK}${name}` : null);
        break;
      }
    }
  }
  return g;
}

/** A 30-bit integer or the top 30 bits of a double, maybe divided by 100 (`RK`). */
function rkValue(rk: number): number {
  let v: number;
  if (rk & 0x02) v = (rk | 0) >> 2;
  else {
    const view = new DataView(new ArrayBuffer(8));
    view.setUint32(4, rk & 0xfffffffc, true);
    v = view.getFloat64(0, true);
  }
  return rk & 0x01 ? v / 100 : v;
}

type Cell = SheetData["cells"][number];

/** Counts cells across a workbook against `OFFICE_LIMITS.cells`. */
class CellBudget {
  private count = 0;
  add() {
    if (++this.count > OFFICE_LIMITS.cells) throw officeTooLarge("cells");
  }
}

/** One worksheet substream, read from its `BOF`; null for a substream that isn't a worksheet. */
function readSheet(stream: Uint8Array, entry: BoundSheet, g: Globals, budget: CellBudget): SheetData | null {
  const records = new Records(stream, entry.at);
  const bof = records.next();
  if (!bof || bof.type !== R.BOF) throw damaged();
  const head = new Fields(bof.data);
  if (head.u16() !== BIFF8) throw tooOld();
  if (head.u16() !== WORKSHEET) return null;
  const ctx = g.formulaContext();
  const sheet: SheetData = { name: entry.name, rows: 0, cols: 0, cells: [] };
  const colWidths: Record<number, number> = {};
  const rowHeights: Record<number, number> = {};
  const merges: NonNullable<SheetData["merges"]> = [];
  const shared = new Map<string, Uint8Array>();
  const arrays = new Map<string, Uint8Array>();
  const pending: { cell: Cell; anchor: string }[] = [];
  const added = new WeakSet<Cell>();
  let maxRow = -1;
  let maxCol = -1;
  let frozenFlag = false;
  let pane: { rows: number; cols: number } | null = null;
  let stringFor: Cell | null = null;
  // Embedded charts are substreams of their own inside a worksheet's: their records are skipped.
  let depth = 1;

  /** Puts a cell on the sheet once it holds something (a value, a formula, an error or a style). */
  const keep = (cell: Cell) => {
    if (added.has(cell)) return;
    if (cell.v === undefined && cell.f === undefined && cell.e === undefined && cell.s === undefined) return;
    budget.add();
    added.add(cell);
    sheet.cells.push(cell);
    if (cell.r > maxRow) maxRow = cell.r;
    if (cell.c > maxCol) maxCol = cell.c;
  };

  const make = (r: number, c: number, xf: number, value: Partial<Cell>): Cell | null => {
    if (r >= MAX_A1_ROWS || c >= MAX_A1_COLS) return null;
    const style = g.style(xf);
    const cell: Cell = { r, c, ...value };
    if (typeof cell.v === "number" && g.date1904 && isDateFormat(style?.nf)) cell.v += DATE_1904_OFFSET;
    if (style) cell.s = style;
    keep(cell);
    return cell;
  };

  for (let rec = records.next(); rec; rec = records.next()) {
    if (rec.type === R.BOF) {
      depth++;
      continue;
    }
    if (rec.type === R.EOF) {
      if (--depth === 0) break;
      continue;
    }
    if (depth > 1) continue;
    const f = new Fields(rec.data, rec.breaks);
    switch (rec.type) {
      case R.LABELSST: {
        const [r, c, xf] = [f.u16(), f.u16(), f.u16()];
        const s = g.strings[f.u32()];
        make(r, c, xf, s !== undefined && s !== "" ? { v: s } : {});
        break;
      }
      case R.LABEL:
      case R.RSTRING: {
        const [r, c, xf] = [f.u16(), f.u16(), f.u16()];
        const s = f.unicodeString();
        make(r, c, xf, s !== "" ? { v: s } : {});
        break;
      }
      case R.NUMBER: {
        const [r, c, xf] = [f.u16(), f.u16(), f.u16()];
        const n = f.f64();
        make(r, c, xf, Number.isFinite(n) ? { v: n } : {});
        break;
      }
      case R.RK: {
        const [r, c, xf] = [f.u16(), f.u16(), f.u16()];
        make(r, c, xf, { v: rkValue(f.u32()) });
        break;
      }
      case R.MULRK: {
        const r = f.u16();
        let c = f.u16();
        // Each entry is a format and a value; the record ends with the last column.
        while (f.left >= 8) {
          const xf = f.u16();
          make(r, c++, xf, { v: rkValue(f.u32()) });
        }
        break;
      }
      case R.BOOLERR: {
        const [r, c, xf] = [f.u16(), f.u16(), f.u16()];
        const v = f.u8();
        make(r, c, xf, f.u8() ? { e: BIFF_ERRORS[v] ?? "#N/A" } : { v: v !== 0 });
        break;
      }
      case R.BLANK: {
        const [r, c, xf] = [f.u16(), f.u16(), f.u16()];
        make(r, c, xf, {});
        break;
      }
      case R.MULBLANK: {
        const r = f.u16();
        let c = f.u16();
        while (f.left >= 4) make(r, c++, f.u16(), {});
        break;
      }
      case R.FORMULA: {
        const [r, c, xf] = [f.u16(), f.u16(), f.u16()];
        const result = f.bytes(8);
        f.u16();
        f.u32();
        const rgce = f.bytes(Math.min(f.u16(), f.left));
        const value: Partial<Cell> = {};
        const special = result[6] === 0xff && result[7] === 0xff;
        if (special) {
          if (result[0] === 1) value.v = result[2] !== 0;
          else if (result[0] === 2) value.e = BIFF_ERRORS[result[2] as number] ?? "#N/A";
        } else {
          const n = new DataView(result.buffer, result.byteOffset, 8).getFloat64(0, true);
          if (Number.isFinite(n)) value.v = n;
        }
        // A shared or array formula's cells point at the cell that starts it (`ptgExp`); its body comes later.
        let anchor: string | null = null;
        if (rgce[0] === 0x01 && rgce.byteLength >= 5) {
          anchor = `${(rgce[1] as number) | ((rgce[2] as number) << 8)},${(rgce[3] as number) | ((rgce[4] as number) << 8)}`;
        } else {
          const text = formulaText(rgce, ctx, { row: r, col: c });
          if (text !== null) value.f = stripFunctionPrefixes(text);
        }
        const cell = make(r, c, xf, value);
        if (cell && anchor) pending.push({ cell, anchor });
        // A text result comes in the STRING record that follows.
        stringFor = special && result[0] === 0 ? cell : null;
        break;
      }
      case R.STRING: {
        const s = f.unicodeString();
        if (stringFor && s !== "") {
          stringFor.v = s;
          keep(stringFor);
        }
        stringFor = null;
        break;
      }
      case R.SHRFMLA: {
        const r1 = f.u16();
        f.u16();
        const c1 = f.u8();
        f.skip(3);
        shared.set(`${r1},${c1}`, f.bytes(Math.min(f.u16(), f.left)));
        break;
      }
      case R.ARRAY: {
        const r1 = f.u16();
        f.u16();
        const c1 = f.u8();
        f.skip(7);
        arrays.set(`${r1},${c1}`, f.bytes(Math.min(f.u16(), f.left)));
        break;
      }
      case R.MERGEDCELLS: {
        const count = f.u16();
        for (let i = 0; i < count && f.left >= 8; i++) {
          const [r1, r2, c1, c2] = [f.u16(), f.u16(), f.u16(), f.u16()];
          if (r2 >= r1 && c2 >= c1 && (r1 !== r2 || c1 !== c2) && r2 < MAX_A1_ROWS && c2 < MAX_A1_COLS) {
            merges.push({ r1, c1, r2, c2 });
          }
        }
        break;
      }
      case R.COLINFO: {
        const [first, last, width] = [f.u16(), f.u16(), f.u16()];
        f.u16();
        const hidden = (f.u16() & 0x01) !== 0;
        if (hidden || width === 0 || last < first) break;
        for (let i = first; i <= Math.min(last, 255); i++) colWidths[i] = widthToPx(width / 256);
        break;
      }
      case R.ROW: {
        const r = f.u16();
        f.skip(4);
        const height = f.u16() & 0x7fff;
        f.skip(4);
        const flags = f.u16();
        // A height of its own (fUnsynced), on a row that shows (fDyZero hides it).
        if (flags & 0x40 && !(flags & 0x20) && height > 0) rowHeights[r] = ptToPx(height / 20);
        break;
      }
      case R.WINDOW2:
        frozenFlag = (f.u16() & 0x08) !== 0;
        break;
      case R.PANE: {
        const cols = f.u16();
        const rows = f.u16();
        if (rows > 0 || cols > 0) pane = { rows, cols };
        break;
      }
      case R.SHEETEXT: {
        if (f.left < 20) break;
        f.skip(16);
        const tab = g.color(f.u32() & 0x7f);
        if (tab) sheet.tab = tab;
        break;
      }
    }
  }

  // Shared formulas (the record that follows the first cell of their range), moved to each cell that uses one; an
  // array formula's text goes on its first cell, its other cells keep their values.
  for (const { cell, anchor } of pending) {
    const body = shared.get(anchor);
    let text: string | null = null;
    if (body) text = formulaText(body, ctx, { row: cell.r, col: cell.c }, true);
    else if (anchor === `${cell.r},${cell.c}`) {
      const array = arrays.get(anchor);
      if (array) text = formulaText(array, ctx, { row: cell.r, col: cell.c });
    }
    if (text !== null) {
      cell.f = stripFunctionPrefixes(text);
      keep(cell);
    }
  }

  if (frozenFlag && pane) sheet.frozen = pane;
  for (const m of merges) {
    maxRow = Math.max(maxRow, m.r2);
    maxCol = Math.max(maxCol, m.c2);
  }
  sheet.rows = Math.max(maxRow + 1, sheet.frozen?.rows ?? 0, 1);
  sheet.cols = Math.max(maxCol + 1, sheet.frozen?.cols ?? 0, 1);
  const widths = Object.entries(colWidths).filter(([i, px]) => Number(i) < sheet.cols && px !== DEFAULT_COL_PX);
  if (widths.length > 0) sheet.colWidths = Object.fromEntries(widths);
  const heights = Object.entries(rowHeights).filter(([i]) => Number(i) < sheet.rows);
  if (heights.length > 0) sheet.rowHeights = Object.fromEntries(heights);
  if (merges.length > 0) sheet.merges = merges;
  return sheet;
}

/** A legacy Excel workbook (BIFF8) as data: its visible worksheets in order. */
export function readBiff(bytes: Uint8Array): WorkbookData {
  if (bytes.byteLength > OFFICE_LIMITS.inputBytes) throw officeTooLarge("size");
  try {
    return readBiffBook(bytes);
  } catch (error) {
    // A file damaged in a way no check above names is still just a damaged file.
    if (isOfficeError(error)) throw error;
    throw damaged();
  }
}

function readBiffBook(bytes: Uint8Array): WorkbookData {
  const file = new CompoundFile(bytes);
  const stream = file.stream("Workbook");
  if (!stream) {
    // An Office file locked with a password is a compound file holding its encrypted package.
    if (file.has("EncryptedPackage")) throw officeEncrypted();
    if (file.has("Book")) throw tooOld();
    throw officeUnreadable("it is not a spreadsheet");
  }
  const g = readGlobals(stream);
  const budget = new CellBudget();
  const sheets: SheetData[] = [];
  for (const entry of g.sheets) {
    if (entry.hidden || !entry.worksheet) continue;
    if (entry.at >= stream.byteLength) throw damaged();
    const sheet = readSheet(stream, entry, g, budget);
    if (sheet) sheets.push(sheet);
  }
  if (sheets.length === 0) throw officeUnreadable("it has no sheet to show");
  return { sheets };
}

/** A legacy `.xls` or an `.ods` workbook as data: its visible sheets in order. */
export async function readXls(bytes: Uint8Array): Promise<WorkbookData> {
  if (bytes.byteLength > OFFICE_LIMITS.inputBytes) throw officeTooLarge("size");
  if (isZipFile(bytes)) return readOds(bytes);
  if (isCompoundFile(bytes)) return readBiff(bytes);
  throw officeUnreadable("it is not a spreadsheet");
}
