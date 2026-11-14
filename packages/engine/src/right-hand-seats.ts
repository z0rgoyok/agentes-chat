import type { AgentScope } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, isNotNull, isNull, schema, sql } from "@agenteschat/db";
import { getAgentCached, workspaceHomeId } from "./agents";
import { fedByRoutine, runAuthorityById, UUID } from "./authority";
import { BROWSER_SCOPE, DESKTOP_SCOPE } from "./browser/types";
import type { MachineCaller } from "./machine-hub";
import { personBehindCall } from "./requester";
import { isRightHand, isRightHandId, RIGHT_HAND, soleReader } from "./right-hand";
import { SANDBOX_SCOPE } from "./sandbox-scope";
import { grantedScopeKeys, grantKey } from "./tools/scopes";
import type { ToolContext } from "./tools/types";

const { agents, organizationMembers, rightHandSeats, users } = schema;

/**
 * The right hand's computer (ADR 0175). One agents row answers everyone, so on the workspace's own computer each
 * person has a seat: a stored random id the computer takes for an agent's, which gives that person's right hand its
 * own OS user, home, browser profile and sign-ins there. Where others read what it does (a channel, a widget, a
 * routine that reports outside its creator's own conversation) it works in one more seat, the workspace's shared one,
 * with an id, a user and a home of its own. A run nobody asked for in a person's own conversation has neither
 * (`runSeat`). The agent's own id never goes to a computer for anything but its locked
 * chat turn (the hub refuses it), so a request built without a seat fails instead of landing every member in one home.
 */

/**
 * Whose seat the shared one is, where a seat's person is kept (`right_hand_seats.user_id`, a run's seat): no
 * person's id is this, and no membership matches it, so nothing that looks a person's seat up can answer with it.
 */
export const SHARED_SEAT = "shared";

/** Whose seat a person's own request reaches: their own, or with `shared` the workspace's shared one. */
export const viewerSeat = (viewer: { userId: string; shared?: boolean }) =>
  viewer.shared ? SHARED_SEAT : viewer.userId;

/** The person a seat's owner is, for what is kept per person (a handoff's `seat_user_id`): null for the shared one. */
export const seatUserOf = (owner: string | null | false | undefined): string | null =>
  owner && owner !== SHARED_SEAT ? owner : null;

/**
 * Loaded on first use: both modules import this one, and a static import back would
 * run their importers before they have finished loading.
 */
const machines = () => import("./machines");
const sandbox = () => import("./sandbox");

/** A call with no place on the workspace's computer: no conversation behind it, or a person who is not a member. */
export const NO_SEAT_MESSAGE =
  "You have no computer for this: the person behind it is not a member of this workspace, or the call belongs to no conversation. Hand this to an agent that has a computer (ask_agent, tell_agent, or create_issue assigned to it), and never ask the person to try again here.";

/**
 * A run whose work one person alone reads and that this person did not ask for (`runSeat`): a routine's, or one an
 * event or another agent woke in their own conversation.
 */
export const UNASKED_SEAT_MESSAGE =
  "You have no computer for this: a person's place on the computer is used only for what that person asks you themselves in their private conversation with you, and nobody asked for this run (a routine's, or one an event or another agent woke). Hand the work to an agent that has a computer (ask_agent, tell_agent, or create_issue assigned to it), or say what is waiting so the person can ask you for it in that conversation.";

/** Why a run has no seat, as it reads it: nobody asked for it where one person alone reads, or it has no conversation. */
export const noSeatMessage = (ctx: { channelId?: string }) => (ctx.channelId ? UNASKED_SEAT_MESSAGE : NO_SEAT_MESSAGE);

/** The workspace has no computer of its own connected: the right hand has none either. */
export const NO_HOME_MESSAGE =
  "You have no computer here: this workspace has no computer of its own connected. An admin connects one in Settings, under Computers: say so. Until then hand this to an agent that has a computer (ask_agent, tell_agent, or create_issue assigned to it) when one does, and never ask the person to try again.";

