import {
  assetFontFamily,
  catalogFont,
  FONT_FALLBACK,
  type FontCategory,
  type FontRef,
  fontAssetOf,
} from "@agenteschat/live";
import { createContext, useContext, useEffect } from "react";

/**
 * Fonts in live files on the web (ADR 0220 §8): a catalog font loads when a file first uses it (`/api/fonts/<id>.css`,
 * served by this server), a file's own font from the file's asset route under a name of its own, and every family is
 * drawn with its kind's fallback while it loads, so text never jumps to an unrelated face.
 */

/** The app ships these itself (`fonts.css`, the variable Source Sans 3): never loaded again. */
const BUILT_IN: Record<string, string> = {
  "source-sans-3": '"Source Sans 3 Variable", "Source Sans 3"',
  "funnel-display": '"Funnel Display"',
};

const loaded = new Set<string>();

/** Loads a catalog font's faces (once per page). */
function loadCatalog(id: string): void {
  if (loaded.has(id) || BUILT_IN[id] || typeof document === "undefined") return;
  loaded.add(id);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/api/fonts/${id}.css`;
  link.dataset.liveFont = id;
  document.head.appendChild(link);
}

/** Loads one of a file's own fonts from its address (once per page). */
function loadAsset(assetId: string, url: string): void {
  const key = `asset:${assetId}`;
  if (loaded.has(key) || typeof document === "undefined") return;
  loaded.add(key);
  const style = document.createElement("style");
  style.dataset.liveFont = key;
  // The address is the app's own asset route; the name is ours, never the uploaded file's.
  style.textContent = `@font-face{font-family:"${assetFontFamily(assetId)}";src:url(${JSON.stringify(url)});font-display:swap}`;
  document.head.appendChild(style);
}

/** A file's asset address by id, for its own fonts; the live file's page gives it. */
export const FontAssetUrl = createContext<((assetId: string) => string | null) | null>(null);

/** The CSS `font-family` of a font ref (a catalog id or `asset:<id>`), with its kind's fallback. */
export function fontFamilyCss(ref: FontRef | undefined, category: FontCategory = "sans"): string | undefined {
  if (!ref) return undefined;
  const asset = fontAssetOf(ref);
  if (asset) return `"${assetFontFamily(asset)}", ${FONT_FALLBACK[category]}`;
  const font = catalogFont(ref);
  if (!font) return undefined;
  return `${BUILT_IN[font.id] ?? `"${font.family}"`}, ${FONT_FALLBACK[font.category]}`;
}

/** Loads a font ref's faces now (a catalog font, or one of the file's own through `assetUrl`); roles load nothing. */
export function loadFontRef(ref: FontRef | undefined, assetUrl: ((assetId: string) => string | null) | null): void {
  if (!ref) return;
  const asset = fontAssetOf(ref);
  if (asset) {
    const url = assetUrl?.(asset);
    if (url) loadAsset(asset, url);
  } else if (catalogFont(ref)) loadCatalog(ref);
}

/** Loads the fonts a drawn piece uses (catalog fonts and the file's own). */
export function useLiveFonts(refs: readonly (FontRef | undefined)[]): void {
  const assetUrl = useContext(FontAssetUrl);
  const key = refs.filter(Boolean).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `refs` as a value
  useEffect(() => {
    for (const ref of refs) loadFontRef(ref, assetUrl);
  }, [key, assetUrl]);
}

/** Every font a rich text's runs name. */
export function fontsOfRich(doc: readonly { runs: readonly { font?: FontRef }[] }[] | undefined): FontRef[] {
  const out = new Set<FontRef>();
  for (const p of doc ?? []) for (const r of p.runs) if (r.font) out.add(r.font);
  return [...out];
}
