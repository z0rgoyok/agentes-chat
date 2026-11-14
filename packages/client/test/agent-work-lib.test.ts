import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { AgentStatus, AgentWork, PendingReturn, RunConsultation } from "../src/api/types";
import {
  activitySentence,
  barConsultTime,
  barEntries,
  type ConsultWithDetails,
  consultDetails,
  lineStep,
} from "../src/lib/activity";
import {
  agentWork,
  handoffAsk,
  returnClock,
  returnFaces,
  returnSentence,
  returnsHere,
  returnWhen,
  threadWorkState,
  threadWorkWord,
  workDetail,
  workLine,
  workTime,
} from "../src/lib/agent-work";
import { consultPair, pairItemOf } from "../src/lib/consult-group";
import { formatTime } from "../src/lib/format";
import { agentFaceWord, agentPresenceShown } from "../src/lib/presence";
import { applyConsultEvent, type ConsultsState } from "../src/realtime/consults";

const NOW = Date.parse("2026-10-14T13:44:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function translator(lng: string): TFunction {
  const i18n = i18next.createInstance();
  void i18n.init({ lng, fallbackLng: "en", resources, initAsync: false, interpolation: { escapeValue: false } });
  return i18n.t.bind(i18n) as TFunction;
}
const t = translator("pt-BR");
const en = translator("en");

const work = (over: Partial<AgentWork> = {}): AgentWork => ({
  state: "working",
  ask: null,
  since: ago(22),
  runId: "run-atlas",
  channelId: "c-vendas",
  channelKind: "channel",
  channelName: "vendas",
  threadId: "t-1",
  messageId: "m-1",
  forAgentId: null,
  routine: false,
  count: 1,
  ...over,
});
const names = { agentName: (id: string) => ({ ada: "Ada", theo: "Theo" })[id] };

describe("an agent's list line (ADR 0084 addendum)", () => {
  test("for whom or where it works, what it waits on, how long, in the state's tone", () => {
    const line = (w: AgentWork, here?: string) => workLine(t, "pt-BR", w, { ...names, here }, NOW);
    expect(line(work({ forAgentId: "ada" }))).toEqual({
      text: "ajudando a Ada",
      short: "trabalhando",
      time: "22 min",
      tone: "working",
    });
    expect(line(work({ forAgentId: "theo" }))?.text).toBe("ajudando o Theo");
    expect(line(work())?.text).toBe("#vendas");
    expect(line(work(), "c-vendas")?.text).toBe("aqui");
    expect(line(work({ channelKind: "dm", channelName: null }))?.text).toBe("trabalhando");
    // Where the viewer reads nothing: the bare state.
    expect(line(work({ channelId: null, channelKind: null, channelName: null }))?.text).toBe("trabalhando");
    expect(line(work({ routine: true, channelId: null }))?.text).toBe("numa rotina");
    expect(line(work({ state: "you", ask: "approval", since: ago(3) }))).toEqual({
      text: "esperando você",
      short: "esperando",
      time: "3 min",
      tone: "you",
    });
    expect(line(work({ state: "approval" }))?.text).toBe("esperando aprovação");
    expect(line(work({ state: "answer" }))?.text).toBe("esperando uma resposta");
    expect(line(work({ state: "computer" }))?.text).toBe("esperando o computador");
    expect(line(work({ state: "outage" }))?.text).toBe("IA fora do ar");
    expect(line(work({ state: "queued" }))).toMatchObject({ text: "na fila", short: "na fila", tone: "neutral" });
    expect(workLine(en, "en", work({ forAgentId: "ada" }), names, NOW)?.text).toBe("helping Ada");
    expect(workLine(t, "pt-BR", null, names, NOW)).toBeNull();
  });

  test("one clock: no time in the first minute, then minutes, then hours", () => {
    expect(workTime("pt-BR", ago(0.5), NOW)).toBeNull();
    expect(workTime("pt-BR", ago(22), NOW)).toBe("22 min");
    expect(workTime("pt-BR", ago(90), NOW)).toBe("1,5 h");
    expect(workTime("en", ago(90), NOW)).toBe("1.5 h");
  });

  test("the profile card's detail: whom it helps, what waits on you", () => {
    expect(workDetail(t, work({ forAgentId: "ada" }), names)).toBe("ajudando a Ada");
    expect(workDetail(t, work({ state: "you", ask: "approval" }), names)).toBe("sua aprovação");
    expect(workDetail(t, work({ state: "you", ask: "answer" }), names)).toBe("sua resposta");
    expect(workDetail(t, work({ channelKind: "dm", channelName: null }), names)).toBeNull();
    expect(workDetail(t, work({ state: "queued" }), names)).toBeNull();
  });

  test("a run this app hears at work counts before the list says so; waiting on you stays", () => {
    const status = (w: AgentWork | null): Pick<AgentStatus, "work"> => ({ work: w });
    expect(agentWork(status(null), { channelId: "c-x", since: NOW - 5000 }, NOW)).toMatchObject({
      state: "working",
      channelId: "c-x",
    });
    expect(agentWork(status(work({ state: "you", ask: "approval" })), { channelId: "c-x" }, NOW)?.state).toBe("you");
    expect(agentWork(status(work({ state: "queued" })), null, NOW)?.state).toBe("queued");
  });
});

