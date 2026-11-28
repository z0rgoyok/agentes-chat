import type { Agent, Member, Message, OrgRole } from "@agenteschat/client";
import { useAllAgents, useFormerAgents, useMembers, useRoles } from "@agenteschat/client";
import { type AgentOwnerLike, ownerNameOf } from "@agenteschat/client/lib/agent-owner";
import { agentsByAnyHandle, formerById } from "@agenteschat/client/lib/directory";
import { memberRoleColor } from "@agenteschat/client/lib/member-groups";
import { appAuthor } from "@agenteschat/client/lib/via";
import { type AgentColor, agentGradient } from "@agenteschat/ui";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { lookOf } from "@/lib/look";

/**
 * People and agents of the organization, by id and handle, for names and avatars. `agents` is what lists and pickers
 * offer (`listed`); the lookups also resolve an agent unlisted to me, whose messages and public card still show.
 */
export function useDirectory(orgId: string) {
  const { t } = useTranslation();
  const agents = useAllAgents(orgId);
  const former = useFormerAgents(orgId);
  const members = useMembers(orgId);
  const roles = useRoles(orgId);
  return useMemo(() => {
    const roleList = roles.data?.roles ?? [];
    const roleById = new Map<string, OrgRole>(roleList.map((r) => [r.id, r]));
    /** A role's name, for whom an agent answers ("Suporte"). */
    const roleName = (id: string) => roleById.get(id)?.name;
    const agentById = new Map<string, Agent>((agents.data ?? []).map((a) => [a.id, a]));
    const gone = formerById(former.data);
    /** The team's agent, or one no longer in it (archived or deleted): what it left still names it. */
    const anyAgent = (id: string) => agentById.get(id) ?? gone.get(id);
    const agentByHandle = agentsByAnyHandle(agents.data ?? []);
    // The uploaded photo wins over the sign-in image (`image` is what every avatar reads).
    const people = (members.data ?? []).map((m) => (m.avatarUrl ? { ...m, image: m.avatarUrl } : m));
    const memberById = new Map<string, Member>(people.map((m) => [m.userId, m]));
    /**
     * The roles a member holds (not `everyone`): an agent one of them answers for is theirs too (ADR 0085, addendum of
     * 2026-11-21).
     */
    const rolesOf = (userId: string): readonly string[] => memberById.get(userId)?.roleIds ?? [];
    /** Who answers for an agent, by name: the person's, or the role's ("Engineering"); undefined for nobody. */
    const ownerName = (a: AgentOwnerLike) =>
      ownerNameOf(a, { person: (id) => memberById.get(id)?.name, role: roleName });
    const memberByHandle = new Map<string, Member>(
      (members.data ?? []).filter((m) => m.handle).map((m) => [m.handle.toLowerCase(), m]),
    );
    /** An integration app's name (ADR 0251) is in its message's `meta.app`: pass `meta` where one may be an app's. */
    const authorName = (author: Message["author"], meta?: Record<string, unknown>) =>
      author.type === "app"
        ? (appAuthor(meta)?.name ?? t("integrations.unknownApp"))
        : author.type === "agent"
          ? (anyAgent(author.id ?? "")?.name ?? t("channel.unknownAgent"))
          : (memberById.get(author.id ?? "")?.name ?? t("channel.unknownPerson"));
    // Agents sharing a first letter get two (Ada "A", Atlas "At").
    const initials = new Map<string, string>();
    const used = new Set<string>();
    for (const a of agents.data ?? []) {
      const first = (a.name.trim()[0] ?? "?").toUpperCase();
      const value = used.has(first) ? `${first}${a.name.trim()[1] ?? ""}` : first;
      used.add(first);
      initials.set(a.id, value);
    }
    const agentInitials = (agentId: string) => initials.get(agentId);
    /** `@ada` → "Ada", `@joao` → "João"; unknown handles stay as typed. */
    const mentionName = (handle: string) =>
      agentByHandle.get(handle.toLowerCase())?.name ?? memberByHandle.get(handle.toLowerCase())?.name ?? null;
    /** A mentioned agent's color; none for a person or an unknown handle (their chip stays neutral). */
    const mentionTone = (handle: string) => {
      const agent = agentByHandle.get(handle.toLowerCase());
      return agent ? (lookOf(agent)?.color ?? "sky") : undefined;
    };
    /** A name's color in the bubbles, on a light and a dark surface: an agent's own, a person's role's; none: the ink. */
    const nameColorOf = (author: Message["author"]) => {
      const color =
        author.type === "agent"
          ? (lookOf(anyAgent(author.id ?? ""))?.color ?? "sky")
          : memberRoleColor(memberById.get(author.id ?? "") ?? { role: "member" }, roles.data?.roles ?? []);
      if (!color) return undefined;
      const [top, deep] = agentGradient(color as AgentColor);
      return [deep, top] as const;
    };
    return {
      agents: (agents.data ?? []).filter((a) => a.listed !== false),
      members: people,
      agentById,
      anyAgent,
      agentByHandle,
      memberById,
      memberByHandle,
      authorName,
      mentionName,
      mentionTone,
      agentInitials,
      nameColorOf,
      roleName,
      roles: roleList,
      roleById,
      rolesOf,
      ownerName,
      loading: agents.isPending || members.isPending,
    };
  }, [agents.data, former.data, members.data, roles.data, agents.isPending, members.isPending, t]);
}
