import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/**
 * An agent's follow-up over HTTP (ADR 0037, round 3, amended 2026-11-13): its line, the conversation's list of returns
 * still to come (the bar above the composer), and who may cancel it: the person it is for, the agent's owner, admins.
 */

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

test("the agent sets a follow-up; its line lists with the messages; a person cancels it once", async () => {
  t = await createTestServer({
    // Call 1 is the key's test when `seedOrg` saves it.
    reply: (_request, call) =>
      call === 2
        ? {
            chunks: [""],
            toolUses: [
              { name: "follow_up", input: { minutes: 30, note: "Check CI run 42 again.", about: "ver o CI" } },
            ],
          }
        : { chunks: ["Ainda rodando. Volto em 30 minutos para ver o CI."] },
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const org = `/api/app/organizations/${orgId}`;
  await owner(`${org}/channels/${channelId}/messages`, { json: { body: "@dev o CI terminou?" } });
  await t.drain();

  const listed = (await (await owner(`${org}/channels/${channelId}/messages`)).json()) as {
    messages: { id: string; body: string; meta: Record<string, unknown> }[];
  };
  const line = listed.messages.find((m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "follow_up");
  expect(line?.meta.notice).toMatchObject({ refs: { about: "ver o CI", state: "pending" } });
  expect(listed.messages.map((m) => m.body)).toContain("Ainda rodando. Volto em 30 minutos para ver o CI.");

  // The bar's list: the return, for the reader, with whether they may cancel it.
  type Listed = { followUps: { messageId: string; about: string; threadId: string | null; canCancel: boolean }[] };
  const returns = async (b: typeof owner) =>
    ((await (await b(`${org}/channels/${channelId}/follow-ups`)).json()) as Listed).followUps;
  expect(await returns(owner)).toMatchObject([
    { messageId: line?.id, about: "ver o CI", threadId: null, canCancel: true, held: false },
  ]);
  // A member who reads #general sees it, without the control, and the server refuses them.
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  expect((await returns(bia)).map((r) => r.canCancel)).toEqual([false]);
  const refused = await bia(`${org}/messages/${line?.id}/cancel-follow-up`, { json: {} });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("follow_up.not_yours");

  const canceled = await owner(`${org}/messages/${line?.id}/cancel-follow-up`, { json: {} });
  expect(canceled.status).toBe(204);
  expect(await returns(owner)).toEqual([]);
  const again = await owner(`${org}/messages/${line?.id}/cancel-follow-up`, { json: {} });
  expect(again.status).toBe(409);
  expect(((await again.json()) as { error: { code: string } }).error.code).toBe("follow_up.not_pending");
  const after = (await (await owner(`${org}/channels/${channelId}/messages`)).json()) as {
    messages: { id: string; meta: Record<string, unknown> }[];
  };
  expect(after.messages.find((m) => m.id === line?.id)?.meta.notice).toMatchObject({ refs: { state: "canceled" } });
});
