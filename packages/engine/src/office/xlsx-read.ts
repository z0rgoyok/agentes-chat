import {
  type CellStyle,
  colIndexOf,
  type ErrorCode,
  isDateFormat,
  isErrorCode,
  MAX_A1_COLS,
  MAX_A1_ROWS,
  type SheetData,
  type WorkbookData,
} from "@agenteschat/live";
import { sheetColor, sheetColorFrom, themeColors } from "./colors";
import { shiftA1, stripFunctionPrefixes } from "./formulas";
import { OFFICE_LIMITS, officeTooLarge, officeUnreadable } from "./limits";
import { OfficePackage, REL } from "./package";
import { attr, boolAttr, dig, type Element, intAttr, kid, kids, numAttr, relAttr, type SaxAttrs, sax } from "./xml";

/**
 * Excel workbooks (`.xlsx`, `.xlsm`) read into `WorkbookData` (ADR 0198), on the server's own zip reader and XML
 * parser: every visible sheet with its values (shared and inline strings, numbers, booleans, errors, dates), formulas
 * (shared ones expanded to each cell), styles (fonts, solid fills, borders, alignment, wrapping, number formats with
 * Excel's built-in ones), theme and indexed colors, merged cells, column widths, row heights, frozen panes and tab
 * colors. Worksheets and shared strings, the parts that grow with the data, are scanned without building a tree.
 * Macros, external links, charts, pictures and conditional formats are left out: the download still has them.
 */

/** Excel's built-in number formats by id (the ones a file may use without writing them out). */
export const BUILTIN_NUMBER_FORMATS: Readonly<Record<number, string>> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  5: '"$"#,##0_);("$"#,##0)',
  6: '"$"#,##0_);[Red]("$"#,##0)',
  7: '"$"#,##0.00_);("$"#,##0.00)',
  8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  // Excel shows 14 and 22 in the system's own short date: day first, as most of the world (and Brazil) writes it.
  14: "dd/mm/yyyy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "dd/mm/yyyy hh:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mm:ss.0",
  48: "##0.0E+0",
  49: "@",
};

/** Points to pixels at 96 dpi (row heights). */
export const ptToPx = (pt: number) => Math.round((pt * 4) / 3);
/** Excel's column width (characters of the default font's widest digit, 7 px) to pixels. */
export const widthToPx = (width: number) => Math.trunc(((256 * width + Math.trunc(128 / 7)) / 256) * 7);

/** A column's width when a workbook doesn't give one (`WorkbookData` keeps only the others). */
const DEFAULT_COL_PX = 100;

/** Days between the 1904 date system's day 0 and the 1900 system's. */
const DATE_1904_OFFSET = 1462;

interface Font {
  b: boolean;
  i: boolean;
  u: boolean;
  x: boolean;
  color: string | null;
  size: number | null;
}

interface Xf {
  numFmt: number;
  font: number;
  fill: number;
  border: number;
  alignment: Element | null;
}

/** A workbook's styles: what each cell format index (`s`) means as a `CellStyle`, read once per index. */
class Styles {
  private readonly formats = new Map<number, string>();
  private readonly fonts: Font[] = [];
  private readonly fills: (string | null)[] = [];
  private readonly borders: CellStyle["bd"][] = [];
  private readonly xfs: Xf[] = [];
  private readonly made = new Map<number, CellStyle | undefined>();
  readonly indexed: string[] = [];

