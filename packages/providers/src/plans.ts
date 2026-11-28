/**
 * Coding plans that think through Claude Code on a computer with the key their
 * owner pastes ("key accounts", ADR 0059). Pure data, read by the runner (where
 * a turn goes, which variable holds the key, what each model alias runs), the
 * engine and the apps (names, where the key is made, the model choices): it
 * imports nothing. A plan with a `modelsUrl` goes by that list once the server
 * has read it (`readPlanModels`), this table being its fallback. The key travels
 * sealed to the computer and stays there; our server never holds or routes it,
 * and the endpoint a turn uses comes from the runner's own copy of this file.
 *
 * Settings as each maker documents them for Claude Code (read 2026-10-24):
 * docs.z.ai/devpack/tool/claude, kimi.com/code/docs (third-party tools, Claude
 * Code), platform.minimax.io/docs/coding-plan/claude-code and
 * opencode.ai/v2/docs/console/harnesses/claude-code. Each plan's models as its
 * maker lists them (read 2026-10-30): docs.z.ai/devpack/overview,
 * kimi.com/code/docs/en/kimi-code/models.html,
 * platform.minimax.io/docs/coding-plan/intro, and opencode.ai/v2/docs/console/go
 * with its live list (opencode.ai/inference/go/v1/models). Flagships in their
 * makers' words (read 2026-10-30): docs.z.ai/guides/llm/glm-5.3, Kimi's models
 * page, Alibaba's Qwen3.8-Max announcement and
 * ai.google.dev/gemini-api/docs/models/gemini-4-argon.
 */

/** Claude Code's model aliases: "Automático" picks one per run, and the plan names the model each one runs. */
export type PlanAlias = "opus" | "sonnet" | "haiku";
export const PLAN_ALIASES: readonly PlanAlias[] = ["opus", "sonnet", "haiku"];

/**
 * How the picker sells a model, from its plan's or maker's own words: `smart` its maker's flagship, `fast` its
 * maker's high-speed version, `cheap` one the plan's limits stretch furthest with.
 */
export type PlanModelTag = "cheap" | "fast" | "smart";

/**
 * What the plan's account must allow before a model answers, all under OpenCode's Settings › Privacy: `globalRegion`
 * its Global region, `paidTraining` paid models that train on what they're sent, `freeTraining` free ones that do.
 */
export type PlanModelNeed = "globalRegion" | "paidTraining" | "freeTraining";

export interface PlanModel {
  /** What Claude Code sends (`--model`, or `ANTHROPIC_DEFAULT_SONNET_MODEL` for its alias); `[1m]`: a 1M-token window. */
  id: string;
  label: string;
  /**
   * The alias it runs for ("Automático"'s tiers, and an agent that chose the alias): `sonnet` on exactly one
   * model, the others at most once; an alias the plan leaves out runs `sonnet`'s model. Without one, it runs only
   * when chosen.
   */
  alias?: PlanAlias;
  tag?: PlanModelTag;
  needs?: PlanModelNeed;
  /** It costs nothing on the plan (its maker's list prices it at 0): the pickers mark it "Free". */
  free?: true;
  /** It reads text only (no images or PDFs): the pickers say so, and an agent that must see screenshots needs another. */
  images?: false;
  /**
   * Who makes it, on a plan that sells several makers' models (the picker groups them): an API provider's id
   * (`@agenteschat/providers`: its name and logo), else the maker's name.
   */
  maker?: string;
}

export interface CodingPlan {
  /** The account's first name ("GLM Coding"), numbered per owner. */
  label: string;
  /** The plan as its maker sells it ("GLM Coding Plan"), for titles. */
  name: string;
  /** Who sells it, for the logo's neighbors and the terms notice ("{{maker}} says…"). */
  maker: string;
  /** Where its owner makes the key. */
  site: string;
  /** What its keys look like (a `RegExp` source): loose, only to catch a paste that isn't a key. */
  keyPattern: string;
  /** How its keys start, as the key field's example; none where the maker publishes no prefix. */
  placeholder?: string;
  claudeCode: {
    /** Its Anthropic Messages endpoint (Claude Code adds `/v1/messages`). */
    baseUrl: string;
    /** The variable Claude Code reads the key from. */
    tokenEnv: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";
    /** Every model of the plan that answers through Claude Code, each maker's together, the aliases' makers first. */
    models: readonly PlanModel[];
    /** The maker's other documented settings. */
    env?: Readonly<Record<string, string>>;
  };
  /**
   * The maker's public list of the plan's models. The server reads it and its answer replaces `claudeCode.models`
   * (`readPlanModels`, `planOf`), so what the maker adds shows up without a release; the table stays the fallback.
   */
  modelsUrl?: string;
  /** The maker's usage endpoint for the key (`apps/server/runner/plan-usage.ts` reads its answer). */
  usage?: { url: string; auth: "bearer" | "raw" };
  /**
   * Each model has limits of its own: a refusal with no window of the account full is that model's, and the plan's
   * other models go on answering.
   */
  limitsPerModel?: true;
}

