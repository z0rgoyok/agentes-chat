import { expect, test } from "bun:test";
import { ptBR } from "@agenteschat/i18n";
import i18next from "i18next";
import { applyChannelEvent, emptyStreams } from "../src/index";
import { barStep } from "../src/lib/work";

const i18n = i18next.createInstance();
await i18n.init({ lng: "pt-BR", resources: { "pt-BR": { translation: ptBR } }, interpolation: { escapeValue: false } });
const t = i18n.t;

type Ev = Parameters<typeof applyChannelEvent>[1];
const base = { channelId: "c1", threadId: "m1", runId: "r1", agentId: "ada" };
const at = 1_000_000;
const running = { type: "agent.run", ...base, status: "running" };
const intent = { type: "agent.intent", ...base, text: "Procurando o e-mail do dono do workspace" };

/** The bar's step for run r1 after these events, `ms` into its turn. */
function stepAfter(events: Record<string, unknown>[], ms = 1000) {
  let s = emptyStreams;
  for (const e of events) s = applyChannelEvent(s, e as Ev, at);
  const run = s.runs.r1;
  if (!run) return null;
  return barStep(t, { ...run, startedAt: at, workingSince: at }, "pt-BR", at + ms);
}

test("what it is about to do takes the place of 'pensando…' and 'escrevendo…'", () => {
  expect(stepAfter([running])).toBe("pensando…");
  expect(stepAfter([running, intent])).toBe("procurando o e-mail do dono do workspace…");
  expect(stepAfter([running, intent, { type: "agent.typing", ...base }])).toBe(
    "procurando o e-mail do dono do workspace…",
  );
  expect(stepAfter([running, { type: "agent.typing", ...base }])).toBe("escrevendo…");
});

test("a real step says what it does, and the line comes back between calls", () => {
  const call = { type: "agent.tool", ...base, tool: "search_context", toolUseId: "b1" };
  expect(stepAfter([running, intent, call])).toBe("buscando no histórico…");
  expect(stepAfter([running, intent, call, { ...call, tool: null }])).toBe("procurando o e-mail do dono do workspace…");
  // Its own words for a step, once the turn has gone on, are its own: they win.
  expect(
    stepAfter([running, intent, { ...call, said: "Vou olhar a lista de membros" }, { ...call, tool: null }], 9000),
  ).toBe("“Vou olhar a lista de membros”");
});

test("its own line on the way ends it, and a late one after it says nothing", () => {
  const said = {
    type: "message.created",
    channelId: "c1",
    message: {
      id: "s1",
      channelId: "c1",
      threadId: "m1",
      agentRunId: null,
      body: "Já vejo.",
      meta: { sayNow: { runId: "r1" } },
    },
  };
  expect(stepAfter([running, intent, said])).toBe("pensando…");
  expect(stepAfter([running, said, intent])).toBe("pensando…");
});

test("a line for a run this conversation doesn't show, or one that ended, makes no row", () => {
  expect(stepAfter([intent])).toBeNull();
  expect(stepAfter([running, { type: "agent.idle", ...base }, intent])).toBeNull();
});
