import { LOCKED_BRAIN_PROTOCOL } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNull, type SQL, schema, sql } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import { appLocale } from "@agenteschat/i18n/locale";
import { AUTO_MODEL } from "@agenteschat/providers";
import type { Agent } from "./agents";
import { recordAudit } from "./audit";
import { accountablePerson, fedByRoutine, personOfMessage, runAuthorityById } from "./authority";
import type { BrainUnavailability, ModelScope } from "./brains/select";
import { ForbiddenError } from "./errors";
import type { MachineStatus } from "./machine-hub";
import type { NoAiCardReason } from "./no-ai";
import { personBehindCall } from "./requester";
import { runnerUpdateWay } from "./runner-update";
import { type AgentRun, isCliFailure } from "./runs";
import { scrubSignIns } from "./tool-detail";
import type { ToolContext } from "./tools/types";

const {
  agents,
  agentBudgetPeriods,
  channelMembers,
  channels,
  machineAccounts,
  organizationMembers,
  organizations,
  users,
} = schema;

/**
 * The team's right hand (ADR 0137): one built-in agent per workspace that sets the team up and changes it, through
 * cards applied by whoever clicks, with the permissions of the person talking to it. Its row is an ordinary agent
 * (`agents.builtin`), so DMs, runs, the gateway's budget and accounting work as for any agent.
 */
export const RIGHT_HAND = "right_hand" as const;

export const isRightHand = (a: { builtin?: string | null } | null | undefined) => a?.builtin === RIGHT_HAND;

/** What it starts with. The name is the same in every language; admins may rename it and change its look. */
export const RIGHT_HAND_DEFAULTS = {
  name: "Lodi",
  handle: "lodi",
  model: AUTO_MODEL,
  appearance: { color: "teal", eyes: "happy", accessory: "headset" },
} as const;

/** What "Automático" reads of it (`chooseAutoModel`): small work first, so it starts on the cheap tier. */
export const RIGHT_HAND_AUTO = {
  role: "Workspace assistant",
  instructions:
    "Sets the team up with people through short questions and cards, and follows its work. A status, a greeting or a short question: the smallest tier and low effort. Handing work to an agent, following it up or reporting what came of it: the medium tier. More only when the person asks for something long or complex.",
} as const;

/**
 * What it holds whatever its grant rows say (`loadScopeKeys` adds the rows on top: apps, mailboxes, databases, a
 * tool turned off): every built-in scope an agent can be given but a computer's, and the setup cards. A computer's
 * (`sandbox:run`, `browser:use`, `desktop:use`) are rows like any agent's, given when it is made
 * (`RIGHT_HAND_COMPUTER_GRANTS`, ADR 0175), so an admin turns them off on its page. One row answers everyone, so what
 * is one person's stays in that person's own DM with it (`rightHandReader`): their Vault items, their mailbox, their
 * tasks, what it remembers for them, and their seat on the workspace's computer (`right-hand-seats.ts`).
 */
export const RIGHT_HAND_GRANTS: readonly string[] = [
  "setup:write",
  "context:read",
  "memory:write",
  "drive:read",
  "drive:write",
  "issues:read",
  "issues:write",
  "calendar:read",
  "calendar:write",
  "skills:read",
  "wiki:read",
  "wiki:write",
  "schedule:write",
  "vault:read",
  "vault:write",
];

/**
 * Tools it is never offered, whatever its grants: each acts on a computer under the agent's own id, which reaches
 * none (ADR 0175 §2), so offering it would only end in a refusal. A folder outside its own, its browser's own hand-off
 * (its browser shows on the seat's desktop, asked for there), missions, and keeping something running after the run.
 */
export const RIGHT_HAND_NOT_OFFERED: ReadonlySet<string> = new Set([
  "request_folder_access",
  "browser_ask_person",
  "propose_mission",
  "keep_running",
]);

