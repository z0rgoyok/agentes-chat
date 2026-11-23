/**
 * Copy and paste (ADR 0196 §2). Copying a range gives three forms: the cells themselves (values, formulas by id,
 * formats, merges) for pasting inside the app, tab-separated text, and an HTML table with the formats, which is what
 * Excel, Google Sheets and other apps read. Pasting takes any of them, preferring the cells, then a table (Excel's and
 * Google Sheets' clipboard HTML, with their values, number formats, styles and merges; Google Sheets' formulas too),
 * then text, which is read cell by cell as if typed. Cutting is a move (`moveRange`): formulas keep pointing where
 * they did, and the ones pointing at the moved cells follow them. Nothing here touches the system clipboard: the
 * apps do.
 */
import type * as Y from "yjs";
import type { LiveOrigin } from "../origins";
import { r1c1ToA1, shiftA1Formula } from "./a1";
import {
  type BorderSide,
  type CellData,
  type CellStyle,
  cellKey,
  cellsMap,
  cleanCellStyle,
  colIds,
  indexOf,
  type Merge,
  parseCellKey,
  readCell,
  readMerges,
  rowIds,
  SheetError,
  type SheetParts,
  type SheetValues,
  sameData,
  sheetIds,
  sheetMap,
  sheetParts,
  sheetSize,
} from "./doc";
import { NUMBER_FORMATS } from "./format";
import { FUNCTION_NAMES, parseCanonical, shiftFormula, toCanonical, toDisplay } from "./formula";
import { type SheetLocale, sheetLocale } from "./locale";
import { rewriteRefs } from "./ops";
import { type ErrorCode, errorFromText, isError } from "./values";
import {
  addNeeds,
  type CellAt,
  checkCellRoom,
  checkIndex,
  checkSize,
  clampRange,
  growSheets,
  growTo,
  type Needs,
  normalizeRange,
  overlaps,
  planInput,
  type RangeIds,
  SHEET_LIMITS,
  type SheetNeeds,
  writeCell,
} from "./write";

/** One copied cell. */
export interface ClipCell {
  /** Its value: what was typed, or what its formula computed (absent for an error or an empty cell). */
  v?: CellData["v"];
  /** Its formula, canonical (by the ids of the sheet it was copied from). */
  f?: string;
  s?: CellStyle;
  /** What it showed. */
  display?: string;
  /** The error its formula computed, or the error it held. */
  e?: ErrorCode;
  /** Its formula in English A1 as it read where it was copied from (`=SUM(B2:B9)`), to paste it on another sheet. */
  a1?: string;
  /** The top-left cell of a merge: how many rows and columns it spans within what was copied. */
  span?: { rows: number; cols: number };
}

/** What can be pasted: the app's own cells (with where they were copied from), an HTML table, or text. */
export interface ClipSource {
  cells?: ClipCell[][];
  tsv?: string;
  html?: string;
  /** The sheet and top-left cell the cells were copied from, so formulas move as copies do. */
  source?: { sheet: string; r1: number; c1: number };
}

const EN = sheetLocale("en-US");

// ---------------------------------------------------------------------------------------------------------------------
// Text

/** Tab-separated text as Excel writes it: fields with tabs, line breaks or quotes are quoted, quotes doubled. */
export function toTsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) => row.map((text) => (/[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text)).join("\t"))
    .join("\n");
}

/**
 * Tab-separated text into rows of fields: quoted fields may hold tabs, line breaks and doubled quotes; a quote that
 * doesn't close a field before a tab or a line break is just text. Line endings may be \n, \r\n or \r; the line
 * break after the last row is not a row.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const n = text.length;
  if (n === 0) return [];
  while (i <= n) {
    let field = "";
    if (text.charAt(i) === '"') {
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < n) {
        const c = text.charAt(j);
        if (c === '"') {
          if (text.charAt(j + 1) === '"') {
            value += '"';
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        value += c;
        j++;
      }
      const next = text.charAt(j);
      if (closed && (j >= n || next === "\t" || next === "\n" || next === "\r")) {
        field = value;
        i = j;
      } else {
        let k = i;
        while (k < n && text.charAt(k) !== "\t" && text.charAt(k) !== "\n" && text.charAt(k) !== "\r") k++;
        field = text.slice(i, k);
        i = k;
      }
    } else {
      let k = i;
      while (k < n && text.charAt(k) !== "\t" && text.charAt(k) !== "\n" && text.charAt(k) !== "\r") k++;
      field = text.slice(i, k);
      i = k;
    }
    row.push(field);
    const c = text.charAt(i);
    if (c === "\t") {
      i++;
      continue;
    }
    rows.push(row);
    row = [];
    if (c === "\r" && text.charAt(i + 1) === "\n") i += 2;
    else i++;
    if (i >= n) break;
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------------
// HTML out

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function borderCss(side: BorderSide): string {
  return `${side.w}px solid ${side.c ?? "#000000"}`;
}

function styleCss(s: CellStyle | undefined): string {
  if (!s) return "";
  const parts: string[] = [];
  if (s.b) parts.push("font-weight:bold");
  if (s.i) parts.push("font-style:italic");
  const lines = [s.u ? "underline" : "", s.x ? "line-through" : ""].filter(Boolean);
  if (lines.length > 0) parts.push(`text-decoration:${lines.join(" ")}`);
  if (s.fc) parts.push(`color:${s.fc}`);
  if (s.bg) parts.push(`background-color:${s.bg}`);
  if (s.ha) parts.push(`text-align:${s.ha === "l" ? "left" : s.ha === "c" ? "center" : "right"}`);
  if (s.va) parts.push(`vertical-align:${s.va === "t" ? "top" : s.va === "m" ? "middle" : "bottom"}`);
  parts.push(s.w ? "white-space:normal" : "white-space:nowrap");
  if (s.fs) parts.push(`font-size:${s.fs}pt`);
  if (s.bd?.t) parts.push(`border-top:${borderCss(s.bd.t)}`);
  if (s.bd?.r) parts.push(`border-right:${borderCss(s.bd.r)}`);
  if (s.bd?.b) parts.push(`border-bottom:${borderCss(s.bd.b)}`);
  if (s.bd?.l) parts.push(`border-left:${borderCss(s.bd.l)}`);
  return parts.join(";");
}

/** An HTML table of the cells, with their formats and merges, as other spreadsheets read a paste. */
export function toHtml(cells: readonly (readonly ClipCell[])[]): string {
  const covered = new Set<string>();
  let body = "";
  cells.forEach((row, r) => {
    body += "<tr>";
    row.forEach((cell, c) => {
      if (covered.has(`${r}:${c}`)) return;
      let attrs = "";
      if (cell.span) {
        for (let i = 0; i < cell.span.rows; i++) {
          for (let j = 0; j < cell.span.cols; j++) if (i > 0 || j > 0) covered.add(`${r + i}:${c + j}`);
        }
        if (cell.span.rows > 1) attrs += ` rowspan="${cell.span.rows}"`;
        if (cell.span.cols > 1) attrs += ` colspan="${cell.span.cols}"`;
      }
      const css = styleCss(cell.s);
      if (css) attrs += ` style="${escapeHtml(css)}"`;
      const text = escapeHtml(cell.display ?? "").replace(/\r?\n/g, "<br>");
      body += `<td${attrs}>${text}</td>`;
    });
    body += "</tr>";
  });
  return `<meta charset="utf-8"><table style="border-collapse:collapse"><tbody>${body}</tbody></table>`;
}

