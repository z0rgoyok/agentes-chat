import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, keys, type Message, type SurfaceLink } from "@agenteschat/client";
import { LOCALE_CODES } from "@agenteschat/i18n/locale";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState, withChatPrefs, withRightHand } from "./fake-api";
import { renderApp, screen, settle, showIn } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};

/** The longest name `SURFACE_NAME` allows (32 characters), with one long unbroken word. */
const LONG_SURFACE = "Example Chat Longunbrokenwordxyz";
const LONG_DISPLAY = "+1 555 0100 0100 0100 0100 0100 0100 0100 0100 0100 0100 0100 01";
const LONG_HANDLE = "@ana.theo.example.chat.handle.without.any.space.to.break.at.all.x";
const LONG_PROFILE = "Ana 🌟 مرحبا بالعالم من مساحة العمل Theo 🚀 שלום עולם ומה שלומכם";
const LONG_WORKSPACE = "Northwind Industries Holdings and Partners Worldwide Operations";

const link = (over: Partial<SurfaceLink> = {}): SurfaceLink => ({
  nudge: { on: true, afterHours: 4, quietFrom: 22, quietTo: 8 },
  id: "link-1",
  status: "pending",
  display: "5511900000001",
  profileName: "Ana",
  orgId: ORG_ID,
  orgName: "Acme",
  createdAt: new Date().toISOString(),
  confirmedAt: null,
  expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
  pinSet: false,
  ...over,
});

/** Configurações › Notificações, with the server bridging `name`. */
async function notifications(surface: NonNullable<ReturnType<typeof seedState>["surface"]> | undefined) {
  const state = seedState();
  state.surface = surface;
  const app = await renderApp(`/org/${ORG_ID}/settings/notifications`, { api: createFakeApi(state) });
  await settle(6);
  const row = () => document.querySelector("#notice-surface-help, #notice-surface-status")?.closest(".settings-row");
  return { state, app, row: () => (row() as HTMLElement | undefined) ?? null };
}

const reload = async (app: Awaited<ReturnType<typeof renderApp>>) => {
  await act(async () => app.services.queryClient.invalidateQueries({ queryKey: keys.surfaceLinks }));
  await settle(6);
};
const dialogOf = (name: string | RegExp) => screen().getByRole("dialog", { name });
const calls = (state: ReturnType<typeof seedState>, method: string) =>
  state.calls.filter((c) => c.method === method).map((c) => c.args);

