import { and, type Executor, eq, isNull, rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { enqueue } from "./outbox";
import type { Approval } from "./tools/gateway";

const { approvals } = schema;

/**
 * Approvals keep the order they were asked in where that order is real (ADR 0182 and its addendum of 2026-11-24). A run
 * does its own calls in the order asked (the executor's resume). Between runs, an approved action waits only for the
 * requests its run was told were already waiting in its conversation when it started (`after_ids`, from `heldHere`):
 * as when a message sent while the agent waited started a run of its own. A person may decide them in any order; an
 * approved action runs once those settle (refused, expired, canceled or done), and one approved before such a request
 * was refused or expired doesn't run at all: what it came after never happened. A request still waiting for a person
 * after `STALE_HOLD_MS` holds nobody, and "Rodar este agora" (`runApprovalNow`) empties a run's `after_ids`.
 * Actions approved ahead (`run_at`, done at their routine's time) and a mission's requests (no run) stand outside.
 */

/** How long a request waiting for a person may hold another run's approved action. */
export const STALE_HOLD_MS = 30 * 60_000;

/** A run's approved actions still to do (not claimed, no result) that may wait for another run: not ahead (alias `a`). */
const toDo = (run: SQL) =>
  sql`a.run_id = ${run} and a.status = 'approved' and a.executed_at is null and a.result is null
    and a.run_at is null`;

/**
 * What stands before a run (`run`: its id, as SQL): the requests its actions still to do were asked after
 * (`after_ids`), not settled. Waiting for a person since less than `STALE_HOLD_MS` is unsettled; so is approved
 * without a result while its run goes on (`executed_at` is set when the run claims the action, before the tool
 * returns). `after_ids` only names requests asked before its run started, so two runs never wait on each other.
 */
const blockersOf = (run: SQL, now: Date) => sql`from approvals b
  where b.id in (select unnest(a.after_ids) from approvals a where ${toDo(run)})
    and b.run_id is not null and b.run_id <> ${run} and b.run_at is null
    and ((b.status = 'pending' and b.created_at > ${new Date(now.getTime() - STALE_HOLD_MS).toISOString()}::timestamptz)
      or (b.status = 'approved' and b.result is null
        and exists (select 1 from agent_runs br where br.id = b.run_id
          and br.status in ('queued', 'running', 'waiting_approval', 'waiting_input'))))`;

/** The request a run's approved actions still wait for, if any (`blockersOf`): the earliest asked. */
export async function heldBehind(
  db: Executor,
  runId: string,
  now = new Date(),
): Promise<{ id: string; title: string } | null> {
  const [row] = rowsOf<{ id: string; title: string }>(
    await db.execute(
      sql`select b.id, b.title ${blockersOf(sql`${runId}::uuid`, now)} order by b.created_at, b.id limit 1`,
    ),
  );
  return row ?? null;
}

/**
 * Why an approved action must not run: a request asked before it by its own run, or one it waits for (`after_ids`), was
 * refused, or expired unanswered, after this one was approved. The person approved it counting on that earlier one; one approved
 * after the refusal was approved knowing it, and runs.
 */
export async function notRunAfter(
  db: Executor,
  approval: Pick<Approval, "id" | "status" | "runId" | "runAt" | "decidedAt">,
): Promise<NotRunBefore | null> {
  if (approval.status !== "approved" || !approval.runId || approval.runAt) return null;
  if (!approval.decidedAt) return null;
  const [row] = rowsOf<NotRunBefore>(
    await db.execute(sql`select b.id, b.title, b.status, b.params from approvals a
      join approvals b on b.org_id = a.org_id and b.id <> a.id
        and b.run_id is not null and b.run_at is null
        and (b.created_at, b.id) < (a.created_at, a.id)
        and (b.run_id = a.run_id or b.id = any(a.after_ids))
      where a.id = ${approval.id}::uuid and b.status in ('refused', 'expired')
        and coalesce(b.decided_at, b.expires_at) > a.decided_at
      order by b.created_at, b.id
      limit 1`),
  );
  return row ?? null;
}

/** The earlier request that keeps an approved action from running (`notRunAfter`). */
export interface NotRunBefore {
  id: string;
  title: string;
  status: "refused" | "expired";
  params?: Record<string, unknown> | null;
}

/** A request as the agent asked it: its tool and its first short values, so two of one tool tell apart. */
function askedAs(before: Pick<NotRunBefore, "title" | "params">) {
  const values = Object.entries(before.params ?? {})
    .filter((e): e is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof e[1]))
    .slice(0, 3)
    .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
    .join(", ");
  return values ? `"${before.title}" (${values})` : `"${before.title}"`;
}

/** What the agent reads (and the request's result says) for an action kept from running by `notRunAfter`. */
export function notRunText(before: Pick<NotRunBefore, "title" | "status" | "params">) {
  const what = before.status === "refused" ? "was refused" : "expired unanswered";
  return `Not done: ${askedAs(before)}, asked before this, ${what} after this one was approved, so this didn't run. If it still makes sense on its own, ask for it again.`;
}