/** Past this many cells, a copy stops at the last row and column holding something. */
const COPY_TRIM_AT = 100_000;

/**
 * Copies a range: the cells for pasting inside the app (formulas canonical and in English A1, computed values, merges
 * as spans), tab-separated text of what the cells show, and an HTML table with their formats. A selection of more
 * than 100,000 cells (a whole large sheet) is copied only as far as its last row and column holding something.
 */
export function copyRange(
  doc: Y.Doc,
  range: RangeIds,
  engine: SheetValues,
  locale: SheetLocale,
): { cells: ClipCell[][]; tsv: string; html: string } {
  const r = normalizeRange(range);
  if (!sheetMap(doc, r.sheet)) throw new SheetError("no_sheet", `There is no sheet ${r.sheet}`);
  const size = sheetSize(doc, r.sheet);
  let r2 = Math.min(r.r2, size.rows - 1);
  let c2 = Math.min(r.c2, size.cols - 1);
  if (r.r1 > r2 || r.c1 > c2) return { cells: [], tsv: "", html: toHtml([]) };
  const rows = rowIds(doc, r.sheet);
  const cols = colIds(doc, r.sheet);
  const map = cellsMap(doc, r.sheet);
  let merges = readMerges(doc, r.sheet).filter((m) => overlaps(m, { r1: r.r1, c1: r.c1, r2, c2 }));
  if ((r2 - r.r1 + 1) * (c2 - r.c1 + 1) > COPY_TRIM_AT) {
    // A big selection (a whole large sheet) copies only as far as something is there, not millions of empty cells.
    const rowAt = indexOf(rows);
    const colAt = indexOf(cols);
    let lastRow = r.r1;
    let lastCol = r.c1;
    for (const key of map?.keys() ?? []) {
      const ids = parseCellKey(key);
      const i = ids ? rowAt.get(ids[0]) : undefined;
      const j = ids ? colAt.get(ids[1]) : undefined;
      if (i === undefined || j === undefined || i < r.r1 || i > r2 || j < r.c1 || j > c2) continue;
      lastRow = Math.max(lastRow, i);
      lastCol = Math.max(lastCol, j);
    }
    for (const m of merges) {
      lastRow = Math.max(lastRow, Math.min(m.r2, r2));
      lastCol = Math.max(lastCol, Math.min(m.c2, c2));
    }
    r2 = lastRow;
    c2 = lastCol;
    merges = merges.filter((m) => overlaps(m, { r1: r.r1, c1: r.c1, r2, c2 }));
  }
  // Each copied merge spans what of it was copied; the cells it covers, by row, copy only their formats.
  const spans = new Map<string, { rows: number; cols: number }>();
  const covered = new Map<number, { top: number; left: number; right: number }[]>();
  for (const m of merges) {
    const top = Math.max(m.r1, r.r1);
    const left = Math.max(m.c1, r.c1);
    const bottom = Math.min(m.r2, r2);
    const right = Math.min(m.c2, c2);
    spans.set(`${top}:${left}`, { rows: bottom - top + 1, cols: right - left + 1 });
    for (let i = top; i <= bottom; i++) {
      const entry = { top, left, right };
      const list = covered.get(i);
      if (list) list.push(entry);
      else covered.set(i, [entry]);
    }
  }
  const hidden = (i: number, j: number): boolean =>
    covered.get(i)?.some((m) => j >= m.left && j <= m.right && (i !== m.top || j !== m.left)) ?? false;
  const cells: ClipCell[][] = [];
  const text: string[][] = [];
  for (let i = r.r1; i <= r2; i++) {
    const row: ClipCell[] = [];
    const line: string[] = [];
    for (let j = r.c1; j <= c2; j++) {
      const rowId = rows[i] as string;
      const colId = cols[j] as string;
      const stored = readCell(map?.get(cellKey(rowId, colId)));
      const clip: ClipCell = {};
      if (stored?.s) clip.s = stored.s;
      if (!hidden(i, j) && stored && (stored.v !== undefined || stored.f !== undefined)) {
        const value = engine.value(r.sheet, rowId, colId);
        if (isError(value)) clip.e = value.error;
        else if (value !== null) clip.v = value;
        if (stored.f !== undefined) {
          clip.f = stored.f;
          clip.a1 = toDisplay(stored.f, { doc, sheetId: r.sheet, locale: EN });
        }
        clip.display = engine.display(r.sheet, rowId, colId, locale);
      }
      const span = spans.get(`${i}:${j}`);
      if (span) clip.span = span;
      row.push(clip);
      line.push(clip.display ?? "");
    }
    cells.push(row);
    text.push(line);
  }
  return { cells, tsv: toTsv(text), html: toHtml(cells) };
}

// ---------------------------------------------------------------------------------------------------------------------
// HTML in

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  copy: "©",
  reg: "®",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  deg: "°",
  ordm: "º",
  ordf: "ª",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number(body.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

interface Tag {
  close: boolean;
  name: string;
  attrs: Map<string, string | true>;
  end: number;
}

/** Reads the tag starting at `i` (a `<`), attributes quoted, unquoted or bare; null when it isn't a tag. */
function readTag(html: string, i: number): Tag | null {
  let j = i + 1;
  const close = html.charAt(j) === "/";
  if (close) j++;
  const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(j, j + 64));
  if (!nameMatch) return null;
  const name = nameMatch[0].toLowerCase();
  j += nameMatch[0].length;
  const attrs = new Map<string, string | true>();
  const n = html.length;
  while (j < n) {
    while (j < n && /\s/.test(html.charAt(j))) j++;
    const c = html.charAt(j);
    if (c === ">") return { close, name, attrs, end: j + 1 };
    if (c === "/" && html.charAt(j + 1) === ">") return { close, name, attrs, end: j + 2 };
    if (c === "") break;
    let k = j;
    while (k < n && !/[\s=>]/.test(html.charAt(k)) && !(html.charAt(k) === "/" && html.charAt(k + 1) === ">")) k++;
    const key = html.slice(j, k).toLowerCase();
    j = k;
    while (j < n && /\s/.test(html.charAt(j))) j++;
    if (html.charAt(j) !== "=") {
      if (key) attrs.set(key, true);
      if (k === j && key === "") j++;
      continue;
    }
    j++;
    while (j < n && /\s/.test(html.charAt(j))) j++;
    const q = html.charAt(j);
    let value: string;
    if (q === '"' || q === "'") {
      const end = html.indexOf(q, j + 1);
      value = html.slice(j + 1, end < 0 ? n : end);
      j = end < 0 ? n : end + 1;
    } else {
      let e = j;
      while (e < n && !/[\s>]/.test(html.charAt(e))) e++;
      value = html.slice(j, e);
      j = e;
    }
    if (key) attrs.set(key, decodeEntities(value));
  }
  return null;
}

