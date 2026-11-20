import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createPostgresPubSub,
  liveTopic,
  MAX_NOTIFY_BYTES,
  orgTopic,
  type PubSub,
  type RealtimeEvent,
} from "@agenteschat/adapters";
import { and, asc, eq, schema } from "@agenteschat/db";
import { agentClientId, agentOrigin, LIVE_LIMITS, SYSTEM } from "@agenteschat/live";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { createChannel, type LiveDocs, type LiveTiming, NotFoundError, ValidationError } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import {
  cellValue,
  firstSheet,
  type LiveApp,
  liveDocsFor,
  makeLiveFile,
  openApp,
  quietLog,
  setCell,
  stateIn,
  until,
} from "./live-fixtures";

let f: Fixture;
let open: LiveDocs[] = [];
let apps: LiveApp[] = [];

beforeEach(async () => {
  f = await setup();
});

afterEach(async () => {
  for (const app of apps) app.leave();
  apps = [];
  for (const docs of open) await docs.stop();
  open = [];
  await f.close();
});

/** A process holding live files (stopped after the test). */
function process(id: string, overrides: Parameters<typeof liveDocsFor>[2] = {}) {
  const docs = liveDocsFor(f, id, overrides);
  open.push(docs);
  return docs;
}

async function app(docs: LiveDocs, fileId: string, userId = f.owner.id, mode?: "edit" | "view") {
  const made = await openApp(docs, f.org.id, fileId, userId, { mode });
  apps.push(made);
  await until(() => firstSheet(made.doc) !== null, "the app's first sync");
  return made;
}

const stored = (fileId: string) =>
  f.db
    .select()
    .from(schema.liveDocUpdates)
    .where(eq(schema.liveDocUpdates.artifactId, fileId))
    .orderBy(asc(schema.liveDocUpdates.seq));

/** An awareness frame whose entries claim any client id (what a socket must not get away with). */
function awarenessFrame(entries: { clientId: number; clock: number; state: unknown }[]) {
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(inner, entry.clientId);
    encoding.writeVarUint(inner, entry.clock);
    encoding.writeVarString(inner, JSON.stringify(entry.state));
  }
  const outer = encoding.createEncoder();
  encoding.writeVarUint(outer, 1);
  encoding.writeVarUint8Array(outer, encoding.toUint8Array(inner));
  return encoding.toUint8Array(outer);
}

