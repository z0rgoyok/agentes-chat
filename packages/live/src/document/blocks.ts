import { newId } from "../ids";
import { LIVE_LIMITS } from "../limits";
import { RICH_MAX_LEVEL } from "../rich/schema";
import { isRichColor, isRichHref, sameTypeMarks, typeMarksOf } from "../rich/text";
import { DOC_MAX_HEADING } from "./schema";
import type {
  DocBlock,
  DocCell,
  DocCode,
  DocHeading,
  DocHeadingLevel,
  DocImage,
  DocParagraph,
  DocQuote,
  DocRun,
  DocTable,
} from "./types";

/**
 * Documents as plain data (ADR 0200): their canonical form (what every reader returns and every writer stores), ids,
 * plain text and sizes.
 */

type Marks = Omit<DocRun, "text">;

/** A block id as the apps make them (`newId`), or one an older document carries: short letters and digits. */
const BLOCK_ID = /^[0-9a-z_-]{1,40}$/i;
/** A picture's id: a `live_assets` id (a UUID) or anything of its shape. */
const ASSET_ID = /^[0-9a-z_-]{1,64}$/i;
const LANGUAGE = /^[a-z0-9_+#.-]{1,40}$/i;

export const DOC_ALT_CHARS = 500;
export const DOC_MIN_WIDTH = 0.1;

export function isBlockId(value: unknown): value is string {
  return typeof value === "string" && BLOCK_ID.test(value);
}

export function isAssetId(value: unknown): value is string {
  return typeof value === "string" && ASSET_ID.test(value);
}

function marksOf(run: Partial<DocRun>): Marks {
  const marks: Marks = {};
  if (run.bold === true) marks.bold = true;
  if (run.italic === true) marks.italic = true;
  if (run.underline === true) marks.underline = true;
  if (run.strike === true) marks.strike = true;
  if (run.code === true) marks.code = true;
  if (isRichColor(run.color)) marks.color = run.color;
  if (isRichHref(run.link)) marks.link = run.link;
  return { ...marks, ...typeMarksOf(run) };
}

function sameMarks(a: Marks, b: Marks): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.code === b.code &&
    a.color === b.color &&
    a.link === b.link &&
    sameTypeMarks(a, b)
  );
}

/** A run's marks, checked (its text left out). */
export function docRunMarks(run: Partial<DocRun>): Marks {
  return marksOf(run);
}

/**
 * Runs in canonical form: marks checked, empty runs dropped, line breaks never marked (a marked run is split around
 * them: ProseMirror's hard breaks carry no marks in the stored text) and neighbors with the same marks merged.
 */
export function normalizeRuns(runs: unknown): DocRun[] {
  const out: DocRun[] = [];
  const push = (text: string, marks: Marks) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && sameMarks(marksOf(last), marks)) last.text += text;
    else out.push({ text, ...marks });
  };
  for (const run of Array.isArray(runs) ? (runs as Partial<DocRun>[]) : []) {
    if (!run || typeof run.text !== "string") continue;
    const marks = marksOf(run);
    const text = run.text.replace(/\r\n?/g, "\n");
    if (Object.keys(marks).length === 0) {
      push(text, marks);
      continue;
    }
    text.split("\n").forEach((part, i) => {
      if (i > 0) push("\n", {});
      push(part, marks);
    });
  }
  return out;
}

const alignOf = (value: unknown) => (value === "left" || value === "center" || value === "right" ? value : undefined);

function levelOf(value: unknown, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(n) && n >= 1 ? Math.min(max, Math.floor(n)) : 0;
}

function withId<T extends DocBlock>(block: T, raw: { id?: unknown }, top: boolean): T {
  if (top && isBlockId(raw.id)) block.id = raw.id;
  return block;
}

