import type { Actor, IssueColumn, IssueProjectRef } from "@agenteschat/client";
import type { AudienceChoice } from "@agenteschat/client/lib/who-sees";

/**
 * A task's field picked on its own pushed screen (ADR 0135: screens, never a list opened in place in the form): what is
 * picked, the value now and how a choice goes back to whoever pushed the screen (Nova tarefa, a task's head, Tarefas'
 * project filter). The caller starts it before pushing `/issues/pick` (a route can't carry a callback), as the agent
 * picker does (`dashboards/agent-pick.ts`); the screen ends it when it closes.
 */
export type TaskPick =
  /**
   * Who does it, several at once (ADR 0188): each tap adds one or takes one off and is written back at once, with the
   * list before it (`was`); the picker stays open until the bar's back. A save returns its promise: when it rejects,
   * the tap is taken back on screen.
   */
  | { what: "who"; value: readonly Actor[]; apply: (who: Actor[], was: Actor[]) => unknown }
  /** A task's project (its own stays listed when archived), or none. */
  | { what: "project"; value: IssueProjectRef | null; apply: (projectId: string | null) => void }
  /** Tarefas' filter: every task (""), a project's id, or the tasks with none (`NO_PROJECT`). */
  | { what: "projectFilter"; value: string; apply: (key: string) => void }
  /** A board column, grouped by stage. */
  | { what: "column"; value: string | null; apply: (column: IssueColumn) => void }
  /** Who sees a task being written: written back as each option is tapped. */
  | { what: "sees"; value: AudienceChoice; apply: (choice: AudienceChoice) => void };

let current: TaskPick | null = null;

/** Starts a pick; the caller pushes `/issues/pick` next, which takes it as it opens. */
export function openTaskPick(pick: TaskPick) {
  current = pick;
}

/**
 * Ends `pick` (the one a screen showed): a pick started meanwhile for the next screen (a field tapped again while the
 * last picker was still sliding away) stays.
 */
export function closeTaskPick(pick: TaskPick | null) {
  if (pick && current === pick) current = null;
}

export const taskPickNow = (): TaskPick | null => current;

/** Two assignees are the same one (nobody included). */
export const sameActor = (a: Actor | null, b: Actor | null) =>
  (a?.type ?? null) === (b?.type ?? null) && a?.id === b?.id;

/** `list` with `who` taken off when it has them, else added last: one tap on the who picker. */
export const toggleActor = (list: readonly Actor[], who: Actor): Actor[] =>
  list.some((a) => sameActor(a, who)) ? list.filter((a) => !sameActor(a, who)) : [...list, who];

/**
 * The agent a change of a task's assignees puts on it as its first agent (`next` adds an agent while `was` has none):
 * that agent is asked and starts, as a single pick always did; with an agent on it already, another one only gets the
 * task (ADR 0188).
 */
export const firstAgentAdded = (was: readonly Actor[], next: readonly Actor[]): Actor | null =>
  was.some((a) => a.type === "agent")
    ? null
    : (next.find((a) => a.type === "agent" && !was.some((w) => sameActor(w, a))) ?? null);

/** A list of people that names someone, or everyone: a task can be created with it. */
export const audienceReady = (a: AudienceChoice) => a.mode === "everyone" || a.userIds.length > 0;
