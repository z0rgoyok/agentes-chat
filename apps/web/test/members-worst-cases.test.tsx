import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Agent, Member, OrgRole, PlanUsage } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADMIN_ROLE_ID, createFakeApi, ORG_ID, seedRoles, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/**
 * Configurações › Membros with what breaks its two lists (break-ui): a 60-character name, a 70-character address with
 * no break, nobody's roles beside six of them, 40 agents, one with no owner, one with no AI account, plans fine,
 * almost full and full. CI's geometry check lays out every screen these tests reach at 1280 and 320.
 */
const LONG_NAME = "Maria Eduarda Albuquerque de Vasconcelos Figueiredo Sobrinho";
const LONG_EMAIL = "mariaeduardaalbuquerquedevasconcelosfigueiredosobrinho@example.com";

const usage = (week: number): PlanUsage => ({
  windows: [
    { kind: "seven_day", usedPercent: week, resetsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() },
    { kind: "five_hour", usedPercent: 3 },
  ],
  source: "probe",
  at: new Date().toISOString(),
});

function worst() {
  const state = seedState();
  const [admin, everyone] = seedRoles() as [OrgRole, OrgRole];
  const extra = ["Financeiro", "Atendimento ao cliente", "Engenharia", "Marketing e vendas", "Jurídico"].map(
    (name, i): OrgRole => ({ ...admin, id: `role-${i}`, name, permissions: [], position: i + 1, hoist: false }),
  );
  state.roles = [admin, ...extra, { ...everyone, position: extra.length + 1 }];
  const person = (userId: string, name: string, email: string, roleIds: string[]): Member => ({
    userId,
    name,
    email,
    image: null,
    role: "member",
    roleIds,
    joinedAt: new Date(Date.now() - 86_400_000).toISOString(),
    handle: userId.slice(2),
    timezone: "UTC",
  });
  state.members.push(
    person("u-maria", LONG_NAME, LONG_EMAIL, [ADMIN_ROLE_ID, ...extra.map((r) => r.id)]),
    person("u-bia", "Bia", "bia@example.com", []),
  );
  const [ada] = state.agents as [Agent];
  state.agents = Array.from({ length: 40 }, (_, i): Agent => {
    const base = { ...ada, id: `agent-${i}`, name: `Agente ${i + 1}`, handle: `agente${i + 1}`, role: "Suporte" };
    if (i === 0) return { ...base, name: "Sem dono", role: "", ownerUserId: null };
    // No AI account: nothing about a plan, closed or open.
    if (i === 1) return { ...base, name: "Sem conta", brain: { kind: "codex", model: "GPT" } };
    const plan = (week: number) => ({
      kind: "claude_code" as const,
      model: "Sonnet",
      account: "Claude 2",
      usage: usage(week),
    });
    if (i === 2) return { ...base, name: "Folgado", brain: plan(40) };
    if (i === 3) return { ...base, name: "Apertado", brain: plan(85) };
    if (i === 4) return { ...base, name: "Quase", brain: plan(95) };
    if (i === 5) return { ...base, name: "Cheio", brain: plan(100) };
    if (i === 6) return { ...base, name: LONG_NAME, role: "Atendimento ao cliente das lojas da região sul" };
    return base;
  });
  state.spentUsd = {};
  return state;
}

async function open(state = worst()) {
  await renderApp(`/org/${ORG_ID}/settings/members`, { api: createFakeApi(state) });
  await settle(6);
  return state;
}

// By class, not by role: an open menu hides the page behind it from the accessibility tree.
const personRow = (name: string) =>
  [...document.querySelectorAll<HTMLElement>(".members-person")].find((row) =>
    row.querySelector(".members-person__name")?.textContent?.startsWith(name),
  ) as HTMLElement;

/** What a person's row menu offers (Radix opens it as the pointer goes down). */
async function menuOf(row: HTMLElement) {
  const trigger = within(row).getByRole("button", { name: /^Mais de / });
  await act(async () => fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false }));
  await settle(2);
  const items = screen()
    .getAllByRole("menuitem")
    .map((i) => i.textContent ?? "");
  await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
  await settle(1);
  return items;
}

const agentRow = (name: string) =>
  [...screen().getByRole("region", { name: "Agentes" }).querySelectorAll<HTMLElement>(".ac-foldrow")].find((row) =>
    row.querySelector("b")?.textContent?.startsWith(name),
  ) as HTMLElement;

