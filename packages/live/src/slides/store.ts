import * as Y from "yjs";
import { cleanGradient, cleanLineHeight, cleanPadding, cleanShadow, cleanTracking, isDash } from "../effects";
import { cleanFileFonts, isFontRef, isFontWeight } from "../fonts";
import { compareStack } from "../fractional";
import { readGroupMap } from "../groups";
import { readRich } from "../rich/yjs";
import { SLIDE_H, SLIDE_W, themeOf } from "./themes";
import {
  type DeckFonts,
  type DeckView,
  type ElementStyle,
  type ElementView,
  isElementType,
  isSlideLayout,
  isSlideRole,
  type SlideBackground,
  type SlideChart,
  type SlideGroup,
  type SlideLayout,
  type SlideTable,
  type SlideView,
} from "./types";

/**
 * Where a presentation lives in its document and how its values are read and checked (ADR 0196 §2): `deck` (a map:
 * `theme`, `w`, `h`, and the deck's own `fonts`, ADR 0220), `slideOrder` (slide ids in order) and `slides` (a map of
 * slide id to a `Y.Map` with `layout`, `bg`, `hidden`, `notes` (`Y.Text`), `elements`, a map of element id to a
 * `Y.Map` per element, and `groups`, a map of group id to `{ name?, parent? }`).
 *
 * Reading is lenient (a value an app doesn't know is left out, never a crash): the document is shared state, and what
 * a newer app or a broken client wrote must not stop the others from opening it. Writing goes through the `clean*`
 * functions, so nothing off-shape gets in.
 */

export function deckMapOf(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>("deck");
}

export function slideOrderOf(doc: Y.Doc): Y.Array<string> {
  return doc.getArray<string>("slideOrder");
}

export function slidesMapOf(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>("slides");
}

export function slideMapOf(doc: Y.Doc, id: string): Y.Map<unknown> | null {
  const value: unknown = slidesMapOf(doc).get(id);
  return value instanceof Y.Map ? (value as Y.Map<unknown>) : null;
}

export function elementsMapOf(slide: Y.Map<unknown>): Y.Map<Y.Map<unknown>> | null {
  const value = slide.get("elements");
  return value instanceof Y.Map ? (value as Y.Map<Y.Map<unknown>>) : null;
}

export function elementMapOf(slide: Y.Map<unknown>, id: string): Y.Map<unknown> | null {
  const value: unknown = elementsMapOf(slide)?.get(id);
  return value instanceof Y.Map ? (value as Y.Map<unknown>) : null;
}

/**
 * The deck's slides in order: each id once (two people moving the same slide at once can repeat it in the order),
 * only slides that exist, and any slide missing from the order (a broken client's) at the end, so nothing is lost.
 */
export function slideIdsOf(doc: Y.Doc): string[] {
  const slides = slidesMapOf(doc);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of slideOrderOf(doc).toArray()) {
    if (typeof id !== "string" || seen.has(id) || !(slides.get(id) instanceof Y.Map)) continue;
    seen.add(id);
    out.push(id);
  }
  const orphans: string[] = [];
  slides.forEach((value, id) => {
    if (!seen.has(id) && value instanceof Y.Map) orphans.push(id);
  });
  return orphans.length ? [...out, ...orphans.sort()] : out;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** Slide units past this are a broken element, not a big one. */
const COORD_MAX = 1e6;

export function isRefId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function isColor(value: unknown): value is string {
  return typeof value === "string" && COLOR.test(value);
}

function num(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

/** A coordinate in slide units, or undefined. */
export function coord(value: unknown): number | undefined {
  return num(value, -COORD_MAX, COORD_MAX);
}

/** A rotation in degrees, in [0, 360); 0 for none. */
export function rotation(value: unknown): number {
  const n = coord(value);
  return n === undefined ? 0 : ((n % 360) + 360) % 360;
}

const SHAPES: readonly string[] = ["rect", "ellipse", "triangle", "diamond", "arrow"];

/** One style key's value as stored, or undefined when it isn't one that key may hold. */
export function cleanStyleValue<K extends keyof ElementStyle>(key: K, value: unknown): ElementStyle[K] | undefined {
  const out = ((): unknown => {
    switch (key) {
      case "size":
        return num(value, 4, 1000);
      case "color":
        return isColor(value) ? value : undefined;
      case "font":
        return isFontRef(value) ? value : undefined;
      case "weight":
        return isFontWeight(value) ? value : undefined;
      case "lineHeight":
        return cleanLineHeight(value);
      case "tracking":
        return cleanTracking(value);
      case "caps":
        return value === true ? true : undefined;
      case "padding":
        return cleanPadding(value);
      case "gradient":
        return cleanGradient(value);
      case "shadow":
        return cleanShadow(value);
      case "dash":
        return isDash(value) ? value : undefined;
      case "align":
        return value === "left" || value === "center" || value === "right" ? value : undefined;
      case "valign":
        return value === "top" || value === "middle" || value === "bottom" ? value : undefined;
      case "fill":
      case "stroke":
        return value === "none" || isColor(value) ? value : undefined;
      case "strokeWidth":
        return num(value, 0, 200);
      case "radius":
        return num(value, 0, 2000);
      case "shape":
        return typeof value === "string" && SHAPES.includes(value) ? value : undefined;
      case "opacity":
        return num(value, 0, 1);
      case "lineEnd":
        return value === "none" || value === "arrow" ? value : undefined;
      default:
        return undefined;
    }
  })();
  return out as ElementStyle[K] | undefined;
}

const STYLE_KEYS: readonly (keyof ElementStyle)[] = [
  "size",
  "color",
  "font",
  "weight",
  "align",
  "valign",
  "lineHeight",
  "tracking",
  "caps",
  "padding",
  "fill",
  "gradient",
  "stroke",
  "strokeWidth",
  "dash",
  "radius",
  "shadow",
  "shape",
  "opacity",
  "lineEnd",
];

/** A style as stored: only known keys with valid values; undefined when nothing is left. */
export function cleanStyle(value: unknown): ElementStyle | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const style: Record<string, unknown> = {};
  for (const key of STYLE_KEYS) {
    const clean = cleanStyleValue(key, raw[key]);
    if (clean !== undefined) style[key] = clean;
  }
  return Object.keys(style).length ? (style as ElementStyle) : undefined;
}

