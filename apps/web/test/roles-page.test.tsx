import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Agent, Channel, OrgRole } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ADA_ID,
  ATLAS_ID,
  createFakeApi,
  ENG_ID,
  type FakeState,
  GENERAL_ID,
  ORG_ID,
  seedRoles,
  seedState,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const last = (state: FakeState, method: string) => state.calls.findLast((c) => c.method === method)?.args;
/** The permissions the last call to `method` sent: the test fails here if none was made. */
const sentPermissions = (state: FakeState, method: string) => {
  const args = last(state, method);
  if (!args) throw new Error(`no ${method} call`);
  return (args[2] as { permissions: string[] }).permissions;
};
const pick = async (combobox: HTMLElement, option: string | RegExp) => {
  combobox.focus();
  await act(async () => fireEvent.keyDown(combobox, { key: "Enter" }));
  await click(screen().getByRole("option", { name: option }));
};

const SUPORTE = "role-support";
const FIN = "role-fin";

/**
 * Acme with Admin, Suporte (approves actions, invites people) and Financeiro (sees costs), Todos as a new workspace's;
 * João holds Admin, Carla and Diego Suporte, Fabio Financeiro. Private #suporte is limited to Suporte, #diretoria is
 * invite only; Atlas answers only João.
 */
function acme(extra: (state: FakeState) => void = () => {}) {
  const state = seedState();
  const [admin, everyone] = seedRoles() as [OrgRole, OrgRole];
  const custom = { ...admin, hoist: false };
  state.roles = [
    admin,
    {
      ...custom,
      id: SUPORTE,
      name: "Suporte",
      icon: "message",
      color: "teal",
      position: 1,
      permissions: ["approve_actions", "invite_people"],
    },
    {
      ...custom,
      id: FIN,
      name: "Financeiro",
      icon: "wallet",
      color: "amber",
      position: 2,
      permissions: ["view_usage"],
    },
    { ...everyone, position: 3 },
  ];
  const person = (userId: string, name: string, roleIds: string[]) => ({
    userId,
    name,
    email: `${name.toLowerCase()}@example.com`,
    image: null,
    role: "member" as const,
    roleIds,
    joinedAt: "2026-11-01T12:00:00.000Z",
    handle: name.toLowerCase(),
    timezone: "America/Sao_Paulo",
  });
  state.members.push(
    person("u-carla", "Carla", [SUPORTE]),
    person("u-diego", "Diego", [SUPORTE]),
    person("u-fabio", "Fabio", [FIN]),
  );
  const channel = (id: string, name: string, more: Partial<Channel>): Channel => ({
    id,
    name,
    topic: "",
    visibility: "private",
    isMember: true,
    createdAt: "2026-11-01T12:00:00.000Z",
    ...more,
  });
  state.channels.push(
    channel("chan-suporte", "suporte", { audienceRoleIds: [SUPORTE] }),
    channel("chan-diretoria", "diretoria", {}),
  );
  state.channelMembers["chan-suporte"] = [
    { type: "person", id: "u-walter" },
    { type: "person", id: "u-carla" },
    { type: "person", id: "u-diego" },
  ];
  state.channelMembers["chan-diretoria"] = [{ type: "person", id: "u-walter" }];
  const atlas = state.agents.find((a) => a.id === ATLAS_ID) as Agent;
  atlas.audience = { mode: "owner", userIds: [], roleIds: [] };
  extra(state);
  return state;
}

async function open(path: string, state = acme()) {
  const api = createFakeApi(state);
  await renderApp(`/org/${ORG_ID}/settings/${path}`, { api });
  await settle(8);
  return state;
}

const row = (name: string) =>
  [...document.querySelectorAll<HTMLElement>(".roles-row")].find(
    (r) => r.querySelector(".roles-row__name")?.textContent === name,
  ) as HTMLElement;
const names = () => [...document.querySelectorAll(".roles-row__name")].map((n) => n.textContent);
const grip = (name: string) => row(name).querySelector<HTMLButtonElement>(".roles-row__grip") as HTMLButtonElement;
const reach = (name: string) => [...row(name).querySelectorAll(".roles-reach__item")].map((i) => i.textContent?.trim());
const permRow = (title: string) =>
  [...document.querySelectorAll<HTMLElement>(".roles-perm")].find(
    (r) => r.querySelector(".settings-row__label")?.textContent === title,
  ) as HTMLElement;

/**
 * The worst realistic data, first in this file so CI's geometry check measures these screens (it keeps the first of
 * each shape): 40-letter cargo names next to a two-letter one, a dozen cargos (the searches show), a channel limited
 * to five cargos, an agent with a long função answering three cargos and two people, people with long names and
 * addresses, and a mailbox question with a long address.
 */
