import { type RefObject, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";

/**
 * A box with a `max-height` holds more than it shows, at this width: measured when it lays out and again whenever its
 * content changes size (fonts, pictures, the page's width). While `active` is off (the box shows whole) it keeps its
 * last answer. With `over`, the answer is whether its content is taller than that instead: for a box whose
 * `max-height` depends on the answer, which would otherwise stay cut after its content shrank back under the limit.
 * Once cut, such a box shows whole again only under `under`: content near `over` at one width and under it at another
 * flipped it on every frame when cutting it took the conversation's scrollbar away and widened the column.
 */
export function useOverflows(box: RefObject<HTMLElement | null>, active = true, over?: number, under = over): boolean {
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !active) return;
    const measure = () => {
      const height = el.scrollHeight;
      setCut((was) => height > ((was ? under : over) ?? el.clientHeight) + 1);
    };
    // In a subtree with deferred layout, let the observer measure once it is drawn. Reading scrollHeight
    // here would force it to lay out early.
    if (el.checkVisibility?.({ contentVisibilityAuto: true }) !== false) measure();
    if (typeof ResizeObserver === "undefined") return;
    const resized = new ResizeObserver(() => flushSync(measure));
    // The box itself while it still grows towards its `max-height`, its first child for what it holds past it.
    resized.observe(el);
    if (el.firstElementChild) resized.observe(el.firstElementChild);
    return () => resized.disconnect();
  }, [box, active, over, under]);
  return cut;
}
