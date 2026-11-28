import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, gte, inArray, isNull, schema, sql } from "@agenteschat/db";
import { planBinding } from "@agenteschat/ui/plan-state";
import { type AiStatusDeps, agentAiStates } from "./ai-status";
import { brainOf } from "./brain-settings";
import { storedPlanUsage } from "./brains/select";
import { deliverNotice, publishDelivery } from "./delivery";
import { publishMessageCreated } from "./events";
import { BUDGET_WARNING_RATIO } from "./gateway";
import { platformCapReached } from "./limits";
import { insertMessageWithRuns, messageView } from "./messages";
import { enqueue } from "./outbox";
import { isRightHand } from "./right-hand";
import { standingRefusal } from "./standing";
import { budgetUsedPercent } from "./usage-pause";

/**
 * Joining a channel says so (ADR 0090, "Joining says so"): one line in the conversation for everyone, naming who
 * joined and who added them, and, when exactly one agent joined and there is room, one welcome from an agent already
 * there. The line is a quiet notice (`joined`, `left`): no unread, no notification, no preview, no search. It is
 * written as the first newcomer, so it needs no author of its own.
 */
export const CHANNEL_JOINED_JOB = "channel.joined";

/** How long after a join its line comes: who joins in the same moment (a team, a bulk add) shares it. */
export const JOIN_LINE_DELAY_MS = 5_000;

/** The welcome only with room: a plan or budget this far used gets the line alone, never a model call. */
export const WELCOME_ROOM_PERCENT = Math.round(BUDGET_WARNING_RATIO * 100);

type Member = { type: "person"; id: string } | { type: "agent"; id: string };

/** A member joined `channelId` (`byUserId` added them, or they joined by themselves): its line comes in a moment. */
export async function noteJoined(
  db: Executor,
  orgId: string,
  channelId: string,
  byUserId: string | null,
  now = new Date(),
) {
  // One job per channel and stretch as long as the delay: a later join in the same stretch came before its job runs,
  // so that job's one line names it too.
  await enqueue(db, {
    orgId,
    kind: CHANNEL_JOINED_JOB,
    payload: { channelId, byUserId },
    dedupeKey: `${CHANNEL_JOINED_JOB}:${channelId}:${Math.floor(now.getTime() / JOIN_LINE_DELAY_MS)}`,
    runAt: new Date(now.getTime() + JOIN_LINE_DELAY_MS),
  });
}

/** "Iara", "Iara and Bento", "Iara, Bento and Ada": the line as the agents read it. */
export const englishNames = (names: readonly string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const refsOf = (members: readonly Member[], byUserId: string | null): Record<string, string> => ({
  members: members.map((m) => `${m.type}:${m.id}`).join(","),
  ...(byUserId ? { by: byUserId } : {}),
});

async function namesOf(db: Executor, orgId: string, members: readonly Member[], byUserId: string | null) {
  const people = [...members.filter((m) => m.type === "person").map((m) => m.id), ...(byUserId ? [byUserId] : [])];
  const agentIds = members.filter((m) => m.type === "agent").map((m) => m.id);
  const [users, agents] = await Promise.all([
    people.length === 0
      ? []
      : db
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.users)
          .where(inArray(schema.users.id, people)),
    agentIds.length === 0
      ? []
      : db
          .select({ id: schema.agents.id, name: schema.agents.name })
          .from(schema.agents)
          .where(and(eq(schema.agents.orgId, orgId), inArray(schema.agents.id, agentIds))),
  ]);
  return new Map([...users, ...agents].map((r) => [r.id, r.name] as const));
}

