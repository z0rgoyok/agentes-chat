import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMemoryRateLimiter, listenResumedTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { createLogger } from "../src/logger";
import { createLiveSockets, type LiveSocketLimits } from "../src/realtime/live";
import { createRealtime, type SocketData } from "../src/realtime/ws";
import {
  type Browser,
  browser,
  createTestServer,
  joinByInvitation,
  listen,
  ORIGIN,
  seedOrg,
  signUp,
  type TestServer,
  upgradeStatus,
} from "./harness";
import { cellValue, forgedAwareness, type LivePeer, livePeer, setCell } from "./live-files-peer";

let t: TestServer;
let server: ReturnType<typeof listen>;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  server = listen(t);
});
afterEach(async () => {
  // Bun never resolves stop(true) after the server itself closed a socket whose client lives in the same process.
  await Promise.race([server.stop(true), Bun.sleep(500)]);
  await t.close();
});

const liveUrl = (port: number, orgId: string, fileId: string, extra = "") =>
  `ws://127.0.0.1:${port}/api/live?orgId=${orgId}&fileId=${fileId}${extra}`;
const headersOf = (b: Browser) => ({ origin: ORIGIN, cookie: b.cookie() });
const meOf = async (b: Browser) => ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;

/** A live file made the way the apps make one. */
async function makeFile(b: Browser, orgId: string, input: { kind: string; title: string; channelId?: string }) {
  const res = await b(`/api/app/organizations/${orgId}/live-files`, { json: input });
  if (res.status !== 201) throw new Error(`create: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; kind: string };
}

/** The owner of Acme with a spreadsheet in the shared Drive (the whole workspace reads it). */
async function seeded() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const org = await seedOrg(owner);
  const file = await makeFile(owner, org.orgId, { kind: "spreadsheet", title: "Budget" });
  const url = (extra = "") => liveUrl(server.port as number, org.orgId, file.id, extra);
  return { owner, ownerId: await meOf(owner), org, file, url };
}

/** The mode a socket was last told: `live.ready`'s, then each `live.mode`. */
const modeOf = (peer: LivePeer) =>
  peer.controls.filter((c) => c.type === "live.ready" || c.type === "live.mode").at(-1)?.mode;

/** The same server with its live sockets' limits changed, on a port of its own. */
function liveServer(limits: Partial<LiveSocketLimits>) {
  const live = createLiveSockets({
    db: t.db,
    auth: t.auth,
    config: t.config,
    pubsub: t.adapters.pubsub,
    rateLimiter: createMemoryRateLimiter(),
    docs: t.engine.live,
    artifacts: t.engine.artifacts,
    limits,
  });
  const realtime = createRealtime({
    db: t.db,
    auth: t.auth,
    config: t.config,
    log: createLogger("error"),
    ...t.adapters,
    live,
  });
  const other = Bun.serve<SocketData>({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => realtime.fetch(req, srv, (r) => t.app.fetch(r)),
    websocket: realtime.websocket,
  });
  return {
    live,
    port: other.port as number,
    stop: async () => {
      live.stop();
      await Promise.race([other.stop(true), Bun.sleep(500)]);
    },
  };
}

describe("opening a live file's socket", () => {
  test("refuses before the upgrade: no session, another site, a stranger, bad parameters, a file out of reach", async () => {
    const { owner, org, file, url } = await seeded();
    const cookie = owner.cookie();
    expect(await upgradeStatus(url(), { origin: ORIGIN })).toBe(401);
    expect(await upgradeStatus(url(), { origin: "https://evil.example", cookie })).toBe(403);
    // No Origin and not the phone app: a page elsewhere could have opened it.
    expect(await upgradeStatus(url(), { cookie })).toBe(403);
    const stranger = browser(t);
    await signUp(stranger, "stranger@example.com");
    expect(await upgradeStatus(url(), { origin: ORIGIN, cookie: stranger.cookie() })).toBe(403);
    const port = server.port as number;
    expect(await upgradeStatus(liveUrl(port, org.orgId, "not-a-file"), { origin: ORIGIN, cookie })).toBe(400);
    expect(await upgradeStatus(liveUrl(port, "not-an-org", file.id), { origin: ORIGIN, cookie })).toBe(400);
    const nowhere = "0193a2b4-0000-7000-8000-000000000000";
    expect(await upgradeStatus(liveUrl(port, org.orgId, nowhere), { origin: ORIGIN, cookie })).toBe(404);
    // A file in a private conversation another member isn't in: not found, never "forbidden".
    const channel = await owner(`/api/app/organizations/${org.orgId}/channels`, {
      json: { name: "eng", visibility: "private" },
    });
    expect(channel.status).toBe(201);
    const { id: channelId } = (await channel.json()) as { id: string };
    const hidden = await makeFile(owner, org.orgId, { kind: "canvas", title: "Roadmap", channelId });
    const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
    expect(await upgradeStatus(liveUrl(port, org.orgId, hidden.id), headersOf(ana))).toBe(404);
    // A table is no live file.
    const doc = await owner(`/api/app/organizations/${org.orgId}/artifacts`, {
      json: { title: "Notes", content: { kind: "table", columns: ["a"], rows: [["1"]] } },
    });
    const { id: docId } = (await doc.json()) as { id: string };
    expect(await upgradeStatus(liveUrl(port, org.orgId, docId), { origin: ORIGIN, cookie })).toBe(404);
  });

  test("the phone app opens it without an Origin, with its own header", async () => {
    const { owner, url } = await seeded();
    const phone = livePeer(url("&text=1"), { cookie: owner.cookie(), "x-agentes-client": "mobile" }, { text: true });
    await phone.opened;
    expect((await phone.ready()).mode).toBe("edit");
    phone.close();
  });

  test("a person keeps a few files open at once, and opens only so many a minute", async () => {
    const { owner, url } = await seeded();
    const capped = liveServer({ perPerson: 2, opensPerMinute: 4 });
    try {
      const at = (extra = "") => url(extra).replace(`:${server.port}/`, `:${capped.port}/`);
      const peers = [livePeer(at(), headersOf(owner)), livePeer(at(), headersOf(owner))];
      await Promise.all(peers.map((p) => p.ready()));
      expect(await upgradeStatus(at(), headersOf(owner))).toBe(429);
      for (const p of peers) p.close();
      await Promise.all(peers.map((p) => p.closed));
      // Two opened, one refused for the count: one more open this minute, then none.
      const third = livePeer(at(), headersOf(owner));
      await third.ready();
      third.close();
      await third.closed;
      expect(await upgradeStatus(at(), headersOf(owner))).toBe(429);
    } finally {
      await capped.stop();
    }
  });
});

describe("editing together", () => {
  test("two people's sockets on one file: each change reaches the other, and the file keeps both", async () => {
    const { owner, org, file, url } = await seeded();
    const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
    // The web app loads the state over HTTP first; the phone's socket (base64 text frames) catches up from nothing.
    const opened = (await (await owner(`/api/app/organizations/${org.orgId}/artifacts/${file.id}/live`)).json()) as {
      state: string;
    };
    const web = livePeer(url(), headersOf(owner), { state: opened.state });
    const phone = livePeer(url("&text=1"), { cookie: ana.cookie(), "x-agentes-client": "mobile" }, { text: true });
    try {
      expect((await web.ready()).mode).toBe("edit");
      expect((await phone.ready()).mode).toBe("edit");
      await web.until(() => web.sheet() !== null, "the web's sheet");
      await phone.until(() => phone.sheet() !== null, "the phone's sheet");
      expect(phone.sheet()?.id).toBe(web.sheet()?.id);

      setCell(web.doc, 0, 0, 42);
      await phone.until(() => cellValue(phone.doc, 0, 0) === 42, "the web's cell on the phone");
      setCell(phone.doc, 1, 0, "Café");
      await web.until(() => cellValue(web.doc, 1, 0) === "Café", "the phone's cell on the web");
      // What each sent is stored: the socket says so.
      await web.control((c) => c.type === "live.saved", "live.saved");

      // Someone who opens it now finds both, from the server.
      const late = livePeer(url(), headersOf(owner));
      try {
        await late.ready();
        await late.until(() => cellValue(late.doc, 0, 0) === 42 && cellValue(late.doc, 1, 0) === "Café", "both cells");
      } finally {
        late.close();
      }
    } finally {
      web.close();
      phone.close();
    }
  });

  test("a read-only socket takes no change: the file went to the trash, and changes come back with it", async () => {
    const { owner, org, file, url } = await seeded();
    const web = livePeer(url(), headersOf(owner));
    try {
      await web.ready();
      await web.until(() => web.sheet() !== null, "the sheet");
      setCell(web.doc, 0, 1, 7);
      await web.control((c) => c.type === "live.saved", "the first change stored");

      expect(
        (await owner(`/api/app/organizations/${org.orgId}/artifacts/${file.id}`, { method: "DELETE" })).status,
      ).toBe(204);
      // Told in place, without closing.
      await web.until(() => modeOf(web) === "view", "live.mode view");
      setCell(web.doc, 0, 1, 99);
      await web.until(() => web.errors.includes("read_only"), "live.error read_only");

      // Whoever opens it now reads it read-only, without the refused change.
      const reader = livePeer(url(), headersOf(owner));
      try {
        await reader.ready();
        await reader.until(() => modeOf(reader) === "view", "a read-only socket");
        await reader.until(() => cellValue(reader.doc, 0, 1) === 7, "the stored cell");
        await Bun.sleep(100);
        expect(cellValue(reader.doc, 0, 1)).toBe(7);
      } finally {
        reader.close();
      }

      expect(
        (await owner(`/api/app/organizations/${org.orgId}/artifacts/${file.id}/restore`, { json: {} })).status,
      ).toBe(200);
      await web.until(() => modeOf(web) === "edit", "live.mode edit again");
    } finally {
      web.close();
    }
  });

  test("editable again, the app hears so before the server asks what it lacks, so it can answer", async () => {
    const { owner, org, file, url } = await seeded();
    const web = livePeer(url(), headersOf(owner));
    try {
      await web.ready();
      await web.until(() => web.sheet() !== null, "the sheet");
      const artifact = `/api/app/organizations/${org.orgId}/artifacts/${file.id}`;
      expect((await owner(artifact, { method: "DELETE" })).status).toBe(204);
      await web.until(() => modeOf(web) === "view", "live.mode view");
      const from = web.inbox.length;
      expect((await owner(`${artifact}/restore`, { json: {} })).status).toBe(200);
      await web.until(() => web.inbox.slice(from).includes("sync:0"), "the server's sync step 1");
      // An app answers a step 1 only in `edit` (ours holds back while read-only), so `live.mode` must come first.
      const after = web.inbox.slice(from);
      expect(after.indexOf("live.mode")).toBeGreaterThanOrEqual(0);
      expect(after.indexOf("live.mode")).toBeLessThan(after.indexOf("sync:0"));
    } finally {
      web.close();
    }
  });
});

describe("presence", () => {
  test("the server says who each one is; a socket can't speak for another one's client", async () => {
    const { owner, ownerId, org, url } = await seeded();
    const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
    const anaId = await meOf(ana);
    const mine = livePeer(url(), headersOf(owner));
    const hers = livePeer(url(), headersOf(ana));
    const third = livePeer(url(), headersOf(ana));
    try {
      await Promise.all([mine.ready(), hers.ready(), third.ready()]);
      // Whatever it claims, the owner's app is the owner.
      mine.awareness.setLocalState({ user: { kind: "person", id: anaId }, mode: "editing", at: { sheet: "s1" } });
      const seenMine = () => hers.awareness.getStates().get(mine.doc.clientID) as Record<string, unknown> | undefined;
      await hers.until(() => (seenMine()?.at as { sheet?: string } | undefined)?.sheet === "s1", "the owner's place");
      expect(seenMine()?.user).toEqual({ kind: "person", id: ownerId });

      hers.awareness.setLocalState({ user: { kind: "person", id: anaId }, mode: "viewing", at: { sheet: "s2" } });
      const seenHers = () => third.awareness.getStates().get(hers.doc.clientID) as Record<string, unknown> | undefined;
      await third.until(() => (seenHers()?.at as { sheet?: string } | undefined)?.sheet === "s2", "Ana's place");

      // The owner's socket claims Ana's client: dropped, so nobody sees her somewhere she isn't.
      const forged = { user: { kind: "person", id: anaId }, mode: "editing", at: { sheet: "forged" } };
      mine.raw(forgedAwareness([{ clientId: hers.doc.clientID, clock: 10_000, state: forged }]));
      await Bun.sleep(300);
      expect((seenHers()?.at as { sheet?: string } | undefined)?.sheet).toBe("s2");
      expect(seenHers()?.user).toEqual({ kind: "person", id: anaId });
    } finally {
      mine.close();
      hers.close();
      third.close();
    }
  });
});

describe("what a socket may send", () => {
  test("a frame over the limit, text on a binary socket and bytes that aren't a message are refused; it goes on", async () => {
    const { owner, url } = await seeded();
    const web = livePeer(url(), headersOf(owner));
    const phone = livePeer(url("&text=1"), { cookie: owner.cookie(), "x-agentes-client": "mobile" }, { text: true });
    try {
      await Promise.all([web.ready(), phone.ready()]);
      web.raw(new Uint8Array(1024 * 1024 + 1));
      await web.until(() => web.errors.includes("too_large"), "too_large");
      web.raw("not a frame");
      await web.until(() => web.errors.filter((e) => e === "invalid").length === 1, "invalid text");
      web.raw(new Uint8Array([7, 1, 2]));
      await web.until(() => web.errors.filter((e) => e === "invalid").length >= 2, "invalid bytes");
      // Base64 text that isn't base64.
      phone.raw("%%%%");
      await phone.until(() => phone.errors.includes("invalid"), "invalid base64");
      // Still open: a ping gets its pong.
      web.raw('{"type":"ping"}');
      await web.control((c) => c.type === "pong", "pong");
      expect(web.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      web.close();
      phone.close();
    }
  });
});

describe("the pace a socket sends at", () => {
  /** Bytes that are no message: what the pace counts is the frame, whatever the document makes of it. */
  const junk = new Uint8Array(4000).fill(7);

  test("frames past it wait their turn, and a ping's pong comes only once those before it were read", async () => {
    const { owner, url } = await seeded();
    const slow = liveServer({ frameBytes: 4096, bytesPerSecond: 8192 });
    try {
      const web = livePeer(url().replace(`:${server.port}/`, `:${slow.port}/`), headersOf(owner));
      await web.ready();
      await Bun.sleep(600);
      const sent = Date.now();
      web.raw(junk);
      web.raw(junk);
      web.raw('{"type":"ping"}');
      await web.control((c) => c.type === "pong", "pong");
      // The second frame waited about half a second for its turn, and the ping waited behind it.
      expect(Date.now() - sent).toBeGreaterThanOrEqual(400);
    } finally {
      await slow.stop();
    }
  });

  test("`live.saved` waits for the frames still in line, and a pong says whether what came before it is stored", async () => {
    const { owner, file, url } = await seeded();
    const slow = liveServer({ frameBytes: 4096, bytesPerSecond: 4096 });
    try {
      const web = livePeer(url().replace(`:${server.port}/`, `:${slow.port}/`), headersOf(owner));
      await web.ready();
      await web.until(() => web.sheet() !== null, "the sheet");
      // The pace's allowance full again, then two changes of about 3 KB: the second waits about half a second.
      await Bun.sleep(1100);
      setCell(web.doc, 0, 0, "a".repeat(3000));
      setCell(web.doc, 0, 1, "b".repeat(3000));
      web.raw('{"type":"ping"}');
      await web.control((c) => c.type === "live.saved", "live.saved");
      // Said only once both are stored: never while the second still waited in line.
      const rows = await t.db
        .select({ seq: schema.liveDocUpdates.seq })
        .from(schema.liveDocUpdates)
        .where(eq(schema.liveDocUpdates.artifactId, file.id));
      expect(rows).toHaveLength(2);
      // The pong came once the second was in, still being stored: it says so.
      expect(web.controls.find((c) => c.type === "pong")).toEqual({ type: "pong", unsaved: true });
    } finally {
      await slow.stop();
    }
  });

  test("past a second's worth waiting the app hears to slow down; past the most that may wait it closes (4429)", async () => {
    const { owner, url } = await seeded();
    const slow = liveServer({ frameBytes: 4096, bytesPerSecond: 4096, waitingBytes: 16 * 1024 });
    try {
      const web = livePeer(url().replace(`:${server.port}/`, `:${slow.port}/`), headersOf(owner));
      await web.ready();
      for (let i = 0; i < 4; i++) web.raw(junk);
      await web.until(() => web.errors.includes("rate"), "live.error rate");
      expect(web.errors.filter((e) => e === "rate")).toHaveLength(1);
      expect(web.ws.readyState).toBe(WebSocket.OPEN);
      for (let i = 0; i < 4; i++) web.raw(junk);
      expect((await Promise.race([web.closed, Bun.sleep(3000).then(() => null)]))?.code).toBe(4429);
    } finally {
      await slow.stop();
    }
  });
});

describe("losing access while it's open", () => {
  test("someone removed from the workspace loses the socket at once (4403)", async () => {
    const { owner, org, url } = await seeded();
    const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
    const anaId = await meOf(ana);
    const hers = livePeer(url(), headersOf(ana));
    await hers.ready();
    const removed = await owner(`/api/app/organizations/${org.orgId}/members/${anaId}`, { method: "DELETE" });
    expect(removed.status).toBeLessThan(300);
    expect((await Promise.race([hers.closed, Bun.sleep(3000).then(() => null)]))?.code).toBe(4403);
  });

  test("a file shared with someone, then not: their socket closes at once (4404); the conversation's stays", async () => {
    const { owner, org } = await seeded();
    const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
    const anaId = await meOf(ana);
    const channel = await owner(`/api/app/organizations/${org.orgId}/channels`, {
      json: { name: "eng", visibility: "private" },
    });
    const { id: channelId } = (await channel.json()) as { id: string };
    const file = await makeFile(owner, org.orgId, { kind: "spreadsheet", title: "Plan", channelId });
    const sharing = (body: Record<string, unknown>) =>
      owner(`/api/app/organizations/${org.orgId}/artifacts/${file.id}/sharing`, { method: "PUT", json: body });
    expect((await sharing({ mode: "people", userIds: [anaId] })).status).toBe(200);
    const url = liveUrl(server.port as number, org.orgId, file.id);
    const hers = livePeer(url, headersOf(ana));
    const mine = livePeer(url, headersOf(owner));
    try {
      // Who it is shared with edits it like who it lives with (ADR 0196 §1).
      expect((await hers.ready()).mode).toBe("edit");
      await mine.ready();
      expect((await sharing({ mode: "conversation" })).status).toBe(200);
      expect((await Promise.race([hers.closed, Bun.sleep(3000).then(() => null)]))?.code).toBe(4404);
      await Bun.sleep(100);
      expect(mine.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      hers.close();
      mine.close();
    }
  });

  test("a Drive file kept to its maker: another member's socket closes (4404), the maker's stays", async () => {
    // A file of the Drive itself has no conversation to hear from: the Drive's change says so (ADR 0157, amendment).
    const { owner, org, file, url } = await seeded();
    const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
    const sharing = (body: Record<string, unknown>) =>
      owner(`/api/app/organizations/${org.orgId}/artifacts/${file.id}/sharing`, { method: "PUT", json: body });
    const hers = livePeer(url(), headersOf(ana));
    const mine = livePeer(url(), headersOf(owner));
    try {
      expect((await hers.ready()).mode).toBe("edit");
      await mine.ready();
      expect((await sharing({ mode: "conversation" })).status).toBe(200);
      expect((await Promise.race([hers.closed, Bun.sleep(3000).then(() => null)]))?.code).toBe(4404);
      await Bun.sleep(100);
      expect(mine.ws.readyState).toBe(WebSocket.OPEN);
      expect(await upgradeStatus(url(), headersOf(ana))).toBe(404);
      // Shared with her by name: she opens it again.
      expect((await sharing({ mode: "people", userIds: [await meOf(ana)] })).status).toBe(200);
      const again = livePeer(url(), headersOf(ana));
      try {
        expect((await again.ready()).mode).toBe("edit");
      } finally {
        again.close();
      }
    } finally {
      hers.close();
      mine.close();
    }
  });

  test("after pub/sub was deaf a while, every socket reads its access again at once", async () => {
    const { owner, file, url } = await seeded();
    const web = livePeer(url(), headersOf(owner));
    try {
      await web.ready();
      // The file goes to the trash and the event saying so is lost (NOTIFY is best effort, ADR 0010).
      await t.db.update(schema.artifacts).set({ deletedAt: new Date() }).where(eq(schema.artifacts.id, file.id));
      await Bun.sleep(1500);
      expect(modeOf(web)).toBe("edit");
      await t.adapters.pubsub.publish(listenResumedTopic, { type: "pubsub.resumed" });
      await web.until(() => modeOf(web) === "view", "live.mode view", 2000);
    } finally {
      web.close();
    }
  });

  test("signing out closes the socket at the next session check (4403)", async () => {
    const { owner, url } = await seeded();
    const fast = liveServer({ sessionRecheckMs: 100 });
    try {
      const web = livePeer(url().replace(`:${server.port}/`, `:${fast.port}/`), headersOf(owner));
      await web.ready();
      expect((await owner("/api/auth/sign-out", { json: {} })).status).toBe(200);
      expect((await Promise.race([web.closed, Bun.sleep(3000).then(() => null)]))?.code).toBe(4403);
    } finally {
      await fast.stop();
    }
  });

  test("a server that stops closes its sockets 1001, so the apps open them again elsewhere", async () => {
    const { owner, url } = await seeded();
    const stopping = liveServer({});
    try {
      const web = livePeer(url().replace(`:${server.port}/`, `:${stopping.port}/`), headersOf(owner));
      await web.ready();
      stopping.live.stop();
      expect((await Promise.race([web.closed, Bun.sleep(3000).then(() => null)]))?.code).toBe(1001);
      expect(stopping.live.count()).toBe(0);
    } finally {
      await stopping.stop();
    }
  });
});
