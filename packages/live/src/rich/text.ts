import { RICH_MAX_LEVEL } from "./schema";
import type { RichDoc, RichParagraph, RichRun } from "./types";

/**
 * Rich text as plain data (ADR 0196 §2): its canonical form, plain text, and the light Markdown agents and people
 * type ("- " bullets, "1. " lists, **bold**, *italic*, ~~strike~~, [links](https://…)).
 */

type Marks = Omit<RichRun, "text">;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s<>"'`]+$/i;
const TYPED_HREF = /^(?:https:\/\/|mailto:)[^\s<>"'`]+$/i;

/** A color a run may carry: "#rgb" or "#rrggbb". */
export function isRichColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

/** A link a run may carry: https, http or mailto, nothing that runs or embeds. */
export function isRichHref(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2048 && SAFE_HREF.test(value);
}

function sameMarks(a: Marks, b: Marks): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.color === b.color &&
    a.link === b.link
  );
}

/** A run's marks, checked (its text left out). */
export function runMarks(run: Partial<RichRun>): Omit<RichRun, "text"> {
  return marksOf(run);
}

function marksOf(run: Partial<RichRun>): Marks {
  const marks: Marks = {};
  if (run.bold === true) marks.bold = true;
  if (run.italic === true) marks.italic = true;
  if (run.underline === true) marks.underline = true;
  if (run.strike === true) marks.strike = true;
  if (isRichColor(run.color)) marks.color = run.color;
  if (isRichHref(run.link)) marks.link = run.link;
  return marks;
}

function hasMarks(marks: Marks): boolean {
  return Object.keys(marks).length > 0;
}

/** A paragraph's attributes, checked: align and list from their words, level an integer 0..4. */
export function paragraphAttrs(input: {
  align?: unknown;
  level?: unknown;
  list?: unknown;
}): Omit<RichParagraph, "runs"> {
  const out: Omit<RichParagraph, "runs"> = {};
  if (input.align === "left" || input.align === "center" || input.align === "right") out.align = input.align;
  const level =
    typeof input.level === "number" ? input.level : typeof input.level === "string" ? Number(input.level) : 0;
  if (Number.isFinite(level) && level >= 1) out.level = Math.min(RICH_MAX_LEVEL, Math.floor(level));
  if (input.list === "bullet" || input.list === "ordered") out.list = input.list;
  return out;
}

/**
 * The canonical form every reader returns and every writer stores: attributes checked, marks checked, empty runs
 * dropped, line breaks never marked (a marked run is split around them, as ProseMirror's hard breaks carry no marks
 * in the stored text), and neighbors with the same marks merged.
 */
export function normalizeRich(rich: readonly RichParagraph[]): RichDoc {
  const out: RichDoc = [];
  for (const paragraph of rich) {
    if (!paragraph || typeof paragraph !== "object") continue;
    const runs: RichRun[] = [];
    const push = (text: string, marks: Marks) => {
      if (!text) return;
      const last = runs[runs.length - 1];
      if (last && sameMarks(marksOf(last), marks)) last.text += text;
      else runs.push({ text, ...marks });
    };
    for (const run of Array.isArray(paragraph.runs) ? paragraph.runs : []) {
      if (!run || typeof run.text !== "string") continue;
      const marks = marksOf(run);
      const text = run.text.replace(/\r\n?/g, "\n");
      if (!hasMarks(marks)) {
        push(text, marks);
        continue;
      }
      text.split("\n").forEach((part, i) => {
        if (i > 0) push("\n", {});
        push(part, marks);
      });
    }
    out.push({ ...paragraphAttrs(paragraph), runs });
  }
  return out;
}

/** The words, paragraphs joined by "\n" (a line break inside a paragraph is a "\n" too). */
export function richText(rich: readonly RichParagraph[]): string {
  return rich.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
}

/** How many characters the text holds (what `LIVE_LIMITS` counts). */
export function richLength(rich: readonly RichParagraph[]): number {
  let n = Math.max(0, rich.length - 1);
  for (const p of rich) for (const r of p.runs) n += r.text.length;
  return n;
}

