import { serverText } from "@agenteschat/i18n";
import {
  canvasBackground,
  type DeckData,
  readDeck as deckOfDoc,
  LiveEditError,
  readShapes,
  SheetEngine,
  SheetError,
  SYSTEM,
  setDocumentSource,
  slidesFromData,
  spreadsheetFromData,
  spreadsheetToData,
  type WorkbookData,
  writeDocument,
} from "@agenteschat/live";
import * as Y from "yjs";
import {
  type ArtifactActor,
  type ArtifactDeps,
  type ArtifactFileFormat,
  type ArtifactView,
  getArtifact,
  type LiveArtifactKind,
  type LiveExport,
  type LiveExporter,
  type LivePicture,
  liveSnapshotOf,
  requireLiveFile,
  setFileSharing,
  storedFileOfArtifact,
} from "../artifacts";
import { NotFoundError, ValidationError } from "../errors";
import { imageSize } from "../image-size";
import {
  docxToDocument,
  docxToHtml,
  isOfficeError,
  OFFICE_LIMITS,
  type OfficeFileKind,
  officeFormatOf,
  officeKindOf,
  officeTooLarge,
  officeTooLargeToEdit,
  officeUnreadable,
  officeUnsupported,
  readPptx,
  readWorkbook,
  slidesPdf,
  writeCsv,
  writePptx,
  writeXlsx,
} from "../office";
import { imageTypeOf } from "../office/package";
import { lineLocale, personLocale } from "../requester";
import { LIVE_ASSET_BYTES } from "./assets";
import { createLiveFile } from "./create";
import type { LiveDocs } from "./docs";
import { documentExport, liveAssetBytes, liveFontBytes } from "./document-export";
import { fileFonts } from "./file-fonts";
import { loadHeadDoc } from "./store";

/**
 * Office files and live files meeting (ADR 0198): an uploaded workbook, deck or Word document as the apps draw it
 * (`officePreview`, read once per version and kept a while: versions never change), made into a live file beside it
 * (`openAsLive`: a spreadsheet, a presentation or a document, ADR 0200), and a live file written out as Excel, CSV,
 * PowerPoint, Word, Markdown or PDF (`exportLive`, also what the Drive's downloads of live files use,
 * `officeLiveExporter`).
 */

/** An uploaded Office file as the apps draw it: a workbook or a deck in their views, a document as clean HTML. */
export type OfficePreview =
  | { kind: "workbook"; workbook: WorkbookData }
  | { kind: "deck"; deck: DeckData }
  | { kind: "document"; html: string };

/** What a live file downloads as (ADR 0198; a document's `.docx`, `.md` and PDF, ADR 0200). */
export type LiveExportFormat = "xlsx" | "csv" | "pptx" | "pdf" | "docx" | "md";

/**
 * Previews by file, version and content, kept ten minutes and within a budget of bytes (a deck holds its pictures):
 * a version never changes, so it is read once while it is looked at, and each of its pictures is served from here.
 */
class PreviewCache {
  private readonly entries = new Map<string, { value: Promise<OfficePreview>; bytes: number; expires: number }>();
  private total = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxBytes: number,
  ) {}

  get(key: string): Promise<OfficePreview> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: Promise<OfficePreview>, bytes: number) {
    this.delete(key);
    this.entries.set(key, { value, bytes, expires: Date.now() + this.ttlMs });
    this.total += bytes;
    for (const [oldest] of this.entries) {
      if (this.total <= this.maxBytes || oldest === key) break;
      this.delete(oldest);
    }
  }

  delete(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.bytes;
  }
}

const previews = new PreviewCache(10 * 60_000, 128 * 1024 * 1024);

/** About how much memory a preview holds: its pictures' bytes and its text. */
function previewBytes(preview: OfficePreview): number {
  if (preview.kind === "document") return preview.html.length * 2;
  if (preview.kind === "deck") {
    return Object.values(preview.deck.media).reduce((n, m) => n + (m.bytes?.byteLength ?? 0), 0) + 64 * 1024;
  }
  return preview.workbook.sheets.reduce((n, s) => n + s.cells.length * 160, 0);
}

