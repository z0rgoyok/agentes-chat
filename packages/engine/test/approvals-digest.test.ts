import { afterEach, expect, test } from "bun:test";
import { and, eq, inArray, schema } from "@agenteschat/db";
import {
  COMMAND_RULE_TOOL,
  COMPOSIO_EXECUTOR,
  decideApprovals,
  ForbiddenError,
  highRisk,
  insertMessage,
  listApprovals,
  liveLodiSwitches,
  openPersonAgentDm,
  personAgentDmKey,
  publishApproval,
  REQUEST_PERMISSION_TOOL,
  RIGHT_HAND,
  repointApprovals,
  routineCall,
  SQL_READS,
  setLodiPrefs,
} from "../src";
import {
  APPROVALS_DIGEST_JOB,
  approvalsDigestLane,
  postApprovalsDigest,
  queueApprovalsDigest,
} from "../src/approvals-digest";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const HOUR = 3_600_000;
const NOW = new Date("2026-11-06T01:00:00Z");
/** A connected app. Only what is routine reads its row (`connect`): to every other test an approval just names it. */
const APP = "00000000-0000-4000-8000-00000000c001";
const TRACKER = "00000000-0000-4000-8000-00000000c002";
const CODE = "00000000-0000-4000-8000-00000000c003";
const GONE = "00000000-0000-4000-8000-00000000c004";
/** Work nobody watched, at the level that asks for some things: every write to a connected app asks there. */
const UNATTENDED = { origin: { kind: "unattended" }, approveAlways: { tool: "t", actions: [] } };

/** The connected apps as the workspace stores them: a custom server with its classified tools, two from the catalog. */
async function connect() {
  const app = (id: string, connector: string, toolPrefix: string) => ({
    id,
    orgId: f.org.id,
    connector,
    label: toolPrefix,
    toolPrefix,
    serverUrl: `https://${toolPrefix}.example.com/mcp`,
    authType: "none",
  });
  await f.db
    .insert(schema.connectorConnections)
    .values([
      app(APP, "custom:notes", "notes"),
      app(TRACKER, "linear", "linear"),
      app(CODE, "github", "github"),
      { ...app(GONE, "custom:old", "old"), revokedAt: NOW },
    ]);
  const tool = (name: string, over: Partial<typeof schema.customTools.$inferInsert> = {}) => ({
    orgId: f.org.id,
    connectionId: APP,
    name,
    access: "write",
    suggestedAccess: "write",
    ...over,
  });
  await f.db.insert(schema.customTools).values([
    tool("create_page"),
    tool("update_page"),
    // An admin set it to ask every time, or turned it off.
    tool("rename_page", { access: "approval" }),
    tool("link_page", { access: "off" }),
    // Our words or the judge would have it ask, whatever the admin chose after.
    tool("move_page", { sensitive: true, access: "approval" }),
    tool("copy_page", { suggestedAccess: "approval" }),
    // Its server says it destroys.
    tool("tag_page", { destructiveHint: true }),
    // The server stopped listing it.
    tool("sort_page", { removedAt: NOW }),
    tool("create_page", { connectionId: GONE }),
  ]);
}

const deps = () => ({ db: f.db, pubsub: f.pubsub, now: () => NOW });

let n = 0;
/** One approval waiting, as the gateway writes it: a connected app's plain action unless `over` says otherwise. */
async function ask(over: Partial<typeof schema.approvals.$inferInsert> = {}) {
  n += 1;
  const tool = over.tool ?? "notes_create_page";
  const scope = over.scope ?? `custom:${APP}:write`;
  const [row] = await f.db
    .insert(schema.approvals)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      toolUseId: `use-${n}`,
      tool,
      scope,
      connectionId: APP,
      params: {},
      actionHash: `hash-${n}`,
      title: `Create page ${n}`,
      ownerUserId: f.owner.id,
      expiresAt: new Date(NOW.getTime() + 72 * HOUR),
      highRisk: highRisk(tool, scope),
      ...over,
    })
    .returning();
  if (!row) throw new Error("no approval");
  return row;
}

