import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { CalendarReminder } from "@agenteschat/client";
import { HOUR_PX, mondayOf } from "@agenteschat/client/lib/calendar";
import { toYmd } from "@agenteschat/client/lib/format";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { pinFileClock } from "./clock";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

pinFileClock();

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = new Date();
const at = (h: number, m = 0) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m);

const go = async (prepare?: (api: ReturnType<typeof createFakeApi>) => Promise<unknown>) => {
  const state = seedState();
  const api = createFakeApi(state);
  await prepare?.(api);
  await renderApp(`/org/${ORG_ID}/calendar`, { api });
  await settle(8);
  return { state, api };
};
/** Drags a chip vertically by `dy` px (pointer down on it, move and release on the window). */
const drag = async (el: HTMLElement, dy: number) => {
  await act(async () => fireEvent.pointerDown(el, { clientX: 10, clientY: 100, button: 0 }));
  await settle(1);
  await act(async () => fireEvent.pointerMove(window, { clientX: 10, clientY: 100 + dy }));
  await act(async () => fireEvent.pointerUp(window, { clientX: 10, clientY: 100 + dy }));
  await settle(3);
};

/** Reminders on the calendar (the fake has none of its own), each in the ranges it falls in; Ada's unless said. */
const addReminders = (
  api: ReturnType<typeof createFakeApi>,
  list: { message: string; at: Date; agentId?: string }[],
) => {
  const range = api.calendar.range;
  api.calendar.range = async (org, from, to) => {
    const out = await range(org, from, to);
    const inRange = list.filter((r) => r.at >= new Date(from) && r.at < new Date(to));
    return {
      ...out,
      reminders: [
        ...(out.reminders ?? []),
        ...inRange.map(
          (r): CalendarReminder => ({
            id: `rem-${r.message}`,
            message: r.message,
            at: r.at.toISOString(),
            forUserId: "u-walter",
            channelId: ENG_ID,
            threadId: null,
            agentId: r.agentId ?? ADA_ID,
            createdBy: "u-walter",
            canCancel: true,
          }),
        ),
      ],
    };
  };
};

