import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  type Executor,
  eq,
  inArray,
  isNull,
  notInArray,
  or,
  schema,
  sql,
} from "@agenteschat/db";
import type { AgentMailLoss } from "./audience";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { memberCardVia } from "./card-via";
import { CHANNEL_OVERRIDES_MAX } from "./channel-permissions";
import { announceChannelLeavers, type ChannelLeaver, dropRoleLeavers } from "./channels";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishAgentsChanged, publishChannelsChanged } from "./events";
import {
  announceMembers,
  can,
  getMembership,
  lockOrgMembers,
  type Membership,
  outranks,
  requireActiveMembership,
  requirePermission,
} from "./organizations";
import {
  COMPUTER_STEPS,
  COMPUTERS_ROW,
  EVERYONE_DEFAULTS,
  isRolePermission,
  PERMISSION_AREAS,
  PERMISSION_ROWS,
  ROLE_COLORS,
  ROLE_ICONS,
  type RoleColor,
  type RoleIcon,
  type RolePermission,
  roleGrants,
} from "./permissions";

/**
 * A workspace's roles (ADR 0085): a person holds any number and may do what any allows; `everyone`
 * ("Todos") is the base every member holds; order is hierarchy. Two rules keep it from being climbed: anyone but
 * an owner only touches roles below their own highest one (and people whose highest role is below theirs), and
 * never gives a key they don't hold themselves.
 */

const {
  agents,
  channelMembers,
  channelPermissionOverrides: overrides,
  channels,
  orgRoles,
  organizationMemberRoles,
  organizationMembers,
} = schema;

export const ROLE_NAME_MAX = 40;
/** A workspace's roles at most, `everyone` aside. */
export const ROLES_MAX = 100;

export interface RoleView {
  id: string;
  kind: "custom" | "everyone";
  name: string;
  icon: string;
  color: string;
  position: number;
  permissions: RolePermission[];
  mentionable: boolean;
  hoist: boolean;
  /** How many people hold it (`everyone`: every member). */
  people: number;
  /** Whether the person asking may change it: they manage roles and stand above it. */
  editable: boolean;
  /**
   * Whether they may give it to people (invitations, requests to join, a person's roles): a role below theirs whose
   * keys they all hold.
   */
  givable: boolean;
  /**
   * The channels it opens that the person asking sees: those limited to it (ADR 0125), and every public channel for
   * `everyone`. Archived ones aside.
   */
  channelIds: string[];
  /** Channels limited to it that the person asking doesn't see: counted, never named. */
  hiddenChannels: number;
  /**
   * The agents it lets people talk to: those whose audience lists it, and for `everyone` those that answer the whole
   * workspace. The right hand (everyone's) and archived agents aside.
   */
  agentIds: string[];
}

/** The base role and an "Admin" that holds `administrator` (listed apart in the members column), for a new workspace. */
export async function createDefaultRoles(tx: Executor, orgId: string) {
  await tx.insert(orgRoles).values([
    {
      orgId,
      kind: "everyone",
      name: "everyone",
      icon: "audienceEveryone",
      color: "graphite",
      permissions: [...EVERYONE_DEFAULTS],
    },
    { orgId, name: "Admin", icon: "shield", color: "indigo", position: 0, permissions: ["administrator"], hoist: true },
  ]);
}

const byOrder = <T extends { kind: string; position: number; name: string }>(a: T, b: T) =>
  (a.kind === "everyone" ? 1 : 0) - (b.kind === "everyone" ? 1 : 0) ||
  a.position - b.position ||
  a.name.localeCompare(b.name);

/**
 * Whether an actor holds every key of a role (an owner holds them all): giving it to anyone, themselves included,
 * then hands out nothing they can't already do.
 */
function holdsAll(actor: Membership, keys: readonly string[]) {
  if (actor.role === "owner") return true;
  const mine = roleGrants(actor.permissions as ReadonlySet<string>);
  return keys.every((k) => !isRolePermission(k) || mine.has(k));
}

/** Whether `actor` may change `role`: hold `manage_roles` (or own the workspace) and stand above it. */
function mayEdit(actor: Membership, role: { kind: string; position: number }) {
  if (!can(actor, "manage_roles")) return false;
  return role.kind === "everyone" || outranks(actor, role.position);
}

/**
 * The workspace's roles, top first and `everyone` last, with how many hold each, and the areas the apps draw the
 * permissions in. Every member may read them: what a role may do is no secret inside the workspace.
 */
