import { inflateSync } from "node:zlib";
import { PDF_MEDIA_TYPE, type ToolImage } from "@agenteschat/providers";
import { MODEL_IMAGE_BYTES, sniffModelImage } from "./avatars";
import { decodeXmlEntities, formatBytes, tableToCsv, textOfBytes } from "./format";
import { inflateZipEntry, listZip, type ZipListing } from "./zip";

/**
 * Any file as an AI reads it (`fileForModel`, `read_file`): a picture or a PDF as itself, text and code as text,
 * Word and PowerPoint as their text, a spreadsheet as CSV per sheet, a zip as its listing. What can't be shown gets a
 * note with the exact cause and one way out, never a bare "binary".
 */

/** A file past this is never read whole to be shown: a note says so. */
export const MODEL_FILE_READ_BYTES = 50_000_000;
/** The biggest PDF shown at once: its base64 fits a computer's 8 MB frame (`MAX_FRAME_BYTES`) with room to spare. */
export const MODEL_PDF_BYTES = 5_000_000;
/** The most pages a PDF shown at once may have (Anthropic's limit per request). */
export const MODEL_PDF_PAGES = 100;
/** Text decoded from a file of no known text type, at most (a log or code under an odd type). */
const ANY_TEXT_BYTES = 5_000_000;
/** A declared text type (`text/csv`, `application/json`, YAML, XML): decoded at any size, `read_artifact` pages it. */
const TEXT_TYPE = /^text\/|json|xml|yaml/;
/** One part of an Office file (a sheet, the document's XML) inflated, at most: also all of one an app reads (ADR 0198). */
export const OFFICE_PART_BYTES = 40_000_000;
const ZIP_LIST_MAX = 300;
const SHEET_ROWS_MAX = 5000;
/** Excel's last column (XFD): a cell past it is no real cell, and would make every row that wide. */
const SHEET_COLUMNS_MAX = 16_384;

export interface ModelFile {
  /** What the AI reads as text (the file's own text, or what was read out of it). */
  text?: string;
  /** Pictures and PDFs shown with the result. */
  images?: ToolImage[];
  /** One sentence on what was shown, or why it can't be and the way out. */
  note: string;
  /** An audio file: its words come from the speech service (`fileForModel`). */
  audio?: true;
}

const extensionOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "ogg", "oga", "opus", "wav", "aac", "flac", "weba"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v", "wmv", "3gp"]);
const PICTURE_EXTENSIONS = new Set(["heic", "heif", "bmp", "tif", "tiff", "avif", "ico", "raw", "cr2", "nef", "psd"]);
const OLD_OFFICE: Record<string, string> = { doc: "docx", xls: "xlsx", ppt: "pptx" };
const WITH_COMPUTER = "With a computer, import_file copies it there to open with your own tools.";

/** The type a file's name and declared type say (`.ts` declared `video/mp2t` is code, not video). */
export const isAudioFile = (name: string, contentType: string) =>
  contentType.startsWith("audio/") || AUDIO_EXTENSIONS.has(extensionOf(name));
const isVideoFile = (name: string, contentType: string) =>
  (contentType.startsWith("video/") && contentType !== "video/mp2t") || VIDEO_EXTENSIONS.has(extensionOf(name));

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05);
const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

// Uploaded files are untrusted: every pattern here runs in linear time (no quantifier that can re-scan what another
// start already scanned), so a crafted file can't stall the server.
const PAGE_OBJECT = /\/Type\s*\/Page(?![a-zA-Z])/g;
const PAGES_TYPE = /\/Type\s*\/Pages\b/;
const COUNT = /\/Count\s+(\d+)/g;
const OBJECT_STREAM = /\/Type\s*\/ObjStm/g;
const STREAM_START = />>\s*stream\r?\n/y;
/** What one compressed object stream may inflate to: past it, its pages go uncounted. */
const OBJECT_STREAM_BYTES = 64_000_000;

