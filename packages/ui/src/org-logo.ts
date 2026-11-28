/**
 * The plate behind a workspace's (or a registered host's) logo, drawn whole: a wordmark leaves room around it. The
 * server marks a PNG whose see-through background carries light ink (a logo made for a dark header) with `LIGHT_INK`
 * at the end of its address; every other logo is taken as dark ink. A plate shows only where the theme's own surface
 * would hide the ink: white behind dark ink in the dark theme, dark behind light ink in the light theme.
 */
export const LIGHT_INK = "#ink=light";

/** The web's `.org-mark` and the Mac app's `.dk-org--logo` repeat these colors in CSS. */
export const LOGO_PLATES = { darkInk: "#ffffff", lightInk: "#1c1c1b" } as const;

export const hasLightInk = (logo: string | null | undefined): boolean => Boolean(logo?.endsWith(LIGHT_INK));

/** The plate's color in a theme, or null for none (the surface behind shows). */
export function logoPlate(logo: string | null | undefined, dark: boolean): string | null {
  const light = hasLightInk(logo);
  if (light === dark) return null;
  return light ? LOGO_PLATES.lightInk : LOGO_PLATES.darkInk;
}
