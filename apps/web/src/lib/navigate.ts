import type { MouseEvent } from "react";

type Leave = (url: string, options?: { replace?: boolean }) => void;

/**
 * Leaves the app for an external URL (OAuth providers). `replace`: the page leaving stays out of the history, so Back
 * from there doesn't land on it again. Replaceable in tests.
 */
let impl: Leave = (url, options) => (options?.replace ? window.location.replace(url) : window.location.assign(url));

export const navigateAway: Leave = (url, options) => impl(url, options);

export function setNavigateAway(next: Leave) {
  impl = next;
}

/**
 * A link that also opens its target in place (a panel, a dialog over the page): a plain click opens it there; a
 * modified or middle click still follows the link (a new tab, its page).
 */
export function inPlaceClick(e: MouseEvent, open: () => void) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  open();
}
