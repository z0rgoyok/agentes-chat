import { isApple } from "@agenteschat/ui";
import { useEffect, useRef } from "react";

/**
 * The Code page's keys (ADR 0215), with ⌘ on Apple platforms and Ctrl elsewhere: ⌘P finds a file of the open session,
 * ⌘J shows or hides its terminal, ⌥⌘N starts a new session, ⌥⌘↑ and ⌥⌘↓ open the session above or below in the list.
 * None is a key the browser keeps for itself. The page listens (`useCodeKeys`); each piece answers its own key
 * (`useCodeKey`), and one that shows only after the key went down asks whether it was for it (`takeCodeKey`).
 */
export type CodeKey = "files" | "terminal" | "newSession" | "prevSession" | "nextSession";

type Keys = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** The key a key press is, or null. With ⌥ held a Mac types another character: the physical key says which. */
export function codeKeyOf(e: Keys, apple = isApple()): CodeKey | null {
  const mod = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.shiftKey) return null;
  if (!e.altKey) {
    if (e.code === "KeyP" || e.key.toLowerCase() === "p") return "files";
    if (e.code === "KeyJ" || e.key.toLowerCase() === "j") return "terminal";
    return null;
  }
  if (e.code === "KeyN") return "newSession";
  if (e.key === "ArrowUp") return "prevSession";
  if (e.key === "ArrowDown") return "nextSession";
  return null;
}

const LABELS: Record<CodeKey, { alt: boolean; key: string; other?: string }> = {
  files: { alt: false, key: "P" },
  terminal: { alt: false, key: "J" },
  newSession: { alt: true, key: "N" },
  prevSession: { alt: true, key: "↑", other: "Up" },
  nextSession: { alt: true, key: "↓", other: "Down" },
};

/** How a key reads on this platform: "⌘P", "⌥⌘N"; elsewhere "Ctrl+P", "Ctrl+Alt+N". */
export function codeKeyLabel(key: CodeKey, apple = isApple()) {
  const k = LABELS[key];
  if (apple) return `${k.alt ? "⌥" : ""}⌘${k.key}`;
  return `Ctrl+${k.alt ? "Alt+" : ""}${k.other ?? k.key}`;
}

/** A button's tooltip with its key: "Buscar arquivo (⌘P)". */
export const withKey = (label: string, key: CodeKey) => `${label} (${codeKeyLabel(key)})`;

const EVENT = "agentes:code-key";
/** How long a key waits for the piece it opens (the Files tab ⌘P shows, the home ⌥⌘N opens). */
const ASK_MS = 2000;
const asked = new Map<CodeKey, number>();

export function emitCodeKey(key: CodeKey) {
  asked.set(key, Date.now());
  window.dispatchEvent(new CustomEvent<CodeKey>(EVENT, { detail: key }));
}

/** Whether `key` just went down for this piece (shown by it, or on screen already): answered, it is no longer asked. */
export function takeCodeKey(key: CodeKey) {
  const at = asked.get(key);
  asked.delete(key);
  return at !== undefined && Date.now() - at < ASK_MS;
}

/** Calls `handler` when `key` goes down on the Code page. */
export function useCodeKey(key: CodeKey, handler: () => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<CodeKey>).detail === key) latest.current();
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [key]);
}

/**
 * The page's listener: a key of its own goes to its pieces and nowhere else. Caught on its way down, before the focused
 * control's own keys (a picker would open on ⌥⌘↓) and the browser's (⌘P would print).
 */
export function useCodeKeys() {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const key = codeKeyOf(e);
      if (!key) return;
      e.preventDefault();
      e.stopPropagation();
      emitCodeKey(key);
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, []);
}
