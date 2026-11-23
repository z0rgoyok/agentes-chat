import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Composer, ComposerFile, type ComposerProps, type ComposerVoice } from "../src";
import type { VoiceNotice } from "../src/components/voice-recorder";
import { fakeMicrophone } from "../testing/microphone";

let restore = () => {};
afterEach(() => {
  cleanup();
  restore();
});

const LABELS: ComposerVoice["labels"] = {
  record: "Gravar áudio",
  recording: "Gravando áudio",
  pause: "Pausar",
  resume: "Continuar gravando",
  discard: "Apagar gravação",
  send: "Enviar áudio",
  listen: "Ouvir sua gravação",
  stopListening: "Parar de ouvir",
  keys: "Enter envia · Esc apaga",
  keysHold: "Solte para enviar · Esc apaga",
  keysPaused: "Pausado · Espaço ouve · Enter envia · Esc apaga",
  left: (s: number) => `faltam ${s} s`,
  askDiscard: "Apagar o áudio? O texto fica.",
  askDelete: "Apagar",
  askKeep: "Manter",
};

function setup(start = "", rest: Partial<ComposerProps> = {}) {
  restore = fakeMicrophone();
  const takes: string[] = [];
  const notices: VoiceNotice[] = [];
  const sent: string[] = [];
  function Box() {
    const [v, setV] = useState(start);
    return (
      <Composer
        value={v}
        onChange={setV}
        onSend={(text) => sent.push(text)}
        label="Mensagem para #eng"
        sendLabel="Enviar"
        attachLabel="Anexar arquivo"
        onFiles={() => {}}
        emoji={{
          button: "Emoji",
          dialog: "Emojis",
          search: "Buscar emoji",
          noResults: "Nenhum emoji encontrado.",
          recent: "Usados recentemente",
          results: "Resultados",
          categories: {
            smileys: "Carinhas",
            people: "Pessoas e gestos",
            nature: "Natureza",
            food: "Comida e bebida",
            activities: "Atividades",
            travel: "Viagens e lugares",
            objects: "Objetos",
            symbols: "Símbolos",
          },
        }}
        voice={{
          scope: "c",
          // The app reads the box itself when the take goes (`ChannelPage`): here, what it would read.
          onTake: () => takes.push(v),
          onNotice: (n) => notices.push(n),
          labels: LABELS,
        }}
        {...rest}
      />
    );
  }
  render(<Box />);
  return { takes, notices, sent };
}

const field = () => screen.getByRole("textbox", { name: "Mensagem para #eng" }) as HTMLTextAreaElement;
const take = () => document.querySelector(".ac-composer__attachments > .ac-composer__voice");
const hint = () => document.querySelector(".ac-composer__voice-hint")?.textContent ?? null;
const wait = (ms: number) => act(() => Bun.sleep(ms));

async function record() {
  await act(async () => {
    fireEvent.pointerDown(screen.getByRole("button", { name: "Gravar áudio" }), { button: 0 });
    fireEvent.pointerUp(window);
  });
  // Long enough to be a take (0.7 s), and past the click that follows the press.
  await wait(800);
}

async function pause() {
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pausar" })));
}

const key = (on: Element, init: KeyboardEventInit) => {
  let kept = true;
  act(() => {
    kept = fireEvent.keyDown(on, init);
  });
  return kept;
};

describe("a take is a row above the text", () => {
  test("in the files' strip, with the field, attach and emoji still there, and delete at the row's end", async () => {
    setup("", {
      attachments: <ComposerFile name="tela.png" status="done" removeLabel="Remover tela.png" onRemove={() => {}} />,
    });
    await record();
    const row = take() as HTMLElement;
    expect(row).toBeTruthy();
    // First in the strip, before the files attached before it.
    expect(row.parentElement?.firstElementChild).toBe(row);
    expect(row.parentElement?.textContent).toContain("tela.png");
    expect(row.lastElementChild?.getAttribute("aria-label")).toBe("Apagar gravação");
    expect(field().disabled).toBe(false);
    for (const name of ["Anexar arquivo", "Emoji", "Pausar", "Enviar áudio"])
      expect(screen.getByRole("button", { name })).toBeTruthy();
    // Nothing fixes the card's height: what is typed or attached during the take grows it as always.
    expect((document.querySelector(".ac-composer") as HTMLElement).style.maxHeight).toBe("");
  });

  test("the css hides neither the field, nor the tools, nor the pills while there is a take", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    expect(css).not.toContain(".ac-composer[data-voice] textarea");
    expect(css).not.toContain(".ac-composer[data-voice] .ac-composer__pills");
    expect(css).not.toContain(".ac-composer[data-voice] .ac-composer__tools");
  });
});

