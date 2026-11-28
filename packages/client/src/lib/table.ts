import { plainInline } from "@agenteschat/ui/markdown";
import { siteName } from "./sites";

/**
 * How a Markdown table lays out in a conversation, on the web and on the phone alike: each column by what its cells
 * hold, so a table fits the width it has before it scrolls. A column that only counts the rows stays narrow; numbers,
 * short words and links stay on one line (a link as its site's icon and name, cut at its end when it is long); only a
 * column of longer text wraps, at its words.
 */
export type TableColumnKind = "index" | "number" | "link" | "short" | "text";

/** A cell as its column's kind reads it: its words without marks, and whether it is nothing but a link. */
export interface TableCellRead {
  text: string;
  link: boolean;
}

/** The longest cell, in letters, of a column that never wraps. */
export const TABLE_SHORT = 18;

/** Rows a table shows in a conversation: the rest open with "See all N rows", as long code opens its lines. */
export const TABLE_PREVIEW_ROWS = 8;

/** A table that shows its first rows only when the rest are more than a couple (two hidden rows aren't worth a tap). */
export const tablePreviewed = (rows: number) => rows > TABLE_PREVIEW_ROWS + 2;

// "429", "-17,2%", "R$ 1.200", "$3.5k", "300 m", "21 dias", "1.000 m²": a number as people write one, with a short unit.
const NUMBER = /^[~≈<>+-]?\s*(R\$|US\$|\$|€|£)?\s*[+-]?\d[\d.,\s]*(%|k|mil|mi|x)?(\s?\p{L}{1,6}[²³.]?)?$/iu;
const COUNT = /^\d{1,4}\.?$/;

/** The kind of each of a table's `columns` columns, read from its rows (the header never counts). */
export function tableColumnKinds(rows: readonly (readonly TableCellRead[])[], columns: number): TableColumnKind[] {
  return Array.from({ length: columns }, (_, c): TableColumnKind => {
    const cells = rows.map((r) => r[c]).filter((cell): cell is TableCellRead => Boolean(cell?.text.trim()));
    if (cells.length === 0) return "short";
    const words = cells.map((cell) => cell.text.trim());
    if (c === 0 && words.every((w) => COUNT.test(w))) return "index";
    if (cells.filter((cell) => cell.link).length * 2 >= cells.length) return "link";
    if (words.every((w) => NUMBER.test(w))) return "number";
    if (words.every((w) => w.length <= TABLE_SHORT)) return "short";
    return "text";
  });
}

const LINK_ONLY = /^\[[^\]]+\]\([^)\s]+\)$/;
const ADDRESS_ONLY = /^<?https?:\/\/\S+>?$/i;

/** A cell of a table as written (its Markdown), read for its column's kind. */
export function tableCellRead(raw: string): TableCellRead {
  const cell = raw.trim();
  return { text: plainInline(cell), link: LINK_ONLY.test(cell) || ADDRESS_ONLY.test(cell) };
}

/**
 * The name a link shows in a table: its site ("tecelagem.com.br", without "https://", "www." or the path), or null
 * when it isn't a web address.
 */
export function linkSite(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return siteName(url.host.toLowerCase());
  } catch {
    return null;
  }
}

/**
 * A table as a spreadsheet takes it from the clipboard: cells split by tabs, rows by line breaks, so pasted into a
 * sheet each value lands in its own cell. A tab or a line break inside a cell becomes a space.
 */
export function tableTsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const clean = (cell: string) => cell.replace(/[\t\r\n]+/g, " ").trim();
  return [header, ...rows].map((r) => header.map((_, c) => clean(r[c] ?? "")).join("\t")).join("\n");
}
