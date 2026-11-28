import * as Y from "yjs";
import { LIVE_LIMITS } from "../limits";
import { overwriteXml } from "../restore";
import { blocksText, clipBlocks, isAssetId } from "./blocks";
import { documentBody, documentChars, documentFonts, documentSource, documentTableCells } from "./ops";
import { DOC_BODY, isDocBlockName } from "./schema";
import type { DocumentPreview } from "./types";
import { readBlocks } from "./yjs";

/**
 * A document as a whole (ADR 0200, ADR 0196 §7): its preview (what cards and the Drive draw), its text (what search
 * finds it by), its rules of shape (what the server checks) and a version's content written over it.
 */

/** About how much text a preview carries: a card's first page. */
const PREVIEW_CHARS = 1200;
const PREVIEW_BLOCKS = 16;
/** The most text `documentText` gives (search reads the first 20,000 characters). */
const TEXT_CHARS = 20_000;

/** A document's first blocks, clipped, with its size and where it came from (no title: the file has one). */
export function documentPreview(doc: Y.Doc): DocumentPreview {
  const body = documentBody(doc);
  const head = new Y.Doc();
  let blocks: ReturnType<typeof readBlocks>;
  try {
    // Only the first blocks are read into plain data, however long the document is.
    const fragment = head.getXmlFragment("x");
    fragment.insert(
      0,
      body
        .slice(0, PREVIEW_BLOCKS)
        .filter((n): n is Y.XmlElement | Y.XmlText => n instanceof Y.XmlElement || n instanceof Y.XmlText)
        .map((n) => n.clone()),
    );
    blocks = readBlocks(fragment);
  } finally {
    head.destroy();
  }
  const preview: DocumentPreview = {
    blocks: clipBlocks(blocks, PREVIEW_CHARS),
    count: body.length,
    chars: documentChars(doc),
  };
  const source = documentSource(doc);
  if (source) preview.source = source;
  const fonts = documentFonts(doc);
  if (fonts) preview.fonts = fonts;
  return preview;
}

/** The document's words, block by block (at most 20,000 characters). */
export function documentText(doc: Y.Doc): string {
  return blocksText(readBlocks(documentBody(doc))).slice(0, TEXT_CHARS);
}

/** What breaks the document's rules of shape or `LIVE_LIMITS` (sentences for the logs; empty when nothing does). */
export function validateDocument(doc: Y.Doc): string[] {
  const limits = LIVE_LIMITS.document;
  const problems: string[] = [];
  const shared = doc.share.get(DOC_BODY);
  if (shared !== undefined && !(shared instanceof Y.XmlFragment) && shared.constructor !== Y.AbstractType) {
    return ["The document's body isn't rich text"];
  }
  const body = documentBody(doc);
  if (body.length > limits.blocks) problems.push(`The document has ${body.length} blocks (at most ${limits.blocks})`);
  body.toArray().forEach((node, i) => {
    if (!(node instanceof Y.XmlElement)) {
      problems.push(`Block ${i + 1} is loose text`);
      return;
    }
    if (!isDocBlockName(node.nodeName)) {
      problems.push(`Block ${i + 1} is an unknown kind (${node.nodeName})`);
      return;
    }
    if (node.nodeName === "image" && !isAssetId(node.getAttribute("asset"))) {
      problems.push(`Block ${i + 1} is a picture without one`);
    }
    if (node.nodeName === "table") {
      const rows = node.toArray();
      if (rows.length > limits.tableRows) problems.push(`Block ${i + 1} has ${rows.length} rows`);
      for (const row of rows) {
        if (row instanceof Y.XmlElement && row.length > limits.tableCols) {
          problems.push(`Block ${i + 1} has a row of ${row.length} cells`);
          break;
        }
      }
    }
  });
  const chars = documentChars(doc);
  if (chars > limits.chars) problems.push(`The document has ${chars} characters (at most ${limits.chars})`);
  const cells = documentTableCells(doc);
  if (cells > limits.tableCells) {
    problems.push(`The document's tables have ${cells} cells (at most ${limits.tableCells})`);
  }
  return problems;
}

/** Writes `from`'s document over `doc`'s in one transaction with `origin`, changing only what differs. */
export function replaceDocument(doc: Y.Doc, from: Y.Doc, origin: unknown): void {
  doc.transact(() => overwriteXml(documentBody(doc), documentBody(from)), origin);
}