/** Writes the line as its first member (a quiet notice) and shows it. */
async function writeLine(
  deps: { db: Executor; pubsub?: PubSub },
  orgId: string,
  channelId: string,
  kind: "joined" | "left",
  members: readonly Member[],
  byUserId: string | null,
) {
  const first = members[0];
  if (!first) return null;
  const names = await namesOf(deps.db, orgId, members, byUserId);
  const who = englishNames(members.map((m) => names.get(m.id) ?? "someone"));
  // Whoever joined by themselves wasn't added: a line that names them names no adder (the job keeps its first payload).
  const by = byUserId && !members.some((m) => m.type === "person" && m.id === byUserId);
  const text =
    kind === "joined"
      ? `${who} joined this channel${by ? `, added by ${names.get(byUserId) ?? "someone"}` : ""}`
      : `${who} left this channel`;
  const notice = { kind, text, refs: refsOf(members, by ? byUserId : null) };
  const { message } = await insertMessageWithRuns(
    deps.db,
    {
      orgId,
      channelId,
      author:
        first.type === "person"
          ? { type: "person", userId: first.id }
          : { type: "agent", agentId: first.id, runId: null, hop: 0, stretchId: null },
      body: text,
      origin: "system",
      meta: { notice },
    },
    { startRuns: false, deliver: false },
  );
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  return message;
}

/** Someone left `channelId` or was taken out: the line says so at once. */
export async function writeLeftLine(
  deps: { db: Executor; pubsub?: PubSub },
  orgId: string,
  channelId: string,
  member: Member,
) {
  const [channel] = await deps.db
    .select({ kind: schema.channels.kind, archivedAt: schema.channels.archivedAt })
    .from(schema.channels)
    .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, channelId)));
  if (channel?.kind !== "channel" || channel.archivedAt) return;
  await writeLine(deps, orgId, channelId, "left", [member], null);
}

export interface JoinsDeps extends AiStatusDeps {
  db: Database;
  pubsub?: PubSub;
}

/**
 * The job: one line naming everyone who joined `channelId` in the last moments and wasn't said yet, then at most one
 * welcome (`welcomeNewcomer`). A join a line already named is never said again, so a retry writes nothing twice.
 */
export async function announceJoins(deps: JoinsDeps, orgId: string, channelId: string, byUserId: string | null) {
  const { db } = deps;
  const { channelMembers, channels, messages } = schema;
  const [channel] = await db
    .select({ kind: channels.kind, archivedAt: channels.archivedAt })
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.id, channelId)));
  if (channel?.kind !== "channel" || channel.archivedAt) return;
  const since = new Date(Date.now() - 2 * 60_000);
  const [rows, said] = await Promise.all([
    db
      .select({
        founder: sql<boolean>`${channelMembers.userId} = ${channels.createdByUserId}
          and ${channelMembers.createdAt} <= ${channels.createdAt} + interval '1 second'`,
        userId: channelMembers.userId,
        agentId: channelMembers.agentId,
        builtin: schema.agents.builtin,
        createdAt: channelMembers.createdAt,
      })
      .from(channelMembers)
      .innerJoin(channels, eq(channels.id, channelMembers.channelId))
      .leftJoin(schema.agents, eq(schema.agents.id, channelMembers.agentId))
      .where(
        and(
          eq(channelMembers.orgId, orgId),
          eq(channelMembers.channelId, channelId),
          gte(channelMembers.createdAt, since),
          isNull(schema.agents.archivedAt),
        ),
      )
      .orderBy(channelMembers.createdAt),
    db
      .select({ meta: messages.meta })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.channelId, channelId),
          gte(messages.createdAt, new Date(since.getTime() - 60_000)),
          sql`${messages.meta}->'notice'->>'kind' = 'joined'`,
        ),
      ),
  ]);
  const named = new Set(
    said.flatMap((m) =>
      String((m.meta as { notice?: { refs?: { members?: unknown } } } | null)?.notice?.refs?.members ?? "").split(","),
    ),
  );
  const members: Member[] = rows.flatMap((r): Member[] => {
    if (r.agentId && !isRightHand(r)) return named.has(`agent:${r.agentId}`) ? [] : [{ type: "agent", id: r.agentId }];
    // Who made the channel is in it from the start: making it is not joining it.
    if (r.userId && !r.founder) return named.has(`person:${r.userId}`) ? [] : [{ type: "person", id: r.userId }];
    return [];
  });
  if (members.length === 0) return;
  await writeLine(deps, orgId, channelId, "joined", members, byUserId);
  // A welcome for one agent alone: none when another one joined within the minute (a team, a bulk add).
  const [only] = members;
  const lately = rows.filter((r) => r.agentId && !isRightHand(r) && r.createdAt.getTime() > Date.now() - 60_000);
  if (members.length === 1 && only?.type === "agent" && lately.length <= 1)
    await welcomeNewcomer(deps, orgId, channelId, only.id, byUserId);
}