describe("an agent's face", () => {
  const status = (over: Partial<AgentStatus>): AgentStatus => ({
    agentId: "atlas",
    presence: "online",
    status: null,
    activeAt: null,
    ...over,
  });
  test("never red Ocupado or amber Ausente: working, waiting on you, available", () => {
    expect(agentPresenceShown(status({ presence: "busy", working: true }), true)).toBe("working");
    // Busy with nothing at work (long work waiting on someone, a routine's run in line): free, as its line says.
    expect(
      agentPresenceShown(status({ presence: "busy", working: false, work: work({ state: "approval" }) }), true),
    ).toBe("online");
    expect(
      agentPresenceShown(status({ presence: "busy", working: false, work: work({ state: "queued" }) }), true),
    ).toBe("online");
    // An older server sends no `working`: its busy still reads at work.
    expect(agentPresenceShown(status({ presence: "busy" }), true)).toBe("working");
    expect(agentPresenceShown(status({ presence: "away" }), true)).toBe("online");
    expect(agentPresenceShown(status({ work: work({ state: "you", ask: "approval" }) }), true)).toBe("waiting");
    expect(agentPresenceShown(status({ presence: "out" }), true)).toBe("out");
    expect(agentPresenceShown(status({ presence: "away" }), false)).toBe("offline");
    expect(agentFaceWord(t, "online")).toBe("Disponível");
    expect(agentFaceWord(t, "working")).toBe("Trabalhando");
    expect(agentFaceWord(t, "waiting")).toBe("Esperando você");
    expect(agentFaceWord(en, "online")).toBe("Available");
  });
});

describe("a thread's chip", () => {
  test("one state at a time: waiting on you, then work, then what it waits on", () => {
    expect(threadWorkState({ needsYou: true, working: true, wait: null })).toBe("needsYou");
    expect(threadWorkState({ needsYou: false, working: true, wait: null })).toBe("working");
    expect(threadWorkState({ needsYou: false, working: true, wait: "queued" })).toBe("queued");
    expect(threadWorkState({ needsYou: false, working: false, wait: "approval" })).toBe("approval");
    expect(threadWorkState({ needsYou: false, working: false, wait: "approval" }, true)).toBe("working");
    expect(threadWorkState({ needsYou: false, working: false, wait: null })).toBeNull();
  });
});

