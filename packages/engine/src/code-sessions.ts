import {
  type AgentScope,
  gitCheckoutDir,
  MISSION_WORKTREE_PROTOCOL,
  type PubSub,
  parseMissionWorktreeEnsured,
} from "@agenteschat/adapters";
import {
  and,
  type Database,
  desc,
  type Executor,
  eq,
  inArray,
  isNotNull,
  isNull,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { audienceError, audienceSql, canTalkTo, REACH_COLUMNS, type Speaker, speakerOf } from "./audience";
import { isComputerBrain } from "./brains/types";
import { caches } from "./cache";
import { requireChannelAccess } from "./channels";
import { createAgentRuns } from "./dispatch";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishUserEvent } from "./events";
import { cutTextEnd, trimEdges } from "./format";
import { cloneOnMachine, type MachineGitDeps } from "./git/machine";
import { agentRepositoryList, parseRepo, repoInList } from "./git/repos";
import { type MachineCaller, MachineRequestError } from "./machine-hub";
import { MachineOfflineError, MachinePausedError } from "./machines";
import { getMessage } from "./messages";
import { branchSlug } from "./mission-worktree";
import { can, getMembership } from "./organizations";
import { codeRunning } from "./sandbox";
import { withoutTrailingSlashes } from "./url-text";

/*
 * Code sessions (ADR 0215): a request worked on in its own git worktree on the agent's computer. The session's
 * conversation is a thread in a channel of kind `code` (the task conversation's model, ADR 0145): runs, steering,
 * stop, approvals, live events and the thread screens work unchanged. Its agent answers there like in a DM, pinned
 * to the session's computer and worktree like a mission's main session (`codeSessionContext`): a computer brain gets
 * them as its session's machine and folder, the engine's own tools work there too.
 */

const { codeSessions, channels, channelMembers, messages, agentRuns, notifications } = schema;

export type CodeSessionRow = typeof codeSessions.$inferSelect;
export const CODE_WORKTREE_STATES = ["preparing", "ready", "failed", "removed"] as const;
export type CodeWorktreeState = (typeof CODE_WORKTREE_STATES)[number];
export const codeWorktreeStateOf = (v: unknown): CodeWorktreeState =>
  typeof v === "string" && (CODE_WORKTREE_STATES as readonly string[]).includes(v)
    ? (v as CodeWorktreeState)
    : "failed";

/**
 * Whether an agent can have a session: a computer for the worktree, and a way to work in its folder there. A computer
 * brain brings its own shell; an agent that thinks through the API works with its code tools, so it needs to be
 * allowed to run code (`codeRunning`).
 */
export async function worksInSessions(
  db: Database,
  agent: { id: string; orgId: string; brain: string; machineId: string | null },
): Promise<boolean> {
  if (!agent.machineId) return false;
  if (isComputerBrain(agent.brain)) return true;
  return (await codeRunning(db, agent.orgId, agent.id)).refused === null;
}

export { CODE_SESSION_HIDDEN_TOOLS } from "./code-session-tools";

/** `ensure` copies `.env*` files and may prune: more than a plain request (as for a mission). */
const ENSURE_TIMEOUT_MS = 120_000;
/** A clone still running on the computer is asked again this often, this many times. */
const CLONE_RETRY_MS = 15_000;
const CLONE_RETRIES = 40;
/**
 * A git command for the panel (diff, status) never runs longer than this on the computer, and the computer answers
 * within `GIT_READ_ANSWER_MS`: both under the apps' own wait for a read (`READ_TIMEOUT_MS`, 30 s), so a computer busy
 * with its agent's work is said to be slow (`machine.timeout`) instead of the server reading as unreachable.
 */
const GIT_READ_SECONDS = 20;
const GIT_READ_ANSWER_MS = 25_000;
/** A read the computer cut at `GIT_READ_SECONDS`: the same words as one it never answered. */
const slowRead = () => new MachineRequestError("timeout", `the computer did not answer within ${GIT_READ_SECONDS} s`);
/** The diff the panel reads: past this, the files are listed without their patch. */
const DIFF_MAX_CHARS = 1_500_000;
/** What a failed worktree keeps of the reason. */
const ERROR_CHARS = 2_000;
/** The request: as long as a chat message may be. */
export const REQUEST_MAX_CHARS = 20_000;
/** A session's name: what fits a row of the list. */
const TITLE_MAX_CHARS = 72;

export interface CodeSessionDeps {
  db: Database;
  pubsub?: PubSub;
  /** Connected computers: makes the worktree and reads git there. */
  hub?: MachineCaller | null;
  /** Our public URL and secret, for the git proxy the clone goes through (`machineGitSetup`). */
  git?: MachineGitDeps["git"] | null;
  /** Our GitHub App, for fetching straight from GitHub where it is installed. */
  github?: MachineGitDeps["github"];
  log?: { warn(message: string, data?: Record<string, unknown>): void };
}

/** The conversation a session was opened from (a suggestion in it, ADR 0215 §11): its message, for the way back. */
export interface CodeSessionFrom {
  channelId: string;
  messageId: string;
  threadId: string | null;
}

/** The root message's `meta.codeSession`: never drawn, never routed. */
export interface CodeSessionMeta {
  sessionId: string;
  repo: string;
  title: string;
  from?: CodeSessionFrom;
}

const fromOf = (v: unknown): CodeSessionFrom | undefined => {
  const f = v as Partial<CodeSessionFrom> | null | undefined;
  return f && typeof f.channelId === "string" && typeof f.messageId === "string"
    ? { channelId: f.channelId, messageId: f.messageId, threadId: typeof f.threadId === "string" ? f.threadId : null }
    : undefined;
};

export function codeSessionOf(meta: unknown): CodeSessionMeta | null {
  const v = (meta as { codeSession?: unknown } | null)?.codeSession as Partial<CodeSessionMeta> | undefined;
  if (!v || typeof v.sessionId !== "string" || typeof v.repo !== "string") return null;
  const from = fromOf(v.from);
  return {
    sessionId: v.sessionId,
    repo: v.repo,
    title: typeof v.title === "string" ? v.title : "",
    ...(from ? { from } : {}),
  };
}

/** A name someone gave a session (an agent's suggestion): one line, cut at a word to fit the list's row. */
export function sessionTitle(raw: string | undefined): string {
  const line = (raw ?? "").replace(/\s+/g, " ").trim();
  if (line.length <= TITLE_MAX_CHARS) return line;
  const cut = line.slice(0, TITLE_MAX_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}

const shortId = (id: string) => id.replace(/-/g, "").slice(-8);

/**
 * A project only on the agent's computer, with no remote yet (ADR 0215): named like a folder (letters, digits, dots,
 * dashes, underscores, not starting with a dot), it lives in `projects/<name>` in the agent's folder, a git repository
 * of its own made on first use. A session on it has `repo` = that name (no slash), so `isLocalSession` tells it apart
 * from a GitHub repository's (`owner/name`).
 */
export const LOCAL_PROJECTS_DIR = "projects";
const LOCAL_NAME = /^(?!\.)[A-Za-z0-9._-]{1,64}$/;
export const localProjectName = (input: string) => {
  const name = withoutTrailingSlashes(input.trim());
  return LOCAL_NAME.test(name) ? name : null;
};
export const isLocalSession = (row: Pick<CodeSessionRow, "repo">) => !row.repo.includes("/");

/** The clone failed for want of GitHub access: stored as this code, said in the person's language by the apps. */
export const GITHUB_ACCESS_ERROR = "github_access";

/** The session's folder, relative to the agent's folder (`.worktrees/` stays out of git on the runner). */
export const codeWorktreePath = (sessionId: string) => `.worktrees/c-${shortId(sessionId)}`;

/**
 * `agentes/<handle>/<slug of the title>-<4 hex>`: under the agent's own prefix, the only new branches the git proxy
 * lets it push (`refRule`); the tail keeps two sessions with the same title apart.
 */
export const codeBranchName = (handle: string, title: string, sessionId: string) =>
  `agentes/${handle}/${branchSlug(title) || "work"}-${shortId(sessionId).slice(-4)}`;

const isStop = (c: string) => c === "." || c === "!" || c === "?";

/**
 * The session's name from the request: its first sentence of its first line, without a trailing period, capitalized,
 * at most 72 characters (cut at a word). People rename it.
 */
export function titleOfRequest(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  const sentence = trimEdges(/^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line, isStop, "end").trim();
  const clean = sentence.replace(/\s+/g, " ");
  const cut = clean.length > 72 ? `${clean.slice(0, 72).replace(/\s+\S*$/, "")}…` : clean;
  return cut ? cut.charAt(0).toLocaleUpperCase() + cut.slice(1) : "Code session";
}

/** The session's agent, for the chat's routing: what names nobody in the session is for it, once it can work. */
export const codeAgentSql = (channelId: SQL) =>
  sql`(select cs.agent_id from ${codeSessions} cs
    join ${schema.agents} ca on ca.id = cs.agent_id and ca.archived_at is null
    where cs.channel_id = ${channelId} and cs.archived_at is null and cs.worktree_state = 'ready' limit 1)`;

/**
 * Who a person names in a session's conversation joins it (ADR 0215): an agent of the workspace by its handle (so the
 * mention wakes it there), a person of the workspace too (they see and talk in the session from then on; what they
 * may do on the computer stays the computer's rule). Returns nothing; the members cache is dropped.
 */
export async function admitCodeMembers(db: Executor, orgId: string, channelId: string, handles: string[]) {
  const clean = [...new Set(handles.map((h) => h.toLowerCase()).filter((h) => /^[a-z0-9_.-]+$/.test(h)))];
  if (clean.length === 0) return;
  const list = `{${clean.join(",")}}`;
  const agents = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, orgId),
        isNull(schema.agents.archivedAt),
        isNull(schema.agents.deletedAt),
        sql`lower(${schema.agents.handle}) = any(${list}::text[])`,
      ),
    );
  if (agents.length > 0)
    await db
      .insert(channelMembers)
      .values(agents.map((a) => ({ orgId, channelId, agentId: a.id, autoReply: true })))
      .onConflictDoNothing();
  await db.execute(sql`insert into ${channelMembers} (org_id, channel_id, user_id)
    select om.org_id, ${channelId}::uuid, om.user_id from ${schema.organizationMembers} om
    where om.org_id = ${orgId}::uuid and lower(om.handle) = any(${list}::text[])
    on conflict do nothing`);
  caches.channelMembers.delete(`${orgId}:${channelId}`);
  // Each agent's list of conversations it sees (`readableChannelIds`), as every other way in drops it.
  for (const a of agents) caches.scopes.deletePrefix(`${orgId}:${a.id}:visible`);
}