type Decls = Map<string, string>;

/** CSS declarations (`a: b; c: "d;e"`), keeping quoted and escaped semicolons. */
function parseDecls(text: string): Decls {
  const out: Decls = new Map();
  let start = 0;
  let quote = "";
  const flush = (end: number) => {
    const decl = text.slice(start, end);
    const colon = decl.indexOf(":");
    if (colon > 0) {
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const value = decl
        .slice(colon + 1)
        .replace(/!important\s*$/i, "")
        .trim();
      if (prop && value) out.set(prop, value);
    }
    start = end + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === ";") flush(i);
  }
  flush(text.length);
  return out;
}

interface CssRule {
  tag: string | null;
  cls: string | null;
  decls: Decls;
}

// The page's CSS is read by index: a regex that tries the rest of the text again from each `/*` left open, or from
// each character of a selector no `{` follows, takes quadratic time on a pasted page written to be slow.

/**
 * CSS without its comments (each from a slash-star to the first star-slash after it; one left open stays) nor the
 * `<!--` and `-->` that wrap a page's CSS for old browsers, which CSS reads as nothing. What is left is only read for
 * styles, never shown.
 */
function cssWithoutComments(text: string): string {
  let css = "";
  let from = 0;
  for (let at = text.indexOf("/*"); at >= 0; at = text.indexOf("/*", from)) {
    const end = text.indexOf("*/", at + 2);
    if (end < 0) break;
    css += text.slice(from, at);
    from = end + 2;
  }
  css += text.slice(from);
  let out = "";
  from = 0;
  for (let i = 0; i < css.length; i++) {
    const skip = css.startsWith("<!--", i) ? 4 : css.startsWith("-->", i) ? 3 : 0;
    if (skip === 0) continue;
    out += css.slice(from, i);
    from = i + skip;
    i = from - 1;
  }
  return out + css.slice(from);
}

const CSS_SELECTOR_ENDS = new Set(["{", "}", "@"]);

function parseCss(text: string): CssRule[] {
  const clean = cssWithoutComments(text);
  const rules: CssRule[] = [];
  // Each `selectors { declarations }`: selectors without `{`, `}` or `@`, declarations without braces.
  let i = 0;
  while (i < clean.length) {
    while (i < clean.length && CSS_SELECTOR_ENDS.has(clean.charAt(i))) i++;
    let open = i;
    while (open < clean.length && !CSS_SELECTOR_ENDS.has(clean.charAt(open))) open++;
    if (open >= clean.length) break;
    if (clean.charAt(open) !== "{") {
      i = open + 1;
      continue;
    }
    let close = open + 1;
    while (close < clean.length && clean.charAt(close) !== "{" && clean.charAt(close) !== "}") close++;
    if (clean.charAt(close) !== "}") {
      i = open + 1;
      continue;
    }
    const decls = parseDecls(clean.slice(open + 1, close));
    for (const raw of clean.slice(i, open).split(",")) {
      const selector = raw.trim().toLowerCase();
      const sm = /^([a-z][a-z0-9]*)?(?:\.([a-z0-9_-]+))?$/.exec(selector);
      if (!sm || (!sm[1] && !sm[2])) continue;
      rules.push({ tag: sm[1] ?? null, cls: sm[2] ?? null, decls });
    }
    i = close + 1;
  }
  return rules;
}

/** Undoes CSS escapes (`\#`, `\0022`), as Excel writes number formats in `mso-number-format`. */
function cssUnescape(text: string): string {
  let value = text.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.replace(/\\([0-9a-fA-F]{1,6}\s?|[\s\S])/g, (_, body: string) => {
    if (/^[0-9a-fA-F]{1,6}\s?$/.test(body)) {
      const code = Number.parseInt(body.trim(), 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return body;
  });
}

const NAMED_CSS_COLORS: Record<string, string> = {
  black: "#000000",
  windowtext: "#000000",
  white: "#ffffff",
  window: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  lime: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  fuchsia: "#ff00ff",
  magenta: "#ff00ff",
  aqua: "#00ffff",
  cyan: "#00ffff",
  navy: "#000080",
  teal: "#008080",
  maroon: "#800000",
  olive: "#808000",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
};

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0");
}

/** A CSS color as `#rrggbb`; null for none, transparent or what can't be read. */
function cssColor(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(
    v,
  );
  if (rgb) {
    const alpha = rgb[4];
    if (alpha !== undefined && (alpha === "0" || alpha === "0%" || Number.parseFloat(alpha) === 0)) return null;
    return `#${hex2(Number(rgb[1]))}${hex2(Number(rgb[2]))}${hex2(Number(rgb[3]))}`;
  }
  return NAMED_CSS_COLORS[v] ?? null;
}

/** A CSS length in points (`11pt`, `14.67px`, `.5pt`); null when it isn't one. */
function cssPoints(value: string): number | null {
  const m = /^(\d*\.?\d+)(pt|px)?$/.exec(value.trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "px" ? n * 0.75 : n;
}

function borderOf(value: string | undefined): BorderSide | null {
  if (!value) return null;
  const tokens = value.trim().toLowerCase().split(/\s+/);
  let width: number | null = null;
  let style = "solid";
  let color: string | null = null;
  for (const token of tokens) {
    if (["none", "hidden"].includes(token)) return null;
    if (["solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset"].includes(token)) style = token;
    else if (token === "thin") width = 0.75;
    else if (token === "medium") width = 1.5;
    else if (token === "thick") width = 2.25;
    else if (cssPoints(token) !== null) width = cssPoints(token);
    else color = cssColor(token) ?? color;
  }
  if (width === 0) return null;
  const pts = width ?? 0.75;
  const w: 1 | 2 | 3 = style === "double" || pts > 1.6 ? 3 : pts > 0.8 ? 2 : 1;
  return color && color !== "#000000" ? { w, c: color } : { w };
}

/** Excel's own names for number formats in its HTML. */
function namedFormat(name: string, locale: SheetLocale): string | undefined | null {
  switch (name.toLowerCase()) {
    case "general":
    case "general number":
      return undefined;
    case "fixed":
      return "0.00";
    case "standard":
      return "#,##0.00";
    case "percent":
      return "0.00%";
    case "scientific":
      return "0.00E+00";
    case "short date":
      return NUMBER_FORMATS.date(locale);
    case "medium date":
      return "dd-mmm-yy";
    case "long date":
      return "dddd, mmmm dd, yyyy";
    case "general date":
      return NUMBER_FORMATS.datetime(locale);
    case "short time":
      return "h:mm";
    case "medium time":
      return "h:mm AM/PM";
    case "long time":
      return "h:mm:ss AM/PM";
    case "currency":
      return NUMBER_FORMATS.currency(locale);
    default:
      return null;
  }
}

/** The styles CSS gives a cell, as the document keeps them. */
function cssStyle(decls: Decls, locale: SheetLocale): CellStyle {
  const s: CellStyle = {};
  const weight = decls.get("font-weight");
  if (weight && (weight === "bold" || weight === "bolder" || Number(weight) >= 600)) s.b = 1;
  if (decls.get("font-style")?.includes("italic")) s.i = 1;
  const deco = `${decls.get("text-decoration") ?? ""} ${decls.get("text-decoration-line") ?? ""}`;
  if (deco.includes("underline")) s.u = 1;
  if (deco.includes("line-through")) s.x = 1;
  const color = cssColor(decls.get("color"));
  if (color) s.fc = color;
  const background = decls.get("background-color") ?? decls.get("background")?.split(/\s+/)[0];
  const bg = cssColor(background);
  if (bg) s.bg = bg;
  const align = decls.get("text-align");
  if (align === "left" || align === "start" || align === "justify") s.ha = "l";
  else if (align === "center" || align === "centre") s.ha = "c";
  else if (align === "right" || align === "end") s.ha = "r";
  const valign = decls.get("vertical-align");
  if (valign === "top") s.va = "t";
  else if (valign === "middle" || valign === "center") s.va = "m";
  else if (valign === "bottom") s.va = "b";
  const space = decls.get("white-space");
  if (space === "normal" || space === "pre-wrap" || space === "pre-line" || space === "break-spaces") s.w = 1;
  const size = decls.get("font-size");
  const pts = size ? cssPoints(size) : null;
  if (pts !== null) s.fs = Math.round(pts * 2) / 2;
  const all = decls.get("border");
  const sides: NonNullable<CellStyle["bd"]> = {};
  for (const [key, name] of [
    ["t", "top"],
    ["r", "right"],
    ["b", "bottom"],
    ["l", "left"],
  ] as const) {
    let side = borderOf(decls.get(`border-${name}`) ?? all);
    const style = decls.get(`border-${name}-style`);
    if (style) {
      side =
        style === "none" || style === "hidden"
          ? null
          : borderOf(`${style} ${decls.get(`border-${name}-width`) ?? ""} ${decls.get(`border-${name}-color`) ?? ""}`);
    }
    if (side) sides[key] = side;
  }
  if (sides.t || sides.r || sides.b || sides.l) s.bd = sides;
  const format = decls.get("mso-number-format");
  if (format) {
    const code = cssUnescape(format);
    const named = namedFormat(code, locale);
    if (named !== null) {
      if (named) s.nf = named;
    } else if (code) s.nf = code;
  }
  return s;
}

/** A style without what the table gives every cell anyway, nor the colors and alignments that are the defaults. */
function ownStyle(full: CellStyle, base: CellStyle, value: CellData["v"]): CellStyle | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(full)) {
    const b = (base as Record<string, unknown>)[key];
    if (key === "bd") {
      const sides: Record<string, unknown> = {};
      for (const [side, line] of Object.entries(v as object)) {
        if (!sameData(line, (b as Record<string, unknown> | undefined)?.[side])) sides[side] = line;
      }
      if (Object.keys(sides).length > 0) out.bd = sides;
      continue;
    }
    if (sameData(v, b)) continue;
    out[key] = v;
  }
  // Black text, white fill, bottom alignment and the alignment a value takes anyway are what a cell shows unformatted
  // (and black or white would stay so in the dark theme).
  if (out.fc === "#000000") delete out.fc;
  if (out.bg === "#ffffff") delete out.bg;
  if (out.va === "b") delete out.va;
  if (out.ha === "r" && typeof value === "number") delete out.ha;
  if (out.ha === "l" && typeof value === "string") delete out.ha;
  return cleanCellStyle(out);
}