export async function listRoles(db: Database, actorId: string, orgId: string) {
  const actor = await requirePermission(db, actorId, orgId, "read");
  const rows = await db
    .select({
      id: orgRoles.id,
      kind: orgRoles.kind,
      name: orgRoles.name,
      icon: orgRoles.icon,
      color: orgRoles.color,
      position: orgRoles.position,
      permissions: orgRoles.permissions,
      mentionable: orgRoles.mentionable,
      hoist: orgRoles.hoist,
      people: sql<number>`(case when ${orgRoles.kind} = 'everyone'
        then (select count(*) from organization_members m where m.org_id = ${orgRoles.orgId})
        else (select count(*) from organization_member_roles mr where mr.org_id = ${orgRoles.orgId} and mr.role_id = ${orgRoles.id})
        end)::int`,
    })
    .from(orgRoles)
    .where(eq(orgRoles.orgId, orgId));
  const reach = await reachOf(db, actor, actorId, orgId);
  const roles: RoleView[] = rows.sort(byOrder).map((r) => ({
    ...r,
    permissions: r.permissions.filter(isRolePermission),
    editable: mayEdit(actor, r),
    givable: r.kind === "custom" && outranks(actor, r.position) && holdsAll(actor, r.permissions),
    ...reach(r),
  }));
  return { roles, areas: PERMISSION_AREAS, colors: ROLE_COLORS, icons: ROLE_ICONS };
}

/**
 * What each role opens besides its keys, for `listRoles`: its channels (seen by `actor` as their channel list does:
 * public, theirs, limited to a role of theirs, every one for an administrator, ADR 0151) and its agents.
 */
async function reachOf(db: Database, actor: Membership, actorId: string, orgId: string) {
  const [rooms, mine, bots] = await Promise.all([
    db
      .select({ id: channels.id, visibility: channels.visibility, roleIds: channels.audienceRoleIds })
      .from(channels)
      .where(
        and(
          eq(channels.orgId, orgId),
          eq(channels.kind, "channel"),
          isNull(channels.archivedAt),
          or(eq(channels.visibility, "public"), sql`cardinality(${channels.audienceRoleIds}) > 0`),
        ),
      )
      .orderBy(asc(channels.position), asc(channels.name)),
    db
      .select({ id: channelMembers.channelId })
      .from(channelMembers)
      .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.userId, actorId))),
    db
      .select({ id: agents.id, mode: agents.audienceMode, roleIds: agents.audienceRoleIds })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt), isNull(agents.builtin)))
      .orderBy(asc(agents.createdAt), asc(agents.name)),
  ]);
  const member = new Set(mine.map((m) => m.id));
  const admin = can(actor, "administrator");
  const sees = (c: (typeof rooms)[number]) =>
    admin || c.visibility === "public" || member.has(c.id) || c.roleIds.some((id) => actor.roleIds.includes(id));
  return (role: { id: string; kind: string }) => {
    if (role.kind === "everyone")
      return {
        channelIds: rooms.filter((c) => c.visibility === "public").map((c) => c.id),
        hiddenChannels: 0,
        agentIds: bots.filter((a) => a.mode === "everyone").map((a) => a.id),
      };
    const limited = rooms.filter((c) => c.visibility === "private" && c.roleIds.includes(role.id));
    return {
      channelIds: limited.filter(sees).map((c) => c.id),
      hiddenChannels: limited.filter((c) => !sees(c)).length,
      agentIds: bots.filter((a) => a.mode === "people" && a.roleIds.includes(role.id)).map((a) => a.id),
    };
  };
}

async function loadRole(db: Executor, orgId: string, roleId: string) {
  const [role] = await db
    .select()
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.id, roleId)));
  if (!role) throw new NotFoundError("Role not found");
  return role;
}

function cleanName(name: string) {
  const v = name.trim().replace(/\s+/g, " ");
  if (!v) throw new ValidationError("A role needs a name", "role.name_required");
  if (v.length > ROLE_NAME_MAX)
    throw new ValidationError(`At most ${ROLE_NAME_MAX} characters`, "role.name_long", { max: ROLE_NAME_MAX });
  return v;
}

const pickColor = (v: string | undefined, fallback: RoleColor) =>
  v && (ROLE_COLORS as readonly string[]).includes(v) ? v : fallback;
const pickIcon = (v: string | undefined, fallback: RoleIcon) =>
  v && (ROLE_ICONS as readonly string[]).includes(v) ? v : fallback;

/**
 * The keys an actor sets on a role: only known ones, and none they don't hold (an owner holds them all). Keys the
 * role already had stay even when the actor lacks them: they only add or remove what they hold.
 */
