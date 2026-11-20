import type { DocRun } from "@agenteschat/live/document";
import * as Y from "yjs";

/**
 * A document block's words edited character by character on the phone (ADR 0200): the field's text is the block's
 * texts and line breaks laid end to end, and each change typed there becomes the smallest edit of the block's own
 * `Y.XmlText`s (one delete, one insert, at the place it happened), so two people typing in the same block both keep
 * what they wrote, and the marks of the words nobody touched stay. Words typed take the marks of the character before
 * the caret (or those the format bar turned on). Splitting and joining blocks stay the document's block operations.
 */

/** Marks as the document stores them: one attribute per mark (`{ bold: {} }`, `{ link: { href } }`). */
export type Marks = Record<string, unknown>;

/** A place in the block's text: a run of `Y.XmlText`, a line break, or something else inline (one character). */
interface Segment {
  node: Y.XmlText | Y.XmlElement;
  /** Its place among the element's children. */
  index: number;
  /** Where it starts in the field's text, and how long it is there. */
  start: number;
  length: number;
  text: boolean;
}

/** A line break in the field's text; anything else inline stands as one object character. */
const BREAK = "\n";
const OBJECT = "￼";

/** y-prosemirror names a mark that may overlap itself `name--<hash>`: the name. */
const markName = (attribute: string) => /^(.*)--[a-zA-Z0-9+/=]{8}$/.exec(attribute)?.[1] ?? attribute;

/**
 * The element whose words the phone edits for a top-level block: a paragraph's, a heading's or a code block's own, a
 * quote's one paragraph; null for anything else (pictures, tables, a quote of many parts).
 */
export function editableElement(block: Y.XmlElement | Y.XmlText | null | undefined): Y.XmlElement | null {
  if (!(block instanceof Y.XmlElement)) return null;
  if (block.nodeName === "paragraph" || block.nodeName === "heading" || block.nodeName === "code_block") return block;
  if (block.nodeName === "blockquote" && block.length === 1) {
    const inner = block.get(0);
    if (inner instanceof Y.XmlElement && inner.nodeName === "paragraph") return inner;
  }
  return null;
}

function segmentsOf(element: Y.XmlElement): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  element.toArray().forEach((node, index) => {
    if (node instanceof Y.XmlText) {
      out.push({ node, index, start: at, length: node.length, text: true });
      at += node.length;
    } else if (node instanceof Y.XmlElement) {
      out.push({ node, index, start: at, length: 1, text: false });
      at += 1;
    }
  });
  return out;
}

type DeltaOp = { insert?: unknown; attributes?: Marks };

/** A stored insert's attributes as a run's marks. */
function runOf(text: string, attributes: Marks | undefined): DocRun {
  const run: DocRun = { text };
  for (const [attribute, value] of Object.entries(attributes ?? {})) {
    if (value === null || value === undefined) continue;
    const name = markName(attribute);
    if (name === "bold" || name === "italic" || name === "underline" || name === "strike" || name === "code")
      run[name] = true;
    else if (name === "link" && typeof (value as { href?: unknown }).href === "string")
      run.link = (value as { href: string }).href;
    else if (name === "color" && typeof (value as { color?: unknown }).color === "string")
      run.color = (value as { color: string }).color;
  }
  return run;
}

/** The block's words as runs with their marks, a line break as "\n": what the field draws. */
export function runsOf(element: Y.XmlElement): DocRun[] {
  const runs: DocRun[] = [];
  for (const s of segmentsOf(element)) {
    if (!s.text) {
      runs.push({ text: (s.node as Y.XmlElement).nodeName === "hard_break" ? BREAK : OBJECT });
      continue;
    }
    for (const op of (s.node as Y.XmlText).toDelta() as DeltaOp[]) {
      if (typeof op.insert === "string") {
        if (op.insert) runs.push(runOf(op.insert, op.attributes));
      } else runs.push({ text: OBJECT });
    }
  }
  return runs;
}

/** The field's text: the block's words, line breaks as "\n". */
export const plainOf = (element: Y.XmlElement) =>
  runsOf(element)
    .map((r) => r.text)
    .join("");

/** The runs between two places of the text (a split's tail), their marks kept. */
export function runsSlice(runs: readonly DocRun[], start: number, end: number): DocRun[] {
  const out: DocRun[] = [];
  let at = 0;
  for (const run of runs) {
    const a = Math.max(start, at);
    const b = Math.min(end, at + run.text.length);
    if (b > a) out.push({ ...run, text: run.text.slice(a - at, b - at) });
    at += run.text.length;
  }
  return out;
}

/** One change of a field's text: `remove` characters at `at`, then `insert` there. */
export interface TextDiff {
  at: number;
  remove: number;
  insert: string;
}

/** The smallest change from one text to the next (what they share at both ends stays); null when they are equal. */
export function textDiff(before: string, after: string): TextDiff | null {
  if (before === after) return null;
  let prefix = 0;
  const shortest = Math.min(before.length, after.length);
  while (prefix < shortest && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  )
    suffix++;
  return { at: prefix, remove: before.length - prefix - suffix, insert: after.slice(prefix, after.length - suffix) };
}

/** Where a place of the text is after a change made elsewhere (the person's caret under someone else's typing). */
export function mapCaret(pos: number, diff: TextDiff): number {
  if (pos <= diff.at) return pos;
  if (pos >= diff.at + diff.remove) return pos - diff.remove + diff.insert.length;
  return diff.at + diff.insert.length;
}