/** Another computer of the workspace (one a person brought, a phone's host): the right hand has no seat there. */
export const notHomeMessage = (computer: string) =>
  `You have no place of your own on ${computer}: your computer is the workspace's own. Do it there, or hand this to an agent that uses ${computer} (ask_agent, tell_agent, or create_issue assigned to it).`;

/** A computer where every agent works as the same OS user can't keep people's seats apart. */
export const notSystemMessage = (computer: string) =>
  `You have no computer on ${computer}: it runs every agent as one user, so it can't keep each person's files and sign-ins apart. Hand this to an agent that has a computer (ask_agent, tell_agent, or create_issue assigned to it), and never ask the person to try again.`;

/**
 * A new seat's id. The computer names an OS user from an id's first 8 letters and digits and never frees one, so the
 * id starts like no agent's and no seat's there has, gone ones included: a clash would leave the person with no seat.
 */
async function newSeatId(db: Executor): Promise<string> {
  for (let tries = 0; tries < 8; tries++) {
    const id = crypto.randomUUID();
    const starts = (table: typeof agents | typeof rightHandSeats) =>
      db
        .select({ id: table.id })
        .from(table)
        .where(sql`left(${table.id}::text, 8) = ${id.slice(0, 8)}`)
        .limit(1);
    if ((await starts(agents)).length + (await starts(rightHandSeats)).length === 0) return id;
  }
  throw new Error("No free id for a seat");
}

/** A seat that is still someone's: a member's, or the workspace's shared one. */
const seatKept = sql`(${organizationMembers.userId} is not null or ${rightHandSeats.userId} = ${SHARED_SEAT})`;
const seatMember = and(
  eq(organizationMembers.orgId, rightHandSeats.orgId),
  eq(organizationMembers.userId, rightHandSeats.userId),
);

/**
 * `userId`'s live seat in the workspace, or with `SHARED_SEAT` the workspace's shared one, made on first use; null
 * for someone who isn't a member, and with `make` off for a seat that doesn't exist yet. One live row per owner: the
 * table's unique index keeps two first uses at once to one seat.
 */
export async function seatOf(
  db: Executor,
  orgId: string,
  userId: string,
  make = true,
): Promise<{ id: string; made: boolean } | null> {
  const live = () =>
    db
      .select({ id: rightHandSeats.id })
      .from(rightHandSeats)
      .leftJoin(organizationMembers, seatMember)
      .where(
        and(
          eq(rightHandSeats.orgId, orgId),
          eq(rightHandSeats.userId, userId),
          isNull(rightHandSeats.removedAt),
          seatKept,
        ),
      );
  const [had] = await live();
  if (had) return { id: had.id, made: false };
  if (!make) return null;
  const id = await newSeatId(db);
  await db.execute(
    userId === SHARED_SEAT
      ? sql`insert into ${rightHandSeats} (id, org_id, user_id) values (${id}::uuid, ${orgId}::uuid, ${SHARED_SEAT})
          on conflict do nothing`
      : sql`insert into ${rightHandSeats} (id, org_id, user_id)
          select ${id}::uuid, om.org_id, om.user_id from ${organizationMembers} om
          where om.org_id = ${orgId}::uuid and om.user_id = ${userId}
          on conflict do nothing`,
  );
  const [made] = await live();
  // Another first use made it meanwhile: this one found it, and only the one that made it tells the computers.
  return made ? { id: made.id, made: made.id === id } : null;
}

/**
 * A seat is gone: a person's with their membership, the shared one (`SHARED_SEAT`) with the workspace's computer or
 * with every computer grant of the right hand. The computer hears its id is deleted, and the next use starts anew.
 */
export async function removeSeat(db: Executor, orgId: string, userId: string) {
  await db
    .update(rightHandSeats)
    .set({ removedAt: new Date() })
    .where(and(eq(rightHandSeats.orgId, orgId), eq(rightHandSeats.userId, userId), isNull(rightHandSeats.removedAt)));
}