/** A pasted cell read from HTML or text, before it lands. */
interface PasteCell extends ClipCell {
  /** Read `display` as if typed. */
  typed?: boolean;
  /** A Google Sheets formula in R1C1, read where it lands. */
  r1c1?: string;
  /** Covered by another cell's span. */
  covered?: boolean;
}

type Mark = "b" | "i" | "u" | "x";

const MARKS: readonly Mark[] = ["b", "i", "u", "x"];

/** Tags that only change how the words inside them look. */
const INLINE_TAGS = new Set(["b", "strong", "i", "em", "u", "s", "strike", "del", "span", "font", "a", "sup", "sub"]);
const TAG_MARKS: Record<string, Mark> = { b: "b", strong: "b", i: "i", em: "i", u: "u", s: "x", strike: "x", del: "x" };

/** How an inline tag makes the words inside it look: by its name, a `<font color>`, or its own style. */
interface InlineLook {
  marks: Mark[];
  color?: string;
}

interface OpenCell {
  attrs: Map<string, string | true>;
  lines: string[];
  text: string;
  /** The inline tags the reader is inside, innermost last. */
  inline: { tag: string; look: InlineLook }[];
  /** Whether every word so far was inside each mark (null: no words yet). */
  every: Record<Mark, boolean | null>;
  /** The one color every word had from its tags (undefined: no words yet; null: none, or several). */
  color: string | null | undefined;
}

function openCell(attrs: Map<string, string | true>): OpenCell {
  return { attrs, lines: [], text: "", inline: [], every: { b: null, i: null, u: null, x: null }, color: undefined };
}

function inlineLook(tag: Tag): InlineLook {
  const marks: Mark[] = [];
  const named = TAG_MARKS[tag.name];
  if (named) marks.push(named);
  let color: string | null = null;
  if (tag.name === "font") {
    const attr = tag.attrs.get("color");
    color = cssColor(typeof attr === "string" ? attr : undefined);
  }
  const style = tag.attrs.get("style");
  if (typeof style === "string") {
    const own = cssStyle(parseDecls(style), EN);
    for (const mark of MARKS) if (own[mark] && !marks.includes(mark)) marks.push(mark);
    if (own.fc) color = own.fc;
  }
  return color ? { marks, color } : { marks };
}

/** Adds words to a cell, noting how they look when they are more than spaces. */
function addText(cell: OpenCell, text: string): void {
  cell.text += text;
  if (text.trim() === "") return;
  for (const mark of MARKS) {
    const inside = cell.inline.some((entry) => entry.look.marks.includes(mark));
    cell.every[mark] = (cell.every[mark] ?? true) && inside;
  }
  let color: string | null = null;
  for (let k = cell.inline.length - 1; k >= 0 && color === null; k--) color = cell.inline[k]?.look.color ?? null;
  cell.color = cell.color === undefined || cell.color === color ? color : null;
}

function textOf(cell: OpenCell): string {
  const lines = [...cell.lines, cell.text].map((line) => line.replace(/[ \t\n\r\f]+/g, " ").trim());
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n").replace(/ /g, " ");
}

function sheetsValue(raw: string | true | undefined): { v?: CellData["v"] } | null {
  if (typeof raw !== "string") return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const type = data["1"];
    if (type === 2 && typeof data["2"] === "string") return { v: data["2"] };
    if (type === 3 && typeof data["3"] === "number") return { v: data["3"] };
    if (type === 4 && (data["4"] === 0 || data["4"] === 1 || typeof data["4"] === "boolean")) return { v: !!data["4"] };
    return null;
  } catch {
    return null;
  }
}

