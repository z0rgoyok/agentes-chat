import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, isNull, schema } from "@agenteschat/db";
import { accessInputOf, replaceableGrants, setAgentAccess } from "./access";
import { moveAgentToGroup } from "./agent-groups";
import { type Agent, archiveAgent, getAgent, unarchiveAgent, updateAgent, validateAgentFields } from "./agents";
import { setAgentAppearance, validateAppearance } from "./appearance";
import {
  agentEditorIds,
  agentManagerIds,
  agentOwnerIds,
  audienceOf,
  editsAgent,
  managesAgent,
  ownsAgent,
  setAgentAudience,
} from "./audience";
import { isBrainEffortSetting, normalizeBrainModel, setAgentBrain } from "./brain-settings";
import { isComputerBrain } from "./brains/types";
import { invalidateOrg } from "./cache";
import { addChannelMember, removeChannelMember, setChannelAgentAutoReply } from "./channels";
import { moveLearnedSections, splitLearned } from "./context/learned-sections";
import { sha256 } from "./crypto";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishAgentsChanged, publishListChanged } from "./events";
import { setAgentComputerTarget } from "./machines";
import { can, getMembership, requirePermission } from "./organizations";
import { reportsToRefusal, setReportsTo } from "./reporting";
import { isRightHand, personalBrain } from "./right-hand";
import { setAgentSkills } from "./skills";
import { canonicalJson } from "./tools/json-schema";
import { agentBudgetState, orgDefaultAgentBudget } from "./usage";

const {
  agentActions,
  agentGroups,
  agentSkills,
  agents,
  channelMembers,
  channels,
  contextProposals,
  machineAccounts,
  providerCredentials,
  skills,
} = schema;

export type SettingLine = schema.ProposedSettingLine;
export type SettingField = SettingLine["field"];
/**
 * What a receipt can put back: a setting, or a change of an instructions, role or apps row applied at once
 * (`applyAsked`). Those three stay cards of their own, never lines of a settings card.
 */
export type ReceiptLine = Omit<SettingLine, "field"> & { field: SettingField | "instructions" | "role" | "apps" };
type Proposal = typeof contextProposals.$inferSelect;

/**
 * Who decides a line (ADR 0137, amending 0092 §5): whoever may make that change on the agent's page. `admin`: who
 * manages that agent (`managesAgent`: model, budget, owner, archive, delete); `editor`: who edits it (`editsAgent`:
 * its owner, who manages it, its "Quem pode editar"; its skills, ADR 0085 addendum of 2026-11-17); `admin_or_owner`:
 * who manages it or its owner (who talks to it, its channels and how it replies there); `account`: only the owner of
 * the AI account, who must own the agent too (a personal plan is assigned by its owner alone, ADR 0059 §3). One row
 * per agent and group, so a row is decided by one rule.
 */
export const SETTING_GROUP: Record<SettingField, "admin" | "editor" | "admin_or_owner" | "account"> = {
  model: "admin",
  effort: "admin",
  budget: "admin",
  owner: "admin",
  archive: "admin",
  delete: "admin",
  audience: "admin_or_owner",
  channel_add: "admin_or_owner",
  channel_remove: "admin_or_owner",
  reply_mode: "admin_or_owner",
  // Which skills it has is how it works: who edits it, as on its page.
  skill: "editor",
  name: "admin",
  look: "admin_or_owner",
  // Who manages agents moves an agent between departments, as on the team screen (ADR 0148 addendum).
  group: "admin",
  // Who manages both the agent and its new supervisor sets a line, as on the page (ADR 0148 addendum, `maySettle`).
  reports_to: "admin",
  ai_account: "account",
};

