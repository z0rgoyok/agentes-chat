import { planOf } from "@agenteschat/providers/plans";
import type { TFunction } from "i18next";
import type {
  Agent,
  AgentAudience,
  AgentEditors,
  AgentSetupResult,
  AudienceMode,
  ForeignMailbox,
  OrgRole,
  OrgSummary,
} from "../api/types";
import { ownsAgentAs } from "./agent-owner";
import { engineOfBrain } from "./brain";
import { joinNames } from "./format";
import { agentGrammar } from "./grammar";
import { can } from "./permissions";
import { isEveryone, sortRoles } from "./roles";
import { isPersonal, modeKey } from "./workspace-mode";

type ModeOrg = Pick<OrgSummary, "mode"> | null | undefined;

/**
 * The i18n key of an audience choice's name (`audience.mode.*`): a personal workspace says it plainly ("Everyone
 * here", "Only some people", ADR 0159); "Only the owner" reads the same in both.
 */
export const audienceModeKey = (org: ModeOrg, mode: AudienceMode) =>
  mode === "owner" ? ("audience.mode.owner" as const) : modeKey(org, `audience.mode.${mode}` as const);

/** The line under the choice "everyone" or "people" (`audience.modeText.*`), a personal workspace's in its words. */
export const audienceModeTextKey = (org: ModeOrg, mode: Exclude<AudienceMode, "owner">) =>
  modeKey(org, `audience.modeText.${mode}` as const);

/** The agent's audience; absent = everyone (older servers). */
export function audienceOf(agent: Agent): Required<AgentAudience> {
  if (agent.audience)
    return {
      mode: agent.audience.mode,
      userIds: agent.audience.userIds ?? [],
      roleIds: agent.audience.roleIds ?? [],
      consultable: agent.audience.consultable ?? true,
    };
  return { mode: agent.audienceMode ?? "everyone", userIds: [], roleIds: [], consultable: true };
}

export const modeOf = (agent: Agent): AudienceMode => agent.audience?.mode ?? agent.audienceMode ?? "everyone";

/**
 * Whether its audience lets `userId` talk to the agent (the server's `canTalkTo`, without `talk_to_agents`): its
 * owner (or holding its owner role, ADR 0085, addendum of 2026-11-21), everyone, one of its people, or holding one of
 * its roles (`roleIds`: theirs, from the directory). A people list the directory didn't send, or roles picked when
 * theirs aren't known, say yes (don't warn on a guess).
 */
export function audienceAdmits(agent: Agent, userId: string, roleIds?: readonly string[]): boolean {
  if (ownsAgentAs(agent, userId, roleIds ?? [])) return true;
  const mode = modeOf(agent);
  if (mode !== "people") return mode === "everyone";
  const a = audienceOf(agent);
  if (!agent.audience || a.userIds.includes(userId)) return true;
  return roleIds ? a.roleIds.some((id) => roleIds.includes(id)) : a.roleIds.length > 0;
}

/** Its audience with `userId` let in; null when its people list wasn't sent (saving would drop them). */
export function audienceWith(agent: Agent, userId: string): AgentAudience | null {
  if (modeOf(agent) === "people" && !agent.audience) return null;
  const a = audienceOf(agent);
  const people = a.mode === "people";
  return {
    mode: "people",
    userIds: [...new Set([...(people ? a.userIds : []), userId])],
    roleIds: people ? a.roleIds : [],
  };
}

/** Whether people with `role` talk to the agent through it: it answers everyone, or its people list the role. */
export function roleTalksTo(role: Pick<OrgRole, "id" | "kind">, agent: Agent) {
  const a = audienceOf(agent);
  return a.mode === "everyone" || (!isEveryone(role) && a.mode === "people" && a.roleIds.includes(role.id));
}

/** Its audience of some people with `roleId` among their roles (`on`) or out of them; the people it lists stay. */
export function audienceWithRole(agent: Agent, roleId: string, on: boolean): AgentAudience {
  const a = audienceOf(agent);
  const people = a.mode === "people";
  const roleIds = people ? a.roleIds.filter((id) => id !== roleId) : [];
  return {
    mode: "people",
    userIds: people ? a.userIds : [],
    roleIds: on ? [...roleIds, roleId] : roleIds,
    consultable: a.consultable,
  };
}