function settableKeys(actor: Membership, next: readonly string[], before: readonly string[] = []) {
  const mine = actor.role === "owner" ? null : roleGrants(actor.permissions as ReadonlySet<string>);
  const wanted = new Set(next.filter(isRolePermission));
  for (const k of wanted) {
    if (mine && !mine.has(k) && !before.includes(k))
      throw new ForbiddenError("You can only give what you can do yourself", "role.grant_forbidden", { key: k });
  }
  for (const k of before) {
    if (mine && isRolePermission(k) && !mine.has(k) && !wanted.has(k))
      throw new ForbiddenError("You can only take away what you can do yourself", "role.grant_forbidden", { key: k });
  }
  return [...wanted];
}

const announceRoles = async (pubsub: PubSub | undefined, orgId: string) => {
  // People's permissions follow their roles: their apps read `me`, the people and the roles again.
  await announceMembers(pubsub, orgId);
};

/**
 * Creates a role at the bottom of the others (just above `everyone`). Needs `manage_roles`. `copyFrom` (Duplicar): a
 * role below the actor whose keys they all hold, whose keys, look and switches fill what `input` leaves out, and
 * whose channels and agents the new role joins (their `audience_role_ids`), with its channel exceptions, in the same
 * transaction. It has nobody yet, so nobody reaches anything new until someone is given it.
 */
export async function createRole(
  db: Database,
  actorId: string,
  orgId: string,
  input: {
    name: string;
    icon?: string;
    color?: string;
    permissions?: string[];
    mentionable?: boolean;
    hoist?: boolean;
    copyFrom?: string;
  },
  options: { pubsub?: PubSub } = {},
) {
  const actor = await requirePermission(db, actorId, orgId, "manage_roles");
  const name = cleanName(input.name);
  const source = input.copyFrom ? await copySource(db, actor, orgId, input.copyFrom) : null;
  const permissions = settableKeys(actor, input.permissions ?? source?.permissions ?? []);
  const reach = {
    channelIds: [] as string[],
    agentIds: [] as string[],
    exceptions: [] as { channelId: string; allow: string[]; deny: string[] }[],
  };
  const role = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`org-roles:${orgId}`}))`);
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int`, last: sql<number>`coalesce(max(${orgRoles.position}), -1)::int` })
      .from(orgRoles)
      .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom")));
    if ((count?.n ?? 0) >= ROLES_MAX) throw new ConflictError("Too many roles", "role.too_many", { max: ROLES_MAX });
    const [row] = await tx
      .insert(orgRoles)
      .values({
        orgId,
        name,
        icon: pickIcon(input.icon, (source?.icon as RoleIcon | undefined) ?? "shield"),
        color: pickColor(input.color, (source?.color as RoleColor | undefined) ?? "graphite"),
        position: (count?.last ?? -1) + 1,
        permissions,
        mentionable: input.mentionable ?? source?.mentionable ?? true,
        hoist: input.hoist ?? source?.hoist ?? false,
      })
      .returning();
    if (!row) throw new Error("role insert returned nothing");
    if (source) {
      // The copy carries the source's channel exceptions (ADR 0134), or its people would escape a deny there. A
      // channel with no room for one more exception is left out of the copy's reach instead.
      const exceptions = await tx
        .select({ channelId: overrides.channelId, allow: overrides.allow, deny: overrides.deny })
        .from(overrides)
        .where(and(eq(overrides.orgId, orgId), eq(overrides.roleId, source.id)));
      const full =
        exceptions.length === 0
          ? []
          : (
              await tx
                .select({ channelId: overrides.channelId })
                .from(overrides)
                .where(
                  inArray(
                    overrides.channelId,
                    exceptions.map((e) => e.channelId),
                  ),
                )
                .groupBy(overrides.channelId)
                .having(sql`count(*) >= ${CHANNEL_OVERRIDES_MAX}`)
            ).map((c) => c.channelId);
      reach.exceptions = exceptions.filter((e) => !full.includes(e.channelId));
      if (reach.exceptions.length > 0)
        await tx.insert(overrides).values(reach.exceptions.map((e) => ({ orgId, roleId: row.id, ...e })));
      reach.channelIds = (
        await tx
          .update(channels)
          .set({ audienceRoleIds: sql`array_append(${channels.audienceRoleIds}, ${row.id}::uuid)` })
          .where(
            and(
              eq(channels.orgId, orgId),
              sql`${source.id}::uuid = any(${channels.audienceRoleIds})`,
              full.length > 0 ? notInArray(channels.id, full) : undefined,
            ),
          )
          .returning({ id: channels.id })
      ).map((c) => c.id);
      reach.agentIds = (
        await tx
          .update(agents)
          .set({
            audienceRoleIds: sql`array_append(${agents.audienceRoleIds}, ${row.id}::uuid)`,
            updatedAt: new Date(),
          })
          .where(and(eq(agents.orgId, orgId), sql`${source.id}::uuid = any(${agents.audienceRoleIds})`))
          .returning({ id: agents.id })
      ).map((a) => a.id);
    }
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "role.created",
      target: { type: "role", id: row.id },
      details: {
        name,
        permissions,
        ...(source ? { copiedFrom: { id: source.id, name: source.name }, ...reach } : {}),
      },
    });
    return row;
  });
  for (const id of reach.channelIds) caches.channels.delete(`${orgId}:${id}`);
  for (const id of reach.agentIds) caches.agents.delete(`${orgId}:${id}`);
  if (reach.agentIds.length > 0) {
    caches.agents.delete(`${orgId}:team`);
    await publishAgentsChanged(options.pubsub, orgId);
  }
  if (reach.channelIds.length > 0) await publishChannelsChanged(options.pubsub, orgId);
  await announceRoles(options.pubsub, orgId);
  return role;
}

