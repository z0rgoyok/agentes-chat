import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { DATE_PILL_IDLE_MS, dayAtTop } from "@/lib/date-pill";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(cleanup);

/** How many times a day line's place was read (`dayAtTop` reads each line above the top edge once a pass). */
let reads = 0;
const at = (el: Element, top: number) => {
  (el as HTMLElement).getBoundingClientRect = () => {
    if ((el as HTMLElement).dataset.day) reads++;
    return { top } as DOMRect;
  };
};
/** The next frame, where the pill reads what is at the top. */
const frame = () => act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));

describe("the day at the top of the list", () => {
  const list = (tops: [string, number][], listTop = 100) => {
    const el = document.createElement("section");
    at(el, listTop);
    for (const [day, top] of tops) {
      const divider = document.createElement("div");
      divider.dataset.day = day;
      at(divider, top);
      el.append(divider);
    }
    return el;
  };

  test("the last day line at or above the top edge; none above the first one (the greeting and its cards) or with none", () => {
    expect(
      dayAtTop(
        list([
          ["d1", -400],
          ["d2", 40],
          ["d3", 600],
        ]),
      ),
    ).toBe("d2");
    expect(
      dayAtTop(
        list([
          ["d1", -400],
          ["d2", 100.5],
        ]),
      ),
    ).toBe("d2");
    // The top above the first day: the conversation's start (its greeting, the setup card) has no day to float over it.
    expect(
      dayAtTop(
        list([
          ["d1", 300],
          ["d2", 900],
        ]),
      ),
    ).toBeNull();
    expect(
      dayAtTop(
        list([
          ["d1", -400],
          ["d2", -10],
        ]),
      ),
    ).toBe("d2");
    expect(dayAtTop(list([]))).toBeNull();
  });
});

describe("the floating date while scrolling", () => {
  test("the person's scroll shows the day of the messages at the top, the same words as its day line; it fades after", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const log = screen().getByRole("region", { name: "Mensagens" });
    const dividers = [...log.querySelectorAll<HTMLElement>("[data-day]")];
    expect(dividers.length).toBeGreaterThan(0);
    at(log, 0);
    for (const d of dividers) at(d, -100);
    expect(document.querySelector(".channel__date")).toBeNull();
    // A layout change scrolling the list says nothing.
    await act(async () => fireEvent.scroll(log));
    expect(document.querySelector(".channel__date")).toBeNull();
    // A wheel's many scroll events in one frame: the pill reads the day lines once.
    reads = 0;
    await act(async () => {
      fireEvent.wheel(log, { deltaY: -40 });
      for (let i = 0; i < 5; i++) fireEvent.scroll(log);
    });
    await frame();
    expect(reads).toBe(dividers.length);
    const pill = document.querySelector(".channel__date") as HTMLElement;
    expect(pill.getAttribute("aria-hidden")).toBe("true");
    expect(pill.hasAttribute("data-shown")).toBe(true);
    expect(pill.textContent).toBe(dividers.at(-1)?.textContent ?? "");
    await act(() => new Promise((r) => setTimeout(r, DATE_PILL_IDLE_MS + 50)));
    expect(pill.hasAttribute("data-shown")).toBe(false);
  });

  test("scrolled up onto the conversation's start, above its first day, the date goes at once instead of lingering", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const log = screen().getByRole("region", { name: "Mensagens" });
    const dividers = [...log.querySelectorAll<HTMLElement>("[data-day]")];
    at(log, 0);
    for (const d of dividers) at(d, -100);
    const scrollUp = async () => {
      await act(async () => {
        fireEvent.wheel(log, { deltaY: -40 });
        fireEvent.scroll(log);
      });
      await frame();
    };
    await scrollUp();
    const pill = document.querySelector(".channel__date") as HTMLElement;
    expect(pill.hasAttribute("data-shown")).toBe(true);
    for (const d of dividers) at(d, 300);
    await scrollUp();
    expect(pill.hasAttribute("data-shown")).toBe(false);
  });
});
