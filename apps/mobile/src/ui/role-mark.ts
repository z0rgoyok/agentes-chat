import { bodyTones, toneAt } from "@agenteschat/ui/agent/engine";
import { ICON_NAMES, type IconName } from "./icons.data";

/**
 * Dither cells and icon size for a role mark `size` points wide: the web's (`packages/ui` RoleMark), the icon at most
 * 72% of the circle so a small mark keeps a rim of color around it. Pure, for `RoleMark` and its tests.
 */
export function roleMarkFit(size: number) {
  const web =
    size <= 16
      ? { cells: 8, icon: 10 }
      : size <= 20
        ? { cells: 8, icon: 12 }
        : size <= 28
          ? { cells: 10, icon: 16 }
          : size <= 40
            ? { cells: 14, icon: 20 }
            : { cells: 18, icon: Math.round(size * 0.47) };
  return { cells: web.cells, icon: Math.min(web.icon, Math.floor(size * 0.72)) };
}

/** The icon a mark draws: the role's when the phone has it, else the shield (the server's default). */
export const roleMarkIcon = (icon: string): IconName =>
  (ICON_NAMES as readonly string[]).includes(icon) ? (icon as IconName) : "shield";

const tonePaths = new Map<string, { fill: string; d: string }[]>();

/**
 * The color's dither (`bodySvg`'s tones and cells) as one path per tone, cached per color and grid: five shapes a
 * mark however many cells, so a list of a hundred cargos stays light.
 */
export function ditherPaths(color: string, cells: number) {
  const key = `${color}:${cells}`;
  const cached = tonePaths.get(key);
  if (cached) return cached;
  const tones = bodyTones(color);
  const d = tones.map(() => "");
  for (let y = 0; y < cells; y++) {
    let start = 0;
    let run = toneAt(0, y, cells);
    for (let x = 1; x <= cells; x++) {
      const tone = x < cells ? toneAt(x, y, cells) : -1;
      if (tone === run) continue;
      d[run] += `M${start} ${y}h${x - start}v1h${start - x}z`;
      start = x;
      run = tone;
    }
  }
  const out = tones.flatMap((fill, i) => (d[i] ? [{ fill, d: d[i] ?? "" }] : []));
  tonePaths.set(key, out);
  return out;
}
