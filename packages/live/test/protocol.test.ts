import { afterEach, describe, expect, test } from "bun:test";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { type PeerUser, peersOf, sanitizePeerState } from "../src/awareness";
import { fromBase64, toBase64 } from "../src/base64";
import {
  type AwarenessEntry,
  awarenessMessage,
  awarenessUpdateMessage,
  controlText,
  isLivePing,
  isLivePong,
  LIVE_CLOSE,
  LIVE_PING,
  LIVE_PONG,
  LIVE_PONG_UNSAVED,
  LiveProtocolError,
  liveShouldReconnect,
  MSG_AWARENESS,
  MSG_QUERY_AWARENESS,
  MSG_SYNC,
  parseControl,
  pongUnsaved,
  queryAwarenessMessage,
  type ReadContext,
  readAwarenessUpdate,
  readMessage,
  syncStep1,
  syncStep2,
  updateMessage,
  writeAwarenessUpdate,
} from "../src/protocol";

const SERVER = Symbol("server");
const NET = Symbol("network");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A peer: its document and its presence (destroyed after each test, since awareness keeps a timer). */
function peer(): { doc: Y.Doc; awareness: Awareness } {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  cleanups.push(() => {
    awareness.destroy();
    doc.destroy();
  });
  return { doc, awareness };
}

function text(doc: Y.Doc): string {
  return doc.getText("t").toString();
}

/** What a y-websocket server or client would make of our bytes: the outer type, then y-protocols' own reader. */
function readLikeYWebsocket(bytes: Uint8Array, doc: Y.Doc): { type: number; reply: Uint8Array | null } {
  const decoder = decoding.createDecoder(bytes);
  const type = decoding.readVarUint(decoder);
  if (type !== MSG_SYNC) return { type, reply: null };
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  syncProtocol.readSyncMessage(decoder, encoder, doc, NET);
  return { type, reply: encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : null };
}

describe("framing (y-websocket's)", () => {
  test("our messages are what y-protocols reads, and theirs are what we read", () => {
    const ours = peer();
    ours.doc.getText("t").insert(0, "hello");
    const theirs = peer();
    // Their step 1 → our step 2 → their document.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_SYNC);
    syncProtocol.writeSyncStep1(encoder, theirs.doc);
    const answer = readMessage(encoding.toUint8Array(encoder), {
      doc: ours.doc,
      awareness: ours.awareness,
      origin: SERVER,
      allowWrite: true,
    });
    expect(answer.type).toBe("sync");
    expect(answer.reply).toBeDefined();
    readLikeYWebsocket(answer.reply as Uint8Array, theirs.doc);
    expect(text(theirs.doc)).toBe("hello");
    // Our step 1 → their step 2 → our document.
    theirs.doc.getText("t").insert(5, " world");
    const reply = readLikeYWebsocket(syncStep1(ours.doc), theirs.doc).reply;
    expect(reply).not.toBeNull();
    const applied = readMessage(reply as Uint8Array, {
      doc: ours.doc,
      awareness: ours.awareness,
      origin: SERVER,
      allowWrite: true,
    });
    expect(applied.update).toBeDefined();
    expect(text(ours.doc)).toBe("hello world");
  });

  test("outer message types", () => {
    const { doc, awareness } = peer();
    expect(decoding.readVarUint(decoding.createDecoder(syncStep1(doc)))).toBe(MSG_SYNC);
    expect(decoding.readVarUint(decoding.createDecoder(awarenessMessage(awareness, [doc.clientID])))).toBe(
      MSG_AWARENESS,
    );
    expect(decoding.readVarUint(decoding.createDecoder(queryAwarenessMessage()))).toBe(MSG_QUERY_AWARENESS);
  });
});

