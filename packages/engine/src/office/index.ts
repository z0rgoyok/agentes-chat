import type { DeckData, WorkbookData } from "@agenteschat/live";
import { readCsv } from "./csv";
import { OFFICE_LIMITS, officeTooLarge, officeUnreadable, officeUnsupported } from "./limits";
import { readOds } from "./ods-read";
import { isCompoundFile, isZipFile } from "./package";
import { readPptx } from "./pptx-read";
import { readBiff } from "./xls-read";
import { readXlsx } from "./xlsx-read";

/**
 * Office files on the server (ADR 0198): uploaded workbooks, decks and Word documents read into what the apps draw
 * (`WorkbookData`, `DeckData`, clean HTML, a live document's blocks), and live files written out as `.xlsx`, `.csv`,
 * `.pptx`, `.docx` and PDF.
 */

export { readCsv, writeCsv } from "./csv";
export { type DocxDocument, type DocxDocumentPicture, docxToDocument } from "./docx-document";
export { docxToHtml, docxToMarkdown } from "./docx-html";
export { type DocxMediaReader, writeDocx } from "./docx-write";
export {
  isOfficeError,
  OFFICE_LIMITS,
  officeEncrypted,
  officeTooLarge,
  officeTooLargeToEdit,
  officeUnreadable,
  officeUnsupported,
} from "./limits";
export { odsFormula, readOds } from "./ods-read";
export { readPptx } from "./pptx-read";
export { type DeckMediaReader, writePptx } from "./pptx-write";
export { slidesPdf } from "./slides-pdf";
export { readBiff, readXls } from "./xls-read";
export { BUILTIN_NUMBER_FORMATS, readXlsx } from "./xlsx-read";
export { writeXlsx } from "./xlsx-write";

/** The Office formats the server reads, by what they are. */
export type OfficeFormat = "xlsx" | "xls" | "ods" | "csv" | "tsv" | "pptx" | "docx";

/** What an Office file is drawn as: a workbook, a deck or a document. */
export type OfficeFileKind = "workbook" | "deck" | "document";

const BY_EXTENSION: Record<string, OfficeFormat> = {
  xlsx: "xlsx",
  xlsm: "xlsx",
  xltx: "xlsx",
  xltm: "xlsx",
  xls: "xls",
  ods: "ods",
  csv: "csv",
  tsv: "tsv",
  pptx: "pptx",
  pptm: "pptx",
  ppsx: "pptx",
  potx: "pptx",
  docx: "docx",
  docm: "docx",
  dotx: "docx",
};

const BY_TYPE: Record<string, OfficeFormat> = {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

/** Which Office format a file is, by its name first and its declared type after; null for one the server doesn't read. */
export function officeFormatOf(name: string, contentType = ""): OfficeFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase() ?? "";
  const byName = BY_EXTENSION[ext];
  if (byName) return byName;
  return BY_TYPE[contentType.split(";")[0]?.trim().toLowerCase() ?? ""] ?? null;
}

/** What the apps draw a format as. */
export function officeKindOf(format: OfficeFormat): OfficeFileKind {
  return format === "pptx" ? "deck" : format === "docx" ? "document" : "workbook";
}

/**
 * Any workbook the server reads, by its name and type (and its bytes, when they say otherwise: an `.xls` that is
 * really an `.xlsx`, or the reverse), each on the server's own reader: `.xlsx`, `.xls` (BIFF8), `.ods`, and
 * `.csv`/`.tsv` as text.
 */
export async function readWorkbook(bytes: Uint8Array, name: string, contentType = ""): Promise<WorkbookData> {
  if (bytes.byteLength > OFFICE_LIMITS.inputBytes) throw officeTooLarge("size");
  const format = officeFormatOf(name, contentType);
  if (format === "csv" || format === "tsv") return readCsv(bytes, name);
  if (format === "xlsx" || format === "xls" || format === "ods") {
    if (isZipFile(bytes)) return format === "ods" ? readOds(bytes) : readXlsx(bytes);
    if (isCompoundFile(bytes)) return readBiff(bytes);
    // Old exports often save their text as `.xls`; anything else under a workbook's name is no workbook.
    if (format === "xls") return readCsv(bytes, name);
    throw officeUnreadable("it is not a spreadsheet");
  }
  throw officeUnsupported(name);
}

/** A PowerPoint deck as data (`readPptx`): its slides in order, at 1920 units wide, its pictures in `media`. */
export async function readDeck(bytes: Uint8Array): Promise<DeckData> {
  return readPptx(bytes);
}
