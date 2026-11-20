import { afterEach, expect, spyOn, test } from "bun:test";
import { domWindow, setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup } from "@testing-library/react";
import { onUnknownHost, showUnknownHost } from "@/components/UnknownHost";
import { createI18n } from "@/i18n";
import { screen } from "./render";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-unknown-host");
  domWindow().happyDOM.setURL("http://localhost:3000/");
});

/** The page as the server answers it on an unknown hostname: #root with the boot sky, the document marked. */
async function open(lang: "en" | "pt-BR" = "en") {
  domWindow().happyDOM.setURL("https://unset.example.com/login");
  document.documentElement.setAttribute("data-unknown-host", "");
  const root = document.body.appendChild(document.createElement("div"));
  root.id = "root";
  root.innerHTML = '<div class="boot" aria-hidden="true"></div>';
  const fetches = spyOn(globalThis, "fetch");
  let settled = false;
  await act(async () => {
    void showUnknownHost(createI18n(lang)).finally(() => {
      settled = true;
    });
  });
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)));
  fetches.mockRestore();
  return { root, fetched: fetches.mock.calls.length, settled };
}

test("a page marked data-unknown-host shows only the not-set-up screen and asks nothing", async () => {
  expect(onUnknownHost()).toBe(false);
  document.documentElement.setAttribute("data-unknown-host", "");
  expect(onUnknownHost()).toBe(true);

  const { root, fetched, settled } = await open();
  expect(fetched).toBe(0);
  // The entry awaits it for good: nothing after it in main.tsx runs.
  expect(settled).toBe(false);
  expect(root.querySelector(".boot")).toBeNull();
  expect(screen().getByRole("heading", { name: "This address isn't set up yet" })).toBeTruthy();
  expect(screen().getByText("If it was just connected, try again in a few minutes.")).toBeTruthy();
  expect(screen().getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(document.title).toBe("Address not set up · agentes.chat");
  expect(document.documentElement.lang).toBe("en");
});

test("in the reader's language", async () => {
  await open("pt-BR");
  expect(screen().getByRole("heading", { name: "Este endereço ainda não está configurado" })).toBeTruthy();
  expect(screen().getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  expect(document.documentElement.lang).toBe("pt-BR");
});

test("main.tsx decides first: the unknown host's screen before any session, router, socket or service worker", () => {
  const main = readFileSync(join(import.meta.dir, "../src/main.tsx"), "utf8");
  const body = main.slice(main.lastIndexOf("\nimport ") + 1);
  const check = body.indexOf("if (onUnknownHost()) {");
  expect(check).toBeGreaterThan(-1);
  expect(body.indexOf("await showUnknownHost(")).toBeGreaterThan(check);
  for (const start of [
    "catchEarlyErrors()",
    "createApiClient()",
    "createRouter(",
    "createRoot(root",
    "installSounds()",
  ]) {
    expect({ start, after: body.indexOf(start) > check }).toEqual({ start, after: true });
  }
});