/** Archive and delete go last (the other changes need the agent active); Undo walks the lines backwards. */
const ORDER: SettingField[] = [
  "ai_account",
  "model",
  "effort",
  "budget",
  "owner",
  "audience",
  "channel_add",
  "channel_remove",
  "reply_mode",
  "skill",
  "name",
  "look",
  "group",
  "reports_to",
  "archive",
  "delete",
];

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** Instructions as Undo compares them: without a "## Learned" section, which every write moves to memory. */
const held = (field: ReceiptLine["field"], value: unknown) =>
  field === "instructions" ? splitLearned(String(value ?? "")).instructions : value;

/** What `from` and `to` hold for an AI account: the brain it thinks with and the account (null: the API). */
interface AccountValue {
  brain: string;
  accountId: string | null;
}

/** An agent's grants in one order, however they were last written: what an apps receipt compares. */
export const agentApps = async (db: Executor, orgId: string, agentId: string) =>
  (await replaceableGrants(db, orgId, agentId)).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));

/** Which AI a right hand's model or effort line reads and writes: its person's own (`person`), else the agent's. */
async function thinkingAgent(db: Executor, agent: Agent, line: Pick<ReceiptLine, "field" | "person">) {
  if (!line.person || (line.field !== "model" && line.field !== "effort")) return agent;
  const own = await personalBrain(db, agent.orgId, line.person);
  return own && { ...agent, brain: own.brain, brainModel: own.brainModel, brainEffort: own.brainEffort };
}

/**
 * A setting's value now. A channel line's value is the agent's seat there: null when it isn't in it, else whether it
 * answers without a mention (`autoReply`), so adding, removing and the reply mode read and write the same thing. The
 * model of an agent that thinks on a computer is its brain's ("Quem pensa"), null for its CLI's default. A skill's is
 * whether the agent has it on, null once the skill is gone.
 */
async function valueNow(
  db: Executor,
  of: Agent,
  line: Pick<ReceiptLine, "field" | "channelId" | "skillId" | "person">,
) {
  const agent = await thinkingAgent(db, of, line);
  // Their own AI is gone (their conversation went back to the workspace's): no value a card or Undo holds.
  if (!agent) return { workspace: true };
  switch (line.field) {
    case "instructions":
      return agent.instructions;
    case "role":
      return agent.role;
    case "apps":
      return agentApps(db, agent.orgId, agent.id);
    case "name":
      return agent.name;
    case "look":
      return agent.appearance;
    case "reports_to":
      return agent.reportsToAgentId ?? null;
    case "group":
      return departmentOf(db, agent);
    case "model":
      return isComputerBrain(agent.brain) ? agent.brainModel : agent.model;
    case "effort":
      return agent.brainEffort ?? null;
    case "budget":
      return agent.monthlyBudgetNanoUsd;
    case "owner":
      return agent.ownerUserId;
    case "archive":
      return agent.archivedAt !== null;
    case "delete":
      return agent.deletedAt !== null;
    case "audience": {
      const { mode, userIds, roleIds } = audienceOf(agent);
      return { mode, userIds, roleIds };
    }
    case "ai_account":
      return { brain: agent.brain, accountId: agent.brainAccountId } satisfies AccountValue;
    case "skill":
      return skillOn(db, agent, line.skillId ?? "");
    default:
      return seatOf(db, agent.id, line.channelId ?? "");
  }
}

/** The department the agent is in, by name; null when it is in none. The card and the tool speak names, not ids. */
async function departmentOf(db: Executor, agent: Agent) {
  if (!agent.groupId) return null;
  const [row] = await db
    .select({ name: agentGroups.name })
    .from(agentGroups)
    .where(and(eq(agentGroups.orgId, agent.orgId), eq(agentGroups.id, agent.groupId)));
  return row?.name ?? null;
}

/** Department names aren't unique: a name two of them share is refused, never resolved to one of them. */
function departmentsNamed(db: Executor, orgId: string, name: string) {
  return db
    .select({ id: agentGroups.id })
    .from(agentGroups)
    .where(and(eq(agentGroups.orgId, orgId), eq(agentGroups.name, name)))
    .limit(2);
}

