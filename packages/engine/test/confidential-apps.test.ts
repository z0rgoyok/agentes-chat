import { afterEach, expect, test } from "bun:test";
import { createMemoryRateLimiter } from "@agenteschat/adapters";
import { eq, schema, sql } from "@agenteschat/db";
import { type AppPrincipal, CONFIDENTIAL_STUB, createAppsMcpHandler } from "../src";
import { closeWorlds } from "./autonomy/harness";
import { CANARY, type VaultWorld, vaultWorld } from "./confidential-fixtures";

// ADR 0190: a person's connected AI app acts as the person, and what its tools answer is read by the app's model,
// which is outside every thread. So a confidential message reaches it as the stub, with nothing attached.

afterEach(closeWorlds);

/** What a person pasted in the thread's root, before any mark. */
const ROOT = "quokkaplan";
/** The name of a file the agent's reply carries. */
const FILE = "ibexsheet";
/** What the run's error says. */
const ERROR = "okapifault";

const READ = { name: "vault_read_record", input: { id: "r1" } };

/** `/mcp` as one person's app calls it: each call's whole answer, as text and as data. */
async function appOf(w: VaultWorld) {
  const [grant] = await w.db
    .insert(schema.appGrants)
    .values({
      orgId: w.org.id,
      userId: w.owner.id,
      kind: "token",
      displayKind: "token",
      displayName: "Test app",
      scopes: ["read", "write", "manage"],
    })
    .returning({ id: schema.appGrants.id });
  const principal: AppPrincipal = {
    grantId: grant?.id ?? "",
    orgId: w.org.id,
    orgName: "Acme",
    userId: w.owner.id,
    personName: "Ana",
    scopes: ["read", "write", "manage"],
    app: { name: "Test app", brand: null, host: null, kind: "token" },
    refusal: null,
  };
  const serve = createAppsMcpHandler(
    { db: w.db, pubsub: w.f.pubsub, rateLimiter: createMemoryRateLimiter(), publicUrl: "https://chat.example.com" },
    { version: "test", maxBodyBytes: 131_072 },
  );
  let id = 0;
  return async (name: string, args: Record<string, unknown>) => {
    const res = await serve(
      new Request("https://chat.example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
      }),
      principal,
    );
    const text = await res.text();
    const { result } = JSON.parse(text) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    if (!result || result.isError) throw new Error(`${name}: ${text}`);
    return { text, data: result.structuredContent ?? {} };
  };
}

type Reply = { untrusted_text: string; attachments: unknown[] };

/** A thread whose run read the record and answered with a file attached, and the app of a person who reads it. */
async function scenario() {
  const w: VaultWorld = await vaultWorld({
    agents: ["kai"],
    script: {
      kai: ({ n }) => (n === 1 ? { calls: [READ] } : { text: `The record says ${CANARY}, as the paste did.` }),
    },
  });
  const asked = await w.say(`@kai a customer pasted this: ${ROOT}. Read record r1.`);
  await w.settle();
  const [reply] = await w.posts("kai");
  if (!reply) throw new Error("kai never answered");
  await w.db
    .update(schema.messages)
    .set({ meta: sql`${schema.messages.meta} || ${JSON.stringify({ artifacts: [{ title: `${FILE}.csv` }] })}::jsonb` })
    .where(eq(schema.messages.id, reply.id));
  // The words are there for the people of the thread, so each test looks for something real.
  expect(reply.meta.sealedBody).toContain(CANARY);
  return { w, asked, call: await appOf(w) };
}

const clean = (text: string) => {
  for (const word of [CANARY, ROOT, FILE, ERROR]) expect(text).not.toContain(word);
};

test("read_conversation hands a confidential thread out as stubs with nothing attached, by each of its ways in", async () => {
  const { w, asked, call } = await scenario();
  // The thread, the task, and the channel that holds the thread's root.
  for (const args of [{ thread_id: asked.id }, { task_id: asked.id }, { channel_id: w.channelId }]) {
    const read = await call("read_conversation", args);
    clean(read.text);
    const messages = read.data.messages as Reply[];
    expect(messages.length).toBe("channel_id" in args ? 1 : 2);
    for (const m of messages) expect(m).toMatchObject({ untrusted_text: CONFIDENTIAL_STUB, attachments: [] });
  }
  // The tools that list things carry no message's words.
  for (const [name, args] of [
    ["list_recent_tasks", {}],
    ["list_recent_tasks", { scope: "working" }],
    ["list_agents", {}],
    ["list_channels", {}],
    ["import_summary", {}],
    ["list_skills", {}],
  ] as const)
    clean((await call(name, args)).text);
});

test("wait_for_reply and send_to_agent answer with the agent's reply as the stub, with nothing attached", async () => {
  const { w, asked, call } = await scenario();
  const waited = await call("wait_for_reply", { task_id: asked.id, timeout_seconds: 1 });
  clean(waited.text);
  expect(waited.data).toMatchObject({ status: "done", reply: { untrusted_text: CONFIDENTIAL_STUB, attachments: [] } });
  // Into the thread: the same key answers with the task once its run is over.
  const send = { agent: "kai", message: "and again?", channel_id: w.channelId, thread_id: asked.id, wait_seconds: 0 };
  expect((await call("send_to_agent", { ...send, idempotency_key: "again" })).data.status).toBe("still_running");
  await w.settle();
  const [, again] = await w.posts("kai");
  await w.db
    .update(schema.messages)
    .set({ meta: sql`${schema.messages.meta} || ${JSON.stringify({ artifacts: [{ title: `${FILE}.csv` }] })}::jsonb` })
    .where(eq(schema.messages.id, again?.id ?? ""));
  const answered = await call("send_to_agent", { ...send, idempotency_key: "again" });
  clean(answered.text);
  expect(answered.data).toMatchObject({
    status: "done",
    reply: { untrusted_text: CONFIDENTIAL_STUB, attachments: [] },
  });
});

test("a failed run of a confidential thread: its error, which is kept text of the run, is not handed out", async () => {
  const { w, asked, call } = await scenario();
  const [run] = await w.runs("kai");
  await w.db
    .update(schema.agentRuns)
    .set({ status: "failed", error: `provider said ${ERROR}` })
    .where(eq(schema.agentRuns.id, run?.id ?? ""));
  const failed = await call("wait_for_reply", { task_id: asked.id, timeout_seconds: 1 });
  expect(failed.data.status).toBe("failed");
  expect(failed.data.error).toBeUndefined();
  clean(failed.text);
});

test("a connected AI app reads any other conversation whole, files and a failed run's error included", async () => {
  const w: VaultWorld = await vaultWorld({
    agents: ["kai"],
    script: { kai: () => ({ text: `Nothing private here: ${CANARY}.` }) },
  });
  const asked = await w.say("@kai say the word");
  await w.settle();
  const [reply] = await w.posts("kai");
  await w.db
    .update(schema.messages)
    .set({ meta: sql`${schema.messages.meta} || ${JSON.stringify({ artifacts: [{ title: `${FILE}.csv` }] })}::jsonb` })
    .where(eq(schema.messages.id, reply?.id ?? ""));
  const call = await appOf(w);
  const read = await call("read_conversation", { channel_id: w.channelId });
  expect(read.text).toContain(CANARY);
  expect(read.text).toContain(FILE);
  const [run] = await w.runs("kai");
  await w.db
    .update(schema.agentRuns)
    .set({ status: "failed", error: `provider said ${ERROR}` })
    .where(eq(schema.agentRuns.id, run?.id ?? ""));
  expect((await call("wait_for_reply", { task_id: asked.id, timeout_seconds: 1 })).data.error).toContain(ERROR);
});
