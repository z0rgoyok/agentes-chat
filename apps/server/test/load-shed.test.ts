import { afterEach, expect, test } from "bun:test";
import { busyResponse, MAX_SOCKETS_PER_PERSON, retryAfterSeconds, watchLoad } from "../src/load-shed";
import { browser, createTestServer, listen, ORIGIN, seedOrg, signUp, type TestServer, upgradeStatus } from "./harness";

const quiet = { warn: () => {} };
const off = { eventLoopMs: 0, dbWaitMs: 0, sockets: 0 };
/** Polls `read` until it gives `want`, for up to `ms`; returns what it read last. */
async function settles<T>(read: () => T, want: T, ms = 2_000) {
  const end = performance.now() + ms;
  while (read() !== want && performance.now() < end) await Bun.sleep(10);
  return read();
}

test("watchLoad: a blocked event loop makes the process overloaded until a calm reading, and says so", async () => {
  const warned: string[] = [];
  const log = { warn: (message: string) => void warned.push(message) };
  const lag = watchLoad({ ping: async () => {}, sockets: () => 0, limits: { ...off, eventLoopMs: 100 }, log }, 200);
  try {
    expect(lag.overloaded()).toBeNull();
    await Bun.sleep(20);
    const until = performance.now() + 250;
    while (performance.now() < until) {}
    expect(await settles(lag.overloaded, "event_loop")).toBe("event_loop");
    expect(warned).toEqual(["overloaded: turning new sockets and reads away"]);
    expect(await settles(lag.overloaded, null)).toBeNull();
    expect(warned.at(-1)).toBe("no longer overloaded");
  } finally {
    lag.stop();
  }
});

test("watchLoad: a slow database (an unanswered select 1 counts as it waits) and too many sockets", async () => {
  let pingMs = 300;
  let sockets = 0;
  const db = watchLoad(
    { ping: () => Bun.sleep(pingMs), sockets: () => 0, limits: { ...off, dbWaitMs: 100 }, log: quiet },
    50,
  );
  const full = watchLoad({ ping: async () => {}, sockets: () => sockets, limits: { ...off, sockets: 3 }, log: quiet });
  try {
    expect(db.overloaded()).toBeNull();
    expect(await settles(db.overloaded, "database")).toBe("database");
    pingMs = 0;
    expect(await settles(db.overloaded, null)).toBeNull();
    expect(full.overloaded()).toBeNull();
    sockets = 3;
    expect(full.overloaded()).toBe("sockets");
  } finally {
    db.stop();
    full.stop();
  }
});

test("busyResponse: a 503 with a Retry-After of 5 to 15 seconds", async () => {
  expect(retryAfterSeconds(() => 0)).toBe(5);
  expect(retryAfterSeconds(() => 0.9999)).toBe(15);
  const res = busyResponse();
  expect(res.status).toBe(503);
  const wait = Number(res.headers.get("retry-after"));
  expect(wait).toBeGreaterThanOrEqual(5);
  expect(wait).toBeLessThanOrEqual(15);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("server_busy");
});

let t: TestServer | null = null;
let server: ReturnType<typeof listen> | null = null;
afterEach(async () => {
  if (server) await Promise.race([server.stop(true), Bun.sleep(500)]);
  await t?.close();
  t = server = null;
});

test("overloaded: reads, new sockets and the health check answer 503, writes and open sockets carry on; a full count sheds sockets only", async () => {
  let overloaded: string | null = null;
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, overloaded: () => overloaded });
  server = listen(t);
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const wsUrl = `ws://127.0.0.1:${server.port}/api/ws?orgId=${orgId}`;
  const open = new WebSocket(wsUrl, { headers: { origin: ORIGIN, cookie: owner.cookie() } } as unknown as string[]);
  await new Promise((resolve) => {
    open.onopen = resolve;
  });

  overloaded = "event_loop";
  const read = await owner(`/api/app/organizations/${orgId}/channels`);
  expect(read.status).toBe(503);
  expect(Number(read.headers.get("retry-after"))).toBeGreaterThanOrEqual(5);
  // A container's check, a deploy's wait and an uptime monitor see it up; only a proxy's `?load=1` sees it busy.
  const health = await t.app.request("/api/health");
  expect([health.status, ((await health.json()) as { status: string }).status]).toEqual([200, "overloaded"]);
  const proxied = await t.app.request("/api/health?load=1");
  expect([proxied.status, ((await proxied.json()) as { status: string }).status]).toEqual([503, "overloaded"]);
  // A link a person opened (a provider's OAuth return, a download) is never turned away.
  const opened = await owner(`/api/app/organizations/${orgId}/channels`, {
    headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
  });
  expect(opened.status).toBe(200);
  expect(await upgradeStatus(wsUrl, { origin: ORIGIN, cookie: owner.cookie() })).toBe(503);
  const write = await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, {
    json: { body: "still goes" },
  });
  expect(write.status).toBeLessThan(300);
  expect(open.readyState).toBe(WebSocket.OPEN);

  // A full socket count turns new sockets away, and the proxy elsewhere; people already here keep reading.
  overloaded = "sockets";
  expect((await owner(`/api/app/organizations/${orgId}/channels`)).status).toBe(200);
  expect((await t.app.request("/api/health?load=1")).status).toBe(503);
  expect(await upgradeStatus(wsUrl, { origin: ORIGIN, cookie: owner.cookie() })).toBe(503);

  overloaded = null;
  expect((await owner(`/api/app/organizations/${orgId}/channels`)).status).toBe(200);
  expect((await t.app.request("/api/health?load=1")).status).toBe(200);
  open.close();
});

test("an app's new socket replaces the one it left behind; a person has at most MAX_SOCKETS_PER_PERSON", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  server = listen(t);
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const headers = { origin: ORIGIN, cookie: owner.cookie() };
  const url = (tab?: string) => `ws://127.0.0.1:${server?.port}/api/ws?orgId=${orgId}${tab ? `&tab=${tab}` : ""}`;
  const openSocket = async (tab?: string) => {
    const ws = new WebSocket(url(tab), { headers } as unknown as string[]);
    const closed = new Promise<string>((resolve) => ws.addEventListener("close", (e) => resolve(e.reason)));
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    return { ws, closed };
  };

  const first = await openSocket("tab1");
  const second = await openSocket("tab1");
  expect(await first.closed).toBe("replaced");
  expect(second.ws.readyState).toBe(WebSocket.OPEN);
  await Bun.sleep(50);
  expect(t.realtime.sockets()).toBe(1);

  const rest = await Promise.all(Array.from({ length: MAX_SOCKETS_PER_PERSON - 1 }, () => openSocket()));
  expect(t.realtime.sockets()).toBe(MAX_SOCKETS_PER_PERSON);
  expect(await upgradeStatus(url(), headers)).toBe(429);
  // The same app coming back replaces its own socket, so it is never the one shut out.
  const again = await openSocket("tab1");
  expect(await second.closed).toBe("replaced");
  for (const s of [again, ...rest]) s.ws.close();
});
