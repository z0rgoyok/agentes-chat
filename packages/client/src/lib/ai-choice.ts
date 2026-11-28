import { compareInOrder } from "@agenteschat/providers/plans";
import type { TFunction } from "i18next";
import type { ApiClient } from "../api/client";
import type {
  AccountUseReason,
  AgentBrainInput,
  AgentSetup,
  AiHub,
  AiHubAccount,
  AiHubKey,
  BrainEffortSetting,
  BrainKind,
  BrainOption,
  BrainScope,
  Model,
  ModelTier,
} from "../api/types";
import { ACCOUNT_KINDS, accountTitle, orderAccounts } from "./ai-accounts";
import { type EffortLevel, effortLevelsFor } from "./brain-advanced";
import { type ModelRow, modelRows } from "./brain-picker";
import { firstName } from "./format";
import { isPlanId, planOf } from "./plans";
import { AUTO, isAuto } from "./providers";

/*
 * The one "account + model + effort" choice (web and phone): which AI a target thinks with, built from "Contas de IA"
 * (`AiHub`) for every picker, so the rows, their order and why one can't be used are worked out once.
 */

/** What is being chosen for. */
export type AiChoiceTarget =
  | { kind: "agent"; agentId: string }
  /** Lodi: the viewer's own AI (`mine`, "A do workspace" first) or the workspace's (admins). */
  | { kind: "lodi"; agentId: string; scope: BrainScope }
  /** An agent still being created: the choice is the caller's to apply once it exists. */
  | { kind: "newAgent" }
  | { kind: "mission"; missionId: string }
  /** "Usar em outros agentes": one setup on several agents. */
  | { kind: "agents"; agentIds: readonly string[] }
  /** "Automático" on a provider's key: the model of one tier. */
  | { kind: "autoTier"; provider: string; tier: ModelTier };

/** A choice: what to think with, its model and effort. */
export interface AiChoice {
  brain: BrainKind;
  /** A plan's account; null: the computer's own sign-in. */
  account?: string | null;
  /** The API's key; null: the workspace's default. */
  key?: string | null;
  /**
   * The key an agent's calls take now with no `key` picked (`AgentBrain.keyId`: its own, else its provider's, which
   * may be no default): the row shown chosen. Never saved.
   */
  usesKey?: string;
  /** Where a plan thinks (its account's computer). */
  machineId?: string | null;
  /** null: the brain's default. */
  model?: string | null;
  effort?: BrainEffortSetting | null;
  /** Takes the account from the agent that thinks with it (a login made for one agent, `aiChoiceTakesFrom`). */
  moveAccount?: true;
}

/** The picker's sections, in order: Lodi's "A do workspace", the viewer's accounts, others' accounts, API keys. */
export type AiChoiceGroup = "workspace" | "yours" | "others" | "keys";
export const AI_CHOICE_GROUPS: readonly AiChoiceGroup[] = ["workspace", "yours", "others", "keys"];

/** One option of the "Conta" select. */
export interface AiChoiceRow {
  /** Stable: the account's id (its first login's), `key:` and the key's id, a brain kind (a mission), or `workspace`. */
  key: string;
  type: "plan" | "key" | "brain" | "workspace";
  group: AiChoiceGroup;
  brain: BrainKind;
  account?: AiHubAccount;
  /** A key's row: the key. "A do workspace": the workspace's default key, which it thinks with. */
  apiKey?: AiHubKey;
  /** Picking it works; else it shows dimmed with `reason`. */
  usable: boolean;
  reason?: AccountUseReason;
  selected: boolean;
}

export interface AiChoiceContext {
  target: AiChoiceTarget;
  viewerId: string;
  current: AiChoice | null;
  /** Only the accounts on this computer (an agent's: a plan thinks where its account is signed in). */
  machineId?: string | null;
  /** The accounts that may think for the target as the server says (an agent's "Quem pensa", `usable`). */
  usable?: ReadonlySet<string>;
  /** A mission's brains (it picks a brain and a model, never an account). */
  brains?: readonly BrainOption[];
}

