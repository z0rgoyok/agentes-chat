import { and, type Executor, eq, schema, sql } from "@agenteschat/db";
import { ValidationError } from "./errors";

const { organizationMembers } = schema;

/** How a conversation's rows are drawn. Mirrored in packages/client/src/lib/chat-look.ts, which also holds the defaults. */
export const CHAT_STYLES = ["comfortable", "left", "bubbles", "compact"] as const;
export type ChatStyle = (typeof CHAT_STYLES)[number];
/** My bubbles in the Bolhas style: a light tint or the solid color. */
export const CHAT_TONES = ["light", "strong"] as const;
export type ChatTone = (typeof CHAT_TONES)[number];
/** Where a conversation opens: at its newest message, or where the person stopped reading. */
export const CHAT_OPEN_AT = ["latest", "read"] as const;
export type ChatOpenAt = (typeof CHAT_OPEN_AT)[number];
/** Tamanho do texto of the messages, smallest first. */
export const CHAT_TEXT_SIZES = ["xs", "sm", "md", "lg", "xl"] as const;
export type ChatTextSize = (typeof CHAT_TEXT_SIZES)[number];

/** Only what the person chose: a key not here keeps the app's default. */
export interface ChatPrefs {
  channelStyle?: ChatStyle;
  dmStyle?: ChatStyle;
  channelTone?: ChatTone;
  dmTone?: ChatTone;
  openAt?: ChatOpenAt;
  textSize?: ChatTextSize;
  /** Show every message in full, without folding it behind See more. */
  fullMessages?: boolean;
  /**
   * "Always send" (ADR 0160 §12): a report an agent offers about the app goes with its reply, without asking. Kept
   * here because it is theirs alone, per workspace, on every device.
   */
  feedbackAuto?: boolean;
  /** The background behind every conversation; absent: none. */
  wallpaper?: Wallpaper;
  /** A conversation's own background, by channel id (`saveConversationWallpaper`); absent: as the others. */
  wallpapers?: Record<string, Wallpaper>;
}

/**
 * A conversation's background. Mirrored in packages/client/src/lib/wallpaper.ts, which documents each kind;
 * how each is painted is in packages/ui/src/sky/wallpaper.ts.
 */
export const WALLPAPER_HUES = ["sky", "indigo", "violet", "rose", "amber", "green", "teal", "graphite"] as const;
export const WALLPAPER_NEUTRALS = ["paper", "mist", "sand"] as const;
type Hue = (typeof WALLPAPER_HUES)[number];
type Neutral = (typeof WALLPAPER_NEUTRALS)[number];
export type Wallpaper =
  | { kind: "none" }
  | { kind: "sky"; color: "auto" | Hue }
  | { kind: "drawings"; color: "auto" | Neutral | Hue }
  | { kind: "agents" }
  | { kind: "color"; color: Neutral | Hue }
  | { kind: "photo"; url: string; dim: number; x: number; y: number };
export const MAX_PHOTO_DIM = 0.8;
/** A photo of a person's, as `setWallpaperPhoto` names it. */
export const WALLPAPER_PHOTO_PATH = /^\/api\/app\/wallpapers\/([^/]+)\/([0-9a-f]{16}\.(jpg|png|webp))$/;
/** Conversations with their own background a person keeps, at most (a guard, far past any real use). */
const MAX_CONVERSATION_WALLPAPERS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isHue = (v: unknown): v is Hue => WALLPAPER_HUES.includes(v as Hue);
const isNeutral = (v: unknown): v is Neutral => WALLPAPER_NEUTRALS.includes(v as Neutral);
const unit = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);

/** A value as a background this build knows; anything else is undefined. */
export function wallpaperOf(v: unknown): Wallpaper | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  switch (o.kind) {
    case "none":
      return { kind: "none" };
    case "sky":
      return o.color === "auto" || isHue(o.color) ? { kind: "sky", color: o.color } : undefined;
    case "drawings":
      return o.color === "auto" || isHue(o.color) || isNeutral(o.color)
        ? { kind: "drawings", color: o.color }
        : undefined;
    case "agents":
      return { kind: "agents" };
    case "color":
      return isHue(o.color) || isNeutral(o.color) ? { kind: "color", color: o.color } : undefined;
    case "photo": {
      if (typeof o.url !== "string" || !WALLPAPER_PHOTO_PATH.test(o.url)) return undefined;
      return {
        kind: "photo",
        url: o.url,
        dim: Math.min(unit(o.dim) ?? 0.45, MAX_PHOTO_DIM),
        x: unit(o.x) ?? 0.5,
        y: unit(o.y) ?? 0.5,
      };
    }
    default:
      return undefined;
  }
}

