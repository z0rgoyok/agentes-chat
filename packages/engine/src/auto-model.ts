import { and, type Database, desc, type Executor, eq, isNull, schema } from "@agenteschat/db";
import {
  endpointModelId,
  isAutoModel,
  MODEL_TIERS,
  type ModelTier,
  modelForTier,
  modelInfo,
  parseCustomModel,
} from "@agenteschat/providers";
import type { Agent } from "./agents";
import { agentBrainSummaries, brainOf, CLAUDE_CODE_MODELS } from "./brain-settings";
import type { BrainPlan } from "./brains/select";
import type { BrainKind } from "./brains/types";
import { caches } from "./cache";
import { defaultCredentials, usableCredentialRow } from "./credentials";
import { cutText } from "./format";
import type { Judge } from "./judge";
import { missionOfThread } from "./missions";
import { orgModelProvider } from "./router";

/**
 * "Automático": an agent whose model (or effort) is `auto` gets them
 * picked per run. Before the first model call the judge reads the task and
 * answers two choices, the model tier (small, medium, large) and the effort
 * (low, medium, high); this module maps that one decision onto the brain the
 * run thinks with, the same way for all of them: the API model from the
 * catalog (Haiku, Sonnet, Opus; the OpenAI line when the agent's key is
 * OpenAI's), Claude Code's aliases, Codex's models. Auto never changes the
 * brain (API ↔ computer), never grants anything, and never blocks a run: no
 * answer in time is the medium tier with medium effort. The choice is kept on
 * the run's transcript (`autoModel`), so a run resumed after an approval or a
 * wait thinks with the same model; a new run decides again.
 */

export type AutoEffort = "low" | "medium" | "high";
export const AUTO_EFFORTS: readonly AutoEffort[] = ["low", "medium", "high"];

/** The judge answers within this, or the run starts on the medium tier with medium effort. */
export const AUTO_MODEL_TIMEOUT_MS = 1500;

/** What the judge decided for a run (or why it fell back). */
export interface AutoChoice {
  tier: ModelTier;
  effort: AutoEffort;
  /** One line, for the run's `context` step. */
  reason: string;
  /** "judge", or why it is medium/medium ("timeout", "error", "none": no judge, "kept": resumed without one). */
  source: "judge" | "timeout" | "error" | "none" | "kept";
}

/** Kept on the transcript: the choice and the API model it mapped to (stable if the keys change mid-run). */
export interface AutoModelRecord extends AutoChoice {
  apiModel?: string;
}

/** What a run that couldn't ask thinks with: the everyday model, ordinary effort. */
export function fallbackChoice(source: Exclude<AutoChoice["source"], "judge">): AutoChoice {
  const why: Record<typeof source, string> = {
    timeout: "The judge didn't answer in time",
    error: "The judge failed",
    none: "No judge on this server",
    kept: "Resumed without a choice",
  };
  return { tier: "medium", effort: "medium", reason: `${why[source]}: medium tier, medium effort.`, source };
}

/** Never the small tier: with a long tool list, the smallest models miss tools they have and give up on the task. */
const ACTING =
  "acting for the person with tools (opening a site, taking a screenshot, clicking or filling in a page, running a command, changing files, sending something)";

const TIER_CRITERIA: Record<ModelTier, string> = {
  small: `A quick, simple turn that only answers: a greeting or thanks, a short factual answer, a status, a yes/no. Little reasoning. Never ${ACTING}.`,
  medium: `Everyday work: an answer that needs some care, ${ACTING}, a few tool calls, a summary, an ordinary fix, document or routine check.`,
  large:
    "Hard or high-stakes work: deep reasoning, a long multi-step task, planning, a subtle bug, writing or reviewing substantial code, or a mistake would be costly.",
};

const EFFORT_CRITERIA: Record<AutoEffort, string> = {
  low: "Answer right away: the task is clear and short.",
  medium: "Think enough for an ordinary task.",
  high: "Think carefully and check the work: the task is hard, ambiguous or long.",
};

const TIER_REASON: Record<ModelTier, string> = {
  small: "a quick, simple turn",
  medium: "everyday work",
  large: "hard or long work",
};

const percent = (p: number | undefined) => (typeof p === "number" ? ` (${Math.round(p * 100)}%)` : "");

/**
 * The tier and effort for a run, in one judge request. Inputs: what the run
 * answers, the last messages, the agent's role, and what kind of run it is (a
 * routine's background work, a mission, a computer brain with code tools).
 * Never throws: without an answer in time it is the medium tier, medium effort.
 */
