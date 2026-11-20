import type { Peer } from "@agenteschat/live/awareness";
import type { RichAlign, RichDoc, RichRun } from "@agenteschat/live/rich";
import {
  type ElementView,
  SLIDE_H,
  SLIDE_LAYOUTS,
  SLIDE_W,
  type SlideLayout,
  type SlideRole,
  type SlideView,
} from "@agenteschat/live/slides";

/**
 * Presentations on the phone (ADR 0196 §9): a slide drawn in its own units (the deck's 1920×1080) scaled to the
 * screen, its texts as the web draws them (lists, levels, marks), the phone's text editor (one paragraph a line), who
 * is on which slide, who presents, and which slides a presentation shows. Pure: the screens draw it and the tests read
 * it.
 */

export interface DeckSize {
  w: number;
  h: number;
}

const DECK: DeckSize = { w: SLIDE_W, h: SLIDE_H };

/** Points per slide unit for a slide `width` points wide. */
export function slideScale(width: number, deck: DeckSize = DECK): number {
  return deck.w > 0 && width > 0 ? width / deck.w : 0;
}

/** How tall a slide `width` points wide is. */
export function slideHeight(width: number, deck: DeckSize = DECK): number {
  return deck.w > 0 && width > 0 ? (width * deck.h) / deck.w : 0;
}

/** The biggest slide that fits `box` whole (presenting), centered in it: its size in points and where it starts. */
export function fitSlide(
  box: { width: number; height: number },
  deck: DeckSize = DECK,
): { width: number; height: number; left: number; top: number } {
  if (box.width <= 0 || box.height <= 0 || deck.w <= 0 || deck.h <= 0) return { width: 0, height: 0, left: 0, top: 0 };
  const width = Math.min(box.width, (box.height * deck.w) / deck.h);
  const height = (width * deck.h) / deck.w;
  return { width, height, left: (box.width - width) / 2, top: (box.height - height) / 2 };
}

/** Where an element sits on a slide drawn at `k` points per unit: its box (a line's from both of its ends). */
export interface ElementFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Degrees, clockwise around its middle. */
  rot: number;
}

export function elementFrame(el: Pick<ElementView, "type" | "x" | "y" | "w" | "h" | "rot">, k: number): ElementFrame {
  const line = el.type === "line";
  const x = line ? Math.min(el.x, el.x + el.w) : el.x;
  const y = line ? Math.min(el.y, el.y + el.h) : el.y;
  return {
    left: x * k,
    top: y * k,
    width: Math.abs(el.w) * k,
    height: Math.abs(el.h) * k,
    rot: el.rot ?? 0,
  };
}

/**
 * The box a finger answers to around an element (in points): at least `min` on each side, grown evenly around the
 * element, so a thin line or a short caption on a small slide is still easy to tap.
 */
export function touchSlop(
  frame: Pick<ElementFrame, "width" | "height">,
  min = 44,
): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  const x = Math.max(0, (min - frame.width) / 2);
  const y = Math.max(0, (min - frame.height) / 2);
  return { top: y, bottom: y, left: x, right: x };
}

/** Elements whose words the phone edits: text boxes and shapes' labels. */
export const holdsText = (el: Pick<ElementView, "type">) => el.type === "text" || el.type === "shape";

/** Whether rich text has no words. */
export const richEmpty = (rich: RichDoc | undefined) =>
  !(rich ?? []).some((p) => p.runs.some((r) => r.text.length > 0));

/** Roles that hold a slide's headline (the theme draws them in its heading look). */
const HEADLINES: readonly SlideRole[] = ["title", "number", "quote"];

/** What an empty text box says while it can be edited ("Toque para adicionar um título"); null for anything else. */
export function placeholderOf(el: Pick<ElementView, "type" | "role" | "text">): "title" | "text" | null {
  if (el.type !== "text" || !richEmpty(el.text)) return null;
  return el.role && HEADLINES.includes(el.role) ? "title" : "text";
}

/** What a text box is, in words (`mobile.live.slides.part.*`). */
export type SlidePart = "title" | "subtitle" | "body" | "caption" | "number" | "quote" | "shape" | "text";

/** A text box's part: its role's name, a shape's label, or a plain text box. */
export function partOf(el: Pick<ElementView, "type" | "role">): SlidePart {
  if (el.type === "shape") return "shape";
  switch (el.role) {
    case "title":
    case "subtitle":
    case "caption":
    case "number":
    case "quote":
      return el.role;
    case "body":
    case "body2":
      return "body";
    default:
      return "text";
  }
}

// ── Text as the web draws it ───────────────────────────────────────────────────────────────────────────────────────

/** A list item's ordinal by paragraph (null: not in an ordered list), restarting below and after a list, as the web. */
export function listNumbers(paragraphs: readonly { list?: unknown; level?: unknown }[]): (number | null)[] {
  const counts: number[] = [];
  return paragraphs.map((p) => {
    const level = typeof p.level === "number" ? Math.max(0, Math.floor(p.level)) : 0;
    counts.length = Math.min(counts.length, level + 1);
    if (p.list !== "ordered") {
      counts.length = Math.min(counts.length, level);
      return null;
    }
    while (counts.length <= level) counts.push(0);
    counts[level] = (counts[level] ?? 0) + 1;
    return counts[level] ?? 1;
  });
}

/** One paragraph as drawn: its marker ("•", "◦", "▪", "3."), its indent in ems, its alignment and its runs. */
export interface DrawnParagraph {
  marker: string | null;
  /** Where the marker hangs, in ems of the box's size. */
  markerAt: number;
  /** Where the words start, in ems. */
  indent: number;
  align: RichAlign | null;
  runs: RichRun[];
}