/** The grant rows it is made with: its computer's scopes, used in a seat there, a person's own or the shared one (ADR 0175). */
export const RIGHT_HAND_COMPUTER_GRANTS = ["sandbox:run", "browser:use", "desktop:use"] as const;

/**
 * Its owner (the person accountable for it) is the workspace's longest-standing owner who can still sign in: set
 * again whenever the one it has is no longer an owner (a role change, leaving, an account deleted).
 */
export async function followOwner(db: Executor, orgId: string) {
  await db.execute(sql`update ${agents} a set owner_user_id = (
      select om.user_id from ${organizationMembers} om join ${users} u on u.id = om.user_id
      where om.org_id = ${orgId}::uuid and om.role = 'owner'
      order by u.blocked_at is not null or u.deletion_due_at is not null, om.created_at limit 1)
    where a.org_id = ${orgId}::uuid and a.builtin = ${RIGHT_HAND}
      and not exists (select 1 from ${organizationMembers} om join ${users} u on u.id = om.user_id
        where om.org_id = a.org_id and om.user_id = a.owner_user_id and om.role = 'owner'
          and u.blocked_at is null and u.deletion_due_at is null)`);
}

/**
 * Gives the workspace its right hand unless it has one (idempotent: the partial unique index decides between two at
 * once). The handle is `lodi`, or the first free one after it. Its budget is the workspace's default. No audit row: it
 * comes with the workspace, as the workspace itself does.
 */
export async function ensureRightHand(db: Executor, orgId: string): Promise<string | null> {
  const [had] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.builtin, RIGHT_HAND)));
  if (had) return null;
  const { freeHandle, takenHandles } = await import("./agents");
  const { FIRST_RUN_SETUP } = await import("./setup-checklist");
  const [taken, [other]] = await Promise.all([
    takenHandles(db, orgId),
    db.select({ id: agents.id }).from(agents).where(eq(agents.orgId, orgId)).limit(1),
  ]);
  const handle = taken.has(RIGHT_HAND_DEFAULTS.handle)
    ? freeHandle(RIGHT_HAND_DEFAULTS.handle, taken)
    : RIGHT_HAND_DEFAULTS.handle;
  const [made] = await db
    .insert(agents)
    .values({
      orgId,
      builtin: RIGHT_HAND,
      name: RIGHT_HAND_DEFAULTS.name,
      handle,
      model: RIGHT_HAND_DEFAULTS.model,
      brainModel: AUTO_MODEL,
      brainEffort: AUTO_MODEL,
      appearance: { ...RIGHT_HAND_DEFAULTS.appearance },
      // A workspace with no agent yet opens on its first-run checklist (ADR 0155 §6).
      ...(other ? {} : { setup: FIRST_RUN_SETUP }),
    })
    .onConflictDoNothing()
    .returning({ id: agents.id });
  if (!made) return null;
  await followOwner(db, orgId);
  await db
    .insert(agentBudgetPeriods)
    // The month's counter exists from the start, as for any new agent (`resyncBudgetCounter`): nothing spent yet.
    .values({ orgId, agentId: made.id, periodStart: sql`date_trunc('month', now() at time zone 'utc')::date` })
    .onConflictDoNothing();
  await db
    .insert(schema.agentScopes)
    .values(RIGHT_HAND_COMPUTER_GRANTS.map((scope) => ({ orgId, agentId: made.id, connectionId: null, scope })))
    .onConflictDoNothing();
  return made.id;
}

/** The workspace's right hand, where it opens after its onboarding: null once archived or deleted. */
export async function rightHandId(db: Executor, orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.orgId, orgId), eq(agents.builtin, RIGHT_HAND), isNull(agents.archivedAt), isNull(agents.deletedAt)),
    );
  return row?.id ?? null;
}

/**
 * Every workspace without a right hand gets one (boot): one query finds none once they all have it. Not one being
 * deleted, which nobody uses again.
 */
