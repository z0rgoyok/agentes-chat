import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { runAuthority } from "./authority";
import { requireChannelAccess } from "./channels";
import {
  type CodeSessionDeps,
  type CodeSessionView,
  createCodeSession,
  localProjectName,
  REQUEST_MAX_CHARS,
  sessionTitle,
  titleOfRequest,
  worksInSessions,
} from "./code-sessions";
import { getChannelCached } from "./context";
import { publishDelivery } from "./delivery";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { publishChannelEvent } from "./events";
import { agentRepositoryList, parseRepo, repoInList } from "./git/repos";
import { ownTyped } from "./message-origin";
import { getMessage, type Message } from "./messages";
import type { Notice } from "./notices";
import { deliverNoticeToRun } from "./run-resume";
import { runColumns } from "./run-state";
import type { AgentRun } from "./runs";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

const { agentRuns, messages, users } = schema;

/*
 * A code session suggested in the chat (ADR 0215 §11). When a person asks an agent that can have a session
 * (`worksInSessions`) to change code in a project, the agent suggests one instead of changing it in the conversation:
 * its reply carries the suggestion (`meta.codeSuggestion`), the person's card with "Abrir sessão" and "Fazer aqui". The
 * session opens with the person's own words as its first message, posted as them; "Fazer aqui" tells the agent to go
 * on in the conversation. Only the person who asked decides.
 */

export const SUGGEST_CODE_SESSION_TOOL = "suggest_code_session";

/** A call of the tool, by its name as a computer brain's bridge or the gateway records it. */
export const isSuggestCodeSession = (name: string) =>
  name === SUGGEST_CODE_SESSION_TOOL || name.endsWith(`__${SUGGEST_CODE_SESSION_TOOL}`);

/** Waiting for the person; being opened (a second click finds it taken); opened as a session; kept in the chat. */
export type CodeSuggestionStatus = "pending" | "opening" | "opened" | "here";

/** `meta.codeSuggestion` on the agent's reply. */
export interface CodeSuggestion {
  id: string;
  agentId: string;
  /** `owner/name` on GitHub, or a project's name on the agent's computer. */
  repo: string;
  title: string;
  /** What the session starts with: the words of the message the run answered. */
  request: string;
  requestMessageId: string;
  /** The person who asked: the one who decides. */
  askerId: string;
  status: CodeSuggestionStatus;
  sessionId?: string;
  /** Who decided, and when. */
  by?: string;
  at?: string;
}

const STATUSES: readonly CodeSuggestionStatus[] = ["pending", "opening", "opened", "here"];

export function codeSuggestionOf(meta: unknown): CodeSuggestion | null {
  const v = (meta as { codeSuggestion?: unknown } | null)?.codeSuggestion as Record<string, unknown> | undefined;
  if (!v || typeof v !== "object") return null;
  const text = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : "");
  const status = STATUSES.find((s) => s === v.status);
  if (!status || !text("id") || !text("agentId") || !text("repo") || !text("askerId") || !text("requestMessageId"))
    return null;
  return {
    id: text("id"),
    agentId: text("agentId"),
    repo: text("repo"),
    title: text("title"),
    request: text("request"),
    requestMessageId: text("requestMessageId"),
    askerId: text("askerId"),
    status,
    ...(text("sessionId") ? { sessionId: text("sessionId") } : {}),
    ...(text("by") ? { by: text("by") } : {}),
    ...(text("at") ? { at: text("at") } : {}),
  };
}

// ── The agent's tool ─────────────────────────────────────────────────────────

const PROJECT_MAX = 200;
const TITLE_MAX = 72;

const DESCRIPTION =
  "Suggests a code session to the person who asked, when their request changes code in a project (fix a bug, build or refactor something). A card under your reply lets them open it in Code, where you work in a copy of the project only for this change and they follow the diff and try it before it joins the main branch, or keep it here. Not for a question, an explanation or a quick look: answer those here. Give the project (`owner/name` on GitHub, or a project's name on your computer) and a short title in their language. Then say in one or two sentences why a session fits, and change nothing here until they choose.";

