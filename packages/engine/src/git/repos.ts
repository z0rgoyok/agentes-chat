import type { MergeDone } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, schema } from "@agenteschat/db";
import { recordAgentActions } from "../agent-actions";
import { getAgent } from "../agents";
import { managesAgent, ownsAgent } from "../audience";
import { recordAudit } from "../audit";
import { fedByRoutine, runAuthorityById } from "../authority";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { requirePermission } from "../organizations";
import { approvalsLevelOf } from "../tools/run-policy";
import type { ToolContext } from "../tools/types";
import {
  GIT_HOSTS,
  type GitHostId,
  gitToolName,
  hostOfEntry,
  parseRepoRef,
  refInList,
  repoEntry,
  repoRefName,
} from "./hosts";

const { agentRepositories: table, agents } = schema;

/**
 * The repositories an agent may use (`agent_repositories`): an ordered list of `owner/name` or `owner/*` (a whole
 * account) on GitHub, and of `gitlab:group/project` or `gitlab:group/*` on another git host (ADR 0227). No list =
 * every repository the organization's git connections reach. The first entry is where the agent starts when nobody
 * names a repository. The git proxy checks it on every fetch and push, and the Tool Gateway on every GitHub call,
 * reads included.
 */

export const MAX_AGENT_REPOSITORIES = 100;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * "owner/name", "owner/*", a GitHub URL or "owner/name.git" → "owner/name" or "owner/*"; another host's repository or
 * group by its name there (`gitlab:group/project`, `gitlab:group/*`) or its address; null when it is none.
 */
export const normalizeRepoEntry = (input: string): string | null =>
  repoEntry(input.replace(/^https?:\/\/github\.com\//i, ""));

const REPO = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/;

/** "owner/name", "https://github.com/owner/name(.git)" → { owner, repo } or null. */
export function parseRepo(input: string) {
  const s = input
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\/$/, "");
  const m = REPO.exec(s);
  // "." and ".." name no GitHub owner or repository, and would climb out of the checkouts' folder (`gitCheckoutDir`).
  if (!m || [m[1], m[2]].some((part) => part === "." || part === "..")) return null;
  return { owner: m[1] as string, repo: m[2] as string };
}

/** Whether GitHub's `owner/repo` is in the list (an empty list allows everything). Case-insensitive, like GitHub. */
export const repoInList = (list: readonly string[], owner: string, repo: string) => refInList(list, `${owner}/${repo}`);

/**
 * The list as it is saved: valid entries, no repeats, no repository that an
 * `owner/*` of the list already covers. The order is kept.
 */
export function cleanRepoList(input: readonly string[]): { list: string[]; invalid: string[] } {
  const invalid: string[] = [];
  const valid: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const entry = normalizeRepoEntry(raw);
    if (!entry) {
      invalid.push(raw);
      continue;
    }
    if (seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    valid.push(entry);
  }
  const wholes = valid.filter((e) => e.endsWith("/*"));
  const list = valid.filter((e) => e.endsWith("/*") || !refInList(wholes.length > 0 ? wholes : ["\0"], e));
  return { list, invalid };
}

/** The agent's repositories in order (no permission check: for the proxy, the gateway and the prompt). */
export async function agentRepositoryList(db: Executor, orgId: string, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ repo: table.repo })
    .from(table)
    .where(and(eq(table.orgId, orgId), eq(table.agentId, agentId)))
    .orderBy(asc(table.position));
  return rows.map((r) => r.repo);
}

/** Whether every entry of `next` was already in reach with `current` (empty = every repository). */
function withinRepos(current: readonly string[], next: readonly string[]) {
  if (current.length === 0) return true;
  if (next.length === 0) return false;
  const have = new Set(current.map((e) => e.toLowerCase()));
  // A repository under an account or group already in reach, or the same entry.
  return next.every((entry) => have.has(entry.toLowerCase()) || (!entry.endsWith("/*") && refInList(current, entry)));
}

/** `GET …/agents/{id}/repositories` (any member). Empty = every repository. */
export async function getAgentRepositories(db: Database, actorId: string, orgId: string, agentId: string) {
  await requirePermission(db, actorId, orgId, "read");
  if (!(await getAgent(db, orgId, agentId))) throw new NotFoundError("Agent not found");
  return agentRepositoryList(db, orgId, agentId);
}

/**
 * `PUT …/agents/{id}/repositories`: replaces the list. Empty = every
 * repository. Who manages the agent (`managesAgent`, ADR 0085 addendum of
 * 2026-11-17) sets anything; its owner may only narrow it (each repository
 * already in reach), like its access. Audited.
 */