export async function ensureRightHands(db: Database, batch = 200): Promise<number> {
  let made = 0;
  for (;;) {
    const rows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          isNull(organizations.deletionDueAt),
          sql`not exists (select 1 from ${agents} a where a.org_id = ${organizations.id} and a.builtin = ${RIGHT_HAND})`,
        ),
      )
      .limit(batch);
    for (const org of rows) if (await db.transaction((tx) => ensureRightHand(tx, org.id))) made++;
    if (rows.length < batch) return made;
  }
}

/** 403 `agent.right_hand_permanent`: it is part of the workspace, as its Settings say. */
export const rightHandPermanent = (what: string) =>
  new ForbiddenError(`The team's right hand can't be ${what}`, "agent.right_hand_permanent");

/** What admins may change on it (ADR 0137): its name and handle, AI and model, budget, how much it asks. Look and audience have their own calls. */
export const RIGHT_HAND_EDITABLE: ReadonlySet<string> = new Set([
  "name",
  "handle",
  "model",
  "credentialId",
  "monthlyBudgetNanoUsd",
  "approvalsLevel",
]);

/** Whether `agentId` is the workspace's right hand, for a caller that holds only its id. */
export async function isRightHandId(db: Executor, orgId: string, agentId: string) {
  const [row] = await db
    .select({ builtin: agents.builtin })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  return isRightHand(row);
}

/** Refuses `what` for the right hand: archived, deleted. */
export async function refuseRightHand(db: Executor, orgId: string, agentId: string, what: string) {
  if (await isRightHandId(db, orgId, agentId)) throw rightHandPermanent(what);
}

/**
 * The right hand is in no channel: an @mention in any channel reaches it all the same (ADR 0137), never a DM between
 * people. Read wherever a run needs the agent in the conversation (the mention lookups, `eligibleChannelAgents`).
 */
export const rightHandReaches = (agent: SQL, channelId: SQL) =>
  sql`(${agent}.builtin = ${RIGHT_HAND} and exists (select 1 from ${schema.channels} rhc
    where rhc.id = ${channelId} and rhc.kind = 'channel' and rhc.archived_at is null and rhc.deleted_at is null))`;

/**
 * Its reply before it is posted (ADR 0137 §4): a sign-in or a key in it (`scrubSignIns`) becomes a note in the language
 * of the person behind the run, and the audit log says how many were taken out, never what. On a Codex or Cursor
 * plan a command could read the plan's own sign-in before the runner kills the turn: this is the last line.
 */
export async function scrubRightHandReply(
  db: Executor,
  run: Pick<AgentRun, "orgId" | "id" | "agentId" | "channelId" | "triggerMessageId">,
  text: string,
): Promise<string> {
  if (scrubSignIns(text, "").found === 0) return text;
  const personId = await personBehindCall({
    db,
    orgId: run.orgId,
    runId: run.id,
    triggerMessageId: run.triggerMessageId,
  }).catch(() => null);
  const [person] = personId ? await db.select({ locale: users.locale }).from(users).where(eq(users.id, personId)) : [];
  const out = scrubSignIns(text, serverText(appLocale([person?.locale], true) ?? "en", "chat.body.redacted"));
  await recordAudit(db, {
    orgId: run.orgId,
    actor: { type: "agent", id: run.agentId },
    action: "right_hand.reply_redacted",
    target: { type: "agent", id: run.agentId },
    details: { found: out.found },
    runId: run.id,
    channelId: run.channelId,
    onBehalfOfUserId: personId,
  });
  return out.text;
}

/**
 * Who a run of the right hand reads for (ADR 0137 §13): the person behind it, in their own DM with it. A routine's own
 * run there reads for its creator: only they set what it does (`updateRoutine`), and only they read what it says.
 * Null anywhere else, since others read a reply in a channel, and for any other agent.
 */
