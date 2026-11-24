import { expect, test } from "bun:test";
import {
  createPostgresPubSub,
  listenResumedTopic,
  type PgNotifier,
  type PubSubTrouble,
  postgresJsNotifier,
  type RealtimeEvent,
} from "../src/pubsub";

/**
 * A Postgres whose connections break the ways a real one's do: NOTIFY can fail or hang, and the LISTEN's connection can
 * die without closing (nothing more arrives on it, and a LISTEN or UNLISTEN sent on it never answers). With `restart`,
 * the LISTEN's connection can be dropped and the next listen opens a new one; `reconnect()` is the driver opening a new
 * one by itself (the OS finally gave up on the dead one).
 */
function flakyPostgres({ restart = false } = {}) {
  type Connection = { dead: boolean; listeners: ((payload: string) => void)[] };
  const fresh = (): Connection => ({ dead: false, listeners: [] });
  const state = { notify: "ok" as "ok" | "fail" | "hang" | "slow", listens: 0, restarts: 0 };
  let connection = fresh();
  const all: Connection[] = [connection];
  const never = <T>() => new Promise<T>(() => {});
  const notifier: PgNotifier = {
    listen: async (_channel, on, onListen) => {
      state.listens++;
      const mine = connection;
      if (mine.dead) return never();
      mine.listeners.push(on);
      onListen?.();
      return async () => {
        if (mine.dead) return never();
        mine.listeners.splice(mine.listeners.indexOf(on), 1);
      };
    },
    notify: async (_channel, payload) => {
      if (state.notify === "fail") throw new Error("Connection terminated unexpectedly");
      if (state.notify === "hang") return never();
      if (state.notify === "slow") await new Promise((r) => setTimeout(r, 60));
      for (const c of all) if (!c.dead) for (const on of [...c.listeners]) on(payload);
    },
    ...(restart
      ? {
          restart: async () => {
            state.restarts++;
            connection.dead = true;
            connection = fresh();
            all.push(connection);
          },
        }
      : {}),
  };
  return {
    notifier,
    state,
    /** The LISTEN's connection died without closing. */
    killListen: () => {
      connection.dead = true;
    },
    reconnect: () => {
      connection = fresh();
      all.push(connection);
    },
  };
}

const until = async (done: () => boolean, ms = 2000) => {
  for (let waited = 0; waited < ms && !done(); waited += 5) await new Promise((r) => setTimeout(r, 5));
};

function watch(pubsub: Awaited<ReturnType<typeof createPostgresPubSub>>) {
  const got: unknown[] = [];
  const resumed: RealtimeEvent[] = [];
  pubsub.subscribe("t", (e) => got.push(e.n));
  pubsub.subscribe(listenResumedTopic, (e) => resumed.push(e));
  return { got, resumed };
}

test("a NOTIFY that hangs holds nothing behind it, and once NOTIFY works every subscriber learns events were missed", async () => {
  const { notifier, state } = flakyPostgres();
  const troubles: PubSubTrouble[] = [];
  state.notify = "hang";
  const pubsub = await createPostgresPubSub(notifier, {
    heartbeatMs: 10_000,
    notifyTimeoutMs: 20,
    notifyLostMs: 40,
    onTrouble: (kind) => troubles.push(kind),
  });
  const { got, resumed } = watch(pubsub);
  await pubsub.publish("t", { type: "x", n: 1 });
  await until(() => troubles.length > 0);
  expect(troubles).toEqual(["notify_timeout"]);
  state.notify = "ok";
  await pubsub.publish("t", { type: "x", n: 2 });
  await until(() => resumed.length > 0);
  // The first never went out; the second did, with the mark that tells every replica to read again.
  expect(got).toEqual([2]);
  expect(resumed).toEqual([{ type: "pubsub.resumed", full: true }]);
  expect(troubles).toEqual(["notify_timeout", "resumed"]);
  await pubsub.close?.();
});

test("a burst of missed marks has subscribers start over once a minute, and resync gently in between", async () => {
  const { notifier } = flakyPostgres();
  const pubsub = await createPostgresPubSub(notifier, { heartbeatMs: 10_000, fullResyncMs: 100 });
  const { resumed } = watch(pubsub);
  // Other replicas' marks, as they come through LISTEN.
  const mark = () =>
    notifier.notify("agenteschat_events", JSON.stringify({ t: "pubsub.missed", e: { type: "missed" } }));
  for (let i = 0; i < 5; i++) await mark();
  expect(resumed.map((e) => e.full)).toEqual([true, false, false, false, false]);
  await new Promise((r) => setTimeout(r, 120));
  await mark();
  expect(resumed.at(-1)).toEqual({ type: "pubsub.resumed", full: true });
  await pubsub.close?.();
});

test("a NOTIFY that is only slow (a busy pool) holds nothing behind it and has no subscriber read again", async () => {
  const { notifier, state } = flakyPostgres();
  const troubles: PubSubTrouble[] = [];
  state.notify = "slow";
  const pubsub = await createPostgresPubSub(notifier, {
    heartbeatMs: 10_000,
    notifyTimeoutMs: 20,
    notifyLostMs: 1_000,
    onTrouble: (kind) => troubles.push(kind),
  });
  const { got, resumed } = watch(pubsub);
  await pubsub.publish("t", { type: "x", n: 1 });
  await new Promise((r) => setTimeout(r, 30));
  await pubsub.publish("t", { type: "x", n: 2 });
  await until(() => got.length === 2);
  await new Promise((r) => setTimeout(r, 30));
  expect(got).toEqual([1, 2]);
  expect(resumed).toEqual([]);
  expect(troubles).toEqual([]);
  await pubsub.close?.();
});

