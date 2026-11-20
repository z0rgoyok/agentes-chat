import { isDateFormat, MAX_A1_ROWS, type SheetData, type WorkbookData } from "@agenteschat/live";
import { OFFICE_LIMITS, officeTooLarge } from "./limits";

/**
 * Comma- and tab-separated files (ADR 0198): read into a one-sheet workbook (the separator found from the file, the
 * text in UTF-8 or, failing that, Windows-1252; numbers read as numbers when they are plainly numbers), and a sheet
 * written back as RFC 4180 CSV.
 */

/** The text of a file of unknown encoding: UTF-8 (byte order mark dropped), else Windows-1252 (old Excel exports). */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1252").decode(body);
  }
}

/** The separator a file uses: the one that splits its first lines into the same, largest number of fields. */
export function guessSeparator(text: string, name = ""): string {
  if (/\.tsv$/i.test(name)) return "\t";
  const sample = text.slice(0, 16_384);
  let best = ",";
  let bestScore = -1;
  for (const sep of [",", ";", "\t", "|"]) {
    const counts = splitRecords(sample, sep, 20)
      .slice(0, -1)
      .map((row) => row.length);
    if (counts.length === 0) {
      const one = splitRecords(sample, sep, 1)[0]?.length ?? 1;
      if (one > 1 && one > bestScore) {
        best = sep;
        bestScore = one;
      }
      continue;
    }
    const first = counts[0] as number;
    const steady = counts.filter((n) => n === first).length / counts.length;
    const score = first > 1 ? first * steady : 0;
    if (score > bestScore) {
      best = sep;
      bestScore = score;
    }
  }
  return best;
}

/** Records of a separated text: quoted fields (with doubled quotes) may hold separators and line breaks. */
function splitRecords(text: string, sep: string, max = Number.POSITIVE_INFINITY): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n && rows.length < max) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
      continue;
    }
    if (ch === sep) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text.charAt(i + 1) === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if ((field !== "" || row.length > 0) && rows.length < max) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const PLAIN_NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const GROUPED_DOT = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const GROUPED_COMMA = /^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/;
const COMMA_DECIMAL = /^-?\d+,\d+$/;

/**
 * A field as a cell's value: a number when it is plainly one in the file's style (a decimal comma where `;` separates,
 * as spreadsheets in comma-decimal languages write), never one with a leading zero (codes, phone numbers), text
 * otherwise. Nothing becomes a formula.
 */
function fieldValue(field: string, commaDecimal: boolean): number | string | undefined {
  const text = field.trim();
  if (text === "") return field === "" ? undefined : field;
  const unsigned = text.replace(/^-/, "");
  if (/^0\d/.test(unsigned)) return field;
  let n: number | null = null;
  if (PLAIN_NUMBER.test(text) && !(commaDecimal && /^\d{1,3}\.\d{3}$/.test(unsigned))) n = Number(text);
  else if (!commaDecimal && GROUPED_DOT.test(text)) n = Number(text.replace(/,/g, ""));
  else if (commaDecimal && GROUPED_COMMA.test(text)) n = Number(text.replace(/\./g, "").replace(",", "."));
  else if (commaDecimal && COMMA_DECIMAL.test(text)) n = Number(text.replace(",", "."));
  return n !== null && Number.isFinite(n) && Math.abs(n) < 1e15 ? n : field;
}

/** A CSV or TSV file as a one-sheet workbook named after the file. */
export function readCsv(input: Uint8Array | string, name = "Sheet 1"): WorkbookData {
  if (typeof input !== "string" && input.byteLength > OFFICE_LIMITS.inputBytes) throw officeTooLarge("size");
  const text = typeof input === "string" ? input : decodeText(input);
  const sep = guessSeparator(text, name);
  const commaDecimal = sep === ";";
  // At most a grid's rows (Excel's), read before the rest is split: every line is a record held in memory, so a file
  // of nothing but line breaks would cost dozens of times its size before a single cell is counted.
  const records = splitRecords(text, sep, MAX_A1_ROWS + 1);
  if (records.length > MAX_A1_ROWS) throw officeTooLarge("rows");
  const cells: SheetData["cells"] = [];
  let cols = 0;
  records.forEach((record, r) => {
    record.forEach((field, c) => {
      const v = fieldValue(field, commaDecimal);
      if (v === undefined) return;
      if (cells.length >= OFFICE_LIMITS.cells) throw officeTooLarge("cells");
      cells.push({ r, c, v });
      if (c + 1 > cols) cols = c + 1;
    });
  });
  const title =
    name
      .replace(/\.(csv|tsv|txt)$/i, "")
      .trim()
      .slice(0, 100) || "Sheet 1";
  return { sheets: [{ name: title, rows: Math.max(records.length, 1), cols: Math.max(cols, 1), cells }] };
}

/** A field as CSV writes it: quoted when it holds a comma, a quote or a line break. */
const csvField = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/**
 * A sheet as CSV: each cell's value (dates and times as they show, numbers in full with a decimal point, TRUE and
 * FALSE, errors by their code), every row as wide as the widest, lines ending in CRLF.
 */
export function writeCsv(sheet: SheetData): string {
  const grid = new Map<number, Map<number, string>>();
  let width = 0;
  let height = 0;
  for (const cell of sheet.cells) {
    let text: string | null = null;
    if (cell.e) text = cell.e;
    else if (typeof cell.v === "number") {
      text = isDateFormat(cell.s?.nf) && cell.t ? cell.t : Number.isFinite(cell.v) ? String(cell.v) : null;
    } else if (typeof cell.v === "boolean") text = cell.v ? "TRUE" : "FALSE";
    else if (typeof cell.v === "string") text = cell.v;
    if (text === null || text === "") continue;
    const row = grid.get(cell.r) ?? new Map<number, string>();
    grid.set(cell.r, row);
    row.set(cell.c, text);
    width = Math.max(width, cell.c + 1);
    height = Math.max(height, cell.r + 1);
  }
  const lines: string[] = [];
  for (let r = 0; r < height; r++) {
    const row = grid.get(r);
    const fields: string[] = [];
    for (let c = 0; c < width; c++) fields.push(csvField(row?.get(c) ?? ""));
    lines.push(fields.join(","));
  }
  return lines.length > 0 ? `${lines.join("\r\n")}\r\n` : "";
}
