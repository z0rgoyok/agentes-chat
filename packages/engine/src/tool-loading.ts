import { and, type Database, desc, eq, gt, isNull, ne, or, schema, sql } from "@agenteschat/db";
import { transcriptKeys } from "./authority";
import { isConfidentialRun } from "./confidential";
import { cutText } from "./format";
import { JevOffError } from "./jev-key";
import type { Judge, JudgeGroup } from "./judge";
import { inChannelRun } from "./run-scope";
import { replyThreadOf } from "./runs";
import { deferrableGroups, type ToolGroup, toolGroupKey } from "./tools/directory";
import type { ToolDefinition } from "./tools/types";

/**
 * Tools on demand (ADR 0043): a run starts with the core tools (conversation,
 * memory, skills, reading the wiki) and the groups the judge expects it to
 * need for this message; every other tool stays one `find_tools` away. The
 * judge only picks what is listed up front: permissions don't change, and a
 * wrong guess costs a search, never a capability. The choice is made once per
 * run and kept on the transcript (`toolGroups`), so the tool list, and with
 * it the prompt cache, stays the same for the whole run. Some groups go
 * without asking (`keptToolGroups`): those the previous run here used, or listed within the hour.
 */

/** A group is loaded up front at this probability or more (a miss costs a search; a load costs every call). */
export const TOOL_GROUP_THRESHOLD = 0.3;
/** The judge answers within this, or the run starts with the previous run's groups (`chooseToolGroups`). */
export const TOOL_GROUPS_TIMEOUT_MS = 1500;
/** Tool names per group shown to the judge. */
const NAMES_PER_GROUP = 20;

/** Why a run loaded what it did, for its `context` step. */
export interface ToolGroupChoice {
  groups: string[];
  /** Each group's probability; empty when the judge didn't answer. */
  scores: Record<string, number>;
  /**
   * "judge", or why it fell back: to `keep` and the previous run's groups, else every group ("timeout"); to the core
   * tools and `keep` ("none", and "error" on a server with no Jev key); to every group ("error" otherwise: the judge
   * refused or failed).
   */
  source: "judge" | "timeout" | "error" | "none";
  /** Groups loaded without asking (`keptToolGroups`). */
  kept: string[];
  /** "error": what the judge said (`platform_cap`: the workspace's platform AI for the month is used up). */
  reason?: string;
}

const describeGroup = (g: ToolGroup) =>
  `${g.label}: ${g.tools
    .slice(0, NAMES_PER_GROUP)
    .map((t) => t.name)
    .join(", ")}${g.tools.length > NAMES_PER_GROUP ? `, and ${g.tools.length - NAMES_PER_GROUP} more` : ""}`;

/**
 * The tool groups a run loads up front: `keep`, and one calibrated yes/no per
 * other group the agent may use ("will it need these for this message?"), all
 * in one judge request. Without an answer in time, `keep` and the groups the
 * previous run here listed (`previous`), or every group when it listed none: a
 * slow judge must not leave the agent saying it can't do what it can. Only
 * `keep` (with the core tools and `find_tools`) on a server with no Jev key (`JevOffError`)
 * and in a confidential thread, where no run is ever judged. When the judge refuses or fails, every group: a
 * judge that is down (or refused for the month) would otherwise leave each run
 * with only what the previous one used, its other tools a search it may not
 * think of. A run another agent started (`lean`) keeps to `keep` then, as on a timeout.
 */
