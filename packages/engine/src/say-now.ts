import type { PubSub } from "@agenteschat/adapters";
import { and, type Executor, eq, gte, schema, sql } from "@agenteschat/db";
import { threadIsConfidential } from "./confidential";
import { publishMessageCreated } from "./events";
import { insertMessage, messageView } from "./messages";
import { runReadOutside } from "./outside";
import { endsWithSentinel, isSentinelOnly } from "./reply-policy";
import { personAmong } from "./run-inbox";
import { type AgentRun, isTerminal, replyThreadOf } from "./runs";
import { runStretchOf } from "./stretch";
import { maskCredentials, scrubSignIns } from "./tool-detail";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";
import { withWikiLinks } from "./wiki-links";
import { movableRun } from "./works";

const { agentRuns, messages } = schema;

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
 * Where the line may go: a person's run, in a conversation people read as it goes (a channel or a DM; not an agents'
 * DM, a mission's thread, background work, a routine's run or a confidential thread). Elsewhere the tool refuses with
 * the reason, and the prompt doesn't speak of it.
 */
export async function sayNowApplies(db: Executor, run: AgentRun, confidential?: boolean) {
  if (run.background || run.workId) return false;
  // Known to the run already (`sealedAtClaim`): no read of the thread's row on its way to the model.
  if (confidential ?? (await threadIsConfidential(db, run.orgId, run.threadRootId))) return false;
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
const NOT_FOR_PEOPLE =
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
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, ctx.runId), eq(agentRuns.orgId, ctx.orgId), eq(agentRuns.agentId, ctx.agentId)));
  return run ?? null;
}

type LinesRun = Pick<AgentRun, "id" | "orgId" | "channelId" | "agentId" | "createdAt">;

/**
 * The lines this run posted on the way (`meta.sayNow.runId`), oldest first: the conversation's record, for the paths
 * that post what a run wrote before its transcript took in a computer turn's lines (a stop, a cut turn, a restart).
 */
export async function linesSaid(db: Executor, run: LinesRun, limit = 5): Promise<{ text: string }[]> {
  const rows = await db
    .select({ body: messages.body })
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
  return rows.map((r) => ({ text: r.body }));
}

/**
 * `say_now` (ADR 0207): one short line to the person, posted at once in the conversation the run answers, before work
 * that takes a while ("Bora! Vou abrir o navegador e já te mando."). Listed in every run with an id but background ones
 * (the run policy keeps it from a routine's, `HERE`), so the tool list stays the same from run to run; where it doesn't
 * apply it refuses with the reason. Once per run: a second call answers what was said. The line is the agent's own
 * message with no run of its own (`runId` null, `meta.sayNow`), like the fast reply's: it is never the reply, the run
 * still owes its answer (`answerOwed`), it notifies nobody, routes to nobody, and the working row stays up.
 */
export function createSayNowToolSource(deps: { pubsub?: PubSub }): ToolSource {
  const tool: ToolDefinition = {
    name: SAY_NOW_TOOL,
    description:
      'Posts one short line in this conversation at once, before work that takes a while: what you\'ll do, in their language ("Bora! Vou abrir o navegador e já te mando."). Never a result, a time, a question or a request for a key: your final message brings the result.',
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
        const [before] = await linesSaid(tx, locked, 1);
        if (before) return { kind: "already", body: before.text } as const;
        // A person wrote since the run last read: the line would answer a conversation that has moved on.
        if (await personAmong(tx, locked.orgId, locked.pendingMessageIds)) return { kind: "wroteAgain" } as const;
        const message = await insertMessage(tx, {
          orgId: locked.orgId,
          channelId: locked.channelId,
          threadId: replyThreadOf({ ...locked, confidential: ctx.confidential }),
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
          meta: { sayNow: { runId: locked.id }, ...((await runReadOutside(tx, locked)) ? { readOutside: true } : {}) },
        });
        // It promised something: the run can't end quiet now (`pass`, the quiet end read this on the row).
        await tx
          .update(agentRuns)
          .set({ transcript: sql`coalesce(${agentRuns.transcript}, '{}'::jsonb) || '{"answerOwed":true}'::jsonb` })
          .where(eq(agentRuns.id, locked.id));
        return { kind: "posted", message } as const;
      });
      if (outcome.kind === "ended") return refused(REFUSED.ended);
      if (outcome.kind === "wroteAgain") return refused(REFUSED.wroteAgain, false);
      if (outcome.kind === "already")
        return {
          content: `Already told them: "${outcome.body}". Do the work now; your final message brings the result.`,
        };
      const [view] = await withWikiLinks(ctx.db, run.orgId, [messageView(outcome.message)]);
      if (view && deps.pubsub) await publishMessageCreated(deps.pubsub, view);
      return {
        content: "Posted. Do the work now; your final message brings the result, without repeating this line.",
        data: { saidNow: { text, messageId: outcome.message.id } },
      };
    },
  };
  return {
    name: "say-now",
    async tools(ctx) {
      // The same list in every run but a background one: where it doesn't apply, it says why.
      return ctx.runId && !ctx.background ? [tool] : [];
    },
  };
}

/** A sentence's words as they compare: lower case, no accents, no punctuation or emoji. */
const wordsOf = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * A reply without what it already told them on the way (`say_now`): models often write the line again as the first
 * words of the turn that called it, or open their final message with it. The leading sentences go when together they
 * repeat a line already said, word for word in its order (ignoring case, accents, punctuation and emoji), and are three
 * words or more or the whole line: "Passaram." after "I'll tell you if they passed" is an answer, not a repeat. Only
 * finished sentences (a heading that runs into a list stays), and never the whole reply unless it is a whole line.
 */
export function withoutSaidNow(text: string, said: readonly Pick<SaidNow, "text">[] | undefined): string {
  if (!said?.length || !text.trim()) return text;
  const lines = said.map((s) => wordsOf(s.text)).filter(Boolean);
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
    const sentence = wordsOf(match[1] ?? "");
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
