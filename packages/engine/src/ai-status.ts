import { and, asc, type Executor, eq, inArray, isNull, ne, schema } from "@agenteschat/db";
import { ensureOpenRouterModels, isAutoModel, routerModelOf } from "@agenteschat/providers";
import type { Agent } from "./agents";
import { type AutoLine, autoLine, autoModelFor, autoProvider } from "./auto-model";
import { brainOf } from "./brain-settings";
import { brainAccountFor, computerBrainUnavailable, mayFallBack, NO_AI_CODES } from "./brains/select";
import { BRAIN_PLAN_NAMES, type BrainKind, type ComputerBrainKind, isComputerBrain } from "./brains/types";
import type { ModelGateway } from "./gateway";
import type { MachineStatus } from "./machine-hub";
import { TASK_OFFLINE_GRACE_MS } from "./machine-tasks";
import { missionTurnFor } from "./missions-engine";
import { isRightHand, membersAmong, rightHandNoAiReason, rightHandPerson, thinkingAgent } from "./right-hand";
import { orgKeyProviders, orgModelProvider, type RoutingSetup } from "./router";
import { planSignInsOf } from "./router-plan";
import type { AgentRun } from "./runs";

/**
 * Whether an agent has an AI to think with (ADR 0061), from what the engine already uses: a key for its
 * model brain, or its computer brain's availability (with the model brain as the fallback). `waiting`:
 * its computer is away for now (offline, paused, a plan limit), which is not "no AI". Computed per
 * request, with no cache and no secrets: no key is decrypted.
 */
export type AiState = "ready" | "no_ai" | "waiting";

/**
 * Why an agent has no AI, as its card and the Connect dialog put it (`cli_missing`: its computer has no such CLI). The
 * team's right hand on a plan also says its computer is away or had a problem, its plan is at its limit (or its model's own limit, or
 * the region that model needs), the plan answers only its owner, the computer's runner needs an update, commands or
 * the CLI are off there, or the plan's CLI there offers tools of its own (`rightHandNoAiReason`).
 */
export type NoAiReason =
  | "no_key"
  | "not_signed_in"
  | "no_computer"
  | "cli_missing"
  | "computer_away"
  | "computer_failed"
  | "cli_failed"
  | "plan_limit"
  | "model_limit"
  | "model_region"
  | "model_off"
  | "plan_inactive"
  | "commands_off"
  | "plan_not_shared"
  | "plans_not_yours"
  | "runner_outdated"
  | "plan_tools";

export interface AgentAi {
  state: AiState;
  /** With `no_ai`. */
  reason?: NoAiReason;
  /**
   * With `not_signed_in`: the CLI whose own sign-in isn't there on the computer, the agent having no account of its
   * own (ADR 0041 §1).
   */
  own?: "claude_code" | "codex" | "cursor" | "opencode" | "grok" | "antigravity";
  /**
   * Ready on an API key with Automático: the maker of the key it thinks with, which the apps name it by ("Claude"), as
   * the right hand's panel names its key. Asked with no run only (the apps' question).
   */
  provider?: string;
  /**
   * With `plans_not_yours`: the workspace has plans, but each serves only the person who connected it. `owner` is that
   * person's name and `plan` what the plan is ("Claude"), for "o Claude daqui é só do Walter".
   */
  owner?: string;
  plan?: string;
}

export interface AiStatusDeps {
  db: Executor;
  gateway: Pick<ModelGateway, "hasModelCredential">;
  /** Computers' status (the machine hub); absent: a computer brain with a computer counts as ready. */
  machines?: { status(machineId: string): Promise<MachineStatus | null> } | null;
}

type AiAgent = Pick<
  Agent,
  "orgId" | "model" | "credentialId" | "brain" | "brainFallback" | "brainAccountId" | "machineId"
> &
  Partial<Pick<Agent, "builtin" | "ownerUserId" | "planForOthers">>;

/** The run being checked: a mission's turn thinks with the mission's brain, and background work never falls back. */
type AiRun = Pick<AgentRun, "id" | "orgId" | "agentId" | "threadRootId" | "triggerMessageId" | "background">;

const READY: AgentAi = { state: "ready" };