export async function chooseAutoModel(
  judge: Judge,
  input: {
    orgId: string;
    agentId?: string;
    runId?: string;
    agent: { name: string; role: string; instructions: string };
    message: string;
    /** The latest messages where it answers, oldest first ("person: text"). */
    recent: string[];
    /** Started by a routine (background work, nobody waiting on the answer). */
    routine: boolean;
    /** Part of a mission (its main session works through a plan). */
    mission: boolean;
    /** Thinks on a computer (Claude Code, Codex), with files and a shell. */
    computer: boolean;
    /** It has tools beyond the conversation. */
    tools: boolean;
    timeoutMs?: number;
  },
): Promise<AutoChoice> {
  const about =
    "An AI agent of a team (`agent`) is about to work on `message` (`recent` is what was said before it; `run` says whether a routine started it in the background, whether it is part of a mission, whether it works on a computer with files and a shell, and whether it has tools). Missions and code work usually need more; greetings and quick questions the least.";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), input.timeoutMs ?? AUTO_MODEL_TIMEOUT_MS);
  });
  try {
    const answers = await Promise.race([
      judge.ask({
        orgId: input.orgId,
        agentId: input.agentId,
        runId: input.runId,
        kind: "auto_model",
        state: {
          agent: {
            name: input.agent.name,
            role: input.agent.role,
            instructions: cutText(input.agent.instructions, 1500),
          },
          message: cutText(input.message, 2000),
          recent: input.recent.map((m) => cutText(m, 400)).join("\n"),
          run: {
            started_by_a_routine: input.routine,
            part_of_a_mission: input.mission,
            works_on_a_computer: input.computer,
            has_tools: input.tools,
          },
        },
        questions: {
          tier: {
            type: "choice",
            instructions: `${about} How capable a model does this task need?`,
            criteria: TIER_CRITERIA,
          },
          effort: {
            type: "choice",
            instructions: `${about} How hard should it think before and while answering?`,
            criteria: EFFORT_CRITERIA,
          },
        },
      }),
      timeout,
    ]);
    if (answers === "timeout") return fallbackChoice("timeout");
    const tier = answers.tier?.choice as ModelTier | undefined;
    const effort = answers.effort?.choice as AutoEffort | undefined;
    if (!tier || !MODEL_TIERS.includes(tier) || !effort || !AUTO_EFFORTS.includes(effort)) {
      return fallbackChoice("error");
    }
    const tierP = percent(answers.tier?.probabilities?.[tier]);
    const effortP = percent(answers.effort?.probabilities?.[effort]);
    const reason = `${TIER_REASON[tier]}${tierP}; ${effort} effort${effortP}.`;
    return { tier, effort, reason: reason.charAt(0).toUpperCase() + reason.slice(1), source: "judge" };
  } catch {
    return fallbackChoice("error");
  } finally {
    clearTimeout(timer);
  }
}

// ── One decision, mapped per brain ───────────────────────────────────────────

type AutoAgent = Pick<Agent, "model" | "brain" | "brainModel" | "brainEffort">;

/** The agent's effort is `auto` and it applies to this brain (its own computer brain, like `brainEffortFor`). */
const autoEffortFor = (agent: AutoAgent, kind: BrainKind) =>
  kind !== "model" && brainOf(agent.brain) === kind && isAutoModel(agent.brainEffort);

/** Some setting of the agent is `auto`: the judge is asked early, while the run's context is built. */
export const autoWanted = (agent: AutoAgent) =>
  isAutoModel(agent.model) ||
  (brainOf(agent.brain) !== "model" && (isAutoModel(agent.brainModel) || isAutoModel(agent.brainEffort)));

/** This run needs a choice: its API model (also what a fallback to the API uses), its brain's model or effort. */
export const needsAutoChoice = (agent: AutoAgent, plan: Pick<BrainPlan, "kind" | "model">) =>
  isAutoModel(agent.model) || isAutoModel(plan.model) || autoEffortFor(agent, plan.kind);

/** A computer brain's model for a tier: Claude Code's alias (`haiku`, `sonnet`, `opus`), a Codex model. */
export function brainModelForTier(kind: BrainKind, tier: ModelTier): string | undefined {
  if (kind === "claude_code") {
    const id = modelForTier("anthropic", tier);
    return CLAUDE_CODE_MODELS.find((o) => o.modelId === id)?.value ?? "sonnet";
  }
  if (kind === "codex") return modelForTier("openai", tier) ?? undefined;
  return undefined;
}

