import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { HOVER_CLOSE_MS } from "../src";
import { Tip } from "../src/components/Tip";
import { box, mouse, place, step, tick } from "../testing";

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  cleanup();
  // The shared window's 0 ms batch must still run for the files after this one (see hover-card.test.tsx).
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

const OPEN_MS = 250;
const tip = () => document.querySelector<HTMLElement>(".ac-tip");
const { enter, leave, move } = mouse;

/*
 * The pill at 100,200 (60×20); its tip 6 px over it (220×34, from 100,160 to 320,194), with a link that does what the
 * pill does. Another button further down the row, at 400,200.
 */
const PILL = box(100, 200, 60, 20);
const BUBBLE = box(100, 160, 220, 34);

function view(fixes: { count: number }, button = false) {
  const link = (
    <button type="button" tabIndex={-1} className="ac-link" onClick={() => fixes.count++}>
      Ative o Modo de Desenvolvedor
    </button>
  );
  render(
    <div>
      {button ? (
        <Tip tip={link} look="ac-msg__tip" button delay={OPEN_MS}>
          <button type="button">Precisa de você</button>
        </Tip>
      ) : (
        <Tip tip={link} look="ac-msg__tip" delay={OPEN_MS} tabIndex={0} data-testid="pill">
          <span>Precisa de você</span>
        </Tip>
      )}
    </div>,
  );
  const trigger = (
    button ? document.querySelector("button") : document.querySelector("[data-testid=pill]")
  ) as HTMLElement;
  place(trigger, PILL);
  return trigger;
}

async function openOn(trigger: HTMLElement) {
  await enter(trigger, 130, 210);
  await tick(OPEN_MS);
  const bubble = tip();
  expect(bubble).not.toBeNull();
  place(bubble, BUBBLE);
  return bubble as HTMLElement;
}

describe("a tip the pointer can enter", () => {
  for (const button of [false, true]) {
    test(`${button ? "a button's" : "an element's"}: it stays open across the gap and on it, and its link clicks`, async () => {
      const fixes = { count: 0 };
      const trigger = view(fixes, button);
      const bubble = await openOn(trigger);
      // Up out of the pill, through the 6 px gap, slower than the grace.
      await leave(trigger, 130, 199);
      await move(document.body, 130, 197);
      await tick(HOVER_CLOSE_MS * 3);
      expect(tip()).not.toBeNull();
      await enter(bubble, 130, 180);
      await tick(HOVER_CLOSE_MS * 3);
      expect(tip()).not.toBeNull();
      const link = bubble.querySelector("button") as HTMLButtonElement;
      await step(() => {
        fireEvent.pointerDown(link, { pointerType: "mouse", pointerId: 1 });
        fireEvent.click(link);
      });
      expect(fixes.count).toBe(1);
    });
  }

  test("toward the far end of the tip, over what lies in the triangle, it waits for the pointer", async () => {
    const trigger = view({ count: 0 });
    await openOn(trigger);
    // Out of the pill's right side, up and to the right toward the tip's far corner: off the pill and off the gap.
    await leave(trigger, 160, 202);
    await move(document.body, 200, 198);
    await tick(HOVER_CLOSE_MS - 50);
    await move(document.body, 260, 196);
    await tick(HOVER_CLOSE_MS - 50);
    expect(tip()).not.toBeNull();
  });

  test("settling elsewhere closes it after the grace, not at once", async () => {
    const trigger = view({ count: 0 });
    await openOn(trigger);
    await leave(trigger, 130, 221);
    await move(document.body, 130, 240);
    await tick(HOVER_CLOSE_MS - 1);
    expect(tip()).not.toBeNull();
    await tick(1);
    expect(tip()).toBeNull();
  });

  test("the keys' focus opens it at once, and the focus going to its link keeps it", async () => {
    const trigger = view({ count: 0 });
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Tab" });
      trigger.focus();
    });
    const bubble = tip();
    expect(bubble).not.toBeNull();
    const link = bubble?.querySelector("button") as HTMLButtonElement;
    await step(() => fireEvent.blur(trigger, { relatedTarget: link }));
    expect(tip()).not.toBeNull();
    await step(() => fireEvent.blur(trigger, { relatedTarget: document.body }));
    expect(tip()).toBeNull();
  });

  test("a button's tip the keys opened closes when the focus leaves its link", async () => {
    const trigger = view({ count: 0 }, true);
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Tab" });
      trigger.focus();
    });
    const link = tip()?.querySelector("button") as HTMLButtonElement;
    expect(link).toBeTruthy();
    await step(() => fireEvent.blur(trigger, { relatedTarget: link }));
    expect(tip()).not.toBeNull();
    await step(() => fireEvent.blur(link, { relatedTarget: document.body }));
    expect(tip()).toBeNull();
  });
});
