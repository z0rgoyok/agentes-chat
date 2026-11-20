import { and, type Database, eq, inArray, isNull, like, ne, not, schema } from "@agenteschat/db";
import { getAgent } from "./agents";
import { namesLabel, namesOf } from "./approvals";
import { canTalkTo, speakerFor } from "./audience";
import { accountablePerson, type RunAuthority, runChain, steeredByOthers } from "./authority";
import { auditLabel } from "./connectors/personal";
import { getMembership } from "./organizations";
import { routineCreatorOf } from "./requester";
import { isRightHandId, rightHandReader } from "./right-hand";
import type { ToolContext } from "./tools/types";
import { vaultPersonOfRun } from "./vault/access";

/**
 * Who decides an action in one person's own mailbox or connection: that person (ADR 0038, ADR 0099 addendum). In a
 * mailbox asked by them, admins may decide it too; asked by anyone else (or nobody), only they do: an action in their
 * name is theirs to approve. A connection's (`personal`) is theirs alone, and only they and who is in its
 * conversation list it. Once they left the workspace nobody could, so the usual rule (the agent's owner, admins)
 * applies.
 */
export async function ownerApprovers(
  db: Database,
  orgId: string,
  ownerId: string,
  requestedBy: string | null,
  personal = false,
) {
  const [member] = await db
    .select({ id: schema.organizationMembers.userId })
    .from(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, orgId), eq(schema.organizationMembers.userId, ownerId)));
  if (!member) return { ok: true as const, approvers: null };
  const own = requestedBy === ownerId;
  return {
    ok: true as const,
    approvers: {
      userIds: [ownerId],
      label: namesLabel(await namesOf(db, [ownerId])),
      requestedBy: own ? null : requestedBy,
      requesterDecides: false,
      ...(own && !personal ? {} : { required: true }),
      ...(personal ? { personal: true } : {}),
    },
  };
}

/** The person a run answers for: who asked, else a routine's creator (as the gateway asks them). */
const personOfRun = (authority: RunAuthority | null) =>
  authority ? (accountablePerson(authority) ?? routineCreatorOf(authority)) : null;

type RunRef = Pick<ToolContext, "db" | "orgId" | "agentId" | "runId">;

/**
 * Who a person's own connection serves in a run (ADR 0099 addendum): the person a personal Vault item or skill serves
 * (`vaultPersonOfRun`): who asked, else a routine's creator, while an active member, and for the right hand only in
 * their own DM with it. Once someone else's words reached the run (`othersSpoke`) it serves nobody for the rest of it:
 * `joined` is then the person it served until that moment. `person` null: nobody.
 */
async function ownerOnlyUse(ctx: RunRef): Promise<{ person: string | null; joined: string | null }> {
  if (!ctx.runId) return { person: null, joined: null };
  const { personId } = await vaultPersonOfRun(ctx.db, { orgId: ctx.orgId, agentId: ctx.agentId, runId: ctx.runId });
  if (personId && (await othersSpoke(ctx.db, ctx.orgId, personId, ctx.runId)))
    return { person: null, joined: personId };
  return { person: personId, joined: null };
}

/**
 * Whether someone else's words reached a run of the chain `runId` is the end of (an agent passing an ask on to another
 * carries it): written into one of its runs, or an answer to a question one of them asked.
 */
async function othersSpoke(db: Database, orgId: string, personId: string, runId: string) {
  const runIds = (await runChain(db, orgId, runId))?.runIds ?? [runId];
  if (await steeredByOthers(db, orgId, personId, runIds)) return true;
  const [answered] = await db
    .select({ id: schema.agentQuestions.id })
    .from(schema.agentQuestions)
    .where(
      and(
        eq(schema.agentQuestions.orgId, orgId),
        inArray(schema.agentQuestions.runId, runIds),
        ne(schema.agentQuestions.answeredByUserId, personId),
      ),
    )
    .limit(1);
  return Boolean(answered);
}

export const ownerOnlyPerson = async (ctx: RunRef) => (await ownerOnlyUse(ctx)).person;

/**
 * What the model tells its person when a call names a tool of their own connection that this run lost because someone
 * else wrote into it; null when that isn't why the tool is missing.
 */
export async function personalLostNote(ctx: RunRef, toolName: string): Promise<string | null> {
  const { joined } = await ownerOnlyUse(ctx);
  if (!joined) return null;
  // Only a connection this agent holds: any other name gets the gateway's ordinary answer.
  const own = await ctx.db
    .selectDistinct({
      label: schema.connectorConnections.label,
      accountLabel: schema.connectorConnections.accountLabel,
      ownerUserId: schema.connectorConnections.ownerUserId,
      prefix: schema.connectorConnections.toolPrefix,
    })
    .from(schema.connectorConnections)
    .innerJoin(
      schema.agentScopes,
      and(
        eq(schema.agentScopes.connectionId, schema.connectorConnections.id),
        eq(schema.agentScopes.agentId, ctx.agentId),
        not(like(schema.agentScopes.scope, "deny:%")),
      ),
    )
    .where(
      and(
        eq(schema.connectorConnections.orgId, ctx.orgId),
        eq(schema.connectorConnections.ownerUserId, joined),
        isNull(schema.connectorConnections.revokedAt),
      ),
    );
  const hit = own.find((c) => toolName.startsWith(`${c.prefix}_`));
  if (!hit) return null;
  return `${auditLabel(hit)} is the own connection of the person who asked you. It stopped being available in this run when someone else wrote into it, because it serves only its person's own requests. Tell them that plainly: they can ask again on their own after this reply. Do not use it, or anything you read from it, for anyone else.`;
}

/**
 * Whether the person behind a run may use one person's own thing through this agent. A mailbox (ADR 0038): its
 * owner, or someone the agent answers directly, as its owner gave it access for (a consultation by someone outside
 * its audience doesn't count); nobody behind the run (an agent's own work, a watch) widens nobody's reach, so it serves
 * as its grant says (`nobody: true`); the team's right hand, which everyone talks to, uses one only for its owner, in
 * their own DM with it (ADR 0137), and the team's only with `rightHandTeam`. A connection (`ownerOnly`): only its
 * owner (`ownerOnlyPerson`), as a personal Vault item or skill. The returned check takes the thing's owner; null is
 * the team's.
 */
export async function personalUseCheck(
  ctx: ToolContext,
  authority: RunAuthority | null,
  options: { nobody: boolean; rightHandTeam: boolean } | { ownerOnly: true },
): Promise<(ownerId: string | null) => boolean> {
  if ("ownerOnly" in options) {
    const person = await ownerOnlyPerson(ctx);
    return (ownerId) => !ownerId || ownerId === person;
  }
  if (await isRightHandId(ctx.db, ctx.orgId, ctx.agentId)) {
    const reader = await rightHandReader(ctx);
    return (ownerId) => (ownerId ? reader !== null && ownerId === reader : options.rightHandTeam);
  }
  const person = personOfRun(authority);
  if (!person) return (ownerId) => !ownerId || options.nobody;
  const agent = await getAgent(ctx.db, ctx.orgId, ctx.agentId);
  const direct = !!agent && canTalkTo(agent, person, await speakerFor(ctx.db, ctx.orgId, person));
  return (ownerId) => !ownerId || direct || ownerId === person;
}

/**
 * `personalUseCheck` for a routine, before any run: whether what its creator set up may hand its agent one person's own
 * connection (its events). Only a routine its owner set up, while they are a member.
 */
export async function creatorMayUse(db: Database, orgId: string, ownerId: string, creatorId: string | null) {
  return !!creatorId && creatorId === ownerId && !!(await getMembership(db, creatorId, orgId));
}