/**
 * Keeps an approved action from running (`notRunAfter`): its result says why and names the earlier request
 * (`notRunAfter` in the stored result, read by the apps). Null when it already ran or was kept already.
 */
export async function markNotRun(db: Executor, approvalId: string, before: NotRunBefore): Promise<Approval | null> {
  const [row] = await db
    .update(approvals)
    .set({ result: { content: notRunText(before), isError: true, notRunAfter: before.id } })
    .where(and(eq(approvals.id, approvalId), isNull(approvals.executedAt), isNull(approvals.result)))
    .returning();
  return row ?? null;
}

/** Wakes each waiting run once for each request settled before it (dedupe key `after:<request>`). */
async function wake(tx: Executor, later: { org_id: string; run_id: string; after: string }[]) {
  for (const row of later) {
    await enqueue(tx, {
      orgId: row.org_id,
      kind: "agent_run.execute",
      payload: { runId: row.run_id },
      dedupeKey: `agent_run.execute:${row.run_id}:after:${row.after}`,
      maxAttempts: 4,
    });
  }
}

/** The agent's runs with an approved action still to do that waits for one of the requests `from` picks (alias `a`). */
const waitingOn = (from: SQL) => sql`select distinct b.org_id, b.run_id, a.id as after
  from approvals a
  join approvals b on b.org_id = a.org_id and b.status = 'approved' and b.result is null
    and a.id = any(b.after_ids) and b.run_id is not null and b.run_id <> a.run_id and b.run_at is null
  join agent_runs r on r.id = b.run_id and r.status in ('waiting_approval', 'waiting_input')
  where ${from}`;

/**
 * These requests just settled: wakes the agent's other runs waiting for them (`heldBehind`), once per run and request
 * settled (a later settling of another request wakes it again). A run still behind another request goes back to
 * waiting; the last to settle wakes it.
 */
export async function wakeLine(tx: Executor, rows: Pick<Approval, "id" | "runId" | "runAt">[]): Promise<void> {
  const ids = rows.filter((r) => r.runId && !r.runAt).map((r) => r.id);
  if (ids.length === 0) return;
  const later = rowsOf<{ org_id: string; run_id: string; after: string }>(
    await tx.execute(
      waitingOn(
        sql`a.id in (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
      ),
    ),
  );
  await wake(tx, later);
}

/**
 * A run failed or was stopped (`transitionRun`): its requests no longer hold anyone, so the runs waiting for any of
 * them are woken, one job per run and request (`wakeLine`), in one query.
 */
export async function wakeLineOfRun(tx: Executor, runId: string): Promise<void> {
  const later = rowsOf<{ org_id: string; run_id: string; after: string }>(
    await tx.execute(waitingOn(sql`a.run_id = ${runId}::uuid and a.run_at is null`)),
  );
  await wake(tx, later);
}

/**
 * The safety net (with the expiry worker, every minute): a run still waiting although nothing holds it any more, as
 * when the request before it settled by a path that didn't wake the line, or went stale (`STALE_HOLD_MS`). Only runs
 * this order can hold (an approved action still to do that waits for another run's request, decided within a week),
 * with nothing of
 * their own left to wait for (an approval, a question, a secret, a mission's or an agent's answer), nothing before
 * them (`blockersOf`) and no job of theirs already on its way; the longest waiting first.
 */
export async function resumeHeldRuns(db: Executor, now = new Date()): Promise<number> {
  const runs = rowsOf<{ id: string; org_id: string }>(
    await db.execute(sql`select r.id, r.org_id from agent_runs r
      where r.status in ('waiting_approval', 'waiting_input')
        and r.updated_at < ${new Date(now.getTime() - 60_000).toISOString()}::timestamptz
        and exists (select 1 from approvals a
          where ${toDo(sql`r.id`)} and cardinality(a.after_ids) > 0
            and a.decided_at > ${new Date(now.getTime() - 7 * 86_400_000).toISOString()}::timestamptz)
        and not exists (select 1 from approvals a where a.run_id = r.id and a.status = 'pending')
        and not exists (select 1 from agent_questions q where q.run_id = r.id and q.status = 'open')
        and not exists (select 1 from secret_requests s where s.run_id = r.id and s.status = 'pending')
        and not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(r.transcript #> '{pending,calls}') = 'array'
            then r.transcript #> '{pending,calls}' else '[]'::jsonb end) c
          where c ? 'waitId' and not c ? 'result')
        and not exists (select 1 from outbox o where o.kind = 'agent_run.execute'
          and o.status in ('pending', 'processing') and o.payload->>'runId' = r.id::text)
        and not exists (select 1 ${blockersOf(sql`r.id`, now)})
      order by r.updated_at
      limit 50`),
  );
  const minute = Math.floor(now.getTime() / 60_000);
  for (const run of runs) {
    await enqueue(db, {
      orgId: run.org_id,
      kind: "agent_run.execute",
      payload: { runId: run.id },
      dedupeKey: `agent_run.execute:${run.id}:after:sweep:${minute}`,
      maxAttempts: 4,
    });
  }
  return runs.length;
}
