import type {
  AgentBrain,
  AgentBrainInput,
  AiAccounts,
  BrainKind,
  Credential,
  Edition,
  MachineAccount,
  MachineAccountKind,
  PlanUsage,
} from "@agenteschat/client";
import { autonomyWords, type NewAgentStart } from "@agenteschat/client/lib/agent-setup";
import {
  type AccountChoice,
  accountAbout,
  accountChain,
  accountInLine,
  accountTitle,
  chainHasRoom,
  type ExistingAi,
  existingAi,
  groupPlans,
  haveAbout,
  haveGroup,
  lendable,
  lockedByOwner,
  lockedText,
  orderStep,
  ownSignInLower,
  pickable,
  signInOf,
  unnamedAccount,
} from "@agenteschat/client/lib/ai-accounts";
import { type AiChoice, aiChoiceBrainInput } from "@agenteschat/client/lib/ai-choice";
import { thinksWith } from "@agenteschat/client/lib/brain";
import { type Advanced, advancedDefaults, advancedParts } from "@agenteschat/client/lib/brain-advanced";
import {
  type BrainPick,
  brainPickInput,
  type ModelRow,
  modelInput,
  modelRows,
  needsOwnSignIn,
} from "@agenteschat/client/lib/brain-picker";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  aiChoiceOf,
  gateRechecks,
  type PlanChoice,
  type PlanGate,
  planOfAccount,
  planOfKind,
} from "@agenteschat/client/lib/no-ai";
import { planWord, roomWord } from "@agenteschat/client/lib/plan-usage";
import { brainPlan } from "@agenteschat/client/lib/plans";
import { AUTO, isAuto, keyLine } from "@agenteschat/client/lib/providers";
import { planState, sortHave } from "@agenteschat/ui/plan-state";
import type { TFunction } from "i18next";

/*
 * What only the phone's "Conectar uma IA" decides. Pure, so it is unit-tested.
 */

/**
 * "Usar uma chave de API agora" under a plan that can't sign in on the agent's computer yet. On the phone the key's
 * row is a page away, so every wait for the workspace's computer offers it, as do an offline computer, none and one
 * that can't take the plan, all but on a hold, when nothing runs and a key is no way around it.
 */
export const offersKeyNow = (gate: PlanGate, held: boolean) =>
  gate.state === "preparing"
    ? gate.view !== null && !held
    : !held && (gate.state === "offline" || gate.state === "missing" || gate.state === "unsupported");

/**
 * A page of the flow, each its own pushed screen: the first page (the two ways), every account already connected
 * ("Todas as contas"), the plans, one plan's page, the API key's, or that key's makers.
 */
export type FlowView =
  | { page: "home" }
  | { page: "have" }
  | { page: "plans" }
  | { page: "plan"; choice: PlanChoice }
  | { page: "key" }
  | { page: "makers" };

/** The flow's steps, counted in its bar's subtitle ("1 de 3"): the way, the sign-in or the key, done. */
export const FLOW_STEPS = 3;

/** The step a page stands for: the two ways and what the person has first, any page after them second, done last. */
export const flowStep = (view: FlowView, done: boolean) =>
  done ? FLOW_STEPS : view.page === "home" || view.page === "have" ? 1 : 2;

/** How often a plan's page asks again while it waits (the web's first run asks as often). */
export const PLAN_POLL_MS = 5000;

/**
 * Whether the plan shown waits on something no event may bring (the first run opens no socket): the workspace's
 * computer on its way, the views not in yet, or what passes by itself (`gateRechecks`: a computer offline, the Cloud's
 * installing or updating a program). Ready, missing, locked and the rest of unsupported stay put until the person does
 * something.
 */
export const pollsPlan = (gate: PlanGate, edition: Edition | null) =>
  gate.state === "preparing" || gate.state === "loading" || gateRechecks(gate, edition);

/* The agent's AI on the phone (the web's "Quem pensa", ADR 0059): what its page lists and reads. */

/** The kind of account a plan brain thinks with; null on the API. */
export const accountKindOf = (brain: BrainKind | undefined): MachineAccountKind | null =>
  brain === "claude_code" || brain === "codex" ? brain : null;

