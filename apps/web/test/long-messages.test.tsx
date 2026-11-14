import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type Message } from "@agenteschat/client";
import { LONG_MESSAGE, MAX_MESSAGE_LENGTH } from "@agenteschat/client/lib/message-length";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, comfortable, createFakeApi, ENG_ID, NOW, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

const ROOT = new URL("../../../", import.meta.url).pathname;
const TALL = "Relatório longo do trimestre";

// No layout here: the tall message's words measure past the rule's height, any other under it.
const heights = {
  scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"),
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
};
const tall = (el: HTMLElement) => el.classList.contains("msg-clip") && Boolean(el.textContent?.includes(TALL));
Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return tall(this) ? 2400 : 0;
  },
});
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return 0;
  },
});

afterEach(() => cleanup());

const said = (id: string, who: string, body: string, minutes: number, extra: Partial<Message> = {}) =>
  ({
    id,
    channelId: ENG_ID,
    threadId: null,
    author: who.startsWith("u-") ? { type: "person", id: who } : { type: "agent", id: who },
    body,
    mentionedAgentIds: [],
    agentRunId: who.startsWith("u-") ? null : `r-${id}`,
    createdAt: new Date(NOW.getTime() - minutes * 60_000).toISOString(),
    ...extra,
  }) as Message;

const open = async (state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(comfortable(state)) });
  await settle(10);
  return { ...r, state };
};
const row = (id: string) => {
  const el = document.querySelector<HTMLElement>(`article[data-message-id="${id}"]`);
  if (!el) throw new Error(`no row ${id}`);
  return el;
};
const composer = () => screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;

describe("a tall message in the conversation", () => {
  const body = `${TALL}\n\n${Array.from({ length: 80 }, (_, i) => `Linha ${i + 1} com **números**.`).join("\n\n")}`;

  test("shows clipped with Ver mais, a person's and an agent's alike; a short one shows whole", async () => {
    await open(
      seedState({
        messages: [said("p1", "u-joao", body, 3), said("a1", ADA_ID, body, 2), said("p2", "u-joao", "ok", 1)],
      }),
    );
    for (const id of ["p1", "a1"]) {
      expect(row(id).querySelector(".msg-clip")?.classList.contains("msg-clip--cut")).toBe(true);
      expect(within(row(id)).getByRole("button", { name: "Ver mais" })).toBeTruthy();
      // The words keep their place as the text's direct child: the bubble's rules read them there.
      expect(row(id).querySelector(".ac-msg__text > .md.msg-clip")).not.toBeNull();
    }
    expect(row("p2").querySelector(".msg-clip--cut")).toBeNull();
    expect(within(row("p2")).queryByRole("button", { name: "Ver mais" })).toBeNull();
    // Not there at all, rather than hidden: a short message's text reads as its words alone.
    expect(row("p2").querySelector(".ac-msg__text")?.textContent).toBe("ok");
    // Never cut by an ellipsis: every word is in the row.
    expect(row("p1").textContent).toContain("Linha 80 com números.");
  });

  test("my own tall message, with a word that never breaks, clips the same way inside its bubble", async () => {
    const mine = `${TALL} ${"semespaco".repeat(300)}\n\n${body}`;
    await open(seedState({ messages: [said("m1", "u-walter", mine, 2)] }));
    expect(row("m1").querySelector(".ac-msg__text > .md.msg-clip--cut")).not.toBeNull();
    expect(within(row("m1")).getByRole("button", { name: "Ver mais" })).toBeTruthy();
  });

  test("Ver mais opens the whole message in place, for good: no dialog, no Ver menos, the focus on its words", async () => {
    await open(seedState({ messages: [said("a1", ADA_ID, body, 2)] }));
    const words = row("a1").querySelector<HTMLElement>(".ac-msg__text > .md.msg-clip--cut");
    await act(async () => fireEvent.click(within(row("a1")).getByRole("button", { name: "Ver mais" })));
    expect(screen().queryByRole("dialog")).toBeNull();
    // The same words where they were, uncut, with nothing that folds them back.
    expect(row("a1").querySelector(".ac-msg__text > .md.msg-clip")).toBe(words);
    expect(words?.classList.contains("msg-clip--cut")).toBe(false);
    expect(within(row("a1")).queryByRole("button", { name: /^Ver (mais|menos)$/ })).toBeNull();
    expect(row("a1").querySelector<HTMLElement>(".msg-clip__foot")?.hidden).toBe(true);
    expect(words?.querySelector("strong")?.textContent).toBe("números");
    // The button that opened it is gone: the focus moves to the words, for keyboards and screen readers.
    expect(document.activeElement === words).toBe(true);
  });

  test("Copiar texto stays in the message's ⋯ menu, with the whole message", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    await open(seedState({ messages: [said("a1", ADA_ID, body, 2)] }));
    const more = within(row("a1")).getByRole("button", { name: "Mais ações da mensagem" });
    more.focus();
    await act(async () => {
      fireEvent.keyDown(more, { key: "Enter" });
      fireEvent.keyUp(more, { key: "Enter" });
    });
    await settle(2);
    await act(async () =>
      fireEvent.click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Copiar texto" })),
    );
    await settle(2);
    expect(copied).toEqual([body]);
  });

  test("opening it lets go of the end: what grows below no longer pulls the list from the words", async () => {
    const native = globalThis.ResizeObserver;
    const observers: ResizeObserverCallback[] = [];
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        observers.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      await open(seedState({ messages: [said("a1", ADA_ID, body, 2)] }));
      const log = screen().getByRole("region", { name: "Mensagens" });
      let height = 2000;
      Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => height });
      Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
      const grow = (to: number) =>
        act(async () => {
          height = to;
          for (const cb of observers) cb([], {} as ResizeObserver);
        });
      await grow(2100);
      expect(log.scrollTop).toBe(2100);
      await act(async () => fireEvent.click(within(row("a1")).getByRole("button", { name: "Ver mais" })));
      await grow(4100);
      expect(log.scrollTop).toBe(2100);
    } finally {
      globalThis.ResizeObserver = native;
    }
  });

  test("the stylesheet's heights are the shared rule's", async () => {
    const css = (await Bun.file(`${ROOT}apps/web/src/layout.css`).text()).replace(/\s+/g, " ");
    expect(css).toContain(`.msg-clip--cut { max-height: ${LONG_MESSAGE.shows}px; overflow-y: clip;`);
  });

  test("a Live or Spec block taller than its card: Ver mais opens it whole, and nothing folds it back", async () => {
    for (const file of ["LiveBlock.tsx", "SpecBlock.tsx"]) {
      const src = await Bun.file(`${ROOT}apps/web/src/components/blocks/${file}`).text();
      const once = src.includes("{tall && !open && (") && src.includes('{t("channel.long.more")}');
      expect({ file, once, less: src.includes("blocks.showLess") }).toEqual({ file, once: true, less: false });
    }
  });
});