function sheetsFormat(raw: string | true | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    return typeof data["2"] === "string" && data["2"].length > 0 ? data["2"] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * LibreOffice's attributes: `sdval` holds a number and `sdnum` ("LCID;flags;code") its format, spelled in the language
 * of that LCID. Only US English codes (1033) are spelled as Excel's are, so a code in another language is left out
 * rather than misread; a boolean is a number with the code `BOOLEAN`.
 */
function calcValue(
  sdval: string | true | undefined,
  sdnum: string | true | undefined,
): { v: number | boolean; nf?: string } | null {
  if (typeof sdval !== "string" || sdval.trim() === "") return null;
  const n = Number(sdval);
  if (!Number.isFinite(n)) return null;
  const parts = typeof sdnum === "string" ? sdnum.split(";") : [];
  const code = parts.slice(2).join(";").trim();
  if (code.toUpperCase() === "BOOLEAN") return { v: n !== 0 };
  const plain = code === "" || ["general", "standard"].includes(code.toLowerCase());
  return parts[0]?.trim() === "1033" && !plain ? { v: n, nf: code } : { v: n };
}

/**
 * What each `<style …>…</style>` of a page holds, found by index: a regex tries the rest of the page again from each
 * `<style` left open (quadratic on a pasted page written to be slow).
 */
function styleBlocks(html: string): string[] {
  const out: string[] = [];
  const open = /<style/gi;
  const close = /<\/style>/gi;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const body = html.indexOf(">", m.index + m[0].length);
    if (body < 0) break;
    close.lastIndex = body + 1;
    const end = close.exec(html);
    if (!end) break;
    out.push(html.slice(body + 1, end.index));
    open.lastIndex = end.index + end[0].length;
  }
  return out;
}

/**
 * The first table of clipboard HTML as a grid of cells (spanned positions marked covered), with values from Excel's
 * (`x:num`, `x:str`, `x:bool`, `x:err`), Google Sheets' (`data-sheets-value`, `-numberformat`, `-formula`) and
 * LibreOffice's (`sdval`, `sdnum`) attributes when present, else the text to read as typed; styles from the page's
 * CSS, the cell's class, its own style and the inline tags its words are in. Null when there is no table.
 */
export function parseHtmlTable(html: string, locale: SheetLocale): ClipCell[][] | null {
  const tableAt = html.search(/<table[\s>]/i);
  if (tableAt < 0) return null;
  const rules: CssRule[] = [];
  for (const css of styleBlocks(html)) rules.push(...parseCss(css));
  const rows: OpenCell[][] = [];
  let tableAttrs: Map<string, string | true> | null = null;
  let depth = 0;
  let row: OpenCell[] | null = null;
  let cell: OpenCell | null = null;
  let skip: string | null = null;
  const closeCell = () => {
    if (cell && row) row.push(cell);
    cell = null;
  };
  const closeRow = () => {
    closeCell();
    if (row) rows.push(row);
    row = null;
  };
  let i = tableAt;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) {
      if (cell && !skip) addText(cell as OpenCell, decodeEntities(html.slice(i, textEnd)));
      i = textEnd;
      if (lt < 0) break;
    }
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    const tag = readTag(html, i);
    if (!tag) {
      if (cell && !skip) addText(cell as OpenCell, "<");
      i++;
      continue;
    }
    i = tag.end;
    if (skip) {
      if (tag.close && tag.name === skip) skip = null;
      continue;
    }
    if (tag.name === "style" || tag.name === "script") {
      if (!tag.close) skip = tag.name;
      continue;
    }
    if (tag.name === "table") {
      if (tag.close) {
        depth--;
        if (depth === 0) break;
      } else {
        depth++;
        if (depth === 1) tableAttrs = tag.attrs;
      }
      continue;
    }
    if (depth > 1) {
      // A table inside a cell: its words belong to the cell.
      if (cell && (tag.name === "br" || tag.name === "tr" || tag.name === "p" || tag.name === "div")) {
        (cell as OpenCell).lines.push((cell as OpenCell).text);
        (cell as OpenCell).text = "";
      }
      continue;
    }
    if (tag.name === "tr") {
      if (tag.close) closeRow();
      else {
        closeRow();
        row = [];
      }
      continue;
    }
    if (tag.name === "td" || tag.name === "th") {
      if (tag.close) closeCell();
      else {
        closeCell();
        if (!row) row = [];
        cell = openCell(tag.attrs);
      }
      continue;
    }
    if (!cell) continue;
    const open = cell as OpenCell;
    if (tag.name === "br" && !tag.close) {
      open.lines.push(open.text);
      open.text = "";
    } else if (["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag.name)) {
      if (open.text.trim() !== "") {
        open.lines.push(open.text);
        open.text = "";
      }
    } else if (INLINE_TAGS.has(tag.name)) {
      if (!tag.close) open.inline.push({ tag: tag.name, look: inlineLook(tag) });
      else {
        const at = open.inline.map((entry) => entry.tag).lastIndexOf(tag.name);
        if (at >= 0) open.inline.splice(at);
      }
    }
  }
  closeRow();
  if (rows.length === 0) return null;

  // What every cell of the table has: the `td` rule and what the table's own style passes down to its cells.
  const tableDecls = parseDecls(
    typeof tableAttrs?.get("style") === "string" ? (tableAttrs?.get("style") as string) : "",
  );
  const inherited: Decls = new Map();
  for (const prop of ["font-size", "font-weight", "font-style", "color", "white-space"]) {
    const v = tableDecls.get(prop);
    if (v) inherited.set(prop, v);
  }
  const baseFor = (tagName: string): Decls => {
    const decls: Decls = new Map(inherited);
    for (const rule of rules) if (rule.tag === tagName && !rule.cls) for (const [k, v] of rule.decls) decls.set(k, v);
    return decls;
  };
  const baseStyle = cssStyle(baseFor("td"), locale);

  const grid: PasteCell[][] = [];
  const taken = new Set<string>();
  rows.forEach((cells, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const open of cells) {
      while (taken.has(`${r}:${c}`)) c++;
      const attr = (name: string) => open.attrs.get(name);
      const rowspan = Math.max(1, Math.min(1000, Number(attr("rowspan")) || 1));
      const colspan = Math.max(1, Math.min(500, Number(attr("colspan")) || 1));
      for (let i = 0; i < rowspan; i++) {
        for (let j = 0; j < colspan; j++) {
          taken.add(`${r + i}:${c + j}`);
          if (i > 0 || j > 0) {
            grid[r + i] ??= [];
            (grid[r + i] as PasteCell[])[c + j] = { covered: true };
          }
        }
      }
      // Styles: the `td` rule, then the cell's classes, then its own style attribute.
      const decls: Decls = baseFor("td");
      const classes = typeof attr("class") === "string" ? (attr("class") as string).toLowerCase().split(/\s+/) : [];
      for (const rule of rules) {
        if (rule.cls && classes.includes(rule.cls) && (!rule.tag || rule.tag === "td" || rule.tag === "th")) {
          for (const [k, v] of rule.decls) decls.set(k, v);
        }
      }
      const inline = attr("style");
      if (typeof inline === "string") for (const [k, v] of parseDecls(inline)) decls.set(k, v);
      const full = cssStyle(decls, locale);
      // Words all inside <b>, <i>, <u>, <s> or a colored <font> or <span> give the cell that look.
      for (const mark of MARKS) if (open.every[mark]) full[mark] = 1;
      if (open.color) full.fc = open.color;
      const sheetsNf = sheetsFormat(attr("data-sheets-numberformat"));
      if (sheetsNf) full.nf = sheetsNf;
      const fromCalc = calcValue(attr("sdval"), attr("sdnum"));
      if (fromCalc?.nf) full.nf = fromCalc.nf;
      const text = textOf(open);
      const out: PasteCell = { display: text };
      const fromSheets = sheetsValue(attr("data-sheets-value"));
      const num = attr("x:num");
      const str = attr("x:str");
      const bool = attr("x:bool");
      const err = attr("x:err");
      if (fromSheets) {
        if (fromSheets.v !== undefined) out.v = fromSheets.v;
      } else if (fromCalc) out.v = fromCalc.v;
      else if (typeof num === "string" && num.trim() !== "" && Number.isFinite(Number(num))) out.v = Number(num);
      else if (str !== undefined) out.v = typeof str === "string" ? str : text;
      else if (typeof bool === "string") out.v = bool.toUpperCase() === "TRUE" || bool === "1";
      else if (typeof err === "string" && errorFromText(err)) out.e = errorFromText(err) as ErrorCode;
      else out.typed = true;
      const formula = attr("data-sheets-formula");
      if (typeof formula === "string" && formula.startsWith("=")) out.r1c1 = formula;
      const style = ownStyle(full, baseStyle, out.v);
      if (style) out.s = style;
      // Excel writes text running over its empty neighbors as a span it marks `mso-ignore:colspan`: not a merge.
      const spill = decls.get("mso-ignore")?.includes("colspan") === true;
      if (rowspan > 1 || (colspan > 1 && !spill)) out.span = { rows: rowspan, cols: spill ? 1 : colspan };
      (grid[r] as PasteCell[])[c] = out;
      c += colspan;
    }
  });
  for (let r = 0; r < grid.length; r++) grid[r] ??= [];
  const width = grid.reduce((w, row) => Math.max(w, row.length), 0);
  return grid.map((row) => Array.from({ length: width }, (_, c) => row[c] ?? {}));
}

