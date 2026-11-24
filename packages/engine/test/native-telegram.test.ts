import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  type ConnectorDeps,
  createApiKeyConnection,
  createNativeConnectorToolSource,
  createRoutine,
  handleTelegramWebhook,
  openConnectionSecret,
  pollTelegramBots,
  revokeAtProvider,
  type ToolContext,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { runContext } from "./mail-fixtures";
import { routineDeps } from "./routine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

const TOKEN = "123456:fake-fixture-bot-token";
const BOT = { id: 9001, is_bot: true, first_name: "Acme", username: "acme_bot" };

/** Telegram's Bot API, in memory: what each method was called with, and its answer. */
function fakeTelegram(answers: Record<string, (body: Record<string, unknown>) => unknown> = {}) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const [, token, method = ""] = /\/bot([^/]+)\/(\w+)$/.exec(String(url)) ?? [];
    const body: Record<string, unknown> =
      init?.body instanceof FormData
        ? Object.fromEntries([...(init.body as unknown as Iterable<[string, unknown]>)])
        : JSON.parse(String(init?.body ?? "{}"));
    calls.push({ method, body });
    if (token !== TOKEN)
      return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
    const answer = answers[method];
    if (answer) {
      const result = answer(body);
      if (result instanceof Response) return result;
      return Response.json({ ok: true, result });
    }
    if (method === "getMe") return Response.json({ ok: true, result: BOT });
    if (method === "sendMessage") {
      return Response.json({
        ok: true,
        result: { message_id: 77, chat: { id: body.chat_id, type: "private" }, date: 1 },
      });
    }
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;
  return { http, calls };
}

function deps(http: typeof fetch, publicUrl = "https://chat.example.com"): ConnectorDeps {
  return { db: f.db, keyWrappers: [f.keyWrapper], publicUrl, http, resolveHost: async () => ["93.184.216.34"] };
}

async function world(http: typeof fetch, publicUrl?: string) {
  f = await setup({
    toolSources: [
      { name: "native", tools: (ctx) => createNativeConnectorToolSource(deps(http, publicUrl)).tools(ctx) },
    ],
  });
  return runContext(f);
}

async function call(ctx: ToolContext, name: string, input: Record<string, unknown>) {
  const r = await f.tools?.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name, input });
  if (r?.type !== "result") throw new Error(`expected a result, got ${r?.type}`);
  return r.output;
}

const privateMessage = (updateId: number, text: string) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1,
    chat: { id: 5150, type: "private", first_name: "Ada" },
    from: { id: 5150, first_name: "Ada" },
    text,
  },
});

test("a bot's token connects it as @its_name and sets its webhook where the internet reaches the server", async () => {
  const tg = fakeTelegram();
  await world(tg.http);
  const row = await createApiKeyConnection(deps(tg.http), f.owner.id, f.org.id, {
    connector: "telegram",
    apiKey: TOKEN,
  });
  expect(row).toMatchObject({ accountLabel: "@acme_bot", accountId: "9001" });
  const hook = tg.calls.find((c) => c.method === "setWebhook");
  expect(hook?.body.url).toBe(`https://chat.example.com/api/webhooks/telegram/${row.id}`);
  const secret = await openConnectionSecret([f.keyWrapper], row);
  expect(secret?.webhookSecret).toBe(String(hook?.body.secret_token));
  await expect(
    createApiKeyConnection(deps(tg.http), f.owner.id, f.org.id, { connector: "telegram", apiKey: "999:not-the-token" }),
  ).rejects.toThrow("Telegram refused the bot's token");
  // Disconnecting takes the webhook off.
  expect(await revokeAtProvider(deps(tg.http), f.org.id, row.id)).toBe(true);
  expect(tg.calls.at(-1)?.method).toBe("deleteWebhook");
});

test("the webhook keeps what the bot heard, a message to it fires its routines once, a wrong secret is nobody", async () => {
  const tg = fakeTelegram();
  await world(tg.http);
  const row = await createApiKeyConnection(deps(tg.http), f.owner.id, f.org.id, {
    connector: "telegram",
    apiKey: TOKEN,
  });
  const secret = String(tg.calls.find((c) => c.method === "setWebhook")?.body.secret_token);
  await createRoutine(routineDeps(f), f.owner.id, f.org.id, {
    agentId: f.agent.id,
    prompt: "Answer people on Telegram.",
    target: { type: "channel", channelId: f.general.id },
    trigger: { type: "event", event: "telegram.message" },
  });
  const raw = JSON.stringify(privateMessage(1, "Oi, vocês abrem sábado?"));
  await expect(handleTelegramWebhook(deps(tg.http), row.id, "wrong", raw)).rejects.toThrow("No Telegram bot");
  expect(await handleTelegramWebhook(deps(tg.http), row.id, secret, raw)).toEqual({ fired: 1 });
  expect(await handleTelegramWebhook(deps(tg.http), row.id, secret, raw)).toEqual({ fired: 0 });
  // In a group, only what mentions or answers the bot is for it.
  const group = (id: number, text: string, entities: unknown[] = []) =>
    JSON.stringify({
      update_id: id,
      message: {
        message_id: id,
        date: 1,
        chat: { id: -100, type: "supergroup", title: "Acme" },
        from: { id: 1 },
        text,
        entities,
      },
    });
  expect(await handleTelegramWebhook(deps(tg.http), row.id, secret, group(2, "bom dia"))).toEqual({ fired: 0 });
  const mention = group(3, "@acme_bot qual o horário?", [{ type: "mention", offset: 0, length: 9 }]);
  expect(await handleTelegramWebhook(deps(tg.http), row.id, secret, mention)).toEqual({ fired: 1 });
  expect(await f.db.select().from(schema.telegramUpdates)).toHaveLength(3);
});

