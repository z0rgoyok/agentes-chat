import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { zip } from "@agenteschat/engine";
import { SYSTEM } from "@agenteschat/live";
import * as Y from "yjs";
import { apiBodyMax } from "../src/http/body-limit";
import { readsOffice } from "../src/routes/app/live-engine";
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
} from "./harness";
import { cellValue, livePeer, setCell } from "./live-files-peer";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
});
afterEach(async () => {
  await t.close();
});

/** A 1×1 PNG. */
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** A font file the engine ships for its own tests (OFL). */
const FONT = new Uint8Array(
  readFileSync(new URL("../../../packages/engine/assets/fonts/Onest-Regular.ttf", import.meta.url)),
);

const meOf = async (b: Browser) => ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;

/** The owner of Acme, and its API under the workspace. */
async function seeded() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const org = await seedOrg(owner);
  const api = (b: Browser, path: string, init?: Parameters<Browser>[1]) =>
    b(`/api/app/organizations/${org.orgId}${path}`, init);
  return { owner, org, api: (path: string, init?: Parameters<Browser>[1]) => api(owner, path, init), as: api };
}

async function make(
  api: (path: string, init?: Parameters<Browser>[1]) => Promise<Response>,
  input: Record<string, unknown>,
) {
  const res = await api("/live-files", { json: input });
  expect(res.status).toBe(201);
  return (await res.json()) as Record<string, unknown> & { id: string; kind: string };
}

/** A file's document as `GET …/live` gives it. */
async function opened(api: (path: string) => Promise<Response>, id: string) {
  const res = await api(`/artifacts/${id}/live`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { state: string; seq: number; mode: string; kind: string };
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(body.state, "base64")));
  return { ...body, doc };
}

/** A multipart upload of `bytes`. */
const upload = (bytes: Uint8Array, name: string, type: string) => {
  const form = new FormData();
  form.append("file", new File([bytes as Uint8Array<ArrayBuffer>], name, { type }));
  return form;
};

describe("the API's description", () => {
  test("lists the live files' routes", async () => {
    const res = await t.app.request("/api/openapi.json");
    expect(res.status).toBe(200);
    const paths = Object.keys(((await res.json()) as { paths: Record<string, unknown> }).paths);
    const org = "/app/organizations/{orgId}";
    const file = `${org}/artifacts/{artifactId}`;
    for (const path of [
      `${org}/live-files`,
      `${org}/live/presence`,
      `${file}/live`,
      `${file}/live/versions`,
      `${file}/live/restore`,
      `${file}/live/ask`,
      `${file}/assets`,
      `${file}/assets/copy`,
      `${file}/fonts`,
      `${file}/preview`,
      `${file}/open-as`,
    ]) {
      expect(paths).toContain(path);
    }
  });
});

describe("making and opening live files", () => {
  test("each kind is made in the Drive or in a conversation, with what the person may do with it", async () => {
    const { api, org } = await seeded();
    const sheet = await make(api, { kind: "spreadsheet", title: "Budget" });
    expect(sheet).toMatchObject({ kind: "spreadsheet", title: "Budget", channelId: null, inDrive: true });
    expect(sheet).toMatchObject({ canDelete: true, audience: { kind: "workspace" }, untrusted: false });
    const deck = await make(api, { kind: "slides", title: "Pitch", channelId: org.channelId });
    expect(deck).toMatchObject({ kind: "slides", channelId: org.channelId, audience: { kind: "channel" } });
    const canvas = await make(api, { kind: "canvas", title: "Ideas" });
    expect(canvas).toMatchObject({ kind: "canvas" });
    // A document is a live file too (ADR 0200): one empty paragraph to start.
    const document = await make(api, { kind: "document", title: "Notes" });
    expect(document).toMatchObject({ kind: "document" });
    expect((await api("/live-files", { json: { kind: "board", title: "No" } })).status).toBe(400);
    expect((await api("/live-files", { json: { kind: "canvas", title: "  " } })).status).toBe(400);
    // They are files like any other: listed in the Drive, filtered by kind.
    const listed = (await (await api("/artifacts?kinds=spreadsheet,slides,canvas")).json()) as {
      artifacts: { id: string }[];
    };
    expect(listed.artifacts.map((a) => a.id).sort()).toEqual([sheet.id, deck.id, canvas.id].sort());
  });

  test("opening one gives its whole document, its mode and kind; never another file's", async () => {
    const { api, owner, org, as } = await seeded();
    const sheet = await make(api, { kind: "spreadsheet", title: "Budget" });
    const state = await opened(api, sheet.id);
    expect(state).toMatchObject({ mode: "edit", kind: "spreadsheet" });
    expect(state.doc.getArray("sheetOrder").length).toBe(1);
    const deck = await opened(api, (await make(api, { kind: "slides", title: "Pitch" })).id);
    expect(deck.doc.getArray("slideOrder").length).toBe(1);

    // A file of another kind has no live document; a document has one (ADR 0200).
    const table = await api("/artifacts", {
      json: { title: "Notes", content: { kind: "table", columns: ["a"], rows: [["1"]] } },
    });
    expect((await api(`/artifacts/${((await table.json()) as { id: string }).id}/live`)).status).toBe(404);
    const doc = await api("/artifacts", {
      json: { title: "Notes", content: { kind: "document", markdown: "# Notes" } },
    });
    const notes = await opened(api, ((await doc.json()) as { id: string }).id);
    expect(notes).toMatchObject({ mode: "edit", kind: "document" });
    expect(notes.doc.getXmlFragment("body").length).toBe(1);
    // In a private conversation another member isn't in: not found for them.
    const channel = (await (await api("/channels", { json: { name: "eng", visibility: "private" } })).json()) as {
      id: string;
    };
    const hidden = await make(api, { kind: "canvas", title: "Roadmap", channelId: channel.id });
    const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
    expect((await as(ana, `/artifacts/${hidden.id}/live`)).status).toBe(404);
    expect((await as(ana, `/artifacts/${sheet.id}/live`)).status).toBe(200);
  });
});