/** The conversations' own backgrounds as stored: channel ids to backgrounds, the unknown ones dropped. */
function wallpapersOf(v: unknown): Record<string, Wallpaper> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, Wallpaper> = {};
  for (const [id, w] of Object.entries(v).slice(0, MAX_CONVERSATION_WALLPAPERS)) {
    const known = UUID.test(id) ? wallpaperOf(w) : undefined;
    if (known) out[id] = known;
  }
  return out;
}

/** A photo background has to be the person's own upload: another's address would show them someone else's photo. */
export function assertOwnWallpaper(w: Wallpaper | undefined, userId: string) {
  if (w?.kind !== "photo") return;
  const m = WALLPAPER_PHOTO_PATH.exec(w.url);
  if (!m || decodeURIComponent(m[1] ?? "") !== userId)
    throw new ValidationError("That photo isn't one of yours", "wallpaper.photo_not_yours");
}

const oneOf = <T extends string>(list: readonly T[], v: unknown) => (list.includes(v as T) ? (v as T) : undefined);

/** The stored value, keeping only what this build knows. */
export function chatPrefsOf(stored: unknown): ChatPrefs {
  const o = (stored ?? {}) as Record<string, unknown>;
  const picks = {
    channelStyle: oneOf(CHAT_STYLES, o.channelStyle),
    dmStyle: oneOf(CHAT_STYLES, o.dmStyle),
    channelTone: oneOf(CHAT_TONES, o.channelTone),
    dmTone: oneOf(CHAT_TONES, o.dmTone),
    openAt: oneOf(CHAT_OPEN_AT, o.openAt),
    textSize: oneOf(CHAT_TEXT_SIZES, o.textSize),
    fullMessages: typeof o.fullMessages === "boolean" ? o.fullMessages : undefined,
    feedbackAuto: typeof o.feedbackAuto === "boolean" ? o.feedbackAuto : undefined,
    wallpaper: wallpaperOf(o.wallpaper),
    wallpapers: wallpapersOf(o.wallpapers),
  };
  return Object.fromEntries(Object.entries(picks).filter(([, v]) => v !== undefined));
}

/** Merged in the database, so a choice made on another device in the meantime stays. Null: not a member here. */
export async function saveChatPrefs(db: Executor, orgId: string, userId: string, patch: ChatPrefs) {
  const rows = await db
    .update(organizationMembers)
    .set({ chatPrefs: sql`${organizationMembers.chatPrefs} || ${JSON.stringify(patch)}::jsonb` })
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .returning({ chatPrefs: organizationMembers.chatPrefs });
  return rows[0] ? chatPrefsOf(rows[0].chatPrefs) : null;
}

/**
 * A conversation's own background for this person (`PUT`/`DELETE …/channels/{channelId}/wallpaper`), kept in their
 * `chatPrefs.wallpapers`; null takes it away (the conversation follows the channels' or DMs' again). Changed in the
 * database, so the other choices, made on another device in the meantime, stay. Null: not a member here.
 */
export async function saveConversationWallpaper(
  db: Executor,
  orgId: string,
  userId: string,
  channelId: string,
  wallpaper: Wallpaper | null,
) {
  const all = sql`coalesce(${organizationMembers.chatPrefs} -> 'wallpapers', '{}'::jsonb)`;
  const next = wallpaper
    ? sql`${all} || jsonb_build_object(${channelId}::text, ${JSON.stringify(wallpaper)}::jsonb)`
    : sql`${all} - ${channelId}::text`;
  const rows = await db
    .update(organizationMembers)
    .set({ chatPrefs: sql`jsonb_set(${organizationMembers.chatPrefs}, '{wallpapers}', ${next})` })
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .returning({ chatPrefs: organizationMembers.chatPrefs });
  return rows[0] ? chatPrefsOf(rows[0].chatPrefs) : null;
}
