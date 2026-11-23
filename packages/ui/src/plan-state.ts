/**
 * Where a plan's usage stands, without React (the web's `PlanMeter` and the phone's meter share it).
 */

/** A plan's usage window, as the API's `PlanUsage` says it. */
export interface PlanMeterWindow {
  kind: string;
  /** `other`: the provider's name for it. */
  label?: string;
  usedPercent: number;
  resetsAt?: string;
  /** When this window was last read, where that is before its reading's `at` (`windowReadAt`). */
  at?: string;
  /** An estimated part of `usedPercent` (one agent's), in full ink over the rest of the bar. */
  part?: number;
  /** Words under the bar: whose use it is. */
  note?: string;
  /** The bar split by agent: each one's estimated part of `usedPercent` in its colours, the rest plain. */
  segments?: readonly MeterSegment[];
}

/** One agent's piece of a bar, in its colours (`light` in the dark theme). */
export interface MeterSegment {
  key: string;
  value: number;
  light: string;
  deep: string;
}

export interface PlanMeterUsage {
  windows: readonly PlanMeterWindow[];
  /** The plan refused a request for its limit. */
  limited?: boolean;
  at: string;
  /** Stuck at its limit: when the server last asked its computer to read it again. */
  checkedAt?: string;
}

/** What the meter says, in the viewer's language. */
export interface PlanMeterText {
  /** "5 horas", "Semana", or the window's `label`. */
  window(w: PlanMeterWindow): string;
  /** The compact line's name: "5h", "semana", or the window's `label`. */
  short(w: PlanMeterWindow): string;
  /** "renova às 15:40", "renova sex às 10:00". */
  resets(iso: string): string;
  /** "Quase no limite". */
  almost: string;
  /** "No limite até 15:40"; `until` null: when it resets isn't known. */
  limited(until: string | null): string;
  /** "Atualizado há 3 min". */
  updated(iso: string): string;
  /** The compact line's age of the numbers, mid-line: "atualizado há 51 min". */
  ago(iso: string): string;
  /** The same past `PLAN_STALE_MS`: "desatualizado, de há 7 h". */
  stale(iso: string): string;
  /**
   * The full meter's heading over a model group's quotas (`modelQuota`): "Só Claude and GPT"; null, over the
   * account's own, "Todos os modelos". Absent: the windows stay one list, each by its own name.
   */
  group?(name: string | null): string;
}

export type PlanState = "ok" | "almost" | "limited";

/** The usage at which a plan is "almost at the limit". */
export const PLAN_ALMOST = 80;
/** From here a window's bar is red: one long task can take a 5-hour window's last tenth. */
export const PLAN_CRITICAL = 90;

export type PlanLevel = "ok" | "almost" | "critical" | "limited";

/** How close a window (or the plan: `limited` when it refused a request) is to its limit, as its bar is colored. */
export const planLevel = (used: number, limited = false): PlanLevel =>
  limited || used >= 100 ? "limited" : used >= PLAN_CRITICAL ? "critical" : used >= PLAN_ALMOST ? "almost" : "ok";

/** Each level's color token: the phone's `c[...]`. The web maps the same levels in components.css. */
export const PLAN_TONE = {
  ok: "ink",
  almost: "warn",
  critical: "danger",
  limited: "danger",
} as const satisfies Record<PlanLevel, "ink" | "warn" | "danger">;

const KIND_ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "monthly", "other"];

/** The label the runner gives a Claude plan's paid extra usage (`get_usage` `extra_usage`, `rate_limit_event` `overage`). */
export const EXTRA_USAGE_LABEL = "Extra usage";

/** `other` windows that are no model's own week. */
const NOT_A_MODEL = new Set([EXTRA_USAGE_LABEL, "OAuth apps"]);

/** A model's own quota: an `other` window named for a model or a group of them (Claude's `model_scoped`, Antigravity's groups). */
const modelOwn = (w: { kind: string; label?: string }) => w.kind === "other" && !!w.label && !NOT_A_MODEL.has(w.label);

