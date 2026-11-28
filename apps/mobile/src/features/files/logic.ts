import type { ArtifactDetail, ArtifactKind } from "@agenteschat/client";
import { extensionOf, fileIcon, isMarkdownFile, previewKind, previewType } from "@agenteschat/client/lib/files";
import { filePath } from "@agenteschat/client/lib/message-links";
import { type LiveScreen, liveRoute, opensLive, type PhoneLiveKind } from "../live-files/routes";

/**
 * Files on a message: which ones show as pictures, the card's tile and
 * line ("MD", "Documento · 4 KB"), how a viewer shows each, and the name a shared copy gets.
 */

/**
 * How the app shows a file: inline picture or video, the document screen (Markdown, text, PDF, an audio file's
 * player), a live file's own screen (ADR 0196), an Office file as the server read it (ADR 0198: a workbook's grid, a
 * deck's slides, a Word document's page; an old table in the same grid), or only its card.
 */
export type FileView =
  | "image"
  | "video"
  | "audio"
  | "markdown"
  | "text"
  | "pdf"
  | "html"
  | "live"
  | "sheet"
  | "deck"
  | "word"
  | "other";

/** The word under the name ("Imagem", "PDF", "Documento"…): `mobile.files.type.<key>`. */
export type FileTypeKey =
  | "image"
  | "video"
  | "pdf"
  | "document"
  | "table"
  | "code"
  | "archive"
  | "diff"
  | "diagram"
  | "page"
  | "text"
  | "spreadsheet"
  | "slides"
  | "canvas"
  | "file";

export interface FileInfo {
  /** The name shown, with its extension ("Resumo da home.md", "home.png"). */
  name: string;
  view: FileView;
  type: FileTypeKey;
  /** The tile's label: the extension in capitals, at most 4 letters ("MD", "PDF", "CSV"). */
  ext: string;
  /** Bytes, when known. */
  size: number | null;
  /** The clean MIME type ("" when unknown). */
  mime: string;
}

/** Raster types the app draws (expo-image); SVG and the rest open as a card. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"]);
/** Video types the phones play (expo-video); WebM only plays on Android, so iPhone falls back to the card. */
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/x-m4v", "video/webm"]);
/** Names that already say "video" while the file's details load (no jump from card to player). */
export const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "webm"]);
/** Names that say "picture": while the details load, and when the stored type doesn't (an upload typed as bytes). */
export const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"]);
const TEXT_EXT = new Set(["txt", "log", "csv", "tsv", "json", "yml", "yaml", "toml", "xml", "ini", "env"]);

/** Non-file artifacts: the extension their download gets (as the server names them). */
const KIND_EXT: Record<Exclude<ArtifactKind, "file">, string> = {
  document: "md",
  table: "csv",
  diff: "patch",
  diagram: "mmd",
  html: "html",
  block: "html",
  poll: "json",
  choices: "json",
  // A live file downloads as the Office file other apps open (ADR 0198); a canvas as its shapes.
  spreadsheet: "xlsx",
  slides: "pptx",
  canvas: "json",
};

const KIND_TYPE: Record<Exclude<ArtifactKind, "file">, FileTypeKey> = {
  document: "document",
  table: "table",
  diff: "diff",
  diagram: "diagram",
  html: "page",
  block: "page",
  poll: "file",
  choices: "file",
  spreadsheet: "spreadsheet",
  slides: "slides",
  canvas: "canvas",
};

export { extensionOf, isCodeName } from "@agenteschat/client/lib/files";

/** The tile's label: "MD", "PDF", "JPEG" (4 letters at most); "" → the caller shows an icon. */
export const extLabel = (ext: string) => ext.slice(0, 4).toUpperCase();