export async function chooseToolGroups(
  judge: Judge,
  input: {
    orgId: string;
    /** The agent and run, for the judge's usage record. */
    agentId?: string;
    runId?: string;
    /** The agent's role and instructions, short. */
    agent: { name: string; role: string; instructions: string };
    /** What the run answers. */
    message: string;
    /** The latest messages where it answers, oldest first ("person: text"). */
    recent: string[];
    tools: ToolDefinition[];
    /** Groups loaded without asking the judge (`keptToolGroups`). */
    keep?: string[];
    /** The groups the previous run in this conversation listed (`previousRunHere`): what a timeout loads. */
    previous?: string[] | null;
    timeoutMs?: number;
    /** Asked with the run's other start judgments (`JudgeGroup`). */
    group?: JudgeGroup;
    /** A run another agent started (a note or a question between agents): a judge that fails loads only `keep`. */
    lean?: boolean;
  },
): Promise<ToolGroupChoice> {
  const all = deferrableGroups(input.tools);
  const kept = all.filter((g) => input.keep?.includes(g.key)).map((g) => g.key);
  const groups = all.filter((g) => !kept.includes(g.key));
  const none = (source: ToolGroupChoice["source"]): ToolGroupChoice => ({ groups: kept, scores: {}, source, kept });
  if (groups.length === 0) {
    input.group?.skip("tool_groups");
    return none("none");
  }
  const questions = Object.fromEntries(
    groups.map((g, i) => [
      `g${i}`,
      {
        type: "noul" as const,
        instructions: `An AI agent of a team (\`agent\`) is about to answer \`message\` in a chat thread (\`recent\` is what was said before it). Will it need these tools to do what the message asks, or to look into it before answering? ${describeGroup(g)}`,
        criteria: {
          true: "It will likely use these tools for this message: the message (or the thread it continues) is about what they do.",
          false: "It won't need them for this message.",
        },
      },
    ]),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), input.timeoutMs ?? TOOL_GROUPS_TIMEOUT_MS);
  });
  try {
    const answers = await Promise.race([
      judge.ask({
        orgId: input.orgId,
        agentId: input.agentId,
        runId: input.runId,
        kind: "tool_groups",
        calibrated: true,
        ...(input.group ? { group: input.group } : {}),
        state: {
          agent: {
            name: input.agent.name,
            role: input.agent.role,
            instructions: cutText(input.agent.instructions, 1500),
          },
          message: cutText(input.message, 2000),
          recent: input.recent.map((m) => cutText(m, 400)).join("\n"),
        },
        questions,
      }),
      timeout,
    ]);
    if (answers === "timeout") {
      const had = all.some((g) => input.previous?.includes(g.key));
      const more = groups.filter((g) => !had || input.previous?.includes(g.key)).map((g) => g.key);
      return { groups: [...kept, ...more], scores: {}, source: "timeout", kept };
    }
    const scores: Record<string, number> = {};
    const chosen = [...kept];
    groups.forEach((g, i) => {
      const p = answers[`g${i}`]?.noul ?? 0;
      scores[g.key] = Math.round(p * 1000) / 1000;
      if (p >= TOOL_GROUP_THRESHOLD) chosen.push(g.key);
    });
    return { groups: chosen, scores, source: "judge", kept };
  } catch (error) {
    // A confidential thread's run is never judged (ADR 0190): its refusal is no outage.
    if (error instanceof JevOffError || isConfidentialRun(input.runId)) return none("error");
    const reason = cutText(error instanceof Error ? error.message : String(error), 200);
    // Another agent's words name the task, and every group would be most of a wake's prompt (each note pays it).
    if (input.lean) return { ...none("error"), reason };
    return { groups: [...kept, ...groups.map((g) => g.key)], scores: {}, source: "error", kept, reason };
  } finally {
    clearTimeout(timer);
  }
}

/** Messages the judge reads before the one the run answers. */
const RECENT_MESSAGES = 6;

/**
 * The latest messages where the run answers, oldest first, for the judge:
 * the thread when it has replies, else the channel's top level. Only the
 * last week (the table is partitioned by time).
 */
export async function recentForJudge(
  db: Database,
  run: { orgId: string; channelId: string; threadRootId: string; triggerMessageId: string },
): Promise<string[]> {
  const m = schema.messages;
  const since = gt(m.createdAt, new Date(Date.now() - 7 * 24 * 3600_000));
  const pick = { body: m.body, authorType: m.authorType, id: m.id };
  const base = and(eq(m.orgId, run.orgId), eq(m.channelId, run.channelId), since, isNull(m.deletedAt));
  let rows = await db
    .select(pick)
    .from(m)
    .where(and(base, or(eq(m.threadId, run.threadRootId), eq(m.id, run.threadRootId))))
    .orderBy(desc(m.createdAt))
    .limit(RECENT_MESSAGES + 1);
  if (rows.length <= 1) {
    rows = await db
      .select(pick)
      .from(m)
      .where(and(base, isNull(m.threadId)))
      .orderBy(desc(m.createdAt))
      .limit(RECENT_MESSAGES + 1);
  }
  return rows
    .filter((r) => r.id !== run.triggerMessageId)
    .slice(0, RECENT_MESSAGES)
    .reverse()
    .map((r) => `${r.authorType}: ${r.body.replace(/\s+/g, " ")}`);
}

