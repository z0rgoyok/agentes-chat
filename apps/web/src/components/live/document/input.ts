import { type DocBlock, type DocParagraph, type DocRun, markdownToBlocks } from "@agenteschat/live/document";
import type { RichList } from "@agenteschat/live/rich";
import { InputRule, inputRules, wrappingInputRule } from "prosemirror-inputrules";
import { Fragment, type Mark, type MarkType, type Node as PMNode, type ResolvedPos, Slice } from "prosemirror-model";
import type { Plugin, Transaction } from "prosemirror-state";
import { docSchema, M, N, widthFraction } from "./schema";

/**
 * What typing and pasting turn into in a document (ADR 0200): the Markdown people already type ("# " a heading, "- " a
 * list, "> " a quote, "```" code, "---" a rule, **bold**, *italic*, `code`, ~~strike~~), and Markdown pasted as
 * plain text read as the document's blocks (the same reader agents write through).
 */

// ── Typed shortcuts ────────────────────────────────────────────────────────────────────────────────────────────────

/** A paragraph at its very start (where the typed shortcuts of blocks apply). */
function atParagraphStart($start: ResolvedPos): boolean {
  return $start.parent.type === N.paragraph && $start.parentOffset === 0;
}

/** "# ", "## ", "### ": a heading of that level (keeping the block's id). */
const headingRule = new InputRule(/^(#{1,3})\s$/, (state, match, start, end): Transaction | null => {
  const $start = state.doc.resolve(start);
  if (!atParagraphStart($start)) return null;
  const index = $start.index(-1);
  if (!$start.node(-1).canReplaceWith(index, index + 1, N.heading)) return null;
  const level = (match[1] ?? "#").length;
  const tr = state.tr.delete(start, end);
  return tr.setBlockType(start, start, N.heading, (old) => ({
    id: old.attrs.id ?? null,
    align: old.attrs.align ?? null,
    level,
  }));
});

/** "- ", "* " or "1. " at the start of a paragraph: a list. */
function listRule(pattern: RegExp, kind: RichList): InputRule {
  return new InputRule(pattern, (state, _match, start, end): Transaction | null => {
    const $start = state.doc.resolve(start);
    if (!atParagraphStart($start) || $start.parent.attrs.list === kind) return null;
    return state.tr
      .delete(start, end)
      .setNodeMarkup($start.before(), undefined, { ...$start.parent.attrs, list: kind });
  });
}

/** "```" then a space (or a language and a space): a code block. */
const codeRule = new InputRule(/^```([a-z0-9_+#.-]{0,40})\s$/i, (state, match, start, end): Transaction | null => {
  const $start = state.doc.resolve(start);
  if (!atParagraphStart($start)) return null;
  const index = $start.index(-1);
  if (!$start.node(-1).canReplaceWith(index, index + 1, N.code_block)) return null;
  const tr = state.tr.delete(start, end);
  return tr.setBlockType(start, start, N.code_block, (old) => ({
    id: old.attrs.id ?? null,
    language: match[1] || null,
  }));
});

/** "---" on a line of its own: a rule across the page, and a new paragraph under it. */
const ruleRule = new InputRule(/^(?:---|___|\*\*\*)$/, (state, _match, start, end): Transaction | null => {
  const $start = state.doc.resolve(start);
  if (!atParagraphStart($start) || $start.depth !== 1 || end !== $start.end()) return null;
  const from = $start.before();
  const to = $start.after();
  return state.tr.replaceWith(from, to, [N.horizontal_rule.create(), N.paragraph.create()]);
});

/** `**words**` and the like: the words with the mark, the signs gone. */
function markRule(pattern: RegExp, type: MarkType): InputRule {
  return new InputRule(pattern, (state, match, start, end): Transaction | null => {
    const full = match[1];
    const inner = match[2];
    if (!full || !inner) return null;
    const $start = state.doc.resolve(start);
    if (!$start.parent.type.allowsMarkType(type)) return null;
    const fullStart = start + match[0].lastIndexOf(full);
    const innerStart = fullStart + full.indexOf(inner);
    const innerEnd = innerStart + inner.length;
    const tr = state.tr;
    // The closing signs typed so far (the last one isn't in the document yet), then the opening ones.
    if (end > innerEnd) tr.delete(innerEnd, end);
    tr.delete(fullStart, innerStart);
    tr.addMark(fullStart, fullStart + inner.length, type.create());
    tr.removeStoredMark(type);
    return tr;
  });
}

export function docInputRules(): Plugin {
  return inputRules({
    rules: [
      headingRule,
      listRule(/^\s*[-*•]\s$/, "bullet"),
      listRule(/^\s*1[.)]\s$/, "ordered"),
      wrappingInputRule(/^\s*>\s$/, N.blockquote),
      codeRule,
      ruleRule,
      markRule(/(?:^|[\s(])(\*\*([^*\s](?:[^*]*[^*\s])?)\*\*)$/, M.bold),
      markRule(/(?:^|[\s(])(~~([^~\s](?:[^~]*[^~\s])?)~~)$/, M.strike),
      markRule(/(?:^|[\s(])(\*([^*\s](?:[^*]*[^*\s])?)\*)$/, M.italic),
      markRule(/(?:^|[\s(])(`([^`\s](?:[^`]*[^`\s])?)`)$/, M.code),
    ],
  });
}