  constructor(
    root: Element | null,
    private readonly theme: Record<string, string>,
  ) {
    if (!root) return;
    for (const rgb of kids(dig(root, "colors", "indexedColors"), "rgbColor")) {
      const v = attr(rgb, "rgb");
      this.indexed.push(v && /^[0-9a-f]{8}$/i.test(v) ? `#${v.slice(2).toLowerCase()}` : "");
    }
    for (const fmt of kids(kid(root, "numFmts"), "numFmt")) {
      const id = intAttr(fmt, "numFmtId");
      const code = attr(fmt, "formatCode");
      if (id !== null && code) this.formats.set(id, code);
    }
    for (const font of kids(kid(root, "fonts"), "font")) {
      const u = kid(font, "u");
      this.fonts.push({
        b: kid(font, "b") !== null && boolAttr(kid(font, "b"), "val", true),
        i: kid(font, "i") !== null && boolAttr(kid(font, "i"), "val", true),
        u: u !== null && attr(u, "val") !== "none",
        x: kid(font, "strike") !== null && boolAttr(kid(font, "strike"), "val", true),
        color: sheetColor(kid(font, "color"), theme, this.indexed),
        size: numAttr(kid(font, "sz"), "val"),
      });
    }
    for (const fill of kids(kid(root, "fills"), "fill")) this.fills.push(this.fillColor(fill));
    for (const border of kids(kid(root, "borders"), "border")) this.borders.push(this.border(border));
    for (const xf of kids(kid(root, "cellXfs"), "xf")) {
      this.xfs.push({
        numFmt: intAttr(xf, "numFmtId") ?? 0,
        font: intAttr(xf, "fontId") ?? 0,
        fill: intAttr(xf, "fillId") ?? 0,
        border: intAttr(xf, "borderId") ?? 0,
        alignment: kid(xf, "alignment"),
      });
    }
  }

  private fillColor(fill: Element): string | null {
    const pattern = kid(fill, "patternFill");
    if (pattern) {
      const type = attr(pattern, "patternType");
      if (type === "solid") {
        return sheetColor(kid(pattern, "fgColor"), this.theme, this.indexed);
      }
      return null;
    }
    // A gradient: its first color, the closest flat look.
    const stop = kid(kid(fill, "gradientFill"), "stop");
    return stop ? sheetColor(kid(stop, "color"), this.theme, this.indexed) : null;
  }

  private border(border: Element): CellStyle["bd"] {
    const out: NonNullable<CellStyle["bd"]> = {};
    const sides = [
      ["t", "top"],
      ["r", "right"],
      ["b", "bottom"],
      ["l", "left"],
    ] as const;
    for (const [key, name] of sides) {
      const logical = name === "left" ? "start" : name === "right" ? "end" : null;
      const side = kid(border, name) ?? (logical ? kid(border, logical) : null);
      const style = attr(side, "style");
      if (!side || !style || style === "none") continue;
      const w = /thick|double/.test(style) ? 3 : /medium/.test(style) ? 2 : 1;
      const c = sheetColor(kid(side, "color"), this.theme, this.indexed);
      out[key] = c ? { w, c } : { w };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** The number format code of a cell format index (undefined for General). */
  formatOf(index: number): string | undefined {
    const xf = this.xfs[index];
    if (!xf) return undefined;
    const code = this.formats.get(xf.numFmt) ?? BUILTIN_NUMBER_FORMATS[xf.numFmt];
    return code && code.toLowerCase() !== "general" ? code : undefined;
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
    const font = this.fonts[xf.font];
    if (font) {
      if (font.b) s.b = 1;
      if (font.i) s.i = 1;
      if (font.u) s.u = 1;
      if (font.x) s.x = 1;
      if (font.color && font.color !== (base?.color ?? "#000000")) s.fc = font.color;
      if (font.size !== null && font.size !== (base?.size ?? 11) && font.size > 0 && font.size <= 409) {
        s.fs = font.size;
      }
    }
    const fill = this.fills[xf.fill];
    if (fill) s.bg = fill;
    const border = this.borders[xf.border];
    if (border) s.bd = border;
    const align = xf.alignment;
    if (align) {
      const h = attr(align, "horizontal");
      if (h === "left" || h === "justify" || h === "distributed") s.ha = "l";
      else if (h === "center" || h === "centerContinuous") s.ha = "c";
      else if (h === "right") s.ha = "r";
      const v = attr(align, "vertical");
      if (v === "top") s.va = "t";
      else if (v === "center" || v === "justify" || v === "distributed") s.va = "m";
      else if (v === "bottom") s.va = "b";
      if (boolAttr(align, "wrapText")) s.w = 1;
    }
    const nf = this.formatOf(index);
    if (nf) s.nf = nf.slice(0, 255);
    return Object.keys(s).length > 0 ? s : undefined;
  }
}

/** A workbook's shared strings: rich runs joined, phonetic hints left out. */
function sharedStrings(pkg: OfficePackage, part: string | null): string[] {
  const text = part ? pkg.text(part) : null;
  if (!text) return [];
  const out: string[] = [];
  let current: string | null = null;
  let inT = false;
  let phonetic = 0;
  sax(
    text,
    {
      open(name, _attrs, selfClosing) {
        if (name === "si") current = "";
        else if (name === "rPh") phonetic++;
        else if (name === "t" && !selfClosing && phonetic === 0) inT = true;
      },
      close(name) {
        if (name === "t") inT = false;
        else if (name === "rPh") phonetic--;
        else if (name === "si") {
          out.push(current ?? "");
          current = null;
        }
      },
      text(chunk) {
        if (inT && current !== null) current += chunk;
      },
    },
    part ?? "sharedStrings",
  );
  return out;
}

/** "B3" → 0-based row and column; null when it isn't a cell's address. */
function cellRef(ref: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref);
  if (!m) return null;
  const c = colIndexOf(m[1] as string);
  const r = Number(m[2]) - 1;
  // Past Excel's last row or column (XFD) it is no real cell, and would make the sheet that wide.
  return c < 0 || c >= MAX_A1_COLS || r < 0 || r >= MAX_A1_ROWS ? null : { r, c };
}

/** "A1:C3" → its corners (a single cell is a range of one). */
function rangeRef(ref: string): { r1: number; c1: number; r2: number; c2: number } | null {
  const [a, b] = ref.split(":");
  const start = a ? cellRef(a) : null;
  const end = b ? cellRef(b) : start;
  if (!start || !end) return null;
  return {
    r1: Math.min(start.r, end.r),
    c1: Math.min(start.c, end.c),
    r2: Math.max(start.r, end.r),
    c2: Math.max(start.c, end.c),
  };
}

/** An ISO 8601 date-time (a cell of type `d`) as a serial in the 1900 date system. */
export function isoSerial(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?/.exec(text.trim());
  if (!m) {
    const time = /^T?(\d{2}):(\d{2})(?::(\d{2}))?/.exec(text.trim());
    return time ? (Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3] ?? 0)) / 86400 : null;
  }
  const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(day)) return null;
  let serial = Math.round((day - Date.UTC(1899, 11, 30)) / 86_400_000);
  if (serial < 61) serial -= 1;
  const seconds = Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0);
  return serial + seconds / 86400;
}

