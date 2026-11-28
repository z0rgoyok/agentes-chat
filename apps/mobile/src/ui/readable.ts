/**
 * A readable column on a large screen (an iPad, a Mac, the iPhone Duo's inner display): a screen's content runs at
 * most `READABLE_MAX` wide and its sides open into margins past it, as the system keeps its lists and text to a
 * readable width instead of edge to edge. Pure (no React Native import), so it is unit-tested; `useReadableSide` reads
 * it for where a screen lays out.
 */

/** The widest a screen's content runs, in points. */
export const READABLE_MAX = 720;

/** The margin each side of a screen's content gets in this width so it stays `READABLE_MAX` wide: 0 on every phone. */
export const readableSide = (width: number) => Math.max(0, Math.floor((width - READABLE_MAX) / 2));
