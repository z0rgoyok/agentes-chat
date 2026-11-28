import { afterAll, afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AuditRow } from "@agenteschat/client";
import { formatInt, formatShortDate } from "@agenteschat/client/lib/format";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle, showIn } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
/**
 * The rows are minutes and a day old, and the list groups them by day: at noon, so they never straddle midnight (a
 * run just past it put them all on Ontem). Only the clock the app reads; timers still run.
 */
const NOON = new Date();
NOON.setHours(12, 0, 0, 0);
setSystemTime(NOON);
afterAll(() => setSystemTime());
const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const row = (over: Partial<AuditRow> & Pick<AuditRow, "id">): AuditRow => ({
  at: at(5),
  actor: { type: "agent", id: ADA_ID, name: "Ada" },
  action: "tool.call",
  target: { type: "tool", id: "create_issue" },
  details: { kind: "internal", behind: "person", input: {} },
  runId: "run-1",
  channelId: GENERAL_ID,
  channel: { id: GENERAL_ID, name: "general", kind: "channel" },
  onBehalfOf: { id: "u-walter", name: "Walter" },
  outcome: "done",
  approval: null,
  secret: null,
  ...over,
});

const AUDIT: AuditRow[] = [
  row({
    id: "a5",
    actor: { type: "agent", id: ATLAS_ID, name: "Atlas" },
    target: { type: "tool", id: "railway_deploy" },
    details: {
      kind: "external",
      connector: "Railway",
      title: "Railway: Deploy api",
      behind: "person",
      reason: "The login broke after the last deploy.",
      approvalId: "ap-1",
      input: { service: "api" },
    },
    outcome: "pending",
    approval: { id: "ap-1", status: "pending", decidedBy: null },
  }),
  row({
    id: "a4",
    target: { type: "tool", id: "drive_delete" },
    details: {
      kind: "internal",
      behind: "person",
      reason: "Not allowed: Ada lacks the scope drive:write",
      refusal: "noAccess",
      input: { file: "contratos-2025.pdf", apiKey: "***" },
    },
    outcome: "refused",
  }),
  row({
    id: "a3",
    target: { type: "tool", id: "sentry_list_issues" },
    details: { kind: "read", connector: "Sentry", title: "Sentry: List issues", behind: "person", input: {} },
  }),
  row({
    id: "a2",
    details: { kind: "internal", behind: "routine", routine: { id: "r1", name: "Follow-up" }, input: {} },
  }),
  row({
    id: "a1",
    at: at(60 * 24),
    actor: { type: "person", id: "u-walter", name: "Walter" },
    action: "routine.created",
    target: { type: "routine", id: "r1" },
    details: { name: "Follow-up" },
    runId: null,
    channelId: null,
    channel: null,
    onBehalfOf: null,
    outcome: null,
  }),
];

const go = async (state = seedState({ audit: AUDIT })) => {
  const api = createFakeApi(state);
  const r = await renderApp(`/org/${ORG_ID}/settings/audit`, { api });
  await settle(6);
  return { api, r, state };
};
const section = () => screen().getByRole("region", { name: "Auditoria" });
const titles = () => [...section().querySelectorAll(".audit-row__title")].map((e) => e.textContent);

