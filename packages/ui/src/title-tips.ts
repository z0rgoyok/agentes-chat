import { hoverPointer, movesByKeys, trackInput } from "./device";
import { EDGE_ROOM, placeTip, TIP_GAP } from "./floating";

/** How long a mouse or a pen rests on an element before its tip opens. */
export const TITLE_TIP_OPEN_MS = 500;
/** After the pointer leaves a shown tip, how long the next element's tip opens with no wait. */
export const TITLE_TIP_GRACE_MS = 300;
/** The tip's id: what a described element's `aria-describedby` names while it shows. */
export const TITLE_TIP_ID = "ac-title-tip";

/** An element wider or taller than this gets its tip by the pointer, not on its own middle (a whole row or card). */
const NEAR = { width: 320, height: 96 };

/**
 * What can carry a tip: a DOM `title`, a control whose only content is an icon (its `aria-label`), or a button whose
 * words are cut short.
 */
const SOURCES = '[title], button, a[href], [role="button"]';
const ICON_ONLY = 'button:not([role]), a[href]:not([role]), [role="button"]';
const FIELDS = "input, textarea, select, [contenteditable]";

/**
 * What `el` says in a tip. Null: nothing of its own, an ancestor may. "": nothing, and no ancestor either (as the
 * browser does for an empty `title`).
 */
function said(el: Element): string | null {
  // An SVG's words are its <title> child, a frame's `title` is its name: both stay the browser's.
  if (!(el instanceof HTMLElement) || el.tagName === "IFRAME") return null;
  const title = el.getAttribute("title");
  // A field's `title` is also its validation bubble's hint (`pattern`): it stays where the browser reads it.
  if (title !== null) return el.hasAttribute("pattern") ? "" : title.trim() && title;
  // A button's words cut short by its place (`.ac-btn__label` in a dialog's foot) are said whole.
  const label = el.querySelector(":scope > .ac-btn__label");
  if (label instanceof HTMLElement && label.scrollWidth > label.clientWidth) return label.textContent ?? "";
  if (
    !el.matches(ICON_ONLY) ||
    // One that opens a hover card or an ⓘ already says more on hover, an open menu covers where the tip would go.
    el.hasAttribute("data-no-tip") ||
    el.hasAttribute("aria-describedby") ||
    el.getAttribute("aria-expanded") === "true" ||
    el.textContent?.trim()
  )
    return null;
  return el.getAttribute("aria-label") || null;
}

/**
 * The product's tooltip, for every DOM `title` and every icon-only control on the page, with no change where they are
 * written: one layer per document that listens for the pointer and the keys' focus.
 *
 * While the pointer or the focus is on an element, its `title` is held here and emptied on the element, so the
 * browser's own tooltip never opens; it goes back when the pointer or the focus leaves. At rest the page is as it was
 * written, so a `title` that React changes or drops is never stale. An element named only by its `title` keeps the name
 * as `aria-label` meanwhile; any other is described by the shown tip (`aria-describedby`).
 *
 * It opens after `TITLE_TIP_OPEN_MS` under a mouse or a pen (at once within `TITLE_TIP_GRACE_MS` of the last one), at
 * once on the keys' focus, never under a finger (a phone keeps its browser's long press). The pointer leaving, a blur,
 * any key, a press, a resize or a scroll that moves it from under the pointer closes it. It is the last thing in <body>,
 * over the dialog, popover or toast its element is in, placed by `placeTip` and kept whole inside the window.
 */
