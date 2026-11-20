import { type RefObject, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";

/**
 * A box with a `max-height` holds more than it shows, at this width: measured when it lays out and again whenever its
 * content changes size (fonts, pictures, the page's width). While `active` is off (the box shows whole) it keeps its
 * last answer. With `over`, the answer is whether its content is taller than that instead: for a box whose
 * `max-height` depends on the answer, which would otherwise stay cut after its content shrank back under the limit.
 */
export function useOverflows(box: RefObject<HTMLElement | null>, active = true, over?: number): boolean {
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !active) return;
    const measure = () => setCut(el.scrollHeight > (over ?? el.clientHeight) + 1);
    // A conversation's rows are skipped while off screen (`content-visibility: auto` in layout.css): measuring one
    // lays it out anyway, about 10 ms each, a second for a conversation that opens with a hundred. A skipped one is
    // measured by the observer once it comes on screen, before that frame is painted (hence at once, not later).
    if (el.checkVisibility?.({ contentVisibilityAuto: true }) !== false) measure();
    if (typeof ResizeObserver === "undefined") return;
    const resized = new ResizeObserver(() => flushSync(measure));
    // The box itself while it still grows towards its `max-height`, its first child for what it holds past it.
    resized.observe(el);
    if (el.firstElementChild) resized.observe(el.firstElementChild);
    return () => resized.disconnect();
  }, [box, active, over]);
  return cut;
}
