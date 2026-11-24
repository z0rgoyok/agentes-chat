import { afterEach, beforeEach, expect, test } from "bun:test";
import { fakeImagePng } from "@agenteschat/providers/testing";
import { apiBodyMax } from "../src/http/body-limit";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/**
 * A live file's conversation over HTTP (ADR 0199): opened on first use by whoever reads the file, written with the
 * chat's own routes, a message pointing at what was selected (`liveRef`), and the file's unread marks. A picture's, a
 * video's or a PDF's too (ADR 0208), whose comments point at a place with the app's pictures of it and are resolved.
 */

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
});
afterEach(async () => {
  await t.close();
});

type Ref = { channelId: string; rootId: string };
type Msg = { id: string; body: string; meta: Record<string, unknown>; liveRef?: Record<string, unknown> };

/** A 1×1 PNG. */
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const PDF = new TextEncoder().encode("%PDF-1.7 not really");
const TEXT = new TextEncoder().encode("lista de compras");

const meOf = async (b: Browser) => ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;

/** A multipart body with `bytes` as its `file`, and other fields as text. */
function form(bytes: Uint8Array, name: string, type: string, fields: Record<string, string> = {}) {
  const body = new FormData();
  body.append("file", new File([bytes as Uint8Array<ArrayBuffer>], name, { type }));
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return body;
}

async function seeded() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const org = await seedOrg(owner);
  const as = (b: Browser, path: string, init?: Parameters<Browser>[1]) =>
    b(`/api/app/organizations/${org.orgId}${path}`, init);
  const api = (path: string, init?: Parameters<Browser>[1]) => as(owner, path, init);
  const make = async (input: Record<string, unknown>) => {
    const res = await api("/live-files", { json: input });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  };
  /** A file the owner uploads to a conversation (#general unless said). */
  const upload = async (bytes: Uint8Array, name: string, type: string, channelId: string = org.channelId) => {
    const res = await api("/artifacts/files", { method: "POST", body: form(bytes, name, type, { channelId }) });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  };
  return { owner, org, api, as, make, upload };
}

test("opened once by whoever reads the file; the file carries it; refused for others and other kinds", async () => {
  const { owner, org, api, as, make } = await seeded();
  const canvas = await make({ kind: "canvas", title: "Campanha", channelId: org.channelId });
  expect(((await (await api(`/artifacts/${canvas.id}`)).json()) as { conversation: unknown }).conversation).toBeNull();

  const opened = await api(`/artifacts/${canvas.id}/conversation`, { json: {} });
  expect(opened.status).toBe(200);
  const at = (await opened.json()) as Ref;
  expect(await (await api(`/artifacts/${canvas.id}/conversation`, { json: {} })).json()).toEqual(at);
  const head = (await (await api(`/artifacts/${canvas.id}`)).json()) as { conversation: Record<string, unknown> };
  expect(head.conversation).toEqual({ ...at, count: 0, lastAt: null, participants: [], working: false });

  // A file in a private channel Ana isn't in: not found for her, as the file is.
  const room = (await (await api("/channels", { json: { name: "eng", visibility: "private" } })).json()) as {
    id: string;
  };
  const hidden = await make({ kind: "spreadsheet", title: "Salários", channelId: room.id });
  const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
  expect((await as(ana, `/artifacts/${hidden.id}/conversation`, { json: {} })).status).toBe(404);
  const hiddenAt = (await (await api(`/artifacts/${hidden.id}/conversation`, { json: {} })).json()) as Ref;
  expect((await as(ana, `/channels/${hiddenAt.channelId}/messages?threadId=${hiddenAt.rootId}`)).status).toBe(403);
  expect((await as(ana, `/artifacts/${canvas.id}/conversation`, { json: {} })).status).toBe(200);

  // A kind without one.
  const table = (await (
    await api("/artifacts", { json: { title: "Metas", content: { kind: "table", columns: ["mês"], rows: [] } } })
  ).json()) as { id: string };
  const refused = await api(`/artifacts/${table.id}/conversation`, { json: {} });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ error: { code: "artifact.no_conversation" } });
});

