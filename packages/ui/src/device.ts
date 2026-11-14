import { HOVERLESS } from "./hooks/useMatchMedia";

/** A phone or tablet typing on its on-screen keyboard (touch first, no mouse). */
export const onScreenKeyboard = () =>
  typeof navigator !== "undefined" &&
  navigator.maxTouchPoints > 0 &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;

/** A pointer that can rest over something without pressing it: a mouse or a pen, never a finger. */
export const hoverPointer = (pointerType: string) => pointerType === "mouse" || pointerType === "pen";

/** A screen whose main pointer can't rest over anything (a phone, a tablet): a tap stands in for hover. */
export const hoverless = () => typeof window.matchMedia === "function" && window.matchMedia(HOVERLESS).matches;

/** Keys that can move the focus besides Tab: between radios, tabs or a menu's items. In a field they move the caret. */
const MOVES = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

let byKeys = false;
let tracked: Document | null = null;

/**
 * Whether the person moves around with the keys: the focus moved while Tab, an arrow or a page key was down, until the
 * next press of a mouse, a finger or a pen. A key that moves nothing changes nothing (Tab that picks a mention in the
 * box, an arrow that moves the caret or scrolls the page), nor do typing, Enter and Escape. A key held with ⌘, Ctrl or
 * Alt is a shortcut, not a move, except Tab: by default, Safari and the macOS app reach a button only with ⌥Tab.
 * `<html data-pointer>` says the pointer leads, so that only the keys draw focus rings: a browser also draws one on
 * whatever a script focuses after any key, typing included (a dialog that closes on Enter gives the focus back to its
 * button). Installed once per document, by the first caller.
 */
export function trackInput() {
  if (typeof document === "undefined" || tracked === document) return;
  tracked = document;
  const root = document.documentElement;
  const set = (keys: boolean) => {
    byKeys = keys;
    root.toggleAttribute("data-pointer", !keys);
  };
  set(false);
  // While the key is down, not only during its event: Radix's roving focus (a menu's arrows) moves it in a timeout.
  let moving = false;
  document.addEventListener(
    "keydown",
    (e) => {
      moving = e.key === "Tab" || (MOVES.has(e.key) && !(e.metaKey || e.ctrlKey || e.altKey));
    },
    true,
  );
  document.addEventListener(
    "keyup",
    () => {
      moving = false;
    },
    true,
  );
  document.addEventListener(
    "focusin",
    () => {
      if (moving) set(true);
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    () => {
      moving = false;
      set(false);
    },
    true,
  );
}

/** The person moves with the keys now (`trackInput`). */
export const movesByKeys = () => byKeys;

/**
 * Whether the one element an IntersectionObserver watches is on screen now (undefined: no answer). One call can
 * carry several answers for it, oldest first: hidden and shown again before the observer called (across a resize to
 * a phone's width and back) gives [off, on], and only the last one says where it is.
 */
export const onScreenNow = (entries: readonly { isIntersecting: boolean }[]) => entries.at(-1)?.isIntersecting;

/** The last control in `root` that Tab reaches, counted as Radix's focus scope does: tab index 0 or more, enabled, shown. */
export const lastTabbable = (root: Element) =>
  [...root.querySelectorAll<HTMLElement>("*")]
    .filter(
      (el) =>
        el.tabIndex >= 0 &&
        !(el as HTMLButtonElement).disabled &&
        !el.hidden &&
        el.checkVisibility?.({ checkVisibilityCSS: true }) !== false,
    )
    .at(-1);

/**
 * Whether something on the page holds the focus: what opened as an overlay closed keeps it, the overlay gives none back.
 * A dialog itself doesn't count: an outer dialog takes the focus back as an inner one closes, for lack of anywhere else.
 */
export const focusHeld = () => {
  const held = document.activeElement;
  return held !== null && held !== document.body && !held.matches('[role="dialog"]');
};

/** What opens over the page and keeps the keys while open: a dialog, a menu, a list of options. */
export const OPEN_LAYER = '[role="dialog"], [role="menu"], [role="listbox"]';

/** Typing in a field (a text box, a select, an editable text): single-key shortcuts and Esc are the field's. */
export const typingInField = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** A page or computer a person is controlling (`data-control` on it): its keys are the person's, never the app's. */
const IN_CONTROL = "[data-control]";

/**
 * Whether the focus rests where no one chose: on the page itself, or in a conversation's box, where the app puts it
 * as the conversation opens. Something taking the keys (a page coming under control) may take it from there.
 */
export const focusIdle = () => {
  const held = document.activeElement;
  return held === null || held === document.body || held.closest(".ac-composer") !== null;
};

/**
 * Whether the app may put the focus in a conversation's box by itself (the conversation opening, a key typed on it):
 * never on a touch screen, whose keyboard would open over the page, nor while a dialog, menu or list is open, a page
 * or computer is under a person's control, a field other than a conversation's box holds the focus, or the person
 * has text selected (to copy it).
 */
export const mayTakeFocus = () => {
  if (onScreenKeyboard() || document.querySelector(`${OPEN_LAYER}, ${IN_CONTROL}`)) return false;
  const held = document.activeElement;
  if (typingInField(held) && !(held as HTMLElement).closest(".ac-composer")) return false;
  return !window.getSelection()?.toString();
};

/** Focus a text box with the caret after its text, the page left where it is (a jump to a message stays put). */
export const focusAtEnd = (box: HTMLTextAreaElement | HTMLInputElement) => {
  box.focus({ preventScroll: true });
  box.setSelectionRange(box.value.length, box.value.length);
  // A draft taller than the box: its end in view, where the caret is (not every browser scrolls to it).
  box.scrollTop = box.scrollHeight;
};