/** The role Duplicar copies: one of the workspace's own, below the actor, every key of it theirs. */
async function copySource(db: Executor, actor: Membership, orgId: string, roleId: string) {
  const [source] = await db
    .select()
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.id, roleId), eq(orgRoles.kind, "custom")));
  if (!source) throw new ValidationError("Unknown role", "role.unknown");
  if (!mayEdit(actor, source)) throw new ForbiddenError("Only someone above this role copies it", "role.above_you");
  if (!holdsAll(actor, source.permissions))
    throw new ForbiddenError("You can only copy a role whose permissions you hold", "role.grant_forbidden");
  return source;
}

/**
 * Changes a role below the actor (or `everyone`). `everyone` keeps its name, look and switches: only its keys
 * change.
 */
export async function updateRole(
  db: Database,
  actorId: string,
  orgId: string,
  roleId: string,
  patch: {
    name?: string;
    icon?: string;
    color?: string;
    permissions?: string[];
    mentionable?: boolean;
    hoist?: boolean;
  },
  options: { pubsub?: PubSub } = {},
) {
  const actor = await requirePermission(db, actorId, orgId, "manage_roles");
  const role = await loadRole(db, orgId, roleId);
  if (!mayEdit(actor, role)) throw new ForbiddenError("Only someone above this role changes it", "role.above_you");
  const everyone = role.kind === "everyone";
  const set: Partial<typeof orgRoles.$inferInsert> = {};
  if (patch.name !== undefined && !everyone) set.name = cleanName(patch.name);
  if (patch.icon !== undefined && !everyone) set.icon = pickIcon(patch.icon, role.icon as RoleIcon);
  if (patch.color !== undefined) set.color = pickColor(patch.color, role.color as RoleColor);
  if (patch.mentionable !== undefined && !everyone) set.mentionable = patch.mentionable;
  if (patch.hoist !== undefined && !everyone) set.hoist = patch.hoist;
  if (patch.permissions !== undefined) {
    const next = settableKeys(actor, patch.permissions, role.permissions);
    // `everyone` never holds `administrator`: it would make every member one.
    set.permissions = everyone ? next.filter((k) => k !== "administrator") : next;
  }
  if (Object.keys(set).length === 0) return role;
  const [row] = await db.transaction(async (tx) => {
    const updated = await tx.update(orgRoles).set(set).where(eq(orgRoles.id, role.id)).returning();
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "role.updated",
      target: { type: "role", id: role.id },
      details: {
        name: set.name ?? role.name,
        ...(set.permissions ? { from: role.permissions, to: set.permissions } : {}),
      },
    });
    return updated;
  });
  await announceRoles(options.pubsub, orgId);
  return row ?? role;
}

/**
 * A role's own level on a row of the roles screen (`PERMISSION_ROWS`): 0 or 1 for a key, the step of the computers'
 * ladder (0 to 4, `COMPUTER_STEPS`). `administrator` aside: what it gives isn't the role's own, and what is comes
 * back when it goes off.
 */
export function rowLevel(keys: readonly string[], row: string): number {
  const own = roleGrants(keys.filter((k) => k !== "administrator"));
  if (row !== COMPUTERS_ROW) return own.has(row as RolePermission) ? 1 : 0;
  return COMPUTER_STEPS.reduce((step, k, i) => (own.has(k) ? i + 1 : step), 0);
}

