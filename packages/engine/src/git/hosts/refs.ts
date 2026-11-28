/**
 * How a repository is named, whatever git host it lives on (ADR 0227). GitHub's keep the name they always had,
 * `owner/name`; a repository anywhere else carries its host first: `gitlab:group/sub/project`,
 * `bitbucket:workspace/repo`, `git:team/project` (a git server by address). The same string is kept on a code
 * session, in an agent's repositories and in a push grant, so nothing that stored `owner/name` changes meaning.
 *
 * No imports: the proxy, the tools, the sessions and the apps' routes all read names through this file.
 */

/** The connector ids that are git hosts, GitHub first (the one a bare `owner/name` means). */
export const GIT_HOST_IDS = ["github", "gitlab", "bitbucket", "git"] as const;
export type GitHostId = (typeof GIT_HOST_IDS)[number];

export const isGitHostId = (v: unknown): v is GitHostId => (GIT_HOST_IDS as readonly string[]).includes(v as string);

export interface RepoRef {
  host: GitHostId;
  /** The repository's path on its host, as the host spells it: `owner/name`, `group/sub/project`. */
  path: string;
}

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;

/** How many `/`-separated parts a repository's path has on each host. */
const DEPTH: Record<GitHostId, { min: number; max: number }> = {
  github: { min: 2, max: 2 },
  // A project sits under a group and up to twenty subgroups.
  gitlab: { min: 2, max: 21 },
  bitbucket: { min: 2, max: 2 },
  // A server by address serves what its paths say: `project.git`, `team/project.git`, `org/project/_git/repo`.
  git: { min: 1, max: 8 },
};

/**
 * A repository path as its host takes it, or null: letters, digits, `_`, `.` and `-` in each part, never `.` or `..`
 * (they would climb out of the checkouts' folder), a trailing slash dropped, and a trailing `.git` where the host
 * adds it by itself.
 */
/** A text without the slashes around it (no expression: what people type may be long). */
function unslashed(text: string) {
  let from = 0;
  let to = text.length;
  while (from < to && text[from] === "/") from++;
  while (to > from && text[to - 1] === "/") to--;
  return text.slice(from, to);
}

/** Nothing a person types as a repository is longer than this. */
const NAME_CHARS = 2000;

export function repoPathOn(host: GitHostId, input: string): string | null {
  if (input.length > NAME_CHARS) return null;
  const trimmed = unslashed(input.trim());
  // A server by address serves exactly the path it was given, `.git` and all.
  const path = host === "git" ? trimmed : trimmed.replace(/\.git$/i, "");
  const parts = path.split("/");
  const { min, max } = DEPTH[host];
  if (parts.length < min || parts.length > max) return null;
  if (parts.some((p) => !SEGMENT.test(p) || p === "." || p === "..")) return null;
  return path;
}

/**
 * Whether a session's `repo` names a repository on a host: a project that lives only on the agent's computer is a
 * plain name, with neither a slash nor a host before it.
 */
export const isHostedRepo = (name: string) => name.includes("/") || name.includes(":");

/** The stored name of a repository: `owner/name` on GitHub, `host:path` anywhere else. */
export const repoRefName = (ref: RepoRef) => (ref.host === "github" ? ref.path : `${ref.host}:${ref.path}`);

/** A project's path in an address, without GitLab's pages of it (`group/project/-/merge_requests/3`). */
function beforePages(path: string) {
  const at = path.indexOf("/-/");
  return at < 0 ? path : path.slice(0, at);
}

/** The sites whose addresses name a repository by themselves (a server by address is told by its connection). */
const SITES: Record<string, GitHostId> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
};

/**
 * A repository as a person or an agent names it: `owner/name` (GitHub), `gitlab:group/project`, or its address on
 * github.com, gitlab.com or bitbucket.org (https or `git@host:`). Null when it names none.
 */
export function parseRepoRef(input: string): RepoRef | null {
  if (input.length > NAME_CHARS) return null;
  const s = input.trim();
  const prefixed = /^([a-z]+):(?!\/\/)(.+)$/.exec(s);
  if (prefixed && isGitHostId(prefixed[1])) {
    const path = repoPathOn(prefixed[1], prefixed[2] as string);
    return path ? { host: prefixed[1], path } : null;
  }
  const address = /^(?:https:\/\/(?:[^@/]+@)?|git@)([A-Za-z0-9.-]+)[/:](.+)$/.exec(s);
  if (address) {
    const host = SITES[(address[1] as string).toLowerCase()];
    if (!host) return null;
    // GitLab's pages of a project go on after `/-/` (`group/project/-/merge_requests/3`).
    const path = repoPathOn(host, beforePages(address[2] as string));
    return path ? { host, path } : null;
  }
  const path = repoPathOn("github", s);
  return path ? { host: "github", path } : null;
}

