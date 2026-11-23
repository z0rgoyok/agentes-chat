/**
 * The spreadsheet's clipboard on the web and in the desktop app (ADR 0196): copy and cut write tab-separated text
 * and an HTML table (what Excel, Google Sheets and documents read) plus our own cells, so a paste here keeps formulas
 * moving as copies do. Everything goes through the `copy`, `cut` and `paste` events of the focused field, which is
 * also what the Mac app's Edit menu sends.
 */
import type { ClipCell, ClipSource } from "@agenteschat/live/spreadsheet";

/** Our own cells on the clipboard (browsers keep custom types between pages of the same browser). */
export const CELLS_TYPE = "application/x-agentes-cells+json";

export interface CopiedCells {
  /** The file and sheet they came from, and their top-left cell (formulas move from there). */
  file: string;
  sheet: string;
  r1: number;
  c1: number;
  rows: number;
  cols: number;
  cells: ClipCell[][];
  tsv: string;
  /** Cut: pasting moves them instead of copying. */
  cut: boolean;
}

/** The last copy made here: what a paste of the same text means, when the browser drops our own type. */
let lastCopy: CopiedCells | null = null;

export const rememberCopy = (copy: CopiedCells | null) => {
  lastCopy = copy;
};
export const lastCopied = () => lastCopy;

/** Writes a copy to the event's clipboard. */
export function writeClipboard(data: DataTransfer, copy: CopiedCells, html: string): void {
  data.setData("text/plain", copy.tsv);
  data.setData("text/html", html);
  try {
    data.setData(CELLS_TYPE, JSON.stringify(copy));
  } catch {
    // A browser that refuses custom types still has the text and the table.
  }
  rememberCopy(copy);
}

/** Tab-separated text compared as Excel writes it (line endings vary between systems). */
const sameText = (a: string, b: string) => a.replace(/\r\n?/g, "\n").trimEnd() === b.replace(/\r\n?/g, "\n").trimEnd();

/** What a paste brings: our own cells (copied here or in another of our files), else an HTML table, else text. */
export function readClipboard(data: DataTransfer): { clip: ClipSource; copied: CopiedCells | null } | null {
  const tsv = data.getData("text/plain");
  const html = data.getData("text/html");
  let copied: CopiedCells | null = null;
  const raw = data.getData(CELLS_TYPE);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as CopiedCells;
      if (parsed && Array.isArray(parsed.cells) && typeof parsed.sheet === "string") copied = parsed;
    } catch {
      copied = null;
    }
  }
  if (!copied && lastCopy && tsv && sameText(lastCopy.tsv, tsv)) copied = lastCopy;
  if (copied) {
    return {
      clip: { cells: copied.cells, source: { sheet: copied.sheet, r1: copied.r1, c1: copied.c1 } },
      copied,
    };
  }
  if (!tsv && !html) return null;
  return { clip: { ...(html ? { html } : {}), ...(tsv ? { tsv } : {}) }, copied: null };
}
