import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createFakeErrorReporter, createMemoryRateLimiter, EmailError } from "@agenteschat/adapters";
import { and, asc, type Database, eq, schema, sql } from "@agenteschat/db";
import {
  type EmailTemplate,
  emailArtAt,
  REPLIES_PER_DAY,
  REPLIES_PER_REQUEST,
  REPLY_TEMPLATES,
  REPLY_TEXT_MAX,
  renderEmail,
  setRestrictionNotices,
  sweepSupportRequests,
} from "@agenteschat/engine";
import { createLogger } from "../src/logger";
import { createOperatorApp, type OperatorDeps } from "../src/operator/app";
import { browser, createTestServer, joinByInvitation, ORIGIN, seedOrg, signUp, type TestServer } from "./harness";

/**
 * The operator answers a member's support request (ADR 0056): an email to the address of the request's account, with
 * one of core's sentences or the operator's own words. The reply is on record with the email's job, the words are in
 * the email alone, and nothing in them is anything but text.
 */

const TOKEN = "operator-test-token-".padEnd(48, "x");
const READ = "operator-read-token-".padEnd(48, "x");
const REVEAL = "operator-reveal-token-".padEnd(48, "x");
const UNKNOWN = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const SUPPORT = "help@example.com";
const CANARY = "canary-reply-words";
const SUBJECT = "An answer to your request for help";
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

/** Core's four sentences as someone who reads pt-BR gets them. */
const IN_PORTUGUESE: Record<(typeof REPLY_TEMPLATES)[number], string> = {
  received: "Recebemos seu pedido e já estamos vendo.",
  need_more: "Precisamos saber mais para ajudar: o que você estava fazendo, o que esperava e o que aconteceu.",
  resolved: "O que você relatou foi corrigido.",
  handed_over: "Uma pessoa já está com o seu pedido e vai responder a você.",
};

type Refusal = { error: { code: string; message: string } };

let t: TestServer;
let db: Database;
let deps: OperatorDeps;
let app: ReturnType<typeof createOperatorApp>;
const w = {} as Record<"orgId" | "otherOrgId" | "ownerId" | "biaId" | "zedId" | "messageId", string>;
const requests = {} as Record<
  "owner" | "bia" | "byHand" | "sixWeeks" | "old" | "left" | "blocked" | "leaving" | "foreign" | "foreignOld",
  string
>;

const path = (orgId = w.orgId) => `/api/operator/v1/reveal/orgs/${orgId}`;
const post = (url: string, json: unknown, options: { token?: string | null; on?: typeof app } = {}) =>
  (options.on ?? app).request(url, {
    method: "POST",
    headers: {
      ...(options.token === null ? {} : { authorization: `Bearer ${options.token ?? REVEAL}` }),
      "content-type": "application/json",
    },
    body: JSON.stringify(json),
  });
const call = (json: unknown, options: Parameters<typeof post>[2] & { orgId?: string } = {}) =>
  post(`${path(options.orgId)}/replies`, json, options);
/** A read through the door, of a message its member reads. */
const read = (options?: Parameters<typeof post>[2], over: Record<string, unknown> = {}) =>
  post(
    path(),
    {
      kind: "message",
      id: w.messageId,
      field: "text",
      purpose: "member_request",
      requestId: requests.owner,
      reason: "Check what the member said the export did before it stopped",
      operator: "call:7",
      assistedByAi: true,
      ...over,
    },
    options,
  );
const reply = (requestId: string, said: { template?: string; text?: string }, over: Record<string, unknown> = {}) => ({
  requestId,
  operator: "call:7",
  assistedByAi: true,
  ...said,
  ...over,
});
/** The answer's status and, for a refusal, its code. */
async function outcome(res: Response | Promise<Response>) {
  const answer = await res;
  return answer.status === 200 ? 200 : [answer.status, ((await answer.json()) as Refusal).error.code];
}
const events = () =>
  db
    .select()
    .from(schema.operatorEvents)
    .where(eq(schema.operatorEvents.type, "support.replied"))
    .orderBy(asc(schema.operatorEvents.createdAt), asc(schema.operatorEvents.id));
const auditLines = () =>
  db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "operator.support_replied"))
    .orderBy(asc(schema.auditLog.createdAt), asc(schema.auditLog.id));