// ---------------------------------------------------------------------------------------------------------------------
// Paste

/** Whether a canonical formula only calls functions the engine knows (so reading it in English was right). */
function knownFunctions(f: string): boolean {
  const known = new Set(FUNCTION_NAMES);
  let ok = true;
  const visit = (ast: ReturnType<typeof parseCanonical>): void => {
    switch (ast.t) {
      case "call":
        if (!known.has(ast.fn)) ok = false;
        for (const arg of ast.args) visit(arg);
        return;
      case "un":
      case "paren":
        visit(ast.a);
        return;
      case "bin":
        visit(ast.a);
        visit(ast.b);
        return;
      case "arr":
        for (const row of ast.rows) for (const item of row) visit(item);
        return;
      default:
        return;
    }
  };
  try {
    visit(parseCanonical(f));
  } catch {
    return false;
  }
  return ok;
}

/**
 * A formula as text landing on a sheet, in canonical form; null when it can't be read there. Text from another app
 * may be English or the person's language: English is tried first and kept only when every function is known.
 */
function landFormula(
  doc: Y.Doc,
  sheet: string,
  text: string,
  locales: readonly SheetLocale[],
): { f: string; needs?: Needs; needsSheets?: Record<string, Needs> } | null {
  for (const loc of locales) {
    const result = toCanonical(text, { doc, sheetId: sheet, locale: loc });
    if (!result.ok) continue;
    if (locales.length > 1 && loc !== locales[locales.length - 1] && !knownFunctions(result.f)) continue;
    const out: { f: string; needs?: Needs; needsSheets?: Record<string, Needs> } = { f: result.f };
    if (result.needs) out.needs = result.needs;
    if (result.needsSheets) out.needsSheets = result.needsSheets;
    return out;
  }
  return null;
}

/** An error kept as a value: a formula that is just the error (`#N/A`). */
function errorCell(code: ErrorCode, s: CellStyle | undefined): CellData {
  return s ? { f: code, s } : { f: code };
}

/**
 * Pastes at `at` (the top-left cell) and returns the range written. `cells` (the app's own copy) win over `html`,
 * which wins over `tsv`; text is read as typed in `locale`. Formulas move as copies do; ones copied from another
 * sheet or another file travel as English A1 and are read again where they land. `valuesOnly` pastes what cells showed
 * (computed values), keeping the formats already there. With `into`, a copy that fits a whole number of times into it
 * repeats to fill it, as in Excel. Merges in the way are undone; merges copied are made again. The sheet grows to fit.
 */
