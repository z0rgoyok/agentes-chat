import { catalogModelOf, MODEL_CATALOG } from "@agenteschat/providers/catalog";
import { ANTIGRAVITY_LEVEL, speedFits } from "@agenteschat/providers/plans";
import type { TFunction } from "i18next";
import type { AgentBrain, BrainKind, BrainOption, BrainSpeed } from "../api/types";
import { type ContextLimit, contextSize } from "./context-limits";
import { isAuto } from "./providers";

/*
 * "Configuração avançada" of an agent's AI (ADR 0086), the same on the web (a dialog over "Quem pensa") and the
 * phone (a screen from "Pensa com"): how it thinks (effort, context window) and who it answers ("Atende outras
 * pessoas", answering through the API while its computer is away). Its row names what is inside, a save says what
 * differs from the defaults.
 */

/** Every effort level, lowest first; a model takes some of them (`effortLevelsOf`). */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const UP_TO_HIGH: readonly EffortLevel[] = ["low", "medium", "high"];
const FIXED_PLAN_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "max"];

/**
 * The effort levels a model takes on `kind`, lowest first: its catalog row's (`efforts`), else up to high, as the
 * gateway sends them (`effortWithin`). `model` is a catalog id (an alias resolved, `[1m]` and dates allowed). Codex,
 * Grok and Antigravity's CLIs stop at high; Cursor and OpenCode take none, nor an Antigravity slug that names its level.
 * No `model` at all: the fixed list the pickers before the one AI choice show (a key's three, a plan's four).
 */
export function effortLevelsOf(kind: BrainKind | undefined, model?: string | null): readonly EffortLevel[] {
  if (model === undefined) return kind === "model" ? UP_TO_HIGH : FIXED_PLAN_LEVELS;
  if (kind === "cursor" || kind === "opencode") return [];
  if (kind === "antigravity" && model && ANTIGRAVITY_LEVEL.test(model)) return [];
  const listed = model ? MODEL_CATALOG[catalogModelOf(model) ?? ""]?.efforts : undefined;
  const levels = listed ? EFFORT_LEVELS.filter((l) => listed.includes(l)) : UP_TO_HIGH;
  return kind === "codex" || kind === "grok" || kind === "antigravity"
    ? levels.filter((l) => UP_TO_HIGH.includes(l))
    : levels;
}

/**
 * `effortLevelsOf` for a model as a brain stores it: null is the brain's default, an alias (`sonnet`) its catalog id
 * through the brain's `options`.
 */
export function effortLevelsFor(
  kind: BrainKind,
  model: string | null | undefined,
  options: readonly Pick<BrainOption, "kind" | "models" | "defaultModel">[],
): readonly EffortLevel[] {
  const option = options.find((o) => o.kind === kind);
  const value = model ?? option?.defaultModel;
  const found = option?.models.find((m) => m.value === value);
  // A Devin family's own levels, as its account listed them (ADR 0253).
  if (found?.efforts?.length) return EFFORT_LEVELS.filter((l) => found.efforts?.includes(l));
  return effortLevelsOf(kind, found?.modelId ?? value ?? null);
}

/** A stored effort as one of `levels`: one the model doesn't take runs as its highest level under it. */
export function shownEffort(stored: EffortLevel, levels: readonly EffortLevel[]): EffortLevel {
  if (levels.length === 0 || levels.includes(stored)) return stored;
  const at = EFFORT_LEVELS.indexOf(stored);
  return levels.filter((l) => EFFORT_LEVELS.indexOf(l) <= at).at(-1) ?? (levels[0] as EffortLevel);
}

/** Velocidade's choices (ADR 0149). */
export const SPEEDS: readonly BrainSpeed[] = ["standard", "fast"];

/** Velocidade means something for what this view thinks with; the right hand (its `scope`) has none. */
export const viewSpeedFits = (view: Pick<AgentBrain, "brain" | "account" | "accounts" | "effectiveModel" | "scope">) =>
  !view.scope &&
  speedFits({
    kind: view.brain,
    provider: view.accounts.find((a) => a.id === view.account)?.provider,
    model: view.effectiveModel,
  });