/**
 * A model group's own quota as the runner names it (`<group> · 5h|7d`, the Antigravity CLI's groups): the group
 * ("Claude and GPT models" → "Claude and GPT") and the window it is. Null for any other window, a model's own week
 * named by the model alone (Claude's `model_scoped`) included.
 */
export function modelQuota(w: { kind: string; label?: string }): {
  group: string;
  kind: "five_hour" | "seven_day";
} | null {
  if (!modelOwn(w) || !w.label) return null;
  const named = /^(.+?)\s*·\s*(5h|7d)$/.exec(w.label);
  const group = named?.[1]?.replace(/\s+models?$/i, "").trim();
  return group ? { group, kind: named?.[2] === "5h" ? "five_hour" : "seven_day" } : null;
}

/**
 * Whether a model's own quota (`modelOwn`) is `model`'s: its name, without the window's length and "models", each
 * model it names (`Claude and GPT models · 7d` → claude, gpt; `Gemini 4 Argon · 7d` → gemini-4-argon; `Fable`)
 * found in the model's id.
 */
const quotaOfModel = (label: string, model: string) =>
  label
    .toLowerCase()
    .replace(/\s*·\s*(?:5h|7d)$/, "")
    .replace(/\bmodels?\b/g, "")
    .split(/\s+and\s+|,|\//)
    .map((name) => name.trim().replace(/\s+/g, "-"))
    .some((name) => name !== "" && model.includes(name));
const passed = (iso: string | undefined, now: number) => iso !== undefined && Date.parse(iso) <= now;

/** When a window was last read: its own time where a later reading didn't name it, else its reading's. */
export const windowReadAt = (usage: { at?: string }, w: { at?: string }) => w.at ?? usage.at;

/**
 * A window whose own reading is older than `PLAN_STALE_MS` and that hasn't reset since: its number may be long gone
 * (the provider can start a new week early), so it is no number to show or act on.
 */
export function windowStale(usage: { at?: string }, w: { at?: string; resetsAt?: string }, now = Date.now()) {
  const read = Date.parse(windowReadAt(usage, w) ?? "");
  return Number.isFinite(read) && now - read > PLAN_STALE_MS && !passed(w.resetsAt, now);
}

/**
 * The windows tightest first (the most used, then the shortest), each with
 * `used` as it stands now: a window whose reset already passed is empty again.
 * A `stale` one (`windowStale`) comes after the fresh ones, so what leads the line and the plan's state is known.
 */
export function planWindows<W extends PlanMeterWindow>(
  usage: { windows: readonly W[]; at?: string },
  now = Date.now(),
) {
  // A model's own quota comes after the account's: the line leads with what every model runs on.
  return usage.windows
    .map((w) => ({
      ...w,
      used: passed(w.resetsAt, now) ? 0 : w.usedPercent,
      stale: windowStale(usage, w, now),
    }))
    .sort(
      (a, b) =>
        Number(modelOwn(a)) - Number(modelOwn(b)) ||
        Number(a.stale) - Number(b.stale) ||
        b.used - a.used ||
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
    );
}

/** A window's amount as a meter says it: its percentage, or for a `stale` one only how old its reading is. */
export const windowAmount = (
  usage: { at?: string },
  w: PlanMeterWindow & { used: number; stale: boolean },
  text: Pick<PlanMeterText, "ago">,
) => (w.stale ? text.ago(windowReadAt(usage, w) ?? "") : `${w.used}%`);

/**
 * A window of the whole plan: not an `other` one (a single model's week, extra usage, another model group's quota),
 * which never puts the plan at its limit; a refusal it causes still does (`limited`).
 */
export const planOwn = (w: Pick<PlanMeterWindow, "kind">) => w.kind !== "other";

/** A window of the whole plan is full now. */
export const planFull = (usage: { windows: readonly PlanMeterWindow[] }, now = Date.now()) =>
  planWindows(usage, now).some((w) => planOwn(w) && w.used >= 100);

/**
 * Where the plan stands: at its limit (a window is full, or it refused a
 * request and no full window has reset since), almost (`PLAN_ALMOST`), or fine.
 * `until`: when every full window has reset; `used`: the tightest window's.
 */
export function planState(
  usage: PlanMeterUsage,
  now = Date.now(),
): { state: PlanState; until: string | null; used: number } {
  const rows = planWindows(usage, now).filter(planOwn);
  const full = rows.filter((w) => w.used >= 100);
  const refused = usage.limited === true && !usage.windows.some((w) => planOwn(w) && w.usedPercent >= 100);
  const used = rows[0]?.used ?? 0;
  if (full.length === 0 && !refused) return { state: used >= PLAN_ALMOST ? "almost" : "ok", until: null, used };
  const resets = full.flatMap((w) => (w.resetsAt ? [w.resetsAt] : []));
  const until = full.length > 0 && resets.length === full.length ? (resets.sort().at(-1) ?? null) : null;
  return { state: "limited", until, used };
}

/** How many windows the compact line names; every window is in its title and in the full meter. */
const LINE_WINDOWS = 2;

/**
 * A plan's state as the one word a closed row has room for ("No limite", "Quase no limite"), with the level its bar
 * is colored by. Null while it is fine: a row says nothing then.
 */
export function planAttention(
  usage: PlanMeterUsage,
  text: Pick<PlanMeterText, "almost" | "limited">,
  now = Date.now(),
): { word: string; level: Exclude<PlanLevel, "ok"> } | null {
  const { state, used } = planState(usage, now);
  if (state === "ok") return null;
  const level = planLevel(used, state === "limited");
  return { word: state === "limited" ? text.limited(null) : text.almost, level: level === "ok" ? "almost" : level };
}

/**
 * When a plan was last read or asked about: its reading's time, or the last time the server asked its computer to read
 * it again while it was stuck at its limit (`checkedAt`), whichever is later. Null with neither.
 */
export function planCheckedAt(usage: { at?: string; checkedAt?: string } | null | undefined): string | null {
  const at = Math.max(Date.parse(usage?.at ?? "") || 0, Date.parse(usage?.checkedAt ?? "") || 0);
  return at > 0 ? new Date(at).toISOString() : null;
}

/** A window of this reading reset since it was read or last asked for (`planCheckedAt`): its numbers are out of date. */
export function resetSinceRead(
  usage: { at?: string; checkedAt?: string; windows: readonly PlanMeterWindow[] },
  now = Date.now(),
) {
  const read = Date.parse(planCheckedAt(usage) ?? "") || 0;
  return usage.windows.some((w) => {
    const reset = Date.parse(w.resetsAt ?? "");
    return reset > read && reset <= now;
  });
}

/** From this age the compact line says how old its numbers are. */
export const PLAN_AGE_SHOWN_MS = 10 * 60_000;
/** Numbers older than this read as out of date. */
export const PLAN_STALE_MS = 6 * 3_600_000;

/** Whether a meter says how old its numbers are: from `PLAN_AGE_SHOWN_MS`, and always at the limit. */
export const planAgeShown = (usage: PlanMeterUsage, now = Date.now()) =>
  planState(usage, now).state === "limited" || now - Date.parse(planCheckedAt(usage) ?? usage.at) >= PLAN_AGE_SHOWN_MS;

/**
 * The compact meter's words: the tightest windows by their short names ("semana 40% · 5h 12%"), every window
 * with its reset for the title, the tightest (`top`) for its one bar, and only near or at the limit what matters then
 * ("Quase no limite · renova às 14:00", "No limite até 14:00"). Null while no window is known: nothing, never 0%.
 * A plan that refused a request before any window was known is still at the limit: no windows, no bar, only the alert.
 * `age`: how old the numbers are, from `PLAN_AGE_SHOWN_MS` and always at the limit (out of date past `PLAN_STALE_MS`,
 * `stale`); null before.
 */
export function planLine(usage: PlanMeterUsage, text: PlanMeterText, now = Date.now()) {
  const rows = planWindows(usage, now);
  const top = rows[0] && !rows[0].stale ? rows[0] : undefined;
  const { state, until } = planState(usage, now);
  if (!rows[0] && state !== "limited") return null;
  const reset = (w?: PlanMeterWindow) => (w?.resetsAt && !passed(w.resetsAt, now) ? text.resets(w.resetsAt) : null);
  const join = (parts: (string | null)[]) => parts.filter(Boolean).join(" · ");
  // At the limit the plan is asked again every few minutes (`planCheckedAt`): how long ago that was always shows then.
  const at = planCheckedAt(usage) ?? usage.at;
  const old = now - Date.parse(at);
  const shown = rows.slice(0, LINE_WINDOWS);
  // Windows read too long ago say only that, once, after the known ones: "5h 12% · semana atualizado há 2 d".
  const unsure = shown.filter((w) => w.stale);
  const oldest = unsure.map((w) => windowReadAt(usage, w) ?? at).sort()[0];
  const stale = old > PLAN_STALE_MS || unsure.length > 0;
  const age = oldest
    ? null
    : old > PLAN_STALE_MS
      ? text.stale(at)
      : old >= PLAN_AGE_SHOWN_MS || state === "limited"
        ? text.ago(at)
        : null;
  return {
    state,
    top,
    stale,
    age,
    line: join([
      ...shown.filter((w) => !w.stale).map((w) => `${text.short(w)} ${w.used}%`),
      oldest ? `${unsure.map((w) => text.short(w)).join(", ")} ${text.ago(oldest)}` : null,
    ]),
    title: rows.map((w) => join([`${text.window(w)} ${windowAmount(usage, w, text)}`, reset(w)])).join("\n"),
    alert: state === "limited" ? text.limited(until) : state === "almost" ? join([text.almost, reset(top)]) : null,
  };
}

/** What `limitOffers` reads of an AI account (the API's `MachineAccount`). */
export interface OfferAccount {
  id: string;
  kind: string;
  /** A coding plan's maker; null: the CLI's own sign-in. */
  provider: string | null;
  mine: boolean;
  status: string;
  usedBy: readonly string[];
  usage: PlanMeterUsage | null;
  /** It thinks for every agent its owner gives it on that computer. */
  shared?: boolean;
  /** Its place in the workspace's order of use; null: after the placed ones. */
  useOrder?: number | null;
  /** The oldest login of the same account (one account may be signed in once per agent); absent: an older server. */
  sameAs?: string;
}

/**
 * At the limit, the owner's other accounts that could think instead: of the
 * same kind and plan maker (another maker's models would think instead),
 * signed in, not at their own limit, and free or made for all of the owner's
 * agents there. A login another agent thinks with is never offered (it serves
 * one agent; moving plans between agents to dodge a limit isn't). Another
 * login of the account in use shares its limit and is never offered; an
 * account signed in once per agent is offered once. In the order of use, then
 * most headroom first, unknown usage last. Shared by the web's and the
 * phone's agent settings.
 */
export function limitOffers<A extends OfferAccount>(
  accounts: readonly A[],
  kind: string,
  current: string | null,
  now = Date.now(),
): { account: A; used: number | null }[] {
  const inUse = accounts.find((a) => a.id === current);
  const provider = inUse?.provider ?? null;
  const accountOf = (a: A) => a.sameAs ?? a.id;
  return accounts
    .filter(
      (a) =>
        a.mine &&
        (!inUse || accountOf(a) !== accountOf(inUse)) &&
        a.kind === kind &&
        (a.provider ?? null) === provider &&
        a.id !== current &&
        a.status === "active" &&
        (a.usedBy.length === 0 || a.shared === true),
    )
    .map((account) => ({ account, plan: account.usage ? planState(account.usage, now) : null }))
    .filter((o) => o.plan?.state !== "limited")
    .map((o) => ({ account: o.account, used: o.plan?.used ?? null }))
    .sort(
      (a, b) =>
        (a.account.useOrder ?? Number.POSITIVE_INFINITY) - (b.account.useOrder ?? Number.POSITIVE_INFINITY) ||
        (a.used ?? 101) - (b.used ?? 101),
    )
    .filter((o, i, all) => all.findIndex((x) => accountOf(x.account) === accountOf(o.account)) === i);
}

/** From here long work pauses until the window resets (ADR 0118); replies to people go on until the limit. */
export const PLAN_PAUSE = 99;
/** From here an agent is told where its plan stands, so it can say a long task may pause. */
export const PLAN_NOTICE = 90;

/** How long each window lasts: a reading with no reset counts for no longer than that. */
const WINDOW_MS: Partial<Record<string, number>> = {
  five_hour: 5 * 3600_000,
  seven_day: 7 * 86_400_000,
  seven_day_opus: 7 * 86_400_000,
  seven_day_sonnet: 7 * 86_400_000,
  monthly: 31 * 86_400_000,
  // A model's own week.
  other: 7 * 86_400_000,
};

/** Extra usage that is on and still has room under its own cap: what long work may go on into. */
export const extraUsageLeft = (usage: { windows: readonly PlanMeterWindow[] } | null | undefined) =>
  usage?.windows.some((w) => w.kind === "other" && w.label === EXTRA_USAGE_LABEL && w.usedPercent < PLAN_PAUSE) ??
  false;

/**
 * The window that binds long work on a run with `model`: the most used of the windows that apply to it and still
 * count now. A model's own week counts only for that model; extra usage and OAuth apps never count.
 * A window whose reset passed reads 0, and one with no reset stops counting once its length passed since the
 * reading. Null: nothing known, which never pauses anything.
 */
export function planBinding(
  usage: (PlanMeterUsage & { at: string }) | null | undefined,
  options: { model?: string | null; now?: number } = {},
): { kind: string; used: number; resetsAt?: string } | null {
  if (!usage) return null;
  const now = options.now ?? Date.now();
  const model = (options.model ?? "").toLowerCase();
  const read = Date.parse(usage.at);
  let top: { kind: string; used: number; resetsAt?: string } | null = null;
  for (const w of usage.windows) {
    // A model's own week (Claude's `model_scoped`, stored as `other` with the model's name) counts for that model.
    if (w.kind === "other" && (!w.label || NOT_A_MODEL.has(w.label) || !quotaOfModel(w.label, model))) continue;
    if (w.kind === "seven_day_opus" && !model.includes("opus")) continue;
    if (w.kind === "seven_day_sonnet" && !model.includes("sonnet")) continue;
    const length = WINDOW_MS[w.kind] ?? 0;
    const live = w.resetsAt ? Date.parse(w.resetsAt) > now : Number.isFinite(read) && now - read < length;
    // A window read too long ago may have reset early: it never pauses work (a refusal still does, `limited`).
    if (!live || windowStale(usage, w, now)) continue;
    if (!top || w.usedPercent > top.used) {
      top = { kind: w.kind, used: w.usedPercent, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) };
    }
  }
  return top;
}