export function pasteCells(
  doc: Y.Doc,
  at: CellAt,
  clip: ClipSource,
  locale: SheetLocale,
  origin: LiveOrigin,
  opts: { valuesOnly?: boolean; into?: RangeIds } = {},
): RangeIds {
  if (!sheetMap(doc, at.sheet)) throw new SheetError("no_sheet", `There is no sheet ${at.sheet}`);
  checkIndex(at.row, "row");
  checkIndex(at.col, "column");
  const single: RangeIds = { sheet: at.sheet, r1: at.row, c1: at.col, r2: at.row, c2: at.col };
  let grid: PasteCell[][] | null = null;
  let kind: "cells" | "html" | "tsv" = "cells";
  if (clip.cells && clip.cells.length > 0 && clip.cells.some((row) => row.length > 0)) grid = clip.cells;
  else if (clip.html) {
    grid = parseHtmlTable(clip.html, locale);
    kind = "html";
  }
  if (!grid && clip.tsv !== undefined) {
    grid = parseTsv(clip.tsv).map((row) => row.map((text) => ({ display: text, typed: true })));
    kind = "tsv";
  }
  if (!grid || grid.length === 0) return single;
  const height = grid.length;
  const width = grid.reduce((w, row) => Math.max(w, row.length), 0);
  if (width === 0) return single;
  let target: RangeIds = { ...single, r2: at.row + height - 1, c2: at.col + width - 1 };
  if (opts.into) {
    const into = normalizeRange(opts.into);
    const ih = into.r2 - into.r1 + 1;
    const iw = into.c2 - into.c1 + 1;
    if (into.sheet === at.sheet && ih % height === 0 && iw % width === 0 && (ih > height || iw > width)) target = into;
  }
  const size = sheetSize(doc, at.sheet);
  checkSize(Math.max(size.rows, target.r2 + 1), Math.max(size.cols, target.c2 + 1));
  const area = (target.r2 - target.r1 + 1) * (target.c2 - target.c1 + 1);
  if (area > SHEET_LIMITS.cells) {
    throw new SheetError("limit", `A spreadsheet holds at most ${SHEET_LIMITS.cells} cells`, [
      { max: SHEET_LIMITS.cells },
    ]);
  }
  const sourceOf = (r: number, c: number): PasteCell =>
    grid?.[(r - target.r1) % height]?.[(c - target.c1) % width] ?? {};
  const rowsBefore = rowIds(doc, at.sheet);
  const colsBefore = colIds(doc, at.sheet);
  const cellsBefore = cellsMap(doc, at.sheet);
  const currentAt = (r: number, c: number): CellData | undefined => {
    const row = rowsBefore[r];
    const col = colsBefore[c];
    return row !== undefined && col !== undefined ? readCell(cellsBefore?.get(cellKey(row, col))) : undefined;
  };
  const hasContent = (p: PasteCell) =>
    !p.covered &&
    (p.v !== undefined || p.f !== undefined || p.e !== undefined || !!p.display || (!opts.valuesOnly && !!p.s));
  let added = 0;
  for (let r = target.r1; r <= target.r2; r++) {
    for (let c = target.c1; c <= target.c2; c++) if (!currentAt(r, c) && hasContent(sourceOf(r, c))) added++;
  }
  checkCellRoom(doc, added);

  // Formulas copied in this file move by ids (onto another sheet's rows when pasted there); from another file they
  // travel as English A1 and are read where they land.
  const source = clip.source;
  const sameDoc = !!source && !!sheetMap(doc, source.sheet);

  doc.transact(() => {
    const parts = sheetParts(doc, at.sheet);
    growTo(parts, Math.max(parts.rows.length, target.r2 + 1), Math.max(parts.cols.length, target.c2 + 1));
    // Merges in the way are undone, as the paste writes over them.
    const rowAt = new Map(parts.rows.toArray().map((id, i) => [id, i]));
    const colAt = new Map(parts.cols.toArray().map((id, i) => [id, i]));
    for (const [key, raw] of [...parts.merges.entries()]) {
      const m = raw as Merge;
      const a = rowAt.get(m?.r1);
      const b = rowAt.get(m?.r2);
      const c = colAt.get(m?.c1);
      const d = colAt.get(m?.c2);
      if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
      if (overlaps({ r1: Math.min(a, b), r2: Math.max(a, b), c1: Math.min(c, d), c2: Math.max(c, d) }, target)) {
        parts.merges.delete(key);
      }
    }
    const rows = parts.rows.toArray();
    const cols = parts.cols.toArray();
    // Formulas read where they land, after the sheet has grown to what they point at (within the limits).
    type Pending = {
      key: string;
      text: string;
      how: "a1" | "r1c1" | "typed";
      s: CellStyle | undefined;
      fallback: CellData | undefined;
    };
    const pending: Pending[] = [];
    const localesFor = (how: Pending["how"]) => (how === "a1" ? [EN] : locale.tag === EN.tag ? [EN] : [EN, locale]);
    for (let r = target.r1; r <= target.r2; r++) {
      for (let c = target.c1; c <= target.c2; c++) {
        const p = sourceOf(r, c);
        const key = cellKey(rows[r] as string, cols[c] as string);
        const current = readCell(parts.cells.get(key));
        const sr = source ? source.r1 + ((r - target.r1) % height) : r;
        const sc = source ? source.c1 + ((c - target.c1) % width) : c;
        const kept = current?.s;
        if (p.covered) {
          writeCell(parts.cells, key, opts.valuesOnly && kept ? { s: kept } : undefined);
          continue;
        }
        const style = opts.valuesOnly || kind === "tsv" ? kept : p.s;
        // The cell as a value: what it computed, a value from a table, an error, or its text read as typed.
        const valueCell = (): CellData | undefined => {
          if (p.v !== undefined) return style ? { v: p.v, s: style } : { v: p.v };
          if (p.e !== undefined) return errorCell(p.e, style);
          if (p.display) {
            const typed = planInput(doc, at.sheet, p.display, locale, style ? { s: style } : undefined, {
              truncate: true,
            });
            if (typed.ok && !typed.needs) return typed.cell;
            return style ? { v: p.display, s: style } : { v: p.display };
          }
          return style ? { s: style } : undefined;
        };
        if (opts.valuesOnly) {
          writeCell(parts.cells, key, valueCell());
          continue;
        }
        if (kind === "cells" && p.f !== undefined) {
          if (sameDoc && source) {
            const f = shiftFormula(p.f, r - sr, c - sc, { doc, sheetId: source.sheet, toSheet: at.sheet });
            writeCell(parts.cells, key, style ? { f, s: style } : { f });
          } else if (p.a1) {
            const text = shiftA1Formula(p.a1, r - sr, c - sc);
            pending.push({ key, text, how: "a1", s: style, fallback: valueCell() });
          } else writeCell(parts.cells, key, valueCell());
          continue;
        }
        if (p.r1c1) {
          pending.push({ key, text: r1c1ToA1(p.r1c1, r, c), how: "r1c1", s: style, fallback: valueCell() });
          continue;
        }
        if (p.typed && p.display?.trim().startsWith("=")) {
          const text = p.display;
          pending.push({ key, text, how: "typed", s: style, fallback: style ? { v: text, s: style } : { v: text } });
          continue;
        }
        writeCell(parts.cells, key, valueCell());
      }
    }
    if (pending.length > 0) {
      type Read = { cell: CellData; needs?: Needs; needsSheets?: Record<string, Needs> } | null;
      const read = (p: Pending): Read => {
        if (p.how === "typed") {
          const plan = planInput(doc, at.sheet, p.text, locale, p.s ? { s: p.s } : undefined, { truncate: true });
          if (!plan.ok || !plan.cell) return null;
          const out: Read = { cell: plan.cell };
          if (plan.needs) out.needs = plan.needs;
          if (plan.needsSheets) out.needsSheets = plan.needsSheets;
          return out;
        }
        const landed = landFormula(doc, at.sheet, p.text, localesFor(p.how));
        if (!landed) return null;
        const out: Read = { cell: p.s ? { f: landed.f, s: p.s } : { f: landed.f } };
        if (landed.needs) out.needs = landed.needs;
        if (landed.needsSheets) out.needsSheets = landed.needsSheets;
        return out;
      };
      let results = pending.map(read);
      const needs: SheetNeeds = new Map();
      for (const result of results) if (result) addNeeds(needs, at.sheet, result);
      if (growSheets(doc, needs)) {
        results = pending.map((p, k) => {
          const before = results[k] ?? null;
          return before && (before.needs || before.needsSheets) ? read(p) : before;
        });
      }
      for (let k = 0; k < pending.length; k++) {
        const p = pending[k] as Pending;
        writeCell(parts.cells, p.key, results[k]?.cell ?? p.fallback);
      }
    }
    // Merges copied are made again, cut to what was pasted.
    if (!opts.valuesOnly) {
      for (let r = target.r1; r <= target.r2; r++) {
        for (let c = target.c1; c <= target.c2; c++) {
          const span = sourceOf(r, c).span;
          if (!span || (span.rows <= 1 && span.cols <= 1)) continue;
          const r2 = Math.min(target.r2, r + span.rows - 1);
          const c2 = Math.min(target.c2, c + span.cols - 1);
          if (r2 === r && c2 === c) continue;
          const merge: Merge = {
            r1: rows[r] as string,
            c1: cols[c] as string,
            r2: rows[r2] as string,
            c2: cols[c2] as string,
          };
          parts.merges.set(cellKey(merge.r1, merge.c1), merge);
        }
      }
    }
  }, origin);
  return target;
}

