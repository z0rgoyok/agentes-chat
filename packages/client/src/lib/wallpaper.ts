/**
 * A conversation's background, mine alone: one behind every conversation in `chatPrefs`, and, per
 * conversation, one that wins over it (`chatPrefs.wallpapers`, by channel id). Nothing chosen is no background, the
 * app as it always was. Mirrored in packages/engine/src/chat-prefs.ts, which keeps only what it validates; how each one
 * is painted lives in packages/ui/src/sky/wallpaper.ts, shared by the web and the phone.
 */

/** The agents' colors a background can take (the agent engine's presets). */
export const WALLPAPER_HUES = ["sky", "indigo", "violet", "rose", "amber", "green", "teal", "graphite"] as const;
export type WallpaperHue = (typeof WALLPAPER_HUES)[number];
/** The three quiet colors of Drawings and Color: paper (warm white), mist (cool) and sand. */
export const WALLPAPER_NEUTRALS = ["paper", "mist", "sand"] as const;
export type WallpaperNeutral = (typeof WALLPAPER_NEUTRALS)[number];
/** "auto": the conversation's own color, an agent's in a DM with it, the workspace's sky anywhere else. */
export type WallpaperAuto = "auto";

/**
 * - `sky`: the pixel sky in one color.
 * - `drawings`: small line drawings in the app's icon style, tone on tone, on an even grid.
 * - `crowd`: the agent symbol, many times over, faint.
 * - `color`: one flat color.
 * - `photo`: a photo of mine (`PUT …/me/wallpaper-photo`), darkened in the dark theme by `dim`, its point of interest
 *   at `x`, `y` (0–1) kept on screen.
 * - `none`: no background; per conversation it says "none here", where no entry says "as the others".
 */
export type Wallpaper =
  | { kind: "none" }
  | { kind: "sky"; color: WallpaperAuto | WallpaperHue }
  | { kind: "drawings"; color: WallpaperAuto | WallpaperNeutral | WallpaperHue }
  | { kind: "agents" }
  | { kind: "color"; color: WallpaperNeutral | WallpaperHue }
  | { kind: "photo"; url: string; dim: number; x: number; y: number };
export type WallpaperKind = Wallpaper["kind"];

export const NO_WALLPAPER: Wallpaper = { kind: "none" };
/** How dark a photo goes in the dark theme until the person moves it. */
export const DEFAULT_PHOTO_DIM = 0.45;
export const MAX_PHOTO_DIM = 0.8;

/** The choices the picker shows, family by family, in order. */
export const WALLPAPER_CHOICES = {
  sky: ["auto", ...WALLPAPER_HUES.filter((h) => h !== "graphite")] as const,
  drawings: ["auto", "paper", "sky", "violet", "rose", "green", "teal"] as const,
  color: ["paper", "mist", "sand", "sky", "violet", "rose", "green", "teal"] as const,
};

const isHue = (v: unknown): v is WallpaperHue => WALLPAPER_HUES.includes(v as WallpaperHue);
const isNeutral = (v: unknown): v is WallpaperNeutral => WALLPAPER_NEUTRALS.includes(v as WallpaperNeutral);
/** A photo of mine, as `PUT …/me/wallpaper-photo` answers it. */
export const WALLPAPER_PHOTO_PATH = /^\/api\/app\/wallpapers\/[^/]+\/[0-9a-f]{16}\.(jpg|png|webp)$/;
const unit = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);

/** A stored or sent value as a background this build knows; anything else is undefined (and is dropped). */
export function wallpaperOf(v: unknown): Wallpaper | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  switch (o.kind) {
    case "none":
      return { kind: "none" };
    case "sky":
      return o.color === "auto" || isHue(o.color) ? { kind: "sky", color: o.color } : undefined;
    case "drawings":
      return o.color === "auto" || isHue(o.color) || isNeutral(o.color)
        ? { kind: "drawings", color: o.color }
        : undefined;
    case "agents":
      return { kind: "agents" };
    case "color":
      return isHue(o.color) || isNeutral(o.color) ? { kind: "color", color: o.color } : undefined;
    case "photo": {
      if (typeof o.url !== "string" || !WALLPAPER_PHOTO_PATH.test(o.url)) return undefined;
      const dim = unit(o.dim);
      return {
        kind: "photo",
        url: o.url,
        dim: dim === null ? DEFAULT_PHOTO_DIM : Math.min(dim, MAX_PHOTO_DIM),
        x: unit(o.x) ?? 0.5,
        y: unit(o.y) ?? 0.5,
      };
    }
    default:
      return undefined;
  }
}

