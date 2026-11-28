import type { MachineAccountKind } from "@agenteschat/client";
import { inDesktopApp } from "./desktop";

/**
 * Opens a provider's sign-in or key page at `url` in a new tab: a normal tab on every browser, never a popup window
 * without the browser's toolbars, which providers' bot checks may refuse (Claude's says it can't verify the browser on
 * Firefox), and which shows no address to check. Called from the click itself (browsers block tabs opened later). Null
 * when the browser refused it; the caller then offers a link. The page it opens can't reach back into the app
 * (`opener`).
 */
export function openSignInTab(url: string): Window | null {
  let w: Window | null = null;
  try {
    w = window.open(url, "_blank");
  } catch {
    return null;
  }
  try {
    if (w) w.opener = null;
  } catch {
    // already another site's
  }
  return w;
}

/**
 * A tab for a sign-in whose address isn't known yet, on our page that says what's happening (`/conectando`). Not in
 * the desktop app, whose windows are the browser's: a page of ours would take over the app's window (main_window.rs).
 */
export const openWaitingTab = (kind: MachineAccountKind) =>
  inDesktopApp() ? null : openSignInTab(`/conectando?kind=${kind}`);

/** Sends the waiting tab to `url`, in its place in the tab's history (closed meanwhile: nothing). */
export function sendSignInTab(w: Window | null, url: string) {
  try {
    if (w && !w.closed) w.location.replace(url);
  } catch {
    // gone, or not ours any more
  }
}
