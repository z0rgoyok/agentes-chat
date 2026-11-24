import type { Member, OrgRole } from "@agenteschat/client";
import { type AgentOwnerLike, hasAgentOwner, ownerNameOf, ownsAgentAs } from "@agenteschat/client/lib/agent-owner";

/**
 * Who answers for an agent on the phone (ADR 0085, addendum of 2026-11-21): a person, a role (whoever holds it at the
 * time) or nobody (the admins). Its name and "is it mine" are read here, by the server's rule (`ownsAgent`); the hooks
 * that feed them are in `hooks.ts` (`useMyRoleIds`, `useOwnsAgent`, `useOwnerRoles`). What needs one person (whose
 * plan thinks for it, whose devices it reaches) still reads `ownerUserId` alone, as the server does: there an agent a
 * role answers for works as one with no owner.
 */

const NO_ROLES: readonly string[] = [];

/** The roles a person holds, from their member row; none while the people load or for someone who left. */
export const roleIdsOf = (
  memberById: ReadonlyMap<string, Pick<Member, "roleIds">>,
  userId: string | null | undefined,
): readonly string[] => (userId ? memberById.get(userId)?.roleIds : undefined) ?? NO_ROLES;

/**
 * Whether `meId` answers for `agent`: its owner, or holding the role that does, their roles read from `memberById` (a
 * conversation row's directory, where no hook may run).
 */
export const ownsIn = (
  memberById: ReadonlyMap<string, Pick<Member, "roleIds">>,
  meId: string | null | undefined,
  agent: AgentOwnerLike | null | undefined,
) => Boolean(meId && agent && ownsAgentAs(agent, meId, roleIdsOf(memberById, meId)));

/** The role that answers for an agent, when one does and the roles have loaded. */
export const ownerRoleOf = (a: AgentOwnerLike | null | undefined, roles: readonly OrgRole[] | undefined) =>
  a?.ownerRoleId ? roles?.find((r) => r.id === a.ownerRoleId) : undefined;

/** The owner's name: the person's, or the role's ("Tecnologia"); undefined for nobody or one not known here. */
export function ownerNameIn(
  a: AgentOwnerLike | null | undefined,
  memberById: ReadonlyMap<string, Pick<Member, "name">>,
  roles: readonly OrgRole[] | undefined,
): string | undefined {
  if (!a) return undefined;
  return ownerNameOf(a, {
    person: (id) => memberById.get(id)?.name,
    role: (id) => roles?.find((r) => r.id === id)?.name,
  });
}

/** Who an approval waits on: the owner it was asked under (its own fields), else its agent's now. */
export const approvalOwnerOf = (approval: AgentOwnerLike, agent: AgentOwnerLike | null | undefined): AgentOwnerLike =>
  hasAgentOwner(approval) ? approval : (agent ?? {});
