import type {
  CanvasPreview,
  DocumentPreview,
  LiveKind,
  LiveOrigin,
  SheetPreview,
  SlidesPreview,
} from "@agenteschat/live";
import * as live from "@agenteschat/live";
import * as Y from "yjs";

/**
 * What the server reads out of a live document (ADR 0196 §7): the small preview cards and the Drive draw, the text
 * search finds it by, the rules of shape it must keep, and the cheap count of what it holds that the sockets check
 * after every change. The document's shape itself is `@agenteschat/live`'s; this is the engine's one door to it.
 */

/** A live file's `content` as `getArtifact` returns it: its kind and preview (and a document's Markdown). */
export type LiveContent =
  | { kind: "spreadsheet"; preview: SheetPreview }
  | { kind: "slides"; preview: SlidesPreview }
  | { kind: "canvas"; preview: CanvasPreview }
  /**
   * A document (ADR 0200): its card's preview, and its whole text as Markdown, which the apps that don't edit
   * documents yet show read-only and `read_artifact` gives agents.
   */
  | { kind: "document"; preview: DocumentPreview; markdown: string };

/** The type of a version's snapshot: the whole Yjs state as one update (ADR 0196 §7). */
export const LIVE_SNAPSHOT_TYPE = "application/vnd.agentes.live";

/** The most search text a live file gives (`artifacts.excerpt`). */
const EXCERPT_CHARS = 20_000;

/** A new document of `kind` as the apps start one (one sheet, one title slide, an empty canvas). */
export function newLiveDoc(kind: LiveKind, opts: { sheetName?: string } = {}): Y.Doc {
  const doc = new Y.Doc();
  live.initLiveDoc(doc, kind, opts);
  return doc;
}

/** The kind a document says it is (its `meta`), or null for one that isn't a live document. */
export const kindOfDoc = (doc: Y.Doc): LiveKind | null => live.liveKindOf(doc);

/** The preview of a document of `kind` (the file's kind, whatever the document says of itself). */
export function liveContentOf(doc: Y.Doc, kind: LiveKind): LiveContent {
  if (kind === "document") {
    const markdown = live.blocksMarkdown(live.readDocument(doc));
    return { kind, preview: live.documentPreview(doc), markdown };
  }
  return { kind, preview: live.livePreview(doc, { kind }) } as LiveContent;
}

/**
 * A document made from Markdown (ADR 0200): what `create_artifact` and an upload's "Edit as document" make, and what
 * a document saved before documents were live files opens as (its latest version's Markdown). Its pictures stay
 * words: a new document has none of its own yet.
 */
export function documentFromMarkdown(markdown: string, origin: unknown = live.SYSTEM): Y.Doc {
  const doc = newLiveDoc("document");
  live.writeDocument(doc, live.markdownToBlocks(markdown, { images: () => null }), origin);
  return doc;
}

/**
 * A version's content as a document: a snapshot (`LIVE_SNAPSHOT_TYPE`) applied, or, for a document saved as
 * Markdown before documents were live files, made from that Markdown.
 */
export function versionDoc(kind: LiveKind, body: Uint8Array, contentType: string): Y.Doc {
  if (kind === "document" && !contentType.startsWith(LIVE_SNAPSHOT_TYPE)) {
    return documentFromMarkdown(new TextDecoder().decode(body));
  }
  const doc = new Y.Doc();
  Y.applyUpdate(doc, body);
  return doc;
}

/** The preview of a version (a snapshot, or an older document's Markdown). */
export function snapshotContent(kind: LiveKind, snapshot: Uint8Array, contentType = LIVE_SNAPSHOT_TYPE): LiveContent {
  const doc = versionDoc(kind, snapshot, contentType);
  try {
    return liveContentOf(doc, kind);
  } finally {
    doc.destroy();
  }
}

/** What search finds a live file by: sheet names and cells, slides' text and notes, a canvas's or a document's words. */
export function liveExcerpt(doc: Y.Doc): string {
  return live.liveText(doc).replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS);
}

/** What breaks the document's rules of shape or its limits, as sentences (empty: nothing). */
export const liveProblems = (doc: Y.Doc): string[] => live.validateLive(doc);

/** Writes `from`'s content over `doc`'s in one transaction with `origin` (a version restored, ADR 0196 §7). */
export function replaceLiveDoc(doc: Y.Doc, from: Y.Doc, origin: LiveOrigin): void {
  live.replaceLiveContent(doc, from, origin);
}

/** A map's key count without walking it: deleted keys still count, so past a limit the exact count decides. */
function sizeOf(value: unknown, limit: number): number {
  if (!(value instanceof Y.Map)) return 0;
  const upper = value._map.size;
  if (upper <= limit) return upper;
  let n = 0;
  for (const item of value._map.values()) if (!item.deleted) n++;
  return n;
}

const lengthOf = (value: unknown) => (value instanceof Y.Array ? value.length : 0);

/**
 * The first of `LIVE_LIMITS` a document is past, or null: counts read in constant time per sheet, slide or the canvas,
 * so the server can look after every change from a socket (ADR 0196 §2). The bytes are the caller's to count.
 */
export function overLimit(doc: Y.Doc, kind: LiveKind): string | null {
  const limits = live.LIVE_LIMITS;
  if (kind === "spreadsheet") {
    const order = doc.getArray<string>("sheetOrder");
    if (order.length > limits.spreadsheet.sheets) return "sheets";
    let cells = 0;
    for (const sheet of doc.getMap<Y.Map<unknown>>("sheets").values()) {
      if (!(sheet instanceof Y.Map)) continue;
      if (lengthOf(sheet.get("rows")) > limits.spreadsheet.rows) return "rows";
      if (lengthOf(sheet.get("cols")) > limits.spreadsheet.cols) return "cols";
      cells += sizeOf(sheet.get("cells"), limits.spreadsheet.cells);
      if (cells > limits.spreadsheet.cells) return "cells";
    }
    return null;
  }
  if (kind === "slides") {
    if (doc.getArray<string>("slideOrder").length > limits.slides.slides) return "slides";
    for (const slide of doc.getMap<Y.Map<unknown>>("slides").values()) {
      if (slide instanceof Y.Map && sizeOf(slide.get("elements"), limits.slides.elements) > limits.slides.elements) {
        return "elements";
      }
    }
    return null;
  }
  if (kind === "document") return live.documentBody(doc).length > limits.document.blocks ? "blocks" : null;
  return sizeOf(doc.getMap("shapes"), limits.canvas.shapes) > limits.canvas.shapes ? "shapes" : null;
}