describe("a return (ADR 0037 addendum of 2026-11-13)", () => {
  const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
  const soon = at(33);
  const late = at(23 * 60);
  const hm = (iso: string, locale = "pt-BR") => formatTime(locale, iso);
  const ret = (over: Partial<PendingReturn> = {}): PendingReturn => ({
    messageId: "l1",
    agentId: "ada",
    channelId: "c-vendas",
    channelKind: "channel",
    channelName: "vendas",
    threadId: "t-1",
    at: soon,
    about: "rever o deploy de hoje",
    runId: "r1",
    replyMessageId: "m1",
    held: false,
    canCancel: true,
    ...over,
  });

  test("when: its time, its day only more than 12 h away (so it never turns at midnight), 12-hour English", () => {
    expect(returnWhen(t, "pt-BR", soon, NOW)).toBe(`às ${hm(soon)}`);
    expect(returnWhen(en, "en", soon, NOW)).toBe(`at ${hm(soon, "en")}`);
    expect(hm(soon, "en")).toMatch(/[AP]M$/);
    expect(returnWhen(t, "pt-BR", late, NOW)).toBe(`amanhã às ${hm(late)}`);
    expect(returnWhen(en, "en", late, NOW)).toBe(`tomorrow at ${hm(late, "en")}`);
    expect(returnWhen(t, "pt-BR", late, NOW, true)).toBe(`Amanhã às ${hm(late)}`);
    expect(returnWhen(t, "pt-BR", soon, NOW, true)).toBe(`Às ${hm(soon)}`);
    // 12 h before it, the day leaves its words: the same time.
    expect(returnWhen(t, "pt-BR", late, Date.parse(late) - 12 * 3600_000)).toBe(`às ${hm(late)}`);
    expect(returnClock(t, "pt-BR", soon, NOW)).toBe(hm(soon));
    expect(returnClock(t, "pt-BR", late, NOW)).toBe(`amanhã ${hm(late)}`);
  });

  test("the bar's sentence: the soonest, held on an answer, the name and the time where nothing more fits", () => {
    const say = (r: PendingReturn, canAnswer = true, short = false) =>
      returnSentence(t, "pt-BR", r, "Ada", { canAnswer, short, now: NOW });
    expect(say(ret())).toBe(`Ada retorna às ${hm(soon)}`);
    expect(say(ret({ at: late }))).toBe(`Ada retorna amanhã às ${hm(late)}`);
    expect(say(ret(), true, true)).toBe(`Ada ${hm(soon)}`);
    expect(say(ret({ held: true }))).toBe("Ada retorna quando você responder");
    expect(say(ret({ held: true }), false)).toBe("Ada retorna depois de uma resposta");
    expect(returnSentence(en, "en", ret(), "Ada", { canAnswer: true, now: NOW })).toBe(
      `Ada follows up at ${hm(soon, "en")}`,
    );
  });

  test("the bar holds a thread's own returns, or the main timeline's; one face per agent, three at most", () => {
    const list = [
      ret({ messageId: "a" }),
      ret({ messageId: "b", threadId: null }),
      ret({ messageId: "c", agentId: "nina" }),
    ];
    expect(returnsHere(list, "t-1").map((r) => r.messageId)).toEqual(["a", "c"]);
    expect(returnsHere(list, null).map((r) => r.messageId)).toEqual(["b"]);
    expect(returnsHere(undefined, null)).toEqual([]);
    const agents = ["ada", "ada", "nina", "theo", "ivo"].map((agentId, i) => ret({ messageId: `${i}`, agentId }));
    expect(returnFaces(agents)).toEqual(["ada", "nina", "theo"]);
  });

  test("the lists, the profile card and the chip: neutral, when it comes, never for how long", () => {
    const later = work({ state: "later", at: soon, since: soon, count: 0 });
    expect(workLine(t, "pt-BR", later, names, NOW)).toEqual({
      text: `retorno às ${hm(soon)}`,
      short: "retorno",
      time: null,
      tone: "neutral",
    });
    expect(workLine(en, "en", later, names, NOW)?.text).toBe(`follow-up at ${hm(soon, "en")}`);
    expect(workDetail(t, later, names, "pt-BR", NOW)).toBe(`retorno às ${hm(soon)}`);
    expect(threadWorkState({ needsYou: false, working: false, wait: null, laterAt: soon })).toBe("later");
    // Anything else on the thread comes first.
    expect(threadWorkState({ needsYou: false, working: true, wait: null, laterAt: soon })).toBe("working");
    expect(threadWorkState({ needsYou: false, working: true, wait: "queued", laterAt: soon })).toBe("queued");
    expect(threadWorkWord(t, "later", { at: soon, locale: "pt-BR", now: NOW })).toBe(`Retorno às ${hm(soon)}`);
    expect(threadWorkWord(en, "later", { at: late, locale: "en", now: NOW })).toBe(
      `Follow-up tomorrow at ${hm(late, "en")}`,
    );
  });
});

