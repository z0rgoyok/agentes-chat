import { expect, test } from "bun:test";
import { MutationObserver, onlineManager, QueryClient } from "@tanstack/react-query";
import type { Me, Message, SnapshotStorage } from "../src/index";
import { createSnapshot, keys, MISSIONS_WAITING_COUNT, SNAPSHOT_MAX_AGE_MS, SNAPSHOT_VERSION } from "../src/index";
import { recentConversations } from "../src/lib/recent";

const memory = () => {
  let value: string | null = null;
  const store: SnapshotStorage & { value: () => string | null } = {
    read: async () => value,
    write: async (v) => {
      value = v;
    },
    remove: async () => {
      value = null;
    },
    value: () => value,
  };
  return store;
};

const me = (id: string): Me => ({ user: { id, name: id, email: `${id}@acme.test` } as Me["user"], organizations: [] });

const msg = (id: string, over: Partial<Message> = {}): Message => ({
  id,
  channelId: "c1",
  threadId: null,
  author: { type: "person", id: "u1" },
  body: id,
  mentionedAgentIds: [],
  agentRunId: null,
  meta: {},
  createdAt: "2026-10-21T10:00:00.000Z",
  ...over,
});

const tick = () => new Promise((r) => setTimeout(r, 0));

test("keeps the lists and the latest messages of a chat, without anything off the list or still sending", async () => {
  const qc = new QueryClient();
  const store = memory();
  qc.setQueryData(keys.me, me("u1"));
  qc.setQueryData(keys.channels("o1"), [{ id: "c1" }]);
  qc.setQueryData(keys.sidebarItems("o1"), { wiki: "always" });
  qc.setQueryData(keys.overview("o1"), { approvalsWaitingForMe: 2 });
  const waiting = keys.missionList("o1", JSON.stringify(MISSIONS_WAITING_COUNT));
  qc.setQueryData(waiting, { missions: [], counts: { waitingYou: 1 } });
  const missoes = keys.missionList("o1", JSON.stringify({ status: "open" }));
  qc.setQueryData(missoes, { missions: [], counts: { waitingYou: 1 } });
  qc.setQueryData(keys.credentials("o1"), [{ id: "secret" }]);
  const many = Array.from({ length: 60 }, (_, i) => msg(`m${i}`));
  qc.setQueryData(keys.messages("o1", "c1"), [...many, msg("local", { local: "pending" })]);
  await createSnapshot(qc, store).flush();

  const next = new QueryClient();
  expect(await createSnapshot(next, store).restore()).toBe(true);
  expect(next.getQueryData<Me>(keys.me)?.user.id).toBe("u1");
  expect(next.getQueryData(keys.channels("o1"))).toEqual([{ id: "c1" }]);
  // Where I put the sidebar's tools and the counts that list one "when there's something": none moves in when the
  // server answers. The Missões tab's lists aren't kept.
  expect(next.getQueryData(keys.sidebarItems("o1"))).toEqual({ wiki: "always" });
  expect(next.getQueryData(keys.overview("o1"))).toEqual({ approvalsWaitingForMe: 2 });
  expect(next.getQueryData(waiting)).toEqual({ missions: [], counts: { waitingYou: 1 } });
  expect(next.getQueryData(missoes)).toBeUndefined();
  expect(next.getQueryData(keys.credentials("o1"))).toBeUndefined();
  const kept = next.getQueryData<Message[]>(keys.messages("o1", "c1")) ?? [];
  expect(kept).toHaveLength(50);
  expect(kept[0]?.id).toBe("m10");
  expect(kept.at(-1)?.id).toBe("m59");
});

test("a request that waits for the network isn't kept: what it carries stays in memory", async () => {
  const qc = new QueryClient();
  const store = memory();
  qc.setQueryData(keys.me, me("u1"));
  onlineManager.setOnline(false);
  try {
    const connect = new MutationObserver(qc, { mutationFn: async (_typed: { apiKey: string }) => null });
    void connect.mutate({ apiKey: "fake-typed-key" }).catch(() => {});
    await tick();
    expect(connect.getCurrentResult().isPaused).toBe(true);
    await createSnapshot(qc, store).flush();
    expect(store.value()).toContain("u1");
    expect(store.value()).not.toContain("fake-typed-key");
  } finally {
    onlineManager.setOnline(true);
  }
});

test("only the most recently updated chats are kept, with their roster", async () => {
  const qc = new QueryClient();
  const store = memory();
  qc.setQueryData(keys.me, me("u1"));
  for (let i = 0; i < 12; i++) {
    qc.setQueryData(keys.messages("o1", `c${i}`), [msg(`m${i}`)], { updatedAt: 1_000 + i });
    qc.setQueryData(keys.roster("o1", `c${i}`), [], { updatedAt: 1_000 + i });
  }
  await createSnapshot(qc, store).flush();

  const next = new QueryClient();
  await createSnapshot(next, store).restore();
  expect(next.getQueryData(keys.messages("o1", "c11"))).toBeDefined();
  expect(next.getQueryData(keys.roster("o1", "c2"))).toBeDefined();
  expect(next.getQueryData(keys.messages("o1", "c1"))).toBeUndefined();
  expect(next.getQueryData(keys.roster("o1", "c1"))).toBeUndefined();
});

test("nothing is saved without a signed-in person", async () => {
  const qc = new QueryClient();
  const store = memory();
  qc.setQueryData(keys.channels("o1"), [{ id: "c1" }]);
  await createSnapshot(qc, store).flush();
  expect(store.value()).toBeNull();
});