describe("Calendário: views, moves and series", () => {
  test("moving a single event updates it (snapped to 15 minutes)", async () => {
    const { state } = await go();
    const chip = screen().getByRole("button", { name: "Daily de produto, 10:00–11:00" });
    await drag(chip, HOUR_PX / 2);
    const call = state.calls.find((c) => c.method === "calendar.update");
    expect(call?.args[2]).toBeUndefined();
    const patch = call?.args[1] as { start: string; end: string };
    expect(new Date(patch.start).getMinutes()).toBe(30);
    expect(new Date(patch.end).getHours() * 60 + new Date(patch.end).getMinutes()).toBe(11 * 60 + 30);
  });

  test("moving one occurrence of a recurring event asks: Só este / Este e os próximos / Todos", async () => {
    const { state } = await go((api) =>
      api.calendar.create(ORG_ID, {
        title: "Standup",
        start: at(8).toISOString(),
        end: at(8, 30).toISOString(),
        recurrence: "none",
        participants: [],
        rule: { freq: "daily", interval: 1, times: ["08:00"], timezone: localZone, start: toYmd(today) },
      }),
    );
    const col = document.querySelector(`[data-day="${toYmd(today)}"]`) as HTMLElement;
    const chip = within(col).getByRole("button", { name: "Standup, 08:00–08:30" });
    expect(chip.querySelector(".cal-chip__repeat")).not.toBeNull();
    await drag(chip, HOUR_PX);
    const prompt = screen().getByRole("dialog", { name: "Alterar evento recorrente" });
    for (const name of ["Só este", "Este e os próximos", "Todos"])
      expect(within(prompt).getByRole("button", { name })).toBeTruthy();
    await click(within(prompt).getByRole("button", { name: "Só este" }));
    await settle(4);
    const [, patch, series] = (state.calls.find((c) => c.method === "calendar.update")?.args ?? []) as [
      string,
      { start: string },
      { scope: string },
    ];
    expect(series.scope).toBe("this");
    expect(new Date(patch.start).getHours()).toBe(9);
    // That day moved; the others stayed.
    expect(within(col).getByRole("button", { name: "Standup, 09:00–09:30" })).toBeTruthy();
  });

  test("an invitation's link opens its event on the event's week; closing it drops the link", async () => {
    const api = createFakeApi(seedState());
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 21, 15);
    const event = await api.calendar.create(ORG_ID, {
      title: "Revisão trimestral",
      start: day.toISOString(),
      end: new Date(day.getTime() + 3600_000).toISOString(),
      recurrence: "none",
      participants: [],
    });
    const { router } = await renderApp(`/org/${ORG_ID}/calendar?open=${event.id}&day=${toYmd(day)}`, { api });
    await settle(8);
    const details = screen().getByRole("region", { name: "Revisão trimestral" });
    expect(details.textContent).toContain("15:00");
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(3);
    expect(screen().queryByRole("region", { name: "Revisão trimestral" })).toBeNull();
    expect(router.state.location.search).toEqual({});
    expect(screen().getByRole("button", { name: "Revisão trimestral, 15:00–16:00" })).toBeTruthy();
  });

  test("an invitation: Vou and Não vou in its details, then what I answered and who else said what", async () => {
    let id = "";
    const { state } = await go(async (api) => {
      const event = await api.calendar.create(ORG_ID, {
        title: "Planejamento",
        start: at(15).toISOString(),
        end: at(16).toISOString(),
        recurrence: "none",
        participants: [
          { type: "person", id: "u-walter" },
          { type: "person", id: "u-joao" },
        ],
      });
      id = event.id;
    });
    await click(screen().getByRole("button", { name: "Planejamento, 15:00–16:00" }));
    await settle(3);
    const details = () => screen().getByRole("region", { name: "Planejamento" });
    expect(details().textContent).toContain("Você está entre os convidados deste evento.");
    await click(within(details()).getByRole("button", { name: "Vou" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "calendar.respond")?.args).toEqual([ORG_ID, id, "accepted"]);
    expect(details().textContent).toContain("Você vai.");
    // The answer can change.
    expect(within(details()).getByRole("button", { name: "Não vou" })).toBeTruthy();
    expect(within(details()).queryByRole("button", { name: "Vou" })).toBeNull();
  });

  test("a link whose day doesn't exist opens on today's week", async () => {
    for (const day of ["2026-13-45", "2026-02-30", "garbage", "20261028"]) {
      await renderApp(`/org/${ORG_ID}/calendar?open=x&day=${day}`, { api: createFakeApi(seedState()) });
      await settle(8);
      expect(document.querySelector(`[data-day="${toYmd(today)}"]`), day).not.toBeNull();
      cleanup();
    }
  });

  test("views: Mês and Agenda; T goes back to today; arrows move the day", async () => {
    await go();
    const range = () => document.querySelector(".ac-pagehead__meta")?.textContent ?? "";
    const thisWeek = range();
    await act(async () => fireEvent.keyDown(document.body, { key: "ArrowRight" }));
    for (let i = 0; i < 7; i++) await act(async () => fireEvent.keyDown(document.body, { key: "ArrowRight" }));
    await settle(3);
    expect(range()).not.toBe(thisWeek);
    await act(async () => fireEvent.keyDown(document.body, { key: "t" }));
    await settle(3);
    expect(range()).toBe(thisWeek);
    await click(screen().getByRole("radio", { name: "Mês" }));
    await settle(4);
    expect(document.querySelectorAll(".cal-month__cell")).toHaveLength(42);
    expect(range()).toBe(new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(today));
    await click(screen().getByRole("radio", { name: "Agenda" }));
    await settle(4);
    expect(document.querySelector(".cal-agenda, .cal-agenda__empty")).not.toBeNull();
  });

  /** Seven reminders today (07:01…07:07): more than a month cell shows. */
  const reminders = (api: ReturnType<typeof createFakeApi>, n = 7, time = (i: number) => at(7, i + 1)) =>
    addReminders(
      api,
      Array.from({ length: n }, (_, i) => ({ message: `Lembrete ${i + 1}`, at: time(i) })),
    );

  /** A row's parts in order: whose face, then its words. */
  const parts = (row: Element) =>
    [...row.children].map((c) => (c.matches(".ac-who") ? "face" : (c.className as string).replace("cal-chip__", "")));

  test("Mês: each item is a row (face, time, name), three a day, then +N mais", async () => {
    await go(async (api) => reminders(api));
    await click(screen().getByRole("radio", { name: "Mês" }));
    await settle(4);
    const cell = document.querySelector(`.cal-month__cell[data-day="${toYmd(today)}"]`) as HTMLElement;
    const rows = [...cell.querySelectorAll<HTMLElement>(":scope > .cal-chip--line")];
    expect(rows).toHaveLength(3);
    const first = within(cell).getByRole("button", { name: "Lembrete 1, 07:01" });
    expect(parts(first)).toEqual(["face", "time tabular", "title"]);
    // The agent's own face, in place of Google's dot.
    expect(first.querySelector(".ac-who .ac-avatar--agent")).not.toBeNull();
    expect(first.getAttribute("title")).toBe("Lembrete 1 · Ada · 07:01");
    const more = within(cell).getByRole("button", { name: /^\+\d+ mais$/ });
    await click(more);
    await settle(2);
    const list = document.querySelector(".cal-more__list") as HTMLElement;
    const names = [...list.querySelectorAll(".cal-chip__title")].map((n) => n.textContent);
    expect(names.indexOf("Lembrete 1")).toBeLessThan(names.indexOf("Lembrete 7"));
    expect(names.length).toBe(rows.length + Number(/\d+/.exec(more.textContent ?? "")?.[0]));
  });

  test("Agenda: a day's reminders are rows among its events", async () => {
    await go(async (api) => reminders(api, 2));
    await click(screen().getByRole("radio", { name: "Agenda" }));
    await settle(4);
    const agenda = document.querySelector(".cal-agenda") as HTMLElement;
    const first = agenda.querySelector(".cal-agenda__day") as HTMLElement;
    const row = within(first).getByRole("button", { name: "Lembrete 1, 07:01" });
    expect(parts(row)).toEqual(["face", "time tabular", "title"]);
    await click(row);
    await settle(2);
    const details = screen().getByRole("region", { name: "Lembrete 1" });
    expect(details.textContent).toContain("Lembrete · postado em #eng");
  });

  test("week: a reminder is one line across its column, a meeting at its time beside it, as wide", async () => {
    await go(async (api) => {
      reminders(api, 1, () => at(5));
      await api.calendar.create(ORG_ID, {
        title: "Planejamento",
        start: at(5).toISOString(),
        end: at(6).toISOString(),
        recurrence: "none",
        participants: [],
      });
    });
    const col = document.querySelector(`.cal-week__col[data-day="${toYmd(today)}"]`) as HTMLElement;
    const chip = within(col).getByRole("button", { name: "Lembrete 1, 05:00" });
    expect(chip.classList.contains("cal-chip--moment")).toBe(true);
    expect(chip.querySelector(".cal-chip__title > .ac-who:first-child .ac-avatar--agent")).not.toBeNull();
    expect(chip.getAttribute("title")).toBe("Lembrete 1 · Ada · 05:00");
    // The meeting sits beside it, never under it.
    const moment = chip.closest(".cal-week__moment") as HTMLElement;
    const meeting = within(col).getByRole("button", { name: "Planejamento, 05:00–06:00" });
    expect([moment, meeting].map((el) => el.style.getPropertyValue("--cols"))).toEqual(["2", "2"]);
    expect(moment.style.getPropertyValue("--col")).not.toBe(meeting.style.getPropertyValue("--col"));
  });

  test("every item opens with its owner's face as its title's first word: an agent's, a person's, a task's assignee", async () => {
    await go(async (api) => {
      await api.calendar.create(ORG_ID, {
        title: "Planejamento",
        start: at(14).toISOString(),
        end: at(15).toISOString(),
        recurrence: "none",
        participants: [],
      });
      const range = api.calendar.range;
      api.calendar.range = async (...args) => {
        const out = await range(...args);
        const byAgent = { type: "agent" as const, id: ADA_ID };
        return {
          ...out,
          events: out.events.map((e) => (e.title === "Planejamento" ? { ...e, createdBy: byAgent } : e)),
        };
      };
    });
    const agentEvent = screen().getByRole("button", { name: "Planejamento, 14:00–15:00" });
    expect(
      agentEvent.querySelector(".cal-chip__title > .ac-who[data-lead]:first-child .ac-avatar--agent"),
    ).not.toBeNull();
    expect(agentEvent.getAttribute("title")).toBe("Planejamento · Ada · 14:00–15:00");
    // A person's event: the organizer's initial, not a calendar glyph.
    const person = screen().getAllByRole("button", { name: /^Daily de produto, / })[0] as HTMLElement;
    const face = person.querySelector(".cal-chip__title > .ac-who:first-child .ac-avatar") as HTMLElement;
    expect(face.dataset.kind).toBe("person");
    expect(face.textContent).toBe("W");
    // The owner's name follows the time, shown by the CSS where the column has room.
    expect(person.querySelector(".cal-chip__time .cal-chip__who")?.textContent).toBe(" · Walter");
    // A due date: who has the task.
    const due = screen().getByRole("button", { name: /^#\d+ Login devolve 401 depois do deploy das 9h, dia todo$/ });
    expect(due.querySelector(".cal-chip__title > .ac-who .ac-avatar--agent")).not.toBeNull();
    expect(due.getAttribute("title")).toBe(`${due.textContent} · Ada · Dia todo`);
  });

  test("a task nobody has yet shows its due date without a face", async () => {
    const monday = mondayOf(today);
    await go((api) => api.issues.create(ORG_ID, { title: "Fechar a release", dueDate: toYmd(monday) }));
    const due = screen().getByRole("button", { name: /^#\d+ Fechar a release, dia todo$/ });
    expect(due.querySelector(".ac-who")).toBeNull();
    expect(due.getAttribute("title")).toBe(due.getAttribute("aria-label"));
    // Where a column has room only for a face, its kind's glyph stands in (the CSS shows it there).
    expect(due.querySelector(".cal-chip__title > svg.cal-chip__glyph")).not.toBeNull();
  });

  test("a task several have opens with the first one's face and counts for each of them in Agents and people", async () => {
    const monday = mondayOf(today);
    const count = (name: string) => {
      const row = [...document.querySelectorAll(".cal-owner")].find(
        (r) => r.querySelector(".ac-who b")?.textContent === name,
      );
      return Number(row?.querySelector(".cal-owner__count")?.textContent ?? 0);
    };
    const open = async () => {
      const filters = screen().queryByRole("button", { name: "Filtros" });
      if (filters) await click(filters);
      await settle(2);
    };
    await go();
    await open();
    const before = { joao: count("João"), atlas: count("Atlas") };
    cleanup();
    await go((api) =>
      api.issues.create(ORG_ID, {
        title: "Fechar a release",
        dueDate: toYmd(monday),
        assignees: [
          { type: "person", id: "u-joao" },
          { type: "agent", id: ATLAS_ID },
        ],
      }),
    );
    const due = screen().getByRole("button", { name: /^#\d+ Fechar a release, dia todo$/ });
    expect(due.querySelector(".ac-who .ac-avatar")?.getAttribute("data-kind")).toBe("person");
    await open();
    expect({ joao: count("João"), atlas: count("Atlas") }).toEqual({ joao: before.joao + 1, atlas: before.atlas + 1 });
    // It stays while one of them shows, and goes once both are hidden.
    const owners = screen().getByRole("region", { name: "Agentes e pessoas" });
    await click(within(owners).getByRole("checkbox", { name: "Mostrar João" }));
    await settle(2);
    expect(screen().queryByRole("button", { name: /^#\d+ Fechar a release, dia todo$/ })).not.toBeNull();
    await click(
      within(screen().getByRole("region", { name: "Agentes e pessoas" })).getByRole("checkbox", {
        name: "Mostrar Atlas",
      }),
    );
    await settle(2);
    expect(screen().queryByRole("button", { name: /^#\d+ Fechar a release, dia todo$/ })).toBeNull();
  });

  test("what's over is drawn lighter: a reminder whose time came, an event that ended", async () => {
    await go(async (api) => {
      addReminders(api, [{ message: "Lembrete 1", at: at(0, 1) }]);
      await api.calendar.create(ORG_ID, {
        title: "Amanhã cedo",
        start: new Date(at(9).getTime() + 86_400_000).toISOString(),
        end: new Date(at(10).getTime() + 86_400_000).toISOString(),
        recurrence: "none",
        participants: [],
      });
    });
    const col = document.querySelector(`.cal-week__col[data-day="${toYmd(today)}"]`) as HTMLElement;
    expect(within(col).getByRole("button", { name: "Lembrete 1, 00:01" }).hasAttribute("data-past")).toBe(true);
    const later = screen().queryByRole("button", { name: "Amanhã cedo, 09:00–10:00" });
    if (later) expect(later.hasAttribute("data-past")).toBe(false);
  });

  test("a reminder's details open with whose it is (Atlas · Ops), then the title, when and where it posts", async () => {
    await go(async (api) =>
      addReminders(api, [{ message: "Conferir os erros do dia", at: at(18), agentId: ATLAS_ID }]),
    );
    await click(screen().getByRole("button", { name: "Conferir os erros do dia, 18:00" }));
    await settle(2);
    const details = screen().getByRole("region", { name: "Conferir os erros do dia" });
    const owner = details.firstElementChild as HTMLElement;
    expect(owner.classList.contains("cal-details__owner")).toBe(true);
    expect(owner.textContent).toBe("Atlas · Ops");
    expect(owner.querySelector(".ac-who .ac-avatar--agent")).not.toBeNull();
    expect(details.querySelector(".cal-details__title")?.textContent).toBe("Conferir os erros do dia");
    expect(details.textContent).toContain("Lembrete · postado em #eng");
    // The agent says it once: no list of people under a reminder.
    expect(details.querySelector(".cal-details__people")).toBeNull();
  });

  test("Agentes e pessoas: everyone with something in view, agents first, by count; unchecking hides theirs", async () => {
    await go(async (api) =>
      addReminders(api, [{ message: "Conferir os erros do dia", at: at(18), agentId: ATLAS_ID }]),
    );
    // With the panel closed, in the Filtros popover.
    const filters = screen().queryByRole("button", { name: "Filtros" });
    if (filters) await click(filters);
    await settle(2);
    const owners = () => screen().getByRole("region", { name: "Agentes e pessoas" });
    const rows = () =>
      [...owners().querySelectorAll(".cal-owner")].map((r) => [
        r.querySelector(".ac-who b")?.textContent,
        r.querySelector(".cal-owner__count")?.textContent,
      ]);
    const names = rows().map(([n]) => n);
    expect(names.slice(0, 2).sort()).toEqual(["Ada", "Atlas"]);
    expect(names.slice(2).sort()).toEqual(["João", "Walter"]);
    const atlas = rows().find(([n]) => n === "Atlas")?.[1];
    expect(Number(atlas)).toBeGreaterThan(0);
    await click(within(owners()).getByRole("checkbox", { name: "Mostrar Atlas" }));
    await settle(2);
    expect(screen().queryByRole("button", { name: /^Conferir os erros do dia, / })).toBeNull();
    expect(screen().getAllByRole("button", { name: /^Daily de produto, / }).length).toBeGreaterThan(0);
    // Still listed, to bring them back.
    const box = within(owners()).getByRole("checkbox", { name: "Mostrar Atlas" });
    expect(box.getAttribute("aria-checked")).toBe("false");
    await click(box);
    await settle(2);
    expect(screen().getAllByRole("button", { name: /^Conferir os erros do dia, / }).length).toBeGreaterThan(0);
  });

  test("the side panel opens beside the week from 1440, with Agentes e pessoas under the mini month", async () => {
    const own = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const set = (w: number) => Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
    try {
      set(1280);
      await go();
      expect(screen().queryByRole("complementary", { name: "Painel do calendário" })).toBeNull();
      cleanup();
      set(1440);
      await go();
      const side = screen().getByRole("complementary", { name: "Painel do calendário" });
      const sections = [...side.querySelectorAll(":scope > section")].map((s) => s.getAttribute("aria-label"));
      expect(sections.indexOf("Agentes e pessoas")).toBe(sections.indexOf("Próximos") - 1);
      // Próximos opens each row with its owner's face.
      for (const row of side.querySelectorAll(".cal-upcoming .ac-row"))
        expect(row.querySelector(".ac-row__lead .ac-avatar")).not.toBeNull();
    } finally {
      if (own) Object.defineProperty(window, "innerWidth", own);
      else delete (window as { innerWidth?: number }).innerWidth;
    }
  });

  test("Próximos: neutral rows (avatar or event icon, title, day · time), no source bar", async () => {
    const tomorrow = new Date(at(9).getTime() + 86_400_000);
    await go(async (api) => addReminders(api, [{ message: "Pagar o aluguel", at: tomorrow }]));
    const show = screen().queryByRole("button", { name: "Mostrar painel" });
    if (show) await click(show);
    const side = screen().getByRole("region", { name: "Próximos" });
    const rows = [...side.querySelectorAll<HTMLElement>(".ac-row")];
    expect(rows.length).toBeGreaterThan(0);
    expect(side.querySelector(".cal-upcoming__item, [data-source]")).toBeNull();
    for (const row of rows) {
      // The lead on the title's first line; a long title wraps whole, no "…" and no hover to read it.
      expect(row.querySelector(".ac-row__lead")).not.toBeNull();
      expect(row.classList.contains("ac-iconline")).toBe(true);
      expect(row.querySelector(".ac-row__title")?.hasAttribute("title")).toBe(false);
    }
    expect(rows.some((r) => / · \d{2}:\d{2}$/.test(r.querySelector(".ac-row__meta")?.textContent ?? ""))).toBe(true);
  });

  test("an empty week keeps the grid with a quiet hint", async () => {
    await go();
    const show = screen().queryByRole("button", { name: "Mostrar painel" });
    if (show) await click(show);
    const filters = screen().getByRole("group", { name: "Filtros" });
    for (const b of within(filters).getAllByRole("button")) await click(b);
    await settle(2);
    expect(document.querySelectorAll(".cal-week__col")).toHaveLength(7);
    expect(screen().getByText("Nada marcado. Arraste para criar ou aperte N")).toBeTruthy();
  });

  test("the all-day lane's gutter is a mark named Dia todo, never words that wrap in the hours' 44px column", async () => {
    await go((api) =>
      api.calendar.create(ORG_ID, {
        title: "Feriado",
        start: at(0).toISOString(),
        end: at(23, 59).toISOString(),
        allDay: true,
        recurrence: "none",
        participants: [],
      }),
    );
    const gutter = document.querySelector(".cal-week__bars > .cal-week__gutter");
    expect(gutter?.textContent?.trim()).toBe("");
    expect(within(gutter as HTMLElement).getByRole("img", { name: "Dia todo" })).toBeTruthy();
  });

  test("on a phone it opens on the day, not on a week of seven columns too narrow to read", async () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) =>
      query === "(max-width: 640px)"
        ? ({ matches: true, media: query } as MediaQueryList)
        : matchMedia.call(window, query)) as typeof window.matchMedia;
    try {
      await go();
      expect(screen().getByRole("radio", { name: "Dia" }).getAttribute("aria-checked")).toBe("true");
      expect(document.querySelectorAll(".cal-week__col")).toHaveLength(1);
    } finally {
      window.matchMedia = matchMedia;
    }
  });
});

describe("Calendário: reminders", () => {
  const reminder = (over: Partial<CalendarReminder> = {}): CalendarReminder => ({
    id: "rem-1",
    message: "Call com o cliente",
    at: at(9).toISOString(),
    forUserId: "u-joao",
    channelId: ENG_ID,
    threadId: null,
    agentId: ADA_ID,
    createdBy: "u-joao",
    canCancel: true,
    ...over,
  });
  /** The calendar with these reminders, and every cancel asked. */
  const withReminders = async (seeded: CalendarReminder[]) => {
    let reminders = seeded;
    const canceled: string[] = [];
    await go(async (api) => {
      const range = api.calendar.range;
      api.calendar.range = async (...args) => ({ ...(await range(...args)), reminders });
      api.reminders = {
        create: async () => ({}) as never,
        list: async () => [],
        cancel: async (_org, id) => {
          canceled.push(id);
          reminders = [];
          return {} as never;
        },
      };
    });
    return canceled;
  };
  const chip = () => screen().queryByRole("button", { name: /^Call com o cliente, / });

  test("a reminder is on the calendar with its time, who set it and where it posts, and who set it cancels it", async () => {
    const canceled = await withReminders([reminder()]);
    // A moment: one line at its time, the agent that posts it opening it.
    expect(chip()?.classList.contains("cal-chip--moment")).toBe(true);
    expect(chip()?.closest(".cal-week__moment")).not.toBeNull();
    expect(chip()?.querySelector(".cal-chip__title > .ac-who .ac-avatar--agent")).not.toBeNull();
    await click(chip() as HTMLElement);
    await settle(2);
    const section = document.querySelector(".cal-details") as HTMLElement;
    const details = within(section);
    expect(section.querySelector(".cal-details__owner")?.textContent).toBe("Ada · Dev");
    expect(details.getByText(/09:00/)).toBeTruthy();
    expect(details.getByText("Lembrete · postado em #eng")).toBeTruthy();
    expect(details.getByText("Criado por João")).toBeTruthy();
    await click(details.getByRole("button", { name: "Cancelar lembrete" }));
    await settle(4);
    expect(canceled).toEqual(["rem-1"]);
    expect(chip()).toBeNull();
  });

  test("someone else's offers no cancel, and the Lembretes filter hides them", async () => {
    await withReminders([reminder({ canCancel: false })]);
    await click(chip() as HTMLElement);
    await settle(2);
    expect(screen().queryByRole("button", { name: "Cancelar lembrete" })).toBeNull();
    await act(async () => fireEvent.keyDown(document.activeElement ?? window, { key: "Escape" }));
    await settle(2);
    // Under 1440 the sources are in the Filtros popover.
    await click(screen().getByRole("button", { name: "Filtros" }));
    await settle(2);
    await click(screen().getByRole("button", { name: /^Lembretes/ }));
    await settle(2);
    expect(chip()).toBeNull();
  });
});
