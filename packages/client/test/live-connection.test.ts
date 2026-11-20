import { afterEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  ApiError,
  LIVE_BACKOFF_JITTER,
  LIVE_BACKOFF_MS,
  LIVE_MAX_FRAME_BYTES,
  LIVE_RESTORED,
  LIVE_TIMING,
  liveSocketUrl,
} from "../src/index";
import type { FakeLiveServer, FakeLiveSocket } from "../src/live/testing";
import { cells, connect, FILE, fakeClock, ORG, type Peer, serverWithFile } from "./live-helpers";

/**
 * The live file connection (ADR 0196 §3) against an in-memory server speaking the same protocol: HTTP state first,
 * sync over the socket, changes both ways, presence, unsent changes, reconnects, read-only, the phone's text frames.
 */

const open: { peers: Peer[]; servers: FakeLiveServer[] } = { peers: [], servers: [] };
afterEach(() => {
  for (const p of open.peers.splice(0)) p.destroy();
  for (const s of open.servers.splice(0)) s.destroy();
});

function setup(options: ConstructorParameters<typeof FakeLiveServer>[0] = {}, mode: "edit" | "view" = "edit") {
  const clock = fakeClock();
  const server = serverWithFile({ timers: clock.timers, savedDelayMs: 40, ...options }, mode);
  open.servers.push(server);
  const join = (opts: Parameters<typeof connect>[2] = {}) => {
    const peer = connect(server, clock, opts);
    open.peers.push(peer);
    return peer;
  };
  /** Time passes and what it set off arrives. */
  const step = async (ms = 0) => {
    clock.advance(ms);
    await server.settle();
  };
  return { clock, server, join, step };
}

