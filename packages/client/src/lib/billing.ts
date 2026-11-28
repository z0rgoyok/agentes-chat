import type { TFunction } from "i18next";
import type { OrgStanding, OrgSummary, WorkspaceLimits } from "../api/types";
import { formatBytes } from "./files";
import { formatInt } from "./format";
import { can } from "./permissions";

/** Mirror of the server's billing holds (`packages/engine/src/standing.ts`, ADR 0079). */
export const BILLING_HOLDS = ["payment", "unpaid", "ended"] as const;
export type BillingHold = (typeof BILLING_HOLDS)[number];

/**
 * The billing hold a workspace is on, or null: a hold whose told reason is one of the codes, which the apps say in
 * the person's words, never as it comes.
 */
export const billingHoldOf = (
  standing: Pick<OrgStanding, "state" | "reason"> | null | undefined,
): BillingHold | null =>
  standing?.state === "hold" ? (BILLING_HOLDS.find((code) => code === standing.reason) ?? null) : null;

/**
 * Where its payer may move the workspace's plan (ADR 0079): every other workspace of theirs where they manage billing,
 * on a billing hold (no plan in force) and not being deleted. None when they don't pay for this one's plan.
 */
export const planMoveTargets = (orgs: readonly OrgSummary[], from: Pick<OrgSummary, "id" | "paysPlan">) =>
  from.paysPlan
    ? orgs.filter(
        (o) => o.id !== from.id && !o.deletion && can(o, "manage_billing") && billingHoldOf(o.standing) !== null,
      )
    : [];

/**
 * Nothing held over the workspace and no suspension: with billing on, the server's only word that its plan is in
 * force.
 */
export const standingActive = (standing: Pick<OrgStanding, "state"> | null | undefined) =>
  (standing?.state ?? "active") === "active";

/**
 * Back from a paid Checkout, the billing service adds `?paid=1` to the return path (ADR 0079). It is the address's
 * word, not the server's: until the hold lifts, the hold banner says the payment arrived, and the onboarding says it's
 * being confirmed, for a minute at most. The router reads `1` as a number, and the onboarding forwards it as `true`.
 */
export const isPaidReturn = (search: Record<string, unknown>) =>
  search.paid === 1 || search.paid === true || search.paid === "1";

/** The periods a plan is paid for. */
export const PLAN_PERIODS = ["month", "year"] as const;
export type PlanPeriod = (typeof PLAN_PERIODS)[number];

/**
 * What a paid return says it bought, when the billing service names it: the plan's key (`plan`) and its period
 * (`period`), beside `paid`. Null when the address isn't a paid return. Keys only, never a name or a price: the app
 * reads the plan's name from the billing service's own plan list (`planOfferOf`).
 */
export interface PaidReturn {
  plan?: string;
  period?: PlanPeriod;
}

export function paidReturnOf(search: Record<string, unknown>): PaidReturn | null {
  if (!isPaidReturn(search)) return null;
  const plan = typeof search.plan === "string" && PLAN_KEY.test(search.plan) ? search.plan : undefined;
  const period = PLAN_PERIODS.find((p) => p === search.period);
  return { ...(plan ? { plan } : {}), ...(period ? { period } : {}) };
}

/** The search a redirect forwards a paid return with: `paid`, and what it bought. Nothing when it isn't one. */
export const paidSearch = (search: Record<string, unknown>): { paid?: true } & PaidReturn => {
  const paid = paidReturnOf(search);
  return paid ? { paid: true, ...paid } : {};
};

/**
 * The plan in force, in one line: by its name and period when the paid return carried them (`plan`: the name the
 * billing service's plan list gives the bought key), else only that it is on.
 */
export function paidLine(t: TFunction, plan: string | null | undefined, period: PlanPeriod | undefined) {
  if (!plan) return t("paidMoment.on");
  if (period === "month") return t("paidMoment.onMonth", { plan });
  if (period === "year") return t("paidMoment.onYear", { plan });
  return t("paidMoment.onPlan", { plan });
}

