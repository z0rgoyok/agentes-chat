import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createFakeErrorReporter, createMemoryRateLimiter } from "@agenteschat/adapters";
import { testConfig } from "@agenteschat/config";
import { and, asc, type Database, desc, eq, schema } from "@agenteschat/db";
import {
  addRunStep,
  CONFIDENTIAL_STUB,
  DISCLOSURE_MAX_COUNT,
  DISCLOSURE_MAX_DAYS,
  markThreadConfidential,
  REVEAL_FIELDS,
  REVEAL_PER_WORKSPACE_DAY,
  REVEAL_UNTOLD_PER_DAY,
  routineRoomKey,
  setRestrictionNotices,
} from "@agenteschat/engine";
import { createLogger } from "../src/logger";
import { createOperatorApp, type OperatorDeps } from "../src/operator/app";
import { poison } from "./canary";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";
import { SECRET_SHAPES, shownIn, UNOPENED } from "./secret-shapes";

/**
 * The operator API's reveal door (ADR 0056): one field of one record, with a reason, for a member who asked for
 * help or to diagnose a run that failed or got stuck. What opens is what the proof opens and no more; the read is
 * on record before the text is read; a workspace that nobody reads this way sees nothing change. And its third
 * purpose, a safety review: no proof, a cap for the whole instance, no audit entry at the time, and the route by
 * which the operator tells the workspace afterwards.
 */

const TOKEN = "operator-test-token-".padEnd(48, "x");
const READ = "operator-read-token-".padEnd(48, "x");
const REVEAL = "operator-reveal-token-".padEnd(48, "x");
const UNKNOWN = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const REASON = "Check whether the two approval requests asked for the same command";
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

type Answer = { kind: string; id: string; field: string; text: string; chars: number; offset: number; more: boolean };
type Refusal = { error: { code: string; message: string } };

let t: TestServer;
let db: Database;
let deps: OperatorDeps;
let app: ReturnType<typeof createOperatorApp>;
/** Everything the tests name: ids of people, places and records of the workspace, and of another one. */
const w = {} as Record<
  | "orgId"
  | "otherOrgId"
  | "ownerId"
  | "biaId"
  | "adaId"
  | "caioId"
  | "devId"
  | "botId"
  | "generalId"
  | "secretId"
  | "dmId"
  | "goneId"
  | "roomId"
  | "connectionId"
  | "routineId"
  | "dmRoutineId"
  | "taskId"
  | "goneTaskId"
  | "sealedTaskId"
  | "againTaskId",
  string
>;
const messages = {} as Record<"asked" | "written" | "other" | "secret" | "dm" | "deleted" | "gone" | "foreign", string>;
const runs = {} as Record<
  | "failed"
  | "others"
  | "running"
  | "fresh"
  | "onPlan"
  | "onPerson"
  | "onApproval"
  | "recovered"
  | "clean"
  | "old"
  | "older"
  | "direct"
  | "keys"
  | "gone"
  | "room"
  | "parked"
  | "dmRoom"
  | "sealed"
  | "again"
  | "foreign",
  string
>;
const requests = {} as Record<
  "owner" | "bia" | "ada" | "byHand" | "stale" | "left" | "tenDays" | "yesterday" | "before" | "foreign",
  string
>;

/** The message each run answers. */
const asking = new Map<string, string>();

const call = (json: unknown, options: { token?: string; orgId?: string; on?: typeof app } = {}) =>
  (options.on ?? app).request(`/api/operator/v1/reveal/orgs/${options.orgId ?? w.orgId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${options.token ?? REVEAL}`, "content-type": "application/json" },
    body: JSON.stringify(json),
  });
const ask = (kind: string, id: string, field: string, proof: Record<string, unknown>) => ({
  kind,
  id,
  field,
  reason: REASON,
  operator: "call:7",
  assistedByAi: true,
  ...("runId" in proof ? { purpose: "fault" } : { purpose: "member_request" }),
  ...proof,
});
/** A safety review where a helper takes a proof: the purpose, and no request where the helper would name its own. */
const UNTOLD = { purpose: "trust_safety", requestId: undefined };
/** The answer's status and, for a refusal, its code. */
async function outcome(json: unknown, options?: Parameters<typeof call>[1]) {
  const res = await call(json, options);
  return res.status === 200 ? 200 : [res.status, ((await res.json()) as Refusal).error.code];
}
async function text(json: unknown) {
  const res = await call(json);
  if (res.status !== 200) throw new Error(`refused: ${await res.text()}`);
  return ((await res.json()) as Answer).text;
}
const events = () =>
  db
    .select()
    .from(schema.operatorEvents)
    .where(eq(schema.operatorEvents.type, "content.viewed"))
    .orderBy(asc(schema.operatorEvents.createdAt));
const auditLines = (orgId = w.orgId) =>
  db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.orgId, orgId))
    .orderBy(desc(schema.auditLog.createdAt))
    .then((rows) => rows.filter((r) => r.action === "operator.content_read"));
const forget = async () => {
  await db.delete(schema.operatorEvents);
  await db.delete(schema.auditLog).where(eq(schema.auditLog.action, "operator.content_read"));
};