const lodiOf = async () => {
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

/** What the right hand posted by itself, oldest first. */
const posts = async () =>
  f.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.authorAgentId, (await lodiOf()).id))
    .orderBy(schema.messages.createdAt);

const cardIds = (m: { meta: Record<string, unknown> } | undefined) =>
  (m?.meta.actionCard as { params: { approvalIds: string[] } } | undefined)?.params.approvalIds;

const digest = (userId: string, at = NOW) => postApprovalsDigest(f.jobDeps, f.org.id, { userId }, at);

test("the switch is live", () => {
  expect(approvalsDigestLane.live).toBe(true);
  expect(liveLodiSwitches()).toContain("digest");
});

test("a new approval queues one job a person on the next 10-minute mark at least 10 minutes away", async () => {
  f = await setup({ rightHand: true });
  const jobs = () => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, APPROVALS_DIGEST_JOB));
  await queueApprovalsDigest(f.db, f.org.id, [f.owner.id], new Date("2026-11-06T12:03:00Z"));
  await queueApprovalsDigest(f.db, f.org.id, [f.owner.id, f.owner.id], new Date("2026-11-06T12:09:59Z"));
  await queueApprovalsDigest(f.db, f.org.id, [f.owner.id], new Date("2026-11-06T12:10:00Z"));
  expect((await jobs()).map((j) => [j.nextAttemptAt.toISOString(), j.dedupeKey, j.payload])).toEqual([
    [
      "2026-11-06T12:20:00.000Z",
      `approvals_digest.post:${f.org.id}:${f.owner.id}:2026-11-06T12:20:00.000Z`,
      { userId: f.owner.id },
    ],
  ]);
  // Publishing an approval queues it for whoever is told: the agent's owner.
  await publishApproval(deps(), await ask(), "approval.created");
  const queued = await jobs();
  expect(queued).toHaveLength(2);
  expect(queued.every((j) => (j.payload as { userId: string }).userId === f.owner.id)).toBe(true);
});

test("under three nothing, three give one quiet card, a fourth joins it, and no model is called", async () => {
  f = await setup({ rightHand: true });
  const first = [await ask(), await ask()];
  // It answers whether a card holds what waits: the reminder of unread asks leaves approvals to it only then.
  expect(await digest(f.owner.id)).toBe(false);
  expect(await posts()).toEqual([]);

  first.push(await ask());
  expect(await digest(f.owner.id)).toBe(true);
  const [card, ...more] = await posts();
  expect(more).toEqual([]);
  expect(card?.meta).toMatchObject({
    bodyCode: "action_approvals",
    actionCard: {
      kind: "approvals",
      forUserId: f.owner.id,
      params: { approvalIds: first.map((a) => a.id), why: "", digest: true },
    },
  });
  // In the person's own DM with the right hand, and nowhere else.
  const [dm] = await f.db
    .select()
    .from(schema.channels)
    .where(eq(schema.channels.id, card?.channelId ?? ""));
  expect(dm?.dmKey).toBe(personAgentDmKey(f.owner.id, (await lodiOf()).id));
  // Ids only: what each approval says comes from the reader's own list.
  expect(JSON.stringify(card)).not.toContain("Create page");

  // The same job again says nothing more.
  await digest(f.owner.id);
  expect(await posts()).toHaveLength(1);

  // A fourth, and one decided meanwhile: the same card, the decided one keeping its line.
  const fourth = await ask();
  await decideApprovals(deps(), f.owner.id, f.org.id, { ids: [first[0]?.id ?? ""], decision: "approve" });
  await digest(f.owner.id, new Date(NOW.getTime() + HOUR));
  const after = await posts();
  expect(after.map((m) => m.id)).toEqual([card?.id ?? ""]);
  expect(cardIds(after[0])).toEqual([...first.map((a) => a.id), fourth.id]);

  // It never rings: no inbox row, no push, and nothing asked of a model.
  expect(await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "notifications.message"))).toEqual([]);
  expect(await f.db.select().from(schema.notifications)).toEqual([]);
  expect(f.provider.calls).toHaveLength(0);
});

