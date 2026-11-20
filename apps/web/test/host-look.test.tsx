import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { HostLook } from "@agenteschat/client";
import { DOCS_SITE } from "@agenteschat/i18n/docs";
import { accentPalette } from "@agenteschat/ui";
import { act, cleanup } from "@testing-library/react";
import { brandTabTitle, createI18n, translateTabTitle } from "@/i18n";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** ADR 0194: on a registered host, the pages before sign-in wear its look; elsewhere, nothing changes. */

const NORTHWIND = {
  name: "Northwind Studio",
  accent: "#7c3aed",
  logoUrl: "/api/host-look/logo?v=abc.png",
  poweredBy: true,
};

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("style");
});

const agentVar = () => document.documentElement.style.getPropertyValue("--agent");

async function signInPage(host: HostLook | null, social = true) {
  const state = seedState({ me: null });
  state.authConfig = { host, socialProviders: { google: social, github: social } };
  await renderApp("/login", { api: createFakeApi(state) });
}

describe("the sign-in page", () => {
  test("on a registered host: its logo and name, its accent, the powered-by line, no provider buttons", async () => {
    await signInPage(NORTHWIND, false);
    const logo = screen().getByRole("img", { name: "Northwind Studio" });
    expect(logo.getAttribute("src")).toBe(NORTHWIND.logoUrl);
    expect(document.querySelector(".auth--host")).not.toBeNull();
    expect(screen().queryByRole("img", { name: "agentes" })).toBeNull();
    const powered = screen().getByRole("link", { name: "Feito com agentes.chat" });
    expect(powered.getAttribute("href")).toBe(DOCS_SITE);
    expect(screen().queryByRole("button", { name: /Continuar com/ })).toBeNull();
    expect(agentVar()).toBe(accentPalette(NORTHWIND.accent).light.agent);
    // On a Cloud server too: no line naming the product's service, no way to its chooser.
    await settle(4);
    expect(document.querySelector(".auth__place")).toBeNull();
  });

  test("on a registered host with no logo: its name alone in the lockup's place", async () => {
    await signInPage({ ...NORTHWIND, logoUrl: null, accent: null }, false);
    expect(document.querySelector(".auth__host-name")?.textContent).toBe("Northwind Studio");
    expect(document.querySelector(".auth__host-logo")).toBeNull();
    expect(agentVar()).toBe("");
  });

  test("on a registered host whose operator turned the powered-by line off: its look without the line", async () => {
    await signInPage({ ...NORTHWIND, poweredBy: false }, false);
    expect(screen().getByRole("img", { name: "Northwind Studio" })).toBeTruthy();
    expect(screen().queryByRole("link", { name: "Feito com agentes.chat" })).toBeNull();
    expect(document.querySelector(".auth__powered")).toBeNull();
  });

  test("anywhere else: exactly as before", async () => {
    await signInPage(null);
    expect(screen().getByRole("img", { name: "agentes" })).toBeTruthy();
    expect(document.querySelector(".auth--host, .auth__powered")).toBeNull();
    expect(screen().getByRole("button", { name: /Continuar com GitHub/ })).toBeTruthy();
    expect(agentVar()).toBe("");
    await settle(4);
    expect(document.querySelector(".auth__place")?.textContent).toContain("Entrando no agentes.chat Cloud");
  });
});

test("inside a workspace the host's accent is gone: the workspace's own or the default", async () => {
  const state = seedState();
  state.authConfig = { host: NORTHWIND };
  await renderApp(`/org/${ORG_ID}/home`, { api: createFakeApi(state) });
  await settle();
  expect(agentVar()).not.toBe(accentPalette(NORTHWIND.accent).light.agent);
});

test("a suspended workspace's screen keeps the workspace's accent, on any host, while it shows and once lifted", async () => {
  const WORKSPACE = "#aa00ff";
  const workspaceAgent = accentPalette(WORKSPACE).light.agent;
  for (const host of [null, NORTHWIND]) {
    const state = seedState();
    state.authConfig = { host };
    if (state.me) {
      state.me.organizations = [
        { id: ORG_ID, name: "Acme", role: "owner", accent: WORKSPACE, standing: { state: "suspended", reason: null } },
      ];
    }
    const r = await renderApp(`/org/${ORG_ID}/home`, { api: createFakeApi(state) });
    await settle(8);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    const standing = async (next: Record<string, unknown>) => {
      await act(async () =>
        socket.push({ type: "event", scope: "org", event: { type: "org.standing", orgId: ORG_ID, ...next } }),
      );
      await settle(6);
    };
    expect(screen().getByRole("heading", { name: "Acme está indisponível" })).toBeTruthy();
    // A new reason renders the screen again.
    await standing({ state: "suspended", reason: "uso fora dos termos" });
    expect(document.documentElement.getAttribute("data-accent")).toBe(WORKSPACE);
    expect(agentVar()).toBe(workspaceAgent);
    await standing({ state: "active", reason: null });
    expect(screen().queryByRole("heading", { name: "Acme está indisponível" })).toBeNull();
    expect(document.documentElement.getAttribute("data-accent")).toBe(WORKSPACE);
    expect(agentVar()).toBe(workspaceAgent);
    cleanup();
  }
});

test("the tab's title names the host where it names the product, in every language and on every page", async () => {
  const i18n = createI18n("en");
  translateTabTitle(i18n);
  expect(document.title).toContain("agentes.chat");
  brandTabTitle("Northwind Studio");
  expect(document.title).toBe("Northwind Studio · Your team and your agents, in the same conversation");
  await act(async () => {
    document.title = "#general · Acme · agentes.chat";
    await Promise.resolve();
  });
  expect(document.title).toBe("#general · Acme · Northwind Studio");
  await act(async () => {
    document.title = "Northwind Studio · Your team and your agents, in the same conversation";
    await i18n.changeLanguage("pt-BR");
  });
  expect(document.title).toBe("Northwind Studio · Seu time e seus agentes, na mesma conversa");
  // A name with "$" is taken as written.
  brandTabTitle("Cash $& Co.");
  await act(async () => {
    document.title = "agentes.chat";
    await Promise.resolve();
  });
  expect(document.title).toBe("Cash $& Co.");
});