/**
 * The accounts the agent's page lists, as the web's picker: its owner's of that kind (a plan thinks only for its
 * owner's agents, ADR 0059 §3), which its owner or an admin picks, and someone else's only while it is this agent's,
 * or every one of that kind for whoever may use other people's plans (`canUseOthersPlans`) where it is `lendable`.
 */
export const agentAccounts = (
  view: Pick<AgentBrain, "accounts" | "account" | "canUsePlans" | "canUseOthersPlans">,
  kind: MachineAccountKind,
  ownerUserId: string | null | undefined,
  agentName = "",
) =>
  view.accounts.filter(
    (a) =>
      a.kind === kind &&
      ((view.canUsePlans ? a.mine : a.ownerId === ownerUserId) ||
        a.id === view.account ||
        (view.canUseOthersPlans === true && a.ownerId !== ownerUserId && lendable(a, agentName))),
  );

/**
 * Where its runs go at a limit (ADR 0041 §6, as the web's "Quem pensa"): `moves`, another account follows its own in
 * the order; `waits`, its own is at its limit and none of the others has room, so it is the agent that waits.
 */
export function agentChain(
  view: Pick<AgentBrain, "accounts" | "account" | "accountPinned" | "scope">,
  agentId: string,
  ownerUserId: string | null | undefined,
) {
  const chain = accountChain(view.accounts, {
    id: agentId,
    ownerId: ownerUserId ?? null,
    account: view.account,
    pinned: view.accountPinned === true,
    ...(view.scope ? { scope: view.scope } : {}),
  });
  const limited = (a: MachineAccount) => (a.usage ? planState(a.usage).state === "limited" : false);
  const own = chain[0];
  return { moves: chain.length > 1, waits: own !== undefined && limited(own) && !chainHasRoom(chain, limited) };
}

/** The plan usage of what it thinks with: its account's, or the computer's own sign-in's where that thinks for it. */
export function thinkingUsage(
  view: Pick<AgentBrain, "accounts" | "account" | "ownSignIn" | "ownUsage">,
  kind: MachineAccountKind,
): PlanUsage | undefined {
  if (view.account === null) return view.ownSignIn ? view.ownUsage[kind] : undefined;
  return view.accounts.find((a) => a.id === view.account)?.usage ?? undefined;
}

/**
 * The other agents an account thinks for now: picking it takes it from them ("Mover para cá"). One made for all of
 * its owner's agents there (`shared`) takes it from nobody: they think with it too ("Também usada por").
 */
export const takenFrom = (account: Pick<MachineAccount, "usedBy" | "shared">, agentName: string) =>
  account.shared === true ? [] : account.usedBy.filter((n) => n !== agentName);

export { type ModelRow, modelInput, modelRows };

/** The model page's lists: one, or on a plan of several makers' models Automático's and one per maker. */
export function modelSections(rows: ModelRow[]): { maker?: string; rows: ModelRow[] }[] {
  const sections: { maker?: string; rows: ModelRow[] }[] = [];
  for (const r of rows) {
    const last = sections.at(-1);
    if (last && last.maker === r.maker) last.rows.push(r);
    else sections.push({ ...(r.maker ? { maker: r.maker } : {}), rows: [r] });
  }
  return sections;
}

/**
 * What picking an account saves on the agent's page (null: the computer's own sign-in), where the account list is the
 * plan choice: the account, and on another plan that plan's default model (its models aren't this one's), Automático
 * staying Automático, as the web's cards do.
 */
export function accountInput(
  view: Pick<AgentBrain, "brain" | "account" | "accounts" | "effectiveModel">,
  a: Pick<MachineAccount, "id" | "kind" | "provider"> | null,
): Pick<AgentBrainInput, "account" | "model"> {
  const kind = accountKindOf(view.brain);
  const next = a ? planOfAccount(a) : kind ? planOfAccount({ kind, provider: null }) : null;
  if (next === aiChoiceOf(view)) return { account: a?.id ?? null };
  return { account: a?.id ?? null, model: isAuto(view.effectiveModel) ? AUTO : null };
}

type ThinkingView = Pick<AgentBrain, "brain" | "effectiveModel" | "options" | "accounts" | "account">;

/** What thinks, in the one sentence every place says it: the model by the plan that pays for it, or the API's model. */
function thinksNow(t: TFunction, view: ThinkingView): string | undefined {
  const model = modelRows(t, view, brainPlan(view)).find((r) => r.checked)?.label;
  const ai = aiChoiceOf(view);
  return ai === "key" || !model ? model : thinksWith(t, ai, model);
}