test("the card the right hand posted when asked what waits is the one that grows: the same approvals are on one card", async () => {
  f = await setup({ rightHand: true });
  const lodi = await lodiOf();
  const first = [await ask(), await ask()];
  const card = {
    kind: "approvals",
    forUserId: f.owner.id,
    params: { approvalIds: first.map((a) => a.id), why: "Two wait" },
  };
  const say = async (channelId: string, minutesAgo: number) =>
    insertMessage(f.db, {
      orgId: f.org.id,
      channelId,
      author: { type: "agent", agentId: lodi.id, runId: null, hop: 1, stretchId: null },
      body: "Approvals waiting: 2",
      meta: { actionCard: card },
      createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
    });
  // Asked in a channel: that card is everyone's to read there, and is left as it is.
  const inChannel = await say(f.general.id, 9);
  first.push(await ask());
  expect(await digest(f.owner.id)).toBe(true);
  const [, own, ...more] = await posts();
  expect(more).toEqual([]);
  expect(own?.meta.actionCard).toMatchObject({
    params: { approvalIds: first.map((a) => a.id), why: "", digest: true },
  });
  await f.db.delete(schema.messages).where(eq(schema.messages.id, own?.id ?? ""));

  // Asked in their own DM with it: no second card under it. It takes what came since and keeps its line.
  const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
  const asked = await say(dm.id, 5);
  expect(await digest(f.owner.id)).toBe(true);
  const after = await posts();
  expect(after.map((m) => m.id)).toEqual([inChannel.id, asked.id]);
  expect(after[0]?.meta.actionCard).toEqual(card);
  expect(after[1]?.meta.actionCard).toEqual({
    kind: "approvals",
    forUserId: f.owner.id,
    params: { approvalIds: first.map((a) => a.id), why: "Two wait", digest: true },
  });
  // Nothing new since: it says nothing and changes nothing.
  expect(await digest(f.owner.id)).toBe(true);
  expect(await posts()).toHaveLength(2);
  expect(f.provider.calls).toHaveLength(0);
});

test("silent with the switch off, in a closed workspace, for someone gone, and when they decided in time", async () => {
  f = await setup({ rightHand: true });
  const three = [await ask(), await ask(), await ask()];

  await setLodiPrefs(f.db, f.org.id, f.owner.id, { digestOff: true });
  await digest(f.owner.id);
  expect(await posts()).toEqual([]);
  await setLodiPrefs(f.db, f.org.id, f.owner.id, { digestOff: false });

  await f.db
    .update(schema.organizations)
    .set({ deletionDueAt: new Date(Date.now() + 24 * HOUR) })
    .where(eq(schema.organizations.id, f.org.id));
  await digest(f.owner.id);
  expect(await posts()).toEqual([]);
  await f.db.update(schema.organizations).set({ deletionDueAt: null }).where(eq(schema.organizations.id, f.org.id));

  await digest("nobody");
  await postApprovalsDigest(f.jobDeps, f.org.id, {}, NOW);
  expect(await posts()).toEqual([]);

  // Decided before the job ran: two are left, and two is not worth a card.
  await decideApprovals(deps(), f.owner.id, f.org.id, { ids: [three[0]?.id ?? ""], decision: "refuse" });
  await digest(f.owner.id);
  expect(await posts()).toEqual([]);
  // One past its deadline does not count either.
  await ask({ expiresAt: new Date(NOW.getTime() - HOUR) });
  await digest(f.owner.id);
  expect(await posts()).toEqual([]);
  expect(f.provider.calls).toHaveLength(0);
});