const jobs = () =>
  db
    .select()
    .from(schema.outbox)
    .where(
      and(eq(schema.outbox.kind, "email.send"), sql`${schema.outbox.payload}#>>'{template,kind}' = 'support_reply'`),
    )
    .orderBy(asc(schema.outbox.createdAt), asc(schema.outbox.id));
/** How much a call left behind. */
const written = async () => ({
  events: (await events()).length,
  audit: (await auditLines()).length,
  jobs: (await jobs()).length,
});
const NOTHING = { events: 0, audit: 0, jobs: 0 };
/** The replies the server sent, once its jobs ran. */
async function mails() {
  await t.drain();
  return t.email.sent.filter((m) => m.tags?.some((tag) => tag.value === "support_reply"));
}
/** A text as it reads, without the hair spaces that keep a mail app from linking it. */
const shown = (text: string) => text.replaceAll("\u200a", "");
/** The HTML part's words as they read, without its tags: stripped until none is left, so two can't leave a third. */
const words = (html: string) => {
  let text = shown(html);
  for (let before = ""; before !== text; ) {
    before = text;
    text = text.replace(/<[^>]+>/g, "");
  }
  return text;
};
const forget = async () => {
  await db.delete(schema.operatorEvents);
  await db.delete(schema.auditLog).where(eq(schema.auditLog.action, "operator.support_replied"));
  await db.delete(schema.outbox).where(eq(schema.outbox.kind, "email.send"));
  t.email.sent.length = 0;
};
/** Everything the server keeps where a reply's words could rest. */
const kept = async () =>
  JSON.stringify([
    await db.select().from(schema.operatorEvents),
    await db.select().from(schema.auditLog),
    await db.select().from(schema.outbox),
  ]);

beforeAll(async () => {
  t = await createTestServer({
    env: {
      OPERATOR_API_TOKEN: TOKEN,
      OPERATOR_API_READ_TOKEN: READ,
      OPERATOR_API_REVEAL_TOKEN: REVEAL,
      SUPPORT_EMAIL: SUPPORT,
      ALLOW_SIGNUP: "true",
    },
  });
  db = t.db;
  // The tests' own door counts no minute: the one about the limits brings a clock.
  const unlimited = {
    consume: async () => ({ allowed: true, remaining: 1, resetAt: new Date(0) }),
    release: async () => {},
  };
  deps = { db, config: t.config, version: "test", log: createLogger("error"), rateLimiter: unlimited, emails: true };
  app = createOperatorApp(deps, TOKEN, READ, REVEAL);

  const userId = async (email: string) =>
    (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)))[0]?.id ?? "";
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const org = await seedOrg(owner);
  const { orgId } = org;
  for (const name of ["bia", "caio", "dora", "edu"]) await joinByInvitation(t, owner, orgId, `${name}@example.com`);
  const [ownerId, biaId, caioId, doraId, eduId] = await Promise.all(
    ["owner", "bia", "caio", "dora", "edu"].map((name) => userId(`${name}@example.com`)),
  );
  const zed = browser(t);
  await signUp(zed, "zed@example.com");
  const other = await seedOrg(zed);
  const [said] = await db
    .insert(schema.messages)
    .values({
      orgId,
      channelId: org.channelId,
      authorType: "person",
      authorUserId: ownerId,
      body: "The export stopped",
    })
    .returning({ id: schema.messages.id });
  Object.assign(w, {
    orgId,
    otherOrgId: other.orgId,
    ownerId,
    biaId,
    zedId: await userId("zed@example.com"),
    messageId: said?.id,
  });

  const request = async (
    userId: string | undefined,
    source: string,
    over: Partial<typeof schema.supportRequests.$inferInsert> = {},
  ) =>
    (
      await db
        .insert(schema.supportRequests)
        .values({ orgId, userId: userId ?? "", source, text: "The export stopped halfway", ...over })
        .returning({ id: schema.supportRequests.id })
    )[0]?.id ?? "";
  requests.owner = await request(ownerId, "form");
  requests.bia = await request(biaId, "offer");
  requests.byHand = await request(ownerId, "operator", { ref: "record-1", text: null });
  requests.sixWeeks = await request(ownerId, "form", { createdAt: ago(45 * DAY) });
  requests.old = await request(ownerId, "form", { createdAt: ago(91 * DAY), text: null });
  requests.left = await request(caioId, "form");
  requests.blocked = await request(doraId, "form");
  requests.leaving = await request(eduId, "email", { ref: "mail-1" });
  requests.foreign = await request(w.zedId, "form", { orgId: other.orgId });
  requests.foreignOld = await request(w.zedId, "form", { orgId: other.orgId, createdAt: ago(91 * DAY) });

  // After they asked: the owner reads English and Bia pt-BR, Caio left, Dora was blocked and Edu deleted his account.
  await db
    .update(schema.users)
    .set({ locale: "en" })
    .where(eq(schema.users.id, ownerId ?? ""));
  await db
    .update(schema.users)
    .set({ locale: "pt-BR" })
    .where(eq(schema.users.id, biaId ?? ""));
  await db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, caioId ?? ""));
  await db
    .update(schema.users)
    .set({ blockedAt: new Date() })
    .where(eq(schema.users.id, doraId ?? ""));
  await db
    .update(schema.users)
    .set({ deletionDueAt: new Date(Date.now() + 7 * DAY) })
    .where(eq(schema.users.id, eduId ?? ""));
  await t.drain();
});