describe("a full sync between a server and two apps", () => {
  test("offline edits on both sides meet, and live updates reach everyone", () => {
    const server = peer();
    server.doc.getText("t").insert(0, "server ");
    const ada = peer();
    ada.doc.getText("t").insert(0, "ada ");
    const atlas = peer();
    const serverCtx: ReadContext = { doc: server.doc, awareness: server.awareness, origin: SERVER, allowWrite: true };
    const toApp = (app: { doc: Y.Doc; awareness: Awareness }, bytes: Uint8Array) =>
      readMessage(bytes, { doc: app.doc, awareness: app.awareness, origin: NET, allowWrite: true });

    // Each app connects: sends its step 1, answers the server's step 1.
    for (const app of [ada, atlas]) {
      const step2 = readMessage(syncStep1(app.doc), serverCtx).reply as Uint8Array;
      toApp(app, step2);
      const back = toApp(app, syncStep1(server.doc)).reply as Uint8Array;
      readMessage(back, serverCtx);
    }
    // Atlas joined after Ada: it gets what Ada sent through the server's state.
    const catchUp = readMessage(syncStep1(atlas.doc), serverCtx).reply as Uint8Array;
    toApp(atlas, catchUp);
    expect(text(ada.doc)).toBe(text(server.doc));
    expect(text(atlas.doc)).toBe(text(server.doc));
    expect(text(server.doc)).toContain("ada");
    expect(text(server.doc)).toContain("server");

    // Live: Ada types; the server applies it and forwards the stored update to Atlas.
    const outbox: Uint8Array[] = [];
    ada.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== NET) outbox.push(updateMessage(update));
    });
    ada.doc.getText("t").insert(0, "» ");
    expect(outbox).toHaveLength(1);
    const result = readMessage(outbox[0] as Uint8Array, serverCtx);
    expect(result.type).toBe("sync");
    expect(result.update).toBeDefined();
    toApp(atlas, updateMessage(result.update as Uint8Array));
    expect(text(atlas.doc)).toBe(text(ada.doc));
    expect(text(server.doc)).toBe(text(ada.doc));

    // The same update again changes nothing, so nothing is stored twice.
    expect(readMessage(outbox[0] as Uint8Array, serverCtx).update).toBeUndefined();
  });

  test("phones send frames as base64 text", () => {
    const server = peer();
    const phone = peer();
    phone.doc.getText("t").insert(0, "from the phone");
    const ctx: ReadContext = { doc: server.doc, awareness: server.awareness, origin: SERVER, allowWrite: true };
    const frame = toBase64(syncStep1(server.doc));
    const step2 = readMessage(fromBase64(frame), { ...ctx, doc: phone.doc, awareness: phone.awareness });
    readMessage(fromBase64(toBase64(step2.reply as Uint8Array)), ctx);
    expect(text(server.doc)).toBe("from the phone");
  });
});

describe("read-only sockets", () => {
  test("writes are refused without touching the document; reads still work", () => {
    const server = peer();
    server.doc.getText("t").insert(0, "kept");
    const viewer = peer();
    viewer.doc.getText("t").insert(0, "nope ");
    const ctx: ReadContext = { doc: server.doc, awareness: server.awareness, origin: SERVER, allowWrite: false };
    const before = Y.encodeStateVector(server.doc);
    const step2 = readMessage(syncStep2(viewer.doc), ctx);
    expect(step2).toEqual({ type: "sync", rejected: true });
    const update = readMessage(updateMessage(Y.encodeStateAsUpdate(viewer.doc)), ctx);
    expect(update.rejected).toBe(true);
    expect(Y.encodeStateVector(server.doc)).toEqual(before);
    expect(text(server.doc)).toBe("kept");
    // The viewer still catches up from the server.
    const reply = readMessage(syncStep1(viewer.doc), ctx).reply as Uint8Array;
    readMessage(reply, { doc: viewer.doc, awareness: viewer.awareness, origin: NET, allowWrite: true });
    expect(text(viewer.doc)).toContain("kept");
  });
});

describe("malformed frames", () => {
  test("throw a protocol error, never half-apply", () => {
    const { doc, awareness } = peer();
    const ctx: ReadContext = { doc, awareness, origin: SERVER, allowWrite: true };
    expect(() => readMessage(new Uint8Array(), ctx)).toThrow(LiveProtocolError);
    expect(() => readMessage(new Uint8Array([9]), ctx)).toThrow(LiveProtocolError);
    expect(() => readMessage(new Uint8Array([MSG_SYNC, 7, 0]), ctx)).toThrow(LiveProtocolError);
    expect(() => readMessage(new Uint8Array([MSG_SYNC, 2, 5, 1, 2]), ctx)).toThrow(LiveProtocolError);
    expect(() => readMessage(new Uint8Array([MSG_AWARENESS, 3, 1, 2, 3]), ctx)).toThrow(LiveProtocolError);
    expect(() => readMessage(new Uint8Array([MSG_SYNC, 2, 3, 255, 255, 255]), ctx)).toThrow(LiveProtocolError);
    expect(doc.getText("t").length).toBe(0);
  });
});