/** The stored attributes of the character at `pos` (null: a line break, an object, or past the end). */
function attributesAt(element: Y.XmlElement, pos: number): Marks | null {
  for (const s of segmentsOf(element)) {
    if (pos < s.start || pos >= s.start + s.length) continue;
    if (!s.text) return null;
    let at = s.start;
    for (const op of (s.node as Y.XmlText).toDelta() as DeltaOp[]) {
      const length = typeof op.insert === "string" ? op.insert.length : 1;
      if (pos < at + length) return { ...(op.attributes ?? {}) };
      at += length;
    }
  }
  return null;
}

/**
 * The marks words typed at `at` take: the character before it, or (at a line's start) the one after it. A link goes on
 * only inside it: typed right after a link, the words are not part of it.
 */
export function marksAt(element: Y.XmlElement, at: number): Marks {
  const before = at > 0 ? attributesAt(element, at - 1) : null;
  const after = attributesAt(element, at);
  const marks = { ...(before ?? after ?? {}) };
  for (const key of Object.keys(marks)) {
    if (markName(key) !== "link") continue;
    const inside = before && after && JSON.stringify(before[key]) === JSON.stringify(after[key]);
    if (!inside) delete marks[key];
  }
  return marks;
}

/** Deletes the text between two places, across the block's texts and line breaks (from the end, so places stay). */
export function deleteRange(element: Y.XmlElement, from: number, to: number): void {
  const segments = segmentsOf(element);
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i] as Segment;
    const a = Math.max(from, s.start);
    const b = Math.min(to, s.start + s.length);
    if (b <= a) continue;
    // An emptied text stays: someone may be typing in it right now.
    if (s.text) (s.node as Y.XmlText).delete(a - s.start, b - a);
    else element.delete(s.index, 1);
  }
}

/**
 * Inserts words at `at` with exactly `marks`: into the text the caret is at the end of or inside, else the text that
 * starts there, else a new text in that place (an empty block, right after a line break).
 */
export function insertAt(element: Y.XmlElement, at: number, words: string, marks: Marks): void {
  if (!words) return;
  const segments = segmentsOf(element);
  const target =
    segments.find((s) => s.text && s.start < at && at <= s.start + s.length) ??
    segments.find((s) => s.text && s.start === at);
  if (target) {
    (target.node as Y.XmlText).insert(at - target.start, words, marks);
    return;
  }
  const next = segments.find((s) => s.start >= at);
  const text = new Y.XmlText();
  element.insert(next ? next.index : element.length, [text]);
  text.insert(0, words, marks);
}

/**
 * A change of the field's text applied to the block: one delete and one insert, the inserted words with `marks`. In a
 * code block the words keep their lines and take no marks; elsewhere a line typed or pasted in joins with a space
 * (Return makes a new block instead).
 */
export function applyDiff(element: Y.XmlElement, diff: TextDiff, marks: Marks): void {
  const code = element.nodeName === "code_block";
  if (diff.remove > 0) deleteRange(element, diff.at, diff.at + diff.remove);
  const words = code ? diff.insert : diff.insert.replace(/\r?\n/g, " ");
  insertAt(element, diff.at, words, code ? {} : marks);
}

/** Whether every character of a range carries a mark (a range with no words: no). */
export function rangeHas(element: Y.XmlElement, from: number, to: number, mark: string): boolean {
  let seen = false;
  for (let pos = from; pos < to; pos++) {
    const attributes = attributesAt(element, pos);
    if (!attributes) continue;
    seen = true;
    if (!Object.entries(attributes).some(([key, value]) => markName(key) === mark && value != null)) return false;
  }
  return seen;
}

/** Sets marks on the words of a range (`{ bold: {} }` puts one on, `{ bold: null }` takes it off). */
export function formatRange(element: Y.XmlElement, from: number, to: number, attributes: Marks): void {
  for (const s of segmentsOf(element)) {
    if (!s.text) continue;
    const a = Math.max(from, s.start);
    const b = Math.min(to, s.start + s.length);
    if (b > a) (s.node as Y.XmlText).format(a - s.start, b - a, attributes);
  }
}

/** A run's marks as the document stores them (the words a joined block brings keep theirs). */
export function runMarks(run: DocRun): Marks {
  const marks: Marks = {};
  if (run.bold) marks.bold = {};
  if (run.italic) marks.italic = {};
  if (run.underline) marks.underline = {};
  if (run.strike) marks.strike = {};
  if (run.code) marks.code = {};
  if (run.color) marks.color = { color: run.color };
  if (run.link) marks.link = { href: run.link };
  return marks;
}

/** Whether marks carry `mark` (the format bar lights its button). */
export const hasMark = (marks: Marks, mark: string) =>
  Object.entries(marks).some(([key, value]) => markName(key) === mark && value != null);

/** Marks with `mark` turned on or off (the format bar with nothing chosen: what the next words take). */
export function withMark(marks: Marks, mark: string, on: boolean): Marks {
  const out: Marks = {};
  for (const [key, value] of Object.entries(marks)) if (markName(key) !== mark) out[key] = value;
  if (on) out[mark] = {};
  return out;
}

/** Appends runs at the end of a block (a block joined to the one above), each keeping its marks. */
export function appendRuns(element: Y.XmlElement, runs: readonly DocRun[]): void {
  let at = plainOf(element).length;
  for (const run of runs) {
    const parts = run.text.split(BREAK);
    parts.forEach((part, i) => {
      if (i > 0) {
        element.insert(element.length, [new Y.XmlElement("hard_break")]);
        at += 1;
      }
      if (part) {
        insertAt(element, at, part, runMarks(run));
        at += part.length;
      }
    });
  }
}
