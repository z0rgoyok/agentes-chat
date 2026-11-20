import type { LiveRef, LiveSelection } from "@agenteschat/client";
import { useSyncExternalStore } from "react";

/*
 * What travels between a live file's screen and its conversation's (ADR 0199), which a route can't carry: the part
 * of the file the conversation opens about (the quote over its composer, sent as the next message's `meta.liveRef`),
 * and the part a message's line names, shown when the file's screen is in view again.
 */

const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The quote waiting over each conversation's composer, by its channel. */
const abouts = new Map<string, LiveRef>();

/** The conversation `channelId` opens about this part of its file: its quote over the composer. */
export function setTalkAbout(channelId: string, ref: LiveRef): void {
  abouts.set(channelId, ref);
  changed();
}

/** The quote goes (its × or the message that carried it). */
export function dropTalkAbout(channelId: string): void {
  if (!abouts.delete(channelId)) return;
  changed();
}

export const talkAboutOf = (channelId: string): LiveRef | null => abouts.get(channelId) ?? null;

/** The quote over `channelId`'s composer, live. */
export const useTalkAbout = (channelId: string): LiveRef | null =>
  useSyncExternalStore(subscribe, () => talkAboutOf(channelId));

/** The part of each file to show once its screen is in view, by file. */
const reveals = new Map<string, { selection: LiveSelection; messageId?: string }>();

/** Shows `selection` (a message's line, or its pin) the next time the file's screen is in view. */
export function revealOnOpen(fileId: string, selection: LiveSelection, messageId?: string): void {
  reveals.set(fileId, messageId ? { selection, messageId } : { selection });
  changed();
}

/** What waits to be shown on `fileId`, live: the file's screen takes it once it is in view (`takeReveal`). */
export const useRevealFor = (fileId: string) => useSyncExternalStore(subscribe, () => reveals.get(fileId) ?? null);

export function takeReveal(fileId: string): void {
  if (!reveals.delete(fileId)) return;
  changed();
}