/** `keys` with `row` at `level` (on the ladder, its step's key alone), the rest untouched. */
export function withRowLevel(keys: readonly string[], row: string, level: number): string[] {
  const rowKeys: readonly string[] = row === COMPUTERS_ROW ? COMPUTER_STEPS : [row];
  const key = row === COMPUTERS_ROW ? COMPUTER_STEPS[level - 1] : level > 0 ? row : undefined;
  return [...keys.filter((k) => !rowKeys.includes(k)), ...(key ? [key] : [])];
}

/** Who holds a row: `everyone`'s level and each custom role's, by id. */
export interface RowLevels {
  everyone: number;
  roles: Record<string, number>;
}

/**
 * "Quem pode…": who holds one row of the roles screen, Todos and the roles in one call (ADR 0085, addendum of
 * 2026-11-13). `everyone` gets `next.everyone`, each listed role its level, and every other role the actor may change
 * goes to 0 on that row. A role above the actor never changes (listing one at another level is refused,
 * `role.above_you`), nor does one with `administrator`, which may everything anyway. Needs `manage_roles`; anyone but
 * an owner only adds or takes keys they hold (`role.grant_forbidden`). One transaction under the roles' lock, one
 * audit row (`role.permission_set`). Returns the row's levels before and after.
 */
export async function setRowHolders(
  db: Database,
  actorId: string,
  orgId: string,
  row: string,
  next: { everyone: number; roles: readonly { id: string; level: number }[] },
  options: { pubsub?: PubSub } = {},
): Promise<{ before: RowLevels; after: RowLevels }> {
  const actor = await requirePermission(db, actorId, orgId, "manage_roles");
  if (!PERMISSION_ROWS.includes(row)) throw new ValidationError("Unknown permission", "role.row_unknown", { row });
  const max = row === COMPUTERS_ROW ? COMPUTER_STEPS.length : 1;
  if ([next.everyone, ...next.roles.map((r) => r.level)].some((l) => !Number.isInteger(l) || l < 0 || l > max))
    throw new ValidationError(`Each level is 0 to ${max}`, "role.level_invalid", { max });
  const listed = new Map(next.roles.map((r) => [r.id, r.level]));
  const done = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`org-roles:${orgId}`}))`);
    const rows = (await tx.select().from(orgRoles).where(eq(orgRoles.orgId, orgId))).sort(byOrder);
    const custom = new Set(rows.filter((r) => r.kind === "custom").map((r) => r.id));
    if ([...listed.keys()].some((id) => !custom.has(id))) throw new ValidationError("Unknown role", "role.unknown");
    const before: RowLevels = { everyone: 0, roles: {} };
    const after: RowLevels = { everyone: 0, roles: {} };
    const changed: { role: (typeof rows)[number]; from: number; to: number; keys: string[] }[] = [];
    for (const role of rows) {
      const from = rowLevel(role.permissions, row);
      let to = from;
      if (role.kind === "everyone") to = next.everyone;
      else if (role.permissions.includes("administrator")) to = from;
      else if (mayEdit(actor, role)) to = listed.get(role.id) ?? 0;
      else if ((listed.get(role.id) ?? from) !== from)
        throw new ForbiddenError("Only someone above this role changes it", "role.above_you", { name: role.name });
      if (role.kind === "everyone") [before.everyone, after.everyone] = [from, to];
      else [before.roles[role.id], after.roles[role.id]] = [from, to];
      if (to !== from)
        changed.push({
          role,
          from,
          to,
          keys: settableKeys(actor, withRowLevel(role.permissions, row, to), role.permissions),
        });
    }
    if (changed.length === 0) return { before, after, changed: false };
    for (const c of changed) await tx.update(orgRoles).set({ permissions: c.keys }).where(eq(orgRoles.id, c.role.id));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "role.permission_set",
      target: { type: "organization", id: orgId },
      details: {
        row,
        everyone: [before.everyone, after.everyone],
        roles: changed
          .filter((c) => c.role.kind === "custom")
          .map((c) => ({ id: c.role.id, name: c.role.name, before: c.from, after: c.to })),
      },
    });
    return { before, after, changed: true };
  });
  if (done.changed) await announceRoles(options.pubsub, orgId);
  return { before: done.before, after: done.after };
}

/** Deletes a role below the actor; whoever held it keeps the rest. `everyone` can't go. */
export async function deleteRole(
  db: Database,
  actorId: string,
  orgId: string,
  roleId: string,
  options: { pubsub?: PubSub } = {},
) {
  const actor = await requirePermission(db, actorId, orgId, "manage_roles");
  const role = await loadRole(db, orgId, roleId);
  if (role.kind === "everyone") throw new ForbiddenError("Every workspace keeps its base role", "role.base");
  if (!mayEdit(actor, role)) throw new ForbiddenError("Only someone above this role changes it", "role.above_you");
  const leavers = await db.transaction(async (tx) => {
    // The lock joinChannel takes for a role channel: a join at the same moment sees the role gone, or is dropped here.
    await lockOrgMembers(tx, orgId);
    const holders = (
      await tx
        .select({ userId: organizationMemberRoles.userId })
        .from(organizationMemberRoles)
        .where(and(eq(organizationMemberRoles.orgId, orgId), eq(organizationMemberRoles.roleId, role.id)))
    ).map((r) => r.userId);
    await tx.delete(orgRoles).where(eq(orgRoles.id, role.id));
    // Its holders leave the channels they were in through it alone (ADR 0125); then the channels forget it.
    const left = await dropRoleLeavers(tx, orgId, { people: holders, roleIds: [role.id] });
    await tx
      .update(schema.channels)
      .set({ audienceRoleIds: sql`array_remove(${schema.channels.audienceRoleIds}, ${role.id}::uuid)` })
      .where(and(eq(schema.channels.orgId, orgId), sql`${role.id}::uuid = any(${schema.channels.audienceRoleIds})`));
    // Invitations and links forget it too, or an app starting an approval or a change on their cargos sends one gone.
    for (const t of [schema.organizationInvitations, schema.organizationInviteLinks]) {
      await tx
        .update(t)
        .set({ roleIds: sql`array_remove(${t.roleIds}, ${role.id}::uuid)` })
        .where(and(eq(t.orgId, orgId), sql`${role.id}::uuid = any(${t.roleIds})`));
    }
    // Boards forget it too: a `roles` board with no role left is its owner's (and admins') alone (ADR 0135 §8).
    await tx
      .update(schema.dashboards)
      .set({ audienceRoleIds: sql`array_remove(${schema.dashboards.audienceRoleIds}, ${role.id}::uuid)` })
      .where(
        and(eq(schema.dashboards.orgId, orgId), sql`${role.id}::uuid = any(${schema.dashboards.audienceRoleIds})`),
      );
    // And who edits them: a board edited by roles with none left is edited by its owner and admins (`owner`).
    await tx
      .update(schema.dashboards)
      .set({
        editRoleIds: sql`array_remove(${schema.dashboards.editRoleIds}, ${role.id}::uuid)`,
        editPolicy: sql`case when cardinality(array_remove(${schema.dashboards.editRoleIds}, ${role.id}::uuid)) = 0
          and ${schema.dashboards.editPolicy} = 'roles' then 'owner' else ${schema.dashboards.editPolicy} end`,
      })
      .where(and(eq(schema.dashboards.orgId, orgId), sql`${role.id}::uuid = any(${schema.dashboards.editRoleIds})`));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "role.deleted",
      target: { type: "role", id: role.id },
      details: { name: role.name, permissions: role.permissions },
    });
    return left;
  });
  await announceChannelLeavers({ db, pubsub: options.pubsub }, orgId, leavers);
  await announceRoles(options.pubsub, orgId);
}

/**
 * Puts the roles in this order (top first; `everyone` stays last, whatever is sent). Anyone but an owner leaves the
 * roles at or above their own where they are: only the ones below them move, among themselves.
 */
export async function reorderRoles(
  db: Database,
  actorId: string,
  orgId: string,
  ids: string[],
  options: { pubsub?: PubSub } = {},
) {
  const actor = await requirePermission(db, actorId, orgId, "manage_roles");
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`org-roles:${orgId}`}))`);
    const current = (
      await tx
        .select({ id: orgRoles.id, position: orgRoles.position, name: orgRoles.name, kind: orgRoles.kind })
        .from(orgRoles)
        .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom")))
    ).sort(byOrder);
    const known = new Set(current.map((r) => r.id));
    const next = [...new Set(ids)].filter((id) => known.has(id));
    if (next.length !== current.length) throw new ValidationError("Send every role once", "role.order_incomplete");
    current.forEach((r, i) => {
      // A role the actor doesn't stand above keeps its slot.
      if (!outranks(actor, r.position) && next[i] !== r.id)
        throw new ForbiddenError("Only someone above a role moves it", "role.above_you");
    });
    for (const [i, id] of next.entries()) {
      await tx.update(orgRoles).set({ position: i }).where(eq(orgRoles.id, id));
    }
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "role.reordered",
      target: { type: "organization", id: orgId },
      details: { order: next.map((id) => current.find((r) => r.id === id)?.name ?? id) },
    });
  });
  await announceRoles(options.pubsub, orgId);
}

