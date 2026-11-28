import { CONNECTOR_CATALOG } from "../../connectors/catalog";
import { outboundFetch, type ResolveHost } from "../../net-guard";
import type { GitHost, HostAt } from "./types";

/**
 * Where a connection's host is reached from this server. A host at an address a person typed (a GitLab of their own,
 * a git server) is fetched as every typed address is, through the guard that keeps private networks out
 * (`outboundFetch`); `http` is the network given from outside (tests).
 */
export function hostAt(
  host: GitHost,
  serverUrl: string,
  deps: { http?: typeof fetch | undefined; resolveHost?: ResolveHost | undefined } = {},
): HostAt {
  const typed = Boolean(CONNECTOR_CATALOG[host.id]?.address);
  const http =
    deps.http ?? (typed ? outboundFetch({ ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}) }) : fetch);
  return host.at(serverUrl, http);
}