afterAll(() => t.close());
// Each test starts with nothing sent: a request's replies and the day's are the events themselves.
beforeEach(() => forget());

test("the tokens: the reveal token is taken; no token, the read token and the full one are refused as the door refuses them", async () => {
  const good = reply(requests.owner, { template: "received" });
  for (const token of [null, "wrong", READ, TOKEN]) {
    const refused = await call(good, { token });
    const door = await read({ token });
    expect({ token, status: refused.status }).toEqual({ token, status: token === READ || token === TOKEN ? 403 : 401 });
    expect({ token, answer: await refused.json() }).toEqual({ token, answer: await door.json() });
  }
  const get = await app.request(`${path()}/replies`, { headers: { authorization: `Bearer ${REVEAL}` } });
  expect(get.status).toBe(403);
  // A server that set no reveal token: whoever asks, nothing is sent and nothing is written.
  const closed = createOperatorApp(deps, TOKEN, READ);
  for (const token of [TOKEN, READ, REVEAL, "wrong"]) {
    expect({ token, answer: await outcome(call(good, { token, on: closed })) }).toEqual({
      token,
      answer: [403, "forbidden"],
    });
  }
  expect(await written()).toEqual(NOTHING);
  expect(await outcome(call(good))).toBe(200);
  expect(await written()).toEqual({ events: 1, audit: 1, jobs: 1 });
});

