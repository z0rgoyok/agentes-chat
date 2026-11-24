import { randomBytes } from "node:crypto";
import { and, type Database, desc, eq, inArray, lt, schema, sql } from "@agenteschat/db";
import type { ToolOutput } from "../../tools/types";
import type { ConnectionSecret } from "../connections";
import {
  json,
  type NativeCall,
  type NativeConnection,
  NativeError,
  type NativeService,
  type NativeTool,
  pageSize,
  str,
} from "./types";

/**
 * Telegram (ADR 0170): a bot a workspace made with @BotFather, connected by its token. A bot can't read history: what
 * it heard is kept in `telegram_updates` (30 days), by webhook where the internet reaches this server, else by
 * `getUpdates` on the worker loop. Its own sends are kept there too, so a chat reads as a conversation.
 */

const { telegramUpdates } = schema;
const API = "https://api.telegram.org";
/** Telegram keeps updates for 24 hours; ours, for a chat's recent past. */
export const TELEGRAM_KEEP_DAYS = 30;
const PHOTO_MAX = 10 * 1024 * 1024;
const FILE_MAX = 50 * 1024 * 1024;
const MESSAGE_MAX = 4096;

interface TgAnswer {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

const tokenOf = (secret: ConnectionSecret) => {
  const token = secret.apiKey;
  if (!token) throw new NativeError("connector.needs_reconnect", "The Telegram bot's token is missing: reconnect it.");
  return token;
};

/** One Bot API method. `writes`: a timeout may have happened on Telegram's side. */
export async function telegramCall<T = unknown>(
  http: typeof fetch,
  secret: ConnectionSecret,
  method: string,
  body: Record<string, unknown> | FormData = {},
  writes = false,
): Promise<T> {
  let res: Response;
  try {
    res = await http(`${API}/bot${tokenOf(secret)}/${method}`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      ...(body instanceof FormData
        ? { body }
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    throw writes
      ? new NativeError(
          "connector.unknown_result",
          "Telegram didn't answer in time: it may have happened. Read the chat (read_messages) before sending again.",
        )
      : new NativeError("connector.failed", "Telegram didn't answer. Try again in a minute.");
  }
  const answer = (await res.json().catch(() => ({ ok: false }))) as TgAnswer;
  if (answer.ok) return answer.result as T;
  const said = (answer.description ?? `HTTP ${res.status}`).slice(0, 300);
  const code = answer.error_code ?? res.status;
  if (code === 401 || code === 404) {
    throw new NativeError(
      "connector.needs_reconnect",
      "Telegram refused the bot's token (revoked in @BotFather?): someone who manages connectors reconnects it with a new token.",
    );
  }
  if (code === 429) {
    const seconds = answer.parameters?.retry_after ?? 30;
    const at = new Date(Date.now() + seconds * 1000);
    throw new NativeError(
      "connector.rate_limited",
      `Telegram takes no more from this bot until ${at.toISOString().slice(11, 16)} UTC (about ${seconds} s). Nothing was sent.`,
      at,
    );
  }
  if (code >= 500) throw new NativeError("connector.failed", "Telegram is busy right now. Try again in a minute.");
  throw new NativeError("connector.refused", `Telegram refused it: "${said}"`);
}

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}
interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}
interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  date: number;
  text?: string;
  caption?: string;
  photo?: unknown[];
  document?: { file_name?: string };
  video?: unknown;
  voice?: unknown;
  sticker?: { emoji?: string };
  reply_to_message?: { from?: TgUser };
  entities?: { type: string; offset: number; length: number; user?: TgUser }[];
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  edited_channel_post?: TgMessage;
  my_chat_member?: { chat: TgChat; from: TgUser; date: number; new_chat_member: { status: string } };
}

const nameOf = (u?: TgUser) =>
  u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || (u.username ? `@${u.username}` : String(u.id)) : null;
const chatTitle = (c: TgChat) =>
  c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(" ") || (c.username ? `@${c.username}` : null));

