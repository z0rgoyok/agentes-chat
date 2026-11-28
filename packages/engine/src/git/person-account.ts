import type { CommitAuthor } from "@agenteschat/adapters";
import { and, type Database, desc, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { runAuthorityById, UUID } from "../authority";
import { TtlCache } from "../cache";
import type { ConnectorConnection } from "../connectors/connections";
import { GIT_HOSTS, type GitHostId, isHostedRepo, parseRepoRef } from "./hosts";

const { agentRuns, channels, codeSessions, users } = schema;

/**
 * A person's own account on a git host in a code session (ADR 0215 §13, ADR 0227). A member may connect GitHub,
 * GitLab, Bitbucket or a git server as their own (`connector_connections.owner_user_id`, ADR 0099): it has no tools
 * of its own and is never the workspace's connection. It is who the work goes as when its person asks in a code
 * session, on that session's repository alone:
 *
 * - the commits the agent makes are authored as them (`codeCommitAuthor`: their name and the host's no-reply address
 *   for that account, never their email), the agent still the co-author;
 * - the push of the session's branch reaches the host with their token (`personAccountOfPush`, in the git proxy);
 * - what the agent writes there (a pull request, a comment, an API commit) goes with their token too
 *   (`open_pull_request`, `githubCallAuth`).
 *
 * Their token stays on the server, as the workspace's does: the agent's computer gets a name and an address. A run
 * nobody asked for (a routine, a check that woke the agent), another conversation, another repository, a person who
 * left or who connected no account: the workspace's connection, as before. In a session with several people it
 * follows who asked that turn, so nobody acts as someone else.
 */
export interface PersonAccount {
  personId: string;
  /** The session's repository, by its stored name (`owner/name`, `gitlab:group/project`). */
  repo: string;
  host: GitHostId;
  connection: ConnectorConnection;
}

/** The account a connection kept when it was connected, when its host named one. */
const accountOf = (c: Pick<ConnectorConnection, "accountId" | "accountLabel">) =>
  c.accountId && c.accountLabel ? { id: c.accountId, login: c.accountLabel } : null;

/** A person's own live connection to a git host, if any. */
export const ownAccount = (connections: readonly ConnectorConnection[], personId: string, host: GitHostId) =>
  connections.find((c) => c.connector === host && c.ownerUserId === personId && c.status === "active") ?? null;

// Who is behind a run and which session it is in never change: read once per run. The connection is read each time
// (`activeConnections` forgets it the moment it is removed).
const behind = new TtlCache<{ personId: string; repo: string; host: GitHostId } | null>(10 * 60_000);

/** The account a run's work on its code session's repository goes as, or null (the workspace's connection). */
export async function personAccountOfRun(
  db: Database,
  orgId: string,
  runId: string | null | undefined,
): Promise<PersonAccount | null> {
  if (!runId || !UUID.test(runId)) return null;
  const who = await behind.getOrLoad(`${orgId}:${runId}`, async () => {
    const [run] = await db
      .select({ repo: codeSessions.repo })
      .from(agentRuns)
      .innerJoin(channels, and(eq(channels.orgId, agentRuns.orgId), eq(channels.id, agentRuns.channelId)))
      .innerJoin(
        codeSessions,
        and(eq(codeSessions.orgId, agentRuns.orgId), eq(codeSessions.channelId, agentRuns.channelId)),
      )
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId), eq(channels.kind, "code")))
      .limit(1);
    // A project that lives only on the computer is on no host.
    const ref = run && isHostedRepo(run.repo) ? parseRepoRef(run.repo) : null;
    if (!run || !ref) return null;
    const authority = await runAuthorityById(db, orgId, runId);
    return authority.kind === "person" ? { personId: authority.personId, repo: run.repo, host: ref.host } : null;
  });
  if (!who) return null;
  // Read when asked: the machine hub and the sandbox load this file, and these load them.
  const [{ activeConnections }, { getMembership }] = await Promise.all([
    import("../connectors/connections"),
    import("../organizations"),
  ]);
  const connection = ownAccount(await activeConnections(db, orgId), who.personId, who.host);
  if (!connection || !(await getMembership(db, who.personId, orgId))) return null;
  return { ...who, connection };
}

/** Whether `repo` (its stored name, any capitals) is the repository a run's person acts as themselves on. */
export const onSessionRepo = (account: PersonAccount, repo: string) =>
  account.repo.toLowerCase() === repo.toLowerCase();

/** More runs than this at once in one session is nothing we tell apart: the workspace's. */
const LIVE_RUNS = 6;

/**
 * The account a push goes as: every ref it updates is the branch of one code session of this agent on this
 * repository, and a person is behind the run working in that session now. The proxy's credential names the agent
 * and its computer, never a run, so the session is found by its branch.
 */
export async function personAccountOfPush(
  db: Database,
  push: { orgId: string; agentId: string; repo: string; refs: readonly string[] },
): Promise<PersonAccount | null> {
  const branches = new Set(push.refs.map((r) => (r.startsWith("refs/heads/") ? r.slice("refs/heads/".length) : "")));
  const [branch] = branches;
  if (branches.size !== 1 || !branch) return null;
  const [session] = await db
    .select({ channelId: codeSessions.channelId })
    .from(codeSessions)
    .where(
      and(
        eq(codeSessions.orgId, push.orgId),
        eq(codeSessions.agentId, push.agentId),
        eq(codeSessions.branch, branch),
        sql`lower(${codeSessions.repo}) = ${push.repo.toLowerCase()}`,
        isNull(codeSessions.archivedAt),
      ),
    )
    .limit(1);
  if (!session) return null;
  const live = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, push.orgId),
        eq(agentRuns.agentId, push.agentId),
        eq(agentRuns.channelId, session.channelId),
        inArray(agentRuns.status, ["running", "waiting_approval"]),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(LIVE_RUNS);
  const [run] = live;
  if (!run || live.length === LIVE_RUNS) return null;
  // The push names no run. With more than one working in the session, it is a person's only when the same person is
  // behind every one of them: otherwise one's work could leave with another's account, and it goes as the workspace.
  const behindEach = await Promise.all(live.map((r) => runAuthorityById(db, push.orgId, r.id)));
  const people = new Set(behindEach.map((a) => (a.kind === "person" ? a.personId : "")));
  if (people.size !== 1 || people.has("")) return null;
  const account = await personAccountOfRun(db, push.orgId, run.id);
  return account && onSessionRepo(account, push.repo) ? account : null;
}

/**
 * Who a run's commits are authored as, when it isn't the agent: the person who asked in a code session, by the
 * account they connected as their own, where its host has an address for it. Sent with the session's turn and
 * commands (`AgentScope.author`); the agent still ends each commit with its own `Co-Authored-By` line.
 */
export async function codeCommitAuthor(
  db: Database,
  orgId: string,
  runId: string | null | undefined,
): Promise<CommitAuthor | null> {
  const account = await personAccountOfRun(db, orgId, runId);
  const named = account && accountOf(account.connection);
  if (!account || !named) return null;
  const host = GIT_HOSTS[account.host];
  const email = host.commitEmail?.(host.at(account.connection.serverUrl, fetch), named);
  if (!email) return null;
  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, account.personId));
  const { trailerName } = await import("./signature");
  return {
    name: trailerName(person?.name ?? "") || named.login,
    email,
  };
}
