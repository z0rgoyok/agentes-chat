/**
 * Edits to a spreadsheet (ADR 0196 §2), shared by the web, the phone and the agents' tools. Each one runs in one
 * transaction with the caller's origin (so undo in the apps takes back exactly one edit, and only the person's own),
 * checks `LIVE_LIMITS` and its input before it writes anything, and keeps every invariant kept by id: inserting rows
 * or columns moves cells, widths, heights and merges with them, deleting them takes their cells, widths and heights
 * along, shrinks the merges and frozen panes they were part of, and moves the edge of a formula's range that pointed
 * at them inward (`=SUM(A1:A10)` without row 1 reads `=SUM(A1:A9)`), as other spreadsheets do; a reference to a
 * single deleted cell reads `#REF!`.
 */
import type * as Y from "yjs";
import { newId } from "../ids";
import type { LiveOrigin } from "../origins";
import {
  type BorderSide,
  type CellData,
  type CellStyle,
  cellKey,
  cellsMap,
  cleanCellStyle,
  cleanSheetName,
  colIds,
  DEFAULT_COL_WIDTH,
  DEFAULT_COLS,
  DEFAULT_ROW_HEIGHT,
  DEFAULT_ROWS,
  frozenOf,
  getCell,
  indexOf,
  isHexColor,
  MAX_COL_WIDTH,
  MAX_FONT_PT,
  MAX_ROW_HEIGHT,
  type Merge,
  MIN_FONT_PT,
  MIN_SIZE,
  NUMBER_FORMAT_MAX,
  newSheetMap,
  parseCellKey,
  readCell,
  readMerge,
  readMerges,
  rowIds,
  SheetError,
  type SheetParts,
  type SheetValues,
  sheetByName,
  sheetIds,
  sheetMap,
  sheetName,
  sheetOrderArray,
  sheetParts,
  sheetSize,
  sheetsMap,
  uniqueSheetName,
} from "./doc";
import {
  type Ast,
  adjustForDeletion,
  type FormulaProblem,
  parseCanonical,
  printCanonical,
  shiftFormula,
} from "./formula";
import type { SheetLocale } from "./locale";
import type { CellValue } from "./values";
import {
  addNeeds,
  type CellAt,
  cellName,
  checkCellRoom,
  checkIndex,
  checkSize,
  clampRange,
  growSheets,
  growTo,
  type InputOptions,
  overlaps,
  planInput,
  type RangeIds,
  SHEET_LIMITS,
  type SheetNeeds,
  writeCell,
} from "./write";

// ---------------------------------------------------------------------------------------------------------------------
// Sheets

function insertIntoOrder(doc: Y.Doc, id: string, index: number | undefined): void {
  const order = sheetOrderArray(doc);
  const others = sheetIds(doc).filter((s) => s !== id);
  const at = index === undefined || !Number.isFinite(index) ? others.length : Math.floor(index);
  const before = others[Math.max(0, Math.min(at, others.length))];
  const raw = order.toArray();
  const pos = before === undefined ? -1 : raw.indexOf(before);
  order.insert(pos < 0 ? raw.length : pos, [id]);
}

function removeFromOrder(doc: Y.Doc, id: string): void {
  const order = sheetOrderArray(doc);
  const raw = order.toArray();
  for (let i = raw.length - 1; i >= 0; i--) if (raw[i] === id) order.delete(i, 1);
}

function requireSheet(doc: Y.Doc, sheetId: string): void {
  if (!sheetMap(doc, sheetId)) throw new SheetError("no_sheet", `There is no sheet ${sheetId}`);
}

function sheetLimit(doc: Y.Doc): void {
  if (sheetIds(doc).length >= SHEET_LIMITS.sheets) {
    throw new SheetError("limit", `A spreadsheet holds at most ${SHEET_LIMITS.sheets} sheets`, [
      { max: SHEET_LIMITS.sheets },
    ]);
  }
}

function freeName(doc: Y.Doc, name: string, except?: string): string {
  const clean = cleanSheetName(name);
  if (!clean) throw new SheetError("sheet_name", "A sheet needs a name");
  const taken = sheetByName(doc, clean);
  if (taken !== null && taken !== except) {
    throw new SheetError("sheet_name_taken", `There is already a sheet named "${clean}"`);
  }
  return clean;
}

function gridCount(n: number | undefined, fallback: number, what: string): number {
  if (n === undefined) return fallback;
  if (!Number.isInteger(n) || n < 1) throw new SheetError("range", `A sheet needs at least 1 ${what}`);
  return n;
}

/**
 * Adds a sheet (100 rows by 26 columns unless given) at `at` in the order (the end by default) and returns its id.
 * The name is cleaned as Excel requires; a name another sheet has is refused (`nextSheetName` gives a free one).
 */
export function addSheet(
  doc: Y.Doc,
  name: string,
  origin: LiveOrigin,
  opts: { rows?: number; cols?: number; at?: number } = {},
): string {
  const clean = freeName(doc, name);
  sheetLimit(doc);
  const rows = gridCount(opts.rows, DEFAULT_ROWS, "row");
  const cols = gridCount(opts.cols, DEFAULT_COLS, "column");
  checkSize(rows, cols);
  const id = newId();
  doc.transact(() => {
    sheetsMap(doc).set(id, newSheetMap(clean, rows, cols));
    insertIntoOrder(doc, id, opts.at);
  }, origin);
  return id;
}

/** Renames a sheet; formulas name sheets by id, so they read the new name at once. */
export function renameSheet(doc: Y.Doc, sheetId: string, name: string, origin: LiveOrigin): void {
  requireSheet(doc, sheetId);
  const clean = freeName(doc, name, sheetId);
  if (sheetName(doc, sheetId) === clean) return;
  doc.transact(() => sheetMap(doc, sheetId)?.set("name", clean), origin);
}