/** Where each `/Type /ObjStm` dictionary's stream starts and ends (`endstream`), in one pass. */
function objectStreams(latin1: string): [number, number][] {
  const found: [number, number][] = [];
  OBJECT_STREAM.lastIndex = 0;
  for (let m = OBJECT_STREAM.exec(latin1); m; m = OBJECT_STREAM.exec(latin1)) {
    const close = latin1.indexOf(">", m.index + m[0].length);
    if (close < 0) break;
    STREAM_START.lastIndex = close;
    const head = STREAM_START.exec(latin1);
    if (!head) {
      OBJECT_STREAM.lastIndex = close;
      continue;
    }
    const start = close + head[0].length;
    const end = latin1.indexOf("endstream", start);
    if (end < 0) break;
    found.push([start, end]);
    OBJECT_STREAM.lastIndex = end;
  }
  return found;
}

/**
 * A PDF's pages (at least one): its page objects or its page tree's `/Count`, whichever says more, read in the
 * compressed object streams too (PDF 1.5+, where most generators keep them), so a long PDF never passes as short.
 */
export function pdfPages(bytes: Uint8Array): number {
  const latin1 = new TextDecoder("latin1").decode(bytes);
  const parts = [latin1];
  for (const [start, end] of objectStreams(latin1)) {
    try {
      parts.push(inflateSync(bytes.subarray(start, end), { maxOutputLength: OBJECT_STREAM_BYTES }).toString("latin1"));
    } catch {
      // Not Flate, cut, or too big: its pages go uncounted.
    }
  }
  let pages = 1;
  for (const part of parts) {
    pages = Math.max(pages, part.match(PAGE_OBJECT)?.length ?? 0);
    // A page tree's `/Count` sits in the same dictionary as its `/Type /Pages`, with no `>` between them.
    for (const dict of part.split(">")) {
      if (!PAGES_TYPE.test(dict)) continue;
      for (const m of dict.matchAll(COUNT)) pages = Math.max(pages, Number(m[1]));
    }
  }
  return pages;
}

/** What the AI is told of a file past `MODEL_FILE_READ_BYTES`, read by its name and type alone. */
export const tooBigToReadNote = (name: string, contentType: string, size: number) =>
  `It is a file of ${formatBytes(size)} (${extensionOf(name) ? `.${extensionOf(name)}, ` : ""}${contentType}), too big to open here. Tell the person exactly that. ${WITH_COMPUTER}`;

/** What `readForModel` makes of one file's bytes (an audio file's words are the caller's). */
export function readForModel(file: { name: string; contentType: string; bytes: Uint8Array }): ModelFile {
  const { name, contentType, bytes } = file;
  const ext = extensionOf(name);
  const size = formatBytes(bytes.byteLength);
  const picture = sniffModelImage(bytes);
  if (picture) {
    if (bytes.byteLength <= MODEL_IMAGE_BYTES) {
      return {
        images: [{ mediaType: picture, data: Buffer.from(bytes).toString("base64") }],
        note: "It is a picture: shown to you with this result.",
      };
    }
    return {
      note: `It is a picture of ${size}, past the ${formatBytes(MODEL_IMAGE_BYTES)} an AI is shown at once, so it can't be shown to you here. Tell the person exactly that: a screenshot or a smaller copy of it would go through. ${WITH_COMPUTER}`,
    };
  }
  if (isPdf(bytes)) {
    const pages = pdfPages(bytes);
    if (bytes.byteLength <= MODEL_PDF_BYTES && pages <= MODEL_PDF_PAGES) {
      return {
        images: [{ mediaType: PDF_MEDIA_TYPE, data: Buffer.from(bytes).toString("base64"), pages, name }],
        note: `It is a PDF (${pages} ${pages === 1 ? "page" : "pages"}): shown to you with this result.`,
      };
    }
    return {
      note: `It is a PDF of ${size} and ${pages} pages, past the ${formatBytes(MODEL_PDF_BYTES)} and ${MODEL_PDF_PAGES} pages an AI is shown at once, so it can't be shown to you here. Tell the person exactly that: the pages that matter as a smaller PDF would go through. ${WITH_COMPUTER}`,
    };
  }
  if (isZip(bytes)) return zipForModel(ext, bytes, size);
  if ((bytes.byteLength <= ANY_TEXT_BYTES || TEXT_TYPE.test(contentType)) && !isAudioFile(name, contentType)) {
    const text = textOfBytes(bytes);
    if (text !== null) return { text, note: "" };
  }
  if (isAudioFile(name, contentType)) return { audio: true, note: "" };
  if (isVideoFile(name, contentType)) {
    return {
      note: `It is a video (${size}), not shown to you as it is: review_media watches it on a computer, with frames across all of it and what is said, with times. Without a computer, tell the person exactly that: its sound as an audio file, or a few screenshots of it, would go through.`,
    };
  }
  if (OLD_OFFICE[ext]) {
    return {
      note: `It is an older Office file (.${ext}), which can't be read here. Tell the person exactly that: the same file saved as .${OLD_OFFICE[ext]} or PDF would go through. ${WITH_COMPUTER}`,
    };
  }
  if (contentType.startsWith("image/") || PICTURE_EXTENSIONS.has(ext)) {
    return {
      note: `It is a picture in a format AIs can't open (${ext ? `.${ext}` : contentType}). Tell the person exactly that: the same picture as PNG or JPEG (a screenshot of it works) would go through. ${WITH_COMPUTER}`,
    };
  }
  return {
    note: `It is a binary file (${ext ? `.${ext}, ` : ""}${contentType}, ${size}) that can't be shown to you as it is. Tell the person exactly that. ${WITH_COMPUTER}`,
  };
}

