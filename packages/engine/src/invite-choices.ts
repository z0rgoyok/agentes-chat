import { and, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { answersOthers, audienceChanged, audienceOf, canTalkTo, speakerOf } from "./audience";
import { isComputerBrain } from "./brains/types";
import { caches } from "./cache";
import { ValidationError } from "./errors";
import { can, getMembership, type Membership } from "./organizations";
import { SIDEBAR_PIN_LIMIT, sidebarViewOf } from "./sidebar-items";
import { foreignMailboxes } from "./tools/scopes";

const { agents, channels, channelMembers, organizationMembers } = schema;

/**
 * At most this many channels, and as many agents, go with one invitation or link (ADR 0184): checked for whoever gives
 * them when it is sent or made, and again when someone joins through it.
 */
export const INVITE_CHOICES_MAX = 20;

const DAY_MS = 86_400_000;
/** "Validade": how long a link made with choices works, from when it is made or edited. */
export const INVITE_LINK_TTLS = {
  "30m": 30 * 60_000,
  "1h": 3_600_000,
  "1d": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  never: null,
} as const;
export type InviteLinkTtl = keyof typeof INVITE_LINK_TTLS;
export const INVITE_LINK_TTL_KEYS = Object.keys(INVITE_LINK_TTLS) as InviteLinkTtl[];
/** "Máximo de pessoas": the approvals a link takes. Null: no limit. */
export const INVITE_LINK_MAX_USES = [1, 5, 10, 25, 50, 100] as const;
/** "Não expira": a date far enough that every `expires_at > now` check still holds. */
export const INVITE_LINK_NEVER = new Date("9999-12-31T00:00:00.000Z");

export const neverExpires = (expiresAt: Date) => expiresAt.getTime() >= INVITE_LINK_NEVER.getTime();

/** When a link with `ttl` stops working, counted from `now`. */
export function linkExpiry(ttl: string, now: Date): Date {
  if (!Object.hasOwn(INVITE_LINK_TTLS, ttl)) {
    throw new ValidationError(
      "A link works for 30 minutes, 1 hour, 1, 7 or 30 days, or never ends",
      "invite_link.choice",
    );
  }
  const ms = INVITE_LINK_TTLS[ttl as InviteLinkTtl];
  return ms === null ? INVITE_LINK_NEVER : new Date(now.getTime() + ms);
}

/** A link's maximum as given: one of `INVITE_LINK_MAX_USES`, or null for no limit. */
export function linkMaxUses(max: number | null): number | null {
  if (max === null || (INVITE_LINK_MAX_USES as readonly number[]).includes(max)) return max;
  throw new ValidationError("A link takes 1, 5, 10, 25, 50 or 100 people, or no limit", "invite_link.choice");
}

/**
 * A link that took all the people it may (`max_uses`): asking (`join.link_full`) and approving
 * (`join.link_full_approval`) through it are refused.
 */
export const inviteLinkFull = (link: { maxUses: number | null; uses: number }) =>
  link.maxUses !== null && link.uses >= link.maxUses;

const unique = (ids: readonly string[]) => [...new Set(ids)];

type ChannelWhy = "archived" | "left" | "gone";

/**
 * Each channel's verdict for someone giving it, in `ids`' order: null when it may go with an invitation, else why not.
 * One of the workspace's channels (not a conversation, not deleted), not archived, and public, one they are in, or a
 * private one limited to one of `roleIds` (whoever gets that cargo may see and join it anyway, ADR 0125).
 */
async function channelVerdicts(
  db: Executor,
  giverId: string | null,
  orgId: string,
  ids: readonly string[],
  roleIds: readonly string[],
) {
  const wanted = unique(ids);
  if (wanted.length === 0) return [];
  // The giver's own row in each channel, joined: a subquery in a single-table select names its columns bare.
  const rows = await db
    .select({
      id: channels.id,
      name: channels.name,
      kind: channels.kind,
      visibility: channels.visibility,
      audienceRoleIds: channels.audienceRoleIds,
      archivedAt: channels.archivedAt,
      deletedAt: channels.deletedAt,
      member: channelMembers.userId,
    })
    .from(channels)
    .leftJoin(channelMembers, and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, giverId ?? "")))
    .where(and(eq(channels.orgId, orgId), inArray(channels.id, wanted)));
  return wanted.map((id) => {
    const c = rows.find((r) => r.id === id);
    const why: ChannelWhy | null =
      c?.kind !== "channel" || c.deletedAt
        ? "gone"
        : c.archivedAt
          ? "archived"
          : c.visibility === "public" || c.member !== null || c.audienceRoleIds.some((r) => roleIds.includes(r))
            ? null
            : "left";
    return { id, name: c && why !== "gone" ? c.name : null, why };
  });
}

