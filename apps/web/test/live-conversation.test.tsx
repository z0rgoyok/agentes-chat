import { afterEach, describe, expect, mock, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { useEffect } from "react";
import type { LiveEditorProps } from "@/components/live/editor";

/**
 * A live file's own conversation (ADR 0199), the task's beside a file: "Conversa N" in the header (unread lights it,
 * mentions add their red count), the thread panel docked beside the file (the page keeps its width; Esc closes it
 * only from inside), named after the file's kind with where the file was made on top; what is selected in the file
 * shows over the composer ("Sobre C2:D6 em Custos") and rides on the message (`liveRef`); the file's buttons ask in it
 * ("@Ada …"); and a message about part of the file has its line, which selects that part in the file, here or from any
 * other chat. The editors are stand-ins: one that reports a selection, asks, and shows what it was told to reveal.
 */

function EditorStub(props: LiveEditorProps) {
  const { onSelection } = props;
  // A spreadsheet always has a cell chosen when it opens.
  useEffect(() => onSelection({ label: "Planilha 1!A1", sheet: "s1", range: "A1" }), [onSelection]);
  return (
    <div data-testid="editor" data-reveal={props.reveal ? JSON.stringify(props.reveal.selection) : ""}>
      <button type="button" onClick={() => props.onSelection({ label: "Custos!C2:D6", sheet: "s1", range: "C2:D6" })}>
        select range
      </button>
      <button type="button" onClick={() => props.onAsk?.({ text: "soma por situação" })}>
        ask the agent
      </button>
    </div>
  );
}
mock.module("../src/components/live/spreadsheet", () => ({
  Spreadsheet: EditorStub,
  WorkbookView: () => <div data-testid="workbook" />,
}));
mock.module("../src/components/live/slides", () => ({
  Slides: EditorStub,
  SlideThumb: () => <span data-testid="slide-thumb" />,
  DeckView: () => <div data-testid="deck" />,
}));
mock.module("../src/components/live/canvas", () => ({
  Canvas: EditorStub,
  CanvasMini: () => <span data-testid="canvas-mini" />,
}));

const { closeAllLiveRooms } = await import("@agenteschat/client");
const { act, cleanup, fireEvent, waitFor, within } = await import("@testing-library/react");
const { ADA_ID, createFakeApi, fakeLiveOf, GENERAL_ID, ORG_ID, seedState } = await import("./fake-api");
const { renderApp, screen, settle } = await import("./render");

afterEach(() => {
  cleanup();
  closeAllLiveRooms();
  // The conversation's open or closed state is the person's choice, kept in the browser: each test starts fresh.
  window.localStorage.clear();
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const header = () => within(document.querySelector(".lf-head") as HTMLElement);
const editor = () => screen().getByTestId("editor");
const panel = () => document.querySelector("aside.lf-talk") as HTMLElement | null;

/**
 * A spreadsheet with a conversation the fake server already made (its root stands for the file), `count` messages in
 * it, and what this person hasn't read there.
 */
async function setup({
  count = 0,
  unread = { unread: 0, mentions: 0 },
  replies = [] as { body: string; meta?: Record<string, unknown> }[],
} = {}) {
  const state = seedState();
  const api = createFakeApi(state);
  const live = fakeLiveOf.get(api);
  if (!live) throw new Error("the fake API has no live fake");
  const file = await live.addFile(ORG_ID, { kind: "spreadsheet", title: "Orçamento" });
  const channelId = `file-conversation-${file.id}`;
  const rootId = `file-root-${file.id}`;
  const at = new Date(Date.now() - 60_000).toISOString();
  state.messages.push({
    id: rootId,
    channelId,
    threadId: null,
    author: { type: "person", id: "u-walter" },
    body: "Orçamento",
    mentionedAgentIds: [],
    agentRunId: null,
    clientId: null,
    meta: { fileConversation: { artifactId: file.id, kind: "spreadsheet", title: "Orçamento" } },
    createdAt: at,
  });
  for (const [i, r] of replies.entries()) {
    state.messages.push({
      id: `reply-${i}`,
      channelId,
      threadId: rootId,
      author: { type: "agent", id: ADA_ID },
      body: r.body,
      mentionedAgentIds: [],
      agentRunId: null,
      clientId: null,
      ...(r.meta ? { meta: r.meta } : {}),
      createdAt: at,
    });
  }
  // The file as the server sends it once its conversation exists (`messages.count` moves as the server's would).
  const messages = { count };
  const get = api.artifacts.get;
  api.artifacts.get = async (...args) => ({
    ...(await get(...args)),
    conversation:
      messages.count > 0
        ? { channelId, rootId, count: messages.count, lastAt: at, participants: [], working: false }
        : null,
  });
  if (api.reads) api.reads.unreadFiles = async () => [{ artifactId: file.id, ...unread }];
  return { api, state, live, file, channelId, rootId, messages };
}

async function open(path: string, api: Parameters<typeof renderApp>[1]["api"]) {
  const app = await renderApp(path, { api });
  await fakeLiveOf.get(api)?.server.settle();
  await settle(6);
  return app;
}

const composer = () =>
  within(panel() as HTMLElement).getByRole("combobox", {
    name: "Escrever na planilha · use @ para chamar um agente",
  }) as HTMLTextAreaElement;

describe("a live file's conversation", () => {
  test("Conversa N in the header: its count, lit by an unread reply, a mention's red count; it opens and closes", async () => {
    const { api, file } = await setup({ count: 4, unread: { unread: 1, mentions: 2 } });
    await open(`/org/${ORG_ID}/drive/${file.id}`, api);
    const toggle = await waitFor(() => header().getByRole("button", { name: "Conversa, 4 mensagens" }));
    expect(toggle.textContent).toContain("4");
    await waitFor(() => expect(toggle.hasAttribute("data-unread")).toBe(true));
    expect(within(toggle).getByRole("img", { name: "2 menções a você" })).toBeTruthy();
    // A file with a conversation opens it by itself the first time, beside the file.
    await waitFor(() => expect(panel()).toBeTruthy());
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await click(toggle);
    await settle(4);
    expect(panel()).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  test("Conversa N follows the conversation with it closed: a message there reads the file again", async () => {
    const { api, file, channelId, messages } = await setup({ count: 1 });
    // Closed by this person before.
    window.localStorage.setItem(`agentes.live.talk.u-walter.${ORG_ID}`, "0");
    const app = await open(`/org/${ORG_ID}/drive/${file.id}`, api);
    const socket = app.sockets.last();
    await act(async () => socket.open());
    await act(async () => socket.push({ type: "subscribed", channelId }));
    await settle(3);
    expect(panel()).toBeNull();
    await waitFor(() => expect(header().getByRole("button", { name: "Conversa, 1 mensagem" })).toBeTruthy());
    messages.count = 2;
    await act(async () =>
      socket.push({
        type: "event",
        channelId,
        event: { channelId, type: "message.created", messageId: "new-one", message: null },
      }),
    );
    await waitFor(() => expect(header().getByRole("button", { name: "Conversa, 2 mensagens" })).toBeTruthy(), {
      timeout: 3000,
    });
  });

  test("the panel: docked beside the file, named after its kind, where it was made on top, the root not drawn", async () => {
    const { api, file } = await setup();
    await open(`/org/${ORG_ID}/drive/${file.id}`, api);
    // No conversation yet: closed, "Conversa" with no count.
    expect(panel()).toBeNull();
    await click(header().getByRole("button", { name: "Conversa" }));
    await settle(8);
    const aside = await waitFor(() => panel() as HTMLElement);
    // Beside the page, never over it: hung from the work area, which keeps its width; nothing dims behind it.
    expect(aside.parentElement?.classList.contains("shell__work")).toBe(true);
    expect(document.querySelector(".lf-page[data-talk]")).toBeTruthy();
    expect(document.querySelector(".thread-panel__scrim")).toBeNull();
    const talk = within(aside);
    await waitFor(() => expect(talk.getByRole("heading", { name: "Conversa da planilha" })).toBeTruthy());
    expect(aside.querySelector(".lf-origin")?.textContent).toBe("Walter criou esta planilha");
    expect(composer()).toBeTruthy();
    // The root stands for the file: never drawn.
    expect(talk.queryByText("Orçamento", { selector: ".md *" })).toBeNull();
    // Esc in the file is the file's; from inside the conversation it closes it.
    await act(async () => fireEvent.keyDown(editor(), { key: "Escape" }));
    await settle(2);
    expect(panel()).toBeTruthy();
    await act(async () => fireEvent.keyDown(composer(), { key: "Escape" }));
    await settle(4);
    expect(panel()).toBeNull();
  });

  test("what is selected shows over the composer and rides on the message; × leaves it out", async () => {
    const { api, state, file } = await setup({ count: 1 });
    await open(`/org/${ORG_ID}/drive/${file.id}`, api);
    await waitFor(() => expect(composer()).toBeTruthy());
    // The cell a spreadsheet opens on isn't something the person pointed at.
    expect(document.querySelector(".lf-quote")).toBeNull();
    await click(within(editor()).getByRole("button", { name: "select range" }));
    await settle(2);
    const quote = await waitFor(() => document.querySelector(".lf-quote") as HTMLElement);
    expect(quote.textContent).toBe("Sobre C2:D6 em Custos");
    await type(composer(), "Soma isso por situação");
    await act(async () => fireEvent.keyDown(composer(), { key: "Enter" }));
    await settle(6);
    const post = state.calls.filter((c) => c.method === "chat.post").at(-1);
    const sent = post?.args[2] as { liveRef?: unknown } | undefined;
    expect(sent?.liveRef).toEqual({
      artifactId: file.id,
      selection: { label: "Custos!C2:D6", sheet: "s1", range: "C2:D6" },
    });
    // Sent: the quote goes until the selection changes.
    expect(document.querySelector(".lf-quote")).toBeNull();

    await click(within(editor()).getByRole("button", { name: "select range" }));
    await settle(2);
    // The same range again isn't a new selection; another one is.
    expect(document.querySelector(".lf-quote")).toBeNull();
    await act(async () => {
      fireEvent.click(within(editor()).getByRole("button", { name: "ask the agent" }));
    });
    await settle(4);
    expect(document.querySelector(".lf-quote")?.textContent).toBe("Sobre C2:D6 em Custos");
    await click(screen().getByRole("button", { name: "Não mandar a seleção" }));
    await settle(2);
    expect(document.querySelector(".lf-quote")).toBeNull();
  });

  test("the file's buttons ask in it: the conversation opens with the agent's @ and the words", async () => {
    const { api, file } = await setup();
    await open(`/org/${ORG_ID}/drive/${file.id}`, api);
    expect(panel()).toBeNull();
    await click(within(editor()).getByRole("button", { name: "ask the agent" }));
    await settle(8);
    await waitFor(() => expect(composer().value).toBe("@ada soma por situação "));
  });

  test("a message about part of the file has its line; a click selects that part in the file", async () => {
    const liveRef = {
      artifactId: "",
      kind: "spreadsheet",
      title: "Orçamento",
      selection: { label: "Custos!C2:D6", sheet: "s1", range: "C2:D6" },
    };
    const { api, file } = await setup({ count: 1, replies: [{ body: "Somei por situação.", meta: { liveRef } }] });
    liveRef.artifactId = file.id;
    await open(`/org/${ORG_ID}/drive/${file.id}`, api);
    const line = await waitFor(() =>
      within(panel() as HTMLElement).getByRole("button", { name: "Mostrar C2:D6 (Custos) no arquivo" }),
    );
    expect(line.closest(".ac-msg__reply")).toBeTruthy();
    expect(line.querySelector(".msg-quote__who")?.textContent).toBe("C2:D6");
    expect(line.querySelector(".msg-quote__excerpt")?.textContent).toBe("Custos");
    await click(line);
    await settle(2);
    expect(JSON.parse(editor().dataset.reveal ?? "null")).toEqual(liveRef.selection);
  });

  test("in any other chat the line opens the file there, at that part", async () => {
    const { api, state, file } = await setup();
    state.messages.push({
      id: "about-the-file",
      channelId: GENERAL_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Formatei os preços.",
      mentionedAgentIds: [],
      agentRunId: null,
      clientId: null,
      meta: {
        liveRef: {
          artifactId: file.id,
          kind: "spreadsheet",
          title: "Orçamento",
          selection: { label: "Custos!F1:G5", sheet: "s1", range: "F1:G5" },
        },
      },
      createdAt: new Date().toISOString(),
    });
    const app = await open(`/org/${ORG_ID}/c/${GENERAL_ID}`, api);
    const line = await waitFor(() => screen().getByRole("button", { name: "Mostrar F1:G5 (Custos) no arquivo" }));
    await click(line);
    await fakeLiveOf.get(api)?.server.settle();
    await settle(8);
    expect(app.router.state.location.pathname).toBe(`/org/${ORG_ID}/drive/${file.id}`);
    await waitFor(() => expect(JSON.parse(editor().dataset.reveal ?? "null")).toMatchObject({ range: "F1:G5" }));
  });
});
