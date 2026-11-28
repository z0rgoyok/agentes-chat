import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "../api/client";
import type { FetchLike } from "../api/http";
import { PUBLIC_SOURCE_URL } from "./about";
import { compareVersions, isNewer } from "./versions";

/**
 * Settings › About on a self-hosted server: whether a newer server release is out. The person's browser asks the
 * public repository's releases on GitHub, never the server, so a self-hosted server makes no call of its own for it.
 */

const REPO = PUBLIC_SOURCE_URL.replace("https://github.com/", "");
/** The newest releases first; the desktop app's (`desktop-v…`) and the helpers' tags are among them. */
export const SERVER_RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
export const SERVER_RELEASES_PAGE = `${PUBLIC_SOURCE_URL}/releases`;
/** A server release's tag: `v0.1.18`. */
const SERVER_TAG = /^v(\d+\.\d+\.\d+)$/;
/** How often a page asks again: GitHub serves 60 unauthenticated requests an hour per address. */
const RELEASE_STALE_MS = 6 * 60 * 60 * 1000;

export interface ServerRelease {
  version: string;
  /** Its page on GitHub: the notes and the packages without Docker. */
  url: string;
}

interface GithubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

/** The newest published server release in GitHub's list; null when there is none. */
export function latestServerRelease(body: unknown): ServerRelease | null {
  if (!Array.isArray(body)) return null;
  let latest: ServerRelease | null = null;
  for (const r of body as GithubRelease[]) {
    const version = typeof r.tag_name === "string" ? SERVER_TAG.exec(r.tag_name)?.[1] : undefined;
    if (!version || r.draft === true || r.prerelease === true) continue;
    if (latest && compareVersions(version, latest.version) <= 0) continue;
    const url = typeof r.html_url === "string" && r.html_url.startsWith(`${PUBLIC_SOURCE_URL}/`) ? r.html_url : null;
    latest = { version, url: url ?? SERVER_RELEASES_PAGE };
  }
  return latest;
}

/** The release to update to: newer than the server's `version`; null when it runs the newest (or ahead of it). */
export const serverUpdate = (version: string | undefined, latest: ServerRelease | null | undefined) =>
  version && latest && isNewer(latest.version, version) ? latest : null;

/** No referrer and no cookie: GitHub learns no page of the server (a cross-site request still names its origin). */
export async function fetchServerRelease(fetchFn: FetchLike): Promise<ServerRelease | null> {
  const res = await fetchFn(SERVER_RELEASES_API, {
    headers: { accept: "application/vnd.github+json" },
    referrerPolicy: "no-referrer",
    credentials: "omit",
  });
  return res.ok ? latestServerRelease(await res.json()) : null;
}

export const serverReleaseQuery = (api: ApiClient) =>
  queryOptions({
    queryKey: ["server-release"],
    queryFn: () => api.system.serverRelease(),
    staleTime: RELEASE_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });

/** SELF_HOSTING.md's upgrades, for `version`: the compose file of its tag, then pull and restart. */
export const dockerUpgrade = (version: string) =>
  [
    `curl -fsSLO https://raw.githubusercontent.com/${REPO}/v${version}/docker-compose.yml`,
    "docker compose pull",
    "docker compose up -d",
  ].join("\n");

/** Without Docker: the release's package extracted into `~/.agentes/app`, then its service started on the folder. */
export const nativeUpgrade = (version: string) =>
  `~/.agentes/app/${version}/bin/agentes-server service install --data ~/.agentes`;

/**
 * Computers whose runner speaks a newer machine protocol than this server (`serverProtocol`): they keep working, and
 * what is new in them waits for the server's update.
 */
export const runnersAhead = (machines: readonly { protocol?: number }[], serverProtocol: number) =>
  machines.filter((m) => (m.protocol ?? 0) > serverProtocol).length;