/** Charts on a slide: past these the data belongs in a spreadsheet. */
export const SLIDE_CHART_LIMITS = { labels: 60, series: 6 } as const;
const CHART_TYPES: readonly string[] = ["bar", "line", "pie", "number"];

function chartText(value: unknown, max: number): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value.trim().slice(0, max) : undefined;
}

/**
 * A chart as stored (the chat's chart shape), or undefined when it can't be drawn honestly: an unknown type, a
 * series whose values don't match the labels, a value that isn't a number.
 */
export function cleanChart(value: unknown): SlideChart | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const type = o.type === "kpi" ? "number" : o.type;
  if (typeof type !== "string" || !CHART_TYPES.includes(type)) return undefined;
  const labels = Array.isArray(o.labels) ? o.labels.map((label) => chartText(label, 60)) : [];
  if (labels.length > SLIDE_CHART_LIMITS.labels || labels.some((label) => label === undefined)) return undefined;
  const series: SlideChart["series"] = [];
  for (const s of Array.isArray(o.series) ? o.series : []) {
    if (!s || typeof s !== "object") return undefined;
    const values = (s as { values?: unknown }).values;
    if (!Array.isArray(values) || values.length !== labels.length) return undefined;
    if (!values.every((v) => typeof v === "number" && Number.isFinite(v))) return undefined;
    series.push({ name: chartText((s as { name?: unknown }).name, 40) ?? "", values: [...(values as number[])] });
  }
  if (series.length > SLIDE_CHART_LIMITS.series) return undefined;
  const chart: SlideChart = {
    type: type as SlideChart["type"],
    title: chartText(o.title, 120) ?? "",
    labels: labels as string[],
    series,
  };
  const subtitle = chartText(o.subtitle, 160);
  if (subtitle) chart.subtitle = subtitle;
  const unit = chartText(o.unit, 8);
  if (unit) chart.unit = unit;
  if (type === "number") {
    if (typeof o.value !== "number" || !Number.isFinite(o.value)) return undefined;
    chart.value = o.value;
    const delta = chartText(o.delta, 60);
    if (delta) chart.delta = delta;
  } else if (series.length === 0) {
    return undefined;
  }
  return chart;
}

/** Tables on a slide: past these the data belongs in a spreadsheet. */
export const SLIDE_TABLE_LIMITS = { rows: 50, cols: 20, cellChars: 2000 } as const;

function cellText(cell: unknown): string {
  if (typeof cell === "string") return cell;
  return typeof cell === "number" || typeof cell === "boolean" ? String(cell) : "";
}

/** A table as stored: rows of text cells, all rows as long as the longest; undefined when it isn't a table. */
export function cleanTable(value: unknown): SlideTable | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  if (!Array.isArray(o.rows) || o.rows.length === 0 || o.rows.length > SLIDE_TABLE_LIMITS.rows) return undefined;
  const rows: string[][] = [];
  for (const row of o.rows) {
    if (!Array.isArray(row) || row.length > SLIDE_TABLE_LIMITS.cols) return undefined;
    rows.push(row.map((cell) => cellText(cell).slice(0, SLIDE_TABLE_LIMITS.cellChars)));
  }
  const cols = Math.max(1, ...rows.map((row) => row.length));
  for (const row of rows) while (row.length < cols) row.push("");
  return { rows, header: o.header === true };
}

/** A slide's background as stored, or undefined. */
export function cleanBackground(value: unknown): SlideBackground | undefined {
  if (isColor(value)) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const asset = (value as { asset?: unknown }).asset;
    if (isRefId(asset)) return { asset };
  }
  return undefined;
}

