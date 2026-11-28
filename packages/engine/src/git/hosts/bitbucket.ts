import { type BranchFact, basic, type GitHost, type HostAt, jsonOf, pathParts } from "./types";

/**
 * The two kinds of token Bitbucket Cloud gives, told apart by how they are pasted: an access token of a workspace,
 * project or repository alone, or a person's API token after their Atlassian email (`ana@acme.dev:ATATT…`), which
 * its API takes only with that email.
 */
function parts(token: string) {
  const at = token.indexOf(":");
  const email = at > 0 ? token.slice(0, at) : "";
  return email.includes("@") ? { email, secret: token.slice(at + 1) } : { email: null, secret: token };
}

const headers = (token: string) => {
  const { email, secret } = parts(token);
  return {
    authorization: email ? basic(`${email}:${secret}`) : `Bearer ${secret}`,
    accept: "application/json",
    "user-agent": "agentes.chat",
  };
};

const repo = (at: HostAt, path: string) => `${at.api}/repositories/${pathParts(path)}`;

/** A branch pattern of Bitbucket's (`release/*`) as an expression: `*` is anything, the rest is itself. */
const glob = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );

interface Restriction {
  kind?: string;
  branch_match_kind?: string;
  pattern?: string;
  branch_type?: string;
}

interface BranchingModel {
  development?: { name?: string | null } | null;
  production?: { name?: string | null } | null;
  branch_types?: { kind?: string; prefix?: string }[];
}

interface Listed {
  full_name?: string;
  slug?: string;
  is_private?: boolean;
  updated_on?: string | null;
  owner?: { type?: string };
}

const PAGES = 5;