/** Deletes a sheet (never the last one); formulas that pointed at it read `#REF!`. */
export function deleteSheet(doc: Y.Doc, sheetId: string, origin: LiveOrigin): void {
  requireSheet(doc, sheetId);
  if (sheetIds(doc).length <= 1) throw new SheetError("last_sheet", "A spreadsheet keeps at least one sheet");
  doc.transact(() => {
    removeFromOrder(doc, sheetId);
    sheetsMap(doc).delete(sheetId);
  }, origin);
}

/** Moves a sheet to `toIndex` in the order (clamped). */
export function moveSheet(doc: Y.Doc, sheetId: string, toIndex: number, origin: LiveOrigin): void {
  requireSheet(doc, sheetId);
  const ids = sheetIds(doc);
  const target = Math.max(0, Math.min(Math.floor(Number.isFinite(toIndex) ? toIndex : 0), ids.length - 1));
  const raw = sheetOrderArray(doc).toArray();
  if (ids.indexOf(sheetId) === target && raw.filter((id) => id === sheetId).length === 1) return;
  doc.transact(() => {
    removeFromOrder(doc, sheetId);
    insertIntoOrder(doc, sheetId, target);
  }, origin);
}

/** A sheet tab's color (`#rrggbb`), or none with null. */
export function setSheetTab(doc: Y.Doc, sheetId: string, color: string | null, origin: LiveOrigin): void {
  requireSheet(doc, sheetId);
  if (color !== null && !isHexColor(color)) throw new SheetError("value", `"${color}" is not a color like #1a7f37`);
  doc.transact(() => {
    const sheet = sheetMap(doc, sheetId);
    if (color === null) sheet?.delete("tab");
    else sheet?.set("tab", color);
  }, origin);
}

/** Visits every reference and range of a formula's tree; `visit` returns true when it changed the node. */
function visitRefs(ast: Ast, visit: (node: Extract<Ast, { t: "ref" } | { t: "range" }>) => boolean): boolean {
  switch (ast.t) {
    case "ref":
    case "range":
      return visit(ast);
    case "un":
    case "paren":
      return visitRefs(ast.a, visit);
    case "bin": {
      const a = visitRefs(ast.a, visit);
      const b = visitRefs(ast.b, visit);
      return a || b;
    }
    case "call": {
      let changed = false;
      for (const arg of ast.args) if (visitRefs(arg, visit)) changed = true;
      return changed;
    }
    case "arr": {
      let changed = false;
      for (const row of ast.rows) for (const item of row) if (visitRefs(item, visit)) changed = true;
      return changed;
    }
    default:
      return false;
  }
}

/** A canonical formula with its references rewritten by `visit`, or null when nothing changed (or it can't be read). */
export function rewriteRefs(
  f: string,
  visit: (node: Extract<Ast, { t: "ref" } | { t: "range" }>) => boolean,
): string | null {
  let ast: Ast;
  try {
    ast = parseCanonical(f);
  } catch {
    return null;
  }
  if (!visitRefs(ast, visit)) return null;
  const next = printCanonical(ast);
  return next === f ? null : next;
}

/**
 * Copies a sheet next to it and returns the new id. The copy keeps the original's row and column ids (they are a
 * sheet's own), so its formulas point at its own cells as Excel's copy does; references naming the original sheet
 * from inside it point at the copy.
 */
export function duplicateSheet(doc: Y.Doc, sheetId: string, newName: string, origin: LiveOrigin): string {
  requireSheet(doc, sheetId);
  sheetLimit(doc);
  const cleaned = cleanSheetName(newName);
  const name = cleaned
    ? freeName(doc, cleaned)
    : uniqueSheetName(doc, `${sheetName(doc, sheetId).slice(0, 26) || "Sheet"} (2)`);
  checkCellRoom(doc, cellsMap(doc, sheetId)?.size ?? 0);
  const id = newId();
  doc.transact(() => {
    const from = sheetParts(doc, sheetId);
    sheetsMap(doc).set(id, newSheetMap(name, from.rows.toArray(), from.cols.toArray()));
    const copy = sheetParts(doc, id);
    for (const [key, raw] of from.cells.entries()) {
      const cell = readCell(raw);
      if (!cell) continue;
      if (cell.f?.includes(`${sheetId}!`)) {
        const f = rewriteRefs(cell.f, (node) => {
          let changed = false;
          for (const ref of node.t === "ref" ? [node.ref] : [node.from, node.to]) {
            if (ref.sheet === sheetId) {
              ref.sheet = id;
              changed = true;
            }
          }
          return changed;
        });
        if (f) cell.f = f;
      }
      copy.cells.set(key, cell);
    }
    for (const [key, size] of from.colWidths.entries()) copy.colWidths.set(key, size);
    for (const [key, size] of from.rowHeights.entries()) copy.rowHeights.set(key, size);
    for (const [key, merge] of from.merges.entries()) copy.merges.set(key, merge);
    copy.sheet.set("frozen", frozenOf(doc, sheetId));
    const tab = from.sheet.get("tab");
    if (isHexColor(tab)) copy.sheet.set("tab", tab);
    insertIntoOrder(doc, id, sheetIds(doc).indexOf(sheetId) + 1);
  }, origin);
  return id;
}

// ---------------------------------------------------------------------------------------------------------------------
// Cells

