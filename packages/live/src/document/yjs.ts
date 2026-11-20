import * as Y from "yjs";
import { normalizeBlock, normalizeRuns } from "./blocks";
import type { DocBlock, DocCell, DocParagraph, DocRun } from "./types";

/**
 * Documents in a `Y.XmlFragment` in y-prosemirror's encoding (ADR 0200), read and written without ProseMirror so the
 * phone and the server share the web editor's documents. What `blockElement` builds is what y-prosemirror 1.3.7's
 * `prosemirrorJSONToYXmlFragment` stores for the same content under `DOC_SCHEMA_SPEC` (tests prove it both ways):
 *
 * - each node is a `Y.XmlElement` named after it, with an attribute for each attribute that isn't null (a
 *   paragraph's `level` 0 and a heading's `level` included);
 * - consecutive text is one `Y.XmlText` whose inserts carry each mark as an attribute named after the mark, valued
 *   with the mark's attributes (`{ bold: {} }`, `{ code: {} }`, `{ link: { href } }`);
 * - a line break is a `Y.XmlElement("hard_break")` between the texts; a code block's text is one `Y.XmlText` whose
 *   lines are joined by "\n".
 */

type Attrs = Record<string, unknown>;

/** y-prosemirror names a mark that may overlap itself `name--<hash>`; ours never do, but read both. */
const HASHED_MARK = /^(.*)--[a-zA-Z0-9+/=]{8}$/;

const markName = (attribute: string) => HASHED_MARK.exec(attribute)?.[1] ?? attribute;

function runOf(text: string, attributes: Attrs | undefined): DocRun {
  const run: DocRun = { text };
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
      case "code":
        run.code = true;
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
    }
  }
  return run;
}

function textRuns(text: Y.XmlText): DocRun[] {
  const runs: DocRun[] = [];
  for (const op of text.toDelta() as { insert?: unknown; attributes?: Attrs }[]) {
    if (typeof op.insert === "string" && op.insert) runs.push(runOf(op.insert, op.attributes));
  }
  return runs;
}

/** An element's inline content as runs: texts, line breaks, and the words of anything else inside. */
function inlineRuns(node: Y.XmlElement | Y.XmlFragment): DocRun[] {
  const runs: DocRun[] = [];
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) runs.push(...textRuns(child));
    else if (child instanceof Y.XmlElement) {
      if (child.nodeName === "hard_break") runs.push({ text: "\n" });
      else runs.push(...inlineRuns(child));
    }
  }
  return runs;
}

/** The plain text of a node, texts only (a code block's lines). */
function plainOf(node: Y.XmlElement): string {
  return inlineRuns(node)
    .map((r) => r.text)
    .join("");
}

const children = (node: Y.XmlElement | Y.XmlFragment) =>
  node.toArray().filter((c): c is Y.XmlElement | Y.XmlText => c instanceof Y.XmlElement || c instanceof Y.XmlText);

function cellOf(cell: Y.XmlElement | Y.XmlText): DocCell {
  if (cell instanceof Y.XmlText) return { blocks: [{ type: "paragraph", runs: textRuns(cell) }] };
  const blocks: DocParagraph[] = [];
  for (const child of children(cell)) {
    const block = rawBlock(child, false);
    if (block?.type === "paragraph") blocks.push(block);
    else if (block) blocks.push({ type: "paragraph", runs: [{ text: wordsOf(child) }] });
  }
  return { blocks };
}

const wordsOf = (node: Y.XmlElement | Y.XmlText) =>
  node instanceof Y.XmlText
    ? textRuns(node)
        .map((r) => r.text)
        .join("")
    : plainOf(node);

/** A node as it is stored, before `normalizeBlock` checks it. */
function rawBlock(node: Y.XmlElement | Y.XmlText, top: boolean): DocBlock | null {
  if (node instanceof Y.XmlText) return { type: "paragraph", runs: textRuns(node) };
  const attrs = node.getAttributes() as Attrs;
  const id = top && typeof attrs.id === "string" ? { id: attrs.id } : {};
  switch (node.nodeName) {
    case "paragraph":
      return { ...(attrs as object), ...id, type: "paragraph", runs: inlineRuns(node) } as DocBlock;
    case "heading":
      return { ...(attrs as object), ...id, type: "heading", runs: inlineRuns(node) } as DocBlock;
    case "blockquote":
      return {
        ...id,
        type: "blockquote",
        blocks: children(node)
          .map((child) => rawBlock(child, false))
          .filter((b): b is DocBlock => b !== null),
      };
    case "code_block":
      return { ...id, type: "code_block", language: attrs.language as string, text: plainOf(node) };
    case "horizontal_rule":
      return { ...id, type: "horizontal_rule" };
    case "image":
      return {
        ...id,
        type: "image",
        asset: attrs.asset as string,
        alt: attrs.alt as string,
        width: attrs.width as number,
      };
    case "table":
      return {
        ...id,
        type: "table",
        ...(attrs.header === true ? { header: true as const } : {}),
        rows: children(node).map((row) => (row instanceof Y.XmlElement ? children(row).map(cellOf) : [])),
      };
    default:
      // Another editor's block: its words, so nothing a newer app writes breaks a read.
      return { ...id, type: "paragraph", runs: inlineRuns(node) };
  }
}

