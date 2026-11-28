import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  type Database,
  type Executor,
  eq,
  inArray,
  isNull,
  or,
  rowsOf,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { managesAgentSql, ownsAgentSql } from "./audience";
import type { BrainPlan } from "./brains/select";
import { TtlCache } from "./cache";
import { NotFoundError } from "./errors";
import { publishOrgEvent } from "./events";
import { getMachine, type ShownMaintenance, shownMaintenance, shownMoving } from "./machines";
import { requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { runState } from "./run-state";
import { RUN_STALE_MS, replyThreadOf } from "./runs";

const { agentRuns, agents, channelMembers, channels, machines, messages } = schema;

/**
 * The line for a shared computer's room (ADR 0032, "Calm waits" and "Calm wakes"). The runner admits a turn only
 * while its memory floor holds and keeps no order, so the engine keeps it, in three ranks: runs a person is waiting
 * on, then agents' work a person asked for lately (`transcript.roomAsked`), then the rest; by when each started
 * waiting within a rank. Only the head of the line asks the runner again. On a computer near its floor, agents'
 * turns start `ROOM_ASK_SPACING_MS` apart, so a burst of mentions reaches it one by one instead of all refused at
 * once (each refusal closes idle CLIs for room); one with clear headroom (`roomIsClear`), or a turn on a CLI already
 * open, starts at once.
 */
export const ROOM_ASK_SPACING_MS = 3_000;

/**
 * What a coding CLI grows to once it runs, and the floor the runner keeps for agents' turns: mirrors of the runner's
 * `TURN_BYTES` and `MIN_FREE_BYTES` (`apps/server/runner/handlers.ts`, `desktop-session.ts`).
 */
const TURN_BYTES = 0.6e9;
const AGENTS_FLOOR_BYTES = 1.5 * 1024 ** 3;
/**
 * How old a computer's free-memory report may be: the runner sends it at most this long after it changed (its
 * `TASK_ROOM_QUIET_MS`), so a turn asked since may be missing from it and is counted against it.
 */
const ROOM_REPORT_MS = 120_000;

/**
 * Clear headroom: the computer's last free-memory report (`size.room.freeGb`, protocol 78), less a turn's growth for
 * each turn asked there within `ROOM_REPORT_MS`, still fits one more above the agents' floor. No report (memory not
 * read there, an older runner): not clear.
 */
export const roomIsClear = (freeGb: number | null, recentAsks: number) =>
  freeGb !== null && freeGb * 1024 ** 3 - recentAsks * TURN_BYTES >= AGENTS_FLOOR_BYTES + TURN_BYTES;

/**
 * When a run behind another in line looks again. The line moves by kicks (a turn ended, the spacing is over), so this
 * is only the fallback: polling at the spacing would triple the line's jobs for no earlier start.
 */
export const ROOM_BEHIND_RETRY_MS = 10_000;

/**
 * A run of the last rank waiting this long ranks with work a person asked for, so a steady stream of that work can't
 * keep it in line for good (a run asks for room until it runs).
 */
export const ROOM_RANK_AGE_MS = 10 * 60_000;

const inLine = and(eq(agentRuns.status, "waiting_input"), sql`${runState}->'waitingForBrain'->>'code' = 'busy'`);
const waitingForRoom = (machineId: string) => and(eq(agentRuns.waitingMachineId, machineId), inLine);
/**
 * The line as people read it: also the run asking from it (`computerWaitOf`), which the computer may still refuse.
 * Read as gone, its row went away at every ask, and a person's message starts one the moment the apps read the line.
 */
const shownInLine = (machineId: string) =>
  and(eq(agentRuns.waitingMachineId, machineId), or(inLine, eq(agentRuns.status, "running")));
const waitIdSql = sql<string | null>`${runState}->'waitingForBrain'->>'waitId'`;
const peopleSql = sql`coalesce((${runState}->>'roomPeople')::boolean, false)`;
const askedSql = sql`coalesce((${runState}->>'roomAsked')::boolean, false)`;
/**
 * Its place in the line: since it started waiting for room, or, a wake that waited outside any run first, since then
 * (`roomOrderSince`). The note after `COMPUTER_QUEUE_NOTE_MS` reads `roomWaitSince` alone.
 */
const sinceSql = sql`coalesce((${runState}->>'roomOrderSince')::bigint, (${runState}->>'roomWaitSince')::bigint, 0)`;
/** A run's rank in the line: 0 a person waits on it, 1 work a person asked for lately (or waiting long), 2 the rest. */
const rankSql = (now: number) =>
  sql<number>`(case when ${peopleSql} then 0 when ${askedSql} or ${sinceSql} < ${now - ROOM_RANK_AGE_MS}::bigint then 1 else 2 end)`;
export type RoomRank = 0 | 1 | 2;

/**
 * Which gate held a run waiting for room, kept on its wait step (`room`): another run ahead in the line, its plan
 * sign-in at its cap, `ROOM_ASK_SPACING_MS`, or the runner's own room check (`no_slot`, free memory on Linux).
 */
export type RoomWaitCause = "line" | "sign_in" | "spacing" | "memory";

/** A Claude plan sign-in a run thinks with: its account, or its computer's own sign-in (`own`). */
export interface SignInSlot {
  key: string;
  /** Runs it takes at once; 0 or less: no limit. */
  cap: number;
}

/**
 * The plan sign-in this plan's turn holds a slot of: Claude Code on a subscription (its account, or its computer's own
 * sign-in). Never an API key nor a coding plan's key (`provider`), nor another brain.
 */
export function signInSlotOf(plan: Pick<BrainPlan, "kind" | "account">, cap: number): SignInSlot | undefined {
  if (plan.kind !== "claude_code" || plan.account?.provider || cap <= 0) return undefined;
  return { key: plan.account?.id ?? "own", cap };
}

/** A computer's own sign-in is that computer's; an account is the workspace's, whichever computer its runs think on. */
const ownSignIn = (key: string) => key === "own";

/**
 * The sign-in a run in line waits to think with (`signInWait`), whatever held it (its cap, the line, the spacing):
 * only runs on that same sign-in hold it back. A run without one (the computer's memory, or no plan sign-in) holds
 * back the whole line.
 */
const signInWaitSql = sql<string | null>`${runState}->'signInWait'->>'key'`;

/** A run working on a sign-in now, holding one of its slots: one whose worker died stops counting once its heartbeat is stale. */
const holdsSlot = (orgId: string, now: number) =>
  and(
    eq(agentRuns.orgId, orgId),
    eq(agentRuns.status, "running"),
    sql`${agentRuns.heartbeatAt} > ${new Date(now - RUN_STALE_MS).toISOString()}::timestamptz`,
  );

/** The workspace's accounts with every slot taken now, so a run at its own sign-in's cap goes on with another one. */
export async function fullSignIns(db: Executor, orgId: string, cap: number): Promise<Set<string>> {
  const key = sql<string>`${runState}->'roomAsk'->>'signIn'`;
  const rows = await db
    .select({ key })
    .from(agentRuns)
    .where(and(holdsSlot(orgId, Date.now()), sql`${key} is not null`, sql`${key} <> 'own'`))
    .groupBy(key)
    .having(sql`count(*) >= ${cap}`);
  return new Set(rows.map((r) => r.key));
}

/** The run first in line for room on this computer, with the wait its job must carry. */
export async function roomHead(
  db: Database,
  machineId: string,
): Promise<{ id: string; orgId: string; waitId: string | null } | null> {
  const [head] = await db
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      waitId: waitIdSql,
    })
    .from(agentRuns)
    .where(waitingForRoom(machineId))
    .orderBy(rankSql(Date.now()), sinceSql, agentRuns.id)
    .limit(1);
  return head ?? null;
}

