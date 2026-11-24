import type { ScreenKind } from "@agenteschat/adapters";
import { cutText, plainWords } from "../format";

/**
 * What an agent sees on a screen (ADR 0054): the page or window as text, one
 * line per node with a ref for each element it can act on (`button "Save"
 * [ref=e3]`, as `agent-browser`'s snapshot writes it), and what changed
 * between two looks. Surface-agnostic: the browser fills it from its
 * snapshot; a desktop surface fills it from the OS accessibility tree
 * (ADR 0062), and everything built on it (targets in words, checks, plans)
 * works the same.
 */

/** What a screen shows, in the words plans and reports use. */
export const SCREEN_NOUN: Record<ScreenKind, string> = { browser: "page", desktop: "screen" };

/** One element the agent can act on. */
export interface ScreenElement {
  /** `e12` (no `@`). */
  ref: string;
  role: string;
  name: string;
  /** Its line on the screen, as written. */
  line: string;
  /** Where it sits: its named containers, nearest first (`form "Sign in"`, `dialog "Cookies"`). */
  context: string[];
  /** Its line's position in `lines` (document order). */
  index: number;
}

export interface ScreenObservation {
  url: string | null;
  /** The window's title, on a desktop (screen text). */
  title?: string;
  /** The screen as text, one node per line (indentation is nesting). */
  lines: string[];
  elements: ScreenElement[];
  /** When it was taken (ms). */
  at: number;
}

/** A rectangle in the surface's pixels: CSS pixels of a page, screen pixels of a desktop. */
export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A still image of the screen (JPEG), with the size of what it shows in the surface's pixels. */
export interface ScreenImage {
  data: string;
  width: number;
  height: number;
  /** The size of what it shows (points on the image map onto it). */
  viewport: { width: number; height: number };
  /** A close-up of part of the screen: where its top left corner is (the whole screen when absent). */
  origin?: { x: number; y: number };
  /** Elements drawn on it with their number and box, when it was annotated. */
  marks?: ScreenMark[];
}

export interface ScreenMark {
  ref: string;
  number: number;
  role: string;
  name?: string;
  box: ScreenRegion;
}

/**
 * A line's head: its role, its quoted name and the attribute brackets right
 * after them (`button "Save" [focused, ref=e3]`, `heading "Title" [ref=e1]
 * [level=1]`). A ref is read there only, as an attribute of its own: a name
 * or a text that says `ref=e9` (a page's title, a terminal's output) can't
 * pass for an element.
 */
