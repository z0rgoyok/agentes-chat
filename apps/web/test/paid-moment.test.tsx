import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import path from "node:path";
import { type ComputerSetup, keys, type Machine, type WorkspaceLimits } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { PAID_MOMENT_ONCE_MS } from "@/lib/paid-return";
import { STORAGE_KEYS } from "@/lib/storage";
import { createFakeApi, type FakeState, fakeMachinesOf, LODI_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle, showIn } from "./render";

/*
 * The moment right after a paid Checkout (ADR 0079) where the workspace's pages land: in full on the page the return
 * landed on (a dialog), as a card in the corner when the plan turned on after the person went elsewhere. It says only
 * what is true now: the plan in force, what it gives, the computer as it is. Once per payment, never on a plain visit,
 * never two dialogs.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  sessionStorage.clear();
  localStorage.clear();
  for (const el of document.querySelectorAll("[data-test-dialog]")) el.remove();
});

const ON = "O seu plano está ativo";
const BETA = "Você chegou cedo. Que bom.";
const CONNECT = "Conecte uma IA para o seu time pensar";
const SETTINGS = `/org/${ORG_ID}/settings/billing`;
const OTHER_ID = "00000000-0000-4000-8000-0000000000b2";
const PENDING = `${STORAGE_KEYS.paidMoment}.${ORG_ID}`;
const SHOWN = `${STORAGE_KEYS.paidMomentShown}.${ORG_ID}`;
const GB = 1024 ** 3;
const STARTING_TOLD = "O seu computador está sendo preparado. Avisamos quando estiver ligado.";

const click = async (el: Element, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
/** The workspace's own computer (ADR 0056 §10): on its way (`setup` only), or made and in the list. */
type Computer = { setup: Partial<ComputerSetup>; machine?: Partial<Machine> };
const open = async (state: FakeState, at: string, computer?: Computer) => {
  const api = createFakeApi(state);
  if (computer) {
    const machines = fakeMachinesOf.get(api);
    const m = computer.machine
      ? machines?.pair({ name: "Computador da Acme", kind: "managed", os: "other", ...computer.machine })
      : undefined;
    machines?.setSetup({ ...computer.setup, machineId: m?.id ?? null });
  }
  const r = await renderApp(at, { api });
  await settle(8);
  return r;
};
const card = () => document.querySelector<HTMLElement>(".paid-card");
const moment = () => screen().queryByRole("dialog", { name: new RegExp(`^(${ON}|Você está no plano)`) });
/** A workspace with its right hand, its plan in force. */
const workspace = () => withRightHand(seedState());
/** Every agent without an AI yet. */
const withoutAi = (state: FakeState) => {
  state.aiStatus = {
    any: false,
    agents: state.agents.map((a) => ({ agentId: a.id, state: "no_ai", reason: "no_key" })),
  };
  return state;
};
const held = (state: FakeState) => {
  const org = state.me?.organizations[0];
  if (org) org.standing = { state: "hold", reason: "payment" };
  return state;
};
const limits = (members: number | null, files: number | null): WorkspaceLimits => ({
  members: { used: 1, limit: members },
  storage: { usedBytes: 0, limitBytes: files, ownStorage: false },
  uploads: { usedBytes24h: 0, limitBytesPerDay: null },
});
/** The billing service's plan list, as the browser reads it. */
const planList = (plans: { key: string; name: string }[]) => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ recommended: "team", plans }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
};