const REFUSED = {
  nobody: "Only a person's request in a conversation gets a session suggested: just answer.",
  inSession: "You are in a code session already: do the work here.",
  ownWork: "This is a task's or a mission's conversation, already the place for its work: do the change here.",
  notPerson:
    "The message you answer isn't a request a person typed in agentes.chat: suggest a session only when a person asks for a change here.",
  empty: "The message you answer has no words to start a session with: ask them what to change.",
  noComputer: "You can't work on a computer, so there's no session to suggest: just answer.",
  project:
    "Not suggested: give the project as `owner/name` of a GitHub repository you may use, or a short name (letters, digits, dots, dashes, underscores) for a project on your computer.",
  notAllowed: (repo: string) =>
    `Not suggested: you can't work in ${repo}. Name one of your repositories, or tell them a person can add it on your page.`,
} as const;

const refused = (content: string): ToolOutput => ({ content, isError: true });
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The run the call comes from, as it is now (never a background one, nor a mission's or a computer's task). */
async function runOf(ctx: ToolContext) {
  if (!ctx.runId || ctx.background || ctx.bridge?.taskId) return null;
  const [run] = await ctx.db
    .select(runColumns)
    .from(agentRuns)
    .where(and(eq(agentRuns.id, ctx.runId), eq(agentRuns.orgId, ctx.orgId), eq(agentRuns.agentId, ctx.agentId)));
  return run ?? null;
}

/**
 * Why no session is suggested where the run works, or null where one may be: a code session's own conversation, a
 * task's, or a mission's thread is already the place for that work (a mission has a worktree of its own).
 */
async function workPlace(
  db: Database,
  run: Pick<AgentRun, "orgId" | "channelId" | "threadRootId">,
): Promise<string | null> {
  const channel = await getChannelCached(db, run.orgId, run.channelId);
  if (!channel) return REFUSED.nobody;
  if (channel.kind === "code") return REFUSED.inSession;
  if (channel.kind === "task") return REFUSED.ownWork;
  if (!run.threadRootId) return null;
  const [mission] = await db
    .select({ id: schema.missions.id })
    .from(schema.missions)
    .where(and(eq(schema.missions.orgId, run.orgId), eq(schema.missions.threadRootId, run.threadRootId)))
    .limit(1);
  return mission ? REFUSED.ownWork : null;
}

/**
 * Whether the agent can suggest a session in this run: it programs on a computer, a person asked, and the conversation
 * isn't the place of some work already (`workPlace`). The prompt speaks of the tool only then.
 */
export async function codeSuggestionApplies(db: Database, run: AgentRun): Promise<boolean> {
  if (run.background || run.workId) return false;
  const agent = await getAgentCached(db, run.orgId, run.agentId);
  if (!agent || !(await worksInSessions(db, agent))) return false;
  if (await workPlace(db, run)) return false;
  return (await runAuthority(db, run)).kind === "person";
}

/**
 * `suggest_code_session`: listed for agents that program on a computer, in runs a person can answer (never a background
 * one); where it doesn't apply it refuses with the reason. What it suggests rides on the run's next reply
 * (`data.codeSuggestion`, `absorbToolData` → `meta.codeSuggestion`), checked now so the card never offers a session that
 * can't open.
 */
