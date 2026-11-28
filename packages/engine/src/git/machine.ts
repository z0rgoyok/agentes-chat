import {
  type AgentScope,
  GIT_CHECKOUTS_DIR,
  GIT_DIRECT_PROTOCOL,
  GIT_HOST_PATH_PROTOCOL,
  GIT_PROTOCOL,
  GIT_STATELESS_TOKEN_PROTOCOL,
  GIT_SYNC_LIMITS,
  GITHUB_APP_TOKEN,
  type GitSyncRepo,
  type GitSyncRequest,
  gitCheckoutDir,
  isGitRepoName,
} from "@agenteschat/adapters";
import { and, type Database, eq, isNull, lte, or, schema } from "@agenteschat/db";
import { getAgentCached } from "../agents";
import { recordAudit } from "../audit";
import { activeConnections } from "../connectors/connections";
import { ago } from "../context";
import type { MachineCaller, MachineCallOptions, MachineStatus } from "../machine-hub";
import { MachineOfflineError, MachinePausedError, REMOVED_COMPUTER_MESSAGE } from "../machines";
import { missionOfRun } from "../mission-context";
import { toolMachineId } from "../right-hand-seats";
import { runnerUpdateWay } from "../runner-update";
import { SAY_NOW_TOOL } from "../say-now";
import { standingRefusal } from "../standing";
import { grantedScopeKeys } from "../tools/scopes";
import { agentCommitEmail, GIT_TOKEN_TTL_SECONDS, gitProxyBase, issueGitToken, machineGitGen } from "./credential";
import { appTokenForRepo, botIdentity, boundInstallations, type GitHubAppConfig, type GitHubHttp } from "./github-app";
import {
  checkoutDirOf,
  GIT_HOST_IDS,
  GIT_HOSTS,
  type GitHostId,
  hostOfEntry,
  parseRepoRef,
  refInList,
  repoRefName,
  teamGitConnection,
} from "./hosts";
import { gitAccess, gitScopes } from "./proxy";
import { agentRepositoryList, type CodeCheckout, codePrompt, repoInList } from "./repos";
import { runCoAuthors } from "./signature";

type KnownCheckout = schema.KnownCheckout;

/**
 * Git on a connected machine through our proxy (ADR 0024 addendum):
 * the server issues the proxy credential for that machine and agent, and the
 * runner clones or updates the agent's checkouts in its own folder
 * (`repos/<owner>/<name>`) with `git.sync` (protocol 11). Only our
 * credential reaches the machine (revocable, scoped to the agent's granted
 * repositories, pushes only to `agentes/<handle>/…`); GitHub's token stays here.
 *
 * ADR 0116: with our GitHub App installed for a repository, a runner on
 * protocol 53 also gets a one-hour installation token for that repository
 * alone (contents: read), so its fetches go straight to GitHub instead of
 * through this server; pushes still go through the proxy. Never the
 * connection's own (OAuth or pasted) token: without the App, all of it goes
 * through the proxy.
 */
export interface MachineGitDeps {
  db: Database;
  hub: MachineCaller;
  /** Our public URL and AGENTES_SECRET (the proxy credential is an HMAC of it). */
  git: { publicUrl: string; secret: string };
  /** Our GitHub App (ADR 0116): fetches straight from GitHub where it is installed. */
  github?: { app: GitHubAppConfig; http: GitHubHttp } | null;
  now?: () => Date;
}

/** An older runner's clone may take this long (partial clone, but a big checkout on a slow link). */
export const MACHINE_CLONE_SECONDS = 1800;
/** A runner on protocol 35 answers `cloning` after this long and the download goes on there. */
export const MACHINE_CLONE_WAIT_SECONDS = 600;
/**
 * A sync of an agent's checkouts, every fetch together, at most this long on the computer. It runs beside the turn
 * (`prepareAgentCode`), so a slow fetch gets to finish instead of failing at a bound the turn would have waited out.
 */
export const CHECKOUT_SYNC_SECONDS = 60;
/** After a sync of an agent's checkouts starts, no process starts another for this long. */
export const CHECKOUT_SYNC_EVERY_MS = 3 * 60_000;
/**
 * A repository whose update failed (it took too long, its config was locked, it was refused) isn't tried again for
 * this long, twice as long after each failure in a row, at most `CHECKOUT_BACKOFF_MAX_MS`.
 */
export const CHECKOUT_BACKOFF_MS = 5 * 60_000;
export const CHECKOUT_BACKOFF_MAX_MS = 60 * 60_000;

/** Why git can't run on the machine now (said to the agent), or null. */
export function machineGitUnavailable(status: MachineStatus | null, orgId: string): Error | null {
  if (!status || status.orgId !== orgId) {
    return new Error(REMOVED_COMPUTER_MESSAGE);
  }
  if (!status.online) return new MachineOfflineError(status.name, status.kind);
  if (status.paused) return new MachinePausedError(status.name, status.paused.until, status.paused.timezone);
  if (status.protocol < GIT_PROTOCOL) {
    return new Error(
      `The agentes.chat app on the computer ${status.name} is too old to clone repositories. ${runnerUpdateWay(status)}`,
    );
  }
  return null;
}

