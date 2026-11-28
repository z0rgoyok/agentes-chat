import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Proposal } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/** A proposal Atlas made in the chat, still being reviewed: Ada's instructions unless `patch` says otherwise. */
const row = (id: string, patch: Partial<Proposal> = {}): Proposal => ({
  id,
  agentId: ADA_ID,
  proposedByAgentId: ATLAS_ID,
  target: { type: "agent_instructions", agentId: ADA_ID },
  title: "Update Ada's instructions",
  why: "Pedido na conversa.",
  evidence: [],
  before: "Seja breve.",
  after: "Seja breve.\n\n## Learned\n- Responder em português.",
  status: "pending",
  stale: false,
  canDecide: true,
  decider: { type: "admins" },
  createdAt: new Date().toISOString(),
  decidedBy: null,
  decidedByAgent: null,
  review: null,
  reviewed: false,
  undoable: false,
  undoneBy: null,
  undoneAt: null,
  decidedAt: null,
  ...patch,
});
/** What Atlas's review decided (ADR 0219): applied, and the viewer may undo it, unless `patch` says otherwise. */
const reviewed = (patch: Partial<Proposal> = {}): Partial<Proposal> => ({
  status: "accepted",
  reviewed: true,
  decidedByAgent: { agentId: ATLAS_ID, name: "Atlas" },
  review: "Uma preferência clara do time, que ainda não estava nas instruções.",
  undoable: true,
  decidedAt: new Date().toISOString(),
  ...patch,
});
const leftOut = (): Partial<Proposal> =>
  reviewed({ status: "refused", undoable: false, review: "Já está dito nas instruções." });
const atlas = (id: string, patch: Partial<Proposal> = {}) =>
  row(id, { agentId: ATLAS_ID, target: { type: "agent_instructions", agentId: ATLAS_ID }, ...patch });
const adaRole = (id: string, patch: Partial<Proposal> = {}) =>
  row(id, { target: { type: "agent_role", agentId: ADA_ID }, before: "Dev", after: "Revisora de código", ...patch });

/** #eng with Atlas's reply carrying the card for `proposals` (`meta.memoryUpdates`). */
async function openCard(proposals: Proposal[], tweak: (api: ReturnType<typeof createFakeApi>) => void = () => {}) {
  const state = seedState();
  state.proposals = proposals;
  const ids = proposals.map((p) => p.id);
  state.messages.push({
    id: "msg-card",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ATLAS_ID },
    body: "Pronto, deixei a proposta.",
    mentionedAgentIds: [],
    agentRunId: "r-card",
    meta: {
      memoryUpdates: [
        {
          action: "proposed",
          itemId: ids[0],
          text: "Responder em português.",
          requestedByUserId: "u-walter",
          proposalId: ids[0],
          proposalIds: ids,
          canDecide: true,
        },
      ],
    },
    createdAt: new Date().toISOString(),
  });
  const api = createFakeApi(state);
  tweak(api);
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return state;
}
/** The list holds only the newest proposals, and the card's are past it: only a read by id finds them. */
const pastTheList = (api: ReturnType<typeof createFakeApi>) => {
  const list = api.proposals.list;
  api.proposals.list = async (orgId, filter) => (filter?.ids ? list(orgId, filter) : []);
};
type Calls = { calls: { method: string; args: unknown[] }[] };
const undone = (state: Calls) => state.calls.filter((c) => c.method === "proposals.undo").map((c) => c.args[1]);
/** Nobody decides a proposal in the chat any more (ADR 0219): none of the old decision's calls. */
const decided = (state: Calls) =>
  state.calls.filter((c) => ["proposals.accept", "proposals.refuse", "proposals.ask"].includes(c.method));
const click = (el: HTMLElement) => act(async () => fireEvent.click(el));
const one = () => screen().getByRole("group", { name: "Proposta de mudança de Atlas" });
const many = () => screen().getByRole("group", { name: "Proposta de mudança de Atlas para 2 agentes" });
/** How the card ended, without the review's line under it. */
const ending = (card: HTMLElement) => card.querySelector(".rq__answer-text")?.firstChild?.textContent;
/** Nothing on a card to decide it with: no Accept, Refuse, Edit or "Ask an admin", no switches. */
function noDecision(card: HTMLElement) {
  for (const name of [/^Aceitar/, /^Recusar/, "Editar", "Pedir a um admin"])
    expect(within(card).queryByRole("button", { name })).toBeNull();
  expect(within(card).queryByRole("switch")).toBeNull();
}

