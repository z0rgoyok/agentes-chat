import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { accentPalette, accentSky, ditherUrl } from "@agenteschat/ui";
import { gradientOf } from "@agenteschat/ui/agent/engine";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { ThemeProvider, useTheme, useWorkspaceAccent } from "@/lib/theme";
import { createFakeApi, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const OTHER_ID = "00000000-0000-4000-8000-0000000000aa";
const PURPLE = "#7c3aed";
const DEFAULT_SKY: [string, string] = ["#8cc3ff", "#0063d1"];
const accentAttr = () => document.documentElement.getAttribute("data-accent");
const agentVar = () => document.documentElement.style.getPropertyValue("--agent");
const vars = () =>
  ["--agent", "--agent2", "--agent-soft", "--on-agent"].map((n) => document.documentElement.style.getPropertyValue(n));

/** Acme with an accent, and a second workspace without one. */
function twoWorkspaces(accent: string | null = PURPLE): FakeState {
  const state = seedState();
  if (!state.me) throw new Error("no me");
  state.me.organizations = [
    { ...(state.me.organizations[0] as (typeof state.me.organizations)[number]), accent },
    { id: OTHER_ID, name: "Globex", role: "owner" },
  ];
  return state;
}

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};

describe("the workspace shell paints its accent", () => {
  test("its four agent colors on the page while in it, none in a workspace without one, none once it is left", async () => {
    const state = twoWorkspaces();
    const r = await renderApp(`/org/${ORG_ID}/home`, { api: createFakeApi(state) });
    await settle(6);
    const light = accentPalette(PURPLE).light;
    expect(vars()).toEqual([light.agent, light.agent2, light.agentSoft, light.onAgent]);
    // Agents with no color of their own and the sky art: the accent's pair; canvases told to repaint.
    expect(gradientOf("sky")).toEqual(accentSky(PURPLE));
    expect(accentAttr()).toBe(PURPLE);

    await act(() => r.router.navigate({ to: "/org/$orgId/home", params: { orgId: OTHER_ID } }));
    await settle(8);
    expect(vars()).toEqual(["", "", "", ""]);
    expect(gradientOf("sky")).toEqual(DEFAULT_SKY);
    expect(accentAttr()).toBeNull();

    await act(() => r.router.navigate({ to: "/org/$orgId/home", params: { orgId: ORG_ID } }));
    await settle(8);
    expect(agentVar()).toBe(light.agent);

    // Once the workspace's shell is gone (the account's own pages, sign-in): the design system's own colors.
    cleanup();
    expect(vars()).toEqual(["", "", "", ""]);
    expect(gradientOf("sky")).toEqual(DEFAULT_SKY);
    expect(accentAttr()).toBeNull();
  });

  test("in the workspace menu, every other workspace's mark is in its own accent, or the default blue", async () => {
    const state = twoWorkspaces();
    state.me?.organizations.push({
      id: "00000000-0000-4000-8000-0000000000bb",
      name: "Initech",
      role: "member",
      accent: "#f97316",
    });
    await renderApp(`/org/${ORG_ID}/home`, { api: createFakeApi(state) });
    await settle(6);
    await click(screen().getByRole("button", { name: "Menu do workspace Acme" }));
    const dither = (name: string) =>
      screen()
        .getByRole("menuitem", { name: new RegExp(name) })
        .querySelector(".ac-logo__dither")
        ?.getAttribute("href");
    expect(dither("Acme")).toBe(ditherUrl(accentSky(PURPLE), 12));
    expect(dither("Globex")).toBe(ditherUrl(DEFAULT_SKY, 12));
    expect(dither("Initech")).toBe(ditherUrl(accentSky("#f97316"), 12));
  });

  test("it follows the theme as it switches", async () => {
    let switchTo: (v: "light" | "dark") => void = () => {};
    function Shell() {
      const { setPreference } = useTheme();
      switchTo = setPreference;
      useWorkspaceAccent("#F97316");
      return null;
    }
    render(
      <ThemeProvider>
        <Shell />
      </ThemeProvider>,
    );
    act(() => switchTo("light"));
    expect(agentVar()).toBe(accentPalette("#f97316").light.agent);
    act(() => switchTo("dark"));
    expect(agentVar()).toBe(accentPalette("#f97316").dark.agent);
    // The engine's sky is one pair in both themes, as the landing's is.
    expect(gradientOf("sky")).toEqual(accentSky("#f97316"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    act(() => switchTo("light"));
    cleanup();
    expect(agentVar()).toBe("");
    expect(gradientOf("sky")).toEqual(DEFAULT_SKY);
  });

  test("anything not a #rrggbb sets nothing", () => {
    function Shell() {
      useWorkspaceAccent("purple");
      return null;
    }
    render(
      <ThemeProvider>
        <Shell />
      </ThemeProvider>,
    );
    expect(vars()).toEqual(["", "", "", ""]);
  });
});

describe("Configurações › Workspace › Cor de destaque", () => {
  const open = async (state: FakeState) => {
    await renderApp(`/org/${ORG_ID}/settings`, { api: createFakeApi(state) });
    await settle(8);
  };
  const popover = () => screen().getByRole("dialog", { name: "Cor de destaque" });

  test("pick a suggestion, see it before saving, save it: the page takes it at once", async () => {
    const state = twoWorkspaces(null);
    await open(state);
    expect(screen().queryByRole("button", { name: "Usar a padrão" })).toBeNull();
    await click(screen().getByRole("button", { name: "Trocar cor" }));
    const save = () => within(popover()).getByRole("button", { name: "Salvar cor" }) as HTMLButtonElement;
    // The default blue is the first suggestion, picked; nothing to save yet.
    const suggestions = within(popover()).getAllByRole("button", { pressed: true });
    expect(suggestions.map((b) => b.getAttribute("aria-label"))).toEqual(["Céu"]);
    expect(save().disabled).toBe(true);

    await click(within(popover()).getByRole("button", { name: "Violeta" }));
    const sample = popover().querySelector<HTMLElement>("[data-testid=accent-sample]");
    expect(sample?.style.getPropertyValue("--agent")).toBe(accentPalette("#6e45d1").light.agent);
    expect(sample?.textContent).toContain("@Agente");
    expect(agentVar()).toBe("");

    await click(save());
    expect(state.calls).toContainEqual({ method: "orgs.setAccent", args: [ORG_ID, "#6e45d1"] });
    expect(document.body.textContent).toContain("Cor de destaque atualizada.");
    expect(agentVar()).toBe(accentPalette("#6e45d1").light.agent);
    expect(screen().getByRole("button", { name: "Usar a padrão" })).toBeTruthy();
  });

  test("a hex typed in the picker; while it saves the row's controls are off; back to the default", async () => {
    const state = twoWorkspaces(PURPLE);
    let release: () => void = () => {};
    state.setAccentGate = new Promise((r) => {
      release = r;
    });
    await open(state);
    await click(screen().getByRole("button", { name: "Trocar cor" }));
    const hex = within(popover()).getByRole("textbox") as HTMLInputElement;
    expect(hex.value).toBe(PURPLE);
    await act(async () => fireEvent.change(hex, { target: { value: "#F97316" } }));
    await click(within(popover()).getByRole("button", { name: "Salvar cor" }));
    expect((within(popover()).getByRole("button", { name: "Salvar cor" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen().getByRole("button", { name: "Usar a padrão" }) as HTMLButtonElement).disabled).toBe(true);
    for (const b of within(popover()).getAllByRole("button", { name: /Céu|Violeta/ }))
      expect((b as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
    await settle(6);
    expect(state.calls).toContainEqual({ method: "orgs.setAccent", args: [ORG_ID, "#f97316"] });
    expect(agentVar()).toBe(accentPalette("#f97316").light.agent);

    state.setAccentGate = undefined;
    await click(screen().getByRole("button", { name: "Usar a padrão" }));
    expect(state.calls).toContainEqual({ method: "orgs.setAccent", args: [ORG_ID, null] });
    expect(document.body.textContent).toContain("De volta à cor padrão.");
    expect(agentVar()).toBe("");
    expect(screen().queryByRole("button", { name: "Usar a padrão" })).toBeNull();
  });
});
