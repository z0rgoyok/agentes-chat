import * as Y from "yjs";
import { LiveEditError } from "../errors";
import { newId } from "../ids";
import { LIVE_LIMITS } from "../limits";
import { overwriteXml } from "../restore";
import { blocksLength, isBlockId, normalizeBlocks, withBlockIds } from "./blocks";
import { DOC_BODY, isDocBlockName } from "./schema";
import type { DocBlock, DocumentSource } from "./types";
import { blockElement, readBlockNode, readBlocks, writeBlocks } from "./yjs";

/**
 * Changing a document (ADR 0200): whole blocks by their ids (insert, replace, delete), text found and replaced in
 * place (its marks kept), and the ids every top-level block must carry. Each runs in one transaction with `origin`, so
 * the apps' undo skips other people's and agents' changes, and leaves blocks it didn't name untouched, so whoever is
 * typing elsewhere in the document keeps their place.
 */

/** The fragment a document's content lives in. */
export function documentBody(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(DOC_BODY);
}

/** The document's blocks, in canonical form. */
export function readDocument(doc: Y.Doc): DocBlock[] {
  return readBlocks(documentBody(doc));
}

const topElements = (doc: Y.Doc) =>
  documentBody(doc)
    .toArray()
    .map((node, index) => ({ node, index }));

/** The id a top-level node carries, or null. */
function idOf(node: unknown): string | null {
  if (!(node instanceof Y.XmlElement)) return null;
  const id = node.getAttribute("id") as unknown;
  return isBlockId(id) ? id : null;
}

/** Where a block is in the body (its index), by id; refused when no block has it. */
export function blockIndex(doc: Y.Doc, id: string): number {
  const at = topElements(doc).find(({ node }) => idOf(node) === id);
  if (!at) throw new LiveEditError("not_found", `No block ${id} in the document`);
  return at.index;
}

/** One block by its id, or null. */
export function readBlock(doc: Y.Doc, id: string): DocBlock | null {
  const at = topElements(doc).find(({ node }) => idOf(node) === id);
  if (!at || !(at.node instanceof Y.XmlElement || at.node instanceof Y.XmlText)) return null;
  return readBlockNode(at.node, true);
}

function takenIds(doc: Y.Doc, except: ReadonlySet<number> = new Set()): Set<string> {
  const ids = new Set<string>();
  for (const { node, index } of topElements(doc)) {
    const id = idOf(node);
    if (id && !except.has(index)) ids.add(id);
  }
  return ids;
}

/** The characters of text a document holds, counted from its texts without reading it into blocks. */
export function documentChars(doc: Y.Doc): number {
  let n = 0;
  for (const text of textsIn(documentBody(doc))) n += text.length;
  return n;
}

/**
 * Refused past `LIVE_LIMITS.document` (blocks, characters, a table's size), on what the body would hold after a
 * change. What a replace takes away isn't subtracted from the characters, so near the limit a replace is refused a
 * little early.
 */
function checkLimits(doc: Y.Doc, adding: readonly DocBlock[], removing: number): void {
  const limits = LIVE_LIMITS.document;
  const all = removing >= documentBody(doc).length;
  const count = documentBody(doc).length - removing + adding.length;
  if (count > limits.blocks) throw new LiveEditError("too_many", `A document holds at most ${limits.blocks} blocks`);
  for (const block of adding) {
    if (block.type === "table") {
      if (block.rows.length > limits.tableRows) {
        throw new LiveEditError("too_many", `A table holds at most ${limits.tableRows} rows`);
      }
      if ((block.rows[0]?.length ?? 0) > limits.tableCols) {
        throw new LiveEditError("too_many", `A table holds at most ${limits.tableCols} columns`);
      }
    }
  }
  const adds = adding.reduce((n, b) => n + (b.type === "table" ? b.rows.reduce((m, row) => m + row.length, 0) : 0), 0);
  if (adds > 0 && adds + (all ? 0 : documentTableCells(doc)) > limits.tableCells) {
    throw new LiveEditError("too_many", `A document's tables hold at most ${limits.tableCells} cells in all`);
  }
  if (blocksLength(adding) + (all ? 0 : documentChars(doc)) > limits.chars) {
    throw new LiveEditError("too_large", `A document holds at most ${limits.chars} characters`);
  }
}

/** The cells of every table in the body, as stored (rows as long as they are). */
export function documentTableCells(doc: Y.Doc): number {
  let cells = 0;
  for (const node of documentBody(doc).toArray()) {
    if (!(node instanceof Y.XmlElement) || node.nodeName !== "table") continue;
    for (const row of node.toArray()) if (row instanceof Y.XmlElement) cells += row.length;
  }
  return cells;
}

/** Plain blocks ready to store: checked, each top-level one with a fresh id unless the caller kept one on purpose. */
function prepare(doc: Y.Doc, blocks: readonly DocBlock[], keep: ReadonlySet<number> = new Set()): DocBlock[] {
  const clean = normalizeBlocks(blocks);
  if (clean.length === 0) throw new LiveEditError("invalid", "Nothing to write");
  return withBlockIds(clean, takenIds(doc, keep));
}

