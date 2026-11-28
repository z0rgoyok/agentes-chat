import * as Y from "yjs";
import type { Box } from "../canvas/geometry";
import { LiveEditError } from "../errors";
import { isOrderKey, keyBetween, keysBetween, restack, type StackMove } from "../fractional";
import { cleanGroupName, groupMembersOf, type LiveGroup, outermostGroup, usedGroups } from "../groups";
import { newId } from "../ids";
import { LIVE_LIMITS } from "../limits";
import { cloneValue, overwriteText } from "../restore";
import { richFromText, richLength } from "../rich/text";
import type { RichDoc } from "../rich/types";
import { writeRich } from "../rich/yjs";
import { FALLBACK_SLOTS, LAYOUTS, type LayoutSlot, roleFamily, slotFor } from "./layouts";
import {
  cleanBackground,
  cleanChart,
  cleanDeckFonts,
  cleanStyle,
  cleanStyleValue,
  cleanTable,
  coord,
  deckMapOf,
  elementMapOf,
  elementsMapOf,
  groupsMapOf,
  isRefId,
  readElements,
  readGroups,
  rotation,
  slideIdsOf,
  slideLayoutOf,
  slideMapOf,
  slideOrderOf,
  slidesMapOf,
} from "./store";
import { SLIDE_H, SLIDE_W } from "./themes";
import {
  type AddSlideOptions,
  type DeckFonts,
  type ElementPatch,
  type ElementStyle,
  type ElementType,
  type ElementView,
  isElementType,
  isSlideLayout,
  isSlideRole,
  isThemeId,
  type NewElement,
  type SlideBackground,
  type SlideLayout,
  type SlideRole,
  type ThemeId,
} from "./types";

/**
 * Edits to a presentation (ADR 0196 §2), the same for the web, the phone and the agents' tools. Each runs in one
 * `doc.transact(fn, origin)`, and checks everything it was given before it changes anything (Yjs keeps what a
 * transaction did before a throw), so a refused edit leaves the document as it was: `LiveEditError` `not_found` for
 * a slide or element that isn't there, `too_many` / `too_large` past `LIVE_LIMITS`, `invalid` for a value the deck
 * can't hold.
 */

const limits = LIVE_LIMITS.slides;

function invalid(message: string): LiveEditError {
  return new LiveEditError("invalid", message);
}

function needSlide(doc: Y.Doc, id: string): Y.Map<unknown> {
  const slide = slideMapOf(doc, id);
  if (!slide) throw new LiveEditError("not_found", `No slide ${id}`);
  return slide;
}

function richOf(text: string | RichDoc): RichDoc {
  return typeof text === "string" ? richFromText(text) : text;
}

function checkText(rich: RichDoc, what: string): void {
  if (richLength(rich) > limits.textChars) {
    throw new LiveEditError("too_large", `${what} is over ${limits.textChars} characters`);
  }
}

function checkBox(box: Box, line: boolean): Box {
  const x = coord(box.x);
  const y = coord(box.y);
  const w = coord(box.w);
  const h = coord(box.h);
  if (x === undefined || y === undefined || w === undefined || h === undefined) throw invalid("Bad box");
  if (!line && (w < 0 || h < 0)) throw invalid("A box can't have a negative size");
  return { x, y, w, h };
}

function sameBox(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** The key that puts a new element on top of the slide's others. */
function topKey(elements: Y.Map<Y.Map<unknown>> | null): string {
  let top: string | null = null;
  elements?.forEach((value) => {
    const z = value instanceof Y.Map ? value.get("z") : undefined;
    if (isOrderKey(z) && (top === null || z > top)) top = z;
  });
  return keyBetween(top, null);
}

function setBox(map: Y.Map<unknown>, box: Box): void {
  map.set("x", box.x);
  map.set("y", box.y);
  map.set("w", box.w);
  map.set("h", box.h);
}

function textElement(
  role: SlideRole | undefined,
  box: Box,
  style: ElementStyle | undefined,
  text: RichDoc,
): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set("type", "text");
  setBox(map, box);
  if (role) map.set("role", role);
  const fragment = new Y.XmlFragment();
  writeRich(fragment, text);
  map.set("text", fragment);
  if (style) map.set("style", { ...style });
  return map;
}

