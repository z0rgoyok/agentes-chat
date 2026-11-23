import { expect, test } from "bun:test";
import { createArtifact } from "@agenteschat/engine";
import type { BlockActionContext } from "../src/routes/app/extras";
import { browser, createTestServer, seedOrg, signUp } from "./harness";

test("a person's session and access to the current block authorize its registered actions", async () => {
  const calls: (BlockActionContext & { actionId: string })[] = [];
  const listed: BlockActionContext[] = [];
  const server = await createTestServer({
    env: { ALLOW_SIGNUP: "true" },
    blockActions: {
      localize: async ({ locale, version }) =>
        locale === "de" && version === 1
          ? { content: { kind: "block", html: "<p>Ergebnis</p>" }, rememberOpen: true }
          : undefined,
      list: async (input) => {
        listed.push(input);
        return [{ id: "item-42", label: "Accept" }];
      },
      invoke: async (input) => void calls.push(input),
    },
  });
  try {
    const owner = browser(server);
    const stranger = browser(server);
    const { user } = (await (await signUp(owner, "owner@example.com")).json()) as { user: { id: string } };
    await signUp(stranger, "stranger@example.com");
    const { orgId, channelId, agentId } = await seedOrg(owner);
    const card = await createArtifact(server.engine.artifacts, { type: "agent", agentId, channelId }, orgId, {
      channelId,
      title: "Result",
      content: { kind: "block", html: "<p>Result</p>" },
    });
    const org = `/api/app/organizations/${orgId}`;
    const endpoint = `${org}/blocks/${card.id}/actions`;
    const json = { actionId: "item-42", version: 1, userId: "ignored" };
    expect((await browser(server)(endpoint, { json })).status).toBe(401);
    expect([403, 404]).toContain((await stranger(endpoint, { json })).status);
    expect(listed).toHaveLength(0);
    expect((await owner(endpoint, { json: { ...json, version: 2 } })).status).toBe(409);
    expect((await owner(endpoint, { json: { ...json, actionId: "other" } })).status).toBe(409);
    expect(calls).toHaveLength(0);
    expect(await (await owner(`${org}/artifacts/${card.id}`)).json()).toMatchObject({
      blockActions: [{ id: "item-42", label: "Accept" }],
    });
    expect(await (await owner(`${org}/artifacts/${card.id}?locale=de&version=1`)).json()).toMatchObject({
      content: { kind: "block", html: "<p>Ergebnis</p>" },
      rememberBlockOpen: true,
    });
    expect((await owner(endpoint, { json })).status).toBe(204);
    expect(calls).toEqual([{ orgId, artifactId: card.id, userId: user.id, actionId: "item-42" }]);
  } finally {
    await server.close();
  }
});
