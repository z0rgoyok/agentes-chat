import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/**
 * A live file's conversation over HTTP (ADR 0199): opened on first use by whoever reads the file, written with the
 * chat's own routes, a message pointing at what was selected (`liveRef`), and the file's unread marks.
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
  return { owner, org, api, as, make };
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
