import * as Y from "yjs";
import { normalizeRich, paragraphAttrs, richFromText, runMarks } from "./text";
import type { RichDoc, RichParagraph, RichRun } from "./types";

/**
 * Rich text in a `Y.XmlFragment` in y-prosemirror's encoding (ADR 0196 §2), read and written without ProseMirror so
 * the phone and the server share the web editor's documents. What `writeRich` stores is what y-prosemirror 1.3.7's
 * `prosemirrorJSONToYXmlFragment` stores for the same text under `RICH_SCHEMA_SPEC` (tests prove it both ways):
 *
 * - each paragraph is a `Y.XmlElement("paragraph")` with an attribute for each attribute that isn't null (`level` 0
 *   included);
 * - consecutive text is one `Y.XmlText` whose inserts carry each mark as an attribute named after the mark, valued
 *   with the mark's attributes (`{ bold: {} }`, `{ color: { color: "#c00" } }`, `{ link: { href } }`);
 * - a line break is a `Y.XmlElement("hard_break")` between the texts.
 */

type ParagraphAttrs = { [key: string]: string | number };

/** y-prosemirror names a mark that may overlap itself `name--<hash>`; ours never do, but read both. */
const HASHED_MARK = /^(.*)--[a-zA-Z0-9+/=]{8}$/;

function markName(attribute: string): string {
  return HASHED_MARK.exec(attribute)?.[1] ?? attribute;
}

function runOf(text: string, attributes: Record<string, unknown> | undefined): RichRun {
  const run: RichRun = { text };
  if (!attributes) return run;
  for (const [attribute, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) continue;
    switch (markName(attribute)) {
      case "bold":
        run.bold = true;
        break;
      case "italic":
        run.italic = true;
        break;
      case "underline":
        run.underline = true;
        break;
      case "strike":
        run.strike = true;
        break;
      case "color": {
        const color = (value as { color?: unknown }).color;
        if (typeof color === "string") run.color = color;
        break;
      }
      case "link": {
        const href = (value as { href?: unknown }).href;
        if (typeof href === "string") run.link = href;
        break;
      }
      default:
        readTypeMark(markName(attribute), value, run);
    }
  }
  return run;
}

/**
 * Reads one of the type marks of ADR 0220 §3 (font, size, weight, highlight, tracking, caps) into `run`, as
 * y-prosemirror stores them (`{ font: { font } }`, `{ highlight: { color } }`, `{ caps: {} }`). Documents share it.
 */
export function readTypeMark(name: string, value: unknown, run: Partial<RichRun>): void {
  const attrs = (value ?? {}) as Record<string, unknown>;
  switch (name) {
    case "font":
      if (typeof attrs.font === "string") run.font = attrs.font;
      break;
    case "size":
      if (typeof attrs.size === "number") run.size = attrs.size;
      break;
    case "weight":
      if (typeof attrs.weight === "number") run.weight = attrs.weight as RichRun["weight"];
      break;
    case "highlight":
      if (typeof attrs.color === "string") run.highlight = attrs.color;
      break;
    case "tracking":
      if (typeof attrs.tracking === "number") run.tracking = attrs.tracking;
      break;
    case "caps":
      run.caps = true;
      break;
  }
}

/** Writes a run's type marks as y-prosemirror attributes (the other half of `readTypeMark`). */
export function writeTypeMarks(run: Partial<RichRun>, attributes: Record<string, unknown>): void {
  if (run.font) attributes.font = { font: run.font };
  if (run.size !== undefined) attributes.size = { size: run.size };
  if (run.weight !== undefined) attributes.weight = { weight: run.weight };
  if (run.highlight) attributes.highlight = { color: run.highlight };
  if (run.tracking !== undefined) attributes.tracking = { tracking: run.tracking };
  if (run.caps) attributes.caps = {};
}

function textRuns(text: Y.XmlText | Y.Text): RichRun[] {
  const runs: RichRun[] = [];
  for (const op of text.toDelta() as { insert?: unknown; attributes?: Record<string, unknown> }[]) {
    if (typeof op.insert === "string" && op.insert) runs.push(runOf(op.insert, op.attributes));
  }
  return runs;
}

function inlineRuns(node: Y.XmlElement | Y.XmlFragment): RichRun[] {
  const runs: RichRun[] = [];
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) runs.push(...textRuns(child));
    else if (child instanceof Y.XmlElement) {
      if (child.nodeName === "hard_break") runs.push({ text: "\n" });
      else runs.push(...inlineRuns(child));
    }
  }
  return runs;
}

