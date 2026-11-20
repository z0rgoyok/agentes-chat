import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import { withHandedWork } from "../src/api/queries";
import type { Message, WorkView } from "../src/api/types";
import { handedLine } from "../src/lib/long-work";

const NOW = new Date("2026-11-15T21:20:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

function translator(lng: string): TFunction {
  const i18n = i18next.createInstance();
  void i18n.init({ lng, fallbackLng: "en", resources, initAsync: false, interpolation: { escapeValue: false } });
  return i18n.t.bind(i18n) as TFunction;
}
const en = translator("en");

const work = (over: Partial<WorkView> = {}): WorkView => ({
  id: "w-1",
  agentId: "atlas",
  channelId: "dm-walter-lodi",
  title: "October sales report",
  status: "live",
  state: "working",
  how: "handed",
  anchorMessageId: "note-1",
  threadId: null,
  homeThreadId: null,
  runId: "run-atlas",
  requestedByUserId: "walter",
  startedAt: ago(2),
  finishedAt: null,
  nextUpdateAt: ago(-8),
  lastUpdate: { text: "Matched 37 refunds.", at: ago(1), seq: 2 },
  question: null,
  plan: [],
  issue: { id: "i-131", number: 131 },
  resultMessageId: null,
  queuePosition: null,
  pausedUntil: null,
  canceledByUserId: null,
  errorCode: null,
  handedBy: { agentId: "lodi", consultationId: "c-1" },
  askerRunId: "run-lodi",
  planStep: { current: 3, total: 5 },
  result: null,
  ...over,
});
const ctx = { locale: "en", now: NOW, meId: "walter", agentName: "Atlas", canStop: true };

describe("a handed work's line under the reply that handed it (F1)", () => {
  test("working: the state, its step and how long; Stop, no task label and no repeated update", () => {
    const h = handedLine(en, work(), ctx);
    expect(h).toMatchObject({
      tone: "working",
      state: "working on it",
      facts: ["step\u00a03\u00a0of\u00a05", "2\u00a0min"],
    });
    expect(h.stop).toEqual({ runId: "run-atlas" });
    expect(h).not.toHaveProperty("task");
    expect(h).not.toHaveProperty("update");
  });

  test("waiting on the reader: amber words for them, the plain ones for anyone else", () => {
    const asked = { text: "5 people or 12?", messageId: "q-1", requestedForUserId: "walter" };
    const waiting = work({ state: "waiting_input", question: asked, startedAt: ago(1) });
    expect(handedLine(en, waiting, ctx)).toMatchObject({
      tone: "waiting",
      state: "waiting for your answer",
      facts: ["1\u00a0min"],
    });
    expect(handedLine(en, waiting, { ...ctx, meId: "joao" }).state).toBe("waiting for an answer");
  });

  test("done: how long it took and See the result, nothing to stop", () => {
    const done = work({ status: "done", state: null, finishedAt: ago(0), startedAt: ago(10), resultMessageId: "r-1" });
    const h = handedLine(en, done, ctx);
    expect(h).toMatchObject({ tone: "done", state: "done in 10\u00a0min", facts: [] });
    expect(h.result).toEqual({ messageId: "r-1", label: "See the result" });
    expect(h.stop).toBeNull();
  });
});

describe("the cache puts the line under the run that handed it", () => {
  const message = (id: string, runId: string | null, over: Partial<Message> = {}) =>
    ({ id, agentRunId: runId, ...over }) as Message;

  test("under the run's last message here, replaced in place when it changes", () => {
    const list = [message("m-1", "run-walter"), message("m-2", "run-lodi"), message("m-3", "run-lodi")];
    const first = withHandedWork(list, work());
    expect(first.map((m) => m.handedWorks?.length ?? 0)).toEqual([0, 0, 1]);
    const next = withHandedWork(first, work({ state: "waiting_input" }));
    expect(next[2]?.handedWorks?.[0]?.state).toBe("waiting_input");
    expect(next[2]?.handedWorks).toHaveLength(1);
  });

  test("a run with no message here yet leaves the list as it is", () => {
    const list = [message("m-1", "run-walter")];
    expect(withHandedWork(list, work())).toBe(list);
  });
});
