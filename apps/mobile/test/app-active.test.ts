import { afterEach, expect, jest, mock, test } from "bun:test";
import { keys, type Message, RealtimeConnection, type SocketLike } from "@agenteschat/client";
import { focusManager, QueryObserver } from "@tanstack/react-query";
import { app, resetAppState, to } from "./app-state";
import { message } from "./features/fixtures";

mock.module("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => undefined }),
  getNetworkStateAsync: async () => ({ isConnected: true }),
}));

const { followAppActive, INACTIVE_GRACE_MS, keepWhileActive } = await import("../src/lib/useAppActive");
const { bindFocusToAppState, catchUpQueries, createQueryClient } = await import("../src/providers/query");

afterEach(() => {
  jest.useRealTimers();
  resetAppState();
  focusManager.setFocused(undefined);
});

/** A connection that writes down what it is asked. */
const fakeConnection = () => {
  const calls: string[] = [];
  return {
    calls,
    start: () => void calls.push("start"),
    stop: () => void calls.push("stop"),
    checkAlive: () => void calls.push("checkAlive"),
  };
};

test("a glance away (the notification shade, a Face ID prompt) keeps the app in front; going home or a long one doesn't", () => {
  jest.useFakeTimers();
  const seen: boolean[] = [];
  const off = followAppActive((active) => seen.push(active), INACTIVE_GRACE_MS);
  to("inactive");
  jest.advanceTimersByTime(INACTIVE_GRACE_MS - 1);
  to("active");
  expect(seen).toEqual([true]);
  // Home: `inactive` on the way to `background`, out at once.
  to("inactive");
  to("background");
  expect(seen).toEqual([true, false]);
  to("active");
  // A call taken over the app: out once it lasted the grace.
  to("inactive");
  jest.advanceTimersByTime(INACTIVE_GRACE_MS);
  expect(seen).toEqual([true, false, true, false]);
  off();
  to("active");
  expect(seen).toEqual([true, false, true, false]);
  // Without a grace, `inactive` is out at once (marking read, a notice's time).
  const strict: boolean[] = [];
  followAppActive((active) => strict.push(active));
  to("inactive");
  expect(strict).toEqual([false]);
});

test("the socket runs while the app is in front: kept through a glance away, stopped in the background, started again with a fresh cookie", async () => {
  jest.useFakeTimers();
  const conn = fakeConnection();
  let cookies = 0;
  let cookie = Promise.resolve();
  const off = keepWhileActive(conn, () => {
    cookies++;
    return cookie;
  });
  await cookie;
  expect(conn.calls).toEqual(["start"]);
  // The notification shade: nothing closes, and the socket is checked on the way back.
  to("inactive");
  jest.advanceTimersByTime(3000);
  to("active");
  expect(conn.calls).toEqual(["start", "checkAlive"]);
  // Home: stopped at once; back, the cookie is read again before it starts.
  to("inactive");
  to("background");
  expect(conn.calls).toEqual(["start", "checkAlive", "stop"]);
  cookie = Promise.resolve();
  to("active");
  await cookie;
  expect(conn.calls).toEqual(["start", "checkAlive", "stop", "start"]);
  expect(cookies).toBe(2);
  // Away again before the cookie came back: it doesn't start in the background.
  let land: () => void = () => {};
  to("background");
  cookie = new Promise<void>((done) => {
    land = done;
  });
  to("active");
  to("background");
  land();
  await cookie;
  expect(conn.calls).toEqual(["start", "checkAlive", "stop", "start", "stop", "stop"]);
  off();
  to("active");
  await cookie;
  expect(conn.calls).toHaveLength(6);
});

test("opened in the background (a notification's action), the socket waits for the app to come to the front", async () => {
  app.state = "background";
  const conn = fakeConnection();
  const cookie = Promise.resolve();
  keepWhileActive(conn, () => cookie);
  await cookie;
  expect(conn.calls).toEqual([]);
  to("active");
  await cookie;
  expect(conn.calls).toEqual(["start"]);
});