test("an old card is left alone, and a person gets at most two digests a day", async () => {
  f = await setup({ rightHand: true });
  const settle = (ids: string[]) =>
    f.db.update(schema.approvals).set({ status: "approved" }).where(inArray(schema.approvals.id, ids));
  const first = [await ask(), await ask(), await ask()];
  await digest(f.owner.id);
  const [old] = await posts();
  await f.db
    .update(schema.messages)
    .set({ createdAt: new Date(NOW.getTime() - HOUR) })
    .where(eq(schema.messages.id, old?.id ?? ""));

  // Thirteen hours on the first card still lists what waits, but nobody is looking at it: a new one.
  const later = new Date(NOW.getTime() + 12 * HOUR);
  const fourth = await ask();
  await digest(f.owner.id, later);
  const two = await posts();
  expect(two).toHaveLength(2);
  expect(cardIds(two[0])).toEqual(first.map((a) => a.id));
  expect(cardIds(two[1])).toEqual([...first.map((a) => a.id), fourth.id]);

  // All decided, three new ones the same day: the day's two are spent, so nothing.
  await settle([...first.map((a) => a.id), fourth.id]);
  const next = [await ask(), await ask(), await ask()];
  expect(await digest(f.owner.id, new Date(later.getTime() + HOUR))).toBe(false);
  expect(await posts()).toHaveLength(2);

  // The next day it speaks again.
  await digest(f.owner.id, new Date(NOW.getTime() + 24 * HOUR));
  const three = await posts();
  expect(three).toHaveLength(3);
  expect(cardIds(three[2])).toEqual(next.map((a) => a.id));
});

