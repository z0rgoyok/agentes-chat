import type { TFunction } from "i18next";
import type { AgentStatus, AgentWork, AgentWorkState, PendingReturn, ThreadInfo, ThreadWait } from "../api/types";
import { daysBetween, formatLineTime, formatTime } from "./format";
import { agentGrammar } from "./grammar";

/**
 * An agent's work in the lists, the profile card and a thread's chip (ADR 0084 addendum of 2026-11-13), the same on
 * every app: one state model (blue at work, amber when it waits on you, quiet otherwise), one set of words, one clock.
 */

/** The tone a state draws in. */
export type WorkTone = "working" | "you" | "neutral";

export const workTone = (state: AgentWorkState): WorkTone =>
  state === "you" ? "you" : state === "working" ? "working" : "neutral";

/** Lists and chips show no time in a state's first minute, then tick once a minute. */
export const WORK_TICK_MS = 60_000;

/**
 * An agent's work as this app knows it now: the list's (`AgentStatus.work`, for this person, workspace-wide) or, before
 * the list's next read, a run of its this app hears at work (`live`: where, since when). Waiting on you stays.
 */
export function agentWork(
  status: Pick<AgentStatus, "work"> | null | undefined,
  live?: { channelId: string; threadId?: string | null; since?: number } | null,
  now = Date.now(),
): AgentWork | null {
  const work = status?.work ?? null;
  if (!live || work?.state === "you" || work?.state === "working") return work;
  return {
    state: "working",
    ask: null,
    since: new Date(live.since ?? now).toISOString(),
    runId: work?.runId ?? "",
    channelId: live.channelId,
    channelKind: null,
    channelName: null,
    threadId: live.threadId ?? null,
    messageId: null,
    forAgentId: null,
    routine: false,
    count: Math.max(1, work?.count ?? 1),
  };
}

/**
 * What a hand-off's run (`runId`, the list's) waits on the viewer for, from its agent's work for them: only when that
 * work is this run, since another run of the agent may be the one that waits on them.
 */
export const handoffAsk = (
  work: Pick<AgentWork, "state" | "ask" | "runId"> | null | undefined,
  runId: string | null | undefined,
): "approval" | "answer" | null => (work?.state === "you" && runId != null && work.runId === runId ? work.ask : null);

/** How long a state has held, as lists say it ("22 min", "1,5 h"); none in its first minute. */
export function workTime(locale: string, since: string | null | undefined, now = Date.now()): string | null {
  const ms = since ? now - Date.parse(since) : Number.NaN;
  if (!(ms >= WORK_TICK_MS)) return null;
  return formatLineTime(locale, ms);
}

/** What a list's line needs beyond the work: names, and the conversation the list belongs to. */
export interface WorkPlaceNames {
  /** An agent's name by id (the one it works for). */
  agentName: (id: string) => string | undefined;
  /** A channel's name by id, when the work doesn't carry it (a run this app hears). */
  channelName?: (id: string) => string | undefined;
  /** The conversation the list is about (the members column): its own work there reads "aqui". */
  here?: string | null;
}

/** A list's line: its words, a shorter form for when they don't fit, the time and the tone. */
export interface WorkLine {
  /** "ajudando a Ada", "#vendas", "aqui", "esperando você", "esperando aprovação", "na fila". */
  text: string;
  /** "trabalhando", "esperando", "na fila". */
  short: string;
  /** "22 min"; null in the first minute. */
  time: string | null;
  tone: WorkTone;
}

/** A neutral wait in a list's words: "esperando aprovação", "esperando o computador", "IA fora do ar". */
export const WAIT_WORDS = {
  approval: "chat.consultPair.waitingApproval",
  answer: "chat.consultPair.waitingInput",
  computer: "chat.consultPair.waitingComputer",
  outage: "chat.consultPair.waitingProvider",
} as const satisfies Record<Exclude<AgentWorkState, "you" | "working" | "queued" | "later">, string>;

/** Where its work is, in a list's line: "ajudando a Ada", "#vendas", "aqui", "numa rotina", "trabalhando". */
function workPlace(t: TFunction, work: AgentWork, names: WorkPlaceNames): string {
  if (work.routine) return t("agentWork.routine");
  const forName = work.forAgentId ? names.agentName(work.forAgentId) : undefined;
  if (forName) {
    const g = agentGrammar(forName);
    return t("chat.consultPanel.helping", { name: g.name, context: g.context });
  }
  if (work.channelId && work.channelId === names.here) return t("agentWork.here");
  const channel =
    work.channelKind === "channel" || work.channelKind === null
      ? (work.channelName ?? (work.channelId ? names.channelName?.(work.channelId) : undefined))
      : undefined;
  return channel ? `#${channel}` : t("agentWork.working");
}

/** An agent's line in a list (the sidebar, the members column, the phone's rows), or null with no work. */
export function workLine(
  t: TFunction,
  locale: string,
  work: AgentWork | null | undefined,
  names: WorkPlaceNames,
  now = Date.now(),
): WorkLine | null {
  if (!work) return null;
  const time = workTime(locale, work.since, now);
  const tone = workTone(work.state);
  switch (work.state) {
    case "you":
      return { text: t("agentWork.you"), short: t("agentWork.waiting"), time, tone };
    case "working":
      return { text: workPlace(t, work, names), short: t("agentWork.working"), time, tone };
    case "queued":
      return { text: t("agentWork.queued"), short: t("agentWork.queued"), time, tone };
    // A return says when, never for how long.
    case "later":
      return {
        text: t("agentWork.later", { when: returnWhen(t, locale, work.at ?? work.since, now) }),
        short: t("agentWork.laterShort"),
        time: null,
        tone,
      };
    default:
      return { text: t(WAIT_WORDS[work.state]), short: t("agentWork.waiting"), time, tone };
  }
}