const consultation = (over: Partial<RunConsultation> = {}): RunConsultation => ({
  id: "q1",
  kind: "note",
  runId: "run-ada",
  agentId: "ada",
  consultedAgentId: "atlas",
  consultedRunId: "run-atlas",
  status: "open",
  waiting: null,
  question: "Revisa a proposta",
  answer: null,
  createdAt: ago(22),
  answeredAt: null,
  expiresAt: new Date(NOW + 600_000).toISOString(),
  ...over,
});

describe("the divider (ADR 0095 addendum)", () => {
  test("amber when its card waits on you, quiet for another's wait, the wait's own clock", () => {
    const pair = (c: RunConsultation, yours?: "approval" | "answer") => consultPair([c], NOW, "ada", yours ?? null);
    expect(pair(consultation())).toMatchObject({ tone: "live", word: { key: "chat.consultPair.working" } });
    expect(pair(consultation(), "approval")).toMatchObject({
      tone: "you",
      word: { key: "chat.consultPair.waitingYourApproval" },
    });
    const waiting = pair(consultation({ waiting: "approval", waitingSince: ago(3) }));
    expect(waiting).toMatchObject({ tone: "wait", word: { key: "chat.consultPair.waitingApproval" } });
    expect(waiting?.seconds).toBe(180);
    expect(pair(consultation({ waiting: "queued" }))?.word?.key).toBe("chat.consultPair.queued");
    // A reply's own record carries no times nor wait: closed, it says how it ended, never amber.
    expect(consultPair([pairItemOf(stored)], NOW, "ada", "approval")?.tone).toBeNull();
  });
});

const stored = {
  consultationId: "q9",
  kind: "note" as const,
  agentId: "atlas",
  status: "answered" as const,
  question: "x",
  answer: "feito",
};

