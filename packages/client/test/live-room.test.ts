import { afterEach, describe, expect, test } from "bun:test";
import { LOCAL } from "@agenteschat/live";
import {
  acquireLiveRoom,
  closeAllLiveRooms,
  LIVE_ROOM_RELEASE_MS,
  LIVE_TIMING,
  LiveRoom,
  type LiveRoomOptions,
  liveRoomKey,
  liveRoomsOpen,
  liveSocketUrl,
  peekLiveRoom,
  releaseLiveRoom,
} from "../src/index";
import { FakeLiveServer } from "../src/live/testing";
import { type Clock, FILE, fakeClock, ORG, QUICK } from "./live-helpers";

/**
 * A live file's room (ADR 0196): its document, presence and the person's own undo over the connection, and the
 * registry that shares one room per file between screens.
 */

const ADA = { kind: "person" as const, id: "ada" };
const BEA = { kind: "person" as const, id: "bea" };

const made: { rooms: LiveRoom[]; servers: FakeLiveServer[] } = { rooms: [], servers: [] };
afterEach(() => {
  closeAllLiveRooms();
  for (const r of made.rooms.splice(0)) r.destroy();
  for (const s of made.servers.splice(0)) s.destroy();
});

/** A server whose file is a spreadsheet with one cell map per sheet (enough for the room, which reads no cells). */
function setup(mode: "edit" | "view" = "edit") {
  const clock = fakeClock();
  const server = new FakeLiveServer({ timers: clock.timers, savedDelayMs: 40 });
  made.servers.push(server);
  server.addFile(FILE, {
    kind: "spreadsheet",
    mode,
    init: (doc) => {
      doc.getArray<string>("sheetOrder").push(["s1"]);
      doc.getMap("sheets");
    },
  });
  const room = (me = ADA, options: Partial<LiveRoomOptions> = {}) => {
    const r = new LiveRoom(roomOptions(server, clock, me, options));
    made.rooms.push(r);
    return r;
  };
  const step = async (ms = 0) => {
    clock.advance(ms);
    await server.settle();
  };
  return { clock, server, room, step };
}

function roomOptions(server: FakeLiveServer, clock: Clock, me = ADA, options: Partial<LiveRoomOptions> = {}) {
  return {
    orgId: ORG,
    fileId: FILE,
    me,
    url: liveSocketUrl("https://app.example.com", ORG, FILE),
    createSocket: server.socketFactory(),
    loadState: async () => server.loadState(FILE),
    timers: clock.timers,
    now: clock.now,
    timing: QUICK,
    backoffJitter: 0,
    ...options,
  } satisfies LiveRoomOptions;
}

/** A sheet's cell, written as the app writes: one transaction with the `LOCAL` origin. */
const setCell = (room: LiveRoom, key: string, value: string) =>
  room.doc.transact(() => room.doc.getMap<string>("sheets").set(key, value), LOCAL);
const cellsOf = (room: LiveRoom) => room.doc.getMap<string>("sheets").toJSON();

