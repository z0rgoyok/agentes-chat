import { useEffect } from "react";

/**
 * When the control that had the focus inside `#scopeId` goes away (its row was taken off or removed), the focus moves
 * to the first of `homeIds` still on the page (a heading, made focusable) instead of falling to the page itself.
 */
export function useFocusHome(scopeId: string, homeIds: readonly string[]) {
  const homes = homeIds.join(" ");
  useEffect(() => {
    let last: Element | null = null;
    const focused = (e: FocusEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target && document.getElementById(scopeId)?.contains(target)) last = target;
      // A dialog opened from the row keeps it: its row may go while the dialog is open, and closing it comes back here.
      else if (!target?.closest("[role='dialog'], [role='alertdialog']")) last = null;
    };
    const watch = new MutationObserver(() => {
      if (!last || last.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      last = null;
      for (const id of homes.split(" ")) {
        const home = document.getElementById(id);
        if (!home) continue;
        if (!home.hasAttribute("tabindex")) home.tabIndex = -1;
        home.focus();
        return;
      }
    });
    document.addEventListener("focusin", focused);
    watch.observe(document.body, { childList: true, subtree: true });
    return () => {
      document.removeEventListener("focusin", focused);
      watch.disconnect();
    };
  }, [scopeId, homes]);
}
