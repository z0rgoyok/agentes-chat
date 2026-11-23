import * as Y from "yjs";

/**
 * Writing one document's content over another's (ADR 0196 §7: restoring a version writes the old content into the
 * live document as one change, so everyone in it sees the file go back). A Yjs type can't move between documents, so
 * these copy, and they change as little as they can: an equal value is left alone, a nested type is updated in place
 * when both sides hold the same kind of type, and a list only changes between its common head and tail. Whatever
 * someone else edits at the same moment then merges with the restore instead of being thrown away with the old
 * items, and their selection (by id) stays where it was.
 *
 * Call these inside one `doc.transact(fn, origin)`.
 */

/** Structural equality of plain JSON values (objects by keys, in any order). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    return typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b);
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array && b instanceof Uint8Array) || a.length !== b.length) return false;
    return a.every((byte, i) => byte === b[i]);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const list = b as unknown[];
    return a.length === list.length && a.every((item, i) => sameJson(item, list[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  if (keys.length !== Object.keys(right).filter((key) => right[key] !== undefined).length) return false;
  return keys.every((key) => sameJson(left[key], right[key]));
}

/**
 * A value as comparable plain data, nested types included: what two values must share to be the same content. Unlike
 * `toJSON()`, rich text keeps its formatting and element attributes keep their types.
 */
export function dumpValue(value: unknown): unknown {
  if (value instanceof Y.XmlText) return { $text: value.toDelta() };
  if (value instanceof Y.Text) return { $text: value.toDelta() };
  if (value instanceof Y.XmlElement) {
    return { $element: value.nodeName, attrs: value.getAttributes(), children: value.toArray().map(dumpValue) };
  }
  if (value instanceof Y.XmlFragment) return { $fragment: value.toArray().map(dumpValue) };
  if (value instanceof Y.Map) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of value.entries()) out[key] = dumpValue(item);
    return { $map: out };
  }
  if (value instanceof Y.Array) return { $array: value.toArray().map(dumpValue) };
  return value;
}

/** Whether two values (plain or nested types, from any documents) hold the same content. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (!(a instanceof Y.AbstractType) && !(b instanceof Y.AbstractType)) return sameJson(a, b);
  return sameJson(dumpValue(a), dumpValue(b));
}

/** A copy that can join another document: nested types are cloned whole, plain values are kept as they are. */
export function cloneValue<T>(value: T): T {
  return value instanceof Y.AbstractType ? (value.clone() as T) : value;
}

/** Which kind of nested type a value is, to decide whether one can be updated from the other in place. */
function typeKind(value: unknown): string | null {
  if (value instanceof Y.XmlText) return "xmltext";
  if (value instanceof Y.Text) return "text";
  if (value instanceof Y.XmlElement) return `element:${value.nodeName}`;
  if (value instanceof Y.XmlFragment) return "fragment";
  if (value instanceof Y.Map) return "map";
  if (value instanceof Y.Array) return "array";
  return null;
}

/** Updates `target` (a nested type) to `source`'s content in place, when both are the same kind; false otherwise. */
function overwriteType(target: unknown, source: unknown): boolean {
  const kind = typeKind(target);
  if (kind === null || kind !== typeKind(source)) return false;
  if (target instanceof Y.XmlText && source instanceof Y.XmlText) overwriteFormatted(target, source);
  else if (target instanceof Y.Text && source instanceof Y.Text) overwriteFormatted(target, source);
  else if (target instanceof Y.XmlElement && source instanceof Y.XmlElement) overwriteXml(target, source);
  else if (target instanceof Y.XmlFragment && source instanceof Y.XmlFragment) overwriteXml(target, source);
  else if (target instanceof Y.Map && source instanceof Y.Map) overwriteMap(target, source);
  else if (target instanceof Y.Array && source instanceof Y.Array) overwriteArray(target, source);
  else return false;
  return true;
}

/** Makes `target` hold exactly `source`'s entries: equal ones untouched, nested types updated in place. */
export function overwriteMap<T>(into: Y.Map<T>, from: Y.Map<T>): void {
  const target = into as unknown as Y.Map<unknown>;
  const source = from as unknown as Y.Map<unknown>;
  for (const key of [...target.keys()]) {
    if (!source.has(key)) target.delete(key);
  }
  for (const [key, value] of source.entries()) {
    const current = target.get(key);
    if (target.has(key) && sameValue(current, value)) continue;
    if (target.has(key) && overwriteType(current, value)) continue;
    target.set(key, cloneValue(value));
  }
}