test("each sentence and a free text reach the outbox for the account's address as it is now, in the account's language", async () => {
  for (const template of REPLY_TEMPLATES) {
    await forget();
    const res = await call(reply(requests.bia, { template }, { assistedByAi: false }));
    expect([res.status, await res.json()]).toEqual([200, { requestId: requests.bia, replies: 1 }]);
    expect((await jobs()).map((job) => [job.orgId, job.payload])).toEqual([
      [
        w.orgId,
        {
          key: expect.stringMatching(/^support-reply:[0-9a-f-]{36}$/),
          to: ["bia@example.com"],
          template: {
            kind: "support_reply",
            locale: "pt-BR",
            reply: template,
            assistedByAi: false,
            support: SUPPORT,
            url: ORIGIN,
          },
        },
      ],
    ]);
    const sent = await mails();
    expect(sent.map((m) => [m.to, m.subject])).toEqual([[["bia@example.com"], "Uma resposta ao seu pedido de ajuda"]]);
    expect(sent[0]?.text).toContain(`\n\n${IN_PORTUGUESE[template]}\n\n`);
    expect(sent[0]?.html).toContain('<html lang="pt-BR"');
    // Who answers and how to answer back, and no word of an AI assistant when none wrote it.
    expect(sent[0]?.text).toContain("\n\nRespondido por quem cuida do servidor do agentes.chat em localhost:3000.\n\n");
    expect(sent[0]?.text).toContain(`\n\nPara responder, escreva para ${SUPPORT}.\n\n`);
    expect(sent[0]?.text).not.toContain("assistente de IA");
  }

  // The address is the account's when the reply is made, whatever it was when the request was.
  await forget();
  await db.update(schema.users).set({ email: "bia.now@example.com" }).where(eq(schema.users.id, w.biaId));
  try {
    expect(await outcome(call(reply(requests.bia, { template: "resolved" })))).toBe(200);
    expect((await mails()).map((m) => m.to)).toEqual([["bia.now@example.com"]]);
  } finally {
    await db.update(schema.users).set({ email: "bia@example.com" }).where(eq(schema.users.id, w.biaId));
  }

  // A free text, to someone who reads English: each line a paragraph, then who answers, that an AI assistant wrote
  // it, and where to write back.
  await forget();
  const text = "The export stopped at the size limit.\nIt works again since this morning.";
  const res = await call(reply(requests.owner, { text }));
  expect([res.status, await res.json()]).toEqual([200, { requestId: requests.owner, replies: 1 }]);
  const [job] = await jobs();
  expect(job?.payload).toEqual({
    key: expect.stringMatching(/^support-reply:/),
    to: ["owner@example.com"],
    template: { kind: "support_reply", locale: "en", text, assistedByAi: true, support: SUPPORT, url: ORIGIN },
  });
  const [mail] = await mails();
  expect([mail?.to, mail?.subject]).toEqual([["owner@example.com"], SUBJECT]);
  expect(mail?.text).toBe(
    [
      SUBJECT,
      "The export stopped at the size limit.",
      "It works again since this morning.",
      "Answered by the people who run the agentes.chat server at localhost:3000.",
      "An AI assistant wrote this answer.",
      `To answer, write to ${SUPPORT}.`,
      "You got this email because you asked for help on agentes.chat.\nSent by the agentes.chat server at localhost:3000.\n",
    ].join("\n\n"),
  );
  expect(mail?.html).toContain(`<a class="ln-m" href="mailto:${SUPPORT}"`);
  // On agentes.chat's own server the same job names agentes.chat.
  const onCloud = renderEmail(job?.payload.template as EmailTemplate, emailArtAt("https://agentes.chat"));
  expect(onCloud.text).toContain("\n\nAnswered by agentes.chat.\n\n");

  // A server with no address to write to names none.
  await forget();
  const bare = createOperatorApp({ ...deps, config: { ...t.config, SUPPORT_EMAIL: undefined } }, TOKEN, READ, REVEAL);
  expect(await outcome(call(reply(requests.owner, { text }, { assistedByAi: false }), { on: bare }))).toBe(200);
  const [plain] = await mails();
  expect(plain?.text).toBe(
    [
      SUBJECT,
      "The export stopped at the size limit.",
      "It works again since this morning.",
      "Answered by the people who run the agentes.chat server at localhost:3000.",
      "You got this email because you asked for help on agentes.chat.\nSent by the agentes.chat server at localhost:3000.\n",
    ].join("\n\n"),
  );
  expect(plain?.html).not.toContain("mailto:");
});

test("a reply reads nothing: a request with no words kept, and one past the 30 days in which it opens content, are answered", async () => {
  expect(await outcome(call(reply(requests.byHand, { template: "handed_over" })))).toBe(200);
  expect(await outcome(call(reply(requests.sixWeeks, { template: "resolved" })))).toBe(200);
  expect((await mails()).map((m) => m.to)).toEqual([["owner@example.com"], ["owner@example.com"]]);
  // The same request opens no content any more.
  expect(await outcome(read({}, { requestId: requests.sixWeeks }))).toEqual([403, "reveal.no_request"]);
});

