import type { GitHostId } from "./refs";

/**
 * A git host (ADR 0227): everything the proxy, the git tools and the code sessions need to know about where
 * repositories live, behind one contract. GitHub is the first one; GitLab, Bitbucket and a git server by address
 * are the others. What agents may do is decided once, above this contract (their own branch, fast-forward only, no
 * tags, a person's approval for someone else's branch): a host only answers questions and carries out what was
 * already allowed.
 *
 * A host that has no answer for a question leaves the method out, and whoever asks takes the careful way: no
 * repository list means the person types the name, no ancestry answer means a push must carry its own history, no
 * pull request call means the agent hands over the link the server printed.
 */

/** Where one connection's host is reached. */
export interface HostAt {
  fetch: typeof fetch;
  /** Its REST API, no trailing slash (`https://api.github.com`, `https://gitlab.com/api/v4`). */
  api: string;
  /** Its git over HTTPS, no trailing slash (`https://github.com`). */
  git: string;
  /** Its site's name, for an address made from an account (`gitlab.com`). */
  site: string;
}

/** An account on a host, as its connection keeps it (`account_id`, `account_label`). */
export interface HostAccount {
  id: string;
  login: string;
}

export interface HostRepository {
  /** Its path on the host (`group/sub/project`). */
  path: string;
  /** The account, workspace or group it sits under (`group/sub`), and what kind that is. */
  under: string;
  kind: "Organization" | "User";
  name: string;
  private: boolean;
  /** Last activity, ISO; null when the host didn't say. */
  updatedAt: string | null;
}

export interface PullRequestInput {
  head: string;
  /** Empty: the repository's default branch. */
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export type PullRequestResult =
  | { ok: true; number: number; url: string | null }
  | { ok: false; status: number; message: string };

export interface GitHost {
  id: GitHostId;
  /** Its name, as people know it ("GitLab"). */
  label: string;
  /** What it calls a pull request, for the words agents and people read. */
  request: "pull request" | "merge request";
  /** Where it is reached for a connection (`server_url`; a host with one address ignores it). */
  at(serverUrl: string, http: typeof fetch): HostAt;
  /** A repository's address for git over HTTPS (`https://gitlab.com/group/project.git`). */
  remote(at: HostAt, path: string): string;
  /** The `user:password` git sends for a token (HTTP Basic), as the host takes that kind of token. */
  gitLogin(token: string): string;
  /** The headers its API takes for a token. */
  apiHeaders(token: string): Record<string, string>;
  /** The account a token is of, asked once when it is connected. Null: the host refused the token. */
  account?(at: HostAt, token: string): Promise<HostAccount | null>;
  /**
   * The address commits are authored with for an account, so the host shows them as that person's without their own
   * email in the history. Null when the host has no such address.
   */
  commitEmail?(at: HostAt, account: HostAccount): string | null;
  /** The repositories a token reaches, newest first. */
  repositories?(at: HostAt, token: string): Promise<{ repositories: HostRepository[]; truncated: boolean }>;
  /** The default branch and what guards each of `names`. Null when a question went unanswered (whoever asks refuses). */
  branchFacts(at: HostAt, token: string, path: string, names: readonly string[]): Promise<BranchFacts | null>;
  /** Whether `tip` descends from `base` (a fast-forward), for commits the push didn't carry. */
  descends?(at: HostAt, token: string, path: string, base: string, tip: string): Promise<boolean>;
  openPullRequest?(at: HostAt, token: string, path: string, input: PullRequestInput): Promise<PullRequestResult>;
  /** Deletes one branch. The host's status (2xx: gone), or null when it didn't answer. */
  deleteBranch?(at: HostAt, token: string, path: string, branch: string): Promise<number | null>;
}

/** A path in a REST address, each part escaped and the slashes kept. */
export const pathParts = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** An answer's JSON, or null when it has none. */
export const jsonOf = (res: Response) => res.json().catch(() => null) as Promise<unknown>;

export const basic = (login: string) => `Basic ${Buffer.from(login).toString("base64")}`;

/**
 * A branch as its host has it: missing (no branch by that exact name), or whether it is protected and the rules that
 * guard it (GitHub's rulesets by type; `push` and `deletion` where a host says only that much).
 */
export type BranchFact = { exists: false } | { exists: true; protected: boolean; rules: string[] };

export interface BranchFacts {
  defaultBranch: string;
  branches: Map<string, BranchFact>;
}

/** Ruleset rules about creating, deleting or force pushing a branch: the proxy decides those itself. */
const UPDATE_NEUTRAL_RULES = new Set(["creation", "deletion", "non_fast_forward"]);

export type BranchBlock = "missing" | "default" | "protected";

/**
 * What keeps agents off this branch, or null: missing, the default branch, or protected (classic protection, or a
 * ruleset's `deletion` rule when `deleting`, else any ruleset rule that guards updates).
 */
export function branchBlock(facts: BranchFacts, branch: string, deleting: boolean): BranchBlock | null {
  const fact = facts.branches.get(branch);
  if (!fact?.exists) return "missing";
  if (branch === facts.defaultBranch) return "default";
  const ruled = deleting ? fact.rules.includes("deletion") : fact.rules.some((r) => !UPDATE_NEUTRAL_RULES.has(r));
  return fact.protected || ruled ? "protected" : null;
}
