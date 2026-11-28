import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ApiClient } from "@agenteschat/client";
import { HOUR_PX } from "@agenteschat/client/lib/calendar";
import { toYmd } from "@agenteschat/client/lib/format";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { pinFileClock } from "./clock";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

pinFileClock();

afterEach(() => cleanup());

const today = (h: number, m: number) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
};

/**
 * The week of a workspace with today's `events`, each element as tall as `drawn` says (0: not measured), and `change`
 * made once it settled: today's column once it settled again, or null when the page broke.
 */
async function todaysColumn(
  drawn: (el: HTMLElement) => number,
  events: { title: string; start: Date; end: Date }[] = [],
  change?: (app: Awaited<ReturnType<typeof renderApp>> & { api: ApiClient }) => Promise<void>,
) {
  const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return drawn(this);
    },
  });
  try {
    const api = createFakeApi(seedState());
    for (const { title, start, end } of events)
      await api.calendar.create(ORG_ID, {
        title,
        start: start.toISOString(),
        end: end.toISOString(),
        recurrence: "none",
        participants: [],
      });
    const app = await renderApp(`/org/${ORG_ID}/calendar`, { api });
    await settle(8);
    if (change) {
      await change({ ...app, api });
      await settle(8);
    }
    return document.querySelector<HTMLElement>(`.cal-week__col[data-day="${toYmd(new Date())}"]`);
  } finally {
    if (own) Object.defineProperty(HTMLElement.prototype, "offsetHeight", own);
    else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
  }
}

/** A meeting's block as tall as it is drawn: its slot. */
const blockHeight = (el: HTMLElement) =>
  el.classList.contains("cal-chip--block") ? Number.parseFloat(el.style.minHeight) || 0 : 0;

/**
 * A meeting is drawn as tall as its slot (two hours, 86px), and the one at 15:00 goes beside it. Made an hour shorter
 * by its bottom edge, it ends where that one starts, which goes back under it. Were its day not measured again, heights
 * that only grow would keep it as tall as it was, and the other meeting beside it.
 */
test("a meeting made shorter keeps no height it no longer has: the one at its new end goes back under it", async () => {
  const coffee = () => screen().getByRole("button", { name: "Café com o time, 15:00–15:30" });
  const col = await todaysColumn(
    blockHeight,
    [
      { title: "Planejamento", start: today(14, 0), end: today(16, 0) },
      { title: "Café com o time", start: today(15, 0), end: today(15, 30) },
    ],
    async () => {
      expect(coffee().style.getPropertyValue("--cols")).toBe("2");
      const edge = screen()
        .getByRole("button", { name: "Planejamento, 14:00–16:00" })
        .querySelector(".cal-chip__resize") as HTMLElement;
      await act(async () => fireEvent.pointerDown(edge, { clientX: 10, clientY: 300, button: 0 }));
      await settle(1);
      await act(async () => fireEvent.pointerMove(window, { clientX: 10, clientY: 300 - HOUR_PX }));
      await act(async () => fireEvent.pointerUp(window, { clientX: 10, clientY: 300 - HOUR_PX }));
    },
  );
  expect(col?.querySelector('[aria-label="Planejamento, 14:00–15:00"]')).not.toBeNull();
  expect(coffee().style.getPropertyValue("--cols")).toBe("1");
});

/**
 * A meeting's details open, and another meeting hours later renamed by someone else: the page reads the calendar again.
 * Only what met the renamed meeting is measured again, so the open meeting's chip and details stay the same elements:
 * they neither pop in again nor drop the focus.
 */
test("an item changed elsewhere on the day leaves an open item's chip and details in place", async () => {
  const chip = () =>
    within(document.querySelector(`.cal-week__col[data-day="${toYmd(new Date())}"]`) as HTMLElement).getByRole(
      "button",
      { name: "Resumo, 07:00–07:30" },
    );
  const details = () => screen().getByRole("dialog", { name: "Resumo" });
  let before: { chip: HTMLElement; details: HTMLElement; focus: Element | null } | undefined;
  await todaysColumn(
    blockHeight,
    [
      { title: "Resumo", start: today(7, 0), end: today(7, 30) },
      { title: "Planejamento", start: today(14, 0), end: today(15, 0) },
    ],
    async ({ api, sockets }) => {
      await act(async () => sockets.last().open());
      await act(async () => fireEvent.click(chip()));
      await settle(2);
      before = { chip: chip(), details: details(), focus: document.activeElement };
      const { events } = await api.calendar.range(ORG_ID, today(0, 0).toISOString(), today(23, 59).toISOString());
      const meeting = events.find((e) => e.title === "Planejamento");
      await api.calendar.update(ORG_ID, meeting?.id ?? "", { title: "Planejamento do trimestre" });
      await act(async () => sockets.last().push({ type: "event", scope: "org", event: { type: "calendar.changed" } }));
    },
  );
  expect(screen().getByRole("button", { name: "Planejamento do trimestre, 14:00–15:00" })).toBeTruthy();
  expect(chip()).toBe(before?.chip as HTMLElement);
  expect(details()).toBe(before?.details as HTMLElement);
  expect(before?.details.contains(before.focus)).toBe(true);
  expect(document.activeElement).toBe(before?.focus as Element);
});
