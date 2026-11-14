import { afterEach, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { requestAgentPanel } from "@/lib/agent-panel-ask";
import { ADA_ID, createFakeApi, ENG_ID, GENERAL_ID, NOW, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

// Opening a conversation puts the cursor in its box (a mouse and a keyboard, not a touch screen), and a letter typed
// anywhere on it goes there.

let undo: (() => void) | undefined;
afterEach(() => {
  cleanup();
  undo?.();
  undo = undefined;
  document.querySelector("#over")?.remove();
});

const box = (name: string) => screen().getByRole("combobox", { name }) as HTMLTextAreaElement;
const key = (target: Element, init: KeyboardEventInit) => act(async () => fireEvent.keyDown(target, init));

const inThread = (id: string, body: string) =>
  ({
    id,
    channelId: ENG_ID,
    threadId: "m-1",
    author: { type: "agent", id: ADA_ID },
    body,
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
    meta: {},
  }) as Message;

test("a channel, a DM with an agent and switching between them: the cursor waits in the box", async () => {
  const state = seedState();
  seedDm(state, { type: "agent", id: ADA_ID });
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(8);
  expect(document.activeElement).toBe(box("Mensagem para #eng"));

  await act(async () =>
    r.router.navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: ORG_ID, agentId: ADA_ID } }),
  );
  await settle(8);
  expect(document.activeElement).toBe(box("Mensagem para Ada"));

  await act(async () =>
    r.router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId: GENERAL_ID } }),
  );
  await settle(8);
  expect(document.activeElement).toBe(box("Mensagem para #general"));
});

test("a draft left in the box: the caret waits after its text", async () => {
  localStorage.setItem(
    "agentes.drafts.u-walter",
    JSON.stringify({ [`channel:${ENG_ID}`]: { text: "metade de uma ideia", at: Date.now() } }),
  );
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()), reload: true });
  await settle(8);
  const el = box("Mensagem para #eng");
  expect(document.activeElement).toBe(el);
  expect(el.value).toBe("metade de uma ideia");
  expect(el.selectionStart).toBe(el.value.length);
  localStorage.clear();
});

test("with a dialog open, the next conversation leaves the focus alone", async () => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
  await settle(8);
  const over = document.createElement("div");
  over.id = "over";
  over.setAttribute("role", "dialog");
  over.tabIndex = -1;
  document.body.append(over);
  over.focus();
  await act(async () =>
    r.router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId: GENERAL_ID } }),
  );
  await settle(8);
  expect(document.activeElement).toBe(over);
  await key(over, { key: "a" });
  expect(document.activeElement).toBe(over);
});

test("with a person controlling an agent's page or computer, neither opening nor typing takes its keys", async () => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
  await settle(8);
  const page = document.createElement("div");
  page.id = "over";
  page.dataset.control = "true";
  page.tabIndex = -1;
  document.body.append(page);
  page.focus();
  await act(async () =>
    r.router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId: GENERAL_ID } }),
  );
  await settle(8);
  expect(document.activeElement).toBe(page);
  await key(page, { key: "a" });
  expect(document.activeElement).toBe(page);
  page.blur();
  await key(document.body, { key: "a" });
  expect(document.activeElement).toBe(document.body);
});

test("on a touch screen nothing takes the focus: its keyboard would open over the page", async () => {
  const media = spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query.includes("pointer: coarse") || query.includes("hover: none"),
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  const points = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
  undo = () => {
    media.mockRestore();
    if (points) Object.defineProperty(navigator, "maxTouchPoints", points);
    else delete (navigator as { maxTouchPoints?: number }).maxTouchPoints;
  };
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
  await settle(8);
  expect(document.activeElement).not.toBe(box("Mensagem para #eng"));
});

test("a letter typed on the conversation goes into the box; Space, arrows and shortcuts stay the page's", async () => {
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
  await settle(8);
  const el = box("Mensagem para #eng");
  const list = screen().getByRole("main");
  const away = () => act(async () => el.blur());

  for (const init of [
    { key: " " },
    { key: "ArrowDown" },
    { key: "PageDown" },
    { key: "Enter" },
    { key: "c", metaKey: true },
    { key: "a", ctrlKey: true },
    { key: "a", isComposing: true },
  ]) {
    await away();
    await key(list, init);
    expect(document.activeElement).not.toBe(el);
  }

  await away();
  await key(list, { key: "o" });
  expect(document.activeElement).toBe(el);

  await away();
  await key(document.body, { key: "é" });
  expect(document.activeElement).toBe(el);

  // A side panel over the conversation (an agent's page) keeps its keys.
  await act(async () => requestAgentPanel(ADA_ID, "overview"));
  await settle(6);
  const side = screen().getByRole("complementary", { name: "Perfil da Ada" });
  const tab = within(side).getAllByRole("button")[0] as HTMLElement;
  tab.focus();
  await key(tab, { key: "m" });
  expect(document.activeElement).toBe(tab);
  await act(async () => fireEvent.click(side.previousElementSibling as HTMLElement));
  await settle(4);
  expect(screen().queryByRole("complementary", { name: "Perfil da Ada" })).toBeNull();

  // Another field keeps its keys.
  const search = document.createElement("input");
  document.body.append(search);
  search.focus();
  await key(search, { key: "x" });
  expect(document.activeElement).toBe(search);
  search.remove();
});

test("a thread opened with its channel takes the cursor, and so does one opened beside it", async () => {
  const state = seedState();
  state.messages.push(inThread("t-1", "o token expira em 15 minutos"));
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}?thread=m-1`, { api: createFakeApi(state) });
  await settle(10);
  const panel = () => screen().getByRole("complementary", { name: "Thread" });
  const threadBox = () => within(panel()).getByRole("combobox", { name: "Responder na thread" });
  expect(document.activeElement).toBe(threadBox());

  // Closed, then opened again from the channel, whose box had the cursor.
  await act(async () => r.router.navigate({ to: ".", search: {} } as never));
  await settle(6);
  box("Mensagem para #eng").focus();
  await act(async () => r.router.navigate({ to: ".", search: { thread: "m-1" } } as never));
  await settle(10);
  expect(document.activeElement).toBe(threadBox());

  // A letter typed in the panel goes to the thread's box, not the channel's.
  const row = panel().querySelector('[data-message-id="t-1"]') as HTMLElement;
  await act(async () => threadBox().blur());
  await key(row, { key: "s" });
  expect(document.activeElement).toBe(threadBox());
});