/**
 * Typed input into one cell (a person, or an agent's literal): "=…" is a formula in the person's language, numbers,
 * percentages, currency and dates are read in their locale (setting the format they imply), TRUE/FALSE or
 * VERDADEIRO/FALSO, and a leading ' keeps text. In a cell formatted as a percentage, "10" is 10% as in Excel. The
 * sheet grows to reach the cell and what its formula points at. A formula that can't be read is not written: the
 * problem comes back for the editor to show.
 */
export function setInput(
  doc: Y.Doc,
  at: CellAt,
  text: string,
  locale: SheetLocale,
  origin: LiveOrigin,
  opts: Pick<InputOptions, "now"> = {},
): { ok: true } | { ok: false; error: FormulaProblem } {
  requireSheet(doc, at.sheet);
  checkIndex(at.row, "row");
  checkIndex(at.col, "column");
  checkSize(at.row + 1, at.col + 1);
  const current = getCell(doc, at.sheet, at.row, at.col);
  const typing: InputOptions = { ...opts, percentEntry: true };
  const plan = planInput(doc, at.sheet, text, locale, current, typing);
  if (!plan.ok) return plan;
  if (!current && plan.cell) checkCellRoom(doc, 1);
  doc.transact(() => {
    const parts = sheetParts(doc, at.sheet);
    growTo(parts, Math.max(parts.rows.length, at.row + 1), Math.max(parts.cols.length, at.col + 1));
    let cell = plan.cell;
    const needs: SheetNeeds = new Map();
    addNeeds(needs, at.sheet, plan);
    if (growSheets(doc, needs)) {
      // The formula's references now land: read it again.
      const again = planInput(doc, at.sheet, text, locale, current, typing);
      if (again.ok) cell = again.cell;
    }
    writeCell(parts.cells, cellKey(parts.rows.get(at.row), parts.cols.get(at.col)), cell);
  }, origin);
  return { ok: true };
}

export type CellInput = string | number | boolean | null;

/**
 * Writes a block of values from `at` (the agents' `set`): a string is read as typed input in `locale` (agents pass
 * an English one, so "=SUM(B2:B9,C1)" is a formula, "1,234.5" a number), numbers and booleans are kept as they are,
 * null empties a cell (keeping its format), and a row shorter than the others leaves the rest alone. Nothing is
 * written when any formula can't be read: the error lists each cell and its problem.
 */
export function setValues(
  doc: Y.Doc,
  at: CellAt,
  values: readonly (readonly CellInput[])[],
  locale: SheetLocale,
  origin: LiveOrigin,
  opts: Pick<InputOptions, "now"> = {},
): void {
  requireSheet(doc, at.sheet);
  checkIndex(at.row, "row");
  checkIndex(at.col, "column");
  const height = values.length;
  const width = values.reduce((n, row) => Math.max(n, row.length), 0);
  if (height === 0 || width === 0) return;
  checkSize(at.row + height, at.col + width);
  if (height * width > SHEET_LIMITS.cells) {
    throw new SheetError("limit", `A spreadsheet holds at most ${SHEET_LIMITS.cells} cells`, [
      { max: SHEET_LIMITS.cells },
    ]);
  }
  const rows = rowIds(doc, at.sheet);
  const cols = colIds(doc, at.sheet);
  const cells = cellsMap(doc, at.sheet);
  const current = (i: number, j: number): CellData | undefined => {
    const r = rows[at.row + i];
    const c = cols[at.col + j];
    return r !== undefined && c !== undefined ? readCell(cells?.get(cellKey(r, c))) : undefined;
  };
  type Planned = { i: number; j: number; cell: CellData | undefined; text?: string };
  const planned: Planned[] = [];
  const problems: { cell: string; problem: FormulaProblem }[] = [];
  const needs: SheetNeeds = new Map();
  let added = 0;
  values.forEach((row, i) => {
    row.forEach((value, j) => {
      if (value === undefined) return;
      const before = current(i, j);
      let cell: CellData | undefined;
      if (value === null) cell = before?.s ? { s: before.s } : undefined;
      else if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          throw new SheetError("value", `${cellName(at.row + i, at.col + j)} can't hold ${value}`, [
            { cell: cellName(at.row + i, at.col + j) },
          ]);
        }
        cell = before?.s ? { v: value, s: before.s } : { v: value };
      } else if (typeof value === "boolean") cell = before?.s ? { v: value, s: before.s } : { v: value };
      else {
        const plan = planInput(doc, at.sheet, value, locale, before, opts);
        if (!plan.ok) {
          problems.push({ cell: cellName(at.row + i, at.col + j), problem: plan.error });
          return;
        }
        cell = plan.cell;
        if (plan.needs || plan.needsSheets) {
          addNeeds(needs, at.sheet, plan);
          planned.push({ i, j, cell, text: value });
          if (!before && cell) added++;
          return;
        }
      }
      if (!before && cell) added++;
      planned.push({ i, j, cell });
    });
  });
  if (problems.length > 0) {
    const list = problems
      .slice(0, 20)
      .map((p) => p.cell)
      .join(", ");
    throw new SheetError(
      "formula",
      `Formulas that can't be read: ${list}`,
      problems.slice(0, 50).map((p) => ({ cell: p.cell, problem: p.problem })),
    );
  }
  checkCellRoom(doc, added);
  doc.transact(() => {
    const parts = sheetParts(doc, at.sheet);
    growTo(parts, Math.max(parts.rows.length, at.row + height), Math.max(parts.cols.length, at.col + width));
    const grew = growSheets(doc, needs);
    for (const p of planned) {
      let cell = p.cell;
      if (p.text !== undefined && grew) {
        const again = planInput(doc, at.sheet, p.text, locale, current(p.i, p.j), opts);
        if (again.ok) cell = again.cell;
      }
      writeCell(parts.cells, cellKey(parts.rows.get(at.row + p.i), parts.cols.get(at.col + p.j)), cell);
    }
  }, origin);
}