/** One stored block, in canonical form (null: one that can't be read as a block, like an image without a picture). */
export function readBlockNode(node: Y.XmlElement | Y.XmlText, top = true): DocBlock | null {
  return normalizeBlock(rawBlock(node, top), top);
}

/** A fragment's blocks, in canonical form. */
export function readBlocks(fragment: Y.XmlFragment): DocBlock[] {
  const out: DocBlock[] = [];
  for (const child of children(fragment)) {
    const block = readBlockNode(child, true);
    if (block) out.push(block);
  }
  return out;
}

function markAttributes(run: DocRun): Attrs {
  const attributes: Attrs = {};
  if (run.bold) attributes.bold = {};
  if (run.italic) attributes.italic = {};
  if (run.underline) attributes.underline = {};
  if (run.strike) attributes.strike = {};
  if (run.code) attributes.code = {};
  if (run.color) attributes.color = { color: run.color };
  if (run.link) attributes.link = { href: run.link };
  return attributes;
}

/** Inline content: texts and line breaks, as y-prosemirror lays them out. */
function inlineNodes(runs: readonly DocRun[]): (Y.XmlText | Y.XmlElement)[] {
  const nodes: (Y.XmlText | Y.XmlElement)[] = [];
  let pending: { insert: string; attributes: Attrs }[] = [];
  const flush = () => {
    if (!pending.length) return;
    const text = new Y.XmlText();
    text.applyDelta(pending);
    nodes.push(text);
    pending = [];
  };
  for (const run of normalizeRuns(runs)) {
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

function element(name: string, attrs: Attrs, content: (Y.XmlText | Y.XmlElement)[] = []): Y.XmlElement {
  const node = new Y.XmlElement<Record<string, string>>(name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(key, value as string);
  }
  if (content.length) node.insert(0, content);
  return node as unknown as Y.XmlElement;
}

function paragraphElement(block: DocParagraph): Y.XmlElement {
  return element(
    "paragraph",
    { id: block.id, align: block.align, level: block.level ?? 0, list: block.list },
    inlineNodes(block.runs),
  );
}

/**
 * A new element for a block (in canonical form), to insert into a fragment. Its attributes are set in the schema's
 * order and only when not null, as y-prosemirror sets them.
 */
export function blockElement(block: DocBlock): Y.XmlElement {
  switch (block.type) {
    case "paragraph":
      return paragraphElement(block);
    case "heading":
      return element("heading", { id: block.id, align: block.align, level: block.level }, inlineNodes(block.runs));
    case "blockquote":
      return element("blockquote", { id: block.id }, block.blocks.map(blockElement));
    case "code_block": {
      const content: Y.XmlText[] = [];
      if (block.text) {
        const text = new Y.XmlText();
        text.insert(0, block.text);
        content.push(text);
      }
      return element("code_block", { id: block.id, language: block.language }, content);
    }
    case "horizontal_rule":
      return element("horizontal_rule", { id: block.id });
    case "image":
      return element("image", { id: block.id, asset: block.asset, alt: block.alt, width: block.width });
    case "table":
      return element(
        "table",
        { id: block.id, header: block.header },
        block.rows.map((row) =>
          element(
            "table_row",
            {},
            row.map((cell) => element("table_cell", {}, cell.blocks.map(paragraphElement))),
          ),
        ),
      );
  }
}

function inTransaction(fragment: Y.XmlFragment, origin: unknown, fn: () => void): void {
  const doc = fragment.doc;
  if (doc) doc.transact(fn, origin);
  else fn();
}

/**
 * Replaces everything in the fragment with `blocks` (each in canonical form; an empty list is one empty paragraph, as
 * ProseMirror's `block+` needs). Ids are stored as given. `origin` applies when this isn't already inside a
 * transaction.
 */
export function writeBlocks(fragment: Y.XmlFragment, blocks: readonly DocBlock[], origin?: unknown): void {
  const clean = blocks.map((b) => normalizeBlock(b, true)).filter((b): b is DocBlock => b !== null);
  const content = (clean.length ? clean : [{ type: "paragraph", runs: [] } as DocParagraph]).map(blockElement);
  inTransaction(fragment, origin, () => {
    // A fragment not yet in a document is a new one (reading it would only warn): nothing to delete.
    if (fragment.doc && fragment.length) fragment.delete(0, fragment.length);
    fragment.insert(0, content);
  });
}