/** A sync update frame, as an app sends a change. */
function updateFrame(update: Uint8Array) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, 2);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** The database refusing the next `n` transactions it is asked for (`refuse(n)`): a connection that drops. */
function flakyDb() {
  let refusing = 0;
  const db = new Proxy(f.db, {
    get(target, prop) {
      if (prop === "transaction" && refusing > 0) {
        refusing--;
        return () => Promise.reject(new Error("connection lost"));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    db,
    refuse: (n: number) => {
      refusing = n;
    },
  };
}

/** A process that hears nothing of other processes' changes: only its tail (`read`, the tail check) brings them. */
function deafPubSub(): PubSub {
  return {
    publish: (topic, event) => f.pubsub.publish(topic, event),
    subscribe: (topic, handler) =>
      f.pubsub.subscribe(topic, (event: RealtimeEvent) => {
        if (event.type !== "live.update") handler(event);
      }),
  };
}

describe("joining a document", () => {
  test("a socket hears the mode and the head, then the server's sync step 1; its first sync brings the file", async () => {
    const file = await makeLiveFile(f);
    const docs = process("a");
    const web = await app(docs, file.id);
    expect(web.controls[0]).toMatchObject({ type: "live.ready", mode: "edit", seq: 0 });
    expect(web.doc.getArray("sheetOrder").length).toBe(1);
    // Its first sheet is named in the language of who made it.
    expect(firstSheet(web.doc)?.sheet.get("name")).toBe("Planilha 1");
    await f.db.update(schema.users).set({ locale: "en" }).where(eq(schema.users.id, f.owner.id));
    const english = await makeLiveFile(f);
    const other = await app(docs, english.id);
    expect(firstSheet(other.doc)?.sheet.get("name")).toBe("Sheet 1");
  });

  test("a file that isn't there, or of another workspace, is not found", async () => {
    const docs = process("a");
    await expect(docs.join(f.org.id, crypto.randomUUID(), conn())).rejects.toBeInstanceOf(NotFoundError);
    await expect(docs.join(f.org.id, "not-a-file", conn())).rejects.toBeInstanceOf(NotFoundError);
    const file = await makeLiveFile(f);
    await expect(docs.join(crypto.randomUUID(), file.id, conn())).rejects.toBeInstanceOf(NotFoundError);
    function conn() {
      return { text: false, userId: f.owner.id, send() {}, close() {}, buffered: () => 0 };
    }
  });
});

describe("changes between people and processes", () => {
  test("a socket's change is stored before the others see it, then reaches a socket of another process", async () => {
    const file = await makeLiveFile(f);
    const a = process("a");
    const b = process("b");
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const web = await app(a, file.id);
    const phone = await app(b, file.id, ana.id);
    setCell(web.doc, 0, 0, 42);
    await until(() => cellValue(phone.doc, 0, 0) === 42, "the cell in the other process");
    const rows = await stored(file.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 1, actorType: "person", actorId: f.owner.id });
    // The socket that sent it hears it is stored.
    await until(() => web.saved() > 0, "live.saved");
    expect(web.control((c) => c.type === "live.saved")).toMatchObject({ seq: 1 });
    // And back: the other process's change reaches the first.
    setCell(phone.doc, 1, 0, "Café");
    await until(() => cellValue(web.doc, 1, 0) === "Café", "the phone's cell on the web");
    expect((await stored(file.id)).map((r) => r.actorId)).toEqual([f.owner.id, ana.id]);
  });

  test("an agent's edit in a process that holds no socket reaches the sockets of another", async () => {
    const file = await makeLiveFile(f);
    const worker = process("worker");
    const server = process("server");
    const web = await app(server, file.id);
    const runId = crypto.randomUUID();
    const { seq } = await worker.edit(f.org.id, file.id, agentOrigin(f.agent.id, runId), (doc) => {
      setCell(doc, 2, 1, 7);
      return "done";
    });
    expect(seq).toBe(1);
    await until(() => cellValue(web.doc, 2, 1) === 7, "the agent's cell");
    const [row] = await stored(file.id);
    expect(row).toMatchObject({ actorType: "agent", actorId: f.agent.id, runId });
  });

  test("changes from one socket within the window are one stored change; two people's, one each", async () => {
    const file = await makeLiveFile(f);
    const a = process("a", { timing: { coalesceMs: 80 } });
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const web = await app(a, file.id);
    const other = await app(a, file.id, ana.id);
    setCell(web.doc, 0, 0, 1);
    setCell(web.doc, 0, 1, 2);
    setCell(other.doc, 0, 2, 3);
    setCell(web.doc, 0, 3, 4);
    // Nothing a socket sent reaches the other before it is stored.
    await Bun.sleep(20);
    expect(cellValue(other.doc, 0, 0)).toBeUndefined();
    await until(() => web.saved() > 0 && other.saved() > 0, "both stored");
    const rows = await stored(file.id);
    expect(rows.map((r) => r.actorId).sort()).toEqual([ana.id, f.owner.id].sort());
    await until(() => cellValue(other.doc, 0, 3) === 4 && cellValue(web.doc, 0, 2) === 3, "each other's cells");
  });

  test("a NOTIFY lost on the way is healed by the tail check", async () => {
    const file = await makeLiveFile(f);
    // Process b hears nothing of the file's changes: only its tail check brings them.
    const deaf: PubSub = {
      publish: (topic, event) => f.pubsub.publish(topic, event),
      subscribe: (topic, handler) =>
        f.pubsub.subscribe(topic, (event: RealtimeEvent) => {
          if (event.type !== "live.update") handler(event);
        }),
    };
    const a = process("a");
    const b = process("b", { pubsub: deaf, timing: { tailCheckMs: 60 } });
    const phone = await app(b, file.id);
    await a.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 3, 3, "late"));
    await until(() => cellValue(phone.doc, 3, 3) === "late", "the change after a tail check");
  });

  test("a change past the inline limit goes by number; the other process reads it from the database", async () => {
    const file = await makeLiveFile(f);
    const a = process("a");
    const b = process("b");
    const phone = await app(b, file.id);
    const big = "x".repeat(20_000);
    await a.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 0, 0, big));
    await until(() => cellValue(phone.doc, 0, 0) === big, "the big cell");
  });

  test("every event a document publishes fits NOTIFY: small changes inline, big ones by number", async () => {
    const file = await makeLiveFile(f);
    const sent: string[] = [];
    const notifier = await createPostgresPubSub({
      listen: async () => async () => {},
      notify: async (_channel, payload) => {
        sent.push(payload);
      },
    });
    const a = process("a", { pubsub: notifier });
    try {
      await a.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 0, 0, "small"));
      await a.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 0, 1, "y".repeat(30_000)));
      await a.setAgentPresence(
        f.org.id,
        file.id,
        { agentId: f.agent.id, runId: crypto.randomUUID() },
        {
          activity: { key: "live.activity.writing", params: { range: "B2:Z900", note: "z".repeat(150) } },
          sel: { canvas: Array.from({ length: 200 }, (_, i) => `shape${i}`.padEnd(64, "q")) },
        },
      );
      await Bun.sleep(30);
      const updates = sent.map((p) => JSON.parse(p) as { t: string; e: RealtimeEvent });
      const changes = updates.filter((u) => u.t === liveTopic(file.id) && u.e.type === "live.update");
      expect(changes).toHaveLength(2);
      expect(typeof changes[0]?.e.u).toBe("string");
      expect(changes[1]?.e.u).toBeUndefined();
      expect(changes[1]?.e.seq).toBe(2);
      expect(updates.some((u) => u.e.type === "live.aw")).toBe(true);
      for (const payload of sent) expect(Buffer.byteLength(payload)).toBeLessThan(MAX_NOTIFY_BYTES);
    } finally {
      await notifier.close?.();
    }
  });
});