/** The Office file behind an artifact at a version: what it is and where its bytes are. */
async function officeSource(deps: ArtifactDeps, actor: ArtifactActor, orgId: string, fileId: string, version?: number) {
  const detail = await getArtifact(deps, actor, orgId, fileId, version);
  const content = detail.content;
  if (content.kind !== "file") throw officeUnsupported(detail.title);
  const format = officeFormatOf(content.name, content.contentType);
  if (!format) throw officeUnsupported(content.name);
  if (content.size > OFFICE_LIMITS.inputBytes) throw officeTooLarge("size");
  return { detail, content, format, kind: officeKindOf(format), version: detail.shownVersion };
}

async function sourceBytes(deps: ArtifactDeps, actor: ArtifactActor, orgId: string, fileId: string, version: number) {
  const file = await storedFileOfArtifact(deps, actor, orgId, fileId, version);
  const store = await deps.blobs.forConfig(orgId, file.storageConfigId);
  const object = await store.get(file.blobKey);
  if (!object) throw new NotFoundError("The stored file is missing", "artifact.not_found");
  return object.body;
}

/** A reader's failure as one of the Office refusals: a file it couldn't make sense of is unreadable, never a crash. */
function asOfficeError(error: unknown): Error {
  if (isOfficeError(error)) return error;
  return officeUnreadable();
}

async function readPreview(bytes: Uint8Array, kind: OfficeFileKind, name: string, type: string) {
  try {
    if (kind === "workbook") return { kind, workbook: await readWorkbook(bytes, name, type) } as const;
    if (kind === "deck") return { kind, deck: readPptx(bytes) } as const;
    return { kind, html: await docxToHtml(bytes) } as const;
  } catch (error) {
    throw asOfficeError(error);
  }
}

/** An uploaded Office file (at a version, else its latest) as the apps draw it, for whoever reads the file. */
export async function officePreview(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  fileId: string,
  version?: number,
): Promise<OfficePreview> {
  const source = await officeSource(deps, actor, orgId, fileId, version);
  const key = `${orgId}:${fileId}:${source.version}:${source.content.sha256}`;
  const cached = previews.get(key);
  if (cached) return cached;
  const reading = (async () => {
    const bytes = await sourceBytes(deps, actor, orgId, fileId, source.version);
    return readPreview(bytes, source.kind, source.content.name, source.content.contentType);
  })();
  // Kept while it is read (two asks at once read once), then at its size; a failure isn't kept.
  previews.set(key, reading, source.content.size);
  reading.then(
    (preview) => previews.get(key) === reading && previews.set(key, reading, previewBytes(preview)),
    () => previews.delete(key),
  );
  return reading;
}

/** A file's name without its extension, as a title. */
const titleOf = (name: string) =>
  name
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .trim()
    .slice(0, 200) || name.slice(0, 200);

/** The pictures a deck uses, stored under new ids its slides then name (`DeckMedia.asset`). */
function deckPictures(deck: DeckData): LivePicture[] {
  const used = new Set<string>();
  for (const slide of deck.slides) {
    if (slide.bg && typeof slide.bg === "object") used.add(slide.bg.media);
    for (const el of slide.elements) if (el.type === "image" && el.media) used.add(el.media);
  }
  const pictures: LivePicture[] = [];
  for (const name of used) {
    const media = deck.media[name];
    const bytes = media?.bytes;
    const type = bytes ? imageTypeOf(bytes) : null;
    if (!media || !bytes || !type || bytes.byteLength > LIVE_ASSET_BYTES) continue;
    const id = Bun.randomUUIDv7();
    const size = imageSize(bytes);
    media.asset = id;
    pictures.push({ id, bytes, contentType: type, width: size?.width ?? null, height: size?.height ?? null });
  }
  return pictures;
}

