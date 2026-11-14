import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { fakeMicrophone } from "@agenteschat/ui/testing";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

let restore = () => {};
afterEach(() => {
  cleanup();
  restore();
  restore = () => {};
});

const open = async (state = seedState(), api = createFakeApi(state)) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { ...r, socket, state };
};
const push = (socket: { push: (f: unknown) => void }, event: Record<string, unknown>) =>
  act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
const frame = (userId: string, kind?: "voice") => ({
  type: "user.typing",
  userId,
  threadId: null,
  ttlMs: 5000,
  ...(kind ? { kind } : {}),
});
const pill = () => document.querySelector(".ac-typing") as HTMLElement;
const composer = () => screen().getByRole("combobox", { name: /Mensagem para/ });
const typed = (text: string) => act(async () => fireEvent.change(composer(), { target: { value: text } }));
const record = () =>
  act(async () => {
    fireEvent.pointerDown(screen().getByRole("button", { name: "Gravar áudio" }), { button: 0 });
    fireEvent.pointerUp(window);
  });
/** The typing frames this app sent, with their kind. */
const typingSent = (socket: { sent: unknown[] }) =>
  socket.sent
    .filter((f) => (f as { type: string }).type === "typing")
    .map((f) => (f as { kind?: string }).kind ?? "typing");
/** The pill's words as read: without the faces' initials and the marks, which screen readers skip too. */
const words = () => {
  const text = pill().querySelector(".ac-typing__text")?.cloneNode(true) as HTMLElement | undefined;
  for (const hidden of text?.querySelectorAll('[aria-hidden="true"]') ?? []) hidden.remove();
  return text?.textContent ?? "";
};
const withMarina = () => {
  const state = seedState();
  const joao = state.members.find((m) => m.userId === "u-joao");
  if (joao) {
    state.members.push({
      ...joao,
      userId: "u-marina",
      name: "Marina Alves",
      email: "marina@example.com",
      handle: "marina",
      roleIds: [],
    });
  }
  return state;
};