function paragraphOf(node: Y.XmlElement | Y.XmlText): RichParagraph {
  if (node instanceof Y.XmlText) return { runs: textRuns(node) };
  const attrs = node.nodeName === "paragraph" ? paragraphAttrs(node.getAttributes()) : {};
  return { ...attrs, runs: inlineRuns(node) };
}

/**
 * The text of a fragment, canonical (`normalizeRich`). An element that isn't a paragraph (another editor's block)
 * reads as a paragraph with its words, and unknown marks are left out, so nothing a newer app writes breaks a read.
 */
export function readRich(fragment: Y.XmlFragment): RichDoc {
  const paragraphs: RichParagraph[] = [];
  for (const child of fragment.toArray()) {
    if (child instanceof Y.XmlElement || child instanceof Y.XmlText) paragraphs.push(paragraphOf(child));
  }
  return normalizeRich(paragraphs);
}

function markAttributes(run: RichRun): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  if (run.bold) attributes.bold = {};
  if (run.italic) attributes.italic = {};
  if (run.underline) attributes.underline = {};
  if (run.strike) attributes.strike = {};
  if (run.color) attributes.color = { color: run.color };
  if (run.link) attributes.link = { href: run.link };
  writeTypeMarks(run, attributes);
  return attributes;
}

/** A paragraph's inline content: texts and line breaks, as y-prosemirror lays them out. */
function inlineNodes(runs: readonly RichRun[]): (Y.XmlText | Y.XmlElement)[] {
  const nodes: (Y.XmlText | Y.XmlElement)[] = [];
  let pending: { insert: string; attributes: Record<string, unknown> }[] = [];
  const flush = () => {
    if (!pending.length) return;
    const text = new Y.XmlText();
    text.applyDelta(pending);
    nodes.push(text);
    pending = [];
  };
  for (const run of runs) {
    run.text.split("\n").forEach((part, i) => {
      if (i > 0) {
        flush();
        nodes.push(new Y.XmlElement("hard_break"));
      }
      if (part) pending.push({ insert: part, attributes: markAttributes(run) });
    });
  }
  flush();
  return nodes;
}

function paragraphElement(paragraph: RichParagraph): Y.XmlElement {
  const element = new Y.XmlElement<ParagraphAttrs>("paragraph");
  if (paragraph.align) element.setAttribute("align", paragraph.align);
  element.setAttribute("level", paragraph.level ?? 0);
  if (paragraph.list) element.setAttribute("list", paragraph.list);
  if (paragraph.lineHeight !== undefined) element.setAttribute("lineHeight", paragraph.lineHeight);
  if (paragraph.spaceAfter !== undefined) element.setAttribute("spaceAfter", paragraph.spaceAfter);
  element.insert(0, inlineNodes(paragraph.runs));
  return element as unknown as Y.XmlElement;
}

function inTransaction(fragment: Y.XmlFragment, origin: unknown, fn: () => void): void {
  const doc = fragment.doc;
  if (doc) doc.transact(fn, origin);
  else fn();
}

/**
 * Replaces everything in the fragment with `rich` (normalized; an empty text is one empty paragraph, as ProseMirror's
 * `paragraph+` needs). `origin` applies when this isn't already inside a transaction.
 */
export function writeRich(fragment: Y.XmlFragment, rich: readonly RichParagraph[], origin?: unknown): void {
  const paragraphs = normalizeRich(rich);
  const content = (paragraphs.length ? paragraphs : [{ runs: [] }]).map(paragraphElement);
  inTransaction(fragment, origin, () => {
    // A fragment not yet in a document is a new one (reading it would only warn): nothing to delete.
    if (fragment.doc && fragment.length) fragment.delete(0, fragment.length);
    fragment.insert(0, content);
  });
}

/** A new fragment holding `rich`, to put in a map (`Y.Map.set`) before it joins a document. */
export function richFragment(rich: readonly RichParagraph[] | string): Y.XmlFragment {
  const fragment = new Y.XmlFragment();
  writeRich(fragment, typeof rich === "string" ? richFromText(rich) : rich);
  return fragment;
}

/** Replaces the fragment's text with light Markdown (`richFromText`). */
export function setRichText(fragment: Y.XmlFragment, text: string, origin?: unknown): void {
  writeRich(fragment, richFromText(text), origin);
}

/** The plain text of a fragment, paragraphs joined by "\n". */
export function fragmentText(fragment: Y.XmlFragment): string {
  return fragment
    .toArray()
    .map((child) => (child instanceof Y.XmlElement || child instanceof Y.XmlText ? plainOf(child) : ""))
    .join("\n");
}

