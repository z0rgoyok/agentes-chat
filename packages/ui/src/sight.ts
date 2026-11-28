/**
 * Whether anyone is looking at the app, for everything that moves on its own (skies, agents, the stylesheets' endless
 * loops), ADR 0228:
 * - `hidden`: the page or the desktop window out of sight;
 * - `away`: another window has the focus and the pointer isn't over this one;
 * - `idle`: in sight, but no key, click, touch, wheel or pointer move for `IDLE_MS` (nobody at the computer, or reading);
 * - `present`: someone is here.
 * The desktop window keeps running its page hidden and in the background (no throttling there,
 * apps/desktop/src-tauri/src/main_window.rs), where each frame of a loop kept a core and the GPU busy with nobody
 * looking; so what moves on its own stops here rather than waiting for the browser to stop it. `<html data-sight>`
 * carries it to the stylesheets (absent while present).
 */
export type Sight = "present" | "idle" | "away" | "hidden";

/** No input for this long: `idle`. */
export const IDLE_MS = 2 * 60_000;

let current: Sight = "present";
let lastInput = Date.now();

/** When the person last pressed, typed, touched, scrolled or moved the pointer (`watchSight` follows it). */
export const lastInputAt = () => lastInput;
const listeners = new Set<(sight: Sight) => void>();

export const sight = (): Sight => current;

/** Calls `cb` on each change; returns the unsubscribe. */
export function onSight(cb: (sight: Sight) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function setSight(next: Sight) {
  if (next === current) return;
  current = next;
  const root = typeof document === "undefined" ? null : document.documentElement;
  if (root) {
    if (next === "present") delete root.dataset.sight;
    else root.dataset.sight = next;
  }
  for (const cb of [...listeners]) cb(next);
}

/**
 * Follows the page's visibility, the window's focus, the pointer and the person's input, once at start. The pointer
 * over the window counts as someone looking (a window on a second screen, watched while typing in another). The first
 * input, or the window coming forward, is `present` again. Returns the stop.
 */
export function watchSight(idleMs = IDLE_MS): () => void {
  let pointerIn = false;
  let last = Date.now();
  let idle = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () =>
    setSight(document.hidden ? "hidden" : !pointerIn && !document.hasFocus() ? "away" : idle ? "idle" : "present");
  const check = () => {
    const left = idleMs - (Date.now() - last);
    if (left > 0) timer = setTimeout(check, left);
    else {
      timer = undefined;
      idle = true;
      update();
    }
  };
  // One timer for a burst of input: it re-arms from the last input when it fires.
  const active = () => {
    last = Date.now();
    lastInput = last;
    if (timer === undefined) timer = setTimeout(check, idleMs);
    if (!idle) return;
    idle = false;
    update();
  };
  const over = () => {
    if (pointerIn) return;
    pointerIn = true;
    update();
  };
  // Leaving the window: the last `pointerout` has nothing it goes to.
  const out = (e: PointerEvent) => {
    if (e.relatedTarget !== null) return;
    pointerIn = false;
    update();
  };
  const inputs = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"];
  for (const name of inputs) window.addEventListener(name, active, { capture: true, passive: true });
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  document.addEventListener("visibilitychange", update);
  document.addEventListener("pointerover", over, { passive: true });
  document.addEventListener("pointerout", out, { passive: true });
  active();
  update();
  return () => {
    clearTimeout(timer);
    for (const name of inputs) window.removeEventListener(name, active, { capture: true });
    window.removeEventListener("focus", update);
    window.removeEventListener("blur", update);
    document.removeEventListener("visibilitychange", update);
    document.removeEventListener("pointerover", over);
    document.removeEventListener("pointerout", out);
    setSight("present");
  };
}