/** Each cell key of a range that holds something, with its row and column indexes. */
function cellsIn(
  parts: SheetParts,
  range: RangeIds,
): { key: string; row: number; col: number; cell: CellData | undefined }[] {
  const rows = parts.rows.toArray();
  const cols = parts.cols.toArray();
  const out: { key: string; row: number; col: number; cell: CellData | undefined }[] = [];
  const area = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
  if (area <= parts.cells.size) {
    for (let r = range.r1; r <= range.r2; r++) {
      for (let c = range.c1; c <= range.c2; c++) {
        const key = cellKey(rows[r] as string, cols[c] as string);
        if (parts.cells.has(key)) out.push({ key, row: r, col: c, cell: readCell(parts.cells.get(key)) });
      }
    }
    return out;
  }
  const rowAt = indexOf(rows);
  const colAt = indexOf(cols);
  for (const [key, raw] of parts.cells.entries()) {
    const ids = parseCellKey(key);
    if (!ids) continue;
    const r = rowAt.get(ids[0]);
    const c = colAt.get(ids[1]);
    if (r === undefined || c === undefined) continue;
    if (r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2) {
      out.push({ key, row: r, col: c, cell: readCell(raw) });
    }
  }
  return out;
}

/** Removes the merges that share a cell with `range`. */
function unmergeIn(parts: SheetParts, range: RangeIds): void {
  const rowAt = indexOf(parts.rows.toArray());
  const colAt = indexOf(parts.cols.toArray());
  for (const [key, raw] of [...parts.merges.entries()]) {
    const m = readMerge(raw);
    if (!m) {
      parts.merges.delete(key);
      continue;
    }
    const a = rowAt.get(m.r1);
    const b = rowAt.get(m.r2);
    const c = colAt.get(m.c1);
    const d = colAt.get(m.c2);
    if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
    const box = { r1: Math.min(a, b), r2: Math.max(a, b), c1: Math.min(c, d), c2: Math.max(c, d) };
    if (overlaps(box, range)) parts.merges.delete(key);
  }
}

/**
 * Clears a range: `all` empties its cells and unmerges it, `contents` takes values and formulas but keeps formats,
 * `formats` takes formats (and merges) but keeps values.
 */
export function clearRange(
  doc: Y.Doc,
  range: RangeIds,
  what: "all" | "contents" | "formats",
  origin: LiveOrigin,
): void {
  requireSheet(doc, range.sheet);
  const r = clampRange(doc, range);
  if (!r) return;
  doc.transact(() => {
    const parts = sheetParts(doc, r.sheet);
    for (const { key, cell } of cellsIn(parts, r)) {
      if (what === "all" || !cell) writeCell(parts.cells, key, undefined);
      else if (what === "contents") writeCell(parts.cells, key, cell.s ? { s: cell.s } : undefined);
      else writeCell(parts.cells, key, { ...cell, s: undefined });
    }
    if (what !== "contents") unmergeIn(parts, r);
  }, origin);
}

type StyleKey = keyof CellStyle;
const STYLE_KEYS: readonly StyleKey[] = ["b", "i", "u", "x", "fc", "bg", "ha", "va", "w", "nf", "fs", "bd"];

function isRemoval(value: unknown): boolean {
  return value === undefined || value === null || value === 0 || value === false || value === "";
}

function checkBorder(side: unknown, where: string): void {
  if (isRemoval(side)) return;
  const s = side as { w?: unknown; c?: unknown };
  if (typeof side !== "object" || (s.w !== 1 && s.w !== 2 && s.w !== 3)) {
    throw new SheetError("value", `${where} needs a width of 1, 2 or 3`);
  }
  if (s.c !== undefined && !isHexColor(s.c)) throw new SheetError("value", `"${String(s.c)}" is not a color`);
}

/** Throws `value` for a style patch value the document can't hold (a color that isn't hex, an unknown alignment). */
function checkPatch(patch: Partial<CellStyle>): void {
  for (const key of STYLE_KEYS) {
    if (!(key in patch)) continue;
    const v = (patch as Record<string, unknown>)[key];
    if (isRemoval(v)) continue;
    switch (key) {
      case "fc":
      case "bg":
        if (!isHexColor(v)) throw new SheetError("value", `"${String(v)}" is not a color like #1a7f37`);
        break;
      case "ha":
        if (v !== "l" && v !== "c" && v !== "r") throw new SheetError("value", `"${String(v)}" is not an alignment`);
        break;
      case "va":
        if (v !== "t" && v !== "m" && v !== "b") throw new SheetError("value", `"${String(v)}" is not an alignment`);
        break;
      case "fs":
        if (typeof v !== "number" || !(v >= MIN_FONT_PT && v <= MAX_FONT_PT)) {
          throw new SheetError("value", `A font size goes from ${MIN_FONT_PT} to ${MAX_FONT_PT} points`);
        }
        break;
      case "nf":
        if (typeof v !== "string" || v.length > NUMBER_FORMAT_MAX) {
          throw new SheetError("value", "A number format is a format code of at most 255 characters");
        }
        break;
      case "bd":
        if (typeof v !== "object") throw new SheetError("value", "Borders are given per side: t, r, b, l");
        for (const side of ["t", "r", "b", "l"] as const) checkBorder((v as Record<string, unknown>)[side], side);
        break;
      default:
        if (v !== 1 && v !== true) throw new SheetError("value", `${key} is 1 (on) or removed`);
    }
  }
}