/**
 * The roles in `ids` the actor may give (or take): custom roles of this workspace below them whose keys they all
 * hold, so nobody hands themselves or anyone else more than they can do. Unknown or base ids refuse the whole call;
 * the result keeps the ids in the workspace.
 */
export async function givableRoleIds(db: Executor, actor: Membership, orgId: string, ids: readonly string[]) {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];
  const rows = await db
    .select({ id: orgRoles.id, kind: orgRoles.kind, position: orgRoles.position, permissions: orgRoles.permissions })
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), inArray(orgRoles.id, wanted)));
  if (rows.length !== wanted.length || rows.some((r) => r.kind !== "custom"))
    throw new ValidationError("Unknown role", "role.unknown");
  if (rows.some((r) => !outranks(actor, r.position)))
    throw new ForbiddenError("You can only give roles below your own", "role.above_you");
  if (rows.some((r) => !holdsAll(actor, r.permissions)))
    throw new ForbiddenError("You can only give roles whose permissions you hold", "role.grant_forbidden");
  return rows.map((r) => r.id);
}

/**
 * The ids among `ids` that `actor` could still give today (`givableRoleIds`, by someone who may invite), the others
 * left out: none when `actor` is no longer a member.
 */
export async function stillGivableRoleIds(
  db: Executor,
  actor: Membership | null,
  orgId: string,
  ids: readonly string[],
) {
  if (!actor || !can(actor, "invite_people") || ids.length === 0) return [];
  const rows = await db
    .select({ id: orgRoles.id, position: orgRoles.position, permissions: orgRoles.permissions })
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom"), inArray(orgRoles.id, [...new Set(ids)])));
  return rows.filter((r) => outranks(actor, r.position) && holdsAll(actor, r.permissions)).map((r) => r.id);
}