/**
 * The `proxy` and `author` of a `git.sync` for this agent on this machine:
 * a fresh proxy credential (6 h) bound to the machine and the agent. Null
 * when the org has no GitHub connection or the agent has no git access.
 * With the GitHub App installed for the workspace (ADR 0156), commits are
 * authored as the app's bot, so GitHub shows them as the app's.
 */
export async function machineGitSetup(
  deps: MachineGitDeps,
  orgId: string,
  agentId: string,
  machineId: string,
  /** A tool's call: who the computer takes the agent for (`machineScope`), the right hand's seat included. */
  scope?: AgentScope,
  /** The git host whose proxy this is for (ADR 0227): each host's connection has its own address there. */
  host: GitHostId = "github",
): Promise<(Pick<GitSyncRequest, "proxy" | "author"> & { agent: AgentScope }) | null> {
  const connection = teamGitConnection(await activeConnections(deps.db, orgId), host);
  if (!connection) return null;
  const keys = await grantedScopeKeys(deps.db, orgId, agentId);
  if (!gitAccess(keys, connection.id, host).read) return null;
  const agent = await getAgentCached(deps.db, orgId, agentId);
  // Without a scope (a brain's turn) the right hand has no checkout: its locked turn prepares none (ADR 0137 §4).
  if (!agent || (scope ? await toolMachineId(deps.db, agent) : agent.machineId) !== machineId) return null;
  const [machine] = await deps.db
    .select({ tokenHash: schema.machines.tokenHash })
    .from(schema.machines)
    .where(and(eq(schema.machines.id, machineId), eq(schema.machines.orgId, orgId), isNull(schema.machines.deletedAt)));
  if (!machine?.tokenHash) return null;
  const now = deps.now?.() ?? new Date();
  const token = issueGitToken(deps.git.secret, {
    orgId,
    agentId,
    sandboxId: machineId,
    gen: machineGitGen(machine.tokenHash),
    exp: Math.floor(now.getTime() / 1000) + GIT_TOKEN_TTL_SECONDS,
    kind: "machine",
  });
  const github = deps.github;
  const bot =
    host === "github" && github && (await boundInstallations(deps.db, orgId)).length > 0
      ? await botIdentity(github.app, github.http)
      : null;
  return {
    proxy: { base: gitProxyBase(deps.git.publicUrl, orgId, connection.id), token },
    author: bot
      ? { name: `${agent.name} (agentes.chat)`, email: bot.email }
      : { name: `${agent.name} (agentes)`, email: agentCommitEmail(deps.git.publicUrl, agent.handle) },
    agent: scope ?? { id: agent.id, handle: agent.handle, name: agent.name },
  };
}

/**
 * Single-repository read tokens of our GitHub App for the repositories among `repos` the agent may use, keyed by
 * repository; empty without the App, on an older runner, where the App isn't installed, or for an agent that is
 * archived, held or suspended (as the proxy refuses it). Only what the runner takes as an installation token
 * (`GITHUB_APP_TOKEN`), never the connection's own. Never throws: a repository without a token fetches through the
 * proxy. Each token handed out is audited as a fetch (`via: github-direct`): the fetches themselves no longer pass
 * through us.
 */
export async function directFetchTokens(
  deps: MachineGitDeps,
  target: { orgId: string; agentId: string; machineId: string },
  protocol: number,
  repos: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const github = deps.github;
  if (!github || protocol < GIT_STATELESS_TOKEN_PROTOCOL || repos.length === 0) return out;
  try {
    const [agent] = await deps.db
      .select({ archivedAt: schema.agents.archivedAt })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, target.agentId), eq(schema.agents.orgId, target.orgId)));
    if (!agent || agent.archivedAt || (await standingRefusal(deps.db, target.orgId, target.agentId))) return out;
    const list = await agentRepositoryList(deps.db, target.orgId, target.agentId);
    const tenant = { db: deps.db, orgId: target.orgId };
    await Promise.all(
      repos.map(async (repo) => {
        const [owner = "", name = ""] = repo.split("/");
        if (!repoInList(list, owner, name)) return;
        const token = await appTokenForRepo(github.app, github.http, tenant, owner, name, { contents: "read" }).catch(
          () => null,
        );
        // The runner refuses a whole `git.sync` over one token it doesn't take.
        if (!token || !GITHUB_APP_TOKEN.test(token)) return;
        out.set(repo, token);
        await recordAudit(deps.db, {
          orgId: target.orgId,
          actor: { type: "agent", id: target.agentId },
          action: "git.fetch",
          target: { type: "git_repo", id: repo },
          details: { via: "github-direct", machineId: target.machineId },
        }).catch(() => undefined);
      }),
    );
  } catch {
    // The database didn't answer: no tokens this time, and the sync still goes (through the proxy).
  }
  return out;
}