/** An element's map as plain data, or null when it isn't an element any app can draw. */
export function readElement(id: string, map: Y.Map<unknown>): ElementView | null {
  const type = map.get("type");
  if (!isElementType(type)) return null;
  const z = map.get("z");
  const line = type === "line";
  const view: ElementView = {
    id,
    type,
    x: coord(map.get("x")) ?? 0,
    y: coord(map.get("y")) ?? 0,
    w: line ? (coord(map.get("w")) ?? 0) : Math.max(0, coord(map.get("w")) ?? 0),
    h: line ? (coord(map.get("h")) ?? 0) : Math.max(0, coord(map.get("h")) ?? 0),
    z: typeof z === "string" ? z : "",
  };
  const rot = rotation(map.get("rot"));
  if (rot) view.rot = rot;
  const role = map.get("role");
  if (isSlideRole(role)) view.role = role;
  const text = map.get("text");
  if ((type === "text" || type === "shape") && text instanceof Y.XmlFragment) view.text = readRich(text);
  const style = cleanStyle(map.get("style"));
  if (style) view.style = style;
  const group = map.get("group");
  if (isRefId(group)) view.group = group;
  if (type === "image") {
    const asset = map.get("asset");
    if (isRefId(asset)) view.asset = asset;
    const fit = map.get("fit");
    view.fit = fit === "contain" ? "contain" : "cover";
    const alt = map.get("alt");
    if (typeof alt === "string" && alt) view.alt = alt.slice(0, 1000);
  }
  if (type === "chart") {
    const chart = cleanChart(map.get("chart"));
    if (chart) view.chart = chart;
  }
  if (type === "table") {
    const table = cleanTable(map.get("table"));
    if (table) view.table = table;
  }
  return view;
}

/** A slide's elements as plain data, bottom to top. */
export function readElements(slide: Y.Map<unknown>): ElementView[] {
  const out: ElementView[] = [];
  elementsMapOf(slide)?.forEach((value, id) => {
    if (!(value instanceof Y.Map)) return;
    const view = readElement(id, value as Y.Map<unknown>);
    if (view) out.push(view);
  });
  return out.sort(compareStack);
}

export function slideLayoutOf(slide: Y.Map<unknown>): SlideLayout {
  const layout = slide.get("layout");
  return isSlideLayout(layout) ? layout : "blank";
}

function notesOf(slide: Y.Map<unknown>): string {
  const notes = slide.get("notes");
  return notes instanceof Y.Text ? notes.toString() : typeof notes === "string" ? notes : "";
}

export function groupsMapOf(slide: Y.Map<unknown>): Y.Map<unknown> | null {
  const value = slide.get("groups");
  return value instanceof Y.Map ? (value as Y.Map<unknown>) : null;
}

/** A slide's groups (ADR 0220 §3). */
export function readGroups(slide: Y.Map<unknown>): SlideGroup[] {
  return readGroupMap(groupsMapOf(slide));
}

function slideView(id: string, index: number, slide: Y.Map<unknown>): SlideView {
  const view: SlideView = {
    id,
    index,
    layout: slideLayoutOf(slide),
    notes: notesOf(slide),
    elements: readElements(slide),
  };
  const bg = cleanBackground(slide.get("bg"));
  if (bg) view.bg = bg;
  if (slide.get("hidden") === true) view.hidden = true;
  const groups = readGroups(slide);
  if (groups.length) {
    view.groups = groups;
    // An element in a group that isn't there reads as ungrouped.
    const ids = new Set(groups.map((g) => g.id));
    for (const el of view.elements) if (el.group && !ids.has(el.group)) delete el.group;
  } else {
    for (const el of view.elements) delete el.group;
  }
  return view;
}

/** The deck's own fonts as stored, or undefined when it has none. */
export function cleanDeckFonts(value: unknown): DeckFonts | undefined {
  return cleanFileFonts(value);
}

/** The deck's own fonts, or undefined. */
export function deckFonts(doc: Y.Doc): DeckFonts | undefined {
  return cleanDeckFonts(deckMapOf(doc).get("fonts"));
}

/** One slide as plain data (with its position), or null when there is no such slide. */
export function readSlide(doc: Y.Doc, id: string): SlideView | null {
  const slide = slideMapOf(doc, id);
  if (!slide) return null;
  return slideView(id, slideIdsOf(doc).indexOf(id), slide);
}

/** The deck's theme. */
export function deckTheme(doc: Y.Doc): DeckView["theme"] {
  return themeOf(deckMapOf(doc).get("theme")).id;
}

/** The whole presentation as plain data: the theme, and the slides in order with their elements bottom to top. */
export function readDeck(doc: Y.Doc): DeckView {
  const slides = slidesMapOf(doc);
  const deck = deckMapOf(doc);
  const fonts = deckFonts(doc);
  return {
    theme: deckTheme(doc),
    ...(fonts ? { fonts } : {}),
    w: num(deck.get("w"), 1, COORD_MAX) ?? SLIDE_W,
    h: num(deck.get("h"), 1, COORD_MAX) ?? SLIDE_H,
    slides: slideIdsOf(doc).map((id, index) => slideView(id, index, slides.get(id) as Y.Map<unknown>)),
  };
}