/**
 * Makes an uploaded Office file editable beside it (ADR 0198): a workbook becomes a spreadsheet, a deck a
 * presentation and a Word document a live document (their pictures stored with them, ADR 0200); in the same
 * conversation and thread, shared as the upload is, with a note saying which file it came from (a document also keeps
 * the upload's name, "Importado de X.docx"). The upload stays as it was.
 */
export async function openAsLive(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  fileId: string,
): Promise<ArtifactView> {
  const source = await officeSource(deps, actor, orgId, fileId);
  const bytes = await sourceBytes(deps, actor, orgId, fileId, source.version);
  const name = source.content.name;
  const title = titleOf(name);
  const locale =
    actor.type === "person"
      ? await personLocale(deps.db, actor.userId)
      : await lineLocale(deps.db, orgId, null, actor.runId ?? null);
  const note = serverText(locale, "live.defaults.fromFile", { name });
  // A Drive upload's sharing comes along from the start: a file of the Drive itself is the workspace's by default
  // (ADR 0157, amendment 2026-11-17), which the upload may not be.
  const place = {
    channelId: source.detail.channelId,
    threadId: source.detail.threadId,
    sharing: source.detail.channelId ? undefined : source.detail.sharing,
  };
  let made: ArtifactView;
  try {
    if (source.kind === "workbook") {
      const workbook = await readWorkbook(bytes, name, source.content.contentType);
      made = await createLiveFile(deps, actor, orgId, {
        kind: "spreadsheet",
        title,
        ...place,
        note,
        init: (doc) => spreadsheetFromData(doc, workbook, SYSTEM),
      });
    } else if (source.kind === "deck") {
      const deck = readPptx(bytes);
      const pictures = deckPictures(deck);
      made = await createLiveFile(deps, actor, orgId, {
        kind: "slides",
        title,
        ...place,
        note,
        pictures,
        init: (doc) => slidesFromData(doc, deck, SYSTEM),
      });
    } else {
      const read = docxToDocument(bytes, {
        pictureId: () => Bun.randomUUIDv7(),
        maxPictureBytes: OFFICE_LIMITS.inlineImageBytes,
        maxEachBytes: LIVE_ASSET_BYTES,
      });
      const pictures: LivePicture[] = read.pictures.map((p) => {
        const size = imageSize(p.bytes);
        return { ...p, width: size?.width ?? null, height: size?.height ?? null };
      });
      made = await createLiveFile(deps, actor, orgId, {
        kind: "document",
        title,
        ...place,
        note,
        pictures,
        init: (doc) => {
          writeDocument(doc, read.blocks, SYSTEM);
          setDocumentSource(doc, { name, file: fileId }, SYSTEM);
        },
      });
    }
  } catch (error) {
    if (error instanceof SheetError && error.reason === "limit") throw officeTooLargeToEdit(error.message);
    if (error instanceof LiveEditError && (error.code === "too_many" || error.code === "too_large")) {
      throw officeTooLargeToEdit(error.message);
    }
    if (error instanceof ValidationError && error.code === "live.too_large") throw officeTooLargeToEdit("size");
    if (error instanceof ValidationError || error instanceof NotFoundError) throw error;
    throw asOfficeError(error);
  }
  // Shared as the upload is (a person's own choice to make; refused quietly when it isn't theirs to make).
  const sharing = source.detail.sharing;
  if (actor.type === "person" && sharing.mode !== "conversation" && made.channelId) {
    await setFileSharing(deps, actor.userId, orgId, made.id, sharing).catch(() => undefined);
  }
  return made;
}

const CONTENT_TYPES: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  json: "application/json",
};