/** What auto sets for a run with this plan. */
export interface AutoApplied {
  /** The API model, when the agent's model is `auto` (the model brain, and a fallback to it). */
  apiModel?: string;
  /** The computer brain's model, when it is `auto` (undefined with `auto` set: the CLI's default). */
  brainModel?: string;
  /** The effort: the computer brain's when its effort is `auto`, the API's when its model is. */
  effort?: AutoEffort;
}

/** Per provider, the models a workspace chose for Automático's tiers (Settings, ADR 0087). */
export type AutoModels = Record<string, Partial<Record<ModelTier, string>>>;

/** The workspace's own models for Automático's tiers (`organization_settings.auto_models`), cached. */
export async function orgAutoModels(db: Executor, orgId: string): Promise<AutoModels> {
  return (await caches.orgs.getOrLoad(`${orgId}:auto-models`, async () => {
    const [row] = await db
      .select({ autoModels: schema.organizationSettings.autoModels })
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.orgId, orgId));
    return row?.autoModels ?? {};
  })) as AutoModels;
}

/**
 * A workspace endpoint's models as Automático reads them (ADR 0146): the credential whose key calls them, and the
 * models its admin chose with each one's last test call (`check`).
 */
export interface AutoEndpoint {
  credentialId: string;
  models: readonly { id: string; check?: "ok" | "no_tools" | "failed" }[];
}

/**
 * The API model for a tier on `provider`'s key: the workspace's own (`tiers`) while it is still on that line, else its
 * line's. A workspace endpoint has no line in the catalog (ADR 0146): one of its own models stands for the tier, since
 * only its key can call them and the Anthropic fallback below would be refused as no AI. Null for a `custom` provider
 * with no endpoint, and for OpenRouter before its list is read: its line is the list, and another provider's model
 * would need another key.
 */
export function autoModelFor(
  provider: string,
  tier: ModelTier,
  tiers?: Partial<Record<ModelTier, string>>,
  endpoint?: AutoEndpoint | null,
): string | null {
  const own = tiers?.[tier];
  // Another provider's (or another endpoint's) model needs another key: only this line's own pick stands.
  const ownHere = own
    ? provider === "custom"
      ? endpoint?.credentialId === parseCustomModel(own)?.credentialId
      : modelInfo(own)?.provider === provider
    : false;
  if (own && ownHere) return own;
  // An endpoint declares no catalog tiers: its one best model answers for every tier.
  if (provider === "custom") return endpoint ? endpointModelId(endpoint.credentialId, endpoint.models) : null;
  return modelForTier(provider, tier) ?? (provider === "openrouter" ? null : modelForTier("anthropic", tier));
}

/**
 * Maps a choice onto the run's brain (the one place that does): the API model
 * for the tier on `provider`'s key (`autoModelFor`), Claude Code's alias,
 * Codex's model, and the effort where the agent left it to auto. The API brain
 * takes the effort when its model is auto (a fixed model keeps the agent's own,
 * `brainEffortFor`). `apiModel` from a resumed run's record wins, so the run keeps its model.
 */
export function autoApplied(
  agent: AutoAgent,
  plan: Pick<BrainPlan, "kind" | "model">,
  choice: Pick<AutoModelRecord, "tier" | "effort" | "apiModel">,
  provider: string,
  tiers?: Partial<Record<ModelTier, string>>,
  endpoint?: AutoEndpoint | null,
): AutoApplied {
  const out: AutoApplied = {};
  if (isAutoModel(agent.model)) {
    const model = choice.apiModel ?? autoModelFor(provider, choice.tier, tiers, endpoint);
    if (model) out.apiModel = model;
  }
  if (plan.kind === "model") {
    if (isAutoModel(agent.model)) out.effort = choice.effort;
    return out;
  }
  if (isAutoModel(plan.model)) {
    const model = brainModelForTier(plan.kind, choice.tier);
    if (model) out.brainModel = model;
  }
  if (autoEffortFor(agent, plan.kind)) out.effort = choice.effort;
  return out;
}

/** The agent and plan a run thinks with: `auto` replaced by what was chosen (the cached agent row is not touched). */
export function withAuto<A extends AutoAgent>(
  agent: A,
  plan: BrainPlan,
  applied: AutoApplied,
): { agent: A; plan: BrainPlan } {
  const next: BrainPlan = { ...plan };
  if (isAutoModel(next.model)) {
    if (applied.brainModel) next.model = applied.brainModel;
    else delete next.model;
  }
  if (applied.effort) next.effort = applied.effort;
  return { agent: applied.apiModel ? { ...agent, model: applied.apiModel } : agent, plan: next };
}