/** A style with a patch applied: keys given empty (undefined, null, 0, false, "") are removed, borders per side. */
export function applyStylePatch(style: CellStyle | undefined, patch: Partial<CellStyle>): CellStyle | undefined {
  const out: Record<string, unknown> = { ...style };
  for (const key of STYLE_KEYS) {
    if (!(key in patch)) continue;
    const v = (patch as Record<string, unknown>)[key];
    if (key === "bd" && !isRemoval(v)) {
      const sides: Record<string, unknown> = { ...(style?.bd ?? {}) };
      for (const side of ["t", "r", "b", "l"] as const) {
        if (!(side in (v as object))) continue;
        const value = (v as Record<string, unknown>)[side];
        if (isRemoval(value)) delete sides[side];
        else sides[side] = value;
      }
      out.bd = sides;
    } else if (isRemoval(v)) delete out[key];
    else out[key] = v === true ? 1 : v;
  }
  return cleanCellStyle(out);
}

/**
 * Formats every cell of a range with `patch` (`{ b: 1 }` bolds, `{ b: undefined }` unbolds, `{ nf: "0.00%" }`),
 * or resets their style with `{ clear: true }`. Empty cells get the style, so what is typed there later keeps it.
 */
export function formatRange(
  doc: Y.Doc,
  range: RangeIds,
  patch: Partial<CellStyle> | { clear: true },
  origin: LiveOrigin,
): void {
  requireSheet(doc, range.sheet);
  const r = clampRange(doc, range);
  if (!r) return;
  if ("clear" in patch && patch.clear === true) {
    doc.transact(() => {
      const parts = sheetParts(doc, r.sheet);
      for (const { key, cell } of cellsIn(parts, r))
        writeCell(parts.cells, key, cell ? { ...cell, s: undefined } : cell);
    }, origin);
    return;
  }
  const stylePatch = patch as Partial<CellStyle>;
  checkPatch(stylePatch);
  restyle(doc, r, origin, (style) => applyStylePatch(style, stylePatch));
}

/** Applies `next` to the style of every cell in a (clamped) range, creating style-only cells within the limits. */
function restyle(
  doc: Y.Doc,
  r: RangeIds,
  origin: LiveOrigin,
  next: (style: CellStyle | undefined, row: number, col: number) => CellStyle | undefined,
): void {
  const rows = rowIds(doc, r.sheet);
  const cols = colIds(doc, r.sheet);
  const cells = cellsMap(doc, r.sheet);
  let added = 0;
  const writes: { key: string; cell: CellData | undefined }[] = [];
  for (let row = r.r1; row <= r.r2; row++) {
    for (let col = r.c1; col <= r.c2; col++) {
      const key = cellKey(rows[row] as string, cols[col] as string);
      const cell = readCell(cells?.get(key));
      const style = next(cell?.s, row, col);
      if (!cell && !style) continue;
      const updated: CellData = { ...cell, s: style };
      if (!cell) added++;
      writes.push({ key, cell: updated });
    }
  }
  checkCellRoom(doc, added);
  doc.transact(() => {
    const parts = sheetParts(doc, r.sheet);
    for (const w of writes) writeCell(parts.cells, w.key, w.cell);
  }, origin);
}

export type BorderPreset =
  | "all"
  | "outer"
  | "inner"
  | "horizontal"
  | "vertical"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "none";

/**
 * Draws or removes borders on a range: `all` every edge, `outer` the range's outline, `inner` the edges between its
 * cells, `horizontal`/`vertical` only the inner ones that way, `top`…`right` one side of the outline, `none` every
 * border of the range (and the neighbors' sides that face it). `side` null removes the preset's edges instead.
 */
export function borderRange(
  doc: Y.Doc,
  range: RangeIds,
  preset: BorderPreset,
  side: BorderSide | null,
  origin: LiveOrigin,
): void {
  requireSheet(doc, range.sheet);
  const r = clampRange(doc, range);
  if (!r) return;
  if (side !== null) checkBorder(side, "A border");
  const line = side === null ? null : side.c ? { w: side.w, c: side.c } : { w: side.w };
  const size = sheetSize(doc, r.sheet);
  const edges = (row: number, col: number): ("t" | "r" | "b" | "l")[] => {
    const out: ("t" | "r" | "b" | "l")[] = [];
    const top = row === r.r1;
    const bottom = row === r.r2;
    const left = col === r.c1;
    const right = col === r.c2;
    switch (preset) {
      case "all":
      case "none":
        return ["t", "r", "b", "l"];
      case "outer":
        if (top) out.push("t");
        if (bottom) out.push("b");
        if (left) out.push("l");
        if (right) out.push("r");
        return out;
      case "inner":
      case "horizontal":
      case "vertical":
        if (preset !== "vertical") {
          if (!top) out.push("t");
          if (!bottom) out.push("b");
        }
        if (preset !== "horizontal") {
          if (!left) out.push("l");
          if (!right) out.push("r");
        }
        return out;
      case "top":
        return top ? ["t"] : [];
      case "bottom":
        return bottom ? ["b"] : [];
      case "left":
        return left ? ["l"] : [];
      case "right":
        return right ? ["r"] : [];
    }
  };
  // "none" also clears the neighbors' facing sides, so the range's outline is really gone.
  const outer =
    preset === "none"
      ? {
          sheet: r.sheet,
          r1: Math.max(0, r.r1 - 1),
          c1: Math.max(0, r.c1 - 1),
          r2: Math.min(size.rows - 1, r.r2 + 1),
          c2: Math.min(size.cols - 1, r.c2 + 1),
        }
      : r;
  restyle(doc, outer, origin, (style, row, col) => {
    const inside = row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2;
    let sides: ("t" | "r" | "b" | "l")[] = [];
    if (inside) sides = edges(row, col);
    else if (row === r.r1 - 1 && col >= r.c1 && col <= r.c2) sides = ["b"];
    else if (row === r.r2 + 1 && col >= r.c1 && col <= r.c2) sides = ["t"];
    else if (col === r.c1 - 1 && row >= r.r1 && row <= r.r2) sides = ["r"];
    else if (col === r.c2 + 1 && row >= r.r1 && row <= r.r2) sides = ["l"];
    if (sides.length === 0) return style;
    const bd: Record<string, BorderSide | null> = {};
    for (const s of sides) bd[s] = preset === "none" ? null : line;
    if (!style && Object.values(bd).every((v) => v === null)) return style;
    return applyStylePatch(style, { bd: bd as CellStyle["bd"] });
  });
}