/**
 * What the agent's page says once an account is saved (`saved`: the view the save returned): the account it now uses
 * (the computer's own sign-in as the account its owner's agents share), or, when the account was another plan's, what
 * thinks now, since its model changed with it (`accountInput`), as the web's cards say it.
 */
export function accountSaved(
  t: TFunction,
  _language: string,
  agentName: string,
  a: Pick<MachineAccount, "kind" | "label" | "plan" | "email" | "mine" | "named" | "keyHint" | "provider"> | null,
  input: Pick<AgentBrainInput, "model">,
  saved: ThinkingView,
): string {
  const g = agentGrammar(agentName);
  if ("model" in input) return t("agentPage.work.saved.brain", { ...g, brain: thinksNow(t, saved) ?? "" });
  return a
    ? t("agentPage.work.saved.account", { ...g, account: accountInLine(t, a) })
    : t("aiAccounts.done.savedAgent", { agent: agentName, label: ownSignInLower(t, saved.brain) });
}

/**
 * An account as the agent's AI lists it (its page and Connect an AI): its name and plan, the line under it, how full
 * its plan is on a line of its own (as the web's rows), its mark.
 */
export const accountRow = (t: TFunction, choice: AccountChoice<MachineAccount>, agentName: string, locale: string) => {
  const usage = choice.login.usage;
  const word = planWord(t, locale, usage ? planState(usage, Date.now()) : null);
  return {
    label: accountTitle(t, choice.login),
    unnamed: unnamedAccount(choice.login),
    sub: accountAbout(t, choice, agentName),
    ...(word ? { below: word } : {}),
    mark: choice.login.provider ?? choice.login.kind,
    off: signInOf(choice.login) === "signed_out",
  };
};

/**
 * Connect an AI's first rows: what the person already has for the agent and may pick (`existingAi`, `pickable`), each
 * row as it reads, with its group by owner (`haveGroup`). An account's line tells it apart (`haveAbout`), someone
 * else's says how much room its plan has, a workspace key the budget line under it.
 */
export function existingRows(
  t: TFunction,
  view: Pick<AgentBrain, "accounts" | "account" | "canUseOthersPlans">,
  keys: readonly Credential[],
  agentName: string,
  locale: string,
) {
  return pickable(existingAi(view, keys)).map((row: ExistingAi) => {
    const group = haveGroup(t, row);
    if (row.kind === "key") {
      return {
        key: row.key.id,
        row,
        group,
        label: row.key.label,
        sub: keyLine(t, row.key),
        below: t("agentPage.work.brain.modelText", agentGrammar(agentName)),
        mark: row.key.provider,
        off: false,
        usage: null,
        isKey: true,
        signIn: false,
      };
    }
    const a = row.choice.login;
    const state = a.usage ? planState(a.usage, Date.now()) : null;
    const word = a.mine ? planWord(t, locale, state) : roomWord(t, locale, state);
    return {
      key: a.id,
      row,
      group,
      label: accountTitle(t, a),
      unnamed: unnamedAccount(a),
      sub: haveAbout(t, row, agentName),
      ...(word ? { below: word } : {}),
      mark: a.provider ?? a.kind,
      off: signInOf(a) === "signed_out",
      usage: a.usage,
      isKey: false,
      signIn: row.act !== "use" && row.act !== "move",
    };
  });
}

/** Someone else's accounts the person can't pick, one line per owner ("Mais 2 contas de Walter…"), by group key. */
export const existingNotes = (
  t: TFunction,
  view: Pick<AgentBrain, "accounts" | "account" | "canUseOthersPlans">,
  keys: readonly Credential[],
) => lockedByOwner(existingAi(view, keys)).map((o) => ({ key: o.key, text: lockedText(t, o) }));

/** Up to this many rows the first page groups them all; past it, this many with most room and a row to the rest. */
export const HAVE_SHOWN = 3;

/**
 * How the first page lays out what the person has, as the web's list: few rows by owner (theirs, the workspace's
 * keys, each other person's), each person's line of accounts they can't give under their group; many rows the three
 * with most room (`sortHave`), the rest a row away ("Ver as N contas"), the lines under them. `all`: every row by
 * owner, whatever their number ("Todas as contas").
 */
