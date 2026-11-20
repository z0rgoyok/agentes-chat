import { LiveEditError, LOCAL } from "@agenteschat/live";
import {
  addElement,
  addSlide,
  arrange,
  deleteElements,
  deleteSlides,
  duplicateSlide,
  type ElementPatch,
  type ElementView,
  moveSlide,
  type NewElement,
  SLIDE_H,
  SLIDE_W,
  type SlideLayout,
  setHidden,
  setLayout,
  setTheme,
  type ThemeId,
  updateElement,
} from "@agenteschat/live/slides";
import type * as Y from "yjs";
import { boundsOf, elementBox, roundBox } from "./geometry";

/**
 * The presentation's edits as the editor makes them (ADR 0196 §2): each one goes through `@agenteschat/live`'s slide
 * edits with the `LOCAL` origin (so the person's undo takes it back, and only theirs), several at once in one
 * transaction. A refused edit (past a limit, a slide someone else just deleted) comes back as its code for the words.
 */

export type EditRefusal = LiveEditError["code"] | "unknown";

const REFUSALS: ReadonlySet<string> = new Set<EditRefusal>([
  "not_found",
  "too_many",
  "too_large",
  "invalid",
  "unknown",
]);

/** An edit's answer that is a refusal, not the id of what it made (ids are 10 lowercase letters and digits). */
export const isRefusal = (result: string | EditRefusal | null): result is EditRefusal =>
  result !== null && REFUSALS.has(result);

/** The file's undo by its document, so each command is a step of its own (see `edit`). */
const undoOf = new WeakMap<Y.Doc, Y.UndoManager>();

/** Tells the edits below which undo is the file's (the editor does, as it opens the file). */
export function bindUndo(doc: Y.Doc, undo: Y.UndoManager) {
  undoOf.set(doc, undo);
}

/**
 * Runs `fn` as one change of this person's; the refusal's code when the document said no. A command is a step of
 * undo of its own, never joined to what came just before or after it (the undo joins changes that come quickly, which
 * suits typing, not two commands); `merge` keeps it in the step being made (a drag writes many times as one).
 */
export function edit(doc: Y.Doc, fn: () => void, opts: { merge?: boolean } = {}): EditRefusal | null {
  const undo = opts.merge ? undefined : undoOf.get(doc);
  undo?.stopCapturing();
  try {
    doc.transact(fn, LOCAL);
    return null;
  } catch (error) {
    return error instanceof LiveEditError ? error.code : "unknown";
  } finally {
    undo?.stopCapturing();
  }
}

/** A slide after `afterId` (or at the end), with `layout`. Returns its id, or the refusal. */
export function newSlide(doc: Y.Doc, layout: SlideLayout, at: number | undefined): string | EditRefusal {
  let id = "";
  const refused = edit(doc, () => {
    id = addSlide(doc, { layout, ...(at !== undefined ? { at } : {}) }, LOCAL);
  });
  return refused ?? id;
}

export function copySlide(doc: Y.Doc, id: string): string | EditRefusal {
  let next = "";
  const refused = edit(doc, () => {
    next = duplicateSlide(doc, id, LOCAL);
  });
  return refused ?? next;
}

export const removeSlides = (doc: Y.Doc, ids: string[]) => edit(doc, () => deleteSlides(doc, ids, LOCAL));
export const placeSlide = (doc: Y.Doc, id: string, to: number) => edit(doc, () => moveSlide(doc, id, to, LOCAL));
export const hideSlide = (doc: Y.Doc, id: string, hidden: boolean) =>
  edit(doc, () => setHidden(doc, id, hidden, LOCAL));
export const changeLayout = (doc: Y.Doc, id: string, layout: SlideLayout) =>
  edit(doc, () => setLayout(doc, id, layout, LOCAL));
export const changeTheme = (doc: Y.Doc, theme: ThemeId) => edit(doc, () => setTheme(doc, theme, LOCAL));

/** Adds an element on top; its id, or the refusal. */
export function insertElement(doc: Y.Doc, slideId: string, el: NewElement): string | EditRefusal {
  let id = "";
  const refused = edit(doc, () => {
    id = addElement(doc, slideId, el, LOCAL);
  });
  return refused ?? id;
}

