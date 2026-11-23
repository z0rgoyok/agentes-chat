import type {
  Artifact,
  ArtifactContent,
  ArtifactFilters,
  ArtifactKind,
  ArtifactLiveContent,
} from "@agenteschat/client";
import { documentPreview, parsePatch } from "@agenteschat/client/lib/artifacts";
import { fileIcon, previewKind } from "@agenteschat/client/lib/files";
import { daysBetween } from "@agenteschat/client/lib/format";

/**
 * The Drive on the phone: the type chips, the sections by day
 * (Hoje, Esta semana, then by month) and what each card's real preview shows. Pure: the screen draws it.
 */

export type DriveType =
  | "all"
  | "documents"
  | "spreadsheets"
  | "presentations"
  | "canvases"
  | "images"
  | "tables"
  | "diffs";
/** The chips in their order: the live files (ADR 0196 §9) after documents, as the New menu lists them. */
export const DRIVE_TYPES: DriveType[] = [
  "all",
  "documents",
  "spreadsheets",
  "presentations",
  "canvases",
  "images",
  "tables",
  "diffs",
];

/** What a card shows before (or without) its content: by kind, uploaded files by their name. */
export type CardShape = "document" | "table" | "diff" | "image" | "spreadsheet" | "slides" | "canvas" | "file";

export function cardShape(a: Pick<Artifact, "kind" | "title">): CardShape {
  switch (a.kind) {
    case "document":
      return "document";
    case "table":
      return "table";
    case "diff":
      return "diff";
    case "spreadsheet":
    case "slides":
    case "canvas":
      return a.kind;
    case "file":
      return fileIcon(a.title) === "image" ? "image" : "file";
    default:
      // Diagrams and HTML pages: a file tile.
      return "file";
  }
}

export function matchesType(a: Pick<Artifact, "kind" | "title">, type: DriveType): boolean {
  if (type === "all") return true;
  const icon = a.kind === "file" ? fileIcon(a.title) : null;
  switch (type) {
    case "documents":
      return a.kind === "document" || icon === "document";
    case "images":
      return icon === "image";
    case "tables":
      return a.kind === "table" || icon === "table";
    case "diffs":
      return a.kind === "diff";
    case "spreadsheets":
      return a.kind === "spreadsheet";
    // An uploaded deck is a presentation too (it opens as its slides, ADR 0198).
    case "presentations":
      return a.kind === "slides" || icon === "slides";
    case "canvases":
      return a.kind === "canvas";
  }
}

/**
 * The kinds the server narrows a type chip to: the kinds that can hold that type. An uploaded file is one kind on the
 * server whatever it holds, so a chip that takes files gets them all and the phone keeps the ones its name says are of
 * the type (`matchesType`).
 */
export function driveKinds(type: DriveType): ArtifactKind[] | undefined {
  switch (type) {
    case "all":
      return undefined;
    case "documents":
      return ["document", "file"];
    case "images":
      return ["file"];
    case "tables":
      return ["table", "file"];
    case "diffs":
      return ["diff"];
    case "spreadsheets":
      return ["spreadsheet"];
    case "presentations":
      return ["slides", "file"];
    case "canvases":
      return ["canvas"];
  }
}

/** What the Drive asks the server for: the words searched and the kinds the chip narrows to. */
export function driveFilters(q: string, type: DriveType): ArtifactFilters {
  const kinds = driveKinds(type);
  return { ...(q ? { q } : {}), ...(kinds ? { kinds } : {}) };
}

/**
 * Whether the Drive asks for the server's next page by itself: fewer files of the type than it shows, more pages on
 * the server, none on its way, the first page in (not the last filter's, shown while the new one loads) and the last
 * page asked for not failed (that one waits for the person: asking again at once would never stop).
 */
export function keepsLooking(at: {
  matched: number;
  wanted: number;
  hasNextPage: boolean;
  fetching: boolean;
  placeholder: boolean;
  failed: boolean;
}): boolean {
  return at.matched < at.wanted && at.hasNextPage && !at.fetching && !at.placeholder && !at.failed;
}

/**
 * What the Drive shows: the rows' shape while it loads or while it still looks for files of the type (nothing found
 * yet, more pages to read), why it didn't load, nothing (with or without filters), or the grid.
 */
export type DriveView = "loading" | "failed" | "empty" | "noMatch" | "grid";

