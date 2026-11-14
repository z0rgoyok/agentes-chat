import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { AgentWork, ManagedTask } from "../src/api/types";
import { agoraContext, agoraGlyph, agoraPhrase, agoraSections, taskWorkState } from "../src/lib/agora";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function translator(lng: string): TFunction {
  const i18n = i18next.createInstance();
  void i18n.init({ lng, fallbackLng: "en", resources, initAsync: false, interpolation: { escapeValue: false } });
  return i18n.t.bind(i18n) as TFunction;
}
const t = translator("pt-BR");

const task = (over: Partial<ManagedTask> & Pick<ManagedTask, "runId">): ManagedTask => ({
  agentId: "atlas",
  channelId: "c-vendas",
  channelKind: "channel",
  channelName: "vendas",
  threadId: null,
  status: "running",
  startedAt: ago(22),
  createdAt: ago(22),
  label: null,
  background: false,
  routine: null,
  plan: null,
  requester: null,
  brain: "model",
  machine: null,
  now: null,
  steps: 0,
  pendingMessageIds: [],
  canStop: true,
  ...over,
});
const work = (state: AgentWork["state"], since: string): AgentWork => ({
  state,
  ask: null,
  since,
  runId: "r",
  channelId: null,
  channelKind: null,
  channelName: null,
  threadId: null,
  messageId: null,
  forAgentId: null,
  routine: false,
  count: 1,
});

describe("Agora (ADR 0128 addendum)", () => {
  test("rows by section, the longest first; a wait on someone else is on hold, never yours", () => {
    const view = {
      tasks: [
        task({ runId: "new", startedAt: ago(2), work: { state: "working", since: ago(2), card: null } }),
        task({ runId: "old", startedAt: ago(40), work: { state: "working", since: ago(40), card: null } }),
        task({ runId: "mine", status: "waiting_approval", work: { state: "you", since: ago(3), card: "m" } }),
        task({ runId: "theirs", status: "waiting_approval", work: { state: "approval", since: ago(3), card: "m" } }),
        // An older server says no work: what its status says, and never "you".
        task({ runId: "older", status: "waiting_approval" }),
      ],
    };
    const s = agoraSections(view);
    expect(s.you.map((i) => i.key)).toEqual(["mine"]);
    expect(s.working.map((i) => i.key)).toEqual(["old", "new"]);
    expect(s.waiting.map((i) => i.key).sort()).toEqual(["older", "theirs"]);
    expect(taskWorkState(task({ runId: "x", status: "waiting_input", held: "computer_busy" }))).toBe("queued");
    expect(taskWorkState(task({ runId: "x", status: "waiting_input", held: "plan", work: null }))).toBe("plan");
  });

  test("a row's words: an agent's line's phrase, then where and on what", () => {
    const [helping] = agoraSections({
      tasks: [
        task({
          runId: "h",
          channelKind: "dm",
          channelName: null,
          betweenAgents: true,
          delegation: {
            agentId: "ada",
            origin: { kind: "agent" },
            from: {
              channelId: "c-vendas",
              channelKind: "channel",
              channelName: "vendas",
              threadId: "t",
              messageId: "m",
              label: "Corrigir o link",
            },
          },
        }),
      ],
    }).working;
    if (!helping) throw new Error("no row");
    expect(agoraPhrase(t, "pt-BR", helping, "Ada", NOW)).toBe("ajudando a Ada");
    expect(agoraContext(t, helping)).toBe("#vendas › Corrigir o link");
    const [routine] = agoraSections({
      tasks: [task({ runId: "r", background: true, routine: { id: "rt", name: "Backups" } })],
    }).working;
    if (!routine) throw new Error("no row");
    expect(agoraPhrase(t, "pt-BR", routine, undefined, NOW)).toBe("numa rotina");
    expect(agoraContext(t, routine)).toBe("Rotina «Backups»");
  });

  test("the button: at rest, the longest-running agent's orbit, amber over it once something waits on you", () => {
    expect(agoraGlyph([], 0)).toEqual({ mark: "idle", agentId: null, working: 0, waiting: 0 });
    const statuses = [
      { agentId: "ada", work: work("working", ago(5)) },
      { agentId: "atlas", work: work("working", ago(30)) },
    ];
    expect(agoraGlyph(statuses, 0)).toEqual({ mark: "working", agentId: "atlas", working: 2, waiting: 0 });
    // A run this app hears counts before the list says so.
    expect(agoraGlyph(statuses, 0, new Set(["theo"])).working).toBe(3);
    expect(agoraGlyph(statuses, 2).mark).toBe("you");
    expect(agoraGlyph([{ agentId: "ada", work: work("you", ago(1)) }], 0)).toMatchObject({ mark: "you", waiting: 1 });
  });
});
