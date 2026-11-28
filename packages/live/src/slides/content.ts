import * as Y from "yjs";
import { LIVE_LIMITS } from "../limits";
import { overwriteArray, overwriteMap } from "../restore";
import { clipRich, richLength, richText } from "../rich/text";
import { readRich } from "../rich/yjs";
import { addSlide } from "./ops";
import { coord, deckFonts, deckMapOf, deckTheme, readSlide, slideIdsOf, slideOrderOf, slidesMapOf } from "./store";
import { DEFAULT_THEME, SLIDE_H, SLIDE_W } from "./themes";
import { type ElementView, isElementType, isSlideLayout, type SlidesPreview, type SlideView } from "./types";

/**
 * A presentation as a whole (ADR 0196 §2, §7): a new one, its preview (what cards and the Drive draw), its text (what
 * search finds it by), its rules of shape (what the server checks) and a version's content written over it.
 */

/** A new presentation's content: the default theme and one title slide. Does nothing when it already has slides. */
export function initSlides(doc: Y.Doc, origin: unknown = null): void {
  doc.transact(() => {
    if (slideIdsOf(doc).length > 0) return;
    const deck = deckMapOf(doc);
    deck.set("theme", DEFAULT_THEME);
    deck.set("w", SLIDE_W);
    deck.set("h", SLIDE_H);
    addSlide(doc, { layout: "title" }, origin);
  }, origin);
}

/** What a preview keeps of a slide: enough to draw a thumbnail, small enough to send with every card. */
const PREVIEW = { elements: 60, textChars: 400, tableRows: 8, tableCols: 6, cellChars: 80 } as const;

function previewSlide(slide: SlideView): SlideView {
  let elements = slide.elements;
  if (elements.length > PREVIEW.elements) {
    // Keep the biggest (what a thumbnail shows), drawn in their own order.
    const keep = new Set(
      [...elements]
        .sort((a, b) => Math.abs(b.w * b.h) - Math.abs(a.w * a.h))
        .slice(0, PREVIEW.elements)
        .map((el) => el.id),
    );
    elements = elements.filter((el) => keep.has(el.id));
  }
  return {
    ...slide,
    notes: "",
    elements: elements.map((el): ElementView => {
      const out: ElementView = { ...el };
      if (el.text) out.text = clipRich(el.text, PREVIEW.textChars);
      if (el.table) {
        out.table = {
          header: el.table.header,
          rows: el.table.rows
            .slice(0, PREVIEW.tableRows)
            .map((row) => row.slice(0, PREVIEW.tableCols).map((cell) => cell.slice(0, PREVIEW.cellChars))),
        };
      }
      return out;
    }),
  };
}

/** The deck's theme, its slide count and its first slide shown in a presentation (a thumbnail's worth of it). */
export function slidesPreview(doc: Y.Doc): SlidesPreview {
  const ids = slideIdsOf(doc);
  const slides = slidesMapOf(doc);
  // Only the slide the card shows is read, however long the deck.
  const shown = ids.find((id) => slides.get(id)?.get("hidden") !== true) ?? ids[0];
  const first = shown ? readSlide(doc, shown) : null;
  const fonts = deckFonts(doc);
  return {
    theme: deckTheme(doc),
    ...(fonts ? { fonts } : {}),
    count: ids.length,
    first: first ? previewSlide(first) : null,
  };
}

/** The most text `slidesText` gives (search reads the first 20,000 characters). */
const TEXT_CHARS = 20_000;

function elementText(el: ElementView): string {
  if (el.text) return richText(el.text);
  if (el.table) return el.table.rows.map((row) => row.join(" | ")).join("\n");
  if (el.chart) {
    const parts = [el.chart.title, el.chart.subtitle ?? "", el.chart.labels.join(", ")];
    parts.push(el.chart.series.map((s) => s.name).join(", "));
    return parts.filter(Boolean).join("\n");
  }
  return el.alt ?? "";
}

