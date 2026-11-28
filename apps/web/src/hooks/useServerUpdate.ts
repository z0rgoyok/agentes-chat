import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters/machine-protocol";
import { instanceQuery, useAuthConfig, useMachines } from "@agenteschat/client";
import { selfHosted } from "@agenteschat/client/lib/about";
import { can } from "@agenteschat/client/lib/permissions";
import { runnersAhead, serverReleaseQuery, serverUpdate } from "@agenteschat/client/lib/server-release";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/api/context";
import { useOrg } from "@/components/org-context";

/**
 * A self-hosted server's newer release, for who configures the workspace: the browser asks GitHub (never the server),
 * and only theirs. `ahead`: the workspace's computers whose runner is newer than this server, which the web app,
 * built with the server, tells by its own machine protocol.
 */
export function useServerUpdate() {
  const { org } = useOrg();
  const server = useAuthConfig().data;
  const admin = can(org, "configure") && selfHosted(server);
  const api = useApi();
  const instance = useQuery({ ...instanceQuery(api), enabled: admin });
  const release = useQuery({ ...serverReleaseQuery(api), enabled: admin });
  const machines = useMachines(org.id, admin);
  return {
    admin,
    version: instance.data?.version,
    latest: admin ? (release.data ?? null) : null,
    update: admin ? serverUpdate(instance.data?.version, release.data) : null,
    ahead: admin ? runnersAhead(machines.data ?? [], MACHINE_PROTOCOL_VERSION) : 0,
  };
}
