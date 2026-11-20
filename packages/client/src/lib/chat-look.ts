import type { Message, ThreadInfo } from "../api/types";
import { landedAfter } from "./timeline";
import type { Wallpaper } from "./wallpaper";

/**
 * How a person's conversations look (`chatPrefs` on their membership, on every device). `comfortable` is the original
 * layout (mine in a gray bubble on the right), `left` is one row for everyone, `bubbles` is a chat app's, `compact` puts
 * the time, a small face, the name and the text on one line. Mirrored in packages/engine/src/chat-prefs.ts.
 */
export const CHAT_STYLES = ["comfortable", "left", "bubbles", "compact"] as const;
export type ChatStyle = (typeof CHAT_STYLES)[number];
/** My bubbles in `bubbles`: a light tint of the color, or the solid color. */
export const CHAT_TONES = ["light", "strong"] as const;
export type ChatTone = (typeof CHAT_TONES)[number];
export const CHAT_OPEN_AT = ["latest", "read"] as const;
export type ChatOpenAt = (typeof CHAT_OPEN_AT)[number];
/**
 * Tamanho do texto, smallest first: the words of every message and the name over them, in every look and conversation.
 * The web's sizes are `--msg-text` and its lines in packages/ui's components.css, the phone's `CHAT_TEXT` in
 * apps/mobile/src/features/chat/look.ts (the system's own text size still applies there).
 */
export const CHAT_TEXT_SIZES = ["xs", "sm", "md", "lg", "xl"] as const;
export type ChatTextSize = (typeof CHAT_TEXT_SIZES)[number];

/** Only what the person chose: a key not here follows the defaults below, so they can change for everyone else. */
export interface ChatPrefs {
  channelStyle?: ChatStyle;
  dmStyle?: ChatStyle;
  channelTone?: ChatTone;
  dmTone?: ChatTone;
  openAt?: ChatOpenAt;
  textSize?: ChatTextSize;
  /** Show every message in full, without folding it behind See more. */
  fullMessages?: boolean;
  /** "Always send": a report an agent offers about the app goes with its reply, without asking me. */
  feedbackAuto?: boolean;
  /** The background behind every conversation (`./wallpaper.ts`); absent: none. */
  wallpaper?: Wallpaper;
  /** A conversation's own background, by channel id, over the two above; absent: as the others. */
  wallpapers?: Record<string, Wallpaper>;
}

/** Owner's decision: a channel reads as one log, and in a DM right and left already say who spoke. */
export const DEFAULT_CHANNEL_STYLE: ChatStyle = "left";
export const DEFAULT_DM_STYLE: ChatStyle = "bubbles";
export const DEFAULT_CHAT_TONE: ChatTone = "light";
/** Owner's decision: smaller words than before the setting existed, which `lg` comes close to. */
export const DEFAULT_TEXT_SIZE: ChatTextSize = "md";
/**
 * Owner's decision: a conversation opens at its latest message, at once, with no wait for the fresh page and no
 * scroll up to a "New" line. Only an explicit `openAt` is stored, so whoever picked "read" keeps it.
 */
export const DEFAULT_OPEN_AT: ChatOpenAt = "latest";

export const textSizeOf = (prefs: ChatPrefs | undefined): ChatTextSize => prefs?.textSize ?? DEFAULT_TEXT_SIZE;
export const openAtOf = (prefs: ChatPrefs | undefined): ChatOpenAt => prefs?.openAt ?? DEFAULT_OPEN_AT;

/**
 * A conversation's vertical rhythm, the web's (`--msg-part-gap`, `--msg-turn-gap`, `--msg-card-gap`, `--msg-block`) and
 * the phone's: `part` between what stacks inside one group (a message's parts, the next row of the same turn), `turn`
 * between groups, measured from what shows to what shows. `card` is a card under a message, in its row or in one of its
 * own, the same in every look. `block` is a row's plate past its content, and takes no room. Two blocks fit in a part,
 * so two tinted rows of a turn meet and never overlap.
 */
export const CHAT_RHYTHM: Record<ChatStyle, { part: number; turn: number; card: number; block: number }> = {
  left: { part: 8, turn: 20, card: 12, block: 4 },
  comfortable: { part: 8, turn: 20, card: 12, block: 4 },
  bubbles: { part: 8, turn: 16, card: 12, block: 1 },
  compact: { part: 4, turn: 8, card: 12, block: 1 },
};

