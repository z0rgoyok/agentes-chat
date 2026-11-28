/**
 * Fonts in live files (ADR 0220 §1–3): the catalog the server ships, and how a file names a font.
 *
 * A `FontRef` is a catalog id (`inter`), one of the file's own fonts (`asset:<id>`, copied in from the Drive like a
 * picture) or a theme role (`heading`, `body`), which each kind turns into its theme's or the document's own font.
 * Pure data shared by the web, the phone and the server: where the files are served from is the server's business.
 */

export type FontCategory = "sans" | "serif" | "display" | "mono" | "handwriting";

export const FONT_CATEGORIES: readonly FontCategory[] = ["sans", "serif", "display", "mono", "handwriting"];

export type FontScript = "latin" | "latin-ext" | "cyrillic" | "greek" | "vietnamese";

/** A weight as CSS says it, 100 to 900 in steps of 100. */
export type FontWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;

export const FONT_WEIGHTS: readonly FontWeight[] = [100, 200, 300, 400, 500, 600, 700, 800, 900];

export function isFontWeight(value: unknown): value is FontWeight {
  return typeof value === "number" && (FONT_WEIGHTS as readonly number[]).includes(value);
}

export interface CatalogFont {
  /** Lowercase words joined by "-": how files and tools name it. */
  id: string;
  /** The family's own name, as CSS and office files name it. */
  family: string;
  category: FontCategory;
  /** The weights it draws (variable families: every step their weight axis covers). */
  weights: readonly FontWeight[];
  italic: boolean;
  scripts: readonly FontScript[];
  license: "OFL-1.1" | "Apache-2.0";
}

/**
 * The 44 families the server ships (ADR 0220 §1): SIL Open Font License 1.1 with no reserved name, Roboto Slab under
 * Apache 2.0, and Source Sans 3 (reserved name "Source"), shipped as its authors' own files. Order: by category, the
 * app's own fonts first.
 */