function imageElement(box: Box, asset: string | undefined, fit: "cover" | "contain"): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set("type", "image");
  setBox(map, box);
  if (asset) map.set("asset", asset);
  map.set("fit", fit);
  return map;
}

/** Where an image goes on a layout without an image slot: the right column, the body taking the left one. */
const SIDE_IMAGE: Box = { x: 1008, y: 304, w: 792, h: 680 };
const SIDE_BODY: Box = { x: 120, y: 304, w: 840, h: 680 };

/** A new slide's map with its layout's placeholders, filled with what was given. */
function newSlideMap(
  layout: SlideLayout,
  parts: { title?: RichDoc; body?: RichDoc; image?: string; notes?: string },
): Y.Map<unknown> {
  const titleSlot = slotFor(layout, "title");
  const bodySlot = slotFor(layout, "body");
  const slots = LAYOUTS[layout];
  const hasImageSlot = slots.some((slot) => slot.type === "image");
  const elements: Y.Map<unknown>[] = [];
  let imageUsed = false;
  for (const slot of slots) {
    if (slot.type === "text") {
      let text: RichDoc = [];
      if (slot === titleSlot && parts.title) text = parts.title;
      else if (slot === bodySlot && parts.body) text = parts.body;
      const narrow = slot === bodySlot && !!parts.image && !hasImageSlot && sameBox(slot.box, FALLBACK_SLOTS.body);
      elements.push(textElement(slot.role, narrow ? SIDE_BODY : slot.box, slot.style, text));
    } else {
      elements.push(imageElement(slot.box, imageUsed ? undefined : parts.image, "cover"));
      imageUsed = true;
    }
  }
  if (parts.title && !titleSlot) elements.push(textElement("title", FALLBACK_SLOTS.title, undefined, parts.title));
  if (parts.body && !bodySlot) {
    elements.push(textElement("body", parts.image ? SIDE_BODY : FALLBACK_SLOTS.body, undefined, parts.body));
  }
  if (parts.image && !hasImageSlot) elements.push(imageElement(SIDE_IMAGE, parts.image, "contain"));
  const slide = new Y.Map<unknown>();
  slide.set("layout", layout);
  const notes = new Y.Text();
  if (parts.notes) notes.insert(0, parts.notes);
  slide.set("notes", notes);
  const map = new Y.Map<Y.Map<unknown>>();
  const keys = keysBetween(null, null, elements.length);
  elements.forEach((element, i) => {
    element.set("z", keys[i] ?? keyBetween(null, null));
    map.set(newId(), element as Y.Map<unknown>);
  });
  slide.set("elements", map);
  return slide;
}

/** Puts `id` in the order before the slide now at `at` (the end when `at` is past the last one or left out). */
function placeInOrder(doc: Y.Doc, id: string, at: number | undefined): void {
  const order = slideOrderOf(doc);
  const ids = slideIdsOf(doc).filter((other) => other !== id);
  const index = at === undefined || !Number.isFinite(at) ? ids.length : Math.max(0, Math.floor(at));
  const before = index < ids.length ? ids[index] : undefined;
  const position = before === undefined ? -1 : order.toArray().indexOf(before);
  if (position < 0) order.push([id]);
  else order.insert(position, [id]);
}

/**
 * Adds a slide with its layout's placeholders (default: `title-body`, or `image-right` with an image). `title` fills
 * the headline slot (the title, the big number or the quote), `body` the main text slot (the body, the subtitle or the
 * caption), both light Markdown; on a layout without such a slot they get a box of their own, and an image without an
 * image slot takes the right column. Returns the new slide's id.
 */