/**
 * Merges a range into one cell: merges it overlaps are taken in, and only the top-left cell keeps its value (the
 * others keep their formats, for borders). A single cell unmerges whatever merge it is in.
 */
export function mergeRange(doc: Y.Doc, range: RangeIds, origin: LiveOrigin): void {
  requireSheet(doc, range.sheet);
  const r = clampRange(doc, range);
  if (!r) return;
  doc.transact(() => {
    const parts = sheetParts(doc, r.sheet);
    unmergeIn(parts, r);
    if (r.r1 === r.r2 && r.c1 === r.c2) return;
    for (const { key, row, col, cell } of cellsIn(parts, r)) {
      if (row === r.r1 && col === r.c1) continue;
      if (cell && (cell.v !== undefined || cell.f !== undefined)) {
        writeCell(parts.cells, key, cell.s ? { s: cell.s } : undefined);
      }
    }
    const merge: Merge = {
      r1: parts.rows.get(r.r1),
      c1: parts.cols.get(r.c1),
      r2: parts.rows.get(r.r2),
      c2: parts.cols.get(r.c2),
    };
    parts.merges.set(cellKey(merge.r1, merge.c1), merge);
  }, origin);
}

/** Unmerges every merge that shares a cell with the range. */
export function unmergeRange(doc: Y.Doc, range: RangeIds, origin: LiveOrigin): void {
  requireSheet(doc, range.sheet);
  const r = clampRange(doc, range);
  if (!r) return;
  doc.transact(() => unmergeIn(sheetParts(doc, r.sheet), r), origin);
}

/** Freezes the first `rows` rows and `cols` columns (0 unfreezes), within the sheet's size. */
export function setFrozen(doc: Y.Doc, sheet: string, rows: number, cols: number, origin: LiveOrigin): void {
  requireSheet(doc, sheet);
  checkIndex(rows, "rows");
  checkIndex(cols, "columns");
  const size = sheetSize(doc, sheet);
  const next = { rows: Math.min(rows, size.rows), cols: Math.min(cols, size.cols) };
  const current = frozenOf(doc, sheet);
  if (current.rows === next.rows && current.cols === next.cols) return;
  doc.transact(() => sheetMap(doc, sheet)?.set("frozen", next), origin);
}

/** Grows a sheet to at least `rows` × `cols` (fresh ids at the end); throws `limit` past `LIVE_LIMITS`. */
export function ensureSize(doc: Y.Doc, sheet: string, rows: number, cols: number, origin: LiveOrigin): void {
  requireSheet(doc, sheet);
  checkSize(rows, cols);
  const size = sheetSize(doc, sheet);
  if (size.rows >= rows && size.cols >= cols) return;
  doc.transact(() => growTo(sheetParts(doc, sheet), rows, cols), origin);
}

// ---------------------------------------------------------------------------------------------------------------------
// Rows and columns

type Along = "rows" | "cols";

function insertAlong(doc: Y.Doc, sheet: string, along: Along, at: number, count: number, origin: LiveOrigin): void {
  requireSheet(doc, sheet);
  checkIndex(at, "at");
  if (!Number.isInteger(count) || count < 1) throw new SheetError("range", "Insert at least one");
  const size = sheetSize(doc, sheet);
  const length = along === "rows" ? size.rows : size.cols;
  if (at > length) throw new SheetError("range", `There are only ${length} ${along === "rows" ? "rows" : "columns"}`);
  if (along === "rows") checkSize(size.rows + count, size.cols);
  else checkSize(size.rows, size.cols + count);
  const frozen = frozenOf(doc, sheet);
  doc.transact(() => {
    const parts = sheetParts(doc, sheet);
    (along === "rows" ? parts.rows : parts.cols).insert(
      at,
      Array.from({ length: count }, () => newId()),
    );
    // Rows inserted among frozen ones stay frozen with them, as in Excel.
    const f = along === "rows" ? frozen.rows : frozen.cols;
    if (at < f) parts.sheet.set("frozen", { ...frozen, [along]: f + count });
  }, origin);
}

/** Inserts `count` empty rows before row `at` (`at` = the row count adds them at the end). */
export function insertRows(doc: Y.Doc, sheet: string, at: number, count: number, origin: LiveOrigin): void {
  insertAlong(doc, sheet, "rows", at, count, origin);
}

/** Inserts `count` empty columns before column `at`. */
export function insertCols(doc: Y.Doc, sheet: string, at: number, count: number, origin: LiveOrigin): void {
  insertAlong(doc, sheet, "cols", at, count, origin);
}

const REF_TOKEN = /\{(?:[A-Za-z0-9_-]+!)?\$?([A-Za-z0-9_-]*),\$?([A-Za-z0-9_-]*)\}/g;

/** Whether a canonical formula names any of `ids` as a row or column (a cheap test before parsing it). */
function namesAny(f: string, ids: ReadonlySet<string>): boolean {
  if (!f.includes("{")) return false;
  REF_TOKEN.lastIndex = 0;
  for (let m = REF_TOKEN.exec(f); m; m = REF_TOKEN.exec(f)) {
    if ((m[1] && ids.has(m[1])) || (m[2] && ids.has(m[2]))) return true;
  }
  return false;
}