test("React Query's focus follows the app the same way: a glance away doesn't count as leaving it", () => {
  jest.useFakeTimers();
  const off = bindFocusToAppState();
  to("inactive");
  expect(focusManager.isFocused()).toBe(true);
  to("active");
  to("background");
  expect(focusManager.isFocused()).toBe(false);
  to("active");
  expect(focusManager.isFocused()).toBe(true);
  off();
});

const until = async (done: () => boolean) => {
  for (let i = 0; i < 50 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
};

test("coming back to the app reads nothing by itself: the socket's catch-up does, joining a read already on its way", async () => {
  const qc = createQueryClient();
  qc.mount();
  let reads = 0;
  let answer: (() => void) | null = null;
  const observer = new QueryObserver(qc, {
    queryKey: ["org", "o1", "channels"],
    queryFn: () =>
      new Promise<number>((done) => {
        reads++;
        answer = () => done(reads);
      }),
  });
  const off = observer.subscribe(() => {});
  await until(() => answer !== null);
  answer?.();
  await until(() => qc.getQueryState(["org", "o1", "channels"])?.fetchStatus === "idle");
  expect(reads).toBe(1);
  // Back in front long after: the focus alone reads nothing.
  qc.getQueryCache()
    .find({ queryKey: ["org", "o1", "channels"] })
    ?.setState({ dataUpdatedAt: 0 });
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await new Promise((r) => setTimeout(r, 20));
  expect(reads).toBe(1);
  // A read on its way when the catch-up comes is joined: one request, not two.
  void observer.refetch();
  await until(() => reads === 2);
  void catchUpQueries(qc, false);
  void catchUpQueries(qc, true);
  await new Promise((r) => setTimeout(r, 20));
  expect(reads).toBe(2);
  answer?.();
  await until(() => qc.getQueryState(["org", "o1", "channels"])?.fetchStatus === "idle");
  expect(qc.getQueryData(["org", "o1", "channels"])).toBe(2);
  // Nothing on its way: a brief gap reads what is shown again, a long one too.
  void catchUpQueries(qc, false);
  await until(() => reads === 3);
  answer?.();
  await until(() => qc.getQueryState(["org", "o1", "channels"])?.fetchStatus === "idle");
  void catchUpQueries(qc, true);
  await until(() => reads === 4);
  expect(reads).toBe(4);
  answer?.();
  off();
  qc.unmount();
});

/** A socket the test opens; it sends nowhere. */
const fakeSocket = () => {
  const socket = {
    readyState: 0,
    send: () => undefined,
    close: () => {
      socket.readyState = 3;
    },
    onopen: null as SocketLike["onopen"],
    onmessage: null as SocketLike["onmessage"],
    onclose: null as SocketLike["onclose"],
    onerror: null as SocketLike["onerror"],
    open: () => {
      socket.readyState = 1;
      socket.onopen?.({});
    },
  };
  return socket;
};

test("back from the background, the open chat reads what was said while the socket was stopped, as soon as it opens", async () => {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const conn = new RealtimeConnection({
    url: "ws://x",
    createSocket: () => {
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    },
    pingMs: 0,
  });
  const qc = createQueryClient();
  qc.mount();
  conn.onCatchUp((full) => void catchUpQueries(qc, full));
  const key = keys.messages("o1", "c1");
  const server: Message[] = [message({ id: "m-1", channelId: "c1" })];
  let reads = 0;
  const observer = new QueryObserver(qc, {
    queryKey: key,
    queryFn: async () => {
      reads++;
      return [...server];
    },
  });
  const off = observer.subscribe(() => {});
  const cookie = Promise.resolve();
  const offActive = keepWhileActive(conn, () => cookie);
  await cookie;
  sockets[0]?.open();
  await until(() => qc.getQueryState(key)?.fetchStatus === "idle" && reads === 1);
  // A few seconds in another app: the socket stops, and what is said meanwhile reaches no one.
  to("background");
  server.push(message({ id: "m-2", channelId: "c1", body: "dita com o app fechado" }));
  to("active");
  await cookie;
  sockets[1]?.open();
  await until(() => reads === 2 && qc.getQueryState(key)?.fetchStatus === "idle");
  expect(qc.getQueryData<Message[]>(key)?.map((m) => m.id)).toEqual(["m-1", "m-2"]);
  offActive();
  conn.stop();
  off();
  qc.unmount();
});