export function addSlide(doc: Y.Doc, opts: AddSlideOptions, origin: unknown): string {
  if (slideIdsOf(doc).length >= limits.slides) {
    throw new LiveEditError("too_many", `A presentation holds at most ${limits.slides} slides`);
  }
  const layout = opts.layout ?? (opts.image ? "image-right" : "title-body");
  if (!isSlideLayout(layout)) throw invalid(`Unknown layout ${String(layout)}`);
  const title = opts.title ? richOf(opts.title) : undefined;
  const body = opts.body ? richOf(opts.body) : undefined;
  if (title) checkText(title, "The title");
  if (body) checkText(body, "The text");
  if (opts.notes && opts.notes.length > limits.textChars) {
    throw new LiveEditError("too_large", `Notes are over ${limits.textChars} characters`);
  }
  if (opts.image && !isRefId(opts.image.asset)) throw invalid("Bad image");
  const id = newId();
  doc.transact(() => {
    slidesMapOf(doc).set(
      id,
      newSlideMap(layout, {
        ...(title ? { title } : {}),
        ...(body ? { body } : {}),
        ...(opts.image ? { image: opts.image.asset } : {}),
        ...(opts.notes ? { notes: opts.notes } : {}),
      }),
    );
    placeInOrder(doc, id, opts.at);
  }, origin);
  return id;
}

/** A copy of a slide right after it (its elements get new ids). Returns the copy's id. */
export function duplicateSlide(doc: Y.Doc, id: string, origin: unknown): string {
  const slide = needSlide(doc, id);
  if (slideIdsOf(doc).length >= limits.slides) {
    throw new LiveEditError("too_many", `A presentation holds at most ${limits.slides} slides`);
  }
  const copy = new Y.Map<unknown>();
  for (const [key, value] of slide.entries()) {
    if (key !== "elements") copy.set(key, cloneValue(value));
  }
  const elements = new Y.Map<Y.Map<unknown>>();
  elementsMapOf(slide)?.forEach((value) => {
    if (value instanceof Y.Map) elements.set(newId(), value.clone() as Y.Map<unknown>);
  });
  copy.set("elements", elements);
  const next = newId();
  const ids = slideIdsOf(doc);
  doc.transact(() => {
    slidesMapOf(doc).set(next, copy);
    placeInOrder(doc, next, ids.indexOf(id) + 1);
  }, origin);
  return next;
}

/** Deletes slides (ids that aren't there are skipped). */
export function deleteSlides(doc: Y.Doc, ids: readonly string[], origin: unknown): void {
  const gone = new Set(ids);
  if (!gone.size) return;
  doc.transact(() => {
    const order = slideOrderOf(doc);
    const items = order.toArray();
    for (let i = items.length - 1; i >= 0; i--) {
      if (gone.has(items[i] as string)) order.delete(i, 1);
    }
    const slides = slidesMapOf(doc);
    for (const id of gone) if (slides.has(id)) slides.delete(id);
  }, origin);
}

/** Moves a slide to the 0-based position `toIndex` (in the order without it). */
export function moveSlide(doc: Y.Doc, id: string, toIndex: number, origin: unknown): void {
  needSlide(doc, id);
  const ids = slideIdsOf(doc);
  const others = ids.filter((other) => other !== id);
  const to = Number.isFinite(toIndex) ? Math.min(others.length, Math.max(0, Math.floor(toIndex))) : others.length;
  const order = slideOrderOf(doc).toArray();
  if (ids.indexOf(id) === to && order.filter((other) => other === id).length === 1) return;
  doc.transact(() => {
    const array = slideOrderOf(doc);
    const items = array.toArray();
    for (let i = items.length - 1; i >= 0; i--) if (items[i] === id) array.delete(i, 1);
    placeInOrder(doc, id, to);
  }, origin);
}

/** The style a placeholder keeps when it moves to another layout's slot: the old slot's look out, the new one's in. */
function restyle(
  style: ElementStyle | undefined,
  from: ElementStyle | undefined,
  to: ElementStyle | undefined,
): ElementStyle | undefined {
  const next: Record<string, unknown> = { ...(style ?? {}) };
  for (const [key, value] of Object.entries(from ?? {})) if (next[key] === value) delete next[key];
  Object.assign(next, to ?? {});
  return Object.keys(next).length ? (next as ElementStyle) : undefined;
}

/**
 * Changes a slide's layout, keeping its texts: each placeholder moves to the new layout's slot with the same role, or
 * else one of the same family (a title to the big number, a body to the caption); an empty placeholder with no slot
 * goes, one with text stays where it is; the layout's picture moves to its new image slot (an empty one with no slot
 * goes); slots left empty get new placeholders.
 */