export async function rightHandReader(
  ctx: Pick<ToolContext, "orgId" | "agentId" | "channelId" | "runId" | "triggerMessageId"> & { db: Executor },
): Promise<string | null> {
  if (!(await isRightHandId(ctx.db, ctx.orgId, ctx.agentId))) return null;
  const person =
    (await personBehindCall(ctx)) ??
    (ctx.runId ? accountablePerson(await runAuthorityById(ctx.db, ctx.orgId, ctx.runId)) : null);
  return person && (await readsAlone(ctx.db, ctx.channelId, person, ctx.agentId)) ? person : null;
}

/**
 * The one person who reads `channelId`: their own DM with an agent, where nobody else reads a reply. Null where no
 * person or more than one reads, and with `agentId` where another agent is in it too.
 */
export async function soleReader(db: Executor, channelId: string, agentId?: string): Promise<string | null> {
  const members = await db
    .select({ userId: channelMembers.userId, agentId: channelMembers.agentId })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(and(eq(channelMembers.channelId, channelId), eq(channels.kind, "dm")));
  const people = members.filter((m) => m.userId);
  const alone = people.length === 1 && (!agentId || members.every((m) => !m.agentId || m.agentId === agentId));
  return alone ? (people[0]?.userId ?? null) : null;
}

/** Whether `person` is the one person who reads `channelId` (`soleReader`). */
export const readsAlone = async (db: Executor, channelId: string, person: string, agentId?: string) =>
  (await soleReader(db, channelId, agentId)) === person;

/** The right hand anywhere but a person's own DM with it: what only reads or writes for that person stays out. */
export async function rightHandAway(
  ctx: Pick<ToolContext, "orgId" | "agentId" | "channelId" | "runId" | "triggerMessageId"> & { db: Executor },
) {
  return (await isRightHandId(ctx.db, ctx.orgId, ctx.agentId)) && !(await rightHandReader(ctx));
}

/** `rightHandAway` for a caller that holds only the run's id (the Vault): a run that is gone reads as away. */
export async function rightHandAwayRun(db: Executor, run: { orgId: string; agentId: string; runId: string }) {
  if (!(await isRightHandId(db, run.orgId, run.agentId))) return false;
  const [row] = /^[0-9a-f-]{36}$/i.test(run.runId)
    ? await db
        .select({ channelId: schema.agentRuns.channelId, triggerMessageId: schema.agentRuns.triggerMessageId })
        .from(schema.agentRuns)
        .where(and(eq(schema.agentRuns.orgId, run.orgId), eq(schema.agentRuns.id, run.runId)))
    : [];
  return !row || !(await rightHandReader({ db, ...run, ...row }));
}

/** Its computer turns' permission profile: the runner's locked-down `chat` (`LOCKED_BRAIN_PROTOCOL`). */
export const RIGHT_HAND_TURN = { mode: "chat" } as const;

type ThinkingAgent = Pick<Agent, "orgId" | "brainAccountId" | "machineId"> &
  Partial<Pick<Agent, "builtin" | "ownerUserId" | "brain" | "brainModel" | "brainEffort" | "brainAccountLentBy">> &
  Partial<Pick<Agent, "planForOthers" | "brainFallback" | "brainExtraUsage" | "credentialId">>;

/** A person's own AI for the right hand (§11): their row, null when their DM thinks with the workspace's. */
export async function personalBrain(db: Executor, orgId: string, userId: string) {
  const [row] = await db
    .select()
    .from(schema.rightHandBrains)
    .where(and(eq(schema.rightHandBrains.orgId, orgId), eq(schema.rightHandBrains.userId, userId)));
  return row ?? null;
}

/**
 * The plan that thinks for `person` when they chose none and the workspace's AI can't answer them (ADR 0059 §3): a
 * model with no key of the workspace's, or a plan that serves only someone else. A signed-in plan that serves them:
 * their own first, else the one that serves everyone with the most room left in its tightest window. Null when there is none, or none is needed.
 */