/**
 * The channels an invitation adds someone to, besides `general` (ADR 0090, 0184), checked for whoever sends it: any
 * other id refuses it all (`invitation.channel`, naming the channel and `why`: `archived`, `left` or `gone`).
 * `roleIds`: the cargos it gives, whose own private channels may go with it.
 */
export async function invitableChannelIds(
  db: Executor,
  actorId: string,
  orgId: string,
  ids: readonly string[],
  roleIds: readonly string[] = [],
) {
  const verdicts = await channelVerdicts(db, actorId, orgId, ids, roleIds);
  const refused = verdicts.find((v) => v.why !== null);
  if (refused) {
    throw new ValidationError("One of these channels can't go with an invitation", "invitation.channel", {
      channelId: refused.id,
      name: refused.name,
      why: refused.why,
    });
  }
  return verdicts.map((v) => v.id);
}

/** The ones among `ids` that `giverId` may still give, the others left out (`invitableChannelIds`, never refusing). */
export async function stillInvitableChannelIds(
  db: Executor,
  giverId: string | null,
  orgId: string,
  ids: readonly string[],
  roleIds: readonly string[],
) {
  return (await channelVerdicts(db, giverId, orgId, ids, roleIds)).filter((v) => v.why === null).map((v) => v.id);
}

/** Adds the person to these channels, in the caller's transaction (ids checked by the caller). */
export async function joinChannels(tx: Executor, orgId: string, userId: string, channelIds: readonly string[]) {
  for (const channelId of channelIds) {
    await tx.insert(channelMembers).values({ orgId, channelId, userId }).onConflictDoNothing();
  }
}

type AgentRow = typeof agents.$inferSelect;

/** It thinks with a plan kept for its owner (ADR 0059 §5): nobody else may be let in but by its owner's own switch. */
const keepsPlan = (a: AgentRow) =>
  isComputerBrain(a.brain) && !answersOthers({ ...audienceOf(a), consultable: false }, a.ownerUserId);

/**
 * Whether an invitation from `giver` may start someone with `a` (ADR 0184): it talks to everyone, it is limited to one
 * of `roleIds`, or `giver` may let one more person in (its owner, or who manages agents) and doing so takes nothing:
 * no plan kept for its owner, no mailbox someone else gave it. A mailbox is never taken unasked, days later, at accept.
 */
async function agentOk(
  db: Executor,
  orgId: string,
  giver: Membership | null,
  giverId: string | null,
  a: AgentRow,
  roleIds: readonly string[],
) {
  if (a.audienceMode === "everyone") return true;
  if (a.audienceMode === "people" && a.audienceRoleIds.some((r) => roleIds.includes(r))) return true;
  if (!giver || !(can(giver, "manage_agents") || (a.ownerUserId !== null && a.ownerUserId === giverId))) return false;
  if (keepsPlan(a)) return false;
  return (await foreignMailboxes(db, orgId, a.id, giverId)).length === 0;
}

/** The workspace's agents among `ids` that an invitation may name: still there, never the right hand (everyone has it). */
async function namedAgents(db: Executor, orgId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), inArray(agents.id, unique(ids))));
}

/**
 * The agents an invitation or a link starts someone with (ADR 0184), checked for whoever sends it, in `ids`' order:
 * `agentOk` for each. The right hand is left out quietly: everyone has it. Any other refuses it all
 * (`invitation.agent`, naming the agent and `why`: `gone`, or `locked` for one they may not open to someone new).
 */