describe("the bar's hand-off (ADR 0095 addendum)", () => {
  const live = (over = {}) => ({
    runId: "run-ada",
    agentId: "ada",
    consultedAgentId: "atlas",
    channelId: "c-vendas",
    threadId: "t-1",
    kind: "note" as const,
    status: "asking" as const,
    since: NOW - 22 * 60_000,
    at: NOW,
    ...over,
  });
  const name = (id: string) => ({ ada: "Ada", atlas: "Atlas" })[id] ?? id;
  const sentence = (details: Partial<ConsultWithDetails>) =>
    activitySentence(
      t,
      barEntries([], [], name, () => undefined, [{ ...live(), ...details }]),
    );

  test("the other agent's step, its wait, or what waits on you, with the lists' clock", () => {
    expect(sentence({ step: "lendo o Drive" })).toBe("Atlas lendo o Drive…");
    expect(sentence({})).toBe("Atlas está trabalhando…");
    expect(sentence({ yours: "approval" })).toBe("Atlas espera sua aprovação…");
    expect(sentence({ wait: "approval" })).toBe("O Atlas espera uma aprovação…");
    expect(sentence({ wait: "queued" })).toBe("Atlas está na fila…");
    expect(sentence({ status: "answered" })).toBe("Atlas terminou. Ada está escrevendo…");
    expect(sentence({ status: "failed" })).toBe("Atlas não terminou. Ada está escrevendo…");
    // A question keeps its own phrase while its colleague is at it.
    expect(sentence({ kind: "question" })).toBe("Ada está perguntando para Atlas…");
    const [entry] = barEntries([], [], name, () => undefined, [live()]);
    expect(barConsultTime("pt-BR", entry?.consult, NOW)).toBe("22 min");
    const [waits] = barEntries([], [], name, () => undefined, [
      { ...live(), wait: "approval", waitSince: NOW - 180_000 },
    ]);
    expect(barConsultTime("pt-BR", waits?.consult, NOW)).toBe("3 min");
  });

  test("what the list and the cards add: its id, its wait, whose card waits on you, its step", () => {
    const row = consultation({ waiting: "approval", waitingSince: ago(3) });
    expect(
      consultDetails(
        live(),
        [row],
        () => null,
        () => "mexendo nos arquivos",
      ),
    ).toEqual({
      kind: "note",
      id: "q1",
      wait: "approval",
      waitSince: NOW - 180_000,
      yours: null,
      toRun: "run-atlas",
      step: null,
    });
    expect(
      consultDetails(
        live(),
        [consultation()],
        (id, run) => (id === "atlas" && run === "run-atlas" ? "approval" : null),
        () => "x",
      ),
    ).toMatchObject({ yours: "approval", toRun: "run-atlas", step: null });
    // Another run of Atlas waits on you while the hand-off works: the hand-off is at work, never amber.
    const elsewhere = work({ state: "you", ask: "approval", runId: "run-atlas-2" });
    expect(
      consultDetails(
        live(),
        [consultation()],
        (_id, run) => handoffAsk(elsewhere, run),
        () => "lendo o Drive",
      ),
    ).toMatchObject({ yours: null, step: "lendo o Drive" });
    expect(handoffAsk(work({ state: "you", ask: "answer", runId: "run-atlas" }), "run-atlas")).toBe("answer");
    // Before the list names the hand-off's run, its agent's work can't say it is this one.
    expect(handoffAsk(work({ state: "you", ask: "answer", runId: "run-atlas" }), null)).toBeNull();
    expect(handoffAsk(work({ runId: "run-atlas" }), "run-atlas")).toBeNull();
    // The bar's own verbs: no case changed on a translated line (ADR 0122).
    expect(lineStep(t, { by: "auto", text: null, kind: "files", subject: null, emoji: null, until: null })).toBe(
      "lendo o Drive",
    );
    expect(
      lineStep(t, { by: "auto", text: null, kind: "connector", subject: "Linear", emoji: null, until: null }),
    ).toBe("consultando o Linear");
    expect(lineStep(t, { by: "auto", text: null, kind: "task", subject: "x", emoji: null, until: null })).toBeNull();
  });

  test("work handed off is on the line live, from its event to its answer", () => {
    let state: ConsultsState = {};
    state = applyConsultEvent(
      state,
      {
        type: "agent.consulting",
        channelId: "c-vendas",
        threadId: "t-1",
        runId: "run-ada",
        agentId: "ada",
        consultedAgentId: "atlas",
        kind: "note",
      },
      NOW,
    );
    expect(state["run-ada"]).toMatchObject({ kind: "note", status: "asking" });
    state = applyConsultEvent(
      state,
      {
        type: "agent.consulted",
        channelId: "c-vendas",
        threadId: "t-1",
        runId: "run-ada",
        agentId: "ada",
        consultedAgentId: "atlas",
        status: "answered",
        kind: "note",
      },
      NOW,
    );
    expect(state["run-ada"]).toMatchObject({ kind: "note", status: "answered" });
  });
});