/** When the windows renew, on one line: "renova 9 nov às 07:00", or each after its short name when there are more. */
export function renewals(rows: readonly PlanMeterWindow[], text: PlanMeterText, now = Date.now()) {
  const due = rows.flatMap((w) => (w.resetsAt && !passed(w.resetsAt, now) ? [{ w, at: w.resetsAt }] : []));
  if (due.length <= 1) return due[0] ? text.resets(due[0].at) : null;
  return due.map(({ w, at }) => `${text.short(w)} ${text.resets(at)}`).join(" · ");
}

/** What ranks a row of accounts to pick from (`sortHave`). */
export interface HaveRank {
  /** Its plan's limits; null where nothing says (a key). */
  usage: PlanMeterUsage | null;
  /** It can't be picked. */
  off?: boolean;
  /** Picking it asks for a sign-in. */
  signIn?: boolean;
  /** A workspace key. */
  isKey?: boolean;
}

/**
 * Accounts to pick from, web and phone: a plan used in one click first, the one with most room on top (one that
 * doesn't say counts as half used); then one that asks for a sign-in, the workspace's keys, a plan at its limit, and
 * last what can't be picked.
 */
export function sortHave<T extends HaveRank>(items: readonly T[], now = Date.now()): T[] {
  const rank = (i: HaveRank) => {
    const s = i.usage ? planState(i.usage, now) : null;
    return (
      (i.off ? 8000 : 0) +
      (s?.state === "limited" ? 4000 : 0) +
      (i.isKey ? 2000 : 0) +
      (i.signIn ? 1000 : 0) +
      (s?.used ?? 50)
    );
  };
  return [...items].sort((a, b) => rank(a) - rank(b));
}
