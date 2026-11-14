import type { Agent, OrgRole } from "../api/types";
import { answersOthers, audienceOf, modeOf } from "./audience";
import { engineOfBrain } from "./brain";

/** What an invitation starts someone with besides #general and the right hand (ADR 0184), as its chips show it. */
export interface InviteStart {
  channelIds: string[];
  agentIds: string[];
}

/**
 * What the invite dialog sends: the picked cargos' own channels and agents (their reach on the roles read), then the
 * ones added by hand, less the ones taken out. Picking another cargo brings its own in; the ones taken out stay out.
 */
export function inviteStart(
  roles: readonly Pick<OrgRole, "id" | "channelIds" | "agentIds">[],
  picked: readonly string[],
  added: InviteStart,
  removed: InviteStart,
): InviteStart {
  const mine = roles.filter((r) => picked.includes(r.id));
  const pick = (own: string[], extra: string[], gone: string[]) =>
    [...new Set([...own, ...extra])].filter((id) => !gone.includes(id));
  return {
    channelIds: pick(
      mine.flatMap((r) => r.channelIds ?? []),
      added.channelIds,
      removed.channelIds,
    ),
    agentIds: pick(
      mine.flatMap((r) => r.agentIds ?? []),
      added.agentIds,
      removed.agentIds,
    ),
  };
}

/**
 * How an agent may go with an invitation, the server's rule (`agentOk`, packages/engine/src/invite-choices.ts):
 * `everyone` (it talks to everyone), `cargo` (limited to a picked cargo), `opens` (restricted, and the viewer lets the
 * person in), or not: `locked` (restricted, someone else's to open), `plan` (it keeps its plan for its owner) or
 * `mailbox` (it reads someone else's mailbox, which opening it would take).
 */
export type InviteAgentCase = "everyone" | "cargo" | "opens" | "locked" | "plan" | "mailbox";

export function inviteAgentCase(
  agent: Agent,
  viewer: { userId: string; managesAgents: boolean },
  /** The picked cargos' agents (`inviteStart`'s, before the ones taken out). */
  cargoAgentIds: readonly string[],
  /** Whose mailboxes opening it would take (`agents.audienceMailLoss`), for one the viewer may open. */
  mailboxOwners: readonly string[] = [],
): InviteAgentCase {
  if (modeOf(agent) === "everyone") return "everyone";
  if (cargoAgentIds.includes(agent.id)) return "cargo";
  if (!viewer.managesAgents && agent.ownerUserId !== viewer.userId) return "locked";
  const onPlan = engineOfBrain(agent.brain?.kind) !== "agent";
  if (onPlan && !answersOthers({ ...audienceOf(agent), consultable: false }, agent.ownerUserId)) return "plan";
  return mailboxOwners.length > 0 ? "mailbox" : "opens";
}

/** The cases an invitation may pick. */
export const invitePickable = (c: InviteAgentCase) => c === "everyone" || c === "cargo" || c === "opens";