/**
 * The groups a run keeps without asking the judge (ADR 0043, token-trim B1): those of the tools the agent's previous
 * run in this conversation called (`previousRunHere`), and, while that run is within `KEEP_LOADED_MS`, every group it
 * listed. The tools come before the system prompt and the history in the provider's prompt cache, so a group that
 * drops between two runs makes the next one write all of it again; one kept is read from the cache for a tenth of
 * that. Past the hour the cache is cold anyway: only what was used stays, and a greeting after computer work no longer
 * carries the computer's tools. A miss costs one `find_tools` search.
 */
export function keptToolGroups(
  previous: PreviousRun | null,
  tools: ToolDefinition[],
  now = Date.now(),
): { used: string[]; listed: string[] } {
  if (!previous) return { used: [], listed: [] };
  const names = new Set(previous.calledTools);
  const warm = now - previous.updatedAt.getTime() < KEEP_LOADED_MS;
  const listed = new Set(warm ? (previous.toolGroups ?? []) : []);
  const used = new Set(tools.filter((t) => names.has(t.name)).map(toolGroupKey));
  return {
    used: [...used],
    listed: [...new Set(tools.map(toolGroupKey).filter((g) => listed.has(g) && !used.has(g)))],
  };
}

/** The agent's previous run in this conversation, as the next run's start reads it (`previousRunHere`). */
export interface PreviousRun {
  id: string;
  /** When it ended (else its last change): the provider's prompt cache of it lives an hour from its last call. */
  updatedAt: Date;
  /** The groups it listed (`Transcript.toolGroups`). */
  toolGroups: string[] | null;
  /** Its "Automático" choice (`Transcript.autoModel`). */
  autoModel: { tier?: unknown; effort?: unknown } | null;
  /** The tools it called (at most 200 names). */
  calledTools: string[];
}

/** The agent's previous run in this conversation: the thread; in a channel's or DM's main timeline, its last run there. */
export async function previousRunHere(
  db: Database,
  run: {
    id: string;
    orgId: string;
    agentId: string;
    channelId: string;
    threadRootId: string;
    triggerMessageId: string;
    replyInThread: boolean;
  },
): Promise<PreviousRun | null> {
  const r = schema.agentRuns;
  const st = schema.agentRunSteps;
  const [row] = await db
    .select({
      id: r.id,
      updatedAt: sql<Date>`coalesce(${r.finishedAt}, ${r.updatedAt})`.mapWith(r.updatedAt),
      transcript: transcriptKeys("toolGroups", "autoModel"),
      // `agent_runs.id` spelled out: a column in a select renders unqualified, and would resolve to the steps' own `id`.
      calledTools: sql<string[]>`array(select distinct ${st.data}->>'name' from ${st}
        where ${st.runId} = agent_runs.id and ${st.kind} = 'tool_call' limit 200)`,
    })
    .from(r)
    .where(
      and(
        eq(r.orgId, run.orgId),
        eq(r.agentId, run.agentId),
        eq(r.channelId, run.channelId),
        replyThreadOf(run) ? eq(r.threadRootId, run.threadRootId) : inChannelRun(sql`${r}`),
        ne(r.id, run.id),
      ),
    )
    .orderBy(desc(r.createdAt))
    .limit(1);
  if (!row) return null;
  const { toolGroups, autoModel } = row.transcript ?? {};
  const groups = Array.isArray(toolGroups) ? toolGroups.filter((g): g is string => typeof g === "string") : null;
  const auto = autoModel && typeof autoModel === "object" ? (autoModel as PreviousRun["autoModel"]) : null;
  return { id: row.id, updatedAt: row.updatedAt, toolGroups: groups, autoModel: auto, calledTools: row.calledTools };
}

/** How long a run keeps every group the previous run listed: the prompt cache's longest life (`cacheTtl` 1h). */
export const KEEP_LOADED_MS = 60 * 60_000;
