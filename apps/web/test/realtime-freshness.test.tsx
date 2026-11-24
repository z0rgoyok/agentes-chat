import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type Message, NetworkError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import type { FakeSocket } from "./fake-socket";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

/*
 * A conversation shown again (after another page, a reconnect, a hidden tab) has what was said meanwhile, whatever
 * its events this app never heard, and the loading bar at the top ends.
 */

afterEach(() => cleanup());

const message = (id: string, body: string, over: Partial<Message> = {}): Message => ({
  id,
  channelId: ENG_ID,
  threadId: "m-1",
  author: { type: "agent", id: ADA_ID },
  body,
  mentionedAgentIds: [],
  agentRunId: `run-${id}`,
  createdAt: new Date().toISOString(),
  ...over,
});

const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;
const inView = (view: HTMLElement, text: string) =>
  [...view.querySelectorAll("article")].filter((a) => a.textContent?.includes(text));
const bar = () => screen().queryByRole("progressbar", { name: "Atualizando" });
const panel = () => screen().getByRole("complementary", { name: "Thread" });
const head = (view: HTMLElement) => view.querySelector(".thread-head__meta")?.textContent ?? "";

/** The server's event, which reaches the app only where it listens to that channel. */
const heard = (socket: FakeSocket, m: Message) =>
  act(async () =>
    socket.push({
      type: "event",
      channelId: m.channelId,
      event: { type: "message.created", channelId: m.channelId, messageId: m.id, message: m },
    }),
  );

async function openApp(path: string, state = seedState(), api = createFakeApi(state)) {
  const r = await renderApp(path, { api });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
  await settle(3);
  const go = async (to: string, params: Record<string, string> = {}) => {
    await act(() => r.router.navigate({ to, params: { orgId: ORG_ID, ...params } } as never));
    await settle(6);
  };
  return { ...r, socket, state, api, go };
}

async function openPanel(rootId = "m-1") {
  await act(async () => fireEvent.mouseEnter(row(rootId)));
  await act(async () =>
    fireEvent.click(within(within(row(rootId)).getByRole("toolbar")).getByRole("button", { name: "Responder" })),
  );
  await settle(8);
  return panel();
}

const subscribed = async (socket: FakeSocket, channelId = ENG_ID) => {
  await act(async () => socket.push({ type: "subscribed", channelId }));
  await settle(5);
};

describe("a thread open, then the inbox, then back to the channel and the thread", () => {
  test("a reply said while away: there, the thread's header counts it, and the bar ends", async () => {
    const { socket, state, go } = await openApp(`/org/${ORG_ID}/c/${ENG_ID}`);
    await openPanel();
    expect(head(panel())).not.toContain("1 resposta");
    await go("/org/$orgId/notifications");
    const m = message("r-away", "resposta da Ada enquanto fora");
    state.messages.push(m);
    await heard(socket, m);
    await go("/org/$orgId/c/$channelId", { channelId: ENG_ID });
    await subscribed(socket);
    const side = await openPanel();
    expect(inView(side, "resposta da Ada enquanto fora")).toHaveLength(1);
    expect(head(side)).toContain("1 resposta");
    expect(bar()).toBeNull();
  });

  test("back with Back, the thread open again at once: a reply said before the server listened again, whose catch-up read failed, still lands", async () => {
    const { socket, state, api, go, router } = await openApp(`/org/${ORG_ID}/c/${ENG_ID}`);
    await openPanel();
    await go("/org/$orgId/notifications");
    const read = api.chat.messages;
    let failingThreadReads = 0;
    api.chat.messages = async (orgId, channelId, options) => {
      if (failingThreadReads > 0 && options?.threadId) {
        failingThreadReads--;
        throw new NetworkError(new TypeError("Failed to fetch"));
      }
      return read(orgId, channelId, options);
    };
    await act(async () => router.history.back());
    await settle(8);
    const side = panel();
    // Said after the thread was read for this showing, before the server had the channel again: no event for it.
    state.messages.push(message("r-gap", "resposta no meio da volta"));
    // Both screens on the channel (it and the thread beside it) catch up: both their reads of the thread fail.
    failingThreadReads = 2;
    await subscribed(socket);
    await settle(5);
    expect(inView(side, "resposta no meio da volta")).toHaveLength(1);
    expect(bar()).toBeNull();
  });
});