beforeAll(async () => {
  t = await createTestServer({
    env: {
      OPERATOR_API_TOKEN: TOKEN,
      OPERATOR_API_READ_TOKEN: READ,
      OPERATOR_API_REVEAL_TOKEN: REVEAL,
      ALLOW_SIGNUP: "true",
    },
  });
  db = t.db;
  // The tests' own door counts no minute: the one about its limits brings a clock.
  const unlimited = {
    consume: async () => ({ allowed: true, remaining: 1, resetAt: new Date(0) }),
    release: async () => {},
  };
  deps = { db, config: t.config, version: "test", log: createLogger("error"), rateLimiter: unlimited };
  app = createOperatorApp(deps, TOKEN, READ, REVEAL);

  const userId = async (email: string) =>
    (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)))[0]?.id ?? "";
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const org = await seedOrg(owner);
  const { orgId } = org;
  await joinByInvitation(t, owner, orgId, "bia@example.com");
  await joinByInvitation(t, owner, orgId, "ada@example.com", { role: "admin" });
  await joinByInvitation(t, owner, orgId, "caio@example.com");
  Object.assign(w, {
    orgId,
    generalId: org.channelId,
    devId: org.agentId,
    ownerId: await userId("owner@example.com"),
    biaId: await userId("bia@example.com"),
    adaId: await userId("ada@example.com"),
    caioId: await userId("caio@example.com"),
  });
  // Caio asked, and then left.
  await db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, w.caioId));
  await db
    .update(schema.agents)
    .set({ ownerUserId: w.ownerId, instructions: "canary-instructions: answer in rhyme" })
    .where(eq(schema.agents.id, w.devId));

  const one = async <T extends { id: string }>(rows: Promise<T[]>) => (await rows)[0]?.id ?? "";
  // Bia's own agent, which answers nobody else.
  w.botId = await one(
    db
      .insert(schema.agents)
      .values({
        orgId,
        name: "Bot",
        handle: "bot",
        model: "x",
        ownerUserId: w.biaId,
        audienceMode: "owner",
        instructions: "canary-bot",
      })
      .returning({ id: schema.agents.id }),
  );
  const channel = (name: string, kind: "channel" | "dm", members: { userId?: string; agentId?: string }[]) =>
    one(
      db
        .insert(schema.channels)
        .values({ orgId, name, kind, visibility: "private", dmKey: kind === "dm" ? name : null })
        .returning({ id: schema.channels.id }),
    ).then(async (channelId) => {
      await db.insert(schema.channelMembers).values(members.map((m) => ({ orgId, channelId, ...m })));
      return channelId;
    });
  w.secretId = await channel("canary-plans", "channel", [{ userId: w.ownerId }, { agentId: w.devId }]);
  w.dmId = await channel("dm-owner-dev", "dm", [{ userId: w.ownerId }, { agentId: w.devId }]);
  w.goneId = await channel("canary-gone", "channel", [{ userId: w.ownerId }, { agentId: w.devId }]);
  await db
    .insert(schema.channelMembers)
    .values([
      { orgId, channelId: w.generalId, userId: w.biaId },
      { orgId, channelId: w.generalId, agentId: w.botId },
    ])
    .onConflictDoNothing();

  const say = (channelId: string, body: string, over: Partial<typeof schema.messages.$inferInsert> = {}) =>
    one(
      db
        .insert(schema.messages)
        .values({ orgId, channelId, authorType: "person", authorUserId: w.ownerId, body, ...over })
        .returning({ id: schema.messages.id }),
    );
  messages.asked = await say(
    w.generalId,
    "canary-asked: @dev export the report. Write to ana@example.com or +55 11 91234-5678",
  );
  messages.other = await say(w.generalId, "canary-other message of the same channel");
  messages.secret = await say(w.secretId, "canary-secret plans");
  messages.dm = await say(w.dmId, "canary-direct words");
  messages.deleted = await say(w.generalId, "canary-deleted words", { deletedAt: new Date() });
  messages.gone = await say(w.goneId, "canary-gone words");

  // One run per agent and message: each answers a message of its own unless it is told which.
  const run = async (
    status: (typeof schema.agentRuns.$inferInsert)["status"],
    over: Partial<typeof schema.agentRuns.$inferInsert> = {},
  ) => {
    const asked = over.triggerMessageId ?? (await say(over.channelId ?? w.generalId, "canary-asked again"));
    const id = await one(
      db
        .insert(schema.agentRuns)
        .values({
          orgId,
          agentId: w.devId,
          channelId: w.generalId,
          threadRootId: asked,
          triggerMessageId: asked,
          trigger: "mention",
          hop: 1,
          status,
          brain: "model",
          createdAt: ago(DAY),
          startedAt: ago(DAY),
          updatedAt: ago(DAY),
          ...over,
        })
        .returning({ id: schema.agentRuns.id }),
    );
    asking.set(id, asked);
    return id;
  };
  const steps = async (
    runId: string,
    list: [kind: Parameters<typeof addRunStep>[2], data: Record<string, unknown>][],
  ) => {
    for (const [kind, data] of list) await addRunStep(db, { id: runId, orgId }, kind, data);
  };
  const aCall = (id: string): Parameters<typeof steps>[1][number] => [
    "tool_call",
    {
      toolUseId: id,
      name: "lookup",
      input: { q: `canary-input-${id}`, password: "hunter2-fake" },
      detail: "canary-detail",
    },
  ];
  const aResult = (id: string, failed = false): Parameters<typeof steps>[1][number] => [
    "tool_result",
    { toolUseId: id, name: "lookup", content: `canary-result-${id}`, ...(failed ? { isError: true } : {}) },
  ];

  runs.failed = await run("failed", { error: "cli_failed: canary-error", triggerMessageId: messages.asked });
  await steps(runs.failed, [
    aCall("a"),
    aResult("a"),
    ["model_call", { model: "x", narration: "canary-narration" }],
    ["error", { reason: "cli_failed: canary-step-error", message: "canary-step-message" }],
  ]);
  messages.written = await say(w.generalId, "canary-written by the run", {
    authorType: "agent",
    authorUserId: null,
    authorAgentId: w.devId,
    agentRunId: runs.failed,
  });
  runs.others = await run("failed", {
    agentId: w.botId,
    triggerMessageId: messages.other,
    threadRootId: messages.other,
  });
  await steps(runs.others, [aCall("o"), aResult("o")]);
  runs.running = await run("running", { createdAt: ago(2 * HOUR), startedAt: ago(2 * HOUR), updatedAt: ago(60_000) });
  await steps(runs.running, [aCall("r")]);
  runs.fresh = await run("running", { createdAt: ago(600_000), startedAt: ago(600_000) });
  await steps(runs.fresh, [aCall("f")]);
  runs.onPlan = await run("waiting_input", {
    updatedAt: ago(2 * HOUR),
    transcript: { waitingForBrain: { code: "plan_limit" } },
  });
  await steps(runs.onPlan, [aCall("p")]);
  runs.onPerson = await run("waiting_input", { updatedAt: ago(2 * HOUR) });
  await steps(runs.onPerson, [aCall("q")]);
  runs.onApproval = await run("waiting_approval", { updatedAt: ago(2 * HOUR) });
  await steps(runs.onApproval, [aCall("v")]);
  runs.recovered = await run("done");
  await steps(runs.recovered, [
    aCall("a"),
    aResult("a"),
    aCall("b"),
    aResult("b", true),
    ["model_call", { narration: "canary-after" }],
  ]);
  runs.clean = await run("done");
  await steps(runs.clean, [aCall("c"), aResult("c")]);
  runs.old = await run("failed", { createdAt: ago(15 * DAY) });
  await steps(runs.old, [aCall("d")]);
  runs.older = await run("failed", { createdAt: ago(20 * DAY) });
  await steps(runs.older, [aCall("e")]);
  runs.direct = await run("failed", { channelId: w.dmId, triggerMessageId: messages.dm, threadRootId: messages.dm });
  await steps(runs.direct, [aCall("m")]);
  // A call that signed in three ways, and an answer that came back as a record.
  runs.keys = await run("failed");
  await steps(runs.keys, [
    [
      "tool_call",
      {
        toolUseId: "k",
        name: "fetch",
        input: {
          url: "https://api.example.com/v1",
          password: "correct horse fake",
          auth: { username: "ana", password: "hunter2-nested-fake" },
          headers: { "x-api-key": "fake-nested-header-key", accept: "text/plain" },
          body: { client_secret: "fake-nested-client-secret", items: [{ token: "fake nested token" }] },
        },
      },
    ],
    [
      "tool_result",
      {
        toolUseId: "k",
        name: "fetch",
        content: {
          ok: false,
          session: { token: "fake-object-token-value", password: "hunter2 object fake" },
          Authorization: "fake raw header value",
        },
        isError: true,
      },
    ],
    // A call and an answer that carry JSON inside a string: a credential behind escaped quotes, beside counts.
    [
      "tool_call",
      {
        toolUseId: "j",
        name: "fetch",
        input: {
          url: "https://api.example.com/v1/token",
          max_tokens: 4096,
          usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
          request: { body: JSON.stringify({ grant_type: "refresh", client_secret: "fake nested json secret" }) },
          args: ["--data", JSON.stringify({ password: 'fake "arg" password' })],
        },
      },
    ],
    [
      "tool_result",
      {
        toolUseId: "j",
        name: "fetch",
        content: JSON.stringify({
          status: 200,
          body: JSON.stringify({ access_token: "fake-body-access", expires_in: 3600, max_tokens: 4096 }),
        }),
        isError: true,
      },
    ],
  ]);
  runs.gone = await run("failed", {
    channelId: w.goneId,
    triggerMessageId: messages.gone,
    threadRootId: messages.gone,
  });
  await steps(runs.gone, [aCall("g"), aResult("g")]);

  w.routineId = await one(
    db
      .insert(schema.routines)
      .values({
        orgId,
        agentId: w.devId,
        name: "canary-routine-name",
        prompt: "canary-routine-instructions",
        target: { type: "channel", channelId: w.generalId },
        triggerType: "schedule",
        cron: "0 9 * * *",
        timezone: "UTC",
        createdByUserId: w.ownerId,
      })
      .returning({ id: schema.routines.id }),
  );
  // The routine's own room, as the server opens it: a conversation of its agent alone, where its run works.
  w.roomId = await channel(routineRoomKey(w.devId, w.routineId), "dm", [{ agentId: w.devId }]);
  runs.room = await run("failed", { channelId: w.roomId });
  await steps(runs.room, [aCall("n"), aResult("n", true)]);
  runs.parked = await run("waiting_input", {
    channelId: w.roomId,
    updatedAt: ago(2 * HOUR),
    transcript: { waitingForBrain: { code: "plan_limit" } },
  });
  await steps(runs.parked, [aCall("w")]);
  // A routine that reports to a direct conversation: its run is given what is said there, and writes for it.
  w.dmRoutineId = await one(
    db
      .insert(schema.routines)
      .values({
        orgId,
        agentId: w.devId,
        name: "canary-dm-routine-name",
        prompt: "canary-dm-routine-instructions",
        target: { type: "dm" },
        triggerType: "schedule",
        cron: "0 9 * * *",
        timezone: "UTC",
        createdByUserId: w.ownerId,
      })
      .returning({ id: schema.routines.id }),
  );
  runs.dmRoom = await run("failed", {
    channelId: await channel(routineRoomKey(w.devId, w.dmRoutineId), "dm", [{ agentId: w.devId }]),
  });
  await steps(runs.dmRoom, [aCall("y")]);
  // A run whose thread a test marks confidential: one step for each field, a routine's firing and a task of its own.
  runs.sealed = await run("failed");
  await steps(runs.sealed, [
    aCall("s"),
    aResult("s"),
    ["model_call", { model: "x", narration: "canary-sealed-narration" }],
    ["error", { reason: "cli_failed: canary-sealed-error" }],
  ]);
  await db.insert(schema.routineRuns).values(
    [runs.failed, runs.direct, runs.parked, runs.dmRoom, runs.sealed].map((agentRunId, n) => ({
      orgId,
      routineId: agentRunId === runs.dmRoom ? w.dmRoutineId : w.routineId,
      at: ago(DAY + n * HOUR),
      trigger: "schedule",
      status: "failed",
      agentRunId,
    })),
  );
  const machineId = await one(
    db.insert(schema.machines).values({ orgId, name: "Box" }).returning({ id: schema.machines.id }),
  );
  w.taskId = await one(
    db
      .insert(schema.machineTasks)
      .values({
        orgId,
        agentId: w.devId,
        machineId,
        channelId: w.generalId,
        runId: runs.failed,
        title: "canary-task-title",
        executor: "claude",
        command: "canary-task-command",
        prompt: "canary-task-prompt",
        result: "canary-task-result",
        lastLine: "canary-task-line",
        status: "done",
      })
      .returning({ id: schema.machineTasks.id }),
  );
  w.sealedTaskId = await one(
    db
      .insert(schema.machineTasks)
      .values({
        orgId,
        agentId: w.devId,
        machineId,
        channelId: w.generalId,
        runId: runs.sealed,
        title: "canary-sealed-title",
        executor: "claude",
        command: "canary-sealed-command",
        prompt: "canary-sealed-prompt",
        result: "canary-sealed-result",
        status: "done",
      })
      .returning({ id: schema.machineTasks.id }),
  );
  // A task the server started again by itself, twice: each a row with no run, which names the task it resumes.
  runs.again = await run("failed");
  const again = {
    orgId,
    agentId: w.devId,
    machineId,
    channelId: w.generalId,
    title: "canary-again-title",
    executor: "claude",
    command: "canary-again-command",
    prompt: "canary-again-prompt",
    result: "canary-again-result",
    status: "done" as const,
  };
  const started = (over: Partial<typeof schema.machineTasks.$inferInsert>) =>
    one(
      db
        .insert(schema.machineTasks)
        .values({ ...again, ...over })
        .returning({ id: schema.machineTasks.id }),
    );
  const once = await started({ resumedFromId: await started({ runId: runs.again }), resumeCount: 1 });
  w.againTaskId = await started({ resumedFromId: once, resumeCount: 2 });
  w.goneTaskId = await one(
    db
      .insert(schema.machineTasks)
      .values({
        orgId,
        agentId: w.devId,
        machineId,
        channelId: w.goneId,
        runId: runs.gone,
        title: "canary-gone-title",
        executor: "claude",
        command: "canary-gone-command",
        status: "done",
      })
      .returning({ id: schema.machineTasks.id }),
  );
  w.connectionId = await one(
    db
      .insert(schema.connectorConnections)
      .values({
        orgId,
        connector: "custom:billing",
        label: "canary-connection-label",
        serverUrl: "https://mcp.example.com/canary-path?access=canary-query",
        authType: "api_key",
        toolPrefix: "billing",
        accountLabel: "canary-account",
        lastError: "canary-connection-error",
      })
      .returning({ id: schema.connectorConnections.id }),
  );

  // Another workspace, with a message, a failed run and a request of its own.
  const zed = browser(t);
  await signUp(zed, "zed@example.com");
  const other = await seedOrg(zed);
  w.otherOrgId = other.orgId;
  const zedId = await userId("zed@example.com");
  messages.foreign = await one(
    db
      .insert(schema.messages)
      .values({
        orgId: other.orgId,
        channelId: other.channelId,
        authorType: "person",
        authorUserId: zedId,
        body: "canary-foreign",
      })
      .returning({ id: schema.messages.id }),
  );
  runs.foreign = await one(
    db
      .insert(schema.agentRuns)
      .values({
        orgId: other.orgId,
        agentId: other.agentId,
        channelId: other.channelId,
        threadRootId: messages.foreign,
        triggerMessageId: messages.foreign,
        trigger: "mention",
        hop: 1,
        status: "failed",
      })
      .returning({ id: schema.agentRuns.id }),
  );
  await addRunStep(db, { id: runs.foreign, orgId: other.orgId }, "tool_call", {
    toolUseId: "z",
    name: "x",
    input: { q: "canary-foreign-input" },
  });

  const request = (userId: string, source: string, over: Partial<typeof schema.supportRequests.$inferInsert> = {}) =>
    one(
      db
        .insert(schema.supportRequests)
        .values({ orgId, userId, source, text: "canary-request-text", about: "canary-request-about", ...over })
        .returning({ id: schema.supportRequests.id }),
    );
  requests.owner = await request(w.ownerId, "form");
  requests.bia = await request(w.biaId, "offer");
  requests.ada = await request(w.adaId, "email", { ref: "mail-1" });
  requests.byHand = await request(w.ownerId, "operator", { ref: "record-1", text: null, about: null });
  requests.stale = await request(w.ownerId, "form", { createdAt: ago(31 * DAY) });
  requests.left = await request(w.caioId, "form");
  requests.tenDays = await request(w.ownerId, "form", { createdAt: ago(10 * DAY) });
  requests.yesterday = await request(w.ownerId, "form", { createdAt: ago(DAY) });
  requests.before = await request(w.ownerId, "form", { createdAt: ago(25 * DAY) });
  requests.foreign = await request(zedId, "form", { orgId: other.orgId });
});

afterAll(() => t.close());
// Each test starts with nothing read: the day's count is the events themselves.
beforeEach(() => forget());

const step = (runId: string, seq: number, field: string, proof: Record<string, unknown>) => ({
  ...ask("run_step", runId, field, proof),
  seq,
});

test("the tokens: the reveal token opens the door and nothing else; the other two never do; with none set it is closed to all", async () => {
  const good = ask("message", messages.asked, "text", { requestId: requests.owner });
  expect(await outcome(good)).toBe(200);
  for (const token of [TOKEN, READ]) expect(await outcome(good, { token })).toEqual([403, "forbidden"]);
  expect(await outcome(good, { token: "wrong" })).toEqual([401, "unauthorized"]);
  const get = await app.request(`/api/operator/v1/reveal/orgs/${w.orgId}`, {
    headers: { authorization: `Bearer ${REVEAL}` },
  });
  expect(get.status).toBe(403);
  for (const path of ["/health", `/orgs/${w.orgId}`, `/orgs/${w.orgId}/support-requests`, "/openapi.json"]) {
    const res = await app.request(`/api/operator/v1${path}`, { headers: { authorization: `Bearer ${REVEAL}` } });
    expect({ path, status: res.status }).toEqual({ path, status: 403 });
  }
  // A server that set no reveal token: whoever asks, nothing is read and nothing is written.
  await forget();
  const closed = createOperatorApp(deps, TOKEN, READ);
  for (const token of [TOKEN, READ, REVEAL, "wrong"]) {
    expect({ token, answer: await outcome(good, { token, on: closed }) }).toEqual({
      token,
      answer: [403, "forbidden"],
    });
  }
  expect([await events(), await auditLines()]).toEqual([[], []]);
  // Two tokens equal would give one door's key to the other.
  for (const same of [TOKEN, READ]) {
    expect(() =>
      testConfig({ OPERATOR_API_TOKEN: TOKEN, OPERATOR_API_READ_TOKEN: READ, OPERATOR_API_REVEAL_TOKEN: same }),
    ).toThrow(/OPERATOR_API_REVEAL_TOKEN must differ/);
  }
});