/** The `owner/name` folders under the agent's `repos/` on the computer (`list`); none when it can't say. */
async function checkoutsOnMachine(
  hub: MachineCaller,
  machineId: string,
  agent: AgentScope,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const { entries } = await hub.call(
      machineId,
      { op: "list", agent, path: GIT_CHECKOUTS_DIR, depth: 2 },
      { timeoutMs: 10_000, ...(signal ? { signal } : {}) },
    );
    return entries.flatMap((e) => {
      const parts = e.path.split("/");
      const repo = parts.slice(1).join("/");
      return e.isDir && parts.length === 3 && parts[0] === GIT_CHECKOUTS_DIR && isGitRepoName(repo) ? [repo] : [];
    });
  } catch {
    return [];
  }
}

/** `git_clone` on a connected machine: clones (or, when it is there, updates) one repository in the agent's folder. */
export async function cloneOnMachine(
  deps: MachineGitDeps,
  target: { orgId: string; agentId: string; machineId: string; scope: AgentScope },
  input: { repo: string; dir?: string; signal?: AbortSignal; onOutput?: MachineCallOptions["onOutput"] },
): Promise<GitSyncRepo> {
  const status = await deps.hub.status(target.machineId);
  const unavailable = machineGitUnavailable(status, target.orgId);
  if (unavailable || !status) throw unavailable;
  const ref = parseRepoRef(input.repo);
  if (!ref) throw new Error(`${input.repo} names no repository`);
  const host = GIT_HOSTS[ref.host];
  const setup = await machineGitSetup(deps, target.orgId, target.agentId, target.machineId, target.scope, ref.host);
  if (!setup) {
    throw new Error(
      `You have no git access to ${host.label} here (scope ${gitScopes(ref.host).read}), or ${host.label} isn't connected.`,
    );
  }
  // A path deeper than `owner/name` (a GitLab subgroup) is one an older runner refuses.
  if (!isGitRepoName(ref.path) && status.protocol < GIT_HOST_PATH_PROTOCOL) {
    throw new Error(
      `The agentes.chat app on the computer ${status.name} is too old to clone ${input.repo}. ${runnerUpdateWay(status)}`,
    );
  }
  const { agent, ...rest } = setup;
  const github =
    ref.host === "github"
      ? (await directFetchTokens(deps, target, status.protocol, [ref.path])).get(ref.path)
      : undefined;
  const reply = await deps.hub.call(
    target.machineId,
    {
      op: "git.sync",
      agent,
      ...rest,
      repos: [{ repo: ref.path, dir: input.dir || checkoutDirOf(ref), clone: true, ...(github ? { github } : {}) }],
      timeoutSeconds: status.protocol >= GIT_DIRECT_PROTOCOL ? MACHINE_CLONE_WAIT_SECONDS : MACHINE_CLONE_SECONDS,
      stream: Boolean(input.onOutput),
    },
    { ...(input.signal ? { signal: input.signal } : {}), ...(input.onOutput ? { onOutput: input.onOutput } : {}) },
  );
  const result = reply.repos[0];
  if (!result) throw new Error("The computer answered without the repository.");
  // The computer knows the repository by its path on the host; everything above it by its stored name.
  const cloned: GitSyncRepo = { ...result, repo: repoRefName(ref) };
  // The next turn starts from what the last sync knew, which may be minutes old: it learns of this clone now.
  if (cloned.status !== "failed") {
    const where = checkoutKey(target);
    const [row] = await deps.db
      .select({ repos: schema.agentCheckouts.repos })
      .from(schema.agentCheckouts)
      .where(where)
      .catch(() => []);
    if (row) {
      const repos = [...row.repos.filter((r) => !sameRepo(r.repo, cloned.repo)), cloned];
      await deps.db
        .update(schema.agentCheckouts)
        .set({ repos })
        .where(where)
        .catch(() => undefined);
    }
  }
  return cloned;
}

/** The repository the conversation names (newest text first), among `repos` (`owner/name`); null when none. */
export function namedRepo(repos: readonly string[], texts: readonly string[]): string | null {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const text of texts) {
    let best: { repo: string; at: number } | null = null;
    for (const repo of repos) {
      const name = repo.split("/")[1] ?? "";
      const patterns = [new RegExp(`(^|[^A-Za-z0-9_.-])${esc(repo)}(?![A-Za-z0-9_-])`, "i")];
      if (name.length >= 3) patterns.push(new RegExp(`(^|[^A-Za-z0-9_./-])${esc(name)}(?![A-Za-z0-9_/-])`, "i"));
      for (const p of patterns) {
        const m = p.exec(text);
        if (m && (!best || m.index < best.at)) best = { repo, at: m.index };
      }
    }
    if (best) return best.repo;
  }
  return null;
}

/** What `prepareAgentCode` gives a turn: where it starts, "# Your code" for the system text, and the start line. */
export interface CodeSetup {
  cwd: string;
  prompt: string;
  /** "You start in …" for the turn's prompt; absent or "" when it starts in no checkout. */
  start?: string;
  /** What the start was picked from, to pick it again for other words (`codeStart`) without reading again. */
  pick?: { present: CodeStartRepo[]; primary?: string; credit?: string; fresh?: string };
}