/** The model brain can be called. `auto` isn't in the catalog: its line's everyday model stands for it. */
async function modelReady(deps: AiStatusDeps, agent: AiAgent): Promise<boolean> {
  if (!isAutoModel(agent.model)) return deps.gateway.hasModelCredential(agent);
  const { provider, endpoint } = await autoLine(deps.db, agent).catch((): AutoLine => ({ provider: "anthropic" }));
  // OpenRouter's line is its list.
  if (provider === "openrouter") await ensureOpenRouterModels();
  const model = autoModelFor(provider, "medium", undefined, endpoint);
  // OpenRouter's list not read: `autoLine` found its key, and a run waits the outage out.
  if (!model) return provider === "openrouter";
  return deps.gateway.hasModelCredential({ ...agent, model });
}

/** The card's reason for an unavailable code in `NO_AI_CODES`. */
export const noAiReasonOf = (code: string): NoAiReason =>
  code === "not_logged_in" ? "not_signed_in" : code === "no_computer" ? "no_computer" : "cli_missing";

/** `not_logged_in` with no account of the agent's: the computer's own sign-in of that CLI isn't there (`own`). */
export const ownNotSignedIn = (code: string, kind: BrainKind, account: unknown): Pick<AgentAi, "own"> =>
  code === "not_logged_in" && !account && isComputerBrain(kind) ? { own: kind } : {};

/**
 * One agent (for one run, when given: right after its row is read, before any judge or model call). `viewer`: with no
 * run, whose DM with the right hand it is asked for (its AI is each person's own, §11). `background`: for work no
 * person is behind (`backgroundAiState`).
 */
export async function agentAiState(
  deps: AiStatusDeps,
  given: AiAgent,
  run?: AiRun,
  viewer?: string,
  background = false,
): Promise<AgentAi> {
  const person = run ? await rightHandPerson(deps.db, given, run) : (viewer ?? null);
  const agent = await thinkingAgent(deps.db, given, person);
  // The workspace's plan while it serves only its owner: it thinks for nobody else, so for no work nobody is behind
  // either (its run refuses that as `plan_unattended`). A person it doesn't serve had no plan that does
  // (`servingPlanFor`): the line names whose the plans are.
  if (isRightHand(agent) && brainOf(agent.brain) !== "model" && !agent.planForOthers) {
    if (person && person !== agent.ownerUserId)
      return (await plansNotYours(deps.db, agent.orgId, person)) ?? { state: "no_ai", reason: "plan_not_shared" };
    if (!person && background) return { state: "no_ai", reason: "plan_not_shared" };
  }
  const mission = run ? await missionTurnFor(deps.db, run).catch(() => null) : null;
  const kind = mission?.brain ?? brainOf(agent.brain);
  if (kind === "model") {
    if (!(await modelReady(deps, agent))) {
      const notYours = person && isRightHand(agent) ? await plansNotYours(deps.db, agent.orgId, person) : null;
      return notYours ?? { state: "no_ai", reason: "no_key" };
    }
    if (run || !isAutoModel(agent.model)) return READY;
    const provider = await autoProvider(deps.db, agent).catch(() => null);
    return provider ? { state: "ready", provider } : READY;
  }
  const machineId = mission?.session?.machineId ?? agent.machineId ?? null;
  const [status, account] = await Promise.all([
    machineId && deps.machines ? deps.machines.status(machineId).catch(() => null) : null,
    brainAccountFor(deps.db, agent, kind, machineId),
  ]);
  const unavailable =
    machineId && !deps.machines ? null : computerBrainUnavailable(kind, machineId, status, Date.now(), account);
  if (!unavailable) return READY;
  if (mayFallBack(agent, { background: background || (run?.background ?? false) }) && (await modelReady(deps, agent)))
    return READY;
  if (NO_AI_CODES.has(unavailable.code))
    return {
      state: "no_ai",
      reason: noAiReasonOf(unavailable.code),
      ...ownNotSignedIn(unavailable.code, kind, account),
    };
  // The right hand never waits for its plan (ADR 0137 §7): its background work has no AI while that plan can't think,
  // unless its run waits for the computer first (`computerBackSoon`): one in standby, which it wakes, or one gone less
  // than the outage grace (its runner dialing again). The codes left here are never `plan_hold` or `plan_unattended`.
  const gone = status?.lastSeenAt ? Date.now() - Date.parse(status.lastSeenAt) : Number.POSITIVE_INFINITY;
  const backSoon = status?.standby || (unavailable.code === "machine_offline" && gone < TASK_OFFLINE_GRACE_MS);
  if (background && isRightHand(agent) && !backSoon)
    return { state: "no_ai", reason: rightHandNoAiReason(unavailable.code) as NoAiReason };
  return { state: "waiting" };
}