/**
 * A person's message went into this run waiting in line: a person waits on it now, so it goes to the front and looks
 * again at once (the same job as a steered message's). The job tells the line's viewers (`line`), after this commits.
 */
export async function frontOfLine(db: Executor, run: { id: string; orgId: string }, messageId: string) {
  const [row] = await db
    .update(agentRuns)
    .set({ transcript: sql`jsonb_set(${agentRuns.transcript}, '{roomPeople}', 'true'::jsonb)` })
    .where(and(eq(agentRuns.id, run.id), inLine))
    .returning({ waitId: waitIdSql, machineId: agentRuns.waitingMachineId });
  if (!row) return;
  await enqueue(db, {
    orgId: run.orgId,
    kind: "agent_run.execute",
    payload: {
      runId: run.id,
      ...(row.waitId ? { wait: row.waitId } : {}),
      ...(row.machineId ? { line: row.machineId } : {}),
    },
    dedupeKey: `agent_run.execute:${run.id}:steer:${messageId}`,
    maxAttempts: 4,
  });
}

/**
 * Asks the head of the line to look again: now (a turn there ended, or one went in with clear headroom), or `at` (the
 * spacing is over). One job of each per wait.
 */
export async function kickRoomQueue(db: Database, machineId: string, at?: Date) {
  const head = await roomHead(db, machineId);
  if (!head?.waitId) return;
  await enqueue(db, {
    orgId: head.orgId,
    kind: "agent_run.execute",
    payload: { runId: head.id, wait: head.waitId },
    dedupeKey: `agent_run.execute:${head.id}:room-kick:${head.waitId}:${at ? "spaced" : "freed"}`,
    maxAttempts: 4,
    ...(at ? { runAt: at } : {}),
  });
}