describe("the outside chat app's row in Notificações", () => {
  test("hidden where the server bridges none, and for an account it may not link", async () => {
    const none = await notifications(undefined);
    expect(none.row()).toBeNull();
    expect(calls(none.state, "surfaces.list")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("Example Chat");
    cleanup();
    const closed = await notifications({ name: "Example Chat", allowed: false, links: [] });
    expect(closed.row()).toBeNull();
    expect(calls(closed.state, "surfaces.list")).toHaveLength(1);
  });

  test("none: Vincular opens the code, its QR, its time and the three steps, then waits and confirms", async () => {
    const { state, app, row } = await notifications({ name: "Example Chat", links: [] });
    const r = row() as HTMLElement;
    expect(r.querySelector(".settings-row__label")?.textContent).toBe("Example Chat");
    // What linking does is the ⓘ's, as on the rows beside it; nothing under the name while nothing is linked, and the
    // button keeps the name's line.
    expect(document.getElementById("notice-surface-help")?.textContent).toBe(
      "Seu braço direito pode mandar mensagens para você lá",
    );
    expect(document.getElementById("notice-surface-status")).toBeNull();
    expect(r.classList.contains("settings-row--button")).toBe(true);
    await click(within(r).getByRole("button", { name: "Vincular" }));
    expect(app.router.state.location.search).toMatchObject({ link: 1 });
    expect(calls(state, "surfaces.mintCode")).toEqual([[ORG_ID]]);

    const dialog = dialogOf("Fale com Seu braço direito no Example Chat");
    expect(
      within(dialog).getByRole("img", { name: "QR code que abre o Example Chat com o seu código digitado" }),
    ).toBeTruthy();
    expect(dialog.textContent).toContain("Seu código KQ7M-3XP1");
    expect(dialog.textContent).toMatch(/Vale por (10:00|9:5\d)/);
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => li.getAttribute("data-state")),
    ).toEqual(["current", "waiting", "waiting"]);
    const open = within(dialog).getByRole("link", { name: "Abrir o Example Chat" });
    expect(open.getAttribute("href")).toBe("https://chat.example.com/send?text=KQ7M-3XP1");
    expect(open.getAttribute("target")).toBe("_blank");

    // Opened: the wait, which moves on by itself.
    open.addEventListener("click", (e) => e.preventDefault());
    await click(open);
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => li.getAttribute("data-state")),
    ).toEqual(["done", "current", "waiting"]);
    expect(dialog.textContent).toContain("Isto avança sozinho quando sua mensagem chegar.");
    expect(dialog.querySelector(".phone-code__qr")).toBeNull();

    // The sender's message arrives: the confirm step, with who sent it and the consent above Confirm.
    state.surface?.links.push(link());
    await reload(app);
    const confirm = dialogOf("Este é o seu Example Chat?");
    expect(confirm.querySelector(".surface-sender")?.textContent).toBe(
      "Este remetente enviou seu código+55 (11) 90000-0001AnaResponde em Acme",
    );
    expect(confirm.querySelector(".surface-sender + p")?.textContent).toBe("Vincule só se for você.");
    const consent = confirm.querySelector(".surface-link > p:last-child")?.textContent;
    expect(consent).toBe(
      "Seu braço direito do agentes.chat pode mandar mensagens no Example Chat sobre seus workspaces, e ligar só quando for urgente e você permitir. Escreva parar para desativar.",
    );
    await click(within(confirm).getByRole("button", { name: "Sim, vincular" }));
    expect(calls(state, "surfaces.confirm")).toEqual([["link-1"]]);
    const done = dialogOf("Example Chat vinculado");
    expect(done.textContent).toContain("Seu braço direito responde você por lá a partir de agora.");
    await click(within(done).getByRole("button", { name: "Pronto" }));
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(app.router.state.location.search).not.toHaveProperty("link");

    // Linked: the sender, with Desvincular.
    expect(document.getElementById("notice-surface-status")?.textContent).toBe("+55 (11) 90000-0001 · Ana");
    expect(within(row() as HTMLElement).getByRole("button", { name: "Desvincular" })).toBeTruthy();
  });

  test("a sender waiting: the row opens the dialog at its confirm step, and Não sou eu cancels it for a new code", async () => {
    const { state, row } = await notifications({ name: "Example Chat", links: [link()] });
    const r = row() as HTMLElement;
    expect(r.tagName).toBe("BUTTON");
    expect(r.textContent).toContain("Um remetente espera a sua confirmação");
    await click(r);
    const dialog = dialogOf("Este é o seu Example Chat?");
    expect(calls(state, "surfaces.mintCode")).toEqual([]);
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => li.getAttribute("data-state")),
    ).toEqual(["done", "done", "current"]);
    await click(within(dialog).getByRole("button", { name: "Não sou eu" }));
    expect(calls(state, "surfaces.remove")).toEqual([["link-1"]]);
    expect(dialogOf(/Fale com/).textContent).toContain("Seu código KQ7M-3XP1");
    expect(within(row() as HTMLElement).getByRole("button", { name: "Vincular", hidden: true })).toBeTruthy();
  });

  test("a code made in another workspace: the consent names that workspace's right hand", async () => {
    const state = withRightHand(seedState());
    state.surface = { name: "Example Chat", links: [link({ orgId: "org-other", orgName: "Northwind" })] };
    const hand = state.agents.find((a) => a.builtin === "right_hand");
    if (hand) state.agentsOf = { "org-other": [{ ...hand, id: "agent-iris", name: "Iris" }] };
    await renderApp(`/org/${ORG_ID}/settings/notifications`, { api: createFakeApi(state) });
    await settle(6);
    await click(document.querySelector("#notice-surface-status")?.closest(".settings-row") as HTMLElement);
    const consent = dialogOf("Este é o seu Example Chat?").querySelector(".surface-link > p:last-child");
    expect(consent?.textContent).toStartWith("Iris do agentes.chat pode mandar mensagens no Example Chat");
  });

  test("confirmed on another device while the code shows: the dialog says linked, and makes no other code", async () => {
    const { state, app } = await notifications({ name: "Example Chat", links: [] });
    await click(screen().getByRole("button", { name: "Vincular" }));
    expect(dialogOf(/Fale com/).textContent).toContain("Seu código KQ7M-3XP1");
    state.surface?.links.push(link({ status: "active", expiresAt: null, confirmedAt: new Date().toISOString() }));
    await reload(app);
    expect(dialogOf("Example Chat vinculado").textContent).toContain("Seu braço direito responde você por lá");
    expect(calls(state, "surfaces.mintCode")).toHaveLength(1);
  });

  test("linked: Desvincular asks first, then the row goes back to Vincular", async () => {
    const { state, row } = await notifications({
      name: "Example Chat",
      links: [link({ status: "active", expiresAt: null, confirmedAt: new Date().toISOString() })],
    });
    await click(within(row() as HTMLElement).getByRole("button", { name: "Desvincular" }));
    const dialog = dialogOf("Desvincular o Example Chat?");
    await click(within(dialog).getByRole("button", { name: "Desvincular" }));
    expect(calls(state, "surfaces.remove")).toEqual([["link-1"]]);
    expect(document.body.textContent).toContain("Example Chat desvinculado");
    expect(within(row() as HTMLElement).getByRole("button", { name: "Vincular" })).toBeTruthy();
  });

  test("linked: the unread reminder, on by default; its delay and quiet hours save at once (ADR 0234)", async () => {
    const { state } = await notifications({
      name: "Example Chat",
      links: [link({ status: "active", expiresAt: null, confirmedAt: new Date().toISOString() })],
    });
    const toggle = screen().getByRole("switch", { name: "Lembrete de não lidas" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    const after = screen().getByRole("combobox", { name: "Lembrar depois de" });
    expect(after.textContent).toBe("4 h");
    after.focus();
    await act(async () => fireEvent.keyDown(after, { key: "Enter" }));
    await click(screen().getByRole("option", { name: "8 h" }));
    expect(screen().getByRole("combobox", { name: "De" }).textContent).toBe("22:00");
    expect(screen().getByRole("combobox", { name: "Até" }).textContent).toBe("8:00");
    await click(toggle);
    expect(calls(state, "surfaces.setNudge")).toEqual([
      ["link-1", { afterHours: 8 }],
      ["link-1", { on: false }],
    ]);
    expect(screen().queryByRole("combobox", { name: "Lembrar depois de" })).toBeNull();
  });

  test("linked: Definir PIN chooses it here, typed twice; the page from the chat opens it with ?pin=1", async () => {
    const { state } = await notifications({
      name: "Example Chat",
      links: [link({ status: "active", expiresAt: null, confirmedAt: new Date().toISOString() })],
    });
    // A row of its own under the linked one, so each keeps its one button.
    const pinRow = () => document.querySelector("#notice-surface-pin-help")?.closest(".settings-row") as HTMLElement;
    expect(pinRow().classList.contains("settings-row--button")).toBe(true);
    await click(within(pinRow()).getByRole("button", { name: "Definir PIN" }));
    const dialog = dialogOf("Seu PIN do Example Chat");
    const save = () => within(dialog).getByRole("button", { name: "Salvar PIN" }) as HTMLButtonElement;
    const type = async (label: string, value: string) => {
      await act(async () => fireEvent.change(within(dialog).getByLabelText(label), { target: { value } }));
      await settle(2);
    };
    await type("Escolha um PIN", "4829x13");
    expect(save().disabled).toBe(true);
    await type("Digite de novo", "482914");
    expect(dialog.textContent).toContain("Os dois PINs não são iguais.");
    await type("Digite de novo", "482913");
    await click(save());
    expect(calls(state, "surfaces.setPin")).toEqual([[{ linkId: "link-1", pin: "482913" }]]);
    expect(document.body.textContent).toContain("PIN salvo");
    expect(within(pinRow()).getByRole("button", { name: "Trocar PIN" })).toBeTruthy();
    cleanup();

    const state2 = seedState();
    state2.surface = {
      name: "Example Chat",
      links: [link({ status: "active", expiresAt: null, confirmedAt: new Date().toISOString() })],
    };
    await renderApp(`/org/${ORG_ID}/settings/notifications?pin=1`, { api: createFakeApi(state2) });
    await settle(6);
    expect(dialogOf("Seu PIN do Example Chat")).toBeTruthy();
  });

  test("each failure says what happened with one way out", async () => {
    // A code the server won't make here: its cause, and only Fechar, since a retry can't pass.
    const final = await notifications({
      name: "Example Chat",
      links: [],
      mintError: new ApiError(409, "surface.no_assistant", "no assistant"),
    });
    await click(within(final.row() as HTMLElement).getByRole("button", { name: "Vincular" }));
    let dialog = dialogOf(/Fale com/);
    expect(within(dialog).getByRole("alert").textContent).toContain("Escolha outro workspace para vincular.");
    expect(within(dialog).queryByRole("button", { name: "Tentar de novo" })).toBeNull();
    await click(within(dialog).getAllByRole("button", { name: "Fechar" }).at(-1) as HTMLElement);
    expect(screen().queryByRole("dialog")).toBeNull();
    cleanup();

    // One that may pass later: Tentar de novo.
    const mint = await notifications({
      name: "Example Chat",
      links: [],
      mintError: new ApiError(429, "rate_limited", "slow down"),
    });
    await click(within(mint.row() as HTMLElement).getByRole("button", { name: "Vincular" }));
    dialog = dialogOf(/Fale com/);
    expect(within(dialog).getByRole("alert")).toBeTruthy();
    if (mint.state.surface) mint.state.surface.mintError = undefined;
    await click(within(dialog).getByRole("button", { name: "Tentar de novo" }));
    expect(dialog.textContent).toContain("Seu código KQ7M-3XP2");
    cleanup();

    // The sender belongs to someone else: a new code is the way on.
    const taken = await notifications({
      name: "Example Chat",
      links: [link()],
      confirmError: new ApiError(409, "surface.taken", "taken"),
    });
    await click(taken.row() as HTMLElement);
    await click(within(dialogOf(/Example Chat\?/)).getByRole("button", { name: "Sim, vincular" }));
    dialog = screen().getByRole("dialog");
    expect(within(dialog).getByRole("alert").textContent).toContain("vinculado a outra conta do agentes.chat");
    if (taken.state.surface) {
      taken.state.surface.confirmError = undefined;
    }
    await click(within(dialog).getByRole("button", { name: "Gerar um novo código" }));
    expect(calls(taken.state, "surfaces.remove")).toEqual([["link-1"]]);
    expect(dialogOf(/Fale com/).textContent).toContain("Seu código KQ7M-3XP1");
    cleanup();

    // No longer in that workspace: only Fechar, the words say where to go.
    const gone = await notifications({
      name: "Example Chat",
      links: [link()],
      confirmError: new ApiError(409, "surface.no_workspace", "gone"),
    });
    await click(gone.row() as HTMLElement);
    await click(within(dialogOf(/Example Chat\?/)).getByRole("button", { name: "Sim, vincular" }));
    dialog = screen().getByRole("dialog");
    expect(within(dialog).getByRole("alert").textContent).toContain("Você não está mais neste workspace.");
    expect(within(dialog).queryByRole("button", { name: "Gerar um novo código" })).toBeNull();
    await click(within(dialog).getAllByRole("button", { name: "Fechar" }).at(-1) as HTMLElement);
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("worst case: long names, a display with nothing to break at, right-to-left words, in German", async () => {
    const worst = await notifications({
      name: LONG_SURFACE,
      links: [link({ display: LONG_HANDLE, profileName: LONG_PROFILE, orgName: LONG_WORKSPACE })],
    });
    await showIn(worst.app.services, "de");
    await click(worst.row() as HTMLElement);
    const dialog = screen().getByRole("dialog");
    expect(dialog.textContent).toContain(LONG_HANDLE);
    expect(dialog.textContent).toContain(LONG_PROFILE);
    // Untrusted words are text, isolated for their own direction.
    expect(dialog.querySelectorAll(".surface-sender bdi")).toHaveLength(2);
    cleanup();

    const code = await notifications({ name: LONG_SURFACE, links: [] });
    await showIn(code.app.services, "de");
    await click(
      within(code.row() as HTMLElement)
        .getAllByRole("button")
        .at(-1) as HTMLElement,
    );
    expect(screen().getByRole("dialog").textContent).toContain(LONG_SURFACE);
    cleanup();

    const active = await notifications({
      name: LONG_SURFACE,
      links: [link({ status: "active", display: LONG_HANDLE, profileName: LONG_PROFILE, expiresAt: null })],
    });
    await showIn(active.app.services, "de");
    expect(document.getElementById("notice-surface-status")?.textContent).toBe(`${LONG_HANDLE} · ${LONG_PROFILE}`);
    cleanup();

    const spaced = await notifications({
      name: LONG_SURFACE,
      links: [link({ status: "active", display: LONG_DISPLAY, profileName: LONG_PROFILE, expiresAt: null })],
    });
    await showIn(spaced.app.services, "de");
    expect(document.getElementById("notice-surface-status")?.textContent).toBe(`${LONG_DISPLAY} · ${LONG_PROFILE}`);
  });

  test("the app's logo takes the box of the glyphs on the rows beside it, in their color, a plain glyph without one", async () => {
    // The test DOM loads no image: this one says every logo loaded, as a browser does for a file that exists.
    const RealImage = globalThis.Image;
    globalThis.Image = class {
      onload: (() => void) | null = null;
      set src(_: string) {
        queueMicrotask(() => this.onload?.());
      }
    } as unknown as typeof Image;
    try {
      await notifications({ name: "Examplechat", links: [] });
      await settle(4);
      const glyphOf = (id: string) =>
        document.getElementById(id)?.closest(".settings-row")?.querySelector<SVGElement>(".settings-row__icon > svg");
      const mark = glyphOf("notice-surface-help");
      const beside = glyphOf("notice-mac-help");
      expect(mark?.querySelector("image")?.getAttribute("href")).toBe("/connectors/examplechat.svg");
      expect(mark?.querySelector("rect")?.getAttribute("fill")).toBe("currentColor");
      expect(beside).toBeTruthy();
      for (const el of [mark, beside]) expect(el?.getAttribute("class")).toBe("ac-icon");
      expect([mark?.style.width, mark?.style.height]).toEqual([beside?.style.width ?? "", beside?.style.height ?? ""]);
      expect(document.querySelector(".settings-row__icon .connector-icon")).toBeNull();
      cleanup();
      await notifications({ name: "Example Chat", links: [] });
      await settle(4);
      expect(glyphOf("notice-surface-help")?.querySelector("image")).toBeNull();
      expect(glyphOf("notice-surface-help")?.style.width).toBe(beside?.style.width ?? "");
    } finally {
      globalThis.Image = RealImage;
    }
  });

  test("at the longest name, in every language: the steps leave the name to the button under them", async () => {
    const { app, row } = await notifications({ name: LONG_SURFACE, links: [] });
    await click(
      within(row() as HTMLElement)
        .getAllByRole("button")
        .at(-1) as HTMLElement,
    );
    const open = screen().getByRole("dialog").querySelector("a[href]") as HTMLElement;
    open.addEventListener("click", (e) => e.preventDefault());
    await click(open);
    // The wait: every step on screen, the send step with its line.
    for (const lang of LOCALE_CODES) {
      await showIn(app.services, lang);
      const dialog = screen().getByRole("dialog");
      expect(dialog.querySelectorAll(".dv-step__text")).toHaveLength(1);
      for (const step of dialog.querySelectorAll(".dv-step")) expect(step.textContent).not.toContain(LONG_SURFACE);
      expect(open.textContent).toContain(LONG_SURFACE);
    }
  });

  // The worst case for CI's geometry check (the capture keeps each language's list): the longest name with its long
  // word, the longest sender, every language's words on the buttons. Each row's one button is on its name's line at the
  // row's end, or under the name at the end when the name's longest word and it can't share the line (`endline`).
  test("in every language, the list's buttons end their names' lines: the help behind the ⓘ, a state under the name", async () => {
    for (const links of [
      [],
      [link({ status: "active", display: LONG_DISPLAY, profileName: LONG_PROFILE, expiresAt: null })],
    ]) {
      const { app, row } = await notifications({ name: LONG_SURFACE, links });
      for (const lang of LOCALE_CODES) {
        await showIn(app.services, lang);
        const phone = document.getElementById("notice-phone-help")?.closest(".settings-row");
        for (const r of [phone, row()]) {
          expect(r?.classList.contains("settings-row--button")).toBe(true);
          expect(r?.querySelector(".settings-row__end > .ac-btn:last-child")).toBeTruthy();
        }
        expect(document.getElementById("notice-phone-status")).toBeNull();
        expect(document.getElementById("notice-surface-status")?.textContent ?? null).toBe(
          links.length ? `${LONG_DISPLAY} · ${LONG_PROFILE}` : null,
        );
        // The PIN row sits right under the app's own: its name leaves the app's out, so a long one can't wrap it to a
        // third line beside its button.
        const pin = document.getElementById("notice-surface-pin-help")?.closest(".settings-row");
        expect(Boolean(pin)).toBe(links.length > 0);
        expect(pin?.querySelector(".settings-row__label")?.textContent ?? "").not.toContain(LONG_SURFACE);
      }
      cleanup();
    }
  });
});

describe("a message written on the outside chat app", () => {
  const seeded = (style: "bubbles" | "comfortable" | "left") => {
    const state = withChatPrefs(seedState(), { channelStyle: style, dmStyle: style });
    const me = state.me?.user.id ?? "";
    state.surface = { name: "Example Chat", links: [] };
    const message = (id: string, via: Record<string, unknown>) =>
      ({
        id,
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: me },
        body: `mensagem ${id}`,
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        meta: { via },
      }) as Message;
    state.messages = [
      message("m1", { kind: "surface", surface: "example chat", linkId: "link-1" }),
      message("m2", { kind: "surface", surface: "example chat", linkId: "link-1", forwarded: true }),
      message("m3", { kind: "surface", surface: "otherchat", linkId: "link-2" }),
    ];
    return state;
  };
  const marks = () => [...document.querySelectorAll<HTMLElement>(".msg-via")];

  test("a glyph before the time says via the app, forwarded ones say so, the name falling back to the id", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seeded("bubbles")) });
    await settle(8);
    const tags = marks();
    expect(tags.map((tag) => tag.getAttribute("aria-label"))).toEqual([
      "via Example Chat",
      "encaminhada via Example Chat",
      "via Otherchat",
    ]);
    expect(tags[0]?.getAttribute("title")).toBe("Enviada por Walter pelo Example Chat");
    expect(tags[1]?.getAttribute("title")).toBe(
      "Walter encaminhou isto do Example Chat. As palavras são de outra pessoa.",
    );
  });

  test("my own rows show it in every look, grouped ones too, never only to screen readers", async () => {
    for (const style of ["bubbles", "comfortable", "left"] as const) {
      await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seeded(style)) });
      await settle(8);
      const tags = marks();
      expect(tags).toHaveLength(3);
      for (const tag of tags) expect(tag.closest(".ac-visually-hidden")).toBeNull();
      if (style === "bubbles") for (const tag of tags) expect(tag.closest(".ac-msg__stamp")).toBeTruthy();
      cleanup();
    }
  });
});

