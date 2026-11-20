import type { TFunction } from "i18next";
import { ApiError } from "../api/http";
import type { Agent, Channel, InviteLink, InviteLinkTtl, OrgRole } from "../api/types";
import { sameList } from "./agent-edit";
import { answersOthers, audienceOf, managesAgent, modeOf } from "./audience";
import { engineOfBrain } from "./brain";
import { agentGrammar } from "./grammar";
import { grants, isEveryone, sortRoles } from "./roles";

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
  viewer: { userId: string },
  /** The picked cargos' agents (`inviteStart`'s, before the ones taken out). */
  cargoAgentIds: readonly string[],
  /** Whose mailboxes opening it would take (`agents.audienceMailLoss`), for one the viewer may open. */
  mailboxOwners: readonly string[] = [],
): InviteAgentCase {
  if (modeOf(agent) === "everyone") return "everyone";
  if (cargoAgentIds.includes(agent.id)) return "cargo";
  // Only its owner or who manages this agent opens it (`managesAgent`, ADR 0085 addendum of 2026-11-17): the "Edit
  // agents" key alone doesn't reach someone's private agent.
  if (!managesAgent(agent) && agent.ownerUserId !== viewer.userId) return "locked";
  const onPlan = engineOfBrain(agent.brain?.kind) !== "agent";
  if (onPlan && !answersOthers({ ...audienceOf(agent), consultable: false }, agent.ownerUserId)) return "plan";
  return mailboxOwners.length > 0 ? "mailbox" : "opens";
}

/** The cases an invitation may pick. */
export const invitePickable = (c: InviteAgentCase) => c === "everyone" || c === "cargo" || c === "opens";

/** What the picked cargos give with Todos: whether the person may talk to agents, and whether one is Administrador. */
export function inviteReach(roles: readonly Pick<OrgRole, "id" | "kind" | "permissions">[], picked: readonly string[]) {
  const held = roles.filter((r) => r.kind === "everyone" || picked.includes(r.id));
  const keys = grants(held.flatMap((r) => r.permissions));
  return {
    talks: keys.has("talk_to_agents"),
    admin: roles.some((r) => picked.includes(r.id) && r.permissions.includes("administrator")),
  };
}

/**
 * The channels an invitation may start someone in besides #general, the server's rule (`channelVerdicts`,
 * packages/engine/src/invite-choices.ts): a public one, one the viewer is in, or a private one limited to a picked
 * cargo. One an administrator only sees (ADR 0151) is none of these.
 */
export function invitableChannels<
  C extends Pick<Channel, "id" | "name" | "visibility" | "isMember" | "audienceRoleIds">,
>(channels: readonly C[], picked: readonly string[]): C[] {
  return channels.filter(
    (c) =>
      c.name !== "general" &&
      (c.visibility === "public" || c.isMember || (c.audienceRoleIds ?? []).some((r) => picked.includes(r))),
  );
}

/** How long a link works (ADR 0184), shortest first: the dialog's Validade, 30 days to start. */
export const INVITE_LINK_TTLS: readonly InviteLinkTtl[] = ["30m", "1h", "1d", "7d", "30d", "never"];
export const INVITE_LINK_TTL = "30d" satisfies InviteLinkTtl;
/** How many people a link takes (ADR 0184): the dialog's Máximo de pessoas; null, no limit (to start). */
export const INVITE_LINK_MAX_USES: readonly (number | null)[] = [1, 5, 10, 25, 50, 100, null];

/** A link's choices in the dialog. */
export interface LinkChoices {
  roleIds: string[];
  channelIds: string[];
  agentIds: string[];
  expiresIn: InviteLinkTtl;
  maxUses: number | null;
}

/**
 * The choices that make the workspace's own link (`plainLink`). Sent as Link opens, they renew it to 30 days at the
 * same address; an empty body only returns it as it is.
 */
export const INVITE_LINK_DEFAULTS: LinkChoices = {
  roleIds: [],
  channelIds: [],
  agentIds: [],
  expiresIn: INVITE_LINK_TTL,
  maxUses: null,
};

/**
 * Whether a link's choices are the workspace's own link (no cargo, no channel or agent besides #general and the right
 * hand, 30 days, no limit): the server answers those with that link, renewed (`createInviteLink`'s `atDefaults`).
 */
export const plainLink = (c: LinkChoices) =>
  c.roleIds.length === 0 &&
  c.channelIds.length === 0 &&
  c.agentIds.length === 0 &&
  c.maxUses === null &&
  c.expiresIn === INVITE_LINK_TTL;