export function haveLayout<R extends { group: { key: string; label: string }; usage: PlanUsage | null }>(
  rows: readonly R[],
  notes: readonly { key: string; text: string }[],
  all = false,
): { best: R[] | null; groups: { key: string; label: string | null; rows: R[]; note: string | null }[] } {
  if (!all && rows.length > HAVE_SHOWN) {
    return {
      best: sortHave(rows).slice(0, HAVE_SHOWN),
      groups: notes.map((n) => ({ key: n.key, label: null, rows: [], note: n.text })),
    };
  }
  const groups: { key: string; label: string | null; rows: R[]; note: string | null }[] = [];
  const order = (k: string) => (k === "mine" ? 0 : k === "keys" ? 1 : 2);
  for (const r of [...rows].sort((x, y) => order(x.group.key) - order(y.group.key))) {
    const g = groups.find((x) => x.key === r.group.key);
    if (g) g.rows.push(r);
    else groups.push({ key: r.group.key, label: r.group.label, rows: [r], note: null });
  }
  for (const n of notes) {
    const g = groups.find((x) => x.key === n.key);
    if (g) g.note = n.text;
    else groups.push({ key: n.key, label: null, rows: [], note: n.text });
  }
  return { best: null, groups };
}

/**
 * Contas de IA's own rows: the viewer's logins of one account (`groupPlans`) as one row, by its login for all agents
 * (else a signed-in one), with every agent on any of them and the newest usage; `logins`, all of them, and those
 * signed out or not checked (`signInNote`).
 */
export function ownAccountRows<A extends MachineAccount & { machineId: string }>(accounts: readonly A[]) {
  return groupPlans(accounts).flatMap(({ logins, usedBy, usage, signedOut, unknown }) => {
    const first = logins.find((l) => l.shared === true) ?? logins.find((l) => l.status === "active") ?? logins[0];
    return first
      ? [
          {
            account: { ...first, usedBy: [...new Set(usedBy)], usage: usage ?? first.usage },
            logins,
            signedOut,
            unknown,
          },
        ]
      : [];
  });
}

/**
 * "Usar em outros agentes" on the phone (ADR 0094): the agent's saved setup in words, as the web's dialog says it
 * ("Opus pelo plano do Claude · Esforço alto · Autonomia: Não pergunta"): the model by the plan that pays for it (the
 * API's model alone), what differs in its advanced settings and its Autonomia.
 */
export function setupWords(
  t: TFunction,
  language: string,
  view: Pick<AgentBrain, "brain" | "effectiveModel" | "options" | "accounts" | "account" | "autonomy">,
  o: { now: Advanced },
): string {
  const parts = advancedParts(t, language, {
    kind: view.brain,
    autoModel: isAuto(view.effectiveModel),
    // The workspace's setup for a key carries no effort yet (ADR 0041, amended 2026-11-12): its words name none.
    now: view.brain === "model" ? { ...o.now, effort: null } : o.now,
  });
  const autonomy = view.autonomy ? autonomyWords(t, view.autonomy) : null;
  return [thinksNow(t, view), ...parts, autonomy].filter(Boolean).join(" · ");
}

/**
 * What "Voltar ao padrão" saves (`advancedDefaults`). On a key a chosen effort goes back to none (`auto`, the
 * provider's default), "Automático" too; on a computer "Automático" keeps picking its own.
 */
export function advancedResetInput(
  view: Pick<AgentBrain, "brain" | "onlyOwner">,
  now: Advanced,
  autoModel: boolean,
): AgentBrainInput {
  const to = advancedDefaults(view.brain, now);
  return {
    contextTokens: to.contextTokens,
    ...(view.brain === "model"
      ? now.effort === null
        ? {}
        : { effort: AUTO }
      : {
          ...(autoModel ? {} : { effort: to.effort }),
          ...(to.speed !== now.speed ? { speed: to.speed } : {}),
          ...(to.onlyOwner !== view.onlyOwner ? { onlyOwner: to.onlyOwner } : {}),
          ...(now.accountPinned ? { accountPinned: false } : {}),
        }),
  };
}

/**
 * What the phone's Criar agente sends for who thinks (ADR 0094): the last setup's API model and key at creation, and
 * its context window right after; or Automático there and the last setup's plan saved on it right after; with no
 * setup, Automático on the API. The setup's Autonomia goes at creation either way.
 */