type CodeStartRepo = { repo: string; dir: string; path?: string };

/**
 * Where a turn starts among the synced checkouts: the repository the conversation names (its trigger first, then
 * its last messages, newest first), else the agent's first repository, else the first checkout.
 */
export function codeStart(
  pick: NonNullable<CodeSetup["pick"]>,
  turn: Pick<CodeTurn, "trigger" | "messages">,
): Pick<CodeSetup, "cwd" | "start"> {
  const texts = [
    turn.trigger,
    ...turn.messages
      .slice(-8)
      .map((m) => m.content)
      .reverse(),
  ];
  const named = namedRepo(
    pick.present.map((r) => r.repo),
    texts,
  );
  const start =
    pick.present.find((r) => r.repo === named) ??
    pick.present.find((r) => r.repo.toLowerCase() === pick.primary?.toLowerCase()) ??
    pick.present[0];
  const lines = [start ? `You start in ${start.path ?? start.dir}.` : "", pick.fresh ?? "", pick.credit ?? ""];
  return { cwd: start?.dir ?? "", start: lines.filter(Boolean).join("\n") };
}

/**
 * The turn's commits end with the agent's own `Co-Authored-By` and the credit for the person behind its run, when they
 * linked GitHub to sign in (ADR 0156), as the run's commits through GitHub's API do: the line that says so, next to
 * where the turn starts. A runner on protocol 63 adds them by itself too (its `commit-msg` hook, never twice); this
 * line covers an older one and a `--no-verify`.
 */
async function creditLine(deps: MachineGitDeps, turn: CodeTurn) {
  const http = deps.github?.http ?? { fetch, apiUrl: "https://api.github.com" };
  // GitHub's login for the person is looked up once a day: a turn waits `CREDIT_WAIT_MS` at most for it, and the
  // lookup goes on for the next one.
  const lines = await runCoAuthors({ db: deps.db, http, loginWaitMs: CREDIT_WAIT_MS }, turn).catch(() => []);
  if (lines.length === 0) return "";
  return `Commits you make this turn: end each commit message with the line${lines.length > 1 ? "s" : ""} ${lines.join(" and ")}`;
}

/** The most a turn waits for GitHub to name the person its commits credit (`creditLine`). */
export const CREDIT_WAIT_MS = 1_000;