/** The span two lists differ in, as [start, endA, endB): everything before `start` and after the ends is equal. */
function diffSpan<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): [number, number, number] {
  let start = 0;
  while (start < a.length && start < b.length && same(a[start] as T, b[start] as T)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && same(a[endA - 1] as T, b[endB - 1] as T)) {
    endA--;
    endB--;
  }
  return [start, endA, endB];
}

/** Makes `target` hold `source`'s items, changing only the span between their common head and tail. */
export function overwriteArray<T>(into: Y.Array<T>, from: Y.Array<T>): void {
  const target = into as unknown as Y.Array<unknown>;
  const source = from as unknown as Y.Array<unknown>;
  const before = target.toArray();
  const after = source.toArray();
  const [start, endA, endB] = diffSpan(before, after, sameValue);
  // As many changed items on each side, pairwise the same kind of nested type: update them in place.
  if (pairsInPlace(before, after, start, endA, endB)) {
    for (let i = start; i < endA; i++) overwriteType(before[i], after[i]);
    return;
  }
  if (endA > start) target.delete(start, endA - start);
  if (endB > start) target.insert(start, after.slice(start, endB).map(cloneValue));
}

/** Whether the changed spans pair up one to one, each pair the same kind of nested type. */
function pairsInPlace(
  before: readonly unknown[],
  after: readonly unknown[],
  start: number,
  endA: number,
  endB: number,
): boolean {
  if (endA - start !== endB - start) return false;
  for (let i = start; i < endA; i++) {
    const kind = typeKind(before[i]);
    if (kind === null || kind !== typeKind(after[i])) return false;
  }
  return true;
}

/** Plain text set with the smallest change: only the characters between the common head and tail. */
export function overwriteText(target: Y.Text, text: string): void {
  const before = target.toString();
  if (before === text) return;
  let start = 0;
  const max = Math.min(before.length, text.length);
  while (start < max && before.charCodeAt(start) === text.charCodeAt(start)) start++;
  // Never split a surrogate pair.
  if (start > 0 && isHigh(before.charCodeAt(start - 1))) start--;
  let tail = 0;
  while (
    tail < max - start &&
    before.charCodeAt(before.length - 1 - tail) === text.charCodeAt(text.length - 1 - tail)
  ) {
    tail++;
  }
  if (tail > 0 && isLow(before.charCodeAt(before.length - tail))) tail--;
  const removed = before.length - start - tail;
  if (removed > 0) target.delete(start, removed);
  const inserted = text.slice(start, text.length - tail);
  if (inserted) target.insert(start, inserted);
}

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Formatted text (with marks) set to another's: unchanged when equal, else its content written again. */
function overwriteFormatted(target: Y.Text, source: Y.Text): void {
  const delta = source.toDelta() as { insert?: unknown; attributes?: Record<string, unknown> }[];
  if (sameValue(target, source)) return;
  if (target.length) target.delete(0, target.length);
  const copy = delta.map((op) => (op.insert instanceof Y.AbstractType ? { ...op, insert: op.insert.clone() } : op));
  target.applyDelta(copy);
}

/**
 * Rich text (a fragment or an element) set to another's: attributes synced, and the children between the common head
 * and tail updated in place when they pair up one to one, else replaced with copies.
 */
export function overwriteXml(target: Y.XmlFragment, source: Y.XmlFragment): void {
  if (target instanceof Y.XmlElement && source instanceof Y.XmlElement) {
    const now = target.getAttributes();
    const next = source.getAttributes();
    for (const key of Object.keys(now)) if (!(key in next)) target.removeAttribute(key);
    for (const [key, value] of Object.entries(next)) {
      if (!sameJson(now[key], value)) target.setAttribute(key, value as string);
    }
  }
  const before = target.toArray();
  const after = source.toArray();
  const [start, endA, endB] = diffSpan<unknown>(before, after, sameValue);
  if (pairsInPlace(before, after, start, endA, endB)) {
    for (let i = start; i < endA; i++) overwriteType(before[i], after[i]);
    return;
  }
  if (endA > start) target.delete(start, endA - start);
  if (endB > start) {
    target.insert(
      start,
      after.slice(start, endB).map((node) => cloneValue(node) as Y.XmlElement | Y.XmlText),
    );
  }
}