const kindRank = (kind: string) => {
  const i = (ACCOUNT_KINDS as readonly string[]).indexOf(kind);
  return i < 0 ? ACCOUNT_KINDS.length : i;
};

/**
 * Every account's logins (`sameAs`), by maker, then in the one order of use with `viewerId`'s own first: the order of
 * the picker's rows and of "Contas de IA".
 */
export function hubAccountsInOrder<A extends AiHubAccount>(accounts: readonly A[], viewerId: string): A[][] {
  const inOrder = compareInOrder(viewerId);
  const first = (logins: readonly A[]) => logins[0] as A;
  return orderAccounts(accounts).sort(
    (x, y) => kindRank(first(x).kind) - kindRank(first(y).kind) || inOrder(first(x), first(y)),
  );
}

/**
 * Whether a choice on the API stands for this key: the one picked, else the one its calls take now (`usesKey`), else
 * the workspace's default.
 */
export const keyChosen = (c: AiChoice, k: AiHubKey): boolean =>
  c.key ? c.key === k.id : c.usesKey ? c.usesKey === k.id : k.isDefault;

/** The target thinks with keys too: not Lodi's own AI (its "A do workspace" is the workspace's key). */
const takesKeys = (t: AiChoiceTarget) => t.kind !== "mission" && !(t.kind === "lodi" && t.scope === "mine");

/** Why an account can't think for the target, or null when it can. */
function blocked(a: AiHubAccount, ctx: AiChoiceContext): AccountUseReason | null {
  if (a.status !== "active") return "signed_out";
  if (ctx.usable) return ctx.usable.has(a.id) ? null : (a.rights.useReason ?? "not_allowed");
  if (ctx.target.kind === "lodi" && ctx.target.scope === "workspace")
    return a.permissions.use.mode === "everyone" ? null : (a.rights.useReason ?? "not_allowed");
  return a.rights.canUse ? null : (a.rights.useReason ?? "not_allowed");
}

/**
 * The rows of the "Conta" select for a target, in the picker's order: Lodi's "A do workspace" first, then the viewer's
 * own accounts, others' accounts, then the API keys. Accounts by maker, then in the order of use (`compareInOrder`, the
 * viewer's own first); the logins of one account (`sameAs`) are one row. Accounts the target can't think with stay,
 * dimmed, with why. `autoTier`: that provider's keys only.
 */
export function aiChoiceRows(hub: AiHub | null | undefined, ctx: AiChoiceContext): AiChoiceRow[] {
  const { target, current } = ctx;
  const rows: AiChoiceRow[] = [];
  if (target.kind === "mission") {
    for (const o of ctx.brains ?? []) {
      rows.push({
        key: o.kind,
        type: "brain",
        group: o.kind === "model" ? "keys" : "yours",
        brain: o.kind,
        usable: o.available,
        selected: current?.brain === o.kind,
      });
    }
    return rows;
  }
  if (target.kind === "lodi" && target.scope === "mine") {
    // "A do workspace" thinks with the workspace's default key: the row names it.
    const defaultKey = hub?.keys.find((k) => k.isDefault);
    rows.push({
      key: "workspace",
      type: "workspace",
      group: "workspace",
      brain: "model",
      ...(defaultKey ? { apiKey: defaultKey } : {}),
      usable: true,
      selected: !current || current.brain === "model",
    });
  }
  if (target.kind !== "autoTier" && hub) {
    const accounts = hub.accounts.filter((a) => !ctx.machineId || a.machineId === ctx.machineId);
    const firsts = hubAccountsInOrder(accounts, ctx.viewerId).map((logins) => ({
      logins,
      first: logins.find((l) => l.id === current?.account) ?? (logins[0] as AiHubAccount),
    }));
    for (const { logins, first } of firsts) {
      const why = blocked(first, ctx);
      rows.push({
        key: first.id,
        type: "plan",
        group: first.mine ? "yours" : "others",
        brain: first.kind,
        account: first,
        usable: why === null,
        ...(why ? { reason: why } : {}),
        selected: !!current?.account && logins.some((l) => l.id === current.account),
      });
    }
  }
  // A plan through its computer's own sign-in (no account row): the choice in use stays a row of its own.
  const own = (target.kind === "agent" || target.kind === "lodi") && current && current.brain !== "model";
  if (own && !current.account && !rows.some((r) => r.selected))
    rows.unshift({
      key: `own:${current.brain}`,
      type: "brain",
      group: "yours",
      brain: current.brain,
      usable: true,
      selected: true,
    });
  if (takesKeys(target) && hub) {
    const keys = target.kind === "autoTier" ? hub.keys.filter((k) => k.provider === target.provider) : hub.keys;
    for (const k of keys) {
      rows.push({
        key: `key:${k.id}`,
        type: "key",
        group: "keys",
        brain: "model",
        apiKey: k,
        usable: true,
        selected: current?.brain === "model" && keyChosen(current, k),
      });
    }
  }
  return AI_CHOICE_GROUPS.flatMap((g) => rows.filter((r) => r.group === g));
}