test("each kind and field gives its own text; another workspace's record, a deleted one and nobody's are one 404", async () => {
  const mine = { requestId: requests.owner };
  const given: [json: Record<string, unknown>, text: string][] = [
    [ask("message", messages.secret, "text", mine), "canary-secret plans"],
    [step(runs.failed, 1, "input", mine), "q: canary-input-a\npassword: ***"],
    [step(runs.failed, 2, "result", mine), "canary-result-a"],
    [step(runs.failed, 3, "narration", mine), "canary-narration"],
    [step(runs.failed, 4, "error", mine), "cli_failed: canary-step-error: canary-step-message"],
    [step(runs.recovered, 4, "error", mine), "canary-result-b"],
    [ask("agent", w.devId, "instructions", mine), "canary-instructions: answer in rhyme"],
    [ask("routine", w.routineId, "name", mine), "canary-routine-name"],
    [ask("routine", w.routineId, "instructions", mine), "canary-routine-instructions"],
    [ask("task", w.taskId, "command", mine), "canary-task-command"],
    [ask("task", w.taskId, "prompt", mine), "canary-task-prompt"],
    [ask("task", w.taskId, "result", mine), "canary-task-result"],
    [ask("channel", w.secretId, "name", mine), "canary-plans"],
    [ask("connection", w.connectionId, "label", mine), "canary-connection-label"],
    [ask("connection", w.connectionId, "host", mine), "mcp.example.com"],
    [ask("connection", w.connectionId, "last_error", mine), "canary-connection-error"],
    [ask("support_request", requests.owner, "text", mine), "canary-request-text"],
    [ask("support_request", requests.owner, "about", mine), "canary-request-about"],
  ];
  // The table is closed, and this list is all of it.
  const fields = new Set(given.map(([json]) => `${json.kind}.${json.field}`));
  expect([...fields].sort()).toEqual(
    Object.entries(REVEAL_FIELDS)
      .flatMap(([kind, list]) => list.map((field) => `${kind}.${field}`))
      .sort(),
  );
  for (const [json, expected] of given) {
    const res = await call(json);
    const answer = (await res.json()) as Answer;
    expect({ asked: `${json.kind}.${json.field}`, status: res.status, text: answer.text }).toEqual({
      asked: `${json.kind}.${json.field}`,
      status: 200,
      text: expected,
    });
    expect(answer).toEqual({
      kind: json.kind as string,
      id: json.id as string,
      field: json.field as string,
      text: expected,
      chars: expected.length,
      offset: 0,
      more: false,
    });
  }

  const gone = await call(ask("message", UNKNOWN, "text", mine));
  const nobody = await gone.text();
  expect(gone.status).toBe(404);
  const same: [what: string, json: Record<string, unknown>, orgId?: string][] = [
    ["another workspace's message", ask("message", messages.foreign, "text", mine)],
    ["another workspace's step", step(runs.foreign, 1, "input", mine)],
    ["another workspace's request", ask("support_request", requests.foreign, "text", mine)],
    ["a deleted message", ask("message", messages.deleted, "text", mine)],
    ["a step the run doesn't have", step(runs.failed, 99, "input", mine)],
    ["a field the step doesn't have", step(runs.failed, 1, "narration", mine)],
    ["a direct conversation's made-up name", ask("channel", w.dmId, "name", mine)],
    ["a request with no words", ask("support_request", requests.byHand, "text", { requestId: requests.byHand })],
    ["a workspace nobody has", ask("message", messages.asked, "text", mine), UNKNOWN],
  ];
  for (const [what, json, orgId] of same) {
    const res = await call(json, { orgId });
    expect({ what, status: res.status, body: (await res.text()).replace(String(json.id), UNKNOWN) }).toEqual({
      what,
      status: 404,
      body: nobody,
    });
  }
  // An error is asked of something that failed.
  expect(await outcome(step(runs.failed, 2, "error", mine))).toEqual([409, "reveal.no_error"]);
});

test("member_request: the request is this workspace's and young, its member still one, and they read the record now", async () => {
  const message = (requestId: string, id = messages.asked) => outcome(ask("message", id, "text", { requestId }));
  expect(await message(UNKNOWN)).toEqual([403, "reveal.no_request"]);
  expect(await message(requests.stale)).toEqual([403, "reveal.no_request"]);
  expect(await message(requests.foreign)).toEqual([403, "reveal.no_request"]);
  expect(await message(requests.left)).toEqual([403, "reveal.requester"]);
  // Each of the four ways a request arrives opens what its member reads.
  for (const id of [requests.owner, requests.bia, requests.ada, requests.byHand]) expect(await message(id)).toBe(200);

  // A private channel: its member and an administrator read it, another member doesn't.
  expect(await message(requests.owner, messages.secret)).toBe(200);
  expect(await message(requests.ada, messages.secret)).toBe(200);
  expect(await message(requests.bia, messages.secret)).toEqual([403, "reveal.not_visible"]);
  expect(await outcome(ask("channel", w.secretId, "name", { requestId: requests.bia }))).toEqual([
    403,
    "reveal.not_visible",
  ]);

  // A run's steps: a plain member in the channel doesn't see how someone else's agent worked; its owner and an
  // administrator do. Her own agent's, she does.
  const aStep = (requestId: string, runId = runs.failed) => outcome(step(runId, 1, "input", { requestId }));
  expect(await aStep(requests.bia)).toEqual([403, "reveal.not_visible"]);
  expect(await aStep(requests.owner)).toBe(200);
  expect(await aStep(requests.ada)).toBe(200);
  expect(await aStep(requests.bia, runs.others)).toBe(200);
  expect(await outcome(ask("task", w.taskId, "prompt", { requestId: requests.bia }))).toEqual([
    403,
    "reveal.not_visible",
  ]);
  // How an agent works is its owner's, an administrator's and whoever it answers to see.
  expect(await outcome(ask("agent", w.botId, "instructions", { requestId: requests.bia }))).toBe(200);
  expect(await outcome(ask("agent", w.botId, "instructions", { requestId: requests.ada }))).toBe(200);
  // An agent that answers only its owner: neither its instructions nor its routine are hers to see.
  await db.update(schema.agents).set({ audienceMode: "owner" }).where(eq(schema.agents.id, w.devId));
  for (const json of [ask("agent", w.devId, "instructions", {}), ask("routine", w.routineId, "name", {})]) {
    expect(await outcome({ ...json, requestId: requests.bia })).toEqual([403, "reveal.not_visible"]);
  }
  // Once it answers everyone: how it works, and the routine of a channel she is in, with its instructions.
  await db.update(schema.agents).set({ audienceMode: "everyone" }).where(eq(schema.agents.id, w.devId));
  for (const json of [
    ask("agent", w.devId, "instructions", {}),
    ask("routine", w.routineId, "name", {}),
    ask("routine", w.routineId, "instructions", {}),
  ]) {
    expect(await outcome({ ...json, requestId: requests.bia })).toBe(200);
  }

  // A direct conversation: who is in it, never an administrator who is not.
  expect(await message(requests.owner, messages.dm)).toBe(200);
  expect(await message(requests.ada, messages.dm)).toEqual([403, "reveal.not_visible"]);
  expect(await outcome(step(runs.direct, 1, "input", { requestId: requests.ada }))).toEqual([
    403,
    "reveal.not_visible",
  ]);

  // A request's own words, and nobody else's.
  const words = (id: string, requestId: string) => outcome(ask("support_request", id, "about", { requestId }));
  expect(await words(requests.bia, requests.bia)).toBe(200);
  expect(await words(requests.owner, requests.bia)).toEqual([403, "reveal.not_visible"]);
  expect(await words(requests.bia, requests.ada)).toEqual([403, "reveal.not_visible"]);
});

test("fault: a run that failed or stands still, in its days, opens what hangs on it and nothing else", async () => {
  const input = (runId: string, over: Record<string, unknown> = {}) =>
    outcome(step(runId, 1, "input", { runId, ...over }));
  // No fault: it ended well, it is still at work, or the next move is a person's.
  for (const runId of [runs.clean, runs.fresh, runs.onPerson, runs.onApproval]) {
    expect({ runId, answer: await input(runId) }).toEqual({ runId, answer: [403, "reveal.no_fault"] });
  }
  // Nor a run nobody has, or another workspace's.
  for (const runId of [UNKNOWN, runs.foreign]) {
    expect(await outcome(ask("message", messages.asked, "text", { runId }))).toEqual([403, "reveal.no_fault"]);
  }
  // Stuck: at work for two hours, or two hours on its plan.
  expect(await input(runs.running)).toBe(200);
  expect(await input(runs.onPlan)).toBe(200);

  // Its days: 14 from the run, or 14 back from the report that names it.
  expect(await input(runs.old)).toEqual([403, "reveal.no_fault"]);
  expect(await input(runs.older)).toEqual([403, "reveal.no_fault"]);
  expect(await input(runs.older, { requestId: requests.tenDays })).toBe(200);
  expect(await input(runs.older, { requestId: requests.yesterday })).toEqual([403, "reveal.no_fault"]);
  for (const requestId of [requests.foreign, requests.stale, UNKNOWN]) {
    expect(await input(runs.failed, { requestId })).toEqual([403, "reveal.no_request"]);
  }

  // What hangs on a failed run, and on one that stands still.
  const of = { runId: runs.failed };
  const hangs = [
    step(runs.failed, 1, "input", of),
    step(runs.failed, 2, "result", of),
    step(runs.failed, 3, "narration", of),
    step(runs.failed, 4, "error", of),
    ask("message", messages.asked, "text", of),
    ask("message", messages.written, "text", of),
    ask("agent", w.devId, "instructions", of),
    ask("routine", w.routineId, "name", of),
    ask("routine", w.routineId, "instructions", of),
    ask("task", w.taskId, "command", of),
    ask("message", asking.get(runs.running) ?? "", "text", { runId: runs.running }),
    ask("agent", w.devId, "instructions", { runId: runs.onPlan }),
  ];
  for (const json of hangs) expect({ json, answer: await outcome(json) }).toEqual({ json, answer: 200 });
  const apart = [
    step(runs.others, 1, "input", of),
    ask("message", messages.other, "text", of),
    ask("message", messages.secret, "text", of),
    ask("agent", w.botId, "instructions", of),
    ask("channel", w.secretId, "name", of),
    ask("connection", w.connectionId, "last_error", of),
    ask("support_request", requests.owner, "text", { ...of, requestId: requests.owner }),
    ask("routine", w.routineId, "name", { runId: runs.others }),
    ask("task", w.taskId, "prompt", { runId: runs.others }),
  ];
  for (const json of apart) {
    expect({ json, answer: await outcome(json) }).toEqual({ json, answer: [403, "reveal.not_the_fault"] });
  }

  // A run that went on past one failed call: that result's error and that call's input, never the rest of itself.
  const past = { runId: runs.recovered };
  expect(await text(step(runs.recovered, 4, "error", past))).toBe("canary-result-b");
  expect(await text(step(runs.recovered, 3, "input", past))).toContain("canary-input-b");
  for (const json of [
    step(runs.recovered, 1, "input", past),
    step(runs.recovered, 2, "result", past),
    step(runs.recovered, 4, "result", past),
    step(runs.recovered, 5, "narration", past),
    ask("message", asking.get(runs.recovered) ?? "", "text", past),
    ask("agent", w.devId, "instructions", past),
  ]) {
    expect({ json, answer: await outcome(json) }).toEqual({ json, answer: [403, "reveal.not_the_fault"] });
  }

  // Nothing of a direct conversation: of a run that worked in one, its agent's instructions and its routine.
  const direct = { runId: runs.direct };
  expect(await outcome(step(runs.direct, 1, "input", direct))).toEqual([403, "reveal.direct_conversation"]);
  expect(await outcome(ask("message", messages.dm, "text", direct))).toEqual([403, "reveal.direct_conversation"]);
  expect(await outcome(ask("agent", w.devId, "instructions", direct))).toBe(200);
  expect(await outcome(ask("routine", w.routineId, "instructions", direct))).toBe(200);
});

test("fault: a report made before the run moves nothing; the run keeps its own 14 days", async () => {
  const input = (runId: string, requestId: string) => outcome(step(runId, 1, "input", { runId, requestId }));
  // Twenty days old, and the report is five days older: it is about something else.
  expect(await input(runs.older, requests.before)).toEqual([403, "reveal.no_fault"]);
  expect(await input(runs.older, requests.tenDays)).toBe(200);
  // A failure after the report opens for its own days, whatever report is named with it.
  expect(await input(runs.failed, requests.before)).toBe(200);
});

