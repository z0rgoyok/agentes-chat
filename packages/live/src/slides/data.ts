import * as Y from "yjs";
import { keysBetween } from "../fractional";
import { newId } from "../ids";
import { LIVE_LIMITS } from "../limits";
import { clipRich, normalizeRich } from "../rich/text";
import { writeRich } from "../rich/yjs";
import {
  cleanBackground,
  cleanChart,
  cleanStyle,
  cleanTable,
  coord,
  deckMapOf,
  isColor,
  isRefId,
  readDeck,
  rotation,
  slideOrderOf,
  slidesMapOf,
} from "./store";
import { DEFAULT_THEME, SLIDE_H, SLIDE_W } from "./themes";
import {
  type DeckData,
  type DeckElementData,
  type DeckSlideData,
  type ElementStyle,
  isElementType,
  isSlideLayout,
  isSlideRole,
  isThemeId,
} from "./types";

/**
 * Presentations as plain data (ADR 0198): what the office readers produce from a `.pptx` and the writers consume.
 * `slidesFromData` replaces a document's slides with a deck read from a file, scaled into the 1920×1080 slide
 * (keeping its proportions, centered); pictures must already be assets of the live file (`media[name].asset`, the
 * engine stores them first), and one that isn't is left out.
 */

/** Scales a deck of any size into the slide: the factor and the offsets that center it. */
function fitInto(w: number, h: number): { s: number; ox: number; oy: number } {
  const width = Number.isFinite(w) && w > 0 ? w : SLIDE_W;
  const height = Number.isFinite(h) && h > 0 ? h : SLIDE_H;
  const s = Math.min(SLIDE_W / width, SLIDE_H / height);
  return { s, ox: (SLIDE_W - width * s) / 2, oy: (SLIDE_H - height * s) / 2 };
}

const round = (n: number) => Math.round(n * 100) / 100;

function scaledStyle(style: ElementStyle | undefined, s: number): ElementStyle | undefined {
  const clean = cleanStyle(style);
  if (!clean) return undefined;
  const out: ElementStyle = { ...clean };
  if (out.size !== undefined) out.size = Math.min(1000, Math.max(4, round(out.size * s)));
  if (out.strokeWidth !== undefined) out.strokeWidth = Math.min(200, round(out.strokeWidth * s));
  if (out.radius !== undefined) out.radius = Math.min(2000, round(out.radius * s));
  return out;
}

/** One element of a deck as a new element map, or null when it can't be one (a picture that isn't an asset). */
function elementMap(el: DeckElementData, data: DeckData, fit: ReturnType<typeof fitInto>): Y.Map<unknown> | null {
  if (!isElementType(el.type)) return null;
  const x = coord(el.x);
  const y = coord(el.y);
  const w = coord(el.w);
  const h = coord(el.h);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
  const line = el.type === "line";
  if (!line && (w < 0 || h < 0)) return null;
  const map = new Y.Map<unknown>();
  map.set("type", el.type);
  map.set("x", round(fit.ox + x * fit.s));
  map.set("y", round(fit.oy + y * fit.s));
  map.set("w", round(w * fit.s));
  map.set("h", round(h * fit.s));
  const rot = rotation(el.rot);
  if (rot) map.set("rot", rot);
  if (isSlideRole(el.role)) map.set("role", el.role);
  const style = scaledStyle(el.style, fit.s);
  if (style) map.set("style", style);
  if (el.type === "text" || el.type === "shape") {
    const fragment = new Y.XmlFragment();
    writeRich(fragment, clipRich(normalizeRich(el.text ?? []), LIVE_LIMITS.slides.textChars));
    map.set("text", fragment);
  }
  if (el.type === "image") {
    const asset = el.media ? data.media[el.media]?.asset : undefined;
    if (!isRefId(asset)) return null;
    map.set("asset", asset);
    map.set("fit", el.fit === "cover" ? "cover" : "contain");
    if (el.alt) map.set("alt", el.alt.slice(0, 1000));
  }
  if (el.type === "table") {
    const table = cleanTable(el.table);
    if (!table) return null;
    map.set("table", table);
  }
  if (el.type === "chart") {
    const chart = cleanChart(el.chart);
    if (!chart) return null;
    map.set("chart", chart);
  }
  return map;
}