/**
 * The live seats of the workspace: its members', with each person's name and language for the computer's own lists,
 * and the shared one, which has neither.
 */
export async function liveSeats(db: Executor, orgId: string) {
  return db
    .select({ id: rightHandSeats.id, userId: rightHandSeats.userId, person: users.name, locale: users.locale })
    .from(rightHandSeats)
    .leftJoin(organizationMembers, seatMember)
    .leftJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(rightHandSeats.orgId, orgId), isNull(rightHandSeats.removedAt), seatKept))
    .orderBy(rightHandSeats.createdAt);
}

/**
 * Seats that are gone, the latest first: removed ones, and a person's whose membership is gone whatever removed it.
 * The shared seat has no membership to lose: only its removal ends it.
 */
export async function removedSeatIds(db: Executor, orgId: string, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: rightHandSeats.id })
    .from(rightHandSeats)
    .where(
      and(
        eq(rightHandSeats.orgId, orgId),
        sql`(${isNotNull(rightHandSeats.removedAt)} or (${rightHandSeats.userId} <> ${SHARED_SEAT}
          and not exists (select 1 from ${organizationMembers} om
            where om.org_id = ${rightHandSeats.orgId} and om.user_id = ${rightHandSeats.userId})))`,
      ),
    )
    .orderBy(desc(sql`coalesce(${rightHandSeats.removedAt}, ${rightHandSeats.createdAt})`))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** What a computer's own lists call the shared seat beside the right hand's name, where a person's seat has theirs. */
const SHARED_SEAT_LABEL = "shared";

/** A seat's name on a computer (its OS user's description): the right hand's, and whose seat it is. */
export const seatName = (agentName: string, seat: { userId: string; person: string | null }) => {
  const whose = seat.userId === SHARED_SEAT ? SHARED_SEAT_LABEL : seat.person;
  return whose ? `${agentName} (${whose})` : agentName;
};

/** The seat as the computer names it: the right hand's handle, and whose it is in the OS user's description. */
const seatScope = (
  seatId: string,
  agent: { handle: string; name: string },
  seat: { userId: string; person: string | null },
): AgentScope => ({ id: seatId, handle: agent.handle, name: seatName(agent.name, seat) });

/**
 * Every live seat as a request names it, on the workspace's own computer: what stops the right hand's work on a
 * computer (its hold, its workspace's) stops each of them, since nothing there goes by the agent's own id.
 */
export async function seatScopes(
  db: Executor,
  orgId: string,
): Promise<{ machineId: string; agents: AgentScope[] } | null> {
  const machineId = await workspaceHomeId(db, orgId);
  const [rightHand] = machineId
    ? await db
        .select({ handle: agents.handle, name: agents.name })
        .from(agents)
        .where(and(eq(agents.orgId, orgId), eq(agents.builtin, RIGHT_HAND)))
    : [];
  if (!machineId || !rightHand) return null;
  return { machineId, agents: (await liveSeats(db, orgId)).map((s) => seatScope(s.id, rightHand, s)) };
}

/** Whether a seat is still there: not removed, and a person's while they are still a member. */
export async function seatLive(db: Executor, seatId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: rightHandSeats.id })
    .from(rightHandSeats)
    .leftJoin(organizationMembers, seatMember)
    .where(and(eq(rightHandSeats.id, seatId), isNull(rightHandSeats.removedAt), seatKept));
  return Boolean(row);
}

/** A computer as a seat's rules read it. */
type SeatMachine = { id: string; orgId: string; name: string; system: boolean };

/**
 * Why the right hand has no seat: the workspace has no computer of its own (`no_home`), this one isn't it
 * (`not_home`), it runs every agent as one user (`not_system`), or the person isn't a member (`no_seat`).
 */
export type SeatRefusal = "no_home" | "not_home" | "not_system" | "no_seat";