export function installTitleTips(doc: Document = document): () => void {
  const win = doc.defaultView;
  if (!win) return () => {};
  trackInput();
  const tip = doc.createElement("div");
  tip.id = TITLE_TIP_ID;
  tip.className = "ac-tip ac-tip--title";
  tip.setAttribute("role", "tooltip");
  // Each tip in its own words' direction, whatever the page's.
  tip.dir = "auto";

  let anchor: HTMLElement | null = null;
  let text = "";
  let by: "pointer" | "keys" = "pointer";
  /** What holding the anchor changed on it, to undo on release. */
  let held = { title: false, blank: false, name: false, described: false };
  let shown = false;
  let wait: ReturnType<typeof setTimeout> | undefined;
  /** A tip the pointer just left: the next one opens with no wait. */
  let warm = false;
  let cooling: ReturnType<typeof setTimeout> | undefined;
  let pointer = { x: 0, y: 0 };

  const place = () => {
    if (!anchor) return;
    const at = anchor.getBoundingClientRect();
    const box = { left: at.left, top: at.top, right: at.right, bottom: at.bottom };
    if (by === "pointer") {
      if (at.width > NEAR.width) {
        box.left = pointer.x;
        box.right = pointer.x;
      }
      if (at.height > NEAR.height) {
        // Clear of the cursor's own drawing, as the browser's tooltip is.
        box.top = pointer.y - 8;
        box.bottom = pointer.y + 20;
      }
    }
    // A column of tiles at the window's edge (the sidebar's, `data-tip-side="right"`): beside it, never over the next.
    if (anchor.closest('[data-tip-side="right"]')) {
      tip.dataset.side = "right";
      tip.style.left = `${at.right + TIP_GAP}px`;
      const middle = (at.top + at.bottom - tip.offsetHeight) / 2;
      tip.style.top = `${Math.max(EDGE_ROOM, Math.min(middle, win.innerHeight - EDGE_ROOM - tip.offsetHeight))}px`;
      return;
    }
    delete tip.dataset.side;
    // Its layout size: the entrance's transform would measure it smaller.
    const to = placeTip(box, { width: tip.offsetWidth, height: tip.offsetHeight }, "center", win.innerWidth);
    tip.style.left = `${to.left}px`;
    // A long one beside a low element, with no room over it either: whole in the window, over its element if need be.
    const low = win.innerHeight - EDGE_ROOM - tip.offsetHeight;
    tip.style.top = `${Math.max(EDGE_ROOM, Math.min(to.top, low))}px`;
  };

  const watch = new MutationObserver((records) => {
    if (!anchor) return;
    if (!anchor.isConnected) return leave(false);
    if (!held.title || !records.some((r) => r.type === "attributes")) return;
    const now = anchor.getAttribute("title");
    if (!now?.trim()) {
      // Dropped or emptied where it is written: nothing to give back.
      held.title = false;
      return leave(false);
    }
    text = now;
    anchor.setAttribute("title", "");
    // This write is not the page's: the next call must only see the page's own, an emptied title among them.
    watch.takeRecords();
    if (held.name) anchor.setAttribute("aria-label", now);
    if (shown) {
      tip.textContent = now;
      place();
    }
  });
  const observe = () => {
    watch.disconnect();
    if (anchor && held.title) watch.observe(anchor, { attributes: true, attributeFilter: ["title"] });
    // A shown tip goes with its element when the page removes it under a resting pointer.
    if (shown) watch.observe(doc.body, { childList: true, subtree: true });
  };

  const hold = (el: HTMLElement, words: string, how: "pointer" | "keys") => {
    anchor = el;
    text = words;
    by = how;
    if (!el.hasAttribute("title")) {
      // Saying its label inside a titled row: an empty `title` here keeps the browser from opening the row's beside it.
      if (el.parentElement?.closest("[title]")) {
        el.setAttribute("title", "");
        held.blank = true;
      }
      return;
    }
    held.title = true;
    const named =
      el.hasAttribute("aria-label") ||
      el.hasAttribute("aria-labelledby") ||
      el.textContent?.trim() ||
      // A face or a logo inside names it by its own words.
      el.querySelector('img[alt]:not([alt=""]), [aria-label]') ||
      (el as HTMLInputElement).labels?.length;
    if (!named) {
      el.setAttribute("aria-label", words);
      held.name = true;
    }
    el.setAttribute("title", "");
    observe();
  };

  const show = (now: boolean) => {
    if (!anchor?.isConnected) return;
    tip.textContent = text;
    tip.classList.toggle("ac-tip--now", now);
    doc.body.append(tip);
    shown = true;
    if (
      held.title &&
      !held.name &&
      !anchor.hasAttribute("aria-describedby") &&
      anchor.getAttribute("aria-label") !== text &&
      // Cut words whose title says them whole.
      anchor.textContent?.trim() !== text.trim()
    ) {
      anchor.setAttribute("aria-describedby", TITLE_TIP_ID);
      held.described = true;
    }
    // One that only repeats its element's name is for the eyes: a screen reader never meets the words twice.
    if (held.described) tip.removeAttribute("aria-hidden");
    else tip.setAttribute("aria-hidden", "true");
    place();
    observe();
  };

  /** Closes the tip and keeps its element held: under a pointer that stays, neither tooltip opens again. */
  const hide = (grace: boolean) => {
    clearTimeout(wait);
    if (!shown) return;
    shown = false;
    tip.remove();
    if (grace) {
      warm = true;
      clearTimeout(cooling);
      cooling = setTimeout(() => {
        warm = false;
      }, TITLE_TIP_GRACE_MS);
    }
    if (held.described) anchor?.removeAttribute("aria-describedby");
    held.described = false;
    observe();
  };

  const leave = (grace: boolean) => {
    hide(grace);
    watch.disconnect();
    if (anchor) {
      if (held.title && anchor.getAttribute("title") === "") anchor.setAttribute("title", text);
      if (held.blank && anchor.getAttribute("title") === "") anchor.removeAttribute("title");
      if (held.name) anchor.removeAttribute("aria-label");
    }
    anchor = null;
    held = { title: false, blank: false, name: false, described: false };
  };

  const find = (start: EventTarget | null) => {
    if (!(start instanceof Element)) return null;
    for (let el = start.closest(SOURCES); el; el = el.parentElement?.closest(SOURCES) ?? null) {
      if (el === anchor) return { el: el as HTMLElement, words: text };
      const words = said(el);
      if (words !== null) return words ? { el: el as HTMLElement, words } : null;
    }
    return null;
  };

  const onOver = (e: PointerEvent) => {
    if (!hoverPointer(e.pointerType) || e.buttons) return;
    pointer = { x: e.clientX, y: e.clientY };
    const found = find(e.target);
    if (found && found.el === anchor) return;
    if (!found) {
      if (by === "pointer") leave(true);
      return;
    }
    const now = shown || warm;
    leave(false);
    hold(found.el, found.words, "pointer");
    if (now) show(true);
    else wait = setTimeout(() => show(false), TITLE_TIP_OPEN_MS);
  };
  const onOut = (e: PointerEvent) => {
    if (!anchor || by !== "pointer" || !hoverPointer(e.pointerType)) return;
    if (!(e.relatedTarget instanceof Node) || !anchor.contains(e.relatedTarget)) leave(true);
  };
  const onMove = (e: PointerEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
  };
  const onFocus = (e: FocusEvent) => {
    const el = e.target;
    // The focused element's own words only, and never a field's: typing in one needs no tip over it.
    if (!movesByKeys() || !(el instanceof HTMLElement) || el === anchor || el.matches(FIELDS)) return;
    const words = said(el);
    if (!words) return;
    leave(false);
    hold(el, words, "keys");
    show(false);
  };
  const onBlur = (e: FocusEvent) => {
    if (by === "keys" && e.target === anchor) leave(false);
  };
  const dismiss = () => hide(false);
  /**
   * Only what moves its element counts: a log that scrolls by itself elsewhere on the page does not. Under a pointer
   * the element leaves it, so the tip closes. Under the keys it follows: the focus itself scrolls its element into view.
   */
  const onScroll = (e: Event) => {
    if (!anchor || !(e.target instanceof Node) || !e.target.contains(anchor)) return;
    if (by === "keys") place();
    else hide(false);
  };

  const on = { capture: true, passive: true };
  doc.addEventListener("pointerover", onOver, on);
  doc.addEventListener("pointerout", onOut, on);
  doc.addEventListener("pointermove", onMove, on);
  // A drag that ends over an element rests there with no new `pointerover`.
  doc.addEventListener("pointerup", onOver, on);
  doc.addEventListener("focusin", onFocus, on);
  doc.addEventListener("focusout", onBlur, on);
  doc.addEventListener("keydown", dismiss, on);
  doc.addEventListener("pointerdown", dismiss, on);
  doc.addEventListener("scroll", onScroll, on);
  win.addEventListener("resize", dismiss);
  win.addEventListener("blur", dismiss);
  return () => {
    leave(false);
    clearTimeout(cooling);
    doc.removeEventListener("pointerover", onOver, on);
    doc.removeEventListener("pointerout", onOut, on);
    doc.removeEventListener("pointermove", onMove, on);
    doc.removeEventListener("pointerup", onOver, on);
    doc.removeEventListener("focusin", onFocus, on);
    doc.removeEventListener("focusout", onBlur, on);
    doc.removeEventListener("keydown", dismiss, on);
    doc.removeEventListener("pointerdown", dismiss, on);
    doc.removeEventListener("scroll", onScroll, on);
    win.removeEventListener("resize", dismiss);
    win.removeEventListener("blur", dismiss);
  };
}
