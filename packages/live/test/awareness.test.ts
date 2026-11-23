import { afterEach, describe, expect, test } from "bun:test";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { agentClientId, type PeerUser, peersOf, readPeerState, sanitizePeerState, utf8Length } from "../src/awareness";
import { LIVE_LIMITS } from "../src/limits";

const ada: PeerUser = { kind: "person", id: "ada" };
const bytes = (state: unknown) => new TextEncoder().encode(JSON.stringify(state)).length;

describe("sanitizePeerState", () => {
  test("keeps the known fields, forces who the socket belongs to", () => {
    const state = sanitizePeerState(
      {
        user: { kind: "agent", id: "impostor" },
        mode: "editing",
        at: { sheet: "s1", slide: "sl1", extra: 1 },
        sel: {
          sheet: { sheet: "s1", r1: "r1", c1: "c1", r2: "r2", c2: "c2", editing: true, x: 1 },
          canvas: ["a", "b"],
        },
        cursor: { x: 1.5, y: -2, space: "canvas", z: 9 },
        view: { x: 0, y: 0, zoom: 1, w: 800, h: 600 },
        presenting: { slide: "sl1", since: 1700000000000 },
        following: 42,
        activity: { key: "writing", params: { range: "B2:C9", n: 3, bad: { x: 1 } } },
        cursorPm: { anchor: { type: { client: 1, clock: 2 }, assoc: 0 }, head: { item: { client: 3, clock: 4 } } },
        injected: "<script>",
      },
      { user: ada, viewOnly: false },
    );
    expect(state).toEqual({
      user: ada,
      mode: "editing",
      at: { sheet: "s1", slide: "sl1" },
      sel: { sheet: { sheet: "s1", r1: "r1", c1: "c1", r2: "r2", c2: "c2", editing: true }, canvas: ["a", "b"] },
      cursor: { x: 1.5, y: -2, space: "canvas" },
      view: { x: 0, y: 0, zoom: 1, w: 800, h: 600 },
      presenting: { slide: "sl1", since: 1700000000000 },
      following: 42,
      activity: { key: "writing", params: { range: "B2:C9", n: "3" } },
      cursorPm: { anchor: { type: { client: 1, clock: 2 }, assoc: 0 }, head: { item: { client: 3, clock: 4 } } },
    });
  });

  test("a read-only socket is viewing, whatever the app says", () => {
    expect(sanitizePeerState({ mode: "editing" }, { user: ada, viewOnly: true })).toEqual({
      user: ada,
      mode: "viewing",
    });
    expect(sanitizePeerState({ mode: "dancing" }, { user: ada, viewOnly: false })?.mode).toBe("viewing");
  });

  test("numbers must be finite, ids short and plain, strings capped", () => {
    const state = sanitizePeerState(
      {
        mode: "viewing",
        at: { sheet: "x".repeat(65), slide: "has space" },
        cursor: { x: Number.POSITIVE_INFINITY, y: 0, space: "canvas" },
        view: { x: 1e12, y: -1e12, zoom: 1e9, w: -5, h: 10 },
        following: 0,
        activity: { key: "a".repeat(65) },
        sel: { slide: Array.from({ length: 500 }, (_, i) => `e${i}`), canvas: ["ok", "not ok", "ok"] },
      },
      { user: ada, viewOnly: false },
    );
    expect(state?.at).toBeUndefined();
    expect(state?.cursor).toBeUndefined();
    expect(state?.view).toEqual({ x: 1e7, y: -1e7, zoom: 100, w: 0, h: 10 });
    expect(state?.following).toBeUndefined();
    expect(state?.activity).toBeUndefined();
    expect(state?.sel?.slide).toHaveLength(200);
    expect(state?.sel?.canvas).toEqual(["ok"]);
    const long = sanitizePeerState(
      { mode: "editing", activity: { key: "writing", params: { text: "y".repeat(5000) } } },
      { user: ada, viewOnly: false },
    );
    expect(long?.activity?.params?.text).toHaveLength(200);
  });

  test("never more than 4096 bytes encoded", () => {
    const huge = sanitizePeerState(
      {
        mode: "editing",
        activity: {
          key: "writing",
          params: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`p${i}`, "z".repeat(200)])),
        },
        sel: {
          slide: Array.from({ length: 200 }, (_, i) => `slide-element-${i}-${"q".repeat(40)}`),
          canvas: Array.from({ length: 200 }, (_, i) => `shape-${i}-${"w".repeat(50)}`),
        },
      },
      { user: { kind: "person", id: "p".repeat(64) }, viewOnly: false },
    );
    expect(huge).not.toBeNull();
    expect(bytes(huge)).toBeLessThanOrEqual(LIVE_LIMITS.awarenessBytes);
    expect(huge?.user.id).toHaveLength(64);
  });

  test("removals and junk", () => {
    expect(sanitizePeerState(null, { user: ada, viewOnly: false })).toBeNull();
    expect(sanitizePeerState("state", { user: ada, viewOnly: false })).toBeNull();
    expect(sanitizePeerState([], { user: ada, viewOnly: false })).toBeNull();
    expect(readPeerState({ mode: "editing" })).toBeNull();
    expect(readPeerState({ user: { kind: "robot", id: "x" } })).toBeNull();
    expect(readPeerState({ user: ada, mode: "editing", junk: 1 })).toEqual({ user: ada, mode: "editing" });
  });
});