/**
 * `userId`'s seat (or with `SHARED_SEAT` the shared one) on `machine` as a request's agent, or why there is none. The
 * one place a seat is given: only on the workspace's own computer, and only where each agent is its own OS user.
 * `told`: tells the workspace's computers of a seat just made, which they list like an agent (its containers, its
 * desktop kept), before its first request. `make` off (reading a screen's state): a seat that doesn't exist yet is
 * not made, and its scope is null.
 */
async function seatOn(
  db: Executor,
  agent: { orgId: string; handle: string; name: string },
  userId: string,
  machine: SeatMachine | null,
  told?: (orgId: string) => Promise<void>,
  make = true,
): Promise<{ ok: true; scope: AgentScope | null } | { ok: false; reason: SeatRefusal; message: string }> {
  const home = await workspaceHomeId(db, agent.orgId);
  if (!home || !machine || machine.orgId !== agent.orgId) {
    return { ok: false, reason: "no_home", message: NO_HOME_MESSAGE };
  }
  if (machine.id !== home) return { ok: false, reason: "not_home", message: notHomeMessage(machine.name) };
  if (!machine.system) return { ok: false, reason: "not_system", message: notSystemMessage(machine.name) };
  const seat = await seatOf(db, agent.orgId, userId, make);
  if (!seat) return make ? { ok: false, reason: "no_seat", message: NO_SEAT_MESSAGE } : { ok: true, scope: null };
  if (seat.made) await told?.(agent.orgId);
  const [person] =
    userId === SHARED_SEAT ? [] : await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return { ok: true, scope: seatScope(seat.id, agent, { userId, person: person?.name ?? null }) };
}

/** A run of the right hand as its seat is chosen from it. */
type SeatRun = Pick<ToolContext, "orgId" | "agentId" | "channelId" | "runId" | "triggerMessageId"> & { db: Executor };

/**
 * Whose seat a run of the right hand works in: a person's user id, `SHARED_SEAT`, or null for none at all. The one
 * place it is decided, from who is behind the run and where its work is read, never from what the model says.
 *
 * - A person's own seat only in their own DM with it, where they alone read, and only when they are the person behind
 *   the run.
 * - No seat where one person alone reads and that person is not behind the run: a run nobody is behind in their DM
 *   (another agent's message, an event from a connected app, a routine's report), and a routine's own run that reports
 *   there. Such a run may carry text from outside, so it gets no hold of that person's files and sign-ins; and its
 *   work is that person's alone, so it does not go where the workspace reads either.
 * - The shared seat everywhere else: a channel and any thread in one, whoever started it, since others read there; a
 *   widget, which others open; a routine that reports where others read.
 *
 * So what one person's seat holds is never worked on where another person reads or by a run they did not ask for, and
 * a run in the shared seat is never given a person's.
 */
export async function runSeat(ctx: SeatRun): Promise<string | null> {
  // Ids the database would refuse are no run's: nobody is behind them, and a failed read fails the call instead of
  // choosing a seat.
  const run = {
    ...ctx,
    runId: UUID.test(ctx.runId ?? "") ? ctx.runId : "",
    triggerMessageId: UUID.test(ctx.triggerMessageId ?? "") ? ctx.triggerMessageId : "",
  };
  const person = await personBehindCall(run);
  const reader = await soleReader(ctx.db, ctx.channelId, ctx.agentId);
  if (reader) return person === reader ? reader : null;
  if (person) return SHARED_SEAT;
  // A routine's own run works in its room, which nobody reads: where it reports decides. The brief counts whether or
  // not its creator is still a member.
  const authority = run.runId ? await runAuthorityById(ctx.db, ctx.orgId, run.runId) : null;
  const brief = authority && authority.kind !== "person" && fedByRoutine(authority) ? authority.brief : null;
  if (brief && !brief.widget && (await soleReader(ctx.db, brief.deliverTo.channelId, ctx.agentId))) return null;
  return SHARED_SEAT;
}