test("a message there points at what was selected; another file or conversation is refused; unread follows it", async () => {
  const { owner, org, api, as, make } = await seeded();
  const sheet = await make({ kind: "spreadsheet", title: "Custos", channelId: org.channelId });
  const other = await make({ kind: "spreadsheet", title: "Receitas", channelId: org.channelId });
  const at = (await (await api(`/artifacts/${sheet.id}/conversation`, { json: {} })).json()) as Ref;
  const selection = { label: "C2:D6 em Custos", sheet: "s1", range: "C2:D6" };

  const posted = await api(`/channels/${at.channelId}/messages`, {
    json: { body: "Confere esses números", threadId: at.rootId, liveRef: { artifactId: sheet.id, selection } },
  });
  expect(posted.status).toBe(201);
  const message = (await posted.json()) as Msg;
  const ref = { artifactId: sheet.id, kind: "spreadsheet", title: "Custos", selection };
  expect(message.liveRef).toEqual(ref);
  expect(message.meta.liveRef).toEqual(ref);
  const thread = (await (await api(`/channels/${at.channelId}/messages?threadId=${at.rootId}`)).json()) as {
    messages: Msg[];
  };
  // The root stands for the file (never drawn); the replies are the conversation.
  expect(thread.messages.filter((m) => !m.meta.fileConversation).map((m) => [m.body, m.liveRef])).toEqual([
    ["Confere esses números", ref],
  ]);

  for (const [channelId, artifactId] of [
    [at.channelId, other.id],
    [org.channelId, sheet.id],
  ] as const) {
    const wrong = await api(`/channels/${channelId}/messages`, {
      json: { body: "Olha", ...(channelId === at.channelId ? { threadId: at.rootId } : {}), liveRef: { artifactId } },
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: { code: "message.live_ref" } });
  }

  // Ana reads the file (it lives in #general), writes there, and so follows the conversation: what the others wrote
  // there is unread for her until she reads the thread.
  const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
  const said = await as(ana, `/channels/${at.channelId}/messages`, { json: { body: "Vou ver", threadId: at.rootId } });
  expect(said.status).toBe(201);
  await api(`/channels/${at.channelId}/messages`, { json: { body: "Obrigada", threadId: at.rootId } });
  expect(await (await as(ana, "/unread-files")).json()).toEqual({
    files: [{ artifactId: sheet.id, unread: 2, mentions: 0 }],
  });
  expect((await as(ana, `/threads/${at.rootId}/read`, { json: {} })).status).toBe(204);
  expect(await (await as(ana, "/unread-files")).json()).toEqual({ files: [] });

  const head = (await (await api(`/artifacts/${sheet.id}`)).json()) as {
    conversation: { count: number; participants: { type: string }[] };
  };
  expect(head.conversation.count).toBe(3);
  expect(head.conversation.participants.map((p) => p.type)).toEqual(["person", "person"]);
});

test("a picture, a video or a PDF has one too, opened by whoever reads it; any other file has none", async () => {
  const { owner, org, api, as, upload } = await seeded();
  const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
  for (const [bytes, name, type, kind] of [
    [PNG, "logo.png", "image/png", "image"],
    [MP4, "demo.mp4", "video/mp4", "video"],
    [PDF, "contrato.pdf", "application/pdf", "pdf"],
  ] as const) {
    const file = await upload(bytes, name, type);
    // Ana reads it (it lives in #general): she opens it, the same one the owner gets.
    const opened = await as(ana, `/artifacts/${file.id}/conversation`, { json: {} });
    expect(opened.status).toBe(200);
    const at = (await opened.json()) as Ref;
    expect(await (await api(`/artifacts/${file.id}/conversation`, { json: {} })).json()).toEqual(at);
    const head = (await (await api(`/artifacts/${file.id}`)).json()) as { conversation: Record<string, unknown> };
    expect(head.conversation).toMatchObject({ ...at, count: 0 });
    const thread = (await (await api(`/channels/${at.channelId}/messages?threadId=${at.rootId}`)).json()) as {
      messages: Msg[];
    };
    expect(thread.messages.map((m) => m.meta.fileConversation)).toEqual([{ artifactId: file.id, kind, title: name }]);
  }

  // A picture in a private channel Ana isn't in: not found for her, as the file is.
  const room = (await (await api("/channels", { json: { name: "eng", visibility: "private" } })).json()) as {
    id: string;
  };
  const hidden = await upload(PNG, "rascunho.png", "image/png", room.id);
  expect((await as(ana, `/artifacts/${hidden.id}/conversation`, { json: {} })).status).toBe(404);

  // Any other uploaded file has none.
  const notes = await upload(TEXT, "notas.txt", "text/plain");
  const refused = await api(`/artifacts/${notes.id}/conversation`, { json: {} });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ error: { code: "artifact.no_conversation" } });
});