// ---------------------------------------------------------------------------------------------------------------------
// Cut and paste

/** Undoes the merges of a sheet that share a cell with `range`. */
function unmergeOver(parts: SheetParts, range: RangeIds): void {
  const rowAt = indexOf(parts.rows.toArray());
  const colAt = indexOf(parts.cols.toArray());
  for (const [key, raw] of [...parts.merges.entries()]) {
    const m = raw as Merge;
    const a = rowAt.get(m?.r1);
    const b = rowAt.get(m?.r2);
    const c = colAt.get(m?.c1);
    const d = colAt.get(m?.c2);
    if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
    if (overlaps({ r1: Math.min(a, b), r2: Math.max(a, b), c1: Math.min(c, d), c2: Math.max(c, d) }, range)) {
      parts.merges.delete(key);
    }
  }
}

/**
 * Every formula of the document that points at a moved cell, or at a range wholly inside the moved block, follows it
 * to where it went (`rows` and `cols` map the block's ids on `fromSheet` to their new ones on `toSheet`). Whole rows
 * and columns stay, as in Excel.
 */
function followMoved(
  doc: Y.Doc,
  fromSheet: string,
  toSheet: string,
  rows: ReadonlyMap<string, string>,
  cols: ReadonlyMap<string, string>,
): void {
  for (const sheet of sheetIds(doc)) {
    const cells = cellsMap(doc, sheet);
    if (!cells) continue;
    for (const [key, raw] of [...cells.entries()]) {
      const cell = readCell(raw);
      if (!cell?.f?.includes("{")) continue;
      const f = rewriteRefs(cell.f, (node) => {
        const ends = node.t === "ref" ? [node.ref] : [node.from, node.to];
        const inside = ends.every(
          (ref) =>
            (ref.sheet ?? sheet) === fromSheet &&
            ref.row !== null &&
            ref.col !== null &&
            rows.has(ref.row) &&
            cols.has(ref.col),
        );
        if (!inside) return false;
        for (const ref of ends) {
          ref.row = rows.get(ref.row as string) as string;
          ref.col = cols.get(ref.col as string) as string;
          // A reference to the formula's own sheet goes unnamed, as typed ones do.
          if (toSheet === sheet) delete ref.sheet;
          else ref.sheet = toSheet;
        }
        return true;
      });
      if (f) cells.set(key, { ...cell, f });
    }
  }
}

/**
 * Moves a range's cells so its top-left lands on `to`, as cutting and pasting does in Excel: values, formulas, formats
 * and the merges inside it go there and leave their old place empty. Moved formulas keep pointing where they did
 * (a copy's would shift), naming their old sheet when they land on another, and every formula in the file that
 * pointed at a moved cell, or at a range wholly inside the block, follows it. What it lands on is replaced and merges
 * in the way are undone; a merge only partly inside the range can't be moved (`merged`), as in Excel. The sheet grows
 * to fit. Returns the range the cells landed on.
 */
export function moveRange(doc: Y.Doc, from: RangeIds, to: CellAt, origin: LiveOrigin): RangeIds {
  if (!sheetMap(doc, from.sheet)) throw new SheetError("no_sheet", `There is no sheet ${from.sheet}`);
  if (!sheetMap(doc, to.sheet)) throw new SheetError("no_sheet", `There is no sheet ${to.sheet}`);
  checkIndex(to.row, "row");
  checkIndex(to.col, "column");
  const src = clampRange(doc, from);
  if (!src) throw new SheetError("range", "Move cells that are on the sheet");
  const height = src.r2 - src.r1 + 1;
  const width = src.c2 - src.c1 + 1;
  const dst: RangeIds = { sheet: to.sheet, r1: to.row, c1: to.col, r2: to.row + height - 1, c2: to.col + width - 1 };
  if (src.sheet === dst.sheet && src.r1 === dst.r1 && src.c1 === dst.c1) return dst;
  const size = sheetSize(doc, to.sheet);
  checkSize(Math.max(size.rows, dst.r2 + 1), Math.max(size.cols, dst.c2 + 1));
  const merges = readMerges(doc, src.sheet).filter((m) => overlaps(m, src));
  const within = (m: { r1: number; c1: number; r2: number; c2: number }) =>
    m.r1 >= src.r1 && m.r2 <= src.r2 && m.c1 >= src.c1 && m.c2 <= src.c2;
  if (merges.some((m) => !within(m))) throw new SheetError("merged", "Part of a merged cell can't be moved");
  doc.transact(() => {
    const target = sheetParts(doc, dst.sheet);
    growTo(target, Math.max(target.rows.length, dst.r2 + 1), Math.max(target.cols.length, dst.c2 + 1));
    const source = sheetParts(doc, src.sheet);
    const fromRows = source.rows.toArray();
    const fromCols = source.cols.toArray();
    const toRows = target.rows.toArray();
    const toCols = target.cols.toArray();
    const rowTo = new Map<string, string>();
    const colTo = new Map<string, string>();
    for (let i = 0; i < height; i++) rowTo.set(fromRows[src.r1 + i] as string, toRows[dst.r1 + i] as string);
    for (let j = 0; j < width; j++) colTo.set(fromCols[src.c1 + j] as string, toCols[dst.c1 + j] as string);
    // The cells as they are now; on another sheet, their references to this one's cells name it.
    const moving: { from: string; to: string; cell: CellData | undefined }[] = [];
    for (let i = 0; i < height; i++) {
      for (let j = 0; j < width; j++) {
        const fromKey = cellKey(fromRows[src.r1 + i] as string, fromCols[src.c1 + j] as string);
        let cell = readCell(source.cells.get(fromKey));
        if (cell?.f && src.sheet !== dst.sheet) {
          const f = rewriteRefs(cell.f, (node) => {
            let changed = false;
            for (const ref of node.t === "ref" ? [node.ref] : [node.from, node.to]) {
              if (ref.sheet === undefined) {
                ref.sheet = src.sheet;
                changed = true;
              }
            }
            return changed;
          });
          if (f) cell = { ...cell, f };
        }
        moving.push({ from: fromKey, to: cellKey(toRows[dst.r1 + i] as string, toCols[dst.c1 + j] as string), cell });
      }
    }
    const movedMerges = merges.map(
      (m): Merge => ({
        r1: toRows[dst.r1 + (m.r1 - src.r1)] as string,
        c1: toCols[dst.c1 + (m.c1 - src.c1)] as string,
        r2: toRows[dst.r1 + (m.r2 - src.r1)] as string,
        c2: toCols[dst.c1 + (m.c2 - src.c1)] as string,
      }),
    );
    for (const m of merges) source.merges.delete(m.key);
    unmergeOver(target, dst);
    // The old place empties first, so where the two overlap the moved cells win.
    for (const m of moving) writeCell(source.cells, m.from, undefined);
    for (const m of moving) writeCell(target.cells, m.to, m.cell);
    for (const m of movedMerges) target.merges.set(cellKey(m.r1, m.c1), m);
    followMoved(doc, src.sheet, dst.sheet, rowTo, colTo);
  }, origin);
  return dst;
}