export function newAgentAi(thinks: NewAgentStart | null): {
  model: string;
  credentialId: string | null;
  contextTokens: number | null;
  /** Saved right after (on `machineId` first, when there is one). */
  plan: { machineId: string | null; input: AgentBrainInput } | null;
  autonomy: NewAgentStart["autonomy"] | undefined;
  /** A plan to connect once the agent exists (`pickedAi`). */
  connect: PlanChoice | null;
} {
  const autonomy = thinks?.autonomy;
  if (thinks?.brain === "model") {
    return {
      model: thinks.model,
      credentialId: thinks.key,
      contextTokens: thinks.contextTokens,
      plan: null,
      autonomy,
      connect: null,
    };
  }
  return {
    model: AUTO,
    credentialId: null,
    contextTokens: null,
    plan: thinks ? { machineId: thinks.machineId, input: thinks.input } : null,
    autonomy,
    connect: null,
  };
}

/**
 * What a pick in the phone's "Quem pensa" sends, as the web's step: an API model at creation; or Automático there and
 * the plan saved right after; or, for a plan with nothing to think with yet, Connect on it once the agent exists (also
 * a computer's own sign-in that can't think for the person's agent yet: `computers`, `useAiAccounts`).
 */
export function pickedAi(
  pick: BrainPick,
  computers: AiAccounts["computers"] | undefined,
): ReturnType<typeof newAgentAi> {
  const none = { credentialId: null, contextTokens: null, plan: null, autonomy: undefined, connect: null };
  if (pick.kind === "model") return { ...none, model: pick.model };
  if (pick.kind === "connect") return { ...none, model: AUTO, connect: pick.choice };
  return {
    ...none,
    model: AUTO,
    plan: { machineId: pick.machineId, input: brainPickInput(pick) },
    connect: needsOwnSignIn(computers, pick) ? planOfKind(pick.kind) : null,
  };
}

/**
 * What Criar agente's "Quem pensa" shows before anything is picked there, as the web's: a plan account it starts on
 * (`plan`), else the last setup, else Automático on the API when something runs it (`anyModel`); null: nothing thinks.
 */
export function newAgentChoice(
  plan: BrainPick | undefined,
  start: NewAgentStart | null,
  anyModel: boolean,
): AiChoice | null {
  if (plan && "machineId" in plan)
    return { brain: plan.kind, machineId: plan.machineId, account: plan.accountId ?? null, model: null };
  if (start?.brain === "model") return { brain: "model", model: start.model, key: start.key };
  if (start)
    return {
      brain: start.brain,
      machineId: start.machineId,
      account: start.account?.id ?? null,
      model: start.input.model ?? null,
      ...(start.input.effort !== undefined ? { effort: start.input.effort } : {}),
    };
  return anyModel ? { brain: "model", model: AUTO, key: null } : null;
}

/**
 * What a choice made in Criar agente's "Quem pensa" sends, as the web's: the API's model and key at creation (its
 * effort right after); or Automático there and the plan saved right after, on its computer.
 */
export function chosenAi(
  choice: AiChoice,
  autonomy: NewAgentStart["autonomy"] | undefined,
): ReturnType<typeof newAgentAi> {
  const none = { contextTokens: null, autonomy, connect: null };
  if (choice.brain === "model")
    return {
      ...none,
      model: choice.model ?? AUTO,
      credentialId: choice.key ?? null,
      plan: choice.effort != null ? { machineId: null, input: { effort: choice.effort } } : null,
    };
  return {
    ...none,
    model: AUTO,
    credentialId: null,
    plan: { machineId: choice.machineId ?? null, input: aiChoiceBrainInput(choice) },
  };
}

/**
 * Move up and Move down for `account` in its order of use (`orderStep`): only for whoever may move it, none at an end
 * nor for an account with no place.
 */
export function orderMoves(
  accounts: readonly { id: string; sameAs?: string; movable?: boolean }[],
  account: { id: string; canMove: boolean },
) {
  if (!account.canMove) return [];
  return ([-1, 1] as const).flatMap((step) => {
    const index = orderStep(accounts, account.id, step);
    return index === null ? [] : [{ step, index }];
  });
}
