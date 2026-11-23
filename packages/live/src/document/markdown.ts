import { LiveEditError } from "../errors";
import { LIVE_LIMITS } from "../limits";
import { RICH_MAX_LEVEL } from "../rich/schema";
import { isRichHref } from "../rich/text";
import { normalizeBlocks, normalizeRuns } from "./blocks";
import { DOC_MAX_HEADING } from "./schema";
import type { DocBlock, DocCell, DocHeadingLevel, DocParagraph, DocRun } from "./types";

/**
 * Documents and Markdown (ADR 0200): what agents write and read, what a document downloads as (`.md`), and how an
 * older Markdown file becomes a document. CommonMark's blocks (headings, paragraphs, lists nested by indent, quotes,
 * fenced code, rules) and GitHub's tables, strikethrough and bare links; inline **bold**, *italic*, ~~strike~~,
 * `code`, [links](https://…) (https, http and mailto only), <u>underline</u> and <br> line breaks. A picture on a line
 * of its own becomes an image block when `images` knows its address; anything else Markdown can say (HTML, footnotes)
 * stays as its text. Color has no Markdown: it is left out of what is written.
 */

type Marks = Omit<DocRun, "text">;

// ── Inline ────────────────────────────────────────────────────────────────────────────────────────────────────────

const ESCAPABLE = "\\`*_{}[]()#+-.!|~<>";
const BARE_URL = /^https?:\/\/[^\s<>"'`]+/i;

/**
 * How far the inline reader may still look ahead for where a mark, a link, a code span or an address ends. Each look
 * scans forward, so a text full of openers that never close (`[[[[`, ` _a _a`) would cost the square of its length on
 * the server's thread, which reads the Markdown people and agents send (ADR 0200). `parseInlineMarkdown` gives each
 * text a budget in proportion to its length; once it is spent, the rest reads as plain words.
 */
let lookahead = Number.POSITIVE_INFINITY;

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

/** Where an underscore may open or close a mark: next to a space, punctuation or the edge (never inside snake_case). */
const isWordEdge = (ch: string | undefined) => ch === undefined || /[\s.,;:!?()[\]{}"'“”‘’-]/.test(ch);

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

/** Where a code span opening with `ticks` backticks at `from` closes (the index of its closing run), or -1. */
function codeEnd(src: string, from: number, ticks: number): number {
  let j = from + ticks;
  while (j < src.length) {
    if (--lookahead < 0) return -1;
    if (src[j] !== "`") {
      j++;
      continue;
    }
    let run = 0;
    while (src[j + run] === "`") run++;
    lookahead -= run;
    if (run === ticks) return j;
    j += run;
  }
  return -1;
}

const tickRun = (src: string, i: number) => {
  let n = 0;
  while (src[i + n] === "`") n++;
  return n;
};

/** Where the delimiter `delim` that opens at `from` closes (with something between), or -1; code spans are skipped. */
function closing(src: string, from: number, delim: string): number {
  for (let j = from + delim.length; j <= src.length - delim.length; j++) {
    if (--lookahead < 0) return -1;
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (src[j] === "`") {
      const ticks = tickRun(src, j);
      lookahead -= ticks;
      const end = codeEnd(src, j, ticks);
      j = end > 0 ? end + ticks - 1 : j + ticks - 1;
      continue;
    }
    // Something must be between the two delimiters.
    if (j === from + delim.length) continue;
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

/** `[label](href)` or `![alt](src)` at `at` (the `[`): its parts and where it ends, or null. */
function bracketAt(src: string, at: number): { label: string; href: string; end: number } | null {
  let depth = 0;
  for (let j = at + 1; j < src.length; j++) {
    if (--lookahead < 0) return null;
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
      const close = closingParen(src, j + 2);
      if (close < 0) return null;
      // An optional title after the address (`(https://x "Title")`) is left out.
      const href = (
        src
          .slice(j + 2, close)
          .trim()
          .split(/\s+/)[0] ?? ""
      ).replace(/^<|>$/g, "");
      return { label: src.slice(at + 1, j), href, end: close + 1 };
    }
  }
  return null;
}

/** The `)` that closes an address opened before `from`, parentheses inside it balanced; -1 when none does. */
function closingParen(src: string, from: number): number {
  let depth = 0;
  for (let j = from; j < src.length; j++) {
    if (--lookahead < 0) return -1;
    const ch = src[j];
    if (ch === "\\") j++;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) return j;
      depth--;
    }
  }
  return -1;
}

/** A bare address's end: trailing punctuation that closes the sentence stays out of it. */
function bareUrl(src: string, at: number): string | null {
  if (lookahead <= 0) return null;
  const match = BARE_URL.exec(src.slice(at));
  if (!match) return null;
  const url = match[0];
  lookahead -= url.length;
  // Trimmed from the end in one pass, the parentheses counted once (a `)` stays while it closes one inside).
  let opens = 0;
  let closes = 0;
  for (const ch of url) {
    if (ch === "(") opens++;
    else if (ch === ")") closes++;
  }
  let end = url.length;
  while (end > 0 && ".,;:!?)]".includes(url[end - 1] as string)) {
    if (url[end - 1] === ")") {
      if (opens >= closes) break;
      closes--;
    }
    end--;
  }
  const out = url.slice(0, end);
  return isRichHref(out) ? out : null;
}

/** Inline Markdown into runs with `marks` (a heading's, a cell's). */
export function parseInlineMarkdown(src: string, marks: Marks = {}): DocRun[] {
  const out: DocRun[] = [];
  const outer = lookahead;
  lookahead = Math.min(outer, 32 * src.length + 16_384);
  try {
    parseInline(src, marks, out);
  } finally {
    lookahead = outer;
  }
  return normalizeRuns(out);
}

function parseInline(src: string, marks: Marks, out: DocRun[]): void {
  /** The text lowercased once, where `</u>` is looked for. */
  let lowered: string | undefined;
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
    if (ch === "`") {
      const ticks = tickRun(src, i);
      const end = codeEnd(src, i, ticks);
      if (end > 0) {
        flush();
        let code = src.slice(i + ticks, end).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        out.push({ text: code, ...marks, code: true });
        i = end + ticks;
        continue;
      }
      buffer += "`".repeat(ticks);
      i += ticks;
      continue;
    }
    if (ch === "<") {
      const lower = src.slice(i, i + 6).toLowerCase();
      const br = /^<br\s*\/?>/i.exec(src.slice(i, i + 6));
      if (br) {
        buffer += "\n";
        i += br[0].length;
        continue;
      }
      if (lower.startsWith("<u>") && lookahead > 0) {
        lowered ??= src.toLowerCase();
        const close = lowered.indexOf("</u>", i + 3);
        lookahead -= (close < 0 ? src.length : close) - i;
        if (close > i + 3) {
          flush();
          parseInline(src.slice(i + 3, close), { ...marks, underline: true }, out);
          i = close + 4;
          continue;
        }
      }
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(src.slice(i));
      if (auto?.[1] && isRichHref(auto[1])) {
        flush();
        out.push({ text: auto[1].replace(/^mailto:/i, ""), ...marks, link: auto[1] });
        i += auto[0].length;
        continue;
      }
    }
    if (ch === "!" && next === "[") {
      const image = bracketAt(src, i + 1);
      if (image) {
        // A picture inside text can't be a block: its description stays, linked when it has a web address.
        flush();
        const alt = image.label || image.href;
        if (isRichHref(image.href)) out.push({ text: alt, ...marks, link: image.href });
        else if (alt) out.push({ text: alt, ...marks });
        i = image.end;
        continue;
      }
    }
    if (ch === "[") {
      const link = bracketAt(src, i);
      if (link?.label && isRichHref(link.href)) {
        flush();
        parseInline(link.label, { ...marks, link: link.href }, out);
        i = link.end;
        continue;
      }
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
    if (!marks.link && (ch === "h" || ch === "H") && isWordEdge(src[i - 1])) {
      const url = bareUrl(src, i);
      if (url) {
        flush();
        out.push({ text: url, ...marks, link: url });
        i += url.length;
        continue;
      }
    }
    buffer += ch;
    i++;
  }
  flush();
}

// ── Blocks ────────────────────────────────────────────────────────────────────────────────────────────────────────

// The block patterns run on whole lines of text people and agents send, on the server's thread: none may leave two
// quantifiers free to split the same run of characters when a line then fails, which costs the square (or the cube)
// of the line's length (ADR 0200). So a fence's "no backtick after it" is a lookahead, a heading's closing `#`s and a
// table rule's outer spaces are taken off by hand (`atxOf`, `isTableRule`), and an item's text is anything to the end.
const FENCE = /^( {0,3})(`{3,}|~{3,})(?=[^`]*$)[ \t]*([^`\s]*)/;
const ATX_HEAD = /^ {0,3}(#{1,6})(?![^ \t])/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^([ \t]*)([-*+•]|\d{1,9}[.)])(?:[ \t]+([\s\S]*))?$/;
const SETEXT_1 = /^ {0,3}=+[ \t]*$/;
const SETEXT_2 = /^ {0,3}-+[ \t]*$/;
/** A table's rule line without the spaces around it (`isTableRule`). */
const TABLE_RULE = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/;
const IMAGE_LINE = /^ {0,3}!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)[ \t]*$/;

export interface MarkdownToBlocksOptions {
  /**
   * A picture's address (`![alt](address)` on a line of its own) as one of the file's pictures: its asset id, or null
   * to keep it as text. By default `asset:<id>` names a picture of the file.
   */
  images?: (address: string) => string | null;
}

const defaultImages = (address: string) => /^asset:([0-9a-z_-]{1,64})$/i.exec(address)?.[1] ?? null;

const isBlank = (ch: string | undefined) => ch === " " || ch === "\t";

/** A line without the spaces and tabs around it. */
function trimTabs(line: string): string {
  let start = 0;
  let end = line.length;
  while (start < end && isBlank(line[start])) start++;
  while (end > start && isBlank(line[end - 1])) end--;
  return line.slice(start, end);
}

/** How many times `ch` ends `text`, counted from its end (an end-anchored pattern rescans every run). */
function endRun(text: string, ch: string): number {
  let n = 0;
  while (n < text.length && text[text.length - 1 - n] === ch) n++;
  return n;
}

/**
 * An ATX heading (`## Title ##`): its level and words, or null. What a single pattern said before, read by hand: the
 * spaces after the `#`s and at the end, and a closing run of `#` after a space or a tab, are left out; a line holding
 * a line or paragraph separator is no heading.
 */
function atxOf(line: string): { level: number; text: string } | null {
  const head = ATX_HEAD.exec(line);
  if (!head) return null;
  let start = head[0].length;
  let end = line.length;
  while (end > start && isBlank(line[end - 1])) end--;
  while (start < end && isBlank(line[start])) start++;
  if (/[\u2028\u2029]/.test(line)) return null;
  let hashes = end;
  while (hashes > start && line[hashes - 1] === "#") hashes--;
  if (hashes < end && hashes > start && isBlank(line[hashes - 1])) {
    end = hashes;
    while (end > start && isBlank(line[end - 1])) end--;
  }
  return { level: (head[1] ?? "#").length, text: line.slice(start, end) };
}

/** Whether a line is a table's rule (`| --- | :-: |`). */
const isTableRule = (line: string) => TABLE_RULE.test(trimTabs(line));

/** Leading spaces, a tab counting as four. */
function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4 - (n % 4);
    else break;
  }
  return n;
}

