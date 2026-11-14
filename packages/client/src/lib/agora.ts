import type { TFunction } from "i18next";
import type { AgentStatus, AgentWorkState, ManagedTask, PendingReturn, TaskManagerView } from "../api/types";
import { returnWhen, WAIT_WORDS, workTime } from "./agent-work";
import { agentGrammar } from "./grammar";
import { returnPlace, taskSince, taskTitle, taskWhere } from "./task-manager";

/**
 * Agora (ADR 0128 addendum of 2026-11-14): the whole workspace's work in one place, from the task manager's list. Its
 * rows go in three sections: what waits on you, who works, and what waits on someone or something else, is in line or
 * comes back later. A row says it in an agent's line's words (ADR 0084 addendum), one line each.
 */

export type AgoraSection = "you" | "working" | "waiting";

/** How a row stands: its work for you, or the plan or budget it waits on (an agent's line leaves those to out of office). */
export type AgoraState = AgentWorkState | "plan" | "budget";

/** A task's: a return is never one. */
export type AgoraTaskState = Exclude<AgoraState, "later">;

export type AgoraItem =
  | { kind: "task"; key: string; agentId: string; state: AgoraTaskState; since: string; task: ManagedTask }
  | { kind: "return"; key: string; agentId: string; state: "later"; since: string; ret: PendingReturn };

/** A task's state for its row; an older server says no `work`: what its status says, never "you". */
export function taskWorkState(task: Pick<ManagedTask, "status" | "held" | "wait" | "work">): AgoraTaskState {
  if (task.work && task.work.state !== "later") return task.work.state;
  if (task.held === "plan" || task.held === "budget") return task.held;
  if (task.status === "running") return "working";
  if (task.status === "waiting_approval") return "approval";
  if (task.status === "queued" || task.held === "computer_busy" || task.wait?.code === "work_queue") return "queued";
  return task.held === "computer_offline" ? "computer" : "answer";
}

export const agoraSection = (state: AgoraState): AgoraSection =>
  state === "you" ? "you" : state === "working" ? "working" : "waiting";

/** A wait on a person (yours or someone else's): the face looks up. */
export const waitsOnSomeone = (state: AgoraState) => state === "you" || state === "approval" || state === "answer";

/** The rows by section, the longest first; the returns after the waits, the soonest first. */
export function agoraSections(
  view: Pick<TaskManagerView, "tasks" | "followUps"> | undefined,
): Record<AgoraSection, AgoraItem[]> {
  const out: Record<AgoraSection, AgoraItem[]> = { you: [], working: [], waiting: [] };
  const tasks = (view?.tasks ?? []).map((task): AgoraItem => {
    const since = task.work?.since ?? task.wait?.since ?? new Date(taskSince(task)).toISOString();
    return { kind: "task", key: task.runId, agentId: task.agentId, state: taskWorkState(task), since, task };
  });
  for (const item of tasks.sort((a, b) => a.since.localeCompare(b.since))) out[agoraSection(item.state)].push(item);
  const returns = [...(view?.followUps ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  for (const ret of returns)
    out.waiting.push({ kind: "return", key: ret.messageId, agentId: ret.agentId, state: "later", since: ret.at, ret });
  return out;
}

const PHRASE = {
  ...WAIT_WORDS,
  you: "agentWork.you",
  queued: "agentWork.queued",
  plan: "agentWork.plan",
  budget: "agentWork.budget",
} as const satisfies Record<Exclude<AgoraTaskState, "working">, string>;

/** The agent a task helps (work it handed off), when the reader reads where: "ajudando a Ada". */
export const helpsWhom = (item: AgoraItem) =>
  item.kind === "task" && item.task.delegation?.from ? item.task.delegation.agentId : null;

/**
 * What a row says after its agent's name, an agent's line's phrase without its time: "ajudando a Ada" (`forName`: the
 * agent it helps), "trabalhando", "numa rotina", "esperando você", "esperando aprovação", "na fila", "retorno às 00:32".
 */
export function agoraPhrase(
  t: TFunction,
  locale: string,
  item: AgoraItem,
  forName: string | undefined,
  now = Date.now(),
): string {
  if (item.kind === "return")
    return item.ret.held
      ? t("chat.consultPair.waitingInput")
      : t("agentWork.later", { when: returnWhen(t, locale, item.ret.at, now) });
  if (item.state === "working") {
    if (forName) {
      const g = agentGrammar(forName);
      return t("chat.consultPanel.helping", { name: g.name, context: g.context });
    }
    return t(item.task.background ? "agentWork.routine" : "agentWork.working");
  }
  return t(PHRASE[item.state]);
}

/** Where a row is and what it is about: "#vendas › Corrigir o link", "Rotina «Backups»", "#vendas › rever o deploy". */
export function agoraContext(t: TFunction, item: AgoraItem): string {
  if (item.kind === "return") {
    const place = returnPlace(t, item.ret);
    return place ? `${place} › ${item.ret.about}` : item.ret.about;
  }
  const where = taskWhere(t, item.task);
  const title = taskTitle(t, item.task);
  return title === where || title === item.task.routine?.name ? where : `${where} › ${title}`;
}

/**
 * A name of this many letters or fewer stays whole on a short line, and the words after it give way first (Agora's
 * rows on the web, the work-along line on the phone). Past it a name is wider than 2.5em in any face.
 */
export const SHORT_NAME = 5;

/** How long a row's state has held, as lists say it; none in its first minute, none for a return (it says when). */
export const agoraTime = (locale: string, item: AgoraItem, now = Date.now()) =>
  item.kind === "return" ? null : workTime(locale, item.since, now);

/** The button's glyph: the task manager's icon at rest, the orbit while work runs, the wait mark when something waits. */
export interface AgoraGlyph {
  mark: "idle" | "working" | "you";
  /** The longest-running agent at work: the orbit's tones. */
  agentId: string | null;
  /** Agents at work, for its tip. */
  working: number;
  /** Things waiting on you, for its tip. */
  waiting: number;
}

/**
 * The button's state from the agents' work for you (`AgentStatus.work`, workspace-wide), the runs this app hears at
 * work (`live`) and what waits on you (the inbox's count): amber wins over the orbit.
 */
export function agoraGlyph(
  statuses: readonly Pick<AgentStatus, "agentId" | "work">[] | undefined,
  waitingOnYou: number,
  live: ReadonlySet<string> = new Set(),
): AgoraGlyph {
  const atWork = (statuses ?? [])
    .filter((s) => s.work?.state === "working")
    .sort((a, b) => (a.work?.since ?? "").localeCompare(b.work?.since ?? ""));
  const working = new Set([...atWork.map((s) => s.agentId), ...live]);
  const yours = (statuses ?? []).filter((s) => s.work?.state === "you").length;
  const waiting = Math.max(waitingOnYou, yours);
  return {
    mark: waiting > 0 ? "you" : working.size > 0 ? "working" : "idle",
    agentId: atWork[0]?.agentId ?? [...live][0] ?? null,
    working: working.size,
    waiting,
  };
}
