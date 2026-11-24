import type { OrgRole } from "../api/types";

/**
 * Who answers for an agent (ADR 0085, addendum of 2026-11-21): a person, a role (whoever holds it at the time) or
 * nobody (the admins). What the apps' pickers, summaries, lists and approval cards read; the server decides with the
 * same rule (`ownsAgent` in the engine).
 */
export interface AgentOwnerLike {
  ownerUserId?: string | null;
  /** Absent from older servers: a person, or nobody. */
  ownerRoleId?: string | null;
}

export type AgentOwner = { kind: "person"; userId: string } | { kind: "role"; roleId: string } | { kind: "none" };

export const agentOwnerOf = (a: AgentOwnerLike): AgentOwner =>
  a.ownerRoleId
    ? { kind: "role", roleId: a.ownerRoleId }
    : a.ownerUserId
      ? { kind: "person", userId: a.ownerUserId }
      : { kind: "none" };

/** It has someone accountable: a person or a role. */
export const hasAgentOwner = (a: AgentOwnerLike) => !!a.ownerUserId || !!a.ownerRoleId;

/** Whether this person answers for the agent: its owner, or holding its owner role (`roleIds`: the roles they hold). */
export const ownsAgentAs = (a: AgentOwnerLike, userId: string, roleIds: readonly string[]) =>
  (!!a.ownerUserId && a.ownerUserId === userId) || (!!a.ownerRoleId && roleIds.includes(a.ownerRoleId));

/** A picker's value for a role (a person's is their id): `role:<id>`. */
export const ROLE_OWNER_PREFIX = "role:";

export const roleOwnerValue = (roleId: string) => `${ROLE_OWNER_PREFIX}${roleId}`;

/** The picker's value for an agent's owner: a person's id, `role:<id>`, or `none` (the picker's own "nobody"). */
export const ownerValueOf = (a: AgentOwnerLike, none: string) =>
  a.ownerRoleId ? roleOwnerValue(a.ownerRoleId) : (a.ownerUserId ?? none);

/** What a save sends for a picked value: a role clears the person and a person (or nobody) the role. */
export function ownerPatchOf(value: string, none: string): { ownerUserId: string | null; ownerRoleId: string | null } {
  if (value.startsWith(ROLE_OWNER_PREFIX))
    return { ownerUserId: null, ownerRoleId: value.slice(ROLE_OWNER_PREFIX.length) };
  return { ownerUserId: value === none ? null : value, ownerRoleId: null };
}

/** The role a picked value names, or null for a person or nobody. */
export const roleOfOwnerValue = (value: string) =>
  value.startsWith(ROLE_OWNER_PREFIX) ? value.slice(ROLE_OWNER_PREFIX.length) : null;

/**
 * The roles an agent may answer to: the workspace's own, but not one holding `administrator`. With no owner the admins
 * already decide (`approverIds` on the server), so "Admin" as owner would say the same thing twice.
 */
export const ownerRoles = (roles: readonly OrgRole[]) =>
  roles.filter((r) => r.kind === "custom" && !r.permissions.includes("administrator"));

/** The owner's name: the person's, or the role's ("Tecnologia"); undefined for nobody or one unknown here. */
export function ownerNameOf(
  a: AgentOwnerLike,
  names: { person: (userId: string) => string | undefined; role: (roleId: string) => string | undefined },
) {
  if (a.ownerRoleId) return names.role(a.ownerRoleId);
  return a.ownerUserId ? names.person(a.ownerUserId) : undefined;
}