/** The line as one string: "ajudando a Ada · 22 min". */
export const workLineText = (line: WorkLine) => (line.time ? `${line.text} · ${line.time}` : line.text);

/**
 * The second part of an agent's "Presença" on its profile card: whom it helps or where it works ("ajudando a Ada"),
 * what it waits on you for ("sua aprovação"), when it comes back ("retorno às 00:32"), or null.
 */
export function workDetail(
  t: TFunction,
  work: AgentWork | null | undefined,
  names: WorkPlaceNames,
  locale = "en",
  now = Date.now(),
): string | null {
  if (!work) return null;
  if (work.state === "you") return t(work.ask === "approval" ? "agentWork.yourApproval" : "agentWork.yourAnswer");
  if (work.state === "later") return t("agentWork.later", { when: returnWhen(t, locale, work.at ?? work.since, now) });
  if (work.state !== "working") return null;
  const place = workPlace(t, work, names);
  return place === t("agentWork.working") ? null : place;
}

// ── A thread's chip ────────────────────────────────────────────────────────────

/** What a thread's chip says, one state at a time: waiting on you, at work, a neutral wait, in line, a return to come. */
export type ThreadWorkState = "needsYou" | "working" | ThreadWait | "later";

/**
 * The chip's state from the list and this app's live runs (`live`: one of its runs works here now, before the list
 * says so): what waits on you, then work, then what the work waits on, then a return still to come. Null: nothing.
 */
export function threadWorkState(
  t: Pick<ThreadInfo, "needsYou" | "working" | "wait" | "laterAt">,
  live = false,
): ThreadWorkState | null {
  if (t.needsYou) return "needsYou";
  if (live || (t.working && !t.wait)) return "working";
  return t.wait ?? (t.working ? "working" : t.laterAt ? "later" : null);
}

/**
 * The chip's words for a state: "Esperando você", "Trabalhando", "Esperando aprovação", "Na fila", and a return's
 * "Retorno às 00:32" (`later`: its time and the reader's locale).
 */
export const threadWorkWord = (
  t: TFunction,
  state: ThreadWorkState,
  later?: { at: string | null | undefined; locale: string; now?: number },
) =>
  state === "later"
    ? t("threads.status.later", { when: returnWhen(t, later?.locale ?? "en", later?.at ?? "", later?.now) })
    : t(`threads.status.${state}`);

// ── A return (an agent's `follow_up`, ADR 0037) ───────────────────────────────

/** More than this far ahead, a return's words say its day ("amanhã às 09:00"): they never turn at midnight. */
export const RETURN_DAY_AFTER_MS = 12 * 3600_000;

/**
 * When a return comes, as its words say it, in the reader's zone: "às 00:32", and more than 12 h away with its day,
 * "amanhã às 09:00" (or "hoje às 21:00"). `label`: the form that opens a label ("Às 00:32").
 */
export function returnWhen(t: TFunction, locale: string, at: string, now = Date.now(), label = false): string {
  const time = formatTime(locale, at);
  const key = label ? "followUps.whenLabel" : "followUps.when";
  if (!(Date.parse(at) - now > RETURN_DAY_AFTER_MS)) return t(`${key}.at`, { time });
  return t(daysBetween(at, new Date(now)) === 0 ? `${key}.today` : `${key}.tomorrow`, { time });
}

/** A return's time where room is short (a list's end): "00:32", or "amanhã 09:00" more than 12 h away. */
export function returnClock(t: TFunction, locale: string, at: string, now = Date.now()): string {
  const time = formatTime(locale, at);
  if (!(Date.parse(at) - now > RETURN_DAY_AFTER_MS)) return time;
  return t(daysBetween(at, new Date(now)) === 0 ? "format.todayAt" : "format.tomorrowAt", { time });
}

/**
 * The returns a conversation's bar holds, the soonest first: a thread's own, or the main timeline's (`threadId` null)
 * in a channel or a DM.
 */
export const returnsHere = (all: readonly PendingReturn[] | undefined, threadId: string | null) =>
  (all ?? []).filter((r) => r.threadId === threadId);

/** The faces the bar opens with: one per agent, the soonest return's first, three at most. */
export const returnFaces = (returns: readonly PendingReturn[]) =>
  [...new Set(returns.map((r) => r.agentId))].slice(0, 3);

/**
 * The bar's sentence for the soonest return (names marked by `mark`): "Ada retorna às 00:32", or held on an answer,
 * "Ada retorna quando você responder" (`canAnswer`: the reader can post here) or "…depois de uma resposta". `short`:
 * the name and the time alone ("Ada 00:32"), where even the sentence doesn't fit.
 */
export function returnSentence(
  t: TFunction,
  locale: string,
  r: Pick<PendingReturn, "at" | "held">,
  name: string,
  opts: { canAnswer: boolean; short?: boolean; now?: number },
): string {
  if (r.held) return t(opts.canAnswer ? "followUps.bar.heldYou" : "followUps.bar.held", { name });
  if (opts.short) return t("followUps.bar.short", { name, time: returnClock(t, locale, r.at, opts.now) });
  return t("followUps.bar.at", { name, when: returnWhen(t, locale, r.at, opts.now) });
}

/** The chip's tone. */
export const threadWorkTone = (state: ThreadWorkState): WorkTone =>
  state === "needsYou" ? "you" : state === "working" ? "working" : "neutral";