/**
 * `plans_not_yours` for `person`: the workspace has a signed-in plan, but each serves only the person who connected it
 * (ADR 0059 §3), named with the oldest one's owner. Null when there is none.
 */
async function plansNotYours(db: Executor, orgId: string, person: string): Promise<AgentAi | null> {
  const { machineAccounts, organizationMembers, users } = schema;
  const [row] = await db
    .select({ kind: machineAccounts.kind, owner: users.name })
    .from(machineAccounts)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, machineAccounts.orgId),
        eq(organizationMembers.userId, machineAccounts.createdBy),
      ),
    )
    .innerJoin(users, eq(users.id, machineAccounts.createdBy))
    .where(
      and(
        eq(machineAccounts.orgId, orgId),
        eq(machineAccounts.status, "active"),
        eq(machineAccounts.serves, "owner"),
        ne(machineAccounts.createdBy, person),
      ),
    )
    .orderBy(asc(machineAccounts.createdAt))
    .limit(1);
  if (!row) return null;
  const plan = isComputerBrain(row.kind as BrainKind) ? BRAIN_PLAN_NAMES[row.kind as ComputerBrainKind] : "Claude";
  return { state: "no_ai", reason: "plans_not_yours", owner: row.owner, plan };
}

/**
 * What an agent's background work (a routine, a widget's build) thinks with: never the model brain standing in for its
 * computer brain (ADR 0053 §6.4), and for the right hand the workspace's own AI, nobody's (ADR 0137 §11), which
 * neither answers work nobody asked for while it serves only its owner nor waits for its computer. Work a person set
 * up thinks for them first (`rightHandWorkAi`).
 */
export const backgroundAiState = (deps: AiStatusDeps, agent: AiAgent) =>
  agentAiState(deps, agent, undefined, undefined, true);

/**
 * Whose AI the right hand's work nobody is behind thinks with (ADR 0137 §11): of the people who set it up, first to
 * last, the first still in the workspace for whom it can think (their own AI, else the workspace's as it answers
 * them), else the workspace's for nobody (`person` null). No AI at all: the first person's state, who it is for.
 */
export async function rightHandWorkAi(
  deps: AiStatusDeps,
  agent: AiAgent,
  people: readonly (string | null | undefined)[],
): Promise<{ person: string | null; ai: AgentAi }> {
  const named = await membersAmong(deps.db, agent.orgId, people);
  let first: { person: string | null; ai: AgentAi } | null = null;
  for (const person of [...named, null]) {
    const ai = await agentAiState(deps, agent, undefined, person ?? undefined, true);
    if (ai.state !== "no_ai") return { person, ai };
    first ??= { person, ai };
  }
  return first as { person: string | null; ai: AgentAi };
}

const agentFields = {
  id: schema.agents.id,
  orgId: schema.agents.orgId,
  model: schema.agents.model,
  credentialId: schema.agents.credentialId,
  brain: schema.agents.brain,
  brainFallback: schema.agents.brainFallback,
  brainAccountId: schema.agents.brainAccountId,
  machineId: schema.agents.machineId,
  builtin: schema.agents.builtin,
  planForOthers: schema.agents.planForOthers,
  ownerUserId: schema.agents.ownerUserId,
};

const activeAgents = (db: Executor, orgId: string) =>
  db
    .select(agentFields)
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), isNull(schema.agents.archivedAt)))
    .orderBy(asc(schema.agents.createdAt));

/**
 * Every agent that isn't archived, and `any`: at least one of them is ready or waiting for its computer. `background`:
 * its state for background work (`backgroundAiState`) where that differs from the one shown: a computer brain ready
 * only through the model brain's fallback, or the right hand, shown with `viewer`'s own AI.
 */