async function skillOn(db: Executor, agent: Agent, skillId: string) {
  if (!skillId) return null;
  const [row] = await db
    .select({ enabled: agentSkills.enabled })
    .from(skills)
    .leftJoin(agentSkills, and(eq(agentSkills.skillId, skills.id), eq(agentSkills.agentId, agent.id)))
    .where(and(eq(skills.orgId, agent.orgId), eq(skills.id, skillId), isNull(skills.deletedAt)));
  return row ? row.enabled === true : null;
}

async function seatOf(db: Executor, agentId: string, channelId: string) {
  const [seat] = await db
    .select({ autoReply: channelMembers.autoReply })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.agentId, agentId)));
  return seat ? seat.autoReply : null;
}

/** Sets one setting to `value` as `actorId`, through the editor the agent's page uses (it checks their right to). */
async function setValue(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  agentId: string,
  line: Pick<ReceiptLine, "field" | "channelId" | "skillId" | "person">,
  value: unknown,
) {
  const { db, pubsub } = deps;
  if (line.person && (line.field === "model" || line.field === "effort")) {
    // Their own AI is theirs alone (ADR 0137 §11): `mine` is the caller's, so anyone else would change their own.
    if (line.person !== actorId)
      throw new ForbiddenError("Only that person changes the AI their own conversation thinks with", "agent.not_owner");
    return void (await setAgentBrain(deps, actorId, orgId, agentId, { scope: "mine", [line.field]: value }));
  }
  switch (line.field) {
    // Whoever decides instructions (`review_memory`), who needn't edit the agent, or who edits it (`editsAgent`, ADR
    // 0085 addendum of 2026-11-17): written straight, as `updateAgent` would refuse the first.
    case "instructions": {
      const [membership, agent] = await Promise.all([
        requirePermission(db, actorId, orgId, "read"),
        getAgent(db, orgId, agentId),
      ]);
      if (!can(membership, "review_memory") && !(agent && editsAgent(agent, actorId, membership)))
        throw new ForbiddenError("Only its owner or an admin can put its instructions back", "action.not_allowed");
      await db
        .update(agents)
        .set({ instructions: String(value), updatedAt: new Date() })
        .where(eq(agents.id, agentId));
      invalidateOrg(orgId);
      // Text put back with a "## Learned" section moves it to memory again, as a save does.
      if ((await moveLearnedSections(db, orgId, { agentId, actorId })) > 0)
        await publishListChanged(pubsub, orgId, "memory");
      return;
    }
    case "role":
      return void (await updateAgent(db, actorId, orgId, agentId, { role: String(value) }, { pubsub }));
    case "apps":
      return void (await setAgentAccess(
        db,
        actorId,
        orgId,
        agentId,
        accessInputOf(value as Awaited<ReturnType<typeof agentApps>>),
      ));
    case "name":
      return void (await updateAgent(db, actorId, orgId, agentId, { name: String(value) }, { pubsub }));
    case "look":
      return void (await setAgentAppearance(
        db,
        actorId,
        orgId,
        agentId,
        value as Parameters<typeof setAgentAppearance>[4],
        { pubsub },
      ));
    case "reports_to":
      return void (await setReportsTo(deps, actorId, orgId, [
        { agentId, reportsToAgentId: typeof value === "string" ? value : null },
      ]));
    // A department: the editor resolves the name the card holds, and checks who may move an agent (ADR 0083).
    case "group": {
      const name = typeof value === "string" && value.trim() ? value.trim() : null;
      const named = name ? await departmentsNamed(db, orgId, name) : [];
      if (name && named.length === 0) throw new NotFoundError("That department is gone", "agent_group.not_found");
      if (named.length > 1)
        throw new ValidationError(`Two departments are called ${name}`, "agent_group.ambiguous", { name: name ?? "" });
      const [group] = named;
      return void (await moveAgentToGroup(deps, actorId, orgId, agentId, { groupId: group?.id ?? null }));
    }
    case "model": {
      const agent = await getAgent(db, orgId, agentId);
      if (agent && isComputerBrain(agent.brain))
        return void (await setAgentBrain(deps, actorId, orgId, agentId, { model: value }));
      return void (await updateAgent(db, actorId, orgId, agentId, { model: String(value) }, { pubsub }));
    }
    case "effort":
      return void (await setAgentBrain(deps, actorId, orgId, agentId, { effort: value }));
    case "budget":
      return void (await updateAgent(
        db,
        actorId,
        orgId,
        agentId,
        { monthlyBudgetNanoUsd: value as number | null },
        { pubsub },
      ));
    case "owner":
      return void (await updateAgent(db, actorId, orgId, agentId, { ownerUserId: value as string | null }, { pubsub }));
    case "archive":
      return value
        ? archiveAgent(db, actorId, orgId, agentId, pubsub)
        : unarchiveAgent(db, actorId, orgId, agentId, { pubsub });
    // Deleting stops its work and closes its missions outside the decision's transaction (`decideProposal`).
    case "delete":
      return;
    case "audience":
      return void (await setAgentAudience(
        db,
        actorId,
        orgId,
        agentId,
        value as Parameters<typeof setAgentAudience>[4],
      ));
    case "ai_account": {
      const to = value as AccountValue;
      if (!to.accountId || !isComputerBrain(to.brain))
        return void (await setAgentBrain(deps, actorId, orgId, agentId, { brain: "model" }));
      const [account] = await db
        .select({ machineId: machineAccounts.machineId })
        .from(machineAccounts)
        .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, to.accountId)));
      if (!account) throw new NotFoundError("That AI account is gone", "account.not_found");
      const agent = await getAgent(db, orgId, agentId);
      if (agent?.machineId !== account.machineId)
        await setAgentComputerTarget(deps, actorId, orgId, agentId, account.machineId, { wakeWaits: false });
      return void (await setAgentBrain(deps, actorId, orgId, agentId, { brain: to.brain, account: to.accountId }));
    }
    case "skill":
      return void (await setAgentSkills(db, actorId, orgId, agentId, [
        { skillId: line.skillId ?? "", enabled: value === true },
      ]));
    default: {
      const channelId = line.channelId ?? "";
      const now = await seatOf(db, agentId, channelId);
      if (value === null) return removeChannelMember(db, actorId, orgId, channelId, { agentId }, { pubsub });
      if (now === null)
        return addChannelMember(db, actorId, orgId, channelId, { agentId, autoReply: value === true }, { pubsub });
      return setChannelAgentAutoReply(db, actorId, orgId, channelId, agentId, value === true, { pubsub });
    }
  }
}

