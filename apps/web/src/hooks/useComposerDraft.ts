import { type ComposerDraft, readDraftBook, withDraft } from "@agenteschat/client/lib/composer-drafts";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AuthClient } from "@/auth/client";
import { STORAGE_KEYS, storage } from "@/lib/storage";

/** How long typing settles before the text is written down (the last change is also written when leaving). */
const SAVE_DELAY_MS = 400;

const bookKey = (userId: string) => `${STORAGE_KEYS.composerDrafts}.${userId}`;

/** The text this person left unsent in a conversation, from this browser's storage. */
export function readComposerDraft(userId: string, key: string): ComposerDraft | undefined {
  return readDraftBook(storage.get(bookKey(userId)), Date.now())[key];
}

/** Writes (or, blank, removes) one entry of this person's book of unsent texts. */
export function writeComposerDraft(userId: string, key: string, text: string) {
  const name = bookKey(userId);
  const next = withDraft(readDraftBook(storage.get(name), Date.now()), key, text, Date.now());
  if (Object.keys(next).length === 0) storage.remove(name);
  else storage.set(name, JSON.stringify(next));
}

/** Every person's unsent texts in this browser, forgotten on sign-out. */
export function forgetComposerDrafts() {
  try {
    const prefix = `${STORAGE_KEYS.composerDrafts}.`;
    for (const name of Object.keys(localStorage)) if (name.startsWith(prefix)) storage.remove(name);
  } catch {
    // Storage unavailable: nothing was kept.
  }
}

/** Signing out forgets every unsent text in this browser too (it may be someone else's next). */
export function withComposerDraftsSignOut(auth: AuthClient): AuthClient {
  return {
    ...auth,
    signOut: async () => {
      forgetComposerDrafts();
      await auth.signOut();
    },
  };
}

/** A composer's text as a store: the box reads it (`useDraftText`), what sends it reads it at that moment (`get`). */
export interface DraftStore {
  get(): string;
  set(next: string | ((old: string) => string)): void;
  subscribe(listener: () => void): () => void;
}

/**
 * A composer's text that survives switching conversations and reloading: it starts from `handed` (text another
 * screen gave it, like ⌘K "Pedir a um agente") or what was left unsent here, and every change is written down
 * shortly after typing settles, at once when the conversation closes or the page goes away. Sending clears it the
 * same way, with the text set to "". A store, not state: a key typed draws the box (`useDraftText`), never the
 * conversation that holds it.
 */
export function useComposerDraft(userId: string, key: string, handed?: string): DraftStore {
  const pending = useRef<string | null>(handed ?? null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current === null) return;
    writeComposerDraft(userId, key, pending.current);
    pending.current = null;
  }, [userId, key]);
  const flushNow = useRef(flush);
  flushNow.current = flush;

  const [store] = useState(() => {
    let text = handed ?? readComposerDraft(userId, key)?.text ?? "";
    const listeners = new Set<() => void>();
    return {
      get: () => text,
      set(next: string | ((old: string) => string)) {
        const value = typeof next === "function" ? next(text) : next;
        if (value === text) return;
        text = value;
        pending.current = value;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => flushNow.current(), SAVE_DELAY_MS);
        for (const l of listeners) l();
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  });

  // Handed text replaces what was left here: written down at once, like any change.
  useEffect(() => {
    if (pending.current !== null) flush();
  }, [flush]);

  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  return store;
}

/** The text in a draft, for what draws it: a change draws only the caller. */
export const useDraftText = (draft: DraftStore) => useSyncExternalStore(draft.subscribe, draft.get, draft.get);