/** Whether I can talk to it (the server's `canTalk`; absent = yes). */
export const canTalk = (agent: Pick<Agent, "canTalk"> | undefined) => agent?.canTalk !== false;

/** Whether a button may send me to its DM: I talk to agents at all, and this one answers me. */
export const mayAsk = (org: OrgSummary | null | undefined, agent: Pick<Agent, "canTalk"> | undefined) =>
  can(org, "talk_to_agents") && canTalk(agent);

/**
 * Whether I see how it works (instructions, tools and access, memory, files, usage, activity, settings): the
 * server's `seesDetails`, the same rule its routes enforce. Without it, only its public card.
 */
export const seesDetails = (agent: { seesDetails?: boolean } | undefined) => agent?.seesDetails !== false;

/** Whether its picture leads to its details: not an agent no longer in the team, nor for who sees only its public card. */
export const opensDetails = (agent: { seesDetails?: boolean; former?: unknown } | undefined) =>
  Boolean(agent) && !agent?.former && seesDetails(agent);

/**
 * Whether its DM opens for me (the server's `openDm`): it answers me, or I manage it (its composer then says why it
 * won't answer and offers to let me in). A private agent's stays closed to who merely holds "Edit agents" and to who
 * its "Who can edit" names (ADR 0085 addendum of 2026-11-17): every row, item or button that leads to its DM asks this,
 * never `listsAgent`.
 */
export const opensDm = (agent: Pick<Agent, "canTalk" | "canManage"> | undefined) =>
  canTalk(agent) || managesAgent(agent);

/**
 * Whether my lists and pickers show the agent (the server's `listsAgentTo`, short of `listsAllAgents`): the ones whose
 * DM opens for me (`opensDm`: that answer me, or that I manage, the lock saying who they answer) and the ones whose
 * workings I edit (`canEdit`, its "Who can edit", ADR 0085 addendum of 2026-11-17). From the server's flags, so a later
 * limit per person reaches every list unchanged. A list whose rows open the DM asks `opensDm` instead: an agent I only
 * edit opens on its page, from Team.
 */
export const listsAgent = (
  _org: OrgSummary | null | undefined,
  agent: Pick<Agent, "canTalk" | "canManage" | "canEdit"> | undefined,
) => opensDm(agent) || editsAgent(agent);

/**
 * Whether Equipe, its sectors and the counts name every agent for me (the server's `listsAllAgents`), but someone
 * else's private one (`listed: false`, which the directory and `useAgents` leave out); without it the server sends them
 * only the agents whose workings I see (`listsAgentTo`): that answer me, or that I edit.
 */
export const listsAllAgents = (org: OrgSummary | null | undefined) =>
  can(org, "view_all_agents") || can(org, "manage_agents");

/**
 * The agents whose DMs my lists leave out (`hiddenDm`): the ones whose DM wouldn't open for me (`opensDm`), as the
 * sidebar's agents and the phone's conversations, whose rows open it, leave them out. An agent I only edit is no
 * exception: its workings are on its page, never in a DM it won't answer (ADR 0085 addendum of 2026-11-17).
 */
export const hiddenAgentIds = (
  _org: OrgSummary | null | undefined,
  agents: readonly Pick<Agent, "id" | "canTalk" | "canManage">[],
) => new Set(agents.filter((a) => !opensDm(a)).map((a) => a.id));

/** A DM with one of `hiddenAgents` (`hiddenAgentIds`): off the lists and their counts. */
export const hiddenDm = (d: { with: { type: string; id: string } }, hiddenAgents: ReadonlySet<string> | undefined) =>
  d.with.type === "agent" && hiddenAgents?.has(d.with.id) === true;

/** Whether `to` lets someone talk to the agent whom `from` didn't; its owner always can (same rule as the backend). */
export function audienceWidens(from: AgentAudience, to: AgentAudience, ownerUserId: string | null): boolean {
  if (to.mode === "owner" || from.mode === "everyone") return false;
  if (to.mode === "everyone" || (to.consultable !== false && from.consultable === false)) return true;
  const people = new Set(from.mode === "people" ? from.userIds : []);
  const roles = new Set(from.mode === "people" ? (from.roleIds ?? []) : []);
  return (
    to.userIds.some((id) => id !== ownerUserId && !people.has(id)) || (to.roleIds ?? []).some((id) => !roles.has(id))
  );
}

