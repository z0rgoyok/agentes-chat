import { extraIcons } from "./extra";
import { sourceIcons } from "./source";
import type { IconShape } from "./types";

/**
 * Our icon set as plain data (20px grid, 1.6 stroke, round ends, drawn in the text's color): what `Icon` draws, and
 * what the server turns into pictures for live files (ADR 0220 §4, `icon:<name>` in `add_html`). No React here.
 */
export const iconShapes: Record<keyof typeof sourceIcons | keyof typeof extraIcons, IconShape[]> = {
  ...sourceIcons,
  ...extraIcons,
};

/** An icon of the set as a standalone SVG document in `color`, or null for a name the set doesn't have. */
export function iconSvg(name: string, color: string): string | null {
  if (!Object.hasOwn(iconShapes, name)) return null;
  const shapes = iconShapes[name as keyof typeof iconShapes];
  const body = shapes
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${v.replace(/"/g, "&quot;")}"`)
          .join(" ")}/>`,
    )
    .join("");
  const ink = /^#[0-9a-f]{3,8}$/i.test(color) ? color : "#0e1a2b";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}