/** What a message holds when it has no text: "[photo]", "[file report.pdf]". */
function bodyOf(m: TgMessage) {
  const text = m.text ?? m.caption ?? "";
  const media = m.photo
    ? "[photo]"
    : m.document
      ? `[file ${m.document.file_name ?? ""}]`.replace(" ]", "]")
      : m.video
        ? "[video]"
        : m.voice
          ? "[voice message]"
          : m.sticker
            ? `[sticker ${m.sticker.emoji ?? ""}]`.replace(" ]", "]")
            : "";
  return [media, text].filter(Boolean).join(" ");
}

/** Whether a message is for the bot: a private chat with it, or one that mentions or answers it. */
export function addressesBot(m: TgMessage, bot: { id: string | null; username: string | null }) {
  if (m.chat.type === "private") return true;
  if (bot.id && String(m.reply_to_message?.from?.id ?? "") === bot.id) return true;
  const handle = bot.username?.replace(/^@/, "").toLowerCase();
  const text = m.text ?? m.caption ?? "";
  return (m.entities ?? []).some(
    (e) =>
      (e.type === "mention" && handle && text.slice(e.offset + 1, e.offset + e.length).toLowerCase() === handle) ||
      (e.type === "text_mention" && bot.id && String(e.user?.id) === bot.id),
  );
}

/**
 * Keeps the updates the bot heard (each once, by `update_id`). Returns the new messages addressed to the bot, for the
 * routines listening to it.
 */
export async function ingestTelegramUpdates(
  db: Database,
  connection: NativeConnection,
  updates: TgUpdate[],
): Promise<
  {
    updateId: number;
    chatId: string;
    chatTitle: string | null;
    sender: string | null;
    text: string;
    messageId: number | null;
  }[]
> {
  type Row = typeof telegramUpdates.$inferInsert & { updateId: number; addressed: boolean };
  const rows = updates.flatMap((u): Row[] => {
    const m = u.message ?? u.channel_post ?? u.edited_message ?? u.edited_channel_post;
    const base = { orgId: connection.orgId, connectionId: connection.id, updateId: u.update_id };
    if (m) {
      return [
        {
          ...base,
          chatId: String(m.chat.id),
          chatType: m.chat.type,
          chatTitle: chatTitle(m.chat),
          senderName: nameOf(m.from),
          senderId: m.from ? String(m.from.id) : null,
          messageId: m.message_id,
          text: bodyOf(m).slice(0, MESSAGE_MAX),
          kind: u.edited_message || u.edited_channel_post ? "edited" : "message",
          status: null,
          addressed: addressesBot(m, { id: connection.accountId, username: connection.accountLabel }),
        },
      ];
    }
    const member = u.my_chat_member;
    if (member) {
      return [
        {
          ...base,
          chatId: String(member.chat.id),
          chatType: member.chat.type,
          chatTitle: chatTitle(member.chat),
          senderName: nameOf(member.from),
          senderId: String(member.from.id),
          messageId: null,
          text: null,
          kind: "member",
          status: member.new_chat_member.status,
          addressed: false,
        },
      ];
    }
    return [];
  });
  if (rows.length === 0) return [];
  const added = await db
    .insert(telegramUpdates)
    .values(rows.map(({ addressed: _, ...r }) => r))
    .onConflictDoNothing()
    .returning({ updateId: telegramUpdates.updateId });
  const fresh = new Set(added.map((a) => a.updateId));
  return rows
    .filter((r) => r.addressed && r.kind === "message" && fresh.has(r.updateId))
    .map((r) => ({
      updateId: r.updateId,
      chatId: r.chatId,
      chatTitle: r.chatTitle ?? null,
      sender: r.senderName ?? null,
      text: r.text ?? "",
      messageId: r.messageId ?? null,
    }));
}

/** Drops what the bot heard more than `TELEGRAM_KEEP_DAYS` ago. */
export async function purgeTelegramUpdates(db: Database) {
  await db
    .delete(telegramUpdates)
    .where(lt(telegramUpdates.receivedAt, sql`now() - ${`${TELEGRAM_KEEP_DAYS} days`}::interval`));
}

