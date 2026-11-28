import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { keys } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { createFakeAuth } from "./fake-auth";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

// act's thenable doesn't chain: a `.then` on it isn't awaited, and the next act overlaps the settling one.
const click = async (el: Element, times = 4) => {
  await act(async () => {
    fireEvent.click(el);
  });
  await settle(times);
};
const button = (name: string | RegExp) => screen().getByRole("button", { name });
/** The account's e-mail dialog, once its code (loaded when it first opens) is here. */
async function emailDialog() {
  for (let i = 0; i < 60 && !screen().queryByRole("dialog", { name: "Mudar e-mail" }); i++)
    await act(() => Bun.sleep(50));
  return screen().getByRole("dialog", { name: "Mudar e-mail" });
}

/** Signed in as Walter at `email`, in no workspace (`required`) or in Acme (`reminder`), at `path`. */
async function open(
  path: string,
  confirmation: "required" | "reminder",
  email = "walter@example.com",
  emailUndelivered: "suppressed" | "rejected" | null = null,
) {
  const state = seedState();
  if (!state.me) throw new Error("signed in");
  state.me.user = { ...state.me.user, email, emailVerified: false, emailConfirmation: confirmation, emailUndelivered };
  if (confirmation === "required") state.me.organizations = [];
  const fake = createFakeAuth();
  const r = await renderApp(path, { api: createFakeApi(state), auth: fake.auth });
  await settle(8);
  return { ...r, state, authCalls: fake.calls };
}

describe("a new account's address never confirmed (ADR 0006, addendum 2026-11-22)", () => {
  test("the onboarding waits on “check your inbox”: its mail app, a new link, a new address, Sair", async () => {
    const { authCalls } = await open("/onboarding", "required", "caixa.inventada@gmail.com");
    expect(screen().getByRole("heading", { name: "Confira seu e-mail" })).toBeTruthy();
    expect(document.body.textContent).toContain(
      "Abra o link que mandamos para caixa.inventada@gmail.com para continuar.",
    );
    expect(screen().getByRole("link", { name: "Abrir o Gmail" }).getAttribute("href")).toBe("https://mail.google.com");
    expect(screen().queryByRole("radio", { name: /Para meu time/ })).toBeNull();

    expect(button("Sair")).toBeTruthy();
    await click(button("Mandar outro link"));
    expect(authCalls).toEqual([{ method: "sendVerificationEmail", args: ["caixa.inventada@gmail.com"] }]);

    await click(button("Endereço errado? Trocar"));
    const dialog = await emailDialog();
    expect(within(dialog).getByLabelText("Novo e-mail")).toBeTruthy();
  });

  test("a link that could never be delivered: the screen and the line say why, the new link and address stay", async () => {
    await open("/onboarding", "required", "walter@example.com", "suppressed");
    const said = screen().getByRole("alert");
    expect(said.textContent).toBe(
      "O e-mail não chegou: o provedor de e-mail bloqueou walter@example.com depois de uma devolução. Confira se o endereço está certo e peça um link novo.",
    );
    expect(button("Mandar outro link")).toBeTruthy();
    expect(button("Endereço errado? Trocar")).toBeTruthy();
    cleanup();
    await open(`/org/${ORG_ID}`, "reminder", "walter@example.com", "rejected");
    expect(screen().getByRole("region", { name: "Confirme seu e-mail" }).textContent).toContain(
      "O e-mail não chegou: walter@example.com foi recusado. Confira se o endereço está certo ou troque por outro.",
    );
  });

  test("once the link is opened, elsewhere too, the onboarding takes over", async () => {
    const { state, services } = await open("/onboarding", "required", "walter@acme.com.br");
    // No mail app known for the address: a new link is the main button.
    expect(screen().queryByRole("link", { name: /^Abrir o / })).toBeNull();
    expect(button("Mandar outro link").className).toContain("primary");
    if (!state.me) throw new Error("signed in");
    state.me.user = { ...state.me.user, emailVerified: true, emailConfirmation: null };
    await act(async () => services.queryClient.invalidateQueries({ queryKey: keys.me }));
    await settle(8);
    expect(screen().queryByRole("heading", { name: "Confira seu e-mail" })).toBeNull();
    expect(screen().getByRole("radio", { name: /Para meu time/ })).toBeTruthy();
  });

  test("an account already in a workspace keeps it, under a line with a new link and a new address", async () => {
    const { authCalls, router } = await open(`/org/${ORG_ID}`, "reminder");
    const line = screen().getByRole("region", { name: "Confirme seu e-mail" });
    expect(line.textContent).toContain("Abra o link que mandamos para walter@example.com.");
    await click(within(line).getByRole("button", { name: "Mandar outro link" }));
    expect(authCalls).toEqual([{ method: "sendVerificationEmail", args: ["walter@example.com"] }]);
    await click(within(line).getByRole("button", { name: "Trocar endereço" }));
    expect((router.state.location.search as { account?: string }).account).toBe("email");
    expect(await emailDialog()).toBeTruthy();
  });
});
