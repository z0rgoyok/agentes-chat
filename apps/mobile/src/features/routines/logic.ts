import type {
  Agent,
  MailFolder,
  Routine,
  RoutineConnectorTrigger,
  RoutineEmailFilter,
  RoutineEvent,
  RoutineInput,
  RoutinePatch,
  RoutineReport,
  RoutineTarget,
  RoutineTargetInput,
} from "@agenteschat/client";
import { createsRoutinesFor } from "@agenteschat/client/lib/audience";
import type { RunStatus } from "@agenteschat/client/lib/calendar";
import { pausedFix, type RoutineFix, runPixels } from "@agenteschat/client/lib/routine-view";
import type { IconName } from "@/ui";
import { defaultRule, fromApiRule, onceAt, onceRule, type RecurrenceRule, toApiRule } from "./rule";

/**
 * Rotinas on the phone, as pure rules (the web's `RoutinesPage` says the same): which routines are live,
 * paused or done, what the list shows under each filter, what the "next" and the runs' lines say, the icons,
 * and the form's draft turned into what the API takes (a new routine, or only what changed). No React Native,
 * no i18n: the screens turn the answers into words.
 */

export const ROUTINE_EVENTS: RoutineEvent[] = [
  "sentry.issue_created",
  "github.pr_opened",
  "issue.created",
  "deploy.succeeded",
];

/** Started by something happening (an event, an email, a webhook call), not by the clock. */
export const isEventDriven = (r: Pick<Routine, "trigger">) =>
  r.trigger.type !== "schedule" && r.trigger.type !== "once";
/** An email routine whose mailbox needs reconnecting (or whose watch fails, or that MillionSend refused). */
export const mailTrouble = (r: Pick<Routine, "trigger">) =>
  (r.trigger.type === "email" || r.trigger.type === "connector") && r.trigger.status && r.trigger.status !== "active"
    ? r.trigger.status
    : null;
/** A run of it is working now (Parar stops it). */
export const isRunning = (r: Pick<Routine, "state">) => r.state === "running";
/** A run of it is at work: working, waiting for a person or its computer, or paused near its plan's limit. */
export const isAtWork = (r: Pick<Routine, "state">) =>
  isRunning(r) || r.state === "waiting_person" || r.state === "waiting_computer" || r.state === "usage_paused";
/** A one-off that already fired (or was cancelled): no switch, no "Rodar agora", nothing left to run. */
export const hasFired = (r: Pick<Routine, "trigger" | "active">) => r.trigger.type === "once" && !r.active;
/** A one-off that fired and whose run ended: shown muted, under "Concluídos" (while its run works, it is live). */
export const isDoneOnce = (r: Pick<Routine, "trigger" | "active" | "state">) => hasFired(r) && !isAtWork(r);
/** Paused: inactive and not a one-off (a fired one-off is done, or live while its run works). */
export const isPaused = (r: Pick<Routine, "trigger" | "active">) => !r.active && r.trigger.type !== "once";
/** A plain reminder from the chat: the agent's own message at a time, no run (nothing to run or stop). */
export const isReminder = (r: Pick<Routine, "target">) =>
  r.target.type === "conversation" && r.target.reminder === true;

/**
 * A title for the row: a routine made from a chat message may be named with its whole prompt; a widget's routine is
 * its widget's title (ADR 0135).
 */