/** Ems a level indents (the web's 1.4em gutter). */
export const LEVEL_EM = 1.4;
/** Ems between two paragraphs. */
export const PARAGRAPH_GAP_EM = 0.3;

const BULLETS = ["•", "◦", "▪", "◦", "▪"];

export function drawnParagraphs(rich: RichDoc): DrawnParagraph[] {
  const numbers = listNumbers(rich);
  return rich.map((p, i) => {
    const level = Math.max(0, Math.min(4, Math.floor(p.level ?? 0)));
    const marker = p.list === "bullet" ? (BULLETS[level] ?? "•") : p.list === "ordered" ? `${numbers[i] ?? 1}.` : null;
    return {
      marker,
      markerAt: level * LEVEL_EM,
      indent: (level + (marker ? 1 : 0)) * LEVEL_EM,
      align: p.align ?? null,
      runs: p.runs,
    };
  });
}

/** A run's look in React Native's words. */
export function runLook(run: RichRun): {
  fontWeight?: "700";
  fontStyle?: "italic";
  textDecorationLine?: "underline" | "line-through" | "underline line-through";
  color?: string;
} {
  const decoration =
    run.underline && run.strike
      ? "underline line-through"
      : run.underline
        ? "underline"
        : run.strike
          ? "line-through"
          : null;
  return {
    ...(run.bold ? { fontWeight: "700" as const } : {}),
    ...(run.italic ? { fontStyle: "italic" as const } : {}),
    ...(decoration ? { textDecorationLine: decoration } : {}),
    ...(run.color ? { color: run.color } : {}),
  };
}

// ── The phone's text editor (`editParagraphTexts`) ────────────────────────────────────────────────────────────────

/**
 * A line break inside a paragraph, as the editor's field holds it: the field's own new line is a new paragraph, so a
 * break typed on the web (a Shift+Enter) travels through the field as the system's line separator and comes back.
 */
export const LINE_BREAK = " ";

/** A text box's words for the field: one paragraph a line. */
export function editorText(rich: RichDoc | undefined): string {
  return (rich ?? [])
    .map((p) =>
      p.runs
        .map((r) => r.text)
        .join("")
        .replace(/\n/g, LINE_BREAK),
    )
    .join("\n");
}

/** The field's words back as paragraphs' texts (what `editParagraphTexts` takes). */
export function paragraphTexts(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(new RegExp(LINE_BREAK, "g"), "\n"));
}

// ── Who is where, who presents ────────────────────────────────────────────────────────────────────────────────────

/** Everyone else on each slide (by the slide they say they are at), in the order `peersOf` gives them. */
export function peersBySlide<P extends Pick<Peer, "self" | "state">>(peers: readonly P[]): Map<string, P[]> {
  const out = new Map<string, P[]>();
  for (const p of peers) {
    if (p.self) continue;
    const at = p.state.presenting?.slide ?? p.state.at?.slide;
    if (!at) continue;
    const list = out.get(at) ?? [];
    list.push(p);
    out.set(at, list);
  }
  return out;
}

/** The element ids someone else has selected on a slide, with who (their outline on the slide). */
export function peerSelections<P extends Pick<Peer, "self" | "state" | "clientId">>(
  peers: readonly P[],
  slideId: string,
): { peer: P; ids: string[] }[] {
  return peers.flatMap((p) =>
    !p.self && p.state.at?.slide === slideId && p.state.sel?.slide?.length ? [{ peer: p, ids: p.state.sel.slide }] : [],
  );
}

/** Who presents now (someone else, the latest to start), or null. */
export function presenterOf<P extends Pick<Peer, "self" | "state">>(peers: readonly P[]): P | null {
  let best: P | null = null;
  for (const p of peers) {
    if (p.self || !p.state.presenting) continue;
    if (!best || (p.state.presenting.since ?? 0) > (best.state.presenting?.since ?? 0)) best = p;
  }
  return best;
}

/** The slides a presentation shows: every one not hidden, in order. */
export const shownSlides = <S extends Pick<SlideView, "hidden">>(slides: readonly S[]): S[] =>
  slides.filter((s) => !s.hidden);

/**
 * Where presenting starts: the slide asked for, or the first shown slide after it when it is hidden (the first one
 * when none follows), as a place among the shown slides.
 */
export function showStart(slides: readonly Pick<SlideView, "id" | "hidden">[], slideId: string | null): number {
  const shown = shownSlides(slides);
  if (!slideId || shown.length === 0) return 0;
  const at = shown.findIndex((s) => s.id === slideId);
  if (at >= 0) return at;
  const from = slides.findIndex((s) => s.id === slideId);
  if (from < 0) return 0;
  const next = slides.slice(from + 1).find((s) => !s.hidden);
  return next ? shown.indexOf(next) : 0;
}

// ── Layouts ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A layout's key under `live.slides.layouts` ("title-body" → "titleBody"). */
export const layoutKey = (layout: SlideLayout): string =>
  layout.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** The layouts "Novo slide" offers, in the web's order. */
export const LAYOUT_CHOICES: readonly SlideLayout[] = SLIDE_LAYOUTS;

/** Where a slide goes when moved one place up (-1) or down (1); null when it can't go that way. */
export function moveTarget(index: number, count: number, step: -1 | 1): number | null {
  const to = index + step;
  return to < 0 || to >= count ? null : to;
}
