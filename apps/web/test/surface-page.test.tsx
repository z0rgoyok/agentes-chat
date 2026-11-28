import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type SurfacePage } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, seedState } from "./fake-api";
import { renderApp, screen, settle, showIn } from "./render";

afterEach(() => cleanup());

const page = (over: Partial<SurfacePage> = {}, approval: Partial<NonNullable<SurfacePage["approval"]>> = {}) => ({
  kind: "confirm" as const,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  surface: "Example Chat",
  orgId: "org-pin",
  pin: { set: true, lockedUntil: null, canChoose: false, resetByEmail: true },
  approval: {
    id: "a-1",
    tool: "vault_delete",
    params: { key: "OLD_KEY" },
    title: "Delete the key OLD_KEY",
    detail: "{}",
    why: null,
    kind: "vault_delete",
    titleParams: {},
    status: "pending",
    canDecide: true,
    approverLabel: null,
    ...approval,
  },
  ...over,
});

async function open(surface: Partial<NonNullable<ReturnType<typeof seedState>["surface"]>>, token = "tok-1") {
  const state = seedState({ me: null });
  state.surface = { name: "Example Chat", links: [], ...surface };
  const app = await renderApp(`/surface-page${token ? `?token=${token}` : ""}`, { api: createFakeApi(state) });
  await settle(6);
  return { state, app };
}

const type = async (label: string, value: string) => {
  await act(async () => fireEvent.change(screen().getByLabelText(label), { target: { value } }));
  await settle(2);
};
const click = async (name: RegExp) => {
  await act(async () => fireEvent.click(screen().getByRole("button", { name })));
  await settle(4);
};
const calls = (state: ReturnType<typeof seedState>, method: string) =>
  state.calls.filter((c) => c.method === method).map((c) => c.args);

test("signed in here as the person, the first approval chooses the PIN, typed twice, hidden", async () => {
  const { state } = await open({
    page: page({ pin: { set: false, lockedUntil: null, canChoose: true, resetByEmail: true } }),
  });
  const first = screen().getByLabelText("Escolha um PIN") as HTMLInputElement;
  expect(first.type).toBe("password");
  const approve = () => screen().getByRole("button", { name: /Aprovar/ }) as HTMLButtonElement;
  await type("Escolha um PIN", "48a29b13");
  expect(first.value).toBe("482913");
  expect(approve().disabled).toBe(true);
  await type("Digite de novo", "482914");
  expect(document.body.textContent).toContain("Os dois PINs não são iguais.");
  await type("Digite de novo", "482913");
  expect(approve().disabled).toBe(false);
  await click(/Aprovar/);
  expect(calls(state, "surfaces.decidePage")).toEqual([[{ token: "tok-1", decision: "approve", pin: "482913" }]]);
  expect(screen().getByRole("heading", { name: "Aprovado" })).toBeTruthy();
  expect(document.body.textContent).toContain("Volte ao Example Chat.");
});

test("no PIN and nobody signed in here: set it first, in the app or by an emailed link; refusing needs none", async () => {
  const { state } = await open({
    page: page({ pin: { set: false, lockedUntil: null, canChoose: false, resetByEmail: true } }),
  });
  expect(screen().getByRole("heading", { name: "Escolha seu PIN primeiro" })).toBeTruthy();
  expect(screen().queryByLabelText("Escolha um PIN")).toBeNull();
  expect(screen().queryByRole("button", { name: /Aprovar/ })).toBeNull();
  const app = screen().getByRole("link", { name: "Escolher no app" }) as HTMLAnchorElement;
  expect(app.getAttribute("href")).toBe("/org/org-pin/settings/notifications?pin=1");
  await click(/Enviar um link por e-mail/);
  expect(calls(state, "surfaces.emailPin")).toEqual([["tok-1"]]);
  expect(document.body.textContent).toContain("Enviamos um link por e-mail. Escolha seu PIN lá");
  await click(/Recusar/);
  expect(calls(state, "surfaces.decidePage")).toEqual([[{ token: "tok-1", decision: "refuse", pin: undefined }]]);
  expect(screen().getByRole("heading", { name: "Recusado" })).toBeTruthy();
  cleanup();

  // A server that sends no email: the app is the one way.
  await open({ page: page({ pin: { set: false, lockedUntil: null, canChoose: false, resetByEmail: false } }) });
  expect(screen().queryByRole("button", { name: /Enviar um link/ })).toBeNull();
  expect(screen().getByRole("link", { name: "Escolher no app" })).toBeTruthy();
});