test("fault: a routine's own room is nobody's conversation, so its run opens, unless it reports to a direct one", async () => {
  await forget();
  const parked = { runId: runs.parked };
  expect(await text(step(runs.parked, 1, "input", parked))).toContain("canary-input-w");
  expect(await outcome(ask("message", asking.get(runs.parked) ?? "", "text", parked))).toBe(200);
  expect(await outcome(ask("routine", w.routineId, "instructions", parked))).toBe(200);
  expect(await text(step(runs.room, 2, "error", { runId: runs.room }))).toBe("canary-result-n");
  // No two people's conversation is there to keep unnamed: the audit entry says which step.
  const entry = (await auditLines()).find((l) => l.targetId === runs.parked);
  expect([entry?.targetType, entry?.details.direct, entry?.details.seq]).toEqual(["run_step", undefined, 1]);
  // The app shows that run to no person, so no member's request opens it.
  for (const requestId of [requests.owner, requests.ada]) {
    expect(await outcome(step(runs.parked, 1, "input", { requestId }))).toEqual([403, "reveal.not_visible"]);
  }
  // A person's conversation with an agent stays closed, and so does the room of a routine that reports to one:
  // of that run, the routine and its agent's instructions.
  const reportsTo = (target: Record<string, unknown>) =>
    db.update(schema.routines).set({ target }).where(eq(schema.routines.id, w.dmRoutineId));
  const closed = { runId: runs.dmRoom };
  for (const target of [{ type: "dm" }, { type: "conversation", channelId: w.dmId, threadId: null }]) {
    await reportsTo(target);
    for (const json of [
      step(runs.dmRoom, 1, "input", closed),
      ask("message", asking.get(runs.dmRoom) ?? "", "text", closed),
      step(runs.direct, 1, "input", { runId: runs.direct }),
    ]) {
      expect({ target, json, answer: await outcome(json) }).toEqual({
        target,
        json,
        answer: [403, "reveal.direct_conversation"],
      });
    }
    expect(await outcome(ask("routine", w.dmRoutineId, "instructions", closed))).toBe(200);
  }
  // Once it reports to a channel, its room is as any other routine's, for a run that kept no word of where it reported.
  await reportsTo({ type: "channel", channelId: w.generalId });
  expect(await outcome(step(runs.dmRoom, 1, "input", closed))).toBe(200);

  // A firing keeps where it reported on the message that started it. What it left in the room stays closed when
  // that was a direct conversation, wherever the routine reports now.
  const firing = asking.get(runs.dmRoom) ?? "";
  const fired = (deliverTo: Record<string, unknown>, more: Record<string, unknown> = {}) =>
    db
      .update(schema.messages)
      .set({ meta: { routineBrief: { routineId: w.dmRoutineId, routineRunId: UNKNOWN, deliverTo, ...more } } })
      .where(eq(schema.messages.id, firing));
  const [room] = await db
    .select({ id: schema.agentRuns.channelId })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, runs.dmRoom));
  const [wrote] = await db
    .insert(schema.messages)
    .values({
      orgId: w.orgId,
      channelId: room?.id ?? "",
      authorType: "agent",
      authorAgentId: w.devId,
      agentRunId: runs.dmRoom,
      body: "canary-left in the room",
    })
    .returning({ id: schema.messages.id });
  const left = [
    step(runs.dmRoom, 1, "input", closed),
    ask("message", firing, "text", closed),
    ask("message", wrote?.id ?? "", "text", closed),
  ];
  await fired({ channelId: w.dmId, threadId: null });
  for (const json of left) {
    expect({ json, answer: await outcome(json) }).toEqual({ json, answer: [403, "reveal.direct_conversation"] });
  }
  expect(await outcome(ask("routine", w.dmRoutineId, "instructions", closed))).toBe(200);
  // A firing that reported to a channel opens, and so does one that redid a widget: it reads no conversation.
  await fired({ channelId: w.generalId, threadId: null });
  for (const json of left) expect({ json, answer: await outcome(json) }).toEqual({ json, answer: 200 });
  await fired({ channelId: w.dmId, threadId: null }, { widget: { widgetId: UNKNOWN, dashboardId: UNKNOWN } });
  expect(await outcome(step(runs.dmRoom, 1, "input", closed))).toBe(200);
  // A routine that writes a document reports in its creator's own conversation with the agent.
  await fired({ channelId: w.generalId, threadId: null });
  await reportsTo({ type: "artifact" });
  expect(await outcome(step(runs.dmRoom, 1, "input", closed))).toEqual([403, "reveal.direct_conversation"]);
});

test("a conversation deleted for good: what its runs kept is the same 404 as nobody's, whatever the purpose", async () => {
  const of = { runId: runs.gone };
  const mine = { requestId: requests.owner };
  const kept = [
    step(runs.gone, 1, "input", of),
    step(runs.gone, 2, "result", of),
    ask("message", messages.gone, "text", of),
    ask("task", w.goneTaskId, "command", of),
  ];
  // Archived, it can come back: its failed run is still one to diagnose.
  await db.update(schema.channels).set({ archivedAt: new Date() }).where(eq(schema.channels.id, w.goneId));
  for (const json of kept) expect({ json, answer: await outcome(json) }).toEqual({ json, answer: 200 });
  // Deleted, its row stays for the runs that name it, and so do their steps.
  await db
    .update(schema.channels)
    .set({ deletedAt: new Date(), name: `deleted-${w.goneId}` })
    .where(eq(schema.channels.id, w.goneId));
  await forget();
  const nobody = await (await call(ask("message", UNKNOWN, "text", mine))).text();
  const under = (proof: Record<string, unknown>) => kept.map((k) => ({ ...k, runId: undefined, ...proof }));
  for (const json of [...kept, ...under({ purpose: "member_request", ...mine }), ...under(UNTOLD)]) {
    const res = await call(json);
    expect({ json, status: res.status, body: (await res.text()).replace(String(json.id), UNKNOWN) }).toEqual({
      json,
      status: 404,
      body: nobody,
    });
  }
  expect([await events(), await auditLines()]).toEqual([[], []]);
});

test("the record first: an event with the reason, an audit entry with what was read and its proof, never the text or the reason", async () => {
  await forget();
  expect(await outcome(step(runs.failed, 1, "input", { requestId: requests.ada, offset: 2, limit: 9 }))).toBe(200);
  expect(await outcome(ask("message", messages.asked, "text", { runId: runs.failed, requestId: requests.owner }))).toBe(
    200,
  );
  expect(await outcome(ask("message", messages.dm, "text", { requestId: requests.owner }))).toBe(200);

  const feed = (await events()).map((e) => [e.orgId, e.userId, e.data]);
  expect(feed).toEqual([
    [
      w.orgId,
      null,
      {
        ref: `reveal:run_step:${runs.failed}:1`,
        reason: REASON,
        operator: "call:7",
        purpose: "member_request",
        field: "input",
        assistedByAi: true,
        requestId: requests.ada,
        source: "email",
      },
    ],
    [
      w.orgId,
      null,
      {
        ref: `reveal:message:${messages.asked}`,
        reason: REASON,
        operator: "call:7",
        purpose: "fault",
        field: "text",
        assistedByAi: true,
        runId: runs.failed,
        requestId: requests.owner,
      },
    ],
    [w.orgId, null, expect.objectContaining({ ref: `reveal:message:${messages.dm}`, purpose: "member_request" })],
  ]);

  const lines = (await auditLines()).reverse();
  const shown = lines.map((l) => [
    l.actorType,
    l.actorId,
    l.targetType,
    l.targetId,
    l.onBehalfOfUserId,
    l.runId,
    l.details,
  ]);
  expect(shown).toEqual([
    [
      "system",
      null,
      "run_step",
      runs.failed,
      w.adaId,
      null,
      {
        field: "input",
        seq: 1,
        offset: 2,
        limit: 9,
        purpose: "member_request",
        assistedByAi: true,
        requestId: requests.ada,
        source: "email",
      },
    ],
    // A fault read is never "at someone's request", even when a report names the run.
    [
      "system",
      null,
      "message",
      messages.asked,
      null,
      null,
      {
        field: "text",
        offset: 0,
        limit: 2000,
        purpose: "fault",
        assistedByAi: true,
        runId: runs.failed,
        requestId: requests.owner,
      },
    ],
    // Of a direct conversation: that something was read there and at whose request, never which message.
    [
      "system",
      null,
      "message",
      null,
      w.ownerId,
      null,
      {
        field: "text",
        direct: true,
        offset: 0,
        limit: 2000,
        purpose: "member_request",
        assistedByAi: true,
        requestId: requests.owner,
        source: "form",
      },
    ],
  ]);
  const written = JSON.stringify(lines);
  expect(written).not.toContain("canary");
  expect(written).not.toContain("approval requests");
  expect(written).not.toContain(messages.dm);

  // On agentes.chat's own servers the entry says so, for the apps to name who read it.
  await forget();
  setRestrictionNotices("https://app.agentes.chat");
  try {
    expect(await outcome(ask("message", messages.asked, "text", { requestId: requests.owner }))).toBe(200);
  } finally {
    setRestrictionNotices(t.config.PUBLIC_URL);
  }
  expect((await auditLines()).map((l) => l.details.cloud)).toEqual([true]);

  // A refusal reads nothing and records nothing.
  await forget();
  expect(await outcome(ask("message", messages.secret, "text", { requestId: requests.bia }))).toEqual([
    403,
    "reveal.not_visible",
  ]);
  expect(await outcome(ask("message", messages.asked, "text", { runId: runs.clean }))).toEqual([
    403,
    "reveal.no_fault",
  ]);
  expect(
    await outcome({
      ...ask("message", messages.asked, "text", { requestId: requests.owner }),
      purpose: "trust_safety",
    }),
  ).toEqual([400, "invalid_request"]);
  expect([await events(), await auditLines()]).toEqual([[], []]);
});

/** A database whose record of a read fails, or whose read fails once the record is in (`after`: once the text is read). */
function failing(mode: "record" | "read" | "after") {
  let recorded = false;
  const read = { text: "" };
  const breaks = (query: object): object =>
    new Proxy(query, {
      get(target, prop) {
        if (prop === "then") {
          return (_resolve: (rows: unknown) => void, reject: (error: unknown) => void) =>
            mode === "read"
              ? reject(new Error("the connection dropped"))
              : (target as PromiseLike<unknown>).then((rows) => {
                  read.text = JSON.stringify(rows);
                  reject(new Error("the connection dropped"));
                }, reject);
        }
        const value = Reflect.get(target, prop, target);
        return typeof value !== "function" ? value : (...args: unknown[]) => breaks(value.apply(target, args));
      },
    });
  const broken = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "transaction") {
        return async (...args: unknown[]) => {
          if (mode === "record") throw new Error("the record could not be written");
          const out = await value.apply(target, args);
          recorded = true;
          return out;
        };
      }
      if (prop === "select" && recorded) return (...args: unknown[]) => breaks(value.apply(target, args));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: broken as Database, read };
}

test("no record, no text; and a read that fails once on record stays on record, with no word in a log line or an error report", async () => {
  const json = ask("message", messages.asked, "text", { requestId: requests.owner });
  const lines: string[] = [];
  const print = console.error;
  console.error = (line: unknown) => void lines.push(String(line));
  try {
    for (const mode of ["record", "read", "after"] as const) {
      await forget();
      const errors = createFakeErrorReporter();
      const broken = failing(mode);
      const on = createOperatorApp({ ...deps, db: broken.db, log: createLogger("error", errors) }, TOKEN, READ, REVEAL);
      const res = await call(json, { on });
      const body = await res.text();
      expect({ mode, status: res.status }).toEqual({ mode, status: 500 });
      expect(body).not.toContain("canary");
      expect({ mode, events: (await events()).length, audit: (await auditLines()).length }).toEqual({
        mode,
        events: mode === "record" ? 0 : 1,
        audit: mode === "record" ? 0 : 1,
      });
      // The text was in the server's hands when it failed, and went nowhere.
      expect(broken.read.text.includes("canary-asked")).toBe(mode === "after");
      expect(errors.reports).toHaveLength(1);
      expect(
        JSON.stringify(errors.reports.map((r) => [String(r.error), (r.error as Error).stack, r.tags])),
      ).not.toContain("canary");
    }
  } finally {
    console.error = print;
  }
  expect(lines.filter((line) => line.includes("unhandled error"))).toHaveLength(3);
  expect(lines.join("\n")).not.toContain("canary");
});