function paragraphOf(raw: Partial<DocParagraph>, top: boolean): DocParagraph {
  const out: DocParagraph = withId({ type: "paragraph", runs: [] }, raw, top);
  const align = alignOf(raw.align);
  if (align) out.align = align;
  const level = levelOf(raw.level, RICH_MAX_LEVEL);
  if (level) out.level = level;
  if (raw.list === "bullet" || raw.list === "ordered") out.list = raw.list;
  out.runs = normalizeRuns(raw.runs);
  return out;
}

function headingOf(raw: Partial<DocHeading>, top: boolean): DocHeading {
  const level = Math.max(1, levelOf(raw.level, DOC_MAX_HEADING)) as DocHeadingLevel;
  const out: DocHeading = withId({ type: "heading", level, runs: [] }, raw, top);
  const align = alignOf(raw.align);
  if (align) out.align = align;
  out.runs = normalizeRuns(raw.runs);
  return out;
}

/** The deepest a quote nests (a quote in a quote in a quote…). */
export const DOC_MAX_DEPTH = 8;

function cellOf(raw: unknown): DocCell {
  const blocks = Array.isArray((raw as Partial<DocCell> | null)?.blocks) ? (raw as DocCell).blocks : [];
  const paragraphs = blocks
    .filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "paragraph")
    .map((b) => paragraphOf(b, false));
  return { blocks: paragraphs.length ? paragraphs : [{ type: "paragraph", runs: [] }] };
}

function tableOf(raw: Partial<DocTable>, top: boolean): DocTable | null {
  const rows = (Array.isArray(raw.rows) ? raw.rows : [])
    .filter((row): row is DocCell[] => Array.isArray(row) && row.length > 0)
    .map((row) => row.map(cellOf));
  if (rows.length === 0) return null;
  // Every row as wide as the widest, so each cell stays under its column; never past the cell budget (a few
  // ragged rows can't ask for millions of empty cells on every read), where the rows stay as they are.
  const width = Math.max(...rows.map((row) => row.length));
  if (rows.length * width <= LIVE_LIMITS.document.tableCells) {
    for (const row of rows) while (row.length < width) row.push({ blocks: [{ type: "paragraph", runs: [] }] });
  }
  const out: DocTable = withId({ type: "table", rows }, raw, top);
  if (raw.header === true) out.header = true;
  return out;
}

/** A block in canonical form, or null for one that can't be (an image without a picture, a table without rows). */
export function normalizeBlock(raw: unknown, top = true, depth = 0): DocBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const block = raw as Partial<DocBlock> & { type?: unknown };
  switch (block.type) {
    case "paragraph":
      return paragraphOf(block as Partial<DocParagraph>, top);
    case "heading":
      return headingOf(block as Partial<DocHeading>, top);
    case "blockquote": {
      const inner =
        depth >= DOC_MAX_DEPTH
          ? []
          : normalizeBlocks((block as Partial<DocQuote>).blocks, { top: false, depth: depth + 1 });
      return withId(
        { type: "blockquote", blocks: inner.length ? inner : [{ type: "paragraph", runs: [] }] },
        block,
        top,
      );
    }
    case "code_block": {
      const code = block as Partial<DocCode>;
      const out: DocCode = withId(
        { type: "code_block", text: typeof code.text === "string" ? code.text.replace(/\r\n?/g, "\n") : "" },
        block,
        top,
      );
      if (typeof code.language === "string" && LANGUAGE.test(code.language)) out.language = code.language;
      return out;
    }
    case "horizontal_rule":
      return withId({ type: "horizontal_rule" }, block, top);
    case "image": {
      const image = block as Partial<DocImage>;
      if (!isAssetId(image.asset)) return null;
      const out: DocImage = withId({ type: "image", asset: image.asset }, block, top);
      if (typeof image.alt === "string" && image.alt.trim()) out.alt = image.alt.trim().slice(0, DOC_ALT_CHARS);
      if (typeof image.width === "number" && Number.isFinite(image.width) && image.width < 1) {
        out.width = Math.round(Math.max(DOC_MIN_WIDTH, image.width) * 1000) / 1000;
      }
      return out;
    }
    case "table":
      return tableOf(block as Partial<DocTable>, top);
    default:
      return null;
  }
}

