import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type ApiClient, ApiError } from "@agenteschat/client";
import { fakeMicrophone } from "@agenteschat/ui/testing";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

let restore = () => {};
afterEach(() => {
  cleanup();
  restore();
  restore = () => {};
});

const copied: string[] = [];
beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (s: string) => void copied.push(s) },
  });
});

type VoiceInput = Parameters<ApiClient["voice"]["send"]>[2];

const open = async (state = seedState({ media: { voiceAvailable: true } }), api = createFakeApi(state)) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(6);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { ...r, socket, state, api };
};
const composer = () => screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;
const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;

describe("a voice note with typed text and files", () => {
  test("one send carries the take, the typed text and the finished files, and clears all three", async () => {
    restore = fakeMicrophone();
    const state = seedState({ media: { voiceAvailable: true } });
    const api = createFakeApi(state);
    const sent: VoiceInput[] = [];
    api.voice.send = async (_org, _channel, input) => {
      sent.push(input);
      return { clipId: "clip-1" };
    };
    await open(state, api);
    // A file attached before the take.
    const input = document.querySelector(".ac-composer input[type=file]") as HTMLInputElement;
    const file = new File([new Uint8Array([137, 80, 78, 71])], "tela.png", { type: "image/png" });
    await act(async () => fireEvent.change(input, { target: { files: [file] } }));
    await settle(4);
    expect(document.querySelector(".ac-composer__file")?.textContent).toContain("tela.png");
    await act(async () => {
      fireEvent.pointerDown(screen().getByRole("button", { name: "Gravar áudio" }), { button: 0 });
      fireEvent.pointerUp(window);
    });
    await act(() => Bun.sleep(800));
    // Typed during the take, in the same box.
    await act(async () => fireEvent.change(composer(), { target: { value: "olha a tela" } }));
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Enviar áudio" })));
    await settle(6);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("olha a tela");
    expect(sent[0]?.attachments).toHaveLength(1);
    expect(composer().value).toBe("");
    expect(document.querySelector(".ac-composer__file")).toBeNull();
    expect(document.querySelector(".ac-composer__voice")).toBeNull();
  });

  test("a take the server refuses gives the typed text and the files back to the box", async () => {
    restore = fakeMicrophone();
    const state = seedState({ media: { voiceAvailable: true } });
    const api = createFakeApi(state);
    api.voice.send = async () => {
      throw new ApiError(400, "voice.limit", "Too many voice messages");
    };
    await open(state, api);
    const input = document.querySelector(".ac-composer input[type=file]") as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "notas.txt", { type: "text/plain" });
    await act(async () => fireEvent.change(input, { target: { files: [file] } }));
    await settle(4);
    await act(async () => {
      fireEvent.pointerDown(screen().getByRole("button", { name: "Gravar áudio" }), { button: 0 });
      fireEvent.pointerUp(window);
    });
    await act(() => Bun.sleep(800));
    await act(async () => fireEvent.change(composer(), { target: { value: "olha as notas" } }));
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Enviar áudio" })));
    await settle(6);
    expect(composer().value).toBe("olha as notas");
    expect(document.querySelector(".ac-composer__file")?.textContent).toContain("notas.txt");
  });

  test("a take with nothing typed or attached goes as before: no text, no files", async () => {
    restore = fakeMicrophone();
    const state = seedState({ media: { voiceAvailable: true } });
    const api = createFakeApi(state);
    const sent: VoiceInput[] = [];
    api.voice.send = async (_org, _channel, input) => {
      sent.push(input);
      return { clipId: "clip-1" };
    };
    await open(state, api);
    await act(async () => {
      fireEvent.pointerDown(screen().getByRole("button", { name: "Gravar áudio" }), { button: 0 });
      fireEvent.pointerUp(window);
    });
    await act(() => Bun.sleep(800));
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Enviar áudio" })));
    await settle(4);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBeUndefined();
    expect(sent[0]?.attachments).toBeUndefined();
  });

  test("the sent message: the typed text above the player, the words alone in it, then the file", async () => {
    const state = seedState({ media: { voiceAvailable: true } });
    const api = createFakeApi(state);
    const saved = await api.artifacts.upload(
      ORG_ID,
      new File([new Uint8Array([137, 80, 78, 71])], "tela.png", { type: "image/png" }),
    );
    state.messages.push({
      id: "m-voice",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-joao" },
      body: "olha a tela\n\no deploy das nove quebrou o login",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {
        voice: { clipId: "clip-1", durationMs: 4000, peaks: [0.2, 0.6, 0.4], text: "olha a tela" },
        artifacts: [{ id: saved.id, version: 1 }],
      },
      createdAt: new Date().toISOString(),
    });
    await open(state, api);
    const message = row("m-voice");
    const player = message.querySelector(".ac-voice") as HTMLElement;
    const tile = message.querySelector(".artifact-tile") as HTMLElement;
    expect(player).toBeTruthy();
    expect(tile).toBeTruthy();
    // The typed text, once, before the player; the file after it.
    expect(message.textContent?.split("olha a tela")).toHaveLength(2);
    const typed = within(message).getByText("olha a tela");
    expect(typed.compareDocumentPosition(player) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(player.compareDocumentPosition(tile) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The player's one line: the spoken words, never the typed text again.
    const words = within(player).getByRole("button", { name: "Ver texto" });
    expect(words.textContent).toBe("o deploy das nove quebrou o login");

    // Copy text copies what was typed, never the words.
    await act(async () => fireEvent.contextMenu(message, { clientX: 40, clientY: 60 }));
    await settle(2);
    const menu = screen().getByRole("menu", { name: "Ações" });
    await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Copiar texto" })));
    await settle(2);
    expect(copied.at(-1)).toBe("olha a tela");
  });

  test("a voice message with nothing typed still shows no text, and has no text to copy", async () => {
    const state = seedState({ media: { voiceAvailable: true } });
    state.messages.push({
      id: "m-voice",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-joao" },
      body: "o deploy das nove quebrou o login",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: { voice: { clipId: "clip-1", durationMs: 4000, peaks: [0.2, 0.6, 0.4] } },
      createdAt: new Date().toISOString(),
    });
    await open(state);
    const message = row("m-voice");
    expect(message.textContent?.split("o deploy das nove quebrou o login")).toHaveLength(2);
    expect(
      within(message.querySelector(".ac-voice") as HTMLElement).getByRole("button", { name: "Ver texto" }),
    ).toBeTruthy();
    await act(async () => fireEvent.contextMenu(message, { clientX: 40, clientY: 60 }));
    await settle(2);
    const menu = screen().getByRole("menu", { name: "Ações" });
    expect(within(menu).queryByRole("menuitem", { name: "Copiar texto" })).toBeNull();
  });
});
