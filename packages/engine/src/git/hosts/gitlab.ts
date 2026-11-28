import { type BranchFact, type GitHost, type HostAt, jsonOf } from "./types";

const headers = (token: string) => ({ authorization: `Bearer ${token}`, "user-agent": "agentes.chat" });

/** A project by its path, as GitLab's API takes it: one escaped part. */
const project = (at: HostAt, path: string) => `${at.api}/projects/${encodeURIComponent(path)}`;

/** What GitLab said went wrong, whatever shape it came in (`message` is a string, a list or fields with lists). */
function refusalOf(body: unknown): string {
  const b = (body ?? {}) as { message?: unknown; error?: unknown; error_description?: unknown };
  const said = b.message ?? b.error_description ?? b.error;
  if (typeof said === "string") return said;
  if (Array.isArray(said)) return said.map(String).join("; ");
  if (said && typeof said === "object") {
    return Object.entries(said)
      .map(([field, why]) => `${field}: ${Array.isArray(why) ? why.join(", ") : String(why)}`)
      .join("; ");
  }
  return "";
}

const PAGES = 5;

/**
 * GitLab (ADR 0227), gitlab.com or a server of one's own (the connection's address). A personal, group or project
 * access token is the whole sign-in: git takes it as the password of `oauth2`, the API as a bearer.
 */
export const gitlabHost: GitHost = {
  id: "gitlab",
  label: "GitLab",
  request: "merge request",
  at(serverUrl, http) {
    const url = new URL(serverUrl);
    const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    return { fetch: http, api: `${base}/api/v4`, git: base, site: url.hostname };
  },
  remote: (at, path) => `${at.git}/${path}.git`,
  gitLogin: (token) => `oauth2:${token}`,
  apiHeaders: headers,
  async account(at, token) {
    const res = await at.fetch(`${at.api}/user`, { headers: headers(token) }).catch(() => null);
    const body = res?.ok ? ((await jsonOf(res)) as { id?: unknown; username?: unknown } | null) : null;
    return typeof body?.username === "string" && typeof body.id === "number"
      ? { id: String(body.id), login: body.username }
      : null;
  },
  // GitLab's private commit address for an account, on the server it is an account of.
  commitEmail: (at, account) =>
    /^\d{1,20}$/.test(account.id) && /^[A-Za-z0-9_.-]{1,255}$/.test(account.login)
      ? `${account.id}-${account.login}@users.noreply.${at.site}`
      : null,
  async repositories(at, token) {
    const repositories = [];
    let truncated = false;
    for (let page = 1; page <= PAGES; page++) {
      const res = await at
        .fetch(
          `${at.api}/projects?membership=true&archived=false&order_by=last_activity_at&per_page=100&page=${page}`,
          { headers: headers(token) },
        )
        .catch(() => null);
      const list = res?.ok ? await jsonOf(res) : null;
      if (!Array.isArray(list)) break;
      for (const p of list as {
        path?: string;
        path_with_namespace?: string;
        visibility?: string;
        last_activity_at?: string | null;
        namespace?: { kind?: string; full_path?: string };
      }[]) {
        if (!p.path_with_namespace || !p.path) continue;
        repositories.push({
          path: p.path_with_namespace,
          under: p.namespace?.full_path ?? p.path_with_namespace.slice(0, -p.path.length - 1),
          kind: p.namespace?.kind === "user" ? ("User" as const) : ("Organization" as const),
          name: p.path,
          private: p.visibility !== "public",
          updatedAt: p.last_activity_at ?? null,
        });
      }
      if (list.length < 100) break;
      if (page === PAGES) truncated = true;
    }
    return { repositories, truncated };
  },
  async branchFacts(at, token, path, names) {
    const get = (rest: string) =>
      at.fetch(`${project(at, path)}${rest}`, { headers: headers(token), redirect: "manual" }).catch(() => null);
    const info = get("").then(async (res) =>
      res?.ok ? ((await jsonOf(res)) as { default_branch?: unknown } | null) : null,
    );
    const fact = async (name: string): Promise<BranchFact | null> => {
      const res = await get(`/repository/branches/${encodeURIComponent(name)}`);
      if (!res) return null;
      if (res.status === 404) return { exists: false };
      if (!res.ok) return null;
      const body = (await jsonOf(res)) as { name?: unknown; protected?: unknown } | null;
      if (!body) return null;
      // A protected branch, by its own rule or a wildcard's, says so itself.
      return body.name === name ? { exists: true, protected: body.protected === true, rules: [] } : { exists: false };
    };
    const branches = new Map<string, BranchFact>();
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
  },
  async descends(at, token, path, base, tip) {
    const res = await at
      .fetch(`${project(at, path)}/repository/merge_base?refs[]=${base}&refs[]=${tip}`, { headers: headers(token) })
      .catch(() => null);
    const body = res?.ok ? ((await jsonOf(res)) as { id?: unknown } | null) : null;
    return body?.id === base;
  },
  async openPullRequest(at, token, path, input) {
    const json = { ...headers(token), "content-type": "application/json" };
    let base = input.base;
    if (!base) {
      const info = await at.fetch(project(at, path), { headers: json });
      if (!info.ok) return { ok: false, status: info.status, message: `GitLab answered ${info.status} for ${path}` };
      base = ((await jsonOf(info)) as { default_branch?: string } | null)?.default_branch ?? "main";
    }
    const res = await at.fetch(`${project(at, path)}/merge_requests`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        source_branch: input.head,
        target_branch: base,
        // A draft is a title that says so.
        title: input.draft && !/^draft:/i.test(input.title) ? `Draft: ${input.title}` : input.title,
        description: input.body,
      }),
    });
    const body = (await jsonOf(res)) as { iid?: unknown; web_url?: unknown } | null;
    if (!res.ok || typeof body?.iid !== "number") return { ok: false, status: res.status, message: refusalOf(body) };
    return { ok: true, number: body.iid, url: typeof body.web_url === "string" ? body.web_url : null };
  },
  async deleteBranch(at, token, path, branch) {
    const res = await at
      .fetch(`${project(at, path)}/repository/branches/${encodeURIComponent(branch)}`, {
        method: "DELETE",
        headers: headers(token),
      })
      .catch(() => null);
    return res ? res.status : null;
  },
};