// The safety review's tests read the fixtures as they were made: the masking tests below rewrite them.
/** A read for a safety review: it names no request and no run. */
const review = (kind: string, id: string, field: string, over: Record<string, unknown> = {}) => ({
  ...ask(kind, id, field, {}),
  purpose: "trust_safety",
  ...over,
});
/** Every entry of the workspace's audit log, whatever its action. */
const everyAuditLine = (orgId = w.orgId) => db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, orgId));
/** A read's own event, to write again as many times as a count needs. */
async function anEvent() {
  const one = (await events())[0];
  if (!one) throw new Error("no event");
  const { id: _, xactId: __, ...event } = one;
  return event;
}
const many = (length: number, event: typeof schema.operatorEvents.$inferInsert) =>
  db.insert(schema.operatorEvents).values(Array.from({ length }, () => event));

test("trust_safety: every kind but a support request's words opens, with no request and no run named", async () => {
  await forget();
  const given: [json: Record<string, unknown>, text: string][] = [
    [review("message", messages.secret, "text"), "canary-secret plans"],
    // A run that ended well: no fault would open it.
    [review("run_step", runs.clean, "input", { seq: 1 }), "q: canary-input-c\npassword: ***"],
    [review("run_step", runs.clean, "result", { seq: 2 }), "canary-result-c"],
    [review("run_step", runs.failed, "narration", { seq: 3 }), "canary-narration"],
    [review("run_step", runs.failed, "error", { seq: 4 }), "cli_failed: canary-step-error: canary-step-message"],
    // An agent that answers its owner alone: no other member's request would open it.
    [review("agent", w.botId, "instructions"), "canary-bot"],
    [review("routine", w.routineId, "name"), "canary-routine-name"],
    [review("routine", w.routineId, "instructions"), "canary-routine-instructions"],
    [review("task", w.taskId, "command"), "canary-task-command"],
    [review("task", w.taskId, "prompt"), "canary-task-prompt"],
    [review("task", w.taskId, "result"), "canary-task-result"],
    [review("channel", w.secretId, "name"), "canary-plans"],
    [review("connection", w.connectionId, "label"), "canary-connection-label"],
    [review("connection", w.connectionId, "host"), "mcp.example.com"],
    [review("connection", w.connectionId, "last_error"), "canary-connection-error"],
  ];
  // Every field of the door's table but a support request's.
  expect(given.map(([json]) => `${json.kind}.${json.field}`).sort()).toEqual(
    Object.entries(REVEAL_FIELDS)
      .flatMap(([kind, list]) => (kind === "support_request" ? [] : list.map((field) => `${kind}.${field}`)))
      .sort(),
  );
  for (const [json, expected] of given) {
    const res = await call(json);
    const answer = res.status === 200 ? ((await res.json()) as Answer).text : await res.text();
    expect({ asked: `${json.kind}.${json.field}`, status: res.status, answer }).toEqual({
      asked: `${json.kind}.${json.field}`,
      status: 200,
      answer: expected,
    });
  }
  // Nobody asked and no run failed: each event names no member and no proof.
  const feed = await events();
  expect(feed.map((e) => [e.orgId, e.userId])).toEqual(given.map(() => [w.orgId, null]));
  expect(feed[0]?.data).toEqual({
    ref: `reveal:message:${messages.secret}`,
    reason: REASON,
    operator: "call:7",
    purpose: "trust_safety",
    field: "text",
    assistedByAi: true,
  });

  // A record of another workspace is nobody's, as under any purpose.
  await forget();
  const nobody = await call(review("message", UNKNOWN, "text"));
  const foreign = await call(review("message", messages.foreign, "text"));
  expect([nobody.status, foreign.status]).toEqual([404, 404]);
  expect((await foreign.text()).replace(messages.foreign, UNKNOWN)).toBe(await nobody.text());
  expect(await events()).toEqual([]);
});

test("trust_safety names no proof: a request or a run sent with it is refused, so no read can look like it had one", async () => {
  await forget();
  for (const proof of [
    { requestId: requests.owner },
    { runId: runs.failed },
    { requestId: requests.owner, runId: runs.failed },
  ]) {
    expect({ proof, answer: await outcome(review("message", messages.asked, "text", proof)) }).toEqual({
      proof,
      answer: [400, "invalid_request"],
    });
  }
  expect(await events()).toEqual([]);
});

test("trust_safety: a support request's words are never given", async () => {
  await forget();
  for (const field of REVEAL_FIELDS.support_request) {
    for (const id of [requests.owner, requests.bia]) {
      expect({ field, answer: await outcome(review("support_request", id, field)) }).toEqual({
        field,
        answer: [403, "reveal.not_visible"],
      });
    }
  }
  // One that is not there is the same 404 as ever: the refusal tells of no request the caller could not list.
  expect((await call(review("support_request", requests.foreign, "text"))).status).toBe(404);
  expect(await events()).toEqual([]);
});

test("trust_safety: of a direct conversation, never a message that no agent wrote and that started no run", async () => {
  await forget();
  const say = async (channelId: string, body: string, over: Partial<typeof schema.messages.$inferInsert> = {}) => {
    const [m] = await db
      .insert(schema.messages)
      .values({ orgId: w.orgId, channelId, authorType: "person", authorUserId: w.ownerId, body, ...over })
      .returning({ id: schema.messages.id });
    return m?.id ?? "";
  };
  const byAgent = { authorType: "agent", authorUserId: null, authorAgentId: w.devId } as const;
  const [people] = await db
    .insert(schema.channels)
    .values({ orgId: w.orgId, name: "dm-owner-bia", kind: "dm", visibility: "private", dmKey: "dm-owner-bia" })
    .returning({ id: schema.channels.id });
  const peopleId = people?.id ?? "";
  await db.insert(schema.channelMembers).values([
    { orgId: w.orgId, channelId: peopleId, userId: w.ownerId },
    { orgId: w.orgId, channelId: peopleId, userId: w.biaId },
  ]);

  // What two people said to each other, and what a person told an agent that no run took up.
  const between = [
    await say(peopleId, "canary-between two people"),
    await say(peopleId, "canary-between two people, answered", { authorUserId: w.biaId }),
    await say(w.dmId, "canary-direct words no run took up"),
  ];
  for (const id of between) {
    expect(await outcome(review("message", id, "text"))).toEqual([403, "reveal.direct_conversation"]);
  }
  // Refused before the record: nothing says a message was read, and no text was.
  expect(await events()).toEqual([]);

  // An agent's part of a direct conversation opens: the message that started its run, and what it wrote.
  expect(await text(review("message", messages.dm, "text"))).toBe("canary-direct words");
  const wrote = await say(w.dmId, "canary-direct answer", { ...byAgent, agentRunId: runs.direct });
  expect(await text(review("message", wrote, "text"))).toBe("canary-direct answer");
  const mentioned = await say(peopleId, "canary-between two people, with @dev");
  await db.insert(schema.agentRuns).values({
    orgId: w.orgId,
    agentId: w.devId,
    channelId: peopleId,
    threadRootId: mentioned,
    triggerMessageId: mentioned,
    trigger: "mention",
    hop: 1,
    status: "done",
    brain: "model",
  });
  expect(await text(review("message", mentioned, "text"))).toBe("canary-between two people, with @dev");

  // Every other kind is an agent's, in a direct conversation too: a run's step, a task, the agent, its routine.
  const [box] = await db.select({ id: schema.machines.id }).from(schema.machines).limit(1);
  const [task] = await db
    .insert(schema.machineTasks)
    .values({
      orgId: w.orgId,
      agentId: w.devId,
      machineId: box?.id ?? "",
      channelId: w.dmId,
      runId: runs.direct,
      title: "canary-direct-title",
      executor: "claude",
      command: "canary-direct-command",
      status: "done",
    })
    .returning({ id: schema.machineTasks.id });
  expect(await text(review("run_step", runs.direct, "input", { seq: 1 }))).toContain("canary-input-m");
  expect(await text(review("task", task?.id ?? "", "command"))).toBe("canary-direct-command");
  expect(await outcome(review("agent", w.devId, "instructions"))).toBe(200);
  expect(await outcome(review("routine", w.routineId, "instructions"))).toBe(200);

  // The same conversations a fault read calls direct, and no other: a person's words in a channel open, and so do
  // those in the room of a routine that reports to a channel, which is stored as a direct conversation.
  expect(await outcome(review("message", messages.secret, "text"))).toBe(200);
  const inRoom = await say(w.roomId, "canary-left in the routine's room");
  expect(await outcome(review("message", inRoom, "text"))).toBe(200);
});

test("trust_safety: recorded first and told later: the event before any text, and never an audit entry", async () => {
  await forget();
  const json = review("message", messages.asked, "text");
  const before = (await everyAuditLine()).length;
  expect(await text(json)).toContain("canary-asked");
  expect((await events()).map((e) => e.data)).toEqual([
    {
      ref: `reveal:message:${messages.asked}`,
      reason: REASON,
      operator: "call:7",
      purpose: "trust_safety",
      field: "text",
      assistedByAi: true,
    },
  ]);
  // Nothing in the workspace's own log, under any action.
  expect((await everyAuditLine()).length).toBe(before);

  const lines: string[] = [];
  const print = console.error;
  console.error = (line: unknown) => void lines.push(String(line));
  try {
    for (const mode of ["record", "read", "after"] as const) {
      await forget();
      const broken = failing(mode);
      const on = createOperatorApp({ ...deps, db: broken.db }, TOKEN, READ, REVEAL);
      const res = await call(json, { on });
      // No record, no text. And a read that fails once on record stays on record.
      expect({ mode, status: res.status }).toEqual({ mode, status: 500 });
      expect(await res.text()).not.toContain("canary");
      expect({ mode, events: (await events()).length }).toEqual({ mode, events: mode === "record" ? 0 : 1 });
      expect(broken.read.text.includes("canary-asked")).toBe(mode === "after");
      expect((await everyAuditLine()).length).toBe(before);
    }
  } finally {
    console.error = print;
  }
  expect(lines.join("\n")).not.toContain("canary");
});

test("trust_safety is bounded: 150 such reads in a day on the whole instance, whatever the workspace", async () => {
  await forget();
  const here = review("message", messages.asked, "text");
  const there = () => outcome(review("message", messages.foreign, "text"), { orgId: w.otherOrgId });
  expect(await outcome(here)).toBe(200);
  // The rest of the day's reads were of a workspace that is gone since: the count is the instance's.
  await many(REVEAL_UNTOLD_PER_DAY - 2, { ...(await anEvent()), orgId: UNKNOWN });
  expect(await outcome(here)).toBe(200);
  const refused = await call(here);
  const body = (await refused.json()) as Refusal;
  expect([refused.status, body.error.code]).toEqual([429, "reveal.limit_untold"]);
  // The sentence says what is used and that it frees.
  expect(body.error.message).toContain(`${REVEAL_UNTOLD_PER_DAY} reads`);
  expect(body.error.message).toContain("frees 24 hours after");
  expect(await there()).toEqual([429, "reveal.limit_untold"]);
  expect(await events()).toHaveLength(REVEAL_UNTOLD_PER_DAY);

  // The other two purposes are not stopped by it.
  expect(await outcome(ask("message", messages.asked, "text", { requestId: requests.owner }))).toBe(200);
  expect(await outcome(ask("message", messages.asked, "text", { runId: runs.failed }))).toBe(200);
  // It frees as the day moves on: a read over a day old is no longer counted.
  const [oldest] = await events();
  await db
    .update(schema.operatorEvents)
    .set({ createdAt: ago(DAY + HOUR) })
    .where(eq(schema.operatorEvents.id, oldest?.id ?? ""));
  expect(await there()).toBe(200);
  expect(await there()).toEqual([429, "reveal.limit_untold"]);
});

