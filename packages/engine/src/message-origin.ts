import { type SQL, schema, sql } from "@agenteschat/db";

const { messages } = schema;
type MessageOrigin = schema.MessageOrigin;

/**
 * The one rule for whose words a message carries (ADR 0250): text a person typed in our own apps (`app`), or wrote from
 * their own linked outside chat (`surface` with `meta.ownWords`, set only by the bridge's insert for a linked sender's
 * own, non-forwarded message, ADR 0187), carrying no outside mark, is their own. Everything else (posted with a token
 * or by an AI app, forwarded from another chat, bridged before `ownWords` was recorded, written by the server, written
 * before origins were recorded) is content the agents may read and answer, never the source of a lasting rule, a
 * memory in someone's name, an instruction change, an approval or a permission.
 */
export const ownTyped = (m: {
  authorType: string;
  origin: MessageOrigin | null;
  meta?: Record<string, unknown> | null;
}): boolean =>
  m.authorType === "person" &&
  m.meta?.readOutside !== true &&
  (m.origin === "app" || (m.origin === "surface" && m.meta?.ownWords === true));

/** `ownTyped` as SQL, over `messages` or an alias of it (`m`). */
export const ownTypedSql = (alias?: string): SQL => {
  const [authorType, origin, meta] = alias
    ? [sql.raw(`${alias}.author_type`), sql.raw(`${alias}.origin`), sql.raw(`${alias}.meta`)]
    : [messages.authorType, messages.origin, messages.meta];
  return sql`(${authorType} = 'person' and coalesce(${meta}->>'readOutside', '') <> 'true'
    and (${origin} = 'app' or (${origin} = 'surface' and coalesce(${meta}->>'ownWords', '') = 'true')))`;
};

/** Origins that carry text from beyond our apps under a person's name: the prompt marks such a message as relayed. */
const RELAYED: ReadonlySet<MessageOrigin> = new Set(["mcp", "surface"]);

/** A person's message that came through a token, an AI app or a bridge (`RELAYED`) and isn't their own (`ownTyped`). */
export const relayedPersonMessage = (m: {
  authorType: string;
  origin: MessageOrigin | null;
  meta: Record<string, unknown> | null;
}) => m.authorType === "person" && m.origin != null && RELAYED.has(m.origin) && !ownTyped(m);

/**
 * Whose words a bridged message carries (ADR 0250): a forwarded one is someone else's, read as quoted text; anything
 * else came from the linked, confirmed sender itself into its own DM with the right hand (ADR 0187 §7: the bridge acts
 * only for an active link, only there), so it is the person's own words, like a message typed in the app.
 */
export const surfaceWordsMeta = (via: { forwarded?: unknown }) =>
  via.forwarded === true ? { readOutside: true as const } : { ownWords: true as const };
