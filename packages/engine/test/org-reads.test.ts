import { afterEach, expect, test } from "bun:test";
import { createMemoryPubSub } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  agentStatuses,
  announceAgentStatus,
  CACHE_TOPIC,
  caches,
  enableCaches,
  forgetOrgReads,
  postPersonMessage,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  enableCaches(false);
  await f?.close();
  f = undefined;
});

test("every member reads one load of the workspace's statuses, each with what they may see", async () => {
  const fx = await setup();
  f = fx;
  enableCaches();
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "@dev olá",
  });
  const [run] = await fx.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  await fx.db
    .update(schema.agentRuns)
    .set({ status: "running", startedAt: new Date(), heartbeatAt: new Date() })
    .where(eq(schema.agentRuns.id, run.id));
  const bia = await addMember(fx.db, fx.org.id, "member", "bia");
  const workOf = async (userId: string) =>
    (await agentStatuses(fx.db, userId, fx.org.id)).find((s) => s.agentId === fx.agent.id)?.work ?? null;

  expect(await workOf(fx.owner.id)).toMatchObject({ state: "working", runId: run.id, channelId: fx.general.id });
  // The same kept rows, but bia is not in #general: the bare state.
  expect(await workOf(bia.id)).toMatchObject({ state: "working", runId: run.id, channelId: null });
  // Who reads where is asked at every request, never kept.
  await addChannelMember(fx.db, fx.owner.id, fx.org.id, fx.general.id, { userId: bia.id });
  expect(await workOf(bia.id)).toMatchObject({ state: "working", channelId: fx.general.id });

  // The workspace's part is kept: a write no status announces goes unseen for a moment.
  await fx.db
    .update(schema.agentRuns)
    .set({ status: "done", finishedAt: new Date() })
    .where(eq(schema.agentRuns.id, run.id));
  expect(await workOf(fx.owner.id)).toMatchObject({ state: "working" });
  // An announced status forgets it, before the event that has the apps read again.
  await announceAgentStatus(fx.pubsub, fx.org.id, fx.agent.id);
  expect(await workOf(fx.owner.id)).toBeNull();
});

test("forgetting an org's reads goes out through the caller's pubsub; a change to an agent forgets them too", async () => {
  const pubsub = createMemoryPubSub();
  const heard: unknown[] = [];
  pubsub.subscribe(CACHE_TOPIC, (event) => heard.push(event));
  caches.orgReads.set("org-a:statuses", 1);
  caches.orgReads.set("org-b:statuses", 2);

  await forgetOrgReads(pubsub, "org-a");
  expect(caches.orgReads.get("org-a:statuses")).toBeUndefined();
  expect(caches.orgReads.get("org-b:statuses")).toBe(2);
  expect(heard).toEqual([{ type: "cache.invalidate", cache: "orgReads", op: "deletePrefix", key: "org-a:" }]);

  // Another process's change to an agent, applied here, forgets that org's reads as well.
  caches.agents.apply("delete", "org-b:agent-1");
  expect(caches.orgReads.get("org-b:statuses")).toBeUndefined();
});