describe("Configurações → Auditoria", () => {
  test("one list by day: who did what, asked by whom, where, and how it ended", async () => {
    await go();
    expect(titles()).toEqual([
      "Atlas usou o Railway",
      "Ada usou a ferramenta drive delete",
      "Ada consultou o Sentry",
      "Ada criou uma tarefa",
      "Walter criou uma rotina",
    ]);
    const first = section().querySelector(".audit-row") as HTMLElement;
    // About what in words, as the call's approval card says it, never "Railway: Deploy api".
    expect(first.textContent).toContain("Fazer um deploy · pedido por Walter · #general");
    expect(first.textContent).toContain("Esperando aprovação");
    expect(section().textContent).toContain("rotina Follow-up");
    expect([...section().querySelectorAll(".ac-grouphead")].map((d) => d.textContent)).toEqual(["Hoje", "Ontem"]);
  });

  // The worst case for CI's geometry check: the toolbar's view and agent and the days' headings in German, then in
  // Japanese. On a phone each control fills its line, never alone beside an empty stretch.
  test("in German and Japanese the toolbar and the days' headings keep their places", async () => {
    const { r } = await go();
    for (const [lang, problems] of [
      ["de", "Abgelehnt und fehlgeschlagen"],
      ["ja", "却下と失敗"],
    ] as const) {
      await showIn(r.services, lang);
      const audit = document.querySelector(".audit") as HTMLElement;
      expect(audit.querySelectorAll(":scope > .ac-toolbar")).toHaveLength(1);
      expect(audit.querySelector(".ac-toolbar")?.textContent).toContain(problems);
      expect(audit.querySelectorAll(".ac-grouphead")).toHaveLength(2);
    }
  });

  test("a row that didn't end in anything keeps its time in the last column, on a phone too", async () => {
    await go();
    const change = [...section().querySelectorAll(".audit-row")].at(-1) as HTMLElement;
    expect(change.textContent).toContain("Walter criou uma rotina");
    // An empty box in the outcome's place takes the time's cell on a phone's three columns.
    expect([...change.children].filter((c) => c.childElementCount === 0 && !c.textContent?.trim())).toHaveLength(0);
    const css = (await Bun.file(new URL("../src/components/audit.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(css).toMatch(/\.audit-row__time \{[^}]*grid-column: -2;/);
  });

  test("the shortcuts: what went wrong, what waits, people's changes", async () => {
    await go();
    await click(within(section()).getByRole("radio", { name: "Recusadas e falhas" }));
    await settle(4);
    expect(titles()).toEqual(["Ada usou a ferramenta drive delete"]);
    await click(within(section()).getByRole("radio", { name: "Esperando" }));
    await settle(4);
    expect(titles()).toEqual(["Atlas usou o Railway"]);
    await click(within(section()).getByRole("radio", { name: "Mudanças de pessoas" }));
    await settle(4);
    expect(titles()).toEqual(["Walter criou uma rotina"]);
  });

  test("another shortcut keeps the list on screen, dimmed under a running bar, until its rows land", async () => {
    const { api } = await go();
    const load = api.orgs.audit;
    let land = () => {};
    api.orgs.audit = (...args) =>
      new Promise((done) => {
        land = () => done(load(...args));
      });
    await click(within(section()).getByRole("radio", { name: "Recusadas e falhas" }));
    await act(() => new Promise((r) => setTimeout(r, 200)));
    const kept = section().querySelector(".ac-refreshing") as HTMLElement;
    expect(kept.getAttribute("aria-busy")).toBe("true");
    expect(kept.hasAttribute("data-busy")).toBe(true);
    expect(within(kept).getByRole("progressbar", { name: "Carregando…" })).toBeTruthy();
    // What it held, never a blank or a skeleton in its place.
    expect(titles()).toHaveLength(5);
    await act(async () => land());
    await settle(4);
    expect(titles()).toEqual(["Ada usou a ferramenta drive delete"]);
    expect(kept.hasAttribute("aria-busy")).toBe(false);
    expect(within(kept).queryByRole("progressbar")).toBeNull();
  });

  test("a row opens the thread's panel: the reason, what was sent (secrets hidden), the conversation", async () => {
    await go();
    const refused = [...section().querySelectorAll<HTMLElement>(".audit-row")][1] as HTMLElement;
    await click(refused);
    const panel = screen().getByRole("complementary", { name: "Detalhe da auditoria" });
    expect(panel.classList.contains("thread-panel")).toBe(true);
    // Why, in words; what the gateway said is the agent's English, in the technical part only.
    expect(panel.textContent).toContain("Por que foi recusado: O agente não tem acesso a isso");
    expect(panel.querySelector(".audit-panel__reason")?.textContent).not.toContain("drive:write");
    expect(panel.querySelector(".audit-panel__tech")?.textContent).toContain(
      "O que respondeuNot allowed: Ada lacks the scope drive:write",
    );
    expect(panel.textContent).toContain("contratos-2025.pdf");
    expect(panel.textContent).toContain("escondido");
    expect(panel.textContent).not.toContain("***");
    expect(within(panel).getByRole("link", { name: "Abrir conversa" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/c/${GENERAL_ID}`,
    );
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
    expect(screen().queryByRole("complementary", { name: "Detalhe da auditoria" })).toBeNull();
  });

  test("a change's details never list ids, and say each field in words", async () => {
    const change = row({
      id: "c1",
      actor: { type: "person", id: "u-walter", name: "Walter" },
      action: "connector.connected",
      target: { type: "connector", id: "conn-1" },
      details: { label: "GitHub da Acme", connectionId: "conn-1", machineId: "m-9", scopeCount: 3 },
      runId: null,
      onBehalfOf: null,
      outcome: null,
    });
    await go(seedState({ audit: [change] }));
    await click(section().querySelector(".audit-row") as HTMLElement);
    const panel = screen().getByRole("complementary", { name: "Detalhe da auditoria" });
    const details = panel.querySelector(".audit-panel__sent")?.textContent ?? "";
    expect(details).toContain("GitHub da Acme");
    expect(details).not.toMatch(/conn-1|m-9|connectionId|machineId/);
    expect(details).toContain("Scope count");
  });

  // Whoever runs the server read one piece of the workspace (the reveal door): the row says who and what, the line
  // under it at whose request or for which fault. The long name is the worst case for CI's geometry check.
  test("the operator's read of something: who read what, at whose request and how it arrived, or for a failed run", async () => {
    const read = (id: string, over: Partial<AuditRow>): AuditRow =>
      row({
        id,
        actor: { type: "system", id: null, name: null },
        action: "operator.content_read",
        runId: null,
        channelId: null,
        channel: null,
        onBehalfOf: null,
        outcome: null,
        ...over,
      });
    const asked = read("o1", {
      at: at(1),
      target: { type: "run_step", id: "run-9" },
      details: {
        field: "input",
        seq: 3,
        offset: 0,
        limit: 2000,
        purpose: "member_request",
        assistedByAi: true,
        requestId: "req-1",
        source: "email",
      },
      onBehalfOf: { id: "u-walter", name: "Walter Albuquerque de Vasconcelos Neto" },
    });
    const fault = read("o2", {
      at: at(2),
      target: { type: "message", id: null },
      details: { field: "text", direct: true, purpose: "fault", assistedByAi: false, runId: "run-9", cloud: true },
    });
    const { r } = await go(seedState({ audit: [asked, fault] }));
    expect(titles()).toEqual([
      "Quem cuida deste servidor leu uma etapa do trabalho de um agente",
      "O suporte do agentes.chat leu algo em uma conversa privada",
    ]);
    const subs = [...section().querySelectorAll(".audit-row__sub")].map((e) => e.textContent);
    expect(subs).toEqual([
      "a pedido de Walter Albuquerque de Vasconcelos Neto, enviado por e-mail · com um assistente de IA",
      "para diagnosticar uma execução que falhou ou travou",
    ]);
    // The panel says why in the reason's place, and of the entry's details never an id nor the server's own mark.
    await click(section().querySelector(".audit-row") as HTMLElement);
    const panel = screen().getByRole("complementary", { name: "Detalhe da auditoria" });
    expect(panel.querySelector(".audit-panel__reason")?.textContent).toBe(
      "Motivo: a pedido de Walter Albuquerque de Vasconcelos Neto, enviado por e-mail · com um assistente de IA",
    );
    const details = panel.querySelector(".audit-panel__sent")?.textContent ?? "";
    expect(details).toContain("input");
    expect(details).not.toMatch(/req-1|run-9|requestId|cloud/i);
    // The longest languages' words, for the geometry check.
    for (const [lang, who] of [
      ["de", "Die Person, die diesen Server betreibt, hat"],
      ["ru", "Администратор этого сервера: просмотр"],
    ] as const) {
      await showIn(r.services, lang);
      expect(document.querySelector(".audit-row__title")?.textContent).toStartWith(who);
    }
  });

  // Whoever runs the server answered a member's support request by email: the row says who and how, the line under
  // it whose request. A long name, a two-letter one and an account that is gone are the worst cases for CI's
  // geometry check.
  test("the operator's answer to a support request: who answered and how, whose request, with an AI assistant or not", async () => {
    const replied = (id: string, minutes: number, details: Record<string, unknown>, name: string | null): AuditRow =>
      row({
        id,
        at: at(minutes),
        actor: { type: "system", id: null, name: null },
        action: "operator.support_replied",
        target: { type: "support_request", id: "req-1" },
        details,
        runId: null,
        channelId: null,
        channel: null,
        onBehalfOf: name ? { id: `u-${id}`, name } : null,
        outcome: null,
      });
    const longName = "Maria Aleksandra Wiśniewska-Kowalczyk de Vasconcelos";
    const { r } = await go(
      seedState({
        audit: [
          replied("p1", 1, { template: "text", chars: 1840, assistedByAi: true }, longName),
          replied("p2", 2, { template: "received", chars: 0, assistedByAi: false, cloud: true }, "Jo"),
          replied("p3", 3, { template: "resolved", chars: 0, assistedByAi: true }, null),
        ],
      }),
    );
    expect(titles()).toEqual([
      "Quem cuida deste servidor respondeu por e-mail",
      "O suporte do agentes.chat respondeu por e-mail",
      "Quem cuida deste servidor respondeu por e-mail",
    ]);
    expect([...section().querySelectorAll(".audit-row__sub")].map((e) => e.textContent)).toEqual([
      `pedido de suporte de ${longName} · com um assistente de IA`,
      "pedido de suporte de Jo",
      "pedido de suporte de Removido · com um assistente de IA",
    ]);
    // It ended in nothing to show: no chip, the time in the last column.
    expect(section().querySelector(".audit-row .ac-chip")).toBeNull();
    // The panel says whose request in the reason's place, and of the entry's details never an id nor the server's
    // own mark.
    await click(section().querySelector(".audit-row") as HTMLElement);
    const panel = screen().getByRole("complementary", { name: "Detalhe da auditoria" });
    expect(panel.querySelector(".audit-panel__lead")?.textContent).toBe(
      "Quem cuida deste servidor respondeu por e-mail",
    );
    expect(panel.querySelector(".audit-panel__reason")?.textContent).toBe(
      `Motivo: pedido de suporte de ${longName} · com um assistente de IA`,
    );
    // Its title is one line, the sentence whole under it. On a phone the title is a block: its words are a box of
    // their own there, or they run past the panel's edge with no "…".
    expect(panel.querySelector(".thread-title__text")?.textContent).toBe(
      "Quem cuida deste servidor respondeu por e-mail",
    );
    const threads = await Bun.file(new URL("../src/components/threads/threads.css", import.meta.url).pathname).text();
    expect(threads.replace(/\/\*[\s\S]*?\*\//g, "")).toMatch(/\.thread-title__text \{\s*display: block;/);
    const details = panel.querySelector(".audit-panel__sent")?.textContent ?? "";
    expect(details).toContain("1840");
    expect(details).not.toMatch(/req-1|requestId|cloud/i);
    // The longest languages' words, for the geometry check.
    for (const [lang, title, sub] of [
      [
        "de",
        "Die Person, die diesen Server betreibt, hat per E-Mail geantwortet",
        `Support-Anfrage von ${longName} · mit einem KI-Assistenten`,
      ],
      [
        "ru",
        "Администратор этого сервера: ответ по почте",
        `запрос в поддержку от ${longName} · с помощью ИИ-ассистента`,
      ],
    ] as const) {
      await showIn(r.services, lang);
      expect(document.querySelector(".audit-row__title")?.textContent).toBe(title);
      expect(document.querySelector(".audit-row__sub")?.textContent).toBe(sub);
    }
  });

  // Whoever runs the server tells the workspace afterwards that it read content to investigate suspected abuse: the
  // row says who and what, the line under it how many items and which days, the count first. A phone's width cuts
  // the sentence after who, so the line under it is what tells two reviews apart. One item and 10,000, one day and
  // two years, and the longest languages are the worst cases for CI's geometry check.
  test("the operator's disclosure of a safety review: who reviewed, and under it how many items and which days", async () => {
    const year = new Date().getFullYear();
    const disclosed = (id: string, minutes: number, details: Record<string, unknown>): AuditRow =>
      row({
        id,
        at: at(minutes),
        actor: { type: "system", id: null, name: null },
        action: "operator.content_review_disclosed",
        target: { type: "organization", id: null },
        details,
        runId: null,
        channelId: null,
        channel: null,
        onBehalfOf: null,
        outcome: null,
      });
    const week = { from: `${year}-03-03T12:00:00.000Z`, to: `${year}-03-09T12:00:00.000Z` };
    const day = { from: `${year}-03-09T10:00:00.000Z`, to: `${year}-03-09T13:00:00.000Z` };
    const years = { from: `${year - 1}-12-28T12:00:00.000Z`, to: `${year}-01-03T12:00:00.000Z` };
    const { r } = await go(
      seedState({
        audit: [
          disclosed("d1", 1, { ...years, count: 10000 }),
          disclosed("d2", 2, { ...day, count: 1, cloud: true }),
          disclosed("d3", 3, { ...week, count: 2 }),
          disclosed("d4", 4, { ...week, count: 12 }),
          disclosed("d5", 5, { ...week, count: 21 }),
        ],
      }),
    );
    const subs = () => [...document.querySelectorAll(".audit-row__sub")].map((e) => e.textContent);
    const own = "Quem cuida deste servidor analisou conteúdo por segurança";
    expect(titles()).toEqual([own, "O suporte do agentes.chat analisou conteúdo por segurança", own, own, own]);
    expect(subs()).toEqual([
      `10.000 itens · 28 dez ${year - 1} a 3 jan ${year}`,
      "1 item · 9 mar",
      "2 itens · 3 mar a 9 mar",
      "12 itens · 3 mar a 9 mar",
      "21 itens · 3 mar a 9 mar",
    ]);
    // It ended in nothing to show: no chip.
    expect(section().querySelector(".audit-row .ac-chip")).toBeNull();
    // Each language's own plural forms, the count the line's first word in all of them, with the dates as the page
    // writes them there.
    type Short = (iso: string, year?: boolean) => string;
    const said: Record<"de" | "pl" | "ru", { who: [string, string]; under: (d: Short, n: string) => string[] }> = {
      de: {
        who: [
          "Die Person, die diesen Server betreibt, hat Inhalte aus Sicherheitsgründen geprüft",
          "Der Support von agentes.chat hat Inhalte aus Sicherheitsgründen geprüft",
        ],
        under: (d, n) => [
          `${n} Elemente · ${d(years.from, true)} bis ${d(years.to, true)}`,
          `1 Element · ${d(day.from)}`,
          ...["2", "12", "21"].map((count) => `${count} Elemente · ${d(week.from)} bis ${d(week.to)}`),
        ],
      },
      pl: {
        who: [
          "Osoba zarządzająca tym serwerem: sprawdzono treści ze względów bezpieczeństwa",
          "Wsparcie agentes.chat: sprawdzono treści ze względów bezpieczeństwa",
        ],
        under: (d, n) => [
          `${n} elementów · od ${d(years.from, true)} do ${d(years.to, true)}`,
          `1 element · ${d(day.from)}`,
          ...["2 elementy", "12 elementów", "21 elementów"].map(
            (items) => `${items} · od ${d(week.from)} do ${d(week.to)}`,
          ),
        ],
      },
      ru: {
        who: [
          "Администратор этого сервера: проверка содержимого в целях безопасности",
          "Поддержка agentes.chat: проверка содержимого в целях безопасности",
        ],
        under: (d, n) => [
          `${n} элементов · с ${d(years.from, true)} по ${d(years.to, true)}`,
          `1 элемент · ${d(day.from)}`,
          ...["2 элемента", "12 элементов", "21 элемент"].map(
            (items) => `${items} · с ${d(week.from)} по ${d(week.to)}`,
          ),
        ],
      },
    };
    const german: Short = (iso, withYear = false) => formatShortDate("de", iso, withYear);
    for (const lang of ["pl", "ru", "de"] as const) {
      await showIn(r.services, lang);
      const short: Short = (iso, withYear = false) => formatShortDate(lang, iso, withYear);
      const [server, cloud] = said[lang].who;
      expect([...document.querySelectorAll(".audit-row__title")].map((e) => e.textContent)).toEqual([
        server,
        cloud,
        server,
        server,
        server,
      ]);
      expect(subs()).toEqual(said[lang].under(short, formatInt(lang, 10000)));
    }
    // The panel says it whole once: the sentence, then the count and the days where a reason goes, under no heading
    // (they are no reason). The three values are not listed again under Detalhes.
    await click(document.querySelector(".audit-row") as HTMLElement);
    const panel = () => document.querySelector(".audit-panel") as HTMLElement;
    const line = () => panel().querySelector(".audit-panel__reason");
    expect(panel().querySelector(".audit-panel__lead")?.textContent).toBe(said.de.who[0]);
    expect(line()?.textContent).toBe(said.de.under(german, formatInt("de", 10000))[0]);
    expect(line()?.querySelector("strong")).toBeNull();
    await showIn(r.services, "pt-BR");
    expect(panel().querySelector(".audit-panel__lead")?.textContent).toBe(own);
    expect(line()?.textContent).toBe(`10.000 itens · 28 dez ${year - 1} a 3 jan ${year}`);
    expect(panel().textContent).not.toMatch(/Motivo|10000|T12:00|cloud/);
    expect(panel().querySelector(".audit-panel__sent")).toBeNull();
  });

  test("the panel hangs from <body>, so it stays put while the list scrolls", async () => {
    await go();
    await click(section().querySelector(".audit-row") as HTMLElement);
    const panel = screen().getByRole("complementary", { name: "Detalhe da auditoria" });
    expect(panel.closest(".shell__main")).toBeNull();
    expect(panel.parentElement).toBe(document.body);
  });

  test("a waiting call links to its request", async () => {
    await go();
    await click(section().querySelector(".audit-row") as HTMLElement);
    const panel = screen().getByRole("complementary", { name: "Detalhe da auditoria" });
    expect(panel.textContent).toContain("Ainda ninguém respondeu");
    expect(within(panel).getByRole("link", { name: "Ver o pedido" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/approvals?open=ap-1`,
    );
  });

  test("the request opens over Auditoria, not on Aprovações", async () => {
    const audit = AUDIT.map((x) => (x.approval ? { ...x, approval: { ...x.approval, id: "ap-deploy" } } : x));
    const { r } = await go(seedState({ audit }));
    await click(section().querySelector(".audit-row") as HTMLElement);
    const panel = screen().getByRole("complementary", { name: "Detalhe da auditoria" });
    await click(within(panel).getByRole("link", { name: "Ver o pedido" }));
    await settle(4);
    expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/audit`);
    expect(document.querySelector(".ap-dialog")?.textContent).toContain("Fazer um deploy");
    // Escape dismisses the request alone; the row stays open under it.
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
    expect(document.querySelector(".ap-dialog")).toBeNull();
    expect(screen().getByRole("complementary", { name: "Detalhe da auditoria" })).toBeTruthy();
  });

  test("a call waiting for a secret says what became of it", async () => {
    const asked = (status: NonNullable<AuditRow["secret"]>["status"]) =>
      row({
        id: `s-${status}`,
        target: { type: "tool", id: "request_secret" },
        details: { kind: "elsewhere", behind: "person", secretRequestId: "sr-1", input: { name: "GITHUB_TOKEN" } },
        outcome: "pending",
        secret: { id: "sr-1", status },
      });
    await go(seedState({ audit: [asked("pending")] }));
    expect(section().querySelector(".audit-row")?.textContent).toContain("Esperando um segredo");
    cleanup();
    await go(seedState({ audit: [asked("delivered")] }));
    const delivered = section().querySelector(".audit-row") as HTMLElement;
    expect(delivered.textContent).toContain("Segredo entregue");
    await click(delivered);
    const panel = screen().getByRole("complementary", { name: "Detalhe da auditoria" });
    expect(panel.textContent).toContain("SegredoEntregue");
  });

  test("members don't see it", async () => {
    const state = seedState({ audit: AUDIT });
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(state);
    expect(screen().queryByRole("region", { name: "Auditoria" })).toBeNull();
  });
});
