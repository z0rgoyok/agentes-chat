import { type RefObject, useEffect } from "react";

/**
 * One tab stop for a toolbar (`role="toolbar"`), moved with ←, →, Home and End (WAI-ARIA's toolbar pattern): the
 * button that last had the focus keeps the stop, disabled ones are skipped, and buttons that come and go (the text
 * group while a box is open) never leave it without one.
 */
export function useRoving(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const items = () =>
      [...el.querySelectorAll<HTMLElement>("button, [role='button']")].filter(
        (b) => !(b as HTMLButtonElement).disabled && b.closest("[role='toolbar']") === el,
      );
    const settle = (current: HTMLElement | null) => {
      const list = items();
      const keep = current && list.includes(current) ? current : list[0];
      for (const b of list) b.tabIndex = b === keep ? 0 : -1;
    };
    settle(null);
    const onFocus = (e: FocusEvent) => settle(e.target as HTMLElement);
    const onKey = (e: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLElement);
      if (at < 0) return;
      e.preventDefault();
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? list.length - 1
            : (at + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    };
    const watch = new MutationObserver(() => {
      const active = document.activeElement as HTMLElement | null;
      settle(active && el.contains(active) ? active : el.querySelector<HTMLElement>("[tabindex='0']"));
    });
    watch.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled"] });
    el.addEventListener("focusin", onFocus);
    el.addEventListener("keydown", onKey);
    return () => {
      watch.disconnect();
      el.removeEventListener("focusin", onFocus);
      el.removeEventListener("keydown", onKey);
    };
  }, [ref]);
}
