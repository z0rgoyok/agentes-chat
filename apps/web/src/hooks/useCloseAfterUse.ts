import { type RefObject, useEffect, useRef } from "react";
import { welcomeClock } from "@/lib/welcome";

/** What counts as the person using the page: a press, a key, a scroll by wheel or finger. */
const USES = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
/** Keys that only start a chord: with Cmd+Tab, Alt+Tab or Ctrl+L the person is going elsewhere, not using the page. */
const MODIFIERS = new Set(["Meta", "Control", "Alt", "AltGraph", "Shift", "CapsLock", "OS"]);

const elsewhere = (e: Event) => {
  if (e.type !== "keydown") return false;
  const key = e as KeyboardEvent;
  return key.metaKey || key.ctrlKey || key.altKey || MODIFIERS.has(key.key);
};

/**
 * Closes the day's greeting on its clock (`welcomeClock`): the person's first press, key or scroll outside `box`
 * starts it, and the pointer on it or the focus inside it holds it. Off while `on` is false. Gone once the clock runs
 * (the person left the channel) counts as closed too.
 */
export function useCloseAfterUse(box: RefObject<HTMLElement | null>, close: () => void, on = true) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    const el = box.current;
    if (!on || !el) return;
    let over = false;
    const clock = welcomeClock(
      () => latest.current(),
      () => over || el.contains(document.activeElement),
    );
    const used = (e: Event) => {
      if ((e.target instanceof Node && el.contains(e.target)) || elsewhere(e)) return;
      for (const type of USES) window.removeEventListener(type, used, true);
      clock.used();
    };
    const enter = () => {
      over = true;
    };
    const pointerLeave = () => {
      over = false;
      clock.left();
    };
    const focusOut = (e: FocusEvent) => {
      // The focus going to something else inside is still inside.
      if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
      clock.left();
    };
    for (const type of USES) window.addEventListener(type, used, { capture: true, passive: true });
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", pointerLeave);
    el.addEventListener("focusout", focusOut);
    return () => {
      clock.stop();
      for (const type of USES) window.removeEventListener(type, used, true);
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", pointerLeave);
      el.removeEventListener("focusout", focusOut);
      if (clock.running()) latest.current();
    };
  }, [box, on]);
}