export function setLayout(doc: Y.Doc, id: string, layout: SlideLayout, origin: unknown): void {
  const slide = needSlide(doc, id);
  if (!isSlideLayout(layout)) throw invalid(`Unknown layout ${String(layout)}`);
  const old = slideLayoutOf(slide);
  if (old === layout && slide.get("layout") === layout) return;
  const views = readElements(slide);
  const oldSlots = LAYOUTS[old];
  const oldImages = oldSlots.filter((slot) => slot.type === "image").map((slot) => slot.box);
  const texts = views.filter((v) => v.type === "text" && v.role);
  const images = views.filter((v) => v.type === "image" && oldImages.some((box) => sameBox(box, v)));
  const slots = LAYOUTS[layout];
  const assigned = new Map<LayoutSlot, ElementView>();
  const used = new Set<string>();
  const take = (slot: LayoutSlot, pick: (v: ElementView) => boolean, from: ElementView[]) => {
    if (assigned.has(slot)) return;
    const found = from.find((v) => !used.has(v.id) && pick(v));
    if (!found) return;
    assigned.set(slot, found);
    used.add(found.id);
  };
  for (const slot of slots) if (slot.type === "text") take(slot, (v) => v.role === slot.role, texts);
  for (const slot of slots) {
    if (slot.type === "text") take(slot, (v) => !!v.role && roleFamily(v.role) === roleFamily(slot.role), texts);
  }
  for (const slot of slots) if (slot.type === "image") take(slot, () => true, images);
  doc.transact(() => {
    slide.set("layout", layout);
    let elements = elementsMapOf(slide);
    if (!elements) {
      elements = new Y.Map<Y.Map<unknown>>();
      slide.set("elements", elements);
    }
    for (const [slot, view] of assigned) {
      const map = elementMapOf(slide, view.id);
      if (!map) continue;
      setBox(map, slot.box);
      if (map.has("rot")) map.delete("rot");
      if (slot.type === "text") {
        const before = oldSlots.find((s) => s.type === "text" && s.role === view.role);
        map.set("role", slot.role);
        const style = restyle(view.style, before?.style, slot.style);
        if (style) map.set("style", style);
        else if (map.has("style")) map.delete("style");
      }
    }
    for (const view of [...texts, ...images]) {
      if (used.has(view.id)) continue;
      const empty = view.type === "text" ? !(view.text ?? []).some((p) => p.runs.length) : !view.asset;
      if (empty) elements.delete(view.id);
    }
    for (const slot of slots) {
      if (assigned.has(slot)) continue;
      const element =
        slot.type === "text"
          ? textElement(slot.role, slot.box, slot.style, [])
          : imageElement(slot.box, undefined, "cover");
      element.set("z", topKey(elements));
      elements.set(newId(), element as Y.Map<unknown>);
    }
  }, origin);
}

/** Sets a slide's background (a color or a picture of the file), or takes it away with `null`. */
export function setBackground(doc: Y.Doc, id: string, bg: SlideBackground | null, origin: unknown): void {
  const slide = needSlide(doc, id);
  const clean = bg === null ? null : cleanBackground(bg);
  if (clean === undefined) throw invalid("Bad background");
  doc.transact(() => {
    if (clean === null) slide.delete("bg");
    else slide.set("bg", typeof clean === "string" ? clean : { ...clean });
  }, origin);
}

/** Hides a slide from the presentation (it stays in the deck), or shows it again. */
export function setHidden(doc: Y.Doc, id: string, hidden: boolean, origin: unknown): void {
  const slide = needSlide(doc, id);
  if ((slide.get("hidden") === true) === hidden) return;
  doc.transact(() => {
    if (hidden) slide.set("hidden", true);
    else slide.delete("hidden");
  }, origin);
}

