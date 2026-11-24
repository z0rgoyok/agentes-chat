import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Database, eq, rowsOf, schema, sql } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { RUN_STATE_KEYS, runState } from "../src/run-state";

let db: Database;
let close: () => Promise<void>;
let runId: string;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  const [org] = await db.insert(schema.organizations).values({ name: "Acme" }).returning();
  const orgId = org?.id ?? "";
  const [agent] = await db
    .insert(schema.agents)
    .values({ orgId, name: "Dev", handle: "dev", model: "claude-sonnet-5-5" })
    .returning();
  const [run] = await db
    .insert(schema.agentRuns)
    .values({
      orgId,
      agentId: agent?.id ?? "",
      channelId: crypto.randomUUID(),
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
      trigger: "mention",
      hop: 1,
    })
    .returning();
  runId = run?.id ?? "";
});
afterEach(() => close());

const stateOf = async () =>
  (await db.select({ state: schema.agentRuns.state }).from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)))[0]
    ?.state;

test("every write of the transcript copies its status keys to state, as they are, and nothing else", async () => {
  expect(await stateOf()).toEqual({});
  const status = Object.fromEntries(RUN_STATE_KEYS.map((k, i) => [k, i % 3 === 0 ? null : { k, i }]));
  const transcript = { ...status, messages: [{ role: "user", content: "hi" }], interruptedTurn: { cause: "x" } };
  await db.update(schema.agentRuns).set({ transcript }).where(eq(schema.agentRuns.id, runId));
  expect(await stateOf()).toEqual(status);

  // A partial write in SQL, a key gone: the copy follows.
  await db
    .update(schema.agentRuns)
    .set({ transcript: sql`jsonb_set(${schema.agentRuns.transcript} - 'outage', '{roomPeople}', 'true'::jsonb)` })
    .where(eq(schema.agentRuns.id, runId));
  const { outage: _gone, ...rest } = status;
  expect(await stateOf()).toEqual({ ...rest, roomPeople: true });

  // A write of other columns leaves it; a transcript taken away empties it.
  await db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, runId));
  expect(await stateOf()).toEqual({ ...rest, roomPeople: true });
  await db.update(schema.agentRuns).set({ transcript: null }).where(eq(schema.agentRuns.id, runId));
  expect(await stateOf()).toEqual({});
});

test("the trigger copies exactly RUN_STATE_KEYS", async () => {
  const every = Object.fromEntries(
    [...RUN_STATE_KEYS, "messages", "pending", "system", "harnessTried"].map((k) => [k, 1]),
  );
  const [row] = rowsOf<{ keys: string[] }>(
    await db.execute(
      sql`select array(select jsonb_object_keys(agent_runs_state_of(${JSON.stringify(every)}::jsonb))) as keys`,
    ),
  );
  expect(row?.keys.sort()).toEqual([...RUN_STATE_KEYS].sort());
});

test("runState reads the transcript of a run whose state was never written", async () => {
  await db
    .update(schema.agentRuns)
    .set({ transcript: { waitingForBrain: { code: "busy" }, messages: [] } })
    .where(eq(schema.agentRuns.id, runId));
  await db.update(schema.agentRuns).set({ state: null }).where(eq(schema.agentRuns.id, runId));
  const code = sql<string | null>`${runState}->'waitingForBrain'->>'code'`;
  const [row] = await db.select({ code }).from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
  expect(row?.code).toBe("busy");
});