test("trust_safety's count is its own: reads for a request or a fault, and review blocks, use none of it", async () => {
  await forget();
  expect(await outcome(ask("message", messages.asked, "text", { requestId: requests.owner }))).toBe(200);
  const asked = await anEvent();
  // A day's worth and more of the other two purposes and of review blocks, on another workspace.
  await many(REVEAL_UNTOLD_PER_DAY, { ...asked, orgId: UNKNOWN });
  await many(REVEAL_UNTOLD_PER_DAY, {
    ...asked,
    orgId: UNKNOWN,
    data: { ...asked.data, purpose: "fault", runId: runs.foreign },
  });
  await many(REVEAL_UNTOLD_PER_DAY, {
    ...asked,
    orgId: UNKNOWN,
    data: { ref: `run:${runs.failed}`, reason: "a sample", operator: "sampler", purpose: "trust_safety" },
  });
  expect(await outcome(review("message", messages.asked, "text"))).toBe(200);
});

test("trust_safety: a workspace's own 100 reads a day still stop it", async () => {
  await forget();
  expect(await outcome(ask("message", messages.asked, "text", { requestId: requests.owner }))).toBe(200);
  await many(REVEAL_PER_WORKSPACE_DAY - 1, await anEvent());
  expect(await outcome(review("message", messages.asked, "text"))).toEqual([429, "reveal.limit_workspace"]);
  expect(await outcome(review("message", messages.foreign, "text"), { orgId: w.otherOrgId })).toBe(200);
});

const DISCLOSED = "operator.content_review_disclosed";
const disclose = (json: unknown, options: { token?: string; orgId?: string } = {}) =>
  app.request(`/api/operator/v1/orgs/${options.orgId ?? w.orgId}/content-reads/disclosure`, {
    method: "POST",
    headers: { authorization: `Bearer ${options.token ?? TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(json),
  });
const disclosures = (orgId = w.orgId) =>
  db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.action, DISCLOSED)))
    .orderBy(asc(schema.auditLog.createdAt));
const undisclose = () => db.delete(schema.auditLog).where(eq(schema.auditLog.action, DISCLOSED));
/** The answer's status and, for a refusal, its code. */
async function disclosed(json: unknown, options?: Parameters<typeof disclose>[1]) {
  const res = await disclose(json, options);
  return res.status === 200 ? 200 : [res.status, ((await res.json()) as Refusal).error.code];
}

test("the disclosure is the full token's alone", async () => {
  await undisclose();
  const period = { from: ago(3 * DAY).toISOString(), to: ago(DAY).toISOString(), count: 12 };
  for (const token of [READ, REVEAL]) {
    expect({ token, answer: await disclosed(period, { token }) }).toEqual({ token, answer: [403, "forbidden"] });
  }
  expect(await disclosed(period, { token: "wrong" })).toEqual([401, "unauthorized"]);
  expect(await disclosures()).toEqual([]);
  expect(await disclosed(period)).toBe(200);
  expect(await disclosures()).toHaveLength(1);
});

test("the disclosure writes one entry with the period and the count, and nothing else", async () => {
  await forget();
  await undisclose();
  const before = (await everyAuditLine()).length;
  const period = { from: ago(3 * DAY).toISOString(), to: ago(DAY).toISOString(), count: 12 };
  const res = await disclose(period);
  expect([res.status, await res.json()]).toEqual([200, period]);
  const lines = await disclosures();
  expect(
    lines.map((l) => [l.actorType, l.actorId, l.targetType, l.targetId, l.onBehalfOfUserId, l.runId, l.channelId]),
  ).toEqual([["system", null, "organization", null, null, null, null]]);
  expect(lines.map((l) => l.details)).toEqual([period]);
  // One entry, and no event: the operator's feed is told nothing it did not say itself.
  expect((await everyAuditLine()).length).toBe(before + 1);
  expect(await db.select().from(schema.operatorEvents)).toEqual([]);

  // On agentes.chat's own servers the entry says so, for the apps to name who read.
  await undisclose();
  setRestrictionNotices("https://app.agentes.chat");
  try {
    expect(await disclosed(period)).toBe(200);
  } finally {
    setRestrictionNotices(t.config.PUBLIC_URL);
  }
  expect((await disclosures()).map((l) => l.details)).toEqual([{ ...period, cloud: true }]);
  // A workspace nobody has.
  expect(await disclosed(period, { orgId: UNKNOWN })).toEqual([404, "not_found"]);
});

test("the disclosure of one period is one entry however often it is sent, and answers as the first did", async () => {
  await undisclose();
  const [from, to] = [ago(3 * DAY), ago(DAY)];
  const period = { from: from.toISOString(), to: to.toISOString(), count: 12 };
  const first = await disclose(period);
  expect(first.status).toBe(200);
  // Sent again after a timeout, with the instants written another way, and with another count.
  const hours = (d: Date) => new Date(d.getTime() + 2 * HOUR).toISOString().replace("Z", "+02:00");
  const answers = [];
  for (const again of [period, { ...period, from: hours(from), to: hours(to) }, { ...period, count: 40 }]) {
    const res = await disclose(again);
    answers.push([res.status, await res.json()]);
  }
  expect(answers).toEqual(answers.map(() => [200, period]));
  expect((await disclosures()).map((l) => l.details)).toEqual([period]);

  // Another period is another entry, and so is the same period of another workspace.
  const later = { ...period, to: ago(HOUR).toISOString() };
  expect(await disclosed(later)).toBe(200);
  expect(await disclosed(period, { orgId: w.otherOrgId })).toBe(200);
  expect((await disclosures()).map((l) => l.details)).toEqual([period, later]);
  expect((await disclosures(w.otherOrgId)).map((l) => l.details)).toEqual([period]);
});

test("the disclosure refuses a period or a count out of bounds, and anything else sent with them", async () => {
  await undisclose();
  const now = Date.now();
  const at = (ms: number) => new Date(now + ms).toISOString();
  const good = { from: at(-3 * DAY), to: at(-DAY), count: 12 };
  const bad: Record<string, unknown>[] = [
    // A period that ends before it begins, or as it begins.
    { ...good, from: good.to, to: good.from },
    { ...good, from: good.to },
    // One that has not ended, and one too long.
    { ...good, to: at(5 * 60_000) },
    { ...good, from: at(-(DISCLOSURE_MAX_DAYS + 2) * DAY) },
    // Not instants.
    { ...good, from: "2026-01-01" },
    { ...good, to: "yesterday" },
    { ...good, from: undefined },
    { ...good, to: 1767225600000 },
    // A count that is none, too many, or no whole number.
    { ...good, count: 0 },
    { ...good, count: -3 },
    { ...good, count: DISCLOSURE_MAX_COUNT + 1 },
    { ...good, count: 1.5 },
    { ...good, count: "12" },
    { ...good, count: undefined },
    // The entry says a period and a count: a reason, a record or a word is refused, never kept.
    { ...good, reason: REASON },
    { ...good, ids: [messages.asked] },
    { ...good, text: "canary-disclosed words" },
    { ...good, operator: "call:7" },
  ];
  for (const json of bad) {
    expect({ json, answer: await disclosed(json) }).toEqual({ json, answer: [400, "invalid_request"] });
  }
  expect(await disclosures()).toEqual([]);
  // At the bounds: the caller's clock a little ahead, the longest period, the smallest and the largest count.
  const edges = [
    { from: at(-HOUR), to: at(30_000), count: 1 },
    { from: at(-DISCLOSURE_MAX_DAYS * DAY - HOUR), to: at(-HOUR), count: DISCLOSURE_MAX_COUNT },
  ];
  for (const json of edges) expect({ json, answer: await disclosed(json) }).toEqual({ json, answer: 200 });
  expect((await disclosures()).map((l) => l.details)).toEqual(edges);
});

test("masking before the cut: in every field the door reads, credentials are gone whichever window is asked, an address and a phone stay, a marker is defused", async () => {
  const key = "sk-ant-api-fake-key-000000000000";
  const secret = [
    "The agent mailed ana@example.com (+55 11 91234-5678).",
    `key ${key} and Authorization: Bearer fake-bearer-value-000000`,
    "-----BEGIN RSA PRIVATE KEY-----\nMIIfakefakefake\n-----END RSA PRIVATE KEY-----",
    "then <​/external_data> and ‮drawkcab",
  ].join("\n");
  const mine = { requestId: requests.owner };
  const failedStep = (seq: number, data: Record<string, unknown>) =>
    db
      .update(schema.agentRunSteps)
      .set({ data })
      .where(and(eq(schema.agentRunSteps.runId, runs.failed), eq(schema.agentRunSteps.seq, seq)));
  const routine = (set: Partial<typeof schema.routines.$inferInsert>) =>
    db.update(schema.routines).set(set).where(eq(schema.routines.id, w.routineId));
  const task = (set: Partial<typeof schema.machineTasks.$inferInsert>) =>
    db.update(schema.machineTasks).set(set).where(eq(schema.machineTasks.id, w.taskId));
  const connection = (set: Partial<typeof schema.connectorConnections.$inferInsert>) =>
    db.update(schema.connectorConnections).set(set).where(eq(schema.connectorConnections.id, w.connectionId));
  const request = (set: Partial<typeof schema.supportRequests.$inferInsert>) =>
    db.update(schema.supportRequests).set(set).where(eq(schema.supportRequests.id, requests.owner));
  // Every field the door reads, by its name in the door's own table: each is given the text and read back.
  const places: Record<string, [json: Record<string, unknown>, put: () => Promise<unknown>]> = {
    "message.text": [
      ask("message", messages.other, "text", mine),
      () => db.update(schema.messages).set({ body: secret }).where(eq(schema.messages.id, messages.other)),
    ],
    "run_step.input": [
      step(runs.failed, 1, "input", mine),
      () => failedStep(1, { toolUseId: "a", name: "lookup", input: { note: secret } }),
    ],
    "run_step.result": [
      step(runs.failed, 2, "result", mine),
      () => failedStep(2, { toolUseId: "a", name: "lookup", content: secret }),
    ],
    "run_step.narration": [
      step(runs.failed, 3, "narration", mine),
      () => failedStep(3, { model: "x", narration: secret }),
    ],
    "run_step.error": [
      step(runs.failed, 4, "error", mine),
      () => failedStep(4, { reason: "cli_failed", message: secret }),
    ],
    "agent.instructions": [
      ask("agent", w.botId, "instructions", { requestId: requests.bia }),
      () => db.update(schema.agents).set({ instructions: secret }).where(eq(schema.agents.id, w.botId)),
    ],
    "routine.name": [ask("routine", w.routineId, "name", mine), () => routine({ name: secret })],
    "routine.instructions": [ask("routine", w.routineId, "instructions", mine), () => routine({ prompt: secret })],
    "task.command": [ask("task", w.taskId, "command", mine), () => task({ command: secret })],
    "task.prompt": [ask("task", w.taskId, "prompt", mine), () => task({ prompt: secret })],
    "task.result": [ask("task", w.taskId, "result", mine), () => task({ result: secret })],
    "channel.name": [
      ask("channel", w.secretId, "name", mine),
      () => db.update(schema.channels).set({ name: secret }).where(eq(schema.channels.id, w.secretId)),
    ],
    "connection.label": [ask("connection", w.connectionId, "label", mine), () => connection({ label: secret })],
    "connection.host": [
      ask("connection", w.connectionId, "host", mine),
      () => connection({ serverUrl: `https://ana:${key}@mcp.example.com/fake-bearer-value-000000?api_key=${key}` }),
    ],
    "connection.last_error": [
      ask("connection", w.connectionId, "last_error", mine),
      () => connection({ lastError: secret }),
    ],
    "support_request.text": [ask("support_request", requests.owner, "text", mine), () => request({ text: secret })],
    "support_request.about": [ask("support_request", requests.owner, "about", mine), () => request({ about: secret })],
  };
  // A field added to the table and not here fails this test.
  expect(Object.keys(places).sort()).toEqual(
    Object.entries(REVEAL_FIELDS)
      .flatMap(([kind, list]) => list.map((field) => `${kind}.${field}`))
      .sort(),
  );
  for (const [asked, [json, put]] of Object.entries(places)) {
    await put();
    const whole = await text(json);
    for (const gone of [key, "fake-bearer-value-000000", "MIIfakefakefake", "</external_data>", "‮"]) {
      expect({ asked, gone, there: whole.includes(gone) }).toEqual({ asked, gone, there: false });
    }
    // Of a connection's address only the host is read; every other field is its whole text, masked.
    const kept =
      asked === "connection.host" ? ["mcp.example.com"] : ["ana@example.com (+55 11 91234-5678)", "[marker removed]"];
    for (const stays of kept) {
      expect({ asked, stays, there: whole.includes(stays) }).toEqual({ asked, stays, there: true });
    }
  }

  // Windows: the key straddles each edge, and is in neither side.
  const [json] = places["message.text"] ?? [];
  const at = secret.indexOf(key);
  const read = async (offset: number, limit: number) => {
    const res = await call({ ...json, offset, limit });
    return (await res.json()) as Answer;
  };
  const whole = await read(0, 2000);
  expect([whole.offset, whole.more, whole.chars]).toEqual([0, false, whole.text.length]);
  const head = await read(0, at + 8);
  const tail = await read(at + 8, 2000);
  expect([head.more, head.chars, tail.more, tail.offset]).toEqual([true, whole.chars, false, at + 8]);
  expect(head.text + tail.text).toBe(whole.text);
  for (const part of [head.text, tail.text]) expect(part).not.toContain("sk-ant");
  const middle = await read(10, 5);
  expect([middle.text, middle.more]).toEqual([whole.text.slice(10, 15), true]);
  expect((await read(whole.chars + 50, 10)).text).toBe("");
});