/** The id of the seat a run works in, when it exists (nothing is made): what a row kept for a seat is checked against. */
export async function runSeatId(ctx: SeatRun): Promise<string | null> {
  const owner = await runSeat(ctx);
  return owner ? ((await seatOf(ctx.db, ctx.orgId, owner, false))?.id ?? null) : null;
}

/**
 * What a run of the right hand has of a computer: a person's own `seat`, the workspace's `shared` one, or `none`
 * at all.
 */
export type SeatState = "seat" | "shared" | "none";

/**
 * `SeatState` of a run, for what its prompt says. It makes no seat: the first request does. `none` too while every
 * tool of a computer is off for it (its grants, the workspace's switch for commands): a prompt never names a computer
 * the run can't use.
 */
export async function seatState(
  db: Database,
  run: { orgId: string; agentId: string; channelId: string; id: string; triggerMessageId: string },
): Promise<SeatState> {
  const home = await workspaceHomeId(db, run.orgId);
  const machine = home ? await (await machines()).getMachine(db, run.orgId, home) : null;
  if (machine?.executors?.mode !== "system") return "none";
  const keys = await grantedScopeKeys(db, run.orgId, run.agentId);
  const has = (scope: string) => keys.has(grantKey(null, scope));
  const commands = has(SANDBOX_SCOPE) && (await (await sandbox()).getSandboxSettings(db, run.orgId)).enabled;
  if (!commands && !has(BROWSER_SCOPE) && !has(DESKTOP_SCOPE)) return "none";
  const owner = await runSeat({ db, ...run, runId: run.id });
  return owner === SHARED_SEAT ? "shared" : owner ? "seat" : "none";
}

/**
 * Whose screen a run's tools act on: nobody's in particular for an agent (its screen is one), and for the right hand
 * the owner of the seat the run uses (a person, or `SHARED_SEAT`), or `false` for a run with no seat (`runSeat`) and a
 * call with no conversation, which have no screen at all.
 */
export async function screenPersonOf(
  db: Executor,
  ctx: Pick<ToolContext, "orgId" | "agentId"> & Partial<Pick<ToolContext, "channelId" | "runId" | "triggerMessageId">>,
): Promise<string | null | false> {
  if (!(await isRightHandId(db, ctx.orgId, ctx.agentId))) return null;
  if (!ctx.channelId) return false;
  const owner = await runSeat({
    db,
    orgId: ctx.orgId,
    agentId: ctx.agentId,
    channelId: ctx.channelId,
    runId: ctx.runId ?? "",
    triggerMessageId: ctx.triggerMessageId ?? "",
  });
  // Never null for a run with no seat: null is an ordinary agent's one screen, which the shared seat's rows match.
  return owner ?? false;
}

export type ScopeContext = Pick<ToolContext, "orgId" | "agentId"> &
  Partial<Pick<ToolContext, "channelId" | "runId" | "triggerMessageId">> & { db: Database };

/**
 * The computer an agent's tools act on: its own, or for the right hand, which is on none (ADR 0137 §1), the
 * workspace's own.
 */
export async function toolMachineId(
  db: Executor,
  agent: { orgId: string; machineId: string | null; builtin?: string | null } | null | undefined,
): Promise<string | null> {
  if (!agent) return null;
  return agent.machineId ?? (isRightHand(agent) ? workspaceHomeId(db, agent.orgId) : null);
}

/**
 * The agent a request to `machineId` is for, built from a tool call: the agent itself, or for the right hand the seat
 * its run works in (`runSeat`: a person's own, or the shared one). Throws what the agent reads when the right hand
 * has no seat there: a run with none, a call with no conversation, a computer that isn't the workspace's own or runs
 * every agent as one user.
 */
