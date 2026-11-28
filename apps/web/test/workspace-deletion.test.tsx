import { afterEach, describe, expect, test } from "bun:test";
import { domWindow, setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import {
  ApiError,
  keys,
  type OrgDeletion,
  type OrgSummary,
  type Role,
  useMe,
  useRestoreAccount,
} from "@agenteschat/client";
import { CLOUD_SERVER } from "@agenteschat/client/lib/server";
import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, meAsAdmin, ORG_ID, seedState } from "./fake-api";
import { createFakeAuth } from "./fake-auth";
import { renderApp, renderPage, screen, settle } from "./render";

afterEach(() => cleanup());

const BETA_ID = "00000000-0000-4000-8000-0000000000b2";
const DAY = 86_400_000;
const soon = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
/** The onboarding's account menu, on its rail (Radix: keyboard), or the one named `name`, and the menu it opens. */
async function accountMenu(name: string | RegExp = "Sua conta") {
  const me = screen().getByRole("button", { name });
  me.focus();
  await act(async () => {
    fireEvent.keyDown(me, { key: "Enter" });
    fireEvent.keyUp(me, { key: "Enter" });
  });
  await settle(2);
  return screen().getByRole("menu");
}
const meEvery = (qc: QueryClient) =>
  qc
    .getQueryCache()
    .find({ queryKey: keys.me })
    ?.observers.map((o) => o.options.refetchInterval);

