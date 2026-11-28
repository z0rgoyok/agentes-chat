import { bitbucketHost } from "./bitbucket";
import { githubHost } from "./github";
import { gitlabHost } from "./gitlab";
import { plainHost } from "./plain";
import { GIT_HOST_IDS, type GitHostId, isGitHostId, parseRepoRef, type RepoRef, repoPathOn, repoRefAt } from "./refs";
import type { GitHost } from "./types";

export * from "./refs";
export * from "./types";

/** Every git host (ADR 0227), by its connector's id. Adding one is a file here and its entry in the catalog. */
export const GIT_HOSTS: Record<GitHostId, GitHost> = {
  github: githubHost,
  gitlab: gitlabHost,
  bitbucket: bitbucketHost,
  git: plainHost,
};

/** The host a connection is of, or null when its connector is no git host. */
export const gitHostOf = (connector: string): GitHost | null => (isGitHostId(connector) ? GIT_HOSTS[connector] : null);

interface Owned {
  connector: string;
  ownerUserId: string | null;
}

/**
 * The workspace's connection to a git host: the team's one, never a person's own account (ADR 0099). The proxy, the
 * repository lists and the agents' git tools read this one.
 */
export const teamGitConnection = <C extends Owned>(connections: readonly C[], host: GitHostId) =>
  connections.find((c) => c.connector === host && !c.ownerUserId);

/** The workspace's git connections, GitHub first. */
export const teamGitConnections = <C extends Owned>(connections: readonly C[]) =>
  GIT_HOST_IDS.flatMap((host) => {
    const connection = teamGitConnection(connections, host);
    return connection ? [{ host: GIT_HOSTS[host], connection }] : [];
  });

/** The token a connection's secret holds for its host: OAuth's, or the pasted one. */
export const tokenOfSecret = (secret: { accessToken?: string; apiKey?: string } | null) =>
  secret?.accessToken ?? secret?.apiKey ?? null;

/**
 * A repository as a person names it, with the workspace's connections at hand: by its name or its address on a known
 * site (`parseRepoRef`), or by its address on a server one of them is connected to (a GitLab of the company's own).
 */
export function repoRefFrom<C extends Owned & { serverUrl: string }>(
  input: string,
  connections: readonly C[],
): RepoRef | null {
  const known = parseRepoRef(input);
  const team = teamGitConnections(connections);
  // A bare `owner/name` means GitHub's. Where the workspace has no GitHub and one other host that takes such a
  // path, it is that host's: nobody should have to know to write the host first.
  if (known?.host === "github" && repoPathOn("github", input) && !team.some((t) => t.host.id === "github")) {
    const others = team.filter((t) => t.host.id !== "git" && repoPathOn(t.host.id, known.path));
    const only = others.length === 1 ? others[0] : undefined;
    if (only) return { host: only.host.id, path: known.path };
  }
  if (known || !/^https:\/\//i.test(input.trim())) return known;
  for (const { host, connection } of team) {
    const ref = repoRefAt(host.id, connection.serverUrl, input);
    if (ref) return ref;
  }
  return null;
}