/** The endpoint of a stored key, as Automático maps its tiers onto it; null for any other provider or a key without one. */
const endpointOf = (row: Awaited<ReturnType<typeof usableCredentialRow>>): AutoEndpoint | null => {
  const endpoint = row?.options.endpoint;
  return row?.provider === "custom" && endpoint ? { credentialId: row.id, models: endpoint.models } : null;
};

/**
 * The workspace's endpoint key behind `orgModelProvider`'s `custom` answer, in the order that reads the provider from:
 * its default key, else the newest one it has.
 */
async function orgEndpointKey(db: Executor, orgId: string) {
  const { legacy } = await defaultCredentials(db, orgId);
  const def = legacy ? await usableCredentialRow(db, orgId, legacy) : null;
  // A live default is where `orgModelProvider` read the provider from; a revoked one leaves the newest key.
  if (def) return def.provider === "custom" ? def : null;
  const [newest] = await db
    .select({ id: schema.providerCredentials.id })
    .from(schema.providerCredentials)
    .where(and(eq(schema.providerCredentials.orgId, orgId), isNull(schema.providerCredentials.revokedAt)))
    .orderBy(desc(schema.providerCredentials.createdAt))
    .limit(1);
  const row = newest ? await usableCredentialRow(db, orgId, newest.id) : null;
  return row?.provider === "custom" ? row : null;
}

/** What an `auto` API model thinks with: the provider of its key, and the endpoint whose own models stand for its tier. */
export interface AutoLine {
  provider: string;
  /** With `custom`: the workspace endpoint's models (ADR 0146). */
  endpoint?: AutoEndpoint;
}

/**
 * The line an `auto` API model comes from: the agent's own key's (unless revoked), else the organization's
 * (`orgModelProvider`: its default key's, its newest key's, else Anthropic) — with the workspace endpoint behind it, so a
 * `custom` key resolves to a model only that key can call.
 */
export async function autoLine(db: Executor, agent: Pick<Agent, "orgId" | "credentialId">): Promise<AutoLine> {
  if (agent.credentialId) {
    const own = await usableCredentialRow(db, agent.orgId, agent.credentialId);
    if (own) {
      const endpoint = endpointOf(own);
      return { provider: own.provider, ...(endpoint ? { endpoint } : {}) };
    }
  }
  const provider = await orgModelProvider(db, agent.orgId);
  if (provider !== "custom") return { provider };
  const endpoint = endpointOf(await orgEndpointKey(db, agent.orgId));
  return { provider, ...(endpoint ? { endpoint } : {}) };
}

/**
 * The provider whose line an `auto` API model comes from (`autoLine`): the agent's own key's (unless revoked), else the
 * organization's (`orgModelProvider`: its default key's, its newest key's, else Anthropic).
 */
export async function autoProvider(db: Executor, agent: Pick<Agent, "orgId" | "credentialId">): Promise<string> {
  return (await autoLine(db, agent)).provider;
}

/**
 * Each agent's brain summary for this viewer (`agentBrainSummaries`) and, for an API brain on Automático, the maker its
 * models come from (`autoProvider`), so the app shows that maker's logo and never a generic mark.
 */
export async function agentBrainLines(
  db: Database,
  viewerId: string,
  orgId: string,
  agents: readonly (Parameters<typeof agentBrainSummaries>[3][number] &
    Pick<Agent, "orgId" | "model" | "credentialId">)[],
) {
  const out = await agentBrainSummaries(db, viewerId, orgId, agents);
  for (const a of agents) {
    const line = out.get(a.id);
    if (line?.kind === "model" && isAutoModel(a.model)) out.set(a.id, { ...line, maker: await autoProvider(db, a) });
  }
  return out;
}

/** Whether the run answers in a mission's thread for this agent (read-only; the brain plan says it later too). */
export async function inMission(
  db: Executor,
  run: { orgId: string; agentId: string; threadRootId: string; triggerMessageId: string },
): Promise<boolean> {
  if (!run.threadRootId || run.threadRootId === run.triggerMessageId) return false;
  const mission = await missionOfThread(db, run.orgId, run.threadRootId);
  return Boolean(mission && mission.agentId === run.agentId);
}