function plainOf(node: Y.XmlElement | Y.XmlText): string {
  return paragraphOf(node)
    .runs.map((r) => r.text)
    .join("");
}

/**
 * The phone's editor (ADR 0196 §9): sets the paragraphs' texts to `texts`, touching as little as it can so other
 * people's edits in the same box merge. Paragraphs whose text didn't change keep everything; a changed paragraph is
 * matched to the old one it most resembles and keeps its attributes and the marks of the words around the change
 * (typed text takes the marks before it); new paragraphs take the attributes of the one before them (a new line in a
 * list stays in the list).
 */
export function editParagraphTexts(fragment: Y.XmlFragment, texts: readonly string[], origin?: unknown): void {
  inTransaction(fragment, origin, () => {
    const nodes = fragment
      .toArray()
      .filter(
        (child): child is Y.XmlElement | Y.XmlText => child instanceof Y.XmlElement || child instanceof Y.XmlText,
      );
    if (nodes.length !== fragment.length) {
      // Something that isn't text sits at the top level: start over from the texts.
      writeRich(
        fragment,
        texts.map((text) => ({ runs: [{ text }] })),
      );
      return;
    }
    const next = texts.length ? texts : [""];
    const old = nodes.map((node) => plainOf(node));
    let start = 0;
    while (start < old.length && start < next.length && old[start] === next[start]) start++;
    let endOld = old.length;
    let endNew = next.length;
    while (endOld > start && endNew > start && old[endOld - 1] === next[endNew - 1]) {
      endOld--;
      endNew--;
    }
    const steps = alignTexts(old.slice(start, endOld), next.slice(start, endNew));
    // Each new paragraph takes the attributes of the paragraph before it in the new order (a new line in a list
    // stays in the list): worked out before anything changes.
    const attrsAt: (Omit<RichParagraph, "runs"> | null)[] = [];
    let before: Y.XmlElement | Y.XmlText | undefined = nodes[start - 1];
    for (const step of steps) {
      if (step.kind === "pair") before = nodes[start + step.i];
      if (step.kind !== "insert") {
        attrsAt.push(null);
        continue;
      }
      const kept = steps.find((s): s is Exclude<AlignStep, { kind: "insert" }> => s.kind !== "insert");
      const template = before ?? (kept ? nodes[start + kept.i] : undefined) ?? nodes[endOld];
      const attrs = template ? paragraphOf(template) : { runs: [] };
      attrsAt.push({
        ...(attrs.align ? { align: attrs.align } : {}),
        ...(attrs.level ? { level: attrs.level } : {}),
        ...(attrs.list ? { list: attrs.list } : {}),
        ...(attrs.lineHeight !== undefined ? { lineHeight: attrs.lineHeight } : {}),
        ...(attrs.spaceAfter !== undefined ? { spaceAfter: attrs.spaceAfter } : {}),
      });
    }
    // Applied from the end, so the positions of what comes before stay put.
    let oldAfter = endOld - start;
    for (let k = steps.length - 1; k >= 0; k--) {
      const step = steps[k];
      if (!step) continue;
      if (step.kind === "pair") {
        const node = nodes[start + step.i];
        if (node) editParagraph(node, old[start + step.i] ?? "", next[start + step.j] ?? "");
        oldAfter = step.i;
      } else if (step.kind === "delete") {
        fragment.delete(start + step.i, 1);
        oldAfter = step.i;
      } else {
        const runs = normalizeRich([{ runs: [{ text: next[start + step.j] ?? "" }] }])[0]?.runs ?? [];
        fragment.insert(start + oldAfter, [paragraphElement({ ...(attrsAt[k] ?? {}), runs })]);
      }
    }
  });
}

type AlignStep = { kind: "pair"; i: number; j: number } | { kind: "delete"; i: number } | { kind: "insert"; j: number };

/** What dropping or adding a whole paragraph costs, against pairing two (0 when equal, 1 when nothing is shared). */
const GAP = 0.6;
/** Past this many pairs to weigh, paragraphs pair by position. */
const ALIGN_CELLS = 4096;

function pairCost(a: string, b: string): number {
  if (a === b) return 0;
  const { prefix, suffix } = commonEnds(a, b);
  return 1 - (prefix + suffix) / Math.max(a.length, b.length);
}

/**
 * How the paragraphs that changed line up: which old one became which new one (its attributes and marks kept), which
 * went and which came, at the least cost. On a tie a later paragraph is the one that goes, so the earlier ones keep
 * their place.
 */
