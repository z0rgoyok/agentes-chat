import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup, waitFor } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`);

describe("a thread's link", () => {
  test("a channel's thread opens in the channel, at its root, with the thread in the panel", async () => {
    const r = await renderApp(`/org/${ORG_ID}/threads/m-1?m=m-2`, { api: createFakeApi(seedState()) });
    await settle(10);
    expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(r.router.state.location.search).toEqual({ m: "m-1", thread: "m-1", tm: "m-2" });
    const panel = await waitFor(() => screen().getByRole("complementary", { name: "Thread" }));
    expect(panel.querySelector(".thread-head--panel")).not.toBeNull();
    // The channel is under it, its root there: no page of the thread's own, and no way to one.
    expect(row("m-1")).not.toBeNull();
    expect(document.querySelector(".thread-head:not(.thread-head--panel)")).toBeNull();
    expect(screen().queryByRole("button", { name: "Abrir em tela cheia" })).toBeNull();
  });

  test("Back from it goes where the link was", async () => {
    const r = await renderApp(`/org/${ORG_ID}/threads`, { api: createFakeApi(seedState()) });
    await settle(6);
    await r.router.navigate({ to: "/org/$orgId/threads/$threadId", params: { orgId: ORG_ID, threadId: "m-1" } });
    await settle(10);
    expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    r.router.history.back();
    await settle(6);
    expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/threads`);
  });

  test("a DM's thread opens in the DM, with the thread in the panel", async () => {
    const state = seedState();
    seedDm(state, { type: "agent", id: ADA_ID });
    const rootId = `m-dm-${ADA_ID}`;
    const r = await renderApp(`/org/${ORG_ID}/threads/${rootId}?reply=true`, { api: createFakeApi(state) });
    await waitFor(() => expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${ADA_ID}`));
    expect(r.router.state.location.search).toEqual({ m: rootId, thread: rootId, reply: true });
    await waitFor(() => screen().getByRole("complementary", { name: "Thread" }));
  });

  test("a thread of a channel no longer in my list (archived) keeps its page, not a channel that isn't there", async () => {
    const state = seedState();
    state.channels = state.channels.filter((c) => c.id !== ENG_ID);
    const r = await renderApp(`/org/${ORG_ID}/threads/m-1`, { api: createFakeApi(state) });
    await settle(10);
    expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/threads/m-1`);
    expect(screen().queryByText("Este canal não existe ou não está mais disponível.")).toBeNull();
  });

  test("a thread that isn't there keeps its page, which says so", async () => {
    const r = await renderApp(`/org/${ORG_ID}/threads/nope`, { api: createFakeApi(seedState()) });
    await settle(8);
    expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/threads/nope`);
    await waitFor(() => screen().getByText("Thread não encontrada"));
  });
});
