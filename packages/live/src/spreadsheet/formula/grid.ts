/**
 * What formulas read of a spreadsheet document (ADR 0196 §2): its sheets by id and name, and each sheet's rows and
 * columns in order. A row's or column's position comes from an index kept per array, so turning thousands of formulas
 * into A1 (or back) costs one pass per sheet.
 *
 * The index is read the way the document's own readers read the arrays (`doc.ts`): ids that aren't strings are
 * skipped and an id repeated by two people moving the same row at once counts once, at its first place, so a formula
 * and the grid on screen always agree on where a row is. An index built before a transaction is dropped when the
 * transaction changes its array (on `beforeObserverCalls`, before any observer can read it); one built while a
 * transaction is open serves only that transaction, until its next insert or delete.
 */
import * as Y from "yjs";

export interface Axis {
  /** Ids in order. */
  ids: readonly string[];
  /** Id → position. */
  pos: ReadonlyMap<string, number>;
}

interface CachedAxis extends Axis {
  /** The array's raw length when this was built. */
  length: number;
  /** The open transaction it was built in, or null when built between transactions. */
  tx: Y.Transaction | null;
  version: number;
}

const EMPTY_AXIS: Axis = { ids: [], pos: new Map() };
const axes = new WeakMap<object, CachedAxis>();
const watched = new WeakSet<Y.Doc>();

/**
 * A count that grows with every insert (new structs of this client) and delete (the transaction's delete set) while a
 * transaction is open: Yjs only merges both when the transaction ends.
 */
export function txVersion(doc: Y.Doc, tr: Y.Transaction): number {
  let n = doc.store.clients.get(doc.clientID)?.length ?? 0;
  for (const items of tr.deleteSet.clients.values()) n += items.length;
  return n;
}

/** The transaction open on a document, if any. */
export function openTransaction(doc: Y.Doc | null | undefined): Y.Transaction | null {
  return doc ? doc._transaction : null;
}

/** Drops the indexes of the arrays a finished transaction changed (also done on its own, before observers run). */
export function forgetChanged(tr: Y.Transaction): void {
  for (const type of tr.changed.keys()) axes.delete(type);
}

function watch(doc: Y.Doc): void {
  if (watched.has(doc)) return;
  watched.add(doc);
  doc.on("beforeObserverCalls", forgetChanged);
}

function build(array: Y.Array<unknown>): { ids: string[]; pos: Map<string, number> } {
  const ids: string[] = [];
  const pos = new Map<string, number>();
  for (const id of array.toArray()) {
    if (typeof id !== "string" || pos.has(id)) continue;
    pos.set(id, ids.length);
    ids.push(id);
  }
  return { ids, pos };
}

/** The index of a rows or columns array. */
export function axisOf(array: Y.Array<unknown> | undefined): Axis {
  if (!array) return EMPTY_AXIS;
  const doc = array.doc;
  const tr = openTransaction(doc);
  const hit = axes.get(array);
  if (hit && hit.length === array.length) {
    if (hit.tx === null) {
      if (!tr?.changed.has(array)) return hit;
    } else if (tr === hit.tx && doc && hit.version === txVersion(doc, tr)) {
      return hit;
    }
  }
  const { ids, pos } = build(array);
  // Built inside a transaction that hasn't touched the array (and didn't make it), the index outlives the
  // transaction like any other: a later change in it shows in `changed`, and its end drops the index.
  const item = array._item;
  const made = tr && item ? item.id.clock >= (tr.beforeState.get(item.id.client) ?? 0) : false;
  const own = doc && tr && (tr.changed.has(array) || made) ? tr : null;
  const axis: CachedAxis = {
    ids,
    pos,
    length: array.length,
    tx: own,
    version: doc && own ? txVersion(doc, own) : 0,
  };
  if (doc) {
    watch(doc);
    axes.set(array, axis);
  }
  return axis;
}

export function sheetsOf(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>("sheets");
}

function isMap(value: unknown): value is Y.Map<unknown> {
  return value instanceof Y.Map;
}

function isArray(value: unknown): value is Y.Array<unknown> {
  return value instanceof Y.Array;
}

export function sheetOf(doc: Y.Doc, sheetId: string): Y.Map<unknown> | undefined {
  const sheet = sheetsOf(doc).get(sheetId);
  return isMap(sheet) ? sheet : undefined;
}

export function rowsArray(sheet: Y.Map<unknown> | undefined): Y.Array<unknown> | undefined {
  const rows = sheet?.get("rows");
  return isArray(rows) ? rows : undefined;
}

export function colsArray(sheet: Y.Map<unknown> | undefined): Y.Array<unknown> | undefined {
  const cols = sheet?.get("cols");
  return isArray(cols) ? cols : undefined;
}

export function cellsMap(sheet: Y.Map<unknown> | undefined): Y.Map<unknown> | undefined {
  const cells = sheet?.get("cells");
  return isMap(cells) ? cells : undefined;
}

export function rowAxis(doc: Y.Doc, sheetId: string): Axis | null {
  const sheet = sheetOf(doc, sheetId);
  return sheet ? axisOf(rowsArray(sheet)) : null;
}

export function colAxis(doc: Y.Doc, sheetId: string): Axis | null {
  const sheet = sheetOf(doc, sheetId);
  return sheet ? axisOf(colsArray(sheet)) : null;
}

/** A sheet's name, or null when there is no such sheet. */
export function sheetName(doc: Y.Doc, sheetId: string): string | null {
  const sheet = sheetOf(doc, sheetId);
  if (!sheet) return null;
  const name = sheet.get("name");
  return typeof name === "string" ? name : "";
}

/**
 * The sheets in order, read as `doc.ts` reads them: repeated ids once, ids without a sheet skipped, sheets missing from
 * the order at the end (sorted by id).
 */
export function orderedSheetIds(doc: Y.Doc): string[] {
  const sheets = sheetsOf(doc);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of doc.getArray<unknown>("sheetOrder").toArray()) {
    if (typeof id !== "string" || seen.has(id) || !isMap(sheets.get(id))) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length < sheets.size) {
    const missing = [...sheets.keys()].filter((id) => !seen.has(id) && isMap(sheets.get(id))).sort();
    out.push(...missing);
  }
  return out;
}

/** A sheet's id by its name, ignoring case as Excel does; the first in the sheet order wins. */
export function sheetIdByName(doc: Y.Doc, name: string): string | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  for (const id of orderedSheetIds(doc)) {
    if ((sheetName(doc, id) ?? "").toLowerCase() === wanted) return id;
  }
  return null;
}
