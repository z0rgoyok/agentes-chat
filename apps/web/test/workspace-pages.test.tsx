import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Proposal } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedRoles, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const go = async (path: string, state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(4);
  return { ...r, state };
};
const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
/** A help line's link: to the page on agentes.chat in Portuguese, in a new tab with no referrer. */
const expectHelpLink = (link: HTMLElement, page: string) => {
  expect(link.getAttribute("href")).toBe(`https://agentes.chat/pt/docs/${page}`);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(link.className).toBe("ac-link ac-link--muted");
};

describe("Requests in the inbox (ADR 0218)", () => {
  /** A request waiting on me: its notification, the inbox's row. */
  const asked = (approvalId: string, agentId: string) =>
    notification({
      id: `n-${approvalId}`,
      kind: "approval",
      waiting: true,
      actors: [{ type: "agent", id: agentId }],
      source: { approvalId, channelId: ENG_ID },
      latest: { expiresAt: new Date(Date.now() + 20 * 3_600_000).toISOString() },
    });
  /** The seed, with its two waiting requests in my inbox and no proposal among them. */
  const waiting = () =>
    seedState({ notifications: [asked("ap-merge", ADA_ID), asked("ap-deploy", ATLAS_ID)], proposals: [] });
  /** A request's row in the inbox's list. */
  const row = (approvalId: string) => document.querySelector(`.ib-row[data-n="n-${approvalId}"]`) as HTMLElement;
  /** The request open beside the list: the conversation's own card. */
  const card = () => document.querySelector(".ib-read .rq") as HTMLElement;
  const refuse = async (open: HTMLElement) => {
    await click(within(open).getByRole("button", { name: "Agora não" }));
    await click(within(open).getByRole("button", { name: "Falta teste" }));
    await click(within(open).getByRole("button", { name: /Recusar e avisar/ }));
    await settle(4);
  };
  /** A filter of the menu beside the inbox's title. */
  const pickFilter = async (name: RegExp) => {
    const trigger = document.querySelector(".ib-filter") as HTMLElement;
    trigger.focus();
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "Enter" });
      fireEvent.keyUp(trigger, { key: "Enter" });
    });
    await settle(2);
    await click(within(screen().getByRole("menu")).getByRole("menuitemradio", { name }));
    await settle(4);
  };

  test("waiting rows, one open beside them; refusing sends the reason and moves it to the decided requests", async () => {
    const { state } = await go("notifications", waiting());
    const list = screen().getByRole("region", { name: "Esperando você" });
    expect(list.contains(row("ap-merge"))).toBe(true);
    expect(list.contains(row("ap-deploy"))).toBe(true);
    expect(row("ap-merge").textContent).toContain("Ada");
    // How long is left to decide, where anything else says when it came.
    expect(row("ap-merge").querySelector(".ib-row__end")?.textContent).toMatch(/^\d+ h$/);
    // The deploy is high risk: the button asks for a hold.
    await click(row("ap-deploy"));
    await settle(2);
    expect(row("ap-deploy").getAttribute("aria-current")).toBe("true");
    expect(card().getAttribute("data-ask-id")).toBe("ap-deploy");
    expect(within(card()).getByRole("button", { name: "Aprovar deploy: segure para confirmar" })).toBeTruthy();

    await click(row("ap-merge"));
    await settle(2);
    expect(row("ap-merge").getAttribute("aria-current")).toBe("true");
    expect(row("ap-deploy").getAttribute("aria-current")).toBeNull();
    expect(card().getAttribute("data-ask-id")).toBe("ap-merge");
    expect(within(card()).getByRole("button", { name: "Aprovar merge" })).toBeTruthy();
    // Beside the list, never over it.
    expect(screen().queryByRole("dialog")).toBeNull();
    await refuse(card());
    expect(state.calls.find((c) => c.method === "approvals.refuse")?.args).toEqual([ORG_ID, "ap-merge", "Falta teste"]);
    // Among the decided requests now, refused today.
    await pickFilter(/Pedidos decididos/);
    const decided = document.querySelector('.ap-li[data-id="ap-merge"]') as HTMLElement;
    expect(decided.closest("section")?.getAttribute("aria-label")).toBe("Hoje");
    expect(decided.textContent).toContain("Recusado");
    expect(document.querySelector('.ap-li[data-id="ap-deploy"]')).toBeNull();
  });

  test("refusing asks why, optional, and says the agent learns from it", async () => {
    await go("approvals?open=ap-merge", waiting());
    const open = card();
    await click(within(open).getByRole("button", { name: "Agora não" }));
    await settle(2);
    const why = within(open).getByLabelText("Por que não?");
    expect(why.getAttribute("placeholder")).toBe("Opcional");
    expect(open.textContent).toContain("Vira uma lição na memória da Ada");
    // Back out, and the decision is there again.
    await click(within(open).getByRole("button", { name: "Voltar" }));
    expect(within(open).queryByLabelText("Por que não?")).toBeNull();
    expect(open.querySelector('[data-approve="ap-merge"]')).not.toBeNull();
  });

  test("a normal-risk approval goes with one click", async () => {
    const { state } = await go("approvals?open=ap-merge", waiting());
    await click(within(card()).getByRole("button", { name: "Aprovar merge" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "approvals.approve")?.args[1]).toBe("ap-merge");
  });

  test("a link to a request's old address opens that request in the inbox; refusing works from its card", async () => {
    for (const id of ["ap-merge", "ap-deploy"]) {
      const { state, router } = await go(`approvals?open=${id}`, waiting());
      expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
      expect(router.state.location.search).toMatchObject({ approval: id });
      expect(row(id).getAttribute("aria-current")).toBe("true");
      expect(card().getAttribute("data-ask-id")).toBe(id);
      await refuse(card());
      expect(state.calls.find((c) => c.method === "approvals.refuse")?.args).toEqual([ORG_ID, id, "Falta teste"]);
      cleanup();
    }
  });

  test("a connector tool that runs another by name reads as that action, in words, with the tool behind Technical details", async () => {
    const state = seedState({ notifications: [asked("ap-trace", ADA_ID)], proposals: [] });
    const merge = state.approvals[0];
    if (!merge) throw new Error("no approval");
    state.approvals = [
      {
        ...merge,
        id: "ap-trace",
        tool: "sentry_execute_tool",
        scope: "custom:conn-sentry:write",
        title: "Sentry: Execute sentry tool",
        connector: "custom:conn-sentry",
        params: { name: "get_event_stacktrace", arguments: { issue: "ACME-177" } },
      },
    ];
    await go("notifications", state);
    const open = card();
    expect(open.querySelector(".rq__well b")?.textContent).toBe("Ver stack trace do evento");
    expect(open.textContent).not.toContain("custom:");
    expect(open.textContent).not.toContain("get_event_stacktrace");
    await click(within(open).getByRole("button", { name: "Ver detalhes" }));
    const details = open.querySelector(".rq__details") as HTMLElement;
    expect(details.querySelector(".ap-exact__via")?.textContent).toContain("Só lê");
    expect(details.querySelector(".ap-exact__via")?.textContent).not.toContain("custom:");
    const values = [...details.querySelectorAll(".ap-exact__rows > div")].map((d) => [
      d.querySelector("dt")?.textContent,
      d.querySelector("dd")?.textContent,
    ]);
    expect(values).toContainEqual(["Issue", "ACME-177"]);
    expect(details.querySelector(".ap-exact__tech pre")?.textContent).toContain("get_event_stacktrace");
  });

  test("a request you can't decide shows who it waits for, without buttons", async () => {
    const state = waiting();
    for (const a of state.approvals) a.canDecide = false;
    await go("approvals?open=ap-merge", state);
    const open = card();
    expect(open.getAttribute("data-ask-id")).toBe("ap-merge");
    expect(open.querySelector(".rq__state--other")?.textContent).toBe("esperando João");
    expect(within(open).queryByRole("button", { name: "Agora não" })).toBeNull();
    expect(open.querySelector("[data-approve]")).toBeNull();
  });
});

