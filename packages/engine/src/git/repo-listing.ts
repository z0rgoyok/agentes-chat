import type { Database } from "@agenteschat/db";
import { activeConnections, type ConnectorDeps } from "../connectors/connections";
import { teamGitHub } from "../connectors/own-github";
import { NotFoundError } from "../errors";
import { requirePermission } from "../organizations";
import { connectionToken, hostConnectionToken } from "./branches";
import { boundInstallations, type GitHubAppConfig, type GitHubHttp, installationToken } from "./github-app";
import { GIT_HOST_IDS, type GitHostId, repoRefName, teamGitConnections } from "./hosts";
import { hostAt } from "./hosts/reach";

export interface GitHubRepositoryView {
  /**
   * The repository's name as it is stored and sent back: `owner/name` as GitHub spells it, `gitlab:group/project` on
   * another host (ADR 0227).
   */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  /** Last push (or update), ISO; null when GitHub didn't say. */
  updatedAt: string | null;
}

export interface GitHubAccountView {
  /** The git host these repositories are on (`github`, `gitlab`, `bitbucket`), and its name for people. */
  host: string;
  hostLabel: string;
  /** What its repositories' names start with, before the last slash (`acme`, `gitlab:acme/web`). */
  prefix: string;
  login: string;
  /** GitHub's `Organization` or `User`. */
  type: string;
  repositories: GitHubRepositoryView[];
}

/** The repositories the organization's GitHub reaches, by account. Never carries a token. */
export interface OrgRepositoryListing {
  /** A git host is connected (a connection, or GitHub's app installed on some account). */
  connected: boolean;
  accounts: GitHubAccountView[];
  /**
   * What the organization's other git hosts reach (ADR 0227), by group or workspace: apart from GitHub's, which the
   * screens about GitHub alone (its webhooks, skills from a repository) go on reading by themselves.
   */
  elsewhere: GitHubAccountView[];
  /** GitHub had more than we read (very large accounts). */
  truncated: boolean;
}

export interface RepoListingDeps {
  db: Database;
  connectors: ConnectorDeps;
  app?: GitHubAppConfig | null;
  /** GitHub's REST API (tests: a fake). */
  github?: GitHubHttp;
  now?: () => number;
}

const TTL_MS = 60_000;
/** Pages of 100 read per source (connection, each installation). */
const MAX_PAGES = 5;
/** By organization, with the GitHub connection it was read with (null: none). */
const cache = new Map<string, { at: number; connectionId: string | null; value: OrgRepositoryListing }>();

/** Drops an organization's cached listing (an installation changed: a new connection is noticed by itself). */
export function forgetOrgRepositories(orgId: string) {
  cache.delete(orgId);
}

interface GitHubRepo {
  full_name?: string;
  name?: string;
  private?: boolean;
  pushed_at?: string | null;
  updated_at?: string | null;
  owner?: { login?: string; type?: string };
}

/**
 * `GET …/github/repositories`: what the org's GitHub connection sees
 * (`/user/repos`) plus the repositories of the GitHub App installations
 * bound to it (`/installation/repositories`), merged by account. Cached for
 * a minute per organization and GitHub connection; tokens stay on the server.
 */
export async function listOrgRepositories(
  deps: RepoListingDeps,
  actorId: string,
  orgId: string,
): Promise<OrgRepositoryListing> {
  await requirePermission(deps.db, actorId, orgId, "read");
  return orgRepositories(deps, orgId);
}

