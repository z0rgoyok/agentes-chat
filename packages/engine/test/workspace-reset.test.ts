import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, isNull, like, rowsOf, schema, sql } from "@agenteschat/db";
import {
  createFileArtifact,
  drainOutbox,
  enqueue,
  enqueueWaitingResets,
  insertMessage,
  listMachineRequests,
  ORG_RESET_JOB,
  type OutboxJob,
  postPersonMessage,
  RESET_ERASES,
  RESET_KEEPS,
  RESET_KEEPS_JOBS,
  RESET_STORED_FILES,
  RESET_TOMBSTONES,
  requestReset,
  resetWorkspace,
  scheduleDeletion,
  setDeletionHold,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const count = async (table: string, orgId = f.org.id) =>
  Number(
    rowsOf<{ n: number }>(
      await f.db.execute(sql`select count(*)::int as n from ${sql.identifier(table)} where org_id = ${orgId}::uuid`),
    )[0]?.n,
  );

const resetDeps = () => ({ db: f.db, pubsub: f.pubsub, artifacts: f.artifactDeps, blobs: f.artifactDeps.blobs });

const orgMessages = async () =>
  Number(
    rowsOf<{ n: number }>(
      await f.db.execute(sql`select count(*)::int as n from messages where org_id = ${f.org.id}::uuid`),
    )[0]?.n,
  );

describe("workspace reset", () => {
  test("every tenant table is kept, tombstoned or erased, once", async () => {
    f = await setup();
    const tables = rowsOf<{ name: string }>(
      await f.db.execute(sql`
        select distinct c.table_name as name from information_schema.columns c
        join information_schema.tables t on t.table_name = c.table_name and t.table_schema = 'public'
        where c.table_schema = 'public' and c.column_name = 'org_id' and t.table_type = 'BASE TABLE'
          and c.table_name not like 'messages\\_%'`),
    ).map((r) => r.name);
    const listed: string[] = [...RESET_KEEPS, ...RESET_TOMBSTONES, ...RESET_ERASES];
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...tables].sort());
  });

  test("every erased table that names stored bytes has them collected", async () => {
    f = await setup();
    const erased: string[] = [...RESET_ERASES];
    const stored = rowsOf<{ name: string }>(
      await f.db.execute(sql`
        select distinct table_name as name from information_schema.columns
        where table_schema = 'public' and column_name in ('blob_key', 'storage_config_id')`),
    )
      .map((r) => r.name)
      .filter((name) => erased.includes(name));
    expect(stored.sort()).toEqual([...RESET_STORED_FILES].sort());
  });

  test("the jobs it keeps are jobs the server runs", async () => {
    f = await setup();
    for (const kind of RESET_KEEPS_JOBS) expect(f.handlers[kind]).toBeFunction();
  });

  test("jobs still waiting for what it erased go with it and do nothing if they ran; the kept ones stay", async () => {
    f = await setup();
    const msg = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "oi",
    });
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: msg.id,
        triggerMessageId: msg.id,
        trigger: "mention",
        hop: 1,
      })
      .returning();
    const [routine] = await f.db
      .insert(schema.routines)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        name: "Daily",
        prompt: "Look at the build.",
        target: { type: "channel", channelId: f.general.id },
        triggerType: "schedule",
        timezone: "UTC",
        createdByUserId: f.owner.id,
      })
      .returning();
    const [routineRun] = await f.db
      .insert(schema.routineRuns)
      .values({ orgId: f.org.id, routineId: routine?.id ?? "", at: new Date(), trigger: "schedule" })
      .returning();
    const erased = {
      "agent_run.execute": { runId: run?.id },
      "message.posted": { messageId: msg.id },
      "routine.run": { routineRunId: routineRun?.id },
    };
    const later = new Date(Date.now() + 3600_000);
    for (const [kind, payload] of Object.entries(erased)) {
      await enqueue(f.db, { orgId: f.org.id, kind, payload, dedupeKey: `test:${kind}`, runAt: later });
    }
    await enqueue(f.db, { orgId: f.org.id, kind: "email.send", payload: {}, dedupeKey: "test:email", runAt: later });
    const jobs = await f.db.select().from(schema.outbox).where(like(schema.outbox.dedupeKey, "test:%"));

    await requestReset(f.db, f.owner.id, f.org.id);
    expect(await resetWorkspace(resetDeps(), f.org.id)).toBe(true);

    const left = await f.db.select().from(schema.outbox).where(like(schema.outbox.dedupeKey, "test:%"));
    expect(left.map((j) => j.kind)).toEqual(["email.send"]);
    const ctx = { finalAttempt: false, owned: async () => true, failed: () => {} };
    for (const job of jobs.filter((j: OutboxJob) => j.kind in erased)) await f.handlers[job.kind]?.(job, ctx);
    expect(await count("agent_runs")).toBe(0);
    expect(await count("routine_runs")).toBe(0);
    expect(await orgMessages()).toBe(0);
  });

  test("its messages go in batches, and a reset cut short after them finishes on its next run", async () => {
    f = await setup();
    await f.db.update(schema.agents).set({ deletedAt: new Date() }).where(eq(schema.agents.orgId, f.org.id));
    const more = await f.db
      .insert(schema.channels)
      .values([
        { orgId: f.org.id, name: "launch" },
        { orgId: f.org.id, name: "ops" },
      ])
      .returning();
    for (const channel of [f.general, ...more]) {
      for (let i = 0; i < 7; i++) {
        await insertMessage(f.db, {
          orgId: f.org.id,
          channelId: channel.id,
          author: { type: "person", userId: f.owner.id },
          body: `m${i}`,
        });
      }
    }
    expect(await orgMessages()).toBe(21);
    await requestReset(f.db, f.owner.id, f.org.id);
    // The transaction that erases the rest fails once the messages are gone, as a process dying there would leave it.
    await f.db.execute(sql`create function refuse_general() returns trigger language plpgsql as $$
      begin raise exception 'crash'; end $$`);
    await f.db.execute(sql`create trigger refuse_general before insert on channels
      for each row execute function refuse_general()`);
    const cut = await resetWorkspace(resetDeps(), f.org.id, { messageBatch: 3 }).catch((e: Error) => e.message);
    expect(cut).toContain('insert into "channels"');
    expect(await orgMessages()).toBe(0);
    expect(await count("channels")).toBe(3);
    const [waiting] = await f.db.select().from(schema.organizations).where(eq(schema.organizations.id, f.org.id));
    expect(waiting?.resetRequestedAt).not.toBeNull();
    await f.db.execute(sql`drop trigger refuse_general on channels`);

    expect(await resetWorkspace(resetDeps(), f.org.id, { messageBatch: 3 })).toBe(true);
    const channels = await f.db.select().from(schema.channels).where(eq(schema.channels.orgId, f.org.id));
    expect(channels.map((c) => c.name)).toEqual(["general"]);
  });

  test("a hold placed while its messages go keeps the rest", async () => {
    f = await setup();
    for (let i = 0; i < 7; i++) {
      await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: f.owner.id },
        body: `m${i}`,
      });
    }
    await requestReset(f.db, f.owner.id, f.org.id);
    // The operator's hold lands right after the first batch.
    await f.db.execute(sql`create function hold_org() returns trigger language plpgsql as $$
      begin update organizations set deletion_hold_at = now() where id = ${sql.raw(`'${f.org.id}'`)}; return null; end $$`);
    await f.db.execute(sql`create trigger hold_org after delete on messages
      for each statement execute function hold_org()`);
    expect(await resetWorkspace(resetDeps(), f.org.id, { messageBatch: 3 })).toBe(false);
    expect(await orgMessages()).toBe(4);
    expect(await count("channels")).toBe(1);
  });

  test("the workspace's computer stays its own: no second one is asked for", async () => {
    f = await setup();
    await f.db.insert(schema.machineProvisioning).values({ orgId: f.org.id, state: "ready" });
    const asked = async () =>
      (await listMachineRequests(f.db, "external", { limit: 50 })).requests.some((r) => r.orgId === f.org.id);
    expect(await asked()).toBe(false);
    await requestReset(f.db, f.owner.id, f.org.id);
    expect(await resetWorkspace(resetDeps(), f.org.id)).toBe(true);
    expect(await asked()).toBe(false);
    const [org] = await f.db.select().from(schema.organizations).where(eq(schema.organizations.id, f.org.id));
    expect([org?.standing, org?.onboardingStep]).toEqual(["active", "context"]);
  });

  test("keeps the workspace, its people, AI accounts and usage, and starts it over", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "oi" });
    const file = await createFileArtifact(f.artifactDeps, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "notes.txt",
      name: "notes.txt",
      bytes: new TextEncoder().encode("hello"),
      contentType: "text/plain",
      channelId: null,
    });
    await f.db.insert(schema.usageRecords).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      credentialId: f.credential.id,
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      requestedModel: "claude-sonnet-5-5",
      inputTokens: 10,
      outputTokens: 0,
      costNanoUsd: 5,
    });
    const stored = [...f.platformBlobs.objects.keys()];
    expect(stored.length).toBeGreaterThan(0);

    const { started } = await requestReset(f.db, f.owner.id, f.org.id);
    expect(started).toBe(true);
    await drainOutbox(f.db, f.handlers);

    const [org] = await f.db.select().from(schema.organizations).where(eq(schema.organizations.id, f.org.id));
    expect(org?.name).toBe("Acme");
    expect(org?.resetRequestedAt).toBeNull();
    expect(org?.onboardedAt).toBeNull();
    expect(org?.onboardingStep).toBe("context");
    expect(await count("organization_members")).toBe(2);
    expect(await count("provider_credentials")).toBe(1);
    expect(await count("usage_records")).toBe(1);
    expect(await count("artifacts")).toBe(0);
    expect(await count("artifact_versions")).toBe(0);
    for (const key of stored) expect(f.platformBlobs.objects.has(key)).toBe(false);
    expect(file.id).toBeTruthy();

    const live = await f.db
      .select({ handle: schema.agents.handle, builtin: schema.agents.builtin })
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, f.org.id), isNull(schema.agents.deletedAt)));
    expect(live).toEqual([{ handle: "lodi", builtin: "right_hand" }]);
    const [dev] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(dev?.deletedAt).not.toBeNull();

    const channels = await f.db.select().from(schema.channels).where(eq(schema.channels.orgId, f.org.id));
    expect(channels.map((c) => c.name)).toEqual(["general"]);
    expect(channels[0]?.createdByUserId).toBe(f.owner.id);
    const members = await f.db
      .select({ userId: schema.channelMembers.userId })
      .from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, channels[0]?.id ?? ""), isNull(schema.channelMembers.agentId)));
    expect(members.map((m) => m.userId).sort()).toEqual([f.owner.id, bia.id].sort());
    expect(
      rowsOf<{ n: number }>(
        await f.db.execute(sql`select count(*)::int as n from messages where org_id = ${f.org.id}::uuid`),
      )[0]?.n,
    ).toBe(0);
    const audit = await f.db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.orgId, f.org.id));
    expect(audit.map((a) => a.action)).toContain("organization.reset");
  });

  test("running it again erases nothing made after it", async () => {
    f = await setup({ rightHand: true });
    await requestReset(f.db, f.owner.id, f.org.id);
    expect(await resetWorkspace(resetDeps(), f.org.id)).toBe(true);
    const [general] = await f.db.select().from(schema.channels).where(eq(schema.channels.orgId, f.org.id));
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, general?.id ?? "", { body: "new" });
    expect(await resetWorkspace(resetDeps(), f.org.id)).toBe(false);
    await drainOutbox(f.db, { [ORG_RESET_JOB]: () => resetWorkspace(resetDeps(), f.org.id).then(() => undefined) });
    expect(await count("channels")).toBe(1);
    expect(
      rowsOf<{ n: number }>(
        await f.db.execute(sql`select count(*)::int as n from messages where org_id = ${f.org.id}::uuid`),
      )[0]?.n,
    ).toBe(1);
  });

  test("only an owner, never while it is being deleted, and once at a time", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    expect(await requestReset(f.db, bia.id, f.org.id).catch((e) => e.code)).toBe("forbidden");
    const first = await requestReset(f.db, f.owner.id, f.org.id);
    const again = await requestReset(f.db, f.owner.id, f.org.id);
    expect(again).toEqual({ startedAt: first.startedAt, started: false });
    await resetWorkspace(resetDeps(), f.org.id);
    await scheduleDeletion({ db: f.db }, f.owner.id, f.org.id, "owner");
    expect(await requestReset(f.db, f.owner.id, f.org.id).catch((e) => e.code)).toBe("org.deleting");
  });

  test("waits while the operator holds the workspace, and the hourly tick takes it once the hold lifts", async () => {
    f = await setup();
    await setDeletionHold(f.db, f.org.id, { held: true, reason: "legal" });
    await requestReset(f.db, f.owner.id, f.org.id);
    expect(await resetWorkspace(resetDeps(), f.org.id)).toBe(false);
    expect(await count("channels")).toBeGreaterThan(0);
    const [held] = await f.db.select().from(schema.organizations).where(eq(schema.organizations.id, f.org.id));
    expect(held?.resetRequestedAt).not.toBeNull();
    const later = new Date(Date.now() + 3600_000);
    expect(await enqueueWaitingResets(f.db, later)).toBe(0);

    await setDeletionHold(f.db, f.org.id, { held: false, reason: null });
    expect(await enqueueWaitingResets(f.db, later)).toBe(1);
    await drainOutbox(f.db, { [ORG_RESET_JOB]: () => resetWorkspace(resetDeps(), f.org.id).then(() => undefined) });
    const [done] = await f.db.select().from(schema.organizations).where(eq(schema.organizations.id, f.org.id));
    expect(done?.resetRequestedAt).toBeNull();
  });
});