/** Sets a slide's speaker notes, changing only the characters that differ (someone may be typing in them). */
export function setNotes(doc: Y.Doc, id: string, text: string, origin: unknown): void {
  const slide = needSlide(doc, id);
  if (text.length > limits.textChars) throw new LiveEditError("too_large", `Notes are over ${limits.textChars}`);
  doc.transact(() => {
    const notes = slide.get("notes");
    if (notes instanceof Y.Text) overwriteText(notes, text);
    else {
      const fresh = new Y.Text();
      fresh.insert(0, text);
      slide.set("notes", fresh);
    }
  }, origin);
}

/** The deck's theme. */
export function setTheme(doc: Y.Doc, theme: ThemeId, origin: unknown): void {
  if (!isThemeId(theme)) throw invalid(`Unknown theme ${String(theme)}`);
  const deck = deckMapOf(doc);
  if (deck.get("theme") === theme) return;
  doc.transact(() => {
    deck.set("theme", theme);
    if (deck.get("w") !== SLIDE_W) deck.set("w", SLIDE_W);
    if (deck.get("h") !== SLIDE_H) deck.set("h", SLIDE_H);
  }, origin);
}

/** Where a new element of a type goes when no box is given: centered on the slide at a size that suits it. */
export function defaultBox(type: ElementType, rows = 3): Box {
  const centered = (w: number, h: number): Box => ({ x: (SLIDE_W - w) / 2, y: (SLIDE_H - h) / 2, w, h });
  switch (type) {
    case "text":
      return centered(960, 200);
    case "shape":
      return centered(480, 320);
    case "image":
      return centered(960, 540);
    case "chart":
      return centered(1200, 640);
    case "table":
      return centered(1440, Math.min(680, Math.max(160, rows * 80)));
    case "line":
      return { x: 660, y: SLIDE_H / 2, w: 600, h: 0 };
  }
}

/** A slide element's values, checked; what to store under each key. */
function checkedElement(el: NewElement): Record<string, unknown> {
  if (!isElementType(el.type)) throw invalid(`Unknown element type ${String(el.type)}`);
  const out: Record<string, unknown> = { type: el.type };
  const table = el.type === "table" ? cleanTable(el.table) : undefined;
  if (el.type === "table" && !table) throw invalid("A table needs rows of cells");
  if (table) {
    const chars = table.rows.reduce((n, row) => n + row.reduce((m, cell) => m + cell.length, 0), 0);
    if (chars > limits.textChars) throw new LiveEditError("too_large", `The table is over ${limits.textChars}`);
    out.table = table;
  }
  const chart = el.type === "chart" ? cleanChart(el.chart) : undefined;
  if (el.type === "chart" && !chart) throw invalid("The chart's data doesn't fit together");
  if (chart) out.chart = chart;
  Object.assign(out, checkBox(el.box ?? defaultBox(el.type, table?.rows.length), el.type === "line"));
  const rot = rotation(el.rot);
  if (rot) out.rot = rot;
  if (el.role !== undefined) {
    if (!isSlideRole(el.role)) throw invalid(`Unknown role ${String(el.role)}`);
    out.role = el.role;
  }
  if (el.type === "text" || el.type === "shape") {
    const rich = el.text === undefined ? [] : richOf(el.text);
    checkText(rich, "The text");
    out.text = rich;
  }
  const style = cleanStyle(el.style);
  if (style) out.style = style;
  if (el.group !== undefined) {
    if (!isRefId(el.group)) throw invalid("Bad group");
    out.group = el.group;
  }
  if (el.type === "image") {
    if (el.asset !== undefined) {
      if (!isRefId(el.asset)) throw invalid("Bad image");
      out.asset = el.asset;
    }
    out.fit = el.fit === "cover" ? "cover" : "contain";
    if (typeof el.alt === "string" && el.alt) out.alt = el.alt.slice(0, 1000);
  }
  return out;
}

/** Adds an element on top of a slide's others. Returns its id. */
export function addElement(doc: Y.Doc, slideId: string, el: NewElement, origin: unknown): string {
  const slide = needSlide(doc, slideId);
  const values = checkedElement(el);
  const elements = elementsMapOf(slide);
  if ((elements?.size ?? 0) >= limits.elements) {
    throw new LiveEditError("too_many", `A slide holds at most ${limits.elements} elements`);
  }
  const id = newId();
  doc.transact(() => {
    let map = elements;
    if (!map) {
      map = new Y.Map<Y.Map<unknown>>();
      slide.set("elements", map);
    }
    const element = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(values)) {
      if (key === "text") {
        const fragment = new Y.XmlFragment();
        writeRich(fragment, value as RichDoc);
        element.set("text", fragment);
      } else element.set(key, value);
    }
    element.set("z", topKey(map));
    map.set(id, element);
  }, origin);
  return id;
}