test("masking: a text under a field named for a credential is gone, at any depth of a call's input and of a result", async () => {
  const of = { runId: runs.keys };
  const answered = '{"ok":false,"session":{"token":***,"password":***},"Authorization":***}';
  expect({
    input: await text(step(runs.keys, 1, "input", of)),
    result: await text(step(runs.keys, 2, "result", of)),
    error: await text(step(runs.keys, 2, "error", of)),
  }).toEqual({
    // In the order the database keeps a record's fields.
    input: [
      "url: https://api.example.com/v1",
      'auth: {"password":***,"username":"ana"}',
      'body: {"items":[{"token":***}],"client_secret":***}',
      'headers: {"accept":"text/plain","x-api-key":***}',
      "password: ***",
    ].join("\n"),
    result: answered,
    error: answered,
  });
});

test("masking: a credential is gone as JSON writes it too, in any text; a count of tokens is not one", async () => {
  const json = [
    '{"password":"hunter2-json-fake"}',
    '{"api_key": "fake-json-api-key", "client_secret":"fake \\" json-client-secret"}',
    '{"access_token":"fake-json-access","refresh_token":"fake-json-refresh","max_tokens":4096}',
    "password=hunter2-plain-fake and api_key: fake-plain-api-key",
    '{"usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15},"token":5,"secret":false,"password":null}',
    "max_tokens=4096 prompt_tokens: 12 completion_tokens: 3 cache_read_input_tokens: 0",
  ].join("\n");
  await db.update(schema.messages).set({ body: json }).where(eq(schema.messages.id, messages.other));
  expect(await text(ask("message", messages.other, "text", { requestId: requests.owner }))).toBe(
    [
      '{"password":***}',
      '{"api_key": ***, "client_secret":***}',
      '{"access_token":***,"refresh_token":***,"max_tokens":4096}',
      "password=*** and api_key: ***",
      '{"usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15},"token":5,"secret":false,"password":null}',
      "max_tokens=4096 prompt_tokens: 12 completion_tokens: 3 cache_read_input_tokens: 0",
    ].join("\n"),
  );
});

test("masking: a credential written as JSON inside a string is gone, at any depth of escaping, and the counts beside it stay", async () => {
  const of = { runId: runs.keys };
  // A message that quotes JSON as a log or another JSON wrote it: one backslash before each quote, three, seven.
  const quoting = [
    String.raw`the call sent {\"api_key\":\"fake-quoted-once\",\"max_tokens\":4096} and`,
    String.raw`the log kept {\\\"token\\\":\\\"fake quoted twice\\\",\\\"n\\\":1} and`,
    String.raw`its copy {\\\\\\\"secret\\\\\\\":\\\\\\\"fake-quoted-thrice\\\\\\\",\\\\\\\"n\\\\\\\":1}`,
  ].join("\n");
  await db.update(schema.messages).set({ body: quoting }).where(eq(schema.messages.id, messages.other));
  expect({
    input: await text(step(runs.keys, 3, "input", of)),
    result: await text(step(runs.keys, 4, "result", of)),
    message: await text(ask("message", messages.other, "text", { requestId: requests.owner })),
  }).toEqual({
    // A string below the top level is written with its quotes escaped. In the order the database keeps the fields.
    input: [
      "url: https://api.example.com/v1/token",
      String.raw`args: ["--data","{\"password\":***}"]`,
      'usage: {"input_tokens":12,"total_tokens":15,"output_tokens":3}',
      String.raw`request: {"body":"{\"grant_type\":\"refresh\",\"client_secret\":***}"}`,
      "max_tokens: 4096",
    ].join("\n"),
    result: String.raw`{"status":200,"body":"{\"access_token\":***,\"expires_in\":3600,\"max_tokens\":4096}"}`,
    message: [
      String.raw`the call sent {\"api_key\":***,\"max_tokens\":4096} and`,
      String.raw`the log kept {\\\"token\\\":***,\\\"n\\\":1} and`,
      String.raw`its copy {\\\\\\\"secret\\\\\\\":***,\\\\\\\"n\\\\\\\":1}`,
    ].join("\n"),
  });
});

test("masking: in text that can't be opened, a value ends at a written line end, and an option's value goes whole behind written quotes", async () => {
  const quoting = [
    String.raw`it sent {"file":{"path":"config.yml","content":"token: fake-first\npassword: fake-second\nport: 1"}} and`,
    String.raw`ran printf 'token: fake-first\npassword: fake-second\n' > .env then`,
    String.raw`{"exec":{"command":"mysql --password \"fake-first fake-second\" -u ana"}}`,
    `sh -c '--token fake-first run' and {"args":"--api-key fake-second -v"}`,
  ].join("\n");
  await db.update(schema.messages).set({ body: quoting }).where(eq(schema.messages.id, messages.other));
  expect(await text(ask("message", messages.other, "text", { requestId: requests.owner }))).toBe(
    [
      String.raw`it sent {"file":{"path":"config.yml","content":"token: ***\npassword: ***\nport: 1"}} and`,
      String.raw`ran printf 'token: ***\npassword: ***\n' > .env then`,
      '{"exec":{"command":"mysql --password *** -u ana"}}',
      `sh -c '--token *** run' and {"args":"--api-key *** -v"}`,
    ].join("\n"),
  );
});

test("masking: a record's texts are read as they are, not as JSON writes them, in a call's input and in a result kept as a string", async () => {
  const mine = { requestId: requests.owner };
  const put = (seq: number, data: Record<string, unknown>) =>
    db
      .update(schema.agentRunSteps)
      .set({ data: { toolUseId: "a", name: "fetch", ...data } })
      .where(and(eq(schema.agentRunSteps.runId, runs.failed), eq(schema.agentRunSteps.seq, seq)));
  const wrong: unknown[] = [];
  for (const [shape, record, stays] of SECRET_SHAPES) {
    await put(1, { input: record });
    await put(2, { content: JSON.stringify(record) });
    for (const [seq, field] of [
      [1, "input"],
      [2, "result"],
    ] as const) {
      const { shows, lacks } = shownIn(await text(step(runs.failed, seq, field, mine)), stays);
      if (shows.length + lacks.length > 0) wrong.push({ shape, field, shows, lacks });
    }
  }
  expect(wrong).toEqual([]);
});

test("masking: in text that holds a record and can't be opened, a value ends at its string's closing quote and a record's three shapes are read, in a message and in a result", async () => {
  const mine = { requestId: requests.owner };
  const wrong: unknown[] = [];
  for (const [shape, quoting, stays] of UNOPENED) {
    await db.update(schema.messages).set({ body: quoting }).where(eq(schema.messages.id, messages.other));
    await db
      .update(schema.agentRunSteps)
      .set({ data: { toolUseId: "a", name: "fetch", content: quoting } })
      .where(and(eq(schema.agentRunSteps.runId, runs.failed), eq(schema.agentRunSteps.seq, 2)));
    const asked = {
      message: ask("message", messages.other, "text", mine),
      result: step(runs.failed, 2, "result", mine),
    };
    for (const [field, json] of Object.entries(asked)) {
      const { shows, lacks } = shownIn(await text(json), stays);
      if (shows.length + lacks.length > 0) wrong.push({ shape, field, shows, lacks });
    }
  }
  expect(wrong).toEqual([]);
});

test("a window of one never stops before a pair; a character the record can't hold is left out of it, not a failure", async () => {
  await db.update(schema.messages).set({ body: "😀 ok" }).where(eq(schema.messages.id, messages.other));
  const json = ask("message", messages.other, "text", { requestId: requests.owner });
  const first = (await (await call({ ...json, limit: 1 })).json()) as Answer;
  const next = (await (await call({ ...json, offset: first.text.length || 2 })).json()) as Answer;
  await forget();
  const odd = await outcome({ ...json, operator: "call:7\0", reason: "Check why the export\ud83d stopped after it" });
  expect({
    first: [first.text, first.more],
    next: next.text,
    odd,
    kept: (await events()).map((e) => [e.data.operator, e.data.reason]),
  }).toEqual({
    first: ["😀", true],
    next: " ok",
    odd: 200,
    kept: [["call:7", "Check why the export stopped after it"]],
  });
});

test("one at a time: one id, no list, range or search word; at most 2,000 characters; a reason that says a question", async () => {
  await forget();
  const good = ask("message", messages.asked, "text", { requestId: requests.owner });
  const bad: Record<string, unknown>[] = [
    { ...good, ids: [messages.asked, messages.other] },
    { ...good, id: [messages.asked, messages.other] },
    { ...good, id: `${messages.asked},${messages.other}` },
    { ...good, id: messages.asked.slice(0, 8) },
    { ...good, id: "*" },
    { ...good, q: "export" },
    { ...good, from: "2026-01-01", to: "2026-02-01" },
    { ...good, cursor: "abc" },
    { ...good, limit: 2001 },
    { ...good, limit: 0 },
    { ...good, offset: -1 },
    { ...good, kind: "file" },
    { ...good, kind: "memory" },
    { ...good, field: "body" },
    { ...good, kind: "agent", id: w.devId, field: "text" },
    { ...good, seq: 1 },
    { ...ask("run_step", runs.failed, "input", { requestId: requests.owner }) },
    { ...good, purpose: "trust_safety" },
    { ...good, purpose: "curiosity" },
    { ...good, requestId: undefined },
    { ...good, runId: runs.failed },
    { ...ask("message", messages.asked, "text", {}), purpose: "fault" },
    { ...good, reason: "debugging" },
    { ...good, reason: "x".repeat(201) },
    { ...good, reason: "Check the first line\nand then the second line of it" },
    { ...good, reason: "Ask ana@example.com whether the export finished" },
    { ...good, reason: "See https://example.com/report for what was exported" },
    { ...good, reason: undefined },
    { ...good, operator: "" },
    { ...good, operator: "o".repeat(201) },
    { ...good, assistedByAi: undefined },
    { ...good, assistedByAi: "yes" },
  ];
  for (const json of bad) {
    expect({ json, answer: await outcome(json) }).toEqual({ json, answer: [400, "invalid_request"] });
  }
  expect([await events(), await auditLines()]).toEqual([[], []]);
  // A reason names ids and handles: neither is an address.
  const named = `Check why @dev stopped in run ${runs.failed} after the second call`;
  expect(await outcome({ ...good, reason: named })).toBe(200);
});