describe("live file connection", () => {
  test("loads the document over HTTP first, then catches up over the socket", async () => {
    const { server, join, step } = setup();
    const a = join();
    expect(a.connection.state.status).toBe("connecting");
    await step();
    expect(cells(a.doc)).toEqual({ A1: "hello" });
    expect(a.connection.state).toMatchObject({
      status: "live",
      mode: "edit",
      loaded: true,
      unsent: false,
      error: null,
    });
    expect(a.connection.state.kind).toBe("spreadsheet");
    const statuses = a.states.map((s) => s.status);
    expect(statuses.indexOf("syncing")).toBeGreaterThanOrEqual(0);
    expect(statuses.at(-1)).toBe("live");
    // y-websocket's handshake: its step 1 and presence on `live.ready`, then the answer to the server's step 1.
    expect(server.last()?.frames.map((f) => f.type)).toEqual(["step1", "awareness", "step2", "ping"]);
    expect(server.last()?.url).toBe(liveSocketUrl("https://app.example.com", ORG, FILE));
  });

  test("without an HTTP state the socket brings the whole document", async () => {
    const { join, step } = setup();
    const a = join({ loadState: false });
    await step();
    expect(cells(a.doc)).toEqual({ A1: "hello" });
    expect(a.connection.state).toMatchObject({ status: "live", loaded: true, mode: "edit" });
  });

  test("two apps converge through the server, concurrent writes included", async () => {
    const { server, join, step } = setup();
    const a = join();
    const b = join();
    await step();
    a.doc.getMap<string>("cells").set("B1", "from a");
    b.doc.getMap<string>("cells").set("C1", "from b");
    expect(a.connection.state.unsent).toBe(true);
    await step(LIVE_TIMING.sendDelayMs);
    const all = { A1: "hello", B1: "from a", C1: "from b" };
    expect(cells(a.doc)).toEqual(all);
    expect(cells(b.doc)).toEqual(all);
    expect(cells(server.file(FILE).doc)).toEqual(all);
    // Both write the same cell at once: everyone ends with the same one.
    a.doc.getMap<string>("cells").set("A1", "x");
    b.doc.getMap<string>("cells").set("A1", "y");
    await step(LIVE_TIMING.sendDelayMs);
    expect(cells(a.doc).A1).toBe(cells(b.doc).A1);
    expect(cells(server.file(FILE).doc).A1).toBe(cells(a.doc).A1);
    // Stored (`live.saved` 40 ms later): nothing unsent.
    await step(100);
    expect(a.connection.state.unsent).toBe(false);
    expect(b.connection.state.unsent).toBe(false);
  });

  test("changes made close together go as one frame", async () => {
    const { server, join, step } = setup();
    const a = join();
    await step();
    const before = server.last()?.updates.length ?? 0;
    for (let i = 0; i < 10; i++) a.doc.getMap<string>("cells").set(`B${i + 2}`, String(i));
    await step(LIVE_TIMING.sendDelayMs);
    expect((server.last()?.updates.length ?? 0) - before).toBe(1);
    expect(Object.keys(cells(server.file(FILE).doc))).toHaveLength(11);
  });

  test("a change from the server (an agent) arrives and is never sent back", async () => {
    const { server, join, step } = setup();
    const a = join();
    await step();
    const sent = server.last()?.updates.length;
    server.edit(FILE, (doc) => doc.getMap<string>("cells").set("E1", "agent"));
    await step(100);
    expect(cells(a.doc).E1).toBe("agent");
    expect(server.last()?.updates.length).toBe(sent);
    expect(a.connection.state.unsent).toBe(false);
  });

  test("unsent changes clear once the server says they are stored", async () => {
    const { join, step } = setup();
    const a = join();
    await step();
    a.doc.getMap<string>("cells").set("B1", "1");
    expect(a.connection.state.unsent).toBe(true);
    expect(a.connection.hasUnsent()).toBe(true);
    await step(LIVE_TIMING.sendDelayMs);
    // Sent, not stored yet.
    expect(a.connection.state.unsent).toBe(true);
    await step(40);
    expect(a.connection.state.unsent).toBe(false);
    expect(a.connection.unsentUpdate()).toBeNull();
  });

  test("with no `live.saved` at all, a pong that says nothing waits to be stored clears what came before it", async () => {
    const { join, step } = setup({ saved: false });
    const a = join();
    await step();
    a.doc.getMap<string>("cells").set("B1", "1");
    await step(LIVE_TIMING.sendDelayMs);
    expect(a.connection.state.unsent).toBe(true);
    // Its ping waits out the gap since the last answer; its pong proves the frame arrived and nothing waits.
    await step(LIVE_TIMING.pingGapMs);
    await step(LIVE_TIMING.savedSettleMs);
    expect(a.connection.state.unsent).toBe(false);
  });

  test("a pong that says changes still wait to be stored keeps them unsent past the settle, until `live.saved`", async () => {
    // Storing takes 3 s (a slow database): the server's pong says `unsaved` meanwhile.
    const { join, step } = setup({ savedDelayMs: 3000 });
    const a = join();
    await step();
    a.doc.getMap<string>("cells").set("B1", "1");
    await step(LIVE_TIMING.sendDelayMs);
    await step(LIVE_TIMING.pingGapMs);
    // The pong came and a second of silence went by: that proves nothing while the server says it is still storing.
    await step(LIVE_TIMING.savedSettleMs);
    expect(a.connection.state.unsent).toBe(true);
    expect(a.connection.unsentUpdate()).not.toBeNull();
    await step(3000);
    expect(a.connection.state.unsent).toBe(false);
  });

  test("offline: changes are kept and go when the connection comes back", async () => {
    const { server, join, step } = setup();
    const a = join();
    const b = join();
    await step();
    server.closeSockets(FILE, 1006);
    await step();
    expect(a.connection.state.status).toBe("offline");
    server.offline = true;
    a.doc.getMap<string>("cells").set("B1", "written offline");
    await step(LIVE_TIMING.sendDelayMs);
    expect(a.connection.state.unsent).toBe(true);
    expect(cells(server.file(FILE).doc).B1).toBeUndefined();
    // Retries fail while the network is down.
    await step(LIVE_BACKOFF_MS[0] as number);
    expect(a.connection.state.status).toBe("offline");
    server.offline = false;
    await step(LIVE_BACKOFF_MS[1] as number);
    await step(LIVE_BACKOFF_MS[2] as number);
    expect(a.connection.state.status).toBe("live");
    expect(cells(server.file(FILE).doc).B1).toBe("written offline");
    expect(cells(b.doc).B1).toBe("written offline");
    await step(100);
    expect(a.connection.state.unsent).toBe(false);
  });

  test("reconnects with backoff, and a socket that caught up starts the waits over", async () => {
    const { server, join, step } = setup();
    const a = join();
    await step();
    const count = () => server.sockets.length;
    server.offline = true;
    server.closeSockets(FILE, 1006);
    await step();
    const start = count();
    await step((LIVE_BACKOFF_MS[0] as number) - 1);
    expect(count()).toBe(start);
    await step(1);
    expect(count()).toBe(start + 1);
    await step((LIVE_BACKOFF_MS[1] as number) - 1);
    expect(count()).toBe(start + 1);
    await step(1);
    expect(count()).toBe(start + 2);
    server.offline = false;
    await step(LIVE_BACKOFF_MS[2] as number);
    expect(a.connection.state.status).toBe("live");
    server.closeSockets(FILE, 1006);
    await step();
    const again = count();
    await step(LIVE_BACKOFF_MS[0] as number);
    expect(count()).toBe(again + 1);
    expect(a.connection.state.status).toBe("live");
  });

  test.each([
    [4403, "forbidden"],
    [4404, "not_found"],
  ])("a close %i ends it for good (%s): no reconnect", async (code, error) => {
    const { server, join, step } = setup();
    const a = join();
    await step();
    server.closeSockets(FILE, code);
    await step();
    expect(a.connection.state).toMatchObject({ status: "closed", error });
    expect(a.errors).toEqual([error]);
    const made = server.sockets.length;
    await step(60_000);
    expect(server.sockets.length).toBe(made);
  });

  test.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
  ])("the HTTP state refusing %i ends it for good (%s)", async (status, error) => {
    const { server, join, step } = setup();
    const a = join({
      loadState: async () => {
        throw new ApiError(status, "x", "refused");
      },
    });
    await step();
    expect(a.connection.state).toMatchObject({ status: "closed", error, loaded: false });
    expect(server.sockets).toHaveLength(0);
  });

  test("the HTTP state failing otherwise is tried again with backoff", async () => {
    const { server, join, step } = setup();
    let calls = 0;
    const a = join({
      loadState: async () => {
        calls++;
        if (calls < 3) throw new TypeError("Network request failed");
        return server.loadState(FILE);
      },
    });
    await step();
    expect(a.connection.state.status).toBe("offline");
    await step(LIVE_BACKOFF_MS[0] as number);
    await step(LIVE_BACKOFF_MS[1] as number);
    expect(calls).toBe(3);
    expect(a.connection.state.status).toBe("live");
  });

  test("sockets refused before opening ask the HTTP state why, which ends it when access is gone", async () => {
    const { server, join, step } = setup();
    let gone = false;
    let loads = 0;
    const a = join({
      loadState: async () => {
        loads++;
        if (gone) throw new ApiError(404, "artifact.not_found", "gone");
        return server.loadState(FILE);
      },
    });
    await step();
    expect(loads).toBe(1);
    // The file's sharing changed: the upgrade is refused (404), which a socket only sees as a close before opening.
    gone = true;
    server.refusing.add(FILE);
    server.closeSockets(FILE, 1006);
    await step();
    for (const ms of LIVE_BACKOFF_MS.slice(0, 3)) await step(ms);
    expect(loads).toBe(2);
    expect(a.connection.state).toMatchObject({ status: "closed", error: "not_found" });
  });

  test("read-only: nothing is sent; once editable again, what waited goes", async () => {
    const { server, join, step } = setup({}, "view");
    const a = join();
    await step();
    expect(a.connection.state.mode).toBe("view");
    a.doc.getMap<string>("cells").set("B1", "waits");
    await step(LIVE_TIMING.sendDelayMs);
    expect(server.last()?.updates).toEqual([]);
    expect(a.connection.state.unsent).toBe(true);
    server.setMode(FILE, "edit");
    await step();
    expect(a.connection.state.mode).toBe("edit");
    expect(cells(server.file(FILE).doc).B1).toBe("waits");
    await step(100);
    expect(a.connection.state.unsent).toBe(false);
  });

  test("a change refused as read-only is kept and offered again when the file is editable", async () => {
    const { server, join, step } = setup();
    const a = join();
    await step();
    server.file(FILE).mode = "view";
    a.doc.getMap<string>("cells").set("B1", "late");
    await step(LIVE_TIMING.sendDelayMs);
    expect(a.errors).toContain("read_only");
    expect(a.connection.state.error).toBe("read_only");
    expect(cells(server.file(FILE).doc).B1).toBeUndefined();
    await step(5000);
    expect(a.connection.state.unsent).toBe(true);
    server.setMode(FILE, "edit");
    await step();
    expect(a.connection.state.error).toBeNull();
    expect(cells(server.file(FILE).doc).B1).toBe("late");
  });

  test("a change refused while the file was too large goes when the server asks for what it lacks", async () => {
    const { server, join, step } = setup();
    const a = join();
    await step();
    server.rejecting = "too_large";
    a.doc.getMap<string>("cells").set("B1", "over");
    await step(LIVE_TIMING.sendDelayMs);
    expect(a.errors).toContain("too_large");
    expect(a.connection.state.error).toBe("too_large");
    expect(cells(server.file(FILE).doc).B1).toBeUndefined();
    // Refused, so never taken as saved, however long it waits.
    await step(5000);
    expect(a.connection.state.unsent).toBe(true);
    // Back under its limits, the server asks each app for what it lacks (its step 1).
    server.rejecting = null;
    server.askForMissing(FILE);
    await step(100);
    expect(a.connection.state.error).toBeNull();
    expect(cells(server.file(FILE).doc).B1).toBe("over");
    await step(2000);
    expect(a.connection.state.unsent).toBe(false);
    expect(a.connection.state.status).toBe("live");
  });

  test("the phone's text frames: bytes go and come as base64", async () => {
    const { server, join, step } = setup();
    const phone = join({ textFrames: true });
    const web = join();
    await step();
    expect(server.sockets[0]?.text).toBe(true);
    expect(phone.connection.state.status).toBe("live");
    phone.doc.getMap<string>("cells").set("B1", "from the phone");
    web.doc.getMap<string>("cells").set("C1", "from the web");
    await step(LIVE_TIMING.sendDelayMs);
    expect(cells(phone.doc)).toEqual({ A1: "hello", B1: "from the phone", C1: "from the web" });
    expect(cells(web.doc)).toEqual(cells(phone.doc));
  });

  test("presence goes to the others, throttled, and leaves with its socket", async () => {
    const { server, join, step } = setup();
    const a = join();
    const b = join();
    await step();
    const sentBefore = server.sockets[0]?.frames.filter((f) => f.type === "awareness").length ?? 0;
    for (let x = 0; x < 20; x++) a.awareness.setLocalStateField("cursor", { x, y: 0, space: "canvas" });
    await step();
    // The first change at once, the rest once the window ends.
    const afterBurst = server.sockets[0]?.frames.filter((f) => f.type === "awareness").length ?? 0;
    expect(afterBurst - sentBefore).toBe(1);
    await step(LIVE_TIMING.awarenessMs);
    const afterWindow = server.sockets[0]?.frames.filter((f) => f.type === "awareness").length ?? 0;
    expect(afterWindow - sentBefore).toBe(2);
    expect((b.awareness.getStates().get(a.awareness.clientID) as { cursor?: { x: number } })?.cursor?.x).toBe(19);
    // A's socket goes: B stops seeing A.
    a.connection.stop();
    await step();
    expect(b.awareness.getStates().has(a.awareness.clientID)).toBe(false);
  });

  test("others' presence is dropped while offline and comes back with the socket", async () => {
    const { server, join, step } = setup();
    const a = join();
    const b = join();
    await step();
    b.awareness.setLocalStateField("at", { sheet: "s1" });
    await step();
    expect(a.awareness.getStates().has(b.awareness.clientID)).toBe(true);
    // Only A's socket drops.
    server.closeSocket(server.sockets[0] as FakeLiveSocket, 1006);
    await step();
    expect(a.awareness.getStates().has(b.awareness.clientID)).toBe(false);
    await step(LIVE_BACKOFF_MS[0] as number);
    expect(a.awareness.getStates().has(b.awareness.clientID)).toBe(true);
  });

  test("back on a new socket, this side shows to the others again at once, without moving", async () => {
    const { server, join, step } = setup();
    const a = join();
    const b = join();
    await step();
    b.awareness.setLocalStateField("at", { sheet: "s1" });
    await step();
    expect(a.awareness.getStates().has(b.awareness.clientID)).toBe(true);
    // B's socket drops: the server takes B out at B's last clock, as the real one does.
    const bSocket = server.sockets.find((s) =>
      s.frames.some((f) => f.type === "awareness" && f.entries.some((e) => e.clientId === b.awareness.clientID)),
    );
    server.closeSocket(bSocket as FakeLiveSocket, 1006);
    await step();
    expect(a.awareness.getStates().has(b.awareness.clientID)).toBe(false);
    // A clock A already knows would be ignored: B comes back at a newer one, where it was.
    await step(LIVE_BACKOFF_MS[0] as number);
    expect(b.connection.state.status).toBe("live");
    expect(a.awareness.getStates().get(b.awareness.clientID)).toMatchObject({ at: { sheet: "s1" } });
  });

  test("an agent's presence from the server shows and goes", async () => {
    const { server, join, step } = setup();
    const a = join();
    await step();
    server.setPeer(FILE, 777, { user: { kind: "agent", id: "atlas" }, mode: "editing" });
    await step();
    expect(a.awareness.getStates().get(777)).toMatchObject({ user: { kind: "agent", id: "atlas" } });
    server.setPeer(FILE, 777, null);
    await step();
    expect(a.awareness.getStates().has(777)).toBe(false);
  });

  test("while offline only the reconnect waits: presence and changes wait without timers of their own", async () => {
    const { clock, server, join, step } = setup();
    const a = join();
    await step();
    // The server done storing (its own timers are on the same clock).
    await step(100);
    server.offline = true;
    server.closeSockets(FILE, 1006);
    await step();
    for (let x = 0; x < 5; x++) a.awareness.setLocalStateField("cursor", { x, y: 0, space: "canvas" });
    a.doc.getMap<string>("cells").set("B1", "later");
    await step(LIVE_TIMING.sendDelayMs);
    expect(clock.pending()).toBe(1);
    server.offline = false;
    await step(LIVE_BACKOFF_MS[0] as number);
    expect(a.connection.state.status).toBe("live");
    // What waited went: the change, and the last presence.
    expect(cells(server.file(FILE).doc).B1).toBe("later");
    const presence = server.file(FILE).peers.get(a.awareness.clientID)?.state as { cursor?: { x: number } };
    expect(presence?.cursor?.x).toBe(4);
  });

  test("a socket the server never joins to the file is replaced", async () => {
    const { server, join, step } = setup();
    server.holdReady = true;
    const a = join();
    await step();
    expect(a.connection.state.status).toBe("syncing");
    await step(LIVE_TIMING.readyTimeoutMs - 1);
    expect(server.sockets[0]?.closedWith).toBeNull();
    server.holdReady = false;
    await step(1);
    expect(server.sockets[0]?.closedWith).toBe(4000);
    await step(LIVE_BACKOFF_MS[0] as number);
    expect(a.connection.state.status).toBe("live");
  });

  test("the waits before reconnecting are shortened by chance, never lengthened", async () => {
    const { server, join, step } = setup();
    // The longest cut: a quarter of each wait.
    join({ backoffJitter: LIVE_BACKOFF_JITTER, random: () => 0.999_999 });
    await step();
    const made = server.sockets.length;
    server.closeSockets(FILE, 1006);
    await step();
    const shortest = Math.round((LIVE_BACKOFF_MS[0] as number) * (1 - LIVE_BACKOFF_JITTER));
    await step(shortest - 1);
    expect(server.sockets.length).toBe(made);
    await step(1);
    expect(server.sockets.length).toBe(made + 1);
  });

  test("a silent socket is replaced: no pong and nothing else heard", async () => {
    const { server, join, step } = setup({ pong: false, saved: false });
    const a = join();
    await step();
    const made = server.sockets.length;
    // The idle ping goes, and nothing at all comes back.
    await step(LIVE_TIMING.pingMs);
    expect(a.connection.state.status).toBe("live");
    await step(LIVE_TIMING.pongTimeoutMs);
    expect(server.sockets[made - 1]?.closedWith).toBe(4000);
    await step(LIVE_BACKOFF_MS[0] as number);
    expect(server.sockets.length).toBe(made + 1);
    expect(a.connection.state.status).toBe("live");
  });

  test("checkAlive pings now, and reconnects at once while waiting to", async () => {
    const { server, join, step } = setup();
    const a = join();
    await step();
    const pings = () => server.last()?.frames.filter((f) => f.type === "ping").length ?? 0;
    const before = pings();
    await step(LIVE_TIMING.pingGapMs);
    a.connection.checkAlive();
    await step();
    expect(pings()).toBe(before + 1);
    server.offline = true;
    server.closeSockets(FILE, 1006);
    await step();
    await step(LIVE_BACKOFF_MS[0] as number);
    const made = server.sockets.length;
    server.offline = false;
    a.connection.checkAlive();
    await step();
    expect(server.sockets.length).toBe(made + 1);
    expect(a.connection.state.status).toBe("live");
  });

  test("pause closes the socket and keeps changes; resume sends them", async () => {
    const { server, join, step } = setup();
    const a = join();
    await step();
    a.connection.pause();
    await step();
    expect(a.connection.state.status).toBe("offline");
    expect(server.openSockets()).toHaveLength(0);
    a.doc.getMap<string>("cells").set("B1", "in the background");
    await step(60_000);
    expect(server.openSockets()).toHaveLength(0);
    a.connection.resume();
    await step();
    expect(a.connection.state.status).toBe("live");
    expect(cells(server.file(FILE).doc).B1).toBe("in the background");
  });

  test("changes kept by an earlier session (the phone) go once the file loaded", async () => {
    const { server, join, step } = setup();
    // An earlier session made a change offline and the app closed.
    const earlier = new Y.Doc();
    Y.applyUpdate(earlier, server.loadState(FILE).state);
    const before = Y.encodeStateVector(earlier);
    earlier.getMap<string>("cells").set("B1", "kept");
    const kept = Y.encodeStateAsUpdate(earlier, before);
    const a = join({ loadState: false });
    a.connection.restore(kept);
    expect(a.connection.state.unsent).toBe(true);
    expect(a.connection.unsentUpdate()).not.toBeNull();
    await step();
    expect(cells(a.doc).B1).toBe("kept");
    await step(LIVE_TIMING.sendDelayMs);
    expect(cells(server.file(FILE).doc).B1).toBe("kept");
    await step(100);
    expect(a.connection.state.unsent).toBe(false);
    earlier.destroy();
    // Applied with its own origin: never the person's own undo.
    expect(LIVE_RESTORED.kind).toBe("restored");
  });

  test("`live.versions` and `live.error` reach their listeners", async () => {
    const { server, join, step } = setup();
    const a = join();
    let versions = 0;
    a.connection.onVersions(() => versions++);
    await step();
    server.versionsChanged(FILE);
    server.refuse(FILE, "rate");
    await step();
    expect(versions).toBe(1);
    expect(a.errors).toEqual(["rate"]);
    expect(a.connection.state.error).toBe("rate");
    // A `rate` refusal ends with the next save.
    a.doc.getMap<string>("cells").set("B1", "1");
    await step(LIVE_TIMING.sendDelayMs);
    await step(40);
    expect(a.connection.state.error).toBeNull();
  });

  test("large changes go in frames that fit; one past the frame cap stays unsent and says why", async () => {
    const { server, join, step } = setup();
    const a = join();
    await step();
    const before = server.last()?.updates.length ?? 0;
    const big = (n: number) => "x".repeat(n);
    a.doc.transact(() => a.doc.getMap<string>("cells").set("B1", big(200_000)));
    a.doc.transact(() => a.doc.getMap<string>("cells").set("B2", big(200_000)));
    await step(LIVE_TIMING.sendDelayMs);
    await step(1000);
    expect((server.last()?.updates.length ?? 0) - before).toBe(2);
    expect(cells(server.file(FILE).doc).B2).toHaveLength(200_000);
    await step(3000);
    expect(a.connection.state.unsent).toBe(false);
    a.doc.getMap<string>("cells").set("C1", big(LIVE_MAX_FRAME_BYTES + 10));
    await step(LIVE_TIMING.sendDelayMs);
    expect(a.errors).toContain("too_large");
    expect(cells(server.file(FILE).doc).C1).toBeUndefined();
    await step(10_000);
    expect(a.connection.state.unsent).toBe(true);
  });

  test("frames over the pace wait their turn, in order", async () => {
    const { server, join, step } = setup();
    const a = join({ sendRate: 100_000 });
    await step();
    const before = server.last()?.updates.length ?? 0;
    const map = a.doc.getMap<string>("cells");
    a.doc.transact(() => map.set("B1", "y".repeat(300_000)));
    a.doc.transact(() => map.set("B2", "z".repeat(300_000)));
    await step(LIVE_TIMING.sendDelayMs);
    // The first fits the burst; the second waits for credit (about 0.9 s at 100 kB/s).
    expect((server.last()?.updates.length ?? 0) - before).toBe(1);
    await step(500);
    expect((server.last()?.updates.length ?? 0) - before).toBe(1);
    await step(1000);
    expect((server.last()?.updates.length ?? 0) - before).toBe(2);
  });

  test("stop sends what waited, says goodbye, and leaves no timer or listener behind", async () => {
    const { clock, server, join, step } = setup();
    const a = join();
    const b = join();
    await step();
    a.doc.getMap<string>("cells").set("B1", "last words");
    a.awareness.setLocalState(null);
    a.connection.stop();
    await step();
    expect(cells(server.file(FILE).doc).B1).toBe("last words");
    expect(b.awareness.getStates().has(a.awareness.clientID)).toBe(false);
    expect(a.connection.state.status).toBe("closed");
    expect(server.sockets[0]?.closedWith).toBe(1000);
    // The server's own storing ends; then only B's timers remain, and B stopping takes them.
    await step(100);
    b.connection.stop();
    expect(clock.pending()).toBe(0);
    const listens = (o: unknown) =>
      (o as { _observers: Map<string, Set<unknown>> })._observers.get("update")?.size ?? 0;
    expect(listens(a.doc)).toBe(0);
    expect(listens(a.awareness)).toBe(0);
    // Nothing more goes.
    a.doc.getMap<string>("cells").set("B2", "after");
    await step(1000);
    expect(cells(server.file(FILE).doc).B2).toBeUndefined();
  });

  test("an unreadable frame from the server starts the sync over on a new socket", async () => {
    const { server, join, step } = setup();
    const a = join({ textFrames: true });
    await step();
    const socket = server.last();
    socket?.onmessage?.({ data: "%%% not base64 %%%" });
    await step();
    expect(socket?.closedWith).toBe(4000);
    await step(LIVE_BACKOFF_MS[0] as number);
    expect(a.connection.state.status).toBe("live");
  });
});