describe("live room", () => {
  test("opens, loads and says where it stands", async () => {
    const { room, step } = setup();
    const r = room();
    const seen: string[] = [];
    r.subscribe(() => seen.push(r.status));
    expect(r.status).toBe("connecting");
    await step();
    expect(r.state).toMatchObject({ status: "live", mode: "edit", loaded: true, unsent: false });
    expect(r.kind).toBe("spreadsheet");
    expect(r.getState()).toBe(r.state);
    expect(seen.at(-1)).toBe("live");
  });

  test("presence: its own first, others with their place; editing reads viewing while read-only", async () => {
    const { server, room, step } = setup();
    const a = room(ADA);
    const b = room(BEA);
    await step();
    a.setLocal({ mode: "editing", at: { sheet: "s1" } });
    b.setLocal({ at: { sheet: "s1" }, cursor: { x: 1, y: 2, space: "canvas" } });
    await step(LIVE_TIMING.awarenessMs);
    const peers = a.peers();
    expect(peers.map((p) => [p.user.id, p.self])).toEqual([
      ["ada", true],
      ["bea", false],
    ]);
    expect(peers[0]?.state.mode).toBe("editing");
    expect(peers[1]?.state.at).toEqual({ sheet: "s1" });
    // The same list until someone changes something.
    expect(a.peers()).toBe(peers);
    // A key set to undefined goes.
    b.setLocal({ cursor: undefined });
    await step(LIVE_TIMING.awarenessMs);
    expect(a.peers()[1]?.state.cursor).toBeUndefined();
    // Read-only: `viewing` whatever the screen says, and back to `editing` when editable again.
    server.setMode(FILE, "view");
    await step(LIVE_TIMING.awarenessMs);
    expect(a.awareness.getLocalState()).toMatchObject({ mode: "viewing", user: ADA });
    expect(b.peers().find((p) => p.user.id === "ada")?.state.mode).toBe("viewing");
    server.setMode(FILE, "edit");
    await step(LIVE_TIMING.awarenessMs);
    expect(a.awareness.getLocalState()).toMatchObject({ mode: "editing" });
    // Who the person is can't be changed by a patch, only by `setUser`.
    a.setLocal({ user: BEA } as never);
    expect(a.awareness.getLocalState()).toMatchObject({ user: ADA });
    a.setUser({ kind: "person", id: "ada2" });
    expect(a.awareness.getLocalState()).toMatchObject({ user: { kind: "person", id: "ada2" } });
  });

  test("onPeers hears changes; onDocChange hears every change with its version", async () => {
    const { server, room, step } = setup();
    const a = room(ADA);
    const b = room(BEA);
    let heard = 0;
    let changes = 0;
    a.onPeers(() => heard++);
    a.onDocChange(() => changes++);
    await step();
    const version = a.version;
    b.setLocal({ at: { sheet: "s1" } });
    await step(LIVE_TIMING.awarenessMs);
    expect(heard).toBeGreaterThan(0);
    server.edit(FILE, (doc) => doc.getMap<string>("sheets").set("x", "1"));
    await step();
    expect(changes).toBeGreaterThan(0);
    expect(a.version).toBeGreaterThan(version);
    expect(a.getVersion()).toBe(a.version);
  });

  test("undo takes back only the person's own changes, and others see it", async () => {
    const { server, room, step } = setup();
    const a = room(ADA);
    const b = room(BEA);
    await step();
    setCell(a, "mine", "1");
    await step(LIVE_TIMING.sendDelayMs);
    // Someone else (and an agent through the server) change things meanwhile.
    b.doc.transact(() => b.doc.getMap<string>("sheets").set("bea", "2"), LOCAL);
    server.edit(FILE, (doc) => doc.getMap<string>("sheets").set("agent", "3"));
    await step(LIVE_TIMING.sendDelayMs);
    expect(cellsOf(a)).toEqual({ mine: "1", bea: "2", agent: "3" });
    a.undo.undo();
    expect(cellsOf(a)).toEqual({ bea: "2", agent: "3" });
    await step(LIVE_TIMING.sendDelayMs);
    expect(cellsOf(b)).toEqual({ bea: "2", agent: "3" });
    expect(server.file(FILE).doc.getMap("sheets").toJSON()).toEqual({ bea: "2", agent: "3" });
    a.undo.redo();
    await step(LIVE_TIMING.sendDelayMs);
    expect(cellsOf(b).mine).toBe("1");
    // Changes from the network never enter the undo stack: undoing everything leaves them.
    while (a.undo.canUndo()) a.undo.undo();
    expect(cellsOf(a)).toEqual({ bea: "2", agent: "3" });
  });

  test("engine() is a spreadsheet's only, made once, and reads its sheets", async () => {
    const { server, room, step } = setup();
    // A real new spreadsheet, as the Drive's New menu makes one.
    const sheetFile = "f0000000-0000-4000-8000-000000000002";
    server.addFile(sheetFile, { kind: "spreadsheet" });
    const a = room(ADA, {
      fileId: sheetFile,
      kind: "spreadsheet",
      url: liveSocketUrl("https://app.example.com", ORG, sheetFile),
      loadState: async () => server.loadState(sheetFile),
    });
    await step();
    expect(a.kind).toBe("spreadsheet");
    const engine = a.engine();
    expect(a.engine()).toBe(engine);
    const sheet = a.doc.getArray<string>("sheetOrder").get(0) as string;
    expect(engine.size(sheet)).toEqual({ rows: 100, cols: 26 });
    const slides = room(BEA, { kind: "slides" });
    expect(() => slides.engine()).toThrow();
  });

  test("destroy: others see the person leave, and nothing is left running", async () => {
    const { clock, room, step } = setup();
    const a = room(ADA);
    const b = room(BEA);
    await step();
    setCell(a, "last", "1");
    expect(b.peers().map((p) => p.user.id)).toEqual(["bea", "ada"]);
    a.destroy();
    await step(100);
    expect(cellsOf(b).last).toBe("1");
    expect(b.peers().map((p) => p.user.id)).toEqual(["bea"]);
    expect(a.destroyed).toBe(true);
    expect(a.status).toBe("closed");
    // Calls after destroy are harmless.
    a.setLocal({ mode: "editing" });
    a.checkAlive();
    a.pause();
    a.resume();
    expect(() => a.engine()).toThrow();
    b.destroy();
    expect(clock.pending()).toBe(0);
  });

  test("pause and resume, unsent changes kept and restored", async () => {
    const { server, room, step } = setup();
    const a = room(ADA);
    await step();
    a.pause();
    setCell(a, "offline", "1");
    await step(LIVE_TIMING.sendDelayMs);
    expect(a.unsent).toBe(true);
    const kept = a.unsentUpdate();
    expect(kept).not.toBeNull();
    // The app restarted: a new room puts the kept changes back.
    a.destroy();
    const again = room(ADA, { start: false });
    again.restoreUnsent(kept as Uint8Array);
    again.start();
    await step();
    await step(LIVE_TIMING.sendDelayMs);
    expect(server.file(FILE).doc.getMap("sheets").get("offline")).toBe("1");
    await step(100);
    expect(again.unsent).toBe(false);
  });
});