/** The session whose conversation is `channelId`, if any (one per conversation: the org's unique index). */
export async function codeSessionOfChannel(
  db: Executor,
  orgId: string,
  channelId: string,
): Promise<CodeSessionRow | null> {
  const [row] = await db
    .select()
    .from(codeSessions)
    .where(and(eq(codeSessions.orgId, orgId), eq(codeSessions.channelId, channelId)))
    .limit(1);
  return row ?? null;
}

/** A run in a code session's conversation, as its tool context and its brain plan carry it. */
export interface CodeSessionContext {
  /**
   * Where the session works: its computer and its worktree (relative to the agent's folder, as the runner resolves
   * it), for the session's own agent while the worktree is ready on the computer the agent uses; null for an agent
   * called in (it works in its own folder) and while the session's own agent has no place (`unavailable`).
   */
  place: { machineId: string; cwd: string } | null;
  /**
   * Why the session's own agent has no place, for it to read: its turn on a computer and its tools that act there
   * refuse with these words, never working in its own folder instead.
   */
  unavailable?: string;
}

const PLACE_PREPARING =
  "This session's worktree is still being prepared on your computer: nothing can run or change yet.";
const PLACE_GONE =
  "This session's worktree is gone (the session was closed, or its worktree failed or was removed): nothing runs here any more. Tell the person; they can retry the session or open a new one.";
const PLACE_MOVED =
  "This session's worktree is on a computer you no longer use: nothing runs here. Tell the person; a new session works on your current computer.";

/**
 * Where an agent works in a session: the session's own agent in its worktree, while it is ready on the computer the
 * agent uses now (a session never sends work to a computer the agent left); anyone else in their own folder.
 */
function placeIn(row: CodeSessionRow, agent: { id: string; machineId: string | null }): CodeSessionContext {
  if (row.agentId !== agent.id) return { place: null };
  if (row.archivedAt || row.worktreeState === "failed" || row.worktreeState === "removed" || !row.worktreePath)
    return { place: null, unavailable: PLACE_GONE };
  if (row.worktreeState !== "ready") return { place: null, unavailable: PLACE_PREPARING };
  if (!row.machineId || row.machineId !== agent.machineId) return { place: null, unavailable: PLACE_MOVED };
  return { place: { machineId: row.machineId, cwd: row.worktreePath } };
}

/** The code session of a run in `channelId`, or null when the conversation isn't a session's. */
export async function codeSessionContext(
  db: Executor,
  orgId: string,
  channelId: string,
  agentId: string,
): Promise<CodeSessionContext | null> {
  const row = await codeSessionOfChannel(db, orgId, channelId);
  if (!row) return null;
  if (row.agentId !== agentId) return { place: null };
  const [agent] = await db
    .select({ id: schema.agents.id, machineId: schema.agents.machineId })
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.id, agentId)));
  return placeIn(row, agent ?? { id: agentId, machineId: null });
}

/**
 * What a run in the session reads about it (in its context, never shown): the repository, the branch and where it
 * started, the folder it works in, and how to work there. `first`: the session's first turn (the project may need
 * installing).
 */
export async function codeSessionBrief(
  db: Database,
  orgId: string,
  channelId: string,
  agentId: string,
  options: { first?: boolean } = {},
): Promise<string | null> {
  const row = await codeSessionOfChannel(db, orgId, channelId);
  if (!row || row.archivedAt) return null;
  const own = row.agentId === agentId;
  const local = isLocalSession(row);
  const lines = [
    "# This conversation: a code session",
    local
      ? `A person opened this session to work on the project "${row.repo}", a local git repository on your computer (\`${row.repoDir}\`, no remote): "${row.title}".`
      : `A person opened this session to work on ${row.repo}: "${row.title}".`,
  ];
  const at = own
    ? placeIn(
        row,
        (
          await db
            .select({ id: schema.agents.id, machineId: schema.agents.machineId })
            .from(schema.agents)
            .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.id, agentId)))
        )[0] ?? { id: agentId, machineId: null },
      )
    : null;
  if (at?.place) {
    lines.push(
      `You work in its own git worktree, on branch \`${row.branch ?? "?"}\`, made from \`${row.baseBranch ?? "the default branch"}\`${row.baseSha ? ` at ${row.baseSha.slice(0, 7)}` : ""}. That worktree is your working folder for this conversation: every relative path, in your commands and your file tools, is inside it.`,
      "Work like in a terminal with this person: read, change and run things in that folder, and say what you did in a few words. Don't touch other checkouts.",
      "If you hand work to helpers of your own (subagents, a workflow), keep it in this turn and answer once, with what they found: work left running in the background means a second answer later.",
      "Say what each command or tool call of yours is for in the person's language: each one is a line of your work they read.",
      "Your computer's screen is this session's preview: the person watches it beside the conversation. When what you made can be looked at (a page, an app, a UI), show it there yourself before you say it's done, without being asked: run the project's dev server, or serve the folder on localhost (for example `python3 -m http.server 8000`, left running in the background), open that address in your browser, look at it and fix what is off. The browser opens only http and https addresses, never a file. The person sees your screen and the diff: don't save copies to the Drive or paste screenshots.",
      local
        ? "Commit when a piece of work is done, with a short message. There is no remote: nothing to push."
        : "Commit when a piece of work is done, with a short message. Push and open a pull request only when the person asks.",
    );
    // A shell kept to its own folder by its CLI's sandbox can't write the repository's git data, which is beside the
    // worktree: the runner's own shell can (only named where the agent has it).
    if ((await codeRunning(db, orgId, agentId)).refused === null)
      lines.push(
        "If your own shell can't write the repository's git data from this folder (a sandbox that keeps it inside), commit with run_code, which runs here too.",
      );
    if (options.first && row.setupCommand)
      lines.push(`The worktree is new: install the project first if it needs it (\`${row.setupCommand}\`).`);
  } else if (at?.unavailable) {
    lines.push(at.unavailable);
  } else if (!own) {
    const team = await db
      .select({
        id: schema.agents.id,
        name: schema.agents.name,
        handle: schema.agents.handle,
        machineId: schema.agents.machineId,
      })
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, row.orgId), inArray(schema.agents.id, [row.agentId, agentId])));
    const lead = team.find((a) => a.id === row.agentId);
    const me = team.find((a) => a.id === agentId);
    const name = lead?.name ?? "The session's agent";
    lines.push(
      `${name} works in this session's worktree; you were called in to help (read, review, test). Don't change its files.`,
    );
    if (lead && row.worktreeState === "ready" && row.worktreePath)
      lines.push(
        me?.machineId && me.machineId === row.machineId
          ? `It is on your computer too, beside your folder: \`../${agentFolderOf(lead)}/${row.worktreePath}\` (branch \`${row.branch ?? "?"}\`). Read what you need there; if you can't, ask ${lead.name}.`
          : `It is on ${lead.name}'s computer, not yours: ask ${lead.name} for what you need to read.`,
      );
  }
  return lines.join("\n");
}

/**
 * An agent's folder's name on its computer, as the runner names it (`agentFolderName` in the runner's `paths.ts`):
 * `<handle>-<first 8 of its id>`. Agents of one workspace keep theirs side by side.
 */
export function agentFolderOf(agent: { id: string; handle: string }) {
  const slug = agent.handle.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const handle = trimEdges(slug, (c) => c === "-" || c === "_" || c === ".").slice(0, 40);
  return `${handle || "agent"}-${agent.id
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8)}`;
}

