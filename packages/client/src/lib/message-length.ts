import type { TFunction } from "i18next";
import { ApiError } from "../api/http";
import { formatInt } from "./format";

/** The longest message the server takes, in characters. Mirrors `MAX_MESSAGE_LENGTH` in packages/engine/src/messages.ts. */
export const MAX_MESSAGE_LENGTH = 100_000;

/** A text counted as the server counts it (trimmed) is past the limit. */
export const tooLongToSend = (text: string, max = MAX_MESSAGE_LENGTH) => text.trim().length > max;

/**
 * A field shows how much it holds from this share of its limit. Mirror: `LIMIT_NEAR` in packages/ui Field.tsx (the
 * kit can't import the client).
 */
export const LIMIT_NEAR = 0.9;

/** A text returning to a field that may hold another: both stay, the returning one first. */
export const joinDrafts = (returning: string, typed: string) => (typed.trim() ? `${returning}\n\n${typed}` : returning);

/** "A mensagem tem 120.000 caracteres e o limite é 100.000." */
export const tooLongText = (t: TFunction, locale: string, length: number, max = MAX_MESSAGE_LENGTH) =>
  t("channel.tooLong.text", { length: formatInt(locale, length), max: formatInt(locale, max) });

/** Under a field past its limit: "O texto tem 20.512 caracteres e o limite é 20.000. Encurte o texto." */
export const overLimitText = (t: TFunction, locale: string, length: number, max: number) =>
  t("common.overLimit", { length: formatInt(locale, length), max: formatInt(locale, max) });

/** A refusal of a message past the limit, with its sizes and then `fix`; null for any other error. */
export function tooLongRefusal(t: TFunction, locale: string, error: unknown, fix: string): string | null {
  if (!(error instanceof ApiError) || error.code !== "message.too_long") return null;
  const { length, max } = error.params ?? {};
  if (typeof length !== "number") return fix;
  return `${tooLongText(t, locale, length, typeof max === "number" ? max : MAX_MESSAGE_LENGTH)} ${fix}`;
}

/**
 * How tall a message shows in a conversation before it is clipped, in points (web and phone alike): one taller than
 * `over` (about two screens of text) shows its first `shows`, faded, and opens whole. Once clipped, it opens again only
 * under `shows`: a measure that moves a few lines with the column's width (a scrollbar showing, a rotated phone) never
 * flips it between clipped and whole.
 */
export const LONG_MESSAGE = { over: 1200, shows: 480 } as const;

/** The height a message of `height` shows at in a conversation: null when it shows whole. */
export const clippedHeight = (height: number): number | null =>
  height > LONG_MESSAGE.over ? LONG_MESSAGE.shows : null;

/**
 * The messages shown whole this session however long, by id: opened with "Ver mais", or shown whole as the answer the
 * reader waited for (`answerIds`). They stay whole while the app runs, on any screen that shows them again, and never
 * fold under the reader as newer messages arrive.
 */
export const shownWhole = new Set<string>();

/**
 * The messages a conversation shows whole however long, never behind "Ver mais": its newest, and every one after the
 * reader's own latest (the answer they wait for). `messages` oldest first.
 */
export function answerIds(messages: readonly { id: string; mine: boolean }[]): Set<string> {
  const ids = new Set<string>();
  // Back from the newest to the reader's own latest; none of theirs here: only the newest.
  for (let i = messages.length - 1; i >= 0 && !messages[i]?.mine; i--) ids.add(messages[i]?.id as string);
  if (ids.size === messages.length) ids.clear();
  const newest = messages.at(-1);
  if (newest) ids.add(newest.id);
  return ids;
}