export interface Advanced {
  /**
   * Null only on an API key with none chosen: high where the model takes an effort and its output limit is known
   * (`turnEffort`), else the provider's default.
   */
  effort: EffortLevel | null;
  /** Always `standard` where Velocidade doesn't show (`viewSpeedFits`). */
  speed: BrainSpeed;
  contextTokens: ContextLimit | null;
  /** "Atende outras pessoas" off. */
  onlyOwner: boolean;
  /** "Só esta conta" (ADR 0041 §6); absent where the agent's account never moves on. */
  accountPinned?: boolean;
}

/** A new agent's: medium effort, its model's window, its owner only on a plan (ADR 0059 §5). */
export const ADVANCED_DEFAULTS: Advanced = {
  effort: "medium",
  speed: "standard",
  contextTokens: null,
  onlyOwner: true,
};

/**
 * "Voltar ao padrão": the API brain has only the effort and the context limit there, so the rest stays as it is; its
 * effort goes back to none (high where the model takes an effort, else the provider's default).
 */
export const advancedDefaults = (kind: BrainKind, now: Advanced): Advanced =>
  kind === "model"
    ? { ...now, effort: null, contextTokens: null }
    : now.accountPinned === undefined
      ? ADVANCED_DEFAULTS
      : { ...ADVANCED_DEFAULTS, accountPinned: false };
export const isAdvancedDefault = (kind: BrainKind, now: Advanced) =>
  JSON.stringify(advancedDefaults(kind, now)) === JSON.stringify(now);

type AdvancedOf = { kind: BrainKind; autoModel: boolean; now: Advanced };

/** The row's line: what the dialog holds ("Esforço, janela de contexto e quem atende"), the effort only with a fixed model. */
export function advancedContents(
  t: TFunction,
  o: Pick<AdvancedOf, "kind" | "autoModel"> & { speed?: boolean },
): string {
  const line = o.autoModel ? "auto" : "fixed";
  const which =
    o.kind === "model" ? (o.autoModel ? "model" : "modelFixed") : o.speed ? (`${line}Speed` as const) : line;
  return t(`agentPage.work.brain.advanced.contents.${which}`);
}

/**
 * After a save: "Tudo no padrão", or only what differs ("Esforço alto · Contexto de 400K"). The effort counts only
 * with a fixed model (an automatic one picks it).
 */
export function advancedSummary(t: TFunction, language: string, o: AdvancedOf): string {
  const parts = advancedParts(t, language, o);
  return parts.length ? parts.join(" · ") : t("agentPage.work.brain.advanced.allDefault");
}

/** What differs from the defaults, each as the row says it; none when everything is. */
export function advancedParts(t: TFunction, _language: string, o: AdvancedOf): string[] {
  const computer = o.kind !== "model";
  const { now } = o;
  return [
    !o.autoModel && now.effort && now.effort !== (computer ? ADVANCED_DEFAULTS.effort : null)
      ? t("agentPage.work.brain.advanced.effort", {
          level: t(`agentPage.work.brain.effortsLower.${now.effort}`),
        })
      : null,
    computer && now.speed === "fast" ? t("agentPage.work.brain.advanced.speed") : null,
    now.contextTokens ? t("agentPage.work.brain.advanced.context", { size: contextSize(now.contextTokens) }) : null,
    computer && !now.onlyOwner ? t("agentPage.work.brain.advanced.sharing") : null,
    computer && now.accountPinned ? t("agentPage.work.brain.pinned") : null,
  ].filter((p): p is string => p !== null);
}

/** Claude's own models (`--model fable|opus|sonnet|haiku`) say what each is for under their names. */
export const isClaudeAlias = (v: string): v is "fable" | "opus" | "sonnet" | "haiku" =>
  v === "fable" || v === "opus" || v === "sonnet" || v === "haiku";

/** An effort as stored, as the apps show it: none (or an automatic one) is medium, the default. */
export const effortLevel = (e: string | null | undefined): EffortLevel =>
  (EFFORT_LEVELS as readonly (string | null | undefined)[]).includes(e) ? (e as EffortLevel) : "medium";

/** An effort as stored, as the apps show it for `kind`: on an API key none (or `auto`) is null. */
export const effortOf = (kind: BrainKind | undefined, e: string | null | undefined): EffortLevel | null =>
  kind === "model" && (!e || isAuto(e)) ? null : effortLevel(e);

/** The `agentPage.work.brain.effortText` line of a level: none says the model decides, and a key's medium is no default. */
export const effortTextOf = (kind: BrainKind | undefined, e: EffortLevel | null) =>
  e === null ? "none" : kind === "model" && e === "medium" ? "mediumKey" : e;