/** One session as the apps show it. */
export interface CodeSessionView {
  id: string;
  channelId: string;
  rootId: string;
  title: string;
  repo: string;
  branch: string | null;
  baseBranch: string | null;
  agentId: string;
  machineId: string | null;
  worktree: { state: CodeWorktreeState; error: string | null; errorCode: "github_access" | null };
  /** A project only on the agent's computer (no remote): no push, no pull request. */
  local: boolean;
  pr: { number: number; url: string | null } | null;
  stat: { files: number; added: number; removed: number; at: string | null };
  /** What it is doing now, for the list: preparing, failed, working (a live run), waiting (on this person), idle. */
  work: "preparing" | "failed" | "working" | "waiting" | "idle";
  createdBy: string | null;
  createdAt: string;
  lastAt: string;
  /** The conversation it was opened from (ADR 0215 §11), on the session's own page only, for whoever can see it. */
  from?: CodeSessionOrigin;
}

/** Where a session was opened from: "your conversation with Leo" (a DM) or "#general" (a channel's name). */
export interface CodeSessionOrigin extends CodeSessionFrom {
  kind: "dm" | "channel";
  name: string;
}

function viewOf(
  row: CodeSessionRow,
  facts: { working: boolean; waiting: boolean; lastAt: Date | null },
): CodeSessionView {
  const state = codeWorktreeStateOf(row.worktreeState);
  const work =
    state === "preparing"
      ? "preparing"
      : state === "failed"
        ? "failed"
        : facts.waiting
          ? "waiting"
          : facts.working
            ? "working"
            : "idle";
  return {
    id: row.id,
    channelId: row.channelId,
    rootId: row.rootMessageId,
    title: row.title,
    repo: row.repo,
    branch: row.branch,
    baseBranch: row.baseBranch,
    agentId: row.agentId,
    machineId: row.machineId,
    worktree:
      row.worktreeError === GITHUB_ACCESS_ERROR
        ? { state, error: null, errorCode: "github_access" }
        : { state, error: row.worktreeError, errorCode: null },
    local: isLocalSession(row),
    pr: row.prNumber ? { number: row.prNumber, url: row.prUrl } : null,
    stat: { files: row.files, added: row.added, removed: row.removed, at: row.statAt?.toISOString() ?? null },
    work,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    lastAt: (facts.lastAt ?? row.updatedAt).toISOString(),
  };
}