/** Counts cells across a workbook against `OFFICE_LIMITS.cells`. */
class CellBudget {
  private count = 0;
  add() {
    if (++this.count > OFFICE_LIMITS.cells) throw officeTooLarge("cells");
  }
}

interface SheetContext {
  strings: string[];
  styles: Styles;
  theme: Record<string, string>;
  date1904: boolean;
  budget: CellBudget;
}

/** One worksheet, scanned once. */
function readWorksheet(text: string, part: string, name: string, ctx: SheetContext): SheetData {
  const sheet: SheetData = { name, rows: 0, cols: 0, cells: [] };
  const colWidths: Record<number, number> = {};
  const rowHeights: Record<number, number> = {};
  const merges: NonNullable<SheetData["merges"]> = [];
  const shared = new Map<string, { formula: string; r: number; c: number }>();
  let defaultWidth: number | null = null;
  let maxRow = -1;
  let maxCol = -1;
  let views = 0;
  let inSheetPr = false;

  let row = -1;
  let col = -1;
  // The cell being read.
  let cell: { r: number; c: number; t: string; s: number } | null = null;
  let value: string | null = null;
  let formula: string | null = null;
  let formulaAttrs: SaxAttrs | null = null;
  let inline: string | null = null;
  let reading: "v" | "f" | "t" | null = null;
  let phonetic = 0;

  const finish = () => {
    if (!cell) return;
    const { r, c, t } = cell;
    const style = cell.s > 0 ? ctx.styles.style(cell.s) : undefined;
    const out: SheetData["cells"][number] = { r, c };
    // The formula: its own text, or a shared one moved from where it was written.
    let f: string | null = null;
    if (formula !== null && formula.trim() !== "") {
      f = stripFunctionPrefixes(formula);
      if (formulaAttrs?.t === "shared" && formulaAttrs.si !== undefined) {
        shared.set(formulaAttrs.si, { formula: f, r, c });
      }
    } else if (formulaAttrs?.t === "shared" && formulaAttrs.si !== undefined) {
      const master = shared.get(formulaAttrs.si);
      if (master) f = shiftA1(master.formula, r - master.r, c - master.c);
    }
    if (f) out.f = f;
    const raw = value ?? "";
    switch (t) {
      case "s": {
        const s = ctx.strings[Number(raw)];
        if (value !== null && s !== undefined) out.v = s;
        break;
      }
      case "inlineStr":
        if (inline !== null) out.v = inline;
        else if (value !== null) out.v = raw;
        break;
      case "str":
        if (value !== null) out.v = raw;
        break;
      case "b":
        if (value !== null) out.v = raw.trim() === "1" || raw.trim().toLowerCase() === "true";
        break;
      case "e": {
        const code = raw.trim();
        if (value !== null) out.e = (isErrorCode(code) ? code : "#N/A") as ErrorCode;
        break;
      }
      case "d": {
        const serial = isoSerial(raw);
        if (serial !== null) out.v = serial;
        break;
      }
      default: {
        if (value !== null && raw.trim() !== "") {
          const n = Number(raw);
          if (Number.isFinite(n)) out.v = ctx.date1904 && isDateFormat(style?.nf) ? n + DATE_1904_OFFSET : n;
        }
      }
    }
    if (style) out.s = style;
    if (out.v !== undefined || out.f !== undefined || out.e !== undefined || out.s !== undefined) {
      ctx.budget.add();
      sheet.cells.push(out);
      if (r > maxRow) maxRow = r;
      if (c > maxCol) maxCol = c;
    }
    cell = null;
  };

  sax(
    text,
    {
      open(tag, a, selfClosing) {
        switch (tag) {
          case "sheetPr":
            inSheetPr = !selfClosing;
            break;
          case "tabColor":
            if (inSheetPr) {
              const tab = sheetColorFrom((k) => a[k], ctx.theme, ctx.styles.indexed);
              if (tab) sheet.tab = tab;
            }
            break;
          case "sheetView":
            views++;
            break;
          case "pane":
            if (views === 1 && (a.state === "frozen" || a.state === "frozenSplit")) {
              const rows = Math.max(0, Math.trunc(Number(a.ySplit ?? 0)) || 0);
              const cols = Math.max(0, Math.trunc(Number(a.xSplit ?? 0)) || 0);
              if (rows > 0 || cols > 0) sheet.frozen = { rows, cols };
            }
            break;
          case "sheetFormatPr": {
            const w = Number(a.defaultColWidth);
            if (Number.isFinite(w) && w > 0) defaultWidth = widthToPx(w);
            break;
          }
          case "col": {
            const min = Number(a.min);
            const max = Math.min(Number(a.max), MAX_A1_COLS);
            const width = Number(a.width);
            if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) break;
            if (!Number.isFinite(width) || width <= 0 || a.hidden === "1") break;
            // A width for every column to the sheet's end is a default, not one per column.
            if (max - min > 1000) {
              defaultWidth = widthToPx(width);
              break;
            }
            for (let i = min - 1; i < max; i++) colWidths[i] = widthToPx(width);
            break;
          }
          case "row": {
            const r = Number(a.r);
            row = Number.isInteger(r) && r >= 1 ? r - 1 : row + 1;
            col = -1;
            const ht = Number(a.ht);
            if (a.ht !== undefined && Number.isFinite(ht) && ht > 0 && a.hidden !== "1") rowHeights[row] = ptToPx(ht);
            break;
          }
          case "c": {
            const at = a.r ? cellRef(a.r) : null;
            const r = at ? at.r : Math.max(row, 0);
            const c = at ? at.c : col + 1;
            // An address that isn't one, or a place past Excel's grid: no cell (what it holds is never read).
            if ((a.r && !at) || r >= MAX_A1_ROWS || c >= MAX_A1_COLS) {
              cell = null;
              break;
            }
            row = r;
            col = c;
            cell = { r, c, t: a.t ?? "n", s: Number(a.s ?? 0) || 0 };
            value = null;
            formula = null;
            formulaAttrs = null;
            inline = null;
            if (selfClosing) finish();
            break;
          }
          case "v":
            if (cell && !selfClosing) {
              reading = "v";
              value = "";
            }
            break;
          case "f":
            if (cell) {
              formulaAttrs = a;
              if (!selfClosing) {
                reading = "f";
                formula = "";
              }
            }
            break;
          case "is":
            if (cell) inline = "";
            break;
          case "rPh":
            phonetic++;
            break;
          case "t":
            if (cell && inline !== null && phonetic === 0 && !selfClosing) reading = "t";
            break;
          case "mergeCell": {
            const m = a.ref ? rangeRef(a.ref) : null;
            if (m && (m.r1 !== m.r2 || m.c1 !== m.c2)) merges.push(m);
            break;
          }
        }
      },
      close(tag) {
        switch (tag) {
          case "sheetPr":
            inSheetPr = false;
            break;
          case "v":
          case "f":
          case "t":
            reading = null;
            break;
          case "rPh":
            phonetic--;
            break;
          case "c":
            finish();
            break;
        }
      },
      text(chunk) {
        if (reading === "v") value = (value ?? "") + chunk;
        else if (reading === "f") formula = (formula ?? "") + chunk;
        else if (reading === "t") inline = (inline ?? "") + chunk;
      },
    },
    part,
  );

  for (const m of merges) {
    maxRow = Math.max(maxRow, m.r2);
    maxCol = Math.max(maxCol, m.c2);
  }
  sheet.rows = Math.max(maxRow + 1, sheet.frozen?.rows ?? 0, 1);
  sheet.cols = Math.max(maxCol + 1, sheet.frozen?.cols ?? 0, 1);
  if (defaultWidth !== null) {
    for (let i = 0; i < sheet.cols; i++) colWidths[i] ??= defaultWidth;
  }
  // Only what falls on the sheet's grid (a style for a whole column doesn't make every column of it a width), and
  // only widths other than the apps' own default of 100 px.
  const widths = Object.entries(colWidths).filter(([i, px]) => Number(i) < sheet.cols && px !== DEFAULT_COL_PX);
  if (widths.length > 0) sheet.colWidths = Object.fromEntries(widths);
  const heights = Object.entries(rowHeights).filter(([i]) => Number(i) < sheet.rows);
  if (heights.length > 0) sheet.rowHeights = Object.fromEntries(heights);
  if (merges.length > 0) sheet.merges = merges;
  return sheet;
}