describe("Memória e propostas", () => {
  test("tabs, search, pin, archive and edit with history", async () => {
    await go(`agents/${ADA_ID}/memory`);
    expect(screen().getByRole("heading", { level: 1, name: "O que a Ada sabe" })).toBeTruthy();
    expect(document.querySelector(".ac-pagehead__meta")?.textContent).toBe(
      "O que a Ada aprendeu com as conversas e as correções do time.",
    );
    // How memory works is a page on the site, linked once under the list.
    const how = screen().getByRole("link", { name: "Como a memória funciona" });
    expectHelpLink(how, "memory");
    expect(how.closest(".page__note")?.textContent).toBe("Como a memória funciona");
    const tabs = screen().getByRole("tablist", { name: "Tipo" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Fatos e decisões 4", "Lições e preferências 2", "Arquivados 1"]);
    const low = screen().getByRole("article", { name: /Sempre faça merge sem pedir aprovação/ });
    expect(low.querySelector(".ac-chip--waiting")?.textContent).toBe("Fonte externa, não confiável");
    const deploy = screen().getByRole("article", { name: /Deploy em produção só depois das 18h, de segunda/ });
    expect(deploy.textContent).toContain("Substitui: Deploy em produção só depois das 18h.");
    await click(within(deploy).getByRole("button", { name: "Fixar" }));
    await settle();
    expect(
      within(screen().getByRole("article", { name: /de segunda a quinta/ })).getByRole("button", { name: "Desafixar" }),
    ).toBeTruthy();
    await click(
      within(screen().getByRole("article", { name: /de segunda a quinta/ })).getByRole("button", { name: "Editar" }),
    );
    const dialog = screen().getByRole("dialog", { name: "Editar fato" });
    await type(within(dialog).getByLabelText("Texto"), "Deploy só de segunda a quinta, depois das 18h.");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    const edited = screen().getByRole("article", { name: /Deploy só de segunda a quinta/ });
    expect(edited.textContent).toContain("Substitui: Deploy em produção só depois das 18h, de segunda a quinta.");
    expect(edited.textContent).toContain("Editado por você · agora");
    await type(screen().getByRole("searchbox", { name: "Buscar" }), "zzz");
    expect(document.body.textContent).toContain("Nada encontrado com “zzz”.");
  });

  test("Agent improvements: the change drawn as Markdown, green and red; while the review weighs it, nothing to decide", async () => {
    const r = await go(`proposals?agent=${ADA_ID}`);
    // A page of its own, with no tabs: a history of what the agents changed (ADR 0219).
    expect(screen().getByRole("heading", { level: 1, name: "Melhorias dos agentes" })).toBeTruthy();
    expect(screen().queryByRole("tab")).toBeNull();
    expect(screen().getByRole("link", { name: "O que a Ada sabe" })).toBeTruthy();
    const detail = screen().getByRole("article");
    // Who proposed it and what it changes, on the requests' head; that its review is weighing it, as words.
    expect(detail.querySelector(".ap-review__by")?.textContent).toContain("Adainstruções da Ada");
    expect(detail.querySelector(".ac-chip")).toBeNull();
    const row = within(screen().getByRole("navigation", { name: "Melhorias" })).getAllByRole("button")[0];
    expect(row?.textContent).toContain("Avaliando…");
    expect(row?.querySelector(".ap-li__state")).toBeNull();
    expect(detail.querySelector(".ap-outcome h2")?.textContent).toStartWith("Avaliando… · ");
    const added = detail.querySelectorAll(".ac-diff__block--add");
    const removed = detail.querySelectorAll(".ac-diff__block--del");
    expect(added.length).toBe(2);
    expect(removed.length).toBe(1);
    expect(removed[0]?.textContent).toBe("Removido: Pede ajuda ao João quando a mudança tocar em pagamentos.");
    // Each block is the instructions' own Markdown, drawn as the Instructions tab draws them: no "+" or "−" column.
    expect(removed[0]?.querySelector(".md")).not.toBeNull();
    expect(detail.querySelector(".ac-diff__mark")).toBeNull();
    // Nobody decides it here: no Accept, Refuse or Edit, no decision bar, and nothing to undo yet.
    for (const name of [/^Aceitar/, /^Recusar/, /^Editar antes/, "Desfazer"])
      expect(screen().queryByRole("button", { name })).toBeNull();
    expect(detail.querySelector(".ap-bar")).toBeNull();
    expect(r.state.calls.filter((c) => c.method.startsWith("proposals.") && c.method !== "proposals.list")).toEqual([]);
  });
});

describe("Memória e propostas (fase 5)", () => {
  /** Applied just now by Ada's review (ADR 0219), and the viewer may undo it, unless `patch` says otherwise. */
  const applied = (patch: Partial<Proposal> = {}): Partial<Proposal> => ({
    status: "accepted",
    reviewed: true,
    decidedByAgent: { agentId: ADA_ID, name: "Ada" },
    review: "Uma correção que se repetiu.",
    undoable: true,
    decidedAt: new Date().toISOString(),
    ...patch,
  });

  test("verified and unverified memories carry a chip with an icon", async () => {
    await go(`agents/${ADA_ID}/memory`);
    const verified = screen().getByRole("article", { name: /Não suportar mais o Internet Explorer/ });
    expect(verified.querySelector(".ac-chip--done")?.textContent).toBe("Verificado");
    const unverified = screen().getByRole("article", { name: /tokens de 15 minutos/ });
    const chip = Array.from(unverified.querySelectorAll(".ac-chip")).find((c) => c.textContent === "Não verificado");
    expect(chip?.querySelector("svg.ac-icon")).not.toBeNull();
  });

  test("pin calls PATCH /memories/{id}", async () => {
    const { state } = await go(`agents/${ADA_ID}/memory`);
    const row = screen().getByRole("article", { name: /tokens de 15 minutos/ });
    await click(within(row).getByRole("button", { name: "Fixar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "memory.patch")?.args).toEqual([ORG_ID, "mem-5", { pinned: true }]);
  });

  test("Undo puts back a change its review applied; one that changed since says so", async () => {
    const state = seedState();
    const [first] = state.proposals;
    if (!first) throw new Error("a proposal expected");
    Object.assign(first, applied());
    const r = await go(`proposals?agent=${ADA_ID}`, state);
    const outcome = screen().getByRole("article").querySelector(".ap-outcome--done") as HTMLElement;
    expect(outcome.querySelector("h2")?.textContent).toBe("Aplicado pela Ada · agora");
    expect(outcome.textContent).toContain("Uma correção que se repetiu.");
    await click(within(outcome).getByRole("button", { name: "Desfazer" }));
    await settle(4);
    expect(r.state.calls.find((c) => c.method === "proposals.undo")?.args).toEqual([ORG_ID, first.id]);
    const back = screen().getByRole("article").querySelector(".ap-outcome") as HTMLElement;
    expect(back.classList.contains("ap-outcome--done")).toBe(false);
    expect(back.querySelector("h2")?.textContent).toBe("Desfeito por você · agora");
    expect(within(back).queryByRole("button", { name: "Desfazer" })).toBeNull();
    cleanup();

    // What it changed moved since: the server refuses (409), and the toast says what to do.
    const changed = seedState();
    const [again] = changed.proposals;
    if (!again) throw new Error("a proposal expected");
    Object.assign(again, applied());
    await go(`proposals?agent=${ADA_ID}`, changed);
    again.undoable = false;
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(4);
    expect(document.querySelector(".ac-toast")?.textContent).toContain("Isso mudou depois de aplicado: ajuste à mão.");
  });

  test("a reason the server wrote reads in the person's language", async () => {
    const state = seedState();
    const [first] = state.proposals;
    if (first) Object.assign(first, { why: "Remover o sistema antigo.", whyCode: "corrected" });
    await go("proposals", state);
    expect(screen().getByRole("article").textContent).toContain("Uma pessoa corrigiu: Remover o sistema antigo.");
  });

  test("stale rows aren't listed, and the newest comes first", async () => {
    const state = seedState();
    const [ada, context] = state.proposals;
    if (!ada || !context) throw new Error("two proposals expected");
    state.proposals.push({ ...context, id: "prop-twin", stale: true, status: "refused" });
    Object.assign(ada, { createdAt: "2026-11-01T10:00:00.000Z" });
    Object.assign(context, { createdAt: "2026-11-05T10:00:00.000Z" });
    await go("proposals", state);
    const rows = within(screen().getByRole("navigation", { name: "Melhorias" })).getAllByRole("button");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Atualizar o contexto da Acme");
    expect(rows[0]?.getAttribute("aria-current")).toBe("true");
    expect(rows[1]?.textContent).toContain("Atualizar as instruções da Ada");
  });

  test("the history is drawn on the requests' layout: the same list rows and review column, with no decision bar", async () => {
    await go("proposals");
    const list = screen().getByRole("navigation", { name: "Melhorias" });
    expect(list.className).toBe("ap-list");
    expect(list.parentElement?.className).toBe("ap-split page-split");
    expect(within(list).getAllByRole("button")[0]?.className).toContain("ap-li ac-mediarow");
    const open = screen().getByRole("article");
    expect(open.className).toBe("ap-review");
    expect(open.querySelector(".ap-review__head .ap-review__title")).not.toBeNull();
    expect(open.querySelectorAll(".ap-review__body > .ap-review__card").length).toBeGreaterThanOrEqual(2);
    expect(open.querySelector(".ap-bar")).toBeNull();
    expect(screen().queryByRole("group", { name: "Decidir todas as propostas" })).toBeNull();
  });

  test("left out by the review: its row and outcome say so and why; Undo only where the viewer may put it back", async () => {
    const state = seedState();
    const [first] = state.proposals;
    if (!first) throw new Error("a proposal expected");
    Object.assign(first, applied({ status: "refused", undoable: false, review: "Já está nas instruções." }));
    await go(`proposals?agent=${ADA_ID}`, state);
    const outcome = screen().getByRole("article").querySelector(".ap-outcome") as HTMLElement;
    expect(outcome.classList.contains("ap-outcome--done")).toBe(false);
    expect(outcome.querySelector("h2")?.textContent).toBe("Não aplicado pela Ada · agora");
    expect(outcome.textContent).toContain("Já está nas instruções.");
    const row = within(screen().getByRole("navigation", { name: "Melhorias" })).getAllByRole("button")[0];
    expect(row?.querySelector(".ap-li__state")?.getAttribute("aria-label")).toBe("Não aplicado pela Ada");
    expect(screen().queryByRole("button", { name: "Desfazer" })).toBeNull();
    cleanup();
    Object.assign(first, applied({ undoable: false }));
    await go(`proposals?agent=${ADA_ID}`, state);
    expect(screen().getByRole("article").querySelector(".ap-outcome--done h2")?.textContent).toBe(
      "Aplicado pela Ada · agora",
    );
    expect(screen().queryByRole("button", { name: "Desfazer" })).toBeNull();
  });

  test("a role proposal's change reads “Mudança · função da Ada”, never “Mudança em função de” (because of)", async () => {
    const state = seedState();
    const [first] = state.proposals;
    if (!first) throw new Error("a proposal expected");
    const target = { type: "agent_role" as const, agentId: ADA_ID };
    state.proposals = [{ ...first, target, before: "Dev", after: "Revisora de código" }];
    await go("proposals", state);
    const change = screen().getByRole("region", { name: "Mudança proposta" });
    expect(within(change).getByRole("heading").textContent).toBe("Mudança · função da Ada");
    expect(change.textContent).toContain("Função: Dev → Revisora de código");
  });
});

describe("Membros", () => {
  test("lists people (you, owner, roles) and agents with budgets", async () => {
    await go("members");
    expect(screen().getByText("Quem faz parte da Acme: 2 pessoas e 2 agentes.")).toBeTruthy();
    const people = screen().getByRole("region", { name: "Pessoas" });
    expect(people.textContent).toContain("Walter (você)");
    expect(people.textContent).toContain("Ativo agora");
    // Each person's roles as chips (ADR 0085). Giving or taking them is in the row's menu, never a loose "+".
    const joao = within(people).getByText("João").closest(".ac-list__row") as HTMLElement;
    expect(joao.querySelector(".members-roles")?.textContent).toBe("Admin");
    expect(within(joao).queryByRole("button", { name: "Cargos de João" })).toBeNull();
    expect(within(joao).getByRole("button", { name: "Mais de João" })).toBeTruthy();
    const agents = screen().getByRole("region", { name: "Agentes" });
    expect(agents.textContent).toContain("Ada · Dev");
    expect(agents.textContent).toContain("Responsável: João");
    expect(agents.textContent).toMatch(/31% do orçamento de \S+/);
    expect(agents.textContent).not.toContain("US$");
  });

  test("an agent on a plan: its limits where the budget was, the budget under them only once it spent through the API", async () => {
    const state = seedState();
    const [ada, atlas] = state.agents;
    if (!ada || !atlas) throw new Error("seed");
    ada.brain = {
      kind: "claude_code",
      model: "Sonnet",
      account: "Claude Team",
      usage: {
        windows: [
          { kind: "five_hour", usedPercent: 12 },
          { kind: "seven_day", usedPercent: 40 },
        ],
        source: "probe",
        at: new Date().toISOString(),
      },
    };
    // Atlas thinks with a plan whose windows aren't known yet, and spent nothing through the API: nothing, never 0%.
    atlas.brain = { kind: "codex", model: "GPT", account: "ChatGPT Plus" };
    state.spentUsd = { [ATLAS_ID]: 0 };
    await go("members", state);
    const [adaRow, atlasRow] = screen().getByRole("region", { name: "Agentes" }).querySelectorAll(".ac-foldrow");
    expect(adaRow?.querySelector(".ac-planmeter__line")?.textContent).toBe("Claude Team · semana 40% · 5h 12%");
    expect(adaRow?.textContent).toMatch(/Claude Team · semana 40% · 5h 12%31% do orçamento de \S+Ver perfil$/);
    expect(atlasRow?.querySelector(".ac-planmeter")).toBeNull();
    expect(atlasRow?.textContent).not.toMatch(/orçamento|%/);
  });

  test("Convites por e-mail: newest first, who sent each and until when; an expired one renews with the same link", async () => {
    const state = seedState();
    state.invitations.push(
      {
        id: "inv-old",
        email: "rafa@acme.com.br",
        role: "member",
        status: "expired",
        expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
        createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
        invitedBy: "Walter",
        url: "http://localhost:3000/invite/tok-inv-old",
      },
      {
        id: "inv-new",
        email: "carla@acme.com.br",
        role: "member",
        status: "pending",
        expiresAt: new Date(Date.now() + 5 * 86_400_000 + 60_000).toISOString(),
        createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        invitedBy: "João",
        url: "http://localhost:3000/invite/tok-inv-new",
      },
    );
    await go("settings/invites", state);
    const sent = () => screen().getByRole("region", { name: "Convites por e-mail" });
    const rows = within(sent()).getAllByRole("group");
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Convite para carla@acme.com.br",
      "Convite para rafa@acme.com.br",
    ]);
    const [carla, rafa] = rows as [HTMLElement, HTMLElement];
    // What it gives, who sent it when it isn't you; until when it works, or since when it doesn't.
    expect(carla.textContent).toContain("de João");
    expect(carla.textContent).toContain("Expira em 5 dias");
    expect(rafa.textContent).not.toContain("de Walter");
    expect(rafa.textContent).toContain("Expirou ontem");
    expect(rafa.getAttribute("data-off")).toBe("true");
    // An expired link opens nothing: no Copy; Renovar sends it again, with the same link.
    expect(within(rafa).queryByRole("button", { name: "Copiar link" })).toBeNull();
    expect(within(rafa).getByRole("button", { name: "Tirar" })).toBeTruthy();
    await click(within(rafa).getByRole("button", { name: "Renovar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "orgs.resendInvitation")?.args).toEqual([ORG_ID, "inv-old"]);
    expect(document.body.textContent).toContain("Convite renovado e mandado de novo para rafa@acme.com.br.");
    const renewed = within(sent()).getByRole("group", { name: "Convite para rafa@acme.com.br" });
    expect(renewed.textContent).toMatch(/Mandado de novo · vale até \d+ \S+/);
    expect(within(renewed).getByRole("button", { name: "Copiar link" })).toBeTruthy();
    expect(state.invitations.find((i) => i.id === "inv-old")?.url).toBe("http://localhost:3000/invite/tok-inv-old");
  });
});

describe("Criar agente", () => {
  test("role presets, validation, and creation in the chosen channels", async () => {
    const { state } = await go("agents/new");
    expect(screen().getByRole("heading", { level: 1, name: "Qual vai ser a função?" })).toBeTruthy();
    // The page says what the button that opened it said.
    expect(document.querySelector(".newag__rail-title b")?.textContent).toBe("Criar agente");
    await click(screen().getByRole("button", { name: /^Dev/ }));
    await click(screen().getByRole("button", { name: "Continuar" }));
    // Dev starts as Ada, and @ada is taken: renamed here.
    await type(screen().getByLabelText("Nome"), "Íris");
    await type(screen().getByLabelText("No chat"), "iris");
    expect(screen().getByText("Mencione @iris para chamar.")).toBeTruthy();
    await click(screen().getByRole("button", { name: "Continuar" }));
    expect((screen().getByLabelText("Instruções") as HTMLTextAreaElement).value).toStartWith(
      "Investiga primeiro: lê o código e as tarefas e erros relacionados antes de responder",
    );
    for (let i = 0; i < 3; i++) await click(screen().getByRole("button", { name: "Continuar" }));
    await type(screen().getByLabelText("Orçamento mensal (US$)"), "0");
    await click(screen().getByRole("button", { name: "Continuar" }));
    expect(screen().getAllByText("Use um valor maior que zero.").length).toBeGreaterThan(0);
    await type(screen().getByLabelText("Orçamento mensal (US$)"), "25");
    await click(screen().getByRole("button", { name: "Continuar" }));
    await click(screen().getByRole("button", { name: "Criar Íris" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "agents.create")?.args[1]).toMatchObject({
      name: "Íris",
      handle: "iris",
      role: "Dev",
      model: "auto",
      ownerUserId: "u-walter",
      // "Chave padrão do workspace".
      credentialId: null,
      monthlyBudgetUsd: 25,
    });
    expect(state.calls.find((c) => c.method === "agents.setChannels")?.args[2]).toEqual([{ channelId: ENG_ID }]);
    // Dev writes on GitHub: one write, after creation.
    const access = state.calls.filter((c) => c.method === "access.set");
    expect(access).toHaveLength(1);
    expect((access[0]?.args[2] as { connectors?: Record<string, boolean> } | undefined)?.connectors).toEqual({
      "conn-gh": true,
    });
    expect(screen().getByRole("heading", { name: "Íris entrou no time" })).toBeTruthy();
    expect(document.body.textContent).toContain("Já está em #eng. Mencione @iris numa conversa para começar.");
    expect(screen().getByRole("link", { name: "Ir para o #eng" })).toBeTruthy();
  });

  test("members can't create agents", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go("agents/new", state);
    expect(document.body.textContent).toContain("Só admins e donos criam agentes.");
    expect(screen().queryByRole("navigation")?.textContent).not.toContain("Criar agente");
  });
});

describe("Equipe (ADR 0148)", () => {
  afterEach(() => localStorage.removeItem("agentes.team.view"));
  const view = async (name: string) => {
    await click(screen().getByRole("radio", { name }));
    await settle(3);
  };
  const rows = () =>
    [...document.querySelectorAll(".team-table tbody tr.team-table__row")].map(
      (r) => r.querySelector(".team-who b")?.textContent,
    );

  test("Lista: each agent with its role, who looks after it, where it is and what it does now", async () => {
    const state = seedState({
      aiStatus: {
        any: true,
        agents: [
          { agentId: ADA_ID, state: "ready" },
          { agentId: ATLAS_ID, state: "no_ai", reason: "no_key" },
        ],
      },
    });
    state.approvals = state.approvals.filter((a) => a.agentId !== ATLAS_ID);
    await go("team", state);
    expect(screen().getByRole("heading", { name: "Equipe" })).toBeTruthy();
    // Its count on the title's row.
    const count = document.querySelector(".ac-pagehead__titleline > .ac-pagehead__count");
    expect(count?.textContent).toBe("2 pessoas · 2 agentes · 0 setores");
    // The same action as the sidebar's, in the same words.
    const head = document.querySelector(".ac-pagehead") as HTMLElement;
    // It opens the new agent's dialog over the page (ADR 0164).
    expect(within(head).getByRole("button", { name: "Criar agente" })).toBeTruthy();
    const table = screen().getByRole("table");
    const ada = within(table).getByRole("link", { name: /Ada/ }).closest("tr") as HTMLElement;
    expect(ada.textContent).toContain("Dev");
    expect(ada.textContent).toContain("João");
    expect(ada.textContent).toContain("eng");
    // The fixture's request waits for Walter: that is what Ada is on now.
    expect(ada.textContent).toContain("Esperando você");
    const atlas = within(table).getByRole("link", { name: /Atlas/ }).closest("tr") as HTMLElement;
    expect(within(atlas).getByRole("button", { name: "Sem IA" })).toBeTruthy();
    expect(atlas.textContent).not.toContain("Disponível");
  });

  test("without Ver todos os agentes, a member's Equipe and its counts name only the agents that answer them", async () => {
    const member = (keyOn: boolean, personal = false) => {
      const state = seedState();
      const org = state.me?.organizations[0];
      if (org) org.role = "member";
      const ada = state.agents.find((a) => a.id === ADA_ID);
      if (ada) ada.audience = personal ? { mode: "owner", userIds: [] } : { mode: "people", userIds: ["u-someone"] };
      state.agentGroups = [
        { id: "g-team", name: "Time", agentIds: [ATLAS_ID] },
        { id: "g-private", name: "Privado", agentIds: [ADA_ID] },
      ];
      state.roles = seedRoles().map((r) =>
        r.kind === "everyone" && !keyOn
          ? { ...r, permissions: r.permissions.filter((k) => k !== "view_all_agents") }
          : r,
      );
      return state;
    };
    const count = () => document.querySelector(".ac-pagehead__titleline > .ac-pagehead__count")?.textContent;
    // Someone else's private agent (it answers only its owner) stays unlisted even with the key.
    await go("team", member(true, true));
    expect(count()).toBe("2 pessoas · 1 agente · 1 setor");
    expect(rows()).toEqual(["Atlas"]);
    cleanup();
    // On for Todos by default: every other agent, as before.
    await go("team", member(true));
    expect(count()).toBe("2 pessoas · 2 agentes · 2 setores");
    expect(rows()).toEqual(["Atlas", "Ada"]);
    cleanup();
    await go("team", member(false));
    expect(count()).toBe("2 pessoas · 1 agente · 1 setor");
    expect(rows()).toEqual(["Atlas"]);
    await view("Setores");
    const sectors = screen().getByRole("region", { name: "Setores" });
    expect(sectors.textContent).toContain("Time");
    expect(sectors.textContent).not.toContain("Privado");
  });

  test("Lista: search by name, role or channel, filter, and sort by a column", async () => {
    await go("team");
    expect(rows()).toEqual(["Ada", "Atlas"]);
    await act(async () =>
      fireEvent.change(screen().getByRole("searchbox", { name: "Buscar no time" }), {
        target: { value: "ops" },
      }),
    );
    expect(rows()).toEqual(["Atlas"]);
    await act(async () =>
      fireEvent.change(screen().getByRole("searchbox", { name: "Buscar no time" }), {
        target: { value: "" },
      }),
    );
    // Walter looks after none of them.
    await click(screen().getByRole("button", { name: /^Meus/ }));
    expect(rows()).toEqual([]);
    expect(screen().getByText("Nenhum agente encontrado.")).toBeTruthy();
    await click(screen().getByRole("button", { name: /^Meus/ }));
    await click(screen().getByRole("button", { name: "Agente" }));
    expect(rows()).toEqual(["Atlas", "Ada"]);
  });

  test("the agent waiting for its computer reads neither Available nor No AI", async () => {
    await go("team", seedState({ aiStatus: { any: true, agents: [{ agentId: ADA_ID, state: "waiting" }] } }));
    const ada = within(screen().getByRole("table")).getByRole("link", { name: /Ada/ }).closest("tr") as HTMLElement;
    expect(ada.textContent).not.toContain("Disponível");
    expect(within(ada).queryByRole("button", { name: "Sem IA" })).toBeNull();
  });

  test("Organograma: the workspace on top, each person with the agents that report to them", async () => {
    await go("team");
    await view("Organograma");
    const chart = screen().getByRole("region", { name: "Organograma" });
    expect(chart.querySelector(".team-node--org")?.textContent).toContain("Acme");
    const joao = [...chart.querySelectorAll(".team-tree__col")].find((c) => c.textContent?.includes("João"));
    expect([...(joao?.querySelectorAll(".team-node--agent b") ?? [])].map((b) => b.textContent)).toEqual([
      "Ada",
      "Atlas",
    ]);
  });

  test("Mapa: a column per channel; dropping an agent on another channel asks the right hand for a card", async () => {
    const { state } = await go("team");
    await view("Mapa");
    const map = screen().getByRole("region", { name: "Mapa" });
    const eng = within(map).getByRole("region", { name: "#eng" });
    expect([...eng.querySelectorAll(".team-map__card b")].map((b) => b.textContent)).toEqual(["Ada", "Atlas"]);
    expect(map.querySelector(".team-map__people")?.textContent).toContain("João");
    const ada = eng.querySelector(".team-map__card") as HTMLElement;
    const general = map.querySelector('[data-map-col="00000000-0000-4000-8000-0000000000c1"]') as HTMLElement;
    const dataTransfer = { setData: () => {}, getData: () => "", effectAllowed: "", dropEffect: "" };
    await act(async () => fireEvent.dragStart(ada, { dataTransfer }));
    await act(async () => fireEvent.dragOver(general, { dataTransfer }));
    expect(general.getAttribute("data-drop")).toBe("true");
    await act(async () => fireEvent.drop(general, { dataTransfer }));
    await settle(3);
    expect(state.calls.filter((c) => c.method === "agents.proposeChannelMove").map((c) => c.args[1])).toEqual([
      {
        agentId: ADA_ID,
        fromChannelId: ENG_ID,
        toChannelId: "00000000-0000-4000-8000-0000000000c1",
        reason: "Levar Ada de #eng para #general, pelo mapa da equipe.",
      },
    ]);
    // Nothing moved: the change waits on the card.
    expect(state.calls.some((c) => c.method === "agentGroups.move")).toBe(false);
  });

  test("Governança e uso: Settings' use per person, with the way to Settings", async () => {
    await go("team");
    await view("Governança e uso");
    const usage = screen().getByRole("region", { name: "Governança e uso" });
    expect(
      within(usage)
        .getByRole("link", { name: /Também nas Configurações/ })
        .getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/settings/usage`);
    await settle(4);
    expect(usage.textContent).toContain("Uso por pessoa");
  });

  test("the view chosen stays for the next visit", async () => {
    await go("team");
    await view("Setores");
    cleanup();
    await go("team");
    expect(screen().getByRole("radio", { name: "Setores" }).getAttribute("aria-checked")).toBe("true");
  });
});
