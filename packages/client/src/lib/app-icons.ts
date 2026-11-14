/**
 * The app icons a person can pick on their device (ADR 0179), in the pickers' order: the first is the icon the apps
 * ship with. Their files come from `packages/ui/scripts/app-icons.mjs` (the same ids, a test keeps them equal); the
 * phone's native side and the desktop app list the same ids too.
 */
export const APP_ICONS = ["night", "moon", "sky", "peekNight", "peekSky"] as const;

export type AppIconId = (typeof APP_ICONS)[number];

/** The icon the apps ship with. */
export const DEFAULT_APP_ICON: AppIconId = APP_ICONS[0];

export const isAppIcon = (value: unknown): value is AppIconId =>
  typeof value === "string" && (APP_ICONS as readonly string[]).includes(value);

/** The icon's name in the pickers (`appIcon.names.*`). */
export const appIconNameKey = (id: AppIconId) => `appIcon.names.${id}` as const;