// ── Blocks into the editor ─────────────────────────────────────────────────────────────────────────────────────────

function marksOf(run: DocRun): Mark[] {
  const marks: Mark[] = [];
  if (run.bold) marks.push(M.bold.create());
  if (run.italic) marks.push(M.italic.create());
  if (run.underline) marks.push(M.underline.create());
  if (run.strike) marks.push(M.strike.create());
  if (run.code) marks.push(M.code.create());
  if (run.color) marks.push(M.color.create({ color: run.color }));
  if (run.link) marks.push(M.link.create({ href: run.link }));
  return marks;
}

/** A paragraph's or a heading's runs as inline nodes (a "\n" is a line break). */
function inline(runs: readonly DocRun[]): PMNode[] {
  const out: PMNode[] = [];
  for (const run of runs) {
    run.text.split("\n").forEach((part, i) => {
      if (i > 0) out.push(N.hard_break.create());
      if (part) out.push(docSchema.text(part, marksOf(run)));
    });
  }
  return out;
}

function paragraphNode(p: DocParagraph): PMNode {
  return N.paragraph.create({ align: p.align ?? null, level: p.level ?? 0, list: p.list ?? null }, inline(p.runs));
}

/** A block as the editor's node, without its id (a pasted block is a new block: `blockIds` names it). */
export function blockNode(block: DocBlock): PMNode | null {
  try {
    switch (block.type) {
      case "paragraph":
        return paragraphNode(block);
      case "heading":
        return N.heading.create({ level: block.level, align: block.align ?? null }, inline(block.runs));
      case "blockquote": {
        const inner = block.blocks.map(blockNode).filter((n): n is PMNode => n !== null);
        return N.blockquote.createChecked(null, inner.length ? inner : [N.paragraph.create()]);
      }
      case "code_block":
        return N.code_block.create(
          { language: block.language ?? null },
          block.text ? docSchema.text(block.text) : null,
        );
      case "horizontal_rule":
        return N.horizontal_rule.create();
      case "image":
        return N.image.create({ asset: block.asset, alt: block.alt ?? null, width: widthFraction(block.width) });
      case "table": {
        const cols = Math.max(1, ...block.rows.map((r) => r.length));
        const rows = block.rows.map((row) =>
          N.table_row.create(
            null,
            Array.from({ length: cols }, (_, c) => {
              const paragraphs = (row[c]?.blocks ?? []).map(paragraphNode);
              return N.table_cell.create(null, paragraphs.length ? paragraphs : [N.paragraph.create()]);
            }),
          ),
        );
        if (!rows.length) return null;
        return N.table.createChecked({ header: block.header ? true : null }, rows);
      }
    }
  } catch {
    // A block the schema refuses: left out.
    return null;
  }
}

/**
 * Text pasted without HTML (from a plain editor, a terminal, an agent's message copied as text): its Markdown as the
 * document's blocks; plain lines go in where the caret is, as words. In code, the words as they are.
 */
export function pastedText(text: string, $context: ResolvedPos, plain: boolean): Slice {
  if ($context.parent.type.spec.code) {
    return new Slice(Fragment.from(docSchema.text(text.replace(/\r\n?/g, "\n"))), 0, 0);
  }
  const blocks: DocBlock[] = plain
    ? text
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line): DocBlock => ({ type: "paragraph", runs: line ? [{ text: line }] : [] }))
    : markdownToBlocks(text, { images: () => null });
  const nodes = blocks.map(blockNode).filter((n): n is PMNode => n !== null);
  if (!nodes.length) return Slice.empty;
  // Plain lines join the words around the caret; headings, lists, quotes and tables come in as blocks of their own.
  const plainLines = nodes.every((n) => n.type === N.paragraph && !n.attrs.list && !n.attrs.level);
  return plainLines ? Slice.maxOpen(Fragment.from(nodes), false) : new Slice(Fragment.from(nodes), 0, 0);
}