const chatInput = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  description: "The chat's id from list_chats (a group's starts with -100), or a public channel's @username.",
} as const;
const messageInput = { type: "integer", description: "The message's id (from read_messages or a send)." } as const;

/** A message the bot sent, kept beside what it heard. */
async function keepSent(call: NativeCall, chatId: string, m: TgMessage | undefined, text: string) {
  if (!m) return;
  await call.db
    .insert(telegramUpdates)
    .values({
      orgId: call.connection.orgId,
      connectionId: call.connection.id,
      updateId: null,
      chatId: String(m.chat?.id ?? chatId),
      chatType: m.chat?.type ?? "unknown",
      chatTitle: m.chat ? chatTitle(m.chat) : null,
      senderName: call.connection.accountLabel,
      senderId: call.connection.accountId,
      messageId: m.message_id,
      text: text.slice(0, MESSAGE_MAX),
      kind: "sent",
    })
    .catch(() => {});
}

const sent = (what: string, m: TgMessage | undefined): ToolOutput => ({
  content: `${what} (message ${m?.message_id ?? "?"}).`,
  data: { messageId: m?.message_id ?? null },
});

const tools: Record<string, NativeTool> = {
  list_chats: {
    external: true,
    description:
      "The chats your Telegram bot is in: private chats with people who wrote to it, groups and channels it was added to, newest first. A bot can't start a chat: a person writes to it first, or adds it to a group (an admin adds it to a channel to post there).",
    input: { properties: {} },
    async run(_input, call) {
      const rows = await call.db
        .select({
          chatId: telegramUpdates.chatId,
          chatType: sql<string>`(array_agg(${telegramUpdates.chatType} order by ${telegramUpdates.receivedAt} desc))[1]`,
          title: sql<
            string | null
          >`(array_agg(${telegramUpdates.chatTitle} order by ${telegramUpdates.receivedAt} desc) filter (where ${telegramUpdates.chatTitle} is not null))[1]`,
          status: sql<
            string | null
          >`(array_agg(${telegramUpdates.status} order by ${telegramUpdates.receivedAt} desc) filter (where ${telegramUpdates.kind} = 'member'))[1]`,
          last: sql<string>`max(${telegramUpdates.receivedAt})`,
        })
        .from(telegramUpdates)
        .where(eq(telegramUpdates.connectionId, call.connection.id))
        .groupBy(telegramUpdates.chatId)
        .orderBy(desc(sql`max(${telegramUpdates.receivedAt})`))
        .limit(100);
      const chats = rows
        .filter((r) => r.status !== "left" && r.status !== "kicked")
        .map((r) => ({ chat_id: r.chatId, type: r.chatType, title: r.title, admin: r.status === "administrator" }));
      if (chats.length === 0) {
        return {
          content: `The bot (${call.connection.accountLabel ?? "this bot"}) has heard from no chat yet. Someone writes to it on Telegram, or adds it to a group, then it shows here.`,
        };
      }
      return json(chats);
    },
  },
  read_messages: {
    description:
      "The last messages of one chat, oldest first: what people wrote where the bot is (in a group with privacy mode on, only what mentions or answers it) and what the bot sent. Telegram keeps no history for bots: only what came since it was connected, for 30 days.",
    input: {
      properties: {
        chat_id: chatInput,
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many (default 10)." },
      },
      required: ["chat_id"],
    },
    external: true,
    async run(input, call) {
      const rows = await call.db
        .select()
        .from(telegramUpdates)
        .where(
          and(
            eq(telegramUpdates.connectionId, call.connection.id),
            eq(telegramUpdates.chatId, str(input.chat_id)),
            inArray(telegramUpdates.kind, ["message", "edited", "sent"]),
          ),
        )
        .orderBy(desc(telegramUpdates.receivedAt))
        .limit(pageSize(input.limit));
      return json(
        rows.reverse().map((r) => ({
          message_id: r.messageId,
          from: r.kind === "sent" ? "the bot" : r.senderName,
          ...(r.senderId && r.kind !== "sent" ? { user_id: r.senderId } : {}),
          text: r.text,
          ...(r.kind === "edited" ? { edited: true } : {}),
          at: r.receivedAt.toISOString(),
        })),
      );
    },
  },
  get_chat: {
    description: "One chat's details from Telegram: its title, type, description and member count.",
    input: { properties: { chat_id: chatInput }, required: ["chat_id"] },
    external: true,
    async run(input, call) {
      const chat = await telegramCall<Record<string, unknown>>(call.http, call.secret, "getChat", {
        chat_id: str(input.chat_id),
      });
      const count = await telegramCall<number>(call.http, call.secret, "getChatMemberCount", {
        chat_id: str(input.chat_id),
      }).catch(() => null);
      const { id, type, title, username, description, first_name, last_name } = chat;
      return json({ id, type, title, username, description, first_name, last_name, members: count });
    },
  },
  send_message: {
    description:
      "Send a message as the bot to a chat it is in (list_chats). Plain text, up to 4,096 characters. Answer someone with reply_to.",
    input: {
      properties: {
        chat_id: chatInput,
        text: { type: "string", minLength: 1, maxLength: MESSAGE_MAX },
        reply_to: { ...messageInput, description: "The message to answer, by its id." },
      },
      required: ["chat_id", "text"],
    },
    async run(input, call) {
      const text = str(input.text);
      const m = await telegramCall<TgMessage>(
        call.http,
        call.secret,
        "sendMessage",
        {
          chat_id: str(input.chat_id),
          text,
          ...(typeof input.reply_to === "number" ? { reply_parameters: { message_id: input.reply_to } } : {}),
        },
        true,
      );
      await keepSent(call, str(input.chat_id), m, text);
      return sent("Sent", m);
    },
  },
  send_file: {
    description:
      "Send a file from the Drive as the bot: a picture shows as a photo (up to 10 MB), anything else as a file (up to 50 MB), with an optional caption.",
    input: {
      properties: {
        chat_id: chatInput,
        file: { type: "string", description: "The Drive file's id." },
        caption: { type: "string", maxLength: 1024 },
      },
      required: ["chat_id", "file"],
    },
    async run(input, call) {
      const file = await call.file(str(input.file));
      const photo = file.contentType.startsWith("image/") && file.bytes.byteLength <= PHOTO_MAX;
      if (file.bytes.byteLength > FILE_MAX) {
        return { content: `${file.name} is over Telegram's 50 MB for bots: nothing was sent.`, isError: true };
      }
      const form = new FormData();
      form.set("chat_id", str(input.chat_id));
      if (str(input.caption)) form.set("caption", str(input.caption));
      form.set(photo ? "photo" : "document", new Blob([file.bytes], { type: file.contentType }), file.name);
      const m = await telegramCall<TgMessage>(call.http, call.secret, photo ? "sendPhoto" : "sendDocument", form, true);
      await keepSent(call, str(input.chat_id), m, `[${photo ? "photo" : `file ${file.name}`}] ${str(input.caption)}`);
      return sent(`Sent ${file.name}`, m);
    },
  },
  edit_message: {
    description: "Change the text of a message the bot sent.",
    input: {
      properties: {
        chat_id: chatInput,
        message_id: messageInput,
        text: { type: "string", minLength: 1, maxLength: MESSAGE_MAX },
      },
      required: ["chat_id", "message_id", "text"],
    },
    async run(input, call) {
      await telegramCall(
        call.http,
        call.secret,
        "editMessageText",
        { chat_id: str(input.chat_id), message_id: input.message_id, text: str(input.text) },
        true,
      );
      return { content: "Edited." };
    },
  },
  pin_message: {
    description: "Pin a message in a chat (the bot must be an admin of a group or channel that may pin).",
    input: { properties: { chat_id: chatInput, message_id: messageInput }, required: ["chat_id", "message_id"] },
    async run(input, call) {
      await telegramCall(
        call.http,
        call.secret,
        "pinChatMessage",
        { chat_id: str(input.chat_id), message_id: input.message_id, disable_notification: true },
        true,
      );
      return { content: "Pinned." };
    },
  },
  delete_message: {
    description: "Delete a message in a chat: the bot's own, or anyone's where the bot is an admin that may delete.",
    input: { properties: { chat_id: chatInput, message_id: messageInput }, required: ["chat_id", "message_id"] },
    async run(input, call) {
      await telegramCall(
        call.http,
        call.secret,
        "deleteMessage",
        { chat_id: str(input.chat_id), message_id: input.message_id },
        true,
      );
      return { content: "Deleted." };
    },
  },
  ban_member: {
    description: "Remove someone from a group or channel and keep them out (the bot must be an admin that may ban).",
    input: {
      properties: { chat_id: chatInput, user_id: { type: "integer", description: "Their user id (read_messages)." } },
      required: ["chat_id", "user_id"],
    },
    async run(input, call) {
      await telegramCall(
        call.http,
        call.secret,
        "banChatMember",
        { chat_id: str(input.chat_id), user_id: input.user_id },
        true,
      );
      return { content: "Banned." };
    },
  },
  create_invite_link: {
    description: "Make a link that lets people join a group or channel (the bot must be an admin that may invite).",
    input: {
      properties: {
        chat_id: chatInput,
        name: { type: "string", maxLength: 32, description: "What the link is for, as admins see it." },
        member_limit: { type: "integer", minimum: 1, maximum: 99999 },
        expire_hours: { type: "integer", minimum: 1, maximum: 8760 },
      },
      required: ["chat_id"],
    },
    async run(input, call) {
      const link = await telegramCall<{ invite_link: string }>(
        call.http,
        call.secret,
        "createChatInviteLink",
        {
          chat_id: str(input.chat_id),
          ...(str(input.name) ? { name: str(input.name) } : {}),
          ...(typeof input.member_limit === "number" ? { member_limit: input.member_limit } : {}),
          ...(typeof input.expire_hours === "number"
            ? { expire_date: Math.floor(Date.now() / 1000) + input.expire_hours * 3600 }
            : {}),
        },
        true,
      );
      return { content: `Invite link: ${link.invite_link}` };
    },
  },
};