/** The first `max` characters of the text, structure and marks kept (previews, limits). */
export function clipRich(rich: readonly RichParagraph[], max: number): RichDoc {
  const out: RichDoc = [];
  let left = Math.max(0, max);
  for (const p of rich) {
    if (left <= 0 && out.length) break;
    const runs: RichRun[] = [];
    for (const r of p.runs) {
      if (left <= 0) break;
      const text = r.text.slice(0, left);
      left -= text.length;
      runs.push({ ...r, text });
    }
    out.push({ ...p, runs });
    left--;
  }
  return out;
}

/** Plain text as rich text: one paragraph per line, no marks, nothing read as Markdown. */
export function plainRich(text: string): RichDoc {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return normalizeRich(lines.map((line) => ({ runs: [{ text: line }] })));
}

const BULLET = /^([-*+•])[ \t]+/;
const ORDERED = /^(\d{1,9})[.)][ \t]+/;
const HEADING = /^(#{1,6})[ \t]+/;

/**
 * Light Markdown to rich text: one paragraph per non-blank line; "- ", "* ", "+ " or "• " starts a bullet, "1. " an
 * ordered item, "# " a bold line; two spaces or a tab of indent is one level; **bold** (or __bold__), *italic* (or
 * _italic_), ~~strike~~ and [label](https://…) links (https and mailto only); a backslash keeps the next mark as is.
 */
export function richFromText(text: string): RichDoc {
  const out: RichParagraph[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    let rest = line.slice(indent.length).trimEnd();
    const paragraph: RichParagraph = { runs: [] };
    const level = levelOf(indent);
    if (level) paragraph.level = level;
    let base: Marks = {};
    const bullet = BULLET.exec(rest);
    const ordered = bullet ? null : ORDERED.exec(rest);
    const heading = bullet || ordered ? null : HEADING.exec(rest);
    if (bullet) {
      paragraph.list = "bullet";
      rest = rest.slice(bullet[0].length);
    } else if (ordered) {
      paragraph.list = "ordered";
      rest = rest.slice(ordered[0].length);
    } else if (heading) {
      base = { bold: true };
      rest = rest.slice(heading[0].length);
    }
    parseInline(rest, base, paragraph.runs);
    out.push(paragraph);
  }
  return normalizeRich(out);
}

function levelOf(indent: string): number {
  let level = 0;
  let spaces = 0;
  for (const ch of indent) {
    if (ch === "\t") {
      level++;
      spaces = 0;
    } else if (++spaces === 2) {
      level++;
      spaces = 0;
    }
  }
  return Math.min(RICH_MAX_LEVEL, level);
}

const ESCAPABLE = "\\*_~[]()#`";

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

/** Where an underscore may open or close a mark: next to a space, punctuation or the edge (never inside snake_case). */
function isWordEdge(ch: string | undefined): boolean {
  return ch === undefined || /[\s.,;:!?()[\]{}"'“”‘’-]/.test(ch);
}

function pairAt(src: string, i: number): string {
  for (const delim of ["**", "__", "~~"]) if (src.startsWith(delim, i)) return delim;
  const ch = src[i];
  return ch === "*" || ch === "_" ? ch : "";
}

function pairMarks(pair: string, marks: Marks): Marks {
  if (pair === "**" || pair === "__") return { ...marks, bold: true };
  if (pair === "~~") return { ...marks, strike: true };
  return { ...marks, italic: true };
}

/** Where the delimiter `delim` that opens at `from` closes (with something between), or -1. */
function closing(src: string, from: number, delim: string): number {
  for (let j = from + delim.length + 1; j <= src.length - delim.length; j++) {
    if (src[j - 1] === "\\") continue;
    if (delim === "*" && src.startsWith("**", j)) {
      // A "**…**" inside an italic: step over it (or over a stray "**").
      const inner = closing(src, j, "**");
      j = inner > 0 ? inner + 1 : j + 1;
      continue;
    }
    if (!src.startsWith(delim, j) || isSpace(src[j - 1])) continue;
    // "***both***": the bold closes on the last two stars, leaving the italic's inside it.
    if (delim === "**" && src[j + 2] === "*") return j + 1;
    if (delim.startsWith("_") && !isWordEdge(src[j + delim.length])) continue;
    return j;
  }
  return -1;
}

function parseInline(src: string, marks: Marks, out: RichRun[]): void {
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ text: buffer, ...marks });
    buffer = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? "";
    const next = src[i + 1];
    if (ch === "\\" && next !== undefined && ESCAPABLE.includes(next)) {
      buffer += next;
      i += 2;
      continue;
    }
    const pair = pairAt(src, i);
    if (pair && !isSpace(src[i + pair.length]) && (!pair.startsWith("_") || isWordEdge(src[i - 1]))) {
      const end = closing(src, i, pair);
      if (end > i + pair.length) {
        flush();
        parseInline(src.slice(i + pair.length, end), pairMarks(pair, marks), out);
        i = end + pair.length;
        continue;
      }
    }
    if (ch === "[") {
      const link = linkAt(src, i);
      if (link) {
        flush();
        parseInline(link.label, { ...marks, link: link.href }, out);
        i = link.end;
        continue;
      }
    }
    buffer += ch;
    i++;
  }
  flush();
}

