import { type Executor, rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { decidableBySql } from "./approvals";
import { managesAgentSql, ownsAgentSql } from "./audience";
import { caches } from "./cache";
import { replyThreadOf } from "./runs";
import { MAX_HANDOFF_LINKS } from "./stretch";
import { channelReaderSql } from "./task-access";

const { approvals } = schema;

/**
 * Where an agent's work shows and how it stands, for one person (ADR 0084 addendum of 2026-11-13). A run another agent
 * handed off works in the two agents' DM, which nobody reads: it shows where it was handed off (its anchor), to the
 * people who read that conversation. Everyone else reads the bare state, which the face's badge already says.
 */

/**
 * How a run stands for the viewer: `you` (it waits on their decision or answer), `working`, a neutral wait (on
 * someone's approval, on someone's answer, on its computer, on its AI provider) or `queued` (in line for a worker or
 * for room on its computer). A run waiting on its plan or its budget is none: out of office says it. `later`: no run on,
 * a return it set comes at `at` (`pendingReturns`).
 */
export type AgentWorkState = "you" | "working" | "approval" | "answer" | "computer" | "outage" | "queued" | "later";

export interface AgentWork {
  state: AgentWorkState;
  /** With `you`: what it waits on the viewer for. */
  ask: "approval" | "answer" | null;
  /** Working: since the hand-off, else the run's start. Waiting or in line: since the wait began. ISO. */
  since: string;
  runId: string;
  /** Where it shows, when the viewer reads that conversation; null otherwise (and for a routine's work). */
  channelId: string | null;
  channelKind: "channel" | "dm" | "task" | "file" | "code" | null;
  /** A channel's name; null for a DM or a task's conversation. */
  channelName: string | null;
  /** Null: the conversation's main timeline. */
  threadId: string | null;
  /** The reply of the run that handed it off, once posted: where a click lands. */
  messageId: string | null;
  /** The agent that handed it off, when the viewer reads where. */
  forAgentId: string | null;
  /** A routine's work (or work a routine handed off): it holds no conversation. */
  routine: boolean;
  /** How many runs it has on, whatever the viewer reads of them. */
  count: number;
  /** With `later`: when it comes back to that conversation. */
  at?: string;
  /** Its conversation is one the viewer doesn't read (someone else's DM, a private channel): no place to open. */
  private?: true;
}

const OPEN = sql.raw("('queued', 'running', 'waiting_approval', 'waiting_input')");

/**
 * For each run still on (of `orgId`, or only `runIds`), the run people see it from, as the CTEs `up` and `anchors`
 * (`run_id`, `anchor_id`, `for_agent`, `handed_at`) after a `with`: up the hand-offs it answers (`agent_consultations`,
 * the latest at each step, at most `MAX_HANDOFF_LINKS`) to the first run outside two agents' DM. A run nobody handed
 * anything is its own anchor, and so is a routine's run (its room is its own). `for_agent` and `handed_at` are the
 * first hand-off's: the agent that asked this run, and when.
 */
export const anchorsSql = (orgId: string, runIds?: readonly string[]): SQL => sql`recursive up(run_id, cur, depth,
    for_agent, handed_at) as (
    select r.id, r.id, 0, null::uuid, null::timestamptz from agent_runs r
    where r.org_id = ${orgId}::uuid and r.status in ${OPEN}
      ${runIds ? sql`and r.id = any(${`{${runIds.join(",")}}`}::uuid[])` : sql``}
    union all
    select up.run_id, k.asker_run_id, up.depth + 1, coalesce(up.for_agent, k.asker_agent_id),
      coalesce(up.handed_at, k.created_at)
    from up
    join agent_runs ur on ur.id = up.cur and not ur.background
    join channels uc on uc.id = ur.channel_id and uc.kind = 'dm' and uc.dm_key is not null
      and uc.dm_key not like '%u:%' and uc.dm_key not like 'routine|%'
    cross join lateral (
      select ac.asker_run_id, ac.asker_agent_id, ac.created_at from agent_consultations ac
      where ac.org_id = ${orgId}::uuid and ac.target_run_id = up.cur
      order by ac.created_at desc limit 1
    ) k
    where up.depth < ${MAX_HANDOFF_LINKS}
  ), anchors as (
    select distinct on (run_id) run_id, cur as anchor_id, for_agent, handed_at from up order by run_id, depth desc
  )`;

/** A conversation only agents are in (`isAgentOnlyDm`), over the channel alias `c`. */
export const agentsOnlyIn = (c: string) =>
  sql.raw(`(${c}.kind = 'dm' and ${c}.dm_key is not null and ${c}.dm_key not like '%u:%')`);

/** Parked on its AI provider's outage (`outageParkedSql`), over the run alias `r`. */
export const outageIn = (r: string) =>
  sql.raw(`(${r}.status = 'waiting_input' and coalesce(${r}.state, ${r}.transcript) -> 'outage' is not null
    and ${r}.waiting_machine_id is null and coalesce(${r}.state, ${r}.transcript) -> 'waitingForBrain' is null)`);

/**
 * Since when a run waits, over `r`: in line for room, on its computer, plan or provider, by that wait's own clock; on a
 * person, since the oldest card it waits on; in line before it ever started, since it was made. Its last change only
 * when none says: a message queued on a waiting run moves `updated_at`, and the wait goes on.
 */
export const waitSinceIn = (r: string) =>
  sql.raw(`coalesce(to_timestamp(coalesce((coalesce(${r}.state, ${r}.transcript)->>'roomWaitSince')::bigint,
    (coalesce(${r}.state, ${r}.transcript)->'waitingForBrain'->>'since')::bigint, (coalesce(${r}.state, ${r}.transcript)->'outage'->>'since')::bigint) / 1000.0),
    case ${r}.status
      when 'waiting_approval' then (select min(pa.created_at) from approvals pa
        where pa.org_id = ${r}.org_id and pa.run_id = ${r}.id and pa.status = 'pending')
      when 'waiting_input' then least(
        (select min(pq.created_at) from agent_questions pq
          where pq.org_id = ${r}.org_id and pq.run_id = ${r}.id and pq.status = 'open'),
        (select min(ps.created_at) from secret_requests ps
          where ps.org_id = ${r}.org_id and ps.run_id = ${r}.id and ps.status = 'pending'))
      when 'queued' then case when ${r}.started_at is null then ${r}.created_at end
    end,
    ${r}.updated_at)`);

/**
 * Whether a run waits on `viewerId`, over the run alias `r`: an approval they may decide (`decidableBySql`), or the
 * question or secret asked of them. An agent's line and the task manager's rows read the same rule.
 */
export const waitsOnViewerIn = (r: string, viewerId: string) => {
  const run = sql.raw(r);
  const viewer = sql`${viewerId}::text`;
  return sql`case ${run}.status
    when 'waiting_approval' then exists (select 1 from ${approvals}
      where ${approvals.orgId} = ${run}.org_id and ${approvals.runId} = ${run}.id and ${approvals.status} = 'pending'
        and ${decidableBySql(viewerId)})
    when 'waiting_input' then exists (select 1 from agent_questions q
        where q.org_id = ${run}.org_id and q.run_id = ${run}.id and q.status = 'open' and q.expires_at > now()
          and q.requested_for_user_id = ${viewer})
      or exists (select 1 from secret_requests s
        where s.org_id = ${run}.org_id and s.run_id = ${run}.id and s.status = 'pending'
          and s.requested_for_user_id = ${viewer})
    else false end`;
};

type Row = {
  run_id: string;
  agent_id: string;
  status: string;
  on_machine: boolean | string;
  outage: boolean | string;
  wait_code: string | null;
  work_since: string | Date;
  wait_since: string | Date;
  for_agent: string | null;
  anchored: boolean | string;
  anchor_background: boolean | string;
  channel_id: string;
  channel_kind: "channel" | "dm" | "task" | "file" | "code";
  channel_name: string;
  thread_root_id: string;
  trigger_message_id: string;
  reply_in_thread: boolean | string;
  reply_message_id: string | null;
  /** Its place may show to whoever reads it: not archived, not two agents' DM (`readable` then asks the viewer). */
  placeable: boolean | string;
  /** Its last sign of life (`heartbeat_at`, else its start or last change), for `aliveAfter`. */
  alive_at: string | Date;
  right_hand: boolean | string | null;
};

const uuids = (ids: readonly string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;

/**
 * What one person may see of a workspace's kept reads (`caches.orgReads`), asked only for the ids given, in one
 * statement: the channels they read (`channelReaderSql`), the runs that wait on them (`waitsOnViewerIn`), the agents
 * they answer for (`ownsAgentSql`) and the ones they manage (`managesAgentSql`). Never kept: who may see what is read
 * fresh at every request, by the same rules the per-person statements used.
 */
export async function viewerFacts(
  db: Executor,
  viewerId: string,
  orgId: string,
  ask: { channelIds?: readonly string[]; runIds?: readonly string[]; agentIds?: readonly string[] },
) {
  const facts = {
    reads: new Set<string>(),
    waitsOn: new Set<string>(),
    owns: new Set<string>(),
    manages: new Set<string>(),
  };
  const channelIds = [...new Set(ask.channelIds ?? [])];
  const runIds = [...new Set(ask.runIds ?? [])];
  const agentIds = [...new Set(ask.agentIds ?? [])];
  const viewer = sql`${viewerId}::text`;
  const parts: SQL[] = [];
  if (channelIds.length > 0)
    parts.push(sql`select 'reads' as fact, c.id from channels c
      where c.org_id = ${orgId}::uuid and c.id = any(${uuids(channelIds)}) and ${channelReaderSql(sql`c.id`, viewer)}`);
  if (runIds.length > 0)
    parts.push(sql`select 'waitsOn' as fact, r.id from agent_runs r
      where r.org_id = ${orgId}::uuid and r.id = any(${uuids(runIds)}) and ${waitsOnViewerIn("r", viewerId)}`);
  if (agentIds.length > 0)
    parts.push(sql`select f.fact, g.id from agents g
      cross join lateral (values ('owns', ${ownsAgentSql("g", viewer)}), ('manages', ${managesAgentSql("g", viewer)})) f(fact, yes)
      where g.org_id = ${orgId}::uuid and g.id = any(${uuids(agentIds)}) and f.yes`);
  if (parts.length === 0) return facts;
  const rows = rowsOf<{ fact: keyof typeof facts; id: string }>(await db.execute(sql.join(parts, sql` union all `)));
  for (const r of rows) facts[r.fact].add(r.id);
  return facts;
}

const truthy = (v: boolean | string | null | undefined) => v === true || v === "t";
const iso = (v: string | Date) => new Date(v).toISOString();

/** Waits whose word is the agent's out of office, not its work's. */
const LIMIT_WAITS = new Set(["plan_limit", "budget", "usage_pause"]);

/** How one run stands for the viewer, or null for none worth a line (a wait on its plan or budget). */
export function workStateOf(r: {
  status: string;
  onMachine: boolean;
  outage: boolean;
  waitCode: string | null;
  you: boolean;
}): AgentWorkState | null {
  if (r.status === "queued") return "queued";
  // Asking its computer for room from the line.
  if (r.status === "running") return r.onMachine ? "queued" : "working";
  if (r.status === "waiting_approval") return r.you ? "you" : "approval";
  if (r.outage) return "outage";
  if (r.waitCode && LIMIT_WAITS.has(r.waitCode)) return null;
  if (r.waitCode === "busy" || r.waitCode === "work_queue") return "queued";
  if (r.onMachine || r.waitCode) return "computer";
  return r.you ? "you" : "answer";
}

/** Which of two items an agent's line says: waiting on you, then working, then a neutral wait, then in line. */
const RANK: Record<AgentWorkState, number> = {
  you: 0,
  working: 1,
  approval: 2,
  answer: 2,
  computer: 2,
  outage: 2,
  queued: 3,
  later: 4,
};

/**
 * Each agent's work for `viewerId`, by agent id: its most important run (`RANK`, then the oldest) and how many it has
 * on. One statement whatever the number of agents: the open runs, their anchors, whether the viewer reads each anchor
 * (`channelReaderSql`) and whether the run waits on them (`decidableBySql` for an approval, the question or secret
 * asked of them). The right hand is each person's own (ADR 0137): its runs where the viewer doesn't read are someone
 * else's talk with it, never counted.
 */
export async function agentWorkFor(
  db: Executor,
  viewerId: string,
  orgId: string,
  /** A running run with no heartbeat since lost its worker: it doesn't count (`loadAgentStatuses`' rule). */
  aliveAfter: Date,
): Promise<Map<string, AgentWork>> {
  const rows = (await orgWork(db, orgId)).filter(
    (r) => !(r.status === "running" && new Date(r.alive_at).getTime() < aliveAfter.getTime()),
  );
  const facts = await viewerFacts(db, viewerId, orgId, {
    channelIds: rows.flatMap((r) => (truthy(r.placeable) ? [r.channel_id] : [])),
    runIds: rows.flatMap((r) => (r.status === "waiting_approval" || r.status === "waiting_input" ? [r.run_id] : [])),
  });
  const out = new Map<string, AgentWork & { rank: number }>();
  for (const r of rows) {
    const readable = truthy(r.placeable) && facts.reads.has(r.channel_id);
    if (truthy(r.right_hand) && !readable) continue;
    const you = facts.waitsOn.has(r.run_id);
    const state = workStateOf({
      status: r.status,
      onMachine: truthy(r.on_machine),
      outage: truthy(r.outage),
      waitCode: r.wait_code,
      you,
    });
    if (!state) continue;
    const routine = truthy(r.anchor_background);
    const placed = readable && !routine;
    const work: AgentWork & { rank: number } = {
      state,
      ask: state !== "you" ? null : r.status === "waiting_approval" ? "approval" : "answer",
      since: iso(state === "working" ? r.work_since : r.wait_since),
      runId: r.run_id,
      channelId: placed ? r.channel_id : null,
      channelKind: placed ? r.channel_kind : null,
      channelName: placed && r.channel_kind === "channel" ? r.channel_name : null,
      threadId: placed
        ? replyThreadOf({
            threadRootId: r.thread_root_id,
            triggerMessageId: r.trigger_message_id,
            replyInThread: truthy(r.reply_in_thread),
          })
        : null,
      messageId: placed && truthy(r.anchored) ? r.reply_message_id : null,
      forAgentId: placed && truthy(r.anchored) ? r.for_agent : null,
      routine,
      count: 1,
      ...(truthy(r.placeable) && !readable && !routine ? { private: true as const } : {}),
      rank: RANK[state],
    };
    const best = out.get(r.agent_id);
    if (!best) {
      out.set(r.agent_id, work);
      continue;
    }
    const count = best.count + 1;
    const wins = work.rank < best.rank || (work.rank === best.rank && work.since < best.since);
    out.set(r.agent_id, wins ? { ...work, count } : { ...best, count });
  }
  return new Map([...out].map(([id, { rank: _rank, ...work }]) => [id, work]));
}

/**
 * The workspace's runs still on, each with the run people see it from (`anchorsSql`), before anything about the
 * viewer: one statement kept a moment for every member (`caches.orgReads`), forgotten when a status is announced.
 */
const orgWork = (db: Executor, orgId: string) =>
  caches.orgReads.getOrLoad(`${orgId}:work`, async () =>
    rowsOf<Row>(
      await db.execute(sql`with ${anchorsSql(orgId)}
        select r.id as run_id, r.agent_id, r.status, r.waiting_machine_id is not null as on_machine,
          ${outageIn("r")} as outage, coalesce(r.state, r.transcript)->'waitingForBrain'->>'code' as wait_code,
          coalesce(t.handed_at, r.started_at, r.created_at) as work_since, ${waitSinceIn("r")} as wait_since,
          t.for_agent, a.id <> r.id as anchored, a.background as anchor_background,
          c.id as channel_id, c.kind as channel_kind, c.name as channel_name, a.thread_root_id, a.trigger_message_id,
          a.reply_in_thread, a.reply_message_id, (c.archived_at is null and not ${agentsOnlyIn("c")}) as placeable,
          coalesce(r.heartbeat_at, r.started_at, r.updated_at) as alive_at, g.builtin = 'right_hand' as right_hand
        from anchors t
        join agent_runs r on r.id = t.run_id
        join agents g on g.id = r.agent_id
        join agent_runs a on a.id = t.anchor_id
        join channels c on c.id = a.channel_id`),
    ),
  ) as Promise<Row[]>;

/** The work without where it is: what an agent hidden from the viewer, or a place they don't read, shows. */
export const bareWork = ({ private: _private, ...w }: AgentWork): AgentWork => ({
  ...w,
  channelId: null,
  channelKind: null,
  channelName: null,
  threadId: null,
  messageId: null,
  forAgentId: null,
});
