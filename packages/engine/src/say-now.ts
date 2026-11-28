import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, gte, schema, sql } from "@agenteschat/db";
import { runAuthority } from "./authority";
import { threadIsConfidential } from "./confidential";
import { getChannelCached } from "./context";
import { inAgentOnlyDm } from "./dms";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { plainWords } from "./format";
import { insertMessage, messageView } from "./messages";
import { missionOfThread } from "./missions";
import { runReadOutside } from "./outside";
import { endsWithSentinel, isSentinelOnly } from "./reply-policy";
import { personAmong } from "./run-inbox";
import { type RunRow, runColumns } from "./run-state";
import { type AgentRun, isTerminal, replyThreadOf } from "./runs";
import { runStretchOf } from "./stretch";
import { maskCredentials, scrubSignIns } from "./tool-detail";
import { listsEveryTool } from "./tools/directory";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";
import { openTurnThread } from "./turn-thread";
import { withWikiLinks } from "./wiki-links";
import { movableRun, workTopic } from "./works";

const { agentRuns, agentRunSteps, messages } = schema;

/**
 * Before work that takes a while, the agent tells the person in one short line what it will do, at once, in the
 * conversation it answers (ADR 0207). The only words of a run that reach the chat before its reply.
 */
export const SAY_NOW_TOOL = "say_now";

/** The line is short: one sentence or two, never a report. */
export const SAY_NOW_MAX = 200;

/** A call of `say_now`, by its name as a computer brain's bridge or the gateway records it. */
export const isSayNow = (name: string) => name === SAY_NOW_TOOL || name.endsWith(`__${SAY_NOW_TOOL}`);

/** What a run told them on the way (`Transcript.saidNow`): the line, its message, and its assistant turn (model loop). */
export interface SaidNow {
  text: string;
  messageId: string;
  /** The transcript's assistant message that called it: what the model wrote up to it was said, never the reply. */
  at?: number;
}

/**
 * Where the line may go: a person's run, in a conversation people read as it goes (a channel, a DM or a code session;
 * a task's or a file's conversation when a person wrote the message the run answers, addendum of 2026-11-24; not an
 * agents' DM, a mission's thread, background work, a routine's run or a confidential thread). Elsewhere the tool
 * refuses with the reason, and the prompt doesn't speak of it.
 */
export async function sayNowApplies(db: Executor, run: RunRow, confidential?: boolean) {
  if (run.background || run.workId) return false;
  // Known to the run already (`sealedAtClaim`): no read of the thread's row on its way to the model.
  if (confidential ?? (await threadIsConfidential(db, run.orgId, run.threadRootId))) return false;
  // A code session (ADR 0215) is read as it goes, though its runs never move to the background.
  const channel = await getChannelCached(db as Database, run.orgId, run.channelId);
  if (channel?.kind === "code") return (await runAuthority(db, run)).kind === "person";
  // A task's or a file's conversation never moves its work elsewhere (`movableRun`), but the person who wrote there
  // reads it as it goes. Work an agent was handed there (a delegate's) has no reader: its trigger is no person's.
  if (channel?.kind === "task" || channel?.kind === "file") {
    const [trigger] = await db
      .select({ authorType: messages.authorType })
      .from(messages)
      .where(and(eq(messages.orgId, run.orgId), eq(messages.id, run.triggerMessageId)))
      .limit(1);
    if (trigger?.authorType !== "person") return false;
    const thread = replyThreadOf(run);
    if (thread && (await missionOfThread(db, run.orgId, thread))) return false;
    return (await runAuthority(db, run)).kind === "person";
  }
  return movableRun(db, run);
}

/** The words people read, as the line goes out: one line, no secret, no mention, cut to `SAY_NOW_MAX`. */
export function sayNowText(raw: unknown): string {
  const line = maskCredentials(typeof raw === "string" ? raw : "")
    .replace(/\s+/g, " ")
    // An @ before a name would mention someone (accented names too): the line wakes nobody.
    .replace(/(^|[^\p{L}\p{N}_@.])@(?=[\p{L}\p{N}])/gu, "$1")
    .trim();
  return line.length > SAY_NOW_MAX ? `${line.slice(0, SAY_NOW_MAX - 1).trimEnd()}…` : line;
}