/** What a chat turn needs from `prepareAgentCode`. */
export interface CodeTurn {
  orgId: string;
  agentId: string;
  threadRootId: string | null;
  trigger: string;
  messages: ReadonlyArray<{ content: string }>;
  session?: { machineId: string; cwd: string; ownFolder?: boolean } | undefined;
  /** Its run: the person behind it gets the credit for its commits. */
  runId?: string;
  /** The turn's tools: its line on the way (`say_now`) is spoken of only when it has it. */
  tools?: ReadonlyArray<{ name: string }>;
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * What the computer knows after a sync: each answered checkout as answered, a failed one with its failures in a row
 * and when it may be tried again (`CHECKOUT_BACKOFF_MS`, doubling, at most `CHECKOUT_BACKOFF_MAX_MS`), and the ones
 * this sync left alone for their backoff as they were. A checkout neither answered nor waiting is gone from the disk.
 */
export function mergeCheckouts(
  before: readonly KnownCheckout[],
  answered: readonly GitSyncRepo[],
  now: number,
): KnownCheckout[] {
  const out: KnownCheckout[] = answered.map((r) => {
    if (r.status !== "failed") return { ...r };
    const last = before.find((b) => sameRepo(b.repo, r.repo));
    const failures = (last?.failures ?? 0) + 1;
    const wait = Math.min(CHECKOUT_BACKOFF_MS * 2 ** (failures - 1), CHECKOUT_BACKOFF_MAX_MS);
    // Where it is and what it had stay known through a failure that didn't say.
    return { ...last, ...r, failures, retryAt: now + wait };
  });
  for (const b of before) {
    if ((b.retryAt ?? 0) > now && !out.some((o) => sameRepo(o.repo, b.repo))) out.push(b);
  }
  return out;
}

/** The syncs (and credential refreshes) this process started, by agent and computer: `wait_for_code` waits for its own. */
const syncing = new Map<string, Promise<KnownCheckout[] | null>>();

/** Every sync this process started, ended (tests: nothing writes after the database closes). */
export async function settleCheckoutSyncs() {
  while (syncing.size > 0) await Promise.all([...syncing.values()]);
}

const checkoutKey = (where: { agentId: string; machineId: string }) =>
  and(eq(schema.agentCheckouts.agentId, where.agentId), eq(schema.agentCheckouts.machineId, where.machineId));

/**
 * This process's turn to sync the agent's checkouts on the computer: true, with the start recorded, when no process
 * started one in the last `gapMs`. One statement, so of the processes that ask at once only one gets it.
 */
async function claimCheckoutSync(
  db: Database,
  at: { orgId: string; agentId: string; machineId: string },
  now: Date,
  gapMs: number,
): Promise<boolean> {
  const t = schema.agentCheckouts;
  const rows = await db
    .insert(t)
    .values({ ...at, syncStartedAt: now, credentialAt: now })
    .onConflictDoUpdate({
      target: [t.agentId, t.machineId],
      set: { syncStartedAt: now, credentialAt: now },
      setWhere: or(isNull(t.syncStartedAt), lte(t.syncStartedAt, new Date(now.getTime() - gapMs))),
    })
    .returning({ agentId: t.agentId });
  return rows.length > 0;
}

/** The tool a turn calls to wait for its checkouts' update running beside it (`waitForCheckouts`). */
export const WAIT_FOR_CODE_TOOL = "wait_for_code";
/** How long `wait_for_code` waits for a sync: the computer's bound and the request's margin. */
export const CHECKOUT_WAIT_MS = (CHECKOUT_SYNC_SECONDS + 15) * 1000;
/** A sync that started this recently is the newest `wait_for_code` gets: it starts no other. */
export const CHECKOUT_FRESH_MS = 30_000;

type CheckoutRow = typeof schema.agentCheckouts.$inferSelect;

/** Another process's sync of these checkouts is still on (it started, hasn't answered, and is within its bound). */
const syncedElsewhere = (row: CheckoutRow | undefined, now: Date) =>
  Boolean(
    row?.syncStartedAt &&
      (!row.syncedAt || row.syncedAt < row.syncStartedAt) &&
      now.getTime() - row.syncStartedAt.getTime() < CHECKOUT_WAIT_MS,
  );

/** Where the agent's git runs on the computer, each git host's setup GitHub first; null when nothing can run there. */
async function gitOn(deps: MachineGitDeps, orgId: string, agentId: string, machineId: string) {
  const status = await deps.hub.status(machineId);
  if (!status || machineGitUnavailable(status, orgId)) return null;
  // Every git host the workspace connected and this agent may read (ADR 0227), GitHub first: each one's checkouts
  // sync through that host's own proxy address.
  const setups = (
    await Promise.all(
      GIT_HOST_IDS.map(async (host) => {
        const setup = await machineGitSetup(deps, orgId, agentId, machineId, undefined, host);
        return setup ? [{ host, setup }] : [];
      }),
    )
  ).flat();
  const first = setups[0];
  return first ? { status, setups, first, github: setups.find((x) => x.host === "github")?.setup } : null;
}

type GitOn = NonNullable<Awaited<ReturnType<typeof gitOn>>>;

/** The repositories a sync of the agent's checkouts asks for, from its list (`agentRepositoryList`). */
async function checkoutList(deps: MachineGitDeps, orgId: string, agentId: string, git: GitOn) {
  const every = await agentRepositoryList(deps.db, orgId, agentId);
  // GitHub's part of the list, as it always was: other hosts' entries are synced after it, by name only.
  const list = every.filter((r) => hostOfEntry(r) === "github");
  const others = every.filter((r) => hostOfEntry(r) !== "github" && !r.endsWith("/*"));
  const explicit = list.filter((r) => !r.endsWith("/*"));
  // An `owner/*` (or all) grant names no repository: its checkouts are found on the computer.
  const wildcard = every.length === 0 || list.length > explicit.length;
  // Other hosts' checkouts by host; a path an older runner refuses would fail the whole sync: it is cloned by name,
  // with `git_clone`.
  const otherRefs = others.flatMap((name) => {
    const ref = parseRepoRef(name);
    return ref && ref.host !== "github" && (isGitRepoName(ref.path) || git.status.protocol >= GIT_HOST_PATH_PROTOCOL)
      ? [ref]
      : [];
  });
  // Only what a sync can answer counts: a repository of a host with no git setup here (or past the request's
  // limit) is never answered, and would otherwise make every turn sync again.
  const answerable = [
    ...(git.github ? explicit.slice(0, GIT_SYNC_LIMITS.repos) : []),
    ...git.setups.flatMap(({ host }) =>
      host === "github"
        ? []
        : otherRefs
            .filter((ref) => ref.host === host)
            .slice(0, GIT_SYNC_LIMITS.repos)
            .map(repoRefName),
    ),
  ];
  return { every, explicit, others, wildcard, otherRefs, answerable };
}

type CheckoutList = Awaited<ReturnType<typeof checkoutList>>;

/** The computer's `git.sync` for one host's setup. */
const syncOn = (
  deps: MachineGitDeps,
  machineId: string,
  { agent, ...rest }: GitOn["first"]["setup"],
  repos: GitSyncRequest["repos"],
  existing: boolean,
) =>
  deps.hub.call(
    machineId,
    { op: "git.sync", agent, ...rest, repos, ...(existing ? { existing } : {}), timeoutSeconds: CHECKOUT_SYNC_SECONDS },
    { timeoutMs: (CHECKOUT_SYNC_SECONDS + 15) * 1000 },
  );

/**
 * A sync (fetch + fast-forward of each default branch) of the agent's checkouts, started now in this process and
 * kept in `syncing` until it ends; what it found is written for every process's next turn. A repository still in its
 * backoff after a failure is left out. Never throws: a sync that fails resolves null.
 */
function startCheckoutSync(
  deps: MachineGitDeps,
  at: { orgId: string; agentId: string; machineId: string },
  git: GitOn,
  list: CheckoutList,
  before: readonly KnownCheckout[],
  now: Date,
): Promise<KnownCheckout[] | null> {
  const { machineId } = at;
  const { status, setups, github } = git;
  const sync = async (): Promise<KnownCheckout[] | null> => {
    const waiting = new Set(before.filter((b) => (b.retryAt ?? 0) > now.getTime()).map((b) => b.repo.toLowerCase()));
    const due = (repo: string) => !waiting.has(repo.toLowerCase());
    const found =
      list.wildcard && deps.github && status.protocol >= GIT_STATELESS_TOKEN_PROTOCOL
        ? await checkoutsOnMachine(deps.hub, machineId, git.first.setup.agent)
        : [];
    // A repository in its backoff is left out, so the computer isn't asked for every checkout it has
    // (`existing`): the others it knows of are named instead.
    const named = waiting.size > 0 ? before.map((b) => b.repo).filter((r) => isGitRepoName(r)) : [];
    const repos: string[] = [];
    for (const r of [...list.explicit, ...found, ...named]) {
      if (due(r) && !repos.some((x) => sameRepo(x, r))) repos.push(r);
    }
    const asked = repos.slice(0, GIT_SYNC_LIMITS.repos);
    // Fresh each sync (GitHub's tokens last an hour; cached until a few minutes before), so the agent's own
    // `git fetch` keeps working between syncs.
    const tokens = github ? await directFetchTokens(deps, at, status.protocol, asked) : new Map<string, string>();
    // A sync the computer didn't answer fails each repository it asked for, so each one waits out its backoff.
    const failedAll = (request: GitSyncRequest["repos"], error: unknown) => ({
      repos: request.map(
        ({ repo, dir }): GitSyncRepo => ({
          repo,
          dir,
          status: "failed",
          message: (error instanceof Error ? error.message : String(error)).slice(0, GIT_SYNC_LIMITS.message),
        }),
      ),
    });
    const answered: GitSyncRepo[] = [];
    if (github) {
      const request = asked.map((repo) => {
        const token = tokens.get(repo);
        return { repo, dir: gitCheckoutDir(repo), clone: false, ...(token ? { github: token } : {}) };
      });
      const reply = await syncOn(deps, machineId, github, request, waiting.size === 0).catch((e: unknown) =>
        failedAll(request, e),
      );
      answered.push(...reply.repos);
    }
    for (const { host, setup } of setups) {
      if (host === "github") continue;
      const refs = list.otherRefs.filter((ref) => ref.host === host && due(repoRefName(ref)));
      if (refs.length === 0) continue;
      const request = refs
        .slice(0, GIT_SYNC_LIMITS.repos)
        .map((ref) => ({ repo: ref.path, dir: checkoutDirOf(ref), clone: false }));
      const reply = await syncOn(deps, machineId, setup, request, false).catch((e: unknown) => failedAll(request, e));
      for (const r of reply.repos) answered.push({ ...r, repo: repoRefName({ host, path: r.repo }) });
    }
    const done = deps.now?.() ?? new Date();
    const merged = mergeCheckouts(before, answered, done.getTime());
    await deps.db.update(schema.agentCheckouts).set({ repos: merged, syncedAt: done }).where(checkoutKey(at));
    return merged;
  };
  const key = `${at.agentId}\0${machineId}`;
  const running = sync()
    .catch(() => null)
    .finally(() => syncing.delete(key));
  syncing.set(key, running);
  return running;
}

/**
 * What the turn's prompt says of its checkouts' freshness: an update running now, and how the agent gets the newest
 * code when the task needs it (`wait_for_code`, after its line on the way when people read one), or when the last one
 * ended. Never a wait of the turn's own: the agent decides whether the task needs the code.
 */
export function freshnessLine(input: {
  syncedAt: Date | null;
  updating: boolean;
  /** No sync answered yet: the checkouts listed may be missing some. */
  nothingKnown: boolean;
  /** The turn can post its line on the way (`say_now`). */
  sayNow: boolean;
  now: Date;
}): string {
  if (!input.updating)
    return input.syncedAt ? `Your checkouts were last updated ${ago(input.syncedAt, input.now.getTime())}.` : "";
  const lead =
    input.nothingKnown || !input.syncedAt
      ? "Your checkouts on this computer are being found and updated right now: what this turn says of them may be missing some."
      : `Your checkouts are being updated right now (last updated ${ago(input.syncedAt, input.now.getTime())}).`;
  const first = input.sayNow
    ? `, after telling the person in one short line (${SAY_NOW_TOOL}), in their language, that you'll look at the latest code`
    : "";
  return `${lead} When the task needs the code, call ${WAIT_FOR_CODE_TOOL} before you read or change it${first}; a turn that doesn't touch the code needs no wait.`;
}

/**
 * Before a chat turn of a computer brain (Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity, Devin) on a
 * connected machine: where the turn starts (the repository the conversation names, else the agent's first
 * repository, else its first checkout), the "# Your code" block for the system text and, for the turn's own prompt,
 * where it starts ("You start in …") and how fresh its checkouts are, from the checkouts as their last sync left them
 * (`agent_checkouts`). Database reads only: the turn never waits on the computer here.
 *
 * The sync itself (fetch + fast-forward of the default branch) runs beside the turn, at most once every
 * `CHECKOUT_SYNC_EVERY_MS` whichever process runs it (at once while the checkouts aren't known yet), skipping a
 * repository still in its backoff after a failure; the next turn reads how it went. A turn whose task needs the code
 * is told the update is on and waits for it itself (`wait_for_code`), after saying so; it can pull by itself too.
 *
 * Null when there is nothing to do: a mission turn (it has its own folder; only the computer's proxy credential is
 * refreshed, beside the turn), an older runner, no GitHub or no git access, or nothing granted or checked out.
 */
export async function prepareAgentCode(deps: MachineGitDeps, turn: CodeTurn): Promise<CodeSetup | null> {
  const machineId = turn.session?.machineId;
  if (!machineId) return null;
  try {
    const git = await gitOn(deps, turn.orgId, turn.agentId, machineId);
    if (!git) return null;
    const now = deps.now?.() ?? new Date();
    const at = { orgId: turn.orgId, agentId: turn.agentId, machineId };
    const [row] = await deps.db.select().from(schema.agentCheckouts).where(checkoutKey(at));
    // A chat turn starts in the agent's folder (""); a mission's turn (its thread) works in the mission's own folder;
    // a session started afresh there because its folder was gone stays there. Those update no checkout, but their
    // pushes go through the proxy too: the computer's credential (6 h) is refreshed for them all the same.
    const chat =
      turn.session?.cwd === "" &&
      !turn.session.ownFolder &&
      !(turn.threadRootId && (await missionOfRun({ db: deps.db, ...turn, threadRootId: turn.threadRootId })));
    if (!chat) {
      const age = row?.credentialAt ? now.getTime() - row.credentialAt.getTime() : Number.POSITIVE_INFINITY;
      const credentialKey = `${turn.agentId}\0${machineId}\0credential`;
      if (age < CHECKOUT_SYNC_EVERY_MS || syncing.has(credentialKey)) return null;
      // One credential serves every host's proxy address: refreshed once, beside the turn. Its first git command comes
      // after the CLI's start and the model's first answer, long after the computer has the new one.
      const refresh = syncOn(deps, machineId, git.first.setup, [], false)
        .then(() =>
          deps.db
            .insert(schema.agentCheckouts)
            .values({ ...at, credentialAt: now })
            .onConflictDoUpdate({
              target: [schema.agentCheckouts.agentId, schema.agentCheckouts.machineId],
              set: { credentialAt: now },
            }),
        )
        .then(() => null)
        .catch(() => null)
        .finally(() => syncing.delete(credentialKey));
      syncing.set(credentialKey, refresh);
      return null;
    }
    const [credit, list] = await Promise.all([
      creditLine(deps, turn),
      checkoutList(deps, turn.orgId, turn.agentId, git),
    ]);
    const known = row?.syncedAt ? row.repos : null;
    const unknown = !known || list.answerable.some((r) => !known.some((k) => sameRepo(k.repo, r)));
    const key = `${turn.agentId}\0${machineId}`;
    let updating = syncing.has(key) || syncedElsewhere(row, now);
    if (!updating && (await claimCheckoutSync(deps.db, at, now, unknown ? 0 : CHECKOUT_SYNC_EVERY_MS))) {
      void startCheckoutSync(deps, at, git, list, known ?? [], now);
      updating = true;
    }
    const fresh = freshnessLine({
      syncedAt: row?.syncedAt ?? null,
      updating,
      nothingKnown: !known,
      sayNow: Boolean(turn.tools?.some((t) => t.name === SAY_NOW_TOOL)),
      now,
    });
    // Nothing known yet: no repository is said to be missing from a computer that may well have it.
    return codeSetupOf(known ?? [], {
      turn,
      every: list.every,
      explicit: known ? list.explicit : [],
      others: known ? list.others : [],
      credit,
      fresh,
      updating,
      handle: git.first.setup.agent.handle,
    });
  } catch {
    // Offline, slow, refused: the turn goes on in the agent's folder, as before.
    return null;
  }
}

/** What `wait_for_code` found: the checkouts as the update left them, and whether it ended within the wait. */
export interface CheckoutsWaited {
  checkouts: KnownCheckout[];
  syncedAt: Date | null;
  /** The update ended within `CHECKOUT_WAIT_MS` (or one ended moments ago); false: still running, these are older. */
  done: boolean;
}

/**
 * `wait_for_code`: waits for the update of the agent's checkouts running beside its turn, in this process (`syncing`)
 * or another (`agent_checkouts` says it started and hasn't answered), `CHECKOUT_WAIT_MS` at most; when none runs and
 * none started in the last `CHECKOUT_FRESH_MS`, starts one and waits for it. A mission's credential refresh started
 * here is waited for too. Null when git can't run on the computer (`machineGitUnavailable` says why).
 */
export async function waitForCheckouts(
  deps: MachineGitDeps,
  at: { orgId: string; agentId: string; machineId: string },
  signal?: AbortSignal,
): Promise<CheckoutsWaited | null> {
  const git = await gitOn(deps, at.orgId, at.agentId, at.machineId);
  if (!git) return null;
  const key = `${at.agentId}\0${at.machineId}`;
  const read = async () => (await deps.db.select().from(schema.agentCheckouts).where(checkoutKey(at)))[0];
  const now = deps.now?.() ?? new Date();
  let running: Promise<unknown> | undefined = syncing.get(key);
  if (!running) {
    const row = await read();
    if (syncedElsewhere(row, now)) {
      const started = row?.syncStartedAt as Date;
      const until = Date.now() + CHECKOUT_WAIT_MS;
      running = (async () => {
        while (Date.now() < until && !signal?.aborted) {
          await Bun.sleep(500);
          const r = await read();
          if (!r || (r.syncedAt && r.syncedAt >= started)) return;
        }
      })();
    } else if (await claimCheckoutSync(deps.db, at, now, CHECKOUT_FRESH_MS)) {
      const list = await checkoutList(deps, at.orgId, at.agentId, git);
      running = startCheckoutSync(deps, at, git, list, row?.syncedAt ? row.repos : [], now);
    }
  }
  const credential = syncing.get(`${key}\0credential`);
  let done = true;
  if (running || credential) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), CHECKOUT_WAIT_MS);
      signal?.addEventListener("abort", () => resolve(false), { once: true });
    });
    done = await Promise.race([Promise.all([running, credential]).then(() => true), limit]);
    clearTimeout(timer);
  }
  const row = await read();
  const list = await agentRepositoryList(deps.db, at.orgId, at.agentId);
  return {
    checkouts: (row?.repos ?? []).filter((r) => refInList(list, r.repo)),
    syncedAt: row?.syncedAt ?? null,
    done,
  };
}