/**
 * The "Modelo" select for a row: a plan's models from its computer's brain options (`options`, Automático first), an
 * API key's from the catalog for its provider (its endpoint's own for a workspace endpoint), the chosen one checked.
 */
export function aiChoiceModels(
  t: TFunction,
  row: AiChoiceRow,
  ctx: { current: AiChoice | null; options: readonly BrainOption[]; models: readonly Model[] },
): ModelRow[] {
  if (row.type === "workspace") return [];
  const same = ctx.current?.brain === row.brain && (row.type !== "plan" || row.selected);
  if (row.type === "key") {
    const k = row.apiKey;
    const chosen = same ? (ctx.current?.model ?? AUTO) : AUTO;
    const list = ctx.models.filter((m) =>
      k?.endpoint ? m.endpoint?.credentialId === k.id : m.provider === k?.provider && m.pick !== false,
    );
    return [
      { value: AUTO, label: t("brain.auto.label"), sub: t("brain.auto.hint"), checked: isAuto(chosen) },
      ...list.map((m) => ({ value: m.id, label: m.label, checked: m.id === chosen })),
    ];
  }
  return modelRows(
    t,
    {
      brain: row.brain,
      effectiveModel: same ? (ctx.current?.model ?? null) : null,
      options: [...ctx.options],
      account: row.account?.id ?? null,
      accounts: row.account ? [row.account] : [],
    },
    planOf(row.account?.provider ?? undefined),
  );
}

/**
 * The "Esforço" select for a row: the levels its model takes (`effortLevelsOf`), `model` as the choice stores it (null:
 * the brain's default, an alias resolved through `options`); none for Lodi's "A do workspace".
 */
export const aiChoiceEfforts = (
  row: AiChoiceRow,
  model: string | null | undefined,
  options: readonly BrainOption[],
): readonly EffortLevel[] => (row.type === "workspace" ? [] : effortLevelsFor(row.brain, model, options));

/** The choice a row makes, keeping the model and effort on the same API key or plan kind. */
export function aiChoiceOf(row: AiChoiceRow, current: AiChoice | null): AiChoice {
  // Lodi's "A do workspace": the workspace's own AI, nothing of the person's to carry.
  if (row.type === "workspace") return { brain: "model" };
  const sameKey = current && row.apiKey && keyChosen(current, row.apiKey);
  const keep = current?.brain === row.brain && (row.type !== "key" || sameKey);
  const rest = keep
    ? { model: current?.model ?? null, effort: current?.effort ?? null }
    : { model: row.type === "key" ? AUTO : null, effort: null };
  if (row.type === "plan" && row.account)
    return { brain: row.brain, account: row.account.id, machineId: row.account.machineId, ...rest };
  if (row.type === "key")
    return { brain: "model", key: row.apiKey?.isDefault ? null : (row.apiKey?.id ?? null), ...rest };
  return { brain: row.brain, ...rest };
}