/** The same plan as a row's value ("Team, yearly"): its name alone when the return said no period. */
export function planLine(t: TFunction, plan: string, period: PlanPeriod | undefined) {
  if (period === "month") return t("billing.planMonth", { plan });
  if (period === "year") return t("billing.planYear", { plan });
  return plan;
}

/**
 * What the plan in force gives, in one line, from the limits the billing service set: the seats paid for and the room
 * for files (a workspace's own bucket counts against none). Null while they aren't known.
 */
export function paidRoom(t: TFunction, locale: string, limits: WorkspaceLimits | null | undefined): string | null {
  if (!limits) return null;
  const people = limits.members.limit;
  const bytes = limits.storage.ownStorage ? null : limits.storage.limitBytes;
  const files = bytes === null ? null : formatBytes(locale, bytes);
  if (people !== null && files !== null)
    return t("paidMoment.room.both", { count: people, people: formatInt(locale, people), files });
  if (people !== null) return t("paidMoment.room.people", { count: people, people: formatInt(locale, people) });
  if (files !== null) return t("paidMoment.room.files", { files });
  return t("paidMoment.room.none");
}

/**
 * The workspace's own computer as it is now: on, or getting ready. Its owners are told when it is on (the
 * `computer_ready` notification), so only they are promised it.
 */
export const paidComputerLine = (t: TFunction, on: boolean, owner: boolean) =>
  t(on ? "paidMoment.computer.on" : owner ? "paidMoment.computer.startingTold" : "paidMoment.computer.starting");

/**
 * The phone's trigger for the moment a plan turns on (it never sees the paid return, ADR 0079): the workspace was on a
 * billing hold the last time this device looked (`wasHeld`) and its plan is in force now. Never on the first look.
 */
export const planTurnedOn = (wasHeld: boolean | undefined, standing: Pick<OrgStanding, "state"> | null | undefined) =>
  wasHeld === true && standingActive(standing);

/**
 * The workspaces this device last saw on a billing hold (`held`, kept by each app), after a look at `orgs`: the ones
 * held now are added; the one on screen (`current`) whose plan turned on is taken out, and `turnedOn` says to show
 * the moment for it. One that turned on elsewhere stays listed until it is opened.
 */
export function planHeldNext(
  held: readonly string[],
  orgs: readonly Pick<OrgSummary, "id" | "standing">[],
  current: string | null,
): { held: string[]; turnedOn: boolean } {
  const org = orgs.find((o) => o.id === current);
  const turnedOn = org !== undefined && planTurnedOn(held.includes(org.id), org.standing);
  const now = orgs.filter((o) => billingHoldOf(o.standing) !== null).map((o) => o.id);
  const next = [...new Set([...held.filter((id) => !(turnedOn && id === current)), ...now])];
  return { held: next, turnedOn };
}

/** The plan the onboarding offers: its key for the billing link, its name, and its price as the billing service writes it. */
export interface PlanOffer {
  key: string;
  name: string;
  price?: string;
}

const PLAN_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const shortText = (v: unknown, max: number) =>
  typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined;

/**
 * The recommended plan (or the one whose `key` is given) from the billing service's public plan list
 * (`GET {billingUrl}/plans.json`), or null when the list isn't one: the app then names no plan. The core server never names a plan nor a price (ADR 0079 §6).
 * `alone` (a personal workspace) takes the list's `recommendedAlone`, the plan for one person, where the list has one.
 */
export function planOfferOf(json: unknown, key?: string, alone = false): PlanOffer | null {
  if (!json || typeof json !== "object") return null;
  const { recommended, recommendedAlone, plans } = json as {
    recommended?: unknown;
    recommendedAlone?: unknown;
    plans?: unknown;
  };
  const wanted = key ?? (alone && typeof recommendedAlone === "string" ? recommendedAlone : recommended);
  if (typeof wanted !== "string" || !Array.isArray(plans)) return null;
  const plan = plans.find((p) => (p as { key?: unknown } | null)?.key === wanted) as
    | Record<string, unknown>
    | undefined;
  const name = shortText(plan?.name, 40);
  if (!plan || !PLAN_KEY.test(wanted) || !name) return null;
  const price = shortText(plan.price, 24);
  return { key: wanted, name, ...(price ? { price } : {}) };
}