test("NOTIFY failing is reported once, counted, and its end said with how many statements were lost", async () => {
  const { notifier, state } = flakyPostgres();
  const troubles: [PubSubTrouble, Record<string, unknown>][] = [];
  state.notify = "fail";
  const pubsub = await createPostgresPubSub(notifier, {
    heartbeatMs: 10_000,
    onTrouble: (kind, detail) => troubles.push([kind, detail]),
  });
  const { got, resumed } = watch(pubsub);
  await pubsub.publish("t", { type: "x", n: 1 });
  await until(() => troubles.length > 0);
  await pubsub.publish("t", { type: "x", n: 2 });
  await new Promise((r) => setTimeout(r, 20));
  state.notify = "ok";
  await pubsub.publish("t", { type: "x", n: 3 });
  await until(() => resumed.length > 0);
  expect(got).toEqual([3]);
  expect(resumed).toHaveLength(1);
  expect(troubles.map(([kind]) => kind)).toEqual(["notify_failed", "resumed"]);
  expect(troubles[1]?.[1]).toMatchObject({ failedStatements: 2 });
  await pubsub.close?.();
});

test("a LISTEN whose connection died without closing is made again on a new one, never waiting on the old", async () => {
  const { notifier, state, killListen } = flakyPostgres({ restart: true });
  const troubles: PubSubTrouble[] = [];
  const pubsub = await createPostgresPubSub(notifier, {
    heartbeatMs: 10,
    listenTimeoutMs: 50,
    onTrouble: (kind) => troubles.push(kind),
  });
  const { got, resumed } = watch(pubsub);
  await new Promise((r) => setTimeout(r, 40));
  // Heard all along: nothing made again, nothing said.
  expect(state.listens).toBe(1);
  expect(troubles).toEqual([]);
  killListen();
  await until(() => resumed.length > 0);
  expect(state.restarts).toBe(1);
  expect(state.listens).toBe(2);
  expect(troubles).toEqual(["deaf", "resumed"]);
  await pubsub.publish("t", { type: "x", n: 1 });
  await until(() => got.length > 0);
  expect(got).toEqual([1]);
  expect(resumed).toHaveLength(1);
  await pubsub.close?.();
});

test("a LISTEN or UNLISTEN that never answers doesn't stop the heartbeat: it keeps trying until the LISTEN is back", async () => {
  // No way to drop the connection: the driver keeps the dead one until the OS gives up (`reconnect`).
  const { notifier, state, killListen, reconnect } = flakyPostgres();
  const troubles: [PubSubTrouble, Record<string, unknown>][] = [];
  const pubsub = await createPostgresPubSub(notifier, {
    heartbeatMs: 10,
    listenTimeoutMs: 20,
    onTrouble: (kind, detail) => troubles.push([kind, detail]),
  });
  const { got, resumed } = watch(pubsub);
  await new Promise((r) => setTimeout(r, 40));
  killListen();
  await until(() => troubles.some(([kind]) => kind === "relisten_failed"));
  const tries = state.listens;
  await until(() => state.listens > tries + 1);
  // Still trying, each try bounded, said once.
  expect(state.listens).toBeGreaterThan(tries + 1);
  reconnect();
  await until(() => resumed.length > 0);
  expect(resumed).toHaveLength(1);
  expect(troubles.map(([kind]) => kind)).toEqual(["deaf", "relisten_failed", "resumed"]);
  expect(troubles[2]?.[1]).toMatchObject({ failedRelistens: expect.any(Number) });
  await pubsub.publish("t", { type: "x", n: 1 });
  await until(() => got.length > 0);
  expect(got).toEqual([1]);
  await pubsub.close?.();
});

test("heartbeats and the missed mark never reach subscribers, and another replica's heartbeat proves nothing", async () => {
  const { notifier } = flakyPostgres();
  const a = await createPostgresPubSub(notifier, { heartbeatMs: 10 });
  const b = await createPostgresPubSub(notifier, { heartbeatMs: 10 });
  const seen: string[] = [];
  for (const topic of ["pubsub.heartbeat", "pubsub.missed"]) a.subscribe(topic, (e) => seen.push(e.type));
  const resumed: RealtimeEvent[] = [];
  a.subscribe(listenResumedTopic, (e) => resumed.push(e));
  await new Promise((r) => setTimeout(r, 60));
  // Both hear both heartbeats: neither takes the other's for its own, neither is deaf.
  expect(seen).toEqual([]);
  expect(resumed).toEqual([]);
  await a.close?.();
  await b.close?.();
});

test("postgres.js: the LISTEN runs on a client of its own, ended at once and made anew on restart", async () => {
  const made: { ended: unknown[]; listened: string[] }[] = [];
  const listenClient = () => {
    const c = { ended: [] as unknown[], listened: [] as string[] };
    made.push(c);
    return {
      listen: async (channel: string) => {
        c.listened.push(channel);
        return { unlisten: async () => {} };
      },
      notify: async () => {},
      end: async (options?: { timeout?: number }) => {
        c.ended.push(options);
      },
    };
  };
  const pool = {
    listen: async (): Promise<{ unlisten(): Promise<void> }> => {
      throw new Error("the pool's client never listens");
    },
    notify: async () => {},
  };
  const notifier = postgresJsNotifier(pool, listenClient);
  await notifier.listen("x", () => {});
  await notifier.listen("y", () => {});
  expect(made).toHaveLength(1);
  await notifier.restart?.();
  await notifier.listen("x", () => {});
  expect(made.map((c) => c.listened)).toEqual([["x", "y"], ["x"]]);
  expect(made[0]?.ended).toEqual([{ timeout: 0 }]);
  await notifier.close?.();
  expect(made[1]?.ended).toEqual([{ timeout: 0 }]);
  // Without one, the pool's client listens and nothing can be dropped.
  expect(postgresJsNotifier(pool).restart).toBeUndefined();
});
