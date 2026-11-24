/**
 * Puts `next` in the field as if typed over the part that changed: the browser keeps it on its own undo stack, so ⌘Z
 * takes it back and ⇧⌘Z puts it again. Setting `value` (what a controlled field does) empties that stack instead.
 * Fires the field's `input` event, so a React `onChange` sees the new text. False when the browser can't (no
 * `execCommand`, the field can't take the focus): the caller then sets the value itself.
 */
export function typeInto(el: HTMLTextAreaElement | HTMLInputElement, next: string): boolean {
  const was = el.value;
  if (was === next) return true;
  let start = 0;
  while (start < was.length && start < next.length && was[start] === next[start]) start++;
  let tail = 0;
  while (
    tail < was.length - start &&
    tail < next.length - start &&
    was[was.length - 1 - tail] === next[next.length - 1 - tail]
  )
    tail++;
  const text = next.slice(start, next.length - tail);
  if (typeof document.execCommand !== "function") return false;
  el.focus({ preventScroll: true });
  // Unfocused, the command would type into whatever has the focus.
  if (document.activeElement !== el) return false;
  el.setSelectionRange(start, was.length - tail);
  const done = document.execCommand(text ? "insertText" : "delete", false, text);
  return done && el.value === next;
}
