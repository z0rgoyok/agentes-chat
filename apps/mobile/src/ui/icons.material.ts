import type { IconName } from "./icons.data";
import { MATERIAL_PATHS } from "./icons.material.data";
import { MATERIAL_NAMES, TAB_MATERIAL } from "./icons.material.names";

/** The grid Google's symbols are drawn on. */
export const MATERIAL_VIEWBOX = "0 -960 960 960";

/**
 * Google's symbol for an icon on Android: its path data, filled when `filled` (a white glyph on a colored tile, a
 * selected tab), or null to draw our line icon. iOS has its own file (`icons.material.ios.ts`) that carries none of
 * the paths: the iPhone draws Apple's symbols.
 */
export function materialPathOf(name: IconName, filled = false): string | null {
  const symbol = MATERIAL_NAMES[name];
  const paths = symbol ? MATERIAL_PATHS[symbol] : undefined;
  if (!paths) return null;
  return filled ? paths.fill : paths.line;
}

/** A tab's glyph from Google's symbols (Android), outline or filled when selected; null keeps ours (Agentes). */
export function materialTabPathOf(glyph: keyof typeof TAB_MATERIAL, selected: boolean): string | null {
  const symbol = TAB_MATERIAL[glyph];
  const paths = symbol ? MATERIAL_PATHS[symbol] : undefined;
  if (!paths) return null;
  return selected ? paths.fill : paths.line;
}