/** The ids among `ids` that are still custom roles of the workspace. */
export async function rolesStillThere(db: Executor, orgId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: orgRoles.id })
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom"), inArray(orgRoles.id, [...new Set(ids)])));
  return rows.map((r) => r.id);
}

/** Adds roles to a member in the caller's transaction, skipping any no longer in the workspace. */
export async function addMemberRolesInTx(
  tx: Executor,
  orgId: string,
  userId: string,
  roleIds: readonly string[],
  actorId = userId,
) {
  if (roleIds.length === 0) return;
  const before = await memberRoleIds(tx, orgId, userId);
  const there = await tx
    .select({ id: orgRoles.id })
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom"), inArray(orgRoles.id, [...new Set(roleIds)])));
  if (there.length === 0) return;
  await tx
    .insert(organizationMemberRoles)
    .values(there.map((r) => ({ orgId, userId, roleId: r.id })))
    .onConflictDoNothing();
  // Loaded here: audience builds on this module.
  const { dropMailForNewRoleMember } = await import("./audience");
  const added = there.map((r) => r.id).filter((id) => !before.includes(id));
  await dropMailForNewRoleMember(tx, orgId, userId, before, added, actorId);
}

/** A member's roles (ids), not `everyone`. */
export async function memberRoleIds(db: Executor, orgId: string, userId: string) {
  const rows = await db
    .select({ id: organizationMemberRoles.roleId })
    .from(organizationMemberRoles)
    .where(and(eq(organizationMemberRoles.orgId, orgId), eq(organizationMemberRoles.userId, userId)));
  return rows.map((r) => r.id);
}

/**
 * Sets a member's roles to exactly `roleIds` (ADR 0085). Needs `manage_members`; anyone but an owner only touches
 * people below them (themselves aside) and only adds or removes roles below their own. An owner's roles are set
 * by owners only.
 */