/**
 * Before rows or columns of `sheet` are deleted: every formula of the document whose range starts or ends on one of
 * them has that edge pulled in to the nearest one that stays inside the range (the formula engine's
 * `adjustForDeletion`).
 */
function pullRangeEdges(doc: Y.Doc, sheet: string, along: Along, removed: Set<string>): void {
  const gone = along === "rows" ? { sheet, rows: removed } : { sheet, cols: removed };
  for (const formulaSheet of sheetIds(doc)) {
    const cells = cellsMap(doc, formulaSheet);
    if (!cells) continue;
    for (const [key, raw] of [...cells.entries()]) {
      const cell = readCell(raw);
      if (!cell?.f || !namesAny(cell.f, removed)) continue;
      const f = adjustForDeletion(cell.f, { doc, sheetId: formulaSheet }, gone);
      if (f !== cell.f) cells.set(key, { ...cell, f });
    }
  }
}

function deleteAlong(doc: Y.Doc, sheet: string, along: Along, at: number, count: number, origin: LiveOrigin): void {
  requireSheet(doc, sheet);
  checkIndex(at, "at");
  if (!Number.isInteger(count) || count < 1) throw new SheetError("range", "Delete at least one");
  const ids = along === "rows" ? rowIds(doc, sheet) : colIds(doc, sheet);
  if (at >= ids.length) return;
  const end = Math.min(ids.length, at + count);
  if (end - at >= ids.length) {
    throw along === "rows"
      ? new SheetError("last_row", "A sheet keeps at least one row")
      : new SheetError("last_col", "A sheet keeps at least one column");
  }
  const removed = new Set(ids.slice(at, end));
  const frozen = frozenOf(doc, sheet);
  doc.transact(() => {
    const parts = sheetParts(doc, sheet);
    // Their cells.
    const others = (along === "rows" ? parts.cols : parts.rows).toArray();
    if (removed.size * others.length <= parts.cells.size) {
      for (const id of removed) {
        for (const other of others) {
          const key = along === "rows" ? cellKey(id, other) : cellKey(other, id);
          if (parts.cells.has(key)) parts.cells.delete(key);
        }
      }
    } else {
      for (const key of [...parts.cells.keys()]) {
        const pair = parseCellKey(key);
        if (pair && removed.has(along === "rows" ? pair[0] : pair[1])) parts.cells.delete(key);
      }
    }
    // Their heights or widths.
    const sizes = along === "rows" ? parts.rowHeights : parts.colWidths;
    for (const id of removed) if (sizes.has(id)) sizes.delete(id);
    // Merges whose edge goes shrink to what is left of them, and are dropped when nothing (or one cell) is.
    const pos = indexOf(ids);
    for (const [key, raw] of [...parts.merges.entries()]) {
      const m = readMerge(raw);
      if (!m) {
        parts.merges.delete(key);
        continue;
      }
      const a = along === "rows" ? m.r1 : m.c1;
      const b = along === "rows" ? m.r2 : m.c2;
      if (!removed.has(a) && !removed.has(b)) continue;
      const ia = pos.get(a);
      const ib = pos.get(b);
      if (ia === undefined || ib === undefined) continue;
      let first = -1;
      let last = -1;
      for (let i = Math.min(ia, ib); i <= Math.max(ia, ib); i++) {
        if (!removed.has(ids[i] as string)) {
          if (first < 0) first = i;
          last = i;
        }
      }
      parts.merges.delete(key);
      if (first < 0) continue;
      const next: Merge =
        along === "rows"
          ? { ...m, r1: ids[first] as string, r2: ids[last] as string }
          : { ...m, c1: ids[first] as string, c2: ids[last] as string };
      if (next.r1 === next.r2 && next.c1 === next.c2) continue;
      parts.merges.set(cellKey(next.r1, next.c1), next);
    }
    // Frozen panes lose the frozen rows or columns that went.
    const f = along === "rows" ? frozen.rows : frozen.cols;
    if (at < f) parts.sheet.set("frozen", { ...frozen, [along]: f - (Math.min(end, f) - at) });
    pullRangeEdges(doc, sheet, along, removed);
    (along === "rows" ? parts.rows : parts.cols).delete(at, end - at);
  }, origin);
}

/** Deletes `count` rows from row `at`, with their cells; a sheet keeps at least one row. */
export function deleteRows(doc: Y.Doc, sheet: string, at: number, count: number, origin: LiveOrigin): void {
  deleteAlong(doc, sheet, "rows", at, count, origin);
}

/** Deletes `count` columns from column `at`, with their cells; a sheet keeps at least one column. */
export function deleteCols(doc: Y.Doc, sheet: string, at: number, count: number, origin: LiveOrigin): void {
  deleteAlong(doc, sheet, "cols", at, count, origin);
}

function setSizes(
  doc: Y.Doc,
  sheet: string,
  along: Along,
  at: number | readonly number[],
  px: number,
  origin: LiveOrigin,
): void {
  requireSheet(doc, sheet);
  if (!Number.isFinite(px)) throw new SheetError("value", "A size is a number of pixels");
  const max = along === "rows" ? MAX_ROW_HEIGHT : MAX_COL_WIDTH;
  const fallback = along === "rows" ? DEFAULT_ROW_HEIGHT : DEFAULT_COL_WIDTH;
  const size = Math.round(Math.max(MIN_SIZE, Math.min(max, px)));
  const list = typeof at === "number" ? [at] : [...at];
  const ids = along === "rows" ? rowIds(doc, sheet) : colIds(doc, sheet);
  for (const i of list) checkIndex(i, along === "rows" ? "row" : "column");
  doc.transact(() => {
    const parts = sheetParts(doc, sheet);
    const map = along === "rows" ? parts.rowHeights : parts.colWidths;
    for (const i of list) {
      const id = ids[i];
      if (id === undefined) continue;
      if (size === fallback) {
        if (map.has(id)) map.delete(id);
      } else if (map.get(id) !== size) map.set(id, size);
    }
  }, origin);
}