/** A turn's code setup from the checkouts the computer has (`prepareAgentCode`). */
function codeSetupOf(
  known: readonly KnownCheckout[],
  input: {
    turn: CodeTurn;
    every: readonly string[];
    explicit: readonly string[];
    others: readonly string[];
    credit: string;
    /** How fresh the checkouts are (`freshnessLine`), for the turn's prompt. */
    fresh: string;
    /** An update of them is on: said even while none is known. */
    updating: boolean;
    handle: string;
  },
): CodeSetup | null {
  const { every, credit } = input;
  const present = known.filter((r) => {
    const there = r.status === "cloned" || r.status === "updated" || (r.status === "failed" && Boolean(r.head));
    // Only what the agent may still use (a repository removed from its list stays on disk, unmentioned).
    return there && refInList(every, r.repo);
  });
  const downloading = known.filter((r) => r.status === "cloning" && refInList(every, r.repo)).map((r) => r.repo);
  const lower = new Set(present.map((r) => r.repo.toLowerCase()));
  const coming = new Set(downloading.map((r) => r.toLowerCase()));
  // A failed update is of a checkout that is there (a missing one answers `missing`), even when the failure left
  // no HEAD to tell (the computer didn't answer, the bound ran out): it isn't offered to clone again.
  const failed = new Set(known.filter((r) => r.status === "failed").map((r) => r.repo.toLowerCase()));
  const notCloned = [...input.explicit, ...input.others].filter(
    (r) => !lower.has(r.toLowerCase()) && !coming.has(r.toLowerCase()) && !failed.has(r.toLowerCase()),
  );
  const listed = present.length > 0 || notCloned.length > 0 || downloading.length > 0;
  // An agent with no checkout here hears nothing of their freshness, unless they are being looked for.
  const fresh = listed || input.updating ? input.fresh : "";
  const primary = input.explicit.find((r) => lower.has(r.toLowerCase()));
  const pick = {
    present: present.map((r) => ({ repo: r.repo, dir: r.dir, ...(r.path ? { path: r.path } : {}) })),
    ...(primary ? { primary } : {}),
    ...(credit ? { credit } : {}),
    ...(fresh ? { fresh } : {}),
  };
  if (!listed) return credit || fresh ? { ...codeStart(pick, input.turn), prompt: "", pick } : null;
  const checkouts: CodeCheckout[] = present.map((r) => ({
    repo: r.repo,
    path: r.path ?? r.dir,
    ...(r.defaultBranch ? { defaultBranch: r.defaultBranch } : {}),
    ...(r.status === "failed" ? { stale: r.message || "the update failed" } : {}),
  }));
  const prompt = codePrompt({ handle: input.handle, checkouts, notCloned, downloading });
  return { ...codeStart(pick, input.turn), prompt, pick };
}
