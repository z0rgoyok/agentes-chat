import type { LiveSelection } from "@agenteschat/client";
import { blockText, type DocBlock, type DocParagraph, runsText } from "@agenteschat/live/document";

/**
 * A document on the phone (ADR 0200), the pure part: which blocks the phone edits, a block's style changed (text,
 * headings, quote, code) and its list toggled, the numbers of a numbered list, and what "Ask Atlas" quotes. The words
 * themselves are edited character by character (`text.ts`). The screen draws it; the tests read it.
 */

/** A block's style, as the format bar's first button names it. */
export type BlockStyle = "paragraph" | "h1" | "h2" | "h3" | "quote" | "code";

export const BLOCK_STYLES: readonly BlockStyle[] = ["paragraph", "h1", "h2", "h3", "quote", "code"];

/** The paragraph a quote holds when it is one paragraph (the phone edits that); null otherwise. */
const quoted = (block: DocBlock): DocParagraph | null =>
  block.type === "blockquote" && block.blocks.length === 1 && block.blocks[0]?.type === "paragraph"
    ? block.blocks[0]
    : null;

/** Whether the phone edits this block's words (a picture, a table, a line and a quote of many parts: on a computer). */
export function editable(block: DocBlock): boolean {
  if (block.type === "paragraph" || block.type === "heading" || block.type === "code_block") return true;
  return quoted(block) !== null;
}

/** The block's style now; a picture, a table or a line has none. */
export function blockStyle(block: DocBlock): BlockStyle | null {
  switch (block.type) {
    case "paragraph":
      return "paragraph";
    case "heading":
      return block.level === 1 ? "h1" : block.level === 2 ? "h2" : "h3";
    case "blockquote":
      return "quote";
    case "code_block":
      return "code";
    default:
      return null;
  }
}

/** The block's words as runs, whatever its style (a code block's lines as plain words). */
function runsOf(block: DocBlock) {
  if (block.type === "paragraph" || block.type === "heading") return block.runs;
  if (block.type === "code_block") return block.text ? [{ text: block.text }] : [];
  const p = quoted(block);
  return p ? p.runs : [{ text: blockText(block) }];
}

/** The block in another style, its words and its id kept (code keeps the words alone). */
export function restyled(block: DocBlock, style: BlockStyle): DocBlock {
  const id = block.id ? { id: block.id } : {};
  const runs = runsOf(block);
  switch (style) {
    case "paragraph":
      return { type: "paragraph", ...id, runs };
    case "h1":
    case "h2":
    case "h3":
      return { type: "heading", ...id, level: style === "h1" ? 1 : style === "h2" ? 2 : 3, runs };
    case "quote":
      return { type: "blockquote", ...id, blocks: [{ type: "paragraph", runs }] };
    case "code":
      return { type: "code_block", ...id, text: runsText(runs) };
  }
}

/** A list item of `list` (the same again: a paragraph again); any other style becomes a paragraph first. */
export function toggledList(block: DocBlock, list: "bullet" | "ordered"): DocBlock {
  const p = block.type === "paragraph" ? block : (restyled(block, "paragraph") as DocParagraph);
  if (p.list === list) {
    const { list: _list, level: _level, ...rest } = p;
    return rest;
  }
  return { ...p, list };
}

/** The quote toggled: a quote becomes its paragraph again, anything else a quote. */
export const toggledQuote = (block: DocBlock): DocBlock =>
  restyled(block, block.type === "blockquote" ? "paragraph" : "quote");

/** The number each item of a numbered list shows: counted along consecutive items of its level. */
export function listNumbers(blocks: readonly DocBlock[]): Map<string, number> {
  const out = new Map<string, number>();
  const counts: number[] = [];
  for (const block of blocks) {
    if (block.type !== "paragraph" || !block.list) {
      counts.length = 0;
      continue;
    }
    const level = Math.max(0, Math.min(4, block.level ?? 0));
    counts.length = level + 1;
    if (block.list === "ordered") {
      const n = (counts[level] ?? 0) + 1;
      counts[level] = n;
      if (block.id) out.set(block.id, n);
    } else counts[level] = 0;
  }
  return out;
}

/** The most words a quote carries to the conversation (ADR 0199 §3), and the most its label shows. */
const QUOTE_MAX = 200;
const LABEL_MAX = 60;

/**
 * What "Ask Atlas" sends about a block: its id, the words chosen (or the block's) as the quote, and a short label
 * of them ("“Summer came early…”").
 */
export function askSelection(block: DocBlock, chosen?: string): LiveSelection | null {
  if (!block.id) return null;
  const words = (chosen?.trim() || blockText(block)).replace(/\s+/g, " ").trim();
  const label = words
    ? `“${words.length > LABEL_MAX ? `${words.slice(0, LABEL_MAX - 1).trimEnd()}…` : words}”`
    : blockText(block).slice(0, LABEL_MAX) || "¶";
  return { label, block: block.id, ...(words ? { text: words.slice(0, QUOTE_MAX) } : {}) };
}