export async function invitableAgentIds(
  db: Executor,
  actor: Membership,
  actorId: string,
  orgId: string,
  ids: readonly string[],
  roleIds: readonly string[] = [],
) {
  const rows = await namedAgents(db, orgId, ids);
  const out: string[] = [];
  for (const id of unique(ids)) {
    const a = rows.find((r) => r.id === id);
    if (a?.builtin) continue;
    const why = !a || a.archivedAt ? "gone" : (await agentOk(db, orgId, actor, actorId, a, roleIds)) ? null : "locked";
    if (why) {
      throw new ValidationError("One of these agents can't go with an invitation", "invitation.agent", {
        agentId: id,
        name: a?.name ?? null,
        why,
      });
    }
    out.push(id);
  }
  return out;
}

/** The ones among `ids` that `giverId` may still start someone with, the others left out (never refusing). */
export async function stillInvitableAgentIds(
  db: Executor,
  giverId: string | null,
  orgId: string,
  ids: readonly string[],
  roleIds: readonly string[],
) {
  const giver = giverId ? await getMembership(db, giverId, orgId) : null;
  const rows = await namedAgents(db, orgId, ids);
  const out: string[] = [];
  for (const id of unique(ids)) {
    const a = rows.find((r) => r.id === id);
    if (a && !a.builtin && !a.archivedAt && (await agentOk(db, orgId, giver, giverId, a, roleIds))) out.push(id);
  }
  return out;
}

/**
 * Someone who just joined starts with the agents an invitation or a link named (ADR 0184), in the joining transaction:
 * each one still there that they can't talk to yet, and that `giverId` may still open for them as `agentOk` says, takes
 * them into its audience (audited `agent.audience_changed` with `via: "invitation"`, its plan's owner told as for any
 * change). Then the ones they can talk to become their sidebar's pinned agents (at most `SIDEBAR_PIN_LIMIT`), only
 * while they have no sidebar view of their own yet. Returns the agents whose audience changed, for the caller to
 * announce once the transaction commits (`forgetStarted`).
 */
export async function startWith(
  tx: Executor,
  input: { orgId: string; userId: string; giverId: string | null; agentIds: readonly string[] },
) {
  const { orgId, userId, giverId } = input;
  const rows = await namedAgents(tx, orgId, input.agentIds);
  if (rows.length === 0) return [];
  const giver = giverId ? await getMembership(tx, giverId, orgId) : null;
  const speaker = speakerOf(await getMembership(tx, userId, orgId));
  const opened: string[] = [];
  const pinned: string[] = [];
  for (const id of unique(input.agentIds)) {
    let a = rows.find((r) => r.id === id);
    if (!a || a.builtin || a.archivedAt) continue;
    if (!canTalkTo(a, userId, { ...speaker, talks: true })) {
      if (!giverId || !(await agentOk(tx, orgId, giver, giverId, a, speaker.roleIds))) continue;
      const before = audienceOf(a);
      const [saved] = await tx
        .update(agents)
        .set({
          audienceMode: "people",
          audienceUserIds: unique([...(before.mode === "people" ? before.userIds : []), userId]),
          audienceRoleIds: before.mode === "people" ? before.roleIds : [],
          updatedAt: new Date(),
        })
        .where(and(eq(agents.orgId, orgId), eq(agents.id, a.id)))
        .returning();
      if (!saved) continue;
      await audienceChanged(tx, orgId, giverId, saved, before, audienceOf(saved), before, "invitation");
      opened.push(a.id);
      a = saved;
    }
    if (canTalkTo(a, userId, speaker)) pinned.push(a.id);
  }
  if (pinned.length > 0) {
    const items = organizationMembers.sidebarItems;
    const view = {
      ...sidebarViewOf(null),
      pins: { agents: pinned.slice(0, SIDEBAR_PIN_LIMIT), channels: [], people: [] },
    };
    await tx
      .update(organizationMembers)
      .set({ sidebarItems: sql`${items} || jsonb_build_object('view', ${JSON.stringify(view)}::jsonb)` })
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
          isNull(sql`${items} -> 'view'`),
        ),
      );
  }
  return opened;
}

/** Agents whose audience `startWith` changed: their cached rows go once its transaction committed. */
export function forgetStarted(orgId: string, agentIds: readonly string[]) {
  for (const id of agentIds) caches.agents.delete(`${orgId}:${id}`);
  if (agentIds.length > 0) caches.agents.delete(`${orgId}:team`);
}
