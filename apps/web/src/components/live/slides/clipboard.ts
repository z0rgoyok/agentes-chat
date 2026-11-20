import { normalizeRich, type RichParagraph, richText } from "@agenteschat/live/rich";
import {
  cleanChart,
  cleanStyle,
  cleanTable,
  type ElementView,
  isElementType,
  isSlideRole,
  type NewElement,
} from "@agenteschat/live/slides";
import { elementSeed } from "./actions";

/**
 * Copying and pasting slide elements (ADR 0196 §2): the clipboard carries them as data of our own type (what it takes
 * to make each again, and the file its pictures belong to) beside their words as plain text, so a paste into another
 * presentation makes the same elements and a paste into a message or a document gets the text.
 */

export const CLIP_TYPE = "application/x-agentes-slides+json";

export interface SlidesClip {
  v: 1;
  /** The live file the elements came from: its pictures are its assets. */
  fileId: string;
  elements: NewElement[];
}

export function clipOf(fileId: string, els: readonly ElementView[]): { json: string; text: string } {
  const clip: SlidesClip = { v: 1, fileId, elements: els.map((el) => elementSeed(el)) };
  const text = els
    .map((el) => {
      if (el.text) return richText(el.text);
      if (el.table) return el.table.rows.map((row) => row.join("\t")).join("\n");
      if (el.chart) return el.chart.title;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
  return { json: JSON.stringify(clip), text };
}

/** Our elements from the clipboard's data, checked (anything else in it is left out), or null. */
export function readClip(raw: string | null | undefined): SlidesClip | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const { v, fileId, elements } = data as Partial<SlidesClip>;
  if (v !== 1 || typeof fileId !== "string" || !Array.isArray(elements)) return null;
  const out: NewElement[] = [];
  for (const raw of elements.slice(0, 200)) {
    if (!raw || typeof raw !== "object" || !isElementType(raw.type)) continue;
    const box = raw.box;
    if (!box || ![box.x, box.y, box.w, box.h].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    const el: NewElement = { type: raw.type, box: { x: box.x, y: box.y, w: box.w, h: box.h } };
    if (typeof raw.rot === "number" && Number.isFinite(raw.rot)) el.rot = raw.rot;
    if (isSlideRole(raw.role)) el.role = raw.role;
    if (Array.isArray(raw.text)) el.text = normalizeRich(raw.text as RichParagraph[]);
    const style = cleanStyle(raw.style);
    if (style) el.style = style;
    if (typeof raw.asset === "string") el.asset = raw.asset;
    if (raw.fit === "cover" || raw.fit === "contain") el.fit = raw.fit;
    if (typeof raw.alt === "string") el.alt = raw.alt;
    const chart = raw.type === "chart" ? cleanChart(raw.chart) : undefined;
    if (raw.type === "chart" && !chart) continue;
    if (chart) el.chart = chart;
    const table = raw.type === "table" ? cleanTable(raw.table) : undefined;
    if (raw.type === "table" && !table) continue;
    if (table) el.table = table;
    out.push(el);
  }
  return out.length ? { v: 1, fileId, elements: out } : null;
}

/** The pasted elements moved by `offset` on both axes (a paste in the same slide lands beside what it copied). */
export function shifted(elements: readonly NewElement[], offset: number): NewElement[] {
  if (!offset) return [...elements];
  return elements.map((el) =>
    el.box ? { ...el, box: { ...el.box, x: el.box.x + offset, y: el.box.y + offset } } : { ...el },
  );
}
