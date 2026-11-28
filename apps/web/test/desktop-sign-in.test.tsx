import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { SignInOptions } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { ASK_BLUR_MS } from "@/components/BackToApp";
import { createFakeApi, seedState } from "./fake-api";
import { createFakeAuth } from "./fake-auth";
import { renderApp, screen, settle } from "./render";

/**
 * agentes for Mac (ADR 0036): in the app's window, Google/GitHub/Apple sign in
 * through the browser; the browser page hands the fresh sign-in back.
 */

const app = () => window as { __agentesDesktop?: unknown };
afterEach(() => {
  cleanup();
  delete app().__agentesDesktop;
  sessionStorage.clear();
});

const ACCOUNT: SignInOptions = { account: true, password: true, providers: [], canSignUp: false };
const ACCESS = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v";
const KEY = /^[A-Za-z0-9_-]{43}$/;
const heading = () => screen().getByRole("heading").textContent;

/** `window.location.assign` recorded instead of followed. */
function recordAssign() {
  const urls: string[] = [];
  const spy = spyOn(window.location, "assign").mockImplementation((url: string | URL) => {
    urls.push(String(url));
  });
  return { urls, restore: () => spy.mockRestore() };
}

describe("in the Mac app's window", () => {
  test("GitHub opens in the browser and the window waits, then enters", async () => {
    app().__agentesDesktop = { version: "0.6.0" };
    const assign = recordAssign();
    let redeemed = false;
    const { auth, calls } = createFakeAuth();
    auth.desktopRedeem = async (verifier) => {
      calls.push({ method: "desktopRedeem", args: [verifier] });
      return redeemed;
    };
    const state = seedState({ me: null });
    const api = createFakeApi(state);
    api.account.signInOptions = async () => ACCOUNT;
    try {
      await renderApp("/login", { api, auth });
      await act(async () => fireEvent.click(screen().getByRole("button", { name: /Continuar com GitHub/ })));
      await settle(6);
      expect(calls.some((c) => c.method === "signInSocial")).toBe(false);
      expect(heading()).toBe("Continue no navegador");
      // The window opens a request for the challenge and shows the code it got back.
      const opened = calls.find((c) => c.method === "desktopOpen");
      expect(opened?.args[0]).toMatch(KEY);
      expect(document.querySelector(".auth__codeValue")?.textContent).toBe("KQ7M-3XPF");
      // No address was typed (the provider picks the account): no empty address chip with only "Trocar".
      expect(document.querySelector(".auth__who")).toBeNull();
      const url = new URL(assign.urls[0] ?? "", "https://app.agentes.chat");
      // An app from before the link back: the browser's page doesn't hand the person back to it.
      expect(url.searchParams.get("back")).toBeNull();
      expect(url.pathname).toBe("/desktop/sign-in");
      expect(url.searchParams.get("provider")).toBe("github");
      // The request id travels through the browser, never the challenge or the verifier.
      expect(url.searchParams.get("request")).toBe("r".repeat(43));
      expect(url.searchParams.get("challenge")).toBeNull();

      // Not yet: stays. Back in front after the browser finished: enters.
      await act(async () => window.dispatchEvent(new Event("focus")));
      await settle(3);
      expect(assign.urls).toHaveLength(1);
      redeemed = true;
      await act(async () => window.dispatchEvent(new Event("focus")));
      await settle(3);
      expect(assign.urls[1]).toBe("/desktop/signed-in?to=%2F");
      const verifiers = calls.filter((c) => c.method === "desktopRedeem").map((c) => c.args[0]);
      expect(verifiers[0]).toMatch(KEY);
      // The verifier never left the window: only the request id went to the browser.
      expect(url.searchParams.get("request")).not.toBe(verifiers[0]);
    } finally {
      assign.restore();
    }
  });

  test("from an early-access link: the browser it opens, and opens again, carries the link's token", async () => {
    app().__agentesDesktop = { version: "0.6.0" };
    const assign = recordAssign();
    const api = createFakeApi(seedState({ me: null }));
    api.account.signInOptions = async () => ({ account: false, password: false, providers: [], canSignUp: true });
    try {
      await renderApp(`/signup?email=ana%40acme.com&access=${ACCESS}`, { api, auth: createFakeAuth().auth });
      await settle(6);
      await act(async () => fireEvent.click(screen().getByRole("button", { name: "Trocar" })));
      await act(async () => fireEvent.click(screen().getByRole("button", { name: /Continuar com GitHub/ })));
      await settle(6);
      await act(async () => fireEvent.click(screen().getByRole("button", { name: "Abrir o navegador de novo" })));
      expect(assign.urls.map((u) => new URL(u, "https://app.agentes.chat").searchParams.get("access"))).toEqual([
        ACCESS,
        ACCESS,
      ]);
    } finally {
      assign.restore();
    }
  });

  test("an app that takes the link back: the browser's page is told to hand the person back to it", async () => {
    app().__agentesDesktop = { version: "0.9.0", signedInLink: true };
    const assign = recordAssign();
    const api = createFakeApi(seedState({ me: null }));
    api.account.signInOptions = async () => ACCOUNT;
    try {
      await renderApp("/login", { api, auth: createFakeAuth().auth });
      await act(async () => fireEvent.click(screen().getByRole("button", { name: /Continuar com GitHub/ })));
      await settle(6);
      expect(new URL(assign.urls[0] ?? "", "https://app.agentes.chat").searchParams.get("back")).toBe("1");
    } finally {
      assign.restore();
    }
  });

  test("the code stands on its own line, never broken, its explanation centred under it", () => {
    const css = readFileSync(join(import.meta.dir, "../src/components/auth.css"), "utf8");
    const rule = (sel: string) => css.split(`\n${sel} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".auth__code")).toContain("flex-direction: column;");
    expect(rule(".auth__code")).toContain("align-items: center;");
    expect(rule(".auth__codeValue")).toContain("white-space: nowrap;");
  });

  test("outside the app, GitHub signs in right here as before", async () => {
    const { auth, calls } = createFakeAuth();
    const api = createFakeApi(seedState({ me: null }));
    await renderApp("/login", { api, auth });
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /Continuar com GitHub/ })));
    await settle(3);
    expect(calls[0]).toEqual({ method: "signInSocial", args: ["github", "/"] });
  });
});

describe("in the browser, for the app", () => {
  const request = "r".repeat(43);

  test("goes to the provider, and back from it asks to confirm the code before handing over", async () => {
    const first = createFakeAuth();
    await renderApp(`/desktop/sign-in?provider=github&request=${request}`, {
      api: createFakeApi(seedState({ me: null })),
      auth: first.auth,
    });
    await settle(3);
    // A refusal comes back to this page, without `done`.
    expect(first.calls[0]).toEqual({
      method: "signInSocial",
      args: [
        "github",
        `/desktop/sign-in?provider=github&request=${request}&done=1`,
        undefined,
        `/desktop/sign-in?provider=github&request=${request}`,
      ],
    });
    cleanup();

    const back = createFakeAuth();
    await renderApp(`/desktop/sign-in?provider=github&request=${request}&done=1`, {
      api: createFakeApi(seedState()),
      auth: back.auth,
    });
    await settle(3);
    // The code is read and shown, but nothing is handed over yet.
    expect(back.calls).toEqual([{ method: "desktopRequestCode", args: [request] }]);
    expect(document.querySelector(".auth__codeValue")?.textContent).toBe("KQ7M-3XPF");
    expect(back.calls.some((c) => c.method === "desktopHandoff")).toBe(false);
    // Only the person's confirmation hands it over.
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /Sim, entrar no app/ })));
    await settle(3);
    expect(back.calls.some((c) => c.method === "desktopHandoff" && c.args[0] === request)).toBe(true);
    expect(heading()).toBe("Tudo certo.");
  });

  test("refused by the provider or the server: why, and back to the app, never the provider again", async () => {
    const { auth, calls } = createFakeAuth();
    await renderApp(`/desktop/sign-in?provider=github&request=${request}&error=access_denied`, {
      api: createFakeApi(seedState({ me: null })),
      auth,
    });
    await settle(3);
    expect(heading()).toBe("O login não terminou.");
    expect(document.querySelector(".auth__lead")?.textContent).toBe(
      "O login foi cancelado. Volte ao app para tentar de novo.",
    );
    expect(calls).toEqual([]);
  });

  test("an early-access token from the app's window goes on to the provider, for the sign-up it makes", async () => {
    const { auth, calls } = createFakeAuth();
    await renderApp(`/desktop/sign-in?provider=google&request=${request}&access=${ACCESS}`, {
      api: createFakeApi(seedState({ me: null })),
      auth,
    });
    await settle(3);
    expect(calls[0]).toEqual({
      method: "signInSocial",
      args: [
        "google",
        `/desktop/sign-in?provider=google&request=${request}&done=1`,
        ACCESS,
        `/desktop/sign-in?provider=google&request=${request}`,
      ],
    });
  });

  test("for an app that takes the link back: once done, back to the app, with a button for when the browser didn't", async () => {
    const first = createFakeAuth();
    await renderApp(`/desktop/sign-in?provider=github&request=${request}&back=1`, {
      api: createFakeApi(seedState({ me: null })),
      auth: first.auth,
    });
    await settle(3);
    // The provider's round trip keeps it, both ways.
    expect(first.calls[0]?.args[1]).toBe(`/desktop/sign-in?provider=github&request=${request}&done=1&back=1`);
    expect(first.calls[0]?.args[3]).toBe(`/desktop/sign-in?provider=github&request=${request}&back=1`);
    cleanup();

    const assign = recordAssign();
    try {
      await renderApp(`/desktop/sign-in?provider=github&request=${request}&done=1&back=1`, {
        api: createFakeApi(seedState()),
        auth: createFakeAuth().auth,
      });
      await settle(3);
      expect(assign.urls).toEqual([]);
      await act(async () => fireEvent.click(screen().getByRole("button", { name: /Sim, entrar no app/ })));
      await settle(3);
      expect(heading()).toBe("Tudo certo.");
      expect(document.querySelector(".auth__lead")?.textContent).toBe("Voltando para o app.");
      expect(assign.urls).toEqual(["agenteschat://desktop/signed-in"]);
      expect(screen().getByRole("link", { name: "Abrir o app" }).getAttribute("href")).toBe(
        "agenteschat://desktop/signed-in",
      );
    } finally {
      assign.restore();
    }
  });

  test("a connector's sign-in for the app: the tab hands its link to the app and says so, only the app's own links", async () => {
    const assign = recordAssign();
    const link = "agenteschat://desktop/connectors/oauth?org=o1&state=s1&code=c1";
    try {
      await renderApp(`/desktop/back#${encodeURIComponent(link)}`, { api: createFakeApi(seedState({ me: null })) });
      await settle(3);
      expect(heading()).toBe("Voltando para o app.");
      expect(assign.urls).toEqual([link]);
      expect(screen().getByRole("link", { name: "Abrir o app" }).getAttribute("href")).toBe(link);
      cleanup();
      await renderApp(`/desktop/back#${encodeURIComponent("https://example.com/")}`, {
        api: createFakeApi(seedState({ me: null })),
      });
      await settle(3);
      expect(assign.urls).toEqual([link]);
      expect(screen().queryByRole("link", { name: "Abrir o app" })).toBeNull();
    } finally {
      assign.restore();
    }
  });

  test("the tab closes as the app comes forward, never on the blur of the browser's own question", async () => {
    const assign = recordAssign();
    const closed = spyOn(window, "close").mockImplementation(() => undefined);
    let now = 1_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    try {
      await renderApp(`/desktop/back#${encodeURIComponent("agenteschat://desktop/signed-in")}`, {
        api: createFakeApi(seedState({ me: null })),
      });
      await settle(3);
      expect(assign.urls).toEqual(["agenteschat://desktop/signed-in"]);
      // "Open the app?" takes focus right away: closing now would take it, and the link, with the tab.
      window.dispatchEvent(new Event("blur"));
      expect(closed).not.toHaveBeenCalled();
      now += ASK_BLUR_MS;
      window.dispatchEvent(new Event("blur"));
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
      closed.mockRestore();
      assign.restore();
    }
  });

  test("a link straight to the end hands nothing over without a real request", async () => {
    const { auth, calls } = createFakeAuth({ requestCode: null });
    await renderApp(`/desktop/sign-in?provider=google&request=${request}&done=1`, {
      api: createFakeApi(seedState()),
      auth,
    });
    await settle(3);
    // It only looked the request up; with no pending request it expires and hands nothing over.
    expect(calls).toEqual([{ method: "desktopRequestCode", args: [request] }]);
    expect(heading()).toBe("Esse pedido expirou.");
  });
});