describe("a conversation shown again", () => {
  test("while the socket is still coming back: what was said meanwhile, read by the showing itself", async () => {
    const { socket, sockets, state, go } = await openApp(`/org/${ORG_ID}/c/${ENG_ID}`);
    await go("/org/$orgId/c/$channelId", { channelId: GENERAL_ID });
    const m = message("g-1", "mensagem no eng enquanto eu estava no general", { threadId: null });
    state.messages.push(m);
    await heard(socket, m);
    await act(async () => socket.drop());
    await go("/org/$orgId/c/$channelId", { channelId: ENG_ID });
    // No open socket, so no `subscribed` and no catch-up: only the showing's own read can bring it. On a busy
    // machine the first retry (half a second) may already have made the next socket; nothing opens it here.
    expect(sockets.last().readyState).not.toBe(1);
    expect(inView(document.body, "mensagem no eng enquanto eu estava no general")).toHaveLength(1);
  });

  test("two quick hops away and back: what was said during them shows", async () => {
    const { socket, state, go } = await openApp(`/org/${ORG_ID}/c/${ENG_ID}`);
    await go("/org/$orgId/c/$channelId", { channelId: GENERAL_ID });
    const m = message("g-2", "dita no meio dos saltos", { threadId: null });
    state.messages.push(m);
    await heard(socket, m);
    await go("/org/$orgId/notifications");
    await go("/org/$orgId/c/$channelId", { channelId: ENG_ID });
    await subscribed(socket);
    expect(inView(document.body, "dita no meio dos saltos")).toHaveLength(1);
  });

  test("an event for a conversation not on screen: shown later, it holds the message once", async () => {
    const { socket, state, go } = await openApp(`/org/${ORG_ID}/c/${GENERAL_ID}`);
    await go("/org/$orgId/c/$channelId", { channelId: ENG_ID });
    await subscribed(socket);
    const m = message("g-3", "no general enquanto eu lia o eng", { channelId: GENERAL_ID, threadId: null });
    state.messages.push(m);
    await heard(socket, m);
    await go("/org/$orgId/c/$channelId", { channelId: GENERAL_ID });
    await subscribed(socket, GENERAL_ID);
    expect(inView(document.body, "no general enquanto eu lia o eng")).toHaveLength(1);
  });

  test("closing a thread beside its open channel doesn't read the channel again when the thread opens next", async () => {
    const { api } = await openApp(`/org/${ORG_ID}/c/${ENG_ID}`);
    const read = api.chat.messages;
    const channelReads: string[] = [];
    api.chat.messages = async (orgId, channelId, options) => {
      if (!options?.threadId) channelReads.push(channelId);
      return read(orgId, channelId, options);
    };
    const side = await openPanel();
    await act(async () => fireEvent.click(within(side).getByRole("button", { name: "Fechar a thread" })));
    await settle(3);
    await openPanel();
    expect(channelReads).toEqual([]);
  });
});

describe("after a reconnect, every screen of the workspace reads again", () => {
  test("the inbox: a request someone refused while the socket was down leaves the waiting ones", async () => {
    const asked = (approvalId: string, agentId: string) =>
      notification({
        id: `n-${approvalId}`,
        kind: "approval",
        waiting: true,
        actors: [{ type: "agent", id: agentId }],
        source: { approvalId, channelId: ENG_ID },
      });
    const { socket, sockets, state } = await openApp(
      `/org/${ORG_ID}/notifications`,
      seedState({ notifications: [asked("ap-merge", ADA_ID), asked("ap-deploy", ATLAS_ID)] }),
    );
    // The requests among what waits on me (the proposals to decide are rows there too).
    const waiting = () =>
      [...screen().getByRole("region", { name: "Esperando você" }).querySelectorAll('.ib-row[data-n^="n-ap-"]')].map(
        (r) => r.getAttribute("data-n"),
      );
    expect(waiting().sort()).toEqual(["n-ap-deploy", "n-ap-merge"]);
    // The deploy is the one open beside the list, with its decision.
    await act(async () => fireEvent.click(document.querySelector('.ib-row[data-n="n-ap-deploy"]') as HTMLElement));
    await settle(4);
    expect(document.querySelector('.ib-read [data-approve="ap-deploy"]')).not.toBeNull();
    await act(async () => socket.drop());
    const deploy = state.approvals.find((a) => a.id === "ap-deploy");
    if (!deploy) throw new Error("the seed's deploy request");
    Object.assign(deploy, {
      status: "refused",
      decidedByUserId: "u-joao",
      decidedAt: new Date().toISOString(),
      reason: "Agora não",
      canDecide: false,
    });
    // Decided, its notification is done with: nothing of it waits on me.
    const notice = state.notifications?.find((n) => n.id === "n-ap-deploy");
    if (notice) Object.assign(notice, { doneAt: new Date().toISOString(), waiting: false });
    await act(() => new Promise((r) => setTimeout(r, 650)));
    await act(async () => sockets.last().open());
    await settle(6);
    expect(waiting()).toEqual(["n-ap-merge"]);
    expect(document.querySelector('.ib-read [data-approve="ap-deploy"]')).toBeNull();
    expect(bar()).toBeNull();
  });
});
