import type { IconName } from "./icons.data";
import type { TAB_MATERIAL } from "./icons.material.names";

/** The grid Google's symbols are drawn on. */
export const MATERIAL_VIEWBOX = "0 -960 960 960";

/** iOS draws Apple's symbols (`icons.sf.ts`): none of Google's paths ride in the iPhone's bundle. */
export function materialPathOf(_name: IconName, _filled = false): string | null {
  return null;
}

export function materialTabPathOf(_glyph: keyof typeof TAB_MATERIAL, _selected: boolean): string | null {
  return null;
}