export async function setAgentRepositories(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  repositories: readonly string[],
) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  const admin = managesAgent(agent, actorId, membership);
  if (!admin && !ownsAgent(agent, actorId, membership.roleIds)) {
    throw new ForbiddenError("Only an admin or the agent's owner can change its repositories");
  }
  const { list, invalid } = cleanRepoList(repositories);
  if (invalid.length > 0) throw new ValidationError(`Not a repository (owner/name or owner/*): ${invalid.join(", ")}`);
  if (!admin && !withinRepos(await agentRepositoryList(db, orgId, agentId), list)) {
    throw new ForbiddenError("Only an admin can give an agent more repositories. Its owner can only take some away.");
  }
  if (list.length > MAX_AGENT_REPOSITORIES) {
    throw new ValidationError(`At most ${MAX_AGENT_REPOSITORIES} repositories per agent`);
  }
  await db.transaction(async (tx) => {
    await tx.delete(table).where(and(eq(table.orgId, orgId), eq(table.agentId, agentId)));
    if (list.length > 0) {
      await tx.insert(table).values(list.map((repo, position) => ({ orgId, agentId, repo, position })));
    }
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent.repositories_changed",
      target: { type: "agent", id: agentId },
      details: { repositories: list },
    });
  });
  return list;
}

/** Where "merge without asking" is on, as chosen, whether or not the agent still reaches each repository. */
async function chosenMergeRepos(db: Executor, orgId: string, agentId: string) {
  const [row] = await db
    .select({ repos: agents.mergeRepos })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  return row?.repos ?? [];
}

const inReach = (list: readonly string[], entry: string) => refInList(list, entry);

/**
 * The repositories this agent merges in without asking: what its owner or an admin chose, within its repositories
 * now (one taken away from the agent stops at once). Read fresh on every merge: turning one off asks at once.
 */
export async function agentMergeRepos(db: Executor, orgId: string, agentId: string): Promise<string[]> {
  const chosen = await chosenMergeRepos(db, orgId, agentId);
  if (chosen.length === 0) return [];
  const list = await agentRepositoryList(db, orgId, agentId);
  return chosen.filter((entry) => inReach(list, entry));
}

/**
 * Where this call may merge without asking: none outside a run (a mission keeps its own gates, and a receipt needs a
 * run), nor in a run a routine's reading woke, where text nobody checked feeds it and every write asks a person
 * (ADR 0053).
 */
export async function mergeReposOfCall(ctx: Pick<ToolContext, "db" | "orgId" | "agentId" | "runId">) {
  if (!ctx.runId) return [];
  const repos = await agentMergeRepos(ctx.db, ctx.orgId, ctx.agentId);
  if (repos.length === 0) return repos;
  // An agent that always asks (ADR 0173) asks for its merges too, whatever was chosen here.
  if ((await approvalsLevelOf(ctx.db, ctx.orgId, ctx.agentId)) === "always") return [];
  const authority = await runAuthorityById(ctx.db, ctx.orgId, ctx.runId);
  return authority.kind === "unattended" && fedByRoutine(authority) ? [] : repos;
}

/** `GET …/agents/{id}/merge-repositories` (who sees the agent's details). */
export async function getAgentMergeRepositories(db: Database, actorId: string, orgId: string, agentId: string) {
  await requirePermission(db, actorId, orgId, "read");
  if (!(await getAgent(db, orgId, agentId))) throw new NotFoundError("Agent not found");
  return agentMergeRepos(db, orgId, agentId);
}

/**
 * `PUT …/agents/{id}/merge-repositories`: replaces the list. Its owner or who manages it (`managesAgent`); exact
 * repositories only (never a whole account), each one the agent may use. Audited.
 */
export async function setAgentMergeRepositories(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  repositories: readonly string[],
) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  if (!managesAgent(agent, actorId, membership) && !ownsAgent(agent, actorId, membership.roleIds)) {
    throw new ForbiddenError("Only an admin or the agent's owner can change where it merges without asking");
  }
  const { list, invalid } = cleanRepoList(repositories);
  const whole = list.filter((entry) => entry.endsWith("/*"));
  if (invalid.length + whole.length > 0) {
    throw new ValidationError(`Not a repository (owner/name): ${[...invalid, ...whole].join(", ")}`);
  }
  const reach = await agentRepositoryList(db, orgId, agentId);
  const outside = list.filter((entry) => !inReach(reach, entry));
  if (outside.length > 0) throw new ValidationError(`The agent doesn't use ${outside.join(", ")}`);
  if (list.length > MAX_AGENT_REPOSITORIES) {
    throw new ValidationError(`At most ${MAX_AGENT_REPOSITORIES} repositories per agent`);
  }
  await db.transaction(async (tx) => {
    await tx
      .update(agents)
      .set({ mergeRepos: list })
      .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent.merge_repositories_changed",
      target: { type: "agent", id: agentId },
      details: { repositories: list },
    });
  });
  return list;
}