export const CODING_PLANS = {
  zai: {
    label: "GLM Coding",
    name: "GLM Coding Plan",
    maker: "Z.ai",
    site: "https://z.ai/manage-apikey/apikey-list",
    keyPattern: "^[A-Za-z0-9._-]{16,256}$",
    claudeCode: {
      baseUrl: "https://api.z.ai/api/anthropic",
      tokenEnv: "ANTHROPIC_AUTH_TOKEN",
      // Every tier has both; Flash spends about a third of GLM-5.3's credits per token.
      models: [
        { id: "glm-5.3[1m]", label: "GLM-5.3", alias: "sonnet", tag: "smart" },
        { id: "glm-5.3-flash[1m]", label: "GLM-5.3 Flash", alias: "haiku", tag: "cheap" },
      ],
      env: { API_TIMEOUT_MS: "3000000" },
    },
    usage: { url: "https://api.z.ai/api/monitor/usage/quota/limit", auth: "raw" },
  },
  kimi: {
    label: "Kimi Code",
    name: "Kimi Code",
    maker: "Kimi",
    site: "https://www.kimi.com/code/console",
    keyPattern: "^[A-Za-z0-9._-]{16,256}$",
    claudeCode: {
      baseUrl: "https://api.kimi.ai/coding/",
      tokenEnv: "ANTHROPIC_API_KEY",
      // `kimi-for-coding` (K2.8 Preview), K3.1 Pro and both K3 need Plus or above, the high-speed models Pro or
      // above. K3.1 Pro Highspeed spends about 2× K3.1 Pro's quota; K2.7 Code Highspeed is another model, at about
      // 3× the quota of K2.7 Code (not in the plan). K3 256K spends about half of K3's.
      models: [
        { id: "kimi-for-coding", label: "Kimi for Coding", alias: "sonnet" },
        { id: "k3.1-pro", label: "K3.1 Pro", alias: "opus", tag: "smart" },
        { id: "k3.1-pro-highspeed", label: "K3.1 Pro Highspeed", tag: "fast" },
        { id: "kimi-for-coding-highspeed", label: "K2.7 Code Highspeed", tag: "fast" },
        { id: "k3", label: "K3" },
        { id: "k3-256k", label: "K3 256K" },
      ],
    },
    usage: { url: "https://api.kimi.com/coding/v1/usages", auth: "bearer" },
  },
  minimax: {
    label: "MiniMax",
    name: "MiniMax M Plan",
    maker: "MiniMax",
    site: "https://platform.minimax.io/console/plan",
    keyPattern: "^[A-Za-z0-9._-]{16,2048}$",
    claudeCode: {
      baseUrl: "https://api.minimax.io/anthropic",
      tokenEnv: "ANTHROPIC_AUTH_TOKEN",
      models: [{ id: "MiniMax-M3.1-Flash[1m]", label: "MiniMax M3.1 Flash", alias: "sonnet" }],
    },
  },
  opencode: {
    label: "OpenCode Go",
    name: "OpenCode Go",
    maker: "OpenCode",
    site: "https://opencode.ai/console",
    keyPattern: "^oc_sk_[A-Za-z0-9._-]{8,256}$",
    placeholder: "oc_sk_…",
    claudeCode: {
      baseUrl: "https://opencode.ai/inference/go/anthropic",
      tokenEnv: "ANTHROPIC_AUTH_TOKEN",
      // Go answers in Anthropic's format for every model, translating the others. Each model has its own
      // monthly cap; `cheap`: 20,000 or more requests a month on Go by OpenCode's own estimates. DeepSeek's
      // models answer only once the OpenCode workspace allows the Global region, the ones that train on what
      // they're sent only once it allows that (paid and free are separate switches); none has an alias, so
      // "Automático" never picks one.
      // The fallback for `modelsUrl` (32 on 2026-11-17, all of them here), and what only we know of each model:
      // its alias and tag. Zen's own free models (`deepseek-v4.1-flash-free`, `glm-5.3-flash-free`, `big-pickle`…)
      // aren't Go's: OpenCode serves its free tier only to the OpenCode CLI ("Free-tier chat models require
      // OpenCode", opencode.ai/v2/docs/console/models, read 2026-11-06), so they can't answer through Claude Code.
      models: [
        { id: "minimax-m3", label: "MiniMax M3", alias: "sonnet", maker: "minimax" },
        { id: "minimax-m3.1-flash", label: "MiniMax M3.1 Flash", maker: "minimax" },
        { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", alias: "haiku", maker: "anthropic" },
        { id: "glm-5.3", label: "GLM-5.3", tag: "smart", maker: "zai" },
        { id: "glm-5.3-flash", label: "GLM-5.3 Flash", tag: "cheap", maker: "zai" },
        { id: "glm-5.2", label: "GLM-5.2", maker: "zai" },
        { id: "kimi-k3.1-pro", label: "Kimi K3.1 Pro", tag: "smart", maker: "moonshot" },
        { id: "kimi-k3", label: "Kimi K3", maker: "moonshot" },
        { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", maker: "moonshot" },
        { id: "qwen4-max", label: "Qwen4 Max", maker: "Alibaba" },
        { id: "qwen3.8-max", label: "Qwen3.8 Max", tag: "smart", maker: "Alibaba" },
        { id: "qwen3.8-flash", label: "Qwen3.8 Flash", tag: "cheap", maker: "Alibaba" },
        { id: "qwen3.7-plus", label: "Qwen3.7 Plus", tag: "cheap", maker: "Alibaba" },
        { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", needs: "globalRegion", maker: "deepseek", images: false },
        {
          id: "deepseek-v4.1-flash",
          label: "DeepSeek V4.1 Flash",
          tag: "cheap",
          needs: "globalRegion",
          maker: "deepseek",
          images: false,
        },
        { id: "mimo-v2.6-pro", label: "MiMo V2.6 Pro", maker: "Xiaomi" },
        { id: "mimo-v2.6-flash", label: "MiMo V2.6 Flash", tag: "cheap", maker: "Xiaomi" },
        { id: "gpt-6-luna", label: "GPT-6 Luna", tag: "cheap", maker: "openai" },
        { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", maker: "openai" },
        { id: "gemini-4-argon", label: "Gemini 4 Argon", tag: "smart", maker: "gemini" },
        { id: "grok-4.7", label: "Grok 4.7", maker: "xAI" },
        { id: "longcat-2.0", label: "LongCat 2.0", tag: "cheap", maker: "Meituan" },
        { id: "longcat-2.5-free", label: "LongCat 2.5 Free", free: true, maker: "Meituan" },
        { id: "hy3", label: "Hy3", tag: "cheap", maker: "Tencent" },
        { id: "hy4", label: "Hy4", maker: "Tencent" },
        { id: "hy4-preview", label: "Hy4 Preview", maker: "Tencent" },
        { id: "hy4-flash-free", label: "Hy4 Flash Free", free: true, maker: "Tencent" },
        { id: "step-5-preview", label: "Step 5 Preview", maker: "StepFun" },
        {
          id: "muse-spark-1.3-contributor",
          label: "Muse Spark 1.3 Contributor",
          needs: "paidTraining",
          maker: "Meta",
        },
        {
          id: "muse-spark-1.2-contributor",
          label: "Muse Spark 1.2 Contributor",
          needs: "paidTraining",
          maker: "Meta",
        },
        { id: "beam-free", label: "Beam Free", free: true, maker: "Reflection" },
        {
          id: "iceman-contributor-free",
          label: "Iceman Contributor Free",
          needs: "freeTraining",
          free: true,
          maker: "OpenCode",
        },
      ],
      // Its models that aren't Claude refuse some of Claude Code's betas; the OpenCode CLI, if the agent runs
      // it, reads no project config that could point it elsewhere.
      env: { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
    },
    modelsUrl: "https://opencode.ai/inference/go/v1/models",
    usage: { url: "https://opencode.ai/zen/go/v1/usage", auth: "bearer" },
    // "Each model has the following usage limits: 5-hour, weekly, monthly" (opencode.ai/docs/go, read 2026-11-05).
    limitsPerModel: true,
  },
} as const satisfies Record<string, CodingPlan>;

/**
 * The models ChatGPT's Fast mode serves (developers.openai.com/api/docs/guides/fast-mode, ids as Codex lists them in
 * its `service_tiers`, codex-cli 0.166.0; GPT-6.2 Sol and Astra from the guide and the pricing page's Fast table,
 * 2026-11-17). Codex drops the tier without a word for any other model.
 */
export const FAST_MODE_MODELS: readonly string[] = [
  "gpt-6.2-sol",
  "gpt-6.2-astra",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];

/**
 * Velocidade (ADR 0149) means something for this brain, sign-in and model: Codex on a ChatGPT sign-in (no key account
 * of a coding plan), with a model on the list. None: Codex's default; `auto`: every model "Automático" picks is on it.
 */
export const speedFits = (o: { kind: string; provider?: string | null; model?: string | null }) =>
  (o.kind === "codex" && !o.provider && (!o.model || o.model === "auto" || FAST_MODE_MODELS.includes(o.model))) ||
  // The Devin CLI (ADR 0253): a model's faster variant (`-fast`, `-priority`, `-lightning`) where its listing has one,
  // else its standard one (`devinVariant`).
  o.kind === "devin";

export type PlanId = keyof typeof CODING_PLANS;
export const PLAN_IDS = Object.keys(CODING_PLANS) as PlanId[];
export const isPlanId = (v: unknown): v is PlanId => typeof v === "string" && Object.hasOwn(CODING_PLANS, v);

/** Each plan as its `modelsUrl` last said: per process, and empty until the list is read (always on a computer). */
const learned = new Map<PlanId, CodingPlan>();

export const planOf = (id: unknown): CodingPlan | undefined =>
  isPlanId(id) ? (learned.get(id) ?? CODING_PLANS[id]) : undefined;

/** Keeps the models a plan's list gave: on the server from `readPlanModels`, in the apps as the server sends them. */
export function learnPlanModels(lists: Partial<Record<string, readonly PlanModel[]>>) {
  for (const [id, models] of Object.entries(lists)) {
    if (!isPlanId(id) || !models?.length || learned.get(id)?.claudeCode.models === models) continue;
    const plan: CodingPlan = CODING_PLANS[id];
    learned.set(id, { ...plan, claudeCode: { ...plan.claudeCode, models } });
  }
}

/** What `learnPlanModels` holds, for the server to send on. */
export const learnedPlanModels = (): Record<string, PlanModel[]> =>
  Object.fromEntries([...learned].map(([id, plan]) => [id, [...plan.claudeCode.models]]));

/** What a model id from a list may look like: it reaches Claude Code's `--model` and its environment. */
const LISTED_MODEL_ID = /^[A-Za-z0-9][\w.-]{0,79}$/;

/** Ids that already mean something, to the pickers (`auto`) or to Claude Code: never a list's model, whatever it says. */
const TAKEN_MODEL_ID = /^(?:auto|default|opus|sonnet|haiku|fable)$/i;

const isListedModelId = (v: unknown): v is string =>
  typeof v === "string" && LISTED_MODEL_ID.test(v) && !TAKEN_MODEL_ID.test(v);

/** Far above any plan's list: past it, the answer isn't one. */
const MAX_LISTED_MODELS = 300;

/** Makers by the first part of a list's `canonical_id` where they aren't its capitalized form: mostly an API provider's id. */
const LISTED_MAKERS = new Map([
  ["anthropic", "anthropic"],
  ["deepseek", "deepseek"],
  ["google", "gemini"],
  ["minimax", "minimax"],
  ["moonshotai", "moonshot"],
  ["openai", "openai"],
  ["stepfun", "StepFun"],
  ["xai", "xAI"],
  ["zhipuai", "zai"],
]);

function listedMaker(canonicalId: unknown, plan: CodingPlan) {
  const prefix = typeof canonicalId === "string" ? (canonicalId.split("/")[0] ?? "") : "";
  if (!/^[a-z][a-z0-9-]{0,39}$/i.test(prefix)) return plan.maker;
  return LISTED_MAKERS.get(prefix) ?? prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

/**
 * The plan's models from its `modelsUrl`'s answer, none if it isn't one: names, makers and prices from the list, the
 * table's alias and tag for what it knows, and what a model needs from what OpenCode documents for each kind
 * (opencode.ai/v2/docs/console/go, read 2026-11-06): DeepSeek's the Global region, a "Contributor" model training
 * allowed. Only chat models that call tools, which every turn does. A model the list drops goes, unless an alias
 * runs it: the computers map the aliases from their own copy of the table.
 */
export function readPlanModels(plan: CodingPlan, body: unknown): PlanModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length > MAX_LISTED_MODELS) return [];
  const table = plan.claudeCode.models;
  const listed = new Map<string, PlanModel>();
  for (const raw of data as ListedModel[]) {
    const id = raw?.id;
    if (!isListedModelId(id)) continue;
    if (raw.type !== "chat" || raw.capabilities?.tools?.supported === false) continue;
    const known = table.find((m) => m.id === id);
    const maker = listedMaker(raw.canonical_id, plan);
    const free = raw.cost?.text?.input?.price === 0 && raw.cost.text.output?.price === 0;
    const trains = /contributor/i.test(id) ? (free ? "freeTraining" : "paidTraining") : undefined;
    const needs = known?.needs ?? (maker === "deepseek" ? "globalRegion" : trains);
    const textOnly = known ? known.images === false : maker === "deepseek";
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    listed.set(id, {
      id,
      label: name && !/\p{C}/u.test(name) ? name.slice(0, 80) : id,
      maker,
      ...(known?.alias ? { alias: known.alias } : {}),
      ...(known?.tag ? { tag: known.tag } : {}),
      ...(needs ? { needs } : {}),
      ...(free ? { free } : {}),
      ...(textOnly ? { images: false as const } : {}),
    });
  }
  if (listed.size === 0) return [];
  const models = [
    ...table.flatMap((m) => listed.get(m.id) ?? (m.alias ? [m] : [])),
    ...[...listed.values()].filter((m) => !table.some((t) => t.id === m.id)),
  ];
  return [...new Set(models.map((m) => m.maker))].flatMap((maker) => models.filter((m) => m.maker === maker));
}

/** The fields of a model in a `modelsUrl` answer that `readPlanModels` reads. */
interface ListedModel {
  id?: unknown;
  name?: unknown;
  canonical_id?: unknown;
  type?: unknown;
  capabilities?: { tools?: { supported?: unknown } };
  cost?: { text?: { input?: { price?: unknown }; output?: { price?: unknown } } };
}

/**
 * The plan for a turn on a computer, whose copy of the table may be older than the plan's list: the id the server
 * chose from that list (`claudeCodeModel` there, which has already turned anything else into `sonnet`) counts as one
 * of the plan's. Only a plan with a list, and only an id of a listed model's shape.
 */
export function planForTurn(plan: CodingPlan, value: unknown): CodingPlan {
  const { models } = plan.claudeCode;
  if (!plan.modelsUrl || !isListedModelId(value) || models.some((m) => m.id === value)) return plan;
  return { ...plan, claudeCode: { ...plan.claudeCode, models: [...models, { id: value, label: value }] } };
}

const isAlias = (v: unknown): v is PlanAlias => PLAN_ALIASES.some((a) => a === v);
/** Claude Code's aliases no plan maps (`fable`): Claude's own sign-in runs them as they are, a plan's runs `sonnet`. */
const isClaudeOnlyAlias = (v: unknown) => v === "fable";

/**
 * The model a stored value runs on a plan: one of its models by id, the model of an alias, else (`auto`, an alias
 * the plan leaves out, another plan's model, none) `sonnet`'s.
 */
export function planModel(plan: CodingPlan, value: string | null | undefined): PlanModel {
  const { models } = plan.claudeCode;
  const byAlias = isAlias(value) ? models.find((m) => m.alias === value) : undefined;
  return (
    models.find((m) => m.id === value) ??
    byAlias ??
    models.find((m) => m.alias === "sonnet") ??
    (models[0] as PlanModel)
  );
}

/** What a plan's model is stored and chosen as: its alias where it has one (portable to Claude), else its id. */
export const planModelValue = (m: PlanModel): string => m.alias ?? m.id;

/**
 * On a plan whose models have limits of their own (`limitsPerModel`), the model a stored value runs (`planModel`), by
 * whose id its limit is kept; null on any other plan.
 */
export function ownLimitsModel(provider: unknown, value: string | null | undefined): PlanModel | null {
  const plan = planOf(provider);
  return plan?.limitsPerModel && value ? planModel(plan, value) : null;
}

/** How long a model's own limit with no known reset (or no subscription) holds once seen: then a turn asks again. */
export const MODEL_LIMIT_HOLD_MS = 30 * 60_000;

/**
 * The model's own limit in `models` (`PlanUsage.models`, kept by the server) that still holds: until its reset, else
 * `MODEL_LIMIT_HOLD_MS` after it was seen. `region`: it needs the account's Global region; `off`: the plan refused it
 * for this key (the model or the account turned off there); both hold until something changes (a new key, someone
 * choosing the model again, a turn on it going through), since asking again only gets the same refusal. `inactive`:
 * the key's workspace has no active subscription, which every model of the plan answers the same way.
 */
export function modelLimitOf(
  models:
    | Readonly<Record<string, { at: string; until?: string; region?: true; off?: true; inactive?: true }>>
    | undefined,
  id: string | null | undefined,
  now = Date.now(),
): { until: number | null; region: boolean; off: boolean; inactive: boolean } | null {
  const l = id ? models?.[id] : undefined;
  if (!l) return null;
  const until = l.until ? Date.parse(l.until) : Number.NaN;
  if (until > now) return { until, region: false, off: false, inactive: false };
  if (l.until) return null;
  const fixed = l.region === true || l.off === true;
  return fixed || now - Date.parse(l.at) < MODEL_LIMIT_HOLD_MS
    ? { until: null, region: l.region === true, off: l.off === true, inactive: l.inactive === true }
    : null;
}

/**
 * Claude Code's words for a 403 from a plan's endpoint ("API Error: 403 {…}"): on a key, the plan refusing the model
 * (switched off in its workspace, or the account itself), never the key, which a 401 refuses.
 */
export const PLAN_FORBIDDEN_TEXT = /\bAPI Error:? 403\b/i;

/**
 * OpenCode Go's 403 when the key's workspace has no active Go subscription: `Account.Disabled`, "An active OpenCode
 * Go subscription is required to use Go models." (its words in public reports, github.com/anomalyco/opencode issues
 * 49768 and 50873, 2026-09). Every model is refused alike, so no setting of one model helps.
 */
export const PLAN_INACTIVE_TEXT = /Account\.Disabled|active (?:OpenCode )?Go subscription/i;

/**
 * What "Automático" runs for `value` (an alias, or `auto`) on a plan whose models have limits of their own: the model
 * it maps to, unless that one is held now (`modelLimitOf`); then the model that last answered with this key
 * (`answered`, kept by the server) while that one isn't; else the plan's first model tagged cheap or smart that needs
 * nothing from the account and isn't held. Anything else stays as it is.
 */
export function autoPlanModel(
  provider: unknown,
  value: string | undefined,
  usage: { models?: Parameters<typeof modelLimitOf>[0]; answered?: string } | null | undefined,
  now = Date.now(),
): string | undefined {
  const own = ownLimitsModel(provider, value);
  const held = own ? modelLimitOf(usage?.models, own.id, now) : null;
  // No active subscription refuses every model alike: another one would only be refused too.
  if (!own || !held || held.inactive) return value;
  const models = planOf(provider)?.claudeCode.models ?? [];
  const free = (id: string) => id !== own.id && !modelLimitOf(usage?.models, id, now);
  const answered = usage?.answered;
  if (answered && models.some((m) => m.id === answered) && free(answered)) return answered;
  return models.find((m) => (m.tag === "cheap" || m.tag === "smart") && !m.needs && !m.free && free(m.id))?.id ?? value;
}

/** A coding plan's model by its id, whichever plan has it. */
export const planModelById = (id: string): PlanModel | undefined =>
  PLAN_IDS.flatMap((p) => planOf(p)?.claudeCode.models ?? []).find((m) => m.id === id);

/** Every coding plan's model ids: what an agent on Claude Code may store besides Claude's own. */
export const isPlanModelId = (v: string) => planModelById(v) !== undefined;

/**
 * The `--model` of a Claude Code turn for a stored value: an alias as is (on a plan, the plan names its model);
 * with a plan, one of its models by id; without one, `fable` or a Claude id. Anything else (another plan's model,
 * none) runs `sonnet`.
 */
export function claudeCodeModel(plan: CodingPlan | undefined, value: unknown): string {
  if (isAlias(value)) return value;
  if (typeof value !== "string") return "sonnet";
  if (plan) return plan.claudeCode.models.some((m) => m.id === value) ? value : "sonnet";
  return isClaudeOnlyAlias(value) || /^claude-/.test(value) ? value : "sonnet";
}

/**
 * The model of a plan (`provider`) a stored value named that the plan's live list (`modelsUrl`) no longer has: its
 * turns run `sonnet` instead (`claudeCodeModel`). Null for an alias, a Claude id, another plan's model, a plan
 * without a list, or before this process has read the list (the table alone would call any newer model gone). Its
 * label from the table when the table still knows it.
 */
export function droppedPlanModel(provider: unknown, value: unknown): PlanModel | null {
  const plan = isPlanId(provider) ? learned.get(provider) : undefined;
  if (!isPlanId(provider) || !plan?.modelsUrl) return null;
  if (typeof value !== "string" || isAlias(value) || isClaudeOnlyAlias(value) || /^claude-/.test(value)) return null;
  if (plan.claudeCode.models.some((m) => m.id === value) || planModelById(value)) return null;
  const table: readonly PlanModel[] = CODING_PLANS[provider].claudeCode.models;
  return table.find((m) => m.id === value) ?? { id: value, label: value };
}

/** A pasted key that fits the plan: one line, the plan's shape. */
export const planKeyFits = (plan: Pick<CodingPlan, "keyPattern">, key: string) => new RegExp(plan.keyPattern).test(key);

/**
 * The accounts that may have one login per agent, the same account signed in again for each, where a login thinks
 * for one agent: on a runner before protocol 29, and on a computer where every agent is its own OS user for a
 * login made before it or with `SHARED_SIGN_INS` off. A coding plan's key has no refresh token, so its copies never
 * sign each other out. Every sign-in may (ADR 0059 §2, amended 2026-10-30 and 2026-11-02), though a new sign-in or
 * a token refresh can sign the account's other logins out: such a login reads as signed out from its next turn on,
 * for its owner to sign in again. Set back to false, a kind refuses a new login of an account already there again;
 * logins made meanwhile keep thinking, each for its agent.
 */
export const LOGIN_PER_AGENT: Readonly<Record<"claude_code" | "codex" | "cursor" | "key", boolean>> = {
  claude_code: true,
  codex: true,
  cursor: true,
  key: true,
};

/**
 * Whether an account (its CLI's kind, and a coding plan's `provider` for a key, `cursor` for a Cursor API key or `zen`
 * for an OpenCode key) may have one login per agent.
 */
export const loginPerAgent = (kind: string, provider?: string | null) =>
  isPlanId(provider) || provider === "cursor" || provider === "zen"
    ? LOGIN_PER_AGENT.key
    : kind === "codex" || kind === "cursor"
      ? LOGIN_PER_AGENT[kind]
      : LOGIN_PER_AGENT.claude_code;

/**
 * Where each agent is its own OS user (system mode), whether a new sign-in is made once for every agent of its
 * owner on that computer (ADR 0059 §2, amended 2026-10-30, protocol 29): root keeps it and hands each turn what
 * its CLI needs. For Claude that is the token `claude setup-token` makes, which the runner then keeps; for ChatGPT
 * (protocol 38) a copy of the `auth.json` root signed in to, whose refreshed copies come back to root; for Gemini
 * (protocol 58) a copy of the Google sign-in root's Antigravity CLI keeps; for Grok Build (protocol 67, amended
 * 2026-11-12) a copy of the `auth.json` in root's `GROK_HOME`, whose refreshed copies come back to root too (its
 * sign-in is a grok.com session token with a refresh token, and `GROK_HOME` is its whole store). Set a kind to
 * false to go back to one login per agent there. Where every agent is the runner's own user, any sign-in thinks
 * for all of them, as the computer's own always has. Accounts made for all agents keep thinking when a kind is
 * switched off, until signed in again or removed.
 */
export const SHARED_SIGN_INS: Readonly<Record<"claude_code" | "codex" | "antigravity" | "grok" | "key", boolean>> = {
  claude_code: true,
  codex: true,
  antigravity: true,
  grok: true,
  key: true,
};

/**
 * Computer brains whose CLI never thinks with the computer's own sign-in, only a connected account (ADR 0142, ADR 0143
 * §3, ADR 0253 §3).
 */
export const ACCOUNT_ONLY_BRAINS = ["antigravity", "grok", "devin"] as const;
export const accountOnlyBrain = (kind: string) => (ACCOUNT_ONLY_BRAINS as readonly string[]).includes(kind);

/**
 * The kinds whose subscriptions a run may go on with at a plan's limit, each within its own kind (ADR 0041 §6). Never
 * Antigravity: Google forbids automating account rotation (ADR 0143). Not Grok, Cursor or OpenCode.
 */
export const NEXT_ACCOUNT_KINDS: readonly string[] = ["claude_code", "codex"];

/** What an account's place in the order of use is read from (`compareInOrder`). */
export interface OrderKey {
  ownerId: string | null;
  /** Its place among its computer's accounts of its kind, 0 first; null or absent: after the placed ones. */
  useOrder?: number | null;
}

const placeOf = (a: OrderKey) => a.useOrder ?? Number.MAX_SAFE_INTEGER;

/**
 * The one order of use (ADR 0041 §6), the engine's `accountOrderSql` in SQL: `person`'s own accounts first, then by
 * place, the unplaced after. A stable sort keeps the rest as given, which is oldest first everywhere.
 */
export const compareInOrder =
  (person: string | null) =>
  (a: OrderKey, b: OrderKey): number =>
    Number(person !== null && b.ownerId === person) - Number(person !== null && a.ownerId === person) ||
    placeOf(a) - placeOf(b);

/** Whether a new sign-in of an account (its CLI's kind, and a coding plan's `provider`) is made for all agents. */
export const sharedSignIn = (kind: string, provider?: string | null) =>
  isPlanId(provider)
    ? SHARED_SIGN_INS.key
    : (kind === "claude_code" || kind === "codex" || kind === "antigravity" || kind === "grok") &&
      SHARED_SIGN_INS[kind];

/**
 * OpenCode's free tier (ADR 0132): models OpenCode serves at no cost and only to its own CLI ("Free-tier chat models
 * require OpenCode", opencode.ai/docs/zen, read 2026-11-02; its free list read again 2026-11-09). Its CLI runs them
 * with no key at all. What `opencode models` lists on the computer comes first; this list is the fallback where it
 * listed nothing.
 * ponytail: hand-copied list, the CLI's own listing replaces it wherever the runner reports one.
 */
export const OPENCODE_FREE_MODELS: readonly { id: string; label: string }[] = [
  { id: "opencode/big-pickle", label: "Big Pickle" },
  { id: "opencode/beam-free", label: "Beam Free" },
  { id: "opencode/crouton-alpha-free", label: "Crouton Alpha Free" },
  { id: "opencode/deepseek-v4.1-flash-free", label: "DeepSeek V4.1 Flash Free" },
  { id: "opencode/flint-40b-free", label: "Flint 40B Free" },
  { id: "opencode/glm-5.3-flash-free", label: "GLM-5.3 Flash Free" },
  { id: "opencode/iceman-free", label: "Iceman Free" },
  { id: "opencode/inkling-2-small-free", label: "Inkling 2 Small Free" },
  { id: "opencode/jev-1.13-free", label: "Jev 1.13 Free" },
  { id: "opencode/longcat-2.5-free", label: "LongCat 2.5 Free" },
  { id: "opencode/mimo-v2.6-flash-free", label: "MiMo V2.6 Flash Free" },
  { id: "opencode/nemotron-3-ultra-free", label: "Nemotron 3 Ultra Free" },
  { id: "opencode/nemotron-3.5-lightning-free", label: "Nemotron 3.5 Lightning Free" },
  { id: "opencode/nemotron-3.5-super-vl-free", label: "Nemotron 3.5 Super VL Free" },
];

/** A model of OpenCode's free tier by its `provider/model` id: one OpenCode serves (`opencode/`) named `-free`, or listed. */
export const isOpencodeFreeModel = (id: string) =>
  /^opencode\/[\w.-]+-free$/.test(id) || OPENCODE_FREE_MODELS.some((m) => m.id === id);

/**
 * Grok Build's models (ADR 0142) where the agent's computer listed none (`grok models` asks xAI: none offline). What
 * the CLI lists comes first; with none chosen its own default runs.
 * ponytail: hand-copied list (grok-4.5 and grok-4.6 as Grok Build 1.0.34 listed them, grok-4.7 as OpenCode Go lists
 * it, 2026-11-04), the CLI's own listing replaces it wherever the runner reports one.
 */
export const GROK_BUILD_MODELS: readonly { id: string; label: string }[] = [
  { id: "grok-4.7", label: "Grok 4.7" },
  { id: "grok-4.6", label: "Grok 4.6" },
  { id: "grok-4.5", label: "Grok 4.5" },
];

/**
 * The Antigravity CLI's models (ADR 0143) where the agent's computer listed none (`agy models` asks Google: none
 * offline, none before an account here signed in), each slug a model at one thinking level, `xhigh` being the
 * "Extra" one, and the plans that include it (antigravity.google/docs/models, read 2026-11-20): Gemini 4 Neon, the
 * CLI's own default, and Argon on paid Google AI Pro, Ultra and Enterprise, Hydrogen on Pro (not its trial), Ultra
 * and Enterprise, Gemini 3.8 Flash on every plan; Carbon on Ultra and Enterprise only, and the older Flash and 3.1
 * Pro on Enterprise only, are left to the CLI's own listing. What the CLI lists comes first; with none chosen its own
 * default runs.
 * ponytail: hand-copied list, the CLI's own listing replaces it wherever the runner reports one.
 */
export const ANTIGRAVITY_MODELS: readonly { id: string; label: string }[] = [
  { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
  { id: "gemini-4-neon-xhigh", label: "Gemini 4 Neon (XHigh)" },
  { id: "gemini-4-neon-medium", label: "Gemini 4 Neon (Medium)" },
  { id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)" },
  { id: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen (High)" },
  { id: "gemini-4-hydrogen-xhigh", label: "Gemini 4 Hydrogen (XHigh)" },
  { id: "gemini-4-hydrogen-medium", label: "Gemini 4 Hydrogen (Medium)" },
  { id: "gemini-4-hydrogen-low", label: "Gemini 4 Hydrogen (Low)" },
  { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
  { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" },
  { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)" },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
];

/**
 * The Antigravity CLI's own catalog decides which models it lists and runs: 1.5.0 has Gemini 4 Argon and 3.8 Flash
 * only, Gemini 4 Neon and Hydrogen came with 1.5.12 (on a Gemini API key) and 1.5.13 (Google AI Pro and Ultra, with
 * the app's 2.34.0; changelog read 2026-11-21). An older CLI never lists them, whatever the account's plan.
 */
export const ANTIGRAVITY_NEON_CLI = "1.5.13";

/** The reserve's models an older CLI (before `ANTIGRAVITY_NEON_CLI`) doesn't know. */
export const ANTIGRAVITY_NEW_MODEL = /^gemini-4-(?:neon|hydrogen)-/;

/**
 * Gemini 4 Argon comes with exactly the plans that have Neon and Hydrogen (paid Google AI Pro, Ultra and Enterprise;
 * antigravity.google/docs/models): a listing with Argon and neither of them was taken by an older CLI.
 */
export const ANTIGRAVITY_PAID_MODEL = /^gemini-4-argon-/;

/** The Antigravity CLI also lists other makers' models (Claude, GPT-OSS): the Gemini plan offers Gemini only. */
export const isAntigravityGemini = (id: string) => id.startsWith("gemini-");

/** An Antigravity model's name from the reserve (`gemini-4-argon-high` → "Gemini 4 Argon (High)"); else the slug. */
export const antigravityLabel = (id: string) => ANTIGRAVITY_MODELS.find((m) => m.id === id)?.label ?? id;

/**
 * A CLI's version as numbers, read anywhere in its `--version` line (`agy 1.5.0`, `1.5.14`); null without one. Each
 * part at most nine digits: the line comes from the computer, and an unbounded run of digits would be slow to search.
 */
export function cliVersionOf(line: string | null | undefined): [number, number, number] | null {
  const m = /(\d{1,9})\.(\d{1,9})\.(\d{1,9})/.exec(line ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether a `--version` line is at least `min` (`1.5.13`); null when the line has no version. */
export function cliVersionAtLeast(line: string | null | undefined, min: string): boolean | null {
  const have = cliVersionOf(line);
  const want = cliVersionOf(min);
  if (!have || !want) return null;
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return (have[i] ?? 0) > (want[i] ?? 0);
  return true;
}

/**
 * An Antigravity CLI account's `provider` when it signs in to Gemini Enterprise (`oauth-business`, ADR 0143); none:
 * a personal Google account (Google AI Pro or Ultra).
 */
export const GEMINI_ENTERPRISE_PROVIDER = "enterprise";

/** What signs an account in again as it was: a coding plan's key, or Gemini Enterprise. */
export const signInProviderOf = (provider: string | null | undefined): string | undefined =>
  isPlanId(provider) || provider === GEMINI_ENTERPRISE_PROVIDER ? provider : undefined;

/**
 * Whether an account's `provider` is the plan chosen: a coding plan's own key, else a sign-in (none, or Gemini
 * Enterprise's seat, an account of the same plan as a personal Google one).
 */
export const providerFitsChoice = (provider: string | null | undefined, choice: string, coding: boolean) =>
  coding ? provider === choice : !provider || provider === GEMINI_ENTERPRISE_PROVIDER;

/**
 * An Antigravity model slug's thinking level, the slug's last word (`gemini-4-neon-xhigh` → `xhigh`): a slug that
 * names one takes no `--effort`.
 */
export const ANTIGRAVITY_LEVEL = /-(?:low|medium|high|xhigh)$/;

/** An Antigravity model slug's model in the catalog: `gemini-4-argon-high` → `gemini-4-argon`, `…-neon-xhigh` too. */
export const antigravityBaseModel = (slug: string) => slug.replace(ANTIGRAVITY_LEVEL, "");

/**
 * The Devin CLI's models (ADR 0253) where no account on the agent's computer listed any yet (`devin models list` asks
 * Cognition: none before a sign-in). Each is a model family (its `family_uid`), run at the level the agent's effort names
 * (`devinVariant`); with none chosen the CLI's own default runs. What the accounts list comes first.
 * ponytail: hand-copied from `devin models list --format json` on a Devin Pro account (CLI 3000.14.30821, 2026-11-22);
 * the CLI's own listing replaces it wherever the runner reports one.
 */
export const DEVIN_MODELS: readonly { id: string; label: string; free?: boolean }[] = [
  { id: "adaptive", label: "Adaptive" },
  { id: "swe-2", label: "SWE-2", free: true },
  { id: "swe-2-flash", label: "SWE-2 Flash", free: true },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "gpt-6-2-sol", label: "GPT-6.2 Sol" },
  { id: "gemini-4-neon", label: "Gemini 4 Neon" },
];

/** The levels a Devin model variant's id ends with, least thinking first (`claude-opus-5-5-xhigh`). */
export const DEVIN_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type DevinLevel = (typeof DEVIN_LEVELS)[number];

/** A Devin variant's faster serving: Anthropic's Fast mode, OpenAI's priority tier, SWE-2's Lightning. */
const DEVIN_FAST_WORD = /-(?:fast|priority|lightning)$/;

/**
 * A Devin variant id read as its level and whether it is a faster serving of it: `gpt-6-sol-high-priority` → high,
 * fast; `claude-opus-4-6-thinking` → no level. A Fusion variant (`fusion-<main>-sidekick-<helper>`) is read by its
 * main model.
 */
export function devinVariantOf(uid: string): { level?: DevinLevel; fast: boolean } {
  const bare = uid.replace(/^fusion-/, "");
  const sidekick = bare.indexOf("-sidekick-");
  const main = sidekick < 0 ? bare : bare.slice(0, sidekick);
  const fast = DEVIN_FAST_WORD.test(main);
  const word = /-([a-z]+)$/.exec(main.replace(DEVIN_FAST_WORD, ""))?.[1];
  const level = (DEVIN_LEVELS as readonly string[]).includes(word ?? "") ? (word as DevinLevel) : undefined;
  return { ...(level ? { level } : {}), fast };
}

/** What an agent's effort asks of a Devin model: `xhigh` and `max` as they are; none, the model's own default. */
const devinWant = (effort: string | undefined): DevinLevel | undefined =>
  (DEVIN_LEVELS as readonly string[]).includes(effort ?? "") ? (effort as DevinLevel) : undefined;

/**
 * The variant a Devin turn runs (ADR 0253): of the family's variants (`variants`, in the CLI's order, its default
 * first), the one at the agent's effort, else the nearest level below it, else the nearest above; the faster serving of
 * that level when the agent answers fast and one exists. A family whose variants name no level runs its first. Null
 * when the family has no variants.
 */
export function devinVariant(variants: readonly string[], effort?: string, fast = false): string | null {
  if (variants.length === 0) return null;
  const read = variants.map((uid) => ({ uid, ...devinVariantOf(uid) }));
  const standard = read.filter((v) => !v.fast);
  const pool = standard.length ? standard : read;
  const want = devinWant(effort);
  let pick = pool[0];
  if (want) {
    const rank = (l?: DevinLevel) => (l ? DEVIN_LEVELS.indexOf(l) : -1);
    const at = DEVIN_LEVELS.indexOf(want);
    const leveled = pool.filter((v) => v.level);
    const exact = leveled.find((v) => v.level === want);
    const below = leveled.filter((v) => rank(v.level) < at).sort((a, b) => rank(b.level) - rank(a.level))[0];
    const above = leveled.filter((v) => rank(v.level) > at).sort((a, b) => rank(a.level) - rank(b.level))[0];
    pick = exact ?? below ?? above ?? pool[0];
  }
  if (!pick) return null;
  if (fast) {
    const quicker = read.find((v) => v.fast && v.level === pick?.level && v.uid.startsWith(pick?.uid ?? ""));
    if (quicker) return quicker.uid;
  }
  return pick.uid;
}

/**
 * The Fusion family's variants the Devin plan offers (ADR 0253): each main model with SWE-2 Medium as its helper, the
 * helper Cognition serves at no cost, as one model per main family (`fusion-claude-opus-5.5`). The other helpers are
 * left out: hundreds of pairs no picker could show.
 */
export const DEVIN_FUSION_HELPER = "-sidekick-swe-2-medium";