export function createCodeSuggestionToolSource(): ToolSource {
  const tool: ToolDefinition = {
    name: SUGGEST_CODE_SESSION_TOOL,
    description: DESCRIPTION,
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          minLength: 1,
          maxLength: PROJECT_MAX,
          description: "`owner/name` of the GitHub repository, or the name of a project on your computer",
        },
        title: {
          type: "string",
          minLength: 1,
          maxLength: TITLE_MAX,
          description: "A few words naming the change, in their language",
        },
      },
      required: ["project", "title"],
      additionalProperties: false,
    },
    describe: () => ({ title: "Suggest a code session" }),
    async execute(input, ctx) {
      // A run that moved itself to the background still answers the person's request: its report carries the card.
      const run = await runOf(ctx);
      if (!run) return refused(REFUSED.nobody);
      const elsewhere = await workPlace(ctx.db, run);
      if (elsewhere) return refused(elsewhere);
      if ((await runAuthority(ctx.db, run)).kind !== "person") return refused(REFUSED.nobody);
      const agent = await getAgentCached(ctx.db, run.orgId, run.agentId);
      if (!agent || !(await worksInSessions(ctx.db, agent))) return refused(REFUSED.noComputer);
      const asked = await getMessage(ctx.db, run.orgId, run.triggerMessageId);
      // Only a request the person typed in our apps opens a coding session (ADR 0250).
      if (!asked || !ownTyped(asked) || !asked.authorUserId) return refused(REFUSED.notPerson);
      const request = asked.body.trim().slice(0, REQUEST_MAX_CHARS);
      if (!request) return refused(REFUSED.empty);
      const raw = str((input as { project?: unknown }).project).trim();
      const parsed = parseRepo(raw);
      const local = parsed ? null : localProjectName(raw);
      if (!parsed && !local) return refused(REFUSED.project);
      const repo = parsed ? `${parsed.owner}/${parsed.repo}` : (local as string);
      if (parsed && !repoInList(await agentRepositoryList(ctx.db, run.orgId, agent.id), parsed.owner, parsed.repo))
        return refused(REFUSED.notAllowed(repo));
      const title = sessionTitle(str((input as { title?: unknown }).title)) || titleOfRequest(request);
      const suggestion: CodeSuggestion = {
        id: Bun.randomUUIDv7(),
        agentId: agent.id,
        repo,
        title,
        request,
        requestMessageId: asked.id,
        askerId: asked.authorUserId,
        status: "pending",
      };
      return {
        content: `Suggested: your reply carries a card to open a session on ${repo} ("${title}") or to keep it here. Say in one or two sentences why a session fits, and change nothing here until they choose: if they open it, the session starts with their words and you go on there; if they keep it here, you're told and do it here.`,
        data: { codeSuggestion: suggestion },
      };
    },
  };
  return {
    name: "code-suggestions",
    async tools(ctx) {
      if (!ctx.runId || ctx.background) return [];
      const agent = await getAgentCached(ctx.db, ctx.orgId, ctx.agentId);
      if (!agent || !(await worksInSessions(ctx.db, agent))) return [];
      // Not where the work has a place already (a task's or a mission's conversation): there it could only refuse.
      return (await workPlace(ctx.db, ctx)) ? [] : [tool];
    },
  };
}

// ── The person's decision ────────────────────────────────────────────────────

/** The suggestion on `messageId`, still waiting, for the person who asked (and can see its conversation). */
async function pendingFor(db: Database, userId: string, orgId: string, messageId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(messageId))
    throw new NotFoundError("Suggestion not found", "code_session.suggestion_gone");
  const message = await getMessage(db, orgId, messageId);
  const suggestion = message ? codeSuggestionOf(message.meta) : null;
  if (!message || !suggestion) throw new NotFoundError("Suggestion not found", "code_session.suggestion_gone");
  await requireChannelAccess(db, userId, orgId, message.channelId);
  if (suggestion.askerId !== userId)
    throw new ForbiddenError("Only who asked decides this suggestion", "code_session.suggestion_not_yours");
  if (suggestion.status !== "pending")
    throw new ConflictError("This suggestion was answered already", "code_session.suggestion_gone");
  return { message, suggestion };
}

/** Moves the suggestion on `message` from `from` to `patch`, or nothing when it isn't `from` any more. */
async function setSuggestion(
  db: Database,
  message: Message,
  from: CodeSuggestionStatus,
  patch: Partial<Record<keyof CodeSuggestion, string | null>>,
): Promise<CodeSuggestion | null> {
  const [row] = await db
    .update(messages)
    .set({
      meta: sql`jsonb_set(${messages.meta}, '{codeSuggestion}', (${messages.meta}->'codeSuggestion') || ${JSON.stringify(patch)}::jsonb)`,
    })
    .where(
      and(
        eq(messages.id, message.id),
        eq(messages.orgId, message.orgId),
        eq(messages.channelId, message.channelId),
        sql`${messages.meta}->'codeSuggestion'->>'status' = ${from}`,
      ),
    )
    .returning({ meta: messages.meta });
  return row ? codeSuggestionOf(row.meta) : null;
}