export async function machineScope(
  hub: Pick<MachineCaller, "status" | "agentsChanged">,
  ctx: ScopeContext,
  machineId: string,
): Promise<AgentScope> {
  const agent = await getAgentCached(ctx.db, ctx.orgId, ctx.agentId);
  if (!isRightHand(agent)) {
    return { id: ctx.agentId, handle: agent?.handle ?? "agent", ...(agent?.name ? { name: agent.name } : {}) };
  }
  const owner =
    agent && ctx.channelId
      ? await runSeat({
          ...ctx,
          channelId: ctx.channelId,
          runId: ctx.runId ?? "",
          triggerMessageId: ctx.triggerMessageId ?? "",
        })
      : null;
  if (!agent || !owner) throw new (await sandbox()).SandboxUnavailableError(noSeatMessage(agent ? ctx : {}));
  const status = await hub.status(machineId);
  const seat = await seatOn(
    ctx.db,
    agent,
    owner,
    status && { id: machineId, orgId: status.orgId, name: status.name, system: status.mode === "system" },
    async (orgId) => hub.agentsChanged?.(orgId),
  );
  if (!seat.ok) throw new (await sandbox()).SandboxUnavailableError(seat.message);
  if (!seat.scope) throw new (await sandbox()).SandboxUnavailableError(NO_SEAT_MESSAGE);
  return seat.scope;
}

/**
 * What the server remembers of an agent's screen is kept under this: the agent, and for the right hand whose seat the
 * run works in too, since each seat is another screen and one must never be compared with another's.
 */
export async function screenKey(
  ctx: Pick<ToolContext, "db" | "orgId" | "agentId" | "channelId" | "runId" | "triggerMessageId">,
) {
  const key = `${ctx.orgId}:${ctx.agentId}`;
  return isRightHand(await getAgentCached(ctx.db, ctx.orgId, ctx.agentId))
    ? `${key}:${(await runSeat(ctx)) ?? "none"}`
    : key;
}

/** A scope's id when it is a seat, for rows that keep which seat their work runs in; null for the agent's own. */
export const seatIdOf = (ctx: { agentId: string }, scope: AgentScope) => (scope.id === ctx.agentId ? null : scope.id);

/**
 * The agent a person's own request reaches on a computer (watching, driving, a terminal, its files): the agent, or
 * for the right hand that person's own seat and no other person's, admins included; with `shared`, the workspace's
 * shared seat, which whoever may reach an agent's computer may (the caller checks that). Everything that opens
 * something of an agent on a computer for a signed-in person goes through here: it takes who asks and never whose
 * seat, so nothing can name another person's. `reason`: why the right hand has no seat for them. `make` off (a
 * screen's state, not opening it): a seat that doesn't exist yet stays unmade, and its scope is null.
 */
export async function viewerScope(
  db: Database,
  orgId: string,
  agentId: string,
  viewerId: string,
  told?: (orgId: string) => Promise<void>,
  make = true,
  shared = false,
): Promise<
  | { machineId: string | null; scope: AgentScope | null; seat: boolean }
  | { reason: SeatRefusal; message: string }
  | null
> {
  const [agent] = await db
    .select({
      orgId: agents.orgId,
      handle: agents.handle,
      name: agents.name,
      machineId: agents.machineId,
      builtin: agents.builtin,
    })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  if (!agent) return null;
  if (!isRightHand(agent)) {
    return { machineId: agent.machineId, scope: { id: agentId, handle: agent.handle, name: agent.name }, seat: false };
  }
  const machineId = await workspaceHomeId(db, orgId);
  const machine = machineId ? await (await machines()).getMachine(db, orgId, machineId) : null;
  const seat = await seatOn(
    db,
    agent,
    shared ? SHARED_SEAT : viewerId,
    machine && {
      id: machine.id,
      orgId: machine.orgId,
      name: machine.name,
      system: machine.executors?.mode === "system",
    },
    told,
    make,
  );
  return seat.ok ? { machineId, scope: seat.scope, seat: true } : { reason: seat.reason, message: seat.message };
}
