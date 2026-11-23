import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ApiClient, VaultItem, VaultItemInput } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

type State = ReturnType<typeof seedState>;

// A made-up key in Anthropic's shape, and a GitHub token's joined at run time (secret scanners read the literal shape).
const KEY = "sk-ant-api03-Zq8xW2pL5mN7vR1tY4uI9oP3aS6dF0gH-jK2lZ8xC5vB1nM4qW7eR9tY2uI6oP0aS3dF";
const GITHUB = ["ghp", "Fake0Fake1Fake2Fake3Fake4Fake5Fake6F"].join("_");

/** The Vault's create, logged as `vault.create`; nothing else of it is reached here. */
function fakeVault(state: State) {
  return {
    overview: async () => ({ items: [], connections: [], sources: [], canManageTeam: false }),
    create: async (orgId: string, input: VaultItemInput) => {
      state.calls.push({ method: "vault.create", args: [orgId, input] });
      return { id: "vi-1", kind: input.kind, scope: input.scope, title: input.title, keyName: input.keyName ?? null };
    },
  } as unknown as NonNullable<ApiClient["vault"]> & { create: (o: string, i: VaultItemInput) => Promise<VaultItem> };
}

const open = async (state: State = seedState()) => {
  const api = createFakeApi(state);
  api.vault = fakeVault(state);
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(5);
  await act(async () => r.sockets.last().open());
  await settle(2);
  return { ...r, state };
};
const composer = () => screen().getByRole("combobox", { name: /Mensagem para/, hidden: true }) as HTMLTextAreaElement;
const send = async (text: string) => {
  await act(async () => fireEvent.change(composer(), { target: { value: text } }));
  await act(async () => fireEvent.keyDown(composer(), { key: "Enter" }));
  await settle(4);
};
const guard = (name = "Isso parece uma chave de API") => screen().queryByRole("dialog", { name });
const click = async (el: HTMLElement) => {
  await act(async () => fireEvent.click(el));
  await settle(6);
};
const posts = (state: State) =>
  state.calls.filter((c) => c.method === "chat.post").map((c) => (c.args[2] as { body: string }).body);

describe("an API key in a message: nothing goes out until the person chooses", () => {
  test("Tirar do texto puts the message back without the key; Enviar mesmo assim sends it as written", async () => {
    const { state } = await open();
    await send(`@ada minha chave é ${KEY} conecta?`);
    const dialog = guard() as HTMLElement;
    expect(dialog.textContent).toContain("Tudo o que vai no chat fica visível para as pessoas e os agentes.");
    expect(posts(state)).toEqual([]);
    await click(within(dialog).getByRole("button", { name: "Tirar do texto" }));
    expect(guard()).toBeNull();
    expect(composer().value).toBe("@ada minha chave é conecta?");
    expect(posts(state)).toEqual([]);

    await send(`usa essa ${KEY}`);
    await click(within(guard() as HTMLElement).getByRole("button", { name: "Enviar mesmo assim" }));
    expect(posts(state)).toEqual([`usa essa ${KEY}`]);
    expect(composer().value).toBe("");
  });

  test("Salvar no Cofre: the Vault's new key opens on it, named after its maker, and the message keeps the rest", async () => {
    const { state } = await open();
    await send(`@ada usa essa ${KEY}`);
    await click(within(guard() as HTMLElement).getByRole("button", { name: "Salvar no Cofre" }));
    expect(composer().value).toBe("@ada usa essa");
    const form = screen().getByRole("dialog", { name: "Novo item" });
    expect(within(form).getByDisplayValue("MY_ANTHROPIC_API_KEY")).toBeTruthy();
    await click(within(form).getByRole("button", { name: "Salvar" }));
    expect(state.calls.find((c) => c.method === "vault.create")?.args[1]).toMatchObject({
      kind: "key",
      scope: "personal",
      keyName: "MY_ANTHROPIC_API_KEY",
      secret: KEY,
    });
    const toast = document.querySelector(".ac-toast")?.textContent;
    expect(toast).toContain("Salvo no Cofre");
    expect(toast).toContain("Os agentes com acesso usam pelo nome MY_ANTHROPIC_API_KEY.");
    expect(posts(state)).toEqual([]);
  });

  test("another service's token is a key or password: the Vault, never the AI key", async () => {
    const { state } = await open();
    await send(`o token do GitHub: ${GITHUB}`);
    const dialog = guard("Isso parece uma chave ou senha") as HTMLElement;
    expect(within(dialog).queryByRole("button", { name: "Usar como chave de IA" })).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Salvar no Cofre" }));
    expect(screen().getByRole("dialog", { name: "Novo item" })).toBeTruthy();
    expect(screen().getByDisplayValue("GITHUB_TOKEN")).toBeTruthy();
    expect(posts(state)).toEqual([]);
  });

  test("an admin can use an AI key as the organization's instead: Connect an AI opens on the key, with it", async () => {
    const { state } = await open();
    await send(`minha chave ${KEY}`);
    await click(within(guard() as HTMLElement).getByRole("button", { name: "Usar como chave de IA" }));
    const add = screen().getByRole("dialog", { name: "Conectar uma IA" });
    expect((within(add).getByLabelText("Cole aqui") as HTMLInputElement).value).toBe(KEY);
    expect(within(add).getByRole("combobox", { name: "Provedor" }).textContent).toBe("Claude");
    await click(within(add).getByRole("button", { name: "Salvar chave" }));
    expect(state.calls.find((c) => c.method === "agents.addCredential")?.args[1]).toMatchObject({
      provider: "anthropic",
    });
    // The workspace's key is another one: said, with the way to switch, which makes this one everyone's.
    expect(add.textContent).toContain("Salva. Os agentes ainda pensam com Claude da Acme.");
    await click(within(add).getByRole("button", { name: "Usar esta chave para todos" }));
    expect(state.calls.filter((c) => c.method === "agents.makeDefaultCredential")).toHaveLength(1);
    expect(state.defaultCredentialId).toBe(state.credentials.at(-1)?.id);
    expect(add.textContent).toContain("Salva. Os agentes sem uma IA própria pensam com ela.");
    await click(within(add).getByRole("button", { name: "Pronto" }));
    expect(composer().value).toBe("minha chave");
    expect(posts(state)).toEqual([]);
  });

  test("a member who doesn't manage the workspace's keys still keeps it in the Vault, never as the AI key", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await open(state);
    await send(`olha ${KEY}`);
    const dialog = guard() as HTMLElement;
    expect(within(dialog).queryByRole("button", { name: "Usar como chave de IA" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Salvar no Cofre" })).toBeTruthy();
    expect(posts(state)).toEqual([]);
  });

  test("ordinary text with sk- words goes out at once", async () => {
    const { state } = await open();
    await send("o sk-learn resolve isso");
    expect(guard()).toBeNull();
    expect(posts(state)).toEqual(["o sk-learn resolve isso"]);
  });
});