/**
 * A channel's look by default in a personal workspace (ADR 0159): a group conversation of one person and their agents
 * reads like a chat app's, as a DM already does.
 */
export const PERSONAL_CHANNEL_STYLE: ChatStyle = "bubbles";

/**
 * Owner's decision: on the phone a channel opens in bubbles too, as a chat app's conversations do; the web keeps the
 * one log (`DEFAULT_CHANNEL_STYLE`). A look the person picks is theirs on every device.
 */
export const PHONE_CHANNEL_STYLE: ChatStyle = "bubbles";

/** Where a conversation is drawn: the phone's channels have their own default (`PHONE_CHANNEL_STYLE`). */
export type ChatSurface = "web" | "phone";

/** A channel's look for whoever hasn't chosen, by the workspace's mode and where it is drawn. */
export const defaultChannelStyle = (personal = false, surface: ChatSurface = "web"): ChatStyle =>
  personal ? PERSONAL_CHANNEL_STYLE : surface === "phone" ? PHONE_CHANNEL_STYLE : DEFAULT_CHANNEL_STYLE;

/**
 * What a conversation shows. A DM has two speakers; anything with more, or with no one person across, is a channel.
 * `personal`: the workspace is personal (ADR 0159), where a channel opens in bubbles too; `surface`: the phone's
 * channels open in bubbles as well. The person's choice wins.
 */
export function chatLookOf(
  prefs: ChatPrefs | undefined,
  dm: boolean,
  personal = false,
  surface: ChatSurface = "web",
): { style: ChatStyle; tone: ChatTone } {
  return dm
    ? { style: prefs?.dmStyle ?? DEFAULT_DM_STYLE, tone: prefs?.dmTone ?? DEFAULT_CHAT_TONE }
    : {
        style: prefs?.channelStyle ?? defaultChannelStyle(personal, surface),
        tone: prefs?.channelTone ?? DEFAULT_CHAT_TONE,
      };
}

/** Whether my own rows stand apart on the right. In the others, a row of mine is a row like anyone's. */
export const mineOnRight = (style: ChatStyle) => style === "comfortable" || style === "bubbles";

/**
 * Whether the other side's rows show their face. A DM whose look keeps mine on the right says who spoke by the side:
 * its header already names the one person or agent there, so no face. Channels, threads and the other looks keep it.
 */
export const facesShown = (style: ChatStyle, dm: boolean) => !(dm && mineOnRight(style));

/** Where a conversation opens the first time it is shown with `unread` messages waiting. */
export const opensAtLastRead = (prefs: ChatPrefs | undefined, unread: number) =>
  openAtOf(prefs) === "read" && unread > 0;

/**
 * The first message that landed after `lastReadAt` and isn't mine: where the "Novas" line goes. Null: none in what's
 * loaded.
 */
export function firstUnreadId(
  messages: readonly Pick<Message, "id" | "author" | "createdAt">[],
  lastReadAt: string | null | undefined,
  meId: string | null,
): string | null {
  const after = lastReadAt ? Date.parse(lastReadAt) : -Infinity;
  const first = messages.find((m) => landedAfter(m, after) && !(m.author.type === "person" && m.author.id === meId));
  return first?.id ?? null;
}

/**
 * A conversation opened with something unread and nothing new at its end: the unread is a reply in a thread, which
 * the conversation shows as one line under the thread's root, maybe far above. The root to bring into view: the
 * thread whose last reply (not mine) is the latest after `lastReadAt`. Null: something new is in the conversation
 * itself (`messages`, its own, no replies), or no thread has a reply since.
 */
export function unreadThreadRootId(
  messages: readonly Pick<Message, "id" | "author" | "createdAt">[],
  threads: readonly Pick<ThreadInfo, "id" | "lastMessage">[],
  lastReadAt: string | null | undefined,
  meId: string | null,
): string | null {
  if (firstUnreadId(messages, lastReadAt, meId)) return null;
  const after = lastReadAt ? Date.parse(lastReadAt) : -Infinity;
  let found: { id: string; at: number } | null = null;
  for (const x of threads) {
    const last = x.lastMessage;
    if (!last || (last.author.type === "person" && last.author.id === meId)) continue;
    const at = Date.parse(last.createdAt);
    if (at > after && (!found || at > found.at)) found = { id: x.id, at };
  }
  return found?.id ?? null;
}