/** A live document written out as `format` (null: its kind's own), or `artifact.format_unavailable`. */
export async function writeLiveExport(
  deps: ArtifactDeps,
  file: { orgId: string; id: string; title: string },
  kind: LiveArtifactKind,
  doc: Y.Doc,
  format: ArtifactFileFormat | LiveExportFormat | null,
): Promise<LiveExport> {
  const out = (ext: string, body: Uint8Array): LiveExport => ({ body, contentType: CONTENT_TYPES[ext] as string, ext });
  if (kind === "spreadsheet" && (format === null || format === "xlsx" || format === "csv")) {
    const engine = new SheetEngine(doc);
    try {
      const data = spreadsheetToData(doc, engine);
      if (format === "csv") {
        const sheet = data.sheets[0] ?? { name: "", rows: 0, cols: 0, cells: [] };
        // A byte order mark, so Excel reads the text as UTF-8.
        return out("csv", new TextEncoder().encode(`\ufeff${writeCsv(sheet)}`));
      }
      return out("xlsx", writeXlsx(data));
    } finally {
      engine.destroy();
    }
  }
  if (kind === "slides" && (format === null || format === "pptx" || format === "pdf")) {
    const deck = deckOfDoc(doc);
    const media = (asset: string) => liveAssetBytes(deps, file.orgId, file.id, asset);
    const own = await fileFonts(deps, file.orgId, file.id);
    if (format === "pdf") {
      // A file's own font goes into a PDF unless its license forbids embedding it (`fsType`, ADR 0220 §2).
      const embeddable = own.list.filter((f) => f.embedding !== "restricted").map((f) => f.id);
      const bytes = new Map<string, Uint8Array>();
      for (const id of embeddable) {
        const b = await liveFontBytes(deps, file.orgId, file.id, id);
        if (b) bytes.set(id, b);
      }
      return out("pdf", await slidesPdf(deck, media, file.title, bytes));
    }
    return out("pptx", await writePptx(deck, media, new Map(own.list.map((f) => [f.id, f.family]))));
  }
  if (kind === "document") return documentExport(deps, file, doc, format);
  if (kind === "canvas" && (format === null || format === "json")) {
    // Plain data: its background and its shapes (text as rich paragraphs), the way the apps read them.
    const canvas = { kind: "canvas", v: 1, bg: canvasBackground(doc), shapes: readShapes(doc) };
    return out("json", new TextEncoder().encode(JSON.stringify(canvas)));
  }
  const asked = (format ?? kind).toUpperCase();
  throw new ValidationError(`${asked} export is not available for this file`, "artifact.format_unavailable");
}

/** The Drive's writer of live files' downloads, versions included (`setLiveExporter` at boot). */
export const officeLiveExporter: LiveExporter = ({ deps, artifact, kind, doc, format }) =>
  writeLiveExport(deps, artifact, kind, doc, format);

/** A download's name: the title's letters and digits, the format's extension. */
function exportName(title: string, ext: string) {
  const slug =
    title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "file";
  return `${slug}.${ext}`;
}

/**
 * A live file as it stands now, as an Office file, a CSV or a PDF (ADR 0198), for whoever reads it: what the
 * process holding it has (`deps.live`) or, without one, what is stored.
 */
export async function exportLive(
  deps: ArtifactDeps & { live?: LiveDocs },
  actor: ArtifactActor,
  orgId: string,
  fileId: string,
  format: LiveExportFormat,
): Promise<{ body: Uint8Array; contentType: string; filename: string }> {
  const access = await requireLiveFile(deps, actor, orgId, fileId);
  const a = access.artifact;
  let doc: Y.Doc;
  if (deps.live) doc = (await deps.live.read(orgId, fileId)).doc;
  else {
    const head = await loadHeadDoc(deps.db, orgId, fileId);
    if (head) doc = head.doc;
    else {
      // No live document (never one made here): its latest version.
      doc = new Y.Doc();
      Y.applyUpdate(doc, await liveSnapshotOf(deps, orgId, fileId, a.currentVersion));
    }
  }
  try {
    const made = await writeLiveExport(deps, a, access.kind, doc, format);
    return { body: made.body, contentType: made.contentType, filename: exportName(a.title, made.ext) };
  } finally {
    doc.destroy();
  }
}