const LONG = "Coordenação Regional de Suporte Técnico";
const ALEKSANDRA = "Aleksandra Wiśniewska-Kowalczyk";
function worst(state: FakeState) {
  const [admin, everyone] = seedRoles() as [OrgRole, OrgRole];
  const names = [LONG, "Jo", "Financeiro e Controladoria Corporativa", "Vendas", "Marketing de Produto", "Jurídico"];
  const extra = Array.from({ length: 10 }, (_, i) => ({
    ...admin,
    id: `role-w${i}`,
    name: names[i] ?? `Equipe de Operações Logísticas ${i}`,
    icon: ["message", "wallet", "chart", "flag", "book", "globe", "code", "bolt", "eye", "plug"][i] ?? "shield",
    color: ["teal", "amber", "rose", "green", "violet", "indigo", "graphite"][i % 7] ?? "teal",
    permissions: i === 0 ? ["approve_actions", "invite_people", "view_usage", "manage_routines", "review_memory"] : [],
    position: 1 + i,
    hoist: false,
  }));
  state.roles = [admin, ...extra, { ...everyone, position: 20 }];
  const person = (userId: string, name: string, email: string, roleIds: string[]) => ({
    userId,
    name,
    email,
    image: null,
    role: "member" as const,
    roleIds,
    joinedAt: "2026-11-01T12:00:00.000Z",
    handle: userId,
    timezone: "Europe/Warsaw",
  });
  state.members.push(
    person("u-ola", ALEKSANDRA, "aleksandra.wisniewska-kowalczyk@northwind-industries-holdings.example.com", [
      "role-w0",
    ]),
    person("u-jo", "Jo", "jo@example.com", ["role-w0", "role-w1"]),
    person("u-bart", "Bartholomew Fitzgerald", "bartholomew.fitzgerald@northwind-industries-holdings.example.com", [
      "role-w0",
    ]),
    ...Array.from({ length: 9 }, (_, i) =>
      person(`u-p${i}`, `Pessoa de Atendimento ${i + 1}`, `atendimento${i + 1}@example.com`, i < 6 ? ["role-w0"] : []),
    ),
  );
  state.channels.push({
    id: "chan-long",
    name: "atendimento-clientes-corporativos-regiao-sudeste",
    topic: "",
    visibility: "private",
    audienceRoleIds: ["role-w0", "role-w1", "role-w2", "role-w3", "role-w4"],
    isMember: true,
    createdAt: "2026-11-01T12:00:00.000Z",
  });
  state.channelMembers["chan-long"] = [
    { type: "person", id: "u-walter" },
    { type: "person", id: "u-ola" },
    { type: "person", id: "u-jo" },
  ];
  const ada = state.agents.find((a) => a.id === ADA_ID) as Agent;
  ada.name = "Bartholomew";
  ada.role = "Especialista em atendimento ao cliente corporativo";
  ada.audience = { mode: "people", userIds: ["u-ola", "u-bart"], roleIds: ["role-w0", "role-w1", "role-w2"] };
  state.roleMailLoss = {
    "role-w0": [
      {
        agentId: ADA_ID,
        agentName: "Bartholomew",
        accountId: "acc-long",
        address: "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
        ownerUserId: "u-bart",
        ownerName: "Bartholomew Fitzgerald",
      },
    ],
  };
  return state;
}