/** What a line for a person never holds: code-ish names (a tool, a function), a file path on a computer, backticks. */
export const NOT_FOR_PEOPLE =
  /`|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|(?:^|\s)(?:~\/|\/(?:Users|home|tmp|var|etc|opt)\/|[A-Za-z]:\\)/;

const REFUSED = {
  nobody:
    "Nobody reads this conversation as it goes (an agents' conversation, a mission's thread or a confidential one): just do the work and answer.",
  work: "This is background work: tell them with post_update.",
  ended: "This run already ended.",
  wroteAgain:
    "They wrote again before your line went out (you read it next): skip the line, read what they said and answer all of it in your final message.",
  words:
    "Not posted: write one short line for a person, in their language, saying what you'll do. No tool or function names, no file paths, no code.",
  empty: "Not posted: the line is empty.",
} as const;

const refused = (content: string, isError = true): ToolOutput => ({ content, isError });

/** The run the call comes from, as it is now (never a mission's task: those report to their mission). */
async function runOf(ctx: ToolContext) {
  if (!ctx.runId || ctx.background || ctx.bridge?.taskId) return null;
  const [run] = await ctx.db
    .select(runColumns)
    .from(agentRuns)
    .where(and(eq(agentRuns.id, ctx.runId), eq(agentRuns.orgId, ctx.orgId), eq(agentRuns.agentId, ctx.agentId)));
  return run ?? null;
}

type LinesRun = Pick<AgentRun, "id" | "orgId" | "channelId" | "agentId" | "createdAt">;

/**
 * The lines this run posted on the way (`meta.sayNow.runId`), oldest first: the conversation's record, for the paths
 * that post what a run wrote before its transcript took in a computer turn's lines (a stop, a cut turn, a restart).
 * The default reads past every line a run may post (its first, `PROGRESS_MAX` progress lines, one per message taken
 * in), so a reply that repeats its newest line still has it left out.
 */
export async function linesSaid(
  db: Executor,
  run: LinesRun,
  limit = 20,
): Promise<{ text: string; took: string[]; at: Date; progress: boolean }[]> {
  const rows = await db
    .select({ body: messages.body, meta: messages.meta, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        // Bounded to the run's agent and time: the monthly partitions before the run aren't read.
        eq(messages.authorAgentId, run.agentId),
        gte(messages.createdAt, run.createdAt),
        sql`${messages.meta}->'sayNow'->>'runId' = ${run.id}`,
      ),
    )
    .orderBy(messages.createdAt)
    .limit(limit);
  return rows.map((r) => {
    const line = r.meta.sayNow as { took?: unknown; progress?: unknown } | undefined;
    const took = line?.took;
    return {
      text: r.body,
      took: Array.isArray(took) ? took.filter((id): id is string => typeof id === "string") : [],
      at: r.createdAt,
      progress: line?.progress === true,
    };
  });
}

/** Long work only: a progress line once the run has worked this long (addendum of 2026-11-24b). */
export const PROGRESS_AFTER_MS = 60_000;
/** At most one line in this long, whichever line came before. */
export const PROGRESS_GAP_MS = 75_000;
/** At most this many progress lines in a run, besides its first line and the ones for messages taken in. */
export const PROGRESS_MAX = 3;

/**
 * Whether a line now is a progress line the run may still post: it has worked `PROGRESS_AFTER_MS` in this stretch,
 * its last line went out `PROGRESS_GAP_MS` ago or more, and it posted fewer than `PROGRESS_MAX` of them.
 */
export function progressDue(
  run: Pick<AgentRun, "createdAt" | "startedAt" | "workingSince">,
  said: readonly { at: Date; progress: boolean }[],
  now: number,
): boolean {
  const since = (run.workingSince ?? run.startedAt ?? run.createdAt).getTime();
  const last = said.at(-1);
  return (
    now - since >= PROGRESS_AFTER_MS &&
    (!last || now - last.at.getTime() >= PROGRESS_GAP_MS) &&
    said.filter((line) => line.progress).length < PROGRESS_MAX
  );
}

/**
 * The messages the run may still answer with a line of its own (addendum of 2026-11-24): a person wrote while it
 * worked and the triage was sure the message corrects or adds to the task (`steerTriage.line` on the run's trail,
 * `steering.ts`), and no line took it yet (`meta.sayNow.took`). One line takes all that wait.
 */
async function linesOwed(db: Executor, run: LinesRun, said: { took: string[] }[]): Promise<string[]> {
  const steps = await db
    .select({ data: agentRunSteps.data })
    .from(agentRunSteps)
    .where(
      and(
        eq(agentRunSteps.runId, run.id),
        eq(agentRunSteps.kind, "context"),
        sql`${agentRunSteps.data}->'steerTriage'->'line' = 'true'::jsonb`,
      ),
    );
  const taken = new Set(said.flatMap((line) => line.took));
  const ids = steps.map((step) => (step.data.steerTriage as { messageId?: unknown } | undefined)?.messageId);
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && !taken.has(id)))];
}

/**
 * `say_now` (ADR 0207): one short line to the person, posted at once in the conversation the run answers, before work
 * that takes a while ("Bora! Vou abrir o navegador e já te mando."). Listed in every run with an id but background ones
 * (the run policy keeps it from a routine's, `HERE`), so the tool list stays the same from run to run; where it doesn't
 * apply it refuses with the reason. Once per run, and once more for each message a person sends meanwhile that corrects
 * or adds to the task (`linesOwed`); any other call answers what was said. The line is the agent's own
 * message with no run of its own (`runId` null, `meta.sayNow`), like the fast reply's: it is never the reply, the run
 * still owes its answer (`answerOwed`), it notifies nobody, routes to nobody, and the working row stays up.
 */
export function createSayNowToolSource(deps: { pubsub?: PubSub }): ToolSource {
  const tool: ToolDefinition = {
    name: SAY_NOW_TOOL,
    description:
      'Posts one short line in this conversation at once, before work that takes a while: what you\'ll do, in their language ("Bora! Vou abrir o navegador e já te mando."). Once more if they correct or add to the task while you work. Never a result, a time, a question or a request for a key: your final message brings the result.',
    scope: "",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", minLength: 1, maxLength: SAY_NOW_MAX } },
      required: ["text"],
      additionalProperties: false,
    },
    describe: () => ({ title: "Tell them what's next" }),
    async execute(input, ctx) {
      const raw = (input as { text?: unknown }).text;
      const text = sayNowText(raw);
      if (!text) return refused(REFUSED.empty);
      // A sign-in or a key is never a line for people (ADR 0137 §4), even masked.
      const signIn = typeof raw === "string" && scrubSignIns(raw, "").found > 0;
      if (signIn || isSentinelOnly(text) || endsWithSentinel(text) || NOT_FOR_PEOPLE.test(text))
        return refused(REFUSED.words);
      const run = await runOf(ctx);
      if (!run || run.background) return refused(REFUSED.nobody);
      if (run.workId) return refused(REFUSED.work);
      if (!(await sayNowApplies(ctx.db, run))) return refused(REFUSED.nobody);
      const outcome = await ctx.db.transaction(async (tx) => {
        // Under the run's lock: two calls at once post one line.
        const [locked] = await tx.select().from(agentRuns).where(eq(agentRuns.id, run.id)).for("update");
        if (!locked || isTerminal(locked.status)) return { kind: "ended" } as const;
        const said = await linesSaid(tx, locked, 50);
        // Messages they sent meanwhile that it takes in with this line (one more line for them, then none).
        const took = await linesOwed(tx, locked, said);
        const before = said.at(-1);
        // Long work may say how it goes, now and then (`progressDue`); otherwise the first line stands.
        const progress = Boolean(before) && took.length === 0 && progressDue(locked, said, Date.now());
        if (before && took.length === 0 && !progress) return { kind: "already", body: before.text } as const;
        // A person wrote since the run last read: the line would answer a conversation that has moved on.
        if (await personAmong(tx, locked.orgId, locked.pendingMessageIds)) return { kind: "wroteAgain" } as const;
        const threadId = replyThreadOf({ ...locked, confidential: ctx.confidential });
        const message = await insertMessage(tx, {
          orgId: locked.orgId,
          channelId: locked.channelId,
          threadId,
          author: {
            type: "agent",
            agentId: locked.agentId,
            runId: null,
            hop: locked.hop,
            stretchId: runStretchOf(locked),
            forRunId: locked.id,
          },
          body: text,
          // A run that read outside content passes the mark on (ADR 0117): the next agent reads the line as relayed.
          meta: {
            sayNow: { runId: locked.id, ...(took.length > 0 ? { took } : {}), ...(progress ? { progress: true } : {}) },
            ...((await runReadOutside(tx, locked)) ? { readOutside: true } : {}),
          },
        });
        // It promised something: the run can't end quiet now (`pass`, the quiet end read this on the row).
        await tx
          .update(agentRuns)
          .set({ transcript: sql`coalesce(${agentRuns.transcript}, '{}'::jsonb) || '{"answerOwed":true}'::jsonb` })
          .where(eq(agentRuns.id, locked.id));
        // Said in a channel's main timeline: the work it announces answers in this line's thread (ADR 0261).
        const opened = threadId === null && (await openTurnThread(tx, locked.id, message.id));
        return { kind: "posted", message, opened } as const;
      });
      if (outcome.kind === "ended") return refused(REFUSED.ended);
      if (outcome.kind === "wroteAgain") return refused(REFUSED.wroteAgain, false);
      if (outcome.kind === "already")
        return {
          content: `Already told them: "${outcome.body}". Do the work now; your final message brings the result. On long work, an update fits once a minute or so has passed.`,
        };
      const [view] = await withWikiLinks(ctx.db, run.orgId, [messageView(outcome.message)]);
      if (view && deps.pubsub) await publishMessageCreated(deps.pubsub, view);
      if (outcome.opened) {
        ctx.threadRootId = outcome.message.id;
        ctx.replyInThread = true;
        if (deps.pubsub) {
          // Live rows keep the place they started in: this one ends in the main timeline and starts over in the thread.
          const at = { channelId: run.channelId, agentId: run.agentId, runId: run.id };
          await publishChannelEvent(deps.pubsub, { type: "agent.idle", ...at, threadId: null });
          await publishChannelEvent(deps.pubsub, { type: "agent.thinking", ...at, threadId: outcome.message.id });
          // The executor holding the run, on this replica or another, answers there from now on (`adoptWork`).
          await deps.pubsub.publish(workTopic(run.id), { type: "run.moved", runId: run.id }).catch(() => {});
        }
      }
      return {
        content: "Posted. Do the work now; your final message brings the result, without repeating this line.",
        data: { saidNow: { text, messageId: outcome.message.id } },
      };
    },
  };
  return {
    name: "say-now",
    async tools(ctx) {
      // The same list in every run but a background one or one between agents: where it doesn't apply, it says why.
      return ctx.runId && !ctx.background && (listsEveryTool(ctx) || !(await inAgentOnlyDm(ctx))) ? [tool] : [];
    },
  };
}

/**
 * A reply without what it already told them on the way (`say_now`): models often write the line again as the first
 * words of the turn that called it, or open their final message with it. The leading sentences go when together they
 * repeat a line already said, word for word in its order (ignoring case, accents, punctuation and emoji), and are three
 * words or more or the whole line: "Passaram." after "I'll tell you if they passed" is an answer, not a repeat. Only
 * finished sentences (a heading that runs into a list stays), and never the whole reply unless it is a whole line.
 */
export function withoutSaidNow(text: string, said: readonly Pick<SaidNow, "text">[] | undefined): string {
  if (!said?.length || !text.trim()) return text;
  const lines = said.map((s) => plainWords(s.text)).filter(Boolean);
  if (lines.length === 0) return text;
  const start = text.trimStart();
  let rest = start;
  let words = "";
  let cut: string | null = null;
  for (;;) {
    const match = /^([^\n.!?…]*)([.!?…]+|\n)(\s*)/u.exec(rest);
    if (!match) break;
    // A heading that runs into a list ("Os voos mais baratos:") leads the answer: it never repeats the line.
    if (match[2] === "\n" && /:\s*$/.test(match[1] ?? "")) break;
    const sentence = plainWords(match[1] ?? "");
    rest = rest.slice(match[0].length);
    // Punctuation or emoji alone joins the sentences around it.
    if (!sentence) continue;
    words = words ? `${words} ${sentence}` : sentence;
    if (!lines.some((line) => ` ${line} `.includes(` ${words} `))) break;
    const whole = lines.includes(words);
    if (words.split(" ").length >= 3 || whole) cut = rest.trim() || whole ? rest : cut;
  }
  return cut === null ? text : cut.trimStart();
}