export function driveView(at: {
  loading: boolean;
  failed: boolean;
  matched: number;
  hasNextPage: boolean;
  placeholder: boolean;
  filtered: boolean;
}): DriveView {
  if (at.failed) return "failed";
  if (at.loading) return "loading";
  if (at.matched > 0) return "grid";
  if (at.placeholder || at.hasNextPage) return "loading";
  return at.filtered ? "noMatch" : "empty";
}

export type DriveSectionKey = { kind: "today" } | { kind: "week" } | { kind: "month"; year: number; month: number };

export interface DriveDaySection {
  /** Stable key: "today", "week", "2026-09". */
  key: string;
  label: DriveSectionKey;
  items: Artifact[];
}

/**
 * By the last update, newest first: "Hoje", "Esta semana" (the last 7 days), then one section per month.
 */
export function driveSections(list: Artifact[], now = new Date()): DriveDaySection[] {
  const sorted = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const out: DriveDaySection[] = [];
  for (const a of sorted) {
    const days = daysBetween(a.updatedAt, now);
    let key: string;
    let label: DriveSectionKey;
    if (days <= 0) {
      key = "today";
      label = { kind: "today" };
    } else if (days < 7) {
      key = "week";
      label = { kind: "week" };
    } else {
      const d = new Date(a.updatedAt);
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      label = { kind: "month", year: d.getFullYear(), month: d.getMonth() };
    }
    const last = out[out.length - 1];
    if (last?.key === key) last.items.push(a);
    else out.push({ key, label, items: [a] });
  }
  return out;
}

/** The 2-column grid's rows. */
export function gridRows<T>(items: T[], columns = 2): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns));
  return rows;
}

export const DOC_LINES = 4;
export const TABLE_ROWS = 4;
export const TABLE_COLS = 3;
export const DIFF_LINES = 6;

export type CardPreview =
  | { kind: "document"; head: string; lines: string[] }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "diff"; lines: { kind: "add" | "del" | "same"; text: string }[] }
  | { kind: "image" }
  /** A live file: its card draws the preview it carries (ADR 0196 §7). */
  | { kind: "live"; content: ArtifactLiveContent }
  | { kind: "file"; ext: string };

const extOf = (name: string) => (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? "").slice(0, 4).toUpperCase();

/** What a card draws from the item's content (at its version). `title` is the fallback heading. */
export function cardPreview(title: string, content: ArtifactContent): CardPreview {
  switch (content.kind) {
    case "document": {
      const [head, ...lines] = documentPreview(content.markdown, DOC_LINES + 1);
      return { kind: "document", head: head ?? title, lines };
    }
    case "table": {
      const columns = content.columns.slice(0, TABLE_COLS);
      return {
        kind: "table",
        columns,
        rows: content.rows.slice(0, TABLE_ROWS).map((r) => columns.map((_, j) => r[j] ?? "")),
      };
    }
    case "diff": {
      const lines: { kind: "add" | "del" | "same"; text: string }[] = [];
      for (const f of content.files) {
        for (const l of parsePatch(f.patch)) {
          if (l.kind === "hunk") continue;
          // The changed lines tell the story; context only between them.
          if (l.kind === "same" && lines.length === 0) continue;
          lines.push({ kind: l.kind, text: l.text });
          if (lines.length === DIFF_LINES) return { kind: "diff", lines };
        }
      }
      return { kind: "diff", lines };
    }
    case "file":
      return previewKind(content.contentType) === "image"
        ? { kind: "image" }
        : { kind: "file", ext: extOf(content.name) || extOf(title) || "FILE" };
    case "diagram":
      return { kind: "file", ext: "MMD" };
    case "html":
    case "block":
      return { kind: "file", ext: "HTML" };
    case "poll":
    case "choices":
      return { kind: "file", ext: "POLL" };
    case "spreadsheet":
    case "slides":
    case "canvas":
      return { kind: "live", content };
  }
}

/** The kind chip on the preview: `mobile.drive.kind.<key>`. */
export function kindKey(
  a: Pick<Artifact, "kind" | "title">,
): "document" | "table" | "diff" | "image" | "spreadsheet" | "slides" | "canvas" | "file" {
  const shape = cardShape(a);
  if (shape !== "file") return shape;
  if (a.kind !== "file") return "file";
  const icon = fileIcon(a.title);
  return icon === "document" ? "document" : icon === "slides" ? "slides" : "file";
}
