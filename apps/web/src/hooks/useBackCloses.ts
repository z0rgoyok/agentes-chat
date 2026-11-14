import { type RouterHistory, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { NAV_ID } from "@/components/NavDrawer";

/**
 * What a history Back closes before it leaves the page: a dialog, a menu, a picker's list, a side pane (`SidePanel`),
 * the phone's navigation drawer. One Radix keeps through its exit (`data-state="closed"`) is already going.
 */
const OVERLAYS = `[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], dialog[open], .thread-panel, #${NAV_ID}[data-open="true"]`;

/** The overlay on top: the last one in the page, as each opens after (and portals after) the one it opened from. */
export function topOverlay(doc: Document = document): Element | null {
  const open = Array.from(doc.querySelectorAll(OVERLAYS)).filter((el) => !el.closest('[data-state="closed"]'));
  return open.at(-1) ?? null;
}

/**
 * Closes `top` the way Esc does, so each overlay's own rules hold (unsaved edits ask first, a menu over a dialog goes
 * first). The key goes to what has the focus when that is in the overlay or drives it (a combobox's list), else to the
 * overlay itself. False when nothing took the key.
 */
export function escapeOverlay(top: Element): boolean {
  const focus = document.activeElement;
  const drives = focus && top.id && focus.getAttribute("aria-controls") === top.id;
  const target = focus && (top.contains(focus) || drives) ? focus : top;
  const key = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(key);
  return key.defaultPrevented;
}

/**
 * A history Back (the title bar's ‹, the menus' Voltar, a mouse's side button, Alt+←) closes the overlay on top and
 * stays on the page; with nothing open it leaves as always. An overlay the URL holds open (`data-in-address`: a thread,
 * an agent's page) lets the Back through, which closes it by moving the URL. Forward and links are never held.
 * Returns the undo.
 */
export function holdBackForOverlays(history: RouterHistory): () => void {
  // A Back let through after the Esc found no taker skips this hold only: other blockers (unsaved edits) still ask.
  let passing = false;
  return history.block({
    enableBeforeUnload: false,
    blockerFn: ({ action }) => {
      if (action !== "BACK") return false;
      if (passing) {
        passing = false;
        return false;
      }
      const top = topOverlay();
      if (!top || top.matches("[data-in-address]")) return false;
      // The browser is on the entry before until the router steps forward again: a close that writes the URL (a
      // details dialog's `?open=`) waits for that, or it would write over the entry before.
      window.addEventListener(
        "popstate",
        () => {
          if (!top.isConnected || escapeOverlay(top)) return;
          passing = true;
          history.back();
        },
        { once: true },
      );
      return true;
    },
  });
}

/** `holdBackForOverlays` for the app's router, once in the shell. */
export function useBackCloses() {
  const router = useRouter();
  useEffect(() => holdBackForOverlays(router.history), [router]);
}