describe("a message past the length limit", () => {
  const over = "x".repeat(MAX_MESSAGE_LENGTH + 5_000);

  test("the composer says the sizes before sending, holds the send, and offers the text as a file", async () => {
    const { state } = await open();
    await act(async () => fireEvent.change(composer(), { target: { value: over } }));
    const notice = document.querySelector<HTMLElement>(".ac-composer__notice");
    expect(notice?.textContent).toContain("A mensagem tem 105.000 caracteres e o limite é 100.000.");
    await act(async () => fireEvent.keyDown(composer(), { key: "Enter" }));
    await settle(2);
    expect(state.calls.filter((c) => c.method === "chat.post")).toHaveLength(0);
    expect(composer().value).toBe(over);

    await act(async () =>
      fireEvent.click(within(notice as HTMLElement).getByRole("button", { name: "Enviar como arquivo" })),
    );
    await settle(4);
    expect(state.calls.find((c) => c.method === "artifacts.upload")?.args[1]).toBe("mensagem.txt");
    expect(composer().value).toBe("");
    expect(document.querySelector(".ac-composer__notice")).toBeNull();
  });

  test("refused by the server all the same: the row says the sizes, and Editar returns the text to the field", async () => {
    const state = seedState({
      failPosts: new ApiError(400, "message.too_long", "Message is longer than 100000 characters", {
        length: 120_000,
        max: 100_000,
      }),
    });
    await open(state);
    await act(async () => fireEvent.change(composer(), { target: { value: "texto recusado" } }));
    await act(async () => fireEvent.keyDown(composer(), { key: "Enter" }));
    await settle(4);
    const failed = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("texto recusado")) as HTMLElement;
    expect(within(failed).getByRole("alert").textContent).toBe(
      "Não enviada. A mensagem tem 120.000 caracteres e o limite é 100.000. Envie o texto como arquivo.Editar",
    );
    // Something typed meanwhile stays: the refused text goes in before it.
    await act(async () => fireEvent.change(composer(), { target: { value: "outro rascunho" } }));
    await act(async () => fireEvent.click(within(failed).getByRole("button", { name: "Editar" })));
    await settle(2);
    expect(composer().value).toBe("texto recusado\n\noutro rascunho");
    expect(
      screen()
        .queryAllByRole("article")
        .some((a) => a.textContent?.includes("Não enviada")),
    ).toBe(false);
  });
});

// The whole suite shares one DOM: the next files measure with its own getters again.
afterAll(() => {
  for (const key of ["scrollHeight", "clientHeight"] as const) {
    const own = heights[key];
    if (own) Object.defineProperty(HTMLElement.prototype, key, own);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
});