/** A row that deletes its agent for good (ADR 0082's rules, applied as whoever clicks). */
export const deletes = (p: Pick<Proposal, "settings">) => (p.settings ?? []).some((l) => l.field === "delete");

/** The row's group (all its lines share one). */
export const settingsGroup = (p: Pick<Proposal, "settings">) => SETTING_GROUP[p.settings?.[0]?.field ?? "model"];

/** The person whose own right-hand AI the row changes (`SettingLine.person`): they alone decide it. */
export const settingsPerson = (p: Pick<Proposal, "settings">) => p.settings?.find((l) => l.person)?.person ?? null;

const accountOwner = async (db: Executor, orgId: string, lines: SettingLine[]) => {
  const id = (lines.find((l) => l.field === "ai_account")?.to as AccountValue | undefined)?.accountId;
  if (!id) return null;
  const [row] = await db
    .select({ createdBy: machineAccounts.createdBy })
    .from(machineAccounts)
    .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, id)));
  return row?.createdBy ?? null;
};

/**
 * The agent a row's "Responde a" line puts its agent under (null: none). That changes the supervisor too, so only who
 * manages it as well decides the row, as `setReportsTo` checks (ADR 0085 addendum of 2026-11-17).
 */
const supervisorOf = (p: Pick<Proposal, "settings">) => {
  const to = (p.settings ?? []).find((l) => l.field === "reports_to")?.to;
  return typeof to === "string" ? to : null;
};

