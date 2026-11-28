/**
 * Lets React survive a page edited behind its back. Browser translation swaps its text nodes for `<font>` ones, and
 * extensions move nodes too: React's next removal or insertion then throws NotFoundError, and that takes the whole
 * screen down. A node already gone stays gone; an insertion whose neighbour left goes last among its siblings. The
 * app stays translatable on purpose: people read their agents' messages in their own language.
 */
export function tolerateForeignDomEdits() {
  const { removeChild, insertBefore } = Node.prototype;
  Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
    return child.parentNode === this ? (removeChild.call(this, child) as T) : child;
  };
  Node.prototype.insertBefore = function <T extends Node>(this: Node, node: T, before: Node | null): T {
    return insertBefore.call(this, node, before?.parentNode === this ? before : null) as T;
  };
}

/**
 * Browser autofill and password managers fire `keydown`/`keyup` events with no `key` (a plain `Event`): a shortcut
 * listener reading `e.key.toLowerCase()` then throws and takes the screen down. Such an event is no key press, so it
 * stops here, before any other listener (capture on window, registered first).
 */
export function dropKeylessKeyEvents(target: Window = window) {
  for (const type of ["keydown", "keyup"])
    target.addEventListener(
      type,
      (e) => {
        if (typeof (e as KeyboardEvent).key !== "string") e.stopImmediatePropagation();
      },
      true,
    );
}
