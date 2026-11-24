import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { COMPACT_QUERY, DESKTOP_QUERY } from "@/components/NavDrawer";
import { TABLET_QUERY } from "@/components/sidebar-state";
import { rules } from "./built-css";
import { createFakeApi, ENG_ID, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

let media: { mockRestore: () => void } | null = null;
/** Only `query` matches: a desktop, a tablet or a phone-width window. */
const widthIs = (query: string) => {
  media = spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: q === query,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
};
afterEach(() => {
  cleanup();
  media?.mockRestore();
  media = null;
});

const personal = () => {
  const state = seedState();
  const org = state.me?.organizations[0];
  if (org) org.mode = "personal";
  return state;
};
const open = async (state: FakeState = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);
  await act(async () => r.sockets.last().open());
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
const toggle = () =>
  within(nav()).getByRole("button", { name: /^(Expandir barra lateral|Minimizar barra lateral|Fechar menu)$/ });
const click = async (el: Element) => act(async () => fireEvent.click(el));
/** The toggle's place: its row's class and what sits before it there. */
const place = () => {
  const b = toggle();
  const row = b.parentElement as HTMLElement;
  return { row: row.className, before: [...row.children].slice(0, [...row.children].indexOf(b)).length };
};

describe("the sidebar's toggle stays in one place at every width", () => {
  for (const [mode, state] of [
    ["a team's workspace", seedState],
    ["a personal workspace", personal],
  ] as const) {
    test(`${mode}: beside ⌘K expanded, under it in the rail, the same on a desktop and a tablet`, async () => {
      widthIs(DESKTOP_QUERY);
      await open(state());
      const expanded = place();
      const button = toggle();
      expect(button.getAttribute("aria-expanded")).toBe("true");
      await click(button);
      expect(nav().dataset.rail).toBe("true");
      const railed = place();
      // The same button where it was: focus stays on it for the next press.
      expect(toggle()).toBe(button);
      expect(button.getAttribute("aria-label")).toBe("Expandir barra lateral");
      await click(button);
      cleanup();
      media?.mockRestore();

      widthIs(TABLET_QUERY);
      await open(state());
      expect(nav().dataset.rail).toBe("true");
      expect(place()).toEqual(railed);
      expect(toggle().getAttribute("aria-expanded")).toBe("false");
      await click(toggle());
      expect(nav().dataset.rail).toBe("false");
      expect(nav().dataset.float).toBe("true");
      expect(place()).toEqual(expanded);
      await click(toggle());
      expect(nav().dataset.rail).toBe("true");
      expect(nav().dataset.float).toBeUndefined();
    });
  }

  test("a tablet's open sidebar folds back on Esc and on a press on the page, and starts as the rail again", async () => {
    widthIs(TABLET_QUERY);
    await open();
    await click(toggle());
    expect(nav().dataset.float).toBe("true");
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
    expect(nav().dataset.rail).toBe("true");
    await click(toggle());
    await act(async () => fireEvent.pointerDown(screen().getByRole("main")));
    expect(nav().dataset.rail).toBe("true");
    await click(toggle());
    cleanup();
    await open();
    expect(nav().dataset.rail).toBe("true");
  });

  test("a tablet's open sidebar hands focus back to its toggle on Esc, and folds back when Tab leaves it", async () => {
    widthIs(TABLET_QUERY);
    await open();
    await click(toggle());
    const row = within(nav()).getByRole("link", { name: /general/ });
    row.focus();
    await act(async () => fireEvent.keyDown(row, { key: "Escape" }));
    expect(nav().dataset.rail).toBe("true");
    expect(document.activeElement).toBe(toggle());
    await click(toggle());
    expect(nav().dataset.float).toBe("true");
    await act(async () => (within(screen().getByRole("main")).getAllByRole("button")[0] as HTMLElement).focus());
    expect(nav().dataset.rail).toBe("true");
  });

  test("a phone-width window's drawer has the toggle in the same place, and it closes the drawer", async () => {
    widthIs(DESKTOP_QUERY);
    await open();
    const expanded = place();
    cleanup();
    media?.mockRestore();
    widthIs(COMPACT_QUERY);
    await open();
    await click(screen().getAllByRole("button", { name: "Abrir menu" })[0] as HTMLElement);
    expect(nav().dataset.open).toBe("true");
    expect(place()).toEqual(expanded);
    await click(toggle());
    expect(nav().dataset.open).toBe("false");
  });

  test("in the Mac app the title bar carries it at a tablet's width too, and it opens the drawer when the window is that narrow", async () => {
    const w = window as { __agentesDesktop?: unknown; __TAURI_INTERNALS__?: unknown };
    w.__agentesDesktop = { version: "0.6.0" };
    w.__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === "this_mac" ? { orgs: [] } : {}) };
    const barToggle = () => (document.querySelector("header.titlebar .titlebar__nav") as HTMLElement).firstElementChild;
    try {
      widthIs(TABLET_QUERY);
      await open();
      expect(barToggle()?.getAttribute("aria-label")).toBe("Expandir barra lateral");
      // Its press is outside the sidebar: the click still toggles it, not closes and opens again.
      await act(async () => fireEvent.pointerDown(barToggle() as Element));
      await click(barToggle() as Element);
      expect(nav().dataset.float).toBe("true");
      await act(async () => fireEvent.pointerDown(barToggle() as Element));
      await click(barToggle() as Element);
      expect(nav().dataset.rail).toBe("true");
      cleanup();
      media?.mockRestore();

      widthIs(COMPACT_QUERY);
      await open();
      expect(barToggle()?.getAttribute("aria-label")).toBe("Abrir menu");
      await click(barToggle() as Element);
      expect(nav().dataset.open).toBe("true");
      // The View menu's item does what the title bar's button does there.
      const menu = (window as { __agentesMenu?: (action: string) => void }).__agentesMenu;
      await act(async () => menu?.("toggleSidebar"));
      expect(nav().dataset.open).toBe("false");
      await act(async () => menu?.("toggleSidebar"));
      expect(nav().dataset.open).toBe("true");
    } finally {
      delete w.__agentesDesktop;
      delete w.__TAURI_INTERNALS__;
    }
  });

  test("no rule hides or moves it by the window's width or height: only the Mac app, whose title bar has it", () => {
    const toggles = /sidebar__(collapse|head-collapse|jump-row)|titlebar__nav/;
    const hides = new Set(["display", "visibility", "position", "order", "opacity"]);
    for (const file of ["layout.css", "responsive.css", "desktop.css"]) {
      const css = readFileSync(join(import.meta.dir, "../src", file), "utf8");
      for (const r of rules(css)) {
        const offenders = r.selectors.filter((s) => toggles.test(s) && !s.startsWith("html[data-desktop]"));
        if (!offenders.length) continue;
        for (const [p, v] of r.declarations) {
          if (!hides.has(p) || (p === "display" && v === "flex")) continue;
          throw new Error(`${file}: ${offenders.join(", ")} sets ${p}: ${v}`);
        }
      }
    }
  });
});
