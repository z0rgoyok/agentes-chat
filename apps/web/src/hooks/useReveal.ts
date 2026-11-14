import { prefersReducedMotion } from "@agenteschat/ui";
import { type RefObject, useLayoutEffect, useRef } from "react";

/** How long folded words take to grow to their whole height. */
const REVEAL_MS = 200;

/**
 * Folded words that open in place, for good, once `open`: `reveal()`, called as they open, takes the height they
 * show, and they grow down from it to their whole height (at once with reduced motion), so what is above them never
 * moves. Focus moves to the words, since the button that opened them goes away.
 */
export function useReveal(box: RefObject<HTMLElement | null>, open: boolean) {
  // The height they showed when "Ver mais" opened them; null when nothing is opening.
  const from = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const start = from.current;
    from.current = null;
    if (!open || !el || start === null) return;
    // Focusable only for this: a click on the words later doesn't focus them.
    el.tabIndex = -1;
    el.addEventListener("blur", () => el.removeAttribute("tabindex"), { once: true });
    el.focus({ preventScroll: true });
    const end = el.offsetHeight;
    if (end <= start || prefersReducedMotion() || typeof el.animate !== "function") return;
    el.animate(
      [
        { maxHeight: `${start}px`, overflow: "clip" },
        { maxHeight: `${end}px`, overflow: "clip" },
      ],
      { duration: REVEAL_MS, easing: "ease-out" },
    );
  }, [box, open]);
  return () => {
    from.current = box.current?.offsetHeight ?? 0;
  };
}
