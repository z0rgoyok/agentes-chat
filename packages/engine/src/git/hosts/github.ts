import type { GitHubHttp } from "../github-app";
import { type BranchFact, type BranchFacts, type GitHost, jsonOf } from "./types";

type Repo = { owner: string; repo: string };

export const githubHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": "agentes.chat",
});

/** A branch name in a REST path: each part escaped, the slashes kept. */
export const branchPath = (name: string) => name.split("/").map(encodeURIComponent).join("/");

/** GitHub's rate limits: an answer that says nothing about the branch. */
const limited = (res: Response) =>
  res.status === 429 || res.headers.has("retry-after") || res.headers.get("x-ratelimit-remaining") === "0";

/**
 * What GitHub says about a repository's default branch and each of `names`, asked with the server's token: whether
 * the branch exists under that exact name, its classic protection and the ruleset rules that apply. Null when a
 * question went unanswered, and whoever asked refuses. Rules GitHub won't list for the repository (403 or 404, as on
 * a plan without rulesets) count as none: GitHub still enforces what it has.
 */
export async function branchFacts(
  http: GitHubHttp,
  token: string,
  repo: Repo,
  names: readonly string[],
): Promise<BranchFacts | null> {
  const base = `${http.apiUrl}/repos/${repo.owner}/${repo.repo}`;
  const get = (path: string) =>
    http.fetch(`${base}${path}`, { headers: githubHeaders(token), redirect: "manual" }).catch(() => null);
  const json = (res: Response) => res.json().catch(() => null) as Promise<unknown>;
  const fact = async (name: string): Promise<BranchFact | null> => {
    const [branch, rules] = await Promise.all([
      get(`/branches/${branchPath(name)}`),
      get(`/rules/branches/${branchPath(name)}`),
    ]);
    if (!branch || !rules) return null;
    // A renamed branch answers with a redirect to its new name.
    if (branch.status === 404 || (branch.status >= 300 && branch.status < 400)) return { exists: false };
    if (!branch.ok) return null;
    const body = (await json(branch)) as { name?: unknown; protected?: unknown } | null;
    if (!body) return null;
    if (body.name !== name) return { exists: false };
    let types: string[];
    if (rules.ok) {
      const list = await json(rules);
      if (!Array.isArray(list)) return null;
      types = list.map((r) => String((r as { type?: unknown } | null)?.type ?? ""));
    } else if ((rules.status === 403 || rules.status === 404) && !limited(rules)) types = [];
    else return null;
    return { exists: true, protected: body.protected === true, rules: types };
  };
  const info = get("").then(async (res) => (res?.ok ? ((await json(res)) as { default_branch?: unknown }) : null));
  const branches = new Map<string, BranchFact>();
  // Ten branches at a time: GitHub limits how many requests run at once.
  for (let i = 0; i < names.length; i += 10) {
    const chunk = names.slice(i, i + 10);
    const answers = await Promise.all(chunk.map(fact));
    for (const [j, answer] of answers.entries()) {
      if (!answer) return null;
      branches.set(chunk[j] as string, answer);
    }
  }
  const defaultBranch = (await info)?.default_branch;
  return typeof defaultBranch === "string" && defaultBranch ? { defaultBranch, branches } : null;
}

const repoOf = (path: string) => {
  const [owner = "", repo = ""] = path.split("/");
  return { owner, repo };
};

/** GitHub (ADR 0024, ADR 0156): the host every other one was drawn from. Its app's tokens are picked above this. */
export const githubHost: GitHost = {
  id: "github",
  label: "GitHub",
  request: "pull request",
  at: (_serverUrl, http) => ({
    fetch: http,
    api: "https://api.github.com",
    git: "https://github.com",
    site: "github.com",
  }),
  remote: (at, path) => `${at.git}/${path}.git`,
  gitLogin: (token) => `x-access-token:${token}`,
  apiHeaders: githubHeaders,
  async account(at, token) {
    const res = await at.fetch(`${at.api}/user`, { headers: githubHeaders(token) }).catch(() => null);
    const body = res?.ok ? ((await jsonOf(res)) as { id?: unknown; login?: unknown } | null) : null;
    return typeof body?.login === "string" && typeof body.id === "number"
      ? { id: String(body.id), login: body.login }
      : null;
  },
  // GitHub's no-reply address for an account: commits show as that person's, their email stays out of the history.
  commitEmail: (_at, account) =>
    /^\d{1,20}$/.test(account.id) && /^[A-Za-z0-9-]{1,39}$/.test(account.login)
      ? `${account.id}+${account.login}@users.noreply.github.com`
      : null,
  branchFacts: (at, token, path, names) => branchFacts({ fetch: at.fetch, apiUrl: at.api }, token, repoOf(path), names),
  async descends(at, token, path, base, tip) {
    const res = await at
      .fetch(`${at.api}/repos/${path}/compare/${base}...${tip}`, { headers: githubHeaders(token) })
      .catch(() => null);
    const status = res?.ok ? ((await jsonOf(res)) as { status?: string } | null)?.status : undefined;
    return status === "ahead" || status === "identical";
  },
  async openPullRequest(at, token, path, input) {
    const headers = { ...githubHeaders(token), "content-type": "application/json" };
    let base = input.base;
    if (!base) {
      const info = await at.fetch(`${at.api}/repos/${path}`, { headers });
      if (!info.ok) return { ok: false, status: info.status, message: `GitHub answered ${info.status} for ${path}` };
      base = ((await jsonOf(info)) as { default_branch?: string } | null)?.default_branch ?? "main";
    }
    const res = await at.fetch(`${at.api}/repos/${path}/pulls`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: input.title, head: input.head, base, body: input.body, draft: input.draft }),
    });
    const body = ((await jsonOf(res)) ?? {}) as {
      html_url?: string;
      number?: number;
      message?: string;
      errors?: { message?: string }[];
    };
    if (!res.ok || typeof body.number !== "number") {
      const why = [body.message, ...(body.errors ?? []).map((e) => e.message)].filter(Boolean).join("; ");
      return { ok: false, status: res.status, message: why };
    }
    return { ok: true, number: body.number, url: body.html_url ?? null };
  },
  async deleteBranch(at, token, path, branch) {
    const res = await at
      .fetch(`${at.api}/repos/${path}/git/refs/heads/${branchPath(branch)}`, {
        method: "DELETE",
        headers: githubHeaders(token),
      })
      .catch(() => null);
    return res ? res.status : null;
  },
};