/** A merge done without a card: its line in the audit, and its receipt under the agent's reply (nothing to undo). */
export async function recordMergeDone(ctx: ToolContext, merge: MergeDone, tool: string) {
  await recordAudit(ctx.db, {
    orgId: ctx.orgId,
    actor: { type: "agent", id: ctx.agentId },
    action: "agent.merged_without_asking",
    target: { type: "repository", id: merge.repo },
    details: { pr: merge.pr, ref: merge.ref, tool },
    runId: ctx.runId || null,
    channelId: ctx.channelId || null,
  });
  await recordAgentActions(ctx.db, ctx, [
    {
      kind: "pr.merged",
      target: { type: "repository", id: merge.repo, title: merge.repo },
      params: { repo: merge.repo, ...(merge.pr ? { number: merge.pr } : {}), ...(merge.ref ? { ref: merge.ref } : {}) },
      final: true,
    },
  ]);
}

/**
 * The repositories a GitHub tool call names: `owner` + `repo` (GitHub's MCP
 * tools), `repo: "owner/name"` (git_clone, open_pull_request) or `repo:`
 * qualifiers of a search query. Null when it names none, or when a search
 * also reaches whole accounts (`org:`, `user:`).
 */
export function reposOfGithubCall(input: Record<string, unknown>): string[] | null {
  const owner = str(input.owner);
  const repo = str(input.repo);
  if (owner && repo) return NAME.test(owner) && NAME.test(repo) ? [`${owner}/${repo}`] : null;
  if (repo) {
    const entry = normalizeRepoEntry(repo);
    return entry && !entry.endsWith("/*") ? [entry] : null;
  }
  const query = str(input.query) || str(input.q);
  if (!query || /(^|\s)-?(org|user|owner):/i.test(query)) return null;
  const named = [...query.matchAll(/(?:^|\s)repo:(\S+)/gi)].map((m) => normalizeRepoEntry(m[1] ?? ""));
  if (named.length === 0 || named.some((r) => !r || r.endsWith("/*"))) return null;
  return named as string[];
}

export type GithubCallCheck =
  | { ok: true; repo: string | null }
  | { ok: false; repo: string | null; message: string; list: string[] };

/** Checks a GitHub tool call against the agent's repositories (the Tool Gateway, before running or asking). */
export async function checkGithubCall(
  db: Executor,
  orgId: string,
  agentId: string,
  input: Record<string, unknown>,
): Promise<GithubCallCheck> {
  const named = reposOfGithubCall(input);
  const list = await agentRepositoryList(db, orgId, agentId);
  if (list.length === 0) return { ok: true, repo: named?.[0] ?? null };
  if (!named) {
    return {
      ok: false,
      repo: null,
      list,
      message: `Not allowed: you may only use these GitHub repositories: ${list.join(", ")}. Name one of them in the call (owner and repo; in a search, repo: qualifiers only).`,
    };
  }
  const denied = named.find((full) => {
    const [o = "", r = ""] = full.split("/");
    return !repoInList(list, o, r);
  });
  if (denied) {
    return {
      ok: false,
      repo: denied,
      list,
      message: `Not allowed: ${denied} isn't one of your GitHub repositories (${list.join(", ")}). Tell the person; whoever can edit you can add it in your access settings. Don't try another way.`,
    };
  }
  return { ok: true, repo: named[0] ?? null };
}

/**
 * Checks a git tool call on another host (ADR 0227) against the agent's repositories: `repo` is that host's own
 * (`group/project`, or with the host first). The proxy checks every fetch and push the same way.
 */
export async function checkHostRepoCall(
  db: Executor,
  orgId: string,
  agentId: string,
  host: GitHostId,
  input: Record<string, unknown>,
): Promise<GithubCallCheck> {
  const given = str(input.repo);
  const ref = parseRepoRef(/^[a-z]+:/.test(given) ? given : `${host}:${given}`);
  const named = ref?.host === host ? repoRefName(ref) : null;
  const list = await agentRepositoryList(db, orgId, agentId);
  if (list.length === 0) return { ok: true, repo: named };
  if (!named) {
    return {
      ok: false,
      repo: null,
      list,
      message: `Not allowed: you may only use these repositories: ${list.join(", ")}. Name one of them in the call (repo).`,
    };
  }
  if (!refInList(list, named)) {
    return {
      ok: false,
      repo: named,
      list,
      message: `Not allowed: ${named} isn't one of your repositories (${list.join(", ")}). Tell the person; whoever can edit you can add it in your access settings. Don't try another way.`,
    };
  }
  return { ok: true, repo: named };
}