describe("the paid moment where the return lands", () => {
  test("back on Settings: the moment in full, its plan, what it gives and one way on, once per payment", async () => {
    const state = workspace();
    state.limits = limits(3, 50 * GB);
    await open(state, `${SETTINGS}?paid=1`);
    const dialog = moment() as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(screen().getAllByRole("dialog")).toHaveLength(1);
    expect(card()).toBeNull();
    expect(dialog.querySelector(".arrival-lede__title")?.textContent).toBe(ON);
    expect(dialog.textContent).toContain("Espaço para 3 pessoas e 50 GB de arquivos.");
    expect(dialog.querySelector(".paid-scene")).toBeTruthy();
    // Never the words of a team already working: the plan is on, nothing more.
    expect(dialog.textContent).not.toContain("de pé");
    cleanup();
    // The same return again (a reload, Back): nothing.
    await open(workspace(), `${SETTINGS}?paid=1`);
    expect(moment()).toBeNull();
    expect(card()).toBeNull();
  });

  test("a plain visit shows nothing", async () => {
    await open(workspace(), SETTINGS);
    expect(moment()).toBeNull();
    expect(card()).toBeNull();
  });

  test("the plan by its name and period when the return carries them", async () => {
    const state = workspace();
    state.authConfig = { billingUrl: "https://billing.example.com" };
    planList([{ key: "team", name: "Equipe" }]);
    await open(state, `${SETTINGS}?paid=1&plan=team&period=year`);
    expect(screen().getByRole("dialog", { name: "Você está no plano Equipe, anual" })).toBeTruthy();
  });

  test("the computer as it is: getting ready (its owner is told when it is on), or on", async () => {
    await open(workspace(), `${SETTINGS}?paid=1`, { setup: { state: "waiting", reason: "capacity" } });
    const getting = moment() as HTMLElement;
    expect(getting.querySelector(".paid-computer")?.textContent).toBe(STARTING_TOLD);
    expect(getting.querySelector(".paid-computer .ac-pixspin")).toBeTruthy();
    // Drawn as it is: never lit while it gets ready.
    expect(getting.querySelector(".ac-computer")?.getAttribute("data-state")).toBe("paused");
    cleanup();
    localStorage.clear();

    await open(workspace(), `${SETTINGS}?paid=1`, { setup: { state: "ready" }, machine: { online: true } });
    expect((moment() as HTMLElement).querySelector(".paid-computer")?.textContent).toBe(
      "O seu computador está ligado.",
    );
    cleanup();
    localStorage.clear();

    // Someone who pays without owning the workspace (an admin) hears of no notice that only owners get.
    const admin = workspace();
    if (admin.me?.organizations[0]) admin.me.organizations[0].role = "member";
    await open(admin, `${SETTINGS}?paid=1`, { setup: { state: "preparing", step: "installing" } });
    expect((moment() as HTMLElement).querySelector(".paid-computer")?.textContent).toBe(
      "O seu computador está sendo preparado.",
    );
  });

  test("where people connect their own computers, the moment says nothing of one", async () => {
    await open(workspace(), `${SETTINGS}?paid=1`);
    const dialog = moment() as HTMLElement;
    expect(dialog.querySelector(".paid-computer")).toBeNull();
    expect(dialog.querySelector(".ac-computer")).toBeNull();
  });

  test("its one way on: Connect an AI while agents have none, else the first conversation", async () => {
    await open(withoutAi(workspace()), `${SETTINGS}?paid=1`);
    await click(within(moment() as HTMLElement).getByRole("button", { name: /Conectar uma IA/ }));
    expect(moment()).toBeNull();
    expect(screen().getAllByRole("dialog")).toHaveLength(1);
    cleanup();
    localStorage.clear();

    const { router } = await open(workspace(), `${SETTINGS}?paid=1`);
    await click(within(moment() as HTMLElement).getByRole("button", { name: /Falar com Lodi/ }), 10);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${LODI_ID}`);
    expect(moment()).toBeNull();
  });

  test("closed, it stays closed", async () => {
    await open(workspace(), `${SETTINGS}?paid=1`);
    await click(within(moment() as HTMLElement).getByRole("button", { name: "Fechar" }));
    expect(moment()).toBeNull();
    expect(card()).toBeNull();
  });

  test("it belongs to its workspace: switching to another one leaves it behind", async () => {
    const state = workspace();
    state.me?.organizations.push({ id: OTHER_ID, name: "Beta", role: "owner" });
    const { router } = await open(state, `${SETTINGS}?paid=1`);
    expect(moment()).toBeTruthy();
    await act(() => router.navigate({ href: `/org/${OTHER_ID}/settings/billing` }));
    await settle(8);
    expect(moment()).toBeNull();
  });

  test("as it shows, the address forgets the return: a reload or Back to it shows nothing", async () => {
    const { router } = await open(workspace(), `${SETTINGS}?paid=1&plan=team&period=year&tab=x`);
    expect(moment()).toBeTruthy();
    const search = router.state.location.search as Record<string, unknown>;
    expect([search.paid, search.plan, search.period]).toEqual([undefined, undefined, undefined]);
    expect(search.tab).toBe("x");
  });

  test("a return already shown leaves nothing kept for the tab", async () => {
    await open(held(workspace()), `${SETTINGS}?paid=1`);
    expect(sessionStorage.getItem(PENDING)).not.toBeNull();
    cleanup();
    // Shown meanwhile in another tab of this browser: the hold lifts, this tab shows nothing and keeps nothing.
    localStorage.setItem(SHOWN, String(Date.now()));
    await open(workspace(), `/org/${ORG_ID}/home`);
    expect(card()).toBeNull();
    expect(sessionStorage.getItem(PENDING)).toBeNull();
  });

  test("a second payment later the same day shows its own moment", async () => {
    localStorage.setItem(SHOWN, String(Date.now() - PAID_MOMENT_ONCE_MS - 1000));
    await open(workspace(), `${SETTINGS}?paid=1`);
    expect(moment()).toBeTruthy();
    expect(PAID_MOMENT_ONCE_MS).toBeLessThanOrEqual(60 * 60_000);
  });
});

describe("the plan card in Settings", () => {
  /** The card's rows, each as its label and its value. */
  const rows = () =>
    [...(document.querySelector('[aria-label="Plano e cobrança"]')?.querySelectorAll(".row") ?? [])].map((r) =>
      [r.querySelector("b")?.textContent, r.querySelector(".muted")?.textContent].join(": "),
    );
  const bought = () => {
    const state = workspace();
    state.limits = limits(null, null);
    state.authConfig = { billingUrl: "https://billing.example.com" };
    planList([{ key: "team", name: "Equipe" }]);
    return state;
  };

  test("names the plan and its period first, from the paid return as the moment does, and keeps it for the tab", async () => {
    const { router } = await open(bought(), `${SETTINGS}?paid=1&plan=team&period=year`);
    expect(screen().getByRole("dialog", { name: "Você está no plano Equipe, anual" })).toBeTruthy();
    expect(rows()).toEqual(["Plano: Equipe, anual", "Pessoas: Sem limite", "Arquivos: Sem limite"]);
    // The address has forgotten the return as the moment showed: the tab still knows what it bought.
    expect((router.state.location.search as Record<string, unknown>).plan).toBeUndefined();
    cleanup();
    await open(bought(), SETTINGS);
    expect(rows()[0]).toBe("Plano: Equipe, anual");
  });

  test("by its name alone when the return said no period", async () => {
    await open(bought(), `${SETTINGS}?paid=1&plan=team`);
    expect(rows()[0]).toBe("Plano: Equipe");
  });

  test("a tab that saw no return, or a plan not in force yet: as before, people and files", async () => {
    await open(bought(), SETTINGS);
    expect(rows()).toEqual(["Pessoas: Sem limite", "Arquivos: Sem limite"]);
    cleanup();
    await open(held(bought()), `${SETTINGS}?paid=1&plan=team&period=year`);
    expect(rows()).toEqual(["Pessoas: Sem limite", "Arquivos: Sem limite"]);
  });
});

describe("a confirmation that comes later", () => {
  test("while the hold lasts, nothing; once it lifts after the person went elsewhere, the card in the corner", async () => {
    await open(held(workspace()), `${SETTINGS}?paid=1`);
    expect(moment()).toBeNull();
    expect(card()).toBeNull();
    cleanup();
    // The address dropped `paid` (another page), the tab kept the return: the hold lifted, the card shows.
    await open(withoutAi(workspace()), `/org/${ORG_ID}/home`, { setup: { state: "waiting", reason: "capacity" } });
    const corner = card() as HTMLElement;
    expect(within(corner).getByRole("heading", { name: ON })).toBeTruthy();
    expect(corner.querySelector(".paid-computer")?.textContent).toBe(STARTING_TOLD);
    expect(within(corner).getByRole("button", { name: "Conectar uma IA" })).toBeTruthy();
    // Not a dialog: the page stays as it is.
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("a page left before the card is on screen keeps the moment for the next one, never used up unseen", async () => {
    // Kept for the tab, the plan in force: the page opens while what the card says (the plan's limits) is on its way.
    sessionStorage.setItem(PENDING, JSON.stringify({ plan: "team", period: "year" }));
    const api = createFakeApi(workspace());
    api.orgs.limits = () => new Promise<never>(() => {});
    await renderApp(`/org/${ORG_ID}/home`, { api });
    await settle(8);
    expect(card()).toBeNull();
    // Never on screen: not noted as shown in this browser, and still kept for the tab.
    expect(localStorage.getItem(SHOWN)).toBeNull();
    expect(sessionStorage.getItem(PENDING)).not.toBeNull();
    cleanup();
    // The next page shows it, and only then is it used up.
    await open(workspace(), `/org/${ORG_ID}/home`);
    expect(card()).toBeTruthy();
    expect(localStorage.getItem(SHOWN)).not.toBeNull();
    expect(sessionStorage.getItem(PENDING)).toBeNull();
  });

  test("on the return, with a dialog of the person's own open as the hold lifts: the card, under it", async () => {
    const state = held(workspace());
    const { services } = await open(state, `${SETTINGS}?paid=1`);
    const theirs = document.createElement("div");
    theirs.setAttribute("role", "dialog");
    theirs.dataset.testDialog = "";
    document.body.append(theirs);
    const org = state.me?.organizations[0];
    if (org) org.standing = { state: "active", reason: null };
    await act(() => services.queryClient.invalidateQueries({ queryKey: keys.me }));
    await settle(10);
    expect(card()).toBeTruthy();
    expect(moment()).toBeNull();
  });

  test("a dialog open as it comes stays above it: the card is drawn under every scrim", async () => {
    const root = path.join(import.meta.dir, "../../..");
    const layers = await Bun.file(path.join(root, "packages/ui/src/styles/layers.css")).text();
    const css = await Bun.file(path.join(root, "apps/web/src/components/arrival/arrival.css")).text();
    const token = (name: string) => Number(layers.match(new RegExp(`--z-${name}:\\s*(-?\\d+)`))?.[1]);
    const z = css.match(/\.paid-card\s*\{[^}]*z-index:\s*var\(--z-([\w-]+)\)/)?.[1] ?? "";
    expect(token(z)).toBeLessThan(token("scrim"));
    expect(token(z)).toBeGreaterThan(token("lifted"));
  });
});

describe("with the arrival (a workspace that opens right after its onboarding)", () => {
  test("the moment first, as a dialog, then the beta notice, then Connect an AI: one at a time", async () => {
    const { router } = await open(withoutAi(workspace()), `/org/${ORG_ID}?paid=1&arrival=1`);
    // Both marks leave the address together: neither brings the other back.
    expect(router.state.location.search).toEqual({});
    const paid = screen().getByRole("dialog", { name: ON });
    expect(screen().getAllByRole("dialog")).toHaveLength(1);
    expect(card()).toBeNull();
    expect(paid.textContent).toContain("Sem limite de pessoas nem de arquivos.");
    await click(within(paid).getByRole("button", { name: /Continuar/ }));
    const beta = screen().getByRole("dialog", { name: BETA });
    expect(screen().getAllByRole("dialog")).toHaveLength(1);
    await click(within(beta).getByRole("button", { name: /Continuar/ }));
    expect(screen().getByRole("dialog", { name: CONNECT })).toBeTruthy();
    expect(screen().getAllByRole("dialog")).toHaveLength(1);
    expect(card()).toBeNull();
  });

  test("still held as the notice opens: the notice alone, no moment", async () => {
    await open(held(withoutAi(workspace())), `/org/${ORG_ID}?paid=1&arrival=1`);
    expect(screen().getByRole("dialog", { name: BETA })).toBeTruthy();
    expect(screen().queryByRole("dialog", { name: ON })).toBeNull();
    expect(card()).toBeNull();
  });
});

describe("the worst case (measured by CI's geometry capture)", () => {
  test("a plan's longest name, a long first name and a long right hand's name, in German, at every width", async () => {
    const state = withRightHand(seedState(), { name: "Maximiliana Bartholomew-Fitzgerald" });
    state.authConfig = { billingUrl: "https://billing.example.com" };
    state.limits = limits(1284, 2048 * GB);
    if (state.me) state.me.user.name = "Aleksandra Wiśniewska-Kowalczyk";
    // The plan list's longest name (`planOfferOf` takes up to 40 characters).
    const plan = "Unternehmen Plus mit eigenem Computer XL";
    planList([{ key: "business", name: plan }]);
    const r = await open(state, `${SETTINGS}?paid=1&plan=business&period=year`, {
      setup: { state: "waiting", reason: "capacity" },
    });
    await showIn(r.services, "de");
    const dialog = screen().getByRole("dialog", { name: `Du nutzt jetzt ${plan}, jährlich` });
    expect(dialog.textContent).toContain("Hallo, Aleksandra");
    // The seats as German writes the number.
    expect(dialog.textContent).toContain("Platz für 1.284 Personen und 2 TB an Dateien.");
    expect(dialog.textContent).toContain("Dein Computer wird vorbereitet. Wir sagen dir Bescheid, sobald er läuft.");
    expect(
      within(dialog).getByRole("button", { name: /Mit Maximiliana Bartholomew-Fitzgerald sprechen/ }),
    ).toBeTruthy();
  });

  test("a workspace with no agents: the sky and the computer alone, and Connect an AI as the way on", async () => {
    await open(seedState({ agents: [] }), `${SETTINGS}?paid=1`, { setup: { state: "waiting", reason: "capacity" } });
    const dialog = moment() as HTMLElement;
    expect(dialog.querySelector(".team-scene__agent")).toBeNull();
    expect(dialog.querySelector(".ac-computer")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Conectar uma IA/ })).toBeTruthy();
  });
});