function zipForModel(ext: string, bytes: Uint8Array, size: string): ModelFile {
  let entries: ZipListing[];
  try {
    entries = listZip(bytes);
  } catch (error) {
    return {
      note: `It is a zip-based file (${size}) that couldn't be opened: ${error instanceof Error ? error.message : String(error)}. Tell the person exactly that. ${WITH_COMPUTER}`,
    };
  }
  const part = (path: string) => {
    const e = entries.find((x) => x.path === path);
    return e && e.size <= OFFICE_PART_BYTES ? decodeUtf8(inflateZipEntry(bytes, e)) : null;
  };
  try {
    if (ext === "docx" || ext === "docm" || entries.some((e) => e.path === "word/document.xml")) {
      const xml = part("word/document.xml");
      if (xml !== null) return { text: docxText(xml), note: "Its text, read out of the Word document, follows." };
    }
    if (ext === "pptx" || entries.some((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.path))) {
      const slides = entries
        .map((e) => ({ e, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(e.path)?.[1] ?? Number.NaN) }))
        .filter((s) => Number.isFinite(s.n))
        .sort((a, b) => a.n - b.n);
      const text = slides
        .map(({ e, n }) => `## Slide ${n}\n${pptxText(part(e.path) ?? "")}`)
        .join("\n\n")
        .trim();
      return { text, note: "Its text, slide by slide, follows." };
    }
    if (ext === "xlsx" || ext === "xlsm" || entries.some((e) => e.path === "xl/workbook.xml")) {
      return { text: xlsxText(part), note: "Its sheets follow, each as CSV." };
    }
  } catch (error) {
    return {
      note: `It is an Office file (${size}) that couldn't be read: ${error instanceof Error ? error.message : String(error)}. Tell the person exactly that. ${WITH_COMPUTER}`,
    };
  }
  const listed = entries
    .slice(0, ZIP_LIST_MAX)
    .map((e) => `${e.path} (${formatBytes(e.size)})`)
    .join("\n");
  const more = entries.length > ZIP_LIST_MAX ? `\n…and ${entries.length - ZIP_LIST_MAX} more files` : "";
  return {
    text: `${listed}${more}`,
    note: `It is a zip archive (${size}, ${entries.length} files), listed below; their contents aren't shown here. With a computer, import_file copies it there to unpack it.`,
  };
}

const decodeUtf8 = (b: Uint8Array) => new TextDecoder("utf-8").decode(b);