describe("the worst case, as the geometry check measures it", () => {
  test("the list: a dozen cargos, a 40-letter name beside a two-letter one, 15 people", async () => {
    await open("roles", worst(seedState()));
    expect(screen().getByRole("searchbox", { name: "Buscar cargo" })).toBeTruthy();
    expect(row(LONG).querySelector(".roles-row__name")?.textContent).toBe(LONG);
    expect(row("Jo")).toBeTruthy();
  });

  test("a long cargo's page, each tab, and its dialogs", async () => {
    await open("roles/role-w0", worst(seedState()));
    expect(screen().getByRole("heading", { level: 2, name: LONG })).toBeTruthy();
    // Quem pode with a dozen cargos: the checklist gets its search.
    await click(within(permRow("Criar canais")).getByRole("switch"));
    const who = screen().getByRole("dialog", { name: "Quem pode criar canais" });
    expect(within(who).getByRole("searchbox", { name: "Buscar cargo" })).toBeTruthy();
    await click(within(who).getByRole("button", { name: "Cancelar" }));
    await settle(4);
    await click(screen().getByRole("button", { name: "Mudar nome, cor e ícone" }));
    const look = screen().getByRole("dialog", { name: "Nome, cor e ícone" });
    expect(look.querySelector(".roles-preview__name")?.textContent).toBe(ALEKSANDRA);
    await click(within(look).getByRole("button", { name: "Cancelar" }));
    await settle(4);
    // Apagar: who leaves, with the longest cargo and person, on as many lines as it takes.
    await act(async () =>
      fireEvent.pointerDown(screen().getByRole("button", { name: "Mais opções" }), { button: 0, ctrlKey: false }),
    );
    await settle(2);
    await click(screen().getByRole("menuitem", { name: "Apagar cargo" }));
    const remove = screen().getByRole("dialog", { name: `Apagar ${LONG}?` });
    await settle(4);
    expect(remove.querySelector(".roles-line")?.textContent).toBe(
      `Saem de canais que viam só por ${LONG}: ${ALEKSANDRA}.`,
    );
    await click(within(remove).getByRole("button", { name: "Cancelar" }));
    await settle(4);
  });

  test("its channels, agents and people with the longest names", async () => {
    const state = worst(seedState());
    await open("roles/role-w0?tab=channels", state);
    expect(
      screen()
        .getByRole("checkbox", { name: /#atendimento-clientes-corporativos-regiao-sudeste$/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    cleanup();
    await open("roles/role-w0?tab=agents", worst(seedState()));
    expect(
      screen()
        .getByRole("checkbox", { name: /^Bartholomew/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    cleanup();
    await open("roles/role-w0?tab=people", worst(seedState()));
    expect(screen().getByRole("searchbox", { name: "Procurar pessoa" })).toBeTruthy();
    await click(screen().getAllByRole("button", { name: "Adicionar pessoas" })[0] as HTMLElement);
    const add = screen().getByRole("dialog", { name: /^Adicionar a / });
    await click(within(add).getByRole("checkbox", { name: /^Pessoa de Atendimento 7/ }));
    await click(within(add).getByRole("button", { name: "Adicionar 1" }));
    await settle(4);
    expect(
      screen().getByRole("dialog", { name: "Bartholomew perde a caixa de e-mail de Bartholomew Fitzgerald" }),
    ).toBeTruthy();
  });

  test("Dono's page: two owners, one with the longest name and address, each with Tirar", async () => {
    const state = worst(seedState());
    const ola = state.members.find((m) => m.userId === "u-ola");
    if (ola) ola.role = "owner";
    await open("roles/owner", state);
    expect(screen().getByRole("heading", { level: 2, name: "Dono" })).toBeTruthy();
    expect(screen().getByRole("button", { name: `Tirar ${ALEKSANDRA} de Dono` })).toBeTruthy();
    expect(
      screen().getByText("aleksandra.wisniewska-kowalczyk@northwind-industries-holdings.example.com"),
    ).toBeTruthy();
  });

  test("no cargo yet: an inline row, no dashed box", async () => {
    const state = seedState();
    const [, everyone] = seedRoles() as [OrgRole, OrgRole];
    state.roles = [{ ...everyone, position: 0 }];
    await open("roles", state);
    expect(screen().getByText("Nenhum cargo ainda. Crie um para dar mais a algumas pessoas.")).toBeTruthy();
  });
});

describe("Settings › Cargos, the list (W1)", () => {
  test("its own entry: Todos pinned under Base, then Dono and the cargos, each saying what it adds", async () => {
    await open("roles");
    const nav = screen().getByRole("navigation", { name: "Seções das configurações" });
    expect(within(nav).getByRole("link", { name: "Cargos" }).getAttribute("aria-current")).toBe("page");
    expect(screen().queryByRole("tab", { name: "Cargos" })).toBeNull();
    expect(screen().getByRole("heading", { level: 2, name: "Cargos" })).toBeTruthy();
    expect([...document.querySelectorAll(".roles-row__name")].map((n) => n.textContent)).toEqual([
      "Todos",
      "Dono",
      "Admin",
      "Suporte",
      "Financeiro",
    ]);
    // Todos says what everyone has; a cargo what it adds, its channels and agents counted.
    expect(reach("Todos")).toEqual(["8 permissões", "2 canais", "1 agente"]);
    expect(reach("Dono")).toEqual(["Pode tudo, sempre"]);
    expect(reach("Admin")).toEqual(["Pode tudo"]);
    expect(reach("Suporte")).toEqual(["+2 permissões", "+1 canal"]);
    expect(reach("Financeiro")).toEqual(["+1 permissão"]);
    // The mark is 18 on the name's line, the owner's row has no grip.
    expect(row("Suporte").querySelector(".ac-rolemark")?.getAttribute("style")).toContain("width: 18px");
    expect(row("Dono").querySelector(".roles-row__grip")).toBeNull();
    expect(row("Suporte").querySelector(".roles-row__grip")).toBeTruthy();
  });

  test("a grip's menu moves a cargo, never above one the viewer can't change", async () => {
    const state = await open("roles");
    expect(grip("Financeiro").getAttribute("aria-label")).toBe("Mover Financeiro");
    await click(grip("Financeiro"));
    const up = screen().getByRole("menuitem", { name: "Mover para cima" });
    await click(up);
    expect(last(state, "roles.reorder")?.[1]).toEqual(["role-admin", FIN, SUPORTE]);
    await settle(4);
    expect(names()).toEqual(["Todos", "Dono", "Admin", "Financeiro", "Suporte"]);
  });

  test("where nothing drags, each cargo's ⋯ at its row's end holds the grip's menu; Todos and Dono keep its room", async () => {
    const state = await open("roles");
    for (const name of ["Todos", "Dono"])
      expect(row(name).querySelector(".roles-row__more")?.childElementCount).toBe(0);
    const more = row("Financeiro").querySelector<HTMLElement>(".roles-row__more > button") as HTMLElement;
    expect([more.getAttribute("aria-label"), more.getAttribute("aria-haspopup")]).toEqual(["Mover Financeiro", "menu"]);
    await click(more);
    expect(
      (screen().getByRole("menuitem", { name: "Mover para baixo" }) as HTMLElement).getAttribute("aria-disabled"),
    ).toBe("true");
    await click(screen().getByRole("menuitem", { name: "Mover para cima" }));
    expect(last(state, "roles.reorder")?.[1]).toEqual(["role-admin", FIN, SUPORTE]);
  });

  test("by the keys: Space lifts, an arrow moves, Space drops and saves once", async () => {
    const state = await open("roles");
    const g = grip("Financeiro");
    g.focus();
    await act(async () => fireEvent.keyDown(g, { key: " " }));
    expect(g.getAttribute("aria-pressed")).toBe("true");
    await act(async () => fireEvent.keyDown(g, { key: "ArrowUp" }));
    expect(state.calls.some((c) => c.method === "roles.reorder")).toBe(false);
    await act(async () => fireEvent.keyDown(g, { key: " " }));
    await settle(4);
    expect(last(state, "roles.reorder")?.[1]).toEqual(["role-admin", FIN, SUPORTE]);
  });

  test("by the keys, down: the grip keeps the focus, and the new order stays on screen while it saves", async () => {
    const state = await open("roles");
    const g = grip("Suporte");
    g.focus();
    await act(async () => fireEvent.keyDown(g, { key: " " }));
    // Going down moves this row's own node; React's commit puts the focus back on the grip, so the keys still reach it.
    await act(async () => fireEvent.keyDown(g, { key: "ArrowDown" }));
    expect(document.activeElement).toBe(g);
    expect(names()).toEqual(["Todos", "Dono", "Admin", "Financeiro", "Suporte"]);
    expect(g.getAttribute("aria-pressed")).toBe("true");
    // Space drops it: before the save lands, the rows keep the new order, never the old one for a moment.
    fireEvent.keyDown(g, { key: " " });
    expect(names()).toEqual(["Todos", "Dono", "Admin", "Financeiro", "Suporte"]);
    expect(g.getAttribute("aria-pressed")).toBe("false");
    await settle(4);
    expect(last(state, "roles.reorder")?.[1]).toEqual(["role-admin", FIN, SUPORTE]);
    expect(names()).toEqual(["Todos", "Dono", "Admin", "Financeiro", "Suporte"]);
  });

  test("⌘K's Criar cargo opens its dialog on this list too, and again once it closed", async () => {
    await open("roles");
    for (let i = 0; i < 2; i++) {
      await act(async () => fireEvent.keyDown(window, { key: "k", metaKey: true }));
      const palette = screen().getByRole("combobox", { name: "Ir para, ou pedir a um agente" });
      await act(async () => fireEvent.change(palette, { target: { value: "criar cargo" } }));
      const first = within(screen().getByRole("listbox", { name: "Resultados" })).getAllByRole("option")[0];
      expect(first?.textContent).toContain("Criar cargo");
      await act(async () => fireEvent.keyDown(palette, { key: "Enter" }));
      await settle(4);
      const dialog = screen().getByRole("dialog", { name: "Criar cargo" });
      await click(within(dialog).getByRole("button", { name: "Cancelar" }));
      await settle(4);
      expect(screen().queryByRole("dialog", { name: "Criar cargo" })).toBeNull();
    }
  });

  test("past 8 cargos a search; at 100 Criar cargo waits, saying why", async () => {
    const many = acme((s) => {
      const [admin] = seedRoles() as [OrgRole];
      const extra = Array.from({ length: 98 }, (_, i) => ({
        ...admin,
        id: `role-x${i}`,
        name: `Equipe ${i}`,
        permissions: [],
        position: 3 + i,
      }));
      s.roles = [...(s.roles ?? []).slice(0, 3), ...extra, { ...(s.roles?.at(-1) as OrgRole), position: 200 }];
    });
    await open("roles", many);
    const create = screen().getByRole("button", { name: "Criar cargo" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    const search = screen().getByRole("searchbox", { name: "Buscar cargo" });
    await act(async () => fireEvent.change(search, { target: { value: "financ" } }));
    expect([...document.querySelectorAll(".roles-row__name")].map((n) => n.textContent)).toEqual(["Financeiro"]);
    await act(async () => fireEvent.change(search, { target: { value: "zzz" } }));
    expect(screen().getByText("Nenhum cargo com “zzz”.")).toBeTruthy();
  });
});

describe("a cargo's page (W2, W3, W4)", () => {
  test("its head and tabs; a row everyone has carries the Todos chip and stays live", async () => {
    await open(`roles/${SUPORTE}`);
    expect(
      screen().getByRole("heading", { level: 2, name: "Suporte" }).querySelector("button[aria-haspopup]"),
    ).toBeTruthy();
    expect([...document.querySelectorAll(".roles-glance .roles-reach__item")].map((i) => i.textContent)).toEqual([
      "2 pessoas",
      "+2 permissões",
      "+1 canal",
    ]);
    expect(
      screen()
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Permissões", "Canais", "Agentes", "Pessoas 2"]);
    const create = permRow("Criar canais");
    expect(within(create).getByRole("button", { name: "Todos" })).toBeTruthy();
    const toggle = within(create).getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    expect(screen().queryByText("Vem de Todos")).toBeNull();
  });

  test("turning off what everyone has asks who may: Todos and the cargos at once, naming who loses it", async () => {
    const state = await open(`roles/${SUPORTE}`);
    await click(within(permRow("Criar canais")).getByRole("switch"));
    const dialog = screen().getByRole("dialog", { name: "Quem pode criar canais" });
    expect(
      within(dialog)
        .getByRole("radio", { name: /Só alguns cargos/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    const box = (name: string) => within(dialog).getByRole("checkbox", { name: new RegExp(`^${name}`) });
    // Administrador may everything: ticked and fixed. This cargo starts unticked, the others ticked.
    expect([box("Admin").getAttribute("aria-checked"), (box("Admin") as HTMLButtonElement).disabled]).toEqual([
      "true",
      true,
    ]);
    expect(box("Suporte").getAttribute("aria-checked")).toBe("false");
    expect(box("Financeiro").getAttribute("aria-checked")).toBe("true");
    expect(dialog.textContent).toContain("Donos sempre podem.");
    expect(dialog.querySelector(".roles-line--live")?.textContent).toBe("Deixam de poder: Carla e Diego.");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    expect(last(state, "roles.setRow")?.slice(1)).toEqual([
      "create_channels",
      {
        everyone: 0,
        roles: [
          { id: SUPORTE, level: 0 },
          { id: FIN, level: 1 },
        ],
      },
    ]);
  });

  test("a key of its own saves at once, the cargo's whole list", async () => {
    const state = await open(`roles/${SUPORTE}`);
    await click(within(permRow("Ver a auditoria")).getByRole("switch"));
    const saved = last(state, "roles.update");
    expect(saved?.[1]).toBe(SUPORTE);
    expect(sentPermissions(state, "roles.update").sort()).toEqual(
      ["approve_actions", "invite_people", "view_audit"].sort(),
    );
  });

  test("the computers are one choice of five steps; below Todos' it asks who keeps it", async () => {
    const state = await open(`roles/${SUPORTE}`);
    const steps = within(permRow("Computadores dos agentes")).getByRole("combobox");
    expect(steps.textContent).toContain("Computador dos próprios agentes");
    steps.focus();
    await act(async () => fireEvent.keyDown(steps, { key: "Enter" }));
    // Two groups, Próprios agentes and Qualquer agente: Navegador and Computador in each.
    const computers = screen().getAllByRole("option", { name: "Computador" });
    expect(computers).toHaveLength(2);
    await click(computers[1] as HTMLElement);
    expect(sentPermissions(state, "roles.update")).toContain("control_computers");
    cleanup();
    const again = await open(`roles/${SUPORTE}`);
    await pick(within(permRow("Computadores dos agentes")).getByRole("combobox"), "Não usa");
    const dialog = screen().getByRole("dialog", { name: "Quem fica com o computador dos próprios agentes" });
    expect(dialog.textContent).toContain("Todos deixam de usar os computadores dos agentes.");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    expect(last(again, "roles.setRow")?.slice(1)).toEqual([
      "computers",
      {
        everyone: 0,
        roles: [
          { id: SUPORTE, level: 0 },
          { id: FIN, level: 2 },
        ],
      },
    ]);
  });

  test("Administrador asks first, then folds the groups into one line", async () => {
    const state = await open(`roles/${SUPORTE}`);
    await click(within(permRow("Administrador")).getByRole("switch"));
    const ask = screen().getByRole("dialog", { name: "Ligar Administrador em Suporte?" });
    expect(ask.textContent).toContain("São 2 pessoas.");
    await click(within(ask).getByRole("button", { name: "Ligar Administrador" }));
    expect(sentPermissions(state, "roles.update")).toContain("administrator");
    await settle(4);
    expect(screen().getByText("Com Administrador, Suporte pode tudo, menos o que é só do dono.")).toBeTruthy();
    expect(permRow("Criar canais")).toBeUndefined();
  });

  test("Todos' own rows: one only some cargos have shows their marks and opens who may, those cargos ticked", async () => {
    const state = await open("roles/everyone");
    expect(
      screen()
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Permissões", "Canais", "Agentes"]);
    const chip = () =>
      within(permRow("Aprovar ações dos agentes")).getByRole("button", { name: /^Só Admin e Suporte/ });
    await click(chip());
    const dialog = screen().getByRole("dialog", { name: "Quem pode aprovar ações" });
    const box = (name: string) =>
      within(dialog).getByRole("checkbox", { name: new RegExp(`^${name}`) }) as HTMLButtonElement;
    // Who holds it starts ticked (Administrador fixed), who doesn't, not.
    expect([box("Admin").getAttribute("aria-checked"), box("Admin").disabled]).toEqual(["true", true]);
    expect(box("Suporte").getAttribute("aria-checked")).toBe("true");
    expect(box("Financeiro").getAttribute("aria-checked")).toBe("false");
    // Todos gets it; each cargo keeps its own.
    await click(within(dialog).getByRole("radio", { name: /^Todos/ }));
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    expect(last(state, "roles.setRow")?.slice(1)).toEqual([
      "approve_actions",
      {
        everyone: 1,
        roles: [
          { id: SUPORTE, level: 1 },
          { id: FIN, level: 0 },
        ],
      },
    ]);
    cleanup();
    // Only some: unticking Suporte takes it from Suporte, no level below none.
    const again = await open("roles/everyone");
    await click(chip());
    const who = screen().getByRole("dialog", { name: "Quem pode aprovar ações" });
    await click(within(who).getByRole("checkbox", { name: /^Suporte/ }));
    expect(who.querySelector(".roles-line--live")?.textContent).toBe("Deixam de poder: Carla e Diego.");
    await click(within(who).getByRole("button", { name: "Salvar" }));
    expect(last(again, "roles.setRow")?.slice(1)).toEqual([
      "approve_actions",
      {
        everyone: 0,
        roles: [
          { id: SUPORTE, level: 0 },
          { id: FIN, level: 0 },
        ],
      },
    ]);
  });
});

describe("a cargo's Canais and Agentes (W5–W8)", () => {
  test("its channels as a checklist with who sees each; #general fixed; opening an invite-only one asks", async () => {
    const state = await open(`roles/${SUPORTE}?tab=channels`);
    const box = (name: string) => screen().getByRole("checkbox", { name: new RegExp(`#${name}$`) });
    expect((box("general") as HTMLButtonElement).disabled).toBe(true);
    expect(box("suporte").getAttribute("aria-checked")).toBe("true");
    expect(box("diretoria").getAttribute("aria-checked")).toBe("false");
    await click(box("diretoria"));
    const ask = screen().getByRole("dialog", { name: "Abrir #diretoria para Suporte?" });
    await click(within(ask).getByRole("button", { name: "Abrir" }));
    expect(last(state, "chat.update")?.slice(1)).toEqual([
      "chan-diretoria",
      { visibility: "private", audienceRoleIds: [SUPORTE] },
    ]);
  });

  test("unticking a public channel asks who sees it, the three words", async () => {
    await open(`roles/${SUPORTE}?tab=channels`);
    await click(screen().getByRole("checkbox", { name: /#eng$/ }));
    const dialog = screen().getByRole("dialog", { name: "Quem vê #eng" });
    expect(
      within(dialog)
        .getAllByRole("radio")
        .map((r) => r.querySelector(".ac-optrow__title")?.textContent),
    ).toEqual(["Todos", "Só alguns cargos", "Só quem for adicionado"]);
  });

  test("who sees it starts with every other cargo ticked, one the viewer can't change too, and saves it", async () => {
    // A channel's cargos have no rank rule: Financeiro stays the viewer's to keep, or narrowing would cut its people.
    const state = acme((s) => {
      const fin = s.roles?.find((r) => r.id === FIN);
      if (fin) fin.editable = false;
    });
    await open(`roles/${SUPORTE}?tab=channels`, state);
    await click(screen().getByRole("checkbox", { name: /#eng$/ }));
    const dialog = screen().getByRole("dialog", { name: "Quem vê #eng" });
    const box = (name: string) =>
      within(dialog).getByRole("checkbox", { name: new RegExp(`^${name}`) }) as HTMLButtonElement;
    expect([box("Financeiro").getAttribute("aria-checked"), box("Financeiro").disabled]).toEqual(["true", false]);
    expect(box("Suporte").getAttribute("aria-checked")).toBe("false");
    expect(dialog.querySelector(".roles-line--live")?.textContent).toBe(
      "Quem já está continua. Deixam de ver: Carla e Diego.",
    );
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    expect(last(state, "chat.update")?.slice(1)).toEqual([ENG_ID, { visibility: "private", audienceRoleIds: [FIN] }]);
  });

  test("unticking an agent everyone talks to asks who talks to it: every other cargo ticked, Administrador's too", async () => {
    // Talking to an agent has no Administrador pass: saving as it opens takes Ada from no cargo's people but Suporte's.
    for (const page of [SUPORTE, "everyone"]) {
      await open(`roles/${page}?tab=agents`);
      await click(screen().getByRole("checkbox", { name: /^Ada/ }));
      const dialog = screen().getByRole("dialog", { name: "Quem fala com Ada" });
      const ticked = (name: string) =>
        within(dialog)
          .getByRole("checkbox", { name: new RegExp(`^${name}`) })
          .getAttribute("aria-checked");
      expect([ticked("Admin"), ticked("Suporte"), ticked("Financeiro")]).toEqual([
        "true",
        page === SUPORTE ? "false" : "true",
        "true",
      ]);
      cleanup();
    }
  });

  test("its agents; one only its owner talks to opens who talks to it, the cargo ticked", async () => {
    await open(`roles/${SUPORTE}?tab=agents`);
    const box = (name: string) => screen().getByRole("checkbox", { name: new RegExp(`^${name}`) });
    expect(box("Ada").getAttribute("aria-checked")).toBe("true");
    expect(box("Atlas").getAttribute("aria-checked")).toBe("false");
    await click(box("Atlas"));
    const dialog = screen().getByRole("dialog", { name: "Quem fala com Atlas" });
    expect(
      within(dialog)
        .getByRole("radio", { name: /Só alguns cargos e pessoas/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(dialog)
        .getByRole("checkbox", { name: /^Suporte/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("a cargo's Pessoas (W9)", () => {
  test("adding someone who'd take a mailbox from an agent asks first, in the same dialog", async () => {
    const state = acme((s) => {
      s.roleMailLoss = {
        [SUPORTE]: [
          {
            agentId: ADA_ID,
            agentName: "Ada",
            accountId: "acc-1",
            address: "bruno@example.com",
            ownerUserId: "u-joao",
            ownerName: "João",
          },
        ],
      };
    });
    await open(`roles/${SUPORTE}?tab=people`, state);
    await click(screen().getByRole("button", { name: "Adicionar pessoas" }));
    const dialog = screen().getByRole("dialog", { name: "Adicionar a Suporte" });
    await click(within(dialog).getByRole("checkbox", { name: /^Fabio/ }));
    await click(within(dialog).getByRole("button", { name: "Adicionar 1" }));
    await settle(4);
    const step = screen().getByRole("dialog", { name: "Ada perde a caixa de e-mail de João" });
    expect(step.textContent).toContain("bruno@example.com");
    expect(state.calls.some((c) => c.method === "roles.setFor")).toBe(false);
    await click(within(step).getByRole("button", { name: "Adicionar mesmo assim" }));
    await settle(4);
    expect(last(state, "roles.setFor")?.slice(1)).toEqual(["u-fabio", [FIN, SUPORTE]]);
  });
});

describe("look, create and the members' menu (W12, W13, W15)", () => {
  test("Nome, cor e ícone: a live preview, then one save", async () => {
    const state = await open(`roles/${SUPORTE}`);
    await click(screen().getByRole("button", { name: "Mudar nome, cor e ícone" }));
    const dialog = screen().getByRole("dialog", { name: "Nome, cor e ícone" });
    // The mark is a word of the name's line (its own box, on the capitals' middle), not a column beside the words.
    expect(dialog.querySelector(".roles-preview")?.className).not.toContain("ac-iconline");
    expect(dialog.querySelector(".roles-preview > .roles-preview__mark > .ac-rolemark")).toBeTruthy();
    expect(dialog.querySelector(".roles-preview > .roles-preview__mark + .roles-preview__name")).toBeTruthy();
    await click(within(dialog).getByRole("radio", { name: "Cor rose" }));
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    expect(last(state, "roles.update")?.slice(1)).toEqual([SUPORTE, { color: "rose" }]);
  });

  test("Apagar says who leaves before it goes: until it knows, the line holds its place and the button waits", async () => {
    const api = createFakeApi(acme());
    await renderApp(`/org/${ORG_ID}/settings/roles/${SUPORTE}`, { api });
    await settle(8);
    const members = api.chat.members;
    let release = () => {};
    api.chat.members = (orgId, channelId) =>
      new Promise((done) => {
        release = () => done(members(orgId, channelId));
      });
    await act(async () =>
      fireEvent.pointerDown(screen().getByRole("button", { name: "Mais opções" }), { button: 0, ctrlKey: false }),
    );
    await settle(2);
    await click(screen().getByRole("menuitem", { name: "Apagar cargo" }));
    const dialog = screen().getByRole("dialog", { name: "Apagar Suporte?" });
    const remove = within(dialog).getByRole("button", { name: "Apagar cargo" }) as HTMLButtonElement;
    expect(dialog.querySelector(".roles-line")?.textContent).toBe("Vendo quem sai de canais…");
    expect(remove.disabled).toBe(true);
    await act(async () => release());
    await settle(4);
    expect(dialog.querySelector(".roles-line")?.textContent).toBe(
      "Saem de canais que viam só por Suporte: Carla e Diego.",
    );
    expect(remove.disabled).toBe(false);
  });

  test("Criar cargo from another one copies its channels and agents too", async () => {
    const state = await open("roles");
    await click(screen().getByRole("button", { name: "Criar cargo" }));
    const dialog = screen().getByRole("dialog", { name: "Criar cargo" });
    await act(async () => fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Plantão" } }));
    await pick(within(dialog).getByRole("combobox"), "Suporte");
    await click(within(dialog).getByRole("button", { name: "Criar cargo" }));
    expect(last(state, "roles.create")?.[1]).toEqual({ name: "Plantão", copyFrom: SUPORTE });
  });

  test("a person's ⋯ › Cargos: the kit's checkbox at each cargo's end, each tick saves", async () => {
    const state = await open("members");
    const carla = [...document.querySelectorAll<HTMLElement>(".members-person")].find((r) =>
      r.textContent?.includes("Carla"),
    ) as HTMLElement;
    await act(async () =>
      fireEvent.pointerDown(within(carla).getByRole("button", { name: "Mais de Carla" }), {
        button: 0,
        ctrlKey: false,
      }),
    );
    await settle(2);
    const sub = screen().getByRole("menuitem", { name: "Cargos" });
    await act(async () => fireEvent.keyDown(sub, { key: "Enter" }));
    await settle(2);
    const fin = screen().getByRole("menuitemcheckbox", { name: "Financeiro" });
    expect(fin.querySelector(".ac-check.ac-menu__box")?.getAttribute("data-state")).toBe("unchecked");
    expect(
      screen()
        .getByRole("menuitemcheckbox", { name: "Suporte" })
        .querySelector(".ac-menu__box")
        ?.getAttribute("data-state"),
    ).toBe("checked");
    await click(fin);
    await settle(4);
    expect(last(state, "roles.setFor")?.slice(1)).toEqual(["u-carla", [SUPORTE, FIN]]);
  });
});

void GENERAL_ID;

describe("REVIEW P1 P2", () => {
  test("P1: Suporte ticked again in Quem pode keeps it; the line and the save say so", async () => {
    const state = await open(`roles/${SUPORTE}`);
    await click(within(permRow("Criar canais")).getByRole("switch"));
    const dialog = screen().getByRole("dialog", { name: "Quem pode criar canais" });
    await click(within(dialog).getByRole("checkbox", { name: /^Suporte/ }));
    expect(
      within(dialog)
        .getByRole("checkbox", { name: /^Suporte/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(dialog.querySelector(".roles-line--live")?.textContent).toBe("Ninguém perde.");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    expect(last(state, "roles.setRow")?.slice(1)).toEqual([
      "create_channels",
      {
        everyone: 0,
        roles: [
          { id: SUPORTE, level: 1 },
          { id: FIN, level: 1 },
        ],
      },
    ]);
  });

  test("P2: Todos' tick keeps the agent's saved consultable", async () => {
    const state = acme((s) => {
      const atlas = s.agents.find((a) => a.id === ATLAS_ID) as Agent;
      atlas.audience = { mode: "owner", userIds: [], roleIds: [], consultable: false };
    });
    await open("roles/everyone?tab=agents", state);
    await click(screen().getByRole("checkbox", { name: /^Atlas/ }));
    const ask = screen().queryByRole("button", { name: "Continuar" });
    if (ask) await click(ask);
    await settle(4);
    const sent = last(state, "agents.update")?.[2] as { audience: { mode: string; consultable?: boolean } };
    expect(sent.audience.mode).toBe("everyone");
    expect(sent.audience.consultable).toBe(false);
  });
});