/**
 * Whether "Outros agentes podem consultar" applies: someone is left out, and it doesn't think with a plan answering only
 * its owner (ADR 0059 §5), where nobody else is answered, consulted or not (same rule as the backend).
 */
export const offersConsultable = (a: AgentAudience, onPlan: boolean) =>
  a.mode !== "everyone" && !(onPlan && a.mode === "owner");

/**
 * Whether a narrowed audience holds for other agents too, as the line under it says (`audience.agents.*`): they still
 * consult it for the rest, they don't, or its owner's plan keeps everyone else out. Null: everyone can talk to it.
 */
export const agentsReach = (
  a: AgentAudience,
  onPlan: boolean,
  ownerUserId: string | null,
): "consulted" | "blocked" | "plan" | null =>
  a.mode === "everyone"
    ? null
    : onPlan && !answersOthers({ ...a, consultable: false }, ownerUserId)
      ? "plan"
      : a.consultable === false
        ? "blocked"
        : "consulted";

/** `agentsReach` in one line, which a screen shows with the reach's own sentence (`audience.agents.*`) behind an ⓘ. */
export const reachShortKey = (reach: "consulted" | "blocked" | "plan") =>
  reach === "consulted" ? "audience.peopleOnly" : "audience.agentsToo";

/** On a plan only its owner turns the switch back on (ADR 0059 §5); anyone else may only turn it off. */
export const consultableLocked = (saved: AgentAudience, viewer: { owner: boolean; onPlan: boolean }) =>
  viewer.onPlan && !viewer.owner && saved.consultable === false;

/** Someone besides its owner can talk to the agent. */
export const answersOthers = (a: AgentAudience, ownerUserId: string | null) =>
  audienceWidens({ mode: "owner", userIds: [] }, a, ownerUserId);

/**
 * Whether I manage the agent: the server's `canManage` ("Editar qualquer agente" where it reaches, ADR 0085 addendum
 * of 2026-11-17). Everything about it, its apps and their levels, budget, how much it asks, brakes and owner included.
 */
export const managesAgent = (agent: { canManage?: boolean } | null | undefined) => agent?.canManage === true;

/** Whether I edit how the agent works (the server's `canEdit`): its instructions, role, skills and routines. */
export const editsAgent = (agent: { canEdit?: boolean } | null | undefined) => agent?.canEdit === true;

/** Whether I set up and change the agent's routines (the server's `canManageRoutines`). */
export const managesRoutinesOf = (agent: { canManageRoutines?: boolean } | null | undefined) =>
  agent?.canManageRoutines === true;

/**
 * Whether I may make (or copy) a routine for the agent: I set up its routines and it answers me, since a routine asks
 * the agent on its creator's behalf (the server's `createRoutine`, ADR 0053; ADR 0085 addendum of 2026-11-17).
 */
export const createsRoutinesFor = (agent: { canManageRoutines?: boolean; canTalk?: boolean } | null | undefined) =>
  managesRoutinesOf(agent) && agent?.canTalk !== false;

/**
 * Only the agent's owner (or who holds its owner role: `myRoleIds`, ADR 0085, addendum of 2026-11-21) and who manages
 * it change who talks to it and who edits it (same rule as the backend).
 */
export const canEditAudience = (
  _org: OrgSummary | undefined,
  agent: Agent,
  myUserId: string,
  myRoleIds: readonly string[] = [],
) => managesAgent(agent) || ownsAgentAs(agent, myUserId, myRoleIds);

/** What a save sends: the people and roles only when it answers some people. */
export const audiencePatch = (a: AgentAudience): AgentAudience => ({
  mode: a.mode,
  userIds: a.mode === "people" ? a.userIds : [],
  roleIds: a.mode === "people" ? (a.roleIds ?? []) : [],
  consultable: a.consultable ?? true,
});

/** Everyone in the workspace: what "Atende outras pessoas" turned on lets in at most. */
export const EVERYONE_AUDIENCE: AgentAudience = { mode: "everyone", userIds: [], roleIds: [] };

