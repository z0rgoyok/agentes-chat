/**
 * What floats over a whole screen keeps clear of the iPhone Duo's fold (ADR 0212). Two panes split at the fold
 * themselves (`paneFrames`); outside them, while the device is folded like a book, a toast, a notice, a dock or a bar
 * across the screen keeps to one side of the fold's division region, moved as little as it can be. Pure (no React
 * Native import), so it is unit-tested; `useWindowFold` and `useFoldRoom` (TwoPane.tsx) read it.
 */
import { type DuoRegions, type Fold, foldInside } from "./two-pane";

/** The window's fold as `DuoProvider` reads it (`useWindowFold`), in the window's points. */
export interface WindowFold {
  /** The fold's division region, active or not; null when none crosses the window, or where there is no module. */
  fold: Fold | null;
  /** Whether it divides the window now: the device folded like a book (opened flat, it is there but inactive). */
  active: boolean;
  /**
   * Whether the window has a fold at all, active or not: for what should stay put as the device bends (a grid's even
   * column count), as the system's inactive regions are meant for.
   */
  hasFold: boolean;
}

/** No fold: a phone, Android, a build without the module, or before the module reports. */
export const NO_FOLD: WindowFold = { fold: null, active: false, hasFold: false };

/** What a report of modules/duo-layout's view says of the window's fold. */
export function windowFoldOf(fold: DuoRegions["fold"] | undefined): WindowFold {
  if (!fold) return NO_FOLD;
  return { fold: { x: fold.x, width: fold.width }, active: fold.active, hasFold: true };
}

/** Whether two readings say the same: a report that changed only the size class redraws nothing that reads the fold. */
export function sameWindowFold(a: WindowFold, b: WindowFold): boolean {
  return a === b || (a.active === b.active && a.fold?.x === b.fold?.x && a.fold?.width === b.fold?.width);
}

/** The fold that moves things: the window's, only while it is active. */
export function activeWindowFold(windowFold: WindowFold): Fold | null {
  return windowFold.active ? windowFold.fold : null;
}

/** The side of the window a floating thing keeps to while the fold divides it, as insets from the window's edges. */
export interface FoldRoom {
  left: number;
  right: number;
  /** The side of the fold it is on: the trailing one (the right) unless the leading one is wider. */
  side: "leading" | "trailing";
}

/**
 * The side past an active fold that divides a window this wide, as insets from its edges: the trailing side, where the
 * guidance sends what comes and goes (it keeps appearing there as the device closes onto its outer display), or the
 * leading one when that is the wider (a fold off the window's middle). Null when no fold divides the window (none, an
 * inactive one, one at an edge or past it): everything lays out as before.
 */
export function foldRoom(width: number, fold: Fold | null): FoldRoom | null {
  if (!foldInside(width, fold)) return null;
  const end = fold.x + fold.width;
  // Whole points: a fold in the middle reads as two equal sides, never one a hair wider.
  return Math.round(width - end) >= Math.round(fold.x)
    ? { left: end, right: 0, side: "trailing" }
    : { left: 0, right: width - fold.x, side: "leading" };
}

/** The air between the fold and a control kept beside it: as much as a toast keeps from the screen's sides. */
export const FOLD_GAP = 12;

/**
 * A control centered across the whole screen, moved beside the fold: its container (as wide as the screen, centering
 * it) takes the room past the fold, and the control stands at the fold's edge of it, `FOLD_GAP` from the curve; the
 * least move that clears it, instead of a jump across the screen.
 */
export function besideFold(room: FoldRoom) {
  return room.side === "trailing"
    ? { left: room.left, right: room.right, alignItems: "flex-start" as const, paddingLeft: FOLD_GAP }
    : { left: room.left, right: room.right, alignItems: "flex-end" as const, paddingRight: FOLD_GAP };
}

/**
 * A bar across the screen with its controls kept to the room past the fold: its own side padding, plus the room's
 * inset on each side. Its background still spans the screen.
 */
export function padPastFold(room: FoldRoom, side: number) {
  return { paddingLeft: side + room.left, paddingRight: side + room.right };
}

/** What sits `side` in from the screen's edges, kept to the room past the fold instead: the same inset inside it. */
export function insetPastFold(room: FoldRoom, side: number) {
  return { left: side + room.left, right: side + room.right };
}

/** Side insets (the safe area's) kept clear of the fold too: on each side, the safe area's or the room's, the larger. */
export function sidesPastFold(sides: { left: number; right: number }, room: FoldRoom | null) {
  return room ? { left: Math.max(sides.left, room.left), right: Math.max(sides.right, room.right) } : sides;
}

/** The toast's distance from the window's sides. */
export const TOAST_SIDE = 12;

/**
 * Where the toast's layer goes, as insets from the window's sides: `TOAST_SIDE` from each, the toast centered between
 * them and never wider. With an active fold dividing the window, the same inside the room past it: the toast stands in
 * the middle of that half, as wide as it allows at most, never across the curve.
 */
export function toastInsets(width: number, fold: Fold | null): { left: number; right: number } {
  const room = foldRoom(width, fold);
  return { left: TOAST_SIDE + (room?.left ?? 0), right: TOAST_SIDE + (room?.right ?? 0) };
}