const HEAD = /^-\s+([A-Za-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)/;
const REF_ATTR = /(?:^|[[,])\s*ref=(e\d+)\s*(?=[,\]])/;
/** Containers worth naming as an element's place ("the Delete in the row for invoice 42"). */
const PLACES = new Set([
  "dialog",
  "alertdialog",
  "form",
  "region",
  "navigation",
  "banner",
  "main",
  "complementary",
  "contentinfo",
  "search",
  "table",
  "row",
  "rowgroup",
  "listitem",
  "list",
  "group",
  "menu",
  "menubar",
  "tablist",
  "tabpanel",
  "toolbar",
  "article",
  "section",
  "heading",
  "Iframe",
  "iframe",
  "window",
]);

/** A table row has no name of its own in the snapshot: its cells say which row it is. */
const ROWS = new Set(["row"]);
/** A place's name, at most. */
const PLACE_CHARS = 80;
const CELLS = new Set(["cell", "gridcell", "rowheader", "columnheader"]);

const unquote = (s: string) => s.replace(/\\(.)/g, "$1");

/** A line's role, name and ref (see `HEAD`). */
function headOf(body: string): { role: string; name: string | null; ref: string | null } {
  const m = HEAD.exec(body);
  if (!m) return { role: "", name: null, ref: null };
  return {
    role: m[1] as string,
    name: m[2] !== undefined ? unquote(m[2]) : null,
    ref: REF_ATTR.exec(m[3] ?? "")?.[1] ?? null,
  };
}

/** `e7`, `@e7` or `[ref=e7]` → `e7`; anything else → null. */
export function screenRef(target: string): string | null {
  const m = /^\s*(?:\[?ref=)?@?(e\d+)\]?\s*$/.exec(target);
  return m ? (m[1] as string) : null;
}

interface Node {
  role: string;
  name: string | null;
  ref: string | null;
  line: string;
  parent: number;
}

/**
 * The screen from a snapshot's text (and its `refs` map when there is one:
 * role and name per ref, as `agent-browser --json` returns them).
 */
export function observeSnapshot(input: {
  text: string;
  url?: string | null;
  title?: string | null;
  refs?: unknown;
  at?: number;
}): ScreenObservation {
  const lines = input.text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");
  const known =
    input.refs && typeof input.refs === "object"
      ? (input.refs as Record<string, { role?: unknown; name?: unknown }>)
      : {};
  // The tree: each line's node and its parent (by indentation).
  const nodes: Node[] = [];
  const children: number[][] = [];
  const open: { depth: number; index: number }[] = [];
  lines.forEach((line, index) => {
    const depth = (line.length - line.trimStart().length) / 2;
    const body = line.trim();
    while (open.length > 0 && (open[open.length - 1] as { depth: number }).depth >= depth) open.pop();
    const parent = open.length > 0 ? (open[open.length - 1] as { index: number }).index : -1;
    nodes.push({ ...headOf(body), line: body, parent });
    children.push([]);
    if (parent >= 0) (children[parent] as number[]).push(index);
    open.push({ depth, index });
  });
  /**
   * A row's first named cells, once per row: enough of them for a place's characters with any one left out. Every
   * element in a row reads it: joining all of its cells for each one would grow with the row's size squared, in time
   * and in memory (a cut keeps its whole join alive).
   */
  const rowCells = new Map<number, { index: number; name: string }[]>();
  const cellsOf = (row: number) => {
    let cells = rowCells.get(row);
    if (cells) return cells;
    cells = [];
    let size = 0;
    for (const c of children[row] as number[]) {
      const { role, name } = nodes[c] as Node;
      if (!name || !CELLS.has(role)) continue;
      cells.push({ index: c, name: name.slice(0, PLACE_CHARS) });
      size += Math.min(name.length, PLACE_CHARS) + 3;
      if (size >= 2 * (PLACE_CHARS + 3)) break;
    }
    rowCells.set(row, cells);
    return cells;
  };
  /** How a container reads as a place: its name, or for a row the other cells' text ("Invoice 42 · R$ 42,00"). */
  const placeOf = (i: number, via: number): string | null => {
    const n = nodes[i] as Node;
    if (!PLACES.has(n.role)) return null;
    if (n.name) return `${n.role} "${cutText(n.name, PLACE_CHARS)}"`;
    if (!ROWS.has(n.role)) return null;
    const cells = cellsOf(i)
      .filter((c) => c.index !== via)
      .map((c) => c.name);
    return cells.length > 0 ? `${n.role} "${cutText(cells.join(" · "), PLACE_CHARS)}"` : null;
  };
  const elements: ScreenElement[] = [];
  nodes.forEach((n, index) => {
    if (!n.ref) return;
    // Its named containers, nearest first.
    const context: string[] = [];
    let child = index;
    let p = n.parent;
    while (p >= 0 && context.length < 3) {
      const place = placeOf(p, child);
      if (place) context.push(place);
      child = p;
      p = (nodes[p] as Node).parent;
    }
    const meta = known[n.ref];
    elements.push({
      ref: n.ref,
      role: typeof meta?.role === "string" && meta.role ? meta.role : n.role,
      name: typeof meta?.name === "string" ? meta.name : (n.name ?? ""),
      line: n.line,
      context,
      index,
    });
  });
  // Refs the map knows that no line carries (rare): still targets.
  const seen = new Set(elements.map((e) => e.ref));
  for (const [ref, meta] of Object.entries(known)) {
    if (seen.has(ref) || !/^e\d+$/.test(ref)) continue;
    const role = typeof meta?.role === "string" ? meta.role : "";
    const name = typeof meta?.name === "string" ? meta.name : "";
    elements.push({ ref, role, name, line: `${role} "${name}" [ref=${ref}]`, context: [], index: lines.length });
  }
  return {
    url: input.url ?? null,
    ...(input.title ? { title: input.title } : {}),
    lines,
    elements,
    at: input.at ?? Date.now(),
  };
}

/** How an element reads to a judge: its line plus where it sits. */
export function describeElement(e: ScreenElement, max = 220): string {
  // Only the head of a long line: the text is cut at `max` anyway, and the ref's pattern backtracks over long spaces.
  const own = e.line
    .slice(0, max + 64)
    .replace(/^-\s+/, "")
    .replace(/\s*\[ref=e\d+\]/, "");
  const where = e.context.length > 0 ? ` — in ${e.context.join(" › ")}` : "";
  const text = `${own}${where}`;
  return text.length > max ? `${cutText(text, max - 1)}…` : text;
}

/** A look this recent is the screen as it is: a plan's first target can be found on it. */
export const FRESH_LOOK_MS = 8000;
/** A look this recent is still what the agent knows of the screen: a plan's changes are counted from it. */
export const KNOWN_LOOK_MS = 10 * 60_000;

/**
 * The last look at each agent's screen, by key, for the newest `max` keys: what its plans start from. A look older
 * than `KNOWN_LOOK_MS` is dropped (nothing reads one), so idle agents' huge pages don't stay in memory.
 */
export function createLookMemory(now: () => number = Date.now, max = 1000) {
  const looks = new Map<string, ScreenObservation>();
  let sweep: ReturnType<typeof setInterval> | null = null;
  const prune = () => {
    for (const [k, old] of looks) {
      if (now() - old.at < KNOWN_LOOK_MS) break;
      looks.delete(k);
    }
    if (looks.size === 0 && sweep) {
      clearInterval(sweep);
      sweep = null;
    }
  };
  return {
    remember(key: string, o: ScreenObservation) {
      looks.delete(key);
      looks.set(key, o);
      if (looks.size > max) looks.delete(looks.keys().next().value as string);
      prune();
      // The last looks go once they are old even when no agent looks again (a quiet server keeps none of them).
      if (!sweep && looks.size > 0) {
        sweep = setInterval(prune, KNOWN_LOOK_MS);
        sweep.unref?.();
      }
    },
    /** The last look, when it is younger than `ms`. */
    within(key: string, ms: number) {
      const o = looks.get(key);
      return o && now() - o.at < ms ? o : null;
    },
    forget(key: string) {
      looks.delete(key);
    },
  };
}

/** The address without its fragment: two looks at the same document. */
const documentOf = (url: string | null) => (url ? url.replace(/#.*$/, "") : null);

export interface ScreenChanges {
  /** The address changed, or most of the screen did: a new page, not a change on it. */
  newPage: boolean;
  added: string[];
  removed: string[];
  urlBefore: string | null;
  urlAfter: string | null;
}

/**
 * What changed between two looks, line by line (a multiset difference: refs
 * stay the same for elements that survive, so a kept line reads the same).
 * Lines in screen order.
 */
export function diffObservations(before: ScreenObservation | null, after: ScreenObservation): ScreenChanges {
  if (!before) {
    return { newPage: true, added: after.lines, removed: [], urlBefore: null, urlAfter: after.url };
  }
  const count = new Map<string, number>();
  for (const l of before.lines) count.set(l.trim(), (count.get(l.trim()) ?? 0) + 1);
  const added: string[] = [];
  for (const l of after.lines) {
    const k = l.trim();
    const n = count.get(k) ?? 0;
    if (n > 0) count.set(k, n - 1);
    else added.push(l);
  }
  const left = new Map(count);
  const removed: string[] = [];
  for (const l of before.lines) {
    const k = l.trim();
    const n = left.get(k) ?? 0;
    if (n > 0) {
      removed.push(l);
      left.set(k, n - 1);
    }
  }
  const kept = after.lines.length - added.length;
  const newPage =
    documentOf(before.url) !== documentOf(after.url) ||
    (after.lines.length > 8 && kept < Math.min(before.lines.length, after.lines.length) * 0.3);
  return { newPage, added, removed, urlBefore: before.url, urlAfter: after.url };
}

/** A short fingerprint of a screen: two looks with the same one show the same thing. */
export function screenDigest(o: ScreenObservation): string {
  let h = 2166136261;
  for (const l of o.lines) {
    for (let i = 0; i < l.length; i++) {
      h ^= l.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 10;
  }
  return `${documentOf(o.url) ?? ""}#${(h >>> 0).toString(36)}:${o.lines.length}`;
}

const STRUCTURE = new Set(["heading", "dialog", "alertdialog", "alert", "status", "tab", "Iframe", "iframe", "window"]);

/**
 * What the agent can act on, for its first look at a page: elements with a
 * ref plus headings, dialogs and alerts, nesting kept; at most `max`
 * characters (the rest counted).
 */
export function screenOverview(o: ScreenObservation, max = 6000): { text: string; omitted: number } {
  const keep = o.lines.filter((l) => {
    const head = headOf(l.trim());
    return head.ref !== null || STRUCTURE.has(head.role);
  });
  return clipLines(keep, max);
}

/** Lines up to `max` characters; how many were left out. */
export function clipLines(lines: string[], max: number): { text: string; omitted: number } {
  const out: string[] = [];
  let size = 0;
  for (const l of lines) {
    if (size + l.length + 1 > max) break;
    out.push(l);
    size += l.length + 1;
  }
  return { text: out.join("\n"), omitted: lines.length - out.length };
}

/** What a judge reads of a page, at most (about 4-5k tokens): a longer page goes in part. */
const JUDGE_TEXT_CHARS = 16_000;
/** On a long page, the top always goes in (its title, header, who is signed in), and each line at most this long. */
const HEAD_CHARS = 2000;
const JUDGE_LINE_CHARS = 1000;
/** Lines kept on each side of a changed line or of one with the question's words. */
const NEAR = 2;
/** What a page says of itself, wherever it is: kept last, while room is left. */
const SIGNALS = new Set(["heading", "dialog", "alertdialog", "alert", "status"]);

/** The indices of `changes.added` in `o` (a repeated line: its last copies, as `diffObservations` counts them). */
function addedIndices(o: ScreenObservation, changes: ScreenChanges): number[] {
  const left = new Map<string, number>();
  for (const l of changes.added) left.set(l.trim(), (left.get(l.trim()) ?? 0) + 1);
  const out: number[] = [];
  for (let i = o.lines.length - 1; i >= 0; i--) {
    const k = (o.lines[i] as string).trim();
    const n = left.get(k) ?? 0;
    if (n === 0) continue;
    left.set(k, n - 1);
    out.push(i);
  }
  return out.reverse();
}

/** Scripts written without spaces between words: their words are looked for as pairs of letters. */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** What to look for of `words`: a word that starts a page's word, or a pair of letters anywhere (`UNSPACED`). */
function termsOf(words: string): { text: string; anywhere: boolean }[] {
  const out = new Map<string, boolean>();
  for (const w of plainWords(words).split(" ")) {
    if (UNSPACED.test(w)) {
      const c = [...w];
      if (c.length < 2) out.set(w, true);
      for (let k = 0; k + 1 < c.length; k++) out.set(`${c[k]}${c[k + 1]}`, true);
    } else if (w.length > 2 || (w.length === 2 && /[^\p{Script=Latin}\p{N}]/u.test(w))) out.set(w, false);
  }
  return [...out].map(([text, anywhere]) => ({ text, anywhere }));
}

/**
 * The page's text for a judge. A page longer than `max` characters goes in part, in page order with `…` where lines
 * are left out: its top, then the lines that changed (a change on the same page, not a new one) and the lines with
 * the most of `words` (the condition, the target), each with a few around it, then headings, dialogs and alerts.
 * A long line goes in pieces, so the piece with the words can go without the rest of the line.
 */
export function screenText(
  o: ScreenObservation,
  focus: { changes?: ScreenChanges | null; words?: string } = {},
  max = JUDGE_TEXT_CHARS,
): { text: string; omitted: number } {
  const lines = o.lines;
  if (lines.reduce((n, l) => n + l.length + 1, 0) <= max) return { text: lines.join("\n"), omitted: 0 };
  const pieces: { text: string; line: number; first: boolean }[] = [];
  const firstPiece: number[] = [];
  lines.forEach((l, line) => {
    firstPiece.push(pieces.length);
    let k = 0;
    do {
      const text = cutText(l.slice(k), JUDGE_LINE_CHARS);
      pieces.push({ text, line, first: k === 0 });
      k += text.length;
    } while (k < l.length);
  });
  const keep = new Set<number>();
  let room = max;
  const take = (i: number) => {
    if (i < 0 || i >= pieces.length || keep.has(i)) return;
    // The piece, and a `…` it may open after it.
    const n = (pieces[i] as { text: string }).text.length + 3;
    if (n > room) return;
    keep.add(i);
    room -= n;
  };
  const around = (i: number) => {
    take(i);
    for (let d = 1; d <= NEAR; d++) {
      take(i - d);
      take(i + d);
    }
  };
  for (let i = 0, size = 0; i < pieces.length && size < HEAD_CHARS; i++) {
    take(i);
    size += (pieces[i] as { text: string }).text.length + 1;
  }
  if (focus.changes && !focus.changes.newPage) {
    for (const i of addedIndices(o, focus.changes)) around(firstPiece[i] as number);
  }
  const terms = termsOf(focus.words ?? "");
  if (terms.length > 0) {
    // A word counts less the more pieces have it ("the" on every line, "declined" on one).
    const said = pieces.map((p) => ` ${plainWords(p.text)} `);
    const has = terms.map((t) => said.map((l) => l.includes(t.anywhere ? t.text : ` ${t.text}`)));
    const weight = has.map((at) => 1 / Math.max(1, at.filter(Boolean).length));
    const scored: { i: number; score: number }[] = [];
    said.forEach((_, i) => {
      const score = has.reduce((n, at, k) => n + (at[i] ? (weight[k] as number) : 0), 0);
      if (score > 0) scored.push({ i, score });
    });
    for (const { i } of scored.sort((a, b) => b.score - a.score || a.i - b.i)) around(i);
  }
  pieces.forEach((p, i) => {
    if (p.first && SIGNALS.has(headOf(p.text.trim()).role)) take(i);
  });
  const kept = [...keep].sort((a, b) => a - b);
  const lineOf = (i: number) => (pieces[i] as { line: number }).line;
  let text = "";
  let prev = -1;
  for (const i of kept) {
    const p = pieces[i] as { text: string; line: number; first: boolean };
    if (prev >= 0 && lineOf(prev) === p.line) text += i === prev + 1 ? p.text : `…${p.text}`;
    else {
      // The end of the line before, whole lines between, the start of this one: each left out is a `…`.
      if (prev >= 0 && prev + 1 < pieces.length && lineOf(prev + 1) === lineOf(prev)) text += "…";
      if (p.line > (prev >= 0 ? lineOf(prev) + 1 : 0)) text += prev >= 0 ? "\n…" : "…";
      if (prev >= 0 || p.line > 0) text += "\n";
      text += p.first ? p.text : `…${p.text}`;
    }
    prev = i;
  }
  if (prev >= 0 && prev + 1 < pieces.length) {
    if (lineOf(prev + 1) === lineOf(prev)) text += "…";
    if (lineOf(pieces.length - 1) > lineOf(prev)) text += "\n…";
  }
  const whole = new Map<number, number>();
  for (const i of kept) whole.set(lineOf(i), (whole.get(lineOf(i)) ?? 0) + 1);
  const omitted = lines.filter(
    (_, line) => whole.get(line) !== (firstPiece[line + 1] ?? pieces.length) - (firstPiece[line] as number),
  ).length;
  return { text, omitted };
}