/** A repository of a server by address, from its address there (`https://git.acme.dev/team/project.git`), or null. */
export function repoRefAt(host: GitHostId, serverUrl: string, input: string): RepoRef | null {
  let base: URL;
  let given: URL;
  try {
    base = new URL(serverUrl);
    given = new URL(input.trim());
  } catch {
    return null;
  }
  if (given.host.toLowerCase() !== base.host.toLowerCase()) return null;
  const under = base.pathname === "/" ? "" : `/${unslashed(base.pathname)}`;
  if (under && !given.pathname.startsWith(`${under}/`)) return null;
  const path = repoPathOn(host, beforePages(given.pathname.slice(under.length)));
  return path ? { host, path } : null;
}

/**
 * An entry of an agent's repositories: a repository, or everything under an account or group (`owner/*`,
 * `gitlab:group/*`). Returned as it is stored, or null when it is neither.
 */
export function repoEntry(input: string): string | null {
  if (input.length > NAME_CHARS) return null;
  const typed = input.trim();
  // Trailing slashes only: `x` keeps what it starts with.
  const s = unslashed(`x${typed}`).slice(1);
  if (!s.endsWith("/*")) {
    const ref = parseRepoRef(s);
    return ref ? repoRefName(ref) : null;
  }
  const whole = s.slice(0, -2);
  const prefixed = /^([a-z]+):(.+)$/.exec(whole);
  const host: GitHostId = prefixed && isGitHostId(prefixed[1]) ? prefixed[1] : "github";
  const under = prefixed && isGitHostId(prefixed[1]) ? (prefixed[2] as string) : whole;
  const parts = under.split("/");
  // Whatever sits under it must still be a repository there: GitHub and Bitbucket have accounts only, one part.
  if (parts.length > DEPTH[host].max - 1 || parts.some((p) => !SEGMENT.test(p) || p === "." || p === "..")) return null;
  return `${repoRefName({ host, path: under })}/*`;
}

/** Whether a repository's stored name is in the list (an empty list allows everything). Capitals don't count. */
export function refInList(list: readonly string[], name: string) {
  if (list.length === 0) return true;
  const full = name.toLowerCase();
  return list.some((entry) => {
    const e = entry.toLowerCase();
    return e === full || (e.endsWith("/*") && full.startsWith(e.slice(0, -1)));
  });
}

/** Whether the list names anything on this host (an empty list reaches every host). */
export const listReaches = (list: readonly string[], host: GitHostId) =>
  list.length === 0 || list.some((entry) => hostOfEntry(entry) === host);

/** The host an entry of the list is on. */
export function hostOfEntry(entry: string): GitHostId {
  const prefixed = /^([a-z]+):/.exec(entry);
  return prefixed && isGitHostId(prefixed[1]) ? prefixed[1] : "github";
}

/** The folder checkouts live in, on the agent's computer. */
const CHECKOUTS = "repos";

/**
 * Where a repository is checked out, relative to the agent's folder: `repos/owner/name` for GitHub's, as always;
 * `repos/_gitlab/group/project` for another host's. No GitHub account starts with `_`, so the two never meet.
 */
export const checkoutDirOf = (ref: RepoRef) =>
  ref.host === "github" ? `${CHECKOUTS}/${ref.path}` : `${CHECKOUTS}/_${ref.host}/${ref.path}`;

/** The git tools agents get on a host's connection, each with the scope of that connector it needs. */
export const GIT_TOOL_SCOPES = {
  git_clone: "git.read",
  open_pull_request: "pr.write",
  delete_branches: "git.write",
  request_branch_push: "git.write",
} as const;
export type GitVerb = keyof typeof GIT_TOOL_SCOPES;

/**
 * A git tool's name on a host: GitHub's are the plain ones (`git_clone`), as they always were; another host's carry
 * it first (`gitlab_git_clone`, `gitserver_git_clone` for a git server by address), so two hosts' tools never share a
 * name and an approval or a denial stays with the host it was given on.
 */
export const gitToolName = (host: GitHostId, verb: GitVerb) =>
  host === "github" ? verb : `${host === "git" ? "gitserver" : host}_${verb}`;

/**
 * Which git tool of ours a tool is, by its exact name and scope (`gitlab_git_clone` + `gitlab:git.read`), or null:
 * they carry a connection only for its credential, and are never a connected app's own tools.
 */
export function gitVerbOf(tool: { name: string; scope: string }): GitVerb | null {
  const at = tool.scope.indexOf(":");
  const host = tool.scope.slice(0, at);
  if (at < 0 || !isGitHostId(host)) return null;
  const scope = tool.scope.slice(at + 1);
  for (const verb of Object.keys(GIT_TOOL_SCOPES) as GitVerb[]) {
    if (GIT_TOOL_SCOPES[verb] === scope && tool.name === gitToolName(host, verb)) return verb;
  }
  return null;
}
