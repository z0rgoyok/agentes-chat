import type { TFunction } from "i18next";
import type { Agent, ApiRule, Routine, RoutineInput } from "../api/types";
import { createsRoutinesFor } from "./audience";
import {
  ANALYTICS,
  CRM,
  everyDay,
  HELP_DESK,
  PAYMENTS,
  ROUTINE_TEMPLATES,
  type RoutineTemplateItem,
  TASKS,
  type TemplateRule,
  templateRule,
  weekdays,
  weekly,
} from "./routine-templates";

/**
 * The routine an app brings when it is connected (ADR 0242): connecting ends with it already on, one per app, so a
 * person sees an agent work on what they just connected without setting anything up. Its words, instructions and
 * report are its template's in New routine (`ROUTINE_TEMPLATES`); it runs on a schedule (never on every email: a
 * mail event costs a provider call each), reports in its creator's DM with the agent, and only speaks with news.
 */
type ScheduleTemplate = Extract<RoutineTemplateItem, { kind: "schedule" }>;

/** The templates apps bring, each with its line in `connectFlow.routine`. */
export type ConnectRoutineKey = Extract<
  ScheduleTemplate["key"],
  "inbox" | "dayPlan" | "failed" | "leads" | "tickets" | "late" | "traffic" | "openPrs" | "errors"
>;

export interface ConnectRoutine {
  template: ConnectRoutineKey;
  /** Catalog connector ids (having one is enough), or `mailbox` for a connected mailbox (Gmail, Outlook, IMAP). */
  apps: "mailbox" | readonly string[];
  /** When it runs; its template's rule when left out. */
  rule?: TemplateRule;
}

export const CONNECT_ROUTINES: readonly ConnectRoutine[] = [
  { template: "inbox", apps: "mailbox" },
  { template: "dayPlan", apps: ["google-calendar"] },
  { template: "failed", apps: PAYMENTS },
  { template: "leads", apps: CRM },
  { template: "tickets", apps: HELP_DESK },
  { template: "late", apps: TASKS },
  // An analytics app: the week's numbers against the week before, every Monday.
  { template: "traffic", apps: ANALYTICS },
  // GitHub's and Sentry's events need a webhook connecting doesn't set up: a check on a schedule works at once.
  { template: "openPrs", apps: ["github"] },
  { template: "errors", apps: ["sentry"], rule: weekdays("09:00", "14:00") },
];

/** The routine an app brings (`mailbox` for a mailbox), or null for an app with none. */
export function connectRoutineOf(app: string | null | undefined): ConnectRoutine | null {
  if (!app) return null;
  return CONNECT_ROUTINES.find((r) => (r.apps === "mailbox" ? app === "mailbox" : r.apps.includes(app))) ?? null;
}

const templateOf = (r: ConnectRoutine): ScheduleTemplate => {
  const found = ROUTINE_TEMPLATES.find((t) => t.key === r.template);
  if (found?.kind !== "schedule") throw new Error(`No schedule template "${r.template}"`);
  return found;
};

/** When: the rules a person picks from, the routine's own first. */
const WHEN: readonly TemplateRule[] = [
  weekdays("09:00", "14:00"),
  weekdays("09:00"),
  weekdays("10:00"),
  everyDay("08:00"),
  weekly("MO", "09:00"),
];
const sameRule = (a: TemplateRule, b: TemplateRule) => JSON.stringify(a) === JSON.stringify(b);

export function connectRoutineRules(r: ConnectRoutine): TemplateRule[] {
  const own = r.rule ?? templateOf(r).rule;
  return [own, ...WHEN.filter((w) => !sameRule(w, own))];
}

/** A rule as the pickers and `ruleSentence` read it: from `today` (YYYY-MM-DD), in `timezone`. */
export const connectRule = (rule: TemplateRule, timezone: string, today: string) =>
  templateRule({ rule }, { start: today, timezone });

const plain = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

type Candidate = Pick<Agent, "id" | "name" | "role" | "builtin" | "former" | "canManageRoutines" | "canTalk">;

/**
 * The agents a routine may be made for here: the ones I set up routines for and that answer me (`createsRoutinesFor`,
 * as the server's `createRoutine`), still in the team; the team's right hand last.
 */
export function connectRoutineAgents<A extends Candidate>(agents: readonly A[]): A[] {
  const mine = agents.filter((a) => !a.former && createsRoutinesFor(a));
  return [...mine.filter((a) => a.builtin !== "right_hand"), ...mine.filter((a) => a.builtin === "right_hand")];
}

/** The agent it starts with: the first that may run it (`connectRoutineAgents`); the person picks another there. */
export function suggestedAgent<A extends Candidate>(agents: readonly A[]): A | null {
  return agents[0] ?? null;
}

/** The routine's name, in the person's language: its template's. */
export const connectRoutineName = (t: TFunction, r: ConnectRoutine) => t(`routines.presets.${r.template}.name`);

/**
 * Whether it was made already (connecting again, a second account): one of the routines I see has its name. A
 * renamed one doesn't count, so connecting again offers it.
 */
export function connectRoutineMade(t: TFunction, r: ConnectRoutine, routines: readonly Pick<Routine, "name">[]) {
  const name = plain(connectRoutineName(t, r));
  return routines.some((x) => plain(x.name) === name);
}

/** What `POST …/routines` takes: its template's name, instructions and report, in my DM with the agent. */
export function connectRoutineInput(
  t: TFunction,
  r: ConnectRoutine,
  pick: { agentId: string; rule: TemplateRule; timezone: string; today: string; mailbox?: string },
): RoutineInput {
  const template = templateOf(r);
  const instructions = t(`routines.presets.${r.template}.prompt`);
  const rule = connectRule(pick.rule, pick.timezone, pick.today);
  const api: ApiRule = {
    freq: rule.freq,
    interval: rule.interval,
    times: rule.times,
    timezone: rule.timezone,
    start: rule.start,
    until: null,
    count: null,
    ...("byWeekday" in rule && rule.byWeekday?.length ? { byWeekday: [...rule.byWeekday] } : {}),
    ...("byMonthDay" in rule && rule.byMonthDay?.length ? { byMonthDay: [...rule.byMonthDay] } : {}),
  };
  return {
    name: connectRoutineName(t, r),
    agentId: pick.agentId,
    prompt: pick.mailbox
      ? `${instructions} ${t("connectFlow.routine.mailboxOnly", { address: pick.mailbox })}`
      : instructions,
    target: { type: "dm" },
    trigger: { type: "schedule", rule: api },
    report: "report" in template ? template.report : "when_new",
  };
}

/** Today in this device's calendar (YYYY-MM-DD): where a new rule starts. */
export function todayYmd(now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