describe("what a socket may change", () => {
  test("a read-only socket's change is refused and never stored", async () => {
    const file = await makeLiveFile(f);
    const a = process("a");
    const reader = await app(a, file.id, f.owner.id, "view");
    expect(reader.controls[0]).toMatchObject({ type: "live.ready", mode: "view" });
    setCell(reader.doc, 0, 0, 99);
    await until(() => reader.errors.includes("read_only"), "live.error read_only");
    await Bun.sleep(30);
    expect(await stored(file.id)).toHaveLength(0);
    // Access changing in place: the same socket edits from now on.
    reader.session.setMode("edit");
    setCell(reader.doc, 0, 1, 5);
    await until(() => reader.saved() > 0, "stored once it may edit");
  });

  test("a frame over the limit is refused; bytes that aren't a message throw for the socket to refuse", async () => {
    const file = await makeLiveFile(f);
    const a = process("a");
    const web = await app(a, file.id);
    web.session.message(new Uint8Array(LIVE_LIMITS.updateBytes + 1));
    expect(web.errors).toContain("too_large");
    expect(() => web.session.message(new Uint8Array([7, 1, 2]))).toThrow();
  });

  test("past its limits a document takes only deletions, so it can be brought back under them", async () => {
    const file = await makeLiveFile(f);
    const a = process("a");
    const web = await app(a, file.id);
    // More sheets than a spreadsheet may hold, in one change (a hostile or broken app).
    const ids = Array.from({ length: LIVE_LIMITS.spreadsheet.sheets + 1 }, (_, i) => `sheet${i}`.padEnd(10, "x"));
    web.doc.getArray<string>("sheetOrder").push(ids);
    await until(() => web.saved() > 0, "the change past the limit, stored");
    const before = (await stored(file.id)).length;
    // Anything more that adds is refused...
    setCell(web.doc, 0, 0, "more");
    await until(() => web.errors.includes("too_large"), "live.error too_large");
    await Bun.sleep(30);
    expect((await stored(file.id)).length).toBe(before);
    // ...an agent's too...
    await expect(a.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 1, 1, "x"))).rejects.toMatchObject({
      code: "live.too_large",
    });
    // ...but deletions go through, and below the limit the document takes changes again.
    await a.edit(f.org.id, file.id, SYSTEM, (doc) => doc.getArray<string>("sheetOrder").delete(1, ids.length));
    await a.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 1, 1, "back"));
    await until(() => cellValue(web.doc, 1, 1) === "back", "a change after coming back under");
  });
});