/** Sets one column's width (or several columns') in px, within 4–2000; the default width removes the setting. */
export function setColWidth(
  doc: Y.Doc,
  sheet: string,
  col: number | readonly number[],
  px: number,
  origin: LiveOrigin,
): void {
  setSizes(doc, sheet, "cols", col, px, origin);
}

/** Sets one row's height (or several rows') in px, within 4–1000; the default height removes the setting. */
export function setRowHeight(
  doc: Y.Doc,
  sheet: string,
  row: number | readonly number[],
  px: number,
  origin: LiveOrigin,
): void {
  setSizes(doc, sheet, "rows", row, px, origin);
}

// ---------------------------------------------------------------------------------------------------------------------
// Sorting

const FOLD: Record<string, string> = {};
for (const [plain, marked] of [
  ["a", "áàâãäåā"],
  ["c", "çćč"],
  ["e", "éèêëēė"],
  ["i", "íìîïī"],
  ["n", "ñń"],
  ["o", "óòôõöøō"],
  ["u", "úùûüū"],
  ["y", "ýÿ"],
  ["s", "šś"],
  ["z", "žźż"],
] as const) {
  for (const ch of marked) FOLD[ch] = plain;
}

/** Text as sorting compares it: case and accents left out, the same on every device. */
function sortText(text: string): string {
  const lower = text.toLowerCase();
  let out = "";
  for (const ch of lower) out += FOLD[ch] ?? ch;
  return out;
}

function sortClass(v: CellValue): number {
  if (v === null || v === "") return 4;
  if (typeof v === "number") return 0;
  if (typeof v === "string") return 1;
  if (typeof v === "boolean") return 2;
  return 3;
}

/**
 * Excel's sort order: numbers (dates too), then text (ignoring case and accents), then FALSE before TRUE, then
 * errors; descending reverses it. Empty cells always go last.
 */
export function compareCells(a: CellValue, b: CellValue, desc = false): number {
  const ca = sortClass(a);
  const cb = sortClass(b);
  if (ca === 4 || cb === 4) return ca === cb ? 0 : ca === 4 ? 1 : -1;
  let c = 0;
  if (ca !== cb) c = ca - cb;
  else if (typeof a === "number" && typeof b === "number") c = a < b ? -1 : a > b ? 1 : 0;
  else if (typeof a === "string" && typeof b === "string") {
    const x = sortText(a);
    const y = sortText(b);
    c = x < y ? -1 : x > y ? 1 : 0;
  } else if (typeof a === "boolean" && typeof b === "boolean") c = Number(a) - Number(b);
  return desc ? -c : c;
}

/**
 * Sorts a range's rows by the computed value of column `byCol` (an index of the sheet, inside the range), moving
 * whole records: every cell of a row in the range moves with its row, formats included, and formulas move as copies
 * do (`=B2*C2` from row 2 reads `=B5*C5` in row 5). Equal values keep their order. With `header`, the first row
 * stays. A range with merged cells can't be sorted, as in Excel.
 */
export function sortRange(
  doc: Y.Doc,
  range: RangeIds,
  byCol: number,
  desc: boolean,
  engine: SheetValues,
  origin: LiveOrigin,
  opts: { header?: boolean } = {},
): void {
  requireSheet(doc, range.sheet);
  const r = clampRange(doc, range);
  if (!r) return;
  checkIndex(byCol, "column");
  if (byCol < r.c1 || byCol > r.c2) throw new SheetError("range", "The column to sort by must be in the range");
  if (readMerges(doc, r.sheet).some((m) => overlaps(m, r))) {
    throw new SheetError("merged", "A range with merged cells can't be sorted");
  }
  const top = r.r1 + (opts.header ? 1 : 0);
  if (r.r2 - top < 1) return;
  const rows = rowIds(doc, r.sheet);
  const cols = colIds(doc, r.sheet);
  const keyCol = cols[byCol] as string;
  const items: { i: number; key: CellValue }[] = [];
  for (let i = top; i <= r.r2; i++) items.push({ i, key: engine.value(r.sheet, rows[i] as string, keyCol) });
  items.sort((a, b) => compareCells(a.key, b.key, desc) || a.i - b.i);
  if (items.every((item, k) => item.i === top + k)) return;
  doc.transact(() => {
    const parts = sheetParts(doc, r.sheet);
    const before = new Map<string, CellData | undefined>();
    for (let i = top; i <= r.r2; i++) {
      for (let c = r.c1; c <= r.c2; c++) {
        const key = cellKey(rows[i] as string, cols[c] as string);
        before.set(key, readCell(parts.cells.get(key)));
      }
    }
    items.forEach((item, k) => {
      const target = top + k;
      if (item.i === target) return;
      for (let c = r.c1; c <= r.c2; c++) {
        const source = before.get(cellKey(rows[item.i] as string, cols[c] as string));
        const moved = source?.f
          ? { ...source, f: shiftFormula(source.f, target - item.i, 0, { doc, sheetId: r.sheet }) }
          : source;
        writeCell(parts.cells, cellKey(rows[target] as string, cols[c] as string), moved);
      }
    });
  }, origin);
}