/** Two links' choices alike: the one made still is what the fields say. */
export const sameChoices = (a: LinkChoices, b: LinkChoices) => {
  const same = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && [...x].sort().join() === [...y].sort().join();
  return (
    same(a.roleIds, b.roleIds) &&
    same(a.channelIds, b.channelIds) &&
    same(a.agentIds, b.agentIds) &&
    a.expiresIn === b.expiresIn &&
    a.maxUses === b.maxUses
  );
};

/** Whether a link took all its people: approving through it is refused until its maximum grows. */
export const linkFull = (link: Pick<InviteLink, "maxUses" | "uses">) =>
  link.maxUses !== null && link.maxUses !== undefined && (link.uses ?? 0) >= link.maxUses;

/**
 * A request's approval starts on its link's cargos the approver may give (ADR 0184 §8); the others, Todos aside, are
 * left out, and the request names them (`leftOut`, top first).
 */
export function approvalCargos(roles: readonly OrgRole[], linkRoleIds: readonly string[]) {
  return {
    given: linkRoleIds.filter((id) => roles.some((r) => r.id === id && r.givable)),
    leftOut: sortRoles(roles.filter((r) => linkRoleIds.includes(r.id) && !isEveryone(r) && !r.givable)).map(
      (r) => r.name,
    ),
  };
}

const DAY_MS = 86_400_000;

/** A link Convites shows in the attention tone: it took all its people, or it has less than a day left. */
export const linkNeedsAttention = (
  link: Pick<InviteLink, "maxUses" | "uses" | "expiresAt" | "neverExpires">,
  now = new Date(),
) => linkFull(link) || (!link.neverExpires && new Date(link.expiresAt).getTime() - now.getTime() < DAY_MS);

/** What a link or an invitation gives: its cargos, and the channels and agents past #general and the right hand. */
export interface InviteLists extends InviteStart {
  roleIds: string[];
}

/**
 * What Editar link or Editar convite saves: only the lists that changed from what it gives now, each compared as the
 * form would send it. The server checks every id it gets for whoever edits, so a list left as someone higher made it
 * (a cargo above theirs, a channel they aren't in) stays as it is instead of refusing the save.
 */
export function changedLists(
  was: { roleIds?: readonly string[]; channelIds?: readonly string[]; agentIds?: readonly string[] },
  now: InviteLists,
): Partial<InviteLists> {
  return {
    ...(sameList(now.roleIds, was.roleIds ?? []) ? {} : { roleIds: now.roleIds }),
    ...(sameList(now.channelIds, was.channelIds ?? []) ? {} : { channelIds: now.channelIds }),
    ...(sameList(now.agentIds, was.agentIds ?? []) ? {} : { agentIds: now.agentIds }),
  };
}

/**
 * Why the server refused a send, a link or an approval for one of its picks (ADR 0184): a channel or an agent gone or
 * no longer the sender's to give (`invitation.channel`, `invitation.agent`, naming it), or a cargo they may no longer
 * give.
 */
export type InviteRefusal =
  | { kind: "channel"; id: string; name: string | null; why: "archived" | "left" | "gone" }
  | { kind: "agent"; id: string; name: string | null; why: "gone" | "locked" }
  | { kind: "role" };

/** A refused channel or agent: its token is marked and `inviteRefusalText` says why. */
export type RefusedPick = Exclude<InviteRefusal, { kind: "role" }>;

const ROLE_REFUSALS = new Set(["role.unknown", "role.above_you", "role.grant_forbidden"]);

/** The pick an error refuses, from its code and params; null for any other error. */
export function inviteRefusal(error: unknown): InviteRefusal | null {
  if (!(error instanceof ApiError)) return null;
  const p = error.params ?? {};
  const name = typeof p.name === "string" && p.name ? p.name : null;
  if (error.code === "invitation.channel" && typeof p.channelId === "string")
    return { kind: "channel", id: p.channelId, name, why: p.why === "archived" || p.why === "left" ? p.why : "gone" };
  if (error.code === "invitation.agent" && typeof p.agentId === "string")
    return { kind: "agent", id: p.agentId, name, why: p.why === "locked" ? "locked" : "gone" };
  return ROLE_REFUSALS.has(error.code) ? { kind: "role" } : null;
}

/** A refused pick's line: what happened to it, and taking it out as the way on. */
export function inviteRefusalText(t: TFunction, r: RefusedPick): string {
  if (r.kind === "channel")
    return r.why === "gone" || !r.name
      ? t("invites.refused.channelGone")
      : t(r.why === "archived" ? "invites.refused.channelArchived" : "invites.refused.channelLeft", {
          channel: r.name,
        });
  if (!r.name) return t("invites.refused.agentUnnamed");
  return t(r.why === "gone" ? "invites.refused.agentGone" : "invites.refused.agentLocked", agentGrammar(r.name));
}