/** Bitbucket Cloud (ADR 0227). */
export const bitbucketHost: GitHost = {
  id: "bitbucket",
  label: "Bitbucket",
  request: "pull request",
  at: (_serverUrl, http) => ({
    fetch: http,
    api: "https://api.bitbucket.org/2.0",
    git: "https://bitbucket.org",
    site: "bitbucket.org",
  }),
  remote: (at, path) => `${at.git}/${path}.git`,
  gitLogin(token) {
    const { email, secret } = parts(token);
    return `${email ? "x-bitbucket-api-token-auth" : "x-token-auth"}:${secret}`;
  },
  apiHeaders: headers,
  async account(at, token) {
    const res = await at.fetch(`${at.api}/user`, { headers: headers(token) }).catch(() => null);
    const body = res?.ok
      ? ((await jsonOf(res)) as { uuid?: unknown; username?: unknown; nickname?: unknown } | null)
      : null;
    const login = typeof body?.username === "string" ? body.username : body?.nickname;
    return typeof body?.uuid === "string" && typeof login === "string" && login ? { id: body.uuid, login } : null;
  },
  async repositories(at, token) {
    const repositories = [];
    let truncated = false;
    let next: string | null = `${at.api}/repositories?role=member&pagelen=100&sort=-updated_on`;
    for (let page = 1; next && page <= PAGES; page++) {
      const res: Response | null = await at.fetch(next, { headers: headers(token) }).catch(() => null);
      const body: { next?: string; values?: Listed[] } | null = res?.ok
        ? ((await jsonOf(res)) as { next?: string; values?: Listed[] } | null)
        : null;
      if (!body?.values) break;
      for (const r of body.values) {
        const [under = "", name = r.slug ?? ""] = (r.full_name ?? "").split("/");
        if (!under || !name) continue;
        repositories.push({
          path: `${under}/${name}`,
          under,
          kind: r.owner?.type === "user" ? ("User" as const) : ("Organization" as const),
          name,
          private: r.is_private !== false,
          updatedAt: r.updated_on ?? null,
        });
      }
      // Only Bitbucket's own next page is followed.
      next = typeof body.next === "string" && body.next.startsWith(`${at.api}/`) ? body.next : null;
      if (next && page === PAGES) truncated = true;
    }
    return { repositories, truncated };
  },
  async branchFacts(at, token, path, names) {
    const get = (rest: string) =>
      at.fetch(`${repo(at, path)}${rest}`, { headers: headers(token), redirect: "manual" }).catch(() => null);
    const info = get("").then(async (res) =>
      res?.ok ? ((await jsonOf(res)) as { mainbranch?: { name?: unknown } | null } | null) : null,
    );
    // Branch permissions are the repository's administrators' to read: a token that may not (403, 404) reads none,
    // and Bitbucket still enforces what it has.
    const listed = await get("/branch-restrictions?pagelen=100");
    if (!listed) return null;
    let restrictions: Restriction[] = [];
    if (listed.ok) {
      const body = (await jsonOf(listed)) as { values?: Restriction[] } | null;
      if (!body?.values) return null;
      restrictions = body.values.filter((r) => r.kind === "push" || r.kind === "delete");
    } else if (listed.status !== 403 && listed.status !== 404) return null;
    let model: BranchingModel | null = null;
    if (restrictions.some((r) => r.branch_match_kind === "branching_model")) {
      const res = await get("/branching-model");
      model = res?.ok ? ((await jsonOf(res)) as BranchingModel | null) : null;
      if (!model) return null;
    }
    const covers = (r: Restriction, name: string) => {
      if (r.branch_match_kind !== "branching_model") return glob(r.pattern ?? "").test(name);
      if (r.branch_type === "development" || r.branch_type === "production") {
        return model?.[r.branch_type]?.name === name;
      }
      const prefix = model?.branch_types?.find((t) => t.kind === r.branch_type)?.prefix;
      return Boolean(prefix) && name.startsWith(prefix as string);
    };
    const fact = async (name: string): Promise<BranchFact | null> => {
      const res = await get(`/refs/branches/${pathParts(name)}`);
      if (!res) return null;
      if (res.status === 404) return { exists: false };
      if (!res.ok) return null;
      const body = (await jsonOf(res)) as { name?: unknown } | null;
      if (!body) return null;
      if (body.name !== name) return { exists: false };
      const rules = restrictions.filter((r) => covers(r, name)).map((r) => (r.kind === "delete" ? "deletion" : "push"));
      return { exists: true, protected: false, rules: [...new Set(rules)] };
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
    const defaultBranch = (await info)?.mainbranch?.name;
    return typeof defaultBranch === "string" && defaultBranch ? { defaultBranch, branches } : null;
  },
  async descends(at, token, path, base, tip) {
    const res = await at
      .fetch(`${repo(at, path)}/merge-base/${base}..${tip}`, { headers: headers(token) })
      .catch(() => null);
    const body = res?.ok ? ((await jsonOf(res)) as { hash?: unknown } | null) : null;
    return body?.hash === base;
  },
  async openPullRequest(at, token, path, input) {
    const res = await at.fetch(`${repo(at, path)}/pullrequests`, {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: JSON.stringify({
        title: input.title,
        description: input.body,
        source: { branch: { name: input.head } },
        // None: the repository's main branch.
        ...(input.base ? { destination: { branch: { name: input.base } } } : {}),
        ...(input.draft ? { draft: true } : {}),
      }),
    });
    const body = (await jsonOf(res)) as {
      id?: unknown;
      links?: { html?: { href?: unknown } };
      error?: { message?: unknown };
    } | null;
    if (!res.ok || typeof body?.id !== "number") {
      const why = typeof body?.error?.message === "string" ? body.error.message : "";
      return { ok: false, status: res.status, message: why };
    }
    const url = body.links?.html?.href;
    return { ok: true, number: body.id, url: typeof url === "string" ? url : null };
  },
  async deleteBranch(at, token, path, branch) {
    const res = await at
      .fetch(`${repo(at, path)}/refs/branches/${pathParts(branch)}`, { method: "DELETE", headers: headers(token) })
      .catch(() => null);
    return res ? res.status : null;
  },
};