describe("edits", () => {
  test("a progressive edit lands in steps that others watch fill in", async () => {
    const file = await makeLiveFile(f);
    const a = process("a");
    const web = await app(a, file.id);
    const seen: number[] = [];
    web.doc.on("update", () => {
      seen.push([0, 1, 2, 3].filter((r) => cellValue(web.doc, r, 0) !== undefined).length);
    });
    const { seq, result } = await a.edit(
      f.org.id,
      file.id,
      agentOrigin(f.agent.id, crypto.randomUUID()),
      async (doc, step) => {
        for (let r = 0; r < 4; r++) {
          setCell(doc, r, 0, r);
          await step();
        }
        return "filled";
      },
      { progressive: true },
    );
    expect(result).toBe("filled");
    expect(seq).toBe(4);
    expect(await stored(file.id)).toHaveLength(4);
    await until(() => cellValue(web.doc, 3, 0) === 3, "the last row");
    expect(seen).toContain(1);
  });

  test("what an edit changed before it failed is stored all the same; the failure goes up", async () => {
    const file = await makeLiveFile(f);
    const a = process("a");
    await expect(
      a.edit(f.org.id, file.id, SYSTEM, (doc) => {
        setCell(doc, 0, 0, "half");
        throw new Error("the tool broke");
      }),
    ).rejects.toThrow("the tool broke");
    const { doc } = await a.read(f.org.id, file.id);
    expect(cellValue(doc, 0, 0)).toBe("half");
    doc.destroy();
  });

  test("edits of one document run one at a time, and each sees the last one's work", async () => {
    const file = await makeLiveFile(f);
    const a = process("a");
    const runs = Array.from({ length: 5 }, (_, i) =>
      a.edit(f.org.id, file.id, SYSTEM, async (doc) => {
        const before = Number(cellValue(doc, 0, 0) ?? 0);
        await Bun.sleep(2);
        setCell(doc, 0, 0, before + 1);
        return i;
      }),
    );
    const results = await Promise.all(runs);
    expect(results.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    const { doc } = await a.read(f.org.id, file.id);
    expect(cellValue(doc, 0, 0)).toBe(5);
    doc.destroy();
  });

  test("an edit needs its origin, and a file that isn't there is not found", async () => {
    const a = process("a");
    const file = await makeLiveFile(f);
    await expect(a.edit(f.org.id, file.id, {} as never, () => {})).rejects.toBeInstanceOf(ValidationError);
    await expect(a.edit(f.org.id, crypto.randomUUID(), SYSTEM, () => {})).rejects.toBeInstanceOf(NotFoundError);
  });

  test("state and read give the head, whether this process holds the file or not", async () => {
    const file = await makeLiveFile(f);
    const a = process("a");
    const b = process("b");
    await a.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 0, 0, "head"));
    const fromDb = await b.state(f.org.id, file.id);
    const held = await a.state(f.org.id, file.id);
    for (const { state, seq } of [fromDb, held]) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, state);
      expect(cellValue(doc, 0, 0)).toBe("head");
      expect(seq).toBe(1);
      doc.destroy();
    }
    await expect(b.state(crypto.randomUUID(), file.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("presence", () => {
  test("the server says who each one is, and a socket can't speak for another one's client", async () => {
    const file = await makeLiveFile(f);
    const a = process("a");
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const mine = await app(a, file.id);
    const hers = await app(a, file.id, ana.id);
    const third = await app(a, file.id, ana.id);
    mine.awareness.setLocalState({ user: { kind: "person", id: ana.id }, mode: "editing", at: { sheet: "s1" } });
    await until(() => (stateIn(hers, mine.doc.clientID)?.at as { sheet?: string })?.sheet === "s1", "my place");
    expect(stateIn(hers, mine.doc.clientID)?.user).toEqual({ kind: "person", id: f.owner.id });
    hers.awareness.setLocalState({ user: { kind: "person", id: ana.id }, mode: "viewing", at: { sheet: "s2" } });
    await until(() => (stateIn(third, hers.doc.clientID)?.at as { sheet?: string })?.sheet === "s2", "her place");
    // My socket claims her client: ignored, so nobody sees her somewhere she isn't.
    const before = stateIn(third, hers.doc.clientID);
    const forged = { user: { kind: "person", id: ana.id }, mode: "editing", at: { sheet: "forged" } };
    mine.raw(awarenessFrame([{ clientId: hers.doc.clientID, clock: 10_000, state: forged }]));
    await Bun.sleep(40);
    expect(stateIn(third, hers.doc.clientID)).toEqual(before);
  });

  test("someone in another process shows in this one, with their mode, and goes when they leave", async () => {
    const file = await makeLiveFile(f);
    const a = process("a");
    const b = process("b");
    const web = await app(a, file.id);
    const phone = await app(b, file.id);
    phone.awareness.setLocalState({ user: { kind: "person", id: f.owner.id }, mode: "editing", at: { sheet: "s9" } });
    await until(() => stateIn(web, phone.doc.clientID)?.mode === "editing", "the phone's presence on the web");
    // Who is in the file, as any process answers it: the one holding the socket, and the other from its summary.
    await until(() => (a.presenceOf([file.id]).get(file.id)?.length ?? 0) === 1, "a's summary");
    await until(() => (b.presenceOf([file.id]).get(file.id)?.length ?? 0) === 1, "b's own");
    const c = process("c");
    await until(() => (c.presenceOf([file.id]).get(file.id) ?? []).length === 1, "a process holding nothing");
    expect(c.presenceOf([file.id]).get(file.id)).toEqual([{ kind: "person", id: f.owner.id, mode: "editing" }]);
    phone.leave();
    await until(() => stateIn(web, phone.doc.clientID) === undefined, "gone from the web");
    await until(() => (c.presenceOf([file.id]).get(file.id) ?? []).length === 0, "gone from the summaries");
  });

  test("a person who hides isn't shown in a file, yet their changes arrive; hiding later takes them out", async () => {
    const file = await makeLiveFile(f);
    const a = process("a");
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const hide = async (userId: string, availability: "hidden" | "auto") => {
      await f.db
        .update(schema.organizationMembers)
        .set({ availability })
        .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, userId)));
      await f.pubsub.publish(orgTopic(f.org.id), {
        type: "org.broadcast",
        orgId: f.org.id,
        event: { type: "member.status", orgId: f.org.id, userId },
      });
    };
    await hide(ana.id, "hidden");
    const watcher = await app(a, file.id);
    const hidden = await app(a, file.id, ana.id);
    const shown = await app(a, file.id, bia.id);
    hidden.awareness.setLocalState({ user: { kind: "person", id: ana.id }, mode: "editing" });
    shown.awareness.setLocalState({ user: { kind: "person", id: bia.id }, mode: "editing" });
    await until(() => stateIn(watcher, shown.doc.clientID) !== undefined, "bia's presence");
    await Bun.sleep(30);
    expect(stateIn(watcher, hidden.doc.clientID)).toBeUndefined();
    expect(
      a
        .presenceOf([file.id])
        .get(file.id)
        ?.map((p) => p.id),
    ).toEqual([bia.id]);
    setCell(hidden.doc, 0, 0, "from ana");
    await until(() => cellValue(watcher.doc, 0, 0) === "from ana", "her change");
    // Bia hides while she is in the file: she is gone for everyone at once.
    await hide(bia.id, "hidden");
    await until(() => stateIn(watcher, shown.doc.clientID) === undefined, "bia hidden");
  });

  test("an agent's presence takes its run's client id, shows everywhere, and leaves after its linger", async () => {
    const file = await makeLiveFile(f);
    const worker = process("worker");
    const server = process("server");
    const web = await app(server, file.id);
    const runId = crypto.randomUUID();
    const clientId = agentClientId(runId, f.agent.id);
    await worker.edit(f.org.id, file.id, agentOrigin(f.agent.id, runId), (doc) => setCell(doc, 0, 0, 1), {
      presence: { at: { sheet: firstSheet(web.doc)?.id ?? "" }, activity: { key: "live.activity.writing" } },
    });
    await until(() => stateIn(web, clientId) !== undefined, "the agent's presence");
    expect(stateIn(web, clientId)).toMatchObject({ user: { kind: "agent", id: f.agent.id }, mode: "editing" });
    expect(server.presenceOf([file.id]).get(file.id)).toContainEqual({
      kind: "agent",
      id: f.agent.id,
      mode: "editing",
    });
    // Its linger over, it is gone from the file.
    await until(() => stateIn(web, clientId) === undefined, "the agent gone", 3000);
    // Set and taken back by hand.
    await worker.setAgentPresence(f.org.id, file.id, { agentId: f.agent.id, runId }, { mode: "viewing" });
    await until(() => stateIn(web, clientId)?.mode === "viewing", "viewing");
    await worker.setAgentPresence(f.org.id, file.id, { agentId: f.agent.id, runId }, null);
    await until(() => stateIn(web, clientId) === undefined, "taken back");
  });

  test("a file in a conversation tells it who is in changed (ids only)", async () => {
    const eng = await createChannel(f.db, f.owner.id, f.org.id, { name: "eng", visibility: "private" });
    const file = await makeLiveFile(f, "canvas", { channelId: eng.id });
    const events = f.listen(eng.id);
    const a = process("a");
    const web = await openApp(a, f.org.id, file.id, f.owner.id);
    apps.push(web);
    web.awareness.setLocalState({ user: { kind: "person", id: f.owner.id }, mode: "viewing" });
    await until(() => events.some((e) => e.type === "live.presence"), "live.presence");
    expect(events.find((e) => e.type === "live.presence")).toEqual({
      type: "live.presence",
      channelId: eng.id,
      artifactId: file.id,
    });
  });
});