function slideMap(slide: DeckSlideData, data: DeckData, fit: ReturnType<typeof fitInto>): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set("layout", isSlideLayout(slide.layout) ? slide.layout : "blank");
  if (typeof slide.bg === "string" && isColor(slide.bg)) map.set("bg", slide.bg);
  else if (slide.bg && typeof slide.bg === "object") {
    const bg = cleanBackground({ asset: data.media[slide.bg.media]?.asset });
    if (bg) map.set("bg", bg);
  }
  if (slide.hidden === true) map.set("hidden", true);
  const notes = new Y.Text();
  if (slide.notes) notes.insert(0, slide.notes.slice(0, LIVE_LIMITS.slides.textChars));
  map.set("notes", notes);
  const elements = new Y.Map<Y.Map<unknown>>();
  const made = (Array.isArray(slide.elements) ? slide.elements : [])
    .map((el) => elementMap(el, data, fit))
    .filter((el): el is Y.Map<unknown> => el !== null)
    .slice(0, LIVE_LIMITS.slides.elements);
  const keys = keysBetween(null, null, made.length);
  made.forEach((el, i) => {
    el.set("z", keys[i]);
    elements.set(newId(), el);
  });
  map.set("elements", elements);
  return map;
}

/** Replaces the document's slides (and theme) with a deck's, in one transaction with `origin`. */
export function slidesFromData(doc: Y.Doc, data: DeckData, origin: unknown): void {
  const fit = fitInto(data.w, data.h);
  const slides = (Array.isArray(data.slides) ? data.slides : []).slice(0, LIVE_LIMITS.slides.slides);
  const made = slides.map((slide) => [newId(), slideMap(slide, data, fit)] as const);
  doc.transact(() => {
    const deck = deckMapOf(doc);
    const current = deck.get("theme");
    deck.set("theme", isThemeId(data.theme) ? data.theme : isThemeId(current) ? current : DEFAULT_THEME);
    deck.set("w", SLIDE_W);
    deck.set("h", SLIDE_H);
    const order = slideOrderOf(doc);
    if (order.length) order.delete(0, order.length);
    const map = slidesMapOf(doc);
    for (const id of [...map.keys()]) map.delete(id);
    for (const [id, slide] of made) map.set(id, slide);
    order.push(made.map(([id]) => id));
  }, origin);
}

/**
 * The document's presentation as plain data, in slide units (`w` 1920, `h` 1080): pictures are named by their asset
 * id in `media` (with the asset id in `asset`; their bytes are the caller's to read), empty picture placeholders are
 * left out.
 */
export function slidesToData(doc: Y.Doc): DeckData {
  const deck = readDeck(doc);
  const media: DeckData["media"] = {};
  const slides: DeckSlideData[] = deck.slides.map((slide) => {
    const out: DeckSlideData = { layout: slide.layout, elements: [] };
    if (typeof slide.bg === "string") out.bg = slide.bg;
    else if (slide.bg) {
      out.bg = { media: slide.bg.asset };
      media[slide.bg.asset] = { type: "", asset: slide.bg.asset };
    }
    if (slide.notes) out.notes = slide.notes;
    if (slide.hidden) out.hidden = true;
    for (const el of slide.elements) {
      if (el.type === "image" && !el.asset) continue;
      const item: DeckElementData = { type: el.type, x: el.x, y: el.y, w: el.w, h: el.h };
      if (el.rot) item.rot = el.rot;
      if (el.role) item.role = el.role;
      if (el.text) item.text = el.text;
      if (el.style) item.style = el.style;
      if (el.asset) {
        item.media = el.asset;
        media[el.asset] = { type: "", asset: el.asset };
      }
      if (el.fit) item.fit = el.fit;
      if (el.alt) item.alt = el.alt;
      if (el.table) item.table = el.table;
      if (el.chart) item.chart = el.chart;
      out.elements.push(item);
    }
    return out;
  });
  return { w: deck.w, h: deck.h, theme: deck.theme, slides, media };
}