/**
 * One agent already in the channel welcomes the newcomer, in one light turn that may pass: the one whose owner added
 * it, else the last one that spoke there. Only with room (`hasRoomToWelcome`): otherwise the line says it all.
 */
export async function welcomeNewcomer(
  deps: JoinsDeps,
  orgId: string,
  channelId: string,
  newcomerId: string,
  byUserId: string | null,
) {
  const { db } = deps;
  const { agents, channelMembers, messages } = schema;
  const here = await db
    .select({ id: agents.id, ownerUserId: agents.ownerUserId, builtin: agents.builtin, name: agents.name })
    .from(channelMembers)
    .innerJoin(agents, eq(agents.id, channelMembers.agentId))
    .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.channelId, channelId), isNull(agents.archivedAt)));
  const others = here.filter((a) => a.id !== newcomerId && !isRightHand(a));
  if (others.length === 0) return;
  let welcomer = byUserId ? others.find((a) => a.ownerUserId === byUserId) : undefined;
  if (!welcomer) {
    const [last] = await db
      .select({ agentId: messages.authorAgentId })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.channelId, channelId),
          inArray(
            messages.authorAgentId,
            others.map((a) => a.id),
          ),
          sql`${messages.meta}->'notice' is null`,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    welcomer = others.find((a) => a.id === last?.agentId);
  }
  if (!welcomer || !(await hasRoomToWelcome(deps, orgId, welcomer.id))) return;
  const newcomer = here.find((a) => a.id === newcomerId)?.name ?? "A new agent";
  const delivered = await db.transaction((tx) =>
    deliverNotice(tx, {
      orgId,
      agentId: welcomer.id,
      channelId,
      threadId: null,
      hop: 0,
      stretchId: null,
      notice: {
        kind: "member_joined",
        text: `${newcomer} just joined this channel, and you were picked to welcome them`,
        refs: { agentId: newcomerId },
      },
    }),
  );
  await publishDelivery(deps.pubsub, delivered);
}

/**
 * Whether a welcome may spend a model call: the workspace has its plan and no hold, the welcomer has an AI, its plan's
 * busiest window and its budget are under `WELCOME_ROOM_PERCENT`, and the workspace's platform AI isn't used up.
 */
export async function hasRoomToWelcome(deps: JoinsDeps, orgId: string, agentId: string): Promise<boolean> {
  const { db } = deps;
  if (await standingRefusal(db, orgId, agentId)) return false;
  const [agent] = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.id, agentId), isNull(schema.agents.archivedAt)));
  if (!agent) return false;
  const ai = (await agentAiStates(deps, orgId, [agentId])).get(agentId);
  if (ai?.state !== "ready") return false;
  const kind = brainOf(agent.brain);
  if (kind !== "model") {
    const usage = await storedPlanUsage(
      db,
      orgId,
      agent.machineId ?? "",
      kind,
      agent.brainAccountId ?? undefined,
    ).catch(() => null);
    const top = planBinding(usage, { model: null, now: Date.now() });
    if (top && top.used >= WELCOME_ROOM_PERCENT) return false;
  }
  const budget = await budgetUsedPercent(db, agent);
  if (budget.held >= WELCOME_ROOM_PERCENT) return false;
  return !(await platformCapReached(db, orgId));
}
