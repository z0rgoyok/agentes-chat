import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type ApiClient, ApiError, type Message, type WorkspaceActionCard } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ADA_ID,
  ADMIN_ROLE_ID,
  createFakeApi,
  type FakeState,
  LODI_ID,
  meWithRole,
  ORG_ID,
  seedDm,
  seedState,
  withRightHand,
} from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

/** The right hand's cards for the rest of the app (ADR 0137 §4): approvals, people, and any screen. */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const DM = `dm-${LODI_ID}`;

/** A card of Lodi's in its DM, `ago` ms old. A second card joins the same DM: Lodi and the DM are seeded once. */
const withLodiCard = (
  state: FakeState,
  actionCard: Record<string, unknown> | WorkspaceActionCard,
  id = "m-card",
  ago = 60_000,
) => {
  if (!state.agents.some((a) => a.id === LODI_ID)) {
    withRightHand(state);
    seedDm(state, { type: "agent", id: LODI_ID });
  }
  const message: Message = {
    id,
    channelId: DM,
    threadId: null,
    author: { type: "agent", id: LODI_ID },
    body: "",
    mentionedAgentIds: [],
    agentRunId: `r-${id}`,
    meta: { actionCard },
    createdAt: new Date(Date.now() - ago).toISOString(),
  };
  state.messages.push(message);
  return state;
};