/** Several elements changed at once (one step of undo; `merge`: part of the step being made, as a drag's). */
export function patchElements(
  doc: Y.Doc,
  slideId: string,
  patches: { id: string; patch: ElementPatch }[],
  opts: { merge?: boolean } = {},
) {
  return edit(
    doc,
    () => {
      for (const { id, patch } of patches) updateElement(doc, slideId, id, patch, LOCAL);
    },
    opts,
  );
}

export const removeElements = (doc: Y.Doc, slideId: string, ids: string[]) =>
  edit(doc, () => deleteElements(doc, slideId, ids, LOCAL));

export const restack = (doc: Y.Doc, slideId: string, ids: string[], how: "front" | "back" | "forward" | "backward") =>
  edit(doc, () => arrange(doc, slideId, ids, how, LOCAL));

/** What it takes to make an element again (a copy, a paste): everything but its id and stacking key. */
export function elementSeed(el: ElementView, offset = 0): NewElement {
  const seed: NewElement = {
    type: el.type,
    box: { x: el.x + offset, y: el.y + offset, w: el.w, h: el.h },
  };
  if (el.rot) seed.rot = el.rot;
  if (el.role) seed.role = el.role;
  if (el.text) seed.text = el.text;
  if (el.style) seed.style = { ...el.style };
  if (el.asset) seed.asset = el.asset;
  if (el.fit) seed.fit = el.fit;
  if (el.alt) seed.alt = el.alt;
  if (el.chart) seed.chart = el.chart;
  if (el.table) seed.table = { rows: el.table.rows.map((r) => [...r]), header: el.table.header };
  return seed;
}

/** Copies of elements on a slide, in their stacking order, shifted so they don't sit right over what they copy. */
export function copyElements(doc: Y.Doc, slideId: string, els: ElementView[], offset: number): string[] | EditRefusal {
  const ids: string[] = [];
  const refused = edit(doc, () => {
    for (const el of els) ids.push(addElement(doc, slideId, elementSeed(el, offset), LOCAL));
  });
  return refused ?? ids;
}

export type AlignHow = "left" | "center" | "right" | "top" | "middle" | "bottom";

/**
 * Lines elements up: one alone with the slide, several with the box around them all (as every slide editor does).
 * Each moves as a whole, turned boxes by their upright bounds.
 */
export function alignPatches(
  els: ElementView[],
  how: AlignHow,
  slide: { w: number; h: number } = { w: SLIDE_W, h: SLIDE_H },
): { id: string; patch: ElementPatch }[] {
  const target = els.length === 1 ? { x: 0, y: 0, w: slide.w, h: slide.h } : boundsOf(els);
  if (!target) return [];
  return els.map((el) => {
    const b = boundsOf([el]) ?? elementBox(el);
    let dx = 0;
    let dy = 0;
    if (how === "left") dx = target.x - b.x;
    else if (how === "center") dx = target.x + target.w / 2 - (b.x + b.w / 2);
    else if (how === "right") dx = target.x + target.w - (b.x + b.w);
    else if (how === "top") dy = target.y - b.y;
    else if (how === "middle") dy = target.y + target.h / 2 - (b.y + b.h / 2);
    else dy = target.y + target.h - (b.y + b.h);
    const moved = roundBox({ x: el.x + dx, y: el.y + dy, w: el.w, h: el.h });
    return { id: el.id, patch: { x: moved.x, y: moved.y } };
  });
}

/** A picture's box on the slide: its own shape, as large as fits in the middle 60% of the slide. */
export function imageBox(width: number | null, height: number | null, slide = { w: SLIDE_W, h: SLIDE_H }) {
  const maxW = slide.w * 0.6;
  const maxH = slide.h * 0.6;
  const ratio = width && height ? width / height : 16 / 9;
  let w = maxW;
  let h = w / ratio;
  if (h > maxH) {
    h = maxH;
    w = h * ratio;
  }
  return roundBox({ x: (slide.w - w) / 2, y: (slide.h - h) / 2, w, h });
}
