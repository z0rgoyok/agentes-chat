import {
  type CountedPointer,
  CURSOR_FLIP_AT,
  type CursorSpot,
  cursorTagLifts,
  type PointerView,
  pointerAtRest,
  pointerInView,
  pointerShare,
} from "@agenteschat/client";
import { fitScale, type Size } from "./screen-view";

/** How a box shows the picture, and the box's size: the edges that would cut the arrow's name. */
export type PointerBox = PointerView & { boxWidth: number; boxHeight: number };

/**
 * What the agent's arrow does for one gesture: where it goes, its rings, only its face while typing, the name turned
 * left where the tip lands past 0.74 of the box and lifted above the arrow where the box's bottom would cut it, both
 * by where the tip lands in the box (a pinch and a pan move the picture under it). `rest` for a gesture over by
 * `now` (`pointerAtRest`): a view shown later (a card opened, control handed back) places it there, never replays it.
 */
export function pointerStep(
  p: CountedPointer,
  view: PointerBox,
  now: number,
): { to: CursorSpot; presses: 0 | 1 | 2; quiet: boolean; flip: boolean; lift: boolean; rest: boolean } {
  const rest = pointerAtRest(p, now);
  const to = pointerShare(p);
  const tip = pointerInView(to, view);
  return {
    to,
    presses: rest ? 0 : p.act === "double" ? 2 : p.act === "click" ? 1 : 0,
    quiet: p.act === "type",
    flip: tip.x > CURSOR_FLIP_AT * view.boxWidth,
    lift: cursorTagLifts(tip.y, view.boxHeight),
    rest,
  };
}

/** The browser card's view of the desktop: the whole screen scaled to fit, pinned at the box's top left. */
export const watchView = (box: Size, desk: Size): PointerBox => ({
  s: fitScale(box, desk),
  x: 0,
  y: 0,
  ...desk,
  boxWidth: box.width,
  boxHeight: box.height,
});