const go = async (state: FakeState) => {
  const r = await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const click = async (el: HTMLElement, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};

describe("approvals waiting for you", () => {
  test("each approval as the conversation shows it; the click decides it, sent with the card for the audit", async () => {
    const state = withLodiCard(seedState(), {
      kind: "approvals",
      forUserId: "u-walter",
      params: { approvalIds: ["ap-merge"], why: "O merge da Ada espera você." },
    });
    await go(state);
    const group = screen().getByRole("group", { name: "Aprovações esperando você" });
    expect(group.textContent).toContain("O merge da Ada espera você.");
    expect(group.textContent).toContain("Fazer um merge");
    await click(within(group).getByRole("button", { name: "Aprovar merge" }));
    expect(state.calls.find((c) => c.method === "approvals.approve")?.args.slice(0, 2)).toEqual([ORG_ID, "ap-merge"]);
    expect(state.calls.find((c) => c.method === "via")?.args).toEqual(["m-card"]);
    expect(screen().getByRole("group", { name: "Aprovações esperando você" }).textContent).toContain(
      "Aprovado por você",
    );
  });
});

describe("changing people", () => {
  const card = {
    kind: "member_changes",
    forUserId: "u-walter",
    params: {
      rows: [
        { userId: "u-joao", name: "João", role: "owner" },
        { userId: "u-joao", name: "João", remove: true },
      ],
      why: "O João assume a conta.",
    },
  };

  test("a row per change, applied with the members' own calls; removing asks as the members screen does", async () => {
    const state = withLodiCard(seedState(), card);
    await go(state);
    const c = screen().getByRole("group", { name: "Mudar pessoas" });
    expect(c.textContent).toContain("O João assume a conta.");
    expect(c.textContent).toContain("Ganha Dono");
    expect(c.textContent).toContain("Remover do workspace");
    await click(within(c).getByRole("button", { name: "Aplicar" }));
    expect(state.calls.find((x) => x.method === "orgs.changeRole")?.args).toEqual([ORG_ID, "u-joao", "owner"]);
    expect(state.calls.filter((x) => x.method === "via").map((x) => x.args[0])).toEqual(["m-card"]);
    // Nothing goes before the members screen's confirmation.
    await click(
      within(screen().getByRole("group", { name: "Mudar pessoas" })).getByRole("button", {
        name: "Remover do workspace",
      }),
    );
    expect(state.calls.some((x) => x.method === "orgs.removeMember")).toBe(false);
    const dialog = screen().getByRole("dialog");
    await click(within(dialog).getByRole("button", { name: "Remover João" }));
    expect(state.calls.find((x) => x.method === "orgs.removeMember")?.args).toEqual([ORG_ID, "u-joao"]);
    // Every row done: the same card, each row saying so, nothing left to press.
    const over = screen().getByRole("group", { name: "Mudar pessoas" });
    expect(over.classList.contains("rq--ended")).toBe(true);
    expect([...over.querySelectorAll(".proposal-row__status")].map((s) => s.textContent)).toEqual(["Feito", "Feito"]);
    expect(within(over).queryByRole("button")).toBeNull();
  });

  test("a member reads that only owners change who is an owner, with no button", async () => {
    const state = withLodiCard(seedState(), {
      ...card,
      params: { ...card.params, rows: [{ userId: "u-joao", name: "João", role: "owner" }] },
    });
    meWithRole(state, []);
    await go(state);
    const c = screen().getByRole("group", { name: "Mudar pessoas" });
    expect(c.textContent).toContain("Só donos mudam quem é dono");
    expect(within(c).queryByRole("button", { name: "Aplicar" })).toBeNull();
  });

  test("roles given and taken read their names", async () => {
    const state = withLodiCard(seedState(), {
      ...card,
      params: {
        ...card.params,
        rows: [{ userId: "u-joao", name: "João", addRoleIds: [], removeRoleIds: [ADMIN_ROLE_ID] }],
      },
    });
    await go(state);
    const c = screen().getByRole("group", { name: "Mudar pessoas" });
    expect(c.textContent).toMatch(/Perde Admin/);
    await click(within(c).getByRole("button", { name: "Aplicar" }));
    expect(state.calls.find((x) => x.method === "roles.setFor")?.args).toEqual([ORG_ID, "u-joao", []]);
  });
});

describe("opening a screen", () => {
  test("Abrir goes to the screen, which asks what it always asks; an agent's page by its name", async () => {
    const state = withLodiCard(seedState(), {
      kind: "open_page",
      forUserId: "u-walter",
      params: { page: "delete_workspace", why: "Para apagar o workspace, confirme lá." },
    });
    withLodiCard(
      state,
      {
        kind: "open_page",
        forUserId: "u-walter",
        params: { page: "agent", agentId: ADA_ID, why: "As instruções dela." },
      },
      "m-ada",
      // A minute older than the delete card: by a clock alone the two can fall in the same millisecond or not.
      120_000,
    );
    const { router } = await go(state);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Apagar workspace");
    expect(text).toContain("Para apagar o workspace, confirme lá.");
    expect(text).toContain("As instruções dela.");
    // The delete card is the newer one.
    const del = screen().getAllByRole("button", { name: "Abrir" }).at(-1);
    if (!del) throw new Error("no Abrir");
    await click(del);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/general`);
    expect(router.state.location.search).toMatchObject({ delete: 1 });
  });

  test("who can't use the screen reads it, with no button", async () => {
    const state = withLodiCard(seedState(), {
      kind: "open_page",
      forUserId: "u-walter",
      params: { page: "roles", why: "Os cargos." },
    });
    meWithRole(state, []);
    await go(state);
    expect(document.body.textContent).toContain("Você não tem acesso a esta tela");
    expect(screen().queryByRole("button", { name: "Abrir" })).toBeNull();
  });
});

describe("a change in the workspace that names all it does", () => {
  const invite = (words: Record<string, string> = {}): WorkspaceActionCard => ({
    kind: "workspace_action",
    forUserId: "u-walter",
    params: {
      action: "invite_people",
      input: { emails: ["ana@example.com", "bia@example.com"], roleIds: ["r-vendas"], roleNames: ["Vendas"] },
      words: { emails: "ana@example.com, bia@example.com", roles: "Vendas", ...words },
      needs: "invite_people",
      why: "As duas novas vendedoras.",
    },
    state: "pending",
    decidedByUserId: null,
    decidedAt: null,
  });
  const removeKey: WorkspaceActionCard = {
    ...invite(),
    params: {
      action: "remove_ai_key",
      input: { credentialId: "k-old", name: "Chave antiga" },
      words: { name: "Chave antiga", provider: "DeepSeek" },
      needs: "manage_credentials",
      why: "Ninguém usa mais.",
    },
  };

  /** The app over a server whose card routes answer `applied` (what the click got back). */
  const goWith = async (state: FakeState, applied: WorkspaceActionCard) => {
    const api: ApiClient = {
      ...createFakeApi(state),
      actionCards: {
        get: async (_orgId, messageId) => ({ messageId, channelId: DM, threadId: null, card: applied }),
        decide: async (...args) => {
          state.calls.push({ method: "actionCards.decide", args });
          return { card: applied };
        },
      },
    };
    await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api });
    await settle(8);
  };
  const cardGroup = () => screen().getByRole("group", { name: "Mudança no workspace" });

  test("an invite reads every address and role before the tap; applied, who was left out and why", async () => {
    const state = withLodiCard(seedState(), invite());
    await goWith(state, {
      ...invite({ invited: "ana@example.com", already_invited: "bia@example.com", already_member: "" }),
      state: "applied",
      decidedByUserId: "u-walter",
      decidedAt: new Date().toISOString(),
    });
    const c = cardGroup();
    expect(c.textContent).toContain("As duas novas vendedoras.");
    expect(c.querySelector(".rq__wt b")?.textContent).toBe(
      "Convidar ana@example.com, bia@example.com para o workspace.",
    );
    // Its role is said in words, and the card says it proposes a change while it still does.
    expect(c.querySelector(".rq__wt small")?.textContent).toBe("Com o cargo Vendas.");
    expect(c.querySelector(".rq__kind")?.textContent).toBe("Propõe uma mudança");
    // Nothing is sent before the tap, and the tap says which action this app showed.
    expect(state.calls.some((x) => x.method === "actionCards.decide")).toBe(false);
    await click(within(c).getByRole("button", { name: "Aplicar" }));
    expect(state.calls.find((x) => x.method === "actionCards.decide")?.args).toEqual([
      ORG_ID,
      "m-card",
      "apply",
      "invite_people",
    ]);
    const over = cardGroup();
    expect(over.textContent).toContain("Aplicado por você");
    // Applied, the card says what happened, and the address left out is a line of its own that points to no button.
    expect(over.querySelector(".rq__wt b")?.textContent).toBe("Convite enviado para ana@example.com.");
    expect(over.querySelector(".rq__wt small")?.textContent).toBe(
      "Com o cargo Vendas.\nbia@example.com já tinha um convite pendente.",
    );
    expect(within(over).queryByRole("button", { name: "Aplicar" })).toBeNull();
    // Its sentence says what was done: nothing over it still says it proposes a change.
    expect(over.querySelector(".rq__kind")).toBeNull();
  });

  test("who was already invited is read from the answer to their own tap, and stays when the card everyone reads arrives", async () => {
    const state = withLodiCard(seedState(), invite());
    const done = { state: "applied", decidedByUserId: "u-walter", decidedAt: new Date().toISOString() } as const;
    const api: ApiClient = {
      ...createFakeApi(state),
      actionCards: {
        get: async (_orgId, messageId) => ({ messageId, channelId: DM, threadId: null, card: invite() }),
        decide: async () => ({
          card: { ...invite({ invited: "ana@example.com", already_invited: "bia@example.com" }), ...done },
        }),
      },
    };
    const { sockets } = await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api });
    await settle(8);
    const socket = sockets.last();
    await act(async () => socket.open());
    await settle(2);
    await click(within(cardGroup()).getByRole("button", { name: "Aplicar" }));
    // The card as the server stores and announces it: who was invited, and no word of the open invitation.
    await act(async () =>
      socket.push({
        type: "event",
        channelId: DM,
        event: {
          type: "action_card.updated",
          channelId: DM,
          threadId: null,
          messageId: "m-card",
          card: { ...invite({ invited: "ana@example.com" }), ...done },
        },
      }),
    );
    await settle(2);
    expect(cardGroup().textContent).toContain("Aplicado por você");
    expect(cardGroup().querySelector(".rq__wt small")?.textContent).toBe(
      "Com o cargo Vendas.\nbia@example.com já tinha um convite pendente.",
    );
  });

  test("removing an API key names the key and its provider, on a danger button", async () => {
    const state = withLodiCard(seedState(), removeKey);
    await goWith(state, removeKey);
    const c = cardGroup();
    expect(c.querySelector(".rq__wt b")?.textContent).toBe("Apagar a chave de API «Chave antiga».");
    expect(c.querySelector(".rq__wt small")?.textContent).toBe("DeepSeek");
    // The button says what it does, never "Aplicar".
    expect(within(c).queryByRole("button", { name: "Aplicar" })).toBeNull();
    const apply = within(c).getByRole("button", { name: "Apagar" });
    await click(apply);
    expect(state.calls.find((x) => x.method === "actionCards.decide")?.args.slice(2)).toEqual([
      "apply",
      "remove_ai_key",
    ]);
  });

  test("someone else's card says who asked; who can't apply it reads who may, with no button", async () => {
    const state = withLodiCard(seedState(), { ...invite(), forUserId: "u-joao" });
    await goWith(state, invite());
    expect(cardGroup().querySelector(".rq__source")?.textContent).toBe(" · pedido por João");
    expect(within(cardGroup()).getByRole("button", { name: "Aplicar" })).toBeTruthy();
    cleanup();
    const member = withLodiCard(seedState(), { ...invite(), forUserId: "u-joao" });
    meWithRole(member, []);
    await goWith(member, invite());
    expect(cardGroup().textContent).toContain("Só quem pode fazer essa mudança aplica");
    expect(within(cardGroup()).queryByRole("button")).toBeNull();
  });

  test("in the inbox, a tap refused because a role was renamed shows the role as it is now before a second tap", async () => {
    const state = seedState();
    withRightHand(state);
    state.notifications = [
      notification({
        id: "n-invite",
        kind: "change_request",
        waiting: true,
        actors: [{ type: "user", id: "u-joao" }],
        source: { action: "invite_people", messageId: "m-card", agentId: LODI_ID, label: "ana@example.com" },
        latest: { text: "ana@example.com" },
      }),
    ];
    // The server's card: the first tap is refused and rewrites it, as the engine does when a role it names moved.
    let now: WorkspaceActionCard = { ...invite(), forUserId: "u-joao" };
    const api: ApiClient = {
      ...createFakeApi(state),
      actionCards: {
        get: async (_orgId, messageId) => {
          state.calls.push({ method: "actionCards.get", args: [messageId] });
          return { messageId, channelId: "dm-of-joao", threadId: null, card: now };
        },
        decide: async (...args) => {
          state.calls.push({ method: "actionCards.decide", args });
          if (now.params.words.roles === "Vendas") {
            const renamed = invite({ roles: "Diretoria" });
            now = {
              ...renamed,
              forUserId: "u-joao",
              params: { ...renamed.params, input: { ...renamed.params.input, roleNames: ["Diretoria"] } },
            };
            throw new ApiError(409, "action_card.changed", "What this card names changed since it was written.");
          }
          now = { ...now, state: "applied", decidedByUserId: "u-walter", decidedAt: new Date().toISOString() };
          return { card: now };
        },
      },
    };
    await renderApp(`/org/${ORG_ID}/notifications`, { api });
    await settle(8);
    const row = () => document.querySelector('[data-n="n-invite"]') as HTMLElement;
    expect(row().querySelector(".rq__wt small")?.textContent).toBe("Com o cargo Vendas.");
    await click(within(row()).getByRole("button", { name: "Aplicar" }));
    // Refused, and the card is read again from the server: it names the role it would now give.
    expect(row().querySelector(".rq__wt small")?.textContent).toBe("Com o cargo Diretoria.");
    expect(state.calls.filter((x) => x.method.startsWith("actionCards.")).map((x) => x.method)).toEqual([
      "actionCards.get",
      "actionCards.decide",
      "actionCards.get",
    ]);
    await click(within(row()).getByRole("button", { name: "Aplicar" }));
    expect(row().textContent).toContain("Aplicado por você");
  });

  // Laid out by the geometry check at 1280, 390 and 320: twenty addresses that never break on their own.
  test("who may do one thing, everyone and the roles at once: the permission, who has it after, and the tap says it read it", async () => {
    const holders: WorkspaceActionCard = {
      ...invite(),
      params: {
        action: "set_permission_holders",
        input: {
          row: "create_channels",
          everyone: 0,
          roles: [
            { id: "r-fin", name: "Financeiro", level: 1 },
            { id: "r-sup", name: "Suporte", level: 1 },
          ],
        },
        words: { permission: "create_channels" },
        needs: "manage_roles",
        why: "Só o Financeiro e o Suporte criam canais.",
      },
    };
    const state = withLodiCard(seedState(), holders);
    await goWith(state, holders);
    const c = cardGroup();
    expect(c.querySelector(".rq__wt b")?.textContent).toBe("Mudar quem pode criar canais");
    expect(c.querySelector(".rq__wt small")?.textContent).toBe("Financeiro e Suporte");
    await click(within(c).getByRole("button", { name: "Aplicar" }));
    expect(state.calls.find((x) => x.method === "actionCards.decide")?.args.slice(2)).toEqual([
      "apply",
      "set_permission_holders",
    ]);
  });

  test("the computers' ladder: a line per role with its step, long names and many roles inside the card", async () => {
    const long = "Coordenação de vendas e pós-venda da filial";
    const roles = Array.from({ length: 12 }, (_, i) => ({ id: `r-${i}`, name: `${long} ${i}`, level: (i % 4) + 1 }));
    const ladder: WorkspaceActionCard = {
      ...invite(),
      params: {
        action: "set_permission_holders",
        input: { row: "computers", everyone: 1, roles },
        words: { permission: "computers", variant: "computers" },
        needs: "manage_roles",
        why: "",
      },
    };
    const state = withLodiCard(seedState(), ladder);
    await goWith(state, ladder);
    const c = cardGroup();
    expect(c.querySelector(".rq__wt b")?.textContent).toBe("Mudar quem usa os computadores dos agentes");
    const lines = (c.querySelector(".rq__wt small")?.textContent ?? "").split("\n");
    expect(lines).toHaveLength(13);
    expect(lines[0]).toBe("Todos: usar o navegador dos próprios agentes");
    expect(lines[4]).toBe(`${long} 3: assumir a tela`);
  });

  test("twenty long addresses and long role names stay inside the card", async () => {
    const emails = Array.from(
      { length: 20 },
      (_, i) => `contas-a-receber.filial-norte-sul-leste-${i}@comercial-distribuidora.example.com`,
    );
    const roleNames = ["Coordenação de vendas e pós-venda", "Financeiro e contas a receber"];
    const worst = invite();
    worst.params.input = { emails, roleIds: ["r-1", "r-2"], roleNames };
    worst.params.words = { emails: emails.join(", "), roles: roleNames.join(", ") };
    const state = withLodiCard(seedState(), worst);
    await goWith(state, worst);
    const c = cardGroup();
    expect(c.querySelector(".rq__wt b")?.textContent).toContain(emails[19] ?? "");
    expect(c.querySelector(".rq__wt small")?.textContent).toBe(`Com os cargos ${roleNames.join(" e ")}.`);
  });
});