async function announce(pubsub: PubSub | undefined, message: Message, suggestion: CodeSuggestion) {
  if (!pubsub) return;
  await publishChannelEvent(pubsub, {
    type: "code.suggestion",
    channelId: message.channelId,
    threadId: message.threadId,
    messageId: message.id,
    suggestion,
  });
}

/** The run that suggested it, told what the person chose (`proposal_result`: only the agent reads it, the card says it). */
async function tellAgent(
  deps: { db: Database; pubsub?: PubSub },
  message: Message,
  notice: Notice,
  options: { wake: boolean },
) {
  if (!message.agentRunId) return;
  const [run] = await deps.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, message.orgId), eq(agentRuns.id, message.agentRunId)));
  if (!run) return;
  const delivered = await deps.db.transaction((tx) => deliverNoticeToRun(tx, run, notice, options));
  await publishDelivery(deps.pubsub, delivered).catch(() => {});
}

const nameOf = async (db: Database, userId: string) =>
  (await db.select({ name: users.name }).from(users).where(eq(users.id, userId)))[0]?.name ?? "The person";

/**
 * "Abrir sessão": the session, made by the person who asked with their own words as its first message and the
 * suggestion's title, and the way back to this conversation. Taken first (`opening`), so a second click opens nothing;
 * a session that can't open leaves the suggestion waiting again, and the error says why.
 */
export async function openCodeSuggestion(
  deps: CodeSessionDeps & { postRequest: (channelId: string, rootId: string, text: string) => Promise<unknown> },
  userId: string,
  orgId: string,
  messageId: string,
): Promise<CodeSessionView> {
  const { message, suggestion } = await pendingFor(deps.db, userId, orgId, messageId);
  const at = new Date().toISOString();
  const taken = await setSuggestion(deps.db, message, "pending", { status: "opening", by: userId, at });
  if (!taken) throw new ConflictError("This suggestion was answered already", "code_session.suggestion_gone");
  let session: CodeSessionView;
  try {
    session = await createCodeSession(deps, userId, orgId, {
      agentId: suggestion.agentId,
      repo: suggestion.repo,
      text: suggestion.request,
      title: suggestion.title,
      from: { channelId: message.channelId, messageId: message.id, threadId: message.threadId },
    });
  } catch (error) {
    const back = await setSuggestion(deps.db, message, "opening", { status: "pending", by: null, at: null });
    if (back) await announce(deps.pubsub, message, back);
    throw error;
  }
  const opened = await setSuggestion(deps.db, message, "opening", { status: "opened", sessionId: session.id });
  if (opened) await announce(deps.pubsub, message, opened);
  await tellAgent(
    deps,
    message,
    {
      kind: "proposal_result",
      from: `Your suggestion of a code session «${suggestion.title}»`,
      text: `${await nameOf(deps.db, userId)} opened it: you work on it in that session now, not here.`,
      refs: { messageId: message.id, ...(message.agentRunId ? { runId: message.agentRunId } : {}) },
    },
    // Its work starts in the session (the request goes there); nothing runs here.
    { wake: false },
  );
  return session;
}

/** "Fazer aqui": the agent goes on in this conversation, told so; the card says who chose it. */
export async function keepCodeSuggestionHere(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  messageId: string,
): Promise<CodeSuggestion> {
  const { message, suggestion } = await pendingFor(deps.db, userId, orgId, messageId);
  const kept = await setSuggestion(deps.db, message, "pending", {
    status: "here",
    by: userId,
    at: new Date().toISOString(),
  });
  if (!kept) throw new ConflictError("This suggestion was answered already", "code_session.suggestion_gone");
  await announce(deps.pubsub, message, kept);
  await tellAgent(
    deps,
    message,
    {
      kind: "proposal_result",
      from: `Your suggestion of a code session «${suggestion.title}»`,
      text: `${await nameOf(deps.db, userId)} chose to keep it here: make the change in this conversation.`,
      refs: { messageId: message.id, ...(message.agentRunId ? { runId: message.agentRunId } : {}) },
    },
    { wake: true },
  );
  return kept;
}