/** Blocks in canonical form: each checked, the ones that can't be left out; ids only at the top level. */
export function normalizeBlocks(blocks: unknown, opts: { top?: boolean; depth?: number } = {}): DocBlock[] {
  const out: DocBlock[] = [];
  for (const raw of Array.isArray(blocks) ? blocks : []) {
    const block = normalizeBlock(raw, opts.top ?? true, opts.depth ?? 0);
    if (block) out.push(block);
  }
  return out;
}

/** The same blocks, each top-level one with an id of its own: missing or repeated ids get new ones. */
export function withBlockIds(blocks: readonly DocBlock[], taken: ReadonlySet<string> = new Set()): DocBlock[] {
  const seen = new Set(taken);
  return blocks.map((block) => {
    if (block.id && !seen.has(block.id)) {
      seen.add(block.id);
      return block;
    }
    let id = newId();
    while (seen.has(id)) id = newId();
    seen.add(id);
    return { ...block, id };
  });
}

/** A run list's text ("\n" for line breaks). */
export const runsText = (runs: readonly DocRun[]): string => runs.map((r) => r.text).join("");

/** A block's plain text: paragraphs and headings as their words, a table cell by cell, a picture by its description. */
export function blockText(block: DocBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return runsText(block.runs);
    case "blockquote":
      return block.blocks.map(blockText).join("\n");
    case "code_block":
      return block.text;
    case "horizontal_rule":
      return "";
    case "image":
      return block.alt ?? "";
    case "table":
      return block.rows
        .map((row) => row.map((cell) => cell.blocks.map((p) => runsText(p.runs)).join(" ")).join("\t"))
        .join("\n");
  }
}

/** The document's plain text, blocks joined by "\n". */
export function blocksText(blocks: readonly DocBlock[]): string {
  return blocks.map(blockText).join("\n");
}

/** How many characters of text the blocks hold (what `LIVE_LIMITS.document.chars` counts). */
export function blocksLength(blocks: readonly DocBlock[]): number {
  let n = 0;
  for (const block of blocks) n += blockText(block).length;
  return n;
}

function clipRuns(runs: readonly DocRun[], left: number): DocRun[] {
  const out: DocRun[] = [];
  for (const run of runs) {
    if (left <= 0) break;
    const text = run.text.slice(0, left);
    left -= text.length;
    out.push({ ...run, text });
  }
  return out;
}

/**
 * The first blocks, up to about `chars` characters (the last one cut), a table's first `rows` rows and a code block's
 * first lines: what a preview draws.
 */
export function clipBlocks(blocks: readonly DocBlock[], chars: number, rows = 6): DocBlock[] {
  const out: DocBlock[] = [];
  let left = chars;
  for (const block of blocks) {
    if (left <= 0 && out.length > 0) break;
    switch (block.type) {
      case "paragraph":
      case "heading":
        out.push({ ...block, runs: clipRuns(block.runs, Math.max(0, left)) });
        left -= runsText(block.runs).length + 1;
        break;
      case "blockquote": {
        const inner = clipBlocks(block.blocks, Math.max(1, left), rows);
        out.push({ ...block, blocks: inner });
        left -= blocksLength(inner) + 1;
        break;
      }
      case "code_block": {
        const text = block.text.split("\n").slice(0, rows).join("\n").slice(0, Math.max(0, left));
        out.push({ ...block, text });
        left -= text.length + 1;
        break;
      }
      case "table": {
        const kept = block.rows.slice(0, rows).map((row) =>
          row.slice(0, rows).map((cell) => ({
            blocks: cell.blocks.slice(0, 1).map((p) => ({ ...p, runs: clipRuns(p.runs, 60) })),
          })),
        );
        out.push({ ...block, rows: kept });
        left -= blockText({ ...block, rows: kept }).length + 1;
        break;
      }
      default:
        out.push(block);
        left -= 1;
    }
  }
  return out;
}