/**
 * A run on this sign-in left its slot (it ended, or waits on something else): the first run in line waiting for that
 * sign-in looks again now, not at its next retry.
 */
export async function kickSignInLine(db: Executor, machineId: string, key: string) {
  const [head] = await db
    .select({ id: agentRuns.id, orgId: agentRuns.orgId, waitId: waitIdSql })
    .from(agentRuns)
    .where(and(ownSignIn(key) ? waitingForRoom(machineId) : inLine, sql`${signInWaitSql} = ${key}`))
    .orderBy(rankSql(Date.now()), sinceSql, agentRuns.id)
    .limit(1);
  if (!head?.waitId) return;
  await enqueue(db, {
    orgId: head.orgId,
    kind: "agent_run.execute",
    payload: { runId: head.id, wait: head.waitId },
    dedupeKey: `agent_run.execute:${head.id}:sign-in-freed:${head.waitId}`,
    maxAttempts: 4,
  });
}

/**
 * Whether this run may send its computer turn now. Null: go (its ask is recorded, and the next in line is asked
 * at once on a computer with clear headroom, else once the spacing is over). Otherwise it is behind: `retryAt` is when
 * it may look again. Behind when a run waiting for room ranks ahead of it (by rank, then the longest wait), or, for
 * agents' work on a computer without clear headroom (`roomIsClear`), when another run asked it less than
 * `ROOM_ASK_SPACING_MS` ago. A person's turn and one on a CLI already open on this computer (`warmOn`: it starts no process) never wait
 * for the spacing; the runner's memory floor still decides whether each fits.
 */