test("what is refused, each with its code, and a refused call writes no event, no audit line and no job", async () => {
  const sentence = { template: "received" };
  // Another workspace's request, nobody's and a workspace nobody has are one answer, and it is the door's.
  const doorMissing = await read({}, { id: UNKNOWN });
  const notFound = await doorMissing.json();
  expect(doorMissing.status).toBe(404);
  for (const [requestId, orgId] of [
    [requests.foreign, w.orgId],
    [requests.foreignOld, w.orgId],
    [UNKNOWN, w.orgId],
    [requests.owner, w.otherOrgId],
    [requests.owner, UNKNOWN],
  ] as const) {
    const res = await call(reply(requestId, sentence), { orgId });
    expect({ requestId, orgId, status: res.status, answer: await res.json() }).toEqual({
      requestId,
      orgId,
      status: 404,
      answer: notFound,
    });
  }

  const refusals: [what: string, json: unknown, answer: [number, string]][] = [
    ["its words are no longer kept", reply(requests.old, sentence), [403, "reveal.request_old"]],
    ["its member left", reply(requests.left, sentence), [403, "reveal.requester"]],
    ["its member is blocked", reply(requests.blocked, sentence), [403, "reveal.requester"]],
    ["its member's account is being deleted", reply(requests.leaving, sentence), [403, "reveal.requester"]],
    ["both", reply(requests.owner, { template: "received", text: "And this." }), [400, "invalid_request"]],
    ["neither", reply(requests.owner, {}), [400, "invalid_request"]],
    ["a sentence core does not have", reply(requests.owner, { template: "refunded" }), [400, "invalid_request"]],
    ["an empty text", reply(requests.owner, { text: "" }), [400, "invalid_request"]],
    ["a text of spaces", reply(requests.owner, { text: " \n\t " }), [400, "invalid_request"]],
    ["a text nobody can see", reply(requests.owner, { text: "\u200b\u2060\ufeff" }), [400, "invalid_request"]],
    ["a text too long", reply(requests.owner, { text: "x".repeat(REPLY_TEXT_MAX + 1) }), [400, "invalid_request"]],
    ["an address", reply(requests.owner, sentence, { to: "mallory@example.com" }), [400, "invalid_request"]],
    ["a name", reply(requests.owner, sentence, { name: "Mallory" }), [400, "invalid_request"]],
    ["a subject", reply(requests.owner, sentence, { subject: "Not ours" }), [400, "invalid_request"]],
    ["nobody who answers", reply(requests.owner, sentence, { operator: " " }), [400, "invalid_request"]],
    [
      "no word on an AI assistant",
      reply(requests.owner, sentence, { assistedByAi: undefined }),
      [400, "invalid_request"],
    ],
  ];
  for (const [what, json, answer] of refusals) {
    expect({ what, answer: await outcome(call(json)) }).toEqual({ what, answer });
  }
  // A server that sends no email would only write the reply to its log.
  const silent = createOperatorApp({ ...deps, emails: false }, TOKEN, READ, REVEAL);
  expect(await outcome(call(reply(requests.owner, sentence), { on: silent }))).toEqual([409, "reveal.no_email"]);
  expect(await written()).toEqual(NOTHING);
});

test("the record: an event in the operator's feed and a line in the workspace's audit log, with what was sent and never its words", async () => {
  const text = `${CANARY}: the export works again.\nTry it once more.`;
  expect(await outcome(call(reply(requests.bia, { text }, { operator: "agent:nine" })))).toBe(200);
  expect(await outcome(call(reply(requests.owner, { template: "need_more" }, { assistedByAi: false })))).toBe(200);

  expect((await events()).map((e) => [e.orgId, e.userId, e.data])).toEqual([
    [
      w.orgId,
      w.biaId,
      { requestId: requests.bia, template: "text", chars: text.length, assistedByAi: true, operator: "agent:nine" },
    ],
    [
      w.orgId,
      w.ownerId,
      { requestId: requests.owner, template: "need_more", chars: 0, assistedByAi: false, operator: "call:7" },
    ],
  ]);
  const lines = (await auditLines()).map((e) => [
    [e.orgId, e.actorType, e.actorId, e.targetType, e.targetId, e.onBehalfOfUserId],
    e.details,
  ]);
  expect(lines).toEqual([
    [
      [w.orgId, "system", null, "support_request", requests.bia, w.biaId],
      { template: "text", chars: text.length, assistedByAi: true },
    ],
    [
      [w.orgId, "system", null, "support_request", requests.owner, w.ownerId],
      { template: "need_more", chars: 0, assistedByAi: false },
    ],
  ]);
  expect(JSON.stringify([await events(), await auditLines()])).not.toContain("canary");

  // On agentes.chat's own server the line says so, for the apps to name who answered.
  setRestrictionNotices("https://agentes.chat");
  try {
    expect(await outcome(call(reply(requests.byHand, { template: "received" })))).toBe(200);
  } finally {
    setRestrictionNotices(ORIGIN);
  }
  expect((await auditLines()).at(-1)?.details).toEqual({
    template: "received",
    chars: 0,
    assistedByAi: true,
    cloud: true,
  });
});