/**
 * Whether `actorId` may decide this row now (read at the click, never when it was proposed). Every line is about its
 * one agent, so "admin" is who manages that agent (`managesAgent`, ADR 0085 addendum of 2026-11-17), never who merely
 * holds the key; a line that puts it under another agent needs who manages that one too (`supervisorOf`).
 */
export async function maySettle(db: Database, actorId: string, p: Proposal) {
  const membership = await getMembership(db, actorId, p.orgId);
  if (!membership) return false;
  const group = settingsGroup(p);
  const agent = p.agentId ? await getAgent(db, p.orgId, p.agentId) : null;
  if (!agent) return false;
  const person = settingsPerson(p);
  if (person) return person === actorId;
  const admin = managesAgent(agent, actorId, membership);
  if (group === "admin") {
    const under = admin ? supervisorOf(p) : null;
    const supervisor = under ? await getAgent(db, p.orgId, under) : null;
    // A supervisor gone since is left to `setReportsTo`, which refuses the line with its reason.
    return admin && (!supervisor || managesAgent(supervisor, actorId, membership));
  }
  if (group === "editor") return editsAgent(agent, actorId, membership);
  if (group === "admin_or_owner") return admin || ownsAgent(agent, actorId, membership.roleIds);
  // An AI account's line is its owner's plan: the agent's one person, never a role (ADR 0085, addendum of 2026-11-21).
  return agent.ownerUserId === actorId && (await accountOwner(db, p.orgId, p.settings ?? [])) === actorId;
}

/**
 * Who the row goes to when the person who asked can't decide it ("Pedir a um admin"), the people `maySettle` lets
 * decide it: who manages its agent (`agentManagerIds`), its owner too when they may decide it, and for an `editor` row
 * whoever edits the agent (`agentEditorIds`: the people its editors name too, as a change to its role is sent). A row
 * that puts the agent under another goes only to who manages both (`supervisorOf`).
 */
export async function settingsDeciders(db: Database, p: Proposal): Promise<string[]> {
  const person = settingsPerson(p);
  if (person) return [person];
  const group = settingsGroup(p);
  if (group === "account") {
    const owner = await accountOwner(db, p.orgId, p.settings ?? []);
    return owner ? [owner] : [];
  }
  const agent = p.agentId ? await getAgent(db, p.orgId, p.agentId) : null;
  if (!agent) return [];
  if (group === "editor") return agentEditorIds(db, p.orgId, agent.id);
  const ids = new Set(await agentManagerIds(db, p.orgId, agent.id));
  if (group === "admin_or_owner") for (const id of await agentOwnerIds(db, p.orgId, agent)) ids.add(id);
  const under = group === "admin" ? supervisorOf(p) : null;
  if (under && (await getAgent(db, p.orgId, under))) {
    const theirs = new Set(await agentManagerIds(db, p.orgId, under));
    return [...ids].filter((id) => theirs.has(id));
  }
  return [...ids];
}

/** What a card may change on the right hand: what its Settings let admins change. */
const RIGHT_HAND_SETTINGS: ReadonlySet<SettingField> = new Set([
  "model",
  "effort",
  "budget",
  "audience",
  "name",
  "look",
  "skill",
]);

/** What a target's lines ask for, before `from` is read: `to`, and the channel for a channel line. */
export type WantedLine = Omit<SettingLine, "from">;

/**
 * Checks each wanted line against the agent as it is now and fills in `from`. A line that changes nothing or can't be
 * made is left off with why (English, for the agent). The right hand is part of the workspace: never archived, its
 * owner the workspace's, in no channel and never on a computer.
 */