/**
 * Replaces the whole body with `blocks` (a new document, an import): ids kept where given and unique, made where not.
 * An empty list leaves one empty paragraph.
 */
export function writeDocument(doc: Y.Doc, blocks: readonly DocBlock[], origin: unknown): string[] {
  const clean = withBlockIds(normalizeBlocks(blocks));
  checkLimits(doc, clean, documentBody(doc).length);
  const out = clean.length ? clean : withBlockIds([{ type: "paragraph", runs: [] }]);
  doc.transact(() => writeBlocks(documentBody(doc), out), origin);
  return out.map((b) => b.id as string);
}

/** A block's content without its id, to tell whether two blocks say the same. */
const contentKey = (block: DocBlock) => JSON.stringify({ ...block, id: undefined });

/**
 * Replaces the whole body with `blocks` changing as little as it can: a new block that says exactly what an old one
 * said takes its id, and only the blocks between the unchanged start and end are written, so whoever is typing in
 * a block the rewrite didn't change keeps their place. Returns the blocks' ids.
 */
export function rewriteDocument(doc: Y.Doc, blocks: readonly DocBlock[], origin: unknown): string[] {
  const clean = normalizeBlocks(blocks);
  if (clean.length === 0) throw new LiveEditError("invalid", "Nothing to write");
  checkLimits(doc, clean, documentBody(doc).length);
  const free = new Map<string, string[]>();
  for (const old of readDocument(doc)) {
    if (!old.id) continue;
    const key = contentKey(old);
    free.set(key, [...(free.get(key) ?? []), old.id]);
  }
  const reused = clean.map((block) => {
    const id = free.get(contentKey(block))?.shift();
    return id ? { ...block, id } : { ...block, id: undefined };
  });
  const out = withBlockIds(reused);
  const scratch = new Y.Doc();
  try {
    const fragment = scratch.getXmlFragment("x");
    writeBlocks(fragment, out);
    doc.transact(() => overwriteXml(documentBody(doc), fragment), origin);
  } finally {
    scratch.destroy();
  }
  return out.map((b) => b.id as string);
}

/** A new document's body: one empty paragraph (ProseMirror's `block+`). */
export function initDocument(doc: Y.Doc, origin: unknown = null): void {
  writeDocument(doc, [], origin);
}

/**
 * Inserts blocks after the block `after` (null: at the start), or before `before`, or (neither) at the end. Returns
 * the new blocks' ids.
 */
export function insertBlocks(
  doc: Y.Doc,
  blocks: readonly DocBlock[],
  where: { after?: string | null; before?: string },
  origin: unknown,
): string[] {
  const body = documentBody(doc);
  let index = body.length;
  if (where.after === null) index = 0;
  else if (typeof where.after === "string") index = blockIndex(doc, where.after) + 1;
  else if (typeof where.before === "string") index = blockIndex(doc, where.before);
  const clean = prepare(doc, blocks);
  checkLimits(doc, clean, 0);
  doc.transact(() => body.insert(index, clean.map(blockElement)), origin);
  return clean.map((b) => b.id as string);
}

/** The span [from, to] of top-level blocks by their ids (`to` defaults to `from`), refused when out of order. */
function span(doc: Y.Doc, from: string, to?: string): [number, number] {
  const a = blockIndex(doc, from);
  const b = to === undefined || to === from ? a : blockIndex(doc, to);
  if (b < a) throw new LiveEditError("invalid", `Block ${to} comes before ${from}`);
  return [a, b];
}

/**
 * Replaces the blocks from `from` to `to` (inclusive; `to` defaults to `from`) with `blocks`. The first new block
 * keeps `from`'s id, so what named it still does; one block replaced by one of the same kind is changed in place
 * (only what differs), so someone typing in it keeps their place. Returns the new blocks' ids.
 */
export function replaceBlocks(
  doc: Y.Doc,
  from: string,
  to: string | undefined,
  blocks: readonly DocBlock[],
  origin: unknown,
): string[] {
  const body = documentBody(doc);
  const [a, b] = span(doc, from, to);
  const range = new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k));
  const first = normalizeBlocks(blocks)[0];
  const named = first ? [{ ...first, id: from }, ...normalizeBlocks(blocks).slice(1)] : [];
  const clean = prepare(doc, named, range);
  checkLimits(doc, clean, range.size);
  const target = body.get(a);
  const single = range.size === 1 && clean.length === 1 && target instanceof Y.XmlElement;
  doc.transact(() => {
    if (single && target.nodeName === clean[0]?.type) {
      overwriteInPlace(target, clean[0] as DocBlock);
      return;
    }
    body.delete(a, range.size);
    body.insert(a, clean.map(blockElement));
  }, origin);
  return clean.map((block) => block.id as string);
}

/** An element brought to a block's content, changing only what differs (through a scratch copy it can be read from). */
function overwriteInPlace(target: Y.XmlElement, block: DocBlock): void {
  const scratch = new Y.Doc();
  try {
    const fragment = scratch.getXmlFragment("x");
    fragment.insert(0, [blockElement(block)]);
    overwriteXml(target, fragment.get(0) as Y.XmlElement);
  } finally {
    scratch.destroy();
  }
}

