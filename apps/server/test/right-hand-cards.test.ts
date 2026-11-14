import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  grantScopes,
  makeDefaultCredential,
  openPersonAgentDm,
  RIGHT_HAND,
  type ToolSource,
} from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** The right hand's approvals and people cards (ADR 0137 §4): applied through the usual routes, audited via it. */

const github: ToolSource = {
  name: "test-github",
  tools: async () => [
    {
      name: "github_merge_pr",
      description: "Merge a pull request",
      scope: "github:pr.merge",
      inputSchema: { type: "object", properties: { pr: { type: "integer" } }, required: ["pr"] },
      describe: (i) => ({ title: `Merge PR #${i.pr}` }),
      execute: async () => ({ content: "merged" }),
    },
  ],
};

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({
    toolSources: [github],
    reply: (req) =>
      JSON.stringify(req.messages.at(-1)?.content).includes("merged")
        ? { chunks: ["Merge done."] }
        : {
            chunks: [],
            toolUses: [
              {
                name: "github_merge_pr",
                input: { pr: 42, why: "CI passed and the review is done: merging ships the fix today." },
              },
            ],
          },
  });
});
afterEach(() => t.close());

/** Posts Lodi's card in the owner's DM with it, as its tools do. */
async function lodiCard(orgId: string, userId: string, actionCard: Record<string, unknown>) {
  const [lodi] = await t.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  const dm = await openPersonAgentDm(t.db, orgId, userId, lodi.id);
  const [m] = await t.db
    .insert(schema.messages)
    .values({
      orgId,
      channelId: dm.id,
      authorType: "agent",
      authorAgentId: lodi.id,
      body: "card",
      meta: { actionCard },
    })
    .returning();
  return { lodiId: lodi.id, messageId: m?.id ?? "" };
}

const viaRows = async (orgId: string, lodiId: string) =>
  (await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, orgId)))
    .filter((r) => (r.details as { via?: string }).via === lodiId)
    .map((r) => r.action)
    .sort();

test("an approval decided from the right hand's card, and people changed from its card, are audited via it", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const ownerId = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const { orgId, channelId, agentId } = await seedOrg(owner);
  await grantScopes(t.db, orgId, agentId, [{ connectionId: null, scope: "github:pr.merge" }]);
  await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, { json: { body: "@dev merge 42" } });
  await t.drain();
  const [approval] = await t.db.select().from(schema.approvals).where(eq(schema.approvals.orgId, orgId));
  if (!approval) throw new Error("no approval");

  const nina = await joinByInvitation(t, owner, orgId, "nina@example.com");
  const ninaId = ((await (await nina("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const { lodiId, messageId } = await lodiCard(orgId, ownerId, {
    kind: "approvals",
    forUserId: ownerId,
    params: { approvalIds: [approval.id], why: "x" },
  });
  const people = await lodiCard(orgId, ownerId, {
    kind: "member_changes",
    forUserId: ownerId,
    params: { rows: [{ userId: ninaId, role: "owner" }], why: "x" },
  });

  const approved = await owner(`/api/app/organizations/${orgId}/approvals/${approval.id}/approve`, {
    json: { via: messageId },
  });
  expect(approved.status).toBe(200);
  // A member's click is refused at the click, card or not.
  const refused = await nina(`/api/app/organizations/${orgId}/members/${ninaId}?via=${people.messageId}`, {
    method: "PATCH",
    json: { role: "owner" },
  });
  expect(refused.status).toBe(403);
  const made = await owner(`/api/app/organizations/${orgId}/members/${ninaId}?via=${people.messageId}`, {
    method: "PATCH",
    json: { role: "owner" },
  });
  expect(made.status).toBe(204);
  // A card that has no row for that person adds no via.
  const back = await owner(`/api/app/organizations/${orgId}/members/${ninaId}?via=${messageId}`, {
    method: "PATCH",
    json: { role: "member" },
  });
  expect(back.status).toBe(204);
  expect(await viaRows(orgId, lodiId)).toEqual(["approval.approved", "member.role_changed"]);
});