function linkAt(src: string, at: number): { label: string; href: string; end: number } | null {
  let depth = 0;
  for (let j = at + 1; j < src.length; j++) {
    const ch = src[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (src[j + 1] !== "(") return null;
      const close = src.indexOf(")", j + 2);
      if (close < 0) return null;
      const href = src.slice(j + 2, close).trim();
      const label = src.slice(at + 1, j);
      if (!label || !TYPED_HREF.test(href)) return null;
      return { label, href, end: close + 1 };
    }
  }
  return null;
}

/**
 * Rich text as the light Markdown `richFromText` reads (how agents read slides and canvases): bullets, numbered
 * items, indent, bold, italic, strike and links; underline and color have no Markdown and come out as plain text.
 */
export function richToMarkdown(rich: readonly RichParagraph[]): string {
  const lines: string[] = [];
  const counters: number[] = [];
  for (const p of rich) {
    const level = p.level ?? 0;
    counters.length = Math.min(counters.length, level + 1);
    let marker = "";
    if (p.list === "ordered") {
      counters[level] = (counters[level] ?? 0) + 1;
      marker = `${counters[level]}. `;
    } else {
      counters[level] = 0;
      if (p.list === "bullet") marker = "- ";
    }
    lines.push(`${"  ".repeat(level)}${marker}${p.runs.map(runMarkdown).join("")}`);
  }
  return lines.join("\n");
}

function escapeMarkdown(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch === "\\" || ch === "*" || ch === "~" || ch === "[" || ch === "]") out += `\\${ch}`;
    else if (ch === "_" && (isWordEdge(text[i - 1]) || isWordEdge(text[i + 1]))) out += "\\_";
    else out += ch;
  }
  return out;
}

function runMarkdown(run: RichRun): string {
  const text = run.text;
  if (!text.trim()) return text;
  // Marks go around the words, never around the spaces next to them (Markdown wouldn't read them).
  // Sliced by trim, not by an end-anchored pattern (which is quadratic on a long run of spaces).
  const lead = text.slice(0, text.length - text.trimStart().length);
  const trail = text.slice(text.trimEnd().length);
  let core = escapeMarkdown(text.slice(lead.length, text.length - trail.length));
  if (run.strike) core = `~~${core}~~`;
  if (run.italic) core = `*${core}*`;
  if (run.bold) core = `**${core}**`;
  if (run.link) core = `[${core}](${run.link})`;
  return `${lead}${core}${trail}`;
}

/** Equal rich texts (after normalizing both). */
export function sameRich(a: readonly RichParagraph[], b: readonly RichParagraph[]): boolean {
  return JSON.stringify(normalizeRich(a)) === JSON.stringify(normalizeRich(b));
}
