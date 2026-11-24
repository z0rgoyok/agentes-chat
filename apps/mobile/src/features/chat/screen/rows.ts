import type { BrowserHandoff, LiveRun, TalkKind } from "@agenteschat/client";
import type { ConversationWait } from "@agenteschat/client/lib/computer-queue";
import { issueTakenOf } from "@agenteschat/client/lib/issues";
import { messageMediaOf } from "@agenteschat/client/lib/media";
import { isEventLine } from "@agenteschat/client/lib/notices";
import { voiceOf } from "@agenteschat/client/lib/voice";
import type { ChatRow } from "../logic";

export type Row =
  | (ChatRow & {
      /** A quiet line right under another: they stack as one group. */
      afterLine?: boolean;
      /** The next row of a turn under anything but a row of it: it takes a turn's gap. */
      newTurn?: boolean;
    })
  | { kind: "marker"; key: string; text: string }
  /** A file's conversation (ADR 0199, 0208): where the file was made or sent from, at its top. */
  | { kind: "origin"; key: string; artifactId: string; fileKind: TalkKind }
  /** A code session's conversation (ADR 0215 §11): where a suggestion opened it from, at its top. */
  | { kind: "codeOrigin"; key: string; sessionId: string }
  /** A run in line for its computer (`conversationWaits`): no live row of its own, this one for all its messages. */
  | { kind: "wait"; key: string; wait: ConversationWait }
  /** An agent's browser card: its live run in the browser, or (no run row) a take over held here. */
  | { kind: "browser"; key: string; run: LiveRun; handoff?: undefined }
  | { kind: "browser"; key: string; run: null; handoff: BrowserHandoff }
  /** Where the picture an agent is making will show (`makingImage`), until its reply takes its place. */
  | { kind: "image"; key: string; run: LiveRun }
  | { kind: "unseen"; key: string };

export const rowKey = (r: Row) => r.key;
export const isQuietLine = (r: Row | undefined) =>
  r?.kind === "message" && (isEventLine(r.message.meta) || issueTakenOf(r.message.meta) !== null);
/**
 * A row's type for the list, which keeps sizes per type: messages by how long they are and whether they carry a card
 * (as Expensify buckets them), so a row not measured yet is guessed close to its size and older pages land without a
 * jump.
 */
export const rowType = (r: Row) => {
  if (r.kind !== "message") return r.kind;
  // A GIF or a sticker alone (ADR 0091) is about its picture's size, not a text's.
  if (voiceOf(r.message.meta)) return "message-voice";
  const media = r.message.body.trim() ? null : messageMediaOf(r.message.meta);
  if (media) return `message-${media.kind}`;
  const n = r.message.body.length;
  const size = n < 80 ? "s" : n < 320 ? "m" : n < 1200 ? "l" : "xl";
  return r.message.meta && Object.keys(r.message.meta).length > 0 ? `message-${size}-card` : `message-${size}`;
};
/** A sticker's row counts as in view from here: one barely in at the edge doesn't take a place among those playing. */
export const STICKER_VIEW = { id: "stickers", itemVisiblePercentThreshold: 30 };
export const DIVIDER_KEY = "unseen-divider";

/** A message's row in the conversation's list. */
export type MessageItem = Extract<Row, { kind: "message" }>;