/**
 * Saving `next` lets more people talk to an agent that thinks with someone else's plan (ADR 0059 §5): their plan pays
 * for those conversations, so the apps ask first, and the server emails its owner.
 */
export const opensOthersPlan = (agent: Agent, next: AgentAudience, myUserId: string) =>
  engineOfBrain(agent.brain?.kind) !== "agent" &&
  // A plan of theirs thinks for it (`account`): not OpenCode's free tier on a computer nobody connected (ADR 0132).
  agent.brain?.account !== undefined &&
  agent.ownerUserId != null &&
  agent.ownerUserId !== myUserId &&
  audienceWidens(audienceOf(agent), next, agent.ownerUserId);

/**
 * "Let me talk to it": its audience with me let in, when it keeps me out and I may change it (its owner or who manages
 * agents) and I talk to agents at all; null otherwise. On someone else's plan the save asks first (`opensOthersPlan`).
 */
export function audienceWithMe(
  org: OrgSummary | undefined,
  agent: Agent,
  myUserId: string,
  myRoleIds: readonly string[] = [],
): AgentAudience | null {
  if (canTalk(agent) || !can(org, "talk_to_agents") || !canEditAudience(org, agent, myUserId, myRoleIds)) return null;
  return audienceWith(agent, myUserId);
}

/** Why to ask before widening its audience: the agent loses the mailboxes others gave it, named by whose they are. */
export const mailLossText = (t: TFunction, agent: Pick<Agent, "name">, mailboxes: readonly ForeignMailbox[]) =>
  t("reach.mailLoss", {
    ...agentGrammar(agent.name),
    owners: joinNames([...new Set(mailboxes.map((m) => m.ownerName ?? m.address))], t),
  });

/**
 * The one question before widening its audience, or null when there is nothing to ask: on someone else's plan
 * (`planOwner`: their name, from `opensOthersPlan`), whose plan and limits it uses and that they get an email, and the
 * mailboxes it loses (`mailLossText`).
 */
export function widenQuestion(
  t: TFunction,
  agent: Pick<Agent, "name" | "brain">,
  planOwner: string | null,
  mailboxes: readonly ForeignMailbox[],
): { title: string; description: string } | null {
  const mail = mailboxes.length > 0 ? mailLossText(t, agent, mailboxes) : null;
  if (!planOwner) return mail ? { title: t("reach.mailLossTitle"), description: mail } : null;
  const why = t("reach.planOpen", { name: agent.name, owner: planOwner, plan: planName(t, agent.brain) });
  return {
    title: t("reach.planTitle", { owner: planOwner }),
    description: mail ? t("common.joinSentences", { a: why, b: mail }) : why,
  };
}

/** The plan a brain thinks with, as the email to its owner says it (the engine's `planName`): a coding plan's own. */
function planName(t: TFunction, brain: Pick<NonNullable<Agent["brain"]>, "kind" | "provider"> | null | undefined) {
  const kind = brain?.kind && brain.kind !== "model" ? brain.kind : "claude_code";
  const provider = brain?.provider ?? undefined;
  const coding = planOf(provider);
  return coding ? (provider === "opencode" ? coding.name : coding.maker) : t(`aiAccounts.connect.${kind}`);
}

/**
 * The one question before "Usar em outros agentes" lets more people talk to agents on other people's plans (the
 * preview's `opensPlan`): whose plans, one line per owner naming their agents; null when it opens none.
 */
export function setupPlanQuestion(
  t: TFunction,
  brain: Pick<NonNullable<Agent["brain"]>, "kind" | "provider">,
  opened: readonly { agent: string; owner: string }[],
): { title: string; description: string } | null {
  const byOwner = new Map<string, string[]>();
  for (const o of opened) byOwner.set(o.owner, [...(byOwner.get(o.owner) ?? []), o.agent]);
  const owners = [...byOwner.keys()];
  const [only] = owners;
  if (only === undefined) return null;
  const plan = planName(t, brain);
  return {
    title:
      owners.length === 1
        ? t("reach.planTitle", { owner: only })
        : t("reach.plansTitle", { owners: joinNames(owners, t) }),
    description: [...byOwner]
      .map(([owner, agents]) => t("reach.planOpen", { name: joinNames(agents, t), owner, plan }))
      .join("\n"),
  };
}

