import { expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { keys } from "@agenteschat/client";
import { QueryClient } from "@tanstack/react-query";
import { Route } from "@/routes/org.$orgId";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";

test("opening a workspace asks for the shell's lists with the page's own reads, not once its code has drawn", async () => {
  const api = createFakeApi(seedState());
  const queryClient = new QueryClient();
  const load = Route.options.loader as unknown as (ctx: {
    context: { queryClient: QueryClient; api: typeof api };
    params: { orgId: string };
  }) => void;
  load({ context: { queryClient, api }, params: { orgId: ORG_ID } });
  for (const key of [
    keys.channels(ORG_ID),
    keys.dms(ORG_ID),
    keys.agentGroups(ORG_ID),
    keys.sidebarItems(ORG_ID),
    keys.members(ORG_ID),
    keys.agents(ORG_ID),
    keys.formerAgents(ORG_ID),
    keys.roles(ORG_ID),
  ])
    expect({ key, asked: queryClient.getQueryState(key) !== undefined }).toEqual({ key, asked: true });
});