describe("versions from the documents", () => {
  test("a version saved by hand stores what the sockets sent first; nothing new writes none", async () => {
    const file = await makeLiveFile(f);
    const a = process("a", { timing: { coalesceMs: 5000 } });
    const web = await app(a, file.id);
    setCell(web.doc, 0, 0, "typed");
    await until(() => web.frames.length > 0, "frames");
    await Bun.sleep(20);
    const version = await a.checkpoint(f.org.id, file.id, { author: { type: "person", id: f.owner.id }, force: true });
    expect(version).toBe(2);
    await until(() => web.controls.some((c) => c.type === "live.versions"), "live.versions");
    expect(await a.checkpoint(f.org.id, file.id, { author: { type: "person", id: f.owner.id }, force: true })).toBe(
      null,
    );
  });

  test("restore brings the file back for everyone and records a version saying so", async () => {
    const file = await makeLiveFile(f);
    const a = process("a");
    const b = process("b");
    const phone = await app(b, file.id);
    await a.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 0, 0, 10));
    const saved = await a.checkpoint(f.org.id, file.id, { author: { type: "person", id: f.owner.id }, force: true });
    await a.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 0, 0, 99));
    await until(() => cellValue(phone.doc, 0, 0) === 99, "99 on the phone");
    const restored = await a.restore(f.org.id, file.id, saved ?? 0, { type: "person", id: f.owner.id });
    expect(restored).toBeGreaterThan(saved ?? 0);
    await until(() => cellValue(phone.doc, 0, 0) === 10, "back to 10 on the phone");
    const [version] = await f.db
      .select()
      .from(schema.artifactVersions)
      .where(and(eq(schema.artifactVersions.artifactId, file.id), eq(schema.artifactVersions.version, restored)));
    // In the language of who restored it.
    expect(version?.note).toBe(`Versão ${saved} restaurada`);
    const audit = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.targetId, file.id), eq(schema.auditLog.action, "artifact.version_restored")));
    expect(audit[0]?.details).toMatchObject({ from: saved, version: restored });
    await expect(a.restore(f.org.id, file.id, 999, { type: "person", id: f.owner.id })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("leaving and stopping", () => {
  test("a document nobody uses goes from memory, and comes back with everything when asked again", async () => {
    const file = await makeLiveFile(f);
    const a = process("a");
    const web = await app(a, file.id);
    setCell(web.doc, 0, 0, "kept");
    await until(() => web.saved() > 0, "stored");
    web.leave();
    await Bun.sleep(150);
    const { doc } = await a.read(f.org.id, file.id);
    expect(cellValue(doc, 0, 0)).toBe("kept");
    doc.destroy();
    // A minute after the last person left, a compaction is due.
    const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "live.compact"));
    expect(job?.payload).toEqual({ fileId: file.id });
  });

  test("stopping stores what the sockets sent and closes them 1001", async () => {
    const file = await makeLiveFile(f);
    const a = liveDocsFor(f, "a", { timing: { coalesceMs: 60_000 } });
    const web = await openApp(a, f.org.id, file.id, f.owner.id);
    await until(() => firstSheet(web.doc) !== null, "sync");
    setCell(web.doc, 0, 0, "last words");
    await until(() => web.frames.length > 0, "frames");
    await Bun.sleep(20);
    await a.stop();
    expect(web.closed[0]?.code).toBe(1001);
    const rows = await stored(file.id);
    expect(rows).toHaveLength(1);
    const late = { text: false, userId: f.owner.id, send() {}, close() {}, buffered: () => 0 };
    await expect(a.join(f.org.id, file.id, late)).rejects.toThrow();
  });

  test("a file purged while open: its sockets close 4404 at the next store", async () => {
    const file = await makeLiveFile(f);
    const a = process("a");
    const web = await app(a, file.id);
    await f.db.delete(schema.liveDocs).where(eq(schema.liveDocs.artifactId, file.id));
    setCell(web.doc, 0, 0, "lost");
    await until(() => web.closed.length > 0, "closed");
    expect(web.closed[0]?.code).toBe(4404);
  });

  test("a document nobody uses keeps what the database refused once, stores it on the retry, then goes", async () => {
    const file = await makeLiveFile(f);
    const flaky = flakyDb();
    // Deaf to other processes' changes, so its state says whether it still holds the file.
    const a = process("a", {
      db: flaky.db,
      pubsub: deafPubSub(),
      timing: { coalesceMs: 60_000, lingerMs: 20, retryMs: [30, 60] },
    });
    const web = await app(a, file.id);
    setCell(web.doc, 0, 0, "kept");
    await Bun.sleep(30);
    // The person leaves before the change is stored (the tab closed): only this process holds it now. The store
    // `unload` tries first is refused.
    flaky.refuse(1);
    web.leave();
    for (let i = 0; i < 100 && (await stored(file.id)).length === 0; i++) await Bun.sleep(10);
    expect(await stored(file.id)).toHaveLength(1);
    // Stored, it let the file go: what another process writes now is what its state reads.
    await Bun.sleep(100);
    await process("b").edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 1, 1, "later"));
    const doc = new Y.Doc();
    Y.applyUpdate(doc, (await a.state(f.org.id, file.id)).state);
    expect([cellValue(doc, 0, 0), cellValue(doc, 1, 1)]).toEqual(["kept", "later"]);
    doc.destroy();
  });
});