test("the record and the email's job commit together: a job that can't be queued leaves no record, and no word in a log line or an error report", async () => {
  const lines: string[] = [];
  const print = console.error;
  console.error = (line: unknown) => void lines.push(String(line));
  const errors = createFakeErrorReporter();
  const on = createOperatorApp({ ...deps, log: createLogger("error", errors) }, TOKEN, READ, REVEAL);
  await db.execute(
    sql`create function refuse_jobs() returns trigger language plpgsql as $$ begin raise exception 'the queue is down'; end $$`,
  );
  await db.execute(sql`create trigger refuse_jobs before insert on outbox for each row execute function refuse_jobs()`);
  try {
    const res = await call(reply(requests.owner, { text: `${CANARY} that must go nowhere` }), { on });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("canary");
  } finally {
    console.error = print;
    await db.execute(sql`drop trigger refuse_jobs on outbox`);
    await db.execute(sql`drop function refuse_jobs()`);
  }
  // The record was written first, and went with the job that failed after it.
  expect(await written()).toEqual(NOTHING);
  expect(lines.filter((line) => line.includes("unhandled error"))).toHaveLength(1);
  expect(lines.join("\n")).not.toContain("canary");
  expect(errors.reports).toHaveLength(1);
  expect(JSON.stringify(errors.reports.map((r) => [String(r.error), (r.error as Error).stack, r.tags]))).not.toContain(
    "canary",
  );
  // The queue back, the same reply goes out.
  expect(await outcome(call(reply(requests.owner, { text: "It works again." })))).toBe(200);
  expect(await written()).toEqual({ events: 1, audit: 1, jobs: 1 });
});

test("the limits, counted from the events: a fourth reply to one request, the server's sixty-first of a day, and the door's minute", async () => {
  const sentence = { template: "received" };
  for (let n = 1; n <= REPLIES_PER_REQUEST; n++) {
    const res = await call(reply(requests.owner, sentence));
    expect([res.status, await res.json()]).toEqual([200, { requestId: requests.owner, replies: n }]);
  }
  expect(await outcome(call(reply(requests.owner, { text: "A fourth." })))).toEqual([429, "reveal.limit_request"]);
  expect(await written()).toEqual({ events: 3, audit: 3, jobs: 3 });
  // Another request of the same member has its own three, and so has another member's.
  expect(await outcome(call(reply(requests.byHand, sentence)))).toBe(200);
  expect(await outcome(call(reply(requests.bia, sentence)))).toBe(200);
  // Counted from the events, so a new process starts where the last one stopped.
  const [first] = await events();
  await db.delete(schema.operatorEvents).where(eq(schema.operatorEvents.id, first?.id ?? ""));
  expect(await outcome(call(reply(requests.owner, sentence)))).toBe(200);
  expect(await outcome(call(reply(requests.owner, sentence)))).toEqual([429, "reveal.limit_request"]);

  // The day is the whole server's: replies to any workspace count, and what the door read does not.
  await forget();
  const elsewhere = { type: "support.replied", orgId: w.otherOrgId, userId: w.zedId, data: { requestId: UNKNOWN } };
  await db
    .insert(schema.operatorEvents)
    .values([
      ...Array.from({ length: REPLIES_PER_DAY - 1 }, () => elsewhere),
      ...Array.from({ length: REPLIES_PER_DAY }, () => ({ ...elsewhere, type: "content.viewed" })),
    ]);
  expect(await outcome(call(reply(requests.owner, sentence)))).toBe(200);
  expect(await outcome(call(reply(requests.bia, sentence)))).toEqual([429, "reveal.limit_day"]);
  expect(await outcome(call(reply(requests.foreign, sentence), { orgId: w.otherOrgId }))).toEqual([
    429,
    "reveal.limit_day",
  ]);
  expect(await written()).toEqual({ events: REPLIES_PER_DAY, audit: 1, jobs: 1 });
  // Yesterday's are past.
  await db
    .update(schema.operatorEvents)
    .set({ createdAt: ago(DAY + HOUR) })
    .where(eq(schema.operatorEvents.orgId, w.otherOrgId));
  expect(await outcome(call(reply(requests.bia, sentence)))).toBe(200);

  // The door's 30 calls a minute are one count for a read and a reply, refused ones included.
  await forget();
  let now = Date.now();
  const on = createOperatorApp({ ...deps, rateLimiter: createMemoryRateLimiter(() => now) }, TOKEN, READ, REVEAL);
  for (let n = 0; n < 14; n++) expect(await outcome(read({ on }))).toBe(200);
  for (let n = 0; n < 15; n++)
    expect(await outcome(call(reply(UNKNOWN, sentence), { on }))).toEqual([404, "not_found"]);
  expect(await outcome(call(reply(requests.owner, sentence), { on }))).toBe(200);
  expect(await outcome(call(reply(requests.owner, sentence), { on }))).toEqual([429, "reveal.limit_minute"]);
  expect(await outcome(read({ on }))).toEqual([429, "reveal.limit_minute"]);
  now += 61_000;
  expect(await outcome(call(reply(requests.owner, sentence), { on }))).toBe(200);
});