describe("live rooms registry", () => {
  test("one room per file, held by every screen, kept a moment after the last lets go", async () => {
    const { clock, server, step } = setup();
    const key = liveRoomKey(ORG, FILE, "https://app.example.com");
    let makes = 0;
    const make = () => {
      makes++;
      return new LiveRoom(roomOptions(server, clock));
    };
    const a = acquireLiveRoom(key, make);
    const b = acquireLiveRoom(key, make);
    expect(b).toBe(a);
    expect(makes).toBe(1);
    expect(peekLiveRoom(key)).toBe(a);
    await step();
    const timers = { setTimeout: clock.timers.setTimeout, clearTimeout: clock.timers.clearTimeout };
    releaseLiveRoom(a, { timers });
    expect(a.destroyed).toBe(false);
    releaseLiveRoom(b, { timers });
    expect(a.destroyed).toBe(false);
    // Taken again before the delay ends (a remount): the same room, still open.
    clock.advance(LIVE_ROOM_RELEASE_MS - 1);
    const c = acquireLiveRoom(key, make);
    expect(c).toBe(a);
    clock.advance(10);
    expect(a.destroyed).toBe(false);
    releaseLiveRoom(c, { timers });
    clock.advance(LIVE_ROOM_RELEASE_MS);
    expect(a.destroyed).toBe(true);
    expect(peekLiveRoom(key)).toBeNull();
    expect(liveRoomsOpen()).toBe(0);
    // The next one is new.
    const d = acquireLiveRoom(key, make);
    expect(d).not.toBe(a);
    expect(makes).toBe(2);
    releaseLiveRoom(d, { delayMs: 0 });
    expect(d.destroyed).toBe(true);
  });

  test("a room closed for good with nobody holding it is replaced", async () => {
    const { clock, server, step } = setup();
    const key = liveRoomKey(ORG, FILE);
    const make = () => new LiveRoom(roomOptions(server, clock));
    const a = acquireLiveRoom(key, make);
    await step();
    server.closeSockets(FILE, 4404);
    await step();
    expect(a.status).toBe("closed");
    releaseLiveRoom(a, { timers: clock.timers });
    const b = acquireLiveRoom(key, make);
    expect(b).not.toBe(a);
    expect(a.destroyed).toBe(true);
    await step();
    expect(b.status).toBe("live");
    releaseLiveRoom(b, { delayMs: 0 });
  });
});