test("the tools: chats it heard, a chat's messages with its own sends, Telegram's limits in words", async () => {
  const tg = fakeTelegram();
  const ctx = await world(tg.http);
  const row = await createApiKeyConnection(deps(tg.http), f.owner.id, f.org.id, {
    connector: "telegram",
    apiKey: TOKEN,
  });
  const secret = String(tg.calls.find((c) => c.method === "setWebhook")?.body.secret_token);
  await handleTelegramWebhook(deps(tg.http), row.id, secret, JSON.stringify(privateMessage(1, "Oi")));
  expect((await call(ctx, "telegram_list_chats", {})).content).toContain(
    JSON.stringify([{ chat_id: "5150", type: "private", title: "Ada", admin: false }]),
  );
  const sent = await call(ctx, "telegram_send_message", { chat_id: "5150", text: "Abrimos sim, das 9 às 13h." });
  expect(sent.content).toBe("Sent (message 77).");
  const read = (await call(ctx, "telegram_read_messages", { chat_id: "5150" })).content;
  expect(read.indexOf('"from":"Ada","user_id":"5150","text":"Oi"')).toBeGreaterThan(-1);
  expect(read.indexOf('"from":"the bot","text":"Abrimos sim, das 9 às 13h."')).toBeGreaterThan(read.indexOf('"Oi"'));
  await f.close();

  const busy = fakeTelegram({
    sendMessage: () =>
      Response.json({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 12 } }),
  });
  const again = await world(busy.http);
  await createApiKeyConnection(deps(busy.http), f.owner.id, f.org.id, { connector: "telegram", apiKey: TOKEN });
  const limited = await call(again, "telegram_send_message", { chat_id: "5150", text: "oi" });
  expect(limited).toMatchObject({ isError: true, data: { code: "connector.rate_limited" } });
  expect(limited.content).toContain("Nothing was sent.");
});

test("a sensitive tool asks, and a token Telegram stops taking marks the bot to reconnect", async () => {
  const tg = fakeTelegram();
  const ctx = await world(tg.http);
  const row = await createApiKeyConnection(deps(tg.http), f.owner.id, f.org.id, {
    connector: "telegram",
    apiKey: TOKEN,
  });
  const ask = await f.tools?.invoke(ctx, {
    toolUseId: "tu_ban",
    name: "telegram_ban_member",
    input: {
      chat_id: "-100",
      user_id: 1,
      why: "This account posted the same casino link in the group five times today.",
    },
  });
  expect(ask?.type).toBe("approval");
  // The token was revoked in @BotFather: the next call says who fixes it.
  const revoked = fakeTelegram();
  await f.close();
  const ctx2 = await world((async (url: string | URL | Request, init?: RequestInit) =>
    String(url).includes("sendMessage")
      ? Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 })
      : revoked.http(url, init)) as typeof fetch);
  const bot = await createApiKeyConnection(deps(revoked.http), f.owner.id, f.org.id, {
    connector: "telegram",
    apiKey: TOKEN,
  });
  const out = await call(ctx2, "telegram_send_message", { chat_id: "5150", text: "oi" });
  expect(out).toMatchObject({ isError: true, data: { code: "connector.needs_reconnect" } });
  const [marked] = await f.db
    .select()
    .from(schema.connectorConnections)
    .where(eq(schema.connectorConnections.id, bot.id));
  expect(marked?.status).toBe("needs_reconnect");
  void row;
});

test("a server the internet doesn't reach polls its bots instead", async () => {
  const tg = fakeTelegram({ getUpdates: () => [privateMessage(10, "Olá")] });
  await world(tg.http, "http://localhost:3000");
  await createApiKeyConnection(deps(tg.http, "http://localhost:3000"), f.owner.id, f.org.id, {
    connector: "telegram",
    apiKey: TOKEN,
  });
  expect(tg.calls.some((c) => c.method === "setWebhook")).toBe(false);
  await pollTelegramBots(deps(tg.http, "http://localhost:3000"));
  expect(tg.calls.at(-1)?.method).toBe("getUpdates");
  const [kept] = await f.db.select().from(schema.telegramUpdates);
  expect(kept).toMatchObject({ updateId: 10, text: "Olá", chatId: "5150" });
});