describe("stopping while the database refuses", () => {
  /** A change an app sent and left before it was stored: what a process holds alone when it stops. */
  async function heldAlone(timing: Partial<LiveTiming> = {}) {
    const file = await makeLiveFile(f);
    const flaky = flakyDb();
    const errors: { message: string; data?: Record<string, unknown> }[] = [];
    const a = process("a", {
      db: flaky.db,
      log: { ...quietLog, error: (message, data) => errors.push({ message, data }) },
      timing: { coalesceMs: 60_000, lingerMs: 60_000, ...timing },
    });
    const web = await app(a, file.id);
    setCell(web.doc, 0, 0, "last words");
    await Bun.sleep(30);
    // Its socket went long before the stop, as a server's do (they close first).
    web.leave();
    return { file, a, flaky, errors };
  }

  test("a store refused just then is tried once more before the document goes", async () => {
    const { file, a, flaky, errors } = await heldAlone();
    flaky.refuse(1);
    await a.stop();
    expect(await stored(file.id)).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test("one still refused is given up within the stop's grace, said loudly with the file and its bytes", async () => {
    const { file, a, flaky, errors } = await heldAlone({ stopRetryMs: 500 });
    flaky.refuse(100);
    const started = Date.now();
    await a.stop();
    expect(Date.now() - started).toBeLessThan(500);
    expect(await stored(file.id)).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("live changes lost at shutdown");
    expect(errors[0]?.data).toMatchObject({ orgId: f.org.id, fileId: file.id, changes: 1 });
    expect(errors[0]?.data?.bytes).toBeGreaterThan(0);
  });
});

describe("changes that wait on others", () => {
  test("one waiting on a change this process doesn't hold yet is stored as it came, and reaches everyone", async () => {
    const file = await makeLiveFile(f);
    // Process a hears nothing of b's changes until it reads its tail.
    const a = process("a", { pubsub: deafPubSub() });
    const b = process("b");
    const web = await app(a, file.id);
    const phone = await app(a, file.id);
    await b.edit(f.org.id, file.id, SYSTEM, (doc) => setCell(doc, 0, 0, "first"));
    // An app that loaded the file elsewhere writes over b's change: in a, its change waits on b's.
    const { doc: elsewhere } = await b.read(f.org.id, file.id);
    const updates: Uint8Array[] = [];
    elsewhere.on("update", (update: Uint8Array) => updates.push(update));
    setCell(elsewhere, 0, 0, "second");
    elsewhere.destroy();
    web.raw(updateFrame(updates[0] as Uint8Array));
    await until(() => web.saved() > 0, "stored");
    // Stored as it came: the file's head has it, whatever becomes of process a.
    expect(await stored(file.id)).toHaveLength(2);
    const { doc: head } = await process("c").read(f.org.id, file.id);
    expect(cellValue(head, 0, 0)).toBe("second");
    head.destroy();
    // Once a reads its tail, the other socket gets b's change and, sent to it already, the one that waited on it.
    (await a.read(f.org.id, file.id)).doc.destroy();
    await until(() => cellValue(phone.doc, 0, 0) === "second", "the change on the other socket");
  });
});

describe("compaction the documents ask for", () => {
  const compactions = () => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "live.compact"));

  test("a young file's changes past the bytes ask at once; asked again only once that one ran", async () => {
    const file = await makeLiveFile(f);
    const a = process("a");
    const big = (c: number, ch: string) => (doc: Y.Doc) => setCell(doc, 0, c, ch.repeat(600 * 1024));
    await a.edit(f.org.id, file.id, SYSTEM, big(0, "x"));
    expect((await compactions()).map((job) => job.payload)).toEqual([{ fileId: file.id }]);
    // Asked and not run yet: not asked again so soon.
    await a.edit(f.org.id, file.id, SYSTEM, big(1, "y"));
    expect(await compactions()).toHaveLength(1);
    // Once it ran, the next heavy change asks again.
    await a.compact(f.org.id, file.id);
    await a.edit(f.org.id, file.id, SYSTEM, big(2, "z"));
    expect(await compactions()).toHaveLength(2);
  });
});
