import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { fakeMicrophone } from "@agenteschat/ui/testing";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** The microphone where nothing turns voice into text yet (`speechState`): it shows, and the first press asks. */

let restore = () => {};
afterEach(() => {
  cleanup();
  restore();
  restore = () => {};
  localStorage.clear();
});

const open = async (state: ReturnType<typeof seedState>) => {
  const api = createFakeApi(state);
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(5);
  return state;
};
const press = () =>
  act(async () => {
    fireEvent.pointerDown(screen().getByRole("button", { name: "Gravar áudio" }), { button: 0 });
    fireEvent.pointerUp(window);
  });
const recording = () => screen().queryByRole("button", { name: "Pausar" });

describe("the microphone with no engine on the server", () => {
  test("a member asks the owner by name, and the next press records at once", async () => {
    restore = fakeMicrophone();
    const state = await open(
      seedState({ media: { speechState: "none", speechOwner: { userId: "u-joao", name: "João" } } }),
    );
    await press();
    await settle();
    const dialog = screen().getByRole("dialog", { name: "A voz ainda não está ligada aqui" });
    expect(dialog.textContent).toContain("Os agentes só vão ouvir quando João escolher");
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Pedir para João" })));
    await settle();
    expect(state.calls.some((c) => c.method === "notifications.askAdmins")).toBe(true);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(recording()).toBeNull();
    await press();
    await act(() => Bun.sleep(150));
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(recording()).not.toBeNull();
  });

  test("Record anyway starts the take the person pressed for", async () => {
    restore = fakeMicrophone();
    await open(seedState({ media: { speechState: "none", speechOwner: null } }));
    await press();
    await settle();
    expect(screen().getByRole("dialog").textContent).toContain("quem cuida deste servidor");
    // Nobody to ask by name: no Ask button.
    expect(screen().queryByRole("button", { name: /Pedir para/ })).toBeNull();
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Gravar mesmo assim" })));
    await act(() => Bun.sleep(150));
    expect(recording()).not.toBeNull();
  });

  test("the server's owner chooses what turns voice into text right there", async () => {
    restore = fakeMicrophone();
    await open(
      seedState({
        media: { speechState: "none", speechOwner: { userId: "u-walter", name: "Walter" } },
        speechKey: { provider: null, hint: null, state: "off", envProviders: [] },
      }),
    );
    await press();
    await settle();
    expect(screen().getByRole("dialog", { name: "Escolha o que transforma a voz em texto" })).toBeTruthy();
    expect(screen().getByRole("radio", { name: "AssemblyAI" })).toBeTruthy();
    fireEvent.change(screen().getByLabelText("Chave da AssemblyAI"), { target: { value: "aai-key-12345678" } });
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Testar" })));
    await settle();
    expect(screen().getByRole("dialog", { name: "As mensagens de voz estão ligadas" })).toBeTruthy();
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Gravar uma mensagem" })));
    await act(() => Bun.sleep(150));
    expect(recording()).not.toBeNull();
  });

  const LOCAL = {
    fit: "fits" as const,
    memoryBytes: 16 * 2 ** 30,
    freeDiskBytes: 100 * 2 ** 30,
    needDiskBytes: 2 * 2 ** 30,
    sizeBytes: 773369957,
    status: { state: "off" as const },
  };
  const owner = (local: typeof LOCAL | (Omit<typeof LOCAL, "fit"> & { fit: "memory" })) =>
    seedState({
      media: { speechState: "none", speechOwner: { userId: "u-walter", name: "Walter" } },
      speechKey: { provider: null, hint: null, state: "off", envProviders: [] },
      speechLocal: local,
    });

  test("the owner downloads the model to this computer in one click, then records", async () => {
    restore = fakeMicrophone();
    const state = await open(owner(LOCAL));
    await press();
    await settle();
    const dialog = screen().getByRole("dialog", { name: "Escolha o que transforma a voz em texto" });
    expect(dialog.textContent).toContain("Neste computador");
    expect(dialog.textContent).toContain("Parakeet, um download de 738 MB");
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Baixar e ligar" })));
    await settle();
    expect(state.calls.some((c) => c.method === "system.installSpeechLocal")).toBe(true);
    expect(screen().getByRole("dialog", { name: "As mensagens de voz estão ligadas" })).toBeTruthy();
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Gravar uma mensagem" })));
    await act(() => Bun.sleep(150));
    expect(recording()).not.toBeNull();
  });

  test("a computer too small says so in numbers, and the provider keys stay right there", async () => {
    restore = fakeMicrophone();
    await open(owner({ ...LOCAL, fit: "memory", memoryBytes: 4 * 2 ** 30 }));
    await press();
    await settle();
    const dialog = screen().getByRole("dialog");
    expect(dialog.textContent).toContain("Este computador tem 4 GB de memória e o modelo de voz precisa de 8 GB");
    expect(screen().getByRole("button", { name: "Baixar e ligar" }).hasAttribute("disabled")).toBe(true);
    expect(screen().getByRole("radio", { name: "AssemblyAI" })).toBeTruthy();
  });

  test("an older server without the state keeps the microphone hidden with no engine", async () => {
    await open(seedState());
    expect(screen().queryByRole("button", { name: "Gravar áudio" })).toBeNull();
  });
});