/** The setup's results that open someone else's plan, among `agentIds`, with each agent's and owner's name. */
export function setupPlanOpens(
  results: readonly AgentSetupResult[],
  agentIds: readonly string[],
  agentOf: (id: string) => Pick<Agent, "name" | "ownerUserId"> | undefined,
  ownerName: (userId: string) => string,
): { agent: string; owner: string }[] {
  return results.flatMap((r) => {
    const a = r.opensPlan && agentIds.includes(r.agentId) ? agentOf(r.agentId) : undefined;
    return a?.ownerUserId ? [{ agent: a.name, owner: ownerName(a.ownerUserId) }] : [];
  });
}

/** One line of "Quem pode falar": the whole workspace (its `everyone` role's mark), a role, or a person. */
export type AudienceLine<P> =
  | { kind: "everyone"; role?: OrgRole }
  | { kind: "role"; role: OrgRole }
  | { kind: "person"; person: P };

/**
 * Who it answers, one line each: everyone; only its owner (a person, or the role that answers for it, ADR 0085,
 * addendum of 2026-11-21); or its roles (top first), then its people. Its owner isn't among them (it always may); only
 * the roles and people we know.
 */
export function audienceLines<P extends { userId: string }>(
  agent: Agent,
  roles: readonly OrgRole[],
  members: readonly P[],
): AudienceLine<P>[] {
  const a = audienceOf(agent);
  const person = (id: string) => members.find((m) => m.userId === id);
  if (a.mode === "everyone") return [{ kind: "everyone", role: roles.find(isEveryone) }];
  const ids = a.mode === "owner" ? (agent.ownerUserId ? [agent.ownerUserId] : []) : a.userIds;
  const people = ids
    .filter((id) => a.mode === "owner" || id !== agent.ownerUserId)
    .flatMap((id) => {
      const p = person(id);
      return p ? [{ kind: "person" as const, person: p }] : [];
    });
  const picked =
    a.mode === "people"
      ? sortRoles(roles.filter((r) => a.roleIds.includes(r.id) && r.id !== agent.ownerRoleId))
      : roles.filter((r) => r.id === agent.ownerRoleId);
  return [...picked.map((role) => ({ kind: "role" as const, role })), ...people];
}

/**
 * "Pessoal" (only the owner) or "Restrito" (some people); nothing for everyone. `viewer`: a personal workspace tells
 * its owner "Only you" on their own agent (ADR 0159).
 */
export function audienceChip(t: TFunction, agent: Agent, viewer?: { org: ModeOrg; meId: string }): string | null {
  const mode = modeOf(agent);
  if (mode === "owner")
    return t(
      viewer && isPersonal(viewer.org) && agent.ownerUserId === viewer.meId
        ? "audience.chip.ownerPersonal"
        : "audience.chip.owner",
    );
  if (mode === "people") return t("audience.chip.people");
  return null;
}

type NameOf = (id: string) => string | undefined;

/** Who it answers: its owner role and its roles, then its owner and its people (only the names we know). */
function answered(agent: Agent, nameOf: NameOf, roleName: NameOf) {
  const a = audienceOf(agent);
  const people = a.mode === "people";
  const ids = [...new Set([...(agent.ownerUserId ? [agent.ownerUserId] : []), ...(people ? a.userIds : [])])];
  // The role that answers for it always may talk to it (ADR 0085, addendum of 2026-11-21).
  const roleIds = [...new Set([...(agent.ownerRoleId ? [agent.ownerRoleId] : []), ...(people ? a.roleIds : [])])];
  const known = (n: string | undefined): n is string => Boolean(n);
  return { roles: roleIds.map(roleName).filter(known), people: ids.map(nameOf).filter(known) };
}

/** Who it answers, roles first, then the owner: ["Suporte", "Walter", "Ana"] (only the names we know). */
export function audienceNames(agent: Agent, nameOf: NameOf, roleName: NameOf = () => undefined): string[] {
  const { roles, people } = answered(agent, nameOf, roleName);
  return [...roles, ...people];
}