export async function settingLines(
  db: Database,
  orgId: string,
  requesterId: string,
  agent: Agent,
  wanted: WantedLine[],
): Promise<{ lines: SettingLine[]; skipped: string[] }> {
  const who = `@${agent.handle}`;
  const lines: SettingLine[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (let w of wanted) {
    const key = `${w.field}:${w.channelId ?? w.skillId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isRightHand(agent) && !RIGHT_HAND_SETTINGS.has(w.field)) {
      skipped.push(`You can't change your own ${w.field.replace("_", " ")}: it is part of the workspace.`);
      continue;
    }
    // Their conversation thinks with their own AI when they chose one (ADR 0137 §11): that is the one they mean.
    if (
      isRightHand(agent) &&
      (w.field === "model" || w.field === "effort") &&
      (await personalBrain(db, orgId, requesterId))
    )
      w = { ...w, person: requesterId };
    const thinking = (await thinkingAgent(db, agent, w)) ?? agent;
    const why = await refusal(db, orgId, requesterId, thinking, w);
    if (why) {
      skipped.push(`${who}: ${why}`);
      continue;
    }
    const from = await valueNow(db, agent, w);
    // As it is stored, so Undo finds what it left.
    const to =
      w.field === "look"
        ? validateAppearance(w.to as Parameters<typeof validateAppearance>[0])
        : w.field === "model" && isComputerBrain(thinking.brain)
          ? normalizeBrainModel(thinking.brain, w.to, thinking.brainModel)
          : w.to;
    if (same(from, to)) {
      skipped.push(
        w.field === "skill"
          ? `${who} ${to ? "already has" : "doesn't have"} the skill ${w.label?.to ?? ""}.`
          : w.field === "group"
            ? `${who} ${to ? `already is in the department ${String(to)}` : "already is in no department"}.`
            : `${who} already has that ${w.field.replace("_", " ")}.`,
      );
      continue;
    }
    // The card names who it reported to: the agent's page knows only ids.
    const label =
      w.field === "reports_to" && typeof from === "string"
        ? { ...w.label, from: (await getAgent(db, orgId, from))?.name }
        : w.label;
    const { pausesNow: _, ...asked } = w;
    const pausesNow = w.field === "budget" && (await spentPast(db, agent, to)) !== null;
    lines.push({ ...asked, to, from, ...(label ? { label } : {}), ...(pausesNow ? { pausesNow } : {}) });
  }
  return { lines, skipped };
}