export async function orgAiStatus(deps: AiStatusDeps, orgId: string, viewer?: string) {
  const states = await Promise.all(
    (await activeAgents(deps.db, orgId)).map(async (a) => {
      const shown = await agentAiState(deps, a, undefined, viewer);
      const mayDiffer =
        isRightHand(a) || (shown.state === "ready" && brainOf(a.brain) !== "model" && a.brainFallback !== false);
      const background = mayDiffer ? (await backgroundAiState(deps, a)).state : shown.state;
      return { agentId: a.id, ...shown, ...(background === shown.state ? {} : { background }) };
    }),
  );
  return { any: states.some((s) => s.state !== "no_ai"), agents: states };
}

/** These agents' states (`agentAiState`) by id; archived agents and other organizations' are left out. */
export async function agentAiStates(deps: AiStatusDeps, orgId: string, agentIds: string[]) {
  const rows =
    agentIds.length === 0
      ? []
      : await deps.db
          .select(agentFields)
          .from(schema.agents)
          .where(
            and(eq(schema.agents.orgId, orgId), inArray(schema.agents.id, agentIds), isNull(schema.agents.archivedAt)),
          );
  return new Map(await Promise.all(rows.map(async (a) => [a.id, await agentAiState(deps, a)] as const)));
}

/** `orgAiStatus(…).any`, stopping at the first agent that has an AI (it runs before routing every message). */
export async function orgHasAi(deps: AiStatusDeps, orgId: string): Promise<boolean> {
  const agents = await activeAgents(deps.db, orgId);
  for (const agent of agents) {
    if ((await agentAiState(deps, agent)).state !== "no_ai") return true;
  }
  // A person's own AI for the right hand (§11) may be the only one: connecting a plan for it leaves its row on no AI.
  const rightHand = agents.find(isRightHand);
  if (!rightHand) return false;
  const people = await deps.db
    .select({ userId: schema.rightHandBrains.userId })
    .from(schema.rightHandBrains)
    .where(eq(schema.rightHandBrains.orgId, orgId));
  for (const { userId } of people) {
    if ((await agentAiState(deps, rightHand, undefined, userId)).state !== "no_ai") return true;
  }
  return false;
}

/**
 * Who picks the agents for a message nobody mentioned (ADR 0074), as Settings and the members menu say it:
 * `by` for the workspace, `mine` for the person asking (a plan picks only for its owner's own messages).
 */
export interface AiRouting {
  by: "jev" | "model" | "plans" | "rules" | "off";
  mine: "jev" | "model" | "plan" | "rules" | "off";
  /** The small model, while it picks. */
  model: string | null;
  /** With `rules`: the default key's provider, which has no small model (Kimi alone). */
  noSmallModel: string | null;
}

/**
 * The first step of the chain that can pick for this workspace now, without asking any. `off`: the router is
 * off. `apiKey`: a key of its own, or the server's own Claude key. No key is decrypted.
 */
export async function orgRouting(
  deps: AiStatusDeps,
  routing: RoutingSetup | null,
  orgId: string,
  userId: string,
): Promise<{ routing: AiRouting; apiKey: boolean }> {
  const keys = await orgKeyProviders(deps.db, orgId);
  const claude = routerModelOf("anthropic");
  const apiKey =
    keys.size > 0 ||
    (claude !== null && (await deps.gateway.hasModelCredential({ orgId, model: claude, credentialId: null })));
  const of = (by: AiRouting["by"], mine: AiRouting["mine"], model: string | null, noSmallModel: string | null) => ({
    routing: { by, mine, model, noSmallModel },
    apiKey,
  });
  if (!routing) return of("off", "off", null, null);
  if (await routing.jev()) return of("jev", "jev", null, null);
  const model = await routing.smallModel(orgId);
  if (model) return of("model", "model", model, null);
  const plans = routing.plans ? await planSignInsOf(deps.db, routing.plans, orgId) : [];
  const mine = plans.some((p) => p.ownerId === userId) ? "plan" : "rules";
  if (plans.length > 0) return of("plans", mine, null, null);
  return of("rules", mine, null, keys.size > 0 ? await orgModelProvider(deps.db, orgId) : null);
}