/** "O Theo só responde a Suporte e Walter." / "… a algumas pessoas." / "" for everyone. */
export function audienceNotice(t: TFunction, agent: Agent, nameOf: NameOf, roleName?: NameOf): string {
  const mode = modeOf(agent);
  if (mode === "everyone") return "";
  const g = agentGrammar(agent.name);
  // From the directory list (mode only, no user ids): don't guess names.
  if (mode === "people" && !agent.audience) return t("audience.notice.some", g);
  const names = audienceNames(agent, nameOf, roleName);
  if (names.length === 0) return t("audience.notice.nobody", g);
  return t("audience.notice.only", { ...g, names: joinNames(names, t) });
}

/** `agent.unavailable` (my own topic): a message of mine named an agent that won't answer me, never stored. */
export interface AgentUnavailableEvent {
  type: "agent.unavailable";
  agentId: string;
  channelId: string;
  threadId: string | null;
  messageId: string;
  /** The server's English, for agents and old clients: the app words it from `code` and `params`. */
  text: string;
  /** `channel.agents_denied` (this channel's exceptions, ADR 0134), `audience.only` or `audience.nobody`. */
  code?: string;
  params?: Record<string, unknown>;
}

export const isAgentUnavailable = (e: { type: string }): e is AgentUnavailableEvent =>
  e.type === "agent.unavailable" &&
  typeof (e as AgentUnavailableEvent).agentId === "string" &&
  typeof (e as AgentUnavailableEvent).channelId === "string";

/**
 * Why the agent I named won't answer me, in my language: the channel's own exception, or whom the agent answers (from
 * the directory when it knows the agent, else from the names the server sent).
 */
export function unavailableNotice(
  t: TFunction,
  notice: Pick<AgentUnavailableEvent, "code" | "params">,
  agent: Agent | undefined,
  nameOf: NameOf,
  roleName?: NameOf,
): string {
  if (notice.code === "channel.agents_denied") return t("channel.perms.agentsDenied");
  const known = agent ? audienceNotice(t, agent, nameOf, roleName) : "";
  if (known) return known;
  const p = notice.params ?? {};
  const g = agentGrammar(typeof p.agentName === "string" ? p.agentName : (agent?.name ?? ""));
  const names = Array.isArray(p.names) ? p.names.filter((n): n is string => typeof n === "string") : [];
  return names.length > 0
    ? t("audience.notice.only", { ...g, names: joinNames(names, t) })
    : t("audience.notice.nobody", g);
}

/**
 * "Only the owner" in words: "Only" and the person's name, "Only whoever holds Engineering" for a role that answers for
 * it (ADR 0085, addendum of 2026-11-21), or "No one for now" with neither (or one not known here).
 */
export function ownerOnlyText(
  t: TFunction,
  agent: Pick<Agent, "ownerUserId" | "ownerRoleId">,
  nameOf: NameOf,
  roleName: NameOf = () => undefined,
) {
  const role = agent.ownerRoleId ? roleName(agent.ownerRoleId) : undefined;
  if (role) return t("audience.summary.ownerRole", { role });
  const owner = agent.ownerUserId ? nameOf(agent.ownerUserId) : undefined;
  return owner ? t("audience.summary.owner", { name: owner }) : t("audience.summary.nobody");
}

/**
 * The profile summary: "Everyone in the workspace", "Support, Engineering and 2 more people", "Only" and a person's
 * name, "Only whoever holds Engineering" (its owner role, ADR 0085, addendum of 2026-11-21). `org`: a personal workspace
 * says "everyone" its way (ADR 0159).
 */
export function audienceSummary(
  t: TFunction,
  agent: Agent,
  nameOf: NameOf,
  roleName: NameOf = () => undefined,
  org?: ModeOrg,
) {
  const a = audienceOf(agent);
  if (a.mode === "everyone") return t(modeKey(org, "audience.summary.everyone"));
  if (a.mode === "owner") return ownerOnlyText(t, agent, nameOf, roleName);
  const { roles, people } = answered(agent, nameOf, roleName);
  const names = [...roles, ...people];
  if (names.length === 0) return t("audience.summary.someone");
  if (names.length <= 3) return t("audience.summary.people", { names: joinNames(names, t) });
  const shown = names.slice(0, 2).join(", ");
  const count = names.length - 2;
  // Only people left over: "e mais 2 pessoas".
  if (roles.length <= 2) return t("audience.summary.manyPeople", { names: shown, count });
  return t("audience.summary.many", { names: shown, count });
}

