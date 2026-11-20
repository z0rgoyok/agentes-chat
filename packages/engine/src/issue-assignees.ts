import { and, asc, type Executor, eq, inArray, type SQL, schema, sql } from "@agenteschat/db";
import { ValidationError } from "./errors";

const { issueAssignees } = schema;

/** One of the people and agents who have a task (ADR 0188). */
export interface Assignee {
  type: "person" | "agent";
  id: string;
}

export const ASSIGNEES_MAX = 20;

const keyOf = (a: Assignee) => `${a.type}:${a.id}`;

/** The list as stored: each once, in the order given. */
export function cleanAssignees(list: readonly Assignee[]): Assignee[] {
  const seen = new Set<string>();
  const out: Assignee[] = [];
  for (const a of list) {
    if (seen.has(keyOf(a))) continue;
    seen.add(keyOf(a));
    out.push({ type: a.type, id: a.id });
  }
  if (out.length > ASSIGNEES_MAX) throw new ValidationError(`A task has at most ${ASSIGNEES_MAX} assignees`);
  return out;
}

export const sameAssignees = (a: readonly Assignee[], b: readonly Assignee[]) =>
  a.length === b.length && a.every((x, k) => keyOf(x) === keyOf(b[k] as Assignee));

/** Those of `list` that `other` doesn't have. */
export const assigneesNotIn = (list: readonly Assignee[], other: readonly Assignee[]) => {
  const have = new Set(other.map(keyOf));
  return list.filter((a) => !have.has(keyOf(a)));
};

/** Who has each of these tasks, in order; a task with nobody isn't in the map. */
export async function assigneesOf(db: Executor, issueIds: string[]): Promise<Map<string, Assignee[]>> {
  const out = new Map<string, Assignee[]>();
  if (issueIds.length === 0) return out;
  const rows = await db
    .select({ issueId: issueAssignees.issueId, type: issueAssignees.assigneeType, id: issueAssignees.assigneeId })
    .from(issueAssignees)
    .where(inArray(issueAssignees.issueId, issueIds))
    .orderBy(asc(issueAssignees.position), asc(issueAssignees.createdAt));
  for (const r of rows) {
    const list = out.get(r.issueId) ?? [];
    list.push({ type: r.type as Assignee["type"], id: r.id });
    out.set(r.issueId, list);
  }
  return out;
}

export const assigneesOfIssue = async (db: Executor, issueId: string) =>
  (await assigneesOf(db, [issueId])).get(issueId) ?? [];

/** Replaces who has the task with `list`, in its order. */
export async function setAssignees(tx: Executor, issue: { id: string; orgId: string }, list: readonly Assignee[]) {
  await tx.delete(issueAssignees).where(eq(issueAssignees.issueId, issue.id));
  if (list.length === 0) return;
  await tx.insert(issueAssignees).values(
    list.map((a, position) => ({
      orgId: issue.orgId,
      issueId: issue.id,
      assigneeType: a.type,
      assigneeId: a.id,
      position,
    })),
  );
}

export async function isAssigned(db: Executor, issueId: string, a: Assignee) {
  const [row] = await db
    .select({ id: issueAssignees.id })
    .from(issueAssignees)
    .where(
      and(
        eq(issueAssignees.issueId, issueId),
        eq(issueAssignees.assigneeType, a.type),
        eq(issueAssignees.assigneeId, a.id),
      ),
    );
  return Boolean(row);
}

/**
 * Whether someone has the task, as a condition over the `issues` rows named `alias`. `id` is text: a person's id, or an
 * agent's cast to text.
 */
export const assignedSql = (alias: string, type: Assignee["type"], id: SQL) =>
  sql`exists (select 1 from ${issueAssignees} ia where ia.issue_id = ${sql.raw(alias)}.id
    and ia.assignee_type = ${type} and ia.assignee_id = ${id})`;

/**
 * Takes someone off every task of the workspace: a person who left it, an agent archived or deleted (ADR 0188).
 * Returns the tasks they were on.
 */
export async function dropAssignee(tx: Executor, orgId: string, a: Assignee): Promise<string[]> {
  const rows = await tx
    .delete(issueAssignees)
    .where(
      and(
        eq(issueAssignees.orgId, orgId),
        eq(issueAssignees.assigneeType, a.type),
        eq(issueAssignees.assigneeId, a.id),
      ),
    )
    .returning({ issueId: issueAssignees.issueId });
  return rows.map((r) => r.issueId);
}