describe("the linked email's undo", () => {
  const undoPage = async (undo: NonNullable<ReturnType<typeof seedState>["surface"]>["undo"], token = "tok-1") => {
    const state = seedState({ me: null });
    state.surface = { name: "Example Chat", links: [], undo };
    await renderApp(`/email-undo?kind=surface${token ? `&token=${token}` : ""}`, { api: createFakeApi(state) });
    return state;
  };

  test("only its button unlinks; it names the app and the sender", async () => {
    const state = await undoPage({ unlinked: true, display: "5511900000001" });
    expect(screen().getByRole("heading", { name: "Desvincular o app de chat?" })).toBeTruthy();
    expect(calls(state, "surfaces.undo")).toEqual([]);
    await click(screen().getByRole("button", { name: /Desvincular/ }));
    expect(calls(state, "surfaces.undo")).toHaveLength(1);
    expect(screen().getByRole("heading", { name: "Example Chat desvinculado" })).toBeTruthy();
    expect(document.body.textContent).toContain("+55 (11) 90000-0001 não alcança mais a sua conta.");
    expect(screen().getByRole("link", { name: "Entrar" })).toBeTruthy();
  });

  test("already ended, a link that no longer works, and too many tries", async () => {
    await undoPage({ unlinked: false, display: null });
    await click(screen().getByRole("button", { name: /Desvincular/ }));
    expect(screen().getByRole("heading", { name: "Já desvinculado" })).toBeTruthy();
    expect(document.body.textContent).toContain("Esse remetente no Example Chat já tinha sido desvinculado.");
    cleanup();

    await undoPage(undefined);
    await click(screen().getByRole("button", { name: /Desvincular/ }));
    expect(screen().getByRole("heading", { name: "Este link para desfazer não funciona mais" })).toBeTruthy();
    expect(document.body.textContent).toContain("configurações de notificações");
    cleanup();

    await undoPage(undefined, "");
    expect(screen().getByRole("heading", { name: "Este link para desfazer não funciona mais" })).toBeTruthy();
    expect(screen().queryByRole("button", { name: /Desvincular/ })).toBeNull();
    cleanup();

    await undoPage(new ApiError(429, "rate_limited", "slow down"));
    await click(screen().getByRole("button", { name: /Desvincular/ }));
    expect(screen().getByRole("alert")).toBeTruthy();
    expect(screen().getByRole("button", { name: /Desvincular/ })).toBeTruthy();
  });

  test("worst case: a long app name and a display with nothing to break at, in German", async () => {
    const state = seedState({ me: null });
    state.surface = { name: LONG_SURFACE, links: [], undo: { unlinked: false, display: LONG_HANDLE } };
    const app = await renderApp("/email-undo?kind=surface&token=tok-w", { api: createFakeApi(state) });
    await showIn(app.services, "de");
    await click(screen().getByRole("button"));
    expect(document.body.textContent).toContain(LONG_HANDLE);
  });
});
