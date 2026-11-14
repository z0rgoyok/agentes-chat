import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type AiAccounts, type AiComputer, ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { createFakeAuth } from "./fake-auth";
import { renderApp, screen, settle, showIn } from "./render";

/*
 * A plan serves the whole workspace unless whoever connected it keeps it to themselves (ADR 0059 §3, amended
 * 2026-11-12): IA e uso says who uses each one and lets its owner choose. Sua conta changes the account's address with
 * the code sent to the current one, or a sign-in again (ADR 0088 §2, addendum 2026-11-13).
 */

afterEach(() => cleanup());

const MAC: AiComputer = {
  machineId: "machine_1",
  name: "MacBook",
  online: true,
  mine: true,
  canAdd: true,
  keys: true,
  brains: { claude_code: true, codex: true },
};
const plan = (id: string, over: Partial<AiAccounts["accounts"][number]> = {}): AiAccounts["accounts"][number] => ({
  id,
  kind: "claude_code",
  label: "Claude",
  email: null,
  plan: "team",
  status: "active",
  ownerId: "u-walter",
  ownerName: "Walter",
  mine: true,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
  machineId: "machine_1",
  computer: "MacBook",
  serves: "everyone",
  ...over,
});

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};

describe("IA e uso: who uses each plan", () => {
  test("each row says it, and only who connected a plan chooses Todos do workspace or Só eu", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setAiAccounts({
      accounts: [
        plan("acct_mine", { label: "Claude Team" }),
        plan("acct_joao", {
          label: "Claude 2",
          ownerId: "u-joao",
          ownerName: "João Silva",
          mine: false,
          serves: "owner",
        }),
      ],
      computers: [MAC],
    });
    await renderApp(`/org/${ORG_ID}/settings/usage`, { api });
    await settle(6);
    const plans = screen().getByRole("region", { name: "Contas" });
    const rows = [...plans.querySelectorAll(".plan-row")] as HTMLElement[];
    const mine = rows.find((r) => r.textContent?.includes("Claude Team")) as HTMLElement;
    const joao = rows.find((r) => r.textContent?.includes("Claude 2")) as HTMLElement;
    expect(mine.querySelector(".plan-acct__name")?.textContent).toContain("de Walter · Todos usam");
    expect(joao.querySelector(".plan-acct__name")?.textContent).toContain("de João · Só João usa");
    // Opened, the plan's owner chooses; on someone else's there is nothing to choose.
    await click(mine.querySelector(".plan-row__head") as HTMLElement);
    await click(joao.querySelector(".plan-row__head") as HTMLElement);
    expect(within(joao).queryByRole("radiogroup", { name: "Quem usa" })).toBeNull();
    const choice = within(mine).getByRole("radiogroup", { name: "Quem usa" });
    expect(within(mine).getByRole("button", { name: "Sobre os termos do plano" })).toBeTruthy();
    await click(within(choice).getByRole("radio", { name: "Só eu" }));
    expect(state.calls.filter((c) => c.method === "machines.setAccountServes").map((c) => c.args)).toEqual([
      [ORG_ID, "acct_mine", "owner"],
    ]);
  });
});

