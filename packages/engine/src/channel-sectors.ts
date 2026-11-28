import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, isNull, schema, sql } from "@agenteschat/db";
import { managesChannel } from "./channels";
import { ForbiddenError, NotFoundError } from "./errors";
import { publishOrgEvent } from "./events";
import { requireActiveMembership } from "./organizations";

const { agentGroups, channels } = schema;

interface Options {
  pubsub?: PubSub;
}

/** Everyone in the org refetches the sidebar's layout (no names in the event: private channels stay private). */
async function layoutChanged(orgId: string, options: Options) {
  await publishOrgEvent(options.pubsub, { type: "org.broadcast", orgId, event: { type: "channels.layout" } });
}

/**
 * The channels of one sector (null: those in none), in sidebar order. Only named channels that aren't archived: DMs
 * never sit in a sector.
 */
export async function channelsInSector(db: Executor, orgId: string, groupId: string | null) {
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.orgId, orgId),
        eq(channels.kind, "channel"),
        isNull(channels.archivedAt),
        groupId ? eq(channels.groupId, groupId) : isNull(channels.groupId),
      ),
    )
    .orderBy(asc(channels.position), asc(channels.name));
  return rows.map((r) => r.id);
}

/** Writes `ids` into `groupId` at positions 0..n (moving any of them there from elsewhere). */
export async function writeChannelOrder(db: Executor, orgId: string, groupId: string | null, ids: string[]) {
  for (const [position, id] of ids.entries()) {
    await db
      .update(channels)
      .set({ groupId, position })
      .where(and(eq(channels.orgId, orgId), eq(channels.id, id)));
  }
}

/**
 * Where a new channel goes in a sector (null: the channels in none). A list nobody arranged by hand has every position
 * at 0 and reads by name, so the new one joins at 0 and keeps that order; once someone arranged it (positions 0..n),
 * the new one goes to its end.
 */
export async function endOfSector(db: Executor, orgId: string, groupId: string | null) {
  const [row] = await db
    .select({ n: sql<number | null>`max(${channels.position})::int` })
    .from(channels)
    .where(
      and(
        eq(channels.orgId, orgId),
        eq(channels.kind, "channel"),
        isNull(channels.archivedAt),
        groupId ? eq(channels.groupId, groupId) : isNull(channels.groupId),
      ),
    );
  const max = Number(row?.n ?? 0);
  return max > 0 ? max + 1 : 0;
}

/** A sector a channel may be put in: it belongs to the org. */
export async function requireSectorInOrg(db: Executor, orgId: string, groupId: string) {
  const [row] = await db
    .select({ id: agentGroups.id })
    .from(agentGroups)
    .where(and(eq(agentGroups.orgId, orgId), eq(agentGroups.id, groupId)));
  if (!row) throw new NotFoundError("Group not found", "agent_group.not_found");
}

/**
 * Puts a channel in a sector (null: under Canais, in none), before `beforeChannelId` of that sector or at its end.
 * Who manages channels, and the channel's creator (`managesChannel`), as for renaming it.
 */
export async function placeChannel(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  input: { groupId: string | null; beforeChannelId?: string | null },
  options: Options = {},
) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [channel] = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.orgId, orgId),
        eq(channels.id, channelId),
        eq(channels.kind, "channel"),
        isNull(channels.archivedAt),
      ),
    );
  if (!channel) throw new NotFoundError("Channel not found");
  if (!(await managesChannel(db, membership, actorId, channel))) {
    throw new ForbiddenError("Only the channel's creator or who manages channels can move it");
  }
  if (input.groupId) await requireSectorInOrg(db, orgId, input.groupId);
  if (input.beforeChannelId === channelId) return;
  await db.transaction(async (tx) => {
    const ids = (await channelsInSector(tx, orgId, input.groupId)).filter((id) => id !== channelId);
    const at = input.beforeChannelId ? ids.indexOf(input.beforeChannelId) : -1;
    ids.splice(at >= 0 ? at : ids.length, 0, channelId);
    await writeChannelOrder(tx, orgId, input.groupId, ids);
  });
  await layoutChanged(orgId, options);
}