describe("nothing typed: the take's keys as they were", () => {
  test("Enter sends the take, from the page or from the empty field, and never a text message", async () => {
    const out = setup();
    await record();
    expect(hint()).toBe(LABELS.keys);
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Enter" });
      await Bun.sleep(20);
    });
    expect(out.takes).toEqual([""]);
    expect(out.sent).toEqual([]);
    expect(take()).toBeNull();

    await record();
    act(() => field().focus());
    expect(hint()).toBe(LABELS.keys);
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
      await Bun.sleep(20);
    });
    expect(out.takes).toEqual(["", ""]);
    expect(out.sent).toEqual([]);
  });

  test("Esc deletes it at once and says so; paused, Space listens", async () => {
    const out = setup();
    await record();
    await pause();
    expect(hint()).toBe(LABELS.keysPaused);
    expect(key(document.body, { key: " " })).toBe(false);
    key(document.body, { key: "Escape" });
    expect(take()).toBeNull();
    expect(out.notices).toEqual(["deleted"]);
    expect(out.takes).toEqual([]);
  });

  test("Enter on delete, reached with Tab, is delete's own: the take is never sent from it", async () => {
    const out = setup();
    await record();
    const trash = screen.getByRole("button", { name: "Apagar gravação" });
    act(() => trash.focus());
    expect(key(trash, { key: "Enter" })).toBe(true);
    await wait(20);
    expect(out.takes).toEqual([]);
  });

  test("a key an input method composes is never the take's", async () => {
    const out = setup();
    await record();
    expect(key(document.body, { key: "Enter", keyCode: 229 })).toBe(true);
    expect(key(document.body, { key: "Escape", isComposing: true })).toBe(true);
    await wait(20);
    expect(take()).toBeTruthy();
    expect(out.takes).toEqual([]);
  });
});

describe("text beside the take", () => {
  test("with the focus in the field the keys are the field's: Space types, Enter sends the take with the text", async () => {
    const out = setup("olha a tela");
    await record();
    await pause();
    act(() => field().focus());
    // The keys line is for keys that are the take's: here they are the field's.
    expect(hint()).toBeNull();
    expect(key(field(), { key: " " })).toBe(true);
    expect(screen.getByRole("button", { name: "Ouvir sua gravação" })).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
      await Bun.sleep(20);
    });
    expect(out.takes).toEqual(["olha a tela"]);
    expect(out.sent).toEqual([]);
    // Out of the field the keys line comes back.
    await record();
    act(() => field().blur());
    expect(hint()).toBe(LABELS.keys);
  });

  test("Esc never drops both: the row asks in place, Enter keeps, Apagar deletes the audio and the text stays", async () => {
    const out = setup("olha a tela");
    await record();
    act(() => field().focus());
    key(field(), { key: "Escape" });
    expect(take()).toBeNull();
    expect(screen.getByText(LABELS.askDiscard)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Enter answers Manter: the take is back, nothing sent.
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
      await Bun.sleep(20);
    });
    expect(take()).toBeTruthy();
    expect(out.takes).toEqual([]);
    expect(out.notices).toEqual([]);
    // Esc from outside the field asks too.
    act(() => field().blur());
    key(document.body, { key: "Escape" });
    expect(screen.getByText(LABELS.askDiscard)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apagar" })));
    expect(take()).toBeNull();
    expect(screen.queryByText(LABELS.askDiscard)).toBeNull();
    expect(out.notices).toEqual(["deleted"]);
    expect(field().value).toBe("olha a tela");
    expect(out.takes).toEqual([]);
  });

  test("Manter keeps the take and puts the focus back in the field", async () => {
    setup("olha a tela");
    await record();
    key(document.body, { key: "Escape" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Manter" })));
    expect(take()).toBeTruthy();
    expect(document.activeElement).toBe(field());
  });

  test("uploads still running hold the take's send, as they hold a typed message's", async () => {
    const out = setup("olha a tela", { sendBlocked: true });
    await record();
    const send = screen.getByRole("button", { name: "Enviar áudio" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Enter" });
      fireEvent.keyDown(field(), { key: "Enter" });
      await Bun.sleep(20);
    });
    expect(out.takes).toEqual([]);
    expect(take()).toBeTruthy();
  });
});
