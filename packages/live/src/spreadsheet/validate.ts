/**
 * The rules of shape of a spreadsheet document (ADR 0196 §2): what the server checks when it compacts a document,
 * so a buggy or hostile client can't leave one no app can open. Readers already skip what is out of shape; this says
 * what it is, as sentences, and what passes `LIVE_LIMITS`. States people reach by working at once (an id repeated by
 * two moves of one sheet, a cell left behind in a row someone deleted) are not problems.
 */
import * as Y from "yjs";
import { cleanCellStyle, isHexColor, NUMBER_FORMAT_MAX, parseCellKey, readMerge, sheetIds } from "./doc";
import { CANONICAL_FORMULA_MAX, SHEET_LIMITS } from "./write";

/** The most problems a check lists. */
const MAX_PROBLEMS = 50;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

const CELL_KEYS = new Set(["v", "f", "s"]);
const STYLE_KEYS = new Set(["b", "i", "u", "x", "fc", "bg", "ha", "va", "w", "nf", "fs", "bd"]);

/** Why a stored cell is out of shape, or null. */
function cellProblem(raw: unknown): string | null {
  if (!isPlainObject(raw)) return "isn't an object";
  for (const key of Object.keys(raw)) if (!CELL_KEYS.has(key)) return `has an unknown field "${key}"`;
  const { v, f, s } = raw;
  if (v !== undefined) {
    if (typeof v === "number" && !Number.isFinite(v)) return "holds a number that isn't finite";
    if (typeof v === "string" && v.length > SHEET_LIMITS.cellChars) return "holds text past the limit";
    if (typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean") return "holds a value of no kind";
  }
  if (f !== undefined && (typeof f !== "string" || f.length === 0)) return "holds a formula that isn't text";
  if (typeof f === "string" && f.length > CANONICAL_FORMULA_MAX) return "holds a formula past the limit";
  if (s !== undefined) {
    if (!isPlainObject(s)) return "has a style that isn't an object";
    for (const key of Object.keys(s)) if (!STYLE_KEYS.has(key)) return `has an unknown style "${key}"`;
    if (typeof s.nf === "string" && s.nf.length > NUMBER_FORMAT_MAX) return "has a number format past the limit";
    const clean = cleanCellStyle(s) ?? {};
    for (const key of Object.keys(s)) {
      if (key === "nf" && typeof s.nf === "string" && s.nf.toLowerCase() === "general") continue;
      if (!(key in clean)) return `has a style "${key}" out of shape`;
    }
  }
  return null;
}

function idArrayProblem(value: unknown, what: string, max: number): string | null {
  if (!(value instanceof Y.Array)) return `its ${what} aren't a list`;
  if (value.length === 0) return `it has no ${what}`;
  if (value.length > max) return `it has ${value.length} ${what} (at most ${max})`;
  const seen = new Set<string>();
  for (const id of value.toArray()) {
    if (typeof id !== "string" || id.length === 0 || id.length > 64)
      return `its ${what} hold something that isn't an id`;
    if (seen.has(id)) return `its ${what} repeat an id`;
    seen.add(id);
  }
  return null;
}

function sizesProblem(value: unknown, what: string): string | null {
  if (!(value instanceof Y.Map)) return `its ${what} aren't a map`;
  for (const size of value.values()) {
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0 || size > 10_000) {
      return `its ${what} hold something that isn't a size`;
    }
  }
  return null;
}

/**
 * What is out of shape or past the limits in a spreadsheet document, as sentences (empty: nothing). Lists at most 50
 * problems; a sheet's cells are summed up in one.
 */
export function validateSpreadsheet(doc: Y.Doc): string[] {
  const problems: string[] = [];
  const add = (text: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push(text);
  };
  for (const id of doc.getArray<unknown>("sheetOrder").toArray()) {
    if (typeof id !== "string") {
      add("The sheet order holds something that isn't a sheet id");
      break;
    }
  }
  const sheets = doc.getMap<unknown>("sheets");
  const ids = sheetIds(doc);
  if (ids.length === 0) add("The spreadsheet has no sheets");
  if (ids.length > SHEET_LIMITS.sheets)
    add(`The spreadsheet has ${ids.length} sheets (at most ${SHEET_LIMITS.sheets})`);
  let total = 0;
  for (const [id, sheet] of sheets.entries()) {
    if (!(sheet instanceof Y.Map)) {
      add(`Sheet ${id} isn't a map`);
      continue;
    }
    const name = sheet.get("name");
    const label = typeof name === "string" && name.length > 0 ? `Sheet "${name.slice(0, 40)}"` : `Sheet ${id}`;
    if (typeof name !== "string" || name.trim().length === 0) add(`${label} has no name`);
    else if (name.length > 100) add(`${label} has a name past the limit`);
    const rows = idArrayProblem(sheet.get("rows"), "rows", SHEET_LIMITS.rows);
    if (rows) add(`${label}: ${rows}`);
    const cols = idArrayProblem(sheet.get("cols"), "columns", SHEET_LIMITS.cols);
    if (cols) add(`${label}: ${cols}`);
    const cells = sheet.get("cells");
    if (!(cells instanceof Y.Map)) add(`${label}: its cells aren't a map`);
    else {
      total += cells.size;
      let bad = 0;
      let first: string | null = null;
      for (const [key, raw] of cells.entries()) {
        const problem = parseCellKey(key) ? cellProblem(raw) : "has a key that isn't row:column";
        if (problem) {
          bad++;
          first ??= problem;
        }
      }
      if (bad > 0) add(`${label}: ${bad} cell${bad === 1 ? "" : "s"} out of shape (one ${first})`);
    }
    for (const [key, what] of [
      ["colWidths", "column widths"],
      ["rowHeights", "row heights"],
    ] as const) {
      const problem = sizesProblem(sheet.get(key), what);
      if (problem) add(`${label}: ${problem}`);
    }
    const merges = sheet.get("merges");
    if (!(merges instanceof Y.Map)) add(`${label}: its merges aren't a map`);
    else {
      for (const merge of merges.values()) {
        if (!readMerge(merge)) {
          add(`${label}: a merge isn't four ids`);
          break;
        }
      }
    }
    const frozen = sheet.get("frozen");
    const count = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0;
    if (!isPlainObject(frozen) || !count(frozen.rows) || !count(frozen.cols))
      add(`${label}: its frozen panes aren't two counts`);
    const tab = sheet.get("tab");
    if (tab !== undefined && !isHexColor(tab)) add(`${label}: its tab color isn't a color`);
  }
  if (total > SHEET_LIMITS.cells) add(`The spreadsheet has ${total} cells (at most ${SHEET_LIMITS.cells})`);
  return problems;
}