test("a free text is another party's words: text in both parts, nothing in it a link, markup or a header", async () => {
  const send = async (text: string) => {
    await forget();
    expect(await outcome(call(reply(requests.owner, { text })))).toBe(200);
    const [mail, ...more] = await mails();
    if (!mail || more.length > 0) throw new Error("one reply, one email");
    return mail;
  };
  // Every link the email holds is the server's own: its logo's, and the address to write back to.
  const links = (html: string) => [...new Set([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]))].sort();
  const OURS = [ORIGIN, `mailto:${SUPPORT}`].sort();

  // HTML is escaped in the HTML part, and stays the characters it is in the text part.
  const markup =
    '<script>alert("x")</script><a href="https://evil.example.com/a">click</a><img src=x onerror=alert(1)>';
  let mail = await send(markup);
  expect(shown(mail.html)).toContain(
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;a href=&quot;https://evil.example.com/a&quot;&gt;click",
  );
  for (const tag of ["<script", "<img src", '<a href="https://evil', "onerror=alert(1)>"]) {
    expect({ tag, there: mail.html.includes(tag) }).toEqual({ tag, there: false });
  }
  expect(shown(mail.text)).toContain(`\n\n${markup}\n\n`);
  expect(links(mail.html)).toEqual(OURS);

  // A web address, a bare host and an email address are text no mail app links, in both parts.
  const linked =
    "Sign in again at https://evil.example.com/login or www.evil.example.com, or write to mallory@example.com";
  mail = await send(linked);
  for (const part of [mail.html, mail.text]) {
    for (const address of ["https://evil", "evil.example.com", "www.evil", "mallory@example.com"]) {
      expect({ address, there: part.includes(address) }).toEqual({ address, there: false });
    }
    expect(words(part)).toContain(linked);
  }
  expect(links(mail.html)).toEqual(OURS);

  // Markdown is not rendered: its marks arrive as typed.
  mail = await send("**bold** and [a page](https://evil.example.com)\n# A title\n- an item\n`code`");
  expect(shown(mail.text)).toContain(
    "\n\n**bold** and [a page](https://evil.example.com)\n\n# A title\n\n- an item\n\n`code`\n\n",
  );
  expect(words(mail.html)).toContain("**bold** and [a page](https://evil.example.com)");
  expect(mail.html).not.toMatch(/<(strong|em|code|li|h[2-6])\b|<b\b[^>]*>bold/);
  expect(links(mail.html)).toEqual(OURS);

  // A header line is a line of the body: the email goes to the account alone, under core's subject.
  const headers =
    "Thanks.\r\nBcc: mallory@example.com\r\nSubject: Not ours\r\nTo: mallory@example.com\r\n\r\nA new body";
  mail = await send(headers);
  expect(Object.keys(mail).sort()).toEqual(["html", "idempotencyKey", "subject", "tags", "text", "to"]);
  expect([mail.to, mail.subject]).toEqual([["owner@example.com"], SUBJECT]);
  expect(shown(mail.text)).toStartWith(
    `${SUBJECT}\n\nThanks.\n\nBcc: mallory@example.com\n\nSubject: Not ours\n\nTo: mallory@example.com\n\nA new body\n\n`,
  );
  expect((await jobs()).map((job) => job.payload.to)).toEqual([["owner@example.com"]]);

  // As long as it may be, it arrives whole; one character more is refused (the refusals' test).
  const long = `${"lorem ipsum ".repeat(166)}dolor si`;
  expect(long.length).toBe(REPLY_TEXT_MAX);
  mail = await send(long);
  expect(shown(mail.text)).toContain(`\n\n${long}\n\n`);
  expect((await events()).map((e) => e.data.chars)).toEqual([REPLY_TEXT_MAX]);

  // A character the database can't hold is left out of the reply and of who answers, not a failure.
  await forget();
  const res = await call(reply(requests.owner, { text: "It works\u0000 again." }, { operator: "call\u0000:8" }));
  expect(res.status).toBe(200);
  expect((await events()).map((e) => [e.data.operator, e.data.chars])).toEqual([["call:8", 15]]);
  expect((await mails()).map((m) => m.text.includes("\n\nIt works again.\n\n"))).toEqual([true]);
});

