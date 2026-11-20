/**
 * The conversation's dock height (the composer's box with the lines over it), kept outside the screen's state: what is
 * drawn from it (the keyboard's gesture area, an empty conversation's greeting, the skeleton) redraws alone when it
 * changes, never the whole conversation, which a field growing a line or the working line coming and going redrew each
 * time. Pure, so it is tested without a screen.
 */
export interface DockHeight {
  get(): number;
  /** The box's height as it was just laid out; nobody is told when it is the same. */
  set(height: number): void;
  subscribe(listener: () => void): () => void;
}

/** The dock's height as last laid out in any conversation (0 before the first). */
let lastDock = 0;

/**
 * What a conversation opening now starts its dock's height at: the one laid out last, or a one-line composer over the
 * home indicator (`resting`). The list places its end above the dock before the dock has measured itself.
 */
export function openingDockHeight(resting: number): number {
  return lastDock > 0 ? lastDock : resting;
}

export function rememberDockHeight(height: number): void {
  if (height > 0) lastDock = height;
}

export function createDockHeight(): DockHeight {
  let height = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => height,
    set(next) {
      if (next === height) return;
      height = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * How far above its resting place the dock rides for the keyboard library's values (`KeyboardStickyView` with
 * `offset={{ opened: lift }}`, the height negative while open): the keyboard's height less the share of the composer's
 * bottom padding hidden behind the keys. A worklet.
 */
export function composerLift(height: number, progress: number, lift: number): number {
  "worklet";
  return Math.max(0, -height - lift * progress);
}

/**
 * The keyboard's room in the conversation's list as `KeyboardChatScrollView` takes it (its `getEffectiveHeight`): the
 * height the keyboard reached, less `offset` in the share it holds of the open keyboard's height (`target`). A worklet.
 */
export function listKeyboardRoom(height: number, target: number, offset: number): number {
  "worklet";
  if (offset === 0 || target === 0) return height;
  return (height * Math.max(target - offset, 0)) / target;
}