/** An Excel workbook as data: its visible sheets in order (hidden ones left out). */
export function readXlsx(bytes: Uint8Array): WorkbookData {
  const pkg = OfficePackage.open(bytes);
  const workbookPart = pkg.mainPart("xl/workbook.xml");
  const workbook = pkg.xml(workbookPart);
  if (!workbook) throw officeUnreadable("it has no workbook");
  // Each part by its relationship, or where Excel puts it when a writer left the relationship out.
  const partOf = (type: string, usual: string) => {
    const rel = pkg.relOfType(workbookPart, type);
    if (rel) return rel.external ? null : rel.target;
    return pkg.has(usual) ? usual : null;
  };
  const themePart = partOf(REL.theme, "xl/theme/theme1.xml");
  const theme = themeColors(themePart ? pkg.xml(themePart) : null);
  const stylesPart = partOf(REL.styles, "xl/styles.xml");
  const styles = new Styles(stylesPart ? pkg.xml(stylesPart) : null, theme);
  const strings = sharedStrings(pkg, partOf(REL.sharedStrings, "xl/sharedStrings.xml"));
  const date1904 = boolAttr(kid(workbook, "workbookPr"), "date1904");
  const ctx: SheetContext = { strings, styles, theme, date1904, budget: new CellBudget() };
  const sheets: SheetData[] = [];
  for (const entry of kids(kid(workbook, "sheets"), "sheet")) {
    const state = attr(entry, "state");
    if (state === "hidden" || state === "veryHidden") continue;
    const part = pkg.target(workbookPart, relAttr(entry));
    if (!part) continue;
    const text = pkg.text(part);
    // A chart sheet or a dialog sheet has no cells: nothing to show.
    if (text === null || !/<(?:\w+:)?worksheet[\s>]/.test(text.slice(0, 2048))) continue;
    sheets.push(readWorksheet(text, part, attr(entry, "name") ?? `Sheet ${sheets.length + 1}`, ctx));
  }
  if (sheets.length === 0) throw officeUnreadable("it has no sheet to show");
  return { sheets };
}