/*
 * "Quem pode editar" (ADR 0085, addendum of 2026-11-17): who changes how an agent works (its instructions, role, skills
 * and routines) besides who looks after it (its owner, and who manages it). Its owner or who manages it changes the
 * list, as with "Quem pode falar" (`canEditAudience`).
 */

/** Its two choices: only who looks after the agent, or some people and roles too. */
export type EditorsMode = "owner" | "people";

/** "Quem pode editar" being edited: the choice, and the people and roles picked (kept while "owner" is chosen). */
export interface EditorsValue {
  mode: EditorsMode;
  userIds: string[];
  roleIds: string[];
}

/**
 * The people and roles its "Quem pode editar" names (the server's `editors`; absent, an older server: nobody). Its
 * owner always edits, so it is never one of them: a named editor who later became its owner stays in the server's
 * list, and counting them would pick "Also some people or roles" with nobody shown (ADR 0085 addendum of 2026-11-17).
 */
export const editorsOf = (agent: Pick<Agent, "editors" | "ownerUserId" | "ownerRoleId">): AgentEditors => ({
  userIds: (agent.editors?.userIds ?? []).filter((id) => id !== agent.ownerUserId),
  // Nor is the role that answers for it (ADR 0085, addendum of 2026-11-21): whoever holds it edits as its owner.
  roleIds: (agent.editors?.roleIds ?? []).filter((id) => id !== agent.ownerRoleId),
});

/** "people" once it names someone, else "owner". */
export const editorsMode = (e: { userIds: readonly string[]; roleIds: readonly string[] }): EditorsMode =>
  e.userIds.length > 0 || e.roleIds.length > 0 ? "people" : "owner";

/** Its "Quem pode editar" as the choice shows it. */
export function editorsValueOf(agent: Pick<Agent, "editors" | "ownerUserId" | "ownerRoleId">): EditorsValue {
  const e = editorsOf(agent);
  return { mode: editorsMode(e), userIds: e.userIds, roleIds: e.roleIds };
}

/** What a save sends: the people and roles under "people"; "owner" names nobody. */
export const editorsPatch = (v: EditorsValue): AgentEditors =>
  v.mode === "people" ? { userIds: v.userIds, roleIds: v.roleIds } : { userIds: [], roleIds: [] };

/**
 * "Quem pode editar" in one line: its owner, then the people and the roles it names, joined as the audience's summary
 * ("Walter, Ana e Suporte", "… e mais 2 pessoas"); naming nobody, "Só quem cuida dela". Only the names we know.
 */
export function editorsSummary(
  t: TFunction,
  agent: Pick<Agent, "name" | "ownerUserId" | "ownerRoleId" | "editors">,
  nameOf: NameOf,
  roleName: NameOf = () => undefined,
) {
  // Its owner always edits: named first, never twice (`editorsOf` leaves them out of the people).
  const e = editorsOf(agent);
  const known = (n: string | undefined): n is string => Boolean(n);
  const people = e.userIds.map(nameOf).filter(known);
  const roles = e.roleIds.map(roleName).filter(known);
  if (people.length === 0 && roles.length === 0) return t("editors.summary.owner", agentGrammar(agent.name));
  // A role that answers for it is named first the same way (ADR 0085, addendum of 2026-11-21).
  const owner = agent.ownerRoleId
    ? roleName(agent.ownerRoleId)
    : agent.ownerUserId
      ? nameOf(agent.ownerUserId)
      : undefined;
  const names = [...(owner ? [owner] : []), ...people, ...roles];
  if (names.length <= 3) return t("audience.summary.people", { names: joinNames(names, t) });
  const shown = names.slice(0, 2).join(", ");
  const count = names.length - 2;
  // The roles come last: only people are left over when it names none ("e mais 2 pessoas").
  if (roles.length === 0) return t("audience.summary.manyPeople", { names: shown, count });
  return t("audience.summary.many", { names: shown, count });
}
