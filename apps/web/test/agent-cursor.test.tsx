import { afterEach, expect, jest, mock, test } from "bun:test";
import path from "node:path";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

// The face is the avatar kit's own (tested there): here only where the cursor is and how it looks.
mock.module("@/components/AgentAvatar", () => ({ AgentAvatar: () => <i className="face" /> }));

import { type CountedPointer, CURSOR_IDLE_MS, CURSOR_REST_OPACITY } from "@agenteschat/client";
import { act, cleanup, render } from "@testing-library/react";
import { AgentCursor } from "@/components/browser/AgentCursor";
import { declarations } from "./built-css";

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

const at = (x: number, y: number, when: number, n = 1): CountedPointer => ({
  x,
  y,
  width: 1000,
  height: 500,
  act: "click",
  n,
  at: when,
});
const cursor = () => document.querySelector(".brw-cur") as HTMLElement | null;
const rings = () => document.querySelectorAll(".brw-cur-ring").length;
const wait = (ms: number) => act(() => void jest.advanceTimersByTime(ms));
const draw = (pointer: CountedPointer | null) => (
  <AgentCursor agentId="a1" name="Atlas Example" color="sky" pointer={pointer} />
);

test("after the idle time it stays where it was in the quiet look, never gone", async () => {
  jest.useFakeTimers();
  const view = render(draw(at(500, 250, Date.now())));
  await wait(1000);
  expect(cursor()?.classList.contains("is-idle")).toBe(false);
  await wait(CURSOR_IDLE_MS);
  expect(cursor()?.classList.contains("is-idle")).toBe(true);
  expect(cursor()?.style.left).toBe("50%");
  expect(cursor()?.style.top).toBe("50%");
  // The next gesture brings it back to full strength.
  view.rerender(draw(at(100, 100, Date.now(), 2)));
  expect(cursor()?.classList.contains("is-idle")).toBe(false);
});

test("the resting look is dimmed, not hidden", async () => {
  const css = await Bun.file(path.join(import.meta.dir, "../src/components/browser/agent-cursor.css")).text();
  const opacity = declarations(css, ".brw-cur.is-idle").find(([p]) => p === "opacity")?.[1];
  expect(Number(opacity)).toBe(CURSOR_REST_OPACITY);
});

test("an old pointer shown again (a card remounted, control handed back) is placed at rest: no glide, no ring", async () => {
  jest.useFakeTimers();
  const old = at(800, 100, Date.now() - CURSOR_IDLE_MS - 1);
  render(draw(old));
  expect(cursor()?.style.left).toBe("80%");
  expect(cursor()?.style.top).toBe("20%");
  expect(cursor()?.classList.contains("is-idle")).toBe(true);
  // Measuring its frame computes its style at full strength first: it never fades down from there.
  expect(cursor()?.classList.contains("is-placed")).toBe(true);
  await wait(1000);
  expect(rings()).toBe(0);
  // Its name still turns left near the right edge.
  expect(cursor()?.classList.contains("is-flip")).toBe(true);
});

test("placed at rest it is there at once, with no fade; the next gesture fades back in as before", async () => {
  const css = await Bun.file(path.join(import.meta.dir, "../src/components/browser/agent-cursor.css")).text();
  expect(declarations(css, ".brw-cur.is-placed")).toContainEqual(["transition", "none"]);
  jest.useFakeTimers();
  const view = render(draw(at(800, 100, Date.now() - CURSOR_IDLE_MS - 1)));
  view.rerender(draw(at(100, 100, Date.now(), 2)));
  expect(cursor()?.classList.contains("is-placed")).toBe(false);
  // Resting after a gesture it saw, it fades down.
  await wait(1000);
  await wait(CURSOR_IDLE_MS);
  expect(cursor()?.classList.contains("is-idle")).toBe(true);
  expect(cursor()?.classList.contains("is-placed")).toBe(false);
});

test("a fresh click still glides there and rings", async () => {
  jest.useFakeTimers();
  render(draw(at(500, 250, Date.now())));
  // Off the point at first, on its way.
  expect(cursor()?.style.left).not.toBe("50%");
  await wait(1000);
  await wait(10);
  expect(cursor()?.style.left).toBe("50%");
  expect(rings()).toBe(1);
});

test("near the picture's bottom its name opens above the arrow, as on the phone, so the edge never cuts it", async () => {
  const tall = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 400 });
  try {
    const old = Date.now() - CURSOR_IDLE_MS - 1;
    const view = render(draw(at(100, 480, old)));
    expect(cursor()?.classList.contains("is-lift")).toBe(true);
    view.rerender(draw(at(100, 100, old, 2)));
    expect(cursor()?.classList.contains("is-lift")).toBe(false);
  } finally {
    if (tall) Object.defineProperty(HTMLElement.prototype, "clientHeight", tall);
  }
});