describe("versions", () => {
  test("a version saved with a name, then the file brought back to it for everyone", async () => {
    const { api, org } = await seeded();
    const sheet = await make(api, { kind: "spreadsheet", title: "Budget" });
    await t.engine.live.edit(org.orgId, sheet.id, SYSTEM, (doc) => setCell(doc, 0, 0, 10));
    const saved = await api(`/artifacts/${sheet.id}/live/versions`, { json: { note: "Before the meeting" } });
    expect(saved.status).toBe(200);
    const { version } = (await saved.json()) as { version: number };
    expect(version).toBeGreaterThan(1);
    const versions = (await (await api(`/artifacts/${sheet.id}/versions`)).json()) as {
      versions: { version: number; note: string | null }[];
    };
    expect(versions.versions.find((v) => v.version === version)?.note).toBe("Before the meeting");

    await t.engine.live.edit(org.orgId, sheet.id, SYSTEM, (doc) => setCell(doc, 0, 0, 99));
    expect(cellValue((await opened(api, sheet.id)).doc, 0, 0)).toBe(99);
    const restored = await api(`/artifacts/${sheet.id}/live/restore`, { json: { version } });
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as { version: number }).version).toBeGreaterThan(version);
    expect(cellValue((await opened(api, sheet.id)).doc, 0, 0)).toBe(10);
  });

  test("a file in the trash is read-only: no version saved, nothing restored, no picture added", async () => {
    const { api } = await seeded();
    const sheet = await make(api, { kind: "spreadsheet", title: "Budget" });
    expect((await api(`/artifacts/${sheet.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await opened(api, sheet.id)).mode).toBe("view");
    const refused = await api(`/artifacts/${sheet.id}/live/versions`, { json: {} });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "live.read_only" } });
    expect((await api(`/artifacts/${sheet.id}/live/restore`, { json: { version: 1 } })).status).toBe(409);
    const picture = await api(`/artifacts/${sheet.id}/assets`, {
      method: "POST",
      body: upload(PNG, "dot.png", "image/png"),
    });
    expect(picture.status).toBe(409);
  });
});

describe("pictures", () => {
  test("a picture added to a canvas is served, as a picture only, to who reads the file", async () => {
    const { api, owner, org, as } = await seeded();
    const canvas = await make(api, { kind: "canvas", title: "Ideas" });
    const added = await api(`/artifacts/${canvas.id}/assets`, {
      method: "POST",
      body: upload(PNG, "dot.png", "image/png"),
    });
    expect(added.status).toBe(201);
    const asset = (await added.json()) as { id: string; contentType: string; size: number; width: number };
    expect(asset).toMatchObject({ contentType: "image/png", size: PNG.byteLength, width: 1, height: 1 });

    const got = await api(`/artifacts/${canvas.id}/assets/${asset.id}`);
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(got.headers.get("content-security-policy")).toBe("sandbox");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    const etag = got.headers.get("etag") ?? "";
    expect(
      (await api(`/artifacts/${canvas.id}/assets/${asset.id}`, { headers: { "if-none-match": etag } })).status,
    ).toBe(304);

    // Its type is read from the bytes: a page called a picture is refused.
    const page = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const notPicture = await api(`/artifacts/${canvas.id}/assets`, {
      method: "POST",
      body: upload(page, "x.png", "image/png"),
    });
    expect(notPicture.status).toBe(400);
    expect(await notPicture.json()).toMatchObject({ error: { code: "live.asset_type" } });
    // Who doesn't read the file doesn't see its pictures.
    const channel = (await (await api("/channels", { json: { name: "eng", visibility: "private" } })).json()) as {
      id: string;
    };
    const hidden = await make(api, { kind: "canvas", title: "Roadmap", channelId: channel.id });
    const inHidden = (await (
      await api(`/artifacts/${hidden.id}/assets`, { method: "POST", body: upload(PNG, "dot.png", "image/png") })
    ).json()) as { id: string };
    const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
    expect((await as(ana, `/artifacts/${hidden.id}/assets/${inHidden.id}`)).status).toBe(404);
    expect((await as(ana, `/artifacts/${canvas.id}/assets/${asset.id}`)).status).toBe(200);
  });

  test("a picture over the size a file takes is refused with its own words", async () => {
    const { api } = await seeded();
    const canvas = await make(api, { kind: "canvas", title: "Ideas" });
    const big = new Uint8Array(26 * 1024 * 1024);
    big.set(PNG);
    const refused = await api(`/artifacts/${canvas.id}/assets`, {
      method: "POST",
      body: upload(big, "big.png", "image/png"),
    });
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({ error: { code: "live.asset_too_large", params: { max: 25 } } });
    // The route counts its own body, as the Drive's uploads do.
    expect(apiBodyMax(`/api/app/organizations/${crypto.randomUUID()}/artifacts/${canvas.id}/assets`)).toBeNull();
  });

  test("a picture from the Drive is copied in, under the reader's check of where it came from", async () => {
    const { api } = await seeded();
    const canvas = await make(api, { kind: "canvas", title: "Ideas" });
    const file = await api("/artifacts/files", { method: "POST", body: upload(PNG, "logo.png", "image/png") });
    expect(file.status).toBe(201);
    const { id: fileId } = (await file.json()) as { id: string };
    const copied = await api(`/artifacts/${canvas.id}/assets/copy`, { json: { artifactId: fileId } });
    expect(copied.status).toBe(201);
    const asset = (await copied.json()) as { id: string; contentType: string };
    expect(asset.contentType).toBe("image/png");
    expect((await api(`/artifacts/${canvas.id}/assets/${asset.id}`)).status).toBe(200);
    expect(
      (await api(`/artifacts/${canvas.id}/assets/copy`, { json: { artifactId: crypto.randomUUID() } })).status,
    ).toBe(404);
  });

  test("a font from the Drive is brought in, listed among the file's fonts and served as a font (ADR 0220 §2)", async () => {
    const { api, owner, org, as } = await seeded();
    const deck = await make(api, { kind: "slides", title: "Plan" });
    expect(await (await api(`/artifacts/${deck.id}/fonts`)).json()).toEqual({ fonts: [] });
    const file = await api("/artifacts/files", { method: "POST", body: upload(FONT, "Brand-Regular.ttf", "font/ttf") });
    expect(file.status).toBe(201);
    const { id: fileId } = (await file.json()) as { id: string };
    const copied = await api(`/artifacts/${deck.id}/assets/copy`, { json: { artifactId: fileId } });
    expect(copied.status).toBe(201);
    const asset = (await copied.json()) as { id: string; contentType: string; font: unknown };
    // The family is the one its own file names, whatever the file was called.
    expect(asset).toMatchObject({
      contentType: "font/ttf",
      font: { family: "Onest", style: "Regular", weight: 400, italic: false },
    });

    const listed = (await (await api(`/artifacts/${deck.id}/fonts`)).json()) as { fonts: unknown[] };
    expect(listed.fonts).toEqual([{ id: asset.id, family: "Onest", style: "Regular", weight: 400, italic: false }]);

    const got = await api(`/artifacts/${deck.id}/assets/${asset.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("font/ttf");
    expect(got.headers.get("content-security-policy")).toBe("sandbox");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(FONT);

    // Who doesn't read the file doesn't see its fonts.
    const channel = (await (await api("/channels", { json: { name: "brand", visibility: "private" } })).json()) as {
      id: string;
    };
    const hidden = await make(api, { kind: "document", title: "Guide", channelId: channel.id });
    const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
    expect((await as(ana, `/artifacts/${hidden.id}/fonts`)).status).toBe(404);
    expect((await as(ana, `/artifacts/${deck.id}/fonts`)).status).toBe(200);
  });
});

describe("presence", () => {
  test("who is in each file the person reads; files out of their reach are left out", async () => {
    const { api, owner, org, as } = await seeded();
    const ownerId = await meOf(owner);
    const sheet = await make(api, { kind: "spreadsheet", title: "Budget" });
    const channel = (await (await api("/channels", { json: { name: "eng", visibility: "private" } })).json()) as {
      id: string;
    };
    const hidden = await make(api, { kind: "canvas", title: "Roadmap", channelId: channel.id });
    const server = listen(t);
    const url = (id: string) => `ws://127.0.0.1:${server.port}/api/live?orgId=${org.orgId}&fileId=${id}`;
    const here = livePeer(url(sheet.id), { origin: ORIGIN, cookie: owner.cookie() });
    const there = livePeer(url(hidden.id), { origin: ORIGIN, cookie: owner.cookie() });
    try {
      await Promise.all([here.ready(), there.ready()]);
      const ids = `${sheet.id},${hidden.id}`;
      type Presence = { presence: Record<string, { kind: string; id: string; mode: string }[]> };
      const mine = async () => ((await (await api(`/live/presence?ids=${ids}`)).json()) as Presence).presence;
      for (let i = 0; i < 100 && !(await mine())[sheet.id]?.length; i++) await Bun.sleep(20);
      expect((await mine())[sheet.id]).toContainEqual(expect.objectContaining({ kind: "person", id: ownerId }));
      expect(Object.keys(await mine()).sort()).toEqual([sheet.id, hidden.id].sort());
      const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
      const hers = ((await (await as(ana, `/live/presence?ids=${ids}`)).json()) as Presence).presence;
      expect(Object.keys(hers)).toEqual([sheet.id]);
      expect((await api("/live/presence?ids=not-an-id")).status).toBe(400);
    } finally {
      here.close();
      there.close();
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  });

  test("someone who hides their presence is in no file to anyone else", async () => {
    const { api, owner, org, as } = await seeded();
    const sheet = await make(api, { kind: "spreadsheet", title: "Budget" });
    const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
    const anaId = await meOf(ana);
    const server = listen(t);
    const hers = livePeer(`ws://127.0.0.1:${server.port}/api/live?orgId=${org.orgId}&fileId=${sheet.id}`, {
      origin: ORIGIN,
      cookie: ana.cookie(),
    });
    type Presence = { presence: Record<string, { kind: string; id: string }[]> };
    const seenBy = async (b: Browser) =>
      ((await (await as(b, `/live/presence?ids=${sheet.id}`)).json()) as Presence).presence[sheet.id] ?? [];
    const hasAna = (list: { kind: string; id: string }[]) => list.some((p) => p.kind === "person" && p.id === anaId);
    try {
      await hers.ready();
      for (let i = 0; i < 100 && !hasAna(await seenBy(owner)); i++) await Bun.sleep(20);
      expect(hasAna(await seenBy(owner))).toBe(true);
      const hidden = await as(ana, "/me/status", { method: "PUT", json: { availability: "hidden" } });
      expect(hidden.status).toBe(200);
      expect(hasAna(await seenBy(owner))).toBe(false);
    } finally {
      hers.close();
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  });
});

describe("Office files (ADR 0198)", () => {
  // Reading and writing them comes with the engine's Office files (`officePreview`, `openAsLive`, `exportLive`).
  const withOffice = test.skipIf(!readsOffice());

  /** A workbook as Excel writes one, with a shared string, a number and a formula. */
  const workbook = () =>
    zip([
      ["[Content_Types].xml", "<Types/>"],
      ["xl/workbook.xml", '<workbook><sheets><sheet name="Costs" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      [
        "xl/_rels/workbook.xml.rels",
        '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
      ],
      ["xl/sharedStrings.xml", "<sst><si><t>Item</t></si></sst>"],
      [
        "xl/worksheets/sheet1.xml",
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>12.5</v></c><c r="C1"><f>B1*2</f><v>25</v></c></row></sheetData></worksheet>',
      ],
    ]);

  withOffice("a spreadsheet downloads as xlsx (its own format) or csv; a document can't be an xlsx", async () => {
    const { api, org } = await seeded();
    const sheet = await make(api, { kind: "spreadsheet", title: "Budget" });
    await t.engine.live.edit(org.orgId, sheet.id, SYSTEM, (doc) => setCell(doc, 0, 0, "Item"));
    for (const path of [`/artifacts/${sheet.id}/file?format=xlsx`, `/artifacts/${sheet.id}/file`]) {
      const res = await api(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain(".xlsx");
      expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 2))).toBe("PK");
    }
    const csv = await api(`/artifacts/${sheet.id}/file?format=csv`);
    expect(csv.status).toBe(200);
    expect(await csv.text()).toContain("Item");
    const doc = await api("/artifacts", {
      json: { title: "Notes", content: { kind: "document", markdown: "# Notes" } },
    });
    const refused = await api(`/artifacts/${((await doc.json()) as { id: string }).id}/file?format=xlsx`);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: "artifact.format_unavailable" } });
  });

  test("a canvas downloads as its own JSON; a format it has none of is refused", async () => {
    const { api } = await seeded();
    const canvas = await make(api, { kind: "canvas", title: "Ideas" });
    const res = await api(`/artifacts/${canvas.id}/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain(".json");
    const refused = await api(`/artifacts/${canvas.id}/file?format=pptx`);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: "artifact.format_unavailable" } });
  });

  withOffice("an uploaded workbook is previewed, then opened as a spreadsheet beside it", async () => {
    const { api } = await seeded();
    const type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const up = await api("/artifacts/files", { method: "POST", body: upload(workbook(), "costs.xlsx", type) });
    expect(up.status).toBe(201);
    const { id } = (await up.json()) as { id: string };
    const preview = await api(`/artifacts/${id}/preview`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ kind: "workbook" });
    const made = await api(`/artifacts/${id}/open-as`, { json: {} });
    expect(made.status).toBe(201);
    const sheet = (await made.json()) as { id: string; kind: string };
    expect(sheet.kind).toBe("spreadsheet");
    expect(cellValue((await opened(api, sheet.id)).doc, 0, 0)).toBe("Item");
  });
});

describe("asking an agent from inside a file", () => {
  test("only about a file the person reads, with something to say", async () => {
    const { api, owner, org, as } = await seeded();
    const channel = (await (await api("/channels", { json: { name: "eng", visibility: "private" } })).json()) as {
      id: string;
    };
    const hidden = await make(api, { kind: "canvas", title: "Roadmap", channelId: channel.id });
    const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
    const asked = await as(ana, `/artifacts/${hidden.id}/live/ask`, {
      json: { agentId: org.agentId, text: "What is this?" },
    });
    expect(asked.status).toBe(404);
    const sheet = await make(api, { kind: "spreadsheet", title: "Budget" });
    const blank = await api(`/artifacts/${sheet.id}/live/ask`, { json: { agentId: org.agentId, text: "  " } });
    expect(blank.status).toBe(400);
  });

  // The agents' side of it (`askAgentAbout`) comes with their tools for live files (ADR 0196 §6); the message goes in
  // the file's own conversation (ADR 0199), the one `…/conversation` opens.
  test("the message goes to the agent with the file and what was selected", async () => {
    const { api, org } = await seeded();
    const sheet = await make(api, { kind: "spreadsheet", title: "Budget", channelId: org.channelId });
    const asked = await api(`/artifacts/${sheet.id}/live/ask`, {
      json: {
        agentId: org.agentId,
        text: "Sum this column",
        selection: { label: "Sheet 1!B2:B9", range: "B2:B9" },
      },
    });
    expect(asked.status).toBe(201);
    const sent = (await asked.json()) as { id: string; channelId: string; threadId: string | null };
    const at = (await (await api(`/artifacts/${sheet.id}/conversation`, { json: {} })).json()) as {
      channelId: string;
      rootId: string;
    };
    expect(sent).toMatchObject({ channelId: at.channelId, threadId: at.rootId });
    const messages = (await (await api(`/channels/${at.channelId}/messages?threadId=${at.rootId}`)).json()) as {
      messages: { id: string; meta?: Record<string, unknown> }[];
    };
    const message = messages.messages.find((m) => m.id === sent.id);
    expect(message?.meta?.liveRef).toMatchObject({
      artifactId: sheet.id,
      kind: "spreadsheet",
      selection: { label: "Sheet 1!B2:B9" },
    });
  });
});
