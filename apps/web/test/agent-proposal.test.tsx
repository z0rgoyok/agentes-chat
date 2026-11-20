import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentDraft, AgentInput, AgentProposalCard, MailAccount, Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ATLAS_ID,
  createFakeApi,
  ENG_ID,
  fakeMailOf,
  GENERAL_ID,
  meWithRole,
  NOW,
  ORG_ID,
  seedState,
} from "./fake-api";
import { typeIn } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

/** A narrow screen (the new agent's two steps, NEW_AGENT_STEPS_QUERY): only that query matches. */
let media: { mockRestore: () => void } | null = null;
const narrowScreen = () => {
  media = spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: q === "(max-width: 959px)",
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
};

afterEach(() => {
  media?.mockRestore();
  media = null;
  cleanup();
  sessionStorage.clear();
});

type State = ReturnType<typeof seedState>;
const HOUR = 3_600_000;
const DESIGN_ID = "00000000-0000-4000-8000-0000000000c9";

/** Atlas's proposal of Nina in #eng (`meta.actionCard`), as `propose_agent` posts it. */
const proposal = (
  id: string,
  card: Partial<AgentProposalCard> = {},
  draft: Partial<AgentDraft> = {},
  minute = 0,
): Message => ({
  id,
  channelId: ENG_ID,
  threadId: null,
  author: { type: "agent", id: ATLAS_ID },
  body: "Proposed a new agent, Nina: server text",
  mentionedAgentIds: [],
  agentRunId: `r-${id}`,
  meta: {
    bodyCode: "agent_proposal",
    bodyParams: { name: "Nina" },
    actionCard: {
      kind: "agent_proposal",
      forUserId: "u-walter",
      params: {
        draft: {
          name: "Nina",
          handle: "nina",
          role: "Designer",
          instructions: "Desenha as telas.",
          appearance: { color: "rose", eyes: "happy", accessory: "bow" },
          channelIds: [ENG_ID],
          access: [],
          ai: { kind: "model" },
          ...draft,
        },
        why: "Você pediu alguém para o design.",
      },
      state: "pending",
      agentId: null,
      decidedByUserId: null,
      decidedAt: null,
      expiresAt: new Date(Date.now() + 20 * HOUR).toISOString(),
      ...card,
    } satisfies AgentProposalCard,
  },
  createdAt: new Date(NOW.getTime() + minute * 60_000).toISOString(),
});