/** The runs of text in Office XML (`<w:t>`, `<a:t>`, `<t>`), one line per paragraph. */
function runsText(xml: string, paragraph: RegExp, run: RegExp): string {
  return xml
    .split(paragraph)
    .map((p) =>
      [...p.matchAll(run)]
        .map((m) => (m[1] === undefined ? "\t" : decodeXmlEntities(m[1])))
        .join("")
        .trimEnd(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const docxText = (xml: string) =>
  runsText(xml, /<\/w:p>/, /<w:t(?:\s[^<>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<\/w:tc>/g);

export const pptxText = (xml: string) => runsText(xml, /<\/a:p>/, /<a:t(?:\s[^<>]*)?>([^<]*)<\/a:t>/g);

const TEXT_RUN = /<t(?:\s[^<>]*)?>([^<]*)<\/t>/g;
const runText = (xml: string) => [...xml.matchAll(TEXT_RUN)].map((t) => decodeXmlEntities(t[1] ?? "")).join("");

/** What each `<open>…</close>` holds, in order: the first `open` before each `close` (a lazy match, in one pass). */
const bodiesOf = (xml: string, open: string, close: string) =>
  xml
    .split(close)
    .slice(0, -1)
    .flatMap((chunk) => {
      const at = chunk.indexOf(open);
      return at < 0 ? [] : [chunk.slice(at + open.length)];
    });

const CELL_HEAD = /<c\b([^<>]*?)(\/?)>/g;

/** Each `<c …>` of a sheet: its attributes and what it holds (empty when it closes itself). */
function cellsOf(xml: string): { attrs: string; body: string }[] {
  const cells: { attrs: string; body: string }[] = [];
  // Once no `</c>` is left, only the cells that close themselves can still be read.
  let closes = true;
  CELL_HEAD.lastIndex = 0;
  for (let m = CELL_HEAD.exec(xml); m; m = CELL_HEAD.exec(xml)) {
    if (m[2]) {
      cells.push({ attrs: m[1] ?? "", body: "" });
      continue;
    }
    if (!closes) continue;
    const start = m.index + m[0].length;
    const end = xml.indexOf("</c>", start);
    if (end < 0) {
      closes = false;
      continue;
    }
    cells.push({ attrs: m[1] ?? "", body: xml.slice(start, end) });
    CELL_HEAD.lastIndex = end + 4;
  }
  return cells;
}

/** A column's letters as its index (`A` → 0, `AB` → 27). */
const columnIndex = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

/** Every sheet of a workbook as CSV under its name (shared strings, inline strings, numbers and booleans). */
export function xlsxText(part: (path: string) => string | null): string {
  const strings = bodiesOf(part("xl/sharedStrings.xml") ?? "", "<si>", "</si>").map(runText);
  const rels = new Map(
    [...(part("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^<>]*>/g)].flatMap((m) => {
      const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
      const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
      return id && target ? [[id, target.replace(/^\/?xl\//, "")] as const] : [];
    }),
  );
  const sheets = [...(part("xl/workbook.xml") ?? "").matchAll(/<sheet\b[^<>]*>/g)].map((m, i) => ({
    name: decodeXmlEntities(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? `Sheet${i + 1}`),
    target: rels.get(/\br:id="([^"]+)"/.exec(m[0])?.[1] ?? "") ?? `worksheets/sheet${i + 1}.xml`,
  }));
  return sheets
    .map(({ name, target }) => {
      const grid: string[][] = [];
      let cut = false;
      for (const { attrs, body } of cellsOf(part(`xl/${target}`) ?? "")) {
        const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
        if (!ref) continue;
        const row = Number(ref[2]) - 1;
        if (row >= SHEET_ROWS_MAX) {
          cut = true;
          continue;
        }
        const column = columnIndex(ref[1] ?? "A");
        if (column >= SHEET_COLUMNS_MAX) continue;
        const type = /\bt="(\w+)"/.exec(attrs)?.[1];
        const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        const value =
          type === "s"
            ? (strings[Number(v)] ?? "")
            : type === "inlineStr"
              ? runText(body)
              : type === "b"
                ? v === "1"
                  ? "TRUE"
                  : "FALSE"
                : decodeXmlEntities(v ?? "");
        const cells = grid[row] ?? [];
        grid[row] = cells;
        cells[column] = value;
      }
      const width = Math.max(0, ...grid.map((r) => r?.length ?? 0));
      const rows = Array.from(grid, (r) => Array.from({ length: width }, (_, i) => r?.[i] ?? ""));
      const csv = rows.length ? tableToCsv(rows[0] ?? [], rows.slice(1)) : "(empty)";
      return `## Sheet: ${name}\n${csv}${cut ? `\n[Only the first ${SHEET_ROWS_MAX} rows are shown.]` : ""}`;
    })
    .join("\n\n");
}

/** Where a file version's transcript is kept, beside its bytes: made once, gone with them. */
export const transcriptKey = (blobKey: string) => `${blobKey}.transcript.txt`;
