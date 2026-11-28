import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup } from "@testing-library/react";
import { openWaitingTab, sendSignInTab } from "@/lib/sign-in-tab";
import { createFakeApi, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

let realOpen: typeof window.open;
beforeEach(() => {
  realOpen = window.open;
});
afterEach(() => {
  cleanup();
  window.open = realOpen;
  delete (window as { __agentesDesktop?: unknown }).__agentesDesktop;
});

describe("a sign-in's tab", () => {
  test("a normal tab on our page, never about:blank or a popup window, and goes on to the provider in place of it", () => {
    const urls: string[] = [];
    const features: (string | undefined)[] = [];
    const replaced: string[] = [];
    const popup = { closed: false, opener: {}, location: { replace: (u: string) => replaced.push(u) } };
    window.open = ((url: string, _target?: string, feature?: string) => {
      urls.push(url);
      features.push(feature);
      return popup;
    }) as never;
    const w = openWaitingTab("claude_code");
    expect(urls).toEqual(["/conectando?kind=claude_code"]);
    // No window features: a popup window without the browser's toolbars is what providers' bot checks refuse.
    expect(features).toEqual([undefined]);
    expect(popup.opener).toBeNull();
    sendSignInTab(w, "https://claude.ai/oauth");
    expect(replaced).toEqual(["https://claude.ai/oauth"]);
  });

  test("in the desktop app, none: a page of ours would take over the app's window", () => {
    (window as { __agentesDesktop?: unknown }).__agentesDesktop = { version: "1", platform: "macos" };
    window.open = (() => {
      throw new Error("opened");
    }) as never;
    expect(openWaitingTab("claude_code")).toBeNull();
  });

  test("the page says what is happening, for whom, with a way out, with no session", async () => {
    const state = seedState();
    state.me = null;
    await renderApp("/conectando?kind=claude_code", { api: createFakeApi(state) });
    await settle(6);
    expect(document.body.textContent).toContain("Conectando Claude");
    expect(document.body.textContent).toContain("Estamos pedindo a página de entrada ao computador.");
    expect(screen().getByRole("button", { name: "Fechar" })).toBeTruthy();
  });
});