const click = async (el: HTMLElement, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
/** The proposal in its message: the request card, open or saying what was decided. */
const cardOf = (text: string) =>
  screen()
    .getAllByRole("article")
    .map((a) => a.querySelector<HTMLElement>(".rq"))
    .filter((card): card is HTMLElement => Boolean(card?.textContent?.includes(text)));
const asMember = (state: State) => {
  const org = state.me?.organizations[0];
  if (org) org.role = "member";
};

describe("an agent's proposal of a new agent, in the chat", () => {
  test("a request card: its reason, the draft in the well; Review opens the new agent's dialog over the conversation, Decline says no", async () => {
    const state = seedState();
    state.messages.push(proposal("p-1"));
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const card = screen().getByRole("group", { name: "Atlas propõe um novo agente" });
    // Waiting for who may create agents, like every other request (the bar can bring it back).
    expect(card.getAttribute("data-ask-kind")).toBe("agent");
    expect(card.hasAttribute("data-ask-mine")).toBe(true);
    // Waiting for me needs no words on the card (its buttons say it).
    expect(card.textContent).not.toContain("esperando você");
    for (const shown of [
      "Você pediu alguém para o design.",
      "Nina",
      "@nina · Designer · Pensa pela API",
      "para decidir",
    ])
      expect(card.textContent).toContain(shown);
    expect(card.querySelector(".ac-expiry-fuse")).not.toBeNull();
    expect(card.textContent).not.toContain("server text");
    // Its name on one line, the handle and role on the next: never run together.
    const who = card.querySelector(".rq__wt");
    expect(who?.querySelector(":scope > b")?.textContent).toBe("Nina");
    expect(who?.querySelector(":scope > small")?.textContent).toBe("@nina · Designer · Pensa pela API");
    // Review: the new agent's dialog over the conversation, its card filled in, the proposal beside it.
    await click(within(card).getByRole("button", { name: "Revisar" }), 10);
    const dialog = screen().getByRole("dialog", { name: "Novo agente" });
    expect(within(dialog).getByRole("region", { name: "A proposta" }).textContent).toContain(
      "Você pediu alguém para o design.",
    );
    expect((within(dialog).getByLabelText("Nome") as HTMLInputElement).value).toBe("Nina");
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    await click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(screen().queryByRole("dialog", { name: "Novo agente" })).toBeNull();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    await click(within(card).getByRole("button", { name: "Recusar" }));
    expect(state.calls.some((c) => c.method === "agents.denyProposal" && c.args[1] === "p-1")).toBe(true);
    // Decided: the same card says who decided where its buttons were.
    const after = screen().getByRole("group", { name: "Atlas propõe um novo agente" });
    expect(after.classList.contains("rq--ended")).toBe(true);
    expect(after.querySelector(".rq__wt b")?.textContent).toBe("Nina");
    expect(after.querySelector(".rq__answer-text")?.textContent).toBe("Recusado por você");
    expect(after.querySelector(".rq-done__mark[data-done]")).toBeNull();
    expect(within(after).queryByRole("button", { name: "Recusar" })).toBeNull();
    expect(document.querySelector('[data-ask-id="p-1"]')).toBeNull();
  });

  // Real time passes in it (the request's own timer), so it gets more than the default 5 s.
  test("open until its time, even with no event: then it reads as expired", async () => {
    const state = seedState();
    const expiresAt = Date.now() + 3_000;
    state.messages.push(proposal("p-1", { expiresAt: new Date(expiresAt).toISOString() }));
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    expect(document.querySelector('[data-ask-id="p-1"]')?.hasAttribute("data-ask-mine")).toBe(true);
    // Nothing comes from the server: the card's own timer closes it at that moment.
    await act(() => new Promise((r) => setTimeout(r, Math.max(0, expiresAt - Date.now()) + 50)));
    await settle(2);
    expect(document.querySelector('[data-ask-id="p-1"]')).toBeNull();
    const [card] = cardOf("Nina");
    expect(card?.textContent).toContain("Expirou");
    expect(within(card as HTMLElement).queryByRole("link", { name: "Revisar" })).toBeNull();
  }, 15_000);

  test("read-only for who can't create agents; created links to the agent; expired after a day", async () => {
    const state = seedState();
    asMember(state);
    state.messages.push(
      proposal(
        "p-open",
        {},
        { ai: { kind: "account", brain: "claude_code", machineId: "m-1", accountId: "a-1", label: "Claude Max" } },
      ),
      proposal(
        "p-made",
        { state: "created", agentId: ATLAS_ID },
        { name: "Otto", handle: "otto", ai: { kind: "none" } },
        1,
      ),
      proposal("p-old", { expiresAt: new Date(Date.now() - HOUR).toISOString() }, { name: "Vera", handle: "vera" }, 2),
    );
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const [open] = cardOf("@nina");
    expect(open?.textContent).toContain("Pensa com Claude Max");
    expect(open?.textContent).toContain("Aguardando um admin");
    // Not the viewer's to decide: the bar never brings it back.
    expect(open?.hasAttribute("data-ask-mine")).toBe(false);
    expect(within(open as HTMLElement).queryByRole("link", { name: "Revisar" })).toBeNull();
    expect(within(open as HTMLElement).queryByRole("button", { name: "Recusar" })).toBeNull();
    const [made] = cardOf("Otto");
    expect(made?.textContent).toContain("Criado");
    expect(made?.querySelector(".rq-done__mark[data-done]")).not.toBeNull();
    // The draft and the way to the agent stay on the card.
    expect(made?.textContent).toContain("@otto");
    expect(made?.textContent).toContain("Sem IA ainda. Conecte uma depois de criar");
    expect(
      within(made as HTMLElement)
        .getByRole("link", { name: "Abrir perfil" })
        .getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/agents/${ATLAS_ID}`);
    const [old] = cardOf("Vera");
    expect(old?.textContent).toContain("Expirou");
    expect(old?.querySelector(".rq-done__mark[data-done]")).toBeNull();
    // Refused or expired there is no agent to go to.
    expect(old?.textContent).toContain("@vera");
    expect(within(old as HTMLElement).queryByRole("link", { name: "Abrir perfil" })).toBeNull();
    // In the conversation, the profile opens in the panel beside it.
    await act(async () => fireEvent.click(within(made as HTMLElement).getByRole("link", { name: "Abrir perfil" })));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(screen().getByRole("complementary", { name: "Perfil do Atlas" })).toBeTruthy();
  });

  test("live: decided by someone else, the card changes in place (only the decision comes)", async () => {
    const state = seedState();
    state.messages.push(proposal("p-1"));
    const { sockets } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const socket = sockets.last();
    await act(async () => socket.open());
    await settle(2);
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "agent.proposal.updated",
          channelId: ENG_ID,
          threadId: null,
          messageId: "p-1",
          state: "created",
          agentId: ATLAS_ID,
          decidedByUserId: "u-joao",
          decidedAt: new Date().toISOString(),
        },
      }),
    );
    await settle(3);
    const [card] = cardOf("Nina");
    expect(card?.querySelector(".rq__answer-text")?.textContent).toBe("Criado por João");
    expect(within(card as HTMLElement).queryByRole("link", { name: "Revisar" })).toBeNull();
    expect(
      within(card as HTMLElement)
        .getByRole("link", { name: "Abrir perfil" })
        .getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/agents/${ATLAS_ID}`);
  });
});

describe("one request, one card: what it gets, created in one click", () => {
  const ROUTINE = {
    name: "E-mails do dia",
    prompt: "Lê a caixa de entrada e resume o que chegou.",
    schedule: "todo dia ao meio-dia",
    rule: { freq: "daily" as const, interval: 1, times: ["12:00"], timezone: "America/Sao_Paulo" },
    cron: "0 12 * * *",
    timezone: "America/Sao_Paulo",
    description: "Every day, at 12:00 (Brasília time)",
    report: "when_new" as const,
    access: "read" as const,
  };
  const withLines = (minute = 0) =>
    proposal(
      "p-1",
      {},
      {
        access: [{ connectionId: "conn-gh", level: "read" }],
        mail: [
          { accountId: "mb-w", address: "walter@acme.com.br", level: "read", ownerUserId: "u-walter" },
          { accountId: "mb-j", address: "joao@acme.com.br", level: "write", ownerUserId: "u-joao" },
        ],
        routine: ROUTINE,
      },
      minute,
    );
  // A line's own text (the routine's folded prompt apart).
  const lines = (card: HTMLElement) =>
    [...card.querySelectorAll(".waitcard__lines > li")].map((li) => {
      const line = li.cloneNode(true) as HTMLElement;
      line.querySelector(".waitcard__prompt")?.remove();
      return line.textContent?.replace(/\s+/g, " ").trim();
    });

  test("each line, with who gives it when I can't; Criar makes it as it is and the card says what it got", async () => {
    const state = seedState();
    state.messages.push(withLines());
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const [card] = cardOf("@nina");
    if (!card) throw new Error("no card");
    expect(lines(card)).toEqual([
      "eng",
      "GitHub · só consulta",
      "walter@acme.com.br · só consulta",
      "joao@acme.com.br · consulta e muda · só João libera",
      "E-mails do dia · Todos os dias, às 12:00 (horário de Brasília)",
    ]);
    // What each run is told, folded under its line: one click makes it under my name.
    expect(card.querySelector(".waitcard__prompt")?.textContent).toContain(ROUTINE.prompt);
    await click(within(card).getByRole("button", { name: "Criar Nina" }), 8);
    expect(state.calls.find((c) => c.method === "agents.createProposed")?.args).toEqual([ORG_ID, "p-1"]);
    expect(state.calls.some((c) => c.method === "agents.create")).toBe(false);
    const [made] = cardOf("Nina");
    if (!made) throw new Error("no card");
    expect(made.querySelector(".rq__answer-text")?.textContent).toBe("Criado por você");
    // What it got stays on the card, with the way to the agent.
    expect(within(made).getByRole("link", { name: "Abrir perfil" })).toBeTruthy();
    // What it got takes a check; João's mailbox waits for him.
    const given = [...made.querySelectorAll(".waitcard__lines > li")].map((li) => li.getAttribute("data-given"));
    expect(given).toEqual(["true", "true", "true", "false", "true"]);
    expect(lines(made)[3]).toBe("joao@acme.com.br · consulta e muda · só João libera");
  });

  test("a routine one click couldn't make waits for an admin, and its card makes it once the agent can report", async () => {
    const state = seedState();
    state.messages.push(
      proposal(
        "p-1",
        {
          state: "created",
          agentId: ATLAS_ID,
          decidedByUserId: "u-walter",
          applied: { channelIds: [], connectionIds: [], mailAccountIds: [] },
          routineId: null,
        },
        { routine: { ...ROUTINE, reportsIn: ENG_ID } },
      ),
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const [card] = cardOf("Nina");
    if (!card) throw new Error("no card");
    expect(lines(card).at(-1)).toBe(
      "E-mails do dia · Todos os dias, às 12:00 (horário de Brasília) · um admin libera · não criada",
    );
    await click(within(card).getByRole("button", { name: "Criar a rotina E-mails do dia" }), 6);
    expect(state.calls.find((c) => c.method === "agents.proposalRoutine")?.args).toEqual([ORG_ID, "p-1"]);
    const [made] = cardOf("Nina");
    expect(within(made as HTMLElement).queryByRole("button", { name: "Criar a rotina E-mails do dia" })).toBeNull();
  });

  test("Criar opens Connect when the agent got nothing to think with, whatever the card suggested", async () => {
    const state = seedState();
    state.messages.push(
      proposal(
        "p-1",
        {},
        { ai: { kind: "account", brain: "claude_code", machineId: "m-1", accountId: "a-1", label: "Claude Max" } },
      ),
    );
    // The asker's plan, but whoever clicks has no account of their own free.
    state.proposalAi = "none";
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const [card] = cardOf("@nina");
    if (!card) throw new Error("no card");
    await click(within(card).getByRole("button", { name: "Criar Nina" }), 8);
    expect(screen().getByRole("dialog", { name: /Conectar uma IA/ })).toBeTruthy();
  });

  test("Review, then Create: the routine is made, my mailbox comes at its level, and its chat opens", async () => {
    const state = seedState();
    state.messages.push(withLines());
    const api = createFakeApi(state);
    const fakeMail = fakeMailOf.get(api);
    if (!fakeMail) throw new Error("no mail fake");
    const mailbox = (id: string, address: string): MailAccount => ({
      id,
      provider: "gmail",
      via: "composio",
      address,
      label: address,
      status: "active",
      lastError: null,
      preset: null,
      createdAt: NOW.toISOString(),
      offActions: [],
      askActions: [],
      aliases: [],
      defaultFrom: null,
      ownerUserId: id === "mb-w" ? "u-walter" : "u-joao",
      agents: [],
    });
    fakeMail.accounts = [mailbox("mb-w", "walter@acme.com.br"), mailbox("mb-j", "joao@acme.com.br")];
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    const [card] = cardOf("@nina");
    if (!card) throw new Error("no card");
    await click(within(card).getByRole("button", { name: "Revisar" }), 10);
    const dialog = screen().getByRole("dialog", { name: "Novo agente" });
    // The routine is on the card, to keep or take out; my own mailbox comes at its level, João's is his to give.
    const body = dialog.querySelector(".nac__body")?.textContent ?? "";
    expect(body).toContain("E-mails do dia");
    expect(body).toContain("walter@acme.com.brLê");
    expect(body).not.toContain("joao@acme.com.br");
    await click(within(dialog).getByRole("button", { name: "Criar Nina" }), 12);
    expect(state.calls.find((c) => c.method === "agents.create")?.args[1]).toMatchObject({ proposal: "p-1" });
    expect(state.calls.find((c) => c.method === "agents.proposalRoutine")?.args).toEqual([ORG_ID, "p-1"]);
    // My mailbox at its level; João's isn't mine to give.
    expect(state.calls.filter((c) => c.method === "mail.setAgent").map((c) => c.args.slice(2, 4))).toEqual([
      ["mb-w", expect.objectContaining({ level: "read" })],
    ]);
    expect(screen().queryByRole("dialog", { name: "Novo agente" })).toBeNull();
    expect(router.state.location.pathname).toMatch(new RegExp(`^/org/${ORG_ID}/dm/agent/`));
  });
});

describe("Review: the new agent's card filled in with the proposal", () => {
  /** The proposal's card in #eng, its new agent's dialog open on it. */
  const review = async (state: State, title = "Novo agente") => {
    const rendered = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const [card] = cardOf("@nina");
    if (!card) throw new Error("no card");
    await click(within(card).getByRole("button", { name: "Revisar" }), 10);
    return { ...rendered, dialog: screen().getByRole("dialog", { name: title }) };
  };
  const side = (dialog: HTMLElement) => within(dialog).getByRole("region", { name: "A proposta" });

  test("what is changed shows beside the card with Undo; creating sends the card with the proposal", async () => {
    // No key and no plan: nothing to think with yet, so its chat asks for an AI after.
    const state = seedState({ credentials: [], platformKey: false });
    state.messages.push(
      proposal("p-1", {}, { ai: { kind: "none" }, hello: "Desenho as telas com você.", later: ["sentry"] }),
    );
    const { dialog, router } = await review(state);
    expect(dialog.querySelector(".nac__handle")?.textContent).toBe("No chat: @nina · Designer");
    expect((within(dialog).getByLabelText("O que faz") as HTMLTextAreaElement).value).toBe(
      "Desenho as telas com você.",
    );
    expect(side(dialog).textContent).toContain("Nada ainda.");
    // Left for after it is created: an AI, and the app it needs that isn't connected.
    expect(side(dialog).textContent).toContain("Conectar uma IA para a Nina pensar");
    expect(side(dialog).textContent).toContain("Conectar Sentry");
    // A change, its line, and Undo.
    await typeIn(within(dialog).getByLabelText("Nome"), "Nina Simone");
    await settle(2);
    expect(side(dialog).textContent).toContain("Nome · Nina → Nina Simone");
    await click(within(side(dialog)).getByRole("button", { name: "Desfazer" }));
    expect((within(dialog).getByLabelText("Nome") as HTMLInputElement).value).toBe("Nina");
    expect(side(dialog).textContent).toContain("Nada ainda.");
    await typeIn(within(dialog).getByLabelText("Nome"), "Nina Simone");
    await settle(2);
    await click(within(dialog).getByRole("button", { name: "Criar Nina Simone" }), 12);
    const created = state.calls.find((c) => c.method === "agents.create")?.args[1] as AgentInput | undefined;
    expect(created).toMatchObject({
      name: "Nina Simone",
      role: "Designer",
      instructions: "Desenha as telas.",
      appearance: { color: "rose", eyes: "happy", accessory: "bow" },
      proposal: "p-1",
      setup: { role: null, hello: "Desenho as telas com você.", apps: { sentry: "read" } },
    });
    expect(router.state.location.pathname).toMatch(new RegExp(`^/org/${ORG_ID}/dm/agent/`));
  });

  test("its name kept, it keeps the @ it proposed", async () => {
    const state = seedState();
    state.messages.push(proposal("p-1", {}, { handle: "nina-design" }));
    const { dialog } = await review(state);
    expect(dialog.querySelector(".nac__handle")?.textContent).toBe("No chat: @nina-design · Designer");
    await click(within(dialog).getByRole("button", { name: "Criar Nina" }), 12);
    expect(state.calls.find((c) => c.method === "agents.create")?.args[1]).toMatchObject({ handle: "nina-design" });
  });

  test("its channels change on the card: one taken out, another added, and the agent joins those", async () => {
    const state = seedState();
    state.channels.push({
      id: DESIGN_ID,
      name: "design",
      topic: "Telas e protótipos",
      visibility: "public",
      isMember: false,
      createdAt: NOW.toISOString(),
    });
    state.messages.push(proposal("p-1", {}, { channelIds: [ENG_ID, DESIGN_ID] }));
    const { dialog } = await review(state);
    const chips = () => [...dialog.querySelectorAll(".nac__app")].map((c) => c.textContent);
    expect(chips()).toEqual(expect.arrayContaining(["#eng", "#design"]));
    // A public channel I'm not in, as I arrange channels: what it is about, and taking it out.
    await click(within(dialog).getByRole("button", { name: "#design" }));
    const channel = screen().getByRole("dialog", { name: "#design" });
    expect(channel.textContent).toContain("Telas e protótipos");
    await click(within(channel).getByRole("button", { name: "Tirar do #design" }));
    expect(chips()).not.toContain("#design");
    expect(side(dialog).textContent).toContain("#design · saiu");
    await click(within(dialog).getByRole("button", { name: "Outro canal" }));
    await click(within(dialog).getByRole("button", { name: "#general" }));
    await click(within(dialog).getByRole("button", { name: "Criar Nina" }), 12);
    const joined = state.calls.find((c) => c.method === "agents.setChannels")?.args[2];
    expect(joined).toHaveLength(2);
    expect(joined).toEqual(expect.arrayContaining([{ channelId: GENERAL_ID }, { channelId: ENG_ID }]));
  });

  test("with Create agents alone, a channel it proposes that I'm not in isn't on the card, nor joined", async () => {
    const state = seedState();
    meWithRole(state, ["create_agents"]);
    state.channels.push({
      id: DESIGN_ID,
      name: "design",
      topic: "",
      visibility: "public",
      isMember: false,
      createdAt: NOW.toISOString(),
    });
    state.messages.push(proposal("p-1", {}, { channelIds: [ENG_ID, DESIGN_ID] }));
    const { dialog } = await review(state);
    const chips = [...dialog.querySelectorAll(".nac__app")].map((c) => c.textContent);
    expect(chips).toContain("#eng");
    expect(chips).not.toContain("#design");
    await click(within(dialog).getByRole("button", { name: "Criar Nina" }), 12);
    const joined = state.calls.find((c) => c.method === "agents.setChannels")?.args[2];
    expect(joined).toEqual([{ channelId: ENG_ID }]);
  });

  test("its first task waits in its chat's composer, and the button says it creates and tries", async () => {
    const state = seedState();
    state.messages.push(proposal("p-1"));
    const { dialog } = await review(state);
    await typeIn(within(dialog).getByLabelText("Primeira tarefa"), "Desenhe a tela de login");
    await settle(2);
    await click(within(dialog).getByRole("button", { name: "Criar e testar" }), 12);
    await settle(6);
    const box = screen().getByRole("combobox", { name: "Mensagem para Nina" }) as HTMLTextAreaElement;
    expect(box.value).toBe("Desenhe a tela de login");
    expect(state.calls.some((c) => c.method === "chat.post")).toBe(false);
  });

  test("on a narrow screen, one column: the card, the proposal under it, Discard proposal beside Create", async () => {
    narrowScreen();
    const state = seedState();
    state.messages.push(proposal("p-1"));
    // Its card's step from the start, titled with its name: no list to go back to.
    const { dialog } = await review(state, "Nina");
    expect(within(dialog).queryByRole("button", { name: "Voltar" })).toBeNull();
    const card = dialog.querySelector(".nac__card") as HTMLElement;
    expect(card.compareDocumentPosition(side(dialog)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Why it was proposed, once: on the line under the title.
    expect(dialog.textContent?.split("Você pediu alguém para o design.")).toHaveLength(2);
    expect(side(dialog).textContent).not.toContain("Proposto pelo");
    await typeIn(within(dialog).getByLabelText("Primeira tarefa"), "Desenhe a tela de login");
    await settle(2);
    expect(within(dialog).getByRole("button", { name: "Criar e testar" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Cancelar" })).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Descartar proposta" }), 8);
    expect(state.calls.some((c) => c.method === "agents.denyProposal" && c.args[1] === "p-1")).toBe(true);
    expect(state.calls.some((c) => c.method === "agents.create")).toBe(false);
  });

  test("Discard proposal says no and closes the dialog, nothing created", async () => {
    const state = seedState();
    state.messages.push(proposal("p-1"));
    const { dialog, router } = await review(state);
    await click(within(dialog).getByRole("button", { name: "Descartar proposta" }), 8);
    expect(state.calls.some((c) => c.method === "agents.denyProposal" && c.args[1] === "p-1")).toBe(true);
    expect(state.calls.some((c) => c.method === "agents.create")).toBe(false);
    expect(screen().queryByRole("dialog", { name: "Novo agente" })).toBeNull();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
  });
});