/** UTF-8 bytes of a text (the size of a document artifact, which has no stored size here). */
export function utf8Bytes(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Adds `.ext` unless the name already ends with it. */
export function withExtension(name: string, ext: string): string {
  if (!ext) return name;
  return extensionOf(name) === ext.toLowerCase() ? name : `${name}.${ext}`;
}

/** What a viewer and a card need to know about an artifact. */
export function fileInfo(a: Pick<ArtifactDetail, "kind" | "title" | "content">): FileInfo {
  const c = a.content;
  if (c.kind === "file") {
    const name = c.name || a.title;
    const ext = extensionOf(name);
    const mime = previewType(c.contentType);
    // The type says what it is; a file stored as plain bytes goes by its name.
    const untyped = !mime || mime === "application/octet-stream";
    // Spreadsheets, decks and Word documents the server reads for the app to draw (ADR 0198), CSV included.
    const office = OFFICE_VIEW[previewKind(mime, name) ?? ""];
    let view: FileView = "other";
    if (IMAGE_TYPES.has(mime) || (untyped && IMAGE_EXT.has(ext))) view = "image";
    else if (VIDEO_TYPES.has(mime) || (untyped && VIDEO_EXT.has(ext))) view = "video";
    else if (mime === "application/pdf" || ext === "pdf") view = "pdf";
    else if (previewKind(mime) === "audio" || (untyped && previewKind("", name) === "audio")) view = "audio";
    else if (office) view = office;
    // A page is shown as a page (its source isn't the point), before the text types it is one of.
    else if (mime === "text/html" || ext === "html" || ext === "htm") view = "html";
    else if (isMarkdownFile(name, mime)) view = "markdown";
    else if (TEXT_EXT.has(ext) || mime.startsWith("text/")) view = "text";
    return { name, view, type: fileType(name, mime, view), ext: extLabel(ext), size: c.size, mime };
  }
  const ext = KIND_EXT[c.kind];
  const name = withExtension(a.title, ext);
  // A document is a live file (ADR 0200): it opens on its own screen as every live kind.
  const view: FileView = opensLive(c.kind)
    ? "live"
    : c.kind === "html"
      ? "html"
      : c.kind === "table"
        ? "sheet"
        : "other";
  const size = c.kind === "document" ? utf8Bytes(c.markdown) : null;
  return { name, view, type: KIND_TYPE[c.kind], ext: extLabel(ext), size, mime: "" };
}

/** The Office previews, by the kind `previewKind` names them. */
const OFFICE_VIEW: Record<string, FileView> = {
  "office-sheet": "sheet",
  "office-slides": "deck",
  "office-doc": "word",
};

function fileType(name: string, mime: string, view: FileView): FileTypeKey {
  if (view === "image") return "image";
  if (view === "video") return "video";
  if (view === "pdf") return "pdf";
  if (view === "markdown") return "document";
  const icon = fileIcon(name, mime);
  if (icon === "image") return "image";
  if (icon === "table") return "table";
  if (icon === "code") return "code";
  if (icon === "archive") return "archive";
  if (icon === "page") return "page";
  if (icon === "slides") return "slides";
  if (icon === "document") return view === "text" ? "text" : "document";
  return view === "text" ? "text" : "file";
}

/**
 * A video's height for `width` in a message: one box (16:9), the video whole inside it. Its own shape is known only
 * once it loads, and a box that took it then would move the rows around it.
 */
export const videoHeight = (width: number) => Math.round((width * 9) / 16);

/** "0:07", "12:05", "1:02:09": a video's time. */
export function videoClock(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A lone picture's height for `width`: one box (4:3), the picture whole inside it, for the video's reason. */
export const singleImageHeight = (width: number) => Math.round(width * 0.75);

/** The tallest a lone picture of known shape gets (a portrait one narrows to fit). */
export const MAX_PICTURE_HEIGHT = 400;

/**
 * A lone picture's box at most `width` wide: in its own proportions when its size is known (`ratio`, as the web's
 * `[data-ratio]` tile), no taller than `MAX_PICTURE_HEIGHT`; else the one 4:3 box.
 */
export function singleImageBox(width: number, ratio: number | undefined): { width: number; height: number } {
  if (!ratio) return { width, height: singleImageHeight(width) };
  const height = Math.round(width / ratio);
  return height <= MAX_PICTURE_HEIGHT
    ? { width, height }
    : { width: Math.round(MAX_PICTURE_HEIGHT * ratio), height: MAX_PICTURE_HEIGHT };
}

/**
 * A video's box for `width` in a message, set before it loads: its own shape when the server read its size (a lone
 * picture's box, an upright one narrowed to fit), else 16:9 (`videoHeight`).
 */
export const videoBox = (width: number, ratio: number | undefined) =>
  ratio ? singleImageBox(width, ratio) : { width, height: videoHeight(width) };

/**
 * A safe file name for a copy in the cache (and the name the share sheet shows): no folders, no
 * characters iOS or other apps refuse, not empty, not too long (the extension is kept).
 */
export function safeFileName(name: string, fallback = "file"): string {
  const cleaned = name
    .normalize("NFC")
    // Path separators and characters file systems refuse.
    .replace(/[/\\:*?"<>|]/g, "-")
    // Control characters.
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    // No leading dots (hidden files) or trailing dots/spaces.
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  const base = cleaned || fallback;
  const MAX = 120;
  if (base.length <= MAX) return base;
  const ext = extensionOf(base);
  if (!ext) return base.slice(0, MAX).trim();
  const stem = base.slice(0, base.length - ext.length - 1);
  return `${stem.slice(0, MAX - ext.length - 1).trim()}.${ext}`;
}

/** The web Drive opened at this file (`filePath`), the address a file's link carries. */
export function driveWebUrl(apiUrl: string, orgId: string, id: string, version?: number): string {
  return `${apiUrl.replace(/\/+$/, "")}${filePath(orgId, id, version)}`;
}

/** A download URL the server returned: signed (absolute, no session needed) or ours (relative, needs it). */
export function resolveDownloadUrl(apiUrl: string, url: string): { uri: string; needsSession: boolean } {
  if (/^https?:\/\//i.test(url)) {
    // A signed storage URL can share the API URL's text prefix without sharing
    // its origin. Never send the app session cookie to that host.
    return { uri: url, needsSession: new URL(url).origin === new URL(apiUrl).origin };
  }
  const base = apiUrl.replace(/\/+$/, "");
  return { uri: `${base}${url.startsWith("/") ? "" : "/"}${url}`, needsSession: true };
}

/**
 * Where a shared copy comes from: the text the app already has (documents, diagrams, pages, small
 * text files), or a download (uploaded files, tables and code changes as CSV / .patch exports, live files as the
 * Office file other apps open).
 */
export type ShareSource =
  | { from: "text"; text: string; name: string; mime: string }
  | { from: "download"; name: string; mime: string }
  /** Made by the server: a table's CSV, a change's .patch, a live file as it is now (no format: a canvas's JSON). */
  | { from: "export"; format?: "csv" | "patch" | "xlsx" | "pptx"; name: string; mime: string };

export function shareSource(a: Pick<ArtifactDetail, "kind" | "title" | "content">): ShareSource {
  const info = fileInfo(a);
  const name = safeFileName(info.name);
  const c = a.content;
  switch (c.kind) {
    case "document":
      return { from: "text", text: c.markdown, name, mime: "text/markdown" };
    case "diagram":
      return { from: "text", text: c.mermaid, name, mime: "text/plain" };
    case "html":
      return { from: "text", text: c.html, name, mime: "text/html" };
    case "block":
      return c.spec
        ? {
            from: "text",
            text: JSON.stringify(c.spec, null, 2),
            name: safeFileName(withExtension(a.title, "json")),
            mime: "application/json",
          }
        : { from: "text", text: c.html ?? "", name, mime: "text/html" };
    case "poll":
      return { from: "text", text: [c.question, ...c.options].join("\n"), name, mime: "text/plain" };
    case "choices":
      return {
        from: "text",
        text: c.questions.map((q) => [q.question, ...q.options.map((o) => o.label)].join("\n")).join("\n\n"),
        name,
        mime: "text/plain",
      };
    case "table":
      return { from: "export", format: "csv", name, mime: "text/csv" };
    case "diff":
      return { from: "export", format: "patch", name, mime: "text/x-patch" };
    // A live file as the Office file other apps open, made from it as it is now (ADR 0198).
    case "spreadsheet":
      return {
        from: "export",
        format: "xlsx",
        name,
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      };
    case "slides":
      return {
        from: "export",
        format: "pptx",
        name,
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      };
    case "canvas":
      return { from: "export", name, mime: "application/json" };
    case "file":
      return { from: "download", name, mime: info.mime };
  }
}

/** The picture `by` away in the viewer, which doesn't wrap round: its index, or null past the first or the last. */
export function pageStep(index: number, by: -1 | 1, count: number): number | null {
  const to = index + by;
  return to >= 0 && to < count ? to : null;
}

/** `id@version` pairs for the picture viewer's route (`?files=a@2,b@1`), and back. */
export function encodeFileList(files: { id: string; version?: number | undefined }[]): string {
  return files.map((f) => (f.version ? `${f.id}@${f.version}` : f.id)).join(",");
}

/** A file as it's opened from where it shows: what's known of it before (or once) its details load. */
export interface FileRef {
  id: string;
  /** The version shown there, when it's a particular one. */
  version?: number | undefined;
  /** Its name: "print.png" already says it's a picture while its details load. */
  title?: string | undefined;
  kind?: ArtifactKind | undefined;
  /** Its details, once loaded: what it is for sure. */
  detail?: Pick<ArtifactDetail, "kind" | "title" | "content" | "shownVersion" | "version"> | undefined;
}

/**
 * A picture or a video, which open in the picture viewer: by its details when they're known (`fileInfo`), else by
 * its name, as `fileInfo` reads an upload stored without a type.
 */
export function isMediaFile(ref: FileRef): boolean {
  if (ref.detail) {
    const view = fileInfo(ref.detail).view;
    return view === "image" || view === "video";
  }
  if (ref.kind !== undefined && ref.kind !== "file") return false;
  const ext = extensionOf(ref.title ?? "");
  return IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext);
}

export type FileRoute =
  | { pathname: "/images"; params: { files: string; at: string; from?: string } }
  | { pathname: "/file/[id]"; params: { id: string; v?: string } }
  | { pathname: LiveScreen; params: { id: string } };

/** A live file's kind, from its details or from the kind the place names (ADR 0196). */
export function liveKindOfRef(ref: FileRef): PhoneLiveKind | null {
  const kind = ref.detail?.kind ?? ref.kind;
  return opensLive(kind) ? kind : null;
}

/**
 * Where a file opens, the one way in from every place that shows one: a picture or a video straight in the picture
 * viewer, among the pictures and videos beside it (`siblings`, in the order they show, so the viewer pages through
 * them) at the one tapped; a live file on its own screen, as it is now (ADR 0196 §9); anything else in the file screen,
 * at an older version when that's the one shown. `from`: the deck it opened from, told where the person stops.
 */
export function fileRoute(ref: FileRef, siblings?: readonly FileRef[], from?: string): FileRoute {
  const live = liveKindOfRef(ref);
  if (live) return liveRoute(live, ref.id);
  if (!isMediaFile(ref)) {
    // Its details say whether the version shown is an older one; without them, the version the place names.
    const older = ref.detail && ref.detail.shownVersion < ref.detail.version ? ref.detail.shownVersion : undefined;
    const v = ref.detail ? older : ref.version;
    return { pathname: "/file/[id]", params: { id: ref.id, ...(v ? { v: String(v) } : {}) } };
  }
  const media = (siblings ?? []).filter(isMediaFile);
  const at = media.findIndex((f) => f.id === ref.id);
  const pages = at >= 0 ? media : [ref];
  return {
    pathname: "/images",
    params: {
      files: encodeFileList(pages.map((f) => ({ id: f.id, version: f.detail?.shownVersion ?? f.version }))),
      at: String(Math.max(at, 0)),
      ...(from ? { from } : {}),
    },
  };
}

export function decodeFileList(raw: string | string[] | undefined): { id: string; version?: number }[] {
  const s = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  return s.split(",").flatMap((part) => {
    const [id = "", v] = part.trim().split("@");
    if (!/^[\w-]{1,64}$/.test(id)) return [];
    const n = v ? Number(v) : Number.NaN;
    return [Number.isInteger(n) && n > 0 ? { id, version: n } : { id }];
  });
}

/** Names that are never a picture or a video: they open the file screen without asking for the details first. */
const DOCUMENT_EXT = new Set([
  ...["md", "markdown", "mdx", "txt", "log", "csv", "tsv", "json", "yml", "yaml", "toml", "xml", "ini", "env"],
  ...["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "html", "htm"],
  ...["zip", "tar", "gz", "patch", "diff", "js", "ts", "tsx", "py", "rb", "go", "rs", "java", "swift", "sql", "sh"],
]);

/**
 * Its details, or its kind and name, already say where a file opens: a picture's or a video's name, or a document's.
 * A name with no extension, or one the app doesn't know (a video in a rarer format), says nothing.
 */
export function whereKnown(ref: FileRef): boolean {
  if (ref.detail) return true;
  if (ref.kind !== undefined && ref.kind !== "file") return true;
  return isMediaFile(ref) || DOCUMENT_EXT.has(extensionOf(ref.title ?? ""));
}

/**
 * A long text in pieces of at most `lines` lines and `chars` characters each, drawn one under the other: one text view
 * as tall as a long file goes past what the phone can draw in one piece, and showed blank. A line longer than a piece
 * (minified code, data on one line) is cut into pieces of its own, so a cut inside a line falls between two pieces and
 * every newline left inside a piece is the text's own.
 */
export function textChunks(text: string, lines = 120, chars = 6000): string[] {
  const out: string[] = [];
  let piece: string[] = [];
  let size = 0;
  for (const whole of text.split("\n")) {
    for (const line of lineParts(whole, chars)) {
      if (piece.length > 0 && (piece.length >= lines || size + line.length > chars)) {
        out.push(piece.join("\n"));
        piece = [];
        size = 0;
      }
      piece.push(line);
      size += line.length + 1;
    }
  }
  if (piece.length > 0 || out.length === 0) out.push(piece.join("\n"));
  return out;
}

/** `line` in parts of at most `size` characters, never between the two halves of one character (an emoji). */
function lineParts(line: string, size: number): string[] {
  const parts: string[] = [];
  let at = 0;
  while (line.length - at > size) {
    let end = at + size;
    const code = line.charCodeAt(end);
    if (code >= 0xdc00 && code <= 0xdfff) end -= 1;
    parts.push(line.slice(at, end));
    at = end;
  }
  parts.push(line.slice(at));
  return parts;
}

// ── A PDF's first page on its cards (`pdf-preview.tsx`) ──────────────────────────────────────────────────────────

/**
 * The most a PDF may weigh for a card to draw its first page: the phone's renderer reads the whole file, and past this
 * a card would download a large file only to show the top of a page. Heavier ones keep their type's tile.
 */
export const PDF_PREVIEW_MAX_BYTES = 15 * 1024 * 1024;

/** The query a PDF's copy in the cache and its pages' sizes are read under: its screen and its previews share it. */
export const pdfCopyKey = (orgId: string, id: string, version: number) =>
  ["org", orgId, "artifacts", "pdf", id, version] as const;

/** A PDF whose first page a card draws: a file read as a PDF, of a known size up to `PDF_PREVIEW_MAX_BYTES`. */
export function pdfPreviewable(detail: Pick<ArtifactDetail, "kind" | "title" | "content"> | undefined): boolean {
  if (detail?.content.kind !== "file") return false;
  const info = fileInfo(detail);
  return info.view === "pdf" && info.size !== null && info.size > 0 && info.size <= PDF_PREVIEW_MAX_BYTES;
}

/** A file picked on the phone that is a PDF (by its type, else by its name). */
export const isLocalPdf = (f: { type: string; name: string }) =>
  f.type === "application/pdf" || extensionOf(f.name) === "pdf";

/**
 * The path the renderer reads for a file on the phone: it takes a path, not a link, and only drops `file://` from one
 * (a picked file's name keeps its spaces and accents escaped in the link, which the path must not have).
 */
export function localPdfPath(uri: string): string {
  const path = uri.replace(/^file:\/\//, "");
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
