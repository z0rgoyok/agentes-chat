import { type LiveRoom, nextFrame, useLiveDocVersion } from "@agenteschat/client";
import { type DeckView, readDeck } from "@agenteschat/live/slides";
import { useMemo } from "react";

/**
 * A presentation as plain data (ADR 0196 §2), read again once a frame at most while it changes: whatever anyone (an
 * agent writing ten slides) does in a burst redraws the screen once a frame.
 */
export function useDeck(room: LiveRoom): DeckView {
  const version = useLiveDocVersion(room, nextFrame);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again after every change (`version`).
  return useMemo(() => readDeck(room.doc), [room, version]);
}