test("it counts only what the person was told about, and never another person's mailbox", async () => {
  f = await setup({ rightHand: true });
  const bia = await addMember(f.db, f.org.id, "admin", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  // Three of the owner's agent: Bia may decide them as an admin, silently. She was not told, so no card for her.
  for (let i = 0; i < 3; i++) await ask();
  // Three in the owner's own mailbox, asked by someone else: only the owner decides those.
  const mailbox = { userIds: [f.owner.id], label: "owner", requestedBy: caio.id, requesterDecides: false };
  for (let i = 0; i < 3; i++)
    await ask({ tool: "mail_work_draft", scope: "mail:draft", approvers: { ...mailbox, required: true } });
  expect((await listApprovals(f.db, bia.id, f.org.id, { status: "pending" })).filter((a) => a.canDecide)).toHaveLength(
    3,
  );

  await digest(bia.id);
  await digest(caio.id);
  expect(await posts()).toEqual([]);

  await digest(f.owner.id);
  const [card, ...more] = await posts();
  expect(more).toEqual([]);
  expect(cardIds(card)).toHaveLength(6);
  const [dm] = await f.db
    .select()
    .from(schema.channels)
    .where(eq(schema.channels.id, card?.channelId ?? ""));
  expect(dm?.dmKey).toBe(personAgentDmKey(f.owner.id, (await lodiOf()).id));
  // Nobody else is in that conversation.
  const members = await f.db
    .select()
    .from(schema.channelMembers)
    .where(eq(schema.channelMembers.channelId, card?.channelId ?? ""));
  expect(members.flatMap((m) => m.userId ?? [])).toEqual([f.owner.id]);
});

test("by its row alone, a call that posts, pays, changes who gets in or runs its input is never routine", () => {
  const row = (tool: string, over: Record<string, unknown> = {}) => {
    const scope = `custom:${APP}:write`;
    return {
      tool,
      scope,
      connectionId: APP,
      highRisk: highRisk(tool, scope),
      approvers: null,
      approveAlways: null,
      origin: null,
      ...over,
    } as Parameters<typeof routineCall>[0];
  };
  const own = [
    // A public post.
    "x_create_tweet",
    "acme_post_tweet",
    "linkedin_create_post",
    "wordpress_create_post",
    "social_create_article_or_url_share",
    "social_post_ig_user_media_publish",
    "video_upload_video",
    "boards_create_pin",
    // Money, and who gets in.
    "billing_create_subscription",
    "acme_cancel_subscription",
    "ads_update_campaign_budget",
    "code_add_a_repository_collaborator",
    "files_add_file_sharing_preference",
    "team_add_member",
    "sheets_clear_values",
    "chat_archive_a_conversation",
    "cloud_update_dns_record",
    // What runs whatever its input says.
    "crm_custom_api_call",
    "acme_api_request",
    "acme_make_request",
    "acme_call_function",
    "warehouse_query_data",
    "acme_query_database",
    "acme_apply_migration",
    "supabase_apply_migration",
    "ops_server_execute_command",
    // Composio's executor, whatever its input names: no record vouches for those actions.
    `acme_${COMPOSIO_EXECUTOR}`,
    "acme_COMPOSIO_REMOTE_WORKBENCH",
    // Sends, deletes and payments, in any case.
    "mail_send_email",
    "acme_sendEmail",
    "acme_deleteRepository",
    "chat_post_message",
    "billing_create_payment_link",
    "billing_pay_invoice",
    "github_merge_pull_request",
  ];
  expect(own.filter((tool) => routineCall(row(tool)) || routineCall(row(tool, UNATTENDED)))).toEqual([]);

  const plain = ["notes_create_page", "notes_update_page", "linear_create_issue", "calendar_update_event"];
  expect(plain.filter((tool) => !routineCall(row(tool)) || !routineCall(row(tool, UNATTENDED)))).toEqual([]);

  // At the default level a person's run asks a connected app's call only when the tool is marked to ask: never routine.
  const kept = { tool: "create_page", actions: [] };
  expect(routineCall(row("notes_create_page", { approveAlways: kept }))).toBe(false);
  expect(routineCall(row("notes_create_page", { approveAlways: kept, origin: { kind: "unattended" } }))).toBe(true);
  // SQL the guard proved read-only is, whoever asked. Never through a mailbox's scope or people named to decide.
  const reads = { approveAlways: { tool: "execute_sql", actions: [`${SQL_READS}project_id=abc`] } };
  expect(routineCall(row("supabase_execute_sql", reads))).toBe(true);
  expect(routineCall(row("supabase_execute_sql"))).toBe(false);
  expect(routineCall(row("supabase_execute_sql", { ...reads, scope: "mail:send" }))).toBe(false);
  expect(routineCall(row("notes_create_page", { connectionId: null }))).toBe(false);
});

test("the one tap decides only what the server calls routine, as the person who taps", async () => {
  f = await setup({ rightHand: true });
  await connect();
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const mine = { userIds: [f.owner.id], label: "owner", requestedBy: null, requesterDecides: false };
  const tracker = { scope: "linear:issues.write", connectionId: TRACKER };
  const plain = [
    // An agent that always asks: a plain write its connection lists.
    await ask(),
    // Work nobody watched, where every write to a connected app asks.
    await ask({ tool: "notes_update_page", ...UNATTENDED }),
    // A catalog connector's plain write.
    await ask({ tool: "linear_create_issue", ...tracker }),
    // SQL the Postgres guard proved read-only when it asked.
    await ask({
      tool: "supabase_execute_sql",
      approveAlways: { tool: "execute_sql", actions: [`${SQL_READS}project_id=abc`] },
    }),
  ];
  const risky = [
    // A shell command on the agent's computer, whatever it is called.
    await ask({
      tool: "run_code",
      scope: "sandbox:run",
      connectionId: null,
      params: { language: "bash", code: "gh pr merge 12" },
      approveAlways: { tool: COMMAND_RULE_TOOL, actions: ["gh pr merge"] },
    }),
    await ask({ tool: "run_code", scope: "sandbox:run", connectionId: null, params: { language: "python" } }),
    await ask({ tool: REQUEST_PERMISSION_TOOL, scope: "", connectionId: null, params: { permission: "x" } }),
    await ask({ tool: "mail_work_send", scope: "mail:send", approvers: { ...mine, required: true } }),
    await ask({ tool: "mail_work_draft", scope: "mail:draft", approvers: mine }),
    await ask({ tool: "github_merge_pull_request", scope: "github:pr.merge" }),
    await ask({ tool: "notes_delete_page" }),
    await ask({ tool: "billing_pay_invoice" }),
    await ask({ tool: "ops_server_execute_command" }),
    await ask({ tool: "supabase_execute_sql" }),
    // Composio's executor, a harmless action in its input or not.
    await ask({
      tool: `acme_${COMPOSIO_EXECUTOR}`,
      params: { tools: [{ tool_slug: "GITHUB_CREATE_AN_ISSUE", arguments: { title: "x" } }] },
    }),
    await ask({ tool: `acme_${COMPOSIO_EXECUTOR}`, params: { tools: "all" } }),
    await ask({ tool: "acme_COMPOSIO_REMOTE_WORKBENCH" }),
    // One of our own tools, even a harmless one.
    await ask({ tool: "create_issue", scope: "issues:write", connectionId: null }),
    // A person's run at the default level: the call asked because its tool is marked to ask.
    await ask({ approveAlways: { tool: "create_page", actions: [] } }),
    // Harmless names the connection does not vouch for: set to ask, off, sensitive, suggested to ask, destroys,
    // no longer listed, never listed.
    await ask({ tool: "notes_rename_page" }),
    await ask({ tool: "notes_link_page" }),
    await ask({ tool: "notes_move_page" }),
    await ask({ tool: "notes_copy_page" }),
    await ask({ tool: "notes_tag_page" }),
    await ask({ tool: "notes_sort_page" }),
    await ask({ tool: "notes_label_page" }),
    // A connection that was removed, and one nobody knows.
    await ask({ tool: "old_create_page", connectionId: GONE }),
    await ask({ tool: "linear_create_issue", ...tracker, connectionId: crypto.randomUUID() }),
    // The catalog marks it sensitive, and a tool we serve ourselves under a connection's credential.
    await ask({ tool: "github_create_repository_ruleset", scope: "github:repo.admin", connectionId: CODE }),
    await ask({ tool: "open_pull_request", scope: "github:pr.write", connectionId: CODE }),
  ];
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

  const listed = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  expect(ids(listed.filter((a) => a.routine))).toEqual(ids(plain));

  await digest(f.owner.id);
  const [card] = await posts();
  const all = [...plain, ...risky].map((a) => a.id);

  // Someone who may decide none of them is told so, and nothing changes.
  await expect(
    decideApprovals(deps(), caio.id, f.org.id, { ids: all, decision: "approve", only: "routine" }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect(await f.db.select().from(schema.approvals).where(eq(schema.approvals.status, "pending"))).toHaveLength(
    all.length,
  );

  // An admin turns one to "ask every time" after the card drew it as routine: the tap leaves it waiting.
  await f.db
    .update(schema.customTools)
    .set({ access: "approval" })
    .where(and(eq(schema.customTools.connectionId, APP), eq(schema.customTools.name, "update_page")));
  const turned = plain.splice(1, 1);
  risky.push(...turned);

  const result = await decideApprovals(deps(), f.owner.id, f.org.id, {
    ids: all,
    decision: "approve",
    only: "routine",
    via: card?.id,
  });
  expect(ids(result.approvals)).toEqual(ids(plain));
  expect([...result.skipped].sort()).toEqual(ids(risky));
  expect(result.approvals.every((a) => a.decidedByUserId === f.owner.id && !a.routine)).toBe(true);
  const waiting = await f.db.select().from(schema.approvals).where(eq(schema.approvals.status, "pending"));
  expect(ids(waiting)).toEqual(ids(risky));

  // One audit row each, the person's own, through the right hand's card. No "Aprovar sempre" rule is kept.
  const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "approval.approved"));
  expect(audit.map((r) => r.targetId).sort()).toEqual(ids(plain));
  const lodi = await lodiOf();
  expect(audit.every((r) => r.actorType === "person" && r.actorId === f.owner.id)).toBe(true);
  expect(audit.every((r) => (r.details as { via?: string }).via === lodi.id)).toBe(true);
  expect(await f.db.select().from(schema.approvalRules)).toEqual([]);

  // With nothing routine left the same tap decides nothing, and says which it left.
  const again = await decideApprovals(deps(), f.owner.id, f.org.id, { ids: all, decision: "approve", only: "routine" });
  expect(again.approvals).toEqual([]);
  expect([...again.skipped].sort()).toEqual([...all].sort());
  expect(f.provider.calls).toHaveLength(0);
});

test("a full card lets go of what was decided, never of what still waits, and then stays as it is", async () => {
  f = await setup({ rightHand: true });
  const first: { id: string }[] = [];
  for (let i = 0; i < 50; i++) first.push(await ask());
  await digest(f.owner.id);
  const [card] = await posts();
  expect(cardIds(card)).toHaveLength(50);

  // Five decided in the middle, five new: the card holds every one still waiting.
  const decided = first.slice(20, 25).map((a) => a.id);
  await f.db.update(schema.approvals).set({ status: "approved" }).where(inArray(schema.approvals.id, decided));
  const fresh: { id: string }[] = [];
  for (let i = 0; i < 5; i++) fresh.push(await ask());
  await digest(f.owner.id, new Date(NOW.getTime() + HOUR));
  const waiting = [...first.filter((a) => !decided.includes(a.id)), ...fresh].map((a) => a.id);
  const [after, ...more] = await posts();
  expect(more).toEqual([]);
  expect(cardIds(after)).toEqual(waiting);

  // The next job has nothing to change, so the message is not written again: a mark left on the card survives it.
  const marked = { ...after?.meta, actionCard: { ...(after?.meta.actionCard as object), mark: "kept" } };
  await f.db
    .update(schema.messages)
    .set({ meta: marked })
    .where(eq(schema.messages.id, card?.id ?? ""));
  await digest(f.owner.id, new Date(NOW.getTime() + 2 * HOUR));
  expect((await posts())[0]?.meta).toEqual(marked);

  // One more than a card holds: the oldest fifty still waiting stay, and none of them gives its place.
  await ask();
  await digest(f.owner.id, new Date(NOW.getTime() + 3 * HOUR));
  const [last, ...none] = await posts();
  expect(none).toEqual([]);
  expect(last?.meta).toEqual(marked);
});

test("an admin's card counts their own agents', nobody's and a covered person's, never another owner's", async () => {
  f = await setup({ rightHand: true });
  const bia = await addMember(f.db, f.org.id, "admin", "bia");
  // The owner's agent: Bia may decide these, and is not told.
  for (let i = 0; i < 3; i++) await ask();
  await digest(bia.id);
  expect(await posts()).toEqual([]);

  // An agent with nobody responsible: the admins are told, Bia among them.
  const nobodys = [
    await ask({ ownerUserId: null }),
    await ask({ ownerUserId: null }),
    await ask({ ownerUserId: null }),
  ];
  await digest(bia.id);
  const [card, ...more] = await posts();
  expect(more).toEqual([]);
  expect(card?.meta).toMatchObject({ actionCard: { forUserId: bia.id } });
  expect(cardIds(card)).toEqual(nobodys.map((a) => a.id));

  // Bia now covers the owner: the owner's three reach her too, on the same card.
  await f.db
    .insert(schema.approvalCovers)
    .values({ orgId: f.org.id, fromUserId: f.owner.id, toUserId: bia.id, mode: "always", risky: true });
  await digest(bia.id, new Date(NOW.getTime() + HOUR));
  expect(cardIds((await posts())[0])).toHaveLength(6);
  expect(f.provider.calls).toHaveLength(0);
});

test("an agent that changes owner queues one job for the new owner, however many of its approvals wait", async () => {
  f = await setup({ rightHand: true });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  for (let i = 0; i < 4; i++) await ask();
  await repointApprovals(deps(), f.org.id, [f.agent.id], bia.id);
  const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, APPROVALS_DIGEST_JOB));
  expect(jobs.map((j) => j.payload)).toEqual([{ userId: bia.id }]);
  // And the card that job posts is hers, with the four.
  await digest(bia.id);
  const [card] = await posts();
  expect(card?.meta).toMatchObject({ actionCard: { forUserId: bia.id } });
  expect(cardIds(card)).toHaveLength(4);
});