/** Why a line can't be proposed (null: it can). */
async function refusal(db: Database, orgId: string, requesterId: string, agent: Agent, w: WantedLine) {
  switch (w.field) {
    case "name":
      return String(w.to).trim() ? null : "a name can't be empty.";
    case "look":
      try {
        validateAppearance(w.to as Parameters<typeof validateAppearance>[0]);
      } catch (error) {
        return error instanceof Error ? error.message : "that look can't be drawn";
      }
      return null;
    case "model":
      try {
        // On a computer any name its CLI may take goes, as under Quem pensa, but another maker's model, which its plan
        // can't run: the refusal says to give it an AI account that runs it first.
        if (isComputerBrain(agent.brain)) normalizeBrainModel(agent.brain, w.to, agent.brainModel);
        else await validateAgentFields(db, orgId, { model: String(w.to) });
      } catch (error) {
        if (!(error instanceof Error)) return "unknown model";
        const maker = error instanceof ValidationError ? error.params?.maker : null;
        // This card moves no agent off its plan onto an API key: its page does.
        const [key] =
          typeof maker === "string"
            ? await db
                .select({ id: providerCredentials.id })
                .from(providerCredentials)
                .where(
                  and(
                    eq(providerCredentials.orgId, orgId),
                    eq(providerCredentials.provider, maker),
                    isNull(providerCredentials.revokedAt),
                  ),
                )
                .limit(1)
            : [];
        return key
          ? `${error.message}, or the workspace's ${maker} API key, which only its page moves it to (Quem pensa); this card can't.`
          : error.message;
      }
      return null;
    case "effort":
      return w.to === null || isBrainEffortSetting(w.to) ? null : "an effort is auto, low, medium, high, xhigh or max.";
    case "budget": {
      if (w.to !== null && !(typeof w.to === "number" && Number.isFinite(w.to) && w.to >= 0))
        return "a budget is 0 or more, or the workspace's default.";
      const spent = await spentPast(db, agent, w.to);
      if (spent === null || w.pausesNow) return null;
      const usd = `US$ ${(spent / 1e9).toFixed(2)}`;
      return `that is at or below the ${usd} it spent this month, so it would stop at once. Ask for more than ${usd}, or send budget_cut: true when stopping it is the point.`;
    }
    case "owner":
      return typeof w.to === "string" && (await getMembership(db, w.to, orgId))
        ? null
        : "its owner must be a member of the workspace.";
    case "archive":
      return w.to === true ? null : "only archiving is proposed here.";
    case "delete":
      return w.to === true ? null : "only deleting is proposed here.";
    case "ai_account": {
      const id = (w.to as AccountValue | null)?.accountId;
      const [account] = id
        ? await db
            .select()
            .from(machineAccounts)
            .where(
              and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, id), eq(machineAccounts.status, "active")),
            )
        : [];
      if (!account || !isComputerBrain(account.kind)) return "no such AI account is connected.";
      return account.createdBy && account.createdBy === agent.ownerUserId
        ? null
        : "an AI account is given only by its owner, to an agent they own: its owner must own the agent first.";
    }
    case "audience":
      return null;
    case "skill":
      if (typeof w.to !== "boolean") return "say whether the skill goes on or off.";
      return (await skillOn(db, agent, w.skillId ?? "")) === null ? "no such skill is installed." : null;
    case "reports_to":
      if (w.to !== null && typeof w.to !== "string") return "say which agent, or none.";
      return reportsToRefusal(db, orgId, agent.id, w.to);
    case "group": {
      if (w.to === null) return null;
      if (typeof w.to !== "string" || !w.to.trim()) return "say which department, or none.";
      const name = w.to.trim();
      const named = await departmentsNamed(db, orgId, name);
      if (named.length > 1) return `two departments are called "${name}": ask the person to rename one of them first.`;
      return named.length ? null : `there is no department called "${name}" here.`;
    }
    default: {
      const [channel] = await db
        .select()
        .from(channels)
        .where(
          and(
            eq(channels.orgId, orgId),
            eq(channels.id, w.channelId ?? ""),
            eq(channels.kind, "channel"),
            isNull(channels.archivedAt),
            isNull(channels.deletedAt),
          ),
        );
      const open = channel?.visibility === "public" && !channel.dmKey;
      const [member] =
        channel && !open
          ? await db
              .select({ id: channelMembers.id })
              .from(channelMembers)
              .where(and(eq(channelMembers.channelId, channel.id), eq(channelMembers.userId, requesterId)))
          : [];
      if (!channel || (!open && !member)) return "no such channel the person who asked can see.";
      const seat = await valueNow(db, agent, w);
      if (w.field === "channel_add" && seat !== null) return `it is already in #${channel.name}.`;
      if (w.field !== "channel_add" && seat === null) return `it isn't in #${channel.name}.`;
      return null;
    }
  }
}

/**
 * This month's spend when a budget of `to` (null: the workspace's default) leaves the agent nothing, so it stops at
 * once; null when it doesn't.
 */
async function spentPast(db: Executor, agent: Agent, to: unknown): Promise<number | null> {
  const budget = typeof to === "number" ? to : await orgDefaultAgentBudget(db as Database, agent.orgId);
  const { spentNanoUsd: spent } = await agentBudgetState(db as Database, agent.orgId, agent.id);
  return budget <= spent ? spent : null;
}

/**
 * Whether a row still applies as its card shows it: each `from` is the agent's value now, and a budget the card
 * didn't say stops the agent still doesn't (the month's spend grows while a card waits).
 */