/** Deletes the blocks from `from` to `to` (inclusive). A document left empty keeps one empty paragraph. */
export function deleteBlocks(doc: Y.Doc, from: string, to: string | undefined, origin: unknown): number {
  const body = documentBody(doc);
  const [a, b] = span(doc, from, to);
  const count = b - a + 1;
  doc.transact(() => {
    body.delete(a, count);
    if (body.length === 0) body.insert(0, withBlockIds([{ type: "paragraph", runs: [] }]).map(blockElement));
  }, origin);
  return count;
}

/** The texts inside a node, in order (a paragraph's, a heading's, a code block's, each cell's, a quote's). */
function textsIn(node: Y.XmlElement | Y.XmlFragment, out: Y.XmlText[] = []): Y.XmlText[] {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) out.push(child);
    else if (child instanceof Y.XmlElement) textsIn(child, out);
  }
  return out;
}

type DeltaOp = { insert?: unknown; attributes?: Record<string, unknown> };

/** The marks at a character of a text (the attributes of the insert holding it). */
function marksAt(delta: readonly DeltaOp[], at: number): Record<string, unknown> {
  let pos = 0;
  for (const op of delta) {
    const length = typeof op.insert === "string" ? op.insert.length : 1;
    if (at < pos + length) return { ...(op.attributes ?? {}) };
    pos += length;
  }
  return {};
}

/**
 * Finds `find` in the document's text (within one stretch of text: not across a line break or a block) and writes
 * `replace` in its place with the marks the found text started with. Only in block `block` when given; every
 * occurrence with `all`, else the first. Returns how many were replaced.
 */
export function replaceText(
  doc: Y.Doc,
  find: string,
  replace: string,
  opts: { all?: boolean; block?: string; ignoreCase?: boolean },
  origin: unknown,
): number {
  if (!find) throw new LiveEditError("invalid", "Nothing to find");
  const body = documentBody(doc);
  const nodes =
    opts.block === undefined
      ? body.toArray().filter((n): n is Y.XmlElement => n instanceof Y.XmlElement)
      : [body.get(blockIndex(doc, opts.block)) as Y.XmlElement];
  const needle = opts.ignoreCase ? find.toLowerCase() : find;
  let count = 0;
  doc.transact(() => {
    for (const node of nodes) {
      for (const text of textsIn(node)) {
        const delta = text.toDelta() as DeltaOp[];
        const plain = delta.map((op) => (typeof op.insert === "string" ? op.insert : "￼")).join("");
        const hay = opts.ignoreCase ? plain.toLowerCase() : plain;
        const hits: number[] = [];
        let from = 0;
        for (;;) {
          const at = hay.indexOf(needle, from);
          if (at < 0) break;
          hits.push(at);
          from = at + needle.length;
          if (!opts.all && count + hits.length >= 1) break;
        }
        // From the end, so the earlier positions stay put.
        for (const at of hits.reverse()) {
          const marks = marksAt(delta, at);
          text.delete(at, find.length);
          if (replace) text.insert(at, replace, marks);
        }
        count += hits.length;
        if (!opts.all && count > 0) return;
      }
    }
  }, origin);
  return count;
}

/**
 * Gives every top-level block that has none (or one another block already has) an id of its own: blocks an editor
 * split or pasted carry their neighbor's or none. Returns whether anything changed.
 */
export function ensureBlockIds(doc: Y.Doc, origin: unknown): boolean {
  const seen = new Set<string>();
  const missing: Y.XmlElement[] = [];
  for (const node of documentBody(doc).toArray()) {
    if (!(node instanceof Y.XmlElement) || !isDocBlockName(node.nodeName)) continue;
    const id = idOf(node);
    if (id && !seen.has(id)) seen.add(id);
    else missing.push(node);
  }
  if (missing.length === 0) return false;
  doc.transact(() => {
    for (const node of missing) {
      let id = newId();
      while (seen.has(id)) id = newId();
      seen.add(id);
      node.setAttribute("id", id);
    }
  }, origin);
  return true;
}

/** Where the document came from (an uploaded `.docx`, ADR 0198), kept in its `meta`. */
export function setDocumentSource(doc: Y.Doc, source: DocumentSource, origin: unknown): void {
  const clean: DocumentSource = { name: source.name.slice(0, 255) };
  if (source.file) clean.file = source.file;
  doc.transact(() => doc.getMap<unknown>("meta").set("source", clean), origin);
}

/** Where the document came from, or null when it was made here. */
export function documentSource(doc: Y.Doc): DocumentSource | null {
  const raw = doc.getMap<unknown>("meta").get("source") as Partial<DocumentSource> | undefined;
  if (!raw || typeof raw !== "object" || typeof raw.name !== "string" || !raw.name) return null;
  return typeof raw.file === "string" ? { name: raw.name, file: raw.file } : { name: raw.name };
}