/** Acme with this person's role (and its deletion, standing or mode, when there is one), and Beta, at `path`. */
async function open(
  path: string,
  {
    role = "owner",
    name = "Acme",
    deletion,
    standing,
    createdAt,
    mode,
    paysPlan,
    beta = { id: BETA_ID, name: "Beta", role: "member" },
    state = seedState(),
  }: {
    role?: Role;
    name?: string;
    deletion?: OrgDeletion;
    standing?: OrgSummary["standing"];
    createdAt?: string;
    mode?: OrgSummary["mode"];
    /** They pay for Acme's plan. */
    paysPlan?: boolean;
    /** Null: Acme is their only workspace. */
    beta?: OrgSummary | null;
    state?: ReturnType<typeof seedState>;
  } = {},
) {
  if (!state.me) throw new Error("signed in");
  state.me.organizations = [
    {
      id: ORG_ID,
      name,
      role,
      ...(deletion ? { deletion } : {}),
      ...(standing ? { standing } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(mode ? { mode } : {}),
      ...(paysPlan ? { paysPlan: true as const } : {}),
    },
    ...(beta ? [beta] : []),
  ];
  const r = await renderApp(path, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
}

describe("deleting a workspace (Configurações › Geral)", () => {
  test("only its owners get the card", async () => {
    await open(`/org/${ORG_ID}/settings`);
    const card = screen().getByRole("region", { name: "Apagar workspace" });
    expect(card.textContent).toContain(
      "Acme fica só para leitura para todos agora. Ele é apagado de vez depois de 7 dias.",
    );
    expect(within(card).getByRole("button", { name: "Apagar workspace…" })).toBeTruthy();
    for (const admin of [true, false]) {
      cleanup();
      const state = seedState();
      if (admin) meAsAdmin(state);
      // Not even from the address the phone opens.
      await open(`/org/${ORG_ID}/settings/general?delete=1`, { role: "member", state });
      expect(screen().queryByRole("region", { name: "Apagar workspace" })).toBeNull();
      expect(screen().queryByRole("dialog")).toBeNull();
    }
  });

  test("the name, typed with its invisible characters ignored, then the code from the email, before it deletes", async () => {
    // A co-owner put a zero-width space in the name: typing it plainly still confirms.
    const { state, router } = await open(`/org/${ORG_ID}/settings`, { name: "Ac\u200bme" });
    const email = state.me?.user.email ?? "";
    await click(screen().getByRole("button", { name: "Apagar workspace…" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Apagar Ac\u200bme?" });
    expect(dialog.textContent).toContain("Qualquer dono pode restaurar até");
    expect(dialog.textContent).toContain("Todos passam a só ler e recebem um email");
    expect(dialog.textContent).toContain(`Vamos mandar um código para ${email} para confirmar que é você.`);
    const send = within(dialog).getByRole("button", { name: "Enviar código" });
    expect(send.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Digite Ac\u200bme para confirmar"), "acm");
    expect(send.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Digite Ac\u200bme para confirmar"), " ACME ");
    await click(send);
    await settle(4);
    expect(state.calls.filter((c) => c.method === "orgs.deletionCode").map((c) => c.args)).toEqual([[ORG_ID]]);
    expect(dialog.textContent).toContain(`Mandamos para ${email}. Vale por 10 minutos.`);
    // Another code only after a minute.
    expect(
      within(dialog)
        .getByRole("button", { name: /^Enviar outro em \d:\d\d$/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    const submit = within(dialog).getByRole("button", { name: "Apagar workspace" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    // Pasted with its space: the digits are what count.
    await type(within(dialog).getByLabelText("Código do email"), "482 913");
    expect(submit.hasAttribute("disabled")).toBe(false);
    await click(submit);
    await settle(6);
    expect(state.calls.find((c) => c.method === "orgs.deleteWorkspace")?.args).toEqual([ORG_ID, { code: "482913" }]);
    // The line on top says so at once, over Geral, which has no way to delete it again.
    expect(screen().getByRole("region", { name: "Status do workspace" }).textContent).toContain(
      "Ac\u200bme vai ser apagado em",
    );
    expect(screen().queryByRole("region", { name: "Apagar workspace" })).toBeNull();
    expect(screen().queryByRole("dialog")).toBeNull();
    // Out of the address too: restored, Geral doesn't open the dialog again.
    expect(router.state.location.search).not.toHaveProperty("delete");
  });

  test("a code refused says why under its field, which empties for the next one", async () => {
    const state = seedState({ deletionError: new ApiError(400, "reauth.code_wrong", "That code isn't right.") });
    await open(`/org/${ORG_ID}/settings/general?delete=1`, { state });
    const dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    await type(within(dialog).getByLabelText("Digite Acme para confirmar"), "Acme");
    await click(within(dialog).getByRole("button", { name: "Enviar código" }));
    await settle(4);
    await type(within(dialog).getByLabelText("Código do email"), "111111");
    await click(within(dialog).getByRole("button", { name: "Apagar workspace" }));
    await settle(6);
    expect(dialog.textContent).toContain("Código errado. Tente de novo.");
    expect((within(dialog).getByLabelText("Código do email") as HTMLInputElement).value).toBe("");
    expect(within(dialog).queryByRole("alert", { name: /Código errado/ })).toBeNull();
  });

  test("a server that sends no email asks for the password; an account without one adds it first", async () => {
    const state = seedState({ authConfig: { passwordReset: false } });
    await open(`/org/${ORG_ID}/settings/general?delete=1`, { state });
    let dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    expect(dialog.textContent).not.toContain("Vamos mandar um código");
    expect(dialog.textContent).toContain("Todos passam a só ler");
    await type(within(dialog).getByLabelText("Digite Acme para confirmar"), "Acme");
    const submit = within(dialog).getByRole("button", { name: "Apagar workspace" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Sua senha"), "correct horse battery");
    await click(submit);
    await settle(6);
    expect(state.calls.find((c) => c.method === "orgs.deleteWorkspace")?.args).toEqual([
      ORG_ID,
      { password: "correct horse battery" },
    ]);

    cleanup();
    const none = seedState({ authConfig: { passwordReset: false } });
    if (!none.me) throw new Error("signed in");
    none.me.user = { ...none.me.user, hasPassword: false };
    await open(`/org/${ORG_ID}/settings/general?delete=1`, { state: none });
    dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    expect(dialog.textContent).toContain(
      "Este servidor não manda email. Adicione uma senha para confirmar que é você.",
    );
    expect(within(dialog).queryByRole("button", { name: "Apagar workspace" })).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Adicionar uma senha" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Adicionar uma senha" })).toBeTruthy();
  });
});

describe("a workspace being deleted opens as ever, read-only, under a line on top", () => {
  const deletion = (dueAt: string | null, by = { id: "u-joao", name: "João" }): OrgDeletion => ({
    dueAt,
    requestedAt: new Date(Date.now() - DAY).toISOString(),
    requestedBy: by,
  });
  const line = () => screen().getByRole("region", { name: "Status do workspace" });

  test("its owners read when it goes and who deleted it, and restore it there before the date", async () => {
    const { state, services } = await open(`/org/${ORG_ID}/settings`, { deletion: deletion(soon(6)) });
    expect(line().textContent).toMatch(/Acme vai ser apagado em \d+ \w+/);
    expect(line().textContent).toContain("João apagou em");
    expect(line().textContent).not.toContain("Só um dono");
    // The page under it is the workspace's own, with no way to delete it again.
    expect(screen().queryByRole("region", { name: "Apagar workspace" })).toBeNull();
    // Nobody hears of a restore: GET /me is asked again every 30 s meanwhile.
    expect(meEvery(services.queryClient)).toContain(30_000);
    await click(within(line()).getByRole("button", { name: "Restaurar workspace" }));
    await settle(6);
    expect(state.calls.filter((c) => c.method === "orgs.restore")).toHaveLength(1);
    expect(screen().queryByRole("region", { name: "Status do workspace" })).toBeNull();
    expect(meEvery(services.queryClient)).not.toContain(30_000);
  });

  test("the one who deleted it reads that they did; members, that only an owner can restore it", async () => {
    await open(`/org/${ORG_ID}`, { deletion: deletion(soon(6), { id: "u-walter", name: "Walter" }) });
    expect(line().textContent).toContain("Você apagou em");

    cleanup();
    await open(`/org/${ORG_ID}`, { role: "member", deletion: deletion(soon(6)) });
    expect(within(line()).queryByRole("button", { name: "Restaurar workspace" })).toBeNull();
    expect(line().textContent).toContain("Só um dono pode restaurar.");

    // Past the date nobody restores, and no date shows.
    cleanup();
    await open(`/org/${ORG_ID}`, { deletion: deletion(null) });
    expect(line().textContent).toContain("Acme está sendo apagado");
    expect(within(line()).queryByRole("button", { name: "Restaurar workspace" })).toBeNull();
    expect(line().textContent).not.toContain("vai ser apagado");
    expect(line().textContent).not.toContain("Só um dono");
  });

  test("its conversations read as ever, the message box says why nothing can be sent", async () => {
    await open(`/org/${ORG_ID}/c/${ENG_ID}`, { deletion: deletion(soon(6)) });
    expect(screen().getByRole("heading", { name: "eng" })).toBeTruthy();
    expect(
      screen().getByText("Você não pode enviar mensagens enquanto este workspace está sendo apagado"),
    ).toBeTruthy();
    expect(screen().queryByRole("combobox", { name: "Mensagem para #eng" })).toBeNull();
  });

  test("what would change it is greyed out or gone, and the line stays on top in Criar agente; the person's own stays", async () => {
    const frozen = () => document.querySelector("fieldset.settings__frozen");
    const pill = () => screen().queryByRole("group", { name: "Meu Início" });
    // As ever first: Novo agente under the agents, Organizar and Widget on Início, Geral's fields.
    await open(`/org/${ORG_ID}`);
    expect(document.querySelector(".sidebar__new-agent")).toBeTruthy();
    expect(pill()).toBeTruthy();
    cleanup();
    await open(`/org/${ORG_ID}`, { deletion: deletion(soon(6)) });
    expect(document.querySelector(".sidebar__new-agent")).toBeNull();
    expect(pill()).toBeNull();

    cleanup();
    await open(`/org/${ORG_ID}/settings/general`, { deletion: deletion(soon(6)) });
    expect(frozen()?.hasAttribute("disabled")).toBe(true);
    expect(frozen()?.querySelector("input, button")).toBeTruthy();
    cleanup();
    await open(`/org/${ORG_ID}/settings/account`, { deletion: deletion(soon(6)) });
    expect(frozen()).toBeNull();
    // What is read through its rows and tabs stays as ever (the Vault, roles, skills, the agents' access): the server
    // refuses its writes.
    cleanup();
    await open(`/org/${ORG_ID}/settings/roles`, { deletion: deletion(soon(6)) });
    expect(frozen()).toBeNull();
    cleanup();
    await open(`/org/${ORG_ID}/settings/access`, { deletion: deletion(soon(6)) });
    expect(frozen()).toBeNull();
    expect(screen().getByRole("radio", { name: "Nativos" })).toBeTruthy();
    // Importar e exportar keeps the workspace as a file and brings no agent in.
    const card = (name: string) => screen().queryByRole("region", { name });
    cleanup();
    await open(`/org/${ORG_ID}/settings/import`);
    expect([card("Importar") !== null, card("Exportar") !== null]).toEqual([true, true]);
    cleanup();
    await open(`/org/${ORG_ID}/settings/import`, { deletion: deletion(soon(6)) });
    expect([card("Importar") !== null, card("Exportar") !== null]).toEqual([false, true]);

    // Equipe with no agent yet speaks as to someone who can't make one, since no button follows.
    const team = async (deleting: boolean) => {
      cleanup();
      const state = seedState();
      state.agents = [];
      await open(`/org/${ORG_ID}/team`, { state, ...(deleting ? { deletion: deletion(soon(6)) } : {}) });
      return document.querySelector(".team .ac-empty__title")?.textContent;
    };
    expect(await team(false)).toBe("Monte seu time de agentes");
    expect(await team(true)).toBe("Seu time de agentes aparece aqui");

    cleanup();
    await open(`/org/${ORG_ID}/agents/new`, { deletion: deletion(soon(6)) });
    expect(line().textContent).toMatch(/Acme vai ser apagado em/);
  });
});

describe("a workspace being deleted, at its end and in the desktop app", () => {
  const deleted = (dueAt: string | null): OrgDeletion => ({ dueAt, requestedAt: soon(-1), requestedBy: null });

  test("deleted for good, it leaves for the person's start, never a page saying they aren't in it", async () => {
    const { state, services, router } = await open(`/org/${ORG_ID}`, { deletion: deleted(null) });
    if (!state.me) throw new Error("signed in");
    state.me = { ...state.me, organizations: state.me.organizations.filter((o) => o.id !== ORG_ID) };
    await act(async () => {
      await services.queryClient.refetchQueries({ queryKey: keys.me });
    });
    await settle(8);
    expect(router.state.location.pathname).toStartWith(`/org/${BETA_ID}`);
    expect(document.body.textContent).not.toContain("Você não faz parte deste workspace");
  });

  test("in the desktop app, it opens under its title bar as ever, the line on top of the work area", async () => {
    const app = window as { __agentesDesktop?: unknown };
    app.__agentesDesktop = { version: "0.6.0" };
    try {
      await open(`/org/${ORG_ID}`, { deletion: deleted(soon(6)) });
      expect(screen().getByRole("region", { name: "Status do workspace" }).textContent).toContain("vai ser apagado");
      expect(document.querySelector(".titlebar")).not.toBeNull();
    } finally {
      delete app.__agentesDesktop;
    }
  });
});

describe("a plan its payer would lose with the workspace", () => {
  const unpaid = {
    id: BETA_ID,
    name: "Beta",
    role: "owner" as const,
    standing: { state: "hold" as const, reason: "payment" },
  };
  const withBilling = () => {
    const state = seedState();
    state.authConfig = { billingUrl: "https://billing.example.com" };
    return state;
  };
  const paid = (path: string, extra: { deletion?: OrgDeletion } = {}) =>
    open(path, { beta: unpaid, state: withBilling(), paysPlan: true, ...extra });

  test("deleting it offers to move the plan to their workspace without one, which goes in one click", async () => {
    const { state } = await paid(`/org/${ORG_ID}/settings`);
    await click(screen().getByRole("button", { name: "Apagar workspace…" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    expect(dialog.textContent).toContain("Seu plano fica com este workspace e para de renovar.");
    expect(dialog.textContent).not.toContain("O plano dele para de renovar.");
    await click(within(dialog).getByRole("button", { name: "Mover meu plano para Beta" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "orgs.movePlan").map((c) => c.args)).toEqual([[ORG_ID, BETA_ID]]);
    expect(dialog.textContent).toContain("Seu plano está indo para Beta. Chega em cerca de um minuto.");
    expect(within(dialog).queryByRole("button", { name: "Mover meu plano para Beta" })).toBeNull();
  });

  test("being deleted, its line offers the move beside Restaurar until the date", async () => {
    const deletion = { dueAt: soon(6), requestedAt: new Date().toISOString(), requestedBy: null };
    const { state } = await paid(`/org/${ORG_ID}/settings`, { deletion });
    const line = screen().getByRole("region", { name: "Status do workspace" });
    expect(line.textContent).toContain("Seu plano para de renovar com ele.");
    await click(within(line).getByRole("button", { name: "Mover meu plano para Beta" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "orgs.movePlan").map((c) => c.args)).toEqual([[ORG_ID, BETA_ID]]);
    expect(line.textContent).toContain("Seu plano está indo para Beta.");
    expect(within(line).getByRole("button", { name: "Restaurar workspace" })).toBeTruthy();
  });

  test("someone who doesn't pay for it, or with no workspace to take it, reads the plan stops renewing", async () => {
    await open(`/org/${ORG_ID}/settings`, { beta: unpaid, state: withBilling() });
    await click(screen().getByRole("button", { name: "Apagar workspace…" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    expect(dialog.textContent).toContain("O plano dele para de renovar.");
    expect(within(dialog).queryByRole("button", { name: /Mover meu plano/ })).toBeNull();
  });
});

describe("the workspace menu tells closed and same-named workspaces apart", () => {
  const rows = async () => {
    await act(async () => {
      fireEvent.click(screen().getByRole("button", { name: /^Menu do workspace/ }));
    });
    await settle(4);
    return within(screen().getByRole("menu", { name: "Seus workspaces" })).getAllByRole("menuitem");
  };

  test("one being deleted says so with its date, one on its own looks as ever", async () => {
    await open(`/org/${ORG_ID}/issues`, {
      beta: {
        id: BETA_ID,
        name: "Beta",
        role: "owner",
        deletion: { dueAt: soon(5), requestedAt: soon(-2), requestedBy: null },
      },
    });
    const [acme, beta] = await rows();
    expect(acme?.textContent).not.toContain("Sendo apagado");
    expect(acme?.textContent).not.toContain("Criado em");
    expect(beta?.textContent).toContain("Sendo apagado, some em");
  });

  test("two live ones with the same name read their creation dates", async () => {
    const state = seedState();
    if (!state.me) throw new Error("signed in");
    state.me.organizations = [
      { id: ORG_ID, name: "Acme", role: "owner", createdAt: "2026-01-10T12:00:00.000Z" },
      { id: BETA_ID, name: "Acme", role: "owner", createdAt: "2026-03-02T12:00:00.000Z" },
    ];
    await renderApp(`/org/${ORG_ID}/issues`, { api: createFakeApi(state) });
    await settle(8);
    const [first, second] = await rows();
    expect(first?.textContent).toMatch(/Criado em 10 jan/);
    expect(second?.textContent).toMatch(/Criado em 2 mar/);
  });

  test("a personal one of mine is me, with the line under the name a team's has (ADR 0159)", async () => {
    const { state } = await open(`/org/${ORG_ID}/issues`, {
      beta: { id: BETA_ID, name: "Pessoal", role: "owner", mode: "personal" },
    });
    const [acme, mine] = await rows();
    expect(acme?.querySelector(".ac-mo__name")?.textContent).toBe("Acme");
    expect(acme?.querySelector(".ac-menu__desc")?.textContent).toBe("Dono");
    // My name on it, never the workspace's, and "Pessoal" where a team's says my role: the same two lines.
    expect(mine?.querySelector(".ac-mo__name")?.textContent).toBe(state.me?.user.name);
    expect(mine?.querySelector(".ac-menu__desc")?.textContent).toBe("Pessoal");
  });
});

describe("the desktop app lists every server's workspaces (ADR 0154)", () => {
  const OWN = "https://agentes.exemplo.com.br";
  const menuRows = async () => {
    await act(async () => {
      fireEvent.click(screen().getByRole("button", { name: /^Menu do workspace/ }));
    });
    await settle(4);
    return within(screen().getByRole("menu", { name: "Seus workspaces" }));
  };
  const text = (el: Element) => el.textContent?.replace(/\s+/g, " ").trim();
  const names = (menu: ReturnType<typeof within>) => menu.getAllByRole("menuitem").map(text);
  /** The menu's items and its headings (matched by `heading`), in order: what sits under which server. */
  const lines = (menu: Element, heading: string) =>
    [...menu.querySelectorAll(`${heading}, [role="menuitem"]`)].map(text);
  type App = { __agentesDesktop?: unknown; __TAURI_INTERNALS__?: unknown };
  let home: string | undefined;
  /** This page in the desktop app at `here`, which reads Oficina on `other`; what the page asks of the app, listed. */
  const inDesktop = (here: string, other: string) => {
    home ??= domWindow().location.href;
    domWindow().happyDOM.setURL(here);
    const asked: Record<string, unknown>[] = [];
    const app = window as App;
    app.__agentesDesktop = { version: "0.6.0", workspaces: true };
    app.__TAURI_INTERNALS__ = {
      invoke: async (_cmd: string, args?: { request?: Record<string, unknown> }) => {
        const request = args?.request;
        if (request) asked.push(request);
        if (request?.kind !== "workspaces") return {};
        const orgs = [{ id: "oficina", name: "Oficina", logo: null, unread: 4, waiting: 0 }];
        return { servers: [{ server: other, signedIn: true, orgs }] };
      },
    };
    return asked;
  };
  afterEach(() => {
    const app = window as App;
    delete app.__agentesDesktop;
    delete app.__TAURI_INTERNALS__;
    if (home) domWindow().happyDOM.setURL(home);
  });

  test("by server with unread counts; another server's opens there; on agentes.chat, Adicionar workspace alone opens the app's window", async () => {
    const asked = inDesktop(CLOUD_SERVER, OWN);
    await open(`/org/${ORG_ID}/issues`);
    const menu = await menuRows();
    expect(menu.getByText("agentes.exemplo.com.br").parentElement?.textContent).toContain("Seu servidor");
    expect(names(menu)).toEqual([
      expect.stringContaining("Acme"),
      expect.stringContaining("Beta"),
      expect.stringMatching(/Oficina.*4/),
      expect.stringContaining("Adicionar workspace"),
      // Another account beside this one (ADR 0183).
      expect.stringContaining("Adicionar conta"),
    ]);
    expect(menu.queryByText("Novo workspace")).toBeNull();
    await click(menu.getAllByRole("menuitem")[2] as Element);
    expect(asked).toContainEqual({ kind: "openWorkspace", server: OWN, orgId: "oficina" });
    const again = await menuRows();
    await click(again.getByText("Adicionar workspace"));
    expect(asked).toContainEqual({ kind: "addWorkspace" });
  });

  test("on a server of one's own, whose window can't make one there, Novo workspace does, under that server", async () => {
    inDesktop(OWN, CLOUD_SERVER);
    const { router } = await open(`/org/${ORG_ID}/issues`);
    const menu = await menuRows();
    expect(lines(screen().getByRole("menu", { name: "Seus workspaces" }), ".sidebar__menu-server")).toEqual([
      "agentes.exemplo.com.br· Seu servidor",
      expect.stringContaining("Acme"),
      expect.stringContaining("Beta"),
      "Novo workspace",
      "agentes.chat",
      expect.stringMatching(/Oficina.*4/),
      expect.stringContaining("Adicionar workspace"),
      expect.stringContaining("Adicionar conta"),
    ]);
    await click(menu.getByText("Novo workspace"));
    await settle(4);
    expect(router.state.location.pathname).toBe("/onboarding");
  });

  test("a personal workspace's account menu the same: Novo workspace under one's own server, not on agentes.chat", async () => {
    const own = "agentes.exemplo.com.br · Seu servidor";
    const oficina = expect.stringMatching(/Oficina.*4/);
    for (const [here, other, servers] of [
      [CLOUD_SERVER, OWN, ["agentes.chat", expect.anything(), "Beta", own, oficina]],
      [OWN, CLOUD_SERVER, [own, expect.anything(), "Beta", "Novo workspace", "agentes.chat", oficina]],
    ] as const) {
      inDesktop(here, other);
      const { router } = await open(`/org/${ORG_ID}/issues`, { mode: "personal" });
      const list = await accountMenu(/^Conta: /);
      const menu = within(list);
      const all = lines(list, ".ac-menu__heading");
      expect(all.slice(all.indexOf("Seus workspaces") + 1)).toEqual([
        ...servers,
        expect.stringContaining("Adicionar workspace"),
        expect.stringContaining("Adicionar conta"),
        "Sair",
      ]);
      if (here === OWN) {
        await click(menu.getByText("Novo workspace"));
        await settle(4);
        expect(router.state.location.pathname).toBe("/onboarding");
      }
      cleanup();
    }
  });

  test("in a browser, the menu is as it was", async () => {
    await open(`/org/${ORG_ID}/issues`);
    const menu = await menuRows();
    expect(menu.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      expect.stringContaining("Acme"),
      expect.stringContaining("Beta"),
      expect.stringContaining("Novo workspace"),
      // The one thing new in a browser: another account beside this one (ADR 0183).
      expect.stringContaining("Adicionar conta"),
    ]);
    expect(menu.queryByText("Adicionar workspace")).toBeNull();
  });
});

describe("adding a password (the account menu)", () => {
  test("its dialog is kept in the address, so signing in again comes back to it", async () => {
    const state = seedState();
    if (!state.me) throw new Error("signed in");
    state.me.user = { ...state.me.user, hasPassword: false };
    await open(`/org/${ORG_ID}/issues?account=password`, { state });
    expect(screen().getByRole("dialog", { name: "Adicionar uma senha" })).toBeTruthy();
  });
});

describe("deleting your account (Configurações › Sua conta)", () => {
  test("Sua conta's last card starts it: a workspace that still needs you comes first, with its two ways out", async () => {
    const state = seedState({
      deletionPlan: {
        closes: [],
        leaves: [{ id: BETA_ID, name: "Beta", role: "owner" }],
        soleOwner: [{ id: BETA_ID, name: "Beta" }],
        computers: [],
        staysBehind: [],
        serverOwner: false,
      },
    });
    const { router } = await open(`/org/${ORG_ID}/settings/account`, { state });
    const card = screen().getByRole("region", { name: "Recomeçar ou apagar" });
    // The kit's Tabs wrap the strip and the panel in a box that lays nothing out (`display: contents`).
    const cards = document.querySelectorAll(".settings__body .ac-tabpanel > .ac-card");
    expect(cards[cards.length - 1]).toBe(card);
    expect(card.classList.contains("settings-danger")).toBe(true);
    const row = Array.from(card.querySelectorAll("details.danger-row")).at(-1) as HTMLElement;
    await act(async () => {
      row.setAttribute("open", "");
    });
    await click(within(row).getByRole("button", { name: "Apagar conta" }));
    await settle(6);
    // Kept in the address: a sign-in again comes back to it.
    expect(router.state.location.search).toMatchObject({ account: "delete" });
    const dialog = screen().getByRole("dialog", { name: "Apagar a sua conta inteira?" });
    expect(dialog.textContent).toContain("Antes de apagar");
    expect(dialog.textContent).toContain(
      "Você é a única pessoa dona de Beta. Torne outra pessoa dona, ou apague Beta.",
    );
    expect(within(dialog).getByRole("link", { name: "Abrir Pessoas" }).getAttribute("href")).toBe(
      `/org/${BETA_ID}/settings/members`,
    );
    expect(within(dialog).getByRole("link", { name: "Apagar Beta" }).getAttribute("href")).toBe(
      `/org/${BETA_ID}/settings/general?delete=1`,
    );
    expect(within(dialog).queryByRole("button", { name: "Apagar conta" })).toBeNull();
  });

  test("a workspace whose others are all outside collaborators: invite a member to make them an owner", async () => {
    const state = seedState({
      deletionPlan: {
        closes: [],
        leaves: [{ id: BETA_ID, name: "Beta", role: "owner" }],
        soleOwner: [{ id: BETA_ID, name: "Beta", onlyOutside: true }],
        computers: [],
        staysBehind: [],
        serverOwner: false,
      },
    });
    await open(`/org/${ORG_ID}/issues?account=delete`, { state });
    const dialog = screen().getByRole("dialog", { name: "Apagar a sua conta inteira?" });
    expect(dialog.textContent).toContain(
      "Você é a única pessoa dona de Beta, e as outras pessoas lá são colaboradores externos, que não podem ser donos. Convide um membro e torne essa pessoa dona, ou apague Beta.",
    );
    expect(within(dialog).getByRole("link", { name: "Abrir Pessoas" })).toBeTruthy();
  });

  test("the account menu doesn't offer it beside Sair", async () => {
    await open(`/org/${ORG_ID}/issues`);
    // A Radix menu opens from the keyboard here (a pointer press, not a click, opens it with a mouse).
    const account = screen().getByRole("button", { name: /^Conta: / });
    account.focus();
    await act(async () => fireEvent.keyDown(account, { key: "Enter" }));
    await settle(2);
    const menu = screen().getAllByRole("menu")[0] as HTMLElement;
    expect(within(menu).getByRole("menuitem", { name: "Sair" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: /Apagar/ })).toBeNull();
  });

  test("one still being set up has no People yet: its onboarding finishes it or deletes it", async () => {
    const state = seedState({
      deletionPlan: {
        closes: [],
        leaves: [{ id: BETA_ID, name: "Beta", role: "owner" }],
        soleOwner: [{ id: BETA_ID, name: "Beta" }],
        computers: [],
        staysBehind: [],
        serverOwner: false,
      },
    });
    const beta: OrgSummary = {
      id: BETA_ID,
      name: "Beta",
      role: "owner",
      onboarding: { step: "agents", generalChannelId: "c-beta" },
    };
    await open(`/org/${ORG_ID}/issues?account=delete`, { state, beta });
    const dialog = screen().getByRole("dialog", { name: "Apagar a sua conta inteira?" });
    expect(dialog.textContent).toContain(
      "Você é a única pessoa dona de Beta. Termine de configurar para tornar outra pessoa dona, ou apague Beta.",
    );
    expect(within(dialog).getByRole("link", { name: "Terminar a configuração" }).getAttribute("href")).toBe(
      "/onboarding",
    );
    expect(within(dialog).getByRole("link", { name: "Apagar Beta" }).getAttribute("href")).toBe("/onboarding?delete=1");
  });

  test("only for someone with no workspace that opens: under its own heading, apart from Sair", async () => {
    const suspended = { state: "suspended", reason: null } as const;
    const betaClosed: OrgSummary = { id: BETA_ID, name: "Beta", role: "member", standing: suspended };
    const heading = () => screen().getByRole("region", { name: "Sua conta inteira" });
    const { router } = await open(`/org/${ORG_ID}`, { standing: suspended, beta: betaClosed });
    expect(screen().getByRole("heading", { name: "Acme está indisponível" })).toBeTruthy();
    expect(within(heading()).queryByRole("button", { name: "Sair" })).toBeNull();
    expect(screen().getByRole("button", { name: "Sair" })).toBeTruthy();
    await click(within(heading()).getByRole("button", { name: "Apagar conta…" }));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Apagar a sua conta inteira?" })).toBeTruthy();
    // Kept in the address: a sign-in again comes back to it.
    expect(router.state.location.search).toMatchObject({ account: "delete" });

    cleanup();
    const state = seedState();
    if (!state.me) throw new Error("signed in");
    state.me.organizations = [];
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(8);
    // The onboarding's account menu (ADR 0162): Apagar conta beside Sair.
    const menu = await accountMenu();
    expect(within(menu).getByRole("menuitem", { name: "Sair" })).toBeTruthy();
    await click(within(menu).getByRole("menuitem", { name: "Apagar conta" }));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Apagar a sua conta inteira?" })).toBeTruthy();
  });

  test("with another workspace that opens, a closed screen never offers it: going there is the main action", async () => {
    const closing = { dueAt: soon(6), requestedAt: soon(-1), requestedBy: null };
    const noAccountDeletion = () => {
      expect(screen().queryByRole("button", { name: /^Apagar conta/ })).toBeNull();
      expect(screen().queryByRole("region", { name: "Sua conta inteira" })).toBeNull();
    };
    // Being deleted, even their only workspace opens: Sua conta is there.
    await open(`/org/${ORG_ID}`, { deletion: closing, beta: null });
    noAccountDeletion();
    expect(screen().getByRole("region", { name: "Status do workspace" })).toBeTruthy();

    cleanup();
    await open(`/org/${ORG_ID}`, {
      standing: { state: "suspended", reason: null },
      beta: { id: BETA_ID, name: "Beta", role: "member", deletion: closing },
    });
    noAccountDeletion();
    expect(screen().getByRole("link", { name: /^Beta/ }).className).toContain("ac-btn--primary");

    // Even from the address: this account's deletion starts in Sua conta.
    cleanup();
    await open(`/org/${ORG_ID}?account=delete`, { standing: { state: "suspended", reason: null } });
    expect(screen().queryByRole("dialog")).toBeNull();

    cleanup();
    const state = seedState();
    if (!state.me) throw new Error("signed in");
    state.me.organizations = [{ id: BETA_ID, name: "Beta", role: "owner" }];
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(8);
    noAccountDeletion();
    // Its account menu has Sair and no Apagar conta: Beta opens, and Sua conta there has it.
    const menu = await accountMenu();
    expect(within(menu).getByRole("menuitem", { name: "Sair" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Apagar conta" })).toBeNull();
  });

  test("one still being set up doesn't count as a way to Sua conta", async () => {
    await open(`/org/${ORG_ID}`, {
      standing: { state: "suspended", reason: null },
      beta: { id: BETA_ID, name: "Beta", role: "owner", onboarding: { step: "agents", generalChannelId: "c-beta" } },
    });
    expect(screen().getByRole("region", { name: "Sua conta inteira" })).toBeTruthy();
  });

  test("Sua conta's last card: one row each to reset, delete the workspace and delete the account", async () => {
    const { router } = await open(`/org/${ORG_ID}/settings/account`);
    const card = screen().getByRole("region", { name: "Recomeçar ou apagar" });
    const rows = Array.from(card.querySelectorAll<HTMLDetailsElement>("details.danger-row"));
    expect(rows.map((r) => r.querySelector("summary")?.textContent)).toEqual([
      "Recomeçar o workspaceApaga o que foi feito nele e começa de novo, com as mesmas pessoas.",
      "Apagar workspaceAcme fica só para leitura para todos agora. Ele é apagado de vez depois de 7 dias.",
      "Apagar contaApaga a sua conta em 7 dias, em todos os workspaces.",
    ]);
    // Closed until opened, and no "…" on a button, no link out of the card.
    expect(rows.map((r) => r.open)).toEqual([false, false, false]);
    expect(within(card).queryAllByRole("link")).toEqual([]);
    expect(Array.from(card.querySelectorAll(".ac-btn")).some((b) => b.textContent?.includes("…"))).toBe(false);
    await act(async () => {
      rows[1]?.setAttribute("open", "");
    });
    await click(within(rows[1] as HTMLElement).getByRole("button", { name: "Apagar workspace" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: /^Apagar Ac/ })).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/account`);
  });

  test("someone who can't delete the workspace gets the account's row alone, under its own name", async () => {
    await open(`/org/${ORG_ID}/settings/account`, { role: "member" });
    const card = screen().getByRole("region", { name: "Apagar conta" });
    expect(card.querySelectorAll(".danger-row").length).toBe(1);
    expect(Array.from(card.querySelectorAll(".ac-btn")).map((b) => b.textContent)).toEqual(["Apagar conta"]);
    expect(within(card).queryAllByRole("link")).toEqual([]);
  });

  test("resetting: what goes and stays on the row, then the name and its own code; the row says it started", async () => {
    const { state, services, router } = await open(`/org/${ORG_ID}/settings/account`);
    const card = screen().getByRole("region", { name: "Recomeçar ou apagar" });
    const row = card.querySelector<HTMLDetailsElement>("details.danger-row") as HTMLDetailsElement;
    await act(async () => {
      row.setAttribute("open", "");
    });
    expect(row.textContent).toContain(
      "Os agentes, as conversas, as DMs, os arquivos, as tarefas, as rotinas e a memória",
    );
    expect(row.textContent).toContain(
      "As pessoas, os cargos, os convites, as contas de IA, os computadores e os conectores",
    );
    expect(row.textContent).toContain("Acontece na hora e não tem volta.");
    await click(within(row).getByRole("button", { name: "Recomeçar workspace" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Recomeçar Acme?" });
    await type(within(dialog).getByLabelText("Digite Acme para confirmar"), "Acme");
    await click(within(dialog).getByRole("button", { name: "Enviar código" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "orgs.resetCode").map((c) => c.args)).toEqual([[ORG_ID]]);
    expect(state.calls.some((c) => c.method === "orgs.deletionCode")).toBe(false);
    const submit = within(dialog).getByRole("button", { name: "Recomeçar workspace" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Código do email"), "482913");
    expect(submit.hasAttribute("disabled")).toBe(false);
    await click(submit);
    await settle(6);
    expect(state.calls.find((c) => c.method === "orgs.reset")?.args).toEqual([ORG_ID, { code: "482913" }]);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(row.querySelector("summary")?.textContent).toContain("Recomeçando Acme…");
    expect(within(row).getByRole("button", { name: "Recomeçar workspace" }).hasAttribute("disabled")).toBe(true);
    // Done (`org.reset` reads `GET /me` again): its owner is on to the onboarding, without a click.
    const acme = state.me?.organizations.find((o) => o.id === ORG_ID);
    if (acme) acme.onboarding = { step: "context", generalChannelId: "c-general" };
    await act(async () => {
      await services.queryClient.invalidateQueries();
    });
    await settle(8);
    expect(router.state.location.pathname).toBe("/onboarding");
  });

  test("the longest workspace name the server takes: every row and the reset dialog keep it whole", async () => {
    const name = "Northwind Industries Holdings: Planejamento Estratégico e Operações Regionais (LATAM 2027)";
    await open(`/org/${ORG_ID}/settings/account`, { name });
    const card = screen().getByRole("region", { name: "Recomeçar ou apagar" });
    const rows = Array.from(card.querySelectorAll<HTMLDetailsElement>("details.danger-row"));
    await act(async () => {
      for (const row of rows) row.setAttribute("open", "");
    });
    expect(rows[1]?.querySelector("summary")?.textContent).toContain(name);
    await click(within(rows[0] as HTMLElement).getByRole("button", { name: "Recomeçar workspace" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: `Recomeçar ${name}?` });
    expect(within(dialog).getByLabelText(`Digite ${name} para confirmar`)).toBeTruthy();
  });

  test("two with the same name in the dialog: told apart in what it says and in its links", async () => {
    const made = (days: number) => new Date(Date.now() - days * DAY).toISOString();
    const state = seedState({
      deletionPlan: {
        closes: [],
        leaves: [
          { id: ORG_ID, name: "Acme", role: "owner" },
          { id: BETA_ID, name: "Acme", role: "owner" },
        ],
        soleOwner: [
          { id: ORG_ID, name: "Acme" },
          { id: BETA_ID, name: "Acme" },
        ],
        computers: [],
        staysBehind: [],
        serverOwner: false,
      },
    });
    await open(`/org/${ORG_ID}/issues?account=delete`, {
      state,
      createdAt: made(90),
      beta: { id: BETA_ID, name: "Acme", role: "owner", createdAt: made(30) },
    });
    const dialog = screen().getByRole("dialog", { name: "Apagar a sua conta inteira?" });
    const links = within(dialog)
      .getAllByRole("link", { name: /^Apagar Acme/ })
      .map((l) => l.textContent);
    expect(new Set(links).size).toBe(2);
    expect(links.every((l) => l?.includes("Criado em"))).toBe(true);
  });

  test("what closes, what you leave, what stays; the code from the email, then out to the sign-in", async () => {
    const state = seedState({
      deletionPlan: {
        closes: [
          { id: ORG_ID, name: "Acme", agents: 12, messages: 340 },
          { id: "00000000-0000-4000-8000-0000000000c3", name: "Rascunho", deletion: { dueAt: soon(3) } },
          { id: "00000000-0000-4000-8000-0000000000c4", name: "Vazio", agents: 0, messages: 0 },
        ],
        leaves: [{ id: BETA_ID, name: "Beta", role: "member" }],
        soleOwner: [],
        computers: [{ orgId: BETA_ID, id: "m1", name: "MacBook" }],
        staysBehind: [
          { orgId: BETA_ID, kind: "mailbox", name: "ana@beta.com" },
          { orgId: BETA_ID, kind: "key", name: "Chave da Ana" },
        ],
        serverOwner: false,
      },
    });
    state.authConfig = { ...state.authConfig, billingUrl: "https://billing.example.com" };
    // Kept in the address: a sign-in again comes back to it.
    const { router } = await open(`/org/${ORG_ID}/issues?account=delete`, { state });
    const dialog = screen().getByRole("dialog", { name: "Apagar a sua conta inteira?" });
    for (const line of [
      "Isto apaga a sua conta inteira, não só um workspace.",
      "Sua conta some de vez em",
      // What each one holds, so one with work in it can't be taken for an empty copy.
      "Acme fecha agora, com 12 agentes e 340 mensagens. Só você está lá, então ele é apagado de vez em",
      "Vazio fecha agora, sem agentes nem mensagens.",
      // Being deleted already, on its own date.
      "Rascunho já está sendo apagado. Ele some de vez em",
      "Você sai de Beta.",
      "Seu computador conectado a Beta sai de lá: MacBook.",
      "O que você adicionou em Beta continua lá. Desconecte antes o que for seu.",
      // Where plans are billed.
      "Os planos que você paga param de renovar. Nada é reembolsado.",
      "Suas mensagens ficam nos workspaces sem o seu nome.",
    ])
      expect(dialog.textContent).toContain(line);
    // Each thing that stays behind, to where it's disconnected.
    expect(within(dialog).getByRole("link", { name: "Desconectar ana@beta.com" }).getAttribute("href")).toBe(
      `/org/${BETA_ID}/settings/connectors`,
    );
    expect(within(dialog).getByRole("link", { name: "Desconectar Chave da Ana" }).getAttribute("href")).toBe(
      `/org/${BETA_ID}/settings/usage`,
    );
    // The way to delete just a workspace, for someone who only meant that.
    expect(dialog.textContent).toContain("Quer apagar só um workspace? A sua conta continua.");
    expect(within(dialog).getByRole("link", { name: "Apagar Acme" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/settings/general?delete=1`,
    );
    expect(within(dialog).queryByRole("button", { name: "Apagar conta" })).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Enviar código" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "account.deletionCode")).toHaveLength(1);
    const submit = within(dialog).getByRole("button", { name: "Apagar conta" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Código do email"), "482913");
    await click(submit);
    await settle(8);
    expect(state.calls.find((c) => c.method === "account.delete")?.args).toEqual([{ code: "482913" }]);
    expect(router.state.location.pathname).toBe("/login");
    expect(document.body.textContent).toContain("Entre antes disso para restaurar.");
  });
});

describe("an account waiting for its deletion", () => {
  const waiting = (dueAt: string | null) => {
    const state = seedState();
    if (!state.me) throw new Error("signed in");
    state.me.user.deletion = { dueAt, requestedAt: soon(-1) };
    state.me.organizations = [];
    return state;
  };
  /** The waiting screen is up. */
  const waits = () => screen().queryByRole("heading", { name: "Sua conta está sendo apagada" }) !== null;
  const toasts = () => [...document.querySelectorAll(".ac-toast")].map((t) => t.textContent);
  /** Signing out ends the session, as the server does: `GET /me` answers nobody after. */
  const endingSession = (state: ReturnType<typeof seedState>) =>
    createFakeAuth({ onSignOut: () => (state.me = null) }).auth;
  // Sair marks this browser as signed out by hand: the next app starts without it.
  afterEach(() => localStorage.removeItem("agentes.signedOut"));

  test("signing in shows one screen in place of the app: when it goes, Restaurar and Sair", async () => {
    const state = waiting(soon(6));
    const { router } = await renderApp("/", { api: createFakeApi(state) });
    await settle(8);
    expect(screen().getByRole("heading", { name: "Sua conta está sendo apagada" })).toBeTruthy();
    expect(screen().getByRole("button", { name: "Sair" })).toBeTruthy();
    // What happens until then is behind the ⓘ beside when it goes.
    expect(screen().getByRole("button", { name: "Sobre Sua conta está sendo apagada" })).toBeTruthy();
    expect(document.body.textContent).toContain("Até lá ninguém fala com você aqui");
    const restore = screen().getByRole("button", { name: "Restaurar conta" });
    await click(restore);
    await settle(8);
    expect(state.calls.some((c) => c.method === "account.restore")).toBe(true);
    expect(screen().queryByRole("heading", { name: "Sua conta está sendo apagada" })).toBeNull();
    expect(router.state.location.pathname).not.toBe("/login");
  });

  test("past its date there is nothing to press but Sair", async () => {
    await renderApp("/", { api: createFakeApi(waiting(null)) });
    await settle(8);
    expect(screen().getByRole("heading", { name: "Sua conta está sendo apagada" })).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Restaurar conta" })).toBeNull();
    expect(screen().getByRole("button", { name: "Sair" })).toBeTruthy();
  });

  // The cache is cleared at every sign-in, sign-out and ended session, which tells nobody who reads `me`.
  test("the screen follows the account in the cache: cleared, it goes, with no page change", async () => {
    const state = waiting(soon(6));
    const { router, services } = await renderApp("/", { api: createFakeApi(state) });
    await settle(8);
    expect(waits()).toBe(true);
    const path = router.state.location.pathname;
    // Restored from another device meanwhile.
    if (state.me) {
      const { deletion: _gone, ...user } = state.me.user;
      state.me = { ...state.me, user };
    }
    await act(async () => services.queryClient.clear());
    await settle(8);
    expect(waits()).toBe(false);
    expect(router.state.location.pathname).toBe(path);
  });

  test("Sair, from a page outside any workspace, ends on the sign-in with the screen gone", async () => {
    const state = waiting(soon(6));
    const { router } = await renderApp("/", { api: createFakeApi(state), auth: endingSession(state) });
    await settle(8);
    expect(router.state.location.pathname).toBe("/onboarding");
    await click(screen().getByRole("button", { name: "Sair" }));
    await settle(8);
    expect(router.state.location.pathname).toBe("/login");
    expect(waits()).toBe(false);
    expect(screen().getByLabelText("E-mail")).toBeTruthy();
    // By hand: the desktop app's own server waits for its owner's click.
    expect(localStorage.getItem("agentes.signedOut")).toBe("1");
  });

  test("an auth client whose sign-out fails leaves all the same", async () => {
    const state = waiting(soon(6));
    const { auth } = createFakeAuth();
    auth.signOut = async () => {
      state.me = null;
      throw new TypeError("Load failed");
    };
    const { router } = await renderApp("/", { api: createFakeApi(state), auth });
    await settle(8);
    await click(screen().getByRole("button", { name: "Sair" }));
    await settle(8);
    expect(router.state.location.pathname).toBe("/login");
    expect(waits()).toBe(false);
    expect(screen().getByLabelText("E-mail")).toBeTruthy();
  });

  test("while Sair runs it shows as working, and neither button can be pressed", async () => {
    const state = waiting(soon(6));
    const { auth } = createFakeAuth();
    let answer = () => {};
    auth.signOut = () =>
      new Promise<void>((done) => {
        answer = done;
      });
    await renderApp("/", { api: createFakeApi(state), auth });
    await settle(8);
    const out = screen().getByRole("button", { name: "Sair" });
    await click(out);
    expect(out.getAttribute("aria-busy")).toBe("true");
    expect(out.hasAttribute("disabled")).toBe(true);
    expect(screen().getByRole("button", { name: "Restaurar conta" }).hasAttribute("disabled")).toBe(true);
    state.me = null;
    await act(async () => answer());
    await settle(8);
    expect(waits()).toBe(false);
  });

  // Deleting the account ended its sessions: the screen can be up after the one it was drawn with.
  test("Restaurar after the session ended goes to the sign-in and says why once, in the app's words", async () => {
    const state = waiting(soon(6));
    const { router } = await renderApp("/", { api: createFakeApi(state) });
    await settle(8);
    state.me = null;
    await click(screen().getByRole("button", { name: "Restaurar conta" }));
    await settle(8);
    expect(state.calls.some((c) => c.method === "account.restore")).toBe(true);
    expect(router.state.location.pathname).toBe("/login");
    expect(waits()).toBe(false);
    expect(screen().getByLabelText("E-mail")).toBeTruthy();
    expect(toasts()).toEqual(["Sua sessão terminou. Entre de novo para continuar."]);
    // The sign-in leads back to where the screen was.
    expect(router.state.location.search).toEqual({ redirect: "/onboarding" });
    // Nobody signed out by hand.
    expect(localStorage.getItem("agentes.signedOut")).toBeNull();
  });

  // Adding an account beside one that waits: the app's own answer to an ended session does nothing at this address.
  test("Restaurar after the session ended, at the sign-in's address: the sign-in shows, with the same words once", async () => {
    const state = waiting(soon(6));
    const { router } = await renderApp("/login?add=1", { api: createFakeApi(state) });
    await settle(8);
    expect(waits()).toBe(true);
    state.me = null;
    await click(screen().getByRole("button", { name: "Restaurar conta" }));
    await settle(8);
    expect(router.state.location.pathname).toBe("/login");
    expect(waits()).toBe(false);
    expect(screen().getByLabelText("E-mail")).toBeTruthy();
    expect(toasts()).toEqual(["Sua sessão terminou. Entre de novo para continuar."]);
  });

  test("a restore the server refuses for no session leaves nobody signed in, for every screen that reads it", async () => {
    const state = waiting(soon(6));
    function Probe() {
      const restore = useRestoreAccount();
      return (
        <button type="button" onClick={() => restore.mutate()}>
          {useMe().data ? "signed in" : "nobody"}
        </button>
      );
    }
    const { services } = await renderPage(<Probe />, { api: createFakeApi(state) });
    await settle(4);
    const probe = screen().getByRole("button", { name: "signed in" });
    state.me = null;
    await click(probe);
    await settle(4);
    expect(services.queryClient.getQueryData(keys.me)).toBeNull();
    expect(probe.textContent).toBe("nobody");
  });

  test("signing in on the sign-in page as an account that waits shows the screen, not the onboarding", async () => {
    const state = seedState({ me: null });
    const { auth } = createFakeAuth({ onSignIn: () => (state.me = waiting(soon(6)).me) });
    const api = createFakeApi(state);
    api.account.signInOptions = async () => ({ account: true, password: true, providers: [], canSignUp: false });
    const { router } = await renderApp("/login", { api, auth });
    await type(screen().getByLabelText("E-mail"), "ana@example.com");
    await click(screen().getByRole("button", { name: /^Continuar(?! com)/ }));
    await settle(4);
    await type(screen().getByLabelText("Senha"), "correct horse");
    await click(screen().getByRole("button", { name: /^Entrar/ }));
    await settle(8);
    expect(router.state.location.pathname).toBe("/onboarding");
    expect(waits()).toBe(true);
  });
});

describe("an invitation into a workspace being deleted", () => {
  test("reads as closed, as its links do: nobody to join, no form to sign up", async () => {
    const state = seedState({
      previews: {
        tok: { orgName: "Acme", email: "", role: "member", kind: "email", invitedBy: null, agents: [], closed: true },
      },
    });
    state.me = null;
    await renderApp("/invite/tok", { api: createFakeApi(state) });
    await settle(6);
    expect(screen().getByRole("heading", { level: 1 }).textContent).toBe("Este link não funciona mais");
    expect(document.body.textContent).toContain("Peça um novo a quem mandou.");
    expect(screen().queryByLabelText("Seu nome")).toBeNull();
  });
});

describe("the desktop app's owner on its own server: a sign-in again on this Mac, no password", () => {
  const win = () => window as { __agentesDesktop?: unknown; __TAURI_INTERNALS__?: unknown };
  afterEach(() => {
    delete win().__agentesDesktop;
    delete win().__TAURI_INTERNALS__;
    sessionStorage.clear();
  });
  /**
   * The app around the site: records each request; `signIn` answers the app's sign-in; `local`: this server runs in
   * this app.
   */
  function inTheApp(signIn: () => Promise<unknown> = () => new Promise(() => {}), local = true) {
    const asked: Record<string, unknown>[] = [];
    win().__agentesDesktop = { version: "0.6.0" };
    win().__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: { request: Record<string, unknown> }) => {
        if (cmd !== "this_mac") return {};
        asked.push(args.request);
        if (args.request.kind === "signIn") return signIn();
        if (args.request.kind === "status") return { orgs: [], local };
        return {};
      },
    };
    return asked;
  }
  const ownerHere = (over: Parameters<typeof seedState>[0] = {}) => {
    const state = seedState({ authConfig: { passwordReset: false }, ...over });
    if (!state.me) throw new Error("signed in");
    state.me.user = { ...state.me.user, hasPassword: false, confirmsOnThisMac: true };
    return state;
  };
  const signedInMinutesAgo = (minutes: number) =>
    sessionStorage.setItem("agentes.thisMac.signedInAt", String(Date.now() - minutes * 60_000));

  test("signed in through the app just now: the name typed, then it deletes with nothing else", async () => {
    inTheApp();
    signedInMinutesAgo(1);
    const { state } = await open(`/org/${ORG_ID}/settings/general?delete=1`, { state: ownerHere() });
    const dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    expect(dialog.textContent).not.toContain("Adicione uma senha");
    expect(within(dialog).queryByLabelText("Sua senha")).toBeNull();
    const submit = within(dialog).getByRole("button", { name: "Apagar workspace" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Digite Acme para confirmar"), "Acme");
    await click(submit);
    await settle(6);
    expect(state.calls.find((c) => c.method === "orgs.deleteWorkspace")?.args).toEqual([ORG_ID, {}]);
  });

  test("an older sign-in: Entrar de novo, which keeps the dialog's place and stays pressed while the app works", async () => {
    const asked = inTheApp();
    signedInMinutesAgo(12);
    const { state } = await open(`/org/${ORG_ID}/settings/general?delete=1`, { state: ownerHere() });
    const dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    expect(dialog.textContent).toContain("Entre de novo para confirmar que é você.");
    expect(within(dialog).queryByRole("button", { name: "Apagar workspace" })).toBeNull();
    const again = within(dialog).getByRole("button", { name: "Entrar de novo" });
    await click(again);
    await settle(2);
    expect(asked).toContainEqual({ kind: "signIn" });
    expect(JSON.parse(sessionStorage.getItem("agentes.thisMac.return") ?? "{}").to).toBe(
      `/org/${ORG_ID}/settings/general?delete=1`,
    );
    expect(
      within(dialog)
        .getByRole("button", { name: /Entrar de novo/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(within(dialog).getByLabelText("Digite Acme para confirmar").closest("fieldset")?.disabled).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Cancelar" }).hasAttribute("disabled")).toBe(true);
    expect(state.calls.some((c) => c.method === "orgs.deleteWorkspace")).toBe(false);
  });

  test("a dialog closed after Entrar de novo does not open again once the app signs the window in", async () => {
    inTheApp();
    const { router } = await open(`/org/${ORG_ID}/settings/general?delete=1`, { state: ownerHere() });
    await settle(4);
    await click(
      within(screen().getByRole("dialog", { name: "Apagar Acme?" })).getByRole("button", { name: "Entrar de novo" }),
    );
    await settle(2);
    expect(sessionStorage.getItem("agentes.thisMac.return")).not.toBeNull();
    // The address moves on (Back): the dialog closes with it.
    await act(() =>
      router.navigate({ to: "/org/$orgId/settings/$section", params: { orgId: ORG_ID, section: "general" } }),
    );
    await settle(6);
    expect(screen().queryByRole("dialog", { name: "Apagar Acme?" })).toBeNull();
    expect(sessionStorage.getItem("agentes.thisMac.return")).toBeNull();
  });

  test("the app refuses to sign in: the dialog says so and the button works again", async () => {
    inTheApp(async () => {
      throw new Error("too_soon");
    });
    await open(`/org/${ORG_ID}/settings/general?delete=1`, { state: ownerHere() });
    const dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    await click(within(dialog).getByRole("button", { name: "Entrar de novo" }));
    await settle(4);
    expect(dialog.textContent).toContain("Algo deu errado. Tente de novo.");
    expect(within(dialog).getByRole("button", { name: "Entrar de novo" }).hasAttribute("disabled")).toBe(false);
    expect(sessionStorage.getItem("agentes.thisMac.return")).toBeNull();
  });

  test("the server finds the sign-in too old after all: it asks for another, in place of the button", async () => {
    inTheApp();
    signedInMinutesAgo(1);
    const state = ownerHere({
      deletionError: new ApiError(403, "reauth.sign_in", "Sign in again to confirm it's you"),
    });
    await open(`/org/${ORG_ID}/settings/general?delete=1`, { state });
    const dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    await type(within(dialog).getByLabelText("Digite Acme para confirmar"), "Acme");
    await click(within(dialog).getByRole("button", { name: "Apagar workspace" }));
    await settle(6);
    expect(dialog.textContent).toContain("Entre de novo para confirmar que é você.");
    expect(within(dialog).getByRole("button", { name: "Entrar de novo" })).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(sessionStorage.getItem("agentes.thisMac.signedInAt")).toBeNull();
  });

  test("on that server from another computer's app: their password, as before, since only its own app signs them in", async () => {
    const asked = inTheApp(undefined, false);
    const state = ownerHere();
    if (state.me) state.me.user = { ...state.me.user, hasPassword: true };
    await open(`/org/${ORG_ID}/settings/general?delete=1`, { state });
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    expect(asked).toContainEqual({ kind: "status" });
    expect(within(dialog).getByLabelText("Sua senha")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Entrar de novo" })).toBeNull();
  });

  test("the same owner in a browser adds a password first, as before", async () => {
    await open(`/org/${ORG_ID}/settings/general?delete=1`, { state: ownerHere() });
    const dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    expect(dialog.textContent).toContain("Adicione uma senha para confirmar que é você.");
  });

  test("deleting the account the same way, from Sua conta's second button too", async () => {
    inTheApp();
    signedInMinutesAgo(1);
    const state = ownerHere();
    await open(`/org/${ORG_ID}/issues?account=delete`, { state, beta: null });
    const dialog = screen().getByRole("dialog", { name: "Apagar a sua conta inteira?" });
    const submit = within(dialog).getByRole("button", { name: "Apagar conta" });
    expect(submit.hasAttribute("disabled")).toBe(false);
    await click(submit);
    await settle(8);
    expect(state.calls.find((c) => c.method === "account.delete")?.args).toEqual([{}]);

    // Sua conta's own button for the workspace is kept in the address, so a sign-in again comes back to it.
    cleanup();
    inTheApp();
    const { router } = await open(`/org/${ORG_ID}/settings/account`, { state: ownerHere() });
    await click(screen().getByRole("button", { name: "Apagar workspace" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Apagar Acme?" })).toBeTruthy();
    expect(router.state.location.search).toMatchObject({ delete: 1 });
  });
});