/** Whether two backgrounds are the same choice (the picker's check mark). */
export function sameWallpaper(a: Wallpaper | undefined, b: Wallpaper | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "photo" && b.kind === "photo") return a.url === b.url;
  return ("color" in a ? a.color : null) === ("color" in b ? b.color : null);
}

/** What the person chose, as far as backgrounds go (a slice of `ChatPrefs`). */
export interface WallpaperPrefs {
  wallpaper?: Wallpaper;
  wallpapers?: Record<string, Wallpaper>;
}

/** The background behind every conversation: what I chose, else none (the owner's default). */
export const defaultWallpaperOf = (prefs: WallpaperPrefs | undefined): Wallpaper => prefs?.wallpaper ?? NO_WALLPAPER;

/** This conversation's own choice, if it has one (it wins over the one behind every conversation). */
export const conversationWallpaperOf = (
  prefs: WallpaperPrefs | undefined,
  channelId: string | null | undefined,
): Wallpaper | undefined => (channelId ? prefs?.wallpapers?.[channelId] : undefined);

/** The background a conversation shows: its own, or the one behind every conversation. */
export const wallpaperFor = (prefs: WallpaperPrefs | undefined, channelId: string | null | undefined): Wallpaper =>
  conversationWallpaperOf(prefs, channelId) ?? defaultWallpaperOf(prefs);

/**
 * A background with "auto" made this conversation's color: `own`, the agent's in a DM with an agent, else the
 * workspace's sky.
 */
export function resolveWallpaper(w: Wallpaper, own: WallpaperHue | null | undefined): Wallpaper {
  if ((w.kind === "sky" || w.kind === "drawings") && w.color === "auto") return { ...w, color: own ?? "sky" };
  return w;
}

/** The nearest preset to an agent's color (a custom "#rrggbb" color takes the sky's). */
export const wallpaperHueOf = (color: string | null | undefined): WallpaperHue | null =>
  color && isHue(color) ? color : null;

export const hasWallpaper = (w: Wallpaper | undefined): boolean => Boolean(w && w.kind !== "none");

/**
 * A background's name for a row's value ("Agent's sky", "Color · Sand"): `dm` says what "auto" means here, the agent's
 * color in a DM, the workspace's in a channel; null (the one behind every conversation): each conversation's own.
 */
export function wallpaperName(
  t: (key: string, params?: Record<string, unknown>) => string,
  w: Wallpaper,
  dm: boolean | null,
) {
  const base = "settings.account.chat.wallpaper";
  const colorName = (c: string) =>
    (WALLPAPER_NEUTRALS as readonly string[]).includes(c) ? t(`${base}.neutral.${c}`) : t(`look.colors.${c}`);
  switch (w.kind) {
    case "none":
      return t(`${base}.none`);
    case "sky":
      return w.color === "auto"
        ? t(`${base}.name.${dm === null ? "skyAuto" : dm ? "skyAgent" : "skyWorkspace"}`)
        : t(`${base}.name.sky`, { color: colorName(w.color) });
    case "drawings":
      return w.color === "auto"
        ? t(`${base}.name.${dm === null ? "drawingsAuto" : dm ? "drawingsAgent" : "drawingsWorkspace"}`)
        : t(`${base}.name.drawings`, { color: colorName(w.color) });
    case "agents":
      return t(`${base}.name.crowd`);
    case "color":
      return t(`${base}.name.color`, { color: colorName(w.color) });
    case "photo":
      return t(`${base}.name.photo`);
  }
}

/** The tiles of the picker, family by family (Sky, Drawings with the agents first, Color), as backgrounds. */
export const WALLPAPER_FAMILIES = {
  sky: WALLPAPER_CHOICES.sky.map((color) => ({ kind: "sky", color }) as Wallpaper),
  drawings: [
    { kind: "agents" } as Wallpaper,
    ...WALLPAPER_CHOICES.drawings.map((color) => ({ kind: "drawings", color }) as Wallpaper),
  ],
  color: WALLPAPER_CHOICES.color.map((color) => ({ kind: "color", color }) as Wallpaper),
} as const;