/** Cells of a table line, split on pipes that aren't escaped or inside code. */
function tableCells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let inCode = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch === "\\" && text[i + 1] === "|") {
      cell += "|";
      i++;
      continue;
    }
    if (ch === "`") {
      const ticks = tickRun(text, i);
      inCode = inCode === ticks ? 0 : inCode === 0 ? ticks : inCode;
      cell += "`".repeat(ticks);
      i += ticks - 1;
      continue;
    }
    if (ch === "|" && inCode === 0) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

const cellOf = (text: string): DocCell => ({ blocks: [{ type: "paragraph", runs: parseInlineMarkdown(text) }] });

/** Lines of a paragraph as its text: a line ending in two spaces or a backslash breaks; others join with a space. */
function joinLines(lines: readonly string[]): string {
  let out = "";
  lines.forEach((raw, i) => {
    const line = i === 0 ? raw.replace(/^[ \t]+/, "") : raw.trimStart();
    if (i === lines.length - 1) {
      out += line.trimEnd();
      return;
    }
    const slashes = endRun(line, "\\");
    if (endRun(line, " ") >= 2) out += `${line.trimEnd()}\n`;
    else if (slashes % 2 === 1) out += `${line.slice(0, -1)}\n`;
    else out += `${line.trimEnd()} `;
  });
  return out;
}

