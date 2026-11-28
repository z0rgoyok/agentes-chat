import type { TFunction } from "i18next";
import type { Agent, Approval, ApprovalsLevel, AuditRow } from "../api/types";
import { managesAgent } from "./audience";

/** The levels as the choice lists them, the one that asks most first. */
export const APPROVALS_LEVELS: readonly ApprovalsLevel[] = ["always", "risky", "never"];

/** An agent's level (ADR 0173): one from an older server, which doesn't say, asks for what is risky. */
export const approvalsLevelOf = (agent: Pick<Agent, "approvalsLevel"> | null | undefined): ApprovalsLevel =>
  agent?.approvalsLevel ?? "risky";

/** The level while a change is on its way: what was asked for, else what is saved. */
export const shownApprovalsLevel = (
  agent: Pick<Agent, "approvalsLevel"> | null | undefined,
  update: { isPending: boolean; variables?: { approvalsLevel?: ApprovalsLevel | null } | undefined },
): ApprovalsLevel => (update.isPending ? update.variables?.approvalsLevel : undefined) ?? approvalsLevelOf(agent);

/** A call in the audit that ran without its approval card because its agent never asks. */
export const auditUnasked = (row: Pick<AuditRow, "details">) => row.details.approvalsLevel === "never";

/** It follows the workspace's level ("Segue o workspace"); an older server doesn't say, so it doesn't show. */
export const followsWorkspace = (agent: Pick<Agent, "approvalsLevelOwn"> | null | undefined) =>
  agent?.approvalsLevelOwn === false;

/**
 * An agent's Aprovações line: its level, and that it is the workspace's while it has no choice of its own ("Só o
 * arriscado · do workspace"), so the line never hides which level holds.
 */
export const approvalsLevelLine = (
  t: TFunction,
  agent: Pick<Agent, "approvalsLevel" | "approvalsLevelOwn"> | null | undefined,
  update: Parameters<typeof shownApprovalsLevel>[1],
) => {
  const level = t(`approvalsLevel.${shownApprovalsLevel(agent, update)}.title`);
  return followsWorkspace(agent) && !update.isPending ? t("approvalsLevel.follows", { level }) : level;
};

/** How many agents keep their own level when the workspace's changes. */
export const ownApprovalsCount = (agents: readonly Pick<Agent, "approvalsLevelOwn">[]) =>
  agents.filter((a) => a.approvalsLevelOwn === true).length;

/**
 * "Mudar quando perguntar" on a waiting approval: for who decides it and may also set its agent's level (who manages
 * the agent, `managesAgent`, ADR 0085 addendum of 2026-11-17), so the choice it opens can be saved.
 */
export const changesWhenAsks = (
  agent: { canManage?: boolean } | null | undefined,
  approval: Pick<Approval, "status" | "canDecide">,
) => approval.status === "pending" && approval.canDecide && managesAgent(agent);

/** What "Desfazer" puts back after a level was chosen: the workspace's level and each agent's own choice. */
export interface LevelsBefore {
  workspace: ApprovalsLevel;
  /** Each agent's own level, null for one that followed the workspace. */
  agents: { id: string; level: ApprovalsLevel | null }[];
}

/**
 * The levels a change can touch, before it: one agent's alone (`only`), or, for every agent, the workspace's and
 * every agent's own choice that the change clears. Only the agents the person manages (`managesAgent`, ADR 0085
 * addendum of 2026-11-17): "Undo" sets each one's level back, which the server refuses on any other, and a refusal
 * would stop the agents after it from getting theirs back.
 */
export const levelsBefore = (
  workspace: ApprovalsLevel,
  agents: readonly Pick<Agent, "id" | "approvalsLevel" | "approvalsLevelOwn" | "canManage">[],
  only?: string,
): LevelsBefore => ({
  workspace,
  agents: agents
    .filter((a) => (only ? a.id === only : a.approvalsLevelOwn === true && managesAgent(a)))
    .map((a) => ({ id: a.id, level: a.approvalsLevelOwn === false ? null : approvalsLevelOf(a) })),
});
