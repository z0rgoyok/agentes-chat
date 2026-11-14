import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** The right hand's greeting of someone who joins (ADR 0177 §6) over HTTP: theirs alone, and the workspace's to stop. */

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

type Dm = { channelId: string; with: { type: string; name: string }; unread: number };
type Message = { body: string; author: { type: string }; meta: Record<string, unknown> | null };

const dmsOf = async (b: ReturnType<typeof browser>, orgId: string) =>
  ((await (await b(`/api/app/organizations/${orgId}/dms`)).json()) as { dms: Dm[] }).dms;

test("who joins finds one greeting in their own conversation with the right hand, which nobody else reads", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const org = `/api/app/organizations/${orgId}`;
  // The page lists the switch now that the feature is built.
  expect(((await (await owner(`${org}/team-week`)).json()) as { switches: string[] }).switches).toContain(
    "welcomePeople",
  );

  // Saving the workspace's key tried it once: the greeting adds no call to that.
  const calls = t.provider.calls.length;
  const nina = await joinByInvitation(t, owner, orgId, "nina@example.com");
  await t.drain();
  const [dm, ...others] = await dmsOf(nina, orgId);
  expect(others).toEqual([]);
  expect(dm).toMatchObject({ with: { type: "agent", name: "Lodi" }, unread: 1 });
  const read = await nina(`${org}/channels/${dm?.channelId}/messages`);
  const { messages } = (await read.json()) as { messages: Message[] };
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    author: { type: "agent" },
    // The test browsers sign up reading pt-BR.
    body: "Você acabou de entrar na Acme. **Do que você cuida por aqui?** Me conta e eu monto seu primeiro agente com você.",
    meta: { bodyCode: "welcome_member", bodyParams: { org: "Acme" } },
  });
  expect(messages[0]?.meta?.replyChips).toMatchObject({ choices: expect.arrayContaining(["Marketing", "Vendas"]) });
  // The owner was told nothing and cannot open that conversation.
  expect(await dmsOf(owner, orgId)).toEqual([]);
  expect((await owner(`${org}/channels/${dm?.channelId}/messages`)).status).not.toBe(200);
  expect(t.provider.calls).toHaveLength(calls);
});

test("only who configures the workspace turns it off, and then nobody is greeted", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const settings = `/api/app/organizations/${orgId}/settings`;
  const nina = await joinByInvitation(t, owner, orgId, "nina@example.com");
  await t.drain();
  expect((await nina(settings, { method: "PATCH", json: { welcomePeople: false } })).status).toBe(403);
  expect((await owner(settings, { method: "PATCH", json: { welcomePeople: false } })).status).toBe(200);
  const caio = await joinByInvitation(t, owner, orgId, "caio@example.com");
  await t.drain();
  expect(await dmsOf(caio, orgId)).toEqual([]);
  expect(await dmsOf(nina, orgId)).toHaveLength(1);
});