/** Whether a line starts a block other than a paragraph (so a paragraph ends before it). */
function startsBlock(line: string, nextLine: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    atxOf(line) !== null ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    ITEM.test(line) ||
    (line.includes("|") && nextLine !== undefined && isTableRule(nextLine) && nextLine.includes("-"))
  );
}

/**
 * Markdown into blocks (canonical form, without ids: the writer gives them). Lists are paragraphs with `list` and a
 * `level` from their indent; a picture on its own line is an image block when `images` names it.
 */
export function markdownToBlocks(markdown: string, opts: MarkdownToBlocksOptions = {}): DocBlock[] {
  const images = opts.images ?? defaultImages;
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  // A table row shorter than its header is filled with empty cells, so a few bytes of `|` lines could ask for
  // millions of cells: the tables of one text hold about as many cells as it has characters, and a table no more
  // than a document holds (`LIVE_LIMITS.document`, refused here with the same words as when it is written).
  const cells = { left: markdown.length + 50_000 };
  return normalizeBlocks(parseBlocks(lines, images, 0, cells));
}

function parseBlocks(
  lines: readonly string[],
  images: (address: string) => string | null,
  depth: number,
  cells: { left: number },
): DocBlock[] {
  const out: DocBlock[] = [];
  /** The indents of the open list levels (a list item deeper than the last opens a level). */
  let listIndents: number[] = [];
  /** The last list item, which an indented line after it continues. */
  let lastItem: DocParagraph | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const indent = fence[1]?.length ?? 0;
      const mark = fence[2] ?? "```";
      const code: string[] = [];
      i++;
      while (i < lines.length) {
        const inner = lines[i] ?? "";
        const close = new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}[ \\t]*$`);
        if (close.test(inner)) {
          i++;
          break;
        }
        code.push(inner.slice(Math.min(indent, indentOf(inner))));
        i++;
      }
      out.push({ type: "code_block", text: code.join("\n"), ...(fence[3] ? { language: fence[3] } : {}) });
      listIndents = [];
      lastItem = null;
      continue;
    }
    const atx = atxOf(line);
    if (atx) {
      const level = Math.min(DOC_MAX_HEADING, atx.level) as DocHeadingLevel;
      out.push({ type: "heading", level, runs: parseInlineMarkdown(atx.text) });
      listIndents = [];
      lastItem = null;
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ type: "horizontal_rule" });
      listIndents = [];
      lastItem = null;
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? "")) {
        inner.push((lines[i] ?? "").replace(QUOTE, ""));
        i++;
      }
      const blocks = depth >= 8 ? [] : parseBlocks(inner, images, depth + 1, cells);
      out.push({ type: "blockquote", blocks });
      listIndents = [];
      lastItem = null;
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const indent = indentOf(item[1] ?? "");
      while (listIndents.length > 0 && indent < (listIndents[listIndents.length - 1] as number)) listIndents.pop();
      const top = listIndents[listIndents.length - 1];
      if (top === undefined || indent > top) listIndents.push(indent);
      const level = Math.min(RICH_MAX_LEVEL, listIndents.length - 1);
      const marker = item[2] ?? "-";
      const textLines = [item[3] ?? ""];
      i++;
      // Lazy and indented continuation lines belong to the item.
      while (i < lines.length) {
        const more = lines[i] ?? "";
        if (!more.trim() || startsBlock(more, lines[i + 1])) break;
        textLines.push(more);
        i++;
      }
      const paragraph: DocParagraph = {
        type: "paragraph",
        list: /\d/.test(marker) ? "ordered" : "bullet",
        runs: parseInlineMarkdown(joinLines(textLines)),
      };
      if (level) paragraph.level = level;
      out.push(paragraph);
      lastItem = paragraph;
      continue;
    }
    const next = lines[i + 1];
    if (line.includes("|") && next !== undefined && isTableRule(next) && next.includes("-")) {
      const limits = LIVE_LIMITS.document;
      const header = tableCells(line);
      if (header.length > limits.tableCols) {
        throw new LiveEditError("too_many", `A table holds at most ${limits.tableCols} columns`);
      }
      const rows: DocCell[][] = [header.map(cellOf)];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) {
        if (rows.length >= limits.tableRows) {
          throw new LiveEditError("too_many", `A table holds at most ${limits.tableRows} rows`);
        }
        cells.left -= header.length;
        if (cells.left < 0) throw new LiveEditError("too_large", "The tables hold more cells than the text could");
        rows.push(tableCells(lines[i] ?? "").map(cellOf));
        i++;
      }
      // Every row as wide as the header, as GitHub draws it.
      for (const row of rows) {
        row.length = Math.min(row.length, header.length);
        while (row.length < header.length) row.push(cellOf(""));
      }
      out.push({ type: "table", header: true, rows });
      listIndents = [];
      lastItem = null;
      continue;
    }
    const picture = IMAGE_LINE.exec(line);
    const asset = picture?.[2] ? images(picture[2]) : null;
    if (picture && asset) {
      out.push({ type: "image", asset, ...(picture[1] ? { alt: picture[1] } : {}) });
      listIndents = [];
      lastItem = null;
      i++;
      continue;
    }
    // A paragraph: lines up to a blank one or another block; "===" or "---" under it makes it a heading.
    const textLines = [line];
    i++;
    let heading: DocHeadingLevel | 0 = 0;
    while (i < lines.length) {
      const more = lines[i] ?? "";
      if (!more.trim()) break;
      if (SETEXT_1.test(more)) {
        heading = 1;
        i++;
        break;
      }
      if (SETEXT_2.test(more)) {
        heading = 2;
        i++;
        break;
      }
      if (startsBlock(more, lines[i + 1])) break;
      textLines.push(more);
      i++;
    }
    const text = joinLines(textLines);
    if (heading) {
      out.push({ type: "heading", level: heading, runs: parseInlineMarkdown(text.replace(/\n/g, " ")) });
    } else if (indentOf(line) >= 2) {
      // An indented paragraph: one level per two spaces (the text of a list item after a blank line stays in the
      // list, a level in).
      const level = Math.min(RICH_MAX_LEVEL, Math.floor(indentOf(line) / 2));
      out.push({ type: "paragraph", level, runs: parseInlineMarkdown(text) });
      if (lastItem) continue;
    } else {
      out.push({ type: "paragraph", runs: parseInlineMarkdown(text) });
    }
    listIndents = [];
    lastItem = null;
  }
  return out;
}

// ── Writing ───────────────────────────────────────────────────────────────────────────────────────────────────────

function escapeText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch === "\\" || ch === "*" || ch === "~" || ch === "[" || ch === "]" || ch === "`" || ch === "<") {
      out += `\\${ch}`;
    } else if (ch === "_" && (isWordEdge(text[i - 1]) || isWordEdge(text[i + 1]))) out += "\\_";
    else out += ch;
  }
  return out;
}

