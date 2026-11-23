import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { setNavigateAway } from "@/lib/navigate";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const REFERRALS = { referralsUrl: "https://refer.example.com" };
const press = async (k: string, el = document.activeElement ?? document.body) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await settle(4);
};
const openMenu = async () => {
  const account = screen().getByRole("button", { name: /^Conta: / });
  account.focus();
  await press("Enter", account);
  return screen().getAllByRole("menu")[0] as HTMLElement;
};
const names = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .map((el) => el.getAttribute("aria-label") ?? el.textContent);
const minted = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "account.referralsLink").map((c) => c.args);

describe("Indique e ganhe in the account menu", () => {
  test("only where the server has a referral service, right under Configurações", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(6);
    expect(names(await openMenu())).not.toContain("Indique e ganhe");
  });

  test("mints the link on the choice and leaves for it", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const state = seedState({ authConfig: REFERRALS });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const menu = await openMenu();
    const items = names(menu);
    expect(items[items.indexOf("Configurações") + 1]).toBe("Indique e ganhe");
    expect(minted(state)).toEqual([]);
    within(menu).getByRole("menuitem", { name: "Indique e ganhe" }).focus();
    await press("Enter");
    expect(minted(state)).toEqual([[`/org/${ORG_ID}/c/${ENG_ID}`]]);
    expect(left).toEqual(["https://refer.example.com/link?t=v1"]);
  });
});

describe("/refer", () => {
  test("signed in: leaves for the referral service at once, /refer left out of the history", async () => {
    const left: [string, boolean][] = [];
    setNavigateAway((url, options) => left.push([url, options?.replace === true]));
    const state = seedState({ authConfig: REFERRALS });
    await renderApp("/refer", { api: createFakeApi(state) });
    expect(minted(state)).toEqual([["/"]]);
    expect(left).toEqual([["https://refer.example.com/link?t=v1", true]]);
  });

  test("no referral service: the page that doesn't exist, with its way back", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const state = seedState({ referralsLinkError: new ApiError(404, "referrals.off", "off") });
    await renderApp("/refer", { api: createFakeApi(state) });
    await settle(6);
    expect(left).toEqual([]);
    expect(screen().getByRole("heading", { name: "Página não encontrada" })).toBeTruthy();
    expect(screen().getByRole("link", { name: "Voltar ao início" })).toBeTruthy();
  });

  test("signed out: sign in first, then back to /refer", async () => {
    const { router } = await renderApp("/refer", { api: createFakeApi(seedState({ me: null })) });
    await settle(6);
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toMatchObject({ redirect: "/refer" });
  });
});