export async function setMemberRoles(
  db: Database,
  actorId: string,
  orgId: string,
  targetUserId: string,
  roleIds: string[],
  /**
   * `via`: the people card it was applied from (the audit's "via", `memberCardVia`). `mailLossSeen`: the mailboxes
   * the person agreed agents lose (`roleMailLoss`); losing any other refuses the change (409
   * `agent.mail_loss_changed`), so a mailbox given after they were asked is never taken unasked.
   */
  options: { pubsub?: PubSub; via?: string; mailLossSeen?: readonly string[] } = {},
) {
  const actor = await requirePermission(db, actorId, orgId, "manage_members");
  const via = await memberCardVia(db, orgId, options.via, targetUserId);
  const target = await getMembership(db, targetUserId, orgId, { includeBlocked: true });
  if (!target) throw new ConflictError("That user is not a member");
  if (target.role === "owner" && actor.role !== "owner")
    throw new ForbiddenError("Only owners change an owner's roles", "role.above_you");
  if (actorId !== targetUserId && !outranks(actor, target.rank))
    throw new ForbiddenError("Only someone above them changes their roles", "role.above_you");
  const next = [...new Set(roleIds)];
  // Read and checked under the lock: two people changing the same person's roles at once never undo each other.
  const changed = await db.transaction(async (tx): Promise<false | ChannelLeaver[]> => {
    await lockOrgMembers(tx, orgId);
    const before = await memberRoleIds(tx, orgId, targetUserId);
    const added = next.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !next.includes(id));
    await givableRoleIds(tx, actor, orgId, [...added, ...removed]);
    if (added.length === 0 && removed.length === 0) return false;
    const seen = options.mailLossSeen;
    if (seen) {
      const { newRoleMemberMailLoss } = await import("./audience");
      const lost = await newRoleMemberMailLoss(tx, orgId, targetUserId, before, added);
      if (lost.some((m) => !seen.includes(m.accountId)))
        throw new ConflictError("An agent holds a mailbox you weren't asked about", "agent.mail_loss_changed");
    }
    // Added before the others go: the mailboxes drop by the roles held before, as the check above and the preview
    // count them, so swapping one role for another that opens the same agent takes nothing.
    await addMemberRolesInTx(tx, orgId, targetUserId, added, actorId);
    if (removed.length > 0)
      await tx
        .delete(organizationMemberRoles)
        .where(
          and(
            eq(organizationMemberRoles.orgId, orgId),
            eq(organizationMemberRoles.userId, targetUserId),
            inArray(organizationMemberRoles.roleId, removed),
          ),
        );
    // Channels limited to the roles taken away (ADR 0125) let them go, unless another of theirs still opens them.
    const left = await dropRoleLeavers(tx, orgId, { people: [targetUserId], roleIds: removed });
    const names = await tx
      .select({ id: orgRoles.id, name: orgRoles.name })
      .from(orgRoles)
      .where(and(eq(orgRoles.orgId, orgId), inArray(orgRoles.id, [...added, ...removed])))
      .orderBy(asc(orgRoles.position));
    const nameOf = (id: string) => names.find((n) => n.id === id)?.name ?? id;
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "member.roles_changed",
      target: { type: "person", id: targetUserId },
      details: { added: added.map(nameOf), removed: removed.map(nameOf), ...(via ? { via } : {}) },
    });
    return left;
  });
  if (changed) {
    await announceChannelLeavers({ db, pubsub: options.pubsub }, orgId, changed);
    // Loaded here: questions build on channels, which this module loads.
    const { releaseQuestionsOutOfReach } = await import("./questions");
    await releaseQuestionsOutOfReach({ db, pubsub: options.pubsub }, orgId, targetUserId);
    await announceMembers(options.pubsub, orgId);
  }
  return next;
}

/**
 * The mailboxes agents would lose if `userIds` got the role (`dropMailForNewRoleMember`), taking nothing: the apps
 * ask first, and pass what was asked as `mailLossSeen`. For who may give it to them (`manage_members`, a role they
 * may give); someone already holding it, or no longer a member, costs nothing.
 */
export async function roleMailLoss(
  db: Database,
  actorId: string,
  orgId: string,
  roleId: string,
  userIds: readonly string[],
): Promise<AgentMailLoss[]> {
  const actor = await requirePermission(db, actorId, orgId, "manage_members");
  await givableRoleIds(db, actor, orgId, [roleId]);
  const { newRoleMemberMailLoss } = await import("./audience");
  const lost = new Map<string, AgentMailLoss>();
  for (const userId of new Set(userIds)) {
    if (!(await getMembership(db, userId, orgId, { includeBlocked: true }))) continue;
    const before = await memberRoleIds(db, orgId, userId);
    if (before.includes(roleId)) continue;
    for (const m of await newRoleMemberMailLoss(db, orgId, userId, before, [roleId]))
      lost.set(`${m.agentId}:${m.accountId}`, m);
  }
  return [...lost.values()];
}

/** The people who hold a role (ids), for the role's screen. Every member may read it. */
export async function roleMembers(db: Database, actorId: string, orgId: string, roleId: string) {
  await requireActiveMembership(db, actorId, orgId);
  const role = await loadRole(db, orgId, roleId);
  if (role.kind === "everyone") {
    const rows = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId));
    return rows.map((r) => r.userId);
  }
  const rows = await db
    .select({ userId: organizationMemberRoles.userId })
    .from(organizationMemberRoles)
    .where(and(eq(organizationMemberRoles.orgId, orgId), eq(organizationMemberRoles.roleId, roleId)));
  return rows.map((r) => r.userId);
}