/** A code span around `text`, with a fence longer than any run of backticks inside it. */
function codeSpan(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const ticks = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

function runMarkdown(run: DocRun, breakAs: string): string {
  return run.text
    .split("\n")
    .map((part) => (part ? partMarkdown(part, run) : ""))
    .join(breakAs);
}

/** An address as Markdown writes it: spaces encoded, and parentheses too when they don't pair up. */
function hrefMarkdown(href: string): string {
  const out = href.replace(/\s/g, encodeURIComponent);
  return closingParen(`${out})`, 0) === out.length ? out : out.replace(/[()]/g, encodeURIComponent);
}

function partMarkdown(text: string, run: DocRun): string {
  if (!text.trim()) return text;
  // Marks go around the words, never around the spaces next to them (Markdown wouldn't read them).
  const lead = /^\s*/.exec(text)?.[0] ?? "";
  // `trimEnd` drops what `\s` matches; an end-anchored `\s*$` would rescan every run of spaces (quadratic).
  const trail = text.slice(text.trimEnd().length);
  const words = text.slice(lead.length, text.length - trail.length);
  let core = run.code ? codeSpan(words) : escapeText(words);
  if (run.strike) core = `~~${core}~~`;
  if (run.italic) core = `*${core}*`;
  if (run.bold) core = `**${core}**`;
  if (run.underline) core = `<u>${core}</u>`;
  if (run.link) core = `[${core}](${hrefMarkdown(run.link)})`;
  return `${lead}${core}${trail}`;
}

/** A line's first characters escaped where Markdown would read them as a block. */
function safeStart(line: string): string {
  if (/^(?:#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|={2,}\s*$|\||~~~|!\[)/.test(line)) return `\\${line}`;
  if (RULE.test(line)) return `\\${line}`;
  return line.replace(/^(\d{1,9})([.)])(\s|$)/, "$1\\$2$3");
}

/** Runs as inline Markdown; a line break is `breakAs` ("\\\n" in a paragraph, "<br>" in a cell or a heading). */
export function runsToMarkdown(runs: readonly DocRun[], breakAs = "\\\n"): string {
  const text = runs.map((run) => runMarkdown(run, breakAs)).join("");
  return breakAs.endsWith("\n")
    ? text
        .split("\n")
        .map((line, i) => (i === 0 || line ? safeStart(line) : line))
        .join("\n")
    : safeStart(text);
}

/**
 * A cell's Markdown, its pipes escaped so they don't split the row. Its backslashes stay as they are: they are already
 * Markdown's escapes (`escapeText`), and a table reads `\|` as a pipe before anything else (`tableCells`), so escaping
 * them again would show them doubled.
 */
const cellMarkdown = (cell: DocCell) =>
  cell.blocks
    .map((p) => runsToMarkdown(p.runs, "<br>"))
    .join("<br>")
    .split("|")
    .join("\\|");

/** One block as Markdown (a list item with its marker; `counter` numbers an ordered one). */
function blockMarkdown(block: DocBlock, counter: number): string {
  switch (block.type) {
    case "paragraph": {
      const level = block.level ?? 0;
      const indent = "  ".repeat(level);
      if (block.list) {
        const marker = block.list === "ordered" ? `${counter}. ` : "- ";
        const pad = " ".repeat(indent.length + marker.length);
        return `${indent}${marker}${runsToMarkdown(block.runs).replace(/\n/g, `\n${pad}`)}`;
      }
      const text = runsToMarkdown(block.runs);
      return level ? text.replace(/^/gm, indent) : text;
    }
    case "heading":
      return `${"#".repeat(block.level)} ${runsToMarkdown(block.runs, "<br>")}`;
    case "blockquote":
      return blocksMarkdown(block.blocks)
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    case "code_block": {
      let longest = 2;
      for (const run of block.text.match(/^`{3,}/gm) ?? []) longest = Math.max(longest, run.length);
      const fence = "`".repeat(longest + 1);
      return `${fence}${block.language ?? ""}\n${block.text}\n${fence}`;
    }
    case "horizontal_rule":
      return "---";
    case "image":
      return `![${escapeText(block.alt ?? "")}](asset:${block.asset})`;
    case "table": {
      const width = Math.max(1, ...block.rows.map((row) => row.length));
      const line = (row: readonly DocCell[]) =>
        `| ${Array.from({ length: width }, (_, k) => (row[k] ? cellMarkdown(row[k]) : "")).join(" | ")} |`;
      const rows = block.rows.map(line);
      rows.splice(1, 0, `|${" --- |".repeat(width)}`);
      return rows.join("\n");
    }
  }
}

/** Ordered items numbered per level, restarting after anything that isn't an item one level up or deeper. */
function listCounter() {
  const counters: number[] = [];
  return (block: DocBlock): number => {
    if (block.type !== "paragraph" || !block.list) {
      counters.length = 0;
      return 0;
    }
    const level = block.level ?? 0;
    counters.length = Math.min(counters.length, level + 1);
    if (block.list === "ordered") counters[level] = (counters[level] ?? 0) + 1;
    else counters[level] = 0;
    return counters[level] ?? 0;
  };
}

const isItem = (block: DocBlock | undefined) => block?.type === "paragraph" && block.list !== undefined;

/**
 * Blocks as Markdown: blank lines between blocks, list items on consecutive lines. With `ids`, each top-level block's
 * first line starts with `[#id] ` (how agents read a document to change it by block).
 */
export function blocksMarkdown(blocks: readonly DocBlock[], opts: { ids?: boolean } = {}): string {
  const count = listCounter();
  const parts: string[] = [];
  blocks.forEach((block, i) => {
    let text = blockMarkdown(block, count(block));
    if (opts.ids && block.id) text = `[#${block.id}] ${text}`;
    const joiner = i === 0 ? "" : isItem(block) && isItem(blocks[i - 1]) ? "\n" : "\n\n";
    parts.push(joiner + text);
  });
  return parts.join("");
}

/** A document's blocks as Markdown (what `.md` downloads and agents read). */
export function documentToMarkdown(blocks: readonly DocBlock[], opts: { ids?: boolean } = {}): string {
  const text = blocksMarkdown(blocks, opts);
  return text ? `${text}\n` : "";
}