describe("a skill proposed in the chat", () => {
  const skill = (id: string, patch: Partial<Proposal> = {}) =>
    row(id, {
      target: { type: "skill", agentId: ADA_ID, skillId: "sk-1", name: "relatorios" },
      before: "# Relatórios\n1. Abrir a planilha.",
      after: "# Relatórios\n1. Abrir a planilha.\n2. Conferir os totais.",
      whyCode: "skill",
      ...patch,
    });

  test("while the review weighs it the card says so and shows the change, with nothing to decide", async () => {
    const state = await openCard([skill("p-skill")]);
    const card = one();
    expect(card.querySelector(".rq__state--other")?.textContent).toBe("Avaliando…");
    expect(card.classList.contains("rq--ended")).toBe(false);
    expect(card.textContent).toContain("relatorios");
    expect(card.querySelector(".rq__wt")?.textContent).toContain("Conferir os totais.");
    await click(within(card).getByRole("button", { name: "Ver a mudança" }));
    expect(card.querySelector(".ac-diff__block--add")?.textContent).toContain("Conferir os totais.");
    noDecision(card);
    expect(within(card).queryByRole("button", { name: "Desfazer" })).toBeNull();
    expect(decided(state)).toEqual([]);
  });

  test("applied by the review: who applied it, the review's why, and Undo puts it back", async () => {
    const state = await openCard([skill("p-skill", reviewed())]);
    const card = one();
    expect(card.classList.contains("rq--ended")).toBe(true);
    expect(card.querySelector(".rq__state--other")).toBeNull();
    expect(card.querySelector(".rq-done__mark[data-done]")).not.toBeNull();
    expect(ending(card)).toBe("Aplicado pelo Atlas");
    expect(card.querySelector(".rq__answer-note")?.textContent).toBe(
      "Uma preferência clara do time, que ainda não estava nas instruções.",
    );
    noDecision(card);
    await click(within(card).getByRole("button", { name: "Desfazer" }));
    await settle(4);
    expect(undone(state)).toEqual(["p-skill"]);
    expect(decided(state)).toEqual([]);
    // Put back: the same card says who did it, with nothing left to undo.
    const back = one();
    expect(ending(back)).toBe("Desfeito por você");
    expect(back.querySelector(".rq-done__mark[data-done]")).toBeNull();
    expect(within(back).queryByRole("button", { name: "Desfazer" })).toBeNull();
  });

  test("left out by the review, whoever may make it applies it in one tap", async () => {
    const state = await openCard([skill("p-skill", { ...leftOut(), applicable: true })]);
    const card = one();
    expect(ending(card)).toBe("Não aplicado pelo Atlas");
    await click(within(card).getByRole("button", { name: "Aplicar mesmo assim" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "proposals.accept").map((c) => c.args[1])).toEqual(["p-skill"]);
    expect(ending(one())).toBe("Aplicado por você");
    expect(within(one()).queryByRole("button", { name: "Aplicar mesmo assim" })).toBeNull();
  });

  test("left out, and the viewer can't make it: nothing to apply", async () => {
    await openCard([skill("p-skill", leftOut())]);
    expect(within(one()).queryByRole("button", { name: "Aplicar mesmo assim" })).toBeNull();
  });
});

describe("a change proposed in the chat, one row", () => {
  test("Undo shows only while the viewer may put it back", async () => {
    await openCard([adaRole("p-role", reviewed({ undoable: false }))]);
    const card = one();
    expect(ending(card)).toBe("Aplicado pelo Atlas");
    expect(within(card).queryByRole("button", { name: "Desfazer" })).toBeNull();
  });

  test("left out by the review: it says so and why, and there is nothing to undo", async () => {
    await openCard([adaRole("p-role", leftOut())]);
    const card = one();
    expect(card.classList.contains("rq--ended")).toBe(true);
    expect(card.querySelector(".rq-done__mark[data-done]")).toBeNull();
    expect(ending(card)).toBe("Não aplicado pelo Atlas");
    expect(card.querySelector(".rq__answer-note")?.textContent).toBe("Já está dito nas instruções.");
    expect(within(card).queryByRole("button", { name: "Desfazer" })).toBeNull();
    noDecision(card);
  });

  test("a workspace-wide lesson no agent holds reads as applied automatically", async () => {
    await openCard([
      row("p-context", { agentId: ATLAS_ID, target: { type: "org_context" }, ...reviewed({ decidedByAgent: null }) }),
    ]);
    expect(ending(one())).toBe("Aplicado automaticamente");
  });

  test("a new role reads as proposed, with no Edit", async () => {
    await openCard([adaRole("p-role")]);
    const card = one();
    // A title of its own starts with a capital: "função da Ada" is written to follow "propõe ·".
    expect(card.querySelector(".rq__wt b")?.textContent).toBe("Função da Ada");
    expect(card.textContent).toContain("Mudar a função da Ada");
    expect(card.textContent).toContain("Função: Dev → Revisora de código");
    noDecision(card);
  });

  test("an agent's instructions: the well's title starts with a capital", async () => {
    await openCard([atlas("p-inst")]);
    expect(one().querySelector(".rq__wt b")?.textContent).toBe("Instruções do Atlas");
  });

  test("a card of one row reads it by id too", async () => {
    await openCard([adaRole("p-role")], pastTheList);
    expect(one().textContent).toContain("Função: Dev → Revisora de código");
  });

  test("Undo on a role reads the agents again", async () => {
    let reads = 0;
    const counting = (api: ReturnType<typeof createFakeApi>) => {
      const list = api.agents.list;
      api.agents.list = async (orgId) => {
        reads += 1;
        return list(orgId);
      };
    };
    const state = await openCard([adaRole("p-role", reviewed())], counting);
    const before = reads;
    await click(within(one()).getByRole("button", { name: "Desfazer" }));
    await settle(4);
    expect(undone(state)).toEqual(["p-role"]);
    expect(reads).toBeGreaterThan(before);
  });
});

describe("a change proposed for several agents in the chat", () => {
  test("while the review weighs them: the change once, a row per agent saying so, nothing to decide", async () => {
    const state = await openCard([row("p-ada"), atlas("p-atlas")]);
    const card = many();
    expect(card.textContent).toContain("Atlas propõe · instruções de 2 agentes");
    expect(card.querySelector(".rq__state--other")?.textContent).toBe("Avaliando…");
    // The change once, behind "See the change", its first line in the well.
    expect(card.querySelector(".rq__wt")?.textContent).toContain("Responder em português.");
    await click(within(card).getByRole("button", { name: "Ver a mudança" }));
    expect(card.querySelectorAll(".ac-diff")).toHaveLength(1);
    // The added lines as Markdown: a list item, not its "- ".
    const added = card.querySelector(".ac-diff__block--add:last-child");
    expect(added?.querySelector("li")?.textContent).toBe("Responder em português.");
    expect([...card.querySelectorAll(".proposal-row__name")].map((s) => s.textContent)).toEqual(["Ada", "Atlas"]);
    expect([...card.querySelectorAll(".proposal-row__status")].map((s) => s.textContent)).toEqual([
      "Avaliando…",
      "Avaliando…",
    ]);
    noDecision(card);
    expect(decided(state)).toEqual([]);
  });

  test("rows the review applied alike: the footer says so once, each row its own why and Undo", async () => {
    const state = await openCard([
      row("p-ada", reviewed({ review: "Vale para a Ada." })),
      atlas("p-atlas", reviewed({ review: "Vale para o Atlas." })),
    ]);
    const card = many();
    expect(card.classList.contains("rq--ended")).toBe(true);
    expect(card.querySelector(".rq__lead")?.textContent).toBe("Atlas propõe · instruções de 2 agentes");
    expect(card.querySelector(".rq__answer-text")?.textContent).toBe("Aplicado pelo Atlas");
    expect(card.querySelector(".rq-done__mark[data-done]")).not.toBeNull();
    expect([...card.querySelectorAll(".proposal-row__status")].map((s) => s.textContent)).toEqual([
      "Aplicado pelo Atlas",
      "Aplicado pelo Atlas",
    ]);
    expect([...card.querySelectorAll(".proposal-row__why")].map((s) => s.textContent)).toEqual([
      "Vale para a Ada.",
      "Vale para o Atlas.",
    ]);
    noDecision(card);
    const undos = within(card).getAllByRole("button", { name: "Desfazer" });
    expect(undos).toHaveLength(2);
    await click(undos[1] as HTMLElement);
    await settle(4);
    expect(undone(state)).toEqual(["p-atlas"]);
    // One put back, one still applied: the footer counts, each row says how it ended.
    const after = many();
    expect(after.querySelector(".rq__answer-text")?.textContent).toBe("1 de 2 aplicadas");
    expect([...after.querySelectorAll(".proposal-row__status")].map((s) => s.textContent)).toEqual([
      "Aplicado pelo Atlas",
      "Desfeito por você",
    ]);
    expect(within(after).getAllByRole("button", { name: "Desfazer" })).toHaveLength(1);
  });

  test("rows that ended apart: applied, left out and overtaken each say so, Undo only where it applies", async () => {
    await openCard([row("p-ada", reviewed()), atlas("p-atlas", leftOut()), adaRole("p-role", { stale: true })]);
    const card = many();
    expect(card.textContent).toContain("Atlas propõe · mudanças em 2 agentes");
    expect(card.textContent).toContain("Função: Dev → Revisora de código");
    expect(card.querySelector(".rq__answer-text")?.textContent).toBe("1 de 3 aplicadas");
    expect([...card.querySelectorAll(".proposal-row__status")].map((s) => s.textContent)).toEqual([
      "Aplicado pelo Atlas",
      "Não aplicado pelo Atlas",
      "Ficou velha",
    ]);
    expect(within(card).getAllByRole("button", { name: "Desfazer" })).toHaveLength(1);
  });

  test("a card reads its rows by id: older than the newest proposals the list holds, it still shows whole", async () => {
    await openCard([row("p-ada"), atlas("p-atlas")], pastTheList);
    const card = many();
    expect([...card.querySelectorAll(".proposal-row__name")].map((s) => s.textContent)).toEqual(["Ada", "Atlas"]);
  });
});