/** The same listing with nobody asking: for an agent's `list_repositories`, which cuts it to what the agent may use. */
export async function orgRepositories(deps: RepoListingDeps, orgId: string): Promise<OrgRepositoryListing> {
  const now = deps.now?.() ?? Date.now();
  const connections = await activeConnections(deps.db, orgId);
  const connection = teamGitHub(connections);
  const others = teamGitConnections(connections).filter((c) => c.host.id !== "github" && c.host.repositories);
  // Every git connection it was read with: one made, replaced or removed since shows at once.
  const connectionId = [connection, ...others.map((o) => o.connection)].map((c) => c?.id ?? "").join(",") || null;
  const hit = cache.get(orgId);
  // A connection made, replaced or removed since shows at once (the app's events forget the listing themselves).
  if (hit && now - hit.at < TTL_MS && hit.connectionId === connectionId) return hit.value;
  const github = deps.github ?? { apiUrl: "https://api.github.com", fetch };
  const found = new Map<string, GitHubRepo>();
  let truncated = false;
  const read = async (token: string, path: (page: number) => string, pick: (body: unknown) => GitHubRepo[]) => {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await github.fetch(`${github.apiUrl}${path(page)}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "agentes.chat",
        },
      });
      if (!res.ok) return;
      const repos = pick(await res.json().catch(() => null));
      for (const r of repos) if (r.full_name) found.set(r.full_name.toLowerCase(), r);
      if (repos.length < 100) return;
      if (page === MAX_PAGES) truncated = true;
    }
  };

  if (connection) {
    const token = await connectionToken(deps.connectors, connection).catch(() => null);
    if (token) {
      await read(
        token,
        (page) =>
          `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
        (body) => (Array.isArray(body) ? (body as GitHubRepo[]) : []),
      ).catch(() => {});
    }
  }
  const installations = deps.app ? await boundInstallations(deps.db, orgId) : [];
  for (const i of installations) {
    if (!deps.app) break;
    const token = await installationToken(deps.app, github, { db: deps.db, orgId }, i.installationId).catch(() => null);
    if (!token) continue;
    await read(
      token,
      (page) => `/installation/repositories?per_page=100&page=${page}`,
      (body) => (body as { repositories?: GitHubRepo[] } | null)?.repositories ?? [],
    ).catch(() => {});
  }

  const accounts = new Map<string, GitHubAccountView>();
  for (const r of found.values()) {
    const [owner = "", name = r.name ?? ""] = (r.full_name ?? "").split("/");
    const key = owner.toLowerCase();
    const account = accounts.get(key) ?? {
      host: "github",
      hostLabel: "GitHub",
      prefix: r.owner?.login ?? owner,
      login: r.owner?.login ?? owner,
      type: r.owner?.type ?? "User",
      repositories: [],
    };
    account.repositories.push({
      fullName: r.full_name ?? `${owner}/${name}`,
      owner: account.login,
      name,
      private: r.private === true,
      updatedAt: r.pushed_at ?? r.updated_at ?? null,
    });
    accounts.set(key, account);
  }
  // The other git hosts (ADR 0227): what each one's connection reaches, by the group or workspace it sits under.
  const elsewhere: GitHubAccountView[] = [];
  for (const { host, connection: c } of others) {
    const token = await hostConnectionToken(deps.connectors, c).catch(() => null);
    const listed = token
      ? await host
          .repositories?.(
            hostAt(host, c.serverUrl, { http: deps.github?.fetch, resolveHost: deps.connectors.resolveHost }),
            token,
          )
          .catch(() => null)
      : null;
    if (!listed) continue;
    if (listed.truncated) truncated = true;
    const groups = new Map<string, GitHubAccountView>();
    for (const r of listed.repositories) {
      const group = groups.get(r.under.toLowerCase()) ?? {
        host: host.id,
        hostLabel: host.label,
        prefix: repoRefName({ host: host.id, path: r.under }),
        login: r.under,
        type: r.kind,
        repositories: [],
      };
      group.repositories.push({
        fullName: repoRefName({ host: host.id, path: r.path }),
        owner: r.under,
        name: r.name,
        private: r.private,
        updatedAt: r.updatedAt,
      });
      groups.set(r.under.toLowerCase(), group);
    }
    elsewhere.push(...groups.values());
  }
  const recent = (a: GitHubRepositoryView, b: GitHubRepositoryView) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.name.localeCompare(b.name);
  const sorted = (list: GitHubAccountView[]) =>
    list
      .map((a) => ({ ...a, repositories: a.repositories.sort(recent) }))
      // By host, organizations first, then people; by name.
      .sort(
        (a, b) =>
          GIT_HOST_IDS.indexOf(a.host as GitHostId) - GIT_HOST_IDS.indexOf(b.host as GitHostId) ||
          Number(a.type !== "Organization") - Number(b.type !== "Organization") ||
          a.login.localeCompare(b.login),
      );
  const value: OrgRepositoryListing = {
    connected: Boolean(connection) || installations.length > 0,
    accounts: sorted([...accounts.values()]),
    elsewhere: sorted(elsewhere),
    truncated,
  };
  cache.set(orgId, { at: now, connectionId, value });
  return value;
}

/** What GitHub shows as the organizations this OAuth sign-in may reach. */
export interface GitHubOrgAccess {
  /** Their logins; null when GitHub didn't answer. */
  orgs: string[] | null;
  /**
   * GitHub's page of our app, where a person grants or requests each organization: its sign-in asks only the first
   * time, so going through it again never brings that choice back. Null on an API key, which isn't our app's.
   */
  manageUrl: string | null;
}

/**
 * `GET …/github/access`: the organizations the GitHub connection reaches now. GitHub lists only those the
 * authorization allows, so a grant shows here as soon as it is made, on the token we already hold.
 */
export async function githubOrgAccess(deps: RepoListingDeps, actorId: string, orgId: string): Promise<GitHubOrgAccess> {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const connection = teamGitHub(await activeConnections(deps.db, orgId));
  if (!connection) throw new NotFoundError("GitHub isn't connected");
  // Read as a person comes back from granting one: its repositories show now, not when the listing expires.
  forgetOrgRepositories(orgId);
  const clientId = connection.authType === "oauth" ? deps.connectors.oauthApps?.github?.clientId : undefined;
  const manageUrl = clientId
    ? `https://github.com/settings/connections/applications/${encodeURIComponent(clientId)}`
    : null;
  const token = await connectionToken(deps.connectors, connection).catch(() => null);
  if (!token) return { orgs: null, manageUrl };
  const github = deps.github ?? { apiUrl: "https://api.github.com", fetch };
  const res = await github
    .fetch(`${github.apiUrl}/user/orgs?per_page=100`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "agentes.chat",
      },
    })
    .catch(() => null);
  const body = res?.ok ? ((await res.json().catch(() => null)) as { login?: unknown }[] | null) : null;
  if (!Array.isArray(body)) return { orgs: null, manageUrl };
  return { orgs: body.flatMap((o) => (typeof o.login === "string" ? [o.login] : [])), manageUrl };
}