/**
 * Changes an element: keys given change, `null` takes an optional one away, `style` merges key by key (`null` per
 * key takes that key away; `style: null` all of it), `text` replaces the text (light Markdown or rich text).
 */
export function updateElement(doc: Y.Doc, slideId: string, elId: string, patch: ElementPatch, origin: unknown): void {
  const slide = needSlide(doc, slideId);
  const map = elementMapOf(slide, elId);
  if (!map) throw new LiveEditError("not_found", `No element ${elId}`);
  const type = map.get("type");
  const sets: [string, unknown][] = [];
  const deletes: string[] = [];
  for (const key of ["x", "y", "w", "h"] as const) {
    if (patch[key] === undefined) continue;
    const n = coord(patch[key]);
    if (n === undefined || (type !== "line" && (key === "w" || key === "h") && n < 0)) throw invalid(`Bad ${key}`);
    sets.push([key, n]);
  }
  if (patch.rot !== undefined) {
    const rot = patch.rot === null ? 0 : rotation(patch.rot);
    if (rot) sets.push(["rot", rot]);
    else deletes.push("rot");
  }
  if (patch.z !== undefined) {
    if (!isOrderKey(patch.z)) throw invalid("Bad stacking key");
    sets.push(["z", patch.z]);
  }
  if (patch.role !== undefined) {
    if (patch.role === null) deletes.push("role");
    else if (isSlideRole(patch.role)) sets.push(["role", patch.role]);
    else throw invalid(`Unknown role ${String(patch.role)}`);
  }
  let text: RichDoc | undefined;
  if (patch.text !== undefined) {
    if (type !== "text" && type !== "shape") throw invalid("Only text boxes and shapes hold text");
    text = richOf(patch.text);
    checkText(text, "The text");
  }
  if (patch.style !== undefined) {
    if (patch.style === null) deletes.push("style");
    else {
      const style: Record<string, unknown> = { ...(cleanStyle(map.get("style")) ?? {}) };
      for (const [key, value] of Object.entries(patch.style)) {
        if (value === null) delete style[key];
        else if (value !== undefined) {
          const clean = cleanStyleValue(key as keyof ElementStyle, value);
          if (clean === undefined) throw invalid(`Bad style ${key}`);
          style[key] = clean;
        }
      }
      if (Object.keys(style).length) sets.push(["style", style]);
      else deletes.push("style");
    }
  }
  if (patch.asset !== undefined) {
    if (patch.asset === null) deletes.push("asset");
    else if (isRefId(patch.asset)) sets.push(["asset", patch.asset]);
    else throw invalid("Bad image");
  }
  if (patch.fit !== undefined) {
    if (patch.fit === null) deletes.push("fit");
    else if (patch.fit === "cover" || patch.fit === "contain") sets.push(["fit", patch.fit]);
    else throw invalid("Bad fit");
  }
  if (patch.alt !== undefined) {
    if (patch.alt === null || patch.alt === "") deletes.push("alt");
    else sets.push(["alt", String(patch.alt).slice(0, 1000)]);
  }
  if (patch.chart !== undefined) {
    if (patch.chart === null) deletes.push("chart");
    else {
      const chart = cleanChart(patch.chart);
      if (!chart) throw invalid("The chart's data doesn't fit together");
      sets.push(["chart", chart]);
    }
  }
  if (patch.group !== undefined) {
    if (patch.group === null) deletes.push("group");
    else if (isRefId(patch.group)) sets.push(["group", patch.group]);
    else throw invalid("Bad group");
  }
  if (patch.table !== undefined) {
    if (patch.table === null) deletes.push("table");
    else {
      const table = cleanTable(patch.table);
      if (!table) throw invalid("A table needs rows of cells");
      sets.push(["table", table]);
    }
  }
  if (!sets.length && !deletes.length && text === undefined) return;
  doc.transact(() => {
    for (const [key, value] of sets) map.set(key, value);
    for (const key of deletes) if (map.has(key)) map.delete(key);
    if (text !== undefined) {
      const fragment = map.get("text");
      if (fragment instanceof Y.XmlFragment) writeRich(fragment, text);
      else {
        const fresh = new Y.XmlFragment();
        writeRich(fresh, text);
        map.set("text", fresh);
      }
    }
  }, origin);
}