/** Where Telegram sends a bot's updates on this server. */
export const telegramWebhookPath = (connectionId: string) => `/api/webhooks/telegram/${connectionId}`;

export const telegram: NativeService = {
  tools,
  async account(secret, http) {
    const me = await telegramCall<TgUser>(http, secret, "getMe");
    if (!me.is_bot) throw new NativeError("connector.refused", "That token isn't a bot's.");
    return { label: me.username ? `@${me.username}` : (me.first_name ?? String(me.id)), id: String(me.id) };
  },
  async connected(secret, connection, http, publicBase) {
    if (!publicBase) {
      // Polling (`getUpdates`) and a webhook exclude each other.
      await telegramCall(http, secret, "deleteWebhook").catch(() => {});
      return { ...secret, webhookSecret: undefined };
    }
    const webhookSecret = randomBytes(32).toString("hex");
    await telegramCall(http, secret, "setWebhook", {
      url: `${publicBase.replace(/\/$/, "")}${telegramWebhookPath(connection.id)}`,
      secret_token: webhookSecret,
      allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post", "my_chat_member"],
    });
    return { ...secret, webhookSecret };
  },
  async revoke(secret, http) {
    await telegramCall(http, secret, "deleteWebhook");
  },
};

/** The next updates of a bot without a webhook: from after the last one kept. */
export async function pollTelegram(
  db: Database,
  connection: NativeConnection,
  secret: ConnectionSecret,
  http: typeof fetch,
) {
  const [last] = await db
    .select({ id: telegramUpdates.updateId })
    .from(telegramUpdates)
    .where(and(eq(telegramUpdates.connectionId, connection.id), sql`${telegramUpdates.updateId} is not null`))
    .orderBy(desc(telegramUpdates.updateId))
    .limit(1);
  const updates = await telegramCall<TgUpdate[]>(http, secret, "getUpdates", {
    offset: last?.id ? last.id + 1 : undefined,
    limit: 100,
    timeout: 0,
    allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post", "my_chat_member"],
  });
  return ingestTelegramUpdates(db, connection, updates);
}