/** What an agent's or Lodi's "Quem pensa" saves for a choice (`PUT …/agents/{id}/brain`). */
export function aiChoiceBrainInput(choice: AiChoice, scope?: BrainScope): AgentBrainInput {
  return {
    ...(scope ? { scope } : {}),
    brain: choice.brain,
    ...(choice.brain !== "model" ? { account: choice.account ?? null } : {}),
    ...(choice.model !== undefined ? { model: choice.model } : {}),
    ...(choice.effort !== undefined ? { effort: choice.effort } : {}),
    ...(choice.moveAccount ? { moveAccount: true } : {}),
  };
}

/**
 * A pick that asks first, in a line under the select with one button: someone else's plan (its use counts on their
 * plan), or a login made for one agent that another agent thinks with (`takesFrom`: it moves here).
 */
export function aiChoiceAsks(row: AiChoiceRow, agentId: string): { owner?: string; takesFrom?: string } | null {
  const a = row.type === "plan" ? row.account : undefined;
  if (!a) return null;
  const others = a.shared === true ? [] : a.usedBy.filter((_, i) => a.usedByIds?.[i] !== agentId);
  const owner = !a.mine && a.ownerName ? firstName(a.ownerName) : undefined;
  if (!owner && others.length === 0) return null;
  return { ...(owner ? { owner } : {}), ...(others[0] ? { takesFrom: others[0] } : {}) };
}

/** The setup "Usar em outros agentes" applies for a choice (`POST …/agent-setup`). */
export function aiChoiceSetup(choice: AiChoice): AgentSetup {
  return {
    brain: choice.brain,
    model: choice.model ?? null,
    ...(choice.brain === "model"
      ? { key: choice.key ?? null }
      : { machineId: choice.machineId ?? null, account: choice.account ?? null }),
    ...(choice.effort !== undefined ? { effort: choice.effort } : {}),
  };
}

/**
 * An account's name where its plan shows beside it ("Trabalho", then "Max · de João"): someone else's and a key
 * account by their name alone, the viewer's own as every app titles it (`accountTitle`).
 */
export const accountShortName = (
  t: TFunction,
  a: Pick<AiHubAccount, "label" | "plan" | "email" | "mine" | "named" | "keyHint" | "provider">,
) => (!a.mine || a.keyHint != null || isPlanId(a.provider) ? a.label : accountTitle(t, a));

/** Why a row is dimmed, in words: its owner by name. */
export const reasonText = (t: TFunction, row: Pick<AiChoiceRow, "reason" | "account">) =>
  row.reason ? t(`aiAccounts.useReason.${row.reason}`, { owner: firstName(row.account?.ownerName ?? "") }) : "";

/** The agents a login made for one agent is taken from when `agentId` picks it (`moveAccount`). */
export const loginHolders = (account: { shared?: boolean; usedByIds?: string[] }, agentId: string) =>
  account.shared === true ? [] : (account.usedByIds ?? []).filter((id) => id !== agentId);

/**
 * A login taken from other agents, given back by Desfazer: what each of them thinks with is read before the move, and
 * the returned function puts it back, once this agent's own Desfazer has let go of the login. An agent whose AI can't be
 * read (not the person's to change) is left as the move left it.
 */
export async function giveBackLogin(
  agents: Pick<ApiClient["agents"], "brain" | "setBrain">,
  orgId: string,
  holderIds: readonly string[],
): Promise<() => Promise<void>> {
  const before = await Promise.all(
    holderIds.map((id) =>
      agents.brain(orgId, id).then(
        (b) => ({ id, brain: b.brain, account: b.account, model: b.model }),
        () => null,
      ),
    ),
  );
  return async () => {
    for (const b of before)
      if (b) await agents.setBrain(orgId, b.id, { brain: b.brain, account: b.account, model: b.model });
  };
}
