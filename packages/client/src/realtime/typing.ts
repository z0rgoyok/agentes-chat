import type { ChannelEvent } from "../api/types";

/**
 * "Marina está digitando…" and "Marina está gravando áudio…": who is typing or recording a voice message per channel,
 * from `user.typing` events (`kind: "voice"` while recording), each valid for `ttlMs`, and where (a thread's id, null
 * in the conversation itself). The latest frame per person wins. And the throttle for sending our own frames.
 */
export const TYPING_TTL_MS = 6000;
export const TYPING_SEND_EVERY_MS = 3000;

/** What a person is doing in the box: writing, or recording a voice message (the frame's `kind: "voice"`). */
export type TypingKind = "typing" | "voice";

export type TypingState = Record<string, Record<string, { until: number; threadId: string | null; kind: TypingKind }>>;

export function applyTyping(
  state: TypingState,
  channelId: string,
  userId: string,
  now: number,
  ttlMs = TYPING_TTL_MS,
  threadId: string | null = null,
  kind: TypingKind = "typing",
): TypingState {
  return { ...state, [channelId]: { ...state[channelId], [userId]: { until: now + ttlMs, threadId, kind } } };
}

/** Someone's message arrived: they stopped typing. */
export function stopTyping(state: TypingState, channelId: string, userId: string): TypingState {
  const current = state[channelId];
  if (!current?.[userId]) return state;
  const { [userId]: _u, ...rest } = current;
  return { ...state, [channelId]: rest };
}

/**
 * A conversation's event on who is at it: a frame starts or renews someone, and their message ends them, also one too
 * big for its event, which names its author without the message.
 */
export function applyTypingEvent(state: TypingState, event: ChannelEvent, now: number): TypingState {
  if (event.type === "user.typing")
    return applyTyping(state, event.channelId, event.userId, now, event.ttlMs, event.threadId, event.kind);
  if (event.type !== "message.created") return state;
  const author = event.message
    ? event.message.author?.type === "person" && event.message.author.id
    : event.authorUserId;
  return author ? stopTyping(state, event.channelId, author) : state;
}

/** Without the typing that ran out by `now` (the same state when none did): a store can drop it on time. */
export function expireTyping(state: TypingState, now: number): TypingState {
  let next = state;
  for (const [channelId, users] of Object.entries(state)) {
    const live = Object.entries(users).filter(([, at]) => at.until > now);
    if (live.length < Object.keys(users).length) next = { ...next, [channelId]: Object.fromEntries(live) };
  }
  return next;
}

/** One person at it, and what they do. */
export interface TypingWho {
  id: string;
  kind: TypingKind;
}

/** Who is typing or recording in the conversation itself (`threadId` null) or in one of its threads. */
export const typingIn = (
  state: TypingState,
  channelId: string,
  now: number,
  exceptUserId?: string,
  threadId: string | null = null,
): TypingWho[] =>
  Object.entries(state[channelId] ?? {})
    .filter(([id, at]) => at.until > now && at.threadId === threadId && id !== exceptUserId)
    .map(([id, at]) => ({ id, kind: at.kind }));

/**
 * Returns a function that says whether to send a typing frame now: at most one every 3 s, but always when the composer
 * starts a new message, so a person writing a second message right after the first shows at once (the server ends an
 * agent's wait early when nobody is typing). A new message: the text is neither a continuation of the last one seen
 * nor cut from it (the field was sent and cleared, or emptied), whatever its length (a pasted text, a suggestion
 * tapped, swipe typing). A frame of the other kind also goes at once, so the others see the change. A take's
 * `keepAlive` frames while it uploads wait until the person hasn't written for 3 s: writing takes over. Its frames
 * while it records never wait, so an agent asked just before still holds its quiet window for the take.
 */
export function typingThrottle(every = TYPING_SEND_EVERY_MS) {
  let last = Number.NEGATIVE_INFINITY;
  let wrote = Number.NEGATIVE_INFINITY;
  let seen = "";
  let sent: TypingKind = "typing";
  return (now: number, text?: string, kind: TypingKind = "typing", keepAlive = false) => {
    if (kind === "voice" && keepAlive && now - wrote < every) return false;
    const next = text?.trim() ?? "";
    const first = kind !== sent || (next !== "" && (seen === "" || (!next.startsWith(seen) && !seen.startsWith(next))));
    if (text !== undefined) seen = next;
    if (next !== "") wrote = now;
    if (!first && now - last < every) return false;
    last = now;
    sent = kind;
    return true;
  };
}