test("a comment points at a place with the app's pictures of it, and is resolved by whoever writes there", async () => {
  const { owner, org, api, as, upload } = await seeded();
  const paths = Object.keys(
    ((await (await t.app.request("/api/openapi.json")).json()) as { paths: Record<string, unknown> }).paths,
  );
  expect(paths).toContain("/app/organizations/{orgId}/artifacts/{artifactId}/marks");
  expect(paths).toContain("/app/organizations/{orgId}/messages/{messageId}/resolve");
  const logo = await upload(PNG, "logo.png", "image/png");
  const at = (await (await api(`/artifacts/${logo.id}/conversation`, { json: {} })).json()) as Ref;

  // The app's pictures of the place go up first: what was marked, and the whole with the mark drawn.
  const mark = async (bytes: Uint8Array, fileId = logo.id) =>
    api(`/artifacts/${fileId}/marks`, { method: "POST", body: form(bytes, "mark.png", "image/png") });
  const cropped = await mark(PNG);
  expect(cropped.status).toBe(201);
  const crop = (await cropped.json()) as { id: string };
  expect(crop).toMatchObject({ contentType: "image/png", size: PNG.byteLength, width: 1, height: 1 });
  const FRAME = fakeImagePng("frame");
  const frame = (await (await mark(FRAME)).json()) as { id: string };
  // Served like a live file's pictures, to whoever reads the file.
  const got = await api(`/artifacts/${logo.id}/assets/${crop.id}`);
  expect(got.status).toBe(200);
  expect(got.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);

  // Told by its bytes, small, and only for a picture, a video or a PDF.
  const notPicture = await mark(new TextEncoder().encode("<html><script>alert(1)</script></html>"));
  expect(notPicture.status).toBe(400);
  expect(await notPicture.json()).toMatchObject({ error: { code: "live.asset_type" } });
  const big = new Uint8Array(2 * 1024 * 1024 + 1);
  big.set(PNG);
  const tooLarge = await mark(big);
  expect(tooLarge.status).toBe(413);
  expect(await tooLarge.json()).toMatchObject({ error: { code: "live.asset_too_large", params: { max: 2 } } });
  // The route counts its own body, as the other uploads do.
  expect(apiBodyMax(`/api/app/organizations/${org.orgId}/artifacts/${logo.id}/marks`)).toBeNull();
  const notes = await upload(TEXT, "notas.txt", "text/plain");
  expect((await mark(PNG, notes.id)).status).toBe(404);

  // The comment points at the place and names its pictures.
  const selection = {
    label: "1",
    mark: { x: 0.25, y: 0.5, w: 0.3, h: 0.2 },
    version: 1,
    crop: crop.id,
    frame: frame.id,
  };
  const posted = await api(`/channels/${at.channelId}/messages`, {
    json: { body: "Esse canto está cortado", threadId: at.rootId, liveRef: { artifactId: logo.id, selection } },
  });
  expect(posted.status).toBe(201);
  const comment = (await posted.json()) as Msg;
  const ref = { artifactId: logo.id, kind: "image", title: "logo.png", selection };
  expect(comment.liveRef).toEqual(ref);
  expect(comment.meta.liveRef).toEqual(ref);

  // Resolved by whoever writes there: Ana reads the picture (it lives in #general).
  const ana = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
  const resolved = await as(ana, `/messages/${comment.id}/resolve`, { json: { resolved: true } });
  expect(resolved.status).toBe(200);
  const done = ((await resolved.json()) as { resolved: { by: unknown; at: string } }).resolved;
  expect(done.by).toEqual({ type: "person", id: await meOf(ana) });
  // Again: the first stays.
  expect(await (await api(`/messages/${comment.id}/resolve`, { json: { resolved: true } })).json()).toEqual({
    resolved: done,
  });
  const metaNow = async () =>
    (
      (await (await api(`/channels/${at.channelId}/messages?threadId=${at.rootId}`)).json()) as { messages: Msg[] }
    ).messages.find((m) => m.id === comment.id)?.meta;
  expect((await metaNow())?.resolved).toEqual(done);
  const reopened = await api(`/messages/${comment.id}/resolve`, { json: { resolved: false } });
  expect(reopened.status).toBe(200);
  expect(await reopened.json()).toEqual({ resolved: null });
  expect((await metaNow())?.resolved).toBeUndefined();
  expect((await metaNow())?.liveRef).toEqual(ref);

  // A message that points at no place is no comment.
  const plain = (await (
    await api(`/channels/${at.channelId}/messages`, { json: { body: "Valeu", threadId: at.rootId } })
  ).json()) as Msg;
  const refused = await api(`/messages/${plain.id}/resolve`, { json: { resolved: true } });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ error: { code: "message.not_comment" } });
});