/** The words of the presentation, slide by slide in reading order (top to bottom, left to right), with the notes. */
export function slidesText(doc: Y.Doc): string {
  const out: string[] = [];
  let length = 0;
  for (const id of slideIdsOf(doc)) {
    const slide = readSlide(doc, id);
    if (!slide) continue;
    const elements = [...slide.elements].sort((a, b) => a.y - b.y || a.x - b.x);
    const words = [...elements.map(elementText), slide.notes].filter((text) => text.trim()).join("\n");
    if (!words) continue;
    out.push(words);
    length += words.length + 2;
    if (length >= TEXT_CHARS) break;
  }
  return out.join("\n\n").slice(0, TEXT_CHARS);
}

/** What breaks the deck's rules of shape or `LIVE_LIMITS` (sentences for the logs; empty when nothing does). */
export function validateSlides(doc: Y.Doc): string[] {
  const limits = LIVE_LIMITS.slides;
  const problems: string[] = [];
  const order = slideOrderOf(doc).toArray();
  if (order.some((id) => typeof id !== "string")) problems.push("The slide order holds something that isn't an id");
  const count = slideIdsOf(doc).length;
  if (count > limits.slides) problems.push(`The deck has ${count} slides (at most ${limits.slides})`);
  slidesMapOf(doc).forEach((slide, id) => {
    if (!(slide instanceof Y.Map)) {
      problems.push(`Slide ${id} isn't a map`);
      return;
    }
    if (!isSlideLayout(slide.get("layout"))) problems.push(`Slide ${id} has no known layout`);
    const notes = slide.get("notes");
    if (!(notes instanceof Y.Text)) problems.push(`Slide ${id} has no notes text`);
    else if (notes.length > limits.textChars) problems.push(`Slide ${id}'s notes are over ${limits.textChars}`);
    const groups = slide.get("groups");
    if (groups !== undefined && !(groups instanceof Y.Map)) problems.push(`Slide ${id}'s groups aren't a map`);
    else if (groups instanceof Y.Map && groups.size > limits.elements) {
      problems.push(`Slide ${id} has ${groups.size} groups (at most ${limits.elements})`);
    }
    const elements = slide.get("elements");
    if (!(elements instanceof Y.Map)) {
      problems.push(`Slide ${id} has no elements map`);
      return;
    }
    if (elements.size > limits.elements) {
      problems.push(`Slide ${id} has ${elements.size} elements (at most ${limits.elements})`);
    }
    elements.forEach((element, elId) => {
      const where = `Element ${elId} of slide ${id}`;
      if (!(element instanceof Y.Map)) {
        problems.push(`${where} isn't a map`);
        return;
      }
      const type = element.get("type");
      if (!isElementType(type)) {
        problems.push(`${where} has no known type`);
        return;
      }
      if (["x", "y", "w", "h"].some((key) => coord(element.get(key)) === undefined)) {
        problems.push(`${where} has no valid box`);
      }
      if (typeof element.get("z") !== "string") problems.push(`${where} has no stacking key`);
      if (type === "text" || type === "shape") {
        const text = element.get("text");
        if (!(text instanceof Y.XmlFragment)) problems.push(`${where} has no text`);
        else if (richLength(readRich(text)) > limits.textChars) problems.push(`${where}'s text is over the limit`);
      }
    });
  });
  return problems;
}

/** Writes `from`'s presentation over `doc`'s in one transaction with `origin`, changing only what differs. */
export function replaceSlides(doc: Y.Doc, from: Y.Doc, origin: unknown): void {
  doc.transact(() => {
    overwriteMap(deckMapOf(doc), deckMapOf(from));
    overwriteArray(slideOrderOf(doc), slideOrderOf(from));
    overwriteMap(slidesMapOf(doc), slidesMapOf(from));
  }, origin);
}

/** A slide by its 1-based number in the deck (how people and agents name slides), or null. */
export function slideByNumber(doc: Y.Doc, n: number): SlideView | null {
  const id = Number.isInteger(n) && n >= 1 ? slideIdsOf(doc)[n - 1] : undefined;
  return id ? readSlide(doc, id) : null;
}