export async function roomGate(
  db: Database,
  run: { id: string; orgId: string },
  machineId: string,
  place: { rank: RoomRank; since: number; warmOn?: string | null },
  signIn?: SignInSlot,
): Promise<{ retryAt: number; cause: RoomWaitCause } | null> {
  const now = Date.now();
  const rank = place.rank === 2 && place.since < now - ROOM_RANK_AGE_MS ? 1 : place.rank;
  let clear = false;
  const behind = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`room:${machineId}`}))`);
    const [ahead] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          waitingForRoom(machineId),
          sql`${agentRuns.id} <> ${run.id}`,
          sql`(${rankSql(now)}, ${sinceSql}, ${agentRuns.id}) < (${rank}::int, ${place.since}::bigint, ${run.id}::uuid)`,
          // A run held only by another sign-in's limit doesn't hold this one back.
          sql`(${signInWaitSql} is null or ${signInWaitSql} = ${signIn?.key ?? ""})`,
        ),
      )
      .limit(1);
    if (ahead) return { retryAt: now + ROOM_BEHIND_RETRY_MS, cause: "line" as const };
    if (signIn) {
      if (!ownSignIn(signIn.key))
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sign-in:${signIn.key}`}))`);
      const [taken] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(agentRuns)
        .where(
          and(
            holdsSlot(run.orgId, now),
            sql`${agentRuns.id} <> ${run.id}`,
            ownSignIn(signIn.key) ? sql`${runState}->'roomAsk'->>'machineId' = ${machineId}` : undefined,
            sql`${runState}->'roomAsk'->>'signIn' = ${signIn.key}`,
          ),
        );
      if (Number(taken?.n ?? 0) >= signIn.cap)
        return { retryAt: now + ROOM_BEHIND_RETRY_MS, cause: "sign_in" as const };
    }
    const askAt = sql`(${runState}->'roomAsk'->>'at')::bigint`;
    const [last] = await tx
      .select({
        at: sql<string | null>`max(${askAt})`,
        recent: sql<number>`count(*) filter (where ${askAt} > ${now - ROOM_REPORT_MS}::bigint)::int`,
        freeGb: sql<
          number | null
        >`(select (${machines.size}->'room'->>'freeGb')::float8 from ${machines} where ${machines.id} = ${machineId})`,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, run.orgId),
          eq(agentRuns.status, "running"),
          sql`${agentRuns.id} <> ${run.id}`,
          sql`${runState}->'roomAsk'->>'machineId' = ${machineId}`,
        ),
      );
    clear = roomIsClear(last?.freeGb == null ? null : Number(last.freeGb), Number(last?.recent ?? 0));
    const at = Number(last?.at ?? 0);
    if (rank > 0 && place.warmOn !== machineId && !clear && now - at < ROOM_ASK_SPACING_MS)
      return { retryAt: at + ROOM_ASK_SPACING_MS, cause: "spacing" as const };
    await tx
      .update(agentRuns)
      .set({
        transcript: sql`jsonb_set(coalesce(${agentRuns.transcript}, '{}'::jsonb), '{roomAsk}', ${JSON.stringify({ machineId, at: now, ...(signIn ? { signIn: signIn.key } : {}) })}::jsonb)`,
      })
      .where(eq(agentRuns.id, run.id));
    return null;
  });
  if (!behind) await kickRoomQueue(db, machineId, clear ? undefined : new Date(now + ROOM_ASK_SPACING_MS));
  return behind;
}

/** The computer whose line shows this run: the one it is working on, or the one it waits in line for. */
export function lineMachineOf(run: { transcript: unknown; waitingMachineId: string | null }): string | null {
  const t = run.transcript as { roomAsk?: { machineId?: string }; waitingForBrain?: { code?: string } } | null;
  if (t?.waitingForBrain?.code === "busy" && run.waitingMachineId) return run.waitingMachineId;
  return t?.roomAsk?.machineId ?? null;
}

/** Tells every open app of the workspace that this computer's line changed, so whoever shows it reads it again. */
export async function publishQueueChanged(pubsub: PubSub | undefined, orgId: string, machineId: string) {
  await publishOrgEvent(pubsub, { type: "org.broadcast", orgId, event: { type: "computer.queue", machineId } });
}

/**
 * What a turn on the computer is for, in structured words and never its content: answering a person, asked by
 * another agent, a routine's run, or long work (ADR 0121). The ids are null when the author is gone.
 */
export type QueuePurpose =
  | { kind: "person"; userId: string | null }
  | { kind: "agent"; agentId: string | null }
  | { kind: "routine" }
  | { kind: "work" };

export interface QueueWhere {
  channelId: string;
  threadId: string | null;
  /** Two agents' private conversation, said only to who may see that work. */
  agents: boolean;
}

/** What the caller may do with a row of the line: everyone reads the line, these depend on who reads it. */
export interface QueueAccess {
  /** It sees this run in the task manager (`seesRunSql`): the row opens it. */
  canOpen: boolean;
  /** It may stop it (who asked, the agent's owner, an admin; the server checks again). */
  canStop: boolean;
}

export interface QueueWorking extends QueueAccess {
  runId: string;
  agentId: string;
  purpose: QueuePurpose;
  where: QueueWhere;
  /** When this turn asked the computer (ISO). */
  startedAt: string;
  /** Its start plus the agent's typical computer turn, never sooner than 30 s from now; null with no basis. */
  estimatedEndAt: string | null;
  /** Past its agent's typical turn: there is no honest end to give (`estimatedEndAt` is null). */
  overdue: boolean;
}

export interface QueueWaiting extends QueueAccess {
  runId: string;
  agentId: string;
  purpose: QueuePurpose;
  where: QueueWhere;
  /** A person waits on it: it goes first. */
  people: boolean;
  /** 1 = next. */
  position: number;
  estimatedStartAt: string | null;
  /** Who it waits for: for the head, the running turn expected to end first; behind it, the agents ahead in line. */
  after: string[];
}

export interface ComputerQueue {
  machineId: string;
  name: string;
  /** It is away for what we do to it (a move, a restart…): the line waits for it, and its dialog says so. */
  moving: boolean;
  /** What we do to it (`shownMaintenance`). */
  maintenance: ShownMaintenance | null;
  working: QueueWorking[];
  waiting: QueueWaiting[];
}

/**
 * Two agents' private conversation (or a routine's room): `isAgentOnlyDm` for a select. No person is a member, so
 * membership can't say who sees the work there.
 */
const agentsOnlySql = (kind: SQL, dmKey: SQL) =>
  sql<boolean>`(${kind} = 'dm' and ${dmKey} is not null and ${dmKey} not like '%u:%')`;

/**
 * Who sees a run's work, for a select naming its columns: the members of its conversation and, for work no person is
 * a member of (a routine's background run, two agents' private conversation), who manages the agent (`manages`: a
 * value, or SQL per run such as `managesAgentSql`, ADR 0085 addendum of 2026-11-17) and the agent's owner (`owns`:
 * `ownsAgentSql` for the viewer, its owner role's holders too, ADR 0085 addendum of 2026-11-21). Other people's DMs
 * stay theirs. The task manager, a task's steps and the rows of the line read it. Never NULL: an agent with no owner
 * would make it so, and `not` of that drops the run from the hidden counts too.
 */
export const seesRunSql = (
  run: { channelId: SQL; kind: SQL; dmKey: SQL; background: SQL; owns: SQL<boolean> },
  userId: string,
  orgId: string,
  manages: boolean | SQL<boolean>,
) => sql<boolean>`coalesce(exists (select 1 from ${channelMembers} cm
    where cm.org_id = ${orgId}::uuid and cm.channel_id = ${run.channelId} and cm.user_id = ${userId})
  or ((${run.background} or ${agentsOnlySql(run.kind, run.dmKey)}) and (${manages} or ${run.owns})), false)`;

/** A running turn's estimated end is never sooner than this from now: an estimate never reads as "any second". */
export const QUEUE_END_FLOOR_MS = 30_000;
/** How many of an agent's latest finished computer turns its typical duration is read from. */
const TYPICAL_TURNS = 20;

/** Median computer-turn durations (ms): per agent, and the org's as the fallback. */
export interface TypicalTurns {
  byAgent: Record<string, number>;
  org: number | null;
}

/**
 * When each running turn should end and each waiting one start, by simulating the computer's slots: each running
 * turn frees one at its expected end, the line takes them in order (the soonest free slot first), and an agent's turn
 * starts at least `ROOM_ASK_SPACING_MS` after the previous ask. A turn past its typical length (`overdue`) has no end
 * to give, and neither has one with no basis (an agent with no history in an org with none): its slot frees at an
 * unknown time, and so does every turn after it. Pure, for a fixed clock.
 */
export function estimateQueue(
  now: number,
  working: readonly { agentId: string; startedAt: number }[],
  waiting: readonly { agentId: string; people: boolean }[],
  typical: TypicalTurns,
): { ends: (number | null)[]; overdue: boolean[]; starts: (number | null)[]; after: string[][] } {
  const typicalOf = (agentId: string) => typical.byAgent[agentId] ?? typical.org;
  const expected = working.map((w) => {
    const d = typicalOf(w.agentId);
    return d === null ? null : w.startedAt + d;
  });
  const overdue = expected.map((end) => end !== null && end <= now);
  const ends = expected.map((end, i) => (end === null || overdue[i] ? null : Math.max(end, now + QUEUE_END_FLOOR_MS)));
  // Unknown ends go last, the longest running of them first.
  const slots = working.map((w, i) => ({
    agentId: w.agentId,
    end: ends[i] ?? Number.POSITIVE_INFINITY,
    since: w.startedAt,
  }));
  let lastAsk = working.reduce((max, w) => Math.max(max, w.startedAt), Number.NEGATIVE_INFINITY);
  const starts: (number | null)[] = [];
  const after: string[][] = [];
  waiting.forEach((w, i) => {
    after.push(i === 0 ? [] : [...new Set(waiting.slice(0, i).map((a) => a.agentId))]);
    if (slots.length === 0) {
      starts.push(null);
      return;
    }
    slots.sort((a, b) => a.end - b.end || a.since - b.since);
    const slot = slots[0] as (typeof slots)[number];
    if (i === 0) after[0] = [slot.agentId];
    if (!Number.isFinite(slot.end)) {
      starts.push(null);
      slots[0] = { agentId: w.agentId, end: Number.POSITIVE_INFINITY, since: Number.POSITIVE_INFINITY };
      return;
    }
    let start = Math.max(slot.end, now);
    if (!w.people) start = Math.max(start, lastAsk + ROOM_ASK_SPACING_MS);
    lastAsk = start;
    starts.push(start);
    const d = typicalOf(w.agentId);
    slots[0] = { agentId: w.agentId, end: d === null ? Number.POSITIVE_INFINITY : start + d, since: start };
  });
  return { ends, overdue, starts, after };
}

// A median of up to 20 turns over 14 days moves little in 10 minutes; the read touches up to 300 finished runs (their
// `state`, or the transcript of a run that ended before it).
// ponytail: per-process cache; a duration column written when the run ends would spare the read.
const typicalCache = new TtlCache<TypicalTurns>(10 * 60_000, 1000);

/**
 * The median of each agent's latest `TYPICAL_TURNS` finished computer turns, from its ask (`roomAsk.at`) to the
 * run's end, and the org's median over those, from the last 14 days.
 */
export async function typicalTurns(db: Database, orgId: string): Promise<TypicalTurns> {
  return typicalCache.getOrLoad(orgId, async () => {
    const rows = rowsOf<{ agent_id: string | null; ms: string | number | null }>(
      await db.execute(sql`
        with recent as (
          select agent_id, finished_at, coalesce(state, transcript) as t from agent_runs
          where org_id = ${orgId}::uuid and status = 'done' and brain is not null and brain <> 'model'
            and finished_at > now() - interval '14 days'
          order by finished_at desc
          limit 300
        ), turns as (
          select agent_id,
            extract(epoch from finished_at) * 1000 - (t->'roomAsk'->>'at')::bigint as ms,
            row_number() over (partition by agent_id order by finished_at desc) as n
          from recent
          where t ? 'roomAsk'
        )
        select agent_id, percentile_cont(0.5) within group (order by ms) as ms
        from turns where n <= ${TYPICAL_TURNS} and ms > 0
        group by rollup(agent_id)`),
    );
    const out: TypicalTurns = { byAgent: {}, org: null };
    for (const r of rows) {
      if (r.ms === null) continue;
      if (r.agent_id === null) out.org = Number(r.ms);
      else out.byAgent[r.agent_id] = Number(r.ms);
    }
    return out;
  });
}

const purposeOf = (r: {
  workId: string | null;
  background: boolean;
  authorType: string | null;
  authorUserId: string | null;
  authorAgentId: string | null;
  viaRoutine: unknown;
}): QueuePurpose =>
  r.workId
    ? { kind: "work" }
    : r.background || (r.authorType === "person" && r.viaRoutine)
      ? { kind: "routine" }
      : r.authorType === "agent"
        ? { kind: "agent", agentId: r.authorAgentId }
        : { kind: "person", userId: r.authorUserId };

/**
 * A computer's line as every member of the workspace sees it: the turns working on it now and the runs waiting for
 * room, in the order the engine admits them (`roomHead`), with estimates. Only the org's own computers.
 */
export async function computerQueue(
  db: Database,
  actorId: string,
  orgId: string,
  machineId: string,
  now = Date.now(),
): Promise<ComputerQueue> {
  await requirePermission(db, actorId, orgId, "read");
  // Who manages each run's agent (`managesAgentSql`), never every holder of "Editar qualquer agente".
  const manages = managesAgentSql("agents", sql`${actorId}::text`);
  // Its owner, or holding its owner role now (ADR 0085, addendum of 2026-11-21).
  const owns = ownsAgentSql("agents", sql`${actorId}::text`);
  const machine = await getMachine(db, orgId, machineId);
  if (!machine) throw new NotFoundError("Computer not found", "machine.not_found");
  const cols = {
    runId: agentRuns.id,
    agentId: agentRuns.agentId,
    channelId: agentRuns.channelId,
    threadRootId: agentRuns.threadRootId,
    triggerMessageId: agentRuns.triggerMessageId,
    replyInThread: agentRuns.replyInThread,
    workId: agentRuns.workId,
    background: agentRuns.background,
    authorType: messages.authorType,
    authorUserId: messages.authorUserId,
    authorAgentId: messages.authorAgentId,
    viaRoutine: sql<unknown>`${messages.meta}->'routine'`,
    owns,
    manages,
    sees: seesRunSql(
      {
        channelId: sql`${agentRuns.channelId}`,
        kind: sql`${channels.kind}`,
        dmKey: sql`${channels.dmKey}`,
        background: sql`${agentRuns.background}`,
        owns,
      },
      actorId,
      orgId,
      manages,
    ),
    agentsOnly: agentsOnlySql(sql`${channels.kind}`, sql`${channels.dmKey}`),
  };
  const trigger = and(eq(messages.orgId, agentRuns.orgId), eq(messages.id, agentRuns.triggerMessageId));
  const lineRows = <T extends object>(fields: T) =>
    db
      .select({ ...cols, ...fields })
      .from(agentRuns)
      .innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .leftJoin(channels, eq(channels.id, agentRuns.channelId))
      .leftJoin(messages, trigger);
  const askAt = sql<string>`(${runState}->'roomAsk'->>'at')::bigint`;
  const [workingRows, waitingRows, typical] = await Promise.all([
    lineRows({ askAt })
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.status, "running"),
          isNull(agentRuns.waitingMachineId),
          sql`${runState}->'roomAsk'->>'machineId' = ${machineId}`,
        ),
      )
      .orderBy(askAt),
    lineRows({ people: sql<boolean>`${peopleSql}` })
      .where(and(eq(agentRuns.orgId, orgId), shownInLine(machineId)))
      .orderBy(rankSql(now), sinceSql, agentRuns.id),
    typicalTurns(db, orgId),
  ]);
  const working = workingRows.map((r) => ({ ...r, startedAt: Number(r.askAt) }));
  const est = estimateQueue(now, working, waitingRows, typical);
  const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());
  const where = (r: {
    channelId: string;
    threadRootId: string;
    triggerMessageId: string;
    replyInThread: boolean;
    sees: boolean;
    agentsOnly: boolean;
  }) => ({
    channelId: r.channelId,
    threadId: replyThreadOf(r),
    agents: r.sees && r.agentsOnly,
  });
  const access = (r: {
    sees: boolean;
    manages: boolean | null;
    owns: boolean | null;
    authorUserId: string | null;
  }) => ({
    canOpen: r.sees,
    canStop: r.manages === true || r.owns === true || r.authorUserId === actorId,
  });
  return {
    machineId,
    name: machine.name,
    moving: shownMoving(machine),
    maintenance: shownMaintenance(machine),
    working: working.map((r, i) => ({
      runId: r.runId,
      agentId: r.agentId,
      purpose: purposeOf(r),
      where: where(r),
      startedAt: new Date(r.startedAt).toISOString(),
      estimatedEndAt: iso(est.ends[i]),
      overdue: est.overdue[i] ?? false,
      ...access(r),
    })),
    waiting: waitingRows.map((r, i) => ({
      runId: r.runId,
      agentId: r.agentId,
      purpose: purposeOf(r),
      where: where(r),
      people: Boolean(r.people),
      position: i + 1,
      estimatedStartAt: iso(est.starts[i]),
      after: est.after[i] ?? [],
      ...access(r),
    })),
  };
}

/** The best rank among this agent's runs in a computer's line, null when none is in line. */
export async function agentLineRank(db: Executor, orgId: string, agentId: string): Promise<RoomRank | null> {
  const [row] = await db
    .select({ rank: sql<number | null>`min(${rankSql(Date.now())})` })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentId, agentId), inLine));
  return row?.rank == null ? null : (Number(row.rank) as RoomRank);
}

/** For a select naming an agent: its computer has runs waiting for room (it is full, and work queues on it). */
export const computerCrowdedSql = (agentId: SQL) => sql<boolean>`exists (select 1 from ${agentRuns} w
  join ${agents} ca on ca.machine_id = w.waiting_machine_id
  where ca.id = ${agentId} and w.status = 'waiting_input' and coalesce(w.state, w.transcript)->'waitingForBrain'->>'code' = 'busy')`;

/** Of these agents, the ones whose computer has runs waiting for room. */
export async function crowdedAgents(db: Executor, orgId: string, agentIds: string[]): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds), computerCrowdedSql(sql`${agents}.id`)));
  return new Set(rows.map((r) => r.id));
}