export async function servingPlanFor(
  db: Executor,
  agent: Pick<Agent, "orgId"> & Partial<Pick<Agent, "brain" | "credentialId" | "brainAccountId">>,
  person: string,
) {
  const { providerCredentials, machines } = schema;
  if ((agent.brain ?? "model") === "model") {
    if (agent.credentialId) return null;
    const [key] = await db
      .select({ id: providerCredentials.id })
      .from(providerCredentials)
      .where(and(eq(providerCredentials.orgId, agent.orgId), isNull(providerCredentials.revokedAt)))
      .limit(1);
    if (key) return null;
  } else {
    if (!agent.brainAccountId) return null;
    const [workspace] = await db
      .select({ serves: machineAccounts.serves, ownerId: machineAccounts.createdBy })
      .from(machineAccounts)
      .where(and(eq(machineAccounts.orgId, agent.orgId), eq(machineAccounts.id, agent.brainAccountId)));
    if (!workspace || workspace.serves === "everyone" || workspace.ownerId === person) return null;
  }
  const rows = await db
    .select({
      id: machineAccounts.id,
      kind: machineAccounts.kind,
      usage: machineAccounts.usage,
      ownerId: machineAccounts.createdBy,
    })
    .from(machineAccounts)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, machineAccounts.orgId),
        eq(organizationMembers.userId, machineAccounts.createdBy),
      ),
    )
    .innerJoin(
      machines,
      and(
        eq(machines.orgId, machineAccounts.orgId),
        eq(machines.id, machineAccounts.machineId),
        isNull(machines.deletedAt),
      ),
    )
    .where(
      and(
        eq(machineAccounts.orgId, agent.orgId),
        eq(machineAccounts.status, "active"),
        sql`(${machineAccounts.serves} = 'everyone' or ${machineAccounts.createdBy} = ${person})`,
        // A login made for one agent thinks for that one only (as `setPersonalBrain` keeps it).
        sql`(${machineAccounts.shared} or not exists (select 1 from ${agents} where ${agents.orgId} = ${machineAccounts.orgId} and ${agents.brainAccountId} = ${machineAccounts.id} and ${agents.archivedAt} is null and ${agents.builtin} is distinct from ${RIGHT_HAND}))`,
      ),
    )
    .orderBy(machineAccounts.createdAt);
  const { planRoom } = await import("./machine-accounts");
  const now = Date.now();
  // Their own plan first, then the one with the most room.
  const [best] = rows
    .map((r) => ({ ...r, mine: r.ownerId === person, room: planRoom(r.usage as Parameters<typeof planRoom>[0], now) }))
    .sort((a, b) => Number(b.mine) - Number(a.mine) || b.room - a.room);
  return best
    ? { brain: best.kind, brainModel: AUTO_MODEL, brainEffort: null, brainAccountId: best.id, brainAccountLentBy: null }
    : null;
}

/**
 * The model a person's own AI thinks with: theirs, else the right hand's when it is saved for that same brain (a model
 * saved for one brain means nothing to another, and the API brain's `auto` would pick tiers on their plan).
 */
export function personalModel(
  own: { brain: string; brainModel: string | null },
  agent: { brain?: string | null; brainModel?: string | null },
): string | null {
  return own.brainModel ?? (own.brain === agent.brain ? (agent.brainModel ?? null) : null);
}

/**
 * The right hand with `person`'s own AI (§11) in place of the workspace's brain, when they chose one, else a plan that
 * serves them while the workspace's AI can't think (`servingPlanFor`).
 */
export async function withPersonalBrain<T extends ThinkingAgent>(
  db: Executor,
  agent: T,
  person: string | null | undefined,
): Promise<{ agent: T; own: boolean }> {
  const own =
    person && isRightHand(agent)
      ? ((await personalBrain(db, agent.orgId, person)) ?? (await servingPlanFor(db, agent, person)))
      : null;
  if (!own) return { agent, own: false };
  return {
    agent: {
      ...agent,
      brain: own.brain,
      brainModel: personalModel(own, agent),
      brainEffort: own.brainEffort,
      brainAccountId: own.brainAccountId,
      brainAccountLentBy: own.brainAccountLentBy,
      brainFallback: false,
      brainExtraUsage: false,
    },
    own: true,
  };
}