describe("awareness", () => {
  const ada: PeerUser = { kind: "person", id: "ada" };

  test("a round trip through the server, which forces identity and sanitizes", () => {
    const server = peer();
    const app = peer();
    const other = peer();
    app.awareness.setLocalState({
      user: { kind: "person", id: "someone-else" },
      mode: "editing",
      at: { slide: "s1" },
      secret: "dropped",
      cursor: { x: 10, y: Number.NaN, space: "slide" },
    });
    const bound = new Map<number, PeerUser>([[app.doc.clientID, ada]]);
    const filter = (entry: AwarenessEntry): AwarenessEntry | null => {
      const user = bound.get(entry.clientId);
      if (!user) return null;
      if (entry.state === null) return entry;
      const state = sanitizePeerState(entry.state, { user, viewOnly: false });
      return state ? { ...entry, state } : null;
    };
    const ctx: ReadContext = {
      doc: server.doc,
      awareness: server.awareness,
      origin: SERVER,
      allowWrite: true,
      filterAwareness: filter,
    };
    const result = readMessage(awarenessMessage(app.awareness, [app.doc.clientID]), ctx);
    expect(result.type).toBe("awareness");
    const stored = server.awareness.getStates().get(app.doc.clientID);
    expect(stored).toEqual({ user: ada, mode: "editing", at: { slide: "s1" } });
    // Forwarded as it was applied, others see the sanitized state.
    expect(result.update).toBeDefined();
    readMessage(awarenessUpdateMessage(result.update as Uint8Array), {
      doc: other.doc,
      awareness: other.awareness,
      origin: NET,
      allowWrite: true,
    });
    const seen = peersOf(other.awareness).find((p) => p.user.id === "ada");
    expect(seen?.state.mode).toBe("editing");
    // A client the socket doesn't own is dropped.
    const intruder = peer();
    intruder.awareness.setLocalState({ user: ada, mode: "editing" });
    const dropped = readMessage(awarenessMessage(intruder.awareness, [intruder.doc.clientID]), ctx);
    expect(dropped.update).toBeUndefined();
    expect(server.awareness.getStates().has(intruder.doc.clientID)).toBe(false);
    // A removal goes through.
    app.awareness.setLocalState(null);
    readMessage(awarenessMessage(app.awareness, [app.doc.clientID]), ctx);
    expect(server.awareness.getStates().has(app.doc.clientID)).toBe(false);
  });

  test("a query gets every known state", () => {
    const server = peer();
    server.awareness.setLocalState({ user: { kind: "agent", id: "atlas" }, mode: "editing" });
    const app = peer();
    const reply = readMessage(queryAwarenessMessage(), {
      doc: server.doc,
      awareness: server.awareness,
      origin: SERVER,
      allowWrite: true,
    }).reply as Uint8Array;
    readMessage(reply, { doc: app.doc, awareness: app.awareness, origin: NET, allowWrite: true });
    expect(app.awareness.getStates().get(server.doc.clientID)).toEqual({
      user: { kind: "agent", id: "atlas" },
      mode: "editing",
    });
  });

  test("updates encode and decode", () => {
    const entries: AwarenessEntry[] = [
      { clientId: 1, clock: 3, state: { user: ada, mode: "viewing" } },
      { clientId: 2, clock: 9, state: null },
    ];
    expect(readAwarenessUpdate(writeAwarenessUpdate(entries))).toEqual(entries);
    expect(() => readAwarenessUpdate(new Uint8Array([2, 1]))).toThrow(LiveProtocolError);
  });
});

describe("control messages", () => {
  test("parse what the server sends, refuse anything else", () => {
    const controls = [
      { type: "live.ready", mode: "edit", seq: 12 },
      { type: "live.mode", mode: "view" },
      { type: "live.saved", seq: 0 },
      { type: "live.versions" },
      { type: "live.error", code: "too_large" },
    ] as const;
    for (const control of controls) expect(parseControl(controlText(control))).toEqual(control);
    expect(parseControl('{"type":"live.error","code":"newer"}')).toEqual({ type: "live.error", code: "invalid" });
    expect(parseControl('{"type":"live.ready","mode":"own","seq":1}')).toBeNull();
    expect(parseControl('{"type":"live.ready","mode":"edit","seq":-1}')).toBeNull();
    expect(parseControl('{"type":"live.saved","seq":1.5}')).toBeNull();
    expect(parseControl("[1]")).toBeNull();
    expect(parseControl("nope")).toBeNull();
    expect(parseControl(`{"type":"live.versions","pad":"${"x".repeat(5000)}"}`)).toBeNull();
    expect(parseControl(LIVE_PONG)).toBeNull();
  });

  test("pings, pongs and close codes", () => {
    expect(isLivePing(LIVE_PING)).toBe(true);
    expect(isLivePong(LIVE_PONG)).toBe(true);
    expect(isLivePing(LIVE_PONG)).toBe(false);
    expect(isLivePing("garbage")).toBe(false);
    // A pong may say changes before its ping still wait to be stored; it is a pong all the same.
    expect(isLivePong(LIVE_PONG_UNSAVED)).toBe(true);
    expect(pongUnsaved(LIVE_PONG_UNSAVED)).toBe(true);
    expect(pongUnsaved(LIVE_PONG)).toBe(false);
    expect(pongUnsaved("garbage")).toBe(false);
    expect(liveShouldReconnect(LIVE_CLOSE.behind)).toBe(true);
    expect(liveShouldReconnect(LIVE_CLOSE.goingAway)).toBe(true);
    expect(liveShouldReconnect(LIVE_CLOSE.forbidden)).toBe(false);
    expect(liveShouldReconnect(LIVE_CLOSE.notFound)).toBe(false);
  });
});