export async function settingsHold(db: Executor, agent: Agent, lines: SettingLine[]) {
  for (const l of lines) {
    if (!same(await valueNow(db, agent, l), l.from)) return false;
    if (l.field === "budget" && !l.pausesNow && (await spentPast(db, agent, l.to)) !== null) return false;
  }
  return true;
}

/** The rows for one agent's lines: one per decider group, each with the hash of what it was made against. */
export function settingsRows(lines: SettingLine[]) {
  const groups = new Map<string, SettingLine[]>();
  for (const l of [...lines].sort((a, b) => ORDER.indexOf(a.field) - ORDER.indexOf(b.field))) {
    const group = l.person ? "person" : SETTING_GROUP[l.field];
    groups.set(group, [...(groups.get(group) ?? []), l]);
  }
  return [...groups.values()].map((settings) => ({
    settings,
    baseHash: sha256(canonicalJson(settings.map((l) => [l.field, l.channelId ?? l.skillId ?? null, l.from]))),
  }));
}

/**
 * Applies an accepted row as `actorId` (its agent locked by the caller): false when a setting moved since it was
 * proposed (stale). Each line through the page's own editor, so it never does more than they could there.
 */
export async function applySettings(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  p: Proposal,
  agent: Agent,
) {
  const lines = p.settings ?? [];
  if (!(await settingsHold(deps.db, agent, lines))) return false;
  for (const l of lines) await setValue(deps, actorId, p.orgId, agent.id, l, l.to);
  return true;
}

/**
 * The receipt of an applied row, on the card's message (ADR 0037's Undo): the person who clicked may undo it, as may
 * an admin. The lines carry what Undo puts back.
 */
export async function recordSettingsReceipt(
  db: Executor,
  p: Proposal,
  actorId: string,
  card: { runId: string | null; messageId: string; channelId: string },
  agentName: string,
  undoWindowMs: number,
) {
  // A deleted agent can't come back: no Undo.
  if (!p.proposedByAgentId || deletes(p)) return;
  const now = new Date();
  await db.insert(agentActions).values({
    orgId: p.orgId,
    runId: card.runId,
    agentId: p.proposedByAgentId,
    channelId: card.channelId,
    messageId: card.messageId,
    requestedByUserId: actorId,
    kind: "agent.settings_changed",
    targetType: "agent",
    targetId: p.agentId ?? "",
    target: { title: agentName },
    params: {
      proposalId: p.id,
      agentName,
      fields: (p.settings ?? []).map((l) => l.field),
      lines: (p.settings ?? []) as unknown as Record<string, unknown>[],
    },
    createdAt: now,
    undoableUntil: new Date(now.getTime() + undoWindowMs),
  });
}

/** Undo (back to each `from`, last line first) or Redo, as `userId`; refused when a setting moved since. */
export async function revertSettings(
  deps: { db: Database; pubsub?: PubSub },
  a: typeof agentActions.$inferSelect,
  userId: string,
  direction: "undo" | "redo",
  changedSince: () => Error,
) {
  // An instructions, role or apps row keeps its texts off the receipt everyone in the conversation reads.
  const kept = (a.before as { lines?: ReceiptLine[] } | null)?.lines;
  const lines = (kept ?? (a.params as { lines?: ReceiptLine[] }).lines ?? []).slice();
  const steps = direction === "undo" ? lines.reverse() : lines;
  const agent = await getAgent(deps.db, a.orgId, a.targetId);
  if (!agent) throw new NotFoundError("The agent is gone", "action.target_gone");
  for (const l of steps)
    if (!same(held(l.field, await valueNow(deps.db, agent, l)), held(l.field, direction === "undo" ? l.to : l.from)))
      throw changedSince();
  for (const l of steps) await setValue(deps, userId, a.orgId, agent.id, l, direction === "undo" ? l.from : l.to);
  // Who it answers and its AI have no event of their own.
  await publishAgentsChanged(deps.pubsub, a.orgId);
}
