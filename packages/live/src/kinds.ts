import * as random from "lib0/random";
import type * as Y from "yjs";
import { canvasPreview, canvasText, initCanvas, replaceCanvas, validateCanvas } from "./canvas";
import type { CanvasPreview } from "./canvas/types";
import { documentPreview, documentText, initDocument, replaceDocument, validateDocument } from "./document";
import type { DocumentPreview } from "./document/types";
import { LiveEditError } from "./errors";
import { isLiveKind, LIVE_KINDS, LIVE_LIMITS, type LiveKind } from "./limits";
import { SYSTEM } from "./origins";
import { initSlides, replaceSlides, slidesPreview, slidesText, validateSlides } from "./slides";
import type { SlidesPreview } from "./slides/types";
import {
  initSpreadsheet,
  replaceSpreadsheet,
  SheetEngine,
  type SheetLocale,
  type SheetPreview,
  sheetLocale,
  spreadsheetPreview,
  spreadsheetText,
  validateSpreadsheet,
} from "./spreadsheet";

/**
 * Live documents as a whole (ADR 0196 §2), whatever their kind: a new one, which kind one is, and the dispatchers the
 * server uses for previews, search text, rules of shape and restoring a version.
 *
 * The kinds and `LIVE_LIMITS` are defined in `limits.ts`, which imports nothing, and re-exported here: the spreadsheet
 * module reads the limits through this module while this one reads the spreadsheet module, so the limits never wait
 * on either.
 */

export { isLiveKind, LIVE_KINDS, LIVE_LIMITS, type LiveKind };

/** The shape version a document's `meta.v` says; a reader meeting a newer one knows it may not see everything. */
export const LIVE_DOC_VERSION = 1;

function metaOf(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>("meta");
}

/** The kind a document says it is (`meta.kind`), or null for one that isn't a live document. */
export function liveKindOf(doc: Y.Doc): LiveKind | null {
  const kind = metaOf(doc).get("kind");
  return typeof kind === "string" && isLiveKind(kind) ? kind : null;
}

/**
 * The document's seed (`meta.seed`): random numbers in formulas come from it, so everyone computes the same ones. A
 * document without one (never made by `initLiveDoc`) reads as "".
 */
export function docSeed(doc: Y.Doc): string {
  const seed = metaOf(doc).get("seed");
  return typeof seed === "string" ? seed : "";
}

/** A fresh seed: 64 random bits as 16 hex digits (lib0's crypto randomness, the same source in every app). */
function newSeed(): string {
  return [random.uint32(), random.uint32()].map((n) => n.toString(16).padStart(8, "0")).join("");
}

/**
 * Makes `doc` a new live document of `kind`: `meta` ({ kind, v: 1, seed }) and the kind's default content (a
 * spreadsheet's one sheet, named in the person's language by the caller, of 100 rows by 26 columns; a presentation's
 * theme and title slide; a canvas's dotted background; a document's one empty paragraph), in one transaction
 * (`SYSTEM` unless `origin` is given). A document that already is a live document is refused.
 */
export function initLiveDoc(
  doc: Y.Doc,
  kind: LiveKind,
  opts: { sheetName?: string; seed?: string; origin?: unknown } = {},
): void {
  if (!isLiveKind(kind)) throw new LiveEditError("invalid", `Unknown kind ${String(kind)}`);
  if (liveKindOf(doc) !== null) throw new LiveEditError("invalid", "The document already is a live file");
  const origin = opts.origin === undefined ? SYSTEM : opts.origin;
  const seed = opts.seed && opts.seed.length <= 64 ? opts.seed : newSeed();
  doc.transact(() => {
    const meta = metaOf(doc);
    meta.set("kind", kind);
    meta.set("v", LIVE_DOC_VERSION);
    meta.set("seed", seed);
    if (kind === "spreadsheet") initSpreadsheet(doc, opts.sheetName || "Sheet 1", origin);
    else if (kind === "slides") initSlides(doc, origin);
    else if (kind === "document") initDocument(doc, origin);
    else initCanvas(doc, origin);
  }, origin);
}