test("a wrong PIN says how many tries are left; refusing needs none", async () => {
  const { state } = await open({
    page: page(),
    decideError: new ApiError(403, "surface.pin_wrong", "Wrong PIN", { left: 2 }),
  });
  await type("Seu PIN", "000000");
  await click(/Aprovar/);
  expect(document.body.textContent).toContain("PIN errado. Tentativas restantes: 2.");
  expect((screen().getByLabelText("Seu PIN") as HTMLInputElement).value).toBe("");
  if (state.surface) state.surface.decideError = undefined;
  await click(/Recusar/);
  expect(calls(state, "surfaces.decidePage").at(-1)).toEqual([{ token: "tok-1", decision: "refuse", pin: undefined }]);
  expect(screen().getByRole("heading", { name: "Recusado" })).toBeTruthy();
});

test("locked, forgot, someone else decides, and a link that ran out", async () => {
  await open({
    page: page({
      pin: {
        set: true,
        lockedUntil: new Date(Date.now() + 60_000).toISOString(),
        canChoose: false,
        resetByEmail: true,
      },
    }),
  });
  expect(document.body.textContent).toContain("PINs errados demais.");
  expect((screen().getByRole("button", { name: /Aprovar/ }) as HTMLButtonElement).disabled).toBe(true);
  await click(/Esqueceu seu PIN/);
  expect(document.body.textContent).toContain("Enviamos um link por e-mail. Escolha seu PIN lá");
  cleanup();

  // A server that sends no email offers no reset by email.
  await open({ page: page({ pin: { set: true, lockedUntil: null, canChoose: false, resetByEmail: false } }) });
  expect(screen().queryByRole("button", { name: /Esqueceu seu PIN/ })).toBeNull();
  cleanup();

  await open({ page: page({}, { canDecide: false, approverLabel: "Bruno" }) });
  expect(document.body.textContent).toContain("Bruno decide isso no app.");
  expect(screen().queryByRole("button", { name: /Aprovar/ })).toBeNull();
  cleanup();

  await open({ page: new ApiError(403, "surface.page_elsewhere", "elsewhere") });
  expect(screen().getByRole("heading", { name: "Este link não funciona mais" })).toBeTruthy();
  expect(document.body.textContent).toContain("Este link foi aberto em outro aparelho.");
  cleanup();

  await open({}, "");
  expect(screen().getByRole("heading", { name: "Este link não funciona mais" })).toBeTruthy();
});

test("the PIN email's page chooses it, typed twice, only from its button", async () => {
  const state = seedState({ me: null });
  state.surface = { name: "Example Chat", links: [] };
  await renderApp("/email-undo?kind=surface-pin&token=tok-p", { api: createFakeApi(state) });
  await settle(6);
  expect(screen().getByRole("heading", { name: "Escolha seu PIN" })).toBeTruthy();
  const save = () => screen().getByRole("button", { name: /Salvar meu PIN/ }) as HTMLButtonElement;
  expect(save().disabled).toBe(true);
  await type("Escolha um PIN", "482913");
  await type("Digite de novo", "482913");
  expect(calls(state, "surfaces.pinFromEmail")).toEqual([]);
  await click(/Salvar meu PIN/);
  expect(calls(state, "surfaces.pinFromEmail")).toEqual([[{ token: "tok-p", pin: "482913" }]]);
  expect(screen().getByRole("heading", { name: "PIN salvo" })).toBeTruthy();
});

test("worst case: a long app name in German still shows the whole lead", async () => {
  const long = "Example Chat Longunbrokenwordxyz";
  const { app } = await open({
    name: long,
    page: page({ surface: long, pin: { set: false, lockedUntil: null, canChoose: false, resetByEmail: true } }),
  });
  await showIn(app.services, "de");
  expect(document.body.textContent).toContain(long);
});