/**
 * An agent as its brain sees it. The right hand is on no computer and its owner is the workspace's (`followOwner`):
 * on a plan it thinks on the computer where that plan's account is signed in, and the plan is its owner's (who pays,
 * as for any agent, ADR 0059 §3). With no account it has no computer. `person`: whose DM the run answers; their own
 * AI (§11) thinks for them in place of the workspace's. A plan thinks for someone else's DM (`planForOthers`) while it
 * serves everyone in the workspace (`machine_accounts.serves`). Every other agent is itself.
 */
export async function thinkingAgent<T extends ThinkingAgent>(
  db: Executor,
  agent: T,
  person?: string | null,
): Promise<T> {
  if (!isRightHand(agent)) return agent;
  const { agent: base, own } = await withPersonalBrain(db, agent, person);
  const [plan] = base.brainAccountId
    ? await db
        .select({
          machineId: machineAccounts.machineId,
          ownerId: machineAccounts.createdBy,
          serves: machineAccounts.serves,
        })
        .from(machineAccounts)
        .where(and(eq(machineAccounts.orgId, agent.orgId), eq(machineAccounts.id, base.brainAccountId)))
    : [];
  const ownerUserId = plan?.ownerId ?? null;
  const everyone = plan?.serves === "everyone";
  return {
    ...base,
    machineId: plan?.machineId ?? null,
    ownerUserId,
    ...(own ? { planForOthers: everyone || ownerUserId === person } : plan ? { planForOthers: everyone } : {}),
  };
}

/** Those of `people` still in the workspace, each once, in the order given. */
export async function membersAmong(db: Executor, orgId: string, people: readonly (string | null | undefined)[]) {
  const named = [...new Set(people.filter((p): p is string => !!p))];
  if (named.length === 0) return named;
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, named)));
  const members = new Set(rows.map((r) => r.userId));
  return named.filter((p) => members.has(p));
}

/**
 * Whose AI work nobody is behind thinks with (§11) where nothing can tell whose AI can think now (`rightHandWorkAi`
 * does, when the work fires): of the people who set it up still in the workspace, the first who chose their own AI,
 * else the first of them (the workspace's AI then answers them as it would in their DM), else nobody.
 */
export async function ownAiPerson(db: Executor, orgId: string, people: readonly (string | null | undefined)[]) {
  const named = await membersAmong(db, orgId, people);
  for (const person of named) if (await personalBrain(db, orgId, person)) return person;
  return named[0] ?? null;
}

/**
 * The person a right hand's run thinks for: who is behind it, else for a run a routine started or its report woke,
 * whoever that firing picked (`RoutineBrief.aiUserId`: of who set the work up, the first whose AI could think). A
 * brief with no pick: its widget's creator, then the routine's (`ownAiPerson`). Null: the workspace's AI, for nobody.
 */
async function thinksFor(db: Executor, run: Pick<AgentRun, "orgId" | "id" | "triggerMessageId">) {
  const authority = await runAuthorityById(db, run.orgId, run.id);
  if (authority.personId) return authority.personId;
  // A run with no row yet reads as an agent's: the person behind its message, as `personBehindCall` says it.
  if (authority.kind === "unattended" && authority.reason === "agent")
    return run.triggerMessageId ? personOfMessage(db, run.orgId, run.triggerMessageId) : null;
  const brief = authority.kind !== "person" && fedByRoutine(authority) ? authority.brief : null;
  if (!brief) return null;
  if (brief.aiUserId !== undefined) return brief.aiUserId;
  const [widget] = brief.widget
    ? await db
        .select({ creator: schema.dashboardWidgets.createdByUserId })
        .from(schema.dashboardWidgets)
        .where(and(eq(schema.dashboardWidgets.orgId, run.orgId), eq(schema.dashboardWidgets.id, brief.widget.widgetId)))
    : [];
  return ownAiPerson(db, run.orgId, [widget?.creator, brief.creatorUserId]);
}

