import type { Box } from "../canvas/geometry";
import type { ElementStyle, SlideLayout, SlideRole } from "./types";

/**
 * Slide layouts (ADR 0196 §2): where a new slide's placeholders sit on the 1920×1080 slide. Proportions follow good
 * keynote templates: generous margins (120 to 200 units at the sides, never text closer than 80 to an edge), titles
 * that grow upwards from a fixed baseline area so one or two lines both sit right, body text starting at the same
 * height on every content layout, and pictures that bleed to the edge.
 *
 * A text placeholder has a role (how the theme styles it, and how agents name it); an image placeholder has none.
 * `style` is the layout's own look for that slot (a bigger title on a title slide) over the theme's.
 */

export type LayoutSlot =
  | { type: "text"; role: SlideRole; box: Box; style?: ElementStyle }
  | { type: "image"; role?: undefined; box: Box; style?: ElementStyle };

/** The content area every content layout shares: title on top, body under it. */
const TITLE: Box = { x: 120, y: 80, w: 1680, h: 176 };
const BODY: Box = { x: 120, y: 304, w: 1680, h: 680 };

export const LAYOUTS: Record<SlideLayout, readonly LayoutSlot[]> = {
  title: [
    { type: "text", role: "title", box: { x: 160, y: 288, w: 1600, h: 336 }, style: { size: 112 } },
    { type: "text", role: "subtitle", box: { x: 160, y: 672, w: 1600, h: 144 } },
  ],
  "title-body": [
    { type: "text", role: "title", box: TITLE },
    { type: "text", role: "body", box: BODY },
  ],
  section: [
    { type: "text", role: "title", box: { x: 160, y: 352, w: 1600, h: 256 }, style: { size: 96 } },
    { type: "text", role: "subtitle", box: { x: 160, y: 648, w: 1600, h: 144 } },
  ],
  "two-columns": [
    { type: "text", role: "title", box: TITLE },
    { type: "text", role: "body", box: { x: 120, y: 304, w: 800, h: 680 } },
    { type: "text", role: "body2", box: { x: 1000, y: 304, w: 800, h: 680 } },
  ],
  "image-left": [
    { type: "image", box: { x: 0, y: 0, w: 912, h: 1080 } },
    { type: "text", role: "title", box: { x: 1008, y: 120, w: 792, h: 288 } },
    { type: "text", role: "body", box: { x: 1008, y: 456, w: 792, h: 504 } },
  ],
  "image-right": [
    { type: "text", role: "title", box: { x: 120, y: 120, w: 792, h: 288 } },
    { type: "text", role: "body", box: { x: 120, y: 456, w: 792, h: 504 } },
    { type: "image", box: { x: 1008, y: 0, w: 912, h: 1080 } },
  ],
  "big-number": [
    { type: "text", role: "number", box: { x: 160, y: 176, w: 1600, h: 432 } },
    { type: "text", role: "caption", box: { x: 160, y: 648, w: 1600, h: 200 }, style: { size: 48 } },
  ],
  quote: [
    { type: "text", role: "quote", box: { x: 200, y: 200, w: 1520, h: 480 }, style: { size: 64 } },
    { type: "text", role: "caption", box: { x: 200, y: 728, w: 1520, h: 96 }, style: { size: 32 } },
  ],
  "title-only": [{ type: "text", role: "title", box: TITLE }],
  blank: [],
};

/** Where a title or a body goes on a layout that has no slot for it (agents may send both for any layout). */
export const FALLBACK_SLOTS = { title: TITLE, body: BODY } as const;

/** Roles that hold a slide's headline (what `addSlide`'s `title` fills) and its main text (`body`), in that order. */
export const HEADLINE_ROLES: readonly SlideRole[] = ["title", "number", "quote"];
export const MAIN_TEXT_ROLES: readonly SlideRole[] = ["body", "subtitle", "caption"];

/** The text slot of a layout that takes a slide's headline, or its main text. */
export function slotFor(layout: SlideLayout, part: "title" | "body"): (LayoutSlot & { type: "text" }) | null {
  const roles = part === "title" ? HEADLINE_ROLES : MAIN_TEXT_ROLES;
  for (const role of roles) {
    const slot = LAYOUTS[layout].find((s): s is LayoutSlot & { type: "text" } => s.type === "text" && s.role === role);
    if (slot) return slot;
  }
  return null;
}

/** The family a role belongs to: when a slide changes layout, a text moves to a slot of the same family. */
export function roleFamily(role: SlideRole): "headline" | "main" | "second" {
  if (HEADLINE_ROLES.includes(role)) return "headline";
  return role === "body2" ? "second" : "main";
}