/** Deletes elements from a slide (ids that aren't there are skipped). */
export function deleteElements(doc: Y.Doc, slideId: string, ids: readonly string[], origin: unknown): void {
  const slide = needSlide(doc, slideId);
  const elements = elementsMapOf(slide);
  if (!elements) return;
  const gone = ids.filter((id) => elements.has(id));
  if (!gone.length) return;
  doc.transact(() => {
    for (const id of gone) elements.delete(id);
    pruneGroups(slide);
  }, origin);
}

/** Drops the groups that hold nothing any more (no element, no group inside), inside the caller's transaction. */
function pruneGroups(slide: Y.Map<unknown>): void {
  const map = groupsMapOf(slide);
  if (!map || map.size === 0) return;
  const named: string[] = [];
  elementsMapOf(slide)?.forEach((element) => {
    const group = element instanceof Y.Map ? element.get("group") : undefined;
    if (typeof group === "string") named.push(group);
  });
  const groups = readGroups(slide);
  const used = usedGroups(groups, named);
  for (const g of groups) if (!used.has(g.id)) map.delete(g.id);
}

/** Brings elements to the front or the back, or one step forward or backward. */
export function arrange(doc: Y.Doc, slideId: string, ids: readonly string[], how: StackMove, origin: unknown): void {
  const slide = needSlide(doc, slideId);
  const items = readElements(slide).map((el) => ({ id: el.id, z: el.z }));
  const keys = restack(items, ids, how);
  if (!keys.size) return;
  doc.transact(() => {
    for (const [id, z] of keys) elementMapOf(slide, id)?.set("z", z);
  }, origin);
}

/** An element's rich text, to bind an editor to it (ProseMirror on the web), or null. */
export function elementTextFragment(doc: Y.Doc, slideId: string, elId: string): Y.XmlFragment | null {
  const slide = slideMapOf(doc, slideId);
  const value = slide ? elementMapOf(slide, elId)?.get("text") : undefined;
  return value instanceof Y.XmlFragment ? value : null;
}

/** A slide's speaker notes, to bind a text field to them, or null. */
export function slideNotes(doc: Y.Doc, slideId: string): Y.Text | null {
  const value = slideMapOf(doc, slideId)?.get("notes");
  return value instanceof Y.Text ? value : null;
}

/** The deck's own fonts over its theme's (ADR 0220 §3); null goes back to the theme's. */
export function setDeckFonts(doc: Y.Doc, fonts: DeckFonts | null, origin: unknown): void {
  const deck = deckMapOf(doc);
  const clean = fonts === null ? undefined : cleanDeckFonts(fonts);
  if (fonts !== null && !clean) throw invalid("Name a heading or body font: a catalog font or one of the file's");
  doc.transact(() => {
    if (clean) deck.set("fonts", { ...clean });
    else if (deck.has("fonts")) deck.delete("fonts");
  }, origin);
}

function groupsMapFor(slide: Y.Map<unknown>): Y.Map<unknown> {
  let map = groupsMapOf(slide);
  if (!map) {
    map = new Y.Map<unknown>();
    slide.set("groups", map);
  }
  return map;
}

/**
 * Makes a group of a slide's elements (ADR 0220 §3): they hold together from now on. Elements already in a group
 * bring their group along (it goes inside the new one), so a card of cards stays whole. Returns the group's id.
 */
