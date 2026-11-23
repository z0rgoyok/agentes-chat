import {
  type DocBlock,
  type DocCell,
  type DocHeadingLevel,
  type DocParagraph,
  type DocRun,
  LIVE_LIMITS,
  normalizeBlocks,
} from "@agenteschat/live";
import { type DocxBlock, type DocxCell, type DocxInline, type DocxParagraph, readDocx } from "./docx-html";
import { OFFICE_LIMITS, officeTooLargeToEdit } from "./limits";

/**
 * A Word document as a live document's blocks (ADR 0200, "Edit as document" of ADR 0198): the same safe reading as
 * its HTML (`readDocx`: headings, paragraphs, runs bold, italic, underlined or struck, links, line breaks, lists,
 * tables with merged cells laid flat, pictures), into `DocBlock`s, its pictures as files the document then keeps.
 */

/** A picture the document starts with: the id its image block names, and its bytes. */
export interface DocxDocumentPicture {
  id: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface DocxDocument {
  blocks: DocBlock[];
  pictures: DocxDocumentPicture[];
}

const MAX_LEVEL = 4;

function runsOf(inlines: readonly DocxInline[]): DocRun[] {
  const runs: DocRun[] = [];
  for (const item of inlines) {
    if (item.kind === "br") runs.push({ text: "\n" });
    else if (item.kind === "text") {
      const run: DocRun = { text: item.text };
      if (item.b) run.bold = true;
      if (item.i) run.italic = true;
      if (item.u) run.underline = true;
      if (item.s) run.strike = true;
      if (item.href) run.link = item.href;
      runs.push(run);
    }
  }
  return runs;
}

const hasWords = (runs: readonly DocRun[]) => runs.some((r) => r.text.trim() !== "");

/** A paragraph's own attributes: a heading's level (1..3), a list item's kind and depth. */
function shapeOf(p: DocxParagraph, runs: DocRun[]): DocBlock {
  if (p.heading > 0) return { type: "heading", level: Math.min(3, p.heading) as DocHeadingLevel, runs };
  const out: DocParagraph = { type: "paragraph", runs };
  if (p.list) {
    out.list = p.list.ordered ? "ordered" : "bullet";
    if (p.list.level > 0) out.level = Math.min(MAX_LEVEL, p.list.level);
  }
  return out;
}

/** A cell's paragraphs: its own, and the words of anything else inside it (a table in a table, a picture's words). */
function cellParagraphs(blocks: readonly DocxBlock[]): DocParagraph[] {
  const out: DocParagraph[] = [];
  for (const block of blocks) {
    if (block.kind === "p") {
      const runs = runsOf(block.inlines);
      const alt = block.inlines.flatMap((i) => (i.kind === "img" && i.alt ? [{ text: i.alt }] : []));
      const all = hasWords(runs) ? runs : alt;
      if (hasWords(all))
        out.push({ type: "paragraph", runs: block.heading ? all.map((r) => ({ ...r, bold: true })) : all });
    } else {
      for (const row of block.rows) for (const cell of row) out.push(...cellParagraphs(cell.blocks));
    }
  }
  return out;
}

const emptyCell = (): DocCell => ({ blocks: [{ type: "paragraph", runs: [] }] });

/**
 * A table laid flat: a merged cell keeps its place, the columns and rows it spans stay empty under their header. Every
 * row is filled out to the widest, so a few bytes of short rows under one wide row would ask for millions of empty
 * cells: a table past what a document holds (`LIVE_LIMITS.document`, which would refuse it anyway) or the tables past
 * the Office files' cells (`OFFICE_LIMITS.cells`, `budget` counting down across the document) are refused first.
 */
function tableOf(rows: readonly DocxCell[][], budget: { cells: number }): DocBlock | null {
  const limits = LIVE_LIMITS.document;
  if (rows.length > limits.tableRows) throw officeTooLargeToEdit(`A table holds at most ${limits.tableRows} rows`);
  const width = Math.max(1, ...rows.map((r) => r.reduce((n, c) => n + c.colspan, 0)));
  if (width > limits.tableCols) throw officeTooLargeToEdit(`A table holds at most ${limits.tableCols} columns`);
  budget.cells -= width * rows.length;
  if (budget.cells < 0) throw officeTooLargeToEdit("cells");
  const below: number[] = [];
  const out: DocCell[][] = rows.map((row) => {
    const cells: DocCell[] = [];
    const skip = () => {
      while ((below[cells.length] ?? 0) > 0) {
        below[cells.length] = (below[cells.length] as number) - 1;
        cells.push(emptyCell());
      }
    };
    for (const cell of row) {
      skip();
      const at = cells.length;
      const blocks = cellParagraphs(cell.blocks);
      cells.push({ blocks: blocks.length ? blocks : [{ type: "paragraph", runs: [] }] });
      for (let k = 1; k < cell.colspan; k++) cells.push(emptyCell());
      if (cell.rowspan > 1) for (let k = 0; k < cell.colspan; k++) below[at + k] = cell.rowspan - 1;
    }
    skip();
    while (cells.length < width) cells.push(emptyCell());
    return cells.slice(0, width);
  });
  if (out.length === 0) return null;
  const header = rows[0]?.length ? rows[0].every((cell) => cell.header) : false;
  return { type: "table", ...(header ? { header: true as const } : {}), rows: out };
}

/**
 * A Word document as blocks and pictures. `pictureId` names each picture (a new asset id); a picture the document
 * can't keep (past `maxEachBytes`, or past `maxPictureBytes` in all) stays as its description.
 */
export function docxToDocument(
  bytes: Uint8Array,
  opts: { pictureId: () => string; maxPictureBytes: number; maxEachBytes: number },
): DocxDocument {
  const blocks: DocBlock[] = [];
  const pictures: DocxDocumentPicture[] = [];
  let kept = 0;
  const budget = { cells: OFFICE_LIMITS.cells };
  const visit = (block: DocxBlock) => {
    if (block.kind === "table") {
      const table = tableOf(block.rows, budget);
      if (table) blocks.push(table);
      return;
    }
    // A picture is a block of its own: the paragraph's words before it, the picture, the words after.
    let part: DocxInline[] = [];
    const flush = () => {
      const runs = runsOf(part);
      if (hasWords(runs)) blocks.push(shapeOf(block, runs));
      part = [];
    };
    for (const item of block.inlines) {
      if (item.kind !== "img") {
        part.push(item);
        continue;
      }
      flush();
      if (item.bytes.byteLength > opts.maxEachBytes || kept + item.bytes.byteLength > opts.maxPictureBytes) {
        if (item.alt) blocks.push({ type: "paragraph", runs: [{ text: item.alt }] });
        continue;
      }
      kept += item.bytes.byteLength;
      const id = opts.pictureId();
      pictures.push({ id, bytes: item.bytes, contentType: item.type });
      blocks.push({ type: "image", asset: id, ...(item.alt ? { alt: item.alt } : {}) });
    }
    flush();
  };
  for (const block of readDocx(bytes, true)) visit(block);
  return { blocks: normalizeBlocks(blocks), pictures };
}