function alignTexts(a: readonly string[], b: readonly string[]): AlignStep[] {
  const n = a.length;
  const m = b.length;
  if (n * m > ALIGN_CELLS) {
    const steps: AlignStep[] = [];
    for (let k = 0; k < Math.max(n, m); k++) {
      if (k < n && k < m) steps.push({ kind: "pair", i: k, j: k });
      else if (k < n) steps.push({ kind: "delete", i: k });
      else steps.push({ kind: "insert", j: k });
    }
    return steps;
  }
  const cost: number[][] = Array.from({ length: n + 1 }, (_, i) =>
    Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j * GAP : j === 0 ? i * GAP : 0)),
  );
  const at = (i: number, j: number) => cost[i]?.[j] ?? Number.POSITIVE_INFINITY;
  for (let i = 1; i <= n; i++) {
    const row = cost[i] as number[];
    for (let j = 1; j <= m; j++) {
      const pair = at(i - 1, j - 1) + pairCost(a[i - 1] ?? "", b[j - 1] ?? "");
      row[j] = Math.min(pair, at(i - 1, j) + GAP, at(i, j - 1) + GAP);
    }
  }
  const steps: AlignStep[] = [];
  const same = (x: number, y: number) => Math.abs(x - y) < 1e-9;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const here = at(i, j);
    if (i > 0 && same(here, at(i - 1, j) + GAP)) {
      steps.push({ kind: "delete", i: --i });
    } else if (j > 0 && same(here, at(i, j - 1) + GAP)) {
      steps.push({ kind: "insert", j: --j });
    } else {
      steps.push({ kind: "pair", i: --i, j: --j });
    }
  }
  return steps.reverse();
}

function commonEnds(a: string, b: string): { prefix: number; suffix: number } {
  let prefix = 0;
  const max = Math.min(a.length, b.length);
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  // Never split a surrogate pair.
  if (prefix > 0 && prefix < max && isHighSurrogate(a.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  while (suffix < max - prefix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) {
    suffix++;
  }
  if (suffix > 0 && suffix < max - prefix && isLowSurrogate(a.charCodeAt(a.length - suffix))) suffix--;
  return { prefix, suffix };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function editParagraph(node: Y.XmlElement | Y.XmlText, before: string, after: string): void {
  if (before === after) return;
  const { prefix, suffix } = commonEnds(before, after);
  const inserted = after.slice(prefix, after.length - suffix);
  const removed = before.length - prefix - suffix;
  if (node instanceof Y.XmlText) {
    replaceText(node, prefix, removed, inserted);
    return;
  }
  const children = node.toArray();
  const only = children.length === 1 ? children[0] : undefined;
  if (!before.includes("\n") && !after.includes("\n") && (only instanceof Y.XmlText || children.length === 0)) {
    if (only instanceof Y.XmlText) replaceText(only, prefix, removed, inserted);
    else if (inserted) {
      const text = new Y.XmlText();
      text.insert(0, inserted);
      node.insert(0, [text]);
    }
    return;
  }
  // Line breaks involved: rebuild the paragraph's inline content from its runs with the same change.
  const runs = spliceRuns(inlineRuns(node), prefix, prefix + removed, inserted);
  const paragraph = normalizeRich([{ runs }])[0];
  if (node.length) node.delete(0, node.length);
  node.insert(0, inlineNodes(paragraph?.runs ?? []));
}

/** In place: the words around keep their marks, and typed text takes the marks of the character before it. */
function replaceText(text: Y.XmlText, at: number, removed: number, inserted: string): void {
  if (removed > 0) text.delete(at, removed);
  if (inserted) text.insert(at, inserted);
}

/** The runs covering the characters [from, to). */
function sliceRuns(runs: readonly RichRun[], from: number, to: number): RichRun[] {
  const out: RichRun[] = [];
  let at = 0;
  for (const run of runs) {
    const end = at + run.text.length;
    const a = Math.max(from, at);
    const b = Math.min(to, end);
    if (b > a) out.push({ ...run, text: run.text.slice(a - at, b - at) });
    at = end;
  }
  return out;
}

/** Runs with the characters [from, to) replaced by `text`, which takes the marks of the character before it. */
function spliceRuns(runs: readonly RichRun[], from: number, to: number, text: string): RichRun[] {
  const head = sliceRuns(runs, 0, from);
  const tail = sliceRuns(runs, to, Number.POSITIVE_INFINITY);
  const last = head[head.length - 1];
  return text ? [...head, { ...(last ? runMarks(last) : {}), text }, ...tail] : [...head, ...tail];
}