/** Live runs, what waits on `userId`, and the last message, for these sessions' conversations (one query each). */
async function factsFor(db: Executor, orgId: string, userId: string, rows: CodeSessionRow[]) {
  const ids = rows.map((r) => r.channelId);
  if (ids.length === 0) return new Map<string, { working: boolean; waiting: boolean; lastAt: Date | null }>();
  // Each conversation's newest message, read backwards from its end (`(channel_id, created_at)`), not all of it.
  const newest = db
    .select({ channelId: messages.channelId, at: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), sql`${messages.channelId} = s.id`, isNull(messages.deletedAt)))
    .orderBy(desc(messages.createdAt))
    .limit(1)
    .as("newest");
  const [live, waiting, last] = await Promise.all([
    db
      .selectDistinct({ channelId: agentRuns.channelId })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          inArray(agentRuns.channelId, ids),
          inArray(agentRuns.status, ["queued", "running", "waiting_approval"]),
        ),
      ),
    db
      .select({ channelId: sql<string>`${notifications.source}->>'channelId'` })
      .from(notifications)
      .where(
        and(
          eq(notifications.orgId, orgId),
          eq(notifications.userId, userId),
          eq(notifications.waiting, true),
          isNull(notifications.doneAt),
          sql`${notifications.source}->>'channelId' in (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        ),
      ),
    db
      .select({ channelId: newest.channelId, at: newest.at })
      .from(sql`unnest(${`{${ids.join(",")}}`}::uuid[]) as s(id)`)
      .crossJoinLateral(newest),
  ]);
  const liveSet = new Set(live.map((r) => r.channelId));
  const waitSet = new Set(waiting.map((r) => r.channelId));
  const lastBy = new Map(last.map((r) => [r.channelId, r.at]));
  return new Map(
    ids.map((id) => [id, { working: liveSet.has(id), waiting: waitSet.has(id), lastAt: lastBy.get(id) ?? null }]),
  );
}

async function requireMember(db: Executor, userId: string, orgId: string) {
  const membership = await getMembership(db, userId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  return membership;
}

/**
 * The sessions `userId` takes part in (a member of the conversation: who opened it and who was called in), newest
 * activity first, archived ones left out.
 */
export async function listCodeSessions(db: Database, userId: string, orgId: string): Promise<CodeSessionView[]> {
  await requireMember(db, userId, orgId);
  const rows = await db
    .select({ session: codeSessions })
    .from(codeSessions)
    .innerJoin(
      channelMembers,
      and(eq(channelMembers.channelId, codeSessions.channelId), eq(channelMembers.userId, userId)),
    )
    .where(and(eq(codeSessions.orgId, orgId), isNull(codeSessions.archivedAt)))
    .orderBy(desc(codeSessions.updatedAt))
    .limit(200);
  const sessions = rows.map((r) => r.session);
  const facts = await factsFor(db, orgId, userId, sessions);
  return sessions
    .map((s) => viewOf(s, facts.get(s.channelId) ?? { working: false, waiting: false, lastAt: null }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** One session, for whoever reads its conversation (the channel's own check, `requireChannelAccess`). */
export async function requireCodeSession(db: Database, userId: string, orgId: string, sessionId: string) {
  const [row] = await db
    .select()
    .from(codeSessions)
    .where(and(eq(codeSessions.id, sessionId), eq(codeSessions.orgId, orgId)))
    .limit(1);
  if (!row || row.archivedAt) throw new NotFoundError("Code session not found");
  await requireChannelAccess(db, userId, orgId, row.channelId);
  return row;
}

export async function getCodeSession(db: Database, userId: string, orgId: string, sessionId: string) {
  const row = await requireCodeSession(db, userId, orgId, sessionId);
  const facts = await factsFor(db, orgId, userId, [row]);
  const view = viewOf(row, facts.get(row.channelId) ?? { working: false, waiting: false, lastAt: null });
  const from = await originOf(db, userId, row);
  return from ? { ...view, from } : view;
}

/**
 * The conversation a session was opened from (its root's `meta.codeSession.from`, ADR 0215 §11), named the way the
 * apps say it, for whoever can open it: nothing for a person it isn't shared with.
 */
async function originOf(db: Database, userId: string, row: CodeSessionRow): Promise<CodeSessionOrigin | null> {
  const from = codeSessionOf((await getMessage(db, row.orgId, row.rootMessageId))?.meta)?.from;
  if (!from) return null;
  const channel = (await requireChannelAccess(db, userId, row.orgId, from.channelId).catch(() => null))?.channel;
  if (!channel) return null;
  if (channel.kind === "dm") {
    const agent = await getAgentCached(db, row.orgId, row.agentId);
    return { ...from, kind: "dm", name: agent?.name ?? "" };
  }
  return { ...from, kind: "channel", name: channel.name };
}

/** Tells the session's people its row changed (the list and the header refetch). */
async function announce(deps: Pick<CodeSessionDeps, "db" | "pubsub">, row: CodeSessionRow) {
  if (!deps.pubsub) return;
  const people = await deps.db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, row.channelId), sql`${channelMembers.userId} is not null`));
  for (const p of people) {
    if (p.userId)
      await publishUserEvent(deps.pubsub, row.orgId, p.userId, { type: "code_session.updated", sessionId: row.id });
  }
}

async function setSession(
  deps: Pick<CodeSessionDeps, "db" | "pubsub">,
  row: CodeSessionRow,
  patch: Partial<CodeSessionRow>,
) {
  const [fresh] = await deps.db
    .update(codeSessions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(codeSessions.id, row.id))
    .returning();
  const next = fresh ?? row;
  await announce(deps, next);
  return next;
}

export interface CreateCodeSessionInput {
  agentId: string;
  /** `owner/name` (or a GitHub URL). */
  repo: string;
  /** The request: the conversation's first message. */
  text: string;
  /** Its name, when someone gave one (an agent's suggestion); else the request's first sentence. */
  title?: string;
  /** The conversation it was opened from (a suggestion in it, ADR 0215 §11). */
  from?: CodeSessionFrom;
}

/**
 * Opens a session: its conversation (a `code` channel with the person and the agent as members, and the root), the
 * row, then the request as the first reply through the chat's own path. The worktree is made after (`prepare`); the
 * request waits for it (`codeAgentSql` reads only a ready session) and goes to the agent once it is ready.
 */
export async function createCodeSession(
  deps: CodeSessionDeps & { postRequest: (channelId: string, rootId: string, text: string) => Promise<unknown> },
  userId: string,
  orgId: string,
  input: CreateCodeSessionInput,
): Promise<CodeSessionView> {
  const membership = await requireMember(deps.db, userId, orgId);
  if (!can(membership, "post")) throw new ForbiddenError("You can't post in this workspace");
  const text = input.text.trim();
  if (!text) throw new ValidationError("Say what to do", "code_session.empty");
  if (text.length > REQUEST_MAX_CHARS) throw new ValidationError("The request is too long", "code_session.too_long");
  // A GitHub repository (`owner/name`, or its URL), else a local project's name on the agent's computer.
  const parsed = parseRepo(input.repo);
  const local = parsed ? null : localProjectName(input.repo);
  if (!parsed && !local)
    throw new ValidationError(
      "Give a GitHub repository (owner/name) or a name for a project on the computer",
      "code_session.bad_repo",
    );
  const repo = parsed ? `${parsed.owner}/${parsed.repo}` : (local as string);
  const agent = await getAgentCached(deps.db, orgId, input.agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  // A session is the agent's work for whoever opens it: only someone it answers opens one (`canTalkTo`).
  if (!canTalkTo(agent, userId, speakerOf(membership))) throw await audienceError(deps.db, agent);
  if (!agent.machineId)
    throw new ValidationError("This agent has no computer", "code_session.no_computer", { agent: agent.name });
  if (!(await worksInSessions(deps.db, agent)))
    throw new ValidationError("This agent can't code on its computer", "code_session.cannot_code", {
      agent: agent.name,
    });
  if (parsed && !repoInList(await agentRepositoryList(deps.db, orgId, agent.id), parsed.owner, parsed.repo))
    throw new ValidationError("This agent can't work in that repository", "code_session.repo_not_allowed", {
      agent: agent.name,
      repo,
    });

  const id = Bun.randomUUIDv7();
  const title = sessionTitle(input.title) || titleOfRequest(text);
  const row = await deps.db.transaction(async (tx) => {
    const [channel] = await tx
      .insert(channels)
      .values({
        orgId,
        // Internal (never listed): unique per workspace, readable in an agent's prompt.
        name: `code-${shortId(id)}`,
        kind: "code",
        visibility: "private",
        createdByUserId: userId,
      })
      .returning({ id: channels.id });
    if (!channel) throw new Error("channel insert returned nothing");
    // Written directly: the root is never shown, indexed, routed or notified.
    const [root] = await tx
      .insert(messages)
      .values({
        orgId,
        channelId: channel.id,
        authorType: "person",
        authorUserId: userId,
        body: `Code session: ${title}`.slice(0, 2_000),
        meta: {
          codeSession: {
            sessionId: id,
            repo,
            title,
            ...(input.from ? { from: input.from } : {}),
          } satisfies CodeSessionMeta,
        },
      })
      .returning({ id: messages.id });
    if (!root) throw new Error("root insert returned nothing");
    await tx.insert(channelMembers).values([
      { orgId, channelId: channel.id, userId },
      { orgId, channelId: channel.id, agentId: agent.id, autoReply: true },
    ]);
    const [session] = await tx
      .insert(codeSessions)
      .values({
        id,
        orgId,
        channelId: channel.id,
        rootMessageId: root.id,
        agentId: agent.id,
        machineId: agent.machineId,
        repo,
        repoDir: parsed ? gitCheckoutDir(repo) : `${LOCAL_PROJECTS_DIR}/${repo}`,
        title,
        branch: codeBranchName(agent.handle, title, id),
        worktreePath: codeWorktreePath(id),
        worktreeState: "preparing",
        createdBy: userId,
      })
      .returning();
    if (!session) throw new Error("session insert returned nothing");
    return session;
  });
  // The agent's list of conversations it sees (`readableChannelIds`) now has this one.
  caches.scopes.deletePrefix(`${orgId}:${row.agentId}:visible`);
  await deps.postRequest(row.channelId, row.rootMessageId, text);
  await announce(deps, row);
  // The worktree is made in the background: the conversation shows it preparing meanwhile.
  void prepareCodeSession(deps, row.id).catch((error) =>
    deps.log?.warn("code session prepare failed", { sessionId: row.id, error: String(error) }),
  );
  return getCodeSession(deps.db, userId, orgId, row.id);
}

/** Sessions being prepared in this process (a second call while one runs does nothing). */
const preparing = new Set<string>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Makes the session's worktree on the agent's computer: the repository's checkout first (`git.sync`, through our
 * proxy), then the worktree on the session's branch (`mission.worktree`, ADR 0044), then the request goes to the
 * agent. Offline, paused or a runner too old: nothing changes (tried again when the computer is back,
 * `ensureCodeSessionsOn`). Idempotent.
 */
export async function prepareCodeSession(deps: CodeSessionDeps, sessionId: string): Promise<CodeSessionRow | null> {
  if (preparing.has(sessionId)) return null;
  preparing.add(sessionId);
  try {
    return await prepare(deps, sessionId);
  } finally {
    preparing.delete(sessionId);
  }
}

async function prepare(deps: CodeSessionDeps, sessionId: string): Promise<CodeSessionRow | null> {
  const [found] = await deps.db.select().from(codeSessions).where(eq(codeSessions.id, sessionId)).limit(1);
  let row = found ?? null;
  if (!row || row.archivedAt || row.worktreeState === "ready" || row.worktreeState === "removed") return row;
  const hub = deps.hub;
  if (!hub || !row.machineId) return row;
  const machineId = row.machineId;
  const status = await hub.status(machineId).catch(() => null);
  if (!status?.online || status.orgId !== row.orgId || status.protocol < MISSION_WORKTREE_PROTOCOL) return row;
  const agent = await getAgentCached(deps.db, row.orgId, row.agentId);
  if (!agent) return row;
  const scope: AgentScope = { id: agent.id, handle: agent.handle };
  if (row.worktreeState === "failed")
    row = await setSession(deps, row, { worktreeState: "preparing", worktreeError: null });

  // The checkout, cloned or brought up to date (a clone may still be running: asked again for a while); a local
  // project is made on the computer instead, or adopted when its folder is there.
  let repoDir = row.repoDir;
  if (isLocalSession(row)) {
    const made = await ensureLocalProject(hub, machineId, row, scope, agent.name);
    if (made === "away") return row;
    if (made !== "ok") return failSession(deps, row, made);
  } else if (deps.git) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const synced = await cloneOnMachine(
          { db: deps.db, hub, git: deps.git, github: deps.github ?? null },
          { orgId: row.orgId, agentId: row.agentId, machineId, scope },
          { repo: row.repo, dir: row.repoDir },
        );
        repoDir = synced.dir || row.repoDir;
        if (synced.status !== "cloning") break;
      } catch (error) {
        if (error instanceof MachineOfflineError || error instanceof MachinePausedError) return row;
        const message = error instanceof Error ? error.message : String(error);
        // No GitHub here (not connected, or no git scope): said in the person's words, with the way out (a local project).
        return failSession(
          deps,
          row,
          /git access to GitHub|GitHub isn't connected/i.test(message) ? GITHUB_ACCESS_ERROR : message,
        );
      }
      if (attempt >= CLONE_RETRIES) return failSession(deps, row, "The repository took too long to clone.");
      await sleep(CLONE_RETRY_MS);
    }
  }

  let reply: unknown;
  try {
    reply = await hub.call<"mission.worktree">(
      machineId,
      {
        op: "mission.worktree",
        action: "ensure",
        repo: repoDir,
        path: row.worktreePath ?? codeWorktreePath(row.id),
        branch: row.branch ?? codeBranchName(agent.handle, row.title, row.id),
        ...(row.baseSha ? { baseSha: row.baseSha } : {}),
        agent: scope,
      },
      { timeoutMs: ENSURE_TIMEOUT_MS },
    );
  } catch (error) {
    const code = error instanceof MachineRequestError ? error.code : null;
    if (
      error instanceof MachineOfflineError ||
      error instanceof MachinePausedError ||
      code === "timeout" ||
      code === "canceled" ||
      code === "paused"
    )
      return row;
    const message = error instanceof Error ? error.message : String(error);
    return failSession(deps, row, code === "not_git" ? "The repository's folder isn't a git repository." : message);
  }
  const got = parseMissionWorktreeEnsured(reply);
  await ensureGitIdentity(hub, machineId, got?.path || row.worktreePath || codeWorktreePath(row.id), scope, agent.name);
  row = await setSession(deps, row, {
    repoDir,
    worktreePath: got?.path || row.worktreePath,
    branch: got?.branch || row.branch,
    baseBranch: row.baseBranch ?? got?.baseBranch ?? null,
    baseSha: row.baseSha ?? got?.baseSha ?? null,
    setupCommand: got?.setupCommand ?? null,
    worktreeState: "ready",
    worktreeError: null,
  });
  await releaseRequest(deps, row);
  return row;
}

/**
 * A local project's folder on the computer, as its agent: made with `git init` (its files, if the folder was there,
 * in a first commit) when it isn't a repository with a commit yet, so the session's worktree can start from it.
 * "ok", "away" (offline, paused) or why it failed.
 */
async function ensureLocalProject(
  hub: MachineCaller,
  machineId: string,
  row: CodeSessionRow,
  scope: AgentScope,
  agentName: string,
): Promise<"ok" | "away" | string> {
  const dir = shellQuote(row.repoDir);
  const who = `-c user.name=${shellQuote(agentName)} -c user.email=${shellQuote(`${scope.handle}@agents.local`)}`;
  const command =
    `mkdir -p ${dir} && cd ${dir} && if ! git rev-parse --verify -q HEAD >/dev/null 2>&1; then ` +
    `(git init -q -b main 2>/dev/null || git init -q) && git add -A && ` +
    `git ${who} commit -q --allow-empty -m 'Start the project'; fi`;
  try {
    const out = await hub.call<"exec">(machineId, {
      op: "exec",
      command,
      timeoutSeconds: 60,
      stream: false,
      agent: scope,
    });
    return out.exitCode === 0 ? "ok" : out.stderr.trim() || "The project's folder couldn't be made.";
  } catch (error) {
    if (error instanceof MachineOfflineError || error instanceof MachinePausedError) return "away";
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The agent's name on its commits in the worktree, where the repository has none: the coding CLI commits with plain
 * `git commit`, which stops without one. Kept in the repository's own config (its worktrees share it); never fails
 * the session.
 */
async function ensureGitIdentity(
  hub: MachineCaller,
  machineId: string,
  worktree: string,
  scope: AgentScope,
  agentName: string,
) {
  const set = (key: string, value: string) =>
    `(git config ${key} >/dev/null 2>&1 || git config ${key} ${shellQuote(value)})`;
  const command = `cd ${shellQuote(worktree)} && ${set("user.name", agentName)} && ${set("user.email", `${scope.handle}@agents.local`)}`;
  await hub
    .call<"exec">(machineId, { op: "exec", command, timeoutSeconds: 30, stream: false, agent: scope })
    .catch(() => null);
}

async function failSession(deps: Pick<CodeSessionDeps, "db" | "pubsub">, row: CodeSessionRow, error: string) {
  return setSession(deps, row, { worktreeState: "failed", worktreeError: cutTextEnd(error, ERROR_CHARS) });
}

/**
 * A turn found the session's worktree missing on its computer (removed there behind our back): the session is failed
 * with that reason, so the person retries it, which makes the worktree again (`retryCodeSession`).
 */
export async function loseCodeWorktree(deps: Pick<CodeSessionDeps, "db" | "pubsub">, orgId: string, channelId: string) {
  const row = await codeSessionOfChannel(deps.db, orgId, channelId);
  if (!row || row.archivedAt || row.worktreeState !== "ready") return;
  await failSession(deps, row, "The worktree isn't on the computer any more.");
}

/**
 * Once the worktree is ready: the people's messages that waited for it go to the agent as one run (the newest
 * starts it; the run reads the thread). Only a message from someone the agent answers starts it (`audienceSql`, as a
 * message posted to a ready session). Nothing when a run already answered after them.
 */
export async function releaseRequest(deps: CodeSessionDeps, row: CodeSessionRow) {
  const [lastPerson] = await deps.db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .innerJoin(schema.agents, and(eq(schema.agents.orgId, row.orgId), eq(schema.agents.id, row.agentId)))
    .where(
      and(
        eq(messages.orgId, row.orgId),
        eq(messages.channelId, row.channelId),
        eq(messages.threadId, row.rootMessageId),
        eq(messages.authorType, "person"),
        isNull(messages.deletedAt),
        audienceSql("agents", sql`${messages.authorUserId}`, { channelId: sql`${row.channelId}::uuid` }),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (!lastPerson) return;
  const [answered] = await deps.db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, row.orgId),
        eq(agentRuns.channelId, row.channelId),
        eq(agentRuns.agentId, row.agentId),
        sql`${agentRuns.createdAt} >= ${lastPerson.createdAt}`,
      ),
    )
    .limit(1);
  if (answered) return;
  const message = await getMessage(deps.db, row.orgId, lastPerson.id);
  if (!message) return;
  const runs = await deps.db.transaction((tx) => createAgentRuns(tx, message, [row.agentId], "dm"));
  // The receipt of the message that waited: its agent has it now.
  if (runs.length > 0) {
    await publishChannelEvent(deps.pubsub, {
      type: "message.routed",
      channelId: row.channelId,
      messageId: message.id,
      seenBy: runs.map((r) => r.agentId),
      pickedBy: runs.map((r) => r.agentId),
      runs: runs.map((r) => ({ agentId: r.agentId, runId: r.id })),
      strategy: "dm",
    });
  }
  for (const run of runs) {
    await publishChannelEvent(deps.pubsub, {
      type: "agent.thinking",
      channelId: run.channelId,
      threadId: row.rootMessageId,
      agentId: run.agentId,
      runId: run.id,
    });
  }
}

/** The computer came back: its sessions still being prepared (or failed for a reason that may pass) try again. */
export async function ensureCodeSessionsOn(deps: CodeSessionDeps, machineId: string) {
  const rows = await deps.db
    .select({ id: codeSessions.id })
    .from(codeSessions)
    .where(
      and(
        eq(codeSessions.machineId, machineId),
        isNull(codeSessions.archivedAt),
        eq(codeSessions.worktreeState, "preparing"),
      ),
    );
  for (const r of rows) await prepareCodeSession(deps, r.id).catch(() => null);
}

/** "Tentar de novo" on a failed session: prepared again from where it stopped. */
export async function retryCodeSession(deps: CodeSessionDeps, userId: string, orgId: string, sessionId: string) {
  const row = await requireCodeSession(deps.db, userId, orgId, sessionId);
  if (row.worktreeState !== "failed") throw new ConflictError("This session isn't failed", "code_session.not_failed");
  await setSession(deps, row, { worktreeState: "preparing", worktreeError: null });
  void prepareCodeSession(deps, row.id).catch(() => null);
  return getCodeSession(deps.db, userId, orgId, row.id);
}

/**
 * The workspace's agents `userId` can start a session with: the ones that can have one (`worksInSessions`) and answer
 * them (`canTalkTo`), oldest first; `first`: stop at one.
 */
async function sessionAgentsIn(
  db: Database,
  orgId: string,
  userId: string,
  speaker: Speaker,
  first = false,
): Promise<string[]> {
  const rows = await db
    .select({
      ...REACH_COLUMNS,
      id: schema.agents.id,
      orgId: schema.agents.orgId,
      brain: schema.agents.brain,
      machineId: schema.agents.machineId,
    })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, orgId),
        isNull(schema.agents.archivedAt),
        isNull(schema.agents.deletedAt),
        isNotNull(schema.agents.machineId),
      ),
    )
    .orderBy(schema.agents.createdAt);
  const found: string[] = [];
  for (const row of rows) {
    if (!canTalkTo(row, userId, speaker)) continue;
    if (!(await worksInSessions(db, row))) continue;
    found.push(row.id);
    if (first) break;
  }
  return found;
}

/**
 * Whether Code has anything for this person (ADR 0215 §12): an agent they can start a session with, or an open session
 * they take part in (its agent may have left since). The apps offer Code only then; the caller checked the membership.
 */
export async function hasCodeWork(db: Database, userId: string, orgId: string): Promise<boolean> {
  const speaker = speakerOf(await getMembership(db, userId, orgId));
  if ((await sessionAgentsIn(db, orgId, userId, speaker, true)).length > 0) return true;
  const [session] = await db
    .select({ id: codeSessions.id })
    .from(codeSessions)
    .innerJoin(
      channelMembers,
      and(eq(channelMembers.channelId, codeSessions.channelId), eq(channelMembers.userId, userId)),
    )
    .where(and(eq(codeSessions.orgId, orgId), isNull(codeSessions.archivedAt)))
    .limit(1);
  return Boolean(session);
}

/**
 * Where a person can start a session: the workspace's agents that can have one (`worksInSessions`) and answer them
 * (`canTalkTo`), each with the repositories it may work in (`any`: its list allows more than it names, so any
 * `owner/name` the person types is tried).
 */
export async function codeStartOptions(db: Database, userId: string, orgId: string) {
  const speaker = speakerOf(await requireMember(db, userId, orgId));
  const agents = [];
  for (const agentId of await sessionAgentsIn(db, orgId, userId, speaker)) {
    const list = await agentRepositoryList(db, orgId, agentId);
    const repos = list.filter((r) => !r.endsWith("/*"));
    agents.push({ agentId, repos, any: list.length === 0 || repos.length < list.length });
  }
  return { agents };
}

/** Renames the session (any member). */
export async function renameCodeSession(
  deps: Pick<CodeSessionDeps, "db" | "pubsub">,
  userId: string,
  orgId: string,
  sessionId: string,
  title: string,
) {
  const row = await requireCodeSession(deps.db, userId, orgId, sessionId);
  const clean = title.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!clean) throw new ValidationError("A name is needed", "code_session.empty_title");
  await setSession(deps, row, { title: clean });
  return getCodeSession(deps.db, userId, orgId, sessionId);
}

/**
 * Closes the session: out of everyone's list, its conversation archived, and the worktree removed from the computer
 * (its branch stays: pushed work is not lost). Who opened it, or an administrator.
 */
export async function archiveCodeSession(deps: CodeSessionDeps, userId: string, orgId: string, sessionId: string) {
  const row = await requireCodeSession(deps.db, userId, orgId, sessionId);
  const membership = await requireMember(deps.db, userId, orgId);
  if (row.createdBy !== userId && !can(membership, "administrator"))
    throw new ForbiddenError("Only who opened the session closes it", "code_session.not_yours");
  const now = new Date();
  await deps.db.transaction(async (tx) => {
    await tx.update(codeSessions).set({ archivedAt: now, updatedAt: now }).where(eq(codeSessions.id, row.id));
    await tx.update(channels).set({ archivedAt: now }).where(eq(channels.id, row.channelId));
  });
  await announce(deps, row);
  if (deps.hub && row.machineId && row.worktreePath && row.worktreeState === "ready") {
    const agent = await getAgentCached(deps.db, orgId, row.agentId);
    if (agent)
      await deps.hub
        .call<"mission.worktree">(row.machineId, {
          op: "mission.worktree",
          action: "remove",
          repo: row.repoDir,
          path: row.worktreePath,
          // The branch stays: what was pushed (or only committed) is never lost with the folder.
          branch: row.branch ?? "",
          deleteBranch: false,
          agent: { id: agent.id, handle: agent.handle },
        })
        .then(() => deps.db.update(codeSessions).set({ worktreeState: "removed" }).where(eq(codeSessions.id, row.id)))
        .catch(() => null);
  }
}

/* ───────── git in the worktree, for the panel ───────── */

/** What the diff covers: everything since the base (committed or not), only what isn't committed, or one commit. */
export type CodeDiffScope = "base" | "uncommitted" | "commit";

export interface CodeDiffFile {
  path: string;
  /** The file's unified patch (`diff --git …`); empty when the diff was too large to send. */
  patch: string;
  added: number;
  removed: number;
  /** Not tracked by git yet (a new file). */
  untracked?: boolean;
}

export interface CodeDiff {
  scope: CodeDiffScope;
  base: { branch: string | null; sha: string | null };
  files: CodeDiffFile[];
  added: number;
  removed: number;
  /** The patches were left out: too large to send. */
  truncated: boolean;
}

/** A read-only git command in the session's worktree, as its agent (the runner's command policy reads it as a read). */
async function gitRead(deps: CodeSessionDeps, row: CodeSessionRow, args: string): Promise<string> {
  if (!deps.hub || !row.machineId)
    throw new ConflictError("This session's computer isn't reachable", "code_session.offline");
  if (row.worktreeState !== "ready" || !row.worktreePath)
    throw new ConflictError("The worktree isn't ready yet", "code_session.not_ready");
  const agent = await getAgentCached(deps.db, row.orgId, row.agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  let out: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };
  try {
    out = await deps.hub.call<"exec">(
      row.machineId,
      {
        op: "exec",
        command: `git --no-pager ${args}`,
        cwd: row.worktreePath,
        timeoutSeconds: GIT_READ_SECONDS,
        stream: false,
        agent: { id: agent.id, handle: agent.handle },
      },
      { timeoutMs: GIT_READ_ANSWER_MS },
    );
  } catch (error) {
    if (error instanceof MachineOfflineError || error instanceof MachinePausedError)
      throw new ConflictError("This session's computer isn't reachable", "code_session.offline");
    throw error;
  }
  if (out.timedOut) throw slowRead();
  if (out.exitCode !== 0) throw new ConflictError(out.stderr.trim() || "git failed", "code_session.git_failed");
  return out.stdout;
}

const LINE_ENDS = new Set(["\n", "\r", "\u2028", "\u2029"]);

/**
 * The file a patch is about, from its first line, `diff --git a/<old> b/<new>`: the new path, "?" when the line is
 * another. Read by index, as `/^diff --git a\/(.+?) b\/(.+)$/` would (the old path at least one character, the first
 * " b/" after it with at least one character after that, on the first line), without its quadratic reading of a line
 * with many " b/" in it.
 */
function patchPath(chunk: string): string {
  const start = "diff --git a/".length;
  if (!chunk.startsWith("diff --git a/")) return "?";
  let end = start;
  while (end < chunk.length && !LINE_ENDS.has(chunk.charAt(end))) end++;
  const line = chunk.slice(start, end);
  const at = line.indexOf(" b/", 1);
  return at >= 1 && at + 3 < line.length ? line.slice(at + 3) : "?";
}

/** Splits `git diff` output into one patch per file, with its line counts. */
export function splitPatch(text: string): CodeDiffFile[] {
  const files: CodeDiffFile[] = [];
  const chunks = text.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  for (const chunk of chunks) {
    const path = patchPath(chunk);
    let added = 0;
    let removed = 0;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
    }
    files.push({ path, patch: chunk.replace(/\n$/, ""), added, removed });
  }
  return files;
}

/**
 * The session's change for the panel: against the base commit (everything since it started, committed or not) or
 * against HEAD (only what isn't committed), new untracked files included as whole-file additions. Also keeps the
 * list's counts up to date.
 */
export async function codeSessionDiff(
  deps: CodeSessionDeps,
  userId: string,
  orgId: string,
  sessionId: string,
  scope: CodeDiffScope,
): Promise<CodeDiff> {
  const row = await requireCodeSession(deps.db, userId, orgId, sessionId);
  const against = scope === "base" ? row.baseSha || row.baseBranch || "HEAD" : "HEAD";
  const [tracked, untrackedList] = await Promise.all([
    gitRead(deps, row, `diff --no-color --no-ext-diff -M ${shellQuote(against)}`),
    gitRead(deps, row, "ls-files --others --exclude-standard -z"),
  ]);
  const files = splitPatch(tracked);
  const untracked = untrackedList.split("\0").filter(Boolean).slice(0, 200);
  for (const path of untracked) {
    // `git diff --no-index` exits 1 when files differ: read through `|| true` so the patch comes back.
    const patch = await gitRead(deps, row, `diff --no-color --no-index -- /dev/null ${shellQuote(path)} || true`).catch(
      () => "",
    );
    const [file] = splitPatch(patch);
    files.push({ path, patch: file?.patch ?? "", added: file?.added ?? 0, removed: 0, untracked: true });
  }
  const size = files.reduce((n, f) => n + f.patch.length, 0);
  const truncated = size > DIFF_MAX_CHARS;
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  if (scope === "base")
    await deps.db
      .update(codeSessions)
      .set({ files: files.length, added, removed, statAt: new Date() })
      .where(eq(codeSessions.id, row.id));
  return {
    scope,
    base: { branch: row.baseBranch, sha: row.baseSha },
    files: truncated ? files.map((f) => ({ ...f, patch: "" })) : files,
    added,
    removed,
    truncated,
  };
}

/** Single-quoted for the shell (git paths may have spaces). */
export const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * Where the session's git stands, for the header's button: changes not committed, commits not pushed (or not on any
 * remote branch yet), and the pull request when there is one. `next` is the step the button offers.
 */
export interface CodeGitState {
  uncommitted: number;
  ahead: number;
  upstream: boolean;
  /** A local project: Commit, then Merge into its base branch on the computer; never Push or a pull request. */
  local: boolean;
  pr: { number: number; url: string | null } | null;
  next: "commit" | "push" | "pr" | "merge" | null;
}

export async function codeSessionGit(
  deps: CodeSessionDeps,
  userId: string,
  orgId: string,
  sessionId: string,
): Promise<CodeGitState> {
  const row = await requireCodeSession(deps.db, userId, orgId, sessionId);
  const status = await gitRead(deps, row, "status --porcelain=v1 --branch");
  const lines = status.split("\n").filter(Boolean);
  const head = lines[0]?.startsWith("## ") ? (lines.shift() ?? "") : "";
  const uncommitted = lines.length;
  let upstream = /\.\.\.\S+/.test(head);
  const aheadMatch = /\[(?:[^\]]*?)ahead (\d+)/.exec(head);
  let ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
  if (!upstream && row.branch) {
    // Pushed without tracking (`git push origin <branch>`): the remote branch's local copy says what is still ahead.
    const remote = `refs/remotes/origin/${row.branch}`;
    const known = await gitRead(deps, row, `rev-parse --verify --quiet ${shellQuote(remote)}`).catch(() => "");
    if (known.trim()) {
      upstream = true;
      const count = await gitRead(deps, row, `rev-list --count ${shellQuote(remote)}..HEAD`).catch(() => "0");
      ahead = Number(count.trim()) || 0;
    }
  }
  if (!upstream && row.baseSha) {
    const count = await gitRead(deps, row, `rev-list --count ${shellQuote(row.baseSha)}..HEAD`).catch(() => "0");
    ahead = Number(count.trim()) || 0;
  }
  const pr = row.prNumber ? { number: row.prNumber, url: row.prUrl } : null;
  if (isLocalSession(row)) {
    // What the base branch doesn't have yet (merging it there clears it).
    const base = row.baseBranch ?? "main";
    const count = await gitRead(deps, row, `rev-list --count ${shellQuote(base)}..HEAD`).catch(() => "0");
    const unmerged = Number(count.trim()) || 0;
    const next = uncommitted > 0 ? "commit" : unmerged > 0 ? "merge" : null;
    return { uncommitted, ahead: unmerged, upstream: false, local: true, pr: null, next };
  }
  // A GitHub repository (`owner/name`): a pushed branch can always become a pull request.
  const next = uncommitted > 0 ? "commit" : ahead > 0 ? "push" : pr ? "merge" : upstream ? "pr" : null;
  return { uncommitted, ahead, upstream, local: false, pr, next };
}

/**
 * The open session working on `branch` of `repo` (`owner/name`, in any case: GitHub's events spell it their way), if
 * any: what GitHub's events on that branch reach (a check that failed there, a pull request opened from it).
 */
export async function codeSessionOnBranch(
  db: Executor,
  orgId: string,
  repo: string,
  branch: string,
): Promise<CodeSessionRow | null> {
  const [row] = await db
    .select()
    .from(codeSessions)
    .where(
      and(
        eq(codeSessions.orgId, orgId),
        sql`lower(${codeSessions.repo}) = lower(${repo})`,
        eq(codeSessions.branch, branch),
        isNull(codeSessions.archivedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Records the pull request opened from the session's branch (the agent's `open_pull_request`, or GitHub's event). */
export async function recordCodeSessionPr(
  deps: Pick<CodeSessionDeps, "db" | "pubsub">,
  orgId: string,
  repo: string,
  branch: string,
  pr: { number: number; url: string | null },
) {
  const row = await codeSessionOnBranch(deps.db, orgId, repo, branch);
  if (!row || (row.prNumber === pr.number && (row.prUrl === pr.url || !pr.url))) return row;
  return setSession(deps, row, { prNumber: pr.number, prUrl: pr.url });
}

/* ───────── the panel's Git and Files tabs (ADR 0215) ───────── */

/** Most commits the Git tab lists, the newest first. */
const LOG_MAX = 100;
/** Most changes the Git tab lists (a folder of new files not ignored yet can hold thousands). */
const CHANGES_MAX = 1_000;
/** Most untracked files whose lines the Git tab counts. */
const UNTRACKED_COUNTED = 100;
/** Most paths the Files tab lists. */
const FILES_MAX = 20_000;
/** Most of a file the Files tab shows. */
export const CODE_FILE_MAX_BYTES = 512 * 1024;
/** A commit named by its hash, short or whole. */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;
/** Files that hold secrets by convention: never shown, even where a repository tracks one. */
const SECRET_FILE = /^\.env(\..*)?$/i;

/** A read-only command in the session's worktree, as its agent: its exit code and what it printed. */
async function worktreeShell(deps: CodeSessionDeps, row: CodeSessionRow, command: string) {
  if (!deps.hub || !row.machineId)
    throw new ConflictError("This session's computer isn't reachable", "code_session.offline");
  if (row.worktreeState !== "ready" || !row.worktreePath)
    throw new ConflictError("The worktree isn't ready yet", "code_session.not_ready");
  const agent = await getAgentCached(deps.db, row.orgId, row.agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  try {
    const out = await deps.hub.call<"exec">(
      row.machineId,
      {
        op: "exec",
        command,
        cwd: row.worktreePath,
        timeoutSeconds: GIT_READ_SECONDS,
        stream: false,
        agent: { id: agent.id, handle: agent.handle },
      },
      { timeoutMs: GIT_READ_ANSWER_MS },
    );
    if (out.timedOut) throw slowRead();
    return out;
  } catch (error) {
    if (error instanceof MachineOfflineError || error instanceof MachinePausedError)
      throw new ConflictError("This session's computer isn't reachable", "code_session.offline");
    throw error;
  }
}

/** What `git status` says of a path not committed: changed, new (added, or not tracked yet), deleted or renamed. */
export type CodeChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";

export interface CodeChange {
  path: string;
  /** Where a renamed file was. */
  from?: string;
  status: CodeChangeStatus;
  /** Its lines against HEAD; null for a binary file, or a new one past those counted. */
  added: number | null;
  removed: number | null;
}

export interface CodeCommit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  /** When it was authored (ISO). */
  at: string;
  files: number;
  added: number;
  removed: number;
}

/** The Git tab: what isn't committed, and the branch's commits since its base. */
export interface CodeGitLog {
  branch: string | null;
  base: { branch: string | null; sha: string | null };
  changes: CodeChange[];
  /** More changes than listed. */
  changesMore: boolean;
  commits: CodeCommit[];
  /** More commits than listed. */
  more: boolean;
}

/** `git status --porcelain=v1 -z` as entries; with `-z` a rename's path is followed by where it came from. */
export function parseStatus(text: string): { path: string; from?: string; status: CodeChangeStatus }[] {
  const parts = text.split("\0");
  const out: { path: string; from?: string; status: CodeChangeStatus }[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i] ?? "";
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    if (x === "?" && y === "?") out.push({ path, status: "untracked" });
    else if (x === "R" || x === "C") {
      const from = parts[i + 1] ?? "";
      i += 1;
      out.push(x === "R" ? { path, from, status: "renamed" } : { path, status: "added" });
    } else if (x === "!") continue;
    else out.push({ path, status: x === "D" || y === "D" ? "deleted" : x === "A" ? "added" : "modified" });
  }
  return out;
}

/** `git diff --numstat -z` by path (a rename's counts go to its new path); a binary file's are null. */
export function parseNumstatZ(text: string): Map<string, { added: number | null; removed: number | null }> {
  const counts = new Map<string, { added: number | null; removed: number | null }>();
  const parts = text.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(parts[i] ?? "");
    if (!m) continue;
    let path = m[3] ?? "";
    if (!path) {
      // A rename: where it was, then where it is.
      path = parts[i + 2] ?? "";
      i += 2;
    }
    counts.set(path, {
      added: m[1] === "-" ? null : Number(m[1]),
      removed: m[2] === "-" ? null : Number(m[2]),
    });
  }
  return counts;
}

/** `git log` written as `%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s` with `--numstat`: one commit per record. */
export function parseLog(text: string): CodeCommit[] {
  const commits: CodeCommit[] = [];
  for (const record of text.split("\x1e")) {
    const [head = "", ...lines] = record.split("\n");
    const [sha = "", short = "", author = "", at = "", subject = ""] = head.split("\x1f");
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    let files = 0;
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (!m) continue;
      files += 1;
      if (m[1] !== "-") added += Number(m[1]);
      if (m[2] !== "-") removed += Number(m[2]);
    }
    commits.push({ sha, short, subject, author, at, files, added, removed });
  }
  return commits;
}

/**
 * The Git tab: what isn't committed (as `git status` lists it, with its lines against HEAD; new files counted whole)
 * and the branch's commits since the session's base, read in the worktree as its agent.
 */
export async function codeSessionGitLog(
  deps: CodeSessionDeps,
  userId: string,
  orgId: string,
  sessionId: string,
): Promise<CodeGitLog> {
  const row = await requireCodeSession(deps.db, userId, orgId, sessionId);
  const base = row.baseSha || row.baseBranch;
  const range = base ? `${shellQuote(base)}..HEAD` : "HEAD";
  const [status, numstat, log] = await Promise.all([
    worktreeShell(deps, row, "git --no-pager status --porcelain=v1 -z --untracked-files=all"),
    worktreeShell(deps, row, "git --no-pager diff --no-color --no-ext-diff --numstat -z HEAD"),
    worktreeShell(
      deps,
      row,
      `git --no-pager log --no-color --format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s --numstat -n ${LOG_MAX + 1} ${range}`,
    ),
  ]);
  if (status.exitCode !== 0) throw new ConflictError(status.stderr.trim() || "git failed", "code_session.git_failed");
  const listed = parseStatus(status.stdout);
  const entries = listed.slice(0, CHANGES_MAX);
  const counts = parseNumstatZ(numstat.exitCode === 0 ? numstat.stdout : "");
  // A new file's lines, as a diff against nothing would count them: one command for all of them, NUL between.
  const untracked = entries.filter((e) => e.status === "untracked").slice(0, UNTRACKED_COUNTED);
  const fresh = new Map<string, number | null>();
  if (untracked.length > 0) {
    const paths = untracked.map((e) => shellQuote(e.path)).join(" ");
    const out = await worktreeShell(
      deps,
      row,
      `for p in ${paths}; do n=$(git --no-pager diff --no-color --no-index --numstat -- /dev/null "$p" 2>/dev/null | cut -f1); printf '%s\\0' "\${n:-0}"; done`,
    ).catch(() => null);
    const said = out?.stdout.split("\0") ?? [];
    untracked.forEach((e, i) => {
      const n = said[i];
      fresh.set(e.path, n === undefined || n === "-" || n === "" ? null : Number(n));
    });
  }
  const changes = entries.map((e): CodeChange => {
    if (e.status === "untracked") {
      const added = fresh.get(e.path);
      return { path: e.path, status: e.status, added: added ?? null, removed: added === undefined ? null : 0 };
    }
    const c = counts.get(e.path);
    return {
      path: e.path,
      ...(e.from ? { from: e.from } : {}),
      status: e.status,
      added: c?.added ?? (e.status === "deleted" ? 0 : null),
      removed: c?.removed ?? null,
    };
  });
  const commits = parseLog(log.exitCode === 0 ? log.stdout : "");
  return {
    branch: row.branch,
    base: { branch: row.baseBranch, sha: row.baseSha },
    changes,
    changesMore: listed.length > CHANGES_MAX,
    commits: commits.slice(0, LOG_MAX),
    more: commits.length > LOG_MAX,
  };
}

/** One commit's change in the worktree (`git show`), split per file like the session's diff. */
export async function codeSessionCommitDiff(
  deps: CodeSessionDeps,
  userId: string,
  orgId: string,
  sessionId: string,
  sha: string,
): Promise<CodeDiff> {
  const row = await requireCodeSession(deps.db, userId, orgId, sessionId);
  if (!COMMIT_SHA.test(sha)) throw new ValidationError("A commit's hash is needed", "code_session.commit_sha");
  const out = await worktreeShell(deps, row, `git --no-pager show --no-color --no-ext-diff -M --format= ${sha}`);
  if (out.exitCode !== 0) throw new NotFoundError("No such commit in this worktree");
  const files = splitPatch(out.stdout);
  const truncated = files.reduce((n, f) => n + f.patch.length, 0) > DIFF_MAX_CHARS;
  return {
    scope: "commit",
    base: { branch: row.baseBranch, sha: row.baseSha },
    files: truncated ? files.map((f) => ({ ...f, patch: "" })) : files,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
    truncated,
  };
}

/** The Files tab: the worktree's files (tracked, and new ones git doesn't ignore), and which of them changed. */
export interface CodeFiles {
  paths: string[];
  /** More files than listed. */
  truncated: boolean;
  changes: { path: string; status: CodeChangeStatus }[];
}

export async function codeSessionFiles(
  deps: CodeSessionDeps,
  userId: string,
  orgId: string,
  sessionId: string,
): Promise<CodeFiles> {
  const row = await requireCodeSession(deps.db, userId, orgId, sessionId);
  const [list, status] = await Promise.all([
    worktreeShell(deps, row, "git --no-pager ls-files -co --exclude-standard -z"),
    worktreeShell(deps, row, "git --no-pager status --porcelain=v1 -z --untracked-files=all"),
  ]);
  if (list.exitCode !== 0) throw new ConflictError(list.stderr.trim() || "git failed", "code_session.git_failed");
  const paths = [...new Set(list.stdout.split("\0").filter(Boolean))];
  return {
    paths: paths.slice(0, FILES_MAX),
    truncated: paths.length > FILES_MAX,
    changes: parseStatus(status.exitCode === 0 ? status.stdout : "").map(({ path, status }) => ({ path, status })),
  };
}

/**
 * A file the session shows, or why not: `binary`, `missing` (gone, or a folder), `ignored` (git ignores
 * it: build output, a key), `secret` (a `.env` file), `outside` (a link out of the worktree).
 */
export type CodeFileState = "ok" | "binary" | "missing" | "ignored" | "secret" | "outside";

export interface CodeFile {
  path: string;
  state: CodeFileState;
  /** Its text, up to `CODE_FILE_MAX_BYTES` (empty unless `ok`). */
  content: string;
  /** Its size in bytes. */
  size: number;
  /** Only its start is here. */
  truncated: boolean;
  /** What it holds, as git names it (its blob hash): a save says which one it started from. Empty unless `ok`. */
  rev: string;
}

/**
 * A path the Files tab may ask for: relative to the worktree, with no `..`, `.` or empty step, no `.git` folder, no
 * backslash and no NUL.
 */
export function codeFilePathOk(path: string): boolean {
  if (!path || path.length > 1024 || path.includes("\0") || path.includes("\\") || path.startsWith("/")) return false;
  return path.split("/").every((step) => step !== "" && step !== "." && step !== ".." && step !== ".git");
}

/**
 * Says what a path is before it is read or written: `ignored`, `outside` (a link, or a folder that resolves out of the
 * worktree), `missing`, else nothing (each step resolved, POSIX `sh` on any computer).
 */
const fileGuard = (path: string) => [
  `p=${shellQuote(path)}`,
  `if git check-ignore -q -- "$p" 2>/dev/null; then echo ignored; exit 0; fi`,
  `if [ -L "$p" ]; then echo outside; exit 0; fi`,
  `if [ ! -f "$p" ]; then echo missing; exit 0; fi`,
  `d=$(cd -- "$(dirname -- "$p")" 2>/dev/null && pwd -P) || { echo missing; exit 0; }`,
  `case "$d/" in "$(pwd -P)/"*) ;; *) echo outside; exit 0 ;; esac`,
];

/**
 * One file of the worktree as its agent reads it, for whoever reads the session: never a file git ignores, a `.env`
 * one, or one reached through a link out of the worktree.
 */
export async function codeSessionFile(
  deps: CodeSessionDeps,
  userId: string,
  orgId: string,
  sessionId: string,
  path: string,
): Promise<CodeFile> {
  const row = await requireCodeSession(deps.db, userId, orgId, sessionId);
  if (!codeFilePathOk(path))
    throw new ValidationError("A path inside the worktree is needed", "code_session.file_path");
  return readWorktreeFile(deps, row, path);
}

async function readWorktreeFile(deps: CodeSessionDeps, row: CodeSessionRow, path: string): Promise<CodeFile> {
  const none = (state: CodeFileState): CodeFile => ({ path, state, content: "", size: 0, truncated: false, rev: "" });
  if (SECRET_FILE.test(path.split("/").pop() ?? "")) return none("secret");
  const command = [
    ...fileGuard(path),
    `echo "ok $(wc -c < "$p" | tr -d ' ') $(git hash-object -- "$p")"`,
    `head -c ${CODE_FILE_MAX_BYTES} -- "$p"`,
  ].join("\n");
  const out = await worktreeShell(deps, row, command);
  if (out.exitCode !== 0)
    throw new ConflictError(out.stderr.trim() || "The file couldn't be read", "code_session.file_failed");
  const cut = out.stdout.indexOf("\n");
  const head = cut < 0 ? out.stdout.trim() : out.stdout.slice(0, cut);
  const [word = "", bytes = "0", rev = ""] = head.split(" ");
  if (word !== "ok") return none(word === "ignored" || word === "outside" ? word : "missing");
  const content = cut < 0 ? "" : out.stdout.slice(cut + 1);
  const size = Number(bytes) || content.length;
  // A NUL early on is a binary file: nothing to read as text.
  if (content.slice(0, 8000).includes("\0")) return { ...none("binary"), size };
  return { path, state: "ok", content, size, truncated: size > CODE_FILE_MAX_BYTES, rev };
}

/**
 * A person saves a file of the worktree (ADR 0215): whoever is in the session, since they could ask its agent for the
 * same change. Only a file the session shows (never one git ignores, a `.env` one, a link out, a binary or a cut
 * one), written as the agent by the runner's own file op (its mode kept, never into a `.git` folder). `rev` is what
 * the person started from: the file holding something else by now (the agent wrote it meanwhile) is refused with
 * `code_session.file_changed`, unless `overwrite` says theirs wins.
 */
export async function saveCodeSessionFile(
  deps: CodeSessionDeps,
  userId: string,
  orgId: string,
  sessionId: string,
  input: { path: string; content: string; rev: string; overwrite?: boolean },
): Promise<CodeFile> {
  const row = await requireCodeSession(deps.db, userId, orgId, sessionId);
  // A save is a change the person could ask the agent for: someone it doesn't answer reads the session, no more.
  const writer = await getAgentCached(deps.db, row.orgId, row.agentId);
  if (writer && !canTalkTo(writer, userId, speakerOf(await getMembership(deps.db, userId, orgId))))
    throw await audienceError(deps.db, writer);
  const { path, content } = input;
  if (!codeFilePathOk(path))
    throw new ValidationError("A path inside the worktree is needed", "code_session.file_path");
  const data = Buffer.from(content, "utf8");
  const locked = () => new ConflictError("This file can't be edited here", "code_session.file_locked");
  if (SECRET_FILE.test(path.split("/").pop() ?? "") || data.byteLength > CODE_FILE_MAX_BYTES || content.includes("\0"))
    throw locked();
  const check = await worktreeShell(
    deps,
    row,
    [...fileGuard(path), `echo "ok $(wc -c < "$p" | tr -d ' ') $(git hash-object -- "$p")"`].join("\n"),
  );
  if (check.exitCode !== 0)
    throw new ConflictError(check.stderr.trim() || "The file couldn't be read", "code_session.file_failed");
  const [word = "", bytes = "0", rev = ""] = (check.stdout.split("\n")[0] ?? "").trim().split(" ");
  // Nothing to save over: gone, ignored, a link out, or longer than the session shows whole.
  if (word !== "ok" || Number(bytes) > CODE_FILE_MAX_BYTES) throw locked();
  if (rev !== input.rev && !input.overwrite)
    throw new ConflictError("The file changed since it was opened", "code_session.file_changed");
  const agent = await getAgentCached(deps.db, row.orgId, row.agentId);
  if (!agent || !deps.hub || !row.machineId || !row.worktreePath) throw new NotFoundError("Agent not found");
  try {
    await deps.hub.call<"write">(row.machineId, {
      op: "write",
      path: `${row.worktreePath}/${path}`,
      base64: data.toString("base64"),
      agent: { id: agent.id, handle: agent.handle },
    });
  } catch (error) {
    if (error instanceof MachineOfflineError || error instanceof MachinePausedError)
      throw new ConflictError("This session's computer isn't reachable", "code_session.offline");
    throw error;
  }
  return readWorktreeFile(deps, row, path);
}
