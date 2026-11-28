import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const ids = { threadId: null, runId: "r-live", agentId: ADA_ID };

const open = async () => {
  const state = seedState();
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  const ev = (event: Record<string, unknown>) =>
    act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
  return { state, ev };
};
const started = (ev: (event: Record<string, unknown>) => Promise<void>) =>
  ev({ type: "agent.run", ...ids, status: "running", startedAt: new Date(Date.now() - 73_000).toISOString() });
/** At work for a while already, on a step. */
const thinking = async (ev: (event: Record<string, unknown>) => Promise<void>) => {
  await started(ev);
  await ev({ type: "agent.tool", ...ids, tool: "read_file", toolUseId: "t1", detail: "apps/api/auth/refresh.ts" });
  await settle(3);
};
/** At work for a while already, writing its reply (an older server's delta carries some of it). */
const writing = async (ev: (event: Record<string, unknown>) => Promise<void>) => {
  await started(ev);
  await ev({ type: "agent.typing", ...ids });
  await ev({ type: "agent.delta", ...ids, seq: 0, text: "O refresh expira cedo." });
  await settle(3);
};
/** The conversation's last row while it works, and its line. */
const tail = () => document.querySelector(".working-tail") as HTMLElement;
const line = () => tail().querySelector(".working-tail__line") as HTMLElement;
/** The bar above the composer: it holds no work any more. */
const bar = () => document.querySelector(".channel__composer > .ac-typing") as HTMLElement;
const row = () => document.querySelector('[data-run-id="r-live"]') as HTMLElement | null;
const typing = (ev: (event: Record<string, unknown>) => Promise<void>) =>
  ev({ type: "user.typing", userId: "u-joao", threadId: null, ttlMs: 6000 });
const cancels = (state: ReturnType<typeof seedState>) => state.calls.filter((c) => c.method === "agents.cancelRun");

describe("while it works the conversation's last row says it, as a reply on its way: no row of its own, writing or not", () => {
  test("on a step: its face with its rings, what it does, its time and its stop; the bar above the composer is empty", async () => {
    const { state, ev } = await open();
    await thinking(ev);
    await act(() => new Promise((r) => setTimeout(r, 2100)));
    await settle(2);
    expect(row()).toBeNull();
    expect(document.querySelector(".ac-msg--waiting")).toBeNull();
    // The last thing in the conversation.
    expect(tail().parentElement?.lastElementChild).toBe(tail());
    expect(tail().querySelector(".working-tail__face .ac-orbit .ac-avatar--agent")).not.toBeNull();
    // Two rings, whole behind the face.
    expect(tail().querySelectorAll(".ac-orbit__back circle.ac-orbit__path")).toHaveLength(2);
    expect(line().querySelector(".ac-typing__text")?.textContent).toBe("Ada mexendo nos arquivos do PC · refresh.ts…");
    expect(line().querySelector(".ac-typing__step")?.getAttribute("title")).toBe(
      "mexendo nos arquivos do PC · refresh.ts…",
    );
    expect(line().querySelector(".run-tail__clock")?.textContent).toBe("1 min");
    expect(bar().dataset.active).toBe("false");
    expect(bar().textContent).toBe("");
    // Its stop is on its row, and the composer's still stops it too.
    await act(async () => fireEvent.click(within(line()).getByRole("button", { name: "Parar" })));
    await settle(2);
    expect(cancels(state)).toHaveLength(1);
  });

  test("its first minute shows no time, and its stop is already in place", async () => {
    const { ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running", startedAt: new Date(Date.now() - 20_000).toISOString() });
    await settle(3);
    expect(line().querySelector(".run-tail__clock")?.textContent).toBe("");
    expect(within(line()).getByRole("button", { name: "Parar" })).not.toBeNull();
  });

  test("writing: still no row and none of its words; the row says it writes and its time, the composer stops it", async () => {
    const { state, ev } = await open();
    await writing(ev);
    expect(row()).toBeNull();
    expect(document.body.textContent).not.toContain("O refresh expira cedo.");
    expect(line().querySelector(".ac-typing__text")?.textContent).toBe("Ada escrevendo…");
    expect(line().querySelector(".run-tail__clock")?.textContent).toBe("1 min");
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Parar a Ada" })));
    await settle(2);
    expect(cancels(state)).toHaveLength(1);
  });

  test("someone typing beside it: 'Ada mexendo… · 1 min · João digitando…', the time hers", async () => {
    const { ev } = await open();
    await thinking(ev);
    await typing(ev);
    await settle(2);
    expect(line().querySelector(".ac-typing__text")?.textContent).toBe("Ada mexendo nos arquivos do PC · refresh.ts…");
    const took = line().querySelector(".run-tail__clock") as HTMLElement;
    expect(took.textContent).toBe("1 min");
    // Who types has a row of its own under her line, so her step never gives way to it.
    expect(took.closest(".run-tail")?.nextElementSibling).toBeNull();
    const also = line().querySelector(".working-tail__also > .ac-typing__also") as HTMLElement;
    expect(also.textContent).toBe("João digitando…");
    expect(also.querySelector(".ac-typing__typers")?.textContent).toBe("João");
    // Her face leads the row; his is the line's one small face, and who types ends the line.
    expect(line().querySelectorAll(".ac-typing__tok")).toHaveLength(1);
    expect(line().lastElementChild).toBe(also.parentElement);
  });

  test("what it did so far under its line: its own words quoted, the app's line for each call, older ones folded", async () => {
    const { ev } = await open();
    await started(ev);
    await ev({ type: "agent.tool", ...ids, tool: "read_file", toolUseId: "t1", said: "Primeiro o login" });
    await ev({ type: "agent.tool", ...ids, tool: "search_context", toolUseId: "t2" });
    await ev({ type: "agent.tool", ...ids, tool: "read_file", toolUseId: "t3" });
    await settle(3);
    // What it had when the row first had lines shows at once (its words and their call); the next waits its turn
    // (one every 3 s at most).
    const trail = () => [...tail().querySelectorAll(".working-tail__trail > li")].map((li) => li.textContent);
    expect(trail()).toHaveLength(2);
    expect(trail()[0]).toBe("“Primeiro o login”");
    expect(trail()[1]).not.toContain("“");
    await act(() => new Promise((r) => setTimeout(r, 3100)));
    await settle(2);
    expect(trail()).toHaveLength(3);
    // Its line now has its capitals at the face's top, the trail under it.
    expect(line().classList.contains("ac-captop")).toBe(true);
  });
});

test("the composer's own stop is there too while the row speaks", async () => {
  const { ev } = await open();
  await writing(ev);
  expect(line()).not.toBeNull();
  expect(screen().getByRole("button", { name: "Parar a Ada" })).toBeTruthy();
});
