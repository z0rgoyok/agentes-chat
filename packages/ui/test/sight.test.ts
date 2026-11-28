import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { onSight, type Sight, sight, watchSight } from "../src";

let hidden = false;
let focused = true;
let focusAsked = 0;
// After setupDom's own beforeAll: the document exists from there.
beforeAll(() => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  spyOn(document, "hasFocus").mockImplementation(() => {
    focusAsked++;
    return focused;
  });
});

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  hidden = false;
  focused = true;
});

const attr = () => document.documentElement.dataset.sight;

test("present while the window has the focus; another window in front is away, until the pointer comes over it", () => {
  stop = watchSight(60_000);
  expect(sight()).toBe("present");
  expect(attr()).toBeUndefined();
  focused = false;
  window.dispatchEvent(new Event("blur"));
  expect(sight()).toBe("away");
  expect(attr()).toBe("away");
  document.body.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
  expect(sight()).toBe("present");
  document.body.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: null }));
  expect(sight()).toBe("away");
  focused = true;
  window.dispatchEvent(new Event("focus"));
  expect(sight()).toBe("present");
  expect(focusAsked).toBeGreaterThan(0);
});

test("hidden beats everything, and coming back into view is present again", () => {
  stop = watchSight(60_000);
  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(sight()).toBe("hidden");
  expect(attr()).toBe("hidden");
  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(sight()).toBe("present");
});

test("no input for a while is idle, and the first input is present again", async () => {
  stop = watchSight(40);
  await new Promise((r) => setTimeout(r, 120));
  expect(sight()).toBe("idle");
  expect(attr()).toBe("idle");
  window.dispatchEvent(new Event("keydown"));
  expect(sight()).toBe("present");
  expect(attr()).toBeUndefined();
});

test("listeners hear each change once; stopping puts it back to present", () => {
  const heard: Sight[] = [];
  const off = onSight((s) => heard.push(s));
  try {
    stop = watchSight(60_000);
    focused = false;
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("blur"));
    stop();
    stop = null;
    expect(heard).toEqual(["away", "present"]);
    expect(attr()).toBeUndefined();
  } finally {
    off();
  }
});