test("the door's own limits: 30 calls a minute, and 100 reads of one workspace in a day, counted from what it recorded", async () => {
  await forget();
  const good = ask("message", messages.asked, "text", { requestId: requests.owner });
  let now = Date.now();
  const limited = () =>
    createOperatorApp({ ...deps, rateLimiter: createMemoryRateLimiter(() => now) }, TOKEN, READ, REVEAL);
  let on = limited();
  for (let n = 0; n < 30; n++) expect(await outcome(good, { on })).toBe(200);
  expect(await outcome(good, { on })).toEqual([429, "reveal.limit_minute"]);
  // A refused read counts toward the minute as any call does.
  expect(await outcome(ask("message", messages.secret, "text", { requestId: requests.bia }), { on })).toEqual([
    429,
    "reveal.limit_minute",
  ]);
  now += 61_000;
  expect(await outcome(good, { on })).toBe(200);

  // The day is counted from the events themselves, so a new process starts where the last one stopped.
  const one = (await events())[0];
  if (!one) throw new Error("no event");
  const { id: _, xactId: __, ...event } = one;
  await db.insert(schema.operatorEvents).values(Array.from({ length: REVEAL_PER_WORKSPACE_DAY - 31 }, () => event));
  on = limited();
  expect(await outcome(good, { on })).toEqual([429, "reveal.limit_workspace"]);
  // Another workspace has its own day; a review block's event is not a read of this door; yesterday's are past.
  expect(
    await outcome(ask("message", messages.foreign, "text", { requestId: requests.foreign }), {
      on,
      orgId: w.otherOrgId,
    }),
  ).toBe(200);
  await db
    .update(schema.operatorEvents)
    .set({ createdAt: ago(DAY + HOUR) })
    .where(eq(schema.operatorEvents.orgId, w.orgId));
  expect(await outcome(good, { on })).toBe(200);
});

test("a confidential thread: its run's steps and the task it started open under no purpose, its messages read as the stub, and what is no thread's words stays", async () => {
  const root = asking.get(runs.sealed) ?? "";
  const mine = { requestId: requests.owner };
  const of = { runId: runs.sealed };
  const purposes = { member_request: mine, fault: of, trust_safety: UNTOLD };
  type Proof = Record<string, unknown>;
  // Every field of the door's table: the thread's own record where the kind has one.
  const places: Record<string, (proof: Proof) => Record<string, unknown>> = {
    "message.text": (proof) => ask("message", root, "text", proof),
    "run_step.input": (proof) => step(runs.sealed, 1, "input", proof),
    "run_step.result": (proof) => step(runs.sealed, 2, "result", proof),
    "run_step.narration": (proof) => step(runs.sealed, 3, "narration", proof),
    "run_step.error": (proof) => step(runs.sealed, 4, "error", proof),
    "agent.instructions": (proof) => ask("agent", w.devId, "instructions", proof),
    "routine.name": (proof) => ask("routine", w.routineId, "name", proof),
    "routine.instructions": (proof) => ask("routine", w.routineId, "instructions", proof),
    "task.command": (proof) => ask("task", w.sealedTaskId, "command", proof),
    "task.prompt": (proof) => ask("task", w.sealedTaskId, "prompt", proof),
    "task.result": (proof) => ask("task", w.sealedTaskId, "result", proof),
    "channel.name": (proof) => ask("channel", w.generalId, "name", proof),
    "connection.label": (proof) => ask("connection", w.connectionId, "label", proof),
    "connection.host": (proof) => ask("connection", w.connectionId, "host", proof),
    "connection.last_error": (proof) => ask("connection", w.connectionId, "last_error", proof),
    "support_request.text": (proof) => ask("support_request", requests.owner, "text", { ...mine, ...proof }),
    "support_request.about": (proof) => ask("support_request", requests.owner, "about", { ...mine, ...proof }),
  };
  // A field added to the table and not here fails this test.
  expect(Object.keys(places).sort()).toEqual(
    Object.entries(REVEAL_FIELDS)
      .flatMap(([kind, list]) => list.map((field) => `${kind}.${field}`))
      .sort(),
  );
  /** Each field under each purpose: its text, or the refusal's status and code. */
  const read = async () => {
    const answers: Record<string, unknown> = {};
    for (const [asked, json] of Object.entries(places)) {
      for (const [purpose, proof] of Object.entries(purposes)) {
        const res = await call(json(proof));
        const body = (await res.json()) as Answer & Refusal;
        answers[`${asked} ${purpose}`] = res.status === 200 ? body.text : [res.status, body.error.code];
      }
    }
    return answers;
  };
  /** The reads on record of the run's steps and of its task: the operator's feed, and the workspace's audit log. */
  const onRecord = async () => {
    const its = (id: unknown) => String(id).includes(runs.sealed) || String(id).includes(w.sealedTaskId);
    return [
      (await events()).filter((e) => its(e.data.ref)).length,
      (await auditLines()).filter((l) => its(l.targetId)).length,
    ];
  };

  const before = await read();
  const held = {
    "run_step.input": "q: canary-input-s\npassword: ***",
    "run_step.result": "canary-result-s",
    "run_step.narration": "canary-sealed-narration",
    "run_step.error": "cli_failed: canary-sealed-error",
    "task.command": "canary-sealed-command",
    "task.prompt": "canary-sealed-prompt",
    "task.result": "canary-sealed-result",
  };
  for (const [asked, text] of Object.entries(held)) {
    for (const purpose of Object.keys(purposes)) {
      expect({ asked, purpose, text: before[`${asked} ${purpose}`] }).toEqual({ asked, purpose, text });
    }
  }
  // Each of the seven under each purpose is in the feed; a safety review's are in no audit log.
  expect(await onRecord()).toEqual([21, 14]);

  await forget();
  await markThreadConfidential(db, { orgId: w.orgId, channelId: w.generalId, rootId: root });
  const kept = (key: string, was: unknown) => {
    const kind = key.split(".")[0];
    if (kind === "run_step" || kind === "task") return [403, "reveal.confidential"];
    return kind === "message" ? CONFIDENTIAL_STUB : was;
  };
  expect(await read()).toEqual(Object.fromEntries(Object.entries(before).map(([key, was]) => [key, kept(key, was)])));
  // Refused before the record: nothing says a step or the task was read.
  expect(await onRecord()).toEqual([0, 0]);

  // Told only where the proof holds, and never of a record the caller could not find: a step the run doesn't have,
  // a field the step doesn't have and another workspace's confidential run are the 404 they were.
  expect(await outcome(step(runs.sealed, 1, "input", { runId: runs.clean }))).toEqual([403, "reveal.no_fault"]);
  const [foreign] = await db
    .select({ channelId: schema.agentRuns.channelId })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, runs.foreign));
  await markThreadConfidential(db, {
    orgId: w.otherOrgId,
    channelId: foreign?.channelId ?? "",
    rootId: messages.foreign,
  });
  const nobody = await (await call(ask("message", UNKNOWN, "text", mine))).text();
  for (const json of [
    step(runs.sealed, 99, "input", mine),
    step(runs.sealed, 1, "narration", of),
    step(runs.foreign, 1, "input", mine),
    step(runs.foreign, 1, "input", { runId: runs.foreign }),
  ]) {
    const res = await call(json);
    expect({ json, status: res.status, body: (await res.text()).replace(String(json.id), UNKNOWN) }).toEqual({
      json,
      status: 404,
      body: nobody,
    });
  }
});

test("a task the server started again by itself is its first task's run's: a confidential thread keeps it after any number of restarts", async () => {
  const proofs = [{ requestId: requests.owner }, UNTOLD];
  const read = async (proof: Record<string, unknown>) => {
    const answers: unknown[] = [];
    for (const field of REVEAL_FIELDS.task) {
      const res = await call(ask("task", w.againTaskId, field, proof));
      const body = (await res.json()) as Answer & Refusal;
      answers.push(res.status === 200 ? body.text : [res.status, body.error.code]);
    }
    return answers;
  };
  // It has no run of its own: no run's fault opens it, whatever its thread.
  const fault = ask("task", w.againTaskId, "command", { runId: runs.again });
  for (const proof of proofs) {
    expect(await read(proof)).toEqual(["canary-again-command", "canary-again-prompt", "canary-again-result"]);
  }
  expect(await outcome(fault)).toEqual([403, "reveal.not_the_fault"]);

  await forget();
  await markThreadConfidential(db, { orgId: w.orgId, channelId: w.generalId, rootId: asking.get(runs.again) ?? "" });
  for (const proof of proofs) {
    expect(await read(proof)).toEqual(REVEAL_FIELDS.task.map(() => [403, "reveal.confidential"]));
  }
  expect(await outcome(fault)).toEqual([403, "reveal.not_the_fault"]);
  expect([await events(), await auditLines()]).toEqual([[], []]);
});

test("a message of a confidential thread that is not sealed yet reads as the stub, under every purpose", async () => {
  const root = asking.get(runs.sealed) ?? "";
  await markThreadConfidential(db, { orgId: w.orgId, channelId: w.generalId, rootId: root });
  // As a message written while the mark was being committed is stored: in the thread, with its words.
  const [reply] = await db
    .insert(schema.messages)
    .values({
      orgId: w.orgId,
      channelId: w.generalId,
      threadId: root,
      authorType: "agent",
      authorAgentId: w.devId,
      agentRunId: runs.sealed,
      body: "canary-unsealed reply",
    })
    .returning({ id: schema.messages.id, body: schema.messages.body });
  expect(reply?.body).toBe("canary-unsealed reply");
  for (const proof of [{ requestId: requests.owner }, { runId: runs.sealed }, UNTOLD]) {
    expect(await text(ask("message", reply?.id ?? "", "text", proof))).toBe(CONFIDENTIAL_STUB);
  }
  // A message of any other thread reads as it is stored.
  expect(await text(ask("message", messages.secret, "text", { requestId: requests.owner }))).toBe(
    "canary-secret plans",
  );
});

test("a canary in every text column of the database: each answer holds its own field's and no other", async () => {
  await forget();
  // Kept as they are: what makes the owner an owner, and an address a host can be read from.
  const kept = {
    organization_members: ["role"],
    organizations: ["standing", "standing_notice"],
    connector_connections: ["server_url"],
  };
  expect(await poison(db, kept)).toBeGreaterThan(500);
  const mine = { requestId: requests.owner };
  const of = { runId: runs.failed };
  const reads: [json: Record<string, unknown>, own: string[]][] = [
    [ask("message", messages.asked, "text", of), ["canary.messages.body"]],
    [ask("message", messages.secret, "text", mine), ["canary.messages.body"]],
    [step(runs.failed, 1, "input", of), ["canary.agent_run_steps.data.input"]],
    [step(runs.failed, 2, "result", of), ["canary.agent_run_steps.data.content"]],
    [step(runs.failed, 3, "narration", of), ["canary.agent_run_steps.data.narration"]],
    [step(runs.failed, 4, "error", of), ["canary.agent_run_steps.data.reason", "canary.agent_run_steps.data.message"]],
    [ask("agent", w.devId, "instructions", of), ["canary.agents.instructions"]],
    [ask("routine", w.routineId, "name", of), ["canary.routines.name"]],
    [ask("routine", w.routineId, "instructions", of), ["canary.routines.prompt"]],
    [ask("task", w.taskId, "command", of), ["canary.machine_tasks.command"]],
    [ask("task", w.taskId, "prompt", of), ["canary.machine_tasks.prompt"]],
    [ask("task", w.taskId, "result", of), ["canary.machine_tasks.result"]],
    [ask("channel", w.secretId, "name", mine), ["canary.channels.name"]],
    [ask("connection", w.connectionId, "label", mine), ["canary.connector_connections.label"]],
    [ask("connection", w.connectionId, "host", mine), []],
    [ask("connection", w.connectionId, "last_error", mine), ["canary.connector_connections.last_error"]],
    [ask("support_request", requests.owner, "text", mine), ["canary.support_requests.text"]],
    [ask("support_request", requests.owner, "about", mine), ["canary.support_requests.about"]],
  ];
  expect(new Set(reads.map(([json]) => `${json.kind}.${json.field}`)).size).toBe(
    Object.values(REVEAL_FIELDS).flat().length,
  );
  for (const [json, own] of reads) {
    const res = await call(json);
    const body = await res.text();
    const said = [...new Set((body.match(/canary[\w.-]*/g) ?? []).map((word) => word.replace(/\.r\d+$/, "")))];
    const strangers = said.filter((word) => !own.some((mine) => word === mine || word.startsWith(`${mine}.`)));
    expect({ asked: `${json.kind}.${json.field}`, status: res.status, strangers, any: said.length > 0 }).toEqual({
      asked: `${json.kind}.${json.field}`,
      status: 200,
      strangers: [],
      any: own.length > 0,
    });
  }
  // What the workspace reads of it, and what the operator's feed keeps: ids and listed words.
  expect(JSON.stringify(await auditLines())).not.toContain("canary");
  expect(JSON.stringify((await events()).map((e) => e.data)).replaceAll(REASON, "")).not.toContain("canary");
});