export function routineTitle(r: Pick<Routine, "name" | "prompt"> & Partial<Pick<Routine, "widget">>): string {
  if (r.widget?.title) return r.widget.title;
  const name = r.name.trim();
  if (name !== (r.prompt ?? "").trim() && name.length <= 80) return name;
  const first = (name.split("\n")[0] ?? name).trim();
  if (first.length <= 60) return first;
  const cut = first.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).trimEnd()}…`;
}

/** Every N minutes for a routine kept as a cron (`*\/N * * * *`, no rule); null otherwise. */
export function everyMinutes(cron: string): number | null {
  const c = cron.trim();
  const every = /^\*\/(\d+) \* \* \* \*$/.exec(c)?.[1] ?? (c === "* * * * *" ? "1" : null);
  return every ? Number(every) : null;
}

// ── The list ────────────────────────────────────────────────────────────────

export const STATUS_FILTERS = ["all", "active", "paused", "event"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export interface RoutineSections<T> {
  /** "No ar" (or "Pausadas" when that is the filter). */
  live: T[];
  paused: T[];
  /** One-offs that already ran: "Concluídos (n)", folded, only under "Todas". */
  done: T[];
  counts: Record<StatusFilter, number>;
  /** A search, an agent or a status narrows the list (nothing left says "Nenhuma rotina com esses filtros"). */
  filtered: boolean;
}

/**
 * The list under the search, the agent and the status, in the server's order: the counts are of what the
 * search and the agent leave (done one-offs apart), as on the web. `whenOf` is the "when" in words (searched).
 */
export function routineSections<T extends Routine>(
  list: readonly T[],
  filter: { status: StatusFilter; agentId: string | null; query: string },
  whenOf: (r: T) => string,
): RoutineSections<T> {
  const query = filter.query.trim().toLowerCase();
  const shown = list.filter(
    (r) =>
      (!filter.agentId || r.agentId === filter.agentId) &&
      (!query || `${r.name} ${r.prompt ?? ""} ${whenOf(r)}`.toLowerCase().includes(query)),
  );
  const current = shown.filter((r) => !isDoneOnce(r));
  const byStatus = (r: T) =>
    filter.status === "all" ||
    (filter.status === "active" && r.active) ||
    (filter.status === "paused" && isPaused(r)) ||
    (filter.status === "event" && isEventDriven(r));
  return {
    live: current.filter((r) => byStatus(r) && !isPaused(r)),
    paused: current.filter((r) => byStatus(r) && isPaused(r)),
    done: shown.filter(isDoneOnce),
    counts: {
      all: current.length,
      active: current.filter((r) => r.active).length,
      paused: current.filter(isPaused).length,
      event: current.filter(isEventDriven).length,
    },
    filtered: Boolean(filter.agentId) || query.length > 0 || filter.status !== "all",
  };
}

/** One agent's routines on the list: its face and name head their section (the web reads them by agent). */
export interface AgentGroup<T> {
  agentId: string;
  routines: T[];
}

/** One name order per language, made once: `localeCompare` with a language builds a collator on every comparison. */
const nameOrders = new Map<string, Intl.Collator>();
const nameOrder = (locale?: string): Intl.Collator => {
  const key = locale ?? "";
  let order = nameOrders.get(key);
  if (!order) {
    order = new Intl.Collator(locale, { sensitivity: "base" });
    nameOrders.set(key, order);
  }
  return order;
};

/**
 * The list broken by agent, one section each: the agents A to Z by `nameOf` (in `locale`), each one's routines in the
 * list's order (`routineSections`' live ones before its paused ones).
 */
export function byAgent<T extends Pick<Routine, "agentId">>(
  list: readonly T[],
  nameOf: (agentId: string) => string,
  locale?: string,
): AgentGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const r of list) groups.set(r.agentId, [...(groups.get(r.agentId) ?? []), r]);
  const order = nameOrder(locale);
  return [...groups]
    .map(([agentId, routines]) => ({ agentId, routines }))
    .sort((a, b) => order.compare(nameOf(a.agentId), nameOf(b.agentId)));
}

// ── Icons (the phone's set) ─────────────────────────────────────────────────

/** Where it delivers: a DM, a thread, a channel, the Drive. */
export function targetIcon(target: RoutineTarget): IconName {
  switch (target.type) {
    case "dm":
      return "chat";
    case "conversation":
      return target.threadId ? "reply" : "hash";
    case "artifact":
      return "doc";
    case "widget":
      return "chart";
    default:
      return "hash";
  }
}

/** What starts it: an event, an email, a reminder, the clock. */
export function whenIcon(r: Pick<Routine, "trigger" | "target">): IconName {
  if (r.trigger.type === "event") return "bolt";
  if (r.trigger.type === "email" || r.trigger.type === "connector") return "mail";
  if (r.trigger.type === "webhook") return "globe";
  if (r.trigger.type === "once" && isReminder(r)) return "bell";
  return "clock";
}

/** The state chip's icon (`routineStateWords`' names in the phone's set; running shows the agent's orbit). */
export const STATE_ICON: Record<"repeat" | "pause" | "alert" | "computer" | "waiting" | "spinner", IconName> = {
  repeat: "clock",
  pause: "pause",
  alert: "x",
  computer: "laptop",
  waiting: "wait",
  spinner: "clock",
};

/** A one-tap fix's icon. */
export const FIX_ICON: Record<RoutineFix, IconName> = { add_agent: "plus", take_over: "join", resume: "play" };

/**
 * The one-tap fix a paused routine offers me (`pausedFix`), for who changes it (`canManage`). "Take over" makes it
 * mine, the server's create check (`takeOverRoutine`, ADR 0053 §6.2): only where I may make one for its agent
 * (`createsRoutinesFor`, its entry in the directory; ADR 0085 addendum of 2026-11-17).
 */
export function fixFor(
  r: Pick<Routine, "active" | "pausedReason" | "target" | "canManage">,
  agent: Pick<Agent, "canManageRoutines" | "canTalk"> | undefined,
): RoutineFix | null {
  const fix = r.canManage ? pausedFix(r) : null;
  return fix === "take_over" && !createsRoutinesFor(agent) ? null : fix;
}

// ── What the row says under the "when" ──────────────────────────────────────

/**
 * The line under the "when": working now, fired at (a one-off), paused, an event's or an email's week, or the
 * next run (in minutes within the hour, hours and minutes within 20 hours, else the day and time).
 */
export type NextLine =
  | { kind: "running" }
  | { kind: "fired"; at: string }
  | { kind: "canceled" }
  | { kind: "paused" }
  | { kind: "event" | "email" | "webhook"; week: number }
  | { kind: "none" }
  | { kind: "soon" }
  | { kind: "minutes"; minutes: number }
  | { kind: "hours"; h: number; m: number }
  | { kind: "at"; iso: string };

export function nextLine(
  r: Pick<Routine, "state" | "trigger" | "active" | "lastRun" | "recentRuns" | "nextRunAt">,
  now: Date,
): NextLine {
  if (isRunning(r)) return { kind: "running" };
  if (hasFired(r)) return r.lastRun ? { kind: "fired", at: r.lastRun.at } : { kind: "canceled" };
  if (!r.active) return { kind: "paused" };
  if (isEventDriven(r)) {
    const week = r.recentRuns.filter((x) => now.getTime() - new Date(x.at).getTime() < 7 * 86_400_000).length;
    const kind = r.trigger.type === "connector" ? "email" : r.trigger.type;
    return { kind: kind === "email" || kind === "webhook" ? kind : "event", week };
  }
  if (!r.nextRunAt) return { kind: "none" };
  const ms = new Date(r.nextRunAt).getTime() - now.getTime();
  if (ms <= 60_000) return { kind: "soon" };
  if (ms < 3_600_000) return { kind: "minutes", minutes: Math.floor(ms / 60_000) };
  if (ms < 20 * 3_600_000)
    return { kind: "hours", h: Math.floor(ms / 3_600_000), m: Math.floor((ms % 3_600_000) / 60_000) };
  return { kind: "at", iso: r.nextRunAt };
}

/** The runs' caption beside the strip: working, never ran, silent in N of M, stopped, or the last one. */
export type RunCaption =
  | { kind: "running" }
  | { kind: "never" }
  | { kind: "silentOf"; count: number; total: number }
  | { kind: "stopped"; at: string }
  | { kind: "last"; status: RunStatus; at: string };

export function runCaption(r: Pick<Routine, "state" | "recentRuns" | "lastRun">): RunCaption {
  if (isRunning(r)) return { kind: "running" };
  // The finished runs (one at work is the strip's own "running").
  const runs = runPixels(r.recentRuns.length > 0 ? r.recentRuns : r.lastRun ? [r.lastRun] : []);
  const last = runs[0];
  if (!last) return { kind: "never" };
  const silent = runs.filter((x) => x.status === "silent").length;
  if (last.status === "silent" && silent > 1) return { kind: "silentOf", count: silent, total: runs.length };
  // A person stopped it: that's no skipped slot (the strip draws both alike).
  if (r.recentRuns[0]?.status === "canceled" && r.recentRuns[0].at === last.at) return { kind: "stopped", at: last.at };
  return { kind: "last", status: last.status, at: last.at };
}

/** The strip's slots. */
export const RUN_SLOTS = 14;

// ── The horizon (the next hours) ────────────────────────────────────────────

/** The horizon: the last 4 hours and the next 20. */
export const HORIZON_BACK = 4 * 3_600_000;
export const HORIZON_AHEAD = 20 * 3_600_000;

/** The routines the horizon draws: active, on the clock, not a one-off that already ran. */
export const horizonLanes = <T extends Routine>(list: readonly T[]) =>
  list.filter((r) => r.active && !isDoneOnce(r) && !isEventDriven(r));

/** The calendar range asked for the coming runs: from this hour on (asked again once an hour, the calendar caches). */
export function horizonRange(now: Date): { from: string; to: string } {
  const start = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
  return { from: new Date(start).toISOString(), to: new Date(start + HORIZON_AHEAD + 3_600_000).toISOString() };
}

/** A routine's coming runs on the horizon, from the calendar; before it answers, its next run alone. */
export function futureRuns(
  r: Pick<Routine, "id" | "nextRunAt">,
  slots: readonly { routineId: string; at: string }[],
  now: Date,
  to: Date,
): string[] {
  const at = slots.filter((s) => s.routineId === r.id && new Date(s.at) > now && new Date(s.at) <= to).map((s) => s.at);
  if (at.length === 0 && r.nextRunAt && new Date(r.nextRunAt) <= to) return [r.nextRunAt];
  return at.sort();
}

/** Where an instant falls across the horizon, 0 to 1. */
export const horizonPos = (d: Date | string, from: Date, to: Date) =>
  (new Date(d).getTime() - from.getTime()) / (to.getTime() - from.getTime());

/** The scale's ticks every three hours on this phone's clock (a midnight says the day), off the edges and "now". */
export function horizonTicks(from: Date, to: Date, now: Date): { at: Date; day: boolean; pos: number }[] {
  const out: { at: Date; day: boolean; pos: number }[] = [];
  const first = new Date(from);
  first.setMinutes(0, 0, 0);
  first.setHours(Math.ceil(first.getHours() / 3) * 3);
  for (let d = new Date(first); d <= to; d = new Date(d.getTime() + 3 * 3_600_000)) {
    const pos = horizonPos(d, from, to);
    if (pos < 0.03 || pos > 0.97 || Math.abs(d.getTime() - now.getTime()) < 1.2 * 3_600_000) continue;
    out.push({ at: d, day: d.getHours() === 0, pos });
  }
  return out;
}

/** How many agents the horizon shows before "Mostrar todos" (the web's five, one fewer on a phone's height). */
export const HORIZON_AGENTS = 4;

type RunMark = ReturnType<typeof runPixels>[number];

/** One agent's lane on the horizon. */
export interface HorizonAgent<T> {
  agentId: string;
  /** Its routines on the clock. */
  routines: T[];
  running: boolean;
  /** Its coming runs in the window, soonest first. */
  future: string[];
  /** Its finished runs in the window (a failure drawn last in its minute, so it shows). */
  past: RunMark[];
  /** Its next run, the routine it is, and how many more of its routines run within half an hour of it. */
  next: { routine: T; at: string; together: number } | null;
}

/** Runs within this of the next one are said with it ("Relatório e mais 1"). */
const TOGETHER_MS = 30 * 60_000;

/**
 * The horizon as the web draws it: one lane per agent, so it doesn't grow with the number of routines. A lane holds
 * the recent runs of all of the agent's routines and its coming ones, the next one named. What is at work comes first,
 * then what runs soonest; an agent with nothing in the window has no lane (`idle` counts them).
 */
export function horizonAgents<T extends Routine>(
  lanes: readonly T[],
  futureOf: (r: T) => string[],
  from: Date,
  now: Date,
): { agents: HorizonAgent<T>[]; idle: number } {
  const time = (iso: string) => new Date(iso).getTime();
  const mine = new Map<string, T[]>();
  for (const r of lanes) mine.set(r.agentId, [...(mine.get(r.agentId) ?? []), r]);
  const all = [...mine].map(([agentId, routines]): HorizonAgent<T> => {
    const nexts = routines
      .flatMap((routine) => {
        const at = futureOf(routine)[0];
        return at ? [{ routine, at }] : [];
      })
      .sort((x, y) => time(x.at) - time(y.at));
    const first = nexts[0];
    return {
      agentId,
      routines,
      running: routines.some(isRunning),
      future: routines.flatMap(futureOf).sort((x, y) => time(x) - time(y)),
      past: routines
        .flatMap((r) =>
          runPixels(r.recentRuns).filter((x) => time(x.at) >= from.getTime() && time(x.at) <= now.getTime()),
        )
        .sort((x, y) => Number(x.status === "failed") - Number(y.status === "failed")),
      next: first
        ? { ...first, together: nexts.filter((x) => time(x.at) - time(first.at) < TOGETHER_MS).length - 1 }
        : null,
    };
  });
  const order = (a: HorizonAgent<T>) => (a.running ? 0 : a.next ? time(a.next.at) : Number.POSITIVE_INFINITY);
  const agents = all
    .filter((a) => a.running || a.future.length > 0 || a.past.length > 0)
    .sort((x, y) => order(x) - order(y));
  return { agents, idle: all.length - agents.length };
}

/** The next run's tag on an agent's lane: in minutes within the hour, else its time; none while the agent works. */
export function laneTag(
  next: string | undefined,
  running: boolean,
  now: Date,
): { kind: "soon"; minutes: number } | { kind: "at"; at: string } | null {
  if (!next || running) return null;
  const ms = new Date(next).getTime() - now.getTime();
  return ms < 3_600_000 ? { kind: "soon", minutes: Math.max(1, Math.floor(ms / 60_000)) } : { kind: "at", at: next };
}

// ── Where it delivers (the form) ────────────────────────────────────────────

export const TARGET_DM = "dm";
export const TARGET_ARTIFACT = "artifact";
/** Editing a routine made in the chat (a thread or DM): keep where it delivers. */
export const TARGET_KEEP = "keep";

/** Where a routine delivers, as the form's choice (a channel's id, or one of the words above). */
export function targetChoice(target: RoutineTarget | undefined): string {
  if (!target) return "";
  if (target.type === "channel") return target.channelId;
  if (target.type === "dm") return TARGET_DM;
  if (target.type === "artifact") return TARGET_ARTIFACT;
  return TARGET_KEEP;
}

// ── "Quando chegar um email" ────────────────────────────────────────────────

export const INBOX = "INBOX";

/** The inbox among a mailbox's folders (by role, then by name), or the IMAP name. */
export const inboxOf = (folders: readonly MailFolder[] | undefined) =>
  folders?.find((f) => f.role === "inbox")?.id ?? folders?.find((f) => f.id.toUpperCase() === INBOX)?.id ?? INBOX;

export const isInbox = (folder: string) => folder.toUpperCase() === INBOX;

/** Only the filters that say something (empty ones are left out of the trigger). */
export function cleanFilter(filter: RoutineEmailFilter): RoutineEmailFilter {
  return {
    ...(filter.from && filter.from.length > 0 ? { from: filter.from } : {}),
    ...(filter.subject?.trim() ? { subject: filter.subject.trim() } : {}),
    ...(filter.text?.trim() ? { text: filter.text.trim() } : {}),
  };
}

export interface EmailDraft {
  accountId: string;
  folder: string;
  filter: RoutineEmailFilter;
}

/** The email trigger a routine has (new, or another kind: none picked yet, the inbox). */
export const emailDraftOf = (r: Routine | undefined): EmailDraft =>
  r?.trigger.type === "email"
    ? { accountId: r.trigger.accountId, folder: r.trigger.folder, filter: r.trigger.filter ?? {} }
    : { accountId: "", folder: "", filter: {} };

// ── The form ────────────────────────────────────────────────────────────────

export type TriggerKind = "schedule" | "event" | "email" | "webhook" | "connector";

/** "Email no MillionSend" (ADR 0130): the connection and the inbox's address, sender and subject filters. */
export interface ConnectorDraft {
  connectionId: string;
  filter: RoutineConnectorTrigger["filter"];
}

/** Only the filters that say something. */
export const cleanConnectorFilter = (f: RoutineConnectorTrigger["filter"]): RoutineConnectorTrigger["filter"] => ({
  ...(f.to?.trim() ? { to: f.to.trim().toLowerCase() } : {}),
  ...(f.from?.length ? { from: f.from } : {}),
  ...(f.subject?.trim() ? { subject: f.subject.trim() } : {}),
});

const connectorTrigger = (c: ConnectorDraft) => ({
  type: "connector" as const,
  connectionId: c.connectionId,
  event: "millionsend.email.received" as const,
  inboxId: null,
  filter: cleanConnectorFilter(c.filter),
});

/** The phrase the routine was written with, as the person wrote it (made with the web's picker, or new: none). */
export const phraseOf = (r: Routine | undefined) => (r?.trigger.type === "schedule" ? (r.trigger.phrase ?? "") : "");

/** The zone a routine runs in ("" for one started by an event, an email or a webhook call). */
export const zoneOf = (r: Routine | undefined) =>
  r && (r.trigger.type === "schedule" || r.trigger.type === "once") ? r.trigger.timezone || "UTC" : "";

export const isUtc = (z: string) => z === "UTC" || z === "Etc/UTC";

/** A routine read in UTC (made before time zones): the form starts in my zone, with a hint to keep UTC. */
export const wasUtc = (r: Routine | undefined) => Boolean(r && !isEventDriven(r) && isUtc(zoneOf(r)));

/** The rule a routine runs on, in `zone` (new, or an old cron-only routine: today's weekday at 09:00). */
export function ruleOf(r: Routine | undefined, zone: string, today = new Date()): RecurrenceRule {
  const base = defaultRule(zone, today);
  if (r?.trigger.type === "once") return onceRule(r.trigger.at, zone);
  if (r?.trigger.type === "schedule" && r.trigger.rule)
    return { ...fromApiRule(r.trigger.rule, base.start), timezone: zone };
  if (!r || r.trigger.type === "schedule") return base;
  return { freq: "weekly", interval: 1, byWeekday: ["MO"], times: ["09:00"], timezone: zone, start: base.start };
}

/** What the form holds. */
export interface RoutineDraft {
  agentId: string;
  /** `targetChoice`: a channel's id, `dm`, `artifact` or `keep`. */
  target: string;
  prompt: string;
  name: string;
  kind: TriggerKind;
  event: RoutineEvent;
  email: EmailDraft;
  connector: ConnectorDraft;
  rule: RecurrenceRule;
  active: boolean;
  report: RoutineReport;
}

/** The form for a new routine, or starting from one (`zone`: the zone the form shows). */
export function draftOf(r: Routine | undefined, zone: string, today = new Date()): RoutineDraft {
  return {
    agentId: r?.agentId ?? "",
    target: targetChoice(r?.target),
    prompt: r?.prompt ?? "",
    name: r?.name ?? "",
    kind: r && isEventDriven(r) ? (r.trigger.type as TriggerKind) : "schedule",
    event: r?.trigger.type === "event" ? r.trigger.event : "sentry.issue_created",
    email: emailDraftOf(r),
    connector:
      r?.trigger.type === "connector"
        ? { connectionId: r.trigger.connectionId, filter: r.trigger.filter }
        : { connectionId: "", filter: {} },
    rule: ruleOf(r, zone, today),
    active: r?.active ?? true,
    report: r?.report ?? "when_new",
  };
}

export function draftTarget(d: RoutineDraft): RoutineTargetInput {
  if (d.target === TARGET_DM) return { type: "dm" };
  if (d.target === TARGET_ARTIFACT) return { type: "artifact" };
  return { type: "channel", channelId: d.target };
}

const emailTrigger = (e: EmailDraft) => ({
  type: "email" as const,
  accountId: e.accountId,
  folder: e.folder || INBOX,
  filter: cleanFilter(e.filter),
});

/** What starts it, as the API takes it: a webhook call, an email, an event, a one-off (its instant) or the rule. */
export function draftTrigger(
  d: Pick<RoutineDraft, "kind" | "event" | "email" | "connector" | "rule">,
): RoutineInput["trigger"] {
  if (d.kind === "connector") return connectorTrigger(d.connector);
  if (d.kind === "webhook") return { type: "webhook" };
  if (d.kind === "email") return emailTrigger(d.email);
  if (d.kind === "event") return { type: "event", event: d.event };
  if (d.rule.freq === "once") return { type: "once", at: onceAt(d.rule), timezone: d.rule.timezone };
  return { type: "schedule", rule: toApiRule(d.rule) };
}

/** A new routine from the form (an empty name lets the server name it). */
export function draftInput(d: RoutineDraft): RoutineInput {
  return {
    ...(d.name.trim() ? { name: d.name.trim() } : {}),
    agentId: d.agentId,
    prompt: d.prompt.trim(),
    target: draftTarget(d),
    trigger: draftTrigger(d),
    report: d.report,
  };
}

/** An instant to the minute (a one-off's "when", as the form shows and compares it). */
const minuteOf = (iso: string) => Math.floor(Date.parse(iso) / 60_000);

/**
 * What changed against the routine (`PATCH` sends only this). `savedRule` is the routine's rule as the API
 * takes it, read when the form opened (`JSON.stringify(toApiRule(ruleOf(r, savedZone)))`): "when" counts as
 * changed only when it differs from it, a one-off's when its minute differs, and a cron's only when a phrase
 * was read into a rule (`ruleTyped`).
 */
export function draftChanges(r: Routine, d: RoutineDraft, savedRule: string, ruleTyped = false): RoutinePatch {
  const patch: RoutinePatch = {};
  if (d.name.trim() && d.name.trim() !== r.name) patch.name = d.name.trim();
  if (r.prompt !== null && d.prompt.trim() !== r.prompt) patch.prompt = d.prompt.trim();
  if (d.agentId !== r.agentId) patch.agentId = d.agentId;
  if (d.target !== TARGET_KEEP && d.target !== targetChoice(r.target)) patch.target = draftTarget(d);
  const once = d.rule.freq === "once";
  const triggerChanged =
    d.kind === "connector"
      ? r.trigger.type !== "connector" ||
        JSON.stringify(connectorTrigger(d.connector)) !==
          JSON.stringify(connectorTrigger({ connectionId: r.trigger.connectionId, filter: r.trigger.filter }))
      : d.kind === "webhook"
        ? r.trigger.type !== "webhook"
        : d.kind === "email"
          ? r.trigger.type !== "email" ||
            JSON.stringify(emailTrigger(d.email)) !==
              JSON.stringify({
                type: "email",
                accountId: r.trigger.accountId,
                folder: r.trigger.folder,
                filter: cleanFilter(r.trigger.filter ?? {}),
              })
          : d.kind === "event"
            ? r.trigger.type !== "event" || r.trigger.event !== d.event
            : once
              ? // To the minute, as the form shows it: the server's instant has seconds ("em 10 minutos"), and a
                // one-off that already ran would be sent again as a time in the past.
                r.trigger.type !== "once" || minuteOf(onceAt(d.rule)) !== minuteOf(r.trigger.at)
              : r.trigger.type !== "schedule" ||
                // A routine kept as a cron (every N minutes) changes only with a phrase read into a rule (`ruleTyped`):
                // its form holds a placeholder rule, which must never replace it.
                (r.trigger.rule ? JSON.stringify(toApiRule(d.rule)) !== savedRule : ruleTyped);
  if (triggerChanged) patch.trigger = draftTrigger(d);
  if (d.active !== r.active) patch.active = d.active;
  if (d.report !== r.report) patch.report = d.report;
  return patch;
}

/** A long toast in two parts: its first sentence as the title, the rest under it (the title takes one line). */
export function toastParts(text: string): { title: string; subtitle?: string } {
  const at = text.indexOf(". ");
  if (at < 0 || at + 2 >= text.length) return { title: text };
  return { title: text.slice(0, at + 1), subtitle: text.slice(at + 2) };
}
