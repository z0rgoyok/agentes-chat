export type Theme = "light" | "dark";

/** On <html> while the theme changes: tokens.css turns every transition off under it. */
export const THEME_SWITCHING_ATTR = "data-theme-switching";

/**
 * Sets `data-theme` on <html> in one frame. Every control eases its color, background and shadow on hover at its own
 * speed, so a theme change under live transitions left buttons and rows fading for ~180 ms while the page around them
 * had already flipped. Transitions are held off for the two frames the new tokens take to paint.
 */
export function switchTheme(theme: Theme, root: HTMLElement = document.documentElement) {
  if (root.dataset.theme === theme) return;
  root.setAttribute(THEME_SWITCHING_ATTR, "");
  root.dataset.theme = theme;
  const release = () => root.removeAttribute(THEME_SWITCHING_ATTR);
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(release));
  else setTimeout(release, 0);
}

/** On <html> while a workspace's accent is shown (ADR 0193): its hex, so drawings that repaint on a theme switch repaint. */
export const ACCENT_ATTR = "data-accent";
/** What a drawing in script watches on <html> to repaint: the theme and the workspace's accent. */
export const PAINT_ATTRS = ["data-theme", ACCENT_ATTR];

/** Calls `redraw` in the same frame `data-theme` or `data-accent` changes on <html>; returns the cleanup. */
export function onThemeChange(redraw: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  const watch = new MutationObserver(redraw);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: PAINT_ATTRS });
  return () => watch.disconnect();
}