test("a card of a workspace change: read, refused, sent to whoever may, applied as them and undone, through the routes", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const ownerId = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const { orgId } = await seedOrg(owner);
  const nina = await joinByInvitation(t, owner, orgId, "nina@example.com");
  const ninaId = ((await (await nina("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const card = {
    kind: "workspace_action",
    forUserId: ninaId,
    params: {
      action: "create_role",
      input: { name: "Marketing", permissions: ["talk_to_agents", "edit_wiki"] },
      words: { name: "Marketing" },
      needs: "manage_roles",
      why: "Cargo de marketing",
    },
    state: "pending",
    decidedByUserId: null,
    decidedAt: null,
  };
  const { messageId } = await lodiCard(orgId, ninaId, card);
  const url = `/api/app/organizations/${orgId}/action-cards/${messageId}`;
  const roles = async () =>
    (await t.db.select().from(schema.orgRoles).where(eq(schema.orgRoles.orgId, orgId))).map((r) => r.name);

  expect(((await (await nina(url)).json()) as { card: { state: string } }).card.state).toBe("pending");
  // The owner can't read her DM, and her own click is refused by the roles screen's check.
  expect((await owner(url)).status).toBe(403);
  expect((await nina(`${url}/apply`, { json: {} })).status).toBe(403);
  expect(await roles()).not.toContain("Marketing");
  expect((await nina(`${url}/ask`, { json: {} })).status).toBe(200);
  const applied = await owner(`${url}/apply`, { json: {} });
  expect(applied.status).toBe(200);
  expect(((await applied.json()) as { card: { state: string; decidedByUserId: string } }).card).toMatchObject({
    state: "applied",
    decidedByUserId: ownerId,
  });
  expect(await roles()).toContain("Marketing");
  expect((await owner(`${url}/apply`, { json: {} })).status).toBe(409);
  const [receipt] = await t.db.select().from(schema.agentActions).where(eq(schema.agentActions.messageId, messageId));
  expect((await owner(`/api/app/organizations/${orgId}/actions/${receipt?.id}/undo`, { json: {} })).status).toBe(200);
  expect(await roles()).not.toContain("Marketing");
});

test("an invite card through the routes: refused from an app that doesn't word it, then sent as whoever applies it", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const ownerId = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const { orgId } = await seedOrg(owner);
  const nina = await joinByInvitation(t, owner, orgId, "nina@example.com");
  const ninaId = ((await (await nina("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const card = (forUserId: string, ...emails: string[]) => ({
    kind: "workspace_action",
    forUserId,
    params: {
      action: "invite_people",
      input: { emails, roleIds: [], roleNames: [] },
      words: { emails: emails.join(", "), roles: "" },
      needs: "invite_people",
      why: "Quem cuida das vendas",
    },
    state: "pending",
    decidedByUserId: null,
    decidedAt: null,
  });
  const sent = async () =>
    (await t.db.select().from(schema.organizationInvitations).where(eq(schema.organizationInvitations.orgId, orgId)))
      .filter((i) => !i.acceptedAt)
      .map((i) => ({ email: i.email, by: i.invitedByUserId }));
  const emails = async () =>
    (await t.db.select().from(schema.outbox).where(eq(schema.outbox.orgId, orgId))).filter(
      (j) => j.kind === "email.send" && JSON.stringify(j.payload).includes("ana@example.com"),
    ).length;

  const mine = await lodiCard(orgId, ownerId, card(ownerId, "ana@example.com"));
  const url = `/api/app/organizations/${orgId}/action-cards/${mine.messageId}`;
  // An installed app sends no `knows`: it showed "a change in the workspace", so nothing is applied.
  for (const json of [{}, { knows: "create_role" }]) {
    const refused = await owner(`${url}/apply`, { json });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("action_card.update_app");
  }
  expect(await sent()).toEqual([]);
  expect(await emails()).toBe(0);
  const applied = await owner(`${url}/apply`, { json: { knows: "invite_people" } });
  expect(applied.status).toBe(200);
  expect(
    ((await applied.json()) as { card: { state: string; params: { words: Record<string, string> } } }).card,
  ).toMatchObject({
    state: "applied",
    params: { words: { invited: "ana@example.com" } },
  });
  expect(await sent()).toEqual([{ email: "ana@example.com", by: ownerId }]);
  expect(await emails()).toBe(1);
  // Applied once: a second tap changes nothing.
  expect((await owner(`${url}/apply`, { json: { knows: "invite_people" } })).status).toBe(409);
  expect(await emails()).toBe(1);

  // A member's own tap runs with the member's permissions: refused, and nobody is invited.
  const hers = await lodiCard(orgId, ninaId, card(ninaId, "bia@example.com"));
  const herUrl = `/api/app/organizations/${orgId}/action-cards/${hers.messageId}`;
  expect((await nina(`${herUrl}/apply`, { json: { knows: "invite_people" } })).status).toBe(403);
  expect((await sent()).map((i) => i.email)).toEqual(["ana@example.com"]);
  // Dismissing needs no `knows`.
  expect((await nina(`${herUrl}/dismiss`, { json: {} })).status).toBe(200);

  // An address that already holds an invitation is said in the answer to whoever applied the card, who may invite.
  // Nina, who may not, reads who was invited and no more.
  const both = await lodiCard(orgId, ninaId, card(ninaId, "ana@example.com", "caio@example.com"));
  const bothUrl = `/api/app/organizations/${orgId}/action-cards/${both.messageId}`;
  expect((await nina(`${bothUrl}/apply`, { json: { knows: "invite_people" } })).status).toBe(403);
  expect((await nina(`${bothUrl}/ask`, { json: {} })).status).toBe(200);
  const wordsOf = async (res: Response) =>
    ((await res.json()) as { card: { params: { words: Record<string, string> } } }).card.params.words;
  expect(await wordsOf(await owner(`${bothUrl}/apply`, { json: { knows: "invite_people" } }))).toMatchObject({
    invited: "caio@example.com",
    already_invited: "ana@example.com",
  });
  const read = await wordsOf(await nina(bothUrl));
  expect(read).toMatchObject({ invited: "caio@example.com" });
  expect(read).not.toHaveProperty("already_invited");
});

test("an API key's removal through the routes: only from an app that names the key, then gone", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const ownerId = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const { orgId, credentialId } = await seedOrg(owner);
  // Agents on Automatic think with the workspace's default key: the first one stays it.
  await makeDefaultCredential(t.db, ownerId, orgId, credentialId);
  const keysUrl = `/api/app/organizations/${orgId}/credentials`;
  const spare = (await (
    await owner(keysUrl, { json: { provider: "deepseek", label: "Chave antiga", apiKey: "sk-test-key-not-real-0003" } })
  ).json()) as { id: string };
  const has = async () =>
    (await t.db.select().from(schema.providerCredentials).where(eq(schema.providerCredentials.orgId, orgId))).some(
      (k) => k.id === spare.id,
    );
  const { messageId } = await lodiCard(orgId, ownerId, {
    kind: "workspace_action",
    forUserId: ownerId,
    params: {
      action: "remove_ai_key",
      input: { credentialId: spare.id, name: "Chave antiga" },
      words: { name: "Chave antiga", provider: "DeepSeek" },
      needs: "manage_credentials",
      why: "",
    },
    state: "pending",
    decidedByUserId: null,
    decidedAt: null,
  });
  const url = `/api/app/organizations/${orgId}/action-cards/${messageId}`;
  const refused = await owner(`${url}/apply`, { json: {} });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("action_card.update_app");
  expect(await has()).toBe(true);
  expect((await owner(`${url}/apply`, { json: { knows: "remove_ai_key" } })).status).toBe(200);
  expect(await has()).toBe(false);
});