describe("Pessoas", () => {
  test("a row: the name and addresses whole, the roles under them or no roles line, one menu at its end", async () => {
    await open();
    const maria = personRow(LONG_NAME);
    expect(maria.querySelector(".members-person__ids")?.textContent).toBe(`@maria${LONG_EMAIL}`);
    expect(maria.querySelectorAll(".members-roles > *")).toHaveLength(6);
    // Nobody's roles: no line for them, not an empty one.
    const bia = personRow("Bia");
    expect(bia.querySelector(".members-roles")).toBeNull();
    // On the name's line: when they were here, then the menu's place, which ends every row whether it has one or not.
    for (const row of [maria, bia, personRow("João"), personRow("Walter")]) {
      const [seen, menu] = [...row.children].slice(-2) as [HTMLElement, HTMLElement];
      expect(seen.className).toBe("members-person__seen ac-captail ac-captop");
      expect(menu.className).toBe("members-person__menu ac-captail ac-captop");
      // The only button of the row besides the face and the name is its menu.
      expect(within(row).queryByRole("button", { name: /^(Cargos de|Mensagem para) / })).toBeNull();
      expect(menu.querySelectorAll("button")).toHaveLength(1);
    }
  });

  test("the owner's menu: a message, the roles to give, removing. Their own row has no message", async () => {
    await open();
    // This server sends no email, so its owner also makes a member's new-password link.
    const link = "Gerar link de senha novaPara quando a pessoa esqueceu a senha";
    expect(await menuOf(personRow("Bia"))).toEqual(["Mensagem direta", "Cargos", link, "Remover do workspace"]);
    expect(await menuOf(personRow(LONG_NAME))).toEqual(["Mensagem direta", "Cargos", link, "Remover do workspace"]);
    expect(await menuOf(personRow("Walter"))).toEqual(["Cargos"]);
  });

  test("giving a role from the menu", async () => {
    const state = await open();
    const bia = personRow("Bia");
    await act(async () =>
      fireEvent.pointerDown(within(bia).getByRole("button", { name: "Mais de Bia" }), { button: 0, ctrlKey: false }),
    );
    await settle(2);
    const sub = screen().getByRole("menuitem", { name: "Cargos" });
    expect(sub.getAttribute("aria-haspopup")).toBe("menu");
    await act(async () => fireEvent.keyDown(sub, { key: "Enter" }));
    await settle(2);
    await act(async () => fireEvent.click(screen().getByRole("menuitemcheckbox", { name: "Financeiro" })));
    await settle(4);
    expect(state.members.find((m) => m.userId === "u-bia")?.roleIds).toEqual(["role-0"]);
    expect(personRow("Bia").querySelector(".members-roles")?.textContent).toBe("Financeiro");
  });

  test("a member who manages nobody: a message to the others, and no menu on their own row, which keeps its room", async () => {
    const state = worst();
    if (state.me) state.me.user = { ...state.me.user, id: "u-bia", name: "Bia" };
    const org = state.me?.organizations[0];
    if (org) org.role = "member";
    // Another owner, so leaving is theirs to do.
    await open(state);
    expect(await menuOf(personRow("João"))).toEqual(["Mensagem direta"]);
    const mine = personRow("Bia");
    const menu = within(mine).queryByRole("button", { name: /^Mais de / });
    if (menu) expect(await menuOf(mine)).toEqual(["Sair do workspace"]);
    else expect((mine.lastElementChild as HTMLElement).childElementCount).toBe(0);
  });
});

describe("Agentes", () => {
  test("closed: the glyph, the name and who answers for it, a word only when its plan needs someone", async () => {
    await open();
    const rows = screen().getByRole("region", { name: "Agentes" }).querySelectorAll(".ac-foldrow");
    expect(rows).toHaveLength(40);
    for (const row of rows) {
      const head = row.querySelector(".ac-foldrow__head") as HTMLElement;
      expect(head.getAttribute("aria-expanded")).toBe("false");
      expect((row.querySelector(".ac-foldrow__fold") as HTMLElement).inert).toBe(true);
      expect(head.querySelector(".ac-planmeter")).toBeNull();
    }
    const said = (name: string) => {
      const word = agentRow(name).querySelector(".ac-foldrow__head .ac-planword");
      return word ? [word.textContent, word.getAttribute("data-level")] : null;
    };
    expect(said("Folgado")).toBeNull();
    expect(said("Sem conta")).toBeNull();
    expect(said("Apertado")).toEqual(["Quase no limite", "almost"]);
    expect(said("Quase")).toEqual(["Quase no limite", "critical"]);
    expect(said("Cheio")).toEqual(["No limite", "limited"]);
    expect(agentRow("Sem dono").querySelector(".ac-foldrow__head")?.textContent).toBe("Sem donoSem responsável");
    expect(agentRow("Quase").querySelector(".ac-foldrow__head")?.textContent).toBe(
      "Quase · SuporteResponsável: JoãoQuase no limite",
    );
  });

  test("open: the account, the bar and when it renews, and the way to the agent's page. Each row opens on its own", async () => {
    await open();
    const quase = agentRow("Quase");
    const head = within(quase).getByRole("button", { name: /^Quase · Suporte/ });
    await act(async () => fireEvent.click(head));
    expect(head.getAttribute("aria-expanded")).toBe("true");
    const fold = quase.querySelector(".ac-foldrow__fold") as HTMLElement;
    expect(fold.inert).toBe(false);
    expect(fold.querySelector(".ac-planmeter__line")?.textContent).toBe("Claude 2 · semana 95% · 5h 3%");
    expect(fold.querySelector(".ac-planmeter__state")?.textContent).toStartWith("Quase no limite · renova ");
    expect(within(fold).getByRole("meter")).toBeTruthy();
    expect(within(fold).getByRole("link", { name: "Ver perfil" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/agents/agent-4`,
    );
    // No AI account: one quiet line says so over the way to its page.
    const none = agentRow("Sem conta");
    await act(async () => fireEvent.click(within(none).getByRole("button", { name: /^Sem conta/ })));
    expect(none.querySelector(".ac-foldrow__more")?.textContent).toBe("Sem IA conectadaVer perfil");
    // The first stays open.
    expect(head.getAttribute("aria-expanded")).toBe("true");
  });
});
