import { describe, expect, test } from "bun:test";
import type { AgentPresence, AgentStatus } from "@agenteschat/client";
import { agentPresenceShown, STATUS_SUGGESTIONS, statusEndNote } from "@agenteschat/client/lib/presence";
import {
  agentWhyKey,
  availabilityOf,
  draftOf,
  inputOf,
  isSuggestion,
  lineText,
  personLine,
  STATUS_EMOJIS,
  untilOf,
} from "../../src/features/status/logic";
import { translator } from "./fixtures";

/** A work with nowhere to show (the bare state). */
const NO_PLACE = {
  channelId: null,
  channelKind: null,
  channelName: null,
  threadId: null,
  messageId: null,
  forAgentId: null,
  routine: false,
  count: 1,
} as const;

const NOW = new Date(2026, 9, 30, 10, 0);

describe("the Status screen's draft (ADR 0084)", () => {
  test("what you picked, read back from how you appear to yourself", () => {
    expect(availabilityOf("online")).toBe("auto");
    expect(availabilityOf("offline")).toBe("auto");
    expect(availabilityOf(undefined)).toBe("auto");
    expect(availabilityOf("away")).toBe("away");
    expect(availabilityOf("busy")).toBe("busy");
    expect(availabilityOf("hidden")).toBe("hidden");
    expect(availabilityOf("out")).toBe("out");
  });

  test("it starts from your saved line, keeping its end", () => {
    expect(draftOf(undefined)).toEqual({ availability: "auto", emoji: null, text: "", until: { at: null } });
    const until = new Date(NOW.getTime() + 3600_000).toISOString();
    expect(draftOf({ presence: "busy", status: { text: "Em reunião", emoji: "📅", until } })).toEqual({
      availability: "busy",
      emoji: "📅",
      text: "Em reunião",
      until: { at: until },
    });
  });

  test("Salvar: the line trimmed with its end; an empty line clears it", () => {
    const draft = {
      availability: "away" as const,
      emoji: "🍽️",
      text: "  Almoçando ",
      until: { choice: "m30" as const },
    };
    expect(inputOf(draft, NOW)).toEqual({
      availability: "away",
      status: { text: "Almoçando", emoji: "🍽️", until: new Date(NOW.getTime() + 30 * 60_000).toISOString() },
    });
    expect(inputOf({ ...draft, text: "   " }, NOW)).toEqual({ availability: "away", status: null });
    const kept = "2026-10-30T18:00:00.000Z";
    expect(untilOf({ at: kept }, NOW)).toBe(kept);
    expect(untilOf({ choice: "never" }, NOW)).toBeNull();
  });

  test("a suggestion shows chosen only as it was picked", () => {
    const draft = { availability: "busy" as const, emoji: "📅", text: "Em reunião", until: { choice: "h1" as const } };
    expect(isSuggestion(draft, "Em reunião", "📅")).toBe(true);
    expect(isSuggestion({ ...draft, emoji: "🎧" }, "Em reunião", "📅")).toBe(false);
    expect(isSuggestion({ ...draft, text: "Em reunião com o time" }, "Em reunião", "📅")).toBe(false);
  });

  test("the emoji key offers the suggestions' emojis, each once", () => {
    expect(new Set(STATUS_EMOJIS).size).toBe(STATUS_EMOJIS.length);
    expect(STATUS_EMOJIS.every((e) => e.length > 0)).toBe(true);
    for (const s of STATUS_SUGGESTIONS) expect(STATUS_EMOJIS).toContain(s.emoji);
  });
});

describe("how a status reads in a row, a pill and a profile", () => {
  test("the line under a status: with no end, only its owner reads Até você mudar", async () => {
    const t = await translator("pt-BR");
    expect(statusEndNote(t, "pt-BR", null, true)).toBe("Até você mudar");
    expect(statusEndNote(t, "pt-BR", null, false)).toBeNull();
    expect(statusEndNote(t, "pt-BR", new Date(Date.now() + 40 * 86_400_000).toISOString(), false)).toMatch(/^Some /);
  });

  test("a person's line, with when it clears", async () => {
    const t = await translator("pt-BR");
    expect(lineText({ emoji: "📅", text: "Em reunião" })).toBe("📅 Em reunião");
    expect(lineText({ emoji: null, text: "Focado" })).toBe("Focado");
    expect(personLine(t, "pt-BR", { text: "Focado", emoji: null, until: null }, NOW)).toBe("Focado");
    const at3 = new Date(2026, 9, 30, 15, 0).toISOString();
    const line = personLine(t, "pt-BR", { text: "Em reunião", emoji: "📅", until: at3 }, NOW);
    expect(line.startsWith("📅 Em reunião · some às ")).toBe(true);
  });

  test("why an agent appears as it does", () => {
    // At work, waiting on you or free: its work says why, not a presence word (ADR 0084 addendum).
    expect(agentWhyKey("working", false)).toBeNull();
    expect(agentWhyKey("waiting", false)).toBeNull();
    expect(agentWhyKey("online", false)).toBeNull();
    expect(agentWhyKey("out", false)).toBe("out");
    expect(agentWhyKey("offline", false)).toBe("offline");
    expect(agentWhyKey("online", true)).toBe("noAi");
  });

  test("an agent's face: at work whatever its AI reads for this person, waiting on you, free; never busy or away", () => {
    const row = (presence: AgentPresence, working?: boolean, work?: AgentStatus["work"]) => ({
      agentId: "lodi",
      presence,
      status: null,
      activeAt: null,
      ...(working === undefined ? {} : { working }),
      ...(work === undefined ? {} : { work }),
    });
    // Idle with no AI here (the right hand's is each person's own): offline; with one, free (never amber "Ausente").
    expect(agentPresenceShown(row("away"), false)).toBe("offline");
    expect(agentPresenceShown(row("away"), true)).toBe("online");
    // The list says it works: blue, never red "Ocupado".
    expect(agentPresenceShown(row("online", true), false)).toBe("working");
    expect(agentPresenceShown(row("busy", true), false)).toBe("working");
    // Busy with nothing at work (long work waiting on someone's approval): free, as its line says.
    const waits = { state: "approval", ask: null, since: "2026-11-13T00:00:00Z", runId: "r2" } as const;
    expect(agentPresenceShown(row("busy", false, { ...waits, ...NO_PLACE }), true)).toBe("online");
    // Its run heard here before the list's next read says so.
    expect(agentPresenceShown(row("away", false), false, true)).toBe("working");
    expect(agentPresenceShown(undefined, false, true)).toBe("working");
    // It waits on this person's decision or answer: amber.
    const you = { state: "you", ask: "approval", since: "2026-11-13T00:00:00Z", runId: "r1" } as const;
    expect(agentPresenceShown(row("online", false, { ...you, ...NO_PLACE }), true)).toBe("waiting");
    // Out of office and held keep their faces.
    expect(agentPresenceShown(row("out"), true)).toBe("out");
    expect(agentPresenceShown(row("offline", true), true, true)).toBe("offline");
  });
});