/** The person whose own AI a right hand's run thinks with (`thinkingAgent`, `thinksFor`); null for any other agent's run. */
export async function rightHandPerson(
  db: Executor,
  agent: { builtin?: string | null },
  run: Pick<AgentRun, "orgId" | "id" | "triggerMessageId">,
): Promise<string | null> {
  if (!isRightHand(agent)) return null;
  return thinksFor(db, run).catch(() => null);
}

/**
 * Why its turn can't think on the plan now, beyond what any computer brain checks (null: it can): a runner that
 * can't lock the CLI down, or while "Atende outras pessoas" is off someone else's DM (`plan_not_shared`: their own
 * plan answers them) or a run nobody is behind (`plan_unattended`: no person's plan can answer it). `agent` is
 * `thinkingAgent`'s.
 */
export async function rightHandPlanRefusal(
  db: Executor,
  agent: Pick<Agent, "name" | "ownerUserId" | "planForOthers">,
  run: Pick<AgentRun, "orgId" | "id" | "triggerMessageId">,
  status: Pick<MachineStatus, "name" | "protocol" | "kind" | "executors"> | null,
): Promise<BrainUnavailability | null> {
  if (!agent.planForOthers) {
    const person = await thinksFor(db, run);
    if (!person) {
      return {
        code: "plan_unattended",
        message: `${agent.name} thinks with a plan that answers only its owner, and no person asked for this.`,
      };
    }
    if (person !== agent.ownerUserId) {
      return { code: "plan_not_shared", message: `${agent.name} thinks with a plan that answers only its owner.` };
    }
  }
  if (status && status.protocol < LOCKED_BRAIN_PROTOCOL) {
    return {
      code: "runner_outdated",
      message: `The runner on ${status.name} is too old for ${agent.name} to think there. ${runnerUpdateWay(status)}`,
    };
  }
  return null;
}

/**
 * The line its DM shows when its plan can't think (ADR 0137 §7): it never falls back to an API key, nor waits with a
 * spinner. Its computer asleep or paused, the plan at its limit (or only its model's, the region that model needs, or
 * that model switched off for the key: `scope`), a plan that answers only its owner (to someone else, or to a run no
 * person asked for), a program to update or turned off there, the plan's CLI not installed, or what any agent says.
 */
export function rightHandNoAiReason(code: string, scope?: ModelScope): NoAiCardReason {
  if (code === "machine_offline" || code === "machine_paused") return "computer_away";
  if (code === "plan_limit")
    return scope === "region"
      ? "model_region"
      : scope === "inactive"
        ? "plan_inactive"
        : scope === "off"
          ? "model_off"
          : scope === "model"
            ? "model_limit"
            : "plan_limit";
  if (code === "plan_not_shared" || code === "plan_not_owner") return "plan_not_shared";
  if (code === "plan_unattended") return "plan_unattended";
  if (code === "runner_outdated" || code === "codex_too_old") return "runner_outdated";
  if (code === "exec_disabled" || code === "tool_off") return "commands_off";
  if (code === "tools_not_locked") return "plan_tools";
  if (code === "no_computer" || code === "no_session") return "no_computer";
  if (code === "not_logged_in") return "not_signed_in";
  if (code === "cli_missing" || code.endsWith("_missing")) return "cli_missing";
  // Only a failure that may pass is left (a retryable one): its card offers "Responder agora" once it can think. The
  // plan's CLI failing is its own, not its computer's.
  return isCliFailure(code) ? "cli_failed" : "computer_failed";
}