export function groupElements(
  doc: Y.Doc,
  slideId: string,
  ids: readonly string[],
  opts: { name?: string; id?: string },
  origin: unknown,
): string {
  const slide = needSlide(doc, slideId);
  const elements = elementsMapOf(slide);
  const present = ids.filter((id) => elements?.has(id));
  if (present.length < 1) throw invalid("Name the elements to group");
  const groups = readGroups(slide);
  if (groups.length >= limits.elements) throw new LiveEditError("too_many", "Too many groups on one slide");
  const id = opts.id && isRefId(opts.id) ? opts.id : newId();
  const name = cleanGroupName(opts.name);
  const known = new Set(groups.map((g) => g.id));
  doc.transact(() => {
    const map = groupsMapFor(slide);
    map.set(id, name ? { name } : {});
    const moved = new Set<string>();
    for (const elId of present) {
      const element = elementMapOf(slide, elId);
      if (!element) continue;
      const current = element.get("group");
      const outer = isRefId(current) && known.has(current) ? outermostGroup(groups, current) : undefined;
      if (outer && outer !== id) {
        if (!moved.has(outer)) {
          const g = map.get(outer);
          map.set(outer, { ...(g && typeof g === "object" ? (g as object) : {}), parent: id });
          moved.add(outer);
        }
      } else element.set("group", id);
    }
  }, origin);
  return id;
}

/** Undoes a group: what it held goes to the group it sat in (or to none), and the group goes away. */
export function ungroup(doc: Y.Doc, slideId: string, groupId: string, origin: unknown): void {
  const slide = needSlide(doc, slideId);
  const map = groupsMapOf(slide);
  const group = readGroups(slide).find((g) => g.id === groupId);
  if (!map || !group) throw new LiveEditError("not_found", `No group ${groupId}`);
  doc.transact(() => {
    elementsMapOf(slide)?.forEach((element) => {
      if (!(element instanceof Y.Map) || element.get("group") !== groupId) return;
      if (group.parent) element.set("group", group.parent);
      else element.delete("group");
    });
    map.forEach((value, id) => {
      if (!value || typeof value !== "object" || (value as { parent?: unknown }).parent !== groupId) return;
      const { parent: _gone, ...rest } = value as { parent?: string; name?: string };
      map.set(id, group.parent ? { ...rest, parent: group.parent } : rest);
    });
    map.delete(groupId);
  }, origin);
}

/** Names a group ("" or null takes the name away). */
export function renameGroup(doc: Y.Doc, slideId: string, groupId: string, name: string | null, origin: unknown): void {
  const slide = needSlide(doc, slideId);
  const map = groupsMapOf(slide);
  const value = map?.get(groupId);
  if (!map || !value || typeof value !== "object") throw new LiveEditError("not_found", `No group ${groupId}`);
  const clean = cleanGroupName(name);
  const { name: _old, ...rest } = value as { name?: string; parent?: string };
  doc.transact(() => map.set(groupId, clean ? { ...rest, name: clean } : rest), origin);
}

/** Every element a group holds, its inner groups' included. */
export function groupMembers(
  slide: { elements: { id: string; group?: string }[]; groups?: { id: string; parent?: string }[] },
  groupId: string,
): string[] {
  return groupMembersOf(slide.elements, slide.groups ?? [], groupId);
}

/**
 * Writes groups as they are given (ids, names, parents), inside the caller's batch: what `add_html` lays out (ADR 0220
 * §4) arrives with its whole tree of groups at once. A parent missing from the slide and from `groups` is dropped.
 */
export function putGroups(doc: Y.Doc, slideId: string, groups: readonly LiveGroup[], origin: unknown): void {
  if (!groups.length) return;
  const slide = needSlide(doc, slideId);
  const existing = new Set(readGroups(slide).map((g) => g.id));
  if (existing.size + groups.length > limits.elements)
    throw new LiveEditError("too_many", "Too many groups on one slide");
  const ids = new Set(groups.map((g) => g.id));
  doc.transact(() => {
    const map = groupsMapFor(slide);
    for (const g of groups) {
      if (!isRefId(g.id)) throw invalid("Bad group");
      const name = cleanGroupName(g.name);
      const parent =
        g.parent && (ids.has(g.parent) || existing.has(g.parent)) && g.parent !== g.id ? g.parent : undefined;
      map.set(g.id, { ...(name ? { name } : {}), ...(parent ? { parent } : {}) });
    }
  }, origin);
}