describe("“gravando áudio…” beside “está digitando…”", () => {
  test("someone recording: three bars where the dots are, their face, their words; writing takes over, their message ends it", async () => {
    const { socket } = await open();
    await push(socket, frame("u-joao", "voice"));
    await settle();
    expect(pill().dataset.active).toBe("true");
    expect(words()).toBe("João está gravando áudio…");
    // The bars, never the dots, and the face beside the bars: their group is the line.
    expect(pill().querySelector(".ac-typing__dots")).toBeNull();
    const voice = pill().querySelector(".ac-typing__group") as HTMLElement;
    expect(voice.querySelector(".ac-typing__bars")?.getAttribute("aria-hidden")).toBe("true");
    expect(voice.querySelectorAll(".ac-typing__bars > span")).toHaveLength(3);
    expect(voice.querySelectorAll(".ac-typing__tok .ac-avatar")).toHaveLength(1);
    expect(pill().querySelectorAll(".ac-typing__tok .ac-avatar")).toHaveLength(1);
    // The pill still tells screen readers.
    expect(pill().getAttribute("aria-live")).toBe("polite");
    // He writes now: the latest frame wins.
    await push(socket, frame("u-joao"));
    await settle();
    expect(words()).toBe("João está digitando…");
    expect(pill().querySelector(".ac-typing__bars")).toBeNull();
    expect(pill().querySelector(".ac-typing__dots")).not.toBeNull();
    // Back to recording, then his voice message arrives: gone at once.
    await push(socket, frame("u-joao", "voice"));
    await settle();
    expect(words()).toBe("João está gravando áudio…");
    await push(socket, {
      type: "message.created",
      messageId: "m-voice",
      message: {
        id: "m-voice",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-joao" },
        body: "subiu o deploy",
        mentionedAgentIds: [],
        agentRunId: null,
        meta: { voice: { clipId: "clip-1", durationMs: 4000, peaks: [0.2, 0.6] } },
        createdAt: new Date().toISOString(),
      },
    });
    await settle();
    expect(pill().dataset.active).toBe("false");
  });

  test("a voice message too big for its event, which only names who sent it, ends their line at once all the same", async () => {
    const { socket } = await open();
    await push(socket, frame("u-joao", "voice"));
    await settle();
    expect(words()).toBe("João está gravando áudio…");
    await push(socket, {
      type: "message.created",
      messageId: "m-long",
      threadId: null,
      agentRunId: null,
      authorUserId: "u-joao",
    });
    await settle();
    expect(pill().dataset.active).toBe("false");
  });

  test("one writes and another records: each verb a group with its own mark and faces, who writes first", async () => {
    const { socket } = await open(withMarina());
    await push(socket, frame("u-marina", "voice"));
    await push(socket, frame("u-joao"));
    await settle();
    expect(words()).toBe("João está digitando · Marina Alves está gravando áudio…");
    // Nothing leads the pill: each group opens with its mark, then its faces, then its words.
    expect(pill().querySelector(":scope > .ac-typing__dots, :scope > .ac-typing__avatars")).toBeNull();
    const [typing, recording] = [...pill().querySelectorAll(".ac-typing__group")] as HTMLElement[];
    expect(typing?.firstElementChild?.className).toBe("ac-typing__dots");
    expect(typing?.querySelectorAll(".ac-typing__tok .ac-avatar")).toHaveLength(1);
    // The " · " goes with who types: short of room, who records takes a line of their own, never cut.
    expect(typing?.querySelector(".ac-typing__people")?.textContent).toBe("João está digitando · ");
    expect(recording?.firstElementChild?.className).toBe("ac-typing__bars");
    expect(recording?.querySelectorAll(".ac-typing__tok .ac-avatar")).toHaveLength(1);
    expect(recording?.querySelector(".ac-typing__people")?.textContent).toBe("Marina Alves está gravando áudio…");
  });

  test("agents at work come first, as with typing: their words, then the bars and who records", async () => {
    const { socket } = await open();
    await push(socket, { type: "agent.run", threadId: null, runId: "r-a", agentId: ADA_ID, status: "running" });
    await push(socket, { type: "agent.run", threadId: null, runId: "r-b", agentId: ATLAS_ID, status: "running" });
    await push(socket, frame("u-joao", "voice"));
    await settle();
    expect(words()).toBe("Ada e Atlas estão trabalhando · João está gravando áudio…");
    expect(pill().querySelector(".ac-typing__agents")?.textContent).toBe("Ada e Atlas estão trabalhando · ");
    expect(pill().querySelector(".ac-typing__dots")).toBeNull();
    expect(pill().querySelector(".ac-typing__group .ac-typing__bars")).not.toBeNull();
  });

  test("worst case: long names, four recording beside a long name typing and two agents: names give way, never the verbs", async () => {
    const state = seedState();
    const joao = state.members.find((m) => m.userId === "u-joao");
    const people = [
      ["u-aleksandra", "Aleksandra Wiśniewska-Kowalczyk"],
      ["u-bartholomew", "Bartholomew Fitzgerald-Montgomery III"],
      ["u-jo", "Jo"],
      ["u-huong", "Nguyễn Thị Thanh Hương"],
      ["u-meiling", "李美玲"],
    ];
    for (const [userId = "", name = ""] of people)
      if (joao)
        state.members.push({ ...joao, userId, name, email: `${userId.slice(2)}@example.com`, handle: userId.slice(2) });
    const { socket } = await open(state);
    for (const id of ["u-aleksandra", "u-jo", "u-huong", "u-meiling"]) await push(socket, frame(id, "voice"));
    await settle();
    expect(words()).toBe("Aleksandra Wiśniewska-Kowalczyk e mais 3 estão gravando áudio…");
    // Three faces at most by the bars; the sentence says the rest.
    expect(pill().querySelectorAll(".ac-typing__group .ac-typing__tok")).toHaveLength(3);
    await push(socket, { type: "agent.run", threadId: null, runId: "r-a", agentId: ADA_ID, status: "running" });
    await push(socket, { type: "agent.run", threadId: null, runId: "r-b", agentId: ATLAS_ID, status: "running" });
    await push(socket, frame("u-bartholomew"));
    await settle();
    expect(words()).toBe(
      "Ada e Atlas estão trabalhando · Bartholomew Fitzgerald-Montgomery III está digitando · Aleksandra Wiśniewska-Kowalczyk e mais 3 estão gravando áudio…",
    );
  });

  test("my own take tells the conversation while it records, never while paused, through the typing throttle", async () => {
    restore = fakeMicrophone();
    const { socket } = await open(seedState({ media: { voiceAvailable: true } }));
    const voiceFrames = () =>
      socket.sent.filter(
        (f) => (f as { type: string; kind?: string }).type === "typing" && (f as { kind?: string }).kind,
      );
    const mic = screen().getByRole("button", { name: "Gravar áudio" });
    await act(async () => {
      fireEvent.pointerDown(mic, { button: 0 });
      fireEvent.pointerUp(window);
    });
    await act(() => Bun.sleep(150));
    expect(voiceFrames()).toEqual([{ type: "typing", channelId: ENG_ID, kind: "voice" }]);
    // One every 3 s: still one a second later.
    await act(() => Bun.sleep(1000));
    expect(voiceFrames()).toHaveLength(1);
    // Paused: nothing more while it waits.
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Pausar" })));
    await act(() => Bun.sleep(2200));
    expect(voiceFrames()).toHaveLength(1);
    // Going on: the next frame once 3 s passed since the last.
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Continuar gravando" })));
    await act(() => Bun.sleep(150));
    expect(voiceFrames()).toHaveLength(2);
  }, 15_000);

  test("a take right after a typed message tells at once, so the agent asked in it still waits for the take", async () => {
    restore = fakeMicrophone();
    const { socket } = await open(seedState({ media: { voiceAvailable: true } }));
    await typed("olha isso");
    await act(async () => fireEvent.keyDown(composer(), { key: "Enter" }));
    await record();
    await act(() => Bun.sleep(150));
    expect(typingSent(socket)).toEqual(["typing", "voice"]);
  });

  test("while the take uploads the others still see it, and writing meanwhile takes over", async () => {
    restore = fakeMicrophone();
    const state = seedState({ media: { voiceAvailable: true } });
    const api = createFakeApi(state);
    let uploaded = () => {};
    api.voice.send = () => new Promise((resolve) => (uploaded = () => resolve({ clipId: "clip-1" })));
    const { socket } = await open(state, api);
    await record();
    await act(() => Bun.sleep(800));
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Enviar áudio" })));
    // On its way: still one frame every 3 s.
    await act(() => Bun.sleep(3300));
    expect(typingSent(socket)).toEqual(["voice", "voice"]);
    // Writing shows at once, and the upload's frames wait while she writes.
    await typed("e mais");
    await act(() => Bun.sleep(1300));
    expect(typingSent(socket)).toEqual(["voice", "voice", "typing"]);
    await act(async () => uploaded());
  }, 15_000);
});