test("a reply's words are in its email and nowhere else: no event, audit line, log line, error report or answer, and not in its job once it is sent or given up", async () => {
  const text = `${CANARY}: start the export again.`;
  const lines: string[] = [];
  const own = { log: console.log, error: console.error };
  console.log = console.error = (line: unknown) => void lines.push(String(line));
  const errors = createFakeErrorReporter();
  const on = createOperatorApp({ ...deps, log: createLogger("debug", errors) }, TOKEN, READ, REVEAL);
  const send = t.email.send;
  try {
    const res = await call(reply(requests.owner, { text }), { on });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("canary");
    // Until the email is sent its job holds them, and nothing else does.
    expect((await jobs()).map((job) => (job.payload.template as { text?: string }).text)).toEqual([text]);
    expect(JSON.stringify([await events(), await auditLines()])).not.toContain("canary");

    // Sent: the email holds them, and the job keeps whom it went to and which email it was.
    const [mail] = await mails();
    expect(mail?.text).toContain(`\n\n${text}\n\n`);
    expect((await jobs()).map((job) => [job.status, job.payload])).toEqual([
      [
        "done",
        {
          key: expect.stringMatching(/^support-reply:/),
          to: ["owner@example.com"],
          template: { kind: "support_reply", locale: "en", assistedByAi: true, support: SUPPORT, url: ORIGIN },
        },
      ],
    ]);
    expect(await kept()).not.toContain("canary");
    // Its job run again (a worker that lost it after sending) has nothing to send, and sends nothing.
    await db
      .update(schema.outbox)
      .set({ status: "pending", completedAt: null, nextAttemptAt: new Date(0) })
      .where(eq(schema.outbox.kind, "email.send"));
    t.email.sent.length = 0;
    expect(await mails()).toEqual([]);
    expect((await jobs()).map((job) => job.status)).toEqual(["done"]);

    // A try that failed for now keeps them for the next one, which sends them.
    await forget();
    t.email.send = async () => {
      throw new EmailError("the provider is down", true, 503);
    };
    expect(await outcome(call(reply(requests.owner, { text }), { on }))).toBe(200);
    expect(await mails()).toEqual([]);
    expect((await jobs()).map((job) => [job.status, (job.payload.template as { text?: string }).text])).toEqual([
      ["pending", text],
    ]);
    t.email.send = send;
    await db
      .update(schema.outbox)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.outbox.kind, "email.send"));
    expect((await mails()).map((m) => m.text.includes(text))).toEqual([true]);
    expect(await kept()).not.toContain("canary");

    // Given up: a provider's refusal no retry changes takes the words with it.
    await forget();
    t.email.send = async () => {
      throw new EmailError("the provider refused the email (422 invalid_to)", false, 422);
    };
    expect(await outcome(call(reply(requests.owner, { text }), { on }))).toBe(200);
    expect(await mails()).toEqual([]);
    expect((await jobs()).map((job) => [job.status, job.lastError])).toEqual([
      ["failed", "the provider refused the email (422 invalid_to)"],
    ]);
    expect(await kept()).not.toContain("canary");

    // A worker that died on the job never got to forget them: the daily sweep does, for finished jobs alone.
    await forget();
    t.email.send = send;
    expect(await outcome(call(reply(requests.owner, { text }), { on }))).toBe(200);
    expect(await outcome(call(reply(requests.byHand, { text }), { on }))).toBe(200);
    const [died, waiting] = await jobs();
    await db
      .update(schema.outbox)
      .set({ status: "failed" })
      .where(eq(schema.outbox.id, died?.id ?? ""));
    await sweepSupportRequests(db);
    expect((await jobs()).map((job) => [job.id, (job.payload.template as { text?: string }).text])).toEqual([
      [died?.id, undefined],
      [waiting?.id, text],
    ]);
  } finally {
    t.email.send = send;
    console.log = own.log;
    console.error = own.error;
  }
  expect(lines.join("\n")).not.toContain("canary");
  expect(JSON.stringify(errors.reports.map((r) => [String(r.error), (r.error as Error).stack, r.tags]))).not.toContain(
    "canary",
  );
});