function kindOrThrow(doc: Y.Doc, kind: LiveKind | undefined): LiveKind {
  const found = kind ?? liveKindOf(doc);
  if (!found) throw new LiveEditError("invalid", "Not a live document");
  return found;
}

/**
 * Writes `from`'s content over `doc`'s in one transaction with `origin` (restoring a version, ADR 0196 §7), changing
 * only what differs so whoever is editing at that moment keeps their place. Both must be the same kind.
 */
export function replaceLiveContent(doc: Y.Doc, from: Y.Doc, origin: unknown): void {
  const kind = kindOrThrow(from, undefined);
  const own = liveKindOf(doc);
  if (own !== null && own !== kind) throw new LiveEditError("invalid", `Can't write a ${kind} over a ${own}`);
  doc.transact(() => {
    if (own === null) {
      const meta = metaOf(doc);
      meta.set("kind", kind);
      meta.set("v", LIVE_DOC_VERSION);
      meta.set("seed", docSeed(from));
    }
    if (kind === "spreadsheet") replaceSpreadsheet(doc, from, origin);
    else if (kind === "slides") replaceSlides(doc, from, origin);
    else if (kind === "document") replaceDocument(doc, from, origin);
    else replaceCanvas(doc, from, origin);
  }, origin);
}

/** A preview of any kind: what cards and the Drive draw, small enough to go with every listing. */
export type LivePreview = SheetPreview | SlidesPreview | CanvasPreview | DocumentPreview;

export interface LiveReadOptions {
  /** The kind, when the caller knows it (else the document's own `meta.kind`). */
  kind?: LiveKind;
  /** A spreadsheet's engine, when the caller has one running (else one is made for this read and dropped). */
  engine?: SheetEngine;
  /** How a spreadsheet's values are shown: a locale or its tag (default "en-US"). */
  locale?: SheetLocale | string;
}

function localeOf(locale: SheetLocale | string | undefined): SheetLocale {
  if (locale && typeof locale === "object") return locale;
  return sheetLocale(typeof locale === "string" && locale ? locale : "en-US");
}

function withEngine<T>(doc: Y.Doc, engine: SheetEngine | undefined, read: (engine: SheetEngine) => T): T {
  if (engine) return read(engine);
  const own = new SheetEngine(doc);
  try {
    return read(own);
  } finally {
    own.destroy();
  }
}

/** The preview: a spreadsheet's top-left cells, a deck's first slide, a canvas's shapes, a document's first blocks. */
export function livePreview(doc: Y.Doc, opts: LiveReadOptions = {}): LivePreview {
  const kind = kindOrThrow(doc, opts.kind);
  if (kind === "spreadsheet") {
    return withEngine(doc, opts.engine, (engine) => spreadsheetPreview(doc, engine, localeOf(opts.locale)));
  }
  if (kind === "document") return documentPreview(doc);
  return kind === "slides" ? slidesPreview(doc) : canvasPreview(doc);
}

/** The document's words, for search (at most 20,000 characters). */
export function liveText(doc: Y.Doc, opts: LiveReadOptions = {}): string {
  const kind = kindOrThrow(doc, opts.kind);
  if (kind === "spreadsheet") {
    return withEngine(doc, opts.engine, (engine) => spreadsheetText(doc, engine, localeOf(opts.locale)));
  }
  if (kind === "document") return documentText(doc);
  return kind === "slides" ? slidesText(doc) : canvasText(doc);
}

/** What breaks the document's rules of shape or `LIVE_LIMITS`, as sentences (empty: nothing). */
export function validateLive(doc: Y.Doc): string[] {
  const kind = liveKindOf(doc);
  if (!kind) return ["The document has no live file kind"];
  const version = metaOf(doc).get("v");
  const problems: string[] = [];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    problems.push("The document has no shape version");
  }
  if (kind === "spreadsheet") problems.push(...validateSpreadsheet(doc));
  else if (kind === "document") problems.push(...validateDocument(doc));
  else problems.push(...(kind === "slides" ? validateSlides(doc) : validateCanvas(doc)));
  return problems;
}