test("clearing the cache (sign-out, sign-in, 401) drops the snapshot", async () => {
  const qc = new QueryClient();
  const store = memory();
  qc.setQueryData(keys.me, me("u1"));
  const snapshot = createSnapshot(qc, store);
  const stop = snapshot.start();
  await snapshot.flush();
  expect(store.value()).not.toBeNull();
  qc.clear();
  await tick();
  expect(store.value()).toBeNull();
  stop();
});

test("an account waiting for its deletion is never kept: its screen is the server's to say, and what was saved goes", async () => {
  const qc = new QueryClient();
  const store = memory();
  qc.setQueryData(keys.me, me("u1"));
  const snapshot = createSnapshot(qc, store);
  await snapshot.flush();
  expect(store.value()).not.toBeNull();
  const waiting = me("u1");
  waiting.user.deletion = { dueAt: "2026-11-18T10:00:00.000Z", requestedAt: "2026-11-11T10:00:00.000Z" };
  qc.setQueryData(keys.me, waiting);
  await snapshot.flush();
  expect(store.value()).toBeNull();
});

test("a saved account that waits for its deletion isn't put back: the snapshot goes", async () => {
  const qc = new QueryClient();
  const store = memory();
  qc.setQueryData(keys.me, me("u1"));
  await createSnapshot(qc, store).flush();
  const saved = JSON.parse(store.value() ?? "");
  saved.state.queries[0].state.data.user.deletion = {
    dueAt: "2026-11-18T10:00:00.000Z",
    requestedAt: "2026-11-11T10:00:00.000Z",
  };
  await store.write(JSON.stringify(saved));

  const next = new QueryClient();
  expect(await createSnapshot(next, store).restore()).toBe(false);
  expect(next.getQueryData(keys.me)).toBeUndefined();
  expect(store.value()).toBeNull();
});

test("someone else on this device: the snapshot and the previous person's workspace data go", async () => {
  const qc = new QueryClient();
  const store = memory();
  qc.setQueryData(keys.me, me("u1"));
  qc.setQueryData(keys.channels("o1"), [{ id: "c1" }]);
  await createSnapshot(qc, store).flush();

  const next = new QueryClient();
  const snapshot = createSnapshot(next, store);
  const stop = snapshot.start();
  await snapshot.restore();
  next.setQueryData(keys.me, me("u2"));
  await tick();
  expect(store.value()).toBeNull();
  expect(next.getQueryData(keys.channels("o1"))).toBeUndefined();
  stop();
});

test("an old or other-version snapshot is ignored and dropped", async () => {
  const store = memory();
  const state = { mutations: [], queries: [] };
  await store.write(JSON.stringify({ v: SNAPSHOT_VERSION + 1, savedAt: Date.now(), owner: "u1", state }));
  expect(await createSnapshot(new QueryClient(), store).restore()).toBe(false);
  expect(store.value()).toBeNull();

  const savedAt = Date.now() - SNAPSHOT_MAX_AGE_MS - 1;
  await store.write(JSON.stringify({ v: SNAPSHOT_VERSION, savedAt, owner: "u1", state }));
  expect(await createSnapshot(new QueryClient(), store).restore()).toBe(false);
  expect(store.value()).toBeNull();
});

test("recent conversations: unread first, then the latest activity, channels I'm in and DMs", () => {
  const channel = (id: string, at: string, over: object = {}) =>
    ({ id, isMember: true, unreadCount: 0, lastMessage: { createdAt: at }, ...over }) as never;
  const dm = (channelId: string, at: string, unread = 0) =>
    ({ channelId, unread, lastMessage: { createdAt: at } }) as never;
  const ids = recentConversations(
    [
      channel("old", "2026-10-01T00:00:00Z"),
      channel("new", "2026-10-20T00:00:00Z"),
      channel("unread", "2026-09-01T00:00:00Z", { unreadCount: 3 }),
      channel("notMine", "2026-10-21T00:00:00Z", { isMember: false }),
      channel("empty", "", { lastMessage: null }),
    ],
    [dm("dm", "2026-10-19T00:00:00Z")],
    3,
  );
  expect(ids).toEqual(["unread", "new", "dm"]);
});

test("a chat's agents' questions and thread links are kept with its messages: opened from the snapshot, its rows are whole", async () => {
  const qc = new QueryClient();
  const store = memory();
  qc.setQueryData(keys.me, me("u1"));
  qc.setQueryData(keys.messages("o1", "c1"), [msg("m1")]);
  qc.setQueryData(keys.consultations("o1", "c1"), [{ id: "q1" }]);
  qc.setQueryData(keys.channelThreads("o1", "c1", "all"), { threads: [{ id: "m1", replyCount: 2 }] });
  // Archived threads, and a chat whose messages aren't kept, are not.
  qc.setQueryData(keys.channelThreads("o1", "c1", "archived"), { threads: [] });
  qc.setQueryData(keys.consultations("o1", "c2"), [{ id: "q2" }]);
  await createSnapshot(qc, store).flush();

  const next = new QueryClient();
  expect(await createSnapshot(next, store).restore()).toBe(true);
  expect(next.getQueryData(keys.consultations("o1", "c1"))).toEqual([{ id: "q1" }]);
  expect(next.getQueryData(keys.channelThreads("o1", "c1", "all"))).toEqual({ threads: [{ id: "m1", replyCount: 2 }] });
  // Counted as fetched: the conversation doesn't wait on them to show.
  expect(next.getQueryState(keys.consultations("o1", "c1"))?.dataUpdateCount ?? 0).toBeGreaterThan(0);
  expect(next.getQueryData(keys.channelThreads("o1", "c1", "archived"))).toBeUndefined();
  expect(next.getQueryData(keys.consultations("o1", "c2"))).toBeUndefined();
});
