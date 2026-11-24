import { CONNECTOR_MARK, OWN_MARK } from "./connected";

/**
 * A service's look in the connectors store, the same on the web and the phone: its mark (a one-color mark of ours,
 * `/connectors/…`, or one in its maker's colors, `/brands/…`) and its brand's colors, the leading one first. The art
 * behind a featured service and on top of its page is drawn from these (`BrandArt` on each app).
 */
export interface BrandLook {
  mark: string | null;
  /** Its mark keeps its maker's colors (never tinted). */
  own: boolean;
  colors: string[];
}

/** Brands' primary colors, the leading one first, by their mark's file; the rest get theirs from the brand color. */
const BRAND_COLORS: Record<string, string[]> = {
  figma: ["#A259FF", "#F24E1E", "#1ABCFE", "#0ACF83", "#FF7262"],
  canva: ["#7D2AE7", "#00C4CC", "#6420FF"],
  posthog: ["#F54E00", "#1D4AFF", "#F9BD2B"],
  sentry: ["#7553FF", "#E1567C", "#362D59"],
  gmail: ["#EA4335", "#4285F4", "#FBBC04", "#34A853"],
  outlook: ["#0078D4", "#28A8EA", "#50D9FF"],
  notion: ["#9B9A97", "#5A5955"],
  linear: ["#5E6AD2", "#8B93FF"],
  slack: ["#4A154B", "#36C5F0", "#2EB67D", "#ECB22E", "#E01E5A"],
  github: ["#8957E5", "#2DA44E", "#0969DA"],
  hubspot: ["#FF7A59", "#FF5C35", "#00BDA5"],
  googledrive: ["#4285F4", "#0F9D58", "#F4B400"],
  stripe: ["#635BFF", "#00D4FF", "#0A2540"],
  postgresql: ["#336791", "#6BA4D8"],
  tiktok: ["#25F4EE", "#FE2C55"],
  meta: ["#0467DF", "#0082FB", "#A33BC2"],
};

/** Our own sky's blues, for a service with no brand color. */
const SKY = ["#2B74E6", "#78B4FF", "#0F56C4"];

const toHex = (rgb: number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
function shade(color: string, toward: number[], k: number) {
  const n = Number.parseInt(color.slice(1, 7), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return toHex(rgb.map((v, i) => v + ((toward[i] ?? v) - v) * k));
}

/** A service's look from its mark's address and its brand color, as the catalog gives them. */
export function brandLook(iconUrl: string | null | undefined, brandColor: string | null | undefined): BrandLook {
  const own = !!iconUrl && OWN_MARK.test(iconUrl);
  const mark = iconUrl && (own || CONNECTOR_MARK.test(iconUrl)) ? iconUrl : null;
  const file = mark?.replace(/^.*\/([a-z0-9-]+)\.svg$/, "$1");
  const known = file ? BRAND_COLORS[file] : undefined;
  if (known) return { mark, own, colors: known };
  if (brandColor && /^#[0-9a-fA-F]{6}$/.test(brandColor)) {
    return {
      mark,
      own,
      colors: [brandColor, shade(brandColor, [255, 255, 255], 0.4), shade(brandColor, [10, 10, 14], 0.35)],
    };
  }
  return { mark, own, colors: SKY };
}

/** The same numbers for the same brand, so its art looks the same on every visit and on every device. */
export function brandRandom(seed: string) {
  let s = [...seed].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
