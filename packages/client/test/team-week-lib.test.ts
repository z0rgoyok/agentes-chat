import { expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import { LOCALE_CODES } from "@agenteschat/i18n/locale";
import i18next, { type TFunction } from "i18next";
import type { Approval, Proposal } from "../src/api/types";
import { actionCardOf } from "../src/lib/action-cards";
import { serverBody } from "../src/lib/message-body";
import { proposalWhy } from "../src/lib/proposals";
import { legacyPatch, lodiPrefsOf, teamWeekOn, teamWeekWhen } from "../src/lib/right-hand-prefs";
import {
  appliesInBulk,
  skipsAlone,
  type TeamWeekCard,
  type TeamWeekNames,
  teamWeekCardOf,
  teamWeekRowMessage,
  teamWeekRowPlace,
  teamWeekRowState,
  teamWeekRowText,
  teamWeekTitleKey,
  weekDay,
} from "../src/lib/team-week";

/** Lodi's weekly card (ADR 0137 §9): parsed, its rows' state from live data, and its words in every language. */

const tOf = (lng: string) => {
  const instance = i18next.createInstance();
  void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
  return instance.t.bind(instance) as unknown as TFunction;
};

const card: TeamWeekCard = {
  kind: "team_week",
  forUserId: "u1",
  from: "2026-10-30",
  to: "2026-11-06",
  timezone: "America/Sao_Paulo",
  stats: { done: 46, stuck: 3, waiting: 2, spentNanoUsd: 41e9, budgetNanoUsd: 80e9 },
  worked: [],
  rows: [
    {
      id: "approvals:caio",
      kind: "approvals",
      agentId: "caio",
      approvalIds: ["ap1", "ap2"],
      since: "2026-11-02T12:00:00Z",
    },
    { id: "budget:ada", kind: "budget", agentId: "ada", proposalId: "p1", stops: 2, from: 20e9, to: 30e9 },
    { id: "channel:theo", kind: "channel", agentId: "theo", proposalId: "p2", channelId: "c-general" },
    { id: "unanswered:c", kind: "unanswered", channelId: "c-atd", count: 6 },
    {
      id: "stalled:t",
      kind: "stalled",
      issueId: "t",
      number: 10,
      title: "Skills",
      steps: [12, 13, 14],
      onNumber: 11,
      hours: 4,
      agentId: "ada",
    },
  ],
  proposalIds: ["p1", "p2"],
  done: { "unanswered:c": { byUserId: "u1", at: "2026-11-06T21:00:00Z" } },
  dismissedAt: null,
};

const names: TeamWeekNames = {
  agent: (id) => ({ caio: "Caio", ada: "Ada", theo: "Theo" })[id ?? ""] ?? "?",
  handle: (id) => (id === "ada" ? "ada" : null),
  channel: (id) => ({ "c-general": "general", "c-atd": "atendimento" })[id] ?? "?",
  usd: (n) => `US$ ${Math.round(n / 1e9)}`,
  join: (list) => list.join(", "),
  since: () => "seg., 09:00",
};

test("the card is an action card, read whatever its meta lacks", () => {
  expect(actionCardOf({ actionCard: card })?.kind).toBe("team_week");
  const bare = actionCardOf({ actionCard: { ...card, done: undefined, worked: undefined } });
  expect(bare && "done" in bare ? bare.done : null).toEqual({});
  expect(actionCardOf({ actionCard: { kind: "team_week" } })).toBeNull();
});

test("each row's state comes from live data: proposals, approvals, or what was applied on the card", () => {
  const proposal = (id: string, status: Proposal["status"]) => ({ id, status, stale: false }) as Proposal;
  const approval = (id: string, status: Approval["status"]) => ({ id, status }) as Approval;
  const live = {
    proposals: [proposal("p1", "accepted"), proposal("p2", "pending")],
    approvals: [approval("ap1", "approved"), approval("ap2", "pending")],
  };
  const states = card.rows.map((r) => teamWeekRowState(card, r, live));
  expect(states).toEqual(["open", "done", "open", "done", "open"]);
  const decided = { ...live, approvals: [approval("ap1", "approved"), approval("ap2", "refused")] };
  expect(teamWeekRowState(card, card.rows[0] as never, decided)).toBe("done");
  const refused = { ...live, proposals: [proposal("p2", "refused")] };
  expect(teamWeekRowState(card, card.rows[2] as never, refused)).toBe("gone");
  // Approvals are read and decided one by one, never in "Aplicar as N".
  expect(card.rows.filter(appliesInBulk).map((r) => r.kind)).toEqual(["budget", "channel", "unanswered", "stalled"]);
});

test("its words in pt-BR, with the agent's gender", () => {
  const t = tOf("pt-BR");
  const text = card.rows.map((r) => teamWeekRowText(t, "pt-BR", r, names));
  expect(text[0]).toEqual({
    title: "2 pedidos de Caio esperam você",
    line: "Esperando desde seg., 09:00.",
    action: "Ver e aprovar",
  });
  expect(text[1]?.title).toBe("Orçamento da Ada: US$ 20 → US$ 30");
  expect(text[1]?.line).toBe("Parou 2 vezes no limite do mês.");
  expect(text[2]?.title).toBe("Colocar o Theo em #general");
  expect(text[3]?.line).toBe("6 perguntas ficaram sem resposta em #atendimento esta semana.");
  expect(text[4]?.line).toBe("Os passos #12, #13, #14 estão parados há 4 h esperando o #11.");
  expect(teamWeekRowMessage(t, card.rows[4] as never, names)).toBe(
    "@ada os passos #12, #13, #14 não precisam esperar o #11. Pode seguir com eles em paralelo.",
  );
  expect(teamWeekWhen(t, "pt-BR", { day: 5, weekHour: 17, dayHour: 9 }, "week")).toBe("Toda sexta às 17:00");
  expect(teamWeekWhen(t, "pt-BR", { day: 6, weekHour: 9, dayHour: 8 }, "week")).toBe("Todo sábado às 9:00");
  expect(weekDay("pt-BR", "2026-11-06")).toBe("6 de nov.");
  expect(serverBody(t, "Sua semana", { bodyCode: "team_week", bodyParams: card }, "pt-BR")).toBe(
    "Como foi a semana do time, de 30 de out. a 6 de nov.",
  );
  // A list without the locale keeps the body the server wrote in the person's language.
  expect(serverBody(t, "Sua semana da equipe está pronta", { bodyCode: "team_week" })).toBe(
    "Sua semana da equipe está pronta",
  );
});

test("every language says every row, with no key left showing", () => {
  for (const lng of LOCALE_CODES) {
    const t = tOf(lng);
    for (const r of card.rows) {
      const { title, line, action } = teamWeekRowText(t, lng, r, names);
      for (const s of [title, line, action]) expect([lng, s.includes("teamWeek.")]).toEqual([lng, false]);
    }
    expect([lng, teamWeekWhen(t, lng, { day: 1, weekHour: 9, dayHour: 9 }, "week").includes("teamWeek.")]).toEqual([
      lng,
      false,
    ]);
  }
});

test("Resumo do dia: its title, its hour, its line, and who gets it", () => {
  const t = tOf("pt-BR");
  expect(teamWeekTitleKey({ period: "day" })).toBe("teamWeek.dayTitle");
  expect(teamWeekTitleKey({})).toBe("teamWeek.title");
  expect(t(teamWeekTitleKey({ period: "day" }))).toBe("Resumo do dia");
  expect(teamWeekWhen(t, "pt-BR", { day: 5, weekHour: 17, dayHour: 9 }, "day")).toBe("Todo dia às 9:00");
  expect(serverBody(t, "Seu resumo", { bodyCode: "team_week", bodyParams: { ...card, period: "day" } }, "pt-BR")).toBe(
    "Como foi o dia do time, até 6 de nov.",
  );
  // The weekly card is an administrator's, the daily one anyone's, each unless stopped.
  const on = { weekOff: false, dayOff: false };
  expect(teamWeekOn(on, "week", true)).toBe(true);
  expect(teamWeekOn(on, "week", false)).toBe(false);
  expect(teamWeekOn(on, "day", false)).toBe(true);
  expect(teamWeekOn({ weekOff: true, dayOff: true }, "day", true)).toBe(false);
  expect(teamWeekOn({ weekOff: true, dayOff: false }, "week", true)).toBe(false);
  for (const lng of LOCALE_CODES) {
    const tl = tOf(lng);
    expect([lng, teamWeekWhen(tl, lng, { day: 1, weekHour: 9, dayHour: 9 }, "day").includes("teamWeek.")]).toEqual([
      lng,
      false,
    ]);
    expect([lng, tl("teamWeek.dayTitle").includes("teamWeek.")]).toEqual([lng, false]);
  }
});

test("what a person chose, from this server and from one before the two cards were told apart", () => {
  expect(lodiPrefsOf({ weekOff: true, dayOff: false, dayHour: 8, weekHour: 10, day: 2, switches: ["digest"] })).toEqual(
    {
      weekOff: true,
      day: 2,
      weekHour: 10,
      dayOff: false,
      dayHour: 8,
      digestOff: false,
      remindOff: false,
      timezone: "UTC",
      dayTimezone: "UTC",
      switches: ["digest"],
    },
  );
  // An older server: its one card, and no switch of a feature it does not have.
  expect(lodiPrefsOf({ off: false, day: 5, hour: 17, timezone: "America/Sao_Paulo" })).toMatchObject({
    weekOff: false,
    weekHour: 17,
    dayOff: true,
    dayTimezone: "America/Sao_Paulo",
    switches: [],
  });
  expect(lodiPrefsOf({ off: false, daily: true, day: 5, hour: 9 })).toMatchObject({
    weekOff: true,
    dayOff: false,
    dayHour: 9,
  });
  expect(lodiPrefsOf({ off: true, daily: true, hour: 9 })).toMatchObject({ weekOff: true, dayOff: true });
  // Which server answered: one from before is saved in its own words.
  expect(lodiPrefsOf({ off: false, daily: true, hour: 9 }).legacy).toBe(true);
  expect(lodiPrefsOf({ weekOff: false, dayOff: false, off: false, daily: false, hour: 17 }).legacy).toBeUndefined();
});

test("a save to a server from before the two cards: a stop stops its one card, a start picks which comes", () => {
  // It would drop the new fields and answer 200, so a switch would snap back.
  expect(legacyPatch({ dayOff: true })).toEqual({ off: true });
  expect(legacyPatch({ weekOff: true })).toEqual({ off: true });
  expect(legacyPatch({ dayOff: false })).toEqual({ off: false, daily: true });
  expect(legacyPatch({ weekOff: false })).toEqual({ off: false, daily: false });
  // Its one hour, and the weekly card's day.
  expect(legacyPatch({ dayHour: 8 })).toEqual({ hour: 8 });
  expect(legacyPatch({ weekHour: 16, day: 2 })).toEqual({ day: 2, hour: 16 });
  // What it has no feature for is not sent.
  expect(legacyPatch({ digestOff: true, remindOff: true })).toEqual({});
  // Each save, read back as that server answers it, shows what was asked.
  const after = (now: Record<string, unknown>, patch: Parameters<typeof legacyPatch>[0]) =>
    lodiPrefsOf({ ...now, ...legacyPatch(patch) });
  const weekly = { off: false, daily: false, day: 5, hour: 17 };
  expect(after(weekly, { weekOff: true })).toMatchObject({ weekOff: true, dayOff: true });
  expect(after(weekly, { dayOff: false })).toMatchObject({ weekOff: true, dayOff: false });
  expect(after({ ...weekly, daily: true }, { dayOff: true })).toMatchObject({ weekOff: true, dayOff: true });
});

test("rows a newer server adds travel in moreRows: known kinds join the card, unknown ones are left off", () => {
  const meta = {
    actionCard: {
      ...card,
      rows: [card.rows[0], { id: "later:1", kind: "something_later" }],
      moreRows: [card.rows[1], { id: "later:2", kind: "something_later" }, null],
    },
  };
  const parsed = teamWeekCardOf(meta);
  expect(parsed?.rows).toEqual(card.rows.slice(0, 2));
  expect(parsed).not.toHaveProperty("moreRows");
  // Every row left is one this build words.
  for (const r of parsed?.rows ?? []) expect(teamWeekRowText(tOf("en"), "en", r, names).title).not.toBe("");
  // A card from before moreRows reads as it did.
  expect(teamWeekCardOf({ actionCard: card })?.rows).toEqual(card.rows);
});

test("the day's card: what waits and what is stuck lead it, in words, and open where they are", () => {
  const day = {
    ...card,
    period: "day",
    rows: [card.rows[3]],
    moreRows: [
      {
        id: "stuck:ada",
        kind: "stuck",
        agentId: "ada",
        channelId: "c-general",
        dm: false,
        code: "plan",
        count: 1,
        held: true,
      },
      { id: "waiting", kind: "waiting", count: 2, ids: ["n1", "n2"], agentId: "caio", since: "2026-11-02T12:00:00Z" },
      {
        id: "stuck:theo",
        kind: "stuck",
        agentId: "theo",
        channelId: "d1",
        dm: true,
        code: "a_later_cause",
        count: 3,
        held: false,
      },
      {
        id: "stuck:task",
        kind: "stuck",
        agentId: "ada",
        channelId: "t1",
        dm: false,
        issueNumber: 12,
        code: "ai",
        count: 1,
        held: false,
      },
    ],
  };
  const parsed = teamWeekCardOf({ actionCard: day }) as TeamWeekCard;
  expect(parsed.rows.map((r) => r.kind)).toEqual(["waiting", "stuck", "stuck", "stuck", "unanswered"]);
  const [waiting, held, failed, inTask] = parsed.rows;
  const t = tOf("pt-BR");
  const text = parsed.rows.map((r) => teamWeekRowText(t, "pt-BR", r, names));
  expect(text[0]).toEqual({
    title: "2 coisas esperam você",
    line: "A mais antiga desde seg., 09:00.",
    action: "Abrir",
  });
  expect(text[1]).toEqual({
    title: "Ada parou e espera para continuar",
    line: "O plano chegou ao limite.",
    action: "Abrir conversa",
  });
  // A cause a later server names reads as the plain one.
  expect(text[2]).toMatchObject({
    title: "Theo parou com erro 3 vezes",
    line: "Algo deu errado. A conversa mostra o quê.",
  });
  expect(teamWeekRowText(t, "pt-BR", { ...(waiting as never as object), count: 1 } as never, names)).toMatchObject({
    title: "1 coisa espera você",
    line: "Esperando desde seg., 09:00.",
  });
  // Open until the inbox says none of them waits any more. Neither is part of "Aplicar as N".
  const live = { proposals: [], approvals: [] };
  expect(teamWeekRowState(parsed, waiting as never, live)).toBe("open");
  expect(teamWeekRowState(parsed, waiting as never, { ...live, waiting: ["n2", "n9"] })).toBe("open");
  expect(teamWeekRowState(parsed, waiting as never, { ...live, waiting: ["n9"] })).toBe("done");
  expect(teamWeekRowState(parsed, held as never, { ...live, waiting: [] })).toBe("open");
  expect(parsed.rows.filter(appliesInBulk).map((r) => r.kind)).toEqual(["unanswered"]);
  expect(parsed.rows.map(teamWeekRowPlace)).toEqual([
    { to: "waiting" },
    { to: "channel", channelId: "c-general" },
    { to: "dm", agentId: "theo", channelId: "d1" },
    { to: "task", number: 12 },
    null,
  ]);
  expect(failed?.kind).toBe("stuck");
  expect(inTask?.kind).toBe("stuck");
  for (const lng of LOCALE_CODES)
    for (const r of parsed.rows) {
      const said = teamWeekRowText(tOf(lng), lng, r, names);
      for (const words of [said.title, said.line, said.action])
        expect([lng, r.id, words === "" || words.includes("teamWeek.")]).toEqual([lng, r.id, false]);
    }
  // A build from before `moreRows` reads `rows` alone: the kinds it words, and no other.
  expect(day.rows.map((r) => r?.kind)).toEqual(["unanswered"]);
});

test("suggestions: archive an idle agent, a smaller model for light work, each put away alone", () => {
  const week = {
    ...card,
    done: {},
    proposalIds: ["p8", "p9"],
    rows: [card.rows[3], card.rows[1]],
    moreRows: [
      { id: "retire:theo", kind: "retire", agentId: "theo", proposalId: "p8" },
      { id: "model:ada", kind: "model", agentId: "ada", proposalId: "p9", from: "big-1", to: "mid-1" },
    ],
  };
  const parsed = teamWeekCardOf({ actionCard: week }) as TeamWeekCard;
  expect(parsed.rows.map((r) => r.kind)).toEqual(["unanswered", "budget", "retire", "model"]);
  const [unanswered, budget, retire, model] = parsed.rows;
  const t = tOf("pt-BR");
  const named = { ...names, model: (id: string) => ({ "big-1": "Grande", "mid-1": "Médio" })[id] ?? id };
  expect(teamWeekRowText(t, "pt-BR", retire as never, named)).toEqual({
    title: "Arquivar o Theo",
    line: "Sem trabalho há 4 semanas, sem rotina e sem tarefa aberta.",
    action: "Arquivar",
  });
  expect(teamWeekRowText(t, "pt-BR", { ...(retire as object), agentId: "ada" } as never, named).title).toBe(
    "Arquivar a Ada",
  );
  expect(teamWeekRowText(t, "pt-BR", model as never, named)).toEqual({
    title: "Ada pode usar o Médio.",
    line: "Hoje usa o Grande.",
    action: "Aplicar",
  });
  // A model's name and its number never part at a line's end.
  const spaced = { ...names, model: () => "Claude Sonnet 5.5" };
  expect(teamWeekRowText(t, "pt-BR", model as never, spaced).title).toBe(
    "Ada pode usar o Claude\u00a0Sonnet\u00a05.5.",
  );
  // Without a model list the ids stand in.
  expect(teamWeekRowText(t, "pt-BR", model as never, names)).toMatchObject({
    title: "Ada pode usar o mid-1.",
    line: "Hoje usa o big-1.",
  });

  // Both follow their proposal, like the budget's. Archiving is never part of "Aplicar as N".
  const proposal = (id: string, status: Proposal["status"]) => ({ id, status, stale: false }) as Proposal;
  const live = { proposals: [proposal("p8", "pending"), proposal("p9", "accepted")], approvals: [] };
  expect(teamWeekRowState(parsed, retire as never, live)).toBe("open");
  expect(teamWeekRowState(parsed, model as never, live)).toBe("done");
  expect(parsed.rows.filter(appliesInBulk).map((r) => r.kind)).toEqual(["unanswered", "budget", "model"]);
  expect(parsed.rows.filter(skipsAlone).map((r) => r.kind)).toEqual(["unanswered", "retire", "model"]);
  // Put away by its reader: it says so, whatever its proposal reads (refused), and stays out of the open ones.
  const skipped = {
    ...parsed,
    skipped: { "retire:theo": { byUserId: "u1", at: "2026-11-06T21:00:00Z" } },
  };
  const refused = { ...live, proposals: [proposal("p8", "refused")] };
  expect(teamWeekRowState(skipped, retire as never, refused)).toBe("skipped");
  // Refused from another administrator's card, it no longer applies on this one.
  expect(teamWeekRowState(parsed, retire as never, refused)).toBe("gone");
  expect(teamWeekRowState(parsed, unanswered as never, live)).toBe("open");
  expect(teamWeekRowState(parsed, budget as never, live)).toBe("open");

  for (const lng of LOCALE_CODES) {
    const tl = tOf(lng);
    const said = [
      ...[retire, model].flatMap((r) => Object.values(teamWeekRowText(tl, lng, r as never, named))),
      tl("teamWeek.skip"),
      tl("teamWeek.skipped"),
      proposalWhy(tl, { why: "the sentence in English", whyCode: "idle" as never }),
      proposalWhy(tl, { why: "the sentence in English", whyCode: "light_work" as never }),
    ];
    for (const words of said)
      expect([lng, words === "" || words.includes("teamWeek.") || words.includes("in English")]).toEqual([lng, false]);
  }
  // A code this build has no words for reads as the sentence the server sent with it.
  expect(proposalWhy(t, { why: "It is new.", whyCode: "a_later_reason" as never })).toBe("It is new.");
});