describe("Sua conta: the account's e-mail (ADR 0088 §2, addendum 2026-11-13)", () => {
  const open = async (state = seedState(), auth = createFakeAuth()) => {
    const view = await renderApp(`/org/${ORG_ID}/settings/account`, { api: createFakeApi(state), auth: auth.auth });
    await click(screen().getByRole("button", { name: /^E-mail/ }));
    return { ...view, state, auth, dialog: screen().getByRole("dialog", { name: "Mudar e-mail" }) };
  };
  const type = async (field: HTMLElement, value: string) => {
    await act(async () => fireEvent.change(field, { target: { value } }));
    await settle(2);
  };
  const changes = (state: ReturnType<typeof seedState>) =>
    state.calls.filter((c) => c.method === "account.changeEmail").map((c) => c.args[0]);

  test("the new address, then the code sent to the current one, then a link to the new address", async () => {
    const { state, dialog, router } = await open();
    // Kept in the address: a sign-in again comes back to it.
    expect(router.state.location.search).toMatchObject({ account: "email" });
    const change = () => within(dialog).getByRole("button", { name: "Mudar e-mail" });
    expect(change().hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Novo e-mail"), "walter@novo.example.com");
    await click(change());
    expect(changes(state)).toEqual([{ newEmail: "walter@novo.example.com" }]);
    const me = state.me?.user.email ?? "";
    expect(dialog.textContent).toContain(`Mandamos para ${me}. Vale por 10 minutos.`);
    expect(within(dialog).getByRole("button", { name: "Enviar outro em 1:00" }).hasAttribute("disabled")).toBe(true);
    expect(change().hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Código do email"), "123 456");
    await click(change());
    expect(changes(state).at(-1)).toEqual({ newEmail: "walter@novo.example.com", code: "123456" });
    expect(dialog.textContent).toContain("Enviamos um link para walter@novo.example.com.");
  });

  test("a code refused says so under the code, and another address takes its own code", async () => {
    const state = seedState();
    const { dialog } = await open(state);
    await type(within(dialog).getByLabelText("Novo e-mail"), "walter@novo.example.com");
    await click(within(dialog).getByRole("button", { name: "Mudar e-mail" }));
    state.emailChangeError = new ApiError(400, "reauth.code_wrong", "That code isn't right.");
    await type(within(dialog).getByLabelText("Código do email"), "111111");
    await click(within(dialog).getByRole("button", { name: "Mudar e-mail" }));
    expect(dialog.textContent).toContain("Código errado. Tente de novo.");
    expect((within(dialog).getByLabelText("Código do email") as HTMLInputElement).value).toBe("");
    await type(within(dialog).getByLabelText("Novo e-mail"), "walter@outro.example.com");
    expect(within(dialog).queryByLabelText("Código do email")).toBeNull();
  });

  test("can't open that inbox: a sign-in again instead, which comes back to the dialog with the address typed", async () => {
    const state = seedState();
    const fake = createFakeAuth();
    // Signed out for real: the sign-in page stays.
    const signOut = fake.auth.signOut;
    fake.auth.signOut = async () => {
      await signOut();
      state.me = null;
    };
    const { dialog, router } = await open(state, fake);
    await type(within(dialog).getByLabelText("Novo e-mail"), "walter@novo.example.com");
    await click(within(dialog).getByRole("button", { name: "Mudar e-mail" }));
    await click(within(dialog).getByRole("button", { name: "Não consegue abrir esse e-mail?" }));
    expect(dialog.textContent).toContain("Entre de novo e troque sem o código. Você volta para cá.");
    expect(within(dialog).queryByLabelText("Código do email")).toBeNull();
    // The browser's address is the page's (the tests' router keeps its own).
    window.history.replaceState(null, "", router.state.location.href);
    await click(within(dialog).getByRole("button", { name: "Entrar de novo" }));
    expect(fake.calls.map((c) => c.method)).toContain("signOut");
    expect(router.state.location.pathname).toBe("/login");
    expect(String(router.state.location.search.redirect)).toContain("account=email");
    expect(sessionStorage.getItem("agentes.emailChangeAsk")).toBe("walter@novo.example.com");
  });

  test("back from signing in again, the dialog opens with the address typed, and changes without a code", async () => {
    sessionStorage.setItem("agentes.emailChangeAsk", "walter@novo.example.com");
    const state = seedState();
    state.emailChange = { status: "sent", email: "walter@novo.example.com" };
    const view = await renderApp(`/org/${ORG_ID}/settings/account?account=email`, { api: createFakeApi(state) });
    const dialog = screen().getByRole("dialog", { name: "Mudar e-mail" });
    expect((within(dialog).getByLabelText("Novo e-mail") as HTMLInputElement).value).toBe("walter@novo.example.com");
    expect(sessionStorage.getItem("agentes.emailChangeAsk")).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Mudar e-mail" }));
    expect(dialog.textContent).toContain("Enviamos um link para walter@novo.example.com.");
    expect(view.router.state.location.search).toMatchObject({ account: "email" });
  });

  test("a current address never confirmed gets no code: the way on is a sign-in again, back to the dialog", async () => {
    const state = seedState();
    const fake = createFakeAuth();
    const signOut = fake.auth.signOut;
    fake.auth.signOut = async () => {
      await signOut();
      state.me = null;
    };
    state.emailChangeError = new ApiError(403, "reauth.sign_in", "Sign in again to change your email");
    const { dialog, router } = await open(state, fake);
    await type(within(dialog).getByLabelText("Novo e-mail"), "walter@novo.example.com");
    await click(within(dialog).getByRole("button", { name: "Mudar e-mail" }));
    expect(dialog.textContent).toContain("Entre de novo para confirmar que é você.");
    expect(within(dialog).queryByLabelText("Código do email")).toBeNull();
    window.history.replaceState(null, "", router.state.location.href);
    await click(within(dialog).getByRole("button", { name: "Entrar de novo" }));
    expect(router.state.location.pathname).toBe("/login");
    expect(String(router.state.location.search.redirect)).toContain("account=email");
    expect(sessionStorage.getItem("agentes.emailChangeAsk")).toBe("walter@novo.example.com");
  });

  test("a server that sends no e-mail changes it at once, and a held address is said under it", async () => {
    const state = seedState();
    state.emailChange = { status: "changed", email: "walter@novo.example.com" };
    const { dialog } = await open(state);
    await type(within(dialog).getByLabelText("Novo e-mail"), "walter@novo.example.com");
    await click(within(dialog).getByRole("button", { name: "Mudar e-mail" }));
    expect(dialog.textContent).toContain("Pronto: agora você entra com walter@novo.example.com.");

    const held = seedState();
    held.emailChangeError = new ApiError(409, "email.held", "This address left another account a moment ago");
    cleanup();
    const second = await open(held);
    await type(within(second.dialog).getByLabelText("Novo e-mail"), "ana@example.com");
    await click(within(second.dialog).getByRole("button", { name: "Mudar e-mail" }));
    expect(second.dialog.textContent).toContain("Este e-mail acabou de sair de outra conta");
  });

  test("worst case: long addresses with nothing to break at, in German, at every step", async () => {
    const state = seedState();
    const current = "aleksandra.wisniewskakowalczyk@northwindindustriesholdings.example.com";
    const next = "bartholomew.fitzgeraldmontgomery@northwindindustriesholdings.example.com";
    if (state.me) state.me.user.email = current;
    const { dialog, services } = await open(state);
    await showIn(services, "de");
    await type(within(dialog).getByRole("textbox"), next);
    await click(within(dialog).getByRole("button", { name: "E-Mail ändern" }));
    expect(dialog.textContent).toContain(current);
    state.emailChangeError = new ApiError(429, "reauth.code_limit", "Too many codes for this email.");
    await type(within(dialog).getByLabelText("Code aus der E-Mail"), "123456");
    await click(within(dialog).getByRole("button", { name: "E-Mail ändern" }));
    await click(within(dialog).getByRole("button", { name: "Kein Zugriff auf dieses Postfach?" }));
    await click(within(dialog).getByRole("button", { name: "Code verwenden" }));
    state.emailChangeError = undefined;
    await type(within(dialog).getByLabelText("Code aus der E-Mail"), "654321");
    await click(within(dialog).getByRole("button", { name: "E-Mail ändern" }));
    expect(dialog.textContent).toContain(next);
  });

  test("worst case: a long address never confirmed, in German, gets the sign-in again instead of a code", async () => {
    const state = seedState();
    if (state.me) state.me.user.email = "aleksandra.wisniewskakowalczyk@northwindindustriesholdings.example.com";
    state.emailChangeError = new ApiError(403, "reauth.sign_in", "Sign in again to change your email");
    const { dialog, services } = await open(state);
    await showIn(services, "de");
    await type(
      within(dialog).getByRole("textbox"),
      "bartholomew.fitzgeraldmontgomery@northwindindustriesholdings.example.com",
    );
    await click(within(dialog).getByRole("button", { name: "E-Mail ändern" }));
    expect(dialog.textContent).toContain("Melde dich erneut an, um zu bestätigen, dass du es bist.");
    expect(within(dialog).getByRole("button", { name: "Erneut anmelden" })).toBeTruthy();
  });
});

describe("“Não fui eu”: the page the old address's notice opens", () => {
  test("only its button acts: the address comes back, and the way on is to sign in", async () => {
    const state = seedState({ me: null });
    await renderApp("/email-undo?token=tok-undo-1", { api: createFakeApi(state) });
    expect(screen().getByRole("heading", { name: "Trazer seu e-mail de volta" })).toBeTruthy();
    expect(state.calls.filter((c) => c.method === "account.undoEmailChange")).toEqual([]);
    await click(screen().getByRole("button", { name: /Não fui eu/ }));
    expect(state.calls.filter((c) => c.method === "account.undoEmailChange").map((c) => c.args)).toEqual([
      ["tok-undo-1"],
    ]);
    expect(screen().getByRole("heading", { name: "Seu e-mail voltou" })).toBeTruthy();
    expect(document.body.textContent).toContain("walter@example.com voltou a ser o e-mail da sua conta");
    expect(screen().getByRole("link", { name: "Entrar" }).getAttribute("href")).toBe(
      "/login?email=walter%40example.com",
    );
  });

  test("a link used, run out or broken says so, with the way to sign in", async () => {
    const state = seedState({ me: null });
    state.undoError = new ApiError(404, "email.undo_gone", "This link expired or was already used");
    await renderApp("/email-undo?token=tok-old", { api: createFakeApi(state) });
    await click(screen().getByRole("button", { name: /Não fui eu/ }));
    expect(screen().getByRole("heading", { name: "Este link não vale mais" })).toBeTruthy();
    expect(screen().getByRole("link", { name: "Entrar" })).toBeTruthy();
    cleanup();
    await renderApp("/email-undo", { api: createFakeApi(seedState({ me: null })) });
    expect(screen().getByRole("heading", { name: "Este link não vale mais" })).toBeTruthy();
    expect(screen().queryByRole("button", { name: /Não fui eu/ })).toBeNull();
  });

  test("worst case: a long address with nothing to break at, in German, back and taken", async () => {
    const back = "aleksandra.wisniewskakowalczyk@northwindindustriesholdings.example.com";
    // Back first: the geometry check measures one screen of each shape, and this one has the page's longest words.
    const done = seedState({ me: null });
    done.undoBack = back;
    const first = await renderApp("/email-undo?token=tok-worst", { api: createFakeApi(done) });
    await showIn(first.services, "de");
    await click(screen().getByRole("button", { name: /Das war ich nicht/ }));
    expect(document.body.textContent).toContain(`${back} ist wieder die E-Mail-Adresse deines Kontos`);
    expect(document.body.textContent).toContain("Anmeldewege, die seit der Änderung hinzugekommen sind");
    cleanup();
    const state = seedState({ me: null });
    state.undoError = new ApiError(409, "email.undo_taken", "Another account has this address now", { email: back });
    const { services } = await renderApp("/email-undo?token=tok-worst-2", { api: createFakeApi(state) });
    await showIn(services, "de");
    await click(screen().getByRole("button", { name: /Das war ich nicht/ }));
    expect(document.body.textContent).toContain(back);
  });
});