describe("peersOf", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function room(): Awareness {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    cleanups.push(() => {
      awareness.destroy();
      doc.destroy();
    });
    return awareness;
  }

  function put(awareness: Awareness, clientId: number, state: Record<string, unknown> | null, lastUpdated = 1) {
    awareness.states.set(clientId, state as Record<string, unknown>);
    awareness.meta.set(clientId, { clock: 1, lastUpdated });
    if (state === null) awareness.states.delete(clientId);
  }

  test("one entry per person or agent; self first, agents at work, people editing, then viewers", () => {
    const awareness = room();
    awareness.setLocalState({ user: { kind: "person", id: "me" }, mode: "viewing" });
    put(awareness, 101, { user: { kind: "person", id: "theo" }, mode: "viewing" });
    put(awareness, 102, { user: { kind: "person", id: "ada" }, mode: "editing" });
    put(awareness, 103, { user: { kind: "agent", id: "atlas" }, mode: "editing" });
    put(awareness, 104, { user: { kind: "agent", id: "nova" }, mode: "viewing" });
    put(awareness, 105, { notAPeer: true });
    const peers = peersOf(awareness);
    expect(peers.map((p) => p.user.id)).toEqual(["me", "atlas", "ada", "nova", "theo"]);
    expect(peers[0]?.self).toBe(true);
    expect(peers.slice(1).every((p) => !p.self)).toBe(true);
  });

  test("several tabs of one person merge: editing wins, then the one seen last", () => {
    const awareness = room();
    awareness.setLocalState(null);
    put(awareness, 201, { user: ada, mode: "viewing", at: { slide: "old" } }, 10);
    put(awareness, 202, { user: ada, mode: "viewing", at: { slide: "new" } }, 20);
    let peers = peersOf(awareness);
    expect(peers).toHaveLength(1);
    expect(peers[0]?.state.at?.slide).toBe("new");
    put(awareness, 203, { user: ada, mode: "editing", at: { slide: "typing" } }, 5);
    peers = peersOf(awareness);
    expect(peers).toHaveLength(1);
    expect(peers[0]?.clientId).toBe(203);
    expect(peers[0]?.state.mode).toBe("editing");
  });

  test("this tab speaks for its person, and any of their tabs editing makes them editing", () => {
    const awareness = room();
    awareness.setLocalState({ user: ada, mode: "viewing", at: { slide: "here" } });
    put(awareness, 301, { user: ada, mode: "editing", at: { slide: "other-tab" } }, 99);
    const [me] = peersOf(awareness);
    expect(me?.self).toBe(true);
    expect(me?.clientId).toBe(awareness.clientID);
    expect(me?.state.at?.slide).toBe("here");
    expect(me?.state.mode).toBe("editing");
  });
});

describe("utf8Length", () => {
  test("counts what an encoder would write", () => {
    const encoder = new TextEncoder();
    for (const text of [
      "",
      "plain",
      "ação",
      "漢字",
      "🚀 and 🙂",
      "lone \ud83d high",
      "lone \ude00 low",
      "\u0080\u07ff\u0800",
    ]) {
      expect(utf8Length(text)).toBe(encoder.encode(text).length);
    }
  });
});

describe("agentClientId", () => {
  test("stable per run, different across runs and agents, a non-zero 32-bit number", () => {
    const a = agentClientId("run-1", "atlas");
    expect(agentClientId("run-1", "atlas")).toBe(a);
    expect(agentClientId("run-2", "atlas")).not.toBe(a);
    expect(agentClientId("run-1", "nova")).not.toBe(a);
    for (let i = 0; i < 1000; i++) {
      const id = agentClientId(`run-${i}`, "atlas");
      expect(Number.isInteger(id) && id > 0 && id <= 0xffffffff).toBe(true);
    }
  });
});