export const FONT_CATALOG: readonly CatalogFont[] = [
  {
    id: "source-sans-3",
    family: "Source Sans 3",
    category: "sans",
    weights: [200, 300, 400, 500, 600, 700, 800, 900],
    italic: true,
    scripts: ["latin", "latin-ext", "cyrillic", "greek", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "onest",
    family: "Onest",
    category: "sans",
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    italic: false,
    scripts: ["latin", "latin-ext", "cyrillic", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "inter",
    family: "Inter",
    category: "sans",
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    italic: true,
    scripts: ["latin", "latin-ext", "cyrillic", "greek", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "geist",
    family: "Geist",
    category: "sans",
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    italic: true,
    scripts: ["latin", "latin-ext", "cyrillic", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "manrope",
    family: "Manrope",
    category: "sans",
    weights: [200, 300, 400, 500, 600, 700, 800],
    italic: false,
    scripts: ["latin", "latin-ext", "cyrillic", "greek", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "dm-sans",
    family: "DM Sans",
    category: "sans",
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    italic: true,
    scripts: ["latin", "latin-ext"],
    license: "OFL-1.1",
  },
  {
    id: "plus-jakarta-sans",
    family: "Plus Jakarta Sans",
    category: "sans",
    weights: [200, 300, 400, 500, 600, 700, 800],
    italic: true,
    scripts: ["latin", "latin-ext", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "outfit",
    family: "Outfit",
    category: "sans",
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    italic: false,
    scripts: ["latin", "latin-ext"],
    license: "OFL-1.1",
  },
  {
    id: "figtree",
    family: "Figtree",
    category: "sans",
    weights: [300, 400, 500, 600, 700, 800, 900],
    italic: true,
    scripts: ["latin", "latin-ext"],
    license: "OFL-1.1",
  },
  {
    id: "work-sans",
    family: "Work Sans",
    category: "sans",
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    italic: true,
    scripts: ["latin", "latin-ext", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "roboto",
    family: "Roboto",
    category: "sans",
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    italic: true,
    scripts: ["latin", "latin-ext", "cyrillic", "greek", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "open-sans",
    family: "Open Sans",
    category: "sans",
    weights: [300, 400, 500, 600, 700, 800],
    italic: true,
    scripts: ["latin", "latin-ext", "cyrillic", "greek", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "montserrat",
    family: "Montserrat",
    category: "sans",
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    italic: true,
    scripts: ["latin", "latin-ext", "cyrillic", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "poppins",
    family: "Poppins",
    category: "sans",
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    italic: true,
    scripts: ["latin", "latin-ext"],
    license: "OFL-1.1",
  },
  {
    id: "nunito",
    family: "Nunito",
    category: "sans",
    weights: [200, 300, 400, 500, 600, 700, 800, 900],
    italic: true,
    scripts: ["latin", "latin-ext", "cyrillic", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "rubik",
    family: "Rubik",
    category: "sans",
    weights: [300, 400, 500, 600, 700, 800, 900],
    italic: true,
    scripts: ["latin", "latin-ext", "cyrillic"],
    license: "OFL-1.1",
  },
  {
    id: "space-grotesk",
    family: "Space Grotesk",
    category: "sans",
    weights: [300, 400, 500, 600, 700],
    italic: false,
    scripts: ["latin", "latin-ext", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "sora",
    family: "Sora",
    category: "sans",
    weights: [100, 200, 300, 400, 500, 600, 700, 800],
    italic: false,
    scripts: ["latin", "latin-ext"],
    license: "OFL-1.1",
  },
  {
    id: "instrument-sans",
    family: "Instrument Sans",
    category: "sans",
    weights: [400, 500, 600, 700],
    italic: true,
    scripts: ["latin", "latin-ext"],
    license: "OFL-1.1",
  },
  {
    id: "fraunces",
    family: "Fraunces",
    category: "serif",
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    italic: true,
    scripts: ["latin", "latin-ext", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "source-serif-4",
    family: "Source Serif 4",
    category: "serif",
    weights: [200, 300, 400, 500, 600, 700, 800, 900],
    italic: true,
    scripts: ["latin", "latin-ext", "cyrillic", "greek", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "newsreader",
    family: "Newsreader",
    category: "serif",
    weights: [200, 300, 400, 500, 600, 700, 800],
    italic: true,
    scripts: ["latin", "latin-ext", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "eb-garamond",
    family: "EB Garamond",
    category: "serif",
    weights: [400, 500, 600, 700, 800],
    italic: true,
    scripts: ["latin", "latin-ext", "cyrillic", "greek", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "literata",
    family: "Literata",
    category: "serif",
    weights: [200, 300, 400, 500, 600, 700, 800, 900],
    italic: true,
    scripts: ["latin", "latin-ext", "cyrillic", "greek", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "crimson-pro",
    family: "Crimson Pro",
    category: "serif",
    weights: [200, 300, 400, 500, 600, 700, 800, 900],
    italic: true,
    scripts: ["latin", "latin-ext", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "instrument-serif",
    family: "Instrument Serif",
    category: "serif",
    weights: [400],
    italic: true,
    scripts: ["latin", "latin-ext"],
    license: "OFL-1.1",
  },
  {
    id: "roboto-slab",
    family: "Roboto Slab",
    category: "serif",
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    italic: false,
    scripts: ["latin", "latin-ext", "cyrillic", "greek", "vietnamese"],
    license: "Apache-2.0",
  },
  {
    id: "funnel-display",
    family: "Funnel Display",
    category: "display",
    weights: [300, 400, 500, 600, 700, 800],
    italic: false,
    scripts: ["latin", "latin-ext"],
    license: "OFL-1.1",
  },
  {
    id: "bricolage-grotesque",
    family: "Bricolage Grotesque",
    category: "display",
    weights: [200, 300, 400, 500, 600, 700, 800],
    italic: false,
    scripts: ["latin", "latin-ext", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "syne",
    family: "Syne",
    category: "display",
    weights: [400, 500, 600, 700, 800],
    italic: false,
    scripts: ["latin", "latin-ext", "greek"],
    license: "OFL-1.1",
  },
  {
    id: "anton",
    family: "Anton",
    category: "display",
    weights: [400],
    italic: false,
    scripts: ["latin", "latin-ext", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "bebas-neue",
    family: "Bebas Neue",
    category: "display",
    weights: [400],
    italic: false,
    scripts: ["latin", "latin-ext"],
    license: "OFL-1.1",
  },
  {
    id: "archivo-black",
    family: "Archivo Black",
    category: "display",
    weights: [400],
    italic: false,
    scripts: ["latin", "latin-ext"],
    license: "OFL-1.1",
  },
  {
    id: "unbounded",
    family: "Unbounded",
    category: "display",
    weights: [200, 300, 400, 500, 600, 700, 800, 900],
    italic: false,
    scripts: ["latin", "latin-ext", "cyrillic", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "oswald",
    family: "Oswald",
    category: "display",
    weights: [200, 300, 400, 500, 600, 700],
    italic: false,
    scripts: ["latin", "latin-ext", "cyrillic", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "doto",
    family: "Doto",
    category: "display",
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    italic: false,
    scripts: ["latin", "latin-ext"],
    license: "OFL-1.1",
  },
  {
    id: "jetbrains-mono",
    family: "JetBrains Mono",
    category: "mono",
    weights: [100, 200, 300, 400, 500, 600, 700, 800],
    italic: true,
    scripts: ["latin", "latin-ext", "cyrillic", "greek", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "martian-mono",
    family: "Martian Mono",
    category: "mono",
    weights: [100, 200, 300, 400, 500, 600, 700, 800],
    italic: false,
    scripts: ["latin", "latin-ext", "cyrillic"],
    license: "OFL-1.1",
  },
  {
    id: "geist-mono",
    family: "Geist Mono",
    category: "mono",
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    italic: true,
    scripts: ["latin", "latin-ext", "cyrillic", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "fira-code",
    family: "Fira Code",
    category: "mono",
    weights: [300, 400, 500, 600, 700],
    italic: false,
    scripts: ["latin", "latin-ext", "cyrillic", "greek"],
    license: "OFL-1.1",
  },
  {
    id: "space-mono",
    family: "Space Mono",
    category: "mono",
    weights: [400, 700],
    italic: true,
    scripts: ["latin", "latin-ext", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "dm-mono",
    family: "DM Mono",
    category: "mono",
    weights: [300, 400, 500],
    italic: true,
    scripts: ["latin", "latin-ext"],
    license: "OFL-1.1",
  },
  {
    id: "roboto-mono",
    family: "Roboto Mono",
    category: "mono",
    weights: [100, 200, 300, 400, 500, 600, 700],
    italic: true,
    scripts: ["latin", "latin-ext", "cyrillic", "greek", "vietnamese"],
    license: "OFL-1.1",
  },
  {
    id: "caveat",
    family: "Caveat",
    category: "handwriting",
    weights: [400, 500, 600, 700],
    italic: false,
    scripts: ["latin", "latin-ext", "cyrillic"],
    license: "OFL-1.1",
  },
];

const BY_ID = new Map(FONT_CATALOG.map((font) => [font.id, font]));
const BY_FAMILY = new Map(FONT_CATALOG.map((font) => [font.family.toLowerCase(), font]));

/** A catalog font by id, or undefined. */
export function catalogFont(id: unknown): CatalogFont | undefined {
  return typeof id === "string" ? BY_ID.get(id) : undefined;
}

/** A catalog font by its family name ("Plus Jakarta Sans") or id, ignoring case; how agents and pasted CSS name one. */
export function catalogFontNamed(name: unknown): CatalogFont | undefined {
  if (typeof name !== "string") return undefined;
  const key = name
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
  return BY_FAMILY.get(key) ?? BY_ID.get(key) ?? BY_ID.get(key.replace(/\s+/g, "-"));
}

/** A font a file names: a catalog id, one of its own fonts or a theme role. */
export type FontRef = string;

export type FontRole = "heading" | "body";

const ASSET_REF = /^asset:([A-Za-z0-9_-]{1,64})$/;

export function isFontRole(value: unknown): value is FontRole {
  return value === "heading" || value === "body";
}

/** The asset id a `asset:<id>` ref names, or null. */
export function fontAssetOf(ref: unknown): string | null {
  return typeof ref === "string" ? (ASSET_REF.exec(ref)?.[1] ?? null) : null;
}

export function fontAssetRef(assetId: string): FontRef {
  return `asset:${assetId}`;
}

/** A ref a file may store: a catalog id, `asset:<id>` or a theme role. */
export function isFontRef(value: unknown): value is FontRef {
  return isFontRole(value) || catalogFont(value) !== undefined || fontAssetOf(value) !== null;
}

/** The weight of `font` closest to `weight` (a heavier one on a tie), so a missing weight draws the nearest. */
export function nearestWeight(font: Pick<CatalogFont, "weights">, weight: number): FontWeight {
  let best: FontWeight = font.weights[0] ?? 400;
  for (const w of font.weights) {
    if (
      Math.abs(w - weight) < Math.abs(best - weight) ||
      (Math.abs(w - weight) === Math.abs(best - weight) && w > best)
    )
      best = w;
  }
  return best;
}

/** What each category falls back to while a font loads or where it can't (CSS generic families). */
export const FONT_FALLBACK: Record<FontCategory, string> = {
  sans: "system-ui, sans-serif",
  serif: "Georgia, serif",
  display: "system-ui, sans-serif",
  mono: "ui-monospace, monospace",
  handwriting: "cursive",
};

/**
 * The family name a file's own font is drawn under (`asset:<id>` → "f-<id>"): its real name may be anything a person
 * uploaded, so it never reaches CSS or an office file as typed.
 */
export function assetFontFamily(assetId: string): string {
  return `f-${assetId}`;
}

/** A file's own fonts for its headings and its body (ADR 0220 §3): a deck's over its theme's, a document's. */
export interface FileFonts {
  heading?: FontRef;
  body?: FontRef;
}

/** A file's own fonts as stored (catalog ids or the file's fonts, never a role), or undefined when it has none. */
export function cleanFileFonts(value: unknown): FileFonts | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const out: FileFonts = {};
  if (isFontRef(v.heading) && !isFontRole(v.heading)) out.heading = v.heading;
  if (isFontRef(v.body) && !isFontRole(v.body)) out.body = v.body;
  return out.heading || out.body ? out : undefined;
}
