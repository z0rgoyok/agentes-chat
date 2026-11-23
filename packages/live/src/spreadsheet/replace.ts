/**
 * Writing one spreadsheet's content over another's (ADR 0196 §7: restoring a version), in one transaction. Only what
 * differs is written, by the same ids, so the change is as small as the difference, the people in the file keep their
 * selections on rows and sheets that are still there, and an edit someone makes at the same moment still lands.
 */
import * as Y from "yjs";
import { readCell, readMerge, sameData, sheetIds, sheetMap, sheetOrderArray, sheetsMap } from "./doc";

function plainCopy(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Makes a Y.Array of ids read like `next`, changing only the middle run between what both share at each end. */
function patchIds(array: Y.Array<string>, next: readonly string[]): void {
  const current: unknown[] = array.toArray();
  let start = 0;
  while (start < current.length && start < next.length && current[start] === next[start]) start++;
  let endCurrent = current.length;
  let endNext = next.length;
  while (endCurrent > start && endNext > start && current[endCurrent - 1] === next[endNext - 1]) {
    endCurrent--;
    endNext--;
  }
  if (endCurrent > start) array.delete(start, endCurrent - start);
  if (endNext > start) array.insert(start, next.slice(start, endNext));
}

/** Makes a Y.Map of plain values hold exactly `next`'s entries. */
function patchMap(map: Y.Map<unknown>, next: Y.Map<unknown> | null, read: (raw: unknown) => unknown): void {
  const wanted = new Map<string, unknown>();
  if (next) {
    for (const [key, raw] of next.entries()) {
      const value = read(raw);
      if (value !== undefined) wanted.set(key, value);
    }
  }
  for (const key of [...map.keys()]) if (!wanted.has(key)) map.delete(key);
  for (const [key, value] of wanted) if (!sameData(map.get(key), value)) map.set(key, value);
}

function idsOf(value: unknown): string[] {
  if (!(value instanceof Y.Array)) return [];
  const seen = new Set<string>();
  return value
    .toArray()
    .filter((id): id is string => typeof id === "string" && id.length > 0 && !seen.has(id) && !!seen.add(id));
}

const readSize = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined);
const readMergeValue = (raw: unknown) => readMerge(raw) ?? undefined;

function partOf<T>(sheet: Y.Map<unknown>, key: string, make: () => T, ok: (v: unknown) => boolean): T {
  const value = sheet.get(key);
  if (ok(value)) return value as T;
  const made = make();
  sheet.set(key, made);
  return made;
}

/** Makes `target` (a sheet's map in the document) hold what `source` (from another document) holds. */
function patchSheet(target: Y.Map<unknown>, source: Y.Map<unknown>): void {
  for (const key of ["name", "tab"] as const) {
    const value = source.get(key);
    if (typeof value === "string") {
      if (target.get(key) !== value) target.set(key, value);
    } else if (target.has(key)) target.delete(key);
  }
  const frozen = plainCopy(source.get("frozen")) ?? { rows: 0, cols: 0 };
  if (!sameData(target.get("frozen"), frozen)) target.set("frozen", frozen);
  const isArray = (v: unknown) => v instanceof Y.Array;
  const isMap = (v: unknown) => v instanceof Y.Map;
  patchIds(
    partOf(target, "rows", () => new Y.Array<string>(), isArray),
    idsOf(source.get("rows")),
  );
  patchIds(
    partOf(target, "cols", () => new Y.Array<string>(), isArray),
    idsOf(source.get("cols")),
  );
  const mapOf = (key: string) => {
    const value = source.get(key);
    return value instanceof Y.Map ? (value as Y.Map<unknown>) : null;
  };
  patchMap(
    partOf(target, "cells", () => new Y.Map(), isMap),
    mapOf("cells"),
    (raw) => readCell(raw),
  );
  patchMap(
    partOf(target, "colWidths", () => new Y.Map(), isMap),
    mapOf("colWidths"),
    readSize,
  );
  patchMap(
    partOf(target, "rowHeights", () => new Y.Map(), isMap),
    mapOf("rowHeights"),
    readSize,
  );
  patchMap(
    partOf(target, "merges", () => new Y.Map(), isMap),
    mapOf("merges"),
    readMergeValue,
  );
}

/**
 * Writes `from`'s spreadsheet (its sheets in order, with everything they hold) over `doc`'s, in one transaction with
 * `origin` (the apps' and the server's origins, `SYSTEM` for a restore). Sheets, rows, columns and cells keep their
 * ids, so only what differs changes.
 */
export function replaceSpreadsheet(doc: Y.Doc, from: Y.Doc, origin: unknown): void {
  const wanted = sheetIds(from);
  doc.transact(() => {
    const sheets = sheetsMap(doc);
    for (const id of [...sheets.keys()]) if (!wanted.includes(id)) sheets.delete(id);
    for (const id of wanted) {
      const source = sheetMap(from, id);
      if (!source) continue;
      const target = sheets.get(id);
      if (target instanceof Y.Map) patchSheet(target, source);
      else {
        // A sheet the document doesn't have: an empty one first (Yjs reads a map only once it is in a document).
        sheets.set(id, new Y.Map<unknown>());
        patchSheet(sheets.get(id) as Y.Map<unknown>, source);
      }
    }
    patchIds(sheetOrderArray(doc), wanted);
  }, origin);
}