/** The prompt block for an agent limited to some repositories (English). Empty when it has no list. */
export function repositoriesPrompt(list: readonly string[]): string {
  if (list.length === 0) return "";
  const say = (r: string) => (r.endsWith("/*") ? `every repository of ${r.slice(0, -2)} (${r})` : r);
  const first = list[0] as string;
  return [
    "# Your repositories",
    `You may only use these repositories, reading included: ${list.map(say).join(", ")}.`,
    first.endsWith("/*")
      ? `When nobody names a repository, search the repositories of ${first.slice(0, -2)} first (search_code) and pick the one that fits; ask only if it stays unclear.`
      : `When nobody names a repository, work in ${first}.`,
    "Anything else is refused: say which repository you would need and that whoever can edit you can add it in your access settings.",
  ].join("\n");
}

/** A checkout of a repository on the agent's connected machine, as `git.sync` reported it. */
export interface CodeCheckout {
  /** `owner/name`. */
  repo: string;
  /** Where it is on the machine (absolute when the runner said, else relative to the agent's folder). */
  path: string;
  defaultBranch?: string;
  /** Why its last update failed (offline, refused…); absent when it went through. */
  stale?: string;
}

/**
 * The "# Your code" prompt block for an agent whose computer is a connected
 * machine (English): its checkouts (updated in the background between turns), how to change
 * code (its own branch, a push through our proxy, a pull request), and the
 * granted repositories not cloned yet. Empty when there is nothing to say.
 */
export function codePrompt(input: {
  handle: string;
  checkouts: readonly CodeCheckout[];
  /** Granted repositories (`owner/name`) with no checkout yet. */
  notCloned: readonly string[];
  /** Repositories still downloading on the computer (ADR 0116). */
  downloading?: readonly string[];
}): string {
  const downloading = input.downloading ?? [];
  if (input.checkouts.length === 0 && input.notCloned.length === 0 && downloading.length === 0) return "";
  const lines = ["# Your code"];
  for (const c of input.checkouts) {
    const branch = c.defaultBranch ? `default branch ${c.defaultBranch}` : "default branch";
    lines.push(
      c.stale
        ? `${c.repo} is checked out at ${c.path} (${branch}; its last update failed: ${c.stale}).`
        : `${c.repo} is checked out at ${c.path} (${branch}).`,
    );
  }
  if (input.checkouts.length > 0) {
    lines.push(
      "Checkouts are updated in the background, not right before each turn: when you need the newest commits of one, run git pull --ff-only there (on its default branch) or git fetch first.",
    );
  }
  // Each git host has its own tools (ADR 0227): GitHub's are the plain names, another host's carry it first.
  const hostsOf = (repos: readonly string[]) => [...new Set(repos.map(hostOfEntry))];
  const onlyGitHub = (hosts: readonly GitHostId[]) => hosts.every((h) => h === "github");
  const each = (hosts: readonly GitHostId[], say: (host: GitHostId) => string | null) =>
    hosts.flatMap((h) => {
      const said = say(h);
      return said ? [`${GIT_HOSTS[h].label}: ${said}`] : [];
    });
  if (input.checkouts.length > 0) {
    const hosts = hostsOf(input.checkouts.map((c) => c.repo));
    const start = `Read it freely; to change code, create a branch agentes/${input.handle}/<topic> there, push it (git push -u origin agentes/${input.handle}/<topic>)`;
    lines.push(
      onlyGitHub(hosts)
        ? `${start} and open a PR with open_pull_request. Delete branches with delete_branches; to push to someone else's branch, ask with request_branch_push first.`
        : `${start} and open a pull or merge request with the tool of the repository's host (${each(hosts, (h) =>
            GIT_HOSTS[h].openPullRequest
              ? gitToolName(h, "open_pull_request")
              : "give the person the link the server prints after the push",
          ).join(
            "; ",
          )}). Deleting branches (${each(hosts, (h) => (GIT_HOSTS[h].deleteBranch ? gitToolName(h, "delete_branches") : null)).join("; ")}) and pushing to someone else's branch (${each(hosts, (h) => gitToolName(h, "request_branch_push")).join("; ")}) are asked for with the host's tool first.`,
    );
  }
  const cloneWith = (repos: readonly string[]) => {
    const hosts = hostsOf(repos);
    return onlyGitHub(hosts)
      ? "git_clone"
      : `its host's clone tool (${each(hosts, (h) => gitToolName(h, "git_clone")).join("; ")})`;
  };
  if (input.notCloned.length > 0) {
    lines.push(
      `Not cloned yet: ${input.notCloned.join(", ")}. To work on one, call ${cloneWith(input.notCloned)} first; it needs no approval.`,
    );
  }
  if (downloading.length > 0) {
    lines.push(
      `Still downloading on your computer: ${downloading.join(", ")}. It goes on by itself; call ${cloneWith(downloading)} for one when you need it, to wait for it.`,
    );
  }
  return lines.join("\n");
}
